#!/usr/bin/env node
/* ============================================================================
   Firebase RTDB  ->  Supabase documents table

   Usage:
     node scripts/migrate-to-supabase.mjs                 # live Firebase -> Supabase
     node scripts/migrate-to-supabase.mjs --from <file>   # from a backup file
     node scripts/migrate-to-supabase.mjs --dry-run       # show plan, write nothing
     node scripts/migrate-to-supabase.mjs --recover-league1
         Rebuild the flattened dls_admin_league from the intact dls_pub_league
         mirror before migrating.

   Reads credentials from .env. Uses the service_role key, which bypasses RLS -
   this script runs on your machine only and its key must never ship in the app.
   ========================================================================= */

import { readFileSync, existsSync } from 'node:fs';
import { argv } from 'node:process';

const FIREBASE_URL = 'https://dls-hub-62226-default-rtdb.firebaseio.com';

// Nodes deliberately left behind.
const SKIP = {
  dls_admin_auth: 'replaced by Supabase Auth (auth.users + admin_profiles)',
  dls_push:       'web-push VAPID subscriptions, obsolete under FCM',
  dls_push_subs:  'web-push VAPID subscriptions, obsolete under FCM'
};

/* ---------- env ---------- */

function loadEnv() {
  if (!existsSync('.env')) throw new Error('.env not found - run from the repo root');
  const env = {};
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  const url = env.Supabase_URL || env.SUPABASE_URL;
  const key = env.Services_Key || env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('.env must define Supabase_URL and Services_Key');
  return { url, key };
}

/* ---------- args ---------- */

const dryRun    = argv.includes('--dry-run');
const recover   = argv.includes('--recover-league1');
const fromIdx   = argv.indexOf('--from');
const fromFile  = fromIdx > -1 ? argv[fromIdx + 1] : null;

/* ---------- source ---------- */

async function loadSource() {
  if (fromFile) {
    console.log(`Reading snapshot: ${fromFile}`);
    return JSON.parse(readFileSync(fromFile, 'utf8'));
  }
  console.log('Reading live Firebase RTDB...');
  const r = await fetch(`${FIREBASE_URL}/.json`);
  if (!r.ok) throw new Error(`Firebase read failed: ${r.status}`);
  return r.json();
}

/* ---------- recovery ---------- */

// dls_admin_league was flattened to defaults on 2026-08-24 when a device with
// empty localStorage PUT defaultLS() over it. dls_pub_league is the published
// mirror and still holds the full season, so the admin document rebuilds from it.
function rebuildLeague1(pub) {
  if (!pub || !Array.isArray(pub.table) || !pub.table.length) return null;
  return {
    teams:         pub.table.map(row => row.team),
    phones:        pub.phones || {},
    logos:         pub.logos || {},
    matchdays:     pub.allMatchdays || [],
    seasons:       pub.seasons || [],
    generated:     true,
    currentDay:    typeof pub.currentMatchday === 'number' ? pub.currentMatchday : 0,
    currentSeason: typeof pub.currentSeason === 'number' ? pub.currentSeason : 1,
    savedAt:       Date.now(),
    recoveredFrom: 'dls_pub_league',
    recoveredAt:   new Date().toISOString()
  };
}

/* ---------- upsert ---------- */

async function upsert(cfg, rows) {
  const r = await fetch(`${cfg.url}/rest/v1/documents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(rows)
  });
  if (!r.ok) throw new Error(`upsert failed (${r.status}): ${await r.text()}`);
}

/* ---------- main ---------- */

const cfg  = loadEnv();
const tree = await loadSource();

const rows = [];
const plan = [];

for (const [path, data] of Object.entries(tree)) {
  if (SKIP[path]) { plan.push([path, 'SKIP', SKIP[path]]); continue; }
  rows.push({ path, data, updated_at: new Date().toISOString() });
  const size = JSON.stringify(data).length;
  plan.push([path, `${size} B`, Array.isArray(data)
    ? `array[${data.length}]`
    : `object{${Object.keys(data || {}).length}}`]);
}

if (recover) {
  const rebuilt = rebuildLeague1(tree.dls_pub_league);
  if (!rebuilt) {
    console.error('  cannot recover league1: dls_pub_league has no table');
  } else {
    const row = rows.find(x => x.path === 'dls_admin_league');
    if (row) row.data = rebuilt; else rows.push({ path: 'dls_admin_league', data: rebuilt });
    plan.push(['dls_admin_league', 'REBUILT',
      `${rebuilt.teams.length} teams, ${rebuilt.matchdays.length} matchdays, season ${rebuilt.currentSeason}`]);
  }
}

console.log('\n  path                      size        shape');
console.log('  ' + '-'.repeat(68));
for (const [p, s, d] of plan) {
  console.log(`  ${p.padEnd(24)} ${String(s).padEnd(11)} ${d}`);
}
console.log(`\n  ${rows.length} documents to write, ${Object.keys(SKIP).length} skipped`);

if (dryRun) {
  console.log('\n  --dry-run: nothing written.');
  process.exit(0);
}

await upsert(cfg, rows);
console.log('\n  Migration complete.');

// Read back through the anon path to prove RLS lets the public surface through.
const check = await fetch(`${cfg.url}/rest/v1/documents?select=path&order=path`, {
  headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` }
});
const stored = await check.json();
console.log(`  Verified ${stored.length} rows in Supabase: ${stored.map(r => r.path).join(', ')}`);
