/* ============================================================================
   GET /api/remind-players
   Nudges teams that still have an unplayed match in the current round.

   Was a Netlify scheduled function. Vercel Cron calls this endpoint instead -
   see the "crons" block in vercel.json. Vercel signs cron requests with
   CRON_SECRET, so the handler rejects anything else.
   ========================================================================= */

import { devicesForComp, pruneTokens, readDoc } from './_lib/supabase.js';
import { sendToTokens } from './_lib/fcm.js';

const COMP_CONFIG = {
  league1: { name: 'Division 1',       pub: 'dls_pub_league',  type: 'league' },
  league2: { name: 'Division 2',       pub: 'dls_pub_league2', type: 'league' },
  league3: { name: 'Division 3',       pub: 'dls_pub_league3', type: 'league' },
  cl:      { name: 'Champions League', pub: 'dls_pub_cl',      type: 'cup'    },
  europa:  { name: 'Europa League',    pub: 'dls_pub_europa',  type: 'cup'    }
};

/** Teams that still owe a match in the round currently on display. */
function teamsWithOutstandingMatches(pub, type) {
  const teams = new Set();
  if (!pub) return teams;

  if (type === 'league') {
    const md = pub.matchday;
    if (md && Array.isArray(md.matches)) {
      md.matches.filter(m => !m.played).forEach(m => {
        if (m.home) teams.add(m.home);
        if (m.away) teams.add(m.away);
      });
    }
    return teams;
  }

  if (pub.phase === 'group' && pub.fixtures) {
    for (const group of ['A', 'B', 'C', 'D']) {
      (pub.fixtures[group] || []).filter(f => !f.played).forEach(f => {
        if (f.home) teams.add(f.home);
        if (f.away) teams.add(f.away);
      });
    }
  }

  if (pub.phase === 'knockout' && pub.ko) {
    const ties = [...(pub.ko.qf || []), ...(pub.ko.sf || [])];
    if (pub.ko.final) ties.push(pub.ko.final);
    ties.filter(m => m && m.home && !m.winner).forEach(m => {
      teams.add(m.home);
      if (m.away) teams.add(m.away);
    });
  }

  return teams;
}

export default async function handler(req, res) {
  // Vercel Cron presents the secret; block anything else so this cannot be
  // used to spam every subscriber.
  const expected = process.env.CRON_SECRET;
  const presented = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!expected || presented !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const summary = [];

  for (const [comp, cfg] of Object.entries(COMP_CONFIG)) {
    try {
      const pub = await readDoc(cfg.pub);
      if (!pub) continue;

      const outstanding = teamsWithOutstandingMatches(pub, cfg.type);
      if (!outstanding.size) continue;

      // push_tokens carries the team a device follows, so only the teams that
      // actually owe a match get pinged - same targeting the Netlify version had.
      const devices = await devicesForComp(comp);
      const tokens = devices
        .filter(d => d.team && outstanding.has(d.team))
        .map(d => d.token);
      if (!tokens.length) continue;

      const result = await sendToTokens(tokens, {
        title: 'Africa DLS Global League \u{1F30D}',
        body: `⚽ You still have an outstanding ${cfg.name} match today. Don’t miss the deadline!`,
        url: 'index.html'
      });

      if (result.invalid.length) await pruneTokens(result.invalid);
      summary.push({ comp, teams: outstanding.size, sent: result.sent });
    } catch (err) {
      summary.push({ comp, error: err.message });
    }
  }

  return res.status(200).json({ ranAt: new Date().toISOString(), summary });
}
