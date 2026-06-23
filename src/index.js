import dinkConfigTemplate from "../dinkconfig-template.json";

const CHANNEL_TO_SECRET = {
	achievements: "WEBHOOK_ACHIEVEMENTS",
	deaths: "WEBHOOK_DEATHS",
	collection: "WEBHOOK_COLLECTION",
};

const SAFE_ALLOWED_MENTIONS = { parse: [] };

const CONFIG_TEMPLATE_STRING = JSON.stringify(dinkConfigTemplate);

function getValidTokens(env) {
	return new Set(
		(env.VALID_TOKENS || "")
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean),
	);
}

// ── Per-user Dink tokens ─────────────────────────────────────────────────────
// Personal config tokens are minted (and revoked/rotated) in the dink_tokens
// table by both the Discord bot (/dink, /dink-revoke) and the site. The proxy
// validates an incoming token against the union of:
//   1. the active (revoked_at IS NULL) rows in dink_tokens (Supabase), and
//   2. the legacy VALID_TOKENS secret (kept as a fallback / for the bot's syncWorker).
// The Supabase set is cached in an isolate global with a short TTL so a freshly
// minted or revoked token takes effect within ~TTL without a redeploy.
let tokensCache = { at: 0, set: null };

async function fetchDinkTokens(env) {
	const url = `${env.SUPABASE_URL}/rest/v1/dink_tokens?select=token&revoked_at=is.null`;
	const res = await fetch(url, {
		headers: {
			apikey: env.SUPABASE_KEY,
			Authorization: `Bearer ${env.SUPABASE_KEY}`,
		},
	});
	if (!res.ok) throw new Error(`dink_tokens ${res.status}`);
	const rows = await res.json();
	return (rows || []).map((r) => r.token).filter(Boolean);
}

async function getValidTokenSet(env) {
	const set = getValidTokens(env); // legacy VALID_TOKENS secret (fresh Set each call)
	if (!supabaseConfigured(env)) return set;
	const ttl = Number(env.TOKENS_TTL_MS) || 30000;
	if (!tokensCache.set || Date.now() - tokensCache.at >= ttl) {
		try {
			tokensCache = { at: Date.now(), set: new Set(await fetchDinkTokens(env)) };
		} catch (e) {
			console.warn("[tokens] load failed:", e.message);
			if (!tokensCache.set) tokensCache = { at: Date.now(), set: new Set() };
		}
	}
	for (const t of tokensCache.set) set.add(t);
	return set;
}

// ── Active Event Manifest (cached in the isolate global) ─────────────────────
// The site (Supabase) is the source of truth. We read two views: the participant
// RSN set (clan ∪ open-event signups) and the tracked-item set for open events.
// Cached with a short TTL so an event going live is picked up within ~TTL.
let manifestCache = { at: 0, data: null };

function supabaseConfigured(env) {
	return !!(env.SUPABASE_URL && env.SUPABASE_KEY);
}

async function sbGet(env, view, select) {
	const url = `${env.SUPABASE_URL}/rest/v1/${view}?select=${encodeURIComponent(select)}`;
	const res = await fetch(url, {
		headers: {
			apikey: env.SUPABASE_KEY,
			Authorization: `Bearer ${env.SUPABASE_KEY}`,
		},
	});
	if (!res.ok) throw new Error(`supabase ${view} ${res.status}`);
	return res.json();
}

async function getManifest(env) {
	const ttl = Number(env.MANIFEST_TTL_MS) || 30000;
	if (manifestCache.data && Date.now() - manifestCache.at < ttl) {
		return manifestCache.data;
	}
	if (!supabaseConfigured(env)) {
		const empty = { participants: new Set(), items: [] };
		manifestCache = { at: Date.now(), data: empty };
		return empty;
	}
	try {
		const [participants, items] = await Promise.all([
			sbGet(env, "vs_active_participants", "rsn"),
			sbGet(
				env,
				"vs_active_tracked_items",
				"event_id,tile_id,item_id,item_name,required_qty,source_name",
			),
		]);
		const data = {
			participants: new Set(
				(participants || []).map((r) => String(r.rsn || "").toLowerCase()),
			),
			items: items || [],
		};
		manifestCache = { at: Date.now(), data };
		return data;
	} catch (e) {
		console.warn("[manifest] load failed:", e.message);
		// Serve the stale cache if we have one; otherwise an empty manifest.
		return manifestCache.data || { participants: new Set(), items: [] };
	}
}

// Stable idempotency key so Dink's retries (maxRetries: 3) don't double-insert.
async function dropKey(parts) {
	const enc = new TextEncoder().encode(parts.join("|"));
	const buf = await crypto.subtle.digest("SHA-256", enc);
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Decision B: for a LOOT payload, record any item that belongs to an active
// tracked-item set AND was dropped by a known participant. Writes to vs_dink_drops
// (dedup via drop_key). Best-effort: failures are logged, never thrown.
async function ingestLootMatches(env, payload, manifest) {
	if (!supabaseConfigured(env)) return;
	const rsn = String(payload.playerName || "");
	if (!rsn || !manifest.participants.has(rsn.toLowerCase())) return;

	const items = payload?.extra?.items;
	if (!Array.isArray(items) || items.length === 0) return;

	const source = payload?.extra?.source ?? null;
	const dinkTs = payload?.embeds?.[0]?.timestamp ?? new Date().toISOString();

	const rows = [];
	for (const item of items) {
		const byId = item.id != null ? manifest.items.find((t) => t.item_id === item.id) : undefined;
		const itemNameLc = String(item.name || "").toLowerCase();
		const match =
			byId ||
			(itemNameLc ? manifest.items.find((t) => t.item_name === itemNameLc) : undefined);
		if (!match) continue;
		// Optional source restriction on the tracked item.
		if (match.source_name && String(source || "").toLowerCase() !== match.source_name.toLowerCase()) {
			continue;
		}
		const qty = Number(item.quantity) || 1;
		const key = await dropKey([rsn, item.id ?? item.name, source ?? "", dinkTs, qty]);
		rows.push({
			event_id: match.event_id,
			rsn,
			item_id: item.id ?? null,
			item_name: item.name ?? null,
			quantity: qty,
			source,
			dink_ts: dinkTs,
			drop_key: key,
		});
	}
	if (rows.length === 0) return;

	try {
		const res = await fetch(
			`${env.SUPABASE_URL}/rest/v1/vs_dink_drops?on_conflict=drop_key`,
			{
				method: "POST",
				headers: {
					apikey: env.SUPABASE_KEY,
					Authorization: `Bearer ${env.SUPABASE_KEY}`,
					"Content-Type": "application/json",
					Prefer: "resolution=ignore-duplicates,return=minimal",
				},
				body: JSON.stringify(rows),
			},
		);
		if (!res.ok) {
			console.warn("[ingest] insert failed:", res.status, await res.text().catch(() => ""));
		}
	} catch (e) {
		console.warn("[ingest] insert error:", e.message);
	}
}

function lootTotalValue(payload) {
	const items = payload?.extra?.items;
	if (!Array.isArray(items)) return 0;
	return items.reduce((sum, it) => sum + (Number(it.quantity) || 0) * (Number(it.priceEach) || 0), 0);
}

async function handleHook(request, env, ctx, channel) {
	const secretName = CHANNEL_TO_SECRET[channel];
	const webhook = secretName && env[secretName];
	if (!webhook) {
		return new Response("unknown channel", { status: 404 });
	}

	const contentType = request.headers.get("Content-Type") || "";

	// Parse the payload up front (both content types) so we can branch on type.
	let payload;
	let form = null;
	if (contentType.includes("application/json")) {
		try {
			payload = await request.json();
		} catch {
			return new Response("invalid json", { status: 400 });
		}
	} else if (contentType.includes("multipart/form-data")) {
		try {
			form = await request.formData();
		} catch {
			return new Response("invalid multipart", { status: 400 });
		}
		const payloadJsonRaw = form.get("payload_json");
		if (typeof payloadJsonRaw !== "string") {
			return new Response("missing payload_json", { status: 400 });
		}
		try {
			payload = JSON.parse(payloadJsonRaw);
		} catch {
			return new Response("invalid payload_json", { status: 400 });
		}
	} else {
		return new Response("unsupported content type", { status: 415 });
	}

	payload.allowed_mentions = SAFE_ALLOWED_MENTIONS;

	// ── LOOT: auto-tracking + Discord feed policy ────────────────────────────
	// Because minLootValue is lowered, the proxy now sees every drop. We make two
	// independent decisions: (B) record matched drops for the bingo tracker, and
	// (A) only forward to Discord when the drop clears FEED_MIN_VALUE.
	if (payload.type === "LOOT") {
		const manifest = await getManifest(env);
		// Decision B — ack Dink fast; do the DB write in the background.
		ctx.waitUntil(ingestLootMatches(env, payload, manifest));

		// Decision A — Discord feed threshold.
		const feedMin = Number(env.FEED_MIN_VALUE);
		const threshold = Number.isFinite(feedMin) ? feedMin : 3000000;
		if (lootTotalValue(payload) < threshold) {
			return new Response(null, { status: 204 }); // not forwarded to Discord
		}
	}

	// Forward to Discord (unchanged behaviour for everything that reaches here).
	let upstream;
	if (form) {
		form.set("payload_json", JSON.stringify(payload));
		upstream = await fetch(webhook, { method: "POST", body: form });
	} else {
		upstream = await fetch(webhook, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
	}

	return new Response(upstream.body, { status: upstream.status });
}

function handleConfig(token) {
	const body = CONFIG_TEMPLATE_STRING.replaceAll("{{TOKEN}}", token);
	return new Response(body, {
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
		},
	});
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const parts = url.pathname.split("/").filter(Boolean);
		const validTokens = await getValidTokenSet(env);

		if (
			request.method === "GET" &&
			parts.length === 2 &&
			parts[0] === "config"
		) {
			const [, token] = parts;
			if (!validTokens.has(token)) {
				return new Response("unauthorized", { status: 401 });
			}
			return handleConfig(token);
		}

		if (
			request.method === "POST" &&
			parts.length === 3 &&
			parts[0] === "hook"
		) {
			const [, token, channel] = parts;
			if (!validTokens.has(token)) {
				return new Response("unauthorized", { status: 401 });
			}
			return handleHook(request, env, ctx, channel);
		}

		return new Response("not found", { status: 404 });
	},
};
