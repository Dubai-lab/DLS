/* ============================================================================
   Native shell behaviour (Capacitor).

   Loaded on every page. Everything here is a no-op in a normal browser, so the
   same files still work when served from the web host.

   Capacitor injects window.Capacitor and its plugins into the WebView, so there
   is no bundler and no import step - the plugins are read off Capacitor.Plugins.
   ========================================================================= */

(function () {
'use strict';

const Cap = window.Capacitor;
const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
const platform = isNative ? Cap.getPlatform() : 'web';
const P = (Cap && Cap.Plugins) || {};

window.DLSNative = { isNative, platform };

if (!isNative) return;

/* -------------------------------------------------------------------------
   Chrome: status bar and splash
   ---------------------------------------------------------------------- */

async function initChrome() {
  try {
    if (P.StatusBar) {
      await P.StatusBar.setStyle({ style: 'DARK' });
      if (platform === 'android') {
        await P.StatusBar.setBackgroundColor({ color: '#0d1117' });
      }
    }
  } catch (e) { /* status bar is cosmetic; never block boot on it */ }

  try {
    if (P.SplashScreen) await P.SplashScreen.hide();
  } catch (e) { /* ignore */ }
}

/* -------------------------------------------------------------------------
   Hardware back button (Android)

   The app is multi-page, so history.back() is the correct gesture. On the
   launch page there is nothing to go back to, so a second press exits rather
   than trapping the user.
   ---------------------------------------------------------------------- */

let lastBackPress = 0;

function initBackButton() {
  if (!P.App) return;
  P.App.addListener('backButton', ({ canGoBack }) => {
    const onLaunchPage = /\/(index\.html)?$/.test(location.pathname);

    if (canGoBack && !onLaunchPage) { history.back(); return; }

    const now = Date.now();
    if (now - lastBackPress < 2000) {
      P.App.exitApp();
    } else {
      lastBackPress = now;
      toastNative('Press back again to exit');
    }
  });
}

function toastNative(message) {
  let el = document.getElementById('dls-native-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'dls-native-toast';
    el.style.cssText =
      'position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom));' +
      'transform:translateX(-50%);background:#161b22;color:#e6edf3;border:1px solid #30363d;' +
      'border-radius:8px;padding:10px 18px;font-size:.85rem;z-index:99999;opacity:0;' +
      'transition:opacity .2s;pointer-events:none';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; }, 1800);
}

/* -------------------------------------------------------------------------
   Push notifications (FCM)

   Replaces the old VAPID web-push flow, which cannot work inside a WebView.
   Android works as soon as google-services.json is in place.
   iOS additionally needs an APNs key, which requires a paid Apple Developer
   membership - on a free account registration simply fails and is ignored.
   ---------------------------------------------------------------------- */

async function initPush() {
  if (!P.PushNotifications) return;

  try {
    let perm = await P.PushNotifications.checkPermissions();
    if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
      perm = await P.PushNotifications.requestPermissions();
    }
    if (perm.receive !== 'granted') return;

    P.PushNotifications.addListener('registration', async ({ value }) => {
      const comps = readSubscribedComps();
      try {
        await window.DB.registerPushToken(value, platform, comps, {
          device_id: localStorage.getItem('dls_device_id') || null,
          team: localStorage.getItem('dls_selected_team_league1') || null
        });
      } catch (e) { /* token re-registers on next launch */ }
    });

    P.PushNotifications.addListener('registrationError', () => {
      // Expected on iOS without a paid Apple Developer account (no APNs key).
    });

    // Tapping a notification deep-links to whatever page it names.
    P.PushNotifications.addListener('pushNotificationActionPerformed', ({ notification }) => {
      const target = notification && notification.data && notification.data.url;
      if (target && /^[\w.-]+\.html([?#].*)?$/.test(target)) location.href = target;
    });

    await P.PushNotifications.register();
  } catch (e) { /* push is optional; never block the app on it */ }
}

// Mirrors the competitions the viewer had opted into under the old web-push flow.
function readSubscribedComps() {
  const comps = ['league1', 'league2', 'league3', 'cl', 'europa'];
  return comps.filter(c => localStorage.getItem('dls_notif_' + c) === '1');
}

/* -------------------------------------------------------------------------
   Boot
   ---------------------------------------------------------------------- */

function boot() {
  initChrome();
  initBackButton();
  initPush();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

})();
