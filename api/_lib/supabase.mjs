/* ============================================================================
   Server-side Supabase helpers (multi-tenant).

   Env:
     SUPABASE_URL
     SUPABASE_SERVICE_KEY   service_role - server only, never in the bundle
   ========================================================================= */

const base = () => {
  const u = process.env.SUPABASE_URL;
  if (!u) throw new Error('SUPABASE_URL is not set');
  return u.replace(/\/+$/, '');
};

const serviceKey = () => {
  const k = process.env.SUPABASE_SERVICE_KEY;
  if (!k) throw new Error('SUPABASE_SERVICE_KEY is not set');
  return k;
};

function headers(extra) {
  return {
    'Content-Type': 'application/json',
    apikey: serviceKey(),
    Authorization: `Bearer ${serviceKey()}`,
    ...(extra || {})
  };
}

async function call(path, opts = {}) {
  const r = await fetch(`${base()}${path}`, { ...opts, headers: headers(opts.headers) });
  const text = await r.text();
  const body = text ? JSON.parse(text) : null;
  if (!r.ok) {
    const err = new Error(body?.message || body?.msg || `${path} failed (${r.status})`);
    err.status = r.status;
    err.body = body;
    throw err;
  }
  return body;
}

/**
 * Resolve the caller's bearer token to a membership in the given tenant.
 * Returns null when the token is missing, invalid, or not a member.
 *
 * Asking Supabase who the token belongs to (rather than verifying the JWT
 * locally) costs one request but honours revocation and password changes.
 */
export async function requireMember(req, tenantId) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token || !tenantId) return null;

  const who = await fetch(`${base()}/auth/v1/user`, {
    headers: { apikey: serviceKey(), Authorization: `Bearer ${token}` }
  });
  if (!who.ok) return null;
  const user = await who.json();
  if (!user?.id) return null;

  const rows = await call(
    `/rest/v1/memberships?user_id=eq.${user.id}&tenant_id=eq.${tenantId}&select=*`
  ).catch(() => null);
  if (!rows?.length) return null;

  const m = rows[0];
  return {
    ...m,
    authEmail: user.email,
    isOwner: m.role === 'owner',
    canManage: compId =>
      m.role === 'owner' ||
      (m.role === 'manager' && (m.competition_ids || []).includes(compId))
  };
}

/** Resolve a bearer token to a user, without requiring any tenant. */
export async function requireUser(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;

  const who = await fetch(`${base()}/auth/v1/user`, {
    headers: { apikey: serviceKey(), Authorization: `Bearer ${token}` }
  });
  if (!who.ok) return null;
  const user = await who.json();
  return user?.id ? user : null;
}

/**
 * Resolve a bearer token to a platform owner.
 * Membership of a league is not enough - the account has to be listed in
 * platform_admins, which only the seed script can write.
 */
export async function requirePlatformAdmin(req) {
  const user = await requireUser(req);
  if (!user) return null;
  const rows = await call(
    `/rest/v1/platform_admins?user_id=eq.${user.id}&select=user_id`
  ).catch(() => null);
  return rows?.length ? user : null;
}

export async function listAuthUsers() {
  const res = await call('/auth/v1/admin/users?per_page=1000').catch(() => null);
  return Array.isArray(res) ? res : res?.users || [];
}

export async function getTenant(tenantId) {
  const rows = await call(`/rest/v1/tenants?id=eq.${tenantId}&select=*`);
  return rows?.length ? rows[0] : null;
}

/** Existing auth user for an email, or null. */
export async function findUserByEmail(email) {
  const res = await call(
    `/auth/v1/admin/users?filter=${encodeURIComponent(email)}&per_page=50`
  ).catch(() => null);
  const list = Array.isArray(res) ? res : res?.users || [];
  return list.find(u => (u.email || '').toLowerCase() === email.toLowerCase()) || null;
}

/** Create a confirmed account. The admin-set access code becomes the password. */
export async function createUser(email, password) {
  return call('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, password, email_confirm: true })
  });
}

export async function setUserPassword(userId, password) {
  return call(`/auth/v1/admin/users/${userId}`, {
    method: 'PUT',
    body: JSON.stringify({ password })
  });
}

export async function findMembership(userId, tenantId) {
  const rows = await call(
    `/rest/v1/memberships?user_id=eq.${userId}&tenant_id=eq.${tenantId}&select=*`
  );
  return rows?.length ? rows[0] : null;
}

export async function insertMembership(row) {
  const rows = await call('/rest/v1/memberships', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row)
  });
  return rows?.length ? rows[0] : null;
}

/** Devices to notify for a competition. */
export async function devicesForTenant(tenantId, compKey) {
  const filter = compKey ? `&comps=cs.{${encodeURIComponent(compKey)}}` : '';
  return call(`/rest/v1/push_tokens?tenant_id=eq.${tenantId}${filter}&select=token,team`)
    .catch(() => []);
}

export async function pruneTokens(tokens) {
  if (!tokens.length) return;
  const list = tokens.map(t => `"${t.replace(/"/g, '\\"')}"`).join(',');
  await call(`/rest/v1/push_tokens?token=in.(${encodeURIComponent(list)})`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' }
  }).catch(() => {});
}

/** Every active league. Used by the nightly reminder cron. */
export async function listTenants() {
  return call('/rest/v1/tenants?status=eq.active&select=id,name,slug').catch(() => []);
}

/** Competitions in a league, or across all of them when tenantId is omitted. */
export async function listCompetitions(tenantId) {
  const filter = tenantId ? `tenant_id=eq.${tenantId}&` : '';
  return call(`/rest/v1/competitions?${filter}select=id,tenant_id,key,name,format,status`)
    .catch(() => []);
}

export async function readDoc(tenantId, path) {
  const rows = await call(
    `/rest/v1/documents?tenant_id=eq.${tenantId}&path=eq.${encodeURIComponent(path)}&select=data`
  ).catch(() => null);
  return rows?.length ? rows[0].data : null;
}
