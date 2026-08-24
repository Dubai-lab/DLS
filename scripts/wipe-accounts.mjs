#!/usr/bin/env node
/* ============================================================================
   Delete every Supabase Auth user, so the platform starts from nothing.

     node scripts/wipe-accounts.mjs --dry-run   # list who would go
     node scripts/wipe-accounts.mjs --confirm   # actually delete

   This is destructive and irreversible. It requires --confirm; there is no
   default that deletes.

   Table data is NOT touched here - `supabase/schema.sql` drops and recreates
   the tables, and deleting the users cascades to memberships anyway.

   Recovery, if this turns out to be a mistake:
     - backups/supabase-documents-*.json  (the migrated competition data)
     - the original Firebase RTDB, which was never deleted
   ========================================================================= */

import { readFileSync, existsSync } from 'node:fs';
import { argv } from 'node:process';

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
  return { url: url.replace(/\/+$/, ''), key };
}

const cfg = loadEnv();
const dryRun = argv.includes('--dry-run');
const confirmed = argv.includes('--confirm');

async function api(path, opts = {}) {
  const r = await fetch(`${cfg.url}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      ...(opts.headers || {})
    }
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path} (${r.status}): ${text}`);
  return text ? JSON.parse(text) : null;
}

const res = await api('/auth/v1/admin/users?per_page=500');
const users = Array.isArray(res) ? res : res.users || [];

if (!users.length) {
  console.log('\n  No accounts found - already clean.\n');
  process.exit(0);
}

console.log(`\n  ${users.length} account(s):\n`);
for (const u of users) {
  const kind = u.is_anonymous ? 'anonymous' : (u.email || '(no email)');
  console.log(`    ${kind.padEnd(32)} created ${(u.created_at || '').slice(0, 10)}`);
}

if (dryRun) {
  console.log('\n  --dry-run: nothing deleted.\n');
  process.exit(0);
}

if (!confirmed) {
  console.log('\n  Refusing to delete without --confirm.');
  console.log('  Re-run as: node scripts/wipe-accounts.mjs --confirm\n');
  process.exit(1);
}

let removed = 0;
for (const u of users) {
  try {
    await api(`/auth/v1/admin/users/${u.id}`, { method: 'DELETE' });
    removed++;
  } catch (e) {
    console.error(`    failed to delete ${u.email || u.id}: ${e.message}`);
  }
}

console.log(`\n  Deleted ${removed} of ${users.length} account(s).`);
console.log('  Next: run supabase/schema.sql, then register through the app.\n');
