#!/usr/bin/env node
/* Wire api.js + native.js into every page, and replace the Netlify function
   calls (and their leaked shared secret) with authenticated apiPost calls. */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'www';
const report = [];

for (const file of readdirSync(DIR).filter(f => f.endsWith('.html'))) {
  const path = join(DIR, file);
  const before = readFileSync(path, 'utf8');
  let s = before;
  const hits = [];

  // 1. load api.js and native.js right after the data layer
  if (!/js\/api\.js/.test(s)) {
    s = s.replace(/([ \t]*)<script src="js\/db\.js"><\/script>\n/, (m, indent) => {
      hits.push('scripts');
      return `${m}${indent}<script src="js/api.js"></script>\n` +
             `${indent}<script src="js/native.js"></script>\n`;
    });
  }

  // 2. drop the hardcoded push secret - the backend authenticates the admin now
  s = s.replace(/^[ \t]*const NOTIFY_SECRET\s*=\s*['"][^'"]*['"];[ \t]*\r?\n/gm, () => {
    hits.push('NOTIFY_SECRET removed'); return '';
  });

  // 3. path-relative Netlify call -> absolute, authenticated apiPost
  s = s.replace(
    /fetch\(\s*['"]\/\.netlify\/functions\/([\w-]+)['"]\s*,\s*\{[^}]*?body:\s*JSON\.stringify\(\s*(\{[^}]*\})\s*\)\s*\}\s*\)/gs,
    (m, fn, payload) => {
      hits.push(`apiPost(${fn})`);
      const cleaned = payload.replace(/,?\s*secret:\s*NOTIFY_SECRET\s*/g, '').replace(/,\s*\}/, ' }');
      return `apiPost('${fn}', ${cleaned})`;
    }
  );

  if (s !== before) writeFileSync(path, s);
  report.push([file, hits.length ? [...new Set(hits)].join(', ') : 'no change']);
}

const w = Math.max(...report.map(r => r[0].length));
for (const [f, h] of report) console.log('  ' + f.padEnd(w + 2) + h);
