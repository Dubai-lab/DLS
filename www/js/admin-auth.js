/* ============================================================================
   DLS ADMIN ACCESS CONTROL  (shared by admin.html + all 5 admin pages)

   Roles:
   - owner   : full access to all 5 competitions + the Management page.
   - manager : access to the competitions listed on their profile.

   This used to be a pair of shared codes checked in the browser, with the
   codes themselves stored in a world-readable database node - anyone could
   fetch them, and anyone could write any competition's data.

   It is now Supabase Auth. Each admin signs in with their own account, and the
   role and competition list come from the admin_profiles table. The same rules
   are enforced again in Postgres by the db_can_read / db_can_write functions,
   so a tampered browser cannot write data its account does not own. The checks
   here only decide what UI to show.
   ========================================================================= */

const AA_COMPS = [
  { key:'league1', label:'DLS League',       sub:'Division 1',      page:'league.html',     color:'#00c853', icon:'&#9917;' },
  { key:'league2', label:'DLS League 2',     sub:'Division 2',      page:'league2.html',    color:'#4fc3f7', icon:'&#9917;' },
  { key:'league3', label:'DLS League 3',     sub:'Division 3',      page:'league3.html',    color:'#ab47bc', icon:'&#9917;' },
  { key:'cl',      label:'Champions League', sub:'Div 1 & 2 Top 8', page:'tournament.html', color:'#FFD700', icon:'&#127942;' },
  { key:'europa',  label:'Europa League',    sub:'Division 3 Top 16', page:'europa.html',   color:'#ff7043', icon:'&#11088;' },
];
function aaComp(key){ return AA_COMPS.find(c=>c.key===key); }

// ── device id (shared with the rest of the app) ──
function aaDeviceId(){
  let id = localStorage.getItem('dls_device_id');
  if(!id){ id = 'dev_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,9); localStorage.setItem('dls_device_id', id); }
  return id;
}

/* ── cached profile ──────────────────────────────────────────────────────
   The profile is cached so the synchronous helpers below (aaIsOwner and
   friends, called from render code) keep working unchanged. aaLoadProfile()
   must run once before them; every page does that at boot.
   ---------------------------------------------------------------------- */

const AA_PROFILE_KEY = 'dls_admin_profile';

function aaCachedProfile(){
  try { return JSON.parse(localStorage.getItem(AA_PROFILE_KEY) || 'null'); }
  catch(e){ return null; }
}
function aaStoreProfile(p){
  if(p) localStorage.setItem(AA_PROFILE_KEY, JSON.stringify(p));
  else  localStorage.removeItem(AA_PROFILE_KEY);
  return p;
}

/** Refresh the cached profile from Supabase. Returns the profile or null. */
async function aaLoadProfile(){
  try {
    const signedIn = await DB.auth.isSignedIn();
    if(!signedIn) return aaStoreProfile(null);
    const profile = await DB.auth.profile();
    return aaStoreProfile(profile);
  } catch(e){
    // Offline: fall back to the cached profile so the UI still renders.
    return aaCachedProfile();
  }
}

// ── synchronous view helpers (read the cache) ──
function aaRole(){ const p = aaCachedProfile(); return p ? p.role : null; }
function aaLeagues(){ const p = aaCachedProfile(); return (p && p.competitions) || []; }
function aaIsOwner(){ return aaRole() === 'owner'; }
function aaCanAccess(comp){ return aaIsOwner() || aaLeagues().includes(comp); }
function aaDisplayName(){ const p = aaCachedProfile(); return (p && p.display_name) || ''; }

// ── sign in / out ──
async function aaSignIn(email, password){
  const profile = await DB.auth.signIn(email, password);
  if(!profile){
    await DB.auth.signOut();
    throw new Error('This account is not registered as a DLS admin.');
  }
  aaStoreProfile(profile);
  return profile;
}

async function aaLogout(){
  try { await DB.auth.signOut(); } catch(e){ /* clear locally regardless */ }
  aaStoreProfile(null);
}

/* ── page guard ──────────────────────────────────────────────────────────
   Call at the top of each admin page, e.g. aaGuard('league1').

   Async, because the session may need refreshing. The page stays behind
   #lock-overlay until the profile confirms access, so competition data is
   never rendered to someone who should not see it.
   ---------------------------------------------------------------------- */
async function aaGuard(comp){
  // Optimistic: reveal immediately if the cache already says yes, so the page
  // does not flash for a legitimate admin.
  const overlay = () => document.getElementById('lock-overlay');
  if(aaCanAccess(comp)){
    const ov = overlay(); if(ov) ov.style.display = 'none';
  }

  await aaLoadProfile();

  if(aaCanAccess(comp)){
    const ov = overlay(); if(ov) ov.style.display = 'none';
    return true;
  }

  location.replace('admin.html');
  return false;
}
