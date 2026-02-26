// public/renderer.js  (replace entire file)
const API = "http://127.0.0.1:5175";
const SESSION_KEY = "rc_session_id";

function getSessionId(){ return localStorage.getItem(SESSION_KEY); }
function setSession(session_id,user){
  localStorage.setItem(SESSION_KEY, session_id);
  localStorage.setItem("user", JSON.stringify(user));
}
function clearSession(){ localStorage.removeItem(SESSION_KEY); localStorage.removeItem("user"); location.reload(); }
function currentUser(){ try { return JSON.parse(localStorage.getItem("user")||"{}"); } catch { return null; } }

async function fetchMe(){
  const sid = getSessionId();
  if(!sid) return null;
  try {
    const r = await fetch(`${API}/api/me`, { headers: { "rc_session_id": sid } });
    if(!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function renderLogin(){
  const app = document.getElementById("app");
  app.innerHTML = `
    <div class="card" style="max-width:360px;margin:40px auto;padding:16px;border:1px solid #e5e7eb;border-radius:12px;font-family:system-ui, sans-serif">
      <h2 style="margin:0 0 12px 0">RetroCatz POS – Sign in</h2>
      <div style="display:grid;gap:8px">
        <input id="u" placeholder="Username" autofocus style="padding:10px;border:1px solid #d1d5db;border-radius:8px"/>
        <input id="p" type="password" placeholder="Password" style="padding:10px;border:1px solid #d1d5db;border-radius:8px"/>
        <div id="err" style="color:#b00020;font-size:12px;min-height:16px"></div>
        <button id="go" style="padding:10px;border-radius:8px;background:#000;color:#fff;border:1px solid #000;cursor:pointer">Sign in</button>
      </div>
    </div>
  `;
  document.getElementById("go").onclick = async () => {
    const username = document.getElementById("u").value.trim();
    const password = document.getElementById("p").value;
    const err = document.getElementById("err");
    err.textContent = "";
    try {
      const r = await fetch(`${API}/api/login`, {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({ username, password })
      });
      const j = await r.json().catch(()=>({error:"Login failed"}));
      if(!r.ok){ err.textContent = j.error || "Login failed"; return; }
      setSession(j.session_id, j.user);
      renderHome();
    } catch {
      err.textContent = "Cannot reach server";
    }
  };
}

function renderHome(){
  const u = currentUser();
  const role = u?.role || "unknown";
  const app = document.getElementById("app");
  app.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px solid #eee;font-family:system-ui,sans-serif">
      <div><strong>RetroCatz POS</strong></div>
      <div>
        <span style="opacity:.7;font-size:12px">${(u?.display_name || u?.username || "user")} (${role})</span>
        <button id="logout" style="margin-left:8px;background:#fff;color:#000;border:1px solid #d1d5db;padding:6px 10px;border-radius:8px;cursor:pointer">Logout</button>
      </div>
    </div>
    <div style="padding:16px;font-family:system-ui,sans-serif">
      <button id="ping" style="padding:8px 12px;border:1px solid #d1d5db;border-radius:8px;background:#fff;cursor:pointer">Test Protected API</button>
      <div id="pingout" style="margin-top:8px;opacity:.7;font-size:12px"></div>
    </div>
  `;
  document.getElementById("logout").onclick = async ()=>{
    const sid = getSessionId();
    try { await fetch(`${API}/api/logout`, { method:"POST", headers:{ "Content-Type":"application/json", "rc_session_id": sid } }); }
    finally { clearSession(); }
  };
  document.getElementById("ping").onclick = async ()=>{
    const sid = getSessionId();
    const r = await fetch(`${API}/api/ping`, { headers: { "rc_session_id": sid } });
    const j = await r.json().catch(()=>({}));
    document.getElementById("pingout").textContent = JSON.stringify(j);
  };
}

(async function boot(){
  const me = await fetchMe();
  if(me && me.user){ setSession(me.session_id, me.user); renderHome(); }
  else { renderLogin(); }
})();
