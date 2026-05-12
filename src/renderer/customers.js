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
  taxExemptExpiresPresets: document.getElementById("custTaxExpiresPresets"),
  tags: document.getElementById("custTags"),
  flagged: document.getElementById("custFlagged"),
  flagReason: document.getElementById("custFlagReason"),
  storeCredit: document.getElementById("custStoreCredit"),
  loyaltyPoints: document.getElementById("custLoyaltyPoints"),
  loyaltyAdjustPoints: document.getElementById("custLoyaltyAdjustPoints"),
  loyaltyReason: document.getElementById("custLoyaltyReason"),
  loyaltyStatus: document.getElementById("custLoyaltyStatus"),
  loyaltyHistory: document.getElementById("custLoyaltyHistory"),
  btnApplyLoyalty: document.getElementById("btnApplyLoyalty"),
  btnRedeemLoyalty: document.getElementById("btnRedeemLoyalty"),
  creditAmount: document.getElementById("custCreditAmount"),
  creditReason: document.getElementById("custCreditReason"),
  btnApplyCredit: document.getElementById("btnApplyCredit"),
  btnAddNote: document.getElementById("btnAddNote"),
  wishTitle: document.getElementById("custWishTitle"),
  wishPlatform: document.getElementById("custWishPlatform"),
  wishMax: document.getElementById("custWishMax"),
  wishNotes: document.getElementById("custWishNotes"),
  btnAddWishlist: document.getElementById("btnAddWishlist"),
  wishlistList: document.getElementById("custWishlistList"),
  layawayList: document.getElementById("custLayawayList"),
  preorderList: document.getElementById("custPreorderList"),
  repairList: document.getElementById("custRepairList"),
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

async function apiJson(path, opts = {}) {
  const res = await apiFetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "request_failed");
  return data;
}

function formatPhone(v) {
  return (v || "").trim();
}

function pill(text, className = "") {
  const span = document.createElement("span");
  span.className = `pill ${className}`.trim();
  span.textContent = text;
  return span;
}

function mutedEmpty(text) {
  const div = document.createElement("div");
  div.className = "muted";
  div.style.padding = "10px";
  div.textContent = text;
  return div;
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
      const main = document.createElement("div");
      const nameWrap = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = c.name || "(no name)";
      nameWrap.appendChild(strong);
      const contact = document.createElement("div");
      contact.className = "muted";
      contact.textContent = c.email || c.phone || "";
      main.appendChild(nameWrap);
      main.appendChild(contact);
      const type = document.createElement("div");
      type.textContent = c.type || "regular";
      const tax = document.createElement("div");
      tax.appendChild(c.tax_exempt ? pill("Exempt", "good") : pill("Standard"));
      const active = document.createElement("div");
      active.appendChild(c.active ? pill("Active", "good") : pill("Inactive", "warn"));
      row.appendChild(main);
      row.appendChild(type);
      row.appendChild(tax);
      row.appendChild(active);
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
  if (els.loyaltyPoints) els.loyaltyPoints.textContent = "0";
  if (els.loyaltyAdjustPoints) els.loyaltyAdjustPoints.value = "";
  if (els.loyaltyReason) els.loyaltyReason.value = "";
  if (els.loyaltyStatus) els.loyaltyStatus.textContent = "1 point per sale dollar. 100 points redeems to $5 store credit.";
  if (els.creditAmount) els.creditAmount.value = "";
  if (els.creditReason) els.creditReason.value = "";
  if (els.wishTitle) els.wishTitle.value = "";
  if (els.wishPlatform) els.wishPlatform.value = "";
  if (els.wishMax) els.wishMax.value = "";
  if (els.wishNotes) els.wishNotes.value = "";
  if (els.alerts) {
    els.alerts.style.display = "none";
    els.alerts.replaceChildren();
  }
  if (els.loyaltyHistory) {
    els.loyaltyHistory.replaceChildren(mutedEmpty("No loyalty activity yet."));
  }
  if (els.wishlistList) {
    els.wishlistList.replaceChildren(mutedEmpty("Select a customer to manage wishlist items."));
  }
  if (els.layawayList) {
    els.layawayList.replaceChildren(mutedEmpty("No layaways loaded."));
  }
  if (els.preorderList) {
    els.preorderList.replaceChildren(mutedEmpty("No preorders loaded."));
  }
  if (els.repairList) {
    els.repairList.replaceChildren(mutedEmpty("No repairs loaded."));
  }
  if (els.history) {
    els.history.replaceChildren(mutedEmpty("No history yet."));
  }
  if (els.timeline) {
    els.timeline.replaceChildren(mutedEmpty("No activity yet."));
  }
  if (els.dupeList) {
    els.dupeList.replaceChildren(mutedEmpty("No duplicates loaded."));
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
  await loadCustomerWorkflows(data.customer.id);
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
  if (els.loyaltyPoints) {
    els.loyaltyPoints.textContent = String(Number(customer?.loyalty_points || 0));
  }
  if (els.alerts) {
    const rows = Array.isArray(alerts) ? alerts : [];
    els.alerts.replaceChildren();
    els.alerts.style.display = rows.length ? "flex" : "none";
    rows.forEach((a) => {
      const div = document.createElement("div");
      div.textContent = `- ${a.message || ""}`;
      els.alerts.appendChild(div);
    });
  }
  if (els.timeline) {
    const rows = Array.isArray(timeline) ? timeline : [];
    els.timeline.replaceChildren();
    if (!rows.length) {
      els.timeline.appendChild(mutedEmpty("No activity yet."));
    } else {
      rows.slice(0, 200).forEach((t) => {
        const row = document.createElement("div");
        row.className = "timeline-row";
        const kind = document.createElement("div");
        kind.className = "timeline-kind";
        kind.textContent = t.kind || "event";
        const title = document.createElement("div");
        title.textContent = t.title || "";
        const meta = document.createElement("div");
        meta.style.textAlign = "right";
        const date = (t.created_at || "").split("T")[0];
        const amt = (typeof t.amount === "number") ? formatMoney(t.amount) : "";
        meta.textContent = `${date} ${amt}`.trim();
        row.append(kind, title, meta);
        els.timeline.appendChild(row);
      });
    }
  }
  if (!els.history) return;
  const rows = Array.isArray(history) ? history : [];
  els.history.replaceChildren();
  if (!rows.length) {
    els.history.appendChild(mutedEmpty("No history yet."));
    return;
  }
  rows.forEach((r) => {
    const row = document.createElement("div");
    row.className = "list-row";
    const main = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = r.title || r.sku || "Item";
    const sku = document.createElement("div");
    sku.className = "muted";
    sku.textContent = r.sku || "";
    main.append(strong, sku);
    const date = document.createElement("div");
    date.textContent = (r.created_at || "").split("T")[0];
    const qty = document.createElement("div");
    qty.textContent = String(Number(r.qty || 0));
    const total = document.createElement("div");
    total.textContent = formatMoney(Number(r.line_total || 0));
    row.append(main, date, qty, total);
    els.history.appendChild(row);
  });
}

function miniMeta(parts) {
  return parts.filter(Boolean).join(" - ");
}

function setEmptyList(target, text) {
  if (!target) return;
  target.replaceChildren(mutedEmpty(text));
}

function appendMiniRow(target, { title, meta, status, actions = [] }) {
  const row = document.createElement("div");
  row.className = "mini-row";
  const left = document.createElement("div");
  const main = document.createElement("div");
  main.className = "mini-title";
  main.textContent = title || "Untitled";
  const sub = document.createElement("div");
  sub.className = "mini-meta";
  sub.textContent = meta || "";
  left.append(main, sub);
  const right = document.createElement("div");
  right.style.display = "flex";
  right.style.gap = "6px";
  right.style.alignItems = "center";
  right.style.justifyContent = "flex-end";
  if (status) right.appendChild(pill(status, ["active", "open", "ready", "fulfilled", "completed"].includes(String(status).toLowerCase()) ? "good" : ""));
  actions.forEach((action) => right.appendChild(action));
  row.append(left, right);
  target.appendChild(row);
}

function smallAction(label, dataset) {
  const btn = document.createElement("button");
  btn.className = "btn";
  btn.style.padding = "5px 7px";
  btn.style.fontSize = "11px";
  btn.textContent = label;
  Object.entries(dataset || {}).forEach(([key, value]) => {
    btn.dataset[key] = String(value);
  });
  return btn;
}

function renderWishlistRows(rows) {
  if (!els.wishlistList) return;
  els.wishlistList.replaceChildren();
  if (!rows.length) {
    setEmptyList(els.wishlistList, "No wishlist items for this customer.");
    return;
  }
  rows.forEach((w) => {
    const matchCount = Array.isArray(w.matches) ? w.matches.length : 0;
    const meta = miniMeta([
      w.platform || "Any platform",
      Number(w.max_price || 0) > 0 ? `Max ${formatMoney(Number(w.max_price || 0))}` : "",
      matchCount ? `${matchCount} inventory match${matchCount === 1 ? "" : "es"}` : "No match"
    ]);
    const actions = [];
    if (w.status === "active") {
      actions.push(smallAction("Fulfill", { wishFulfill: w.id }));
      actions.push(smallAction("Cancel", { wishCancel: w.id }));
    }
    appendMiniRow(els.wishlistList, { title: w.title, meta, status: w.status, actions });
  });
}

function renderLoyaltyHistory(rows) {
  if (!els.loyaltyHistory) return;
  els.loyaltyHistory.replaceChildren();
  if (!rows.length) {
    setEmptyList(els.loyaltyHistory, "No loyalty activity yet.");
    return;
  }
  rows.forEach((row) => {
    const points = Number(row.points_delta || 0);
    appendMiniRow(els.loyaltyHistory, {
      title: `${points > 0 ? "+" : ""}${points} points`,
      meta: miniMeta([(row.created_at || "").split("T")[0], row.reason || "", Number(row.amount || 0) ? formatMoney(Number(row.amount || 0)) : ""]),
      status: ""
    });
  });
}

function renderSimpleWorkflowList(target, rows, emptyText, mapper) {
  if (!target) return;
  target.replaceChildren();
  if (!rows.length) {
    setEmptyList(target, emptyText);
    return;
  }
  rows.forEach((row) => appendMiniRow(target, mapper(row)));
}

async function loadCustomerWorkflows(id) {
  if (!id) return;
  try {
    const data = await apiJson(`/api/customers/${encodeURIComponent(id)}/workflows`);
    renderWishlistRows(Array.isArray(data.wishlist) ? data.wishlist : []);
    renderLoyaltyHistory(Array.isArray(data.loyalty) ? data.loyalty : []);
    renderSimpleWorkflowList(els.layawayList, Array.isArray(data.layaways) ? data.layaways : [], "No layaways for this customer.", (l) => ({
      title: l.label || `Layaway #${l.id}`,
      meta: miniMeta([`Balance ${formatMoney(Number(l.balance || 0))}`, l.due_at ? `Due ${l.due_at}` : "No due date"]),
      status: l.status
    }));
    renderSimpleWorkflowList(els.preorderList, Array.isArray(data.preorders) ? data.preorders : [], "No preorders for this customer.", (p) => ({
      title: p.title,
      meta: miniMeta([p.platform || "Any platform", p.release_at ? `Release ${p.release_at}` : "TBD", Number(p.deposit || 0) ? `Deposit ${formatMoney(Number(p.deposit || 0))}` : ""]),
      status: p.status
    }));
    renderSimpleWorkflowList(els.repairList, Array.isArray(data.repairs) ? data.repairs : [], "No repairs for this customer.", (r) => ({
      title: `${r.ticket_no || "Repair"} - ${r.device || ""}`.trim(),
      meta: miniMeta([r.issue || "", Number(r.estimate || 0) ? `Estimate ${formatMoney(Number(r.estimate || 0))}` : "", r.due_at ? `Due ${r.due_at}` : ""]),
      status: r.status
    }));
  } catch (err) {
    console.warn("Failed to load customer workflow details", err);
    setEmptyList(els.wishlistList, "Customer workflow details failed to load.");
  }
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

async function applyLoyaltyAdjustment() {
  if (!selectedId) {
    alert("Select a customer first.");
    return;
  }
  const points = Number(els.loyaltyAdjustPoints?.value || 0);
  if (!Number.isFinite(points) || points === 0) return;
  try {
    await apiJson(`/api/customers/${encodeURIComponent(selectedId)}/loyalty/adjust`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points, reason: els.loyaltyReason?.value || "Manual loyalty adjustment" })
    });
    if (els.loyaltyAdjustPoints) els.loyaltyAdjustPoints.value = "";
    if (els.loyaltyReason) els.loyaltyReason.value = "";
    if (els.loyaltyStatus) els.loyaltyStatus.textContent = "Loyalty points updated.";
    await selectCustomer(selectedId);
  } catch (err) {
    alert("Loyalty update failed.");
  }
}

async function redeemLoyalty() {
  if (!selectedId) {
    alert("Select a customer first.");
    return;
  }
  try {
    await apiJson(`/api/customers/${encodeURIComponent(selectedId)}/loyalty/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: 100 })
    });
    if (els.loyaltyStatus) els.loyaltyStatus.textContent = "Redeemed 100 points to $5 store credit.";
    await selectCustomer(selectedId);
  } catch (err) {
    alert("This customer does not have enough points to redeem yet.");
  }
}

async function addWishlistItem() {
  if (!selectedId) {
    alert("Select a customer first.");
    return;
  }
  const title = (els.wishTitle?.value || "").trim();
  if (!title) {
    alert("Enter the item the customer wants.");
    return;
  }
  try {
    await apiJson("/api/wishlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer_id: selectedId,
        customer_name: els.name?.value || "",
        customer_phone: els.phone?.value || "",
        customer_email: els.email?.value || "",
        title,
        platform: els.wishPlatform?.value || "",
        max_price: Number(els.wishMax?.value || 0) || 0,
        notes: els.wishNotes?.value || ""
      })
    });
    if (els.wishTitle) els.wishTitle.value = "";
    if (els.wishPlatform) els.wishPlatform.value = "";
    if (els.wishMax) els.wishMax.value = "";
    if (els.wishNotes) els.wishNotes.value = "";
    await loadCustomerWorkflows(selectedId);
  } catch (err) {
    alert("Wishlist item could not be saved.");
  }
}

async function updateWishlistStatus(id, status) {
  if (!selectedId || !id) return;
  try {
    if (status === "cancelled") {
      await apiJson(`/api/wishlist/${encodeURIComponent(id)}`, { method: "DELETE" });
    } else {
      await apiJson(`/api/wishlist/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status })
      });
    }
    await loadCustomerWorkflows(selectedId);
  } catch (err) {
    alert("Wishlist status could not be updated.");
  }
}

async function loadDuplicates() {
  if (!els.dupeList) return;
  const res = await apiFetch(`/api/customers/duplicates`);
  if (!res.ok) {
    els.dupeList.replaceChildren(mutedEmpty("Failed to load duplicates."));
    return;
  }
  const data = await res.json();
  const rows = Array.isArray(data.rows) ? data.rows : [];
  if (!rows.length) {
    els.dupeList.replaceChildren(mutedEmpty("No duplicates found."));
    return;
  }
  els.dupeList.replaceChildren();
  rows.forEach((r) => {
    const wrap = document.createElement("div");
    wrap.style.padding = "8px 10px";
    wrap.style.borderBottom = "1px solid #131a2a";

    const title = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = r.key || "Duplicate group";
    title.append(strong, document.createTextNode(` (${Number(r.count || 0)})`));

    const items = document.createElement("div");
    items.className = "muted";
    (Array.isArray(r.items) ? r.items : []).forEach((c) => {
      const item = document.createElement("div");
      item.style.padding = "4px 0";
      const contact = c.phone || c.email || c.phone2 || c.email2 || "";
      item.textContent = `#${c.id} - ${c.name || ""} - ${contact}`;
      items.appendChild(item);
    });

    wrap.append(title, items);
    els.dupeList.appendChild(wrap);
  });
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
  if (els.btnApplyLoyalty) els.btnApplyLoyalty.addEventListener("click", applyLoyaltyAdjustment);
  if (els.btnRedeemLoyalty) els.btnRedeemLoyalty.addEventListener("click", redeemLoyalty);
  if (els.btnAddWishlist) els.btnAddWishlist.addEventListener("click", addWishlistItem);
  if (els.wishlistList) {
    els.wishlistList.addEventListener("click", (event) => {
      const target = event.target.closest("button");
      if (!target) return;
      if (target.dataset.wishFulfill) updateWishlistStatus(target.dataset.wishFulfill, "fulfilled");
      if (target.dataset.wishCancel) updateWishlistStatus(target.dataset.wishCancel, "cancelled");
    });
  }
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

function installDatePresets() {
  const helper = window.VaultCoreDatePresets;
  if (!helper || !els.taxExemptExpiresPresets || !els.taxExemptExpires) return;
  const addYears = (years) => {
    const d = new Date();
    return new Date(d.getFullYear() + years, d.getMonth(), d.getDate());
  };
  helper.installSingleDatePresets({
    container: els.taxExemptExpiresPresets,
    input: els.taxExemptExpires,
    label: "Expires",
    presets: [
      { label: "+30 Days", get: () => helper.addDays(new Date(), 30) },
      { label: "+60 Days", get: () => helper.addDays(new Date(), 60) },
      { label: "+90 Days", get: () => helper.addDays(new Date(), 90) },
      { label: "+1 Year", get: () => addYears(1) }
    ]
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  clearForm();
  installDatePresets();
  wireEvents();
  await loadCustomers();
  const initialCustomerId = Number(new URLSearchParams(window.location.search).get("customer_id") || 0);
  if (initialCustomerId) await selectCustomer(initialCustomerId);
});
