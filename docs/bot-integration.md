# Discord Bot ↔ Dink Proxy Integration Guide

How to wire your existing Discord bot into the dink-proxy Worker so that `/dink` issues per-user tokens, hands out a single dynamic-config URL, and stays in sync with Cloudflare.

This guide assumes you've already:
- Created the Supabase token table (see [Schema](#schema) — confirm your columns match).
- Have a working `/dink` slash command that currently returns a webhook URL (we'll repurpose it).
- Have admin access to the Cloudflare account hosting the Worker.

---

## Architecture

```
Discord user ──/dink──▶ Bot ──┬──▶ Supabase (mint/lookup token)
                              │
                              └──▶ Cloudflare API (sync VALID_TOKENS secret)

Discord user ──pastes config URL──▶ RuneLite Dink plugin
                                          │
                                          ▼
                                  GET /config/<token>
                                          │
                              dink-proxy Worker
                                          │
                       (returns Dink config JSON with webhook
                        URLs containing the user's token baked in)
                                          │
                                          ▼
                              Dink posts notifications to:
                              POST /hook/<token>/<channel>
```

Source of truth: **Supabase**. Cloudflare's `VALID_TOKENS` secret is a derived cache that the bot pushes to whenever the active-token set changes.

---

## Worker setup (one-time, before any bot work)

The Dink config template lives at [`/dinkconfig-template.json`](../dinkconfig-template.json) at the dink-proxy repo root. The Worker imports it at build time and substitutes `{{TOKEN}}` per request.

> **Why bundled in code, not a secret?** Cloudflare Workers caps text-binding values at 5.1 kB; the full Dink config is ~6.1 kB. Bundling sidesteps the limit. Tradeoff: updating the template requires `npx wrangler deploy` instead of just `wrangler secret put`.

### Build the template

Take your current Dink config JSON. Find every webhook URL field and replace it with the proxy URL containing `{{TOKEN}}` and the appropriate channel:

```json
{
  "deathWebhook":      "https://dink-proxy.voltionosrs.workers.dev/hook/{{TOKEN}}/deaths",
  "lootWebhook":       "https://dink-proxy.voltionosrs.workers.dev/hook/{{TOKEN}}/achievements",
  "collectionWebhook": "https://dink-proxy.voltionosrs.workers.dev/hook/{{TOKEN}}/collection",
  "petWebhook":        "https://dink-proxy.voltionosrs.workers.dev/hook/{{TOKEN}}/achievements",
  "discordWebhook":    "https://dink-proxy.voltionosrs.workers.dev/hook/{{TOKEN}}/achievements"
  // ...all other Dink settings preserved as-is
}
```

Channel routing (current Worker config):
- `/deaths` — death notifier
- `/achievements` — combat achievements, diary, quest, loot, pet, and any notifier without an explicit webhook override (`discordWebhook` is the fallback)
- `/collection` — collection log

Save the result as `dinkconfig-template.json` at the repo root.

### Deploy

```
npx wrangler deploy
```

The template is embedded in the bundle; no separate secret needed.

### Verify the config endpoint

Using the bootstrap test token already set as `VALID_TOKENS`:

```
curl https://dink-proxy.voltionosrs.workers.dev/config/testtoken123
```

Expect: your config JSON back, with every `{{TOKEN}}` replaced by `testtoken123`.

If you get `unauthorized` (401): the token isn't in `VALID_TOKENS`. (Once the bot is wired up, this will be an automatically-managed list.)

### Updating the template later

To change Dink settings clan-wide (e.g. tweak a message format, add a notifier):

1. Edit `dinkconfig-template.json`.
2. `npx wrangler deploy`.

Every clan member's Dink picks up the new config on its next dynamic-config fetch — typically within minutes.

---

## Schema

Confirm your existing table has at least these columns. If the names differ, adjust the SQL/code throughout this guide.

```sql
create table dink_tokens (
  token        text primary key,
  discord_id   text not null unique references clan_members(discord_id),
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz
);
create index on dink_tokens (discord_id) where revoked_at is null;
```

Key invariants:
- `discord_id` is `unique` → at most one token row per person (active or revoked). If you want to allow rotating a token (revoke old, mint new), drop the unique constraint and rely on the partial index for "active".
- `revoked_at` is the soft-delete column. `revoked_at IS NULL` = active.

> If your schema differs, tell me the actual column names and I'll update the code samples.

---

## Cloudflare API setup (one-time)

The bot needs to update the `VALID_TOKENS` secret on the Worker whenever the active token list changes.

1. **Generate an API token.** Cloudflare dashboard → My Profile → API Tokens → Create Token.
   - Use the **"Edit Cloudflare Workers"** template.
   - Account resources: include the account that owns `dink-proxy`.
   - Zone resources: not needed.
   - Copy the token once — you can't view it again.

2. **Find your Account ID.** Cloudflare dashboard → Workers & Pages → right sidebar shows "Account ID".

3. **Add to bot environment:**
   ```
   CF_API_TOKEN=<the token from step 1>
   CF_ACCOUNT_ID=<the account id from step 2>
   CF_WORKER_NAME=dink-proxy
   PROXY_BASE_URL=https://dink-proxy.voltionosrs.workers.dev
   ```

---

## Bot operations

Three core helpers. Adapt syntax to your bot's language/framework — examples are JS-flavored pseudocode.

### `getOrCreateToken(discordId)`

Returns the user's active token. Creates one if they don't have an active row.

```js
import crypto from 'node:crypto';

export async function getOrCreateToken(discordId) {
  const { data: existing } = await supabase
    .from('dink_tokens')
    .select('token')
    .eq('discord_id', discordId)
    .is('revoked_at', null)
    .maybeSingle();

  if (existing) return { token: existing.token, created: false };

  const token = crypto.randomBytes(24).toString('hex');
  const { error } = await supabase
    .from('dink_tokens')
    .insert({ token, discord_id: discordId });
  if (error) throw error;

  return { token, created: true };
}
```

### `revokeTokensFor(discordId)`

Soft-deletes all active tokens for a user.

```js
export async function revokeTokensFor(discordId) {
  const { error } = await supabase
    .from('dink_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('discord_id', discordId)
    .is('revoked_at', null);
  if (error) throw error;
}
```

### `syncWorker()`

Pulls the current active-token set from Supabase, joins comma-separated, and rewrites the Worker secret.

```js
export async function syncWorker() {
  const { data, error } = await supabase
    .from('dink_tokens')
    .select('token')
    .is('revoked_at', null);
  if (error) throw error;

  const list = data.map(r => r.token).join(',');

  const url = `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/workers/scripts/${process.env.CF_WORKER_NAME}/secrets`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${process.env.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'VALID_TOKENS',
      text: list,
      type: 'secret_text',
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Cloudflare secret update failed: ${res.status} ${body}`);
  }
}
```

Cloudflare picks up the new secret value within ~30 seconds for new requests. No Worker redeploy needed.

---

## Updating the `/dink` command

Replace whatever `/dink` currently returns with the dynamic-config URL. The user pastes one URL into Dink's "Dynamic Config" field and never sees the token directly.

```js
// Inside your existing /dink slash command handler:
export async function handleDinkCommand(interaction) {
  const discordId = interaction.user.id;

  // 1. Verify caller is in clan_members. Adapt to your existing check.
  const { data: member } = await supabase
    .from('clan_members')
    .select('discord_id')
    .eq('discord_id', discordId)
    .maybeSingle();
  if (!member) {
    return interaction.reply({
      content: 'You need to be in the clan members table first.',
      ephemeral: true,
    });
  }

  // 2. Get or mint their token.
  const { token, created } = await getOrCreateToken(discordId);

  // 3. If new token, push to Cloudflare so the Worker accepts it.
  if (created) await syncWorker();

  // 4. DM the user the single config URL.
  const configUrl = `${process.env.PROXY_BASE_URL}/config/${token}`;
  try {
    await interaction.user.send(
      `Your Dink config URL:\n\`${configUrl}\`\n\n` +
      `Paste this into RuneLite → Dink plugin → "Dynamic Config" field.\n` +
      `It auto-configures all your webhook URLs. Don't share this link — it's tied to your account.`
    );
    await interaction.reply({ content: 'Sent you a DM with your config URL.', ephemeral: true });
  } catch {
    // User has DMs disabled. Fall back to ephemeral reply (still private to them).
    await interaction.reply({
      content: `Couldn't DM you. Here it is (only you can see this):\n\`${configUrl}\``,
      ephemeral: true,
    });
  }
}
```

---

## Admin operations

### `/dink-revoke <user>` — revoke a clan member's token

For when someone leaves the clan, gets their config URL leaked, or you need to cut them off.

```js
export async function handleDinkRevokeCommand(interaction, targetUser) {
  // Add your own admin permission check here.
  await revokeTokensFor(targetUser.id);
  await syncWorker();
  await interaction.reply({
    content: `Revoked Dink access for ${targetUser.tag}.`,
    ephemeral: true,
  });
}
```

### Auto-revoke on clan-leave

If your bot already has a "user removed from clan_members" event/flow, hook into it:

```js
// In whatever code handles "remove from clan_members"
async function removeFromClan(discordId) {
  await supabase.from('clan_members').delete().eq('discord_id', discordId);
  await revokeTokensFor(discordId);
  await syncWorker();
}
```

This keeps Supabase as the single source of truth for clan membership — leaving the clan automatically kills Dink access.

---

## Worker reference (already deployed)

For reference — these are the routes the Worker exposes:

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/config/:token`         | Returns Dink config JSON with `{{TOKEN}}` substituted from the bundled template. 401 if token isn't in `VALID_TOKENS`. |
| `POST` | `/hook/:token/:channel`  | Forwards Dink notification to the channel's Discord webhook. 401 on bad token, 404 on unknown channel, 415 on unsupported content type. Injects `allowed_mentions: {parse: []}` to neutralize `@everyone`/`@here`/role pings. |

Anything else → 404. Worker secrets the bot doesn't touch:
- `WEBHOOK_ACHIEVEMENTS`, `WEBHOOK_DEATHS`, `WEBHOOK_COLLECTION` — the real Discord webhook URLs.

The Dink config template lives in source at [`dinkconfig-template.json`](../dinkconfig-template.json), bundled into the Worker at build time. The bot only writes to: `VALID_TOKENS`.

---

## Operational notes

- **Sync failures are not fatal to mint.** If `syncWorker()` throws, the token still exists in Supabase but isn't yet accepted by the Worker. Your `/dink` handler should retry, or surface the error to the user with "try again in a minute". A periodic safety-net `syncWorker()` (cron every 5–15 min) is cheap insurance.
- **Rate limits.** Cloudflare's secrets API is generous (well above clan-scale traffic), but if you ever do bulk operations, batch them and call `syncWorker()` once at the end rather than per-user.
- **Don't log tokens.** They're bearer credentials. If you need to audit who's posting, log `discord_id` instead.
- **Rotation.** If a single user's token leaks, run `revokeTokensFor` then have them call `/dink` again — they'll get a new token. If `CF_API_TOKEN` itself leaks, regenerate it in the Cloudflare dashboard and update the bot env.
- **Config template changes.** Edit `dinkconfig-template.json` and run `npx wrangler deploy`. Every user's Dink picks up the new config on its next dynamic-config fetch (within minutes).

---

## End-to-end test path

Once everything is wired:

1. Bot env vars set (`CF_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_WORKER_NAME`, `PROXY_BASE_URL`).
2. `dinkconfig-template.json` populated, `npx wrangler deploy` succeeded.
3. Run `/dink` as yourself in Discord — DM should arrive with a config URL like `.../config/<48-hex-chars>`.
4. Check Supabase: a row should exist in `dink_tokens` for your `discord_id`.
5. Cloudflare dashboard → dink-proxy → Settings → Variables: `VALID_TOKENS` "last updated" timestamp should be recent (you can't see the value).
6. `curl https://dink-proxy.voltionosrs.workers.dev/config/<your-token>` → should return your config JSON with the token substituted into webhook URLs.
7. Paste the config URL into RuneLite Dink "Dynamic Config" field. Trigger a Send Test on any notifier — should land in the right Discord channel.
8. Run `/dink-revoke @yourself` (or the equivalent admin flow). Re-curl `/config/<your-token>` — expect 401. Trigger another Dink notifier — expect 401 from the hook endpoint, no Discord message.
