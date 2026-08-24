#!/usr/bin/env node
/* ============================================================================
   Create the Supabase Auth accounts that replace the shared admin codes.

   Usage:
     node scripts/seed-admins.mjs --list                 # show configured admins
     node scripts/seed-admins.mjs                        # create accounts
     node scripts/seed-admins.mjs --reset-passwords      # new passwords for all

   Passwords are generated here and printed ONCE. Copy them somewhere safe -
   they are not stored anywhere by this script.
   ========================================================================= */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { argv } from 'node:process';

/* One owner plus one manager per competition, mirroring the old AA_COMPS list.
   Edit the emails before running. */
const ADMINS = [
  { email: 'eg8217178@gmail.com', name: 'Owner',            role: 'owner',   comps: ['league1','league2','league3','cl','europa'] },
  { email: 'league1@dls.local',   name: 'DLS League Admin', role: 'manager', comps: ['league1'] },
  { email: 'league2@dls.local',   name: 'DLS League 2 Admin', role: 'manager', comps: ['league2'] },
  { email: 'league3@dls.local',   name: 'DLS League 3 Admin', role: 'manager', comps: ['league3'] },
  { email: 'cl@dls.local',        name: 'Champions League Admin', role: 'manager', comps: ['cl'] },
  { email: 'europa@dls.local',    name: 'Europa League Admin',    role: 'manager', comps: ['europa'] }
];

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

// 16 chars, no ambiguous glyphs, safe to read aloud over the phone.
function makePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(16);
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}

async function api(cfg, path, opts = {}) {
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
  const body = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(`${path} (${r.status}): ${text}`);
  return body;
}

async function findUser(cfg, email) {
  const res = await api(cfg, `/auth/v1/admin/users?per_page=200`);
  const list = Array.isArray(res) ? res : res.users || [];
  return list.find(u => (u.email || '').toLowerCase() === email.toLowerCase()) || null;
}

if (argv.includes('--list')) {
  console.log('\n  Configured admins (edit scripts/seed-admins.mjs to change):\n');
  for (const a of ADMINS) {
    console.log(`  ${a.role.padEnd(8)} ${a.email.padEnd(28)} ${a.comps.join(', ')}`);
  }
  console.log('');
  process.exit(0);
}

const cfg = loadEnv();
const resetPasswords = argv.includes('--reset-passwords');
const created = [];

for (const a of ADMINS) {
  const password = makePassword();
  let user = await findUser(cfg, a.email);

  if (!user) {
    user = await api(cfg, '/auth/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email: a.email, password, email_confirm: true })
    });
    created.push({ ...a, password, status: 'created' });
  } else if (resetPasswords) {
    await api(cfg, `/auth/v1/admin/users/${user.id}`, {
      method: 'PUT',
      body: JSON.stringify({ password })
    });
    created.push({ ...a, password, status: 'password reset' });
  } else {
    created.push({ ...a, password: '(unchanged)', status: 'already existed' });
  }

  await api(cfg, '/rest/v1/admin_profiles', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      user_id: user.id,
      display_name: a.name,
      role: a.role,
      competitions: a.comps
    })
  });
}

console.log('\n  Admin accounts\n');
console.log('  ' + 'email'.padEnd(28) + 'role'.padEnd(10) + 'password'.padEnd(20) + 'status');
console.log('  ' + '-'.repeat(76));
for (const c of created) {
  console.log('  ' + c.email.padEnd(28) + c.role.padEnd(10) + c.password.padEnd(20) + c.status);
}

const fresh = created.filter(c => c.password !== '(unchanged)');
if (fresh.length) {
  const out = 'ADMIN-PASSWORDS.txt';
  writeFileSync(out,
    'DLS admin accounts - generated ' + new Date().toISOString() + '\n' +
    'Delete this file once the passwords are stored safely.\n\n' +
    fresh.map(c => `${c.email}\t${c.role}\t${c.password}`).join('\n') + '\n');
  console.log(`\n  Passwords also written to ${out} (gitignored). Delete it once saved.`);
}
console.log('');
