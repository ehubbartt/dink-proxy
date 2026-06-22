# Dink Payload Reference

Captured payloads from the RuneLite Dink plugin, indexed by notifier type. Used as fixtures when building proxy validation (clan-RSN check, `@everyone` strip, Dink-shape verification).

## Request shape (all notifiers)

- Method: `POST`
- Content-Type varies based on whether Dink is attaching a screenshot:
  - **No attachment:** `application/json; charset=utf-8` — the entire body is the JSON payload directly.
  - **With attachment:** `multipart/form-data; boundary=<uuid>` — two parts:
    1. `payload_json` — JSON string (Discord webhook fields + Dink-specific fields)
    2. `file` — attachment (typically a screenshot PNG)

Body sizes seen so far: ~2 KB (JSON-only loot drop) up to ~2.6 MB (death with screenshot).

The proxy must handle both content types. `request.formData()` works for multipart; `request.json()` for the JSON-only case. Branch on `Content-Type`.

## Common `payload_json` fields

These appear on every notifier:

| Field | Type | Notes |
|---|---|---|
| `type` | string | Notifier type, e.g. `DEATH`, `COLLECTION`, `COMBAT_ACHIEVEMENT` |
| `playerName` | string | RSN — **the field we'll use for clan-membership filter** |
| `accountType` | string | `NORMAL`, `IRONMAN`, `GROUP_IRONMAN`, etc. |
| `dinkAccountHash` | string | Stable per-account hash from Dink, safe to log |
| `clanName` | string? | In-game clan name. Optional — absent in LOOT payloads. |
| `groupIronClanName` | string? | Group iron clan name, if applicable |
| `seasonalWorld` | bool | |
| `world` | int | World number |
| `regionId` | int | |
| `extra` | object | Notifier-specific payload (see per-type sections) |
| `discordUser` | object | `{id, name, avatarHash}` of the linked Discord account |
| `embeds` | array | Discord embed objects — what renders in the channel |

The `embeds[].image.url` typically references `attachment://<filename>` matching the file part.

---

## DEATH

Captured 2026-05-04. Source: `bajj` died to an Iron Dragon.

```json
{
  "type": "DEATH",
  "playerName": "bajj",
  "accountType": "GROUP_IRONMAN",
  "dinkAccountHash": "e9428ba6c52f561b327f49d0e4efc91e54b4e31b3169b5cfd5fa0885",
  "clanName": "Volition",
  "groupIronClanName": "CooLdude420",
  "seasonalWorld": false,
  "world": 415,
  "regionId": 6557,
  "extra": {
    "valueLost": 0,
    "isPvp": false,
    "killerName": "Iron dragon",
    "killerNpcId": 7254,
    "keptItems": [
      { "id": 13393, "quantity": 1, "priceEach": 351, "name": "Xeric's talisman" },
      { "id": 32399, "quantity": 1, "priceEach": 351, "name": "Sailors' amulet" },
      { "id": 22081, "quantity": 1, "priceEach": 2,   "name": "Locator orb" }
    ],
    "lostItems": [],
    "location": { "regionId": 6557, "plane": 0, "instanced": false }
  },
  "discordUser": {
    "id": "172117551524872192",
    "name": "_bajj",
    "avatarHash": "01ad22f05412f060254bdf3f6d8463fb"
  },
  "embeds": [
    {
      "title": "Player Death",
      "description": "bajj Has shit a brick",
      "author": {
        "name": "bajj",
        "icon_url": "https://oldschool.runescape.wiki/images/Group_ironman_chat_badge.png",
        "url": "https://secure.runescape.com/m=hiscore_oldschool/hiscorepersonal?user1=bajj"
      },
      "color": 15990936,
      "image": { "url": "attachment://deathImage.png" },
      "thumbnail": { "url": "https://oldschool.runescape.wiki/images/Items_kept_on_death.png" },
      "fields": [],
      "footer": {
        "text": "Powered by Dink",
        "icon_url": "https://github.com/pajlads/DinkPlugin/raw/master/icon.png"
      },
      "timestamp": "2026-05-04T18:31:08.841882Z"
    }
  ]
}
```

Attachment: `deathImage.png` (~2.5 MB in this sample).

DEATH-specific `extra` fields:
- `isPvp`, `killerName`, `killerNpcId`
- `valueLost` — total GE value of `lostItems`
- `keptItems[]`, `lostItems[]` — each item: `{id, quantity, priceEach, name}`
- `location` — `{regionId, plane, instanced}`

---

## LOOT

Captured 2026-05-05. Source: `bajj` killed a Cow calf, no screenshot attached → request was `application/json`.

```json
{
  "type": "LOOT",
  "playerName": "bajj",
  "accountType": "GROUP_IRONMAN",
  "dinkAccountHash": "e9428ba6c52f561b327f49d0e4efc91e54b4e31b3169b5cfd5fa0885",
  "groupIronClanName": "CooLdude420",
  "seasonalWorld": false,
  "world": 338,
  "regionId": 12851,
  "extra": {
    "items": [
      { "criteria": ["VALUE"], "id": 526,  "quantity": 1, "priceEach": 31,  "name": "Bones" },
      { "criteria": ["VALUE"], "id": 2132, "quantity": 1, "priceEach": 31,  "name": "Raw beef" },
      { "criteria": ["VALUE"], "id": 1739, "quantity": 1, "priceEach": 114, "name": "Cowhide" }
    ],
    "source": "Cow calf",
    "category": "NPC",
    "killCount": 28,
    "npcId": 2794
  },
  "discordUser": {
    "id": "172117551524872192",
    "name": "_bajj",
    "avatarHash": "01ad22f05412f060254bdf3f6d8463fb"
  },
  "embeds": [
    {
      "title": "Loot Drop",
      "description": "bajj has looted: \n\n1 x [Bones](https://oldschool.runescape.wiki/w/Special:Search?search=Bones) (31)\n1 x [Raw beef](https://oldschool.runescape.wiki/w/Special:Search?search=Raw%20beef) (31)\n1 x [Cowhide](https://oldschool.runescape.wiki/w/Special:Search?search=Cowhide) (114)\nFrom: [Cow calf](https://oldschool.runescape.wiki/w/Special:Search?search=Cow%20calf)",
      "author": { "name": "bajj", "icon_url": "...", "url": "..." },
      "color": 15990936,
      "thumbnail": { "url": "https://static.runelite.net/cache/item/icon/1739.png" },
      "fields": [
        { "name": "Kill Count",  "value": "```\n28\n```",         "inline": true },
        { "name": "Total Value", "value": "```ldif\n176 gp\n```", "inline": true }
      ],
      "footer": { "text": "Powered by Dink", "icon_url": "..." },
      "timestamp": "2026-05-05T15:33:20.388452Z"
    },
    { "image": { "url": "https://static.runelite.net/cache/item/icon/526.png" } },
    { "image": { "url": "https://static.runelite.net/cache/item/icon/2132.png" } },
    { "image": { "url": "https://static.runelite.net/cache/item/icon/1739.png" } }
  ]
}
```

No file attachment.

LOOT-specific `extra` fields:
- `items[]` — each item: `{id, quantity, priceEach, name, criteria[]}`. `criteria` indicates which Dink filter triggered the notification (e.g. `VALUE`, `NAME`, `RARITY`).
- `source` — what dropped the loot (NPC name, container name, etc.)
- `category` — `NPC`, `EVENT`, `PLAYER`, `PICKPOCKET`, etc.
- `killCount` — kill count of source if NPC
- `npcId` — present when category is NPC

Note: the `embeds[]` array has multiple embed objects — one main embed plus thumbnail-only embeds for each looted item icon. Discord renders this as a single message with multiple item images.

---

## COLLECTION

Captured 2026-05-05. Source: `bajj` unlocked `Victor's cape (1)`. Multipart request (screenshot attached).

```json
{
  "type": "COLLECTION",
  "playerName": "bajj",
  "accountType": "GROUP_IRONMAN",
  "dinkAccountHash": "e9428ba6c52f561b327f49d0e4efc91e54b4e31b3169b5cfd5fa0885",
  "clanName": "Volition",
  "groupIronClanName": "CooLdude420",
  "seasonalWorld": false,
  "world": 338,
  "regionId": 12600,
  "extra": {
    "itemName": "Victor's cape (1)",
    "itemId": 24207,
    "price": 4,
    "completedEntries": 322,
    "totalEntries": 1699,
    "currentRank": "IRON",
    "rankProgress": 22,
    "logsNeededForNextRank": 178,
    "nextRank": "STEEL"
  },
  "discordUser": { "id": "...", "name": "_bajj", "avatarHash": "..." },
  "embeds": [ "<truncated in initial log; recapture after log-format fix>" ]
}
```

COLLECTION-specific `extra` fields:
- `itemName`, `itemId`, `price` — the unlocked log slot's item
- `completedEntries`, `totalEntries` — collection log progress overall
- `currentRank`, `nextRank` — collection log rank tier (BRONZE / IRON / STEEL / etc.)
- `rankProgress` — entries completed within the current rank tier
- `logsNeededForNextRank` — entries remaining to reach `nextRank`

---

## ACHIEVEMENTS

Dink has multiple notifier types that may map to the achievements channel. Each has a different `type` value and `extra` shape — capture all that you'll route to that channel:

- `COMBAT_ACHIEVEMENT` — combat achievement task completed
- `ACHIEVEMENT_DIARY` — diary task / tier completed
- `QUEST` — quest completed
- `LEVEL` — level up (if you want these here)
- `PET` — pet drop (if you want these here)

_TBD — trigger each desired type via Dink "Send Test" and paste payloads below._

### COMBAT_ACHIEVEMENT

_TBD_

### ACHIEVEMENT_DIARY

_TBD_

### QUEST

_TBD_

---

## Notes for proxy validation logic

- `playerName` is the canonical RSN to match against Supabase clan list.
- `dinkAccountHash` could be used as an alternative/secondary key (more stable than RSN if names change), but you'd need to store hashes in Supabase up front.
- Strip mentions: scan `embeds[].description`, `embeds[].title`, `embeds[].fields[].value`, and any top-level `content` for `@everyone` / `@here` / `<@&...>`.
- Multipart parsing: use `request.formData()` in the Worker. Pull `payload_json`, `JSON.parse`, validate, modify if needed, reassemble FormData with the file part untouched, forward.
