(function () {
  const API_BASE = "http://127.0.0.1:5175";
  const SESSION_KEY = "rc_session_id";

  const els = {
    status: document.getElementById("status"),
    refresh: document.getElementById("btnRefresh"),
    summary: document.getElementById("summaryGrid"),
    lanes: document.getElementById("laneGrid"),
    eventsBody: document.getElementById("eventsBody"),
    eventMeta: document.getElementById("eventMeta"),
    riskList: document.getElementById("riskList"),
    riskMeta: document.getElementById("riskMeta"),
    movementBody: document.getElementById("movementBody"),
    movementMeta: document.getElementById("movementMeta"),
    stockBody: document.getElementById("stockBody"),
    stockMeta: document.getElementById("stockMeta"),
    laneItemsTitle: document.getElementById("laneItemsTitle"),
    laneItemsMeta: document.getElementById("laneItemsMeta"),
    laneItemsBody: document.getElementById("laneItemsBody"),
    locationFilter: document.getElementById("laneLocationFilter")
  };

  let latestLanes = [];
  let selectedLaneKey = "sellable";
  let inventoryLocations = [{ key: "store", label: "Store" }];

  function authHeaders() {
    const sid = localStorage.getItem(SESSION_KEY) || "";
    return sid ? { rc_session_id: sid } : {};
  }

  function setStatus(message, tone) {
    if (!els.status) return;
    els.status.textContent = message || "";
    els.status.className = "status" + (tone ? ` ${tone}` : "");
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function int(value) {
    const n = Number(value || 0);
    return Number.isFinite(n) ? Math.round(n).toLocaleString() : "0";
  }

  function money(value) {
    const n = Number(value || 0);
    return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
  }

  function dateShort(value) {
    if (!value) return "";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value).slice(0, 16);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function supportLabel(value) {
    if (value === "current") return "Current";
    if (value === "partial") return "Partial";
    return "Not tracked";
  }

  function supportClass(value) {
    if (value === "current") return "current";
    if (value === "partial") return "partial";
    return "not-tracked";
  }

  function itemName(row) {
    const title = row.title || row.name || "Untitled";
    const bits = [row.platform, row.condition].filter(Boolean);
    return bits.length ? `${title} (${bits.join(", ")})` : title;
  }

  async function fetchControl() {
    const res = await fetch(`${API_BASE}/api/inventory-control`, {
      cache: "no-store",
      headers: authHeaders()
    });
    if (res.status === 401) {
      window.location.href = "../../public/index.html";
      return null;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }

  async function apiJson(path, options = {}) {
    const headers = { ...authHeaders(), ...(options.headers || {}) };
    if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
    if (res.status === 401) {
      window.location.href = "../../public/index.html";
      return null;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.data = data;
      throw err;
    }
    return data;
  }

  function locationLabel(key) {
    const clean = String(key || "store").replace(/_/g, " ");
    return clean.replace(/\b\w/g, (char) => char.toUpperCase());
  }

  function normalizeLocations(raw) {
    const input = Array.isArray(raw) ? raw : [];
    const seen = new Set();
    const list = [];
    const add = (entry) => {
      const key = String(entry?.key || entry?.value || entry || "").trim() || "store";
      if (seen.has(key)) return;
      seen.add(key);
      list.push({ key, label: String(entry?.label || locationLabel(key)) });
    };
    add({ key: "store", label: "Store" });
    input.forEach(add);
    return list;
  }

  function syncLocationFilter(locations) {
    inventoryLocations = normalizeLocations(locations);
    if (!els.locationFilter) return;
    const current = els.locationFilter.value || "";
    els.locationFilter.innerHTML = `<option value="">All locations</option>` + inventoryLocations
      .map((loc) => `<option value="${escapeHtml(loc.key)}">${escapeHtml(loc.label)}</option>`)
      .join("");
    if (current && inventoryLocations.some((loc) => loc.key === current)) {
      els.locationFilter.value = current;
    }
  }

  function laneForKey(key) {
    return latestLanes.find((lane) => lane.key === key) || latestLanes[0] || null;
  }

  function statusForLane(lane) {
    if (!lane) return "sellable";
    return lane.key === "online" ? "sellable" : lane.key;
  }

  async function loadLaneItems() {
    const lane = laneForKey(selectedLaneKey);
    if (!lane || !els.laneItemsBody) return;
    const params = new URLSearchParams({ status: statusForLane(lane) });
    const location = els.locationFilter?.value || "";
    if (location) params.set("location", location);
    if (els.laneItemsTitle) els.laneItemsTitle.textContent = `${lane.label} Items`;
    if (els.laneItemsMeta) els.laneItemsMeta.textContent = "Loading items...";
    const data = await apiJson(`/api/inventory-control/items?${params.toString()}`);
    renderLaneItems(data, lane);
  }

  function renderSummary(data) {
    const s = data.summary || {};
    const metrics = [
      ["Sales Section", int(s.sellableUnits), `${int(s.sellableSkus ?? s.activeSkus)} sellable SKUs`],
      ["Online Qty", int(s.sellableUnits), "Sellable bucket only"],
      ["Draft Event Units", int(s.eventDraftUnits), "Not reserved yet"],
      ["Reserved/Holds", int(s.reservedUnits), "Layaway, reservation, online"],
      ["30d Waste", int(s.wasteUnits30d), `${int(s.deletedUnits30d)} deleted units`],
      ["Retail Value", money(s.retailValue), `${money(s.costValue)} cost basis`]
    ];
    els.summary.innerHTML = metrics.map(([label, value, sub]) => `
      <div class="metric">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
        <small>${escapeHtml(sub)}</small>
      </div>
    `).join("");
  }

  function renderLanes(data) {
    const lanes = Array.isArray(data.lanes) ? data.lanes : [];
    latestLanes = lanes;
    if (!laneForKey(selectedLaneKey)) selectedLaneKey = lanes[0]?.key || "sellable";
    els.lanes.innerHTML = lanes.map((lane) => {
      const units = lane.units === null || lane.units === undefined ? "-" : int(lane.units);
      const records = lane.records === null || lane.records === undefined ? "" : `${int(lane.records)} record${Number(lane.records) === 1 ? "" : "s"}`;
      const value = lane.value === null || lane.value === undefined ? "" : `Value ${money(lane.value)}`;
      return `
        <button class="lane ${lane.key === selectedLaneKey ? "active" : ""}" type="button" data-lane-key="${escapeHtml(lane.key)}">
          <div class="lane-head">
            <div class="lane-title">${escapeHtml(lane.label)}</div>
            <span class="pill ${supportClass(lane.support)}">${supportLabel(lane.support)}</span>
          </div>
          <div class="lane-num">${escapeHtml(units)}</div>
          <div class="lane-meta">${escapeHtml([records, value].filter(Boolean).join(" | "))}</div>
          <div class="lane-meta">${escapeHtml(lane.note || "")}</div>
        </button>
      `;
    }).join("");
  }

  function renderLaneItems(data, lane) {
    const rows = Array.isArray(data.rows) ? data.rows : [];
    const location = data.location ? ` at ${locationLabel(data.location)}` : "";
    if (els.laneItemsTitle) els.laneItemsTitle.textContent = `${lane?.label || "Bucket"} Items`;
    if (els.laneItemsMeta) {
      els.laneItemsMeta.textContent = `${int(rows.reduce((sum, row) => sum + Number(row.bucket_qty || 0), 0))} unit${rows.length === 1 ? "" : "s"} across ${int(rows.length)} SKU${rows.length === 1 ? "" : "s"}${location}`;
    }
    if (!rows.length) {
      els.laneItemsBody.innerHTML = `<tr><td colspan="6"><div class="empty">No items in this bucket${escapeHtml(location)}.</div></td></tr>`;
      return;
    }
    els.laneItemsBody.innerHTML = rows.map((row) => {
      const item = itemName(row);
      const search = encodeURIComponent(row.sku || row.title || "");
      return `
        <tr>
          <td class="mono">${escapeHtml(row.sku || "")}</td>
          <td><a class="row-link" href="inventory.html?search=${search}">${escapeHtml(item)}</a></td>
          <td>${escapeHtml(locationLabel(row.location || "store"))}</td>
          <td class="num">${int(row.bucket_qty)}</td>
          <td class="num">${money(row.price)}</td>
          <td class="num">${money(row.retail_value)}</td>
        </tr>
      `;
    }).join("");
  }

  function renderEvents(data) {
    const rows = (data.events || []).slice(0, 20);
    els.eventMeta.textContent = `${int(rows.length)} recent event record${rows.length === 1 ? "" : "s"}`;
    if (!rows.length) {
      els.eventsBody.innerHTML = `<tr><td colspan="6"><div class="empty">No live event records yet.</div></td></tr>`;
      return;
    }
    els.eventsBody.innerHTML = rows.map((row) => `
      <tr>
        <td>${escapeHtml(row.name)}</td>
        <td>${escapeHtml(row.channel)}</td>
        <td><span class="pill ${row.status === "draft" ? "partial" : "current"}">${escapeHtml(row.status)}</span></td>
        <td class="num">${int(row.units)}</td>
        <td class="num">${int(row.skuCount)}</td>
        <td>${escapeHtml(dateShort(row.updatedAt || row.finalizedAt))}</td>
      </tr>
    `).join("");
  }

  function countRiskRows(exceptions) {
    return Object.values(exceptions || {}).reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0), 0);
  }

  function renderRisks(data) {
    const ex = data.exceptions || {};
    const warningCount = countRiskRows(ex);
    const rows = [
      ["Negative quantity", "Rows with qty below zero", ex.negativeQty || []],
      ["Missing price", "Active stock that cannot be sold cleanly online", ex.missingPrice || []],
      ["Missing cost", "Active stock with weak profit reporting", ex.missingCost || []],
      ["Missing barcode", "Active stock without a saved manufacturer barcode", ex.missingBarcode || []],
      ["Duplicate UPC", "Manufacturer barcodes shared by more than one active row", ex.duplicateBarcodes || []]
    ];
    els.riskMeta.textContent = `${int(warningCount)} visible warning${warningCount === 1 ? "" : "s"}`;
    els.riskList.innerHTML = rows.map(([label, detail, list]) => `
      <div class="risk-row">
        <strong>${escapeHtml(label)}</strong>
        <span class="muted">${escapeHtml(detail)}</span>
        <span class="risk-count">${int(list.length)}</span>
      </div>
    `).join("");
  }

  function renderMovements(data) {
    const rows = data.recentMovements || [];
    els.movementMeta.textContent = `${int(rows.length)} latest`;
    if (!rows.length) {
      els.movementBody.innerHTML = `<tr><td colspan="6"><div class="empty">No movement history has been logged yet.</div></td></tr>`;
      return;
    }
    els.movementBody.innerHTML = rows.map((row) => {
      const delta = Number(row.qty_delta || 0);
      const deltaClass = delta < 0 ? "bad" : "good";
      return `
        <tr>
          <td>${escapeHtml(dateShort(row.created_at))}</td>
          <td class="mono">${escapeHtml(row.sku || "")}</td>
          <td>${escapeHtml(itemName(row))}</td>
          <td>${escapeHtml(row.reason || "")}${row.note ? `<div class="lane-meta">${escapeHtml(row.note)}</div>` : ""}</td>
          <td class="num ${deltaClass}">${delta > 0 ? "+" : ""}${int(delta)}</td>
          <td>${escapeHtml(row.username || "")}</td>
        </tr>
      `;
    }).join("");
  }

  function renderStock(data) {
    const rows = data.topStock || [];
    els.stockMeta.textContent = `${int(rows.length)} highest value rows`;
    if (!rows.length) {
      els.stockBody.innerHTML = `<tr><td colspan="5"><div class="empty">No active stock found.</div></td></tr>`;
      return;
    }
    els.stockBody.innerHTML = rows.map((row) => `
      <tr>
        <td class="mono">${escapeHtml(row.sku || "")}</td>
        <td>${escapeHtml(itemName(row))}</td>
        <td class="num">${int(row.qty)}</td>
        <td class="num">${money(row.price)}</td>
        <td class="num">${money(row.retail_value)}</td>
      </tr>
    `).join("");
  }

  async function refresh() {
    try {
      if (els.refresh) els.refresh.disabled = true;
      setStatus("Refreshing inventory control view...", "warn");
      const data = await fetchControl();
      if (!data) return;
      syncLocationFilter(data.locations);
      renderSummary(data);
      renderLanes(data);
      renderEvents(data);
      renderRisks(data);
      renderMovements(data);
      renderStock(data);
      await loadLaneItems();
      setStatus(`Updated ${dateShort(data.generatedAt)}`, "good");
    } catch (err) {
      console.error(err);
      setStatus(`Inventory Control failed: ${err.message || err}`, "bad");
    } finally {
      if (els.refresh) els.refresh.disabled = false;
    }
  }

  if (els.refresh) els.refresh.addEventListener("click", refresh);
  if (els.lanes) {
    els.lanes.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-lane-key]");
      if (!button) return;
      selectedLaneKey = button.getAttribute("data-lane-key") || "sellable";
      renderLanes({ lanes: latestLanes });
      try {
        await loadLaneItems();
      } catch (err) {
        console.error(err);
        if (els.laneItemsMeta) els.laneItemsMeta.textContent = "Could not load items for that bucket.";
      }
    });
  }
  if (els.locationFilter) {
    els.locationFilter.addEventListener("change", async () => {
      try {
        await loadLaneItems();
      } catch (err) {
        console.error(err);
        if (els.laneItemsMeta) els.laneItemsMeta.textContent = "Could not load items for that location.";
      }
    });
  }
  refresh();
})();
