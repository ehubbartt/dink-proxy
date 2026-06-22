# Bingo Drop Auto-Tracking

Design doc for turning the dink-proxy Worker into an automatic bingo drop tracker, so
qualifying OSRS drops are credited to active bingo tiles without players submitting screenshots
and admins approving them by hand.

> Status: **proposal**. Nothing here is built yet. This documents the intended change to
> `dink-proxy` and how it hooks into the existing (currently archived) bingo system in
> `voli-disc-bot`.

---

## Context / motivation

Bingos run on a website submission portal with **manual admin approval** of every drop. That's slow
for both players (submit + wait) and admins (review every screenshot). Since clan members already run
the Dink RuneLite plugin pointed at this proxy, the proxy *already sees every drop as structured JSON*.
We can use that feed to auto-credit bingo tiles.

**Decision (set by project owner):**
- **Spoofing / anti-cheat is out of scope.** We trust the Dink payload's `playerName`. (See
  [dink-payloads.md](dink-payloads.md) — payloads are self-reported; we are explicitly accepting that.)
- **The proxy processes _every_ incoming request, but forwards only the ones we choose** — to Discord,
  to the bingo tracker, both, or neither.

---

## What changes, in one sentence

Lower Dink's loot threshold so the proxy receives all drops, then make the proxy parse each loot
payload and make **two independent decisions** per drop: (1) does it belong to an active bingo tile →
record it for the bingo tracker, and (2) does it meet the Discord-feed policy → forward to the
achievements webhook. Most drops match neither and are dropped at the edge.

---

## Data flow

```
RuneLite + Dink (minLootValue lowered)
      │  POST /hook/<token>/achievements   (LOOT payload, every drop)
      ▼
┌─────────────────────────────────────────────────────────────────┐
│ dink-proxy Worker  (src/index.js, handleHook)                     │
│                                                                   │
│  1. validate token            (unchanged, src/index.js:106)       │
│  2. parse payload, type==LOOT                                     │
│  3. load Active Bingo Manifest (cached; see below)                │
│                                                                   │
│  ── Decision A: Discord feed ──────────────────────────────────  │
│     total value >= FEED_MIN_VALUE  OR  allowlisted  →  forward    │
│        to WEBHOOK_ACHIEVEMENTS (existing behaviour)               │
│     else → do NOT forward to Discord                              │
│                                                                   │
│  ── Decision B: bingo match ───────────────────────────────────  │
│     playerName ∈ participants  AND  itemId/name ∈ tile items      │
│        → record drop to ingestion sink (Supabase)                 │
│     else → drop                                                   │
└─────────────────────────────────────────────────────────────────┘
      │ (matched drops only)
      ▼
  Supabase  dink_drops  (raw, deduped, audit log)
      │
      ▼
  voli-disc-bot poller  (mirror of jobs/siteSubmissionPoller.js)
      │  resolve RSN→team, apply progress, mark tiles complete, award
      ▼
  bingo_event_progress / bingo_event_teams  (db/bingo_event.js)
      │
      ▼
  Discord bingo board update / payout
```

Key point: **the proxy stays "dumb"** — it filters and records. The *bingo business logic*
(team resolution, quantity accumulation, tile completion, rewards) stays in the bot, next to the
existing `config/bingoTiles.json` and `db/bingo_event.js`.

---

## Components to build

### 1. Dink config — lower the loot threshold

In [dinkconfig-template.json](../dinkconfig-template.json), `minLootValue`/`lootImageMinValue` are
currently `3000000`. Lower the value threshold (e.g. to `1`) so Dink emits a LOOT notification for
essentially every drop. Config is served per-token by the Worker
([src/index.js:72-80](../src/index.js#L72-L80)) and changes require `npx wrangler deploy`
(per [bot-integration.md](bot-integration.md)).

> Consequence: because Dink now sends everything, the proxy becomes responsible for deciding what
> reaches the Discord achievements channel (Decision A). If we skip that, the channel floods and we
> hit Discord webhook rate limits. See **Discord feed policy** below.

### 2. Proxy: parse, filter, route (`src/index.js`)

`handleHook` currently parses the payload only to strip mentions
([src/index.js:32-67](../src/index.js#L32-L67)). Extend it:

- Branch on `payload.type`. Only `LOOT` runs the bingo logic; other types forward as today.
- **Decision A — Discord feed policy.** Compute total value from `extra.items[]`
  (`Σ quantity × priceEach`). Forward to `WEBHOOK_ACHIEVEMENTS` only if it clears `FEED_MIN_VALUE`
  (a new env var, default 3_000_000) or hits a name allowlist. This re-implements the threshold Dink
  used to apply for us. Mentions are still stripped ([src/index.js:39](../src/index.js#L39)).
- **Decision B — bingo match.** For each item in `extra.items[]`, check `playerName` against the
  manifest's participant set and the item (`id` and/or normalized `name`) against the manifest's tile
  item set. On a match, record a drop (below). Optionally also require `extra.source` to match the
  tile's `source_name`.
- Use `ctx.waitUntil(...)` for the ingestion write so we ack Dink fast and don't block on Supabase.
  (Add `ctx` to the `fetch(request, env, ctx)` signature — [src/index.js:83](../src/index.js#L83).)

### 3. The Active Bingo Manifest (what the proxy needs to filter)

To make Decision B without a DB round-trip per request, the Worker needs a small, cached manifest:

```jsonc
{
  "eventId": 42,
  "endsAt": "2026-07-01T00:00:00Z",
  "participants": ["bajj", "somersn", ...],          // RSNs (lowercased for compare)
  "tileItems": [                                      // from bingoTiles.json, promoted to data
    { "tile": 1, "itemName": "dragon med helm", "itemId": 1149, "source": "...", "required": 2 }
  ]
}
```

- **Source of truth:** the bot owns this. `config/bingoTiles.json` (item names + required qty) and
  `bingo_event_players` (participants) already exist in voli-disc-bot. Two viable delivery options:
  - **(Recommended) Worker reads from Supabase via PostgREST**, cached in an isolate-global with a
    30–60s TTL. Requires the tile items to live in the DB (today they're a static file —
    [voli-disc-bot/config/bingoTiles.json](../../voli-disc-bot/config/bingoTiles.json) — so either move
    them into a table/`events` JSON column, or have the bot publish them).
  - **(Alternative) Bot pushes the manifest to Workers KV** (mirrors how it already pushes
    `VALID_TOKENS` via [voli-disc-bot/services/dinkProxy.js](../../voli-disc-bot/services/dinkProxy.js)).
    Worker reads KV, caches in-isolate.
- **Freshness:** TTL means an event going live is picked up within ~1 minute. Acceptable; if not,
  shorten TTL or have the bot bust the cache on event start.
- **No match data → fast path:** when there is no active bingo, the manifest is empty and Decision B
  is a single boolean — negligible cost.

### 4. Ingestion sink + bot processing

**New Supabase table `dink_drops`** (raw, append-only audit log; dedupe lives here):

```
id            bigserial PK
event_id      integer            -- bingo event this was matched to
rsn           text               -- payload playerName
item_id       integer
item_name     text
quantity      integer
source        text               -- extra.source
dink_ts       timestamptz        -- payload timestamp (client, informational)
received_at   timestamptz        -- proxy receive time (authoritative for "during event")
drop_key      text UNIQUE        -- idempotency: hash(rsn|item_id|source|dink_ts|quantity)
processed     boolean default false
```

- **Proxy write:** direct PostgREST insert with `on_conflict=drop_key` ignore (dedup against Dink's
  retries — `maxRetries: 3` in the config). Worker needs `SUPABASE_URL` + a key (service-role secret,
  or anon key with an insert RLS policy) as Cloudflare secrets.
- **Bot consumer:** add a poller modeled on
  [voli-disc-bot/jobs/siteSubmissionPoller.js](../../voli-disc-bot/jobs/siteSubmissionPoller.js)
  (already runs every 60s). It reads `processed = false` rows, resolves `rsn → players → bingo_event_players → team`
  ([voli-disc-bot/db/supabase.js:13-26](../../voli-disc-bot/db/supabase.js#L13-L26),
  [voli-disc-bot/db/bingo_event.js](../../voli-disc-bot/db/bingo_event.js)), increments
  `bingo_event_progress.current_quantity`, flips `is_completed` when `required_quantity` is reached,
  triggers board refresh / payout, then sets `processed = true`.

> Why a raw table + poller instead of the proxy updating progress directly: the completion/quantity
> logic is transactional and team-aware, and it lives in the bot beside the rest of the bingo code.
> The table gives us idempotency, an audit trail, retries, and decouples burst ingestion from
> processing. It mirrors a pattern already in the repo.

> The bridge mechanism ([voli-disc-bot/handlers/bridge.js](../../voli-disc-bot/handlers/bridge.js)) is
> a *Discord-webhook* path — fine for rare low-volume signals but unsuitable here because it would
> route drops through Discord and its rate limits. Use the Supabase table instead.

---

## Identity & matching details

- **Player:** match the payload `playerName` (RSN) against the participant set. The URL token
  ([src/index.js:106](../src/index.js#L106)) still gates access; we don't need token→RSN resolution
  because spoofing is out of scope and `playerName` is trusted.
- **Item:** Dink gives both `id` and `name` per item ([dink-payloads.md:160-165](dink-payloads.md#L160-L165)).
  Prefer `id` matching; keep normalized-`name` as a fallback. Today `bingoTiles.json` only stores
  `item_name` — adding `item_id` per tile makes matching robust against name variants (noted/charged forms).
- **Quantity / "collect N" tiles:** the proxy records `quantity`; the bot accumulates into
  `bingo_event_progress.current_quantity` against `required_quantity`.
- **Source-restricted tiles:** optionally require `extra.source` to equal the tile's `source_name`.
- **Timing:** use the proxy `received_at` as authoritative for "happened during the event window,"
  not the client `dink_ts`.

---

## Throughput & cost

- **Cloudflare Workers scale fine** to the request rates in question; the edge filter discards the
  vast majority of drops in microseconds, so real work (DB writes) only happens on matches.
- **Free-tier ceilings will bite at high volume:** Workers free = 100k req/day, KV free = 100k
  reads/day. Sustained high request rates need the **Workers Paid plan** ($5/mo). Cache the manifest
  in-isolate to avoid a KV/Supabase read per request.
- **Discord rate limits** are the reason Decision A exists — never forward the full 1gp firehose to a
  webhook.
- **Dedup** is handled by the `drop_key` unique constraint, absorbing Dink's retries.

---

## Limitations (know these going in)

- **Not every tile is a loot drop.** Clue/collection-log/pet/level/KC tiles come through *other* Dink
  notifier types ([dink-payloads.md](dink-payloads.md) lists `COLLECTION`, etc.), and some tiles
  ("finish a raid", "complete a quest") aren't Dink-trackable at all. Manual submission must remain as
  the fallback for those. Auto-tracking covers item-drop tiles.
- **Config propagation delay.** Dink fetches the dynamic config periodically, and the manifest cache
  has a TTL — lowering the threshold and starting an event aren't instant; allow lead time.
- **Availability.** If the proxy or the bot poller is down mid-event, matched drops in `dink_drops`
  are still durable (proxy write is independent of the bot), but unrecorded drops during a proxy
  outage are lost — keep manual submission available as a backstop.
- **Bingo system is currently archived** ([voli-disc-bot/CLAUDE.md:12](../../voli-disc-bot/CLAUDE.md#L12));
  reactivating/adapting `db/bingo_event.js`, `config/bingoTiles.json`, and `services/bingoBoard.js` is
  part of this effort.

---

## Open decisions

1. **Manifest delivery:** Worker reads Supabase (recommended) vs. bot pushes to KV.
2. **Tile items in the DB:** promote `bingoTiles.json` into a table / `events` column so the proxy can
   read the active tile set (and add `item_id`s).
3. **Supabase auth from the Worker:** service-role secret vs. anon key + insert RLS policy.
4. **Discord feed during bingos:** keep the normal 3M+ feed running, or mute it for bingo items to
   avoid double-posting?
5. **Reward model:** auto-award on tile completion, or auto-record + light admin confirm for big tiles?

---

## Suggested implementation phases

1. **Capture & verify payloads.** Trigger a real tile-item drop with the lowered threshold and record
   the LOOT payload into [dink-payloads.md](dink-payloads.md) (confirm `id`/`name`/`source`/`quantity`).
2. **Proxy Decision A.** Add the Discord feed policy (value/allowlist) so lowering the threshold
   doesn't flood Discord. Ship and verify the feed looks unchanged.
3. **Manifest + Decision B (no writes).** Add the cached manifest and matching; `log()` matches only.
   Verify matches are detected correctly with no side effects.
4. **Ingestion.** Create `dink_drops`, write matched drops with dedupe via `ctx.waitUntil`.
5. **Bot poller.** Add the consumer (modeled on `siteSubmissionPoller.js`) to apply progress to
   `bingo_event_progress` and refresh the board.
6. **End-to-end test** on a throwaway bingo event with a couple of cheap tile items.

---

## References

dink-proxy: [src/index.js](../src/index.js) · [dinkconfig-template.json](../dinkconfig-template.json) ·
[wrangler.jsonc](../wrangler.jsonc) · [dink-payloads.md](dink-payloads.md) ·
[bot-integration.md](bot-integration.md)

voli-disc-bot: `config/bingoTiles.json` · `db/bingo_event.js` · `db/supabase.js` (player lookups) ·
`db/dinkTokens.js` · `services/dinkProxy.js` (CF sync pattern) · `jobs/siteSubmissionPoller.js`
(poller pattern) · `handlers/bridge.js` (inbound bridge — not used here)
