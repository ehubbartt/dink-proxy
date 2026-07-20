import dinkConfigTemplate from "../dinkconfig-template.json";

const CHANNEL_TO_SECRET = {
	achievements: "WEBHOOK_ACHIEVEMENTS",
	deaths: "WEBHOOK_DEATHS",
	collection: "WEBHOOK_COLLECTION",
};

const SAFE_ALLOWED_MENTIONS = { parse: [] };

// Notification types the proxy is willing to relay to Discord — a strict allowlist
// (fail-closed): only messages of these types, which we format and expect, are
// forwarded; every other type is silently dropped in handleHook. This is the trust
// boundary that keeps external-plugin "send to Dink" notifications (e.g. a RuneLite
// plugin's card-pack messages), chat triggers, level-ups, quests, and any unknown or
// spoofed type out of the channels. LOOT and COLLECTION also feed the bingo/board
// auto-tracker; DEATH and PET are forward-only.
const FORWARD_TYPES = new Set(["LOOT", "COLLECTION", "DEATH", "PET"]);

const CONFIG_TEMPLATE_STRING = JSON.stringify(dinkConfigTemplate);

// Clan-wide ALWAYS-WATCH list, sourced from the bundled template's lootItemAllowlist.
// This is a DELIBERATE clan-wide FEED concern — marquee drops (vestiges, etc.) we always
// want reaching the Discord feed even for a member with no bingo tiles — and is SEPARATE
// from per-member tile tracking (injected per token in handleConfig, which does NOT depend
// on this list). It's always served, so it also survives a mangled live-config allowlist.
// Edit the bundled dinkconfig-template.json to change this set. (It is not "what a member
// is tracking"; per-member creditable items are the vs_dink_token_items injection below.)
const CLAN_ALWAYS_WATCH = (typeof dinkConfigTemplate.lootItemAllowlist === "string"
	? dinkConfigTemplate.lootItemAllowlist.split("\n")
	: []
)
	.map((s) => s.trim())
	.filter(Boolean);

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

// Is this {id, name} an active tracked item? Id match preferred, case-insensitive name
// fallback. WATCH BOTH WAYS: we no longer filter by match_type — the proxy records a drop
// if the item is tracked at all, whether it arrived as a LOOT drop or a COLLECTION unlock,
// and the site consumer credits on either (idempotency makes a double-fire safe). This
// closes the "mis-tagged match_type → never tracked" gap. The tracked-item set is a flat,
// event-less list; the proxy only decides "is this item in play?". Returns the item or null.
function findTrackedMatch (manifest, { id, name }) {
	const nameLc = String(name || "").toLowerCase();
	const byId = id != null ? manifest.items.find((t) => t.item_id === id) : undefined;
	if (byId) return byId;
	return (nameLc ? manifest.items.find((t) => String(t.item_name || "").toLowerCase() === nameLc) : undefined) || null;
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

// Decision B (LOOT): record any looted item that belongs to the active tracked-item set
// (any match_type — watch both ways) AND was dropped by a known participant. If the client
// attached a screenshot, it's uploaded once and stamped on every matched row from this kill
// — the site copies it into the credited tile's proof images.
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
		if (!findTrackedMatch(manifest, { id: item.id, name: item.name })) continue;
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
// pet is a clog slot). Matches the unlocked item against the tracked-item set by id/name
// (any match_type — watch both ways). Collection notifications aren't value-gated, so they
// always reach us — which is why a multi-server member's tile can credit via a clog unlock
// without a Dink config reload.
async function ingestCollectionMatch (env, payload, manifest, screenshot) {
	if (!supabaseConfigured(env)) return;
	const rsn = String(payload.playerName || "");
	if (!rsn || !manifest.participants.has(rsn.toLowerCase())) return;

	const ex = payload?.extra || {};
	const itemId = ex.itemId ?? null;
	const itemName = ex.itemName ?? null;
	if (itemId == null && !itemName) return;

	if (!findTrackedMatch(manifest, { id: itemId, name: itemName })) return;

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

// ── Discord feed policy (LOOT) ───────────────────────────────────────────────
// A notification is feed-worthy only if a single STACK (quantity × unit price)
// clears the threshold — never the summed total, so a kingdom/herb-run dump of
// many cheap stacks stays out of the channel while one 3m+ stack (or e.g. 3 × 1m
// of the same item) posts. Returns the qualifying stacks.
function feedWorthyStacks (payload, threshold) {
	const items = payload?.extra?.items;
	if (!Array.isArray(items)) return [];
	return items.filter(
		(it) => (Number(it.quantity) || 0) * (Number(it.priceEach) || 0) >= threshold,
	);
}

// Pull the OSRS item id out of a RuneLite icon URL
// (https://static.runelite.net/cache/item/icon/<id>.png) — the id Dink stamps on
// each per-item image embed. Returns null if the url isn't a recognizable item icon.
function iconItemId (embed) {
	const url = embed?.image?.url;
	if (typeof url !== "string") return null;
	const m = url.match(/\/item\/icon\/(\d+)/);
	return m ? Number(m[1]) : null;
}

// Trim a forwarded LOOT message down to the qualifying (feed-worthy) stacks. Dink
// sends ONE main embed whose description lists every looted item, followed by one
// image-only embed per item (its icon at .../item/icon/<id>.png) — Discord renders
// those trailing embeds as the row of item pictures. We do TWO things, both keyed off
// the structured payload.extra.items (the same data the feed gate uses):
//   1. Drop the main embed's description lines that mention only sub-threshold items.
//      Robust to `lootIcons` emoji prefixes and markdown-linked names ("N x
//      [Name](wiki-url) (value)") — we match on item name, not line shape; header /
//      "From:" / blank lines mention no item and are kept.
//   2. Drop the trailing per-item icon embeds whose item is sub-threshold, so the
//      channel no longer shows pictures of the cheap items we filtered out of the text.
// Anything we can't classify is kept: the main embed (index 0), non-icon image embeds,
// and icons whose id isn't in the item list. If nothing is sub-threshold, it's a no-op.
function trimLootMessage (payload, threshold) {
	const embeds = payload?.embeds;
	const items = payload?.extra?.items;
	if (!Array.isArray(embeds) || embeds.length === 0) return;
	if (!Array.isArray(items) || items.length === 0) return;

	const stackValue = (it) => (Number(it.quantity) || 0) * (Number(it.priceEach) || 0);
	const big = items.filter((it) => stackValue(it) >= threshold);
	const small = items.filter((it) => stackValue(it) < threshold);
	if (!small.length) return; // nothing sub-threshold to strip

	const bigNames = big.map((it) => String(it.name || "").toLowerCase()).filter(Boolean);
	const smallNames = small.map((it) => String(it.name || "").toLowerCase()).filter(Boolean);
	const bigIds = new Set(big.map((it) => it.id).filter((id) => id != null).map(Number));
	const smallIds = new Set(small.map((it) => it.id).filter((id) => id != null).map(Number));

	// 1. Trim the main embed's description to the qualifying items.
	const main = embeds[0];
	if (main && typeof main.description === "string" && smallNames.length) {
		const lines = main.description.split("\n");
		const kept = lines.filter((line) => {
			const lc = line.toLowerCase();
			const hasSmall = smallNames.some((n) => lc.includes(n));
			const hasBig = bigNames.some((n) => lc.includes(n));
			return hasBig || !hasSmall; // keep big-item and non-item lines; drop small-only lines
		});
		if (kept.length && kept.length < lines.length) {
			main.description = kept.join("\n");
		}
	}

	// 2. Drop the trailing per-item icon embeds for sub-threshold items. An icon whose
	//    item is also a big stack (shouldn't happen — one stack is either big or small)
	//    is kept, so a genuine over-threshold picture never gets dropped.
	payload.embeds = embeds.filter((embed, i) => {
		if (i === 0) return true; // main embed always kept
		const id = iconItemId(embed);
		if (id == null) return true; // not a recognizable item icon → keep
		return !(smallIds.has(id) && !bigIds.has(id));
	});
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

	// Targeted debug logging: when the DEBUG_LOG_RSN secret is set, log the full inbound
	// payload for ONLY that player (case-insensitive), so you can inspect exactly what YOUR
	// account sends — every type, including ones dropped below — without the whole clan's
	// traffic in the logs. Worker-side only (view with `wrangler tail` or the dashboard Logs);
	// never forwarded to Discord. Unset the secret to turn it off.
	const debugRsn = (env.DEBUG_LOG_RSN || "").trim().toLowerCase();
	if (debugRsn && String(payload.playerName || "").toLowerCase() === debugRsn) {
		console.log("[debug]", channel, JSON.stringify(payload));
	}

	// Fail-closed trust boundary: only relay the notification types we format and
	// fully understand (see FORWARD_TYPES). Anything else — external-plugin "send to
	// Dink" notifications, chat triggers, levels, quests, unknown or spoofed types — is
	// silently ignored and never reaches a channel. 204 so Dink treats it as delivered
	// and doesn't retry. The console line is Worker-side only (observability), not a
	// Discord message.
	if (!FORWARD_TYPES.has(payload.type)) {
		console.log("[hook] ignored unsupported type:", payload.type);
		return new Response(null, { status: 204 });
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
	// (A) only forward to Discord when a SINGLE STACK clears FEED_MIN_VALUE — the
	// summed total is never used, so cheap tracked items and multi-stack junk
	// dumps are recorded but don't spam the achievements channel.
	if (payload.type === "LOOT") {
		const manifest = await getManifest(env);
		// Decision B — ack Dink fast; do the DB write in the background. (Runs on
		// the full, untrimmed item list regardless of the feed decision below.)
		ctx.waitUntil(ingestLootMatches(env, payload, manifest, screenshot));

		// Decision A — Discord feed threshold, judged per stack.
		const feedMin = Number(env.FEED_MIN_VALUE);
		const threshold = Number.isFinite(feedMin) ? feedMin : 3000000;
		const bigStacks = feedWorthyStacks(payload, threshold);
		if (bigStacks.length === 0) {
			return new Response(null, { status: 204 }); // not forwarded to Discord
		}
		// Only the qualifying stacks appear in the channel (text + item icons).
		trimLootMessage(payload, threshold);
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

// Serve the Dink config for a token: inject THIS member's tracked-item names into Dink's
// loot allowlist (so the proxy receives those items regardless of value, without lowering
// minLootValue to 1) and guarantee a sane minLootValue. {{TOKEN}} is substituted last.
// Floor applied to multi-server tokens regardless of what the admin template says.
const MULTI_SERVER_MIN_LOOT = 3000000;

// Per-token LAST-GOOD tracked-item cache. On a transient vs_dink_token_items error we serve
// the member's OWN last-known items (or nothing) — NEVER the clan-wide union, so one member
// can never be polluted with the whole clan's items. Isolate-local, clan-bounded (one entry
// per active token), no eviction needed.
let tokenItemsCache = new Map(); // token → { at:number, items:[{item_name, match_type}] }

async function fetchTokenLootItems (env, token) {
	const url = `${env.SUPABASE_URL}/rest/v1/vs_dink_token_items?select=item_name,match_type&token=eq.${encodeURIComponent(token)}`;
	const res = await fetch(url, {
		headers: {
			apikey: env.SUPABASE_KEY,
			Authorization: `Bearer ${env.SUPABASE_KEY}`,
		},
	});
	if (!res.ok) throw new Error(`vs_dink_token_items ${res.status}`);
	return res.json();
}

async function handleConfig (env, token) {
	const templateString = await getConfigTemplate(env);
	let cfg;
	try {
		cfg = JSON.parse(templateString);
	} catch {
		cfg = {};
	}

	// Merge THIS MEMBER's tracked-item names into lootItemAllowlist (newline-separated) so
	// their cheap tracked loot reaches the proxy despite minLootValue. Per-token on purpose;
	// on a transient error we fall back to the member's OWN last-good set (see cache), never
	// the clan-wide union — an empty result is a valid answer (no active tiles → nothing to
	// inject), not a failure.
	try {
		// This member's tracked items, with a per-token last-good cache: fresh within
		// TOKEN_ITEMS_TTL_MS; on error, serve their own last-good set for up to
		// TOKEN_ITEMS_STALE_MS, else nothing. Never the clan union.
		let items = [];
		if (supabaseConfigured(env)) {
			const ttl = Number(env.TOKEN_ITEMS_TTL_MS) || 60000;
			const staleMs = Number(env.TOKEN_ITEMS_STALE_MS) || 1800000;
			const cached = tokenItemsCache.get(token);
			if (cached && Date.now() - cached.at < ttl) {
				items = cached.items;
			} else {
				try {
					items = (await fetchTokenLootItems(env, token)) || [];
					tokenItemsCache.set(token, { at: Date.now(), items });
				} catch (e) {
					console.warn("[config] per-token items failed:", e.message);
					items = cached && Date.now() - cached.at < staleMs ? cached.items : [];
				}
			}
		}
		// WATCH BOTH WAYS: inject ALL tracked item names, loot AND collection. A collection
		// item in the loot allowlist is harmless (Dink only fires a loot notif if it actually
		// drops as loot) and closes the "mis-tagged match_type → never tracked" gap — the
		// site credits on whichever notification arrives first.
		const names = items.map((i) => (i.item_name || "").trim()).filter(Boolean);
		// Whatever the live config lists (split on newlines; may be a single mangled blob if
		// the stored value lost its newlines — harmless, it just never matches).
		const served =
			typeof cfg.lootItemAllowlist === "string"
				? cfg.lootItemAllowlist.split("\n").map((s) => s.trim()).filter(Boolean)
				: [];
		// Rebuild the allowlist as: clan always-watch ∪ live-config items ∪ this member's
		// tracked items — deduped case-insensitively, always correctly newline-separated.
		// CLAN_ALWAYS_WATCH guarantees the marquee-drop feed set and repairs a mangled live
		// value; it runs unconditionally so the base is correct even with no active tiles.
		const seen = new Set();
		const merged = [];
		for (const n of [...CLAN_ALWAYS_WATCH, ...served, ...names]) {
			const lc = n.toLowerCase();
			if (!seen.has(lc)) {
				seen.add(lc);
				merged.push(n);
			}
		}
		if (merged.length) cfg.lootItemAllowlist = merged.join("\n");
	} catch (e) {
		console.warn("[config] allowlist injection failed:", e.message);
	}

	// Guarantee a value threshold (the allowlist covers tracked items separately).
	if (cfg.minLootValue == null) cfg.minLootValue = 3000000;

	// Multi-server members (dink_tokens.multi_server, the /dink-check checkbox) must
	// NEVER be served a low threshold: their Dink also posts to other Discord servers,
	// and a low minLootValue would fire those webhooks on every drop. The allowlist
	// above already whitelists their tracked tiles, so the tracker still receives
	// everything it needs. They reload the config (plugin toggle) whenever their
	// boards/tiles change.
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