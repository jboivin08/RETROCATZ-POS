// src/session.js
export function getSessionId() {
  return localStorage.getItem("rc_session_id");
}

export function storeSession(session_id, user) {
  localStorage.setItem("rc_session_id", session_id);
  localStorage.setItem("user", JSON.stringify(user));
}

export function currentUser() {
  try { return JSON.parse(localStorage.getItem("user") || "{}"); } catch { return null; }
}

export function getRole() {
  const u = currentUser();
  return u && u.role ? u.role : null; // "owner" | "manager" | "clerk"
}

export async function fetchMe() {
  const sid = getSessionId();
  if (!sid) return null;
  const r = await fetch("/api/me", { headers: { "rc_session_id": sid } });
  if (!r.ok) return null;
  return await r.json();
}

export function authHeaders() {
  const sid = getSessionId();
  return sid ? { "rc_session_id": sid, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

export function logout() {
  const sid = getSessionId();
  fetch("/api/logout", { method: "POST", headers: { "Content-Type":"application/json", "rc_session_id": sid } })
    .finally(()=>{
      localStorage.removeItem("rc_session_id");
      localStorage.removeItem("user");
      location.reload();
    });
}
