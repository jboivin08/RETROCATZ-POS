const API = "http://127.0.0.1:5175";

(function(){
  const q = new URLSearchParams(location.search);
  const s = q.get("sid");
  if (s && !localStorage.getItem("rc_session_id")) localStorage.setItem("rc_session_id", s);
})();
function sid(){ return localStorage.getItem("rc_session_id"); }
function auth(){ return { "rc_session_id": sid(), "Content-Type":"application/json" }; }
function backToLogin(){ window.location.href = "../../public/index.html"; }

const PERM_KEYS = ["inv_add","inv_edit","inv_delete","cost_change","category_admin","user_admin","checkout","reports"];

document.getElementById("back-btn").onclick = () => {
  window.location.href = "../index.html?sid=" + encodeURIComponent(sid());
};

function rowHtml(u){
  const tdPerms = PERM_KEYS.map(k=>{
    const checked = u[k] ? "checked" : "";
    return `<td><input type="checkbox" data-k="${k}" data-id="${u.id}" ${checked}></td>`;
  }).join("");
  return `
    <tr>
      <td>${u.id}</td>
      <td>${u.username}</td>
      <td>${u.role}</td>
      <td>${u.active ? "yes" : "no"}</td>
      <td>${u.created_at || ""}</td>
      ${tdPerms}
      <td>
        <button class="btn-sm" data-edit="${u.id}">Edit</button>
        <button class="btn-sm" data-reset="${u.id}">Reset PW</button>
        <button class="btn-sm" data-del="${u.id}">Delete</button>
      </td>
    </tr>
  `;
}

async function loadUsers(){
  const tbody = document.getElementById("users-table");
  if (!sid()) return backToLogin();
  const r = await fetch(`${API}/api/users`, { headers: auth() });
  if (r.status === 401) return backToLogin();
  if (r.status === 403) { tbody.innerHTML = `<tr><td colspan="14">Owner access required.</td></tr>`; return; }
  if (!r.ok) { tbody.innerHTML = `<tr><td colspan="14">Failed (${r.status})</td></tr>`; return; }

  const rows = await r.json();
  tbody.innerHTML = rows.map(rowHtml).join("");

  // permission toggles
  tbody.querySelectorAll('input[type="checkbox"][data-id]').forEach(cb=>{
    cb.addEventListener("change", onPermToggle);
  });

  // edit
  tbody.querySelectorAll("[data-edit]").forEach(b=>{
    b.onclick = async ()=>{
      const id = b.getAttribute("data-edit");
      const newName = prompt("New username (leave blank to skip):");
      const newRole = prompt("New role (owner/manager/clerk, leave blank to skip):");
      const newPw = prompt("New password (min 8, leave blank to skip):");
      const body = {};
      if (newName) body.username = newName;
      if (newRole) body.role = newRole;
      if (newPw && newPw.length >= 8) body.password = newPw;
      if (Object.keys(body).length === 0) return;
      const rr = await fetch(`${API}/api/users/${id}`, { method:"PUT", headers: auth(), body: JSON.stringify(body) });
      if (rr.ok) loadUsers();
      else alert(`Edit failed (${rr.status})`);
    };
  });

  // reset password
  tbody.querySelectorAll("[data-reset]").forEach(b=>{
    b.onclick = async ()=>{
      const id = b.getAttribute("data-reset");
      const pw = prompt("New password (min 8 chars):");
      if (!pw || pw.length < 8) return;
      const rr = await fetch(`${API}/api/users/${id}/password`, {
        method:"PUT", headers: auth(), body: JSON.stringify({ password: pw })
      });
      if (rr.ok) alert("Password updated");
    };
  });

  // delete
  tbody.querySelectorAll("[data-del]").forEach(b=>{
    b.onclick = async ()=>{
      const id = b.getAttribute("data-del");
      if (!confirm("Delete this user?")) return;
      const rr = await fetch(`${API}/api/users/${id}`, { method:"DELETE", headers: auth() });
      if (rr.ok) loadUsers();
      else alert(`Delete failed (${rr.status})`);
    };
  });
}

let pending = {};
let saveTimer = null;
function onPermToggle(e){
  const cb = e.target;
  const id = cb.getAttribute("data-id");
  const key = cb.getAttribute("data-k");
  if (!pending[id]) pending[id] = {};
  pending[id][key] = cb.checked ? 1 : 0;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushPermSaves, 300);
}

async function flushPermSaves(){
  const batches = pending;
  pending = {};
  for (const id of Object.keys(batches)) {
    const payload = {};
    PERM_KEYS.forEach(k=>{
      const el = document.querySelector(`input[data-id="${id}"][data-k="${k}"]`);
      payload[k] = el && el.checked ? 1 : 0;
    });
    await fetch(`${API}/api/users/${id}/permissions`, {
      method:"PUT", headers: auth(), body: JSON.stringify(payload)
    }).catch(()=>{});
  }
}

async function createUser(e){
  e.preventDefault();
  const f = e.target;
  const payload = {
    username: f.username.value.trim(),
    display_name: f.display_name.value.trim(),
    password: f.password.value,
    role: f.role.value
  };
  const r = await fetch(`${API}/api/users`, { method:"POST", headers: auth(), body: JSON.stringify(payload) });
  if (!r.ok) {
    const t = await r.text().catch(()=> ""); alert(`Create failed (${r.status}): ${t}`); return;
  }
  f.reset();
  loadUsers();
}

document.addEventListener("DOMContentLoaded", ()=>{
  const form = document.getElementById("user-form");
  if (form) form.addEventListener("submit", createUser);
  loadUsers();
});
