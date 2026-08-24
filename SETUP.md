# DLS Africa Hub — native app setup

The app is no longer a PWA. It is a Capacitor app: `www/` is bundled into real
Android and iOS binaries, Supabase is the backend, and Vercel hosts the web copy
plus the two backend functions.

```
www/           the app itself (bundled into both binaries and served by Vercel)
  js/db.js       Supabase data layer + fbFetch compatibility shim
  js/admin-auth.js  role checks against Supabase Auth
  js/api.js      absolute backend URLs
  js/native.js   status bar, back button, push
api/           Vercel serverless functions
supabase/      schema.sql - run this in the SQL editor
scripts/       migration and admin seeding
android/ ios/  native projects, built by Codemagic
```

Work through the steps in order. Steps 1–3 must happen before the app can load
any data.

---

## 1. Create the database schema

Supabase Dashboard → **SQL Editor** → New query → paste all of
`supabase/schema.sql` → Run.

It is idempotent, so you can re-run it after edits.

This creates:

- `documents` — one JSONB row per former Firebase node
- `admin_profiles` — who administers which competition
- `push_tokens` — FCM devices, replacing the old web-push subscriptions
- the `db_get` / `db_set` / `db_update` / `db_delete` RPCs the app calls
- row level security, so `anon` can read published data and write only
  highlight reactions and team claims

## 2. Migrate the data

```bash
node scripts/migrate-to-supabase.mjs --dry-run          # preview
node scripts/migrate-to-supabase.mjs --recover-league1  # migrate for real
```

`--recover-league1` rebuilds `dls_admin_league` from the intact `dls_pub_league`
mirror. See "The 2026-08-24 wipe" below for why that is needed.

Three nodes are deliberately **not** migrated:

| Node | Why |
|---|---|
| `dls_admin_auth` | replaced by Supabase Auth |
| `dls_push` | web-push VAPID subscriptions, dead under FCM |
| `dls_push_subs` | same |

## 3. Create the admin accounts

```bash
node scripts/seed-admins.mjs --list    # review the emails first, edit the file
node scripts/seed-admins.mjs
```

Passwords are generated, printed once, and written to `ADMIN-PASSWORDS.txt`
(gitignored). Save them somewhere safe and delete that file.

Edit the `ADMINS` array at the top of `scripts/seed-admins.mjs` to change who
gets an account. The owner email currently defaults to yours.

---

## 4. Deploy to Vercel

Import the GitHub repo at vercel.com. `vercel.json` already sets `www` as the
output directory and picks up `api/`.

Set these environment variables (Project → Settings → Environment Variables):

| Variable | Value |
|---|---|
| `SUPABASE_URL` | from `.env` |
| `SUPABASE_SERVICE_KEY` | the `Services_Key` from `.env` — **server only** |
| `FIREBASE_SERVICE_ACCOUNT` | FCM service account JSON, on one line |
| `CRON_SECRET` | any long random string; Vercel sends it to the cron endpoint |

Then set `API_ORIGIN` in `www/js/api.js` to your real Vercel URL. Until you do,
the native builds will call `https://dls-africa-hub.vercel.app`.

**Note on the cron:** `vercel.json` schedules `remind-players` three times a day.
Vercel's Hobby plan allows only one cron invocation per day — either upgrade or
reduce the schedule to a single daily run.

Once Vercel is live, delete the Netlify site. `netlify.toml` and
`netlify/functions/` are already removed from the repo.

## 5. Firebase Cloud Messaging

You keep the existing Firebase project — only Realtime Database is being retired.

1. Firebase Console → Project Settings → **Cloud Messaging**, make sure the API
   is enabled.
2. Project Settings → **Service accounts** → Generate new private key. That JSON
   becomes `FIREBASE_SERVICE_ACCOUNT` on Vercel.
3. Project Settings → **General** → add an Android app with package name
   `com.africadlsglobal.hub` → download `google-services.json`.
4. Base64-encode it and store it in Codemagic as `FIREBASE_GOOGLE_SERVICES_JSON`
   in a variable group named `firebase`:

   ```bash
   base64 -w0 google-services.json
   ```

**iOS push will not work on a free Apple ID.** APNs keys require a paid Apple
Developer Program membership. The app handles this gracefully — registration
fails and is ignored. Android push works regardless.

## 6. Build on Codemagic

Connect the GitHub repo. `codemagic.yaml` defines four workflows:

| Workflow | Output | Needs |
|---|---|---|
| `android-debug` | installable APK | nothing — **start here** |
| `android-release` | signed AAB + APK | a keystore named `dls_keystore` |
| `ios-unsigned` | unsigned `.ipa` | nothing |
| `ios-signed` | TestFlight | paid Apple account + App Store Connect key |

### Getting the app onto your iPhone with a free Apple ID

Codemagic cannot do free-provisioning signing — Apple only issues those 7-day
certificates through Xcode on a Mac. So `ios-unsigned` builds with signing
disabled and gives you a raw `.ipa`:

1. Run the `ios-unsigned` workflow, download the artifact.
2. Install [Sideloadly](https://sideloadly.io) on Windows.
3. Plug in your iPhone, drop in the `.ipa`, sign in with your Apple ID.
4. On the phone: Settings → General → VPN & Device Management → trust the
   developer certificate.

The profile expires after **7 days**; re-run Sideloadly to refresh it. A paid
membership raises that to a year and unlocks TestFlight and push.

---

## The 2026-08-24 wipe

While this migration was being prepared, `dls_admin_league` dropped from 50,903
bytes to 76 — it lost `teams`, `matchdays`, `logos`, `phones`, and `seasons`.

The cause is in the old `league.html`: `LS` was loaded from **localStorage**, and
`saveLS()` pushed whatever `LS` held to the database as a whole-node PUT. On a
device with no local data, `defaultLS()` returns empty arrays, and writing that
produces exactly the record now in the database. Leagues 2 and 3 have been
sitting at that same 76-byte default, so this had happened before.

Every fresh native install starts with empty localStorage, so this would have
become routine. Three changes address it:

1. **`db_set()` refuses** to replace a populated `dls_admin_*` document with an
   empty one (`db_doc_weight` in `schema.sql`).
2. **`cloudHydrate()`** pulls the cloud copy down at boot when the device has no
   local state, so admins start from real data rather than a blank season.
3. **`--recover-league1`** rebuilds the lost document from `dls_pub_league`.

---

## Still on Firebase

**Firebase Storage** still hosts highlight videos and thumbnails — 18 upload and
delete call sites across the admin pages. Those still work, because Storage is a
separate service from the Realtime Database being retired. Moving them to
Supabase Storage is a follow-up; the bucket is currently empty.

## Security changes made during the migration

| Before | After |
|---|---|
| Admin codes in a world-readable DB node | Supabase Auth accounts + RLS |
| `NOTIFY_SECRET` hardcoded in 5 admin pages | Vercel verifies the caller's Supabase token |
| Viewer downloaded every competition code | `resolve_access_code()` returns only the match |
| Anyone could write any node | RLS: anon writes only reactions and team claims |

The `anon` key in `www/js/db.js` is meant to be public — RLS is what protects the
data. The `service_role` key must never appear in `www/`.
