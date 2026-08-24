/* ============================================================================
   GET /api/platform-stats
   Everything the platform owner's dashboard needs in one call.

   Most of it is readable through RLS by a platform admin already. The account
   list is not - auth.users is never exposed to the client - so owner emails and
   signup counts come from here, behind a platform-admin check.
   ========================================================================= */

import { requirePlatformAdmin, listAuthUsers } from './_lib/supabase.js';

const SUPABASE = () => (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = () => process.env.SUPABASE_SERVICE_KEY;

async function table(path) {
  const r = await fetch(`${SUPABASE()}/rest/v1/${path}`, {
    headers: {
      apikey: KEY(),
      Authorization: `Bearer ${KEY()}`,
      Accept: 'application/json'
    }
  });
  if (!r.ok) return [];
  return r.json();
}

export default async function handler(req, res) {
  const admin = await requirePlatformAdmin(req);
  if (!admin) {
    return res.status(403).json({ error: 'Platform owners only' });
  }

  try {
    const [tenants, competitions, memberships, users] = await Promise.all([
      table('tenants?select=*&order=created_at.desc'),
      table('competitions?select=id,tenant_id,name,format,season,status'),
      table('memberships?select=id,tenant_id,role,status,email'),
      listAuthUsers()
    ]);

    const byTenant = id => ({
      competitions: competitions.filter(c => c.tenant_id === id).length,
      members:      memberships.filter(m => m.tenant_id === id).length,
      players:      memberships.filter(m => m.tenant_id === id && m.role === 'player').length,
      // Registered but never signed in - a useful signal that a league was set
      // up and then abandoned.
      pending:      memberships.filter(m => m.tenant_id === id && m.status === 'invited').length
    });

    const emailFor = id => users.find(u => u.id === id)?.email || null;

    const leagues = tenants.map(t => ({
      ...t,
      owner_email: emailFor(t.owner_id),
      ...byTenant(t.id)
    }));

    const now = Date.now();
    const within = (iso, days) =>
      iso && (now - new Date(iso).getTime()) < days * 86400000;

    return res.status(200).json({
      totals: {
        leagues:      tenants.length,
        active:       tenants.filter(t => t.status === 'active').length,
        suspended:    tenants.filter(t => t.status === 'suspended').length,
        competitions: competitions.length,
        members:      memberships.length,
        accounts:     users.length,
        newLeagues7d: tenants.filter(t => within(t.created_at, 7)).length,
        newUsers7d:   users.filter(u => within(u.created_at, 7)).length,
        // Accounts that never signed in after being registered.
        neverSignedIn: users.filter(u => !u.last_sign_in_at).length
      },
      leagues
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
