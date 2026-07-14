import dinkConfigTemplate from "../dinkconfig-template.json";

const CHANNEL_TO_SECRET = {
	achievements: "WEBHOOK_ACHIEVEMENTS",
	deaths: "WEBHOOK_DEATHS",
	collection: "WEBHOOK_COLLECTION",
};

const SAFE_ALLOWED_MENTIONS = { parse: [] };

const CONFIG_TEMPLATE_STRING = JSON.stringify(dinkConfigTemplate);

function getValidTokens (env) {
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
let tokensCache = { at: 0, set: null, multi: new Set() };

async function fetchDinkTokens (env) {
	const url = `${env.SUPABASE_URL}/rest/v1/dink_tokens?select=token,multi_server&revoked_at=is.null`;
	const res = await fetch(url, {
		headers: {
			apikey: env.SUPABASE_KEY,
			Authorization: `Bearer ${env.SUPABASE_KEY}`,
		},
	});
	if (!res.ok) throw new Error(`dink_tokens ${res.status}`);
	const rows = await res.json();
	return (rows || []).filter((r) => r.token);
}

async function getValidTokenSet (env) {
	const set = getValidTokens(env); // legacy VALID_TOKENS secret (fresh Set each call)
	if (!supabaseConfigured(env)) return set;
	const ttl = Number(env.TOKENS_TTL_MS) || 30000;
	if (!tokensCache.set || Date.now() - tokensCache.at >= ttl) {
		try {
			const rows = await fetchDinkTokens(env);
			tokensCache = {
				at: Date.now(),
				set: new Set(rows.map((r) => r.token)),
				multi: new Set(rows.filter((r) => r.multi_server === true).map((r) => r.token)),
			};
		} catch (e) {
			console.warn("[tokens] load failed:", e.message);
			if (!tokensCache.set) tokensCache = { at: Date.now(), set: new Set(), multi: new Set() };
		}
	}
	for (const t of tokensCache.set) set.add(t);
	return set;
}

// Was this token flagged multi-server (dink_tokens.multi_server, set from the
// site's /dink-check page)? Reads the cache getValidTokenSet just refreshed —
// legacy VALID_TOKENS entries are never multi-server.
function isMultiServerToken (token) {
	return tokensCache.multi.has(token);
}

// ── Active manifest (cached in the isolate global) ───────────────────────────
// The site (Supabase) is the source of truth. We read two views derived from the
// unified per-player active-tiles index: the participant RSN set (owners of any
// active item tile — open-event signups ∪ locked personal-board owners) and the
// flat, event-less tracked-item set (item_id, item_name, match_type). The proxy
// only needs "is this item in play, of this notif type?"; the consumer resolves
// the actual tile(s) per user. Cached with a short TTL.
let manifestCache = { at: 0, data: null };

function supabaseConfigured (env) {
	return !!(env.SUPABASE_URL && env.SUPABASE_KEY);
}

async function sbGet (env, view, select) {
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

async function getManifest (env) {
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
			// The site's vs_active_tracked_items view (derived from vs_active_player_tiles)
			// exposes only these columns — a flat, event-less list of trackable items.
			sbGet(env, "vs_active_tracked_items", "item_id,item_name,match_type"),
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
async function dropKey (parts) {
	const enc = new TextEncoder().encode(parts.join("|"));
	const buf = await crypto.subtle.digest("SHA-256", enc);
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Is this {id, name} an active tracked item of the given match type ('loot' |
// 'collection')? Id match preferred, case-insensitive name fallback. The tracked-item
// set is now a flat, event-less list (no source_name/event_id) — the proxy only decides
// "is this item in play?"; the site consumer resolves the per-user tile(s) and any
// source/timing constraints. Returns the matched item or null.
function findTrackedMatch (manifest, { id, name }, matchType) {
	const nameLc = String(name || "").toLowerCase();
	const candidates = manifest.items.filter((t) => (t.match_type || "loot") === matchType);
	const byId = id != null ? candidates.find((t) => t.item_id === id) : undefined;
	if (byId) return byId;
	return (nameLc ? candidates.find((t) => String(t.item_name || "").toLowerCase() === nameLc) : undefined) || null;
}

// Upload a Dink screenshot to the site's public proofs bucket and return its public
// URL (null on any failure — the drop still records, just without an image). Keyed by
// the drop_key so Dink retries overwrite the same object instead of duplicating.
const IMAGE_BUCKET = "vs-bingo-proofs";
async function uploadDropImage (env, key, screenshot) {
	if (!screenshot || !supabaseConfigured(env)) return null;
	try {
		const type = screenshot.type || "image/png";
		const ext = type === "image/jpeg" ? "jpg" : type === "image/webp" ? "webp" : type === "image/gif" ? "gif" : "png";
		const path = `dink/${key}.${ext}`;
		const res = await fetch(
			`${env.SUPABASE_URL}/storage/v1/object/${IMAGE_BUCKET}/${path}`,
			{
				method: "POST",
				headers: {
					apikey: env.SUPABASE_KEY,
					Authorization: `Bearer ${env.SUPABASE_KEY}`,
					"Content-Type": type,
					"x-upsert": "true",
				},
				body: screenshot,
			},
		);
		if (!res.ok) {
			console.warn("[image] upload failed:", res.status, await res.text().catch(() => ""));
			return null;
		}
		return `${env.SUPABASE_URL}/storage/v1/object/public/${IMAGE_BUCKET}/${path}`;
	} catch (e) {
		console.warn("[image] upload error:", e.message);
		return null;
	}
}

// Insert matched drop rows into vs_dink_drops (dedup via drop_key). Best-effort:
// failures are logged, never thrown.
async function insertDinkDrops (env, rows) {
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

// Decision B (LOOT): record any looted item that belongs to an active loot-type
// tracked-item set AND was dropped by a known participant. If the client attached a
// screenshot, it's uploaded once and stamped on every matched row from this kill —
// the site copies it into the credited tile's proof images.
async function ingestLootMatches (env, payload, manifest, screenshot) {
	if (!supabaseConfigured(env)) return;
	const rsn = String(payload.playerName || "");
	if (!rsn || !manifest.participants.has(rsn.toLowerCase())) return;

	const items = payload?.extra?.items;
	if (!Array.isArray(items) || items.length === 0) return;

	const source = payload?.extra?.source ?? null;
	const dinkTs = payload?.embeds?.[0]?.timestamp ?? new Date().toISOString();

	const rows = [];
	for (const item of items) {
		if (!findTrackedMatch(manifest, { id: item.id, name: item.name }, "loot")) continue;
		const qty = Number(item.quantity) || 1;
		const value = (Number(item.priceEach) || 0) * qty;
		const key = await dropKey([rsn, item.id ?? item.name, source ?? "", dinkTs, qty]);
		// No event_id — the consumer resolves the tile(s) per user from the active index.
		rows.push({
			rsn,
			item_id: item.id ?? null,
			item_name: item.name ?? null,
			quantity: qty,
			source,
			value,
			dink_ts: dinkTs,
			drop_key: key,
			notif_type: "loot",
		});
	}
	if (rows.length && screenshot) {
		const imageUrl = await uploadDropImage(env, rows[0].drop_key, screenshot);
		if (imageUrl) for (const r of rows) r.image_url = imageUrl;
	}
	await insertDinkDrops(env, rows);
}

// Decision B (COLLECTION): a collection-log unlock (also how pets register, since a
// pet is a clog slot). Matches collection-type tracked items by the unlocked item's
// id/name. Collection notifications aren't value-gated, so they always reach us.
async function ingestCollectionMatch (env, payload, manifest, screenshot) {
	if (!supabaseConfigured(env)) return;
	const rsn = String(payload.playerName || "");
	if (!rsn || !manifest.participants.has(rsn.toLowerCase())) return;

	const ex = payload?.extra || {};
	const itemId = ex.itemId ?? null;
	const itemName = ex.itemName ?? null;
	if (itemId == null && !itemName) return;

	if (!findTrackedMatch(manifest, { id: itemId, name: itemName }, "collection")) return;

	const dinkTs = payload?.embeds?.[0]?.timestamp ?? new Date().toISOString();
	const value = Number(ex.price) || 0;
	const key = await dropKey([rsn, itemId ?? itemName, "collection", dinkTs, 1]);
	const imageUrl = screenshot ? await uploadDropImage(env, key, screenshot) : null;
	// No event_id — the consumer credits the matching event clog tile and/or the
	// owner's personal-board tile from the active index.
	await insertDinkDrops(env, [
		{
			rsn,
			item_id: itemId,
			item_name: itemName,
			quantity: 1,
			source: "Collection log",
			value,
			dink_ts: dinkTs,
			drop_key: key,
			notif_type: "collection",
			...(imageUrl ? { image_url: imageUrl } : {}),
		},
	]);
}

function lootTotalValue (payload) {
	const items = payload?.extra?.items;
	if (!Array.isArray(items)) return 0;
	return items.reduce((sum, it) => sum + (Number(it.quantity) || 0) * (Number(it.priceEach) || 0), 0);
}

async function handleHook (request, env, ctx, channel) {
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

	// Dink attaches the screenshot (when enabled) as an image file part in the
	// multipart body. Grab the first one without assuming its field name; it becomes
	// the recorded drop's proof image.
	let screenshot = null;
	if (form) {
		for (const [, v] of form.entries()) {
			if (v && typeof v === "object" && typeof v.arrayBuffer === "function" && String(v.type || "").startsWith("image/")) {
				screenshot = v;
				break;
			}
		}
	}

	// ── LOOT: auto-tracking + Discord feed policy ────────────────────────────
	// Active events' tracked items are injected into Dink's loot allowlist (see
	// handleConfig), so the proxy receives them regardless of value. We make two
	// independent decisions: (B) record matched drops for the bingo tracker, and
	// (A) only forward to Discord when the drop clears FEED_MIN_VALUE (so cheap
	// tracked items are recorded but don't spam the achievements channel).
	if (payload.type === "LOOT") {
		const manifest = await getManifest(env);
		// Decision B — ack Dink fast; do the DB write in the background.
		ctx.waitUntil(ingestLootMatches(env, payload, manifest, screenshot));

		// Decision A — Discord feed threshold.
		const feedMin = Number(env.FEED_MIN_VALUE);
		const threshold = Number.isFinite(feedMin) ? feedMin : 3000000;
		if (lootTotalValue(payload) < threshold) {
			return new Response(null, { status: 204 }); // not forwarded to Discord
		}
	} else if (payload.type === "COLLECTION") {
		// Collection-log unlocks (and pets) can complete tiles too. Record matches in
		// the background; the notification still forwards to its channel as before.
		const manifest = await getManifest(env);
		ctx.waitUntil(ingestCollectionMatch(env, payload, manifest, screenshot));
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

// Serve the Dink config for a token: inject the active events' tracked-item names
// into Dink's loot allowlist (so the proxy receives those items regardless of value,
// without lowering minLootValue to 1) and guarantee a sane minLootValue. {{TOKEN}}
// is substituted last.
// Floor applied to multi-server tokens regardless of what the admin template says.
const MULTI_SERVER_MIN_LOOT = 3000000;

async function handleConfig (env, token) {
	const templateString = await getConfigTemplate(env);
	let cfg;
	try {
		cfg = JSON.parse(templateString);
	} catch {
		cfg = {};
	}

	// Merge active LOOT tracked-item names into lootItemAllowlist (newline-separated) so
	// cheap loot reaches the proxy despite minLootValue. Collection-type items are excluded
	// — they arrive via Dink's collection-log notifier regardless of value, not as loot.
	try {
		const manifest = await getManifest(env);
		const names = [
			...new Set(
				manifest.items
					.filter((i) => (i.match_type || "loot") === "loot")
					.map((i) => (i.item_name || "").trim())
					.filter(Boolean),
			),
		];
		if (names.length) {
			const base =
				typeof cfg.lootItemAllowlist === "string" && cfg.lootItemAllowlist.trim()
					? cfg.lootItemAllowlist.split("\n").map((s) => s.trim()).filter(Boolean)
					: [];
			// Dedupe case-insensitively, preserving the first spelling seen.
			const seen = new Set(base.map((s) => s.toLowerCase()));
			const merged = [...base];
			for (const n of names) {
				if (!seen.has(n.toLowerCase())) {
					seen.add(n.toLowerCase());
					merged.push(n);
				}
			}
			cfg.lootItemAllowlist = merged.join("\n");
		}
	} catch (e) {
		console.warn("[config] allowlist injection failed:", e.message);
	}

	// Guarantee a value threshold (the allowlist covers tracked items separately).
	if (cfg.minLootValue == null) cfg.minLootValue = 3000000;

	// Multi-server members (dink_tokens.multi_server, the /dink-check checkbox) must
	// NEVER be served a low threshold: their Dink also posts to other Discord servers,
	// and the standard config's minLootValue of 1 fires those webhooks on every drop.
	// The allowlist above already whitelists their tracked tiles, so the tracker still
	// receives everything it needs. They reload the config (plugin toggle) whenever
	// their boards/tiles change.
	if (isMultiServerToken(token)) {
		cfg.minLootValue = Math.max(Number(cfg.minLootValue) || 0, MULTI_SERVER_MIN_LOOT);
	}

	const body = JSON.stringify(cfg).replaceAll("{{TOKEN}}", token);
	return new Response(body, {
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
		},
	});
}

// ── Dink config template (admin-editable via the site) ───────────────────────
// The config is editable on the site as a bot_config row (config_name=dink_config)
// and served live here, so admins can change Dink settings without a redeploy.
// Cached in an isolate global with a TTL; falls back to the bundled template when
// Supabase is unconfigured or the row is absent (so default behaviour is preserved).
let configCache = { at: 0, data: null };

async function fetchConfigTemplate (env) {
	const url = `${env.SUPABASE_URL}/rest/v1/bot_config?select=config_value&config_name=eq.dink_config&limit=1`;
	const res = await fetch(url, {
		headers: {
			apikey: env.SUPABASE_KEY,
			Authorization: `Bearer ${env.SUPABASE_KEY}`,
		},
	});
	if (!res.ok) throw new Error(`bot_config ${res.status}`);
	const rows = await res.json();
	const value = rows?.[0]?.config_value;
	return value ? JSON.stringify(value) : null;
}

async function getConfigTemplate (env) {
	if (!supabaseConfigured(env)) return CONFIG_TEMPLATE_STRING;
	const ttl = Number(env.CONFIG_TTL_MS) || 60000;
	if (configCache.data && Date.now() - configCache.at < ttl) {
		return configCache.data;
	}
	try {
		const tmpl = await fetchConfigTemplate(env);
		const data = tmpl || CONFIG_TEMPLATE_STRING; // missing row → bundled fallback
		configCache = { at: Date.now(), data };
		return data;
	} catch (e) {
		console.warn("[config] load failed (using bundled):", e.message);
		// Serve the last good value if we have one, else the bundled template.
		return configCache.data || CONFIG_TEMPLATE_STRING;
	}
}

export default {
	async fetch (request, env, ctx) {
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
			return handleConfig(env, token);
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