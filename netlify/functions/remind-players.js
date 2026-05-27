const webpush = require('web-push');
const { schedule } = require('@netlify/functions');

const FIREBASE_URL = 'https://dls-hub-62226-default-rtdb.firebaseio.com';

const COMP_CONFIG = {
  league1: { name: 'Division 1',       pub: 'dls_pub_league',  type: 'league' },
  league2: { name: 'Division 2',       pub: 'dls_pub_league2', type: 'league' },
  league3: { name: 'Division 3',       pub: 'dls_pub_league3', type: 'league' },
  cl:      { name: 'Champions League', pub: 'dls_pub_cl',      type: 'cup'    },
  europa:  { name: 'Europa League',    pub: 'dls_pub_europa',  type: 'cup'    },
};

webpush.setVapidDetails(
  'mailto:admin@africadlsglobal.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

async function getJSON(path) {
  const r = await fetch(`${FIREBASE_URL}/${path}.json`).catch(() => null);
  return r && r.ok ? r.json().catch(() => null) : null;
}

function isReasonableHour(timezone) {
  try {
    const hour = parseInt(
      new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: 'numeric', hour12: false }).format(new Date()),
      10
    );
    return hour >= 7 && hour <= 22;
  } catch { return true; }
}

async function sendReminder(entry, key, comp, compName) {
  if (!isReasonableHour(entry.timezone || 'UTC')) return;
  const payload = JSON.stringify({
    title: 'Africa DLS Global League 🌍',
    body: `⚽ You still have an outstanding ${compName} match today. Don’t miss the deadline!`,
    icon: '/dls_logo.jpeg',
    url: '/viewer.html'
  });
  await webpush.sendNotification(entry.subscription, payload).catch(async err => {
    if (err.statusCode === 410 || err.statusCode === 404) {
      await fetch(
        `${FIREBASE_URL}/dls_push_subs/${comp}/${encodeURIComponent(key)}.json`,
        { method: 'DELETE' }
      ).catch(() => {});
    }
  });
}

module.exports.handler = schedule('0 7,12,17 * * *', async () => {
  for (const [comp, cfg] of Object.entries(COMP_CONFIG)) {
    const [pub, subs] = await Promise.all([
      getJSON(cfg.pub),
      getJSON(`dls_push_subs/${comp}`)
    ]);
    if (!pub || !subs || typeof subs !== 'object') continue;

    const teamsWithMatches = new Set();

    if (cfg.type === 'league') {
      const md = pub.matchday;
      if (md && Array.isArray(md.matches)) {
        md.matches.filter(m => !m.played).forEach(m => {
          if (m.home) teamsWithMatches.add(m.home);
          if (m.away) teamsWithMatches.add(m.away);
        });
      }
    } else {
      if (pub.phase === 'group' && pub.fixtures) {
        for (const grp of ['A', 'B', 'C', 'D']) {
          (pub.fixtures[grp] || []).filter(f => !f.played).forEach(f => {
            if (f.home) teamsWithMatches.add(f.home);
            if (f.away) teamsWithMatches.add(f.away);
          });
        }
      }
      if (pub.phase === 'knockout' && pub.ko) {
        const allKO = [...(pub.ko.qf || []), ...(pub.ko.sf || [])];
        if (pub.ko.final) allKO.push(pub.ko.final);
        allKO.filter(m => m && m.home && !m.winner).forEach(m => {
          teamsWithMatches.add(m.home);
          teamsWithMatches.add(m.away);
        });
      }
    }

    for (const [key, entry] of Object.entries(subs)) {
      if (entry.team && teamsWithMatches.has(entry.team)) {
        await sendReminder(entry, key, comp, cfg.name);
      }
    }
  }

  return { statusCode: 200 };
});
