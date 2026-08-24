#!/usr/bin/env node
/* ============================================================================
   Verify the SMTP credentials in .env, and optionally send a real test email.

     node scripts/test-smtp.mjs                 # connect and authenticate only
     node scripts/test-smtp.mjs --send you@x.com  # also send a sample

   Run this before wiring SMTP into Supabase - a bad app password fails silently
   in the dashboard, and you find out when a player never gets their code.
   ========================================================================= */

import { readFileSync, existsSync } from 'node:fs';
import { argv } from 'node:process';
import nodemailer from 'nodemailer';

if (!existsSync('.env')) { console.error('.env not found - run from the repo root'); process.exit(1); }

const env = {};
for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
}

const host = env.SMTP_HOST;
const user = env.SMTP_USER;
const pass = env.SMTP_PASSWORD;
const port = Number(env.SMTP_PORT || 587) || 587;

if (!host || !user || !pass) {
  console.error('Missing SMTP_HOST, SMTP_USER or SMTP_PASSWORD in .env');
  process.exit(1);
}

console.log(`\n  host  ${host}:${port}`);
console.log(`  user  ${user}`);
console.log(`  pass  ${'*'.repeat(Math.min(pass.length, 16))} (${pass.length} chars)\n`);

// Gmail app passwords are 16 characters. They are often pasted with the spaces
// Google displays them with, which fails authentication in a confusing way.
if (/gmail|google/i.test(host) && pass.replace(/\s/g, '').length !== 16) {
  console.warn('  Warning: Gmail app passwords are 16 characters. This one is ' +
               pass.replace(/\s/g, '').length + '.');
}
if (/\s/.test(pass)) {
  console.warn('  Warning: the password contains spaces. Google shows app passwords');
  console.warn('           in groups of four, but they must be stored without spaces.\n');
}

const transport = nodemailer.createTransport({
  host, port,
  secure: port === 465,
  requireTLS: port === 587,
  auth: { user, pass }
});

try {
  await transport.verify();
  console.log('  Connection and authentication: OK\n');
} catch (e) {
  console.error('  FAILED: ' + e.message + '\n');
  if (/invalid login|username and password/i.test(e.message)) {
    console.error('  For Gmail this almost always means:');
    console.error('    - 2-step verification is not enabled on the account, or');
    console.error('    - this is the account password rather than an app password, or');
    console.error('    - the app password was pasted with spaces.\n');
  }
  process.exit(1);
}

const sendIdx = argv.indexOf('--send');
if (sendIdx > -1) {
  const to = argv[sendIdx + 1] || user;
  console.log(`  Sending a test message to ${to} ...`);
  const info = await transport.sendMail({
    from: `"League Hub" <${user}>`,
    to,
    subject: 'League Hub SMTP test',
    text: 'If you are reading this, outbound email works.',
    html: `<div style="font-family:Segoe UI,Arial,sans-serif;background:#12171f;color:#e6edf3;
                 padding:28px;border-radius:14px;max-width:460px">
             <div style="color:#FFD700;font-weight:800;font-size:18px;margin-bottom:14px">League Hub</div>
             <p style="margin:0;color:#8b949e">If you are reading this, outbound email works.</p>
           </div>`
  });
  console.log(`  Sent. Message id: ${info.messageId}\n`);
} else {
  console.log('  Add --send your@email.com to send a real test message.\n');
}
