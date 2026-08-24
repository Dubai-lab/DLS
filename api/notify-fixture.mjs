/* ============================================================================
   POST /api/notify-fixture
   Tells a competition's players that a new matchday has been published.

   Body: { tenantId, competitionKey, matchday }

   Rewritten for the multi-tenant schema. The original was written when there
   was one league with five hardcoded competitions, and imported helpers
   (requireAdmin, tokensForComp) that no longer exist.
   ========================================================================= */

import { requireMember, getTenant, listCompetitions, devicesForTenant, pruneTokens }
  from './_lib/supabase.mjs';
import { sendToTokens } from './_lib/fcm.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { tenantId, competitionKey, matchday } = req.body || {};
  if (!tenantId || !competitionKey) {
    return res.status(400).json({ error: 'tenantId and competitionKey are required' });
  }

  const caller = await requireMember(req, tenantId);
  if (!caller) return res.status(401).json({ error: 'Sign in as an admin of this league' });
  if (caller.role === 'player') {
    return res.status(403).json({ error: 'Only admins can send notifications' });
  }

  try {
    const [tenant, comps] = await Promise.all([
      getTenant(tenantId),
      listCompetitions(tenantId)
    ]);
    if (!tenant) return res.status(404).json({ error: 'League not found' });

    const comp = comps.find(c => c.key === competitionKey);
    if (!comp) return res.status(404).json({ error: 'No such competition in this league' });
    if (!caller.canManage(comp.id)) {
      return res.status(403).json({ error: `You do not manage ${comp.name}` });
    }

    const devices = await devicesForTenant(tenantId, competitionKey);
    const tokens = devices.map(d => d.token);

    const body = matchday
      ? `\u{1F4C5} ${comp.name} — Matchday ${matchday} fixtures are out.`
      : `\u{1F4C5} ${comp.name} — new fixtures are out.`;

    const result = await sendToTokens(tokens, {
      title: tenant.name,
      body,
      url: 'app.html'
    });

    if (result.invalid.length) await pruneTokens(result.invalid);

    return res.status(200).json({
      competition: comp.name,
      recipients: tokens.length,
      sent: result.sent,
      failed: result.failed,
      pruned: result.invalid.length
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
