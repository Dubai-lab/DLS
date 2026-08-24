#!/usr/bin/env node
/* ============================================================================
   Local dev server.

     npm run serve            -> http://localhost:5173
     npm run serve -- 8080    -> a different port

   Serves www/ AND runs the /api/* functions in-process, so the whole app works
   locally with nothing deployed. Vercel functions are just modules exporting
   default (req, res), so the only work is parsing the body and bolting on the
   res.status().json() helpers Vercel provides.

   Handlers are re-imported on every request, so editing api/<route>.js takes
   effect immediately. Shared modules under api/_lib/ are a different matter:
   Node's ESM cache is keyed on the specifier and never released, so a handler
   re-import still sees the old copy. `npm run serve` therefore runs under
   --watch-path=./api, which restarts the process when anything there changes.

   Environment comes from .env. The service_role key and SMTP password are read
   here, in a process that only ever listens on localhost - they never reach the
   browser.
   ========================================================================= */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'www';
const PORT = Number(process.argv[2]) || 5173;

/* ---------- environment ----------------------------------------------------
   .env uses the names Supabase's dashboard shows. The functions expect the
   names they will see on Vercel, so both are set. */

function loadEnv() {
  if (!existsSync('.env')) {
    console.warn('\n  No .env found - /api routes needing credentials will fail.\n');
    return;
  }
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  const alias = {
    SUPABASE_URL: ['Supabase_URL', 'SUPABASE_URL'],
    SUPABASE_SERVICE_KEY: ['Services_Key', 'SUPABASE_SERVICE_KEY'],
    SUPABASE_ANON_KEY: ['Anon_Key', 'SUPABASE_ANON_KEY']
  };
  for (const [target, sources] of Object.entries(alias)) {
    if (process.env[target]) continue;
    const hit = sources.map(s => process.env[s]).find(Boolean);
    if (hit) process.env[target] = hit;
  }
  process.env.APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
}
loadEnv();

/* ---------- static ---------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico':  'image/x-icon'
};

/* ---------- api ---------- */

function readBody(req) {
  return new Promise((done, fail) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      // A dev server should not be a memory hazard if something misbehaves.
      if (raw.length > 2_000_000) { fail(new Error('Request body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!raw) return done({});
      try { done(JSON.parse(raw)); }
      catch { done(raw); }          // hand non-JSON through untouched
    });
    req.on('error', fail);
  });
}

/** Give Node's ServerResponse the shape Vercel handlers expect. */
function vercelResponse(res) {
  res.status = code => { res.statusCode = code; return res; };
  res.json = payload => {
    if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
    return res;
  };
  res.send = payload => {
    res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    return res;
  };
  return res;
}

async function runApi(req, res, name, url) {
  const file = resolve(`api/${name}.mjs`);
  if (!/^[\w-]+$/.test(name) || !existsSync(file)) {
    return vercelResponse(res).status(404).json({ error: `No API route named "${name}"` });
  }

  try {
    req.body = await readBody(req);
    req.query = Object.fromEntries(url.searchParams);

    // Cache-busted so edits under api/ apply without a restart.
    const mod = await import(`${pathToFileURL(file).href}?v=${Date.now()}`);
    const handler = mod.default;
    if (typeof handler !== 'function') {
      return vercelResponse(res).status(500).json({ error: `api/${name}.mjs has no default export` });
    }

    await handler(req, vercelResponse(res));
    if (!res.writableEnded) res.end();
  } catch (err) {
    console.error(`  /api/${name} failed:`, err);
    if (!res.headersSent) {
      vercelResponse(res).status(500).json({ error: err.message });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}

/* ---------- server ---------- */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { pathname = '/'; }

  if (pathname.startsWith('/api/')) {
    console.log(`  ${req.method} ${pathname}`);
    return runApi(req, res, pathname.slice(5).replace(/\/+$/, ''), url);
  }

  if (pathname === '/') pathname = '/index.html';

  // normalize resolves any ../ before the join, keeping requests inside www/.
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, safe);

  try {
    const info = await stat(file);
    if (info.isDirectory()) throw new Error('directory');
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'      // never cache in dev, or edits look ignored
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`404  ${pathname}`);
  }
});

server.listen(PORT, () => {
  const at = p => `  http://localhost:${PORT}${p}`;
  console.log(`\n  Football League Hub - serving ${ROOT}/ on port ${PORT}`);

  const ready = process.env.SUPABASE_SERVICE_KEY ? 'yes' : 'NO - check .env';
  const mail = process.env.SMTP_PASSWORD ? 'yes' : 'NO - check .env';
  console.log(`  API routes live: ${ready}   ·   email configured: ${mail}\n`);

  console.log('  Landing page');
  console.log(at('/'));
  console.log('\n  Sign up / sign in');
  console.log(at('/register.html'));
  console.log(at('/login.html'));
  console.log('\n  League console');
  console.log(at('/console.html'));
  console.log('\n  Stuck signed in?');
  console.log(at('/logout.html'));
  console.log('\n  Ctrl+C to stop.\n');
});
