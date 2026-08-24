/* ============================================================================
   GET /api/remind-players   (Vercel Cron)
   Nudges teams that still owe a match in the round currently published.

   Runs across every active league, so it must stay cheap: it reads only the
   published document per competition, and skips anything with no outstanding
   matches or no registered devices.

   Vercel signs cron requests with CRON_SECRET; anything else is refused, or
   this becomes a way for a stranger to notify every player on the platform.
   ========================================================================= */

import { listTenants, listCompetitions, devicesForTenant, pruneTokens, readDoc }
  from './_lib/supabase.mjs';
import { sendToTokens } from './_lib/fcm.mjs';

/** Teams that still owe a match in whatever round is on display. */
function teamsWithOutstandingMatches(pub) {
  const teams = new Set();
  if (!pub) return teams;

  if (pub.format === 'round_robin') {
    const days = pub.allMatchdays || [];
    const current = days[pub.currentMatchday || 0];
    for (const m of (current && current.matches) || []) {
      if (m.played) continue;
      if (m.home) teams.add(m.home);
      if (m.away) teams.add(m.away);
    }
    return teams;
  }

  // Cup: group matches while the groups are running, ties once they are not.
  if (pub.phase === 'group') {
    for (const list of Object.values(pub.fixtures || {})) {
      for (const f of list) {
        if (f.played) continue;
        if (f.home) teams.add(f.home);
        if (f.away) teams.add(f.away);
      }
    }
    return teams;
  }

  for (const round of pub.ko || []) {
    for (const m of round.matches || []) {
      // Both sides known and no winner yet - that tie is still to be played.
      if (!m.home || !m.away || m.winner) continue;
      teams.add(m.home);
      teams.add(m.away);
    }
  }
  return teams;
}

export default async function handler(req, res) {
  const expected = process.env.CRON_SECRET;
  const presented = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!expected || presented !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const summary = [];

  try {
    const tenants = await listTenants();

    for (const tenant of tenants) {
      const comps = await listCompetitions(tenant.id);

      for (const comp of comps) {
        if (comp.status === 'finished') continue;

        try {
          const pub = await readDoc(tenant.id, `comp/${comp.key}/pub`);
          if (!pub) continue;

          const outstanding = teamsWithOutstandingMatches(pub);
          if (!outstanding.size) continue;

          // push_tokens records the team a device follows, so only the players
          // who actually owe a match are disturbed.
          const devices = await devicesForTenant(tenant.id, comp.key);
          const tokens = devices
            .filter(d => d.team && outstanding.has(d.team))
            .map(d => d.token);
          if (!tokens.length) continue;

          const result = await sendToTokens(tokens, {
            title: tenant.name,
            body: `⚽ You still have a ${comp.name} match to play. Arrange it before the deadline.`,
            url: 'app.html'
          });

          if (result.invalid.length) await pruneTokens(result.invalid);
          summary.push({
            league: tenant.name, competition: comp.name,
            teams: outstanding.size, sent: result.sent
          });
        } catch (e) {
          // One broken competition must not stop the rest of the platform.
          summary.push({ league: tenant.name, competition: comp.name, error: e.message });
        }
      }
    }

    return res.status(200).json({ ranAt: new Date().toISOString(), summary });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
