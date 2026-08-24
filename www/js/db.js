/* ============================================================================
   Football League Hub - Supabase data layer (multi-tenant)

   Every data call is scoped to a tenant. The tenant id is passed explicitly to
   the server on each request rather than inferred from a cookie or a global,
   because a person can belong to several leagues at once - as an owner of one
   and a player in another.

   The server re-checks membership on every call (see db_can_read / db_can_write
   in supabase/schema.sql), so nothing here is a security boundary. Setting the
   wrong tenant gets you a 403, not someone else's data.

   Only the anon key lives in this file. It is meant to be public; RLS is the
   protection. The service_role key must never appear anywhere under www/.
   ========================================================================= */

(function () {
'use strict';

const SUPABASE_URL = 'https://kyovkzsfjfhzbnlfoigx.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt5b3ZrenNmamZoemJubGZvaWd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc1NDA3MzcsImV4cCI6MjEwMzExNjczN30.5GlkI7SGrgEjsQjHaqvXYsTl7lcUvvi5IKWQpTXikSk';

const SESSION_KEY = 'lh_session';
const TENANT_KEY  = 'lh_tenant';

/* -------------------------------------------------------------------------
   Session
   ---------------------------------------------------------------------- */

function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
  catch (e) { return null; }
}

function storeSession(s) {
  if (!s) { localStorage.removeItem(SESSION_KEY); return null; }
  s.expires_at = s.expires_at || (Date.now() / 1000 + (s.expires_in || 3600));
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  return s;
}

let refreshing = null;

async function refresh(session) {
  // Collapse concurrent refreshes so a burst of calls issues one token request.
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
        body: JSON.stringify({ refresh_token: session.refresh_token })
      });
      if (!r.ok) { storeSession(null); return null; }
      return storeSession(await r.json());
    } catch (e) {
      return session;            // offline: keep what we have and retry later
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function token() {
  let s = loadSession();
  if (!s || !s.access_token) return null;
  if (s.expires_at && Date.now() / 1000 > s.expires_at - 60) s = await refresh(s);
  return s && s.access_token ? s.access_token : null;
}

function userId() {
  const s = loadSession();
  if (!s || !s.access_token) return null;
  try {
    const payload = s.access_token.split('.')[1];
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))).sub || null;
  } catch (e) { return null; }
}

/* -------------------------------------------------------------------------
   Transport
   ---------------------------------------------------------------------- */

async function authHeaders() {
  const t = await token();
  return {
    'Content-Type': 'application/json',
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${t || SUPABASE_ANON_KEY}`
  };
}

function describe(status, detail) {
  const err = new Error(detail || `request failed (${status})`);
  err.status = status;
  err.isPermission = status === 403 || status === 401 ||
                     /permission denied/i.test(detail || '');
  err.isWipeGuard = /refusing to overwrite/i.test(detail || '');
  return err;
}

async function rpc(fn, args) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(args || {})
  });

  if (!r.ok) {
    let detail = '';
    try { const e = await r.json(); detail = e.message || e.hint || JSON.stringify(e); }
    catch (_) { detail = await r.text().catch(() => ''); }
    throw describe(r.status, `${fn}: ${detail}`);
  }

  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

async function rest(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { ...(await authHeaders()), Accept: 'application/json', ...(opts.headers || {}) }
  });
  if (!r.ok) throw describe(r.status, await r.text().catch(() => ''));
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

/* -------------------------------------------------------------------------
   Current tenant

   Cached in localStorage so a refresh does not drop the user back to a league
   picker. Purely a convenience - the server verifies membership regardless.
   ---------------------------------------------------------------------- */

function getTenant() {
  try { return JSON.parse(localStorage.getItem(TENANT_KEY) || 'null'); }
  catch (e) { return null; }
}

function setTenant(t) {
  if (t) localStorage.setItem(TENANT_KEY, JSON.stringify(t));
  else localStorage.removeItem(TENANT_KEY);
  return t;
}

function tenantId() {
  const t = getTenant();
  if (!t || !t.tenant_id) {
    throw new Error('No league selected. Join or choose a league first.');
  }
  return t.tenant_id;
}

/* -------------------------------------------------------------------------
   Firebase-compatible push keys, kept because existing documents use them and
   they sort chronologically.
   ---------------------------------------------------------------------- */

const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
let lastPushTime = 0;
const lastRand = [];

function pushKey(now) {
  now = now || Date.now();
  const duplicate = now === lastPushTime;
  lastPushTime = now;

  const chars = new Array(8);
  for (let i = 7; i >= 0; i--) { chars[i] = PUSH_CHARS.charAt(now % 64); now = Math.floor(now / 64); }
  let id = chars.join('');

  if (!duplicate) {
    for (let i = 0; i < 12; i++) lastRand[i] = Math.floor(Math.random() * 64);
  } else {
    let i = 11;
    for (; i >= 0 && lastRand[i] === 63; i--) lastRand[i] = 0;
    lastRand[i]++;
  }
  for (let i = 0; i < 12; i++) id += PUSH_CHARS.charAt(lastRand[i]);
  return id;
}

/* -------------------------------------------------------------------------
   Public API
   ---------------------------------------------------------------------- */

const DB = {
  tenant: {
    get: getTenant,
    set: setTenant,
    id: () => { try { return tenantId(); } catch (e) { return null; } },
    clear: () => setTenant(null)
  },

  // ---- documents, scoped to the current tenant ----
  async get(path)            { return rpc('db_get',      { p_tenant: tenantId(), p_path: path }); },
  async getMany(paths)       { return rpc('db_get_many', { p_tenant: tenantId(), p_paths: paths }); },
  async update(path, patch)  { return rpc('db_update',   { p_tenant: tenantId(), p_path: path, p_data: patch }); },
  async remove(path)         { await rpc('db_delete',    { p_tenant: tenantId(), p_path: path }); },

  async set(path, value) {
    if (value === null || value === undefined) return DB.remove(path);
    return rpc('db_set', { p_tenant: tenantId(), p_path: path, p_data: value });
  },

  /** Append under a generated key, the way RTDB push did. */
  async push(path, value) {
    const key = pushKey();
    await rpc('db_set', { p_tenant: tenantId(), p_path: `${path}/${key}`, p_data: value });
    return { name: key };
  },

  // ---- identity ----
  auth: {
    /** Step 1 of registration. Supabase emails a verification code. */
    async signUp(email, password) {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
        body: JSON.stringify({ email, password })
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.msg || body.error_description || 'Sign-up failed');
      // A confirmed session comes back only when email confirmation is disabled.
      if (body.access_token) storeSession(body);
      return body;
    },

    /** Step 2. Exchanges the emailed code for a session. */
    async verifyEmail(email, code) {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
        body: JSON.stringify({ email, token: code, type: 'signup' })
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.msg || body.error_description || 'That code is not valid');
      storeSession(body);
      return body;
    },

    async resendCode(email) {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/resend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
        body: JSON.stringify({ email, type: 'signup' })
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        throw new Error(b.msg || 'Could not resend the code');
      }
      return true;
    },

    /**
     * Step 1 of a forgotten password: Supabase emails a recovery code.
     *
     * Always resolves, even for an address with no account. Reporting "no such
     * user" would turn this into a way to discover who has registered.
     */
    async requestReset(email) {
      await fetch(`${SUPABASE_URL}/auth/v1/recover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
        body: JSON.stringify({ email })
      }).catch(() => {});
      return true;
    },

    /** Step 2: exchange the emailed code for a short-lived session. */
    async verifyReset(email, code) {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
        body: JSON.stringify({ email, token: code, type: 'recovery' })
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.msg || body.error_description || 'That code is not valid');
      storeSession(body);
      return body;
    },

    async signIn(email, password) {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
        body: JSON.stringify({ email, password })
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error_description || body.msg || 'Wrong email or password');
      storeSession(body);
      return body;
    },

    async signOut() {
      const t = await token();
      if (t) {
        await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
          method: 'POST',
          headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${t}` }
        }).catch(() => {});
      }
      storeSession(null);
      setTenant(null);
    },

    /**
     * Change the signed-in user's own password.
     * Players are handed an access code by their admin; this lets them replace
     * it with something only they know.
     */
    async changePassword(next) {
      const t = await token();
      if (!t) throw new Error('Sign in first');
      const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${t}`
        },
        body: JSON.stringify({ password: next })
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.msg || body.error_description || 'Could not change the code');
      return true;
    },

    /** True if a token exists locally. Cheap, but does not prove it still works. */
    async isSignedIn() { return (await token()) !== null; },

    /**
     * Ask the server who this token belongs to, and drop the session if it
     * refuses.
     *
     * isSignedIn() only inspects localStorage, so a token whose account was
     * deleted server-side still reads as signed in until it expires - which
     * strands the person on a page they cannot get past. Boot screens use this
     * instead, at the cost of one request.
     */
    async currentUser() {
      const t = await token();
      if (!t) return null;
      try {
        const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
          headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${t}` }
        });
        if (r.status === 401 || r.status === 403) {
          // The account is gone or the token was revoked. Clear it out so the
          // next page load starts clean rather than looping.
          storeSession(null);
          setTenant(null);
          return null;
        }
        if (!r.ok) return null;
        const user = await r.json();
        return user && user.id ? user : null;
      } catch (e) {
        // Offline: keep the session and let the caller carry on optimistically.
        return { offline: true };
      }
    },

    /** Wipe every trace of the session on this device. */
    reset() {
      storeSession(null);
      setTenant(null);
    },
    async accessToken() { return token(); },
    userId
  },

  /** Who am I, and which leagues can I see. Called on boot by every page. */
  async context() { return rpc('my_context'); },

  // ---- registration and members ----
  async createLeague(name, slug, gameType) {
    return rpc('create_tenant', { p_name: name, p_slug: slug || '', p_game_type: gameType });
  },

  /**
   * Register a member. Goes through /api/add-member because creating an
   * account needs the service key, which must never reach the browser.
   */
  async addMember({ email, team, displayName, phone, role = 'player',
                    accessCode, competitionIds = [] }) {
    const r = await fetch(apiUrl('add-member'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await token()}`
      },
      body: JSON.stringify({
        tenantId: tenantId(), email, team, displayName, phone,
        role, accessCode, competitionIds
      })
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || 'Could not register that member');
    return body;
  },

  /** Mark this membership active on first sign-in. */
  async touch() {
    return rpc('touch_membership', { p_tenant: tenantId() });
  },

  // ---- competitions ----
  async competitions() {
    return rest(`competitions?tenant_id=eq.${tenantId()}&select=*&order=sort_order,created_at`);
  },

  async createCompetition({ key, name, format, accent = '#00c853' }) {
    const rows = await rest('competitions', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ tenant_id: tenantId(), key, name, format, accent })
    });
    return rows && rows.length ? rows[0] : null;
  },

  async members() {
    return rest(`memberships?tenant_id=eq.${tenantId()}&select=*&order=created_at`);
  },

  /** Update a member's team, name, crest colour or logo. Owner only (RLS). */
  async updateMember(id, patch) {
    const rows = await rest(`memberships?id=eq.${id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(patch)
    });
    return rows && rows.length ? rows[0] : null;
  },

  /** Reissue a member's access code and email it to them. Admins only. */
  async resetMemberCode(membershipId, accessCode) {
    const r = await fetch(apiUrl('reset-code'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await token()}`
      },
      body: JSON.stringify({ tenantId: tenantId(), membershipId, accessCode: accessCode || null })
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || 'Could not reset that code');
    return body;
  },

  async removeMember(id) {
    await rest(`memberships?id=eq.${id}`, { method: 'DELETE' });
  },

  /**
   * Upload a team crest and return its public URL.
   *
   * Stored under <tenant_id>/<membership_id>.<ext>, which is what the storage
   * policy checks - the first folder segment must be a league the uploader
   * belongs to, so one league cannot overwrite another's crests.
   */
  async uploadTeamLogo(membershipId, file) {
    const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
    const path = `${tenantId()}/${membershipId}.${ext}`;
    const t = await token();

    const r = await fetch(
      `${SUPABASE_URL}/storage/v1/object/team-logos/${path}`,
      {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${t}`,
          'Content-Type': file.type || 'image/png',
          // Replace rather than fail when a team changes its crest.
          'x-upsert': 'true'
        },
        body: file
      }
    );
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      throw new Error(`Upload failed (${r.status}): ${detail.slice(0, 160)}`);
    }

    // Cache-busted, or browsers keep showing the previous crest at the same URL.
    return `${SUPABASE_URL}/storage/v1/object/public/team-logos/${path}?v=${Date.now()}`;
  },

  /**
   * Suspend or reinstate a league. Platform owners only in practice - the
   * tenants policy checks is_tenant_owner(), which is_platform_admin() satisfies.
   */
  async setTenantStatus(id, status) {
    const rows = await rest(`tenants?id=eq.${id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ status })
    });
    if (!rows || !rows.length) {
      throw new Error('Not allowed to change that league');
    }
    return rows[0];
  },

  /* ---- result submissions ----
     A player uploads a screenshot against a specific fixture; an organiser
     checks it and enters the score. The claim is never applied on its own. */

  /**
   * Upload screenshots and file a submission.
   * Images go up first: a submission row pointing at files that failed to
   * upload is worse than an upload with no row, which is just an orphan.
   */
  async submitResult({ competitionId, matchRef, team, claimedHome, claimedAway, note, files }) {
    const t = await token();
    const tenant = tenantId();
    const paths = [];

    for (const file of files || []) {
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
      const path = `${tenant}/${competitionId}/${pushKey()}.${ext}`;
      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/match-results/${path}`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${t}`,
          'Content-Type': file.type || 'image/jpeg'
        },
        body: file
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        throw new Error(`Upload failed (${r.status}): ${detail.slice(0, 140)}`);
      }
      paths.push(path);
    }

    const rows = await rest('result_submissions', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        tenant_id: tenant,
        competition_id: competitionId,
        match_ref: matchRef,
        submitted_by: userId(),
        team: team || null,
        claimed_home: typeof claimedHome === 'number' ? claimedHome : null,
        claimed_away: typeof claimedAway === 'number' ? claimedAway : null,
        note: note || null,
        image_paths: paths
      })
    });
    return rows && rows.length ? rows[0] : null;
  },

  /** Submissions for a competition. Players see their own; reviewers see all. */
  async submissions(competitionId, status) {
    const filter = status ? `&status=eq.${status}` : '';
    return rest(`result_submissions?competition_id=eq.${competitionId}${filter}` +
                `&select=*&order=created_at.desc`);
  },

  async pendingCount() {
    return rpc('pending_result_count', { p_tenant: tenantId() });
  },

  async reviewSubmission(id, patch) {
    const rows = await rest(`result_submissions?id=eq.${id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ ...patch, reviewed_by: userId(), reviewed_at: new Date().toISOString() })
    });
    return rows && rows.length ? rows[0] : null;
  },

  /**
   * A time-limited URL for a screenshot.
   * The bucket is private, and an <img> cannot send an Authorization header,
   * so viewing needs a signed link rather than the plain object path.
   */
  async signedResultUrl(path, seconds) {
    const t = await token();
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/match-results/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${t}`
      },
      body: JSON.stringify({ expiresIn: seconds || 3600 })
    });
    if (!r.ok) throw new Error('Could not open that image');
    const body = await r.json();
    return `${SUPABASE_URL}/storage/v1${body.signedURL || body.signedUrl}`;
  },

  /* ---- public league directory ---- */

  /** Leagues that opted into the landing-page directory. Readable by anyone. */
  async publicLeagues(limit) {
    return rpc('list_public_leagues', { p_limit: limit || 60 });
  },

  /** Count a Join press. Best effort - never block the redirect on it. */
  async recordJoinClick(tenantId) {
    try { await rpc('record_join_click', { p_tenant: tenantId }); }
    catch (e) { /* a missed count is not worth an error */ }
  },

  /** Update this league's public listing. Owner only, enforced by RLS. */
  async updateListing(patch) {
    const rows = await rest(`tenants?id=eq.${tenantId()}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(patch)
    });
    if (!rows || !rows.length) throw new Error('Not allowed to change this league');
    return rows[0];
  },

  /** The current league's own row, including its listing settings. */
  async myLeague() {
    const rows = await rest(`tenants?id=eq.${tenantId()}&select=*`);
    return rows && rows.length ? rows[0] : null;
  },

  /** Update a competition's settings, including its promotion links. */
  async updateCompetition(id, patch) {
    const rows = await rest(`competitions?id=eq.${id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(patch)
    });
    return rows && rows.length ? rows[0] : null;
  },

  /**
   * Move teams between competitions.
   * `from` may be null to add without removing - a side qualifying for the cup
   * keeps playing its league.
   */
  async moveMembers({ from, to, teams }) {
    return rpc('move_members', {
      p_tenant: tenantId(), p_from: from || null, p_to: to, p_teams: teams
    });
  },

  /**
   * The divisions that send teams to this cup, and how many each sends.
   * The rule lives on each division, so a cup can be fed by several at once -
   * 8 from Division 1, 4 from Division 2 - without restating anything here.
   */
  async cupFeeders(cupId) {
    return (await rpc('cup_feeders', { p_tenant: tenantId(), p_cup: cupId })) || [];
  },

  /** The standings a competition's published season ended on. */
  async finalTable(competitionId) {
    return rpc('final_table', { p_tenant: tenantId(), p_competition: competitionId });
  },

  /**
   * Finished seasons for a competition.
   * Selected on its own because each snapshot carries a full set of fixtures -
   * far too heavy to include in the competition list loaded on every boot.
   */
  async archivedSeasons(competitionId) {
    const rows = await rest(`competitions?id=eq.${competitionId}&select=archived_seasons`);
    return rows && rows.length ? (rows[0].archived_seasons || []) : [];
  },

  /** Archive the finished season and move the competition to the next one. */
  async rollSeason(competitionId, snapshot) {
    return rpc('roll_season', { p_competition: competitionId, p_snapshot: snapshot || {} });
  }
};

window.DB = DB;
window.pushKey = pushKey;

})();
