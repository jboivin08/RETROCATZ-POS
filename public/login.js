const API = "http://127.0.0.1:5175";
const SESSION_KEY = "rc_session_id";

function setSession(session_id, user) {
  localStorage.setItem(SESSION_KEY, session_id);
  localStorage.setItem("user", JSON.stringify(user));
}

function getSessionId() {
  return localStorage.getItem(SESSION_KEY);
}

async function fetchMe() {
  const sid = getSessionId();
  if (!sid) return null;
  try {
    const r = await fetch(`${API}/api/me`, { headers: { "rc_session_id": sid } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function renderLogin() {
  const app = document.getElementById("app");
  app.innerHTML = `
    <div class="card">
      <h2>RetroCatz POS – Sign in</h2>
      <div class="row">
        <input id="u" placeholder="Username" autofocus />
        <input id="p" type="password" placeholder="Password" />
        <div id="err" class="error"></div>
        <button id="go">Sign in</button>
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });
      if (r.status === 409) {
        renderBootstrap();
        return;
      }
      const j = await r.json().catch(() => ({ error: "Login failed" }));
      if (!r.ok) { err.textContent = j.error || "Login failed"; return; }

      setSession(j.session_id, j.user);
      // go to your existing UI under src/renderer
      window.location.href = "../src/renderer/index.html";
    } catch {
      err.textContent = "Cannot reach server";
    }
  };
}

function renderBootstrap() {
  const app = document.getElementById("app");
  app.innerHTML = `
    <div class="card">
      <h2>RetroCatz POS â€“ First Run Setup</h2>
      <div class="row">
        <input id="bu" placeholder="Owner username" autofocus />
        <input id="bd" placeholder="Display name (optional)" />
        <input id="bp" type="password" placeholder="Password (min 8 chars)" />
        <div id="berr" class="error"></div>
        <button id="bgo">Create Owner</button>
      </div>
    </div>
  `;

  document.getElementById("bgo").onclick = async () => {
    const username = document.getElementById("bu").value.trim();
    const display_name = document.getElementById("bd").value.trim();
    const password = document.getElementById("bp").value;
    const err = document.getElementById("berr");
    err.textContent = "";

    try {
      const r = await fetch(`${API}/api/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, display_name })
      });
      const j = await r.json().catch(() => ({ error: "Bootstrap failed" }));
      if (!r.ok) { err.textContent = j.error || "Bootstrap failed"; return; }
      renderLogin();
    } catch {
      err.textContent = "Cannot reach server";
    }
  };
}

(async function boot() {
  const me = await fetchMe();
  if (me && me.user) {
    window.location.href = "../src/renderer/index.html";
    return;
  }
  try {
    const s = await fetch(`${API}/api/bootstrap/status`);
    const j = await s.json().catch(() => ({ hasUsers: true }));
    if (j && j.hasUsers === false) {
      renderBootstrap();
      return;
    }
  } catch {
    // ignore and show login
  }
  renderLogin();
})();
