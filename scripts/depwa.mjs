#!/usr/bin/env node
/* Strip every PWA hook from the pages and wire in the Supabase data layer.
   One-off codemod; kept in the repo so the edit is reviewable and repeatable. */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'www';
const files = readdirSync(DIR).filter(f => f.endsWith('.html'));
const report = [];

for (const file of files) {
  const path = join(DIR, file);
  const before = readFileSync(path, 'utf8');
  let s = before;
  const hits = [];

  // 1. manifest link - the thing that makes a site installable
  s = s.replace(/^[ \t]*<link[^>]*rel=["']manifest["'][^>]*>\r?\n/gmi, () => {
    hits.push('manifest'); return '';
  });

  // 2. iOS standalone meta tags (apple-mobile-web-app-capable is what puts an
  //    installed icon into full-screen app mode on iPhone)
  s = s.replace(/^[ \t]*<meta[^>]*name=["']apple-mobile-web-app-[^"']*["'][^>]*>\r?\n/gmi, () => {
    hits.push('apple-meta'); return '';
  });

  // 3. service worker registration, inline or in its own script tag
  s = s.replace(
    /^[ \t]*<script>\s*if\s*\(\s*['"]serviceWorker['"]\s+in\s+navigator\s*\)[^<]*<\/script>\r?\n/gmi,
    () => { hits.push('sw-register-tag'); return ''; }
  );
  s = s.replace(
    /^[ \t]*if\s*\(\s*['"]serviceWorker['"]\s+in\s+navigator\s*\)\s*navigator\.serviceWorker\.register\([^)]*\)[^;\n]*;?\r?\n/gmi,
    () => { hits.push('sw-register-line'); return ''; }
  );

  // 4. admin-auth.js moved into js/
  s = s.replace(/src=(["'])admin-auth\.js\1/g, () => {
    hits.push('admin-auth-path'); return 'src="js/admin-auth.js"';
  });

  // 5. load the Supabase data layer before any inline script needs it
  if (!/js\/db\.js/.test(s)) {
    s = s.replace(/([ \t]*)<\/head>/i, (m, indent) => {
      hits.push('db.js');
      return `${indent}<script src="js/db.js"></script>\n${indent}</head>`;
    });
  }

  if (s !== before) writeFileSync(path, s);
  report.push([file, hits.length ? [...new Set(hits)].join(', ') : 'no change']);
}

const w = Math.max(...report.map(r => r[0].length));
for (const [f, h] of report) console.log('  ' + f.padEnd(w + 2) + h);
