// Post a fake Dink LOOT drop through the REAL worker code, in-process, against whatever
// Supabase the shell points at. No deploy, no wrangler, no RuneLite.
//
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
//     node scripts/send-test-drop.mjs --token <t> --rsn bajj --item "Serpentine visage" \
//       --item-id 12927 --source Zulrah
//
// Options:
//   --token T   a valid row in dink_tokens (the member's config URL token)
//   --rsn R     the player name Dink would report
//   --item S    item name (default "Twisted bow")
//   --item-id N item id (default 20997)
//   --source S  the NPC/container (default "Chambers of Xeric")
//   --value N   single-stack gp value (optional — tracked-item drops are admitted by the
//               allowlist regardless; value only matters for value-floor admission, e.g.
//               Battleship bombs)
//   --qty N     stack size (default 1)
//
// POINT THIS AT STAGING. It writes a real row to vs_dink_drops for the RSN you give it —
// against a database with a live event, that row credits a real tile / arms a real bomb.
// For an event rehearsal, use the item/source of a LIVE objective (the connect4 rail
// names them) and the RSN of someone seated on a side.
//
// USE A NON-TEST GAME. A connect4 game created with the "Test game" box ticked refuses
// real-shaped drop keys BY DESIGN (only `test-`/`manual:`/`admin:` keys land, so live
// Dink traffic can never fill a test board) — a drop sent here against one reports 204
// from the worker and then dies as `no_tile` in the consumer. Create the rehearsal game
// with the box unticked; to delete it afterwards, flip `structure.connect4.test` to true
// in the DB first (deletion refuses non-test games as a guard).
//
// THE DRAIN PING RUNS TOO when the shell provides it:
//
//   SITE_URL=https://volition-site-staging.fly.dev DINK_PROCESS_SECRET=… node scripts/…
//
// With both set, the worker's after-insert ping fires at the real staging site, the drop
// is credited within a second or two, and any open board repaints on its next 3s version
// poll — the full pipeline, no deploy. Without them the ping is skipped (the site's
// poll-on-read backstop still credits eventually), matching a proxy with no SITE_URL.
//
// It exercises the whole worker path — token validation, the manifest load, the admission
// rule, and the drain ping — which is the part no other test in either repo covers. What
// it does NOT cover is Cloudflare itself: routing, secrets and the deployed bundle. A
// green run here means the code is right, not that it is live. The deployed rehearsal
// twin is `npx wrangler deploy --env staging` (see wrangler.jsonc).

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const TOKEN = opt('token');
const RSN = opt('rsn');
const VALUE = Number(opt('value', '0'));
const ITEM = opt('item', 'Twisted bow');
const ITEM_ID = Number(opt('item-id', '20997'));
const SOURCE = opt('source', 'Chambers of Xeric');
const QTY = Number(opt('qty', '1'));

if (!TOKEN || !RSN) {
	console.error('need --token and --rsn (see the header of this file)');
	process.exit(1);
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
	console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set — point them at STAGING');
	process.exit(1);
}

// Workers resolves `import x from "./x.json"` bare; Node requires an import attribute.
// Copy the worker verbatim with only that one line adjusted, so the logic under test is
// byte-identical to what gets deployed.
const dir = mkdtempSync(join(tmpdir(), 'dink-proxy-'));
const src = readFileSync(join(ROOT, 'src', 'index.js'), 'utf8');
const patched = src.replace(
	/^import dinkConfigTemplate from "\.\.\/dinkconfig-template\.json";$/m,
	`import dinkConfigTemplate from ${JSON.stringify(pathToFileURL(join(ROOT, 'dinkconfig-template.json')).href)} with { type: "json" };`
);
if (patched === src) {
	console.error('could not adjust the JSON import — has src/index.js line 1 changed?');
	process.exit(1);
}
writeFileSync(join(dir, 'worker.mjs'), patched);
const worker = (await import(pathToFileURL(join(dir, 'worker.mjs')).href)).default;

const env = {
	SUPABASE_URL: process.env.SUPABASE_URL,
	SUPABASE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
	// No caching, so a manifest change (a battle opening) is picked up immediately.
	MANIFEST_TTL_MS: '1',
	TOKENS_TTL_MS: '1',
	// The Discord forward is expected to fail and is irrelevant: the Supabase write runs
	// first, through ctx.waitUntil, and that is what is being tested.
	WEBHOOK_ACHIEVEMENTS: 'http://127.0.0.1:9099/no-discord-here',
	// The drain ping fires only when the shell provides the real pair (see header).
	SITE_URL: process.env.SITE_URL || '',
	DINK_PROCESS_SECRET: process.env.DINK_PROCESS_SECRET || ''
};
if (env.SITE_URL && env.DINK_PROCESS_SECRET) {
	console.log(`drain ping armed → ${env.SITE_URL}`);
} else {
	console.log('drain ping OFF (set SITE_URL + DINK_PROCESS_SECRET to exercise it)');
}

const payload = {
	type: 'LOOT',
	playerName: RSN,
	extra: { source: SOURCE, items: [{ id: ITEM_ID, quantity: QTY, priceEach: VALUE, name: ITEM }] }
};

const form = new FormData();
form.set('payload_json', JSON.stringify(payload));

const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };

console.log(`→ ${RSN}: ${QTY}x ${ITEM}${VALUE ? ` worth ${VALUE.toLocaleString()} gp` : ''} from ${SOURCE}`);
try {
	const res = await worker.fetch(
		new Request(`https://dink-proxy.local/hook/${TOKEN}/achievements`, { method: 'POST', body: form }),
		env,
		ctx
	);
	if (res.status === 401) {
		console.error('  ✗ 401 — that token is not in dink_tokens for this database');
		process.exit(1);
	}
	console.log(`  worker responded ${res.status}`);
} catch (e) {
	// Only the Discord forward can throw here; the DB write is already queued.
	console.log(`  (Discord forward failed, as expected: ${e.message})`);
}

const settled = await Promise.allSettled(pending);
let failed = 0;
for (const r of settled) {
	if (r.status === 'rejected') {
		failed++;
		console.error(`  ✗ background write failed: ${r.reason?.message ?? r.reason}`);
	}
}
console.log(`  ${settled.length} background task(s) settled${failed ? `, ${failed} failed` : ''}`);
if (env.SITE_URL && env.DINK_PROCESS_SECRET) {
	console.log('\nThe drain ping ran with the insert — check the board (it repaints on its');
	console.log('next 3s version poll) or vs_dink_drops.outcome for the credit.');
} else {
	console.log('\nNo ping was sent. Drain the consumer on the site side (open the connect4');
	console.log('tester, or POST /api/dink/process) and check vs_dink_drops.outcome.');
}
process.exit(failed ? 1 : 0);
