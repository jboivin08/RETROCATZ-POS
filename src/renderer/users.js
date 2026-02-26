const API = "http://127.0.0.1:5175";

(function bootstrapSession() {
  const q = new URLSearchParams(location.search);
  const incoming = q.get("sid");
  if (incoming && !localStorage.getItem("rc_session_id")) {
    localStorage.setItem("rc_session_id", incoming);
  }
})();

const PERMISSIONS = [
  { key: "inv_add", label: "Add Inventory" },
  { key: "inv_edit", label: "Edit Inventory" },
  { key: "inv_delete", label: "Delete Inventory" },
  { key: "cost_change", label: "Cost Changes" },
  { key: "category_admin", label: "Category Admin" },
  { key: "user_admin", label: "User Admin" },
  { key: "checkout", label: "Checkout" },
  { key: "reports", label: "Reports" }
];

const state = {
  me: null,
  users: [],
  selectedId: null
};

function sid() {
  return localStorage.getItem("rc_session_id");
}

function authHeaders() {
  return {
    "rc_session_id": sid() || "",
    "Content-Type": "application/json"
  };
}

function backToLogin() {
  window.location.href = "../../public/index.html";
}

function escapeHtml(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setNotice(message, level = "info") {
  const el = document.getElementById("notice");
  if (!el) return;
  el.textContent = message || "";
  if (level === "error") el.style.color = "#ffc5c5";
  else if (level === "success") el.style.color = "#b7f7d8";
  else el.style.color = "#9fb2d6";
}

async function api(path, opts = {}) {
  const response = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      ...authHeaders()
    }
  });

  if (response.status === 401) {
    backToLogin();
    throw new Error("Unauthorized");
  }

  let payload = null;
  const text = await response.text().catch(() => "");
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text };
    }
  }

  if (!response.ok) {
    const msg = (payload && (payload.error || payload.message)) || `Request failed (${response.status})`;
    const err = new Error(msg);
    err.status = response.status;
    throw err;
  }

  return payload;
}

function getSelectedUser() {
  return state.users.find(u => Number(u.id) === Number(state.selectedId)) || null;
}

function getOwnersCount() {
  return state.users.filter(u => u.role === "owner").length;
}

function formatDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function permissionCount(user) {
  return PERMISSIONS.reduce((n, p) => n + (user[p.key] ? 1 : 0), 0);
}

function filteredUsers() {
  const term = (document.getElementById("search-input")?.value || "").trim().toLowerCase();
  const role = (document.getElementById("role-filter")?.value || "").trim().toLowerCase();

  return state.users.filter(u => {
    if (role && u.role !== role) return false;
    if (!term) return true;
    const hay = `${u.username || ""} ${u.display_name || ""}`.toLowerCase();
    return hay.includes(term);
  });
}

function renderMetrics() {
  const users = state.users;
  const active = users.filter(u => Number(u.active) === 1).length;
  const owners = users.filter(u => u.role === "owner").length;
  const managers = users.filter(u => u.role === "manager").length;

  document.getElementById("metric-total").textContent = String(users.length);
  document.getElementById("metric-active").textContent = String(active);
  document.getElementById("metric-owners").textContent = String(owners);
  document.getElementById("metric-managers").textContent = String(managers);
}

function renderTable() {
  const tbody = document.getElementById("users-table");
  const rows = filteredUsers();

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="muted">No users match the current filter.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(u => {
    const selected = Number(state.selectedId) === Number(u.id);
    const statusClass = Number(u.active) === 1 ? "status-on" : "status-off";
    const statusText = Number(u.active) === 1 ? "Active" : "Inactive";
    const canDelete = !(state.me && Number(state.me.id) === Number(u.id));

    return `
      <tr data-row-id="${u.id}" ${selected ? 'style="background: rgba(46,196,255,.08);"' : ""}>
        <td>#${u.id}</td>
        <td>${escapeHtml(u.username)}</td>
        <td>${escapeHtml(u.display_name || "-")}</td>
        <td>${escapeHtml(u.role)}</td>
        <td><span class="status-pill ${statusClass}">${statusText}</span></td>
        <td>${escapeHtml(formatDate(u.created_at))}</td>
        <td>${permissionCount(u)}/${PERMISSIONS.length}</td>
        <td>
          <div class="actions">
            <button class="btn-xs" data-action="select" data-id="${u.id}">Select</button>
            <button class="btn-xs" data-action="toggle-active" data-id="${u.id}">${Number(u.active) === 1 ? "Disable" : "Enable"}</button>
            <button class="btn-xs danger" data-action="delete" data-id="${u.id}" ${canDelete ? "" : "disabled"}>Delete</button>
          </div>
        </td>
      </tr>
    `;
  }).join("");
}

function renderPermissionEditor(user) {
  const grid = document.getElementById("perm-grid");
  if (!grid) return;

  const isOwner = user.role === "owner";
  grid.innerHTML = PERMISSIONS.map(p => {
    const checked = user[p.key] ? "checked" : "";
    const disabled = isOwner ? "disabled" : "";
    return `
      <label class="perm-item">
        <input type="checkbox" data-perm="${p.key}" ${checked} ${disabled} />
        <span>${escapeHtml(p.label)}</span>
      </label>
    `;
  }).join("");
}

function renderEditor() {
  const panel = document.getElementById("editor-panel");
  const label = document.getElementById("active-editor-label");
  const user = getSelectedUser();

  if (!user) {
    panel.style.display = "none";
    label.textContent = "No user selected";
    return;
  }

  panel.style.display = "block";
  label.textContent = `Editing: ${user.display_name || user.username} (#${user.id})`;

  const editForm = document.getElementById("edit-form");
  editForm.elements.id.value = String(user.id);
  editForm.elements.username.value = user.username || "";
  editForm.elements.display_name.value = user.display_name || "";
  editForm.elements.role.value = user.role || "clerk";
  editForm.elements.active.checked = Number(user.active) === 1;

  renderPermissionEditor(user);

  const owners = getOwnersCount();
  const isSelf = state.me && Number(state.me.id) === Number(user.id);
  const roleSelect = document.getElementById("edit-role");
  const activeToggle = document.getElementById("edit-active");
  const deleteBtn = document.getElementById("delete-user-btn");

  const isLastOwner = user.role === "owner" && owners <= 1;
  roleSelect.disabled = isLastOwner && isSelf;
  activeToggle.disabled = isLastOwner && isSelf;
  deleteBtn.disabled = isSelf;

  if (user.role === "owner") {
    setNotice("Owner accounts always retain full permissions.");
  }
}

async function loadMe() {
  const data = await api("/api/me", { method: "GET", headers: { "Content-Type": "application/json" } });
  state.me = data && data.user ? data.user : null;
}

async function loadUsers() {
  const users = await api("/api/users", { method: "GET", headers: { "Content-Type": "application/json" } });
  state.users = Array.isArray(users) ? users : [];

  if (state.selectedId && !getSelectedUser()) {
    state.selectedId = null;
  }

  renderMetrics();
  renderTable();
  renderEditor();
}

function attachTableHandlers() {
  const tbody = document.getElementById("users-table");
  tbody.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;

    const id = Number(btn.dataset.id);
    const action = btn.dataset.action;

    try {
      if (action === "select") {
        state.selectedId = id;
        renderTable();
        renderEditor();
        setNotice("User selected.");
        return;
      }

      if (action === "toggle-active") {
        const user = state.users.find(u => Number(u.id) === id);
        if (!user) return;
        const nextActive = Number(user.active) === 1 ? 0 : 1;
        await api(`/api/users/${id}/active`, {
          method: "PUT",
          body: JSON.stringify({ active: nextActive })
        });
        setNotice(`User ${nextActive ? "enabled" : "disabled"}.`, "success");
        await loadUsers();
        return;
      }

      if (action === "delete") {
        const user = state.users.find(u => Number(u.id) === id);
        if (!user) return;
        const ok = confirm(`Delete user \"${user.username}\"? This cannot be undone.`);
        if (!ok) return;

        await api(`/api/users/${id}`, { method: "DELETE" });
        if (Number(state.selectedId) === id) state.selectedId = null;
        setNotice("User deleted.", "success");
        await loadUsers();
      }
    } catch (err) {
      setNotice(err.message || "Action failed.", "error");
    }
  });
}

function attachCreateForm() {
  const form = document.getElementById("create-form");
  const clearBtn = document.getElementById("clear-create");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = form.username.value.trim();
    const display_name = form.display_name.value.trim();
    const role = form.role.value;
    const password = form.password.value;
    const password2 = form.password2.value;
    const active = form.active.checked ? 1 : 0;

    if (!username) {
      setNotice("Username is required.", "error");
      return;
    }
    if (password.length < 8) {
      setNotice("Password must be at least 8 characters.", "error");
      return;
    }
    if (password !== password2) {
      setNotice("Password confirmation does not match.", "error");
      return;
    }

    try {
      await api("/api/users", {
        method: "POST",
        body: JSON.stringify({ username, display_name, role, password, active })
      });
      form.reset();
      form.active.checked = true;
      setNotice("User created.", "success");
      await loadUsers();
    } catch (err) {
      setNotice(err.message || "Create failed.", "error");
    }
  });

  clearBtn.addEventListener("click", () => {
    form.reset();
    form.active.checked = true;
    setNotice("");
  });
}

function collectPermissionPayload() {
  const payload = {};
  for (const p of PERMISSIONS) {
    const input = document.querySelector(`#perm-grid input[data-perm="${p.key}"]`);
    payload[p.key] = input && input.checked ? 1 : 0;
  }
  return payload;
}

function attachEditForms() {
  const editForm = document.getElementById("edit-form");
  const pwForm = document.getElementById("password-form");
  const resetPwBtn = document.getElementById("reset-password-btn");
  const cancelPwBtn = document.getElementById("cancel-password");
  const cancelEditBtn = document.getElementById("cancel-edit");
  const clearSelectionBtn = document.getElementById("new-selection");
  const deleteBtn = document.getElementById("delete-user-btn");

  editForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = Number(editForm.elements.id.value);
    const role = editForm.elements.role.value;
    const username = editForm.elements.username.value.trim();
    const display_name = editForm.elements.display_name.value.trim();
    const active = editForm.elements.active.checked ? 1 : 0;

    if (!id) {
      setNotice("No user selected.", "error");
      return;
    }
    if (!username) {
      setNotice("Username is required.", "error");
      return;
    }

    try {
      await api(`/api/users/${id}`, {
        method: "PUT",
        body: JSON.stringify({ username, display_name, role, active })
      });

      await api(`/api/users/${id}/permissions`, {
        method: "PUT",
        body: JSON.stringify(collectPermissionPayload())
      });

      setNotice("User profile and permissions saved.", "success");
      await loadUsers();
    } catch (err) {
      setNotice(err.message || "Save failed.", "error");
    }
  });

  resetPwBtn.addEventListener("click", () => {
    pwForm.style.display = pwForm.style.display === "none" ? "block" : "none";
    if (pwForm.style.display === "none") {
      pwForm.reset();
    }
  });

  cancelPwBtn.addEventListener("click", () => {
    pwForm.reset();
    pwForm.style.display = "none";
  });

  pwForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const user = getSelectedUser();
    if (!user) {
      setNotice("Select a user first.", "error");
      return;
    }

    const pw1 = pwForm.pw1.value;
    const pw2 = pwForm.pw2.value;

    if (pw1.length < 8) {
      setNotice("Password must be at least 8 characters.", "error");
      return;
    }
    if (pw1 !== pw2) {
      setNotice("Password confirmation does not match.", "error");
      return;
    }

    try {
      await api(`/api/users/${user.id}/password`, {
        method: "PUT",
        body: JSON.stringify({ password: pw1 })
      });
      pwForm.reset();
      pwForm.style.display = "none";
      setNotice("Password updated.", "success");
    } catch (err) {
      setNotice(err.message || "Password update failed.", "error");
    }
  });

  deleteBtn.addEventListener("click", async () => {
    const user = getSelectedUser();
    if (!user) {
      setNotice("Select a user first.", "error");
      return;
    }
    if (state.me && Number(state.me.id) === Number(user.id)) {
      setNotice("You cannot delete your own signed-in account.", "error");
      return;
    }

    const ok = confirm(`Delete user \"${user.username}\"? This cannot be undone.`);
    if (!ok) return;

    try {
      await api(`/api/users/${user.id}`, { method: "DELETE" });
      state.selectedId = null;
      setNotice("User deleted.", "success");
      await loadUsers();
    } catch (err) {
      setNotice(err.message || "Delete failed.", "error");
    }
  });

  clearSelectionBtn.addEventListener("click", () => {
    state.selectedId = null;
    renderTable();
    renderEditor();
    setNotice("Selection cleared.");
  });

  cancelEditBtn.addEventListener("click", () => {
    state.selectedId = null;
    renderTable();
    renderEditor();
    setNotice("Edit canceled.");
  });
}

function attachHeaderHandlers() {
  document.getElementById("back-btn").addEventListener("click", () => {
    window.location.href = `index.html?sid=${encodeURIComponent(sid() || "")}`;
  });
  document.getElementById("refresh-btn").addEventListener("click", async () => {
    try {
      await loadUsers();
      setNotice("User list refreshed.", "success");
    } catch (err) {
      setNotice(err.message || "Refresh failed.", "error");
    }
  });

  const runFilter = () => {
    renderTable();
  };
  document.getElementById("search-input").addEventListener("input", runFilter);
  document.getElementById("role-filter").addEventListener("change", runFilter);
}

async function init() {
  if (!sid()) {
    backToLogin();
    return;
  }

  try {
    await loadMe();
    await loadUsers();
  } catch (err) {
    if (err && err.status === 403) {
      document.getElementById("users-table").innerHTML = "<tr><td colspan=\"8\" class=\"muted\">Owner role is required to manage users.</td></tr>";
      setNotice("Owner access required.", "error");
      return;
    }
    setNotice(err.message || "Unable to load users.", "error");
    return;
  }

  attachTableHandlers();
  attachCreateForm();
  attachEditForms();
  attachHeaderHandlers();
}

document.addEventListener("DOMContentLoaded", init);
