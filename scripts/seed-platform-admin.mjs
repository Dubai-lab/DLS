#!/usr/bin/env node
/* ============================================================================
   Grant (or revoke) platform-owner access.

     node scripts/seed-platform-admin.mjs --list
     node scripts/seed-platform-admin.mjs you@example.com          # create + grant
     node scripts/seed-platform-admin.mjs you@example.com --revoke

   If the email has no account yet, one is created with a generated password and
   no league. That keeps the platform owner separate from any tenant: an account
   that runs a league should not also be able to see every other league.

   A platform admin can see and manage every league on the installation. That
   is deliberately not something the app can grant itself - it only happens
   from here, with the service key, on your machine.
   ========================================================================= */

import { readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { argv } from 'node:process';

function loadEnv() {
  if (!existsSync('.env')) throw new Error('.env not found - run from the repo root');
  const env = {};
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  const url = env.Supabase_URL || env.SUPABASE_URL;
  const key = env.Services_Key || env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('.env must define Supabase_URL and Services_Key');
  return { url: url.replace(/\/+$/, ''), key };
}

const cfg = loadEnv();

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

async function allUsers() {
  const res = await api('/auth/v1/admin/users?per_page=500');
  return Array.isArray(res) ? res : res.users || [];
}

/* ---------- list ---------- */

if (argv.includes('--list')) {
  const rows = await api('/rest/v1/platform_admins?select=user_id,created_at');
  if (!rows.length) {
    console.log('\n  No platform admins yet.\n');
  } else {
    const users = await allUsers();
    console.log('\n  Platform admins:\n');
    for (const r of rows) {
      const u = users.find(x => x.id === r.user_id);
      console.log(`    ${(u?.email || r.user_id).padEnd(34)} since ${String(r.created_at).slice(0, 10)}`);
    }
    console.log('');
  }
  process.exit(0);
}

/* ---------- grant / revoke ---------- */

const email = argv.find(a => a.includes('@'));
if (!email) {
  console.error('\n  Usage: node scripts/seed-platform-admin.mjs you@example.com [--revoke]');
  console.error('         node scripts/seed-platform-admin.mjs --list\n');
  process.exit(1);
}

const users = await allUsers();
let user = users.find(u => (u.email || '').toLowerCase() === email.toLowerCase());

/* A platform owner should not be a tenant. Registering through the app would
   force them to create a league, so the account is made here instead - already
   confirmed, with no membership of anything. */
if (!user && !argv.includes('--revoke')) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const password = Array.from(randomBytes(18), b => alphabet[b % alphabet.length]).join('');

  user = await api('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, password, email_confirm: true })
  });

  console.log(`\n  Created a new platform account.\n`);
  console.log(`    email     ${email}`);
  console.log(`    password  ${password}`);
  console.log(`\n  Save that now - it is not stored anywhere and is not shown again.`);
}

if (!user) {
  console.error(`\n  No account for ${email}.\n`);
  process.exit(1);
}

if (argv.includes('--revoke')) {
  await api(`/rest/v1/platform_admins?user_id=eq.${user.id}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' }
  });
  console.log(`\n  Revoked platform access for ${email}.\n`);
  process.exit(0);
}

await api('/rest/v1/platform_admins', {
  method: 'POST',
  headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
  body: JSON.stringify({ user_id: user.id })
});

console.log(`\n  ${email} is now a platform admin.`);
console.log('  Open /platform.html while signed in as that account.\n');
