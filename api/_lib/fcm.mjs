/* ============================================================================
   Firebase Cloud Messaging (HTTP v1).

   The legacy FCM server-key endpoint is retired, so v1 requires an OAuth2
   access token minted from a service account. That is a signed JWT exchange,
   which node:crypto can do directly - no need to pull in firebase-admin just
   to send a handful of notifications.

   Env:
     FIREBASE_SERVICE_ACCOUNT  the service account JSON, as one line
   ========================================================================= */

import { createSign } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

let cachedToken = null; // { token, expiresAt }

function serviceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
  return JSON.parse(raw);
}

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function accessToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }

  const sa = serviceAccount();
  const now = Math.floor(Date.now() / 1000);

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  }));

  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(sa.private_key, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`
    })
  });

  if (!res.ok) throw new Error(`FCM token exchange failed: ${await res.text()}`);
  const body = await res.json();

  cachedToken = {
    token: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000
  };
  return cachedToken.token;
}

/**
 * Send one notification to many device tokens.
 * v1 has no multicast endpoint, so this fans out with bounded concurrency and
 * reports which tokens the server rejected so the caller can prune them.
 */
export async function sendToTokens(tokens, { title, body, url }) {
  if (!tokens.length) return { sent: 0, failed: 0, invalid: [] };

  const sa = serviceAccount();
  const token = await accessToken();
  const endpoint =
    `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`;

  const invalid = [];
  let sent = 0;
  let failed = 0;

  const CONCURRENCY = 10;
  for (let i = 0; i < tokens.length; i += CONCURRENCY) {
    const batch = tokens.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async deviceToken => {
      const message = {
        message: {
          token: deviceToken,
          notification: { title, body },
          data: url ? { url: String(url) } : {},
          android: {
            priority: 'high',
            notification: { channel_id: 'dls_default', icon: 'ic_stat_notify' }
          },
          apns: {
            payload: { aps: { sound: 'default', badge: 1 } }
          }
        }
      };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(message)
      }).catch(() => null);

      if (res && res.ok) { sent++; return; }

      failed++;
      // 404 UNREGISTERED / 400 INVALID_ARGUMENT mean the token is dead.
      if (res && (res.status === 404 || res.status === 400)) invalid.push(deviceToken);
    }));
  }

  return { sent, failed, invalid };
}
