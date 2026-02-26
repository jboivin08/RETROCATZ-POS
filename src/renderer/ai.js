// ai.js — RetroCatz Brain front-end
const API_BASE = "http://127.0.0.1:5175";
const SESSION_KEY = "rc_session_id";

function $(id) {
  return document.getElementById(id);
}

const feedListEl = $("feedList");
const feedEmptyEl = $("feedEmpty");
const refreshBtn = $("refreshFeedBtn");
const modeSelect = $("aiMode");
const chattinessSelect = $("aiChattiness");
const mindWindowEl = $("mindWindow");
const mindCodeEl = $("mindCode");
const chatTranscriptEl = $("chatTranscript");
const chatFormEl = $("chatForm");
const chatInputEl = $("chatInput");
const chatSendBtn = $("chatSendBtn");
const aiLiveStatusEl = $("aiLiveStatus");
let currentMode = "lab";

// ---- Helpers -------------------------------------------------------------

function formatDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function createBadge(text, className) {
  const span = document.createElement("span");
  span.className = "badge " + className;
  span.textContent = text;
  return span;
}

function severityClass(severity) {
  switch ((severity || "").toLowerCase()) {
    case "warning":
      return "badge-warning";
    case "opportunity":
      return "badge-opportunity";
    default:
      return "badge-info";
  }
}

function sourceLabel(source) {
  switch ((source || "").toLowerCase()) {
    case "store_oracle":
      return "STORE_ORACLE";
    case "margin_risk":
      return "MARGIN & RISK COACH";
    case "market":
      return "MARKET WATCHER";
    case "trend":
      return "TREND BRAIN";
    case "system":
      return "SYSTEM";
    default:
      return (source || "OTHER").toUpperCase();
  }
}

function renderAiStatus(meta) {
  if (!aiLiveStatusEl) return;
  aiLiveStatusEl.classList.remove("live", "fallback");

  if (!meta) {
    aiLiveStatusEl.textContent = "AI status unknown";
    return;
  }

  if (meta.liveUsed) {
    aiLiveStatusEl.classList.add("live");
    aiLiveStatusEl.textContent = "Live AI ON";
    return;
  }

  aiLiveStatusEl.classList.add("fallback");
  const reason = meta.fallbackReason ? ` (${meta.fallbackReason})` : "";
  aiLiveStatusEl.textContent = `Live AI OFF${reason}`;
}

async function loadAiStatus() {
  try {
    const data = await fetchJson(`${API_BASE}/api/ai/status`);
    if (data && data.mode && modeSelect) {
      currentMode = data.mode;
      modeSelect.value = data.mode;
    }
    if (!data || data.mode === "off") {
      renderAiStatus({ liveUsed: false, fallbackReason: "ai_mode_off" });
      return;
    }
    if (!data.liveConfigured) {
      renderAiStatus({ liveUsed: false, fallbackReason: "missing_openai_api_key" });
      return;
    }

    aiLiveStatusEl.classList.remove("live", "fallback");
    aiLiveStatusEl.classList.add("live");
    aiLiveStatusEl.textContent = data.mode === "on" ? "Live AI READY (ONLINE)" : "Live AI READY (AUTO)";
  } catch (err) {
    renderAiStatus(null);
    console.warn("Failed to load AI status:", err.message);
  }
}

// ---- Feed rendering ------------------------------------------------------

function renderFeed(rows) {
  feedListEl.innerHTML = "";

  if (!rows || !rows.length) {
    feedEmptyEl.style.display = "block";
    return;
  }

  feedEmptyEl.style.display = "none";

  rows.forEach((msg) => {
    const card = document.createElement("div");
    card.className = "msg-card";

    const header = document.createElement("div");
    header.className = "msg-header";

    const title = document.createElement("div");
    title.className = "msg-title";
    title.textContent = msg.title || "(untitled)";

    const meta = document.createElement("div");
    meta.className = "msg-meta";

    const sevBadge = createBadge(
      (msg.severity || "info").toUpperCase(),
      severityClass(msg.severity)
    );
    const srcBadge = createBadge(sourceLabel(msg.source), "badge-source");

    const when = document.createElement("span");
    when.textContent = " " + formatDate(msg.createdAt);

    meta.appendChild(sevBadge);
    meta.appendChild(document.createTextNode(" "));
    meta.appendChild(srcBadge);
    meta.appendChild(when);

    header.appendChild(title);
    header.appendChild(meta);

    const body = document.createElement("div");
    body.className = "msg-body";
    body.textContent = msg.body || "";

    card.appendChild(header);
    card.appendChild(body);

    feedListEl.appendChild(card);
  });
}

// ---- API calls -----------------------------------------------------------

async function fetchJson(url, options) {
  const sid = localStorage.getItem(SESSION_KEY) || "";
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", "rc_session_id": sid },
    ...options
  });
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error("unauthorized");
    }
    const msg = await res.text();
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  return res.json();
}

async function loadSettings() {
  try {
    const data = await fetchJson(`${API_BASE}/api/ai/settings`);
    if (data && data.mode && modeSelect) {
      currentMode = data.mode;
      modeSelect.value = data.mode;
    }
    if (data && data.chattiness && chattinessSelect) {
      chattinessSelect.value = data.chattiness;
    }
    if (data && data.mode === "off") {
      renderAiStatus({ liveUsed: false, fallbackReason: "ai_mode_off" });
    }
  } catch (err) {
    console.warn("Failed to load AI settings:", err.message);
  }
}

async function loadFeed() {
  try {
    const rows = await fetchJson(`${API_BASE}/api/ai/feed`);
    renderFeed(rows);
  } catch (err) {
    console.warn("Failed to load AI feed:", err.message);
    feedListEl.innerHTML = "";
    feedEmptyEl.style.display = "block";
    feedEmptyEl.textContent = "Cannot reach Brain service. Is the backend running?";
  }
}

async function refreshBrain() {
  try {
    // Visual pulse in the mind window
    mindWindowEl.classList.add("active");
    setTimeout(() => mindWindowEl.classList.remove("active"), 1000);

    // Tell the brain to re-run snapshots
    const data = await fetchJson(`${API_BASE}/api/ai/refresh`, {
      method: "POST",
      body: JSON.stringify({})
    });

    const feed = data.feed || [];
    renderFeed(feed);

    const ts = new Date().toISOString();
    mindCodeEl.textContent =
      `[${ts}]\n` +
      `POST /api/ai/refresh\n` +
      `→ Store Oracle + Margin & Risk Coach reran.\n` +
      `Feed items now: ${feed.length}`;
  } catch (err) {
    console.error("Refresh failed:", err);
    mindCodeEl.textContent =
      "Refresh failed.\n" +
      (err && err.message ? err.message : "Unknown error.");
  }
}

async function updateChattiness(mode) {
  try {
    const body = { mode: currentMode, chattiness: mode };
    const data = await fetchJson(`${API_BASE}/api/ai/settings`, {
      method: "POST",
      body: JSON.stringify(body)
    });
    currentMode = data.mode || currentMode;

    const ts = new Date().toISOString();
    mindCodeEl.textContent =
      `[${ts}]\n` +
      `Chattiness set to: ${data.chattiness || mode}\n` +
      `Mode: ${data.mode || "lab"}`;
  } catch (err) {
    console.warn("Failed to update chattiness:", err.message);
  }
}

async function updateMode(mode) {
  try {
    const body = { mode, chattiness: chattinessSelect?.value || "normal" };
    const data = await fetchJson(`${API_BASE}/api/ai/settings`, {
      method: "POST",
      body: JSON.stringify(body)
    });
    currentMode = data.mode || mode;
    if (modeSelect) modeSelect.value = currentMode;
    await loadAiStatus();
  } catch (err) {
    console.warn("Failed to update AI mode:", err.message);
  }
}

async function sendChat(message) {
  const ts = new Date().toISOString();

  // render my line immediately
  const meLine = document.createElement("div");
  meLine.className = "chat-line me";
  meLine.textContent = message;
  chatTranscriptEl.appendChild(meLine);
  chatTranscriptEl.scrollTop = chatTranscriptEl.scrollHeight;

  try {
    chatSendBtn.disabled = true;

    const data = await fetchJson(`${API_BASE}/api/ai/chat`, {
      method: "POST",
      body: JSON.stringify({ message })
    });

    const reply = data.reply || "(no reply)";
    renderAiStatus(data.meta || null);

    const aiLine = document.createElement("div");
    aiLine.className = "chat-line ai";
    aiLine.textContent = reply;
    chatTranscriptEl.appendChild(aiLine);
    chatTranscriptEl.scrollTop = chatTranscriptEl.scrollHeight;

    mindWindowEl.classList.add("active");
    setTimeout(() => mindWindowEl.classList.remove("active"), 800);

    mindCodeEl.textContent =
      `[${ts}]\n` +
      `POST /api/ai/chat\n` +
      `User: "${message}"\n` +
      `Brain: "${reply}"\n` +
      `Live: ${data?.meta?.liveUsed ? "on" : "off"} (${data?.meta?.fallbackReason || "ok"})`;
  } catch (err) {
    const errLine = document.createElement("div");
    errLine.className = "chat-line ai";
    errLine.textContent = err.message === "unauthorized"
      ? "Session expired. Please sign in again."
      : "Brain is offline or unreachable.";
    chatTranscriptEl.appendChild(errLine);
    chatTranscriptEl.scrollTop = chatTranscriptEl.scrollHeight;
    console.error("Chat failed:", err);
  } finally {
    chatSendBtn.disabled = false;
  }
}

// ---- Wire up events -------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  // initial load
  loadSettings();
  loadAiStatus();
  loadFeed();

  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      refreshBrain();
    });
  }

  if (chattinessSelect) {
    chattinessSelect.addEventListener("change", (e) => {
      updateChattiness(e.target.value);
    });
  }

  if (modeSelect) {
    modeSelect.addEventListener("change", (e) => {
      updateMode(e.target.value);
    });
  }

  if (chatFormEl) {
    chatFormEl.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = (chatInputEl.value || "").trim();
      if (!text) return;
      chatInputEl.value = "";
      sendChat(text);
    });
  }
});
