const webpush = require('web-push');

const FIREBASE_URL = 'https://dls-hub-62226-default-rtdb.firebaseio.com';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: 'Bad JSON' }; }

  const { comp, compName, matchday, secret } = body;
  if (secret !== process.env.NOTIFY_SECRET) return { statusCode: 403 };
  if (!comp || !compName) return { statusCode: 400, body: 'Missing params' };

  webpush.setVapidDetails(
    'mailto:admin@africadlsglobal.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  const r = await fetch(`${FIREBASE_URL}/dls_push_subs/${comp}.json`).catch(() => null);
  if (!r || !r.ok) return { statusCode: 200, body: 'no subs' };
  const subs = await r.json();
  if (!subs || typeof subs !== 'object') return { statusCode: 200, body: 'no subs' };

  const isLeague = comp.startsWith('league');
  const notifBody = isLeague
    ? `📅 Division ${comp.replace('league', '')} — Matchday ${matchday} fixtures are now available!`
    : comp === 'cl'
    ? `🏆 Champions League — New fixtures are now available!`
    : `⭐ Europa League — New fixtures are now available!`;

  const payload = JSON.stringify({
    title: 'Africa DLS Global League 🌍',
    body: notifBody,
    icon: '/dls_logo.jpeg',
    url: '/viewer.html'
  });

  const sends = Object.entries(subs).map(([key, entry]) =>
    webpush.sendNotification(entry.subscription, payload).catch(async err => {
      if (err.statusCode === 410 || err.statusCode === 404) {
        await fetch(
          `${FIREBASE_URL}/dls_push_subs/${comp}/${encodeURIComponent(key)}.json`,
          { method: 'DELETE' }
        ).catch(() => {});
      }
    })
  );

  await Promise.allSettled(sends);
  return { statusCode: 200, body: JSON.stringify({ comp, sent: Object.keys(subs).length }) };
};
