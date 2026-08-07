// Post a fake Dink LOOT drop through the REAL worker code, in-process, against whatever
// Supabase the shell points at. No deploy, no wrangler, no RuneLite.
//
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
//     node scripts/send-test-drop.mjs --token <t> --rsn bajj --value 60000000
//
// Options:
//   --token T   a valid row in dink_tokens (the member's config URL token)
//   --rsn R     the player name Dink would report
//   --value N   single-stack gp value — what the Battleship tiers are judged on
//   --item S    item name (default "Twisted bow")
//   --item-id N item id (default 20997)
//   --source S  the NPC/container (default "Chambers of Xeric")
//
// POINT THIS AT STAGING. It writes a real row to vs_dink_drops for the RSN you give it,
// and against a database with a live Battleship battle that row can arm a real bomb.
//
// It exercises the whole worker path — token validation, the manifest load (including
// vs_value_tracked_rsns), and the admission rule — which is the part no other test in
// either repo covers. What it does NOT cover is Cloudflare itself: routing, secrets and
// the deployed bundle. A green run here means the code is right, not that it is live.

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

if (!TOKEN || !RSN || !VALUE) {
	console.error('need --token, --rsn and --value (see the header of this file)');
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
	WEBHOOK_ACHIEVEMENTS: 'http://127.0.0.1:9099/no-discord-here'
};

const payload = {
	type: 'LOOT',
	playerName: RSN,
	extra: { source: SOURCE, items: [{ id: ITEM_ID, quantity: 1, priceEach: VALUE, name: ITEM }] }
};

const form = new FormData();
form.set('payload_json', JSON.stringify(payload));

const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };

console.log(`→ ${RSN}: ${ITEM} worth ${VALUE.toLocaleString()} gp from ${SOURCE}`);
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
console.log('\nNow drain the consumer on the site side and check the outcome:');
console.log('  vs_dink_drops.outcome should be "bomb"; the arsenal should grow by one.');
process.exit(failed ? 1 : 0);
