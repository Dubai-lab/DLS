/* ============================================================================
   POST /api/notify-fixture
   Announces a new matchday to everyone subscribed to that competition.

   Was netlify/functions/notify-fixture.js. Two things changed:
     - web-push VAPID  ->  FCM, because service-worker push cannot reach a
       native WebView
     - shared NOTIFY_SECRET  ->  Supabase bearer token, because the secret was
       hardcoded in five client pages and therefore public
   ========================================================================= */

import { requireAdmin, tokensForComp, pruneTokens } from './_lib/supabase.js';
import { sendToTokens } from './_lib/fcm.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const admin = await requireAdmin(req);
  if (!admin) return res.status(401).json({ error: 'Sign in as an admin' });

  const { comp, compName, matchday } = req.body || {};
  if (!comp || !compName) {
    return res.status(400).json({ error: 'comp and compName are required' });
  }
  if (!admin.canManage(comp)) {
    return res.status(403).json({ error: `You do not manage ${comp}` });
  }

  const isLeague = comp.startsWith('league');
  const body = isLeague
    ? `\u{1F4C5} Division ${comp.replace('league', '')} — Matchday ${matchday} fixtures are now available!`
    : comp === 'cl'
      ? '\u{1F3C6} Champions League — New fixtures are now available!'
      : '⭐ Europa League — New fixtures are now available!';

  try {
    const tokens = await tokensForComp(comp);
    const result = await sendToTokens(tokens, {
      title: 'Africa DLS Global League \u{1F30D}',
      body,
      url: 'index.html'
    });

    if (result.invalid.length) await pruneTokens(result.invalid);

    return res.status(200).json({
      comp,
      recipients: tokens.length,
      sent: result.sent,
      failed: result.failed,
      pruned: result.invalid.length
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
