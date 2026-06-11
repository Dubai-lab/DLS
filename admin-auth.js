/* ════════════════════════════════════════════════════════════
   DLS ADMIN ACCESS CONTROL  (shared by index.html + all 5 admin pages)

   Roles:
   - owner   : full access to all 5 competitions + the Management page.
               Enters the Owner Master Code once, then remembered on the device.
   - manager : access to ONE assigned competition only. Enters that
               competition's manager code (set by the owner in Management).

   First gate password (shared): dlsadmin@123
   Owner Master Code (initial)  : OWNER-2026   (changeable in Management)

   NOTE: this is browser-side access *management*, not server security.
   ════════════════════════════════════════════════════════════ */

const AA_FB = 'https://dls-hub-62226-default-rtdb.firebaseio.com';
const AA_DEFAULT_PW = 'dlsadmin@123';
const AA_LOCK_MS = 24 * 60 * 60 * 1000;   // locked browsers auto-clear after 24h

const AA_COMPS = [
  { key:'league1', label:'DLS League',       sub:'Division 1',        page:'league.html',     color:'#00c853', icon:'&#9917;' },
  { key:'league2', label:'DLS League 2',     sub:'Division 2',        page:'league2.html',    color:'#4fc3f7', icon:'&#9917;' },
  { key:'league3', label:'DLS League 3',     sub:'Division 3',        page:'league3.html',    color:'#ab47bc', icon:'&#9917;' },
  { key:'cl',      label:'Champions League', sub:'Div 1 & 2 Top 8',   page:'tournament.html', color:'#FFD700', icon:'&#127942;' },
  { key:'europa',  label:'Europa League',    sub:'Division 3 Top 16', page:'europa.html',     color:'#ff7043', icon:'&#11088;' },
];
function aaComp(key){ return AA_COMPS.find(c=>c.key===key); }

// ── device id (shared with the rest of the app) ──
function aaDeviceId(){
  let id = localStorage.getItem('dls_device_id');
  if(!id){ id = 'dev_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,9); localStorage.setItem('dls_device_id', id); }
  return id;
}

// ── local auth state ──
function aaRole(){ return localStorage.getItem('dls_admin_role'); }                 // 'owner' | 'manager' | null
function aaLeagues(){ try{ return JSON.parse(localStorage.getItem('dls_admin_leagues')||'[]'); }catch(e){ return []; } }
function aaIsOwner(){ return aaRole()==='owner'; }
function aaCanAccess(comp){ return aaIsOwner() || aaLeagues().includes(comp); }
function aaSetOwner(){ localStorage.setItem('dls_admin_role','owner'); localStorage.setItem('dls_admin_leagues', JSON.stringify(AA_COMPS.map(c=>c.key))); }
function aaSetManager(comp){ localStorage.setItem('dls_admin_role','manager'); localStorage.setItem('dls_admin_leagues', JSON.stringify([comp])); }
function aaLogout(){ localStorage.removeItem('dls_admin_role'); localStorage.removeItem('dls_admin_leagues'); }

// ── Firebase config (codes + locks) ──
async function aaFetchConfig(){
  try{
    const r = await fetch(AA_FB+'/dls_admin_auth.json');
    let d = r.ok ? await r.json() : null;
    if(!d || !d.ownerCode){
      d = { ownerCode:'OWNER-2026', leagueCodes:{}, locks:{} };
      await fetch(AA_FB+'/dls_admin_auth.json',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});
    }
    if(!d.leagueCodes) d.leagueCodes = {};
    if(!d.locks) d.locks = {};
    return d;
  }catch(e){ return { ownerCode:'OWNER-2026', leagueCodes:{}, locks:{} }; }
}

// ── lockout (browser locked after 3 wrong manager codes) ──
async function aaIsLocked(cfg){
  const lk = cfg && cfg.locks && cfg.locks[aaDeviceId()];
  if(!lk) return false;
  if(lk.until && Date.now() > lk.until){            // expired → auto-clear
    fetch(AA_FB+'/dls_admin_auth/locks/'+aaDeviceId()+'.json',{method:'DELETE'}).catch(()=>{});
    return false;
  }
  return true;
}
async function aaLockDevice(){
  const body = { until: Date.now()+AA_LOCK_MS, at: Date.now() };
  try{ await fetch(AA_FB+'/dls_admin_auth/locks/'+aaDeviceId()+'.json',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); }catch(e){}
}
async function aaUnlockDevice(id){
  try{ await fetch(AA_FB+'/dls_admin_auth/locks/'+id+'.json',{method:'DELETE'}); }catch(e){}
}

// ── page guard: call on each admin page e.g. aaGuard('league1') ──
// Hides #lock-overlay if this device may access the comp, else sends to the gate.
function aaGuard(comp){
  if(aaCanAccess(comp)){
    const ov = document.getElementById('lock-overlay'); if(ov) ov.style.display='none';
    return true;
  }
  location.replace('index.html');
  return false;
}
