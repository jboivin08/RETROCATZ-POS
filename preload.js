// preload.js
const { contextBridge, shell } = require("electron");
const BASE = "http://127.0.0.1:5175";
const SESSION_KEY = "rc_session_id";

function getSID() { return localStorage.getItem(SESSION_KEY); }
function setSID(sid) { localStorage.setItem(SESSION_KEY, sid); }

async function apiFetch(path, opts = {}) {
  const headers = new Headers(opts.headers || {});
  const sid = getSID();
  if (sid) headers.set("rc_session_id", sid);
  headers.set("Content-Type", "application/json");
  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  return res.headers.get("content-type")?.includes("application/json") ? res.json() : res.text();
}

contextBridge.exposeInMainWorld("api", {
  // auth
  login: async (username, password) => {
    const data = await apiFetch("/api/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    setSID(data.session_id);
    return data;
  },
  me: async () => apiFetch("/api/me"),

  // items
  listItems: async () => apiFetch("/api/items"),
  addItem: async (item) => apiFetch("/api/items", { method: "POST", body: JSON.stringify(item) }),

  // util
  hasSession: () => !!getSID(),
  openExternal: (url) => {
    if (!url || typeof url !== "string") return;
    if (!/^https?:\/\//i.test(url)) return;
    shell.openExternal(url);
  }
});
