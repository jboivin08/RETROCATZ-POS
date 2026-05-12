const API = "http://127.0.0.1:5175";
const SESSION_KEY = "rc_session_id";
const LOADING_DISABLED_KEY = "vaultcore_loading_disabled";
const MIN_LOADING_MS = 2200;

let loadingCancelled = false;

function loadingDisabled() {
  return localStorage.getItem(LOADING_DISABLED_KEY) === "1";
}

function setLoadingDisabled(disabled) {
  if (disabled) localStorage.setItem(LOADING_DISABLED_KEY, "1");
  else localStorage.removeItem(LOADING_DISABLED_KEY);
}

function setBodyMode(mode) {
  document.body.classList.toggle("auth-ready", mode !== "loading");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function fetchBootstrapStatus() {
  const r = await fetch(`${API}/api/bootstrap/status`, { cache: "no-store" });
  if (!r.ok) throw new Error("server_not_ready");
  return await r.json().catch(() => ({ hasUsers: true }));
}

async function waitForServer({ onUpdate } = {}) {
  const started = Date.now();
  const timeoutMs = 18000;
  let attempt = 0;

  while (Date.now() - started < timeoutMs) {
    if (loadingCancelled) return { ok: false, cancelled: true };
    attempt += 1;
    try {
      const status = await fetchBootstrapStatus();
      return { ok: true, status };
    } catch {
      if (onUpdate) {
        const label =
          attempt < 3 ? "Starting local services..." :
          attempt < 7 ? "Checking the register database..." :
          "Still waiting for the local server...";
        onUpdate(label, `Attempt ${attempt}`);
      }
      await sleep(Math.min(450 + attempt * 180, 1400));
    }
  }

  return { ok: false, timeout: true };
}

function renderLoadingScreen() {
  loadingCancelled = false;
  setBodyMode("loading");
  const app = document.getElementById("app");
  app.innerHTML = `
    <main class="loading-shell">
      <section class="loading-card" aria-live="polite">
        <div class="vault-mark" aria-hidden="true">
          <div class="vault-core">VC</div>
        </div>
        <h1 class="loading-title">VaultCore</h1>
        <div id="loadStatus" class="loading-status">Starting local services...</div>
        <div id="loadDetail" class="loading-detail">Preparing the register</div>
        <div class="loading-bar" aria-hidden="true"><span></span></div>
        <div class="loading-actions">
          <button id="skipLoading" class="secondary" type="button">Skip</button>
          <button id="disableLoading" class="link-button" type="button">Turn off loading screen</button>
        </div>
      </section>
    </main>
  `;

  document.getElementById("skipLoading").onclick = () => {
    loadingCancelled = true;
    renderEntry();
  };
  document.getElementById("disableLoading").onclick = () => {
    setLoadingDisabled(true);
    loadingCancelled = true;
    renderEntry({ serverWarning: "Loading screen is off on this register." });
  };
}

function updateLoadingStatus(status, detail) {
  const statusEl = document.getElementById("loadStatus");
  const detailEl = document.getElementById("loadDetail");
  if (statusEl) statusEl.textContent = status;
  if (detailEl) detailEl.textContent = detail || "";
}

function renderServerProblem() {
  setBodyMode("server");
  const app = document.getElementById("app");
  app.innerHTML = `
    <main class="server-panel">
      <h2>VaultCore could not reach the local server</h2>
      <p>The register app is open, but the local service is not answering yet. Retry startup, or continue to sign in and try again in a moment.</p>
      <div class="server-actions">
        <button id="retryServer" type="button">Retry</button>
        <button id="openLoginAnyway" class="secondary" type="button">Open login</button>
        <button id="disableLoadingFromError" class="secondary" type="button">Turn off loading screen</button>
      </div>
    </main>
  `;
  document.getElementById("retryServer").onclick = () => boot();
  document.getElementById("openLoginAnyway").onclick = () => renderEntry({
    serverWarning: "The local server is still starting. If sign in fails, wait a moment and retry."
  });
  document.getElementById("disableLoadingFromError").onclick = () => {
    setLoadingDisabled(true);
    renderEntry({ serverWarning: "Loading screen is off on this register." });
  };
}

function renderLogin({ serverWarning = "" } = {}) {
  setBodyMode("login");
  const app = document.getElementById("app");
  app.innerHTML = `
    <div class="card">
      <h2>VaultCore POS - Sign in</h2>
      <div class="row">
        <input id="u" placeholder="Username" autofocus />
        <input id="p" type="password" placeholder="Password" />
        ${serverWarning ? `<div class="hint">${serverWarning}</div>` : ""}
        <div id="err" class="error"></div>
        <button id="go">Sign in</button>
      </div>
      <div class="auth-actions">
        <span class="hint">Loading screen: ${loadingDisabled() ? "off" : "on"}</span>
        <button id="toggleLoading" class="link-button" type="button">${loadingDisabled() ? "Turn on" : "Turn off"}</button>
      </div>
    </div>
  `;

  document.getElementById("toggleLoading").onclick = () => {
    const nextDisabled = !loadingDisabled();
    setLoadingDisabled(nextDisabled);
    renderLogin({
      serverWarning: nextDisabled
        ? "Loading screen is off on this register."
        : "Loading screen will show next time VaultCore opens."
    });
  };

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
      err.textContent = "Cannot reach the local server. Restart VaultCore or wait a moment and try again.";
    }
  };
}

function renderBootstrap() {
  setBodyMode("bootstrap");
  const app = document.getElementById("app");
  app.innerHTML = `
    <div class="card">
      <h2>VaultCore POS - First Run Setup</h2>
      <div class="row">
        <input id="bu" placeholder="Owner username" autofocus />
        <input id="bd" placeholder="Display name (optional)" />
        <input id="bp" type="password" placeholder="Password (min 8 chars)" />
        <div id="berr" class="error"></div>
        <button id="bgo">Create Owner</button>
      </div>
      <div class="auth-actions">
        <span class="hint">Loading screen: ${loadingDisabled() ? "off" : "on"}</span>
        <button id="toggleLoading" class="link-button" type="button">${loadingDisabled() ? "Turn on" : "Turn off"}</button>
      </div>
    </div>
  `;

  document.getElementById("toggleLoading").onclick = () => {
    setLoadingDisabled(!loadingDisabled());
    renderBootstrap();
  };

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
      err.textContent = "Cannot reach the local server. Restart VaultCore or wait a moment and try again.";
    }
  };
}

async function renderEntry(options = {}) {
  const me = await fetchMe();
  if (me && me.user) {
    window.location.href = "../src/renderer/index.html";
    return;
  }
  try {
    const j = await fetchBootstrapStatus();
    if (j && j.hasUsers === false) {
      renderBootstrap();
      return;
    }
  } catch {
    if (!options.serverWarning) {
      return renderServerProblem();
    }
  }
  renderLogin(options);
}

async function boot() {
  if (loadingDisabled()) {
    await renderEntry();
    return;
  }

  const loadingStartedAt = Date.now();
  renderLoadingScreen();
  const ready = await waitForServer({ onUpdate: updateLoadingStatus });
  if (ready.cancelled) return;
  if (!ready.ok) {
    renderServerProblem();
    return;
  }
  updateLoadingStatus("VaultCore is ready", "Opening sign in");
  const remaining = Math.max(0, MIN_LOADING_MS - (Date.now() - loadingStartedAt));
  await sleep(Math.max(remaining, 350));
  if (loadingCancelled) return;
  await renderEntry();
}

boot();
