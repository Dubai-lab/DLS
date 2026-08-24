import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The web assets in www/ are bundled into the binary rather than loaded from a
 * remote URL. A Capacitor app that just points server.url at a website is
 * routinely rejected under App Store guideline 4.2 ("minimum functionality"),
 * and it would also stop working the moment the host is unreachable.
 *
 * Because the app boots from capacitor://localhost (iOS) or https://localhost
 * (Android), any request to a path-relative API endpoint resolves against the
 * device, not the server. Backend calls must use absolute https URLs - see
 * www/js/api.js.
 */
const config: CapacitorConfig = {
  appId: 'com.footballleaguehub.app',
  appName: 'Football League Hub',
  webDir: 'www',

  // Matches the page background so there is no white flash before first paint.
  backgroundColor: '#0d1117',

  android: {
    // https://localhost rather than the older http scheme, so the WebView
    // treats the origin as secure and localStorage survives app restarts.
    androidScheme: 'https',
    allowMixedContent: false,
    captureInput: true
  },

  ios: {
    scheme: 'Football League Hub',
    contentInset: 'always',
    // The pages already handle safe-area insets via env(safe-area-inset-*).
    limitsNavigationsToAppBoundDomains: false
  },

  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      launchAutoHide: true,
      backgroundColor: '#0d1117',
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: false
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0d1117',
      overlaysWebView: false
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert']
    }
  }
};

export default config;
