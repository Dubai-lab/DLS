/* ============================================================================
   Backend endpoint resolution.

   The old code called '/.netlify/functions/notify-fixture'. That path is
   resolved against the current origin, which inside the app is
   capacitor://localhost (iOS) or https://localhost (Android) - the device
   itself. Those calls would 404 in the native build, so every backend call
   goes through an absolute URL.

   Update API_ORIGIN once the Vercel project is deployed.
   ========================================================================= */

(function () {
'use strict';

const API_ORIGIN = 'https://footballleaguehub.vercel.app';

const isNative = !!(window.Capacitor &&
                    window.Capacitor.isNativePlatform &&
                    window.Capacitor.isNativePlatform());

/**
 * apiUrl('notify-fixture') ->
 *   web:    /api/notify-fixture          (same origin, so previews work)
 *   native: https://<host>/api/notify-fixture
 */
function apiUrl(name) {
  const path = `/api/${String(name).replace(/^\/+|^api\//g, '')}`;
  return isNative ? API_ORIGIN + path : path;
}

/**
 * POST to a backend function, authenticated as the signed-in admin.
 *
 * This replaces the old shared NOTIFY_SECRET, which was hardcoded into five
 * admin pages and therefore readable by anyone who viewed source. The function
 * verifies the Supabase token server-side and checks admin_profiles instead.
 */
async function apiPost(name, body) {
  const headers = { 'Content-Type': 'application/json' };

  const token = window.DB && window.DB.auth
    ? await window.DB.auth.accessToken()
    : null;
  if (token) headers.Authorization = `Bearer ${token}`;

  return fetch(apiUrl(name), {
    method: 'POST',
    headers,
    body: JSON.stringify(body || {})
  });
}

window.apiUrl = apiUrl;
window.apiPost = apiPost;

})();
