const API_BASE = "http://127.0.0.1:5175";

function getAuthHeaders() {
  const sid = localStorage.getItem("rc_session_id") || "";
  return sid ? { "rc_session_id": sid } : {};
}

const els = {
  list: document.getElementById("custList"),
  count: document.getElementById("custCount"),
  search: document.getElementById("custSearch"),
  typeFilter: document.getElementById("custTypeFilter"),
  taxFilter: document.getElementById("custTaxFilter"),
  activeFilter: document.getElementById("custActiveFilter"),
  btnNew: document.getElementById("btnNew"),
  btnSave: document.getElementById("btnSave"),
  btnToggleActive: document.getElementById("btnToggleActive"),
  backBtn: document.getElementById("back-btn"),
  btnFindDupes: document.getElementById("btnFindDupes"),
  btnMergeCustomers: document.getElementById("btnMergeCustomers"),
  btnExportEmails: document.getElementById("btnExportEmails"),
  mergeSourceId: document.getElementById("mergeSourceId"),
  mergeTargetId: document.getElementById("mergeTargetId"),
  dupeList: document.getElementById("dupeList"),

  id: document.getElementById("custId"),
  type: document.getElementById("custType"),
  name: document.getElementById("custName"),
  phone: document.getElementById("custPhone"),
  phone2: document.getElementById("custPhone2"),
  phone3: document.getElementById("custPhone3"),
  email: document.getElementById("custEmail"),
  email2: document.getElementById("custEmail2"),
  email3: document.getElementById("custEmail3"),
  ein: document.getElementById("custEin"),
  taxExempt: document.getElementById("custTaxExempt"),
  taxExemptExpires: document.getElementById("custTaxExemptExpires"),
  tags: document.getElementById("custTags"),
  flagged: document.getElementById("custFlagged"),
  flagReason: document.getElementById("custFlagReason"),
  storeCredit: document.getElementById("custStoreCredit"),
  creditAmount: document.getElementById("custCreditAmount"),
  creditReason: document.getElementById("custCreditReason"),
  btnApplyCredit: document.getElementById("btnApplyCredit"),
  btnAddNote: document.getElementById("btnAddNote"),
  address1: document.getElementById("custAddress1"),
  address2: document.getElementById("custAddress2"),
  city: document.getElementById("custCity"),
  state: document.getElementById("custState"),
  zip: document.getElementById("custZip"),
  notes: document.getElementById("custNotes"),

  statusTag: document.getElementById("custStatusTag"),
  typeTag: document.getElementById("custTypeTag"),
  taxTag: document.getElementById("custTaxTag"),
  alerts: document.getElementById("custAlerts"),
  totalSpend: document.getElementById("custTotalSpend"),
  txnCount: document.getElementById("custTxnCount"),
  lastVisit: document.getElementById("custLastVisit"),
  history: document.getElementById("custHistory"),
  timeline: document.getElementById("custTimeline")
};

let customers = [];
let selectedId = null;

function apiFetch(path, opts = {}) {
  const headers = { ...getAuthHeaders(), ...(opts.headers || {}) };
  return fetch(API_BASE + path, { ...opts, headers });
}

function formatPhone(v) {
  return (v || "").trim();
}

function renderList() {
  if (!els.list) return;
  els.list.innerHTML = "";
  if (!customers.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.style.padding = "10px";
    empty.textContent = "No customers yet.";
    els.list.appendChild(empty);
  } else {
    customers.forEach((c) => {
      const row = document.createElement("div");
      row.className = "list-row" + (c.id === selectedId ? " active" : "");
      row.innerHTML = `
        <div>
          <div><strong>${c.name || "(no name)"}</strong></div>
          <div class="muted">${c.email || c.phone || ""}</div>
        </div>
        <div>${c.type || "regular"}</div>
        <div>${c.tax_exempt ? '<span class="pill good">Exempt</span>' : '<span class="pill">Standard</span>'}</div>
        <div>${c.active ? '<span class="pill good">Active</span>' : '<span class="pill warn">Inactive</span>'}</div>
      `;
      row.addEventListener("click", () => selectCustomer(c.id));
      els.list.appendChild(row);
    });
  }
  if (els.count) {
    els.count.textContent = `${customers.length} customer${customers.length === 1 ? "" : "s"}`;
  }
}

function applyTags(cust) {
  if (!cust) {
    els.statusTag.textContent = "New";
    els.typeTag.textContent = "Regular";
    els.taxTag.textContent = "Tax: Standard";
    return;
  }
  els.statusTag.textContent = cust.active ? "Active" : "Inactive";
  els.typeTag.textContent = cust.type === "business" ? "Business" : "Regular";
  els.taxTag.textContent = cust.tax_exempt ? "Tax: Exempt" : "Tax: Standard";
}

function clearForm() {
  selectedId = null;
  els.id.value = "";
  els.type.value = "regular";
  els.name.value = "";
  els.phone.value = "";
  els.phone2.value = "";
  els.phone3.value = "";
  els.email.value = "";
  els.email2.value = "";
  els.email3.value = "";
  els.ein.value = "";
  els.taxExempt.checked = false;
  els.taxExemptExpires.value = "";
  els.tags.value = "";
  els.flagged.checked = false;
  els.flagReason.value = "";
  els.address1.value = "";
  els.address2.value = "";
  els.city.value = "";
  els.state.value = "";
  els.zip.value = "";
  els.notes.value = "";
  if (els.btnToggleActive) {
    els.btnToggleActive.textContent = "Deactivate";
    els.btnToggleActive.disabled = true;
  }
  applyTags(null);
  if (els.totalSpend) els.totalSpend.textContent = "$0.00";
  if (els.txnCount) els.txnCount.textContent = "0";
  if (els.lastVisit) els.lastVisit.textContent = "--";
  if (els.storeCredit) els.storeCredit.textContent = "$0.00";
  if (els.creditAmount) els.creditAmount.value = "";
  if (els.creditReason) els.creditReason.value = "";
  if (els.alerts) {
    els.alerts.style.display = "none";
    els.alerts.innerHTML = "";
  }
  if (els.history) {
    els.history.innerHTML = '<div class="muted" style="padding:10px;">No history yet.</div>';
  }
  if (els.timeline) {
    els.timeline.innerHTML = '<div class="muted" style="padding:10px;">No activity yet.</div>';
  }
  if (els.dupeList) {
    els.dupeList.innerHTML = '<div class="muted" style="padding:10px;">No duplicates loaded.</div>';
  }
  syncEinVisibility();
}

function populateForm(c) {
  selectedId = c.id;
  els.id.value = c.id || "";
  els.type.value = c.type || "regular";
  els.name.value = c.name || "";
  els.phone.value = c.phone || "";
  els.phone2.value = c.phone2 || "";
  els.phone3.value = c.phone3 || "";
  els.email.value = c.email || "";
  els.email2.value = c.email2 || "";
  els.email3.value = c.email3 || "";
  els.ein.value = c.ein || "";
  els.taxExempt.checked = !!c.tax_exempt;
  els.taxExemptExpires.value = (c.tax_exempt_expires_at || "").split("T")[0];
  els.tags.value = c.tags || "";
  els.flagged.checked = !!c.flagged;
  els.flagReason.value = c.flag_reason || "";
  els.address1.value = c.address1 || "";
  els.address2.value = c.address2 || "";
  els.city.value = c.city || "";
  els.state.value = c.state || "";
  els.zip.value = c.zip || "";
  els.notes.value = c.notes || "";
  syncEinVisibility();
  if (els.btnToggleActive) {
    els.btnToggleActive.textContent = c.active ? "Deactivate" : "Activate";
    els.btnToggleActive.disabled = false;
  }
  applyTags(c);
}

function buildPayload() {
  return {
    type: els.type.value || "regular",
    name: (els.name.value || "").trim(),
    phone: formatPhone(els.phone.value),
    phone2: formatPhone(els.phone2.value),
    phone3: formatPhone(els.phone3.value),
    email: (els.email.value || "").trim(),
    email2: (els.email2.value || "").trim(),
    email3: (els.email3.value || "").trim(),
    ein: (els.ein.value || "").trim(),
    tax_exempt: els.taxExempt.checked ? 1 : 0,
    tax_exempt_expires_at: els.taxExemptExpires.value || "",
    tags: (els.tags.value || "").trim(),
    flagged: els.flagged.checked ? 1 : 0,
    flag_reason: (els.flagReason.value || "").trim(),
    store_credit_cents: parseInt(els.storeCredit?.dataset?.cents || "0", 10) || 0,
    address1: (els.address1.value || "").trim(),
    address2: (els.address2.value || "").trim(),
    city: (els.city.value || "").trim(),
    state: (els.state.value || "").trim(),
    zip: (els.zip.value || "").trim(),
    notes: (els.notes.value || "").trim()
  };
}

async function loadCustomers() {
  const params = new URLSearchParams();
  if (els.search.value) params.set("search", els.search.value.trim());
  if (els.typeFilter.value) params.set("type", els.typeFilter.value);
  if (els.taxFilter.value) params.set("tax", els.taxFilter.value);
  if (els.activeFilter.value) params.set("active", els.activeFilter.value);

  const res = await apiFetch(`/api/customers?${params.toString()}`);
  if (!res.ok) {
    console.warn("Failed to load customers");
    return;
  }
  const data = await res.json();
  customers = Array.isArray(data.rows) ? data.rows : [];
  renderList();
}

async function selectCustomer(id) {
  const res = await apiFetch(`/api/customers/${encodeURIComponent(id)}`);
  if (!res.ok) return;
  const data = await res.json();
  if (!data || !data.customer) return;
  populateForm(data.customer);
  renderHistory(data.summary, data.history, data.timeline, data.alerts, data.customer);
  renderList();
}

function formatMoney(value) {
  const n = Number.isFinite(value) ? value : 0;
  return "$" + n.toFixed(2);
}

function renderHistory(summary, history, timeline, alerts, customer) {
  if (els.totalSpend) els.totalSpend.textContent = formatMoney(Number(summary?.total_spend || 0));
  if (els.txnCount) els.txnCount.textContent = String(Number(summary?.txn_count || 0));
  if (els.lastVisit) els.lastVisit.textContent = summary?.last_visit ? String(summary.last_visit).split("T")[0] : "--";
  if (els.storeCredit) {
    const cents = Number(customer?.store_credit_cents || 0);
    els.storeCredit.textContent = formatMoney(cents / 100);
    els.storeCredit.dataset.cents = String(cents);
  }
  if (els.alerts) {
    const rows = Array.isArray(alerts) ? alerts : [];
    if (!rows.length) {
      els.alerts.style.display = "none";
      els.alerts.innerHTML = "";
    } else {
      els.alerts.style.display = "flex";
      els.alerts.innerHTML = rows.map((a) => `<div>• ${a.message}</div>`).join("");
    }
  }

  if (els.timeline) {
    const rows = Array.isArray(timeline) ? timeline : [];
    if (!rows.length) {
      els.timeline.innerHTML = '<div class="muted" style="padding:10px;">No activity yet.</div>';
    } else {
      els.timeline.innerHTML = rows.slice(0, 200).map((t) => {
        const date = (t.created_at || "").split("T")[0];
        const amt = (typeof t.amount === "number") ? formatMoney(t.amount) : "";
        return `
          <div class="timeline-row">
            <div class="timeline-kind">${t.kind || "event"}</div>
            <div>${t.title || ""}</div>
            <div style="text-align:right;">${date} ${amt}</div>
          </div>
        `;
      }).join("");
    }
  }

  if (!els.history) return;
  const rows = Array.isArray(history) ? history : [];
  if (!rows.length) {
    els.history.innerHTML = '<div class="muted" style="padding:10px;">No history yet.</div>';
    return;
  }

  const html = rows.map((r) => {
    const date = (r.created_at || "").split("T")[0];
    const title = r.title || r.sku || "Item";
    const qty = Number(r.qty || 0);
    const total = formatMoney(Number(r.line_total || 0));
    return `
      <div class="list-row">
        <div><strong>${title}</strong><div class="muted">${r.sku || ""}</div></div>
        <div>${date}</div>
        <div>${qty}</div>
        <div>${total}</div>
      </div>
    `;
  }).join("");
  els.history.innerHTML = html;
}

async function addNote() {
  if (!selectedId) return;
  const note = (els.notes.value || "").trim();
  if (!note) return;
  const res = await apiFetch(`/api/customers/${encodeURIComponent(selectedId)}/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note })
  });
  if (!res.ok) {
    alert("Failed to add note.");
    return;
  }
  els.notes.value = "";
  await selectCustomer(selectedId);
}

async function applyCreditAdjustment() {
  if (!selectedId) return;
  const raw = parseFloat(els.creditAmount.value || "0");
  if (!raw || !Number.isFinite(raw)) return;
  const cents = Math.round(raw * 100);
  const reason = (els.creditReason.value || "").trim();
  const res = await apiFetch(`/api/customers/${encodeURIComponent(selectedId)}/adjustments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amount_cents: cents, reason })
  });
  if (!res.ok) {
    alert("Failed to apply adjustment.");
    return;
  }
  els.creditAmount.value = "";
  els.creditReason.value = "";
  await selectCustomer(selectedId);
}

async function loadDuplicates() {
  if (!els.dupeList) return;
  const res = await apiFetch(`/api/customers/duplicates`);
  if (!res.ok) {
    els.dupeList.innerHTML = '<div class="muted" style="padding:10px;">Failed to load duplicates.</div>';
    return;
  }
  const data = await res.json();
  const rows = Array.isArray(data.rows) ? data.rows : [];
  if (!rows.length) {
    els.dupeList.innerHTML = '<div class="muted" style="padding:10px;">No duplicates found.</div>';
    return;
  }
  const html = rows.map((r) => {
    const items = (r.items || []).map((c) => {
      const contact = c.phone || c.email || c.phone2 || c.email2 || "";
      return `<div style="padding:4px 0;">#${c.id} • ${c.name || ""} • ${contact}</div>`;
    }).join("");
    return `
      <div style="padding:8px 10px; border-bottom:1px solid #131a2a;">
        <div><strong>${r.key}</strong> (${r.count})</div>
        <div class="muted">${items}</div>
      </div>
    `;
  }).join("");
  els.dupeList.innerHTML = html;
}

async function mergeCustomers() {
  const source_id = Number(els.mergeSourceId?.value || 0);
  const target_id = Number(els.mergeTargetId?.value || 0);
  if (!source_id || !target_id || source_id === target_id) {
    alert("Enter two different customer IDs.");
    return;
  }
  const res = await apiFetch(`/api/customers/merge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_id, target_id })
  });
  if (!res.ok) {
    alert("Merge failed.");
    return;
  }
  els.mergeSourceId.value = "";
  els.mergeTargetId.value = "";
  await loadDuplicates();
  await loadCustomers();
}

async function saveCustomer() {
  const payload = buildPayload();
  if (!payload.name) {
    alert("Name is required.");
    return;
  }

  if (selectedId) {
    const res = await apiFetch(`/api/customers/${encodeURIComponent(selectedId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      alert("Failed to update customer.");
      return;
    }
  } else {
    const res = await apiFetch(`/api/customers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      alert("Failed to create customer.");
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (data && data.id) selectedId = data.id;
  }
  await loadCustomers();
  if (selectedId) {
    await selectCustomer(selectedId);
  }
}

async function toggleActive() {
  if (!selectedId) return;
  const current = customers.find((c) => c.id === selectedId);
  const next = current && current.active ? 0 : 1;
  const res = await apiFetch(`/api/customers/${encodeURIComponent(selectedId)}/active`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ active: next })
  });
  if (!res.ok) {
    alert("Failed to update status.");
    return;
  }
  await loadCustomers();
  await selectCustomer(selectedId);
}

function getDefaultExportColumns() {
  return ["name", "type", "email", "phone", "address1", "city", "state", "zip", "tags", "active"];
}

function loadExportColumns() {
  try {
    const raw = localStorage.getItem("customersExportColumns");
    const list = raw ? JSON.parse(raw) : null;
    if (Array.isArray(list) && list.length) return list;
  } catch {}
  return getDefaultExportColumns();
}

function mapExportValue(c, col) {
  switch (col) {
    case "name": return c.name || "";
    case "type": return c.type || "";
    case "email": return c.email || "";
    case "email2": return c.email2 || "";
    case "email3": return c.email3 || "";
    case "phone": return c.phone || "";
    case "phone2": return c.phone2 || "";
    case "phone3": return c.phone3 || "";
    case "address1": return c.address1 || "";
    case "address2": return c.address2 || "";
    case "city": return c.city || "";
    case "state": return c.state || "";
    case "zip": return c.zip || "";
    case "ein": return c.ein || "";
    case "tags": return c.tags || "";
    case "tax_exempt": return c.tax_exempt ? "yes" : "no";
    case "store_credit_cents":
      return (Number(c.store_credit_cents || 0) / 100).toFixed(2);
    case "active": return c.active ? "active" : "inactive";
    case "notes": return c.notes || "";
    default: return "";
  }
}

function formatCsvValue(v) {
  const s = String(v ?? "");
  if (s.includes('"') || s.includes(",") || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

async function exportEmailsCsv() {
  const params = new URLSearchParams();
  if (els.search.value) params.set("search", els.search.value.trim());
  if (els.typeFilter.value) params.set("type", els.typeFilter.value);
  if (els.taxFilter.value) params.set("tax", els.taxFilter.value);
  if (els.activeFilter.value) params.set("active", els.activeFilter.value);
  params.set("limit", "5000");
  const res = await apiFetch(`/api/customers?${params.toString()}`);
  if (!res.ok) {
    alert("Export failed.");
    return;
  }
  const data = await res.json().catch(() => ({}));
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const cols = loadExportColumns();
  const header = cols.map((c) => c.toUpperCase());
  const lines = [header.map(formatCsvValue).join(",")];
  rows.forEach((c) => {
    const row = cols.map((col) => mapExportValue(c, col));
    lines.push(row.map(formatCsvValue).join(","));
  });
  const csv = lines.join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `customers-emails-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function wireEvents() {
  if (els.backBtn) els.backBtn.addEventListener("click", () => { window.location.href = "index.html"; });
  if (els.btnNew) els.btnNew.addEventListener("click", clearForm);
  if (els.btnSave) els.btnSave.addEventListener("click", saveCustomer);
  if (els.btnToggleActive) els.btnToggleActive.addEventListener("click", toggleActive);
  if (els.btnAddNote) els.btnAddNote.addEventListener("click", addNote);
  if (els.btnApplyCredit) els.btnApplyCredit.addEventListener("click", applyCreditAdjustment);
  if (els.btnFindDupes) els.btnFindDupes.addEventListener("click", loadDuplicates);
  if (els.btnMergeCustomers) els.btnMergeCustomers.addEventListener("click", mergeCustomers);
  if (els.btnExportEmails) els.btnExportEmails.addEventListener("click", exportEmailsCsv);

  const refresh = () => loadCustomers();
  [els.search, els.typeFilter, els.taxFilter, els.activeFilter].forEach((el) => {
    if (!el) return;
    el.addEventListener("input", refresh);
    el.addEventListener("change", refresh);
  });

  if (els.type) {
    els.type.addEventListener("change", () => {
      const isBiz = els.type.value === "business";
      if (!isBiz) els.ein.value = "";
      syncEinVisibility();
    });
  }
}

function syncEinVisibility() {
  if (!els.ein || !els.type) return;
  const isBiz = els.type.value === "business";
  els.ein.style.display = isBiz ? "block" : "none";
}

document.addEventListener("DOMContentLoaded", () => {
  clearForm();
  wireEvents();
  loadCustomers();
});
