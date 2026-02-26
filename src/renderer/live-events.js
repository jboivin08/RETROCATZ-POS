(() => {
  const API_BASE = 'http://127.0.0.1:5175';
  const API_ITEMS = API_BASE + '/api/items';

  // Auth header pattern (matches your inventory.html)
  function getAuthHeaders() {
    const sid = localStorage.getItem('rc_session_id') || '';
    return sid ? { 'rc_session_id': sid } : {};
  }

  const STORAGE_KEY = 'rcz:live_events:v1';

  // -------- DOM --------
  const $ = (id) => document.getElementById(id);

  const btnBack = $('btnBack');
  const appStatus = $('appStatus');

  // Views
  const viewLanding = $('viewLanding');
  const viewEditor = $('viewEditor');

  // Landing controls
  const newEventName = $('newEventName');
  const newEventChannel = $('newEventChannel');
  const btnCreateEvent = $('btnCreateEvent');
  const eventsTbody = $('eventsTbody');
  const eventCountPill = $('eventCountPill');
  const filterStatus = $('filterStatus');
  const filterText = $('filterText');
  const btnClearAll = $('btnClearAll');
  const btnExportEvents = $('btnExportEvents');

  // Editor controls
  const editorStatusPill = $('editorStatusPill');
  const editorName = $('editorName');
  const editorMeta = $('editorMeta');

  // Editor channel dropdown (optional)
  const editorChannel = $('editorChannel');

  const btnEditorBack = $('btnEditorBack');
  const btnSaveDraft = $('btnSaveDraft');
  const btnFinalize = $('btnFinalize');
  const btnVoidSale = $('btnVoidSale');

  const smartSearch = $('smartSearch');
  const btnReloadInventory = $('btnReloadInventory');
  const searchHint = $('searchHint');
  const resultsBox = $('results');

  const linesBox = $('lines');
  const btnClearLines = $('btnClearLines');

  const sumLines = $('sumLines');
  const sumGross = $('sumGross');
  const sumCost = $('sumCost');
  const sumProfit = $('sumProfit');

  // Override input (optional)
  const overrideTotalSold = $('overrideTotalSold');

  // NEW HTML hook points (safe if missing)
  const overrideActions = $('overrideActions'); // where the 3 buttons should live (new HTML)
  const forcedAvgPill = $('forcedAvgPill');
  const forcedAvgText = $('forcedAvgText');
  const forcedLineCount = $('forcedLineCount');

  // Command Center (safe if missing)
  const ccItemsPerMin = $('ccItemsPerMin');
  const ccGrossPerHr = $('ccGrossPerHr');
  const ccAvgSold = $('ccAvgSold');
  const ccMargin = $('ccMargin');
  const btnCcFocusSearch = $('btnCcFocusSearch');
  const btnCcJumpLines = $('btnCcJumpLines');
  const btnCcMarkBundle = $('btnCcMarkBundle'); // placeholder
  const sessionNotes = $('sessionNotes');

  // Buttons will be created dynamically if not present in HTML
  let btnApplyBlanks = $('btnApplyBlanks');
  let btnApplyAuto = $('btnApplyAuto');
  let btnApplyForce = $('btnApplyForce');

  // -------- State --------
  let itemsCache = [];        // inventory items from API
  let itemsById = new Map();  // fast lookup
  let itemsBySku = new Map(); // fast lookup (lowercased sku)
  let events = [];            // persisted
  let currentEventId = null;  // in editor
  let searchResults = [];     // current results list
  let kpiTimer = null;

  // -------- Utils --------
  const nowISO = () => new Date().toISOString();
  const fmt$ = (n) => `$${(Number(n || 0)).toFixed(2)}`;
  const lc = (s) => String(s ?? '').toLowerCase().trim();

  function uid() {
    return 'ev_' + Math.random().toString(16).slice(2) + '_' + Date.now().toString(16);
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }

  function setStatus(text, kind = 'neutral') {
    if (!appStatus) return;
    appStatus.textContent = text;
    appStatus.className = 'pill';
    if (kind === 'ok') appStatus.style.borderColor = 'rgba(34,197,94,0.55)';
    else if (kind === 'warn') appStatus.style.borderColor = 'rgba(245,158,11,0.55)';
    else if (kind === 'bad') appStatus.style.borderColor = 'rgba(239,68,68,0.55)';
    else appStatus.style.borderColor = 'rgba(148,163,184,0.35)';
  }

  function loadEvents() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      events = Array.isArray(parsed) ? parsed : [];
    } catch {
      events = [];
    }
  }

  function saveEvents() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
  }

  function getEventById(id) {
    return events.find(e => e.id === id) || null;
  }

  function recalcEventTotals(ev) {
    const lines = Array.isArray(ev.lines) ? ev.lines : [];
    let gross = 0, cost = 0;
    for (const ln of lines) {
      const qty = Number(ln.qtySold || 0);
      const sell = Number(ln.sellPrice || 0);
      const c = Number(ln.cost || 0);
      gross += sell * qty;
      cost += c * qty;
    }
    return { gross, cost, profit: gross - cost, linesCount: lines.length };
  }

  function eventStatusPillHtml(status) {
    if (status === 'voided') return `<span class="pill voided">voided</span>`;
    if (status === 'finalized') return `<span class="pill final">finalized</span>`;
    return `<span class="pill draft">draft</span>`;
  }

  function isLocked(ev) {
    return !ev || ev.status === 'finalized' || ev.status === 'voided';
  }

  function niceDate(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString(); } catch { return String(iso); }
  }

  function toNumberSafe(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function rebuildItemIndexes() {
    itemsById = new Map();
    itemsBySku = new Map();
    for (const it of itemsCache) {
      const id = Number(it.id);
      if (Number.isFinite(id)) itemsById.set(id, it);
      const sku = lc(it.sku);
      if (sku) itemsBySku.set(sku, it);
    }
  }

  // -------- Inventory API --------
  async function loadInventory() {
    setStatus('Loading inventory…', 'warn');
    const res = await fetch(API_ITEMS, { cache: 'no-store', headers: { ...getAuthHeaders() } });
    if (!res.ok) throw new Error(`Inventory API failed: ${res.status}`);
    const data = await res.json();
    itemsCache = Array.isArray(data) ? data : (data.items || []);
    rebuildItemIndexes();
    setStatus(`Inventory loaded (${itemsCache.length} items)`, 'ok');
  }

  function findItemMatches(query) {
    const q = lc(query);
    if (!q) return [];

    const exactSku = itemsCache.find(it => lc(it.sku) === q);
    if (exactSku) return [exactSku];

    const out = [];
    for (const it of itemsCache) {
      const sku = lc(it.sku);
      const title = lc(it.title);
      if (sku.includes(q) || title.includes(q)) out.push(it);
      if (out.length >= 25) break;
    }

    out.sort((a,b) => {
      const as = lc(a.sku), bs = lc(b.sku);
      const at = lc(a.title), bt = lc(b.title);
      const aSkuStarts = as.startsWith(q) ? 1 : 0;
      const bSkuStarts = bs.startsWith(q) ? 1 : 0;
      if (aSkuStarts !== bSkuStarts) return bSkuStarts - aSkuStarts;

      const aTitleStarts = at.startsWith(q) ? 1 : 0;
      const bTitleStarts = bt.startsWith(q) ? 1 : 0;
      if (aTitleStarts !== bTitleStarts) return bTitleStarts - aTitleStarts;

      return at.localeCompare(bt);
    });

    return out;
  }

  // -------- Override input sync (NEVER overwrite while typing) --------
  function syncOverrideInputFromEvent(ev) {
    if (!overrideTotalSold || !ev) return;
    if (document.activeElement === overrideTotalSold) return; // user is typing, don’t fight them

    const v = ev.overrideTotalSold;
    overrideTotalSold.value = (v === null || v === undefined || v === '') ? '' : String(v);
  }

  function persistOverrideFromInput({ commitNumber } = { commitNumber: false }) {
    if (!overrideTotalSold) return;
    const ev = currentEventId ? getEventById(currentEventId) : null;
    if (isLocked(ev)) return;

    // Always store the raw string (so typing doesn’t get “fixed” mid-entry)
    ev.overrideTotalSoldRaw = String(overrideTotalSold.value ?? '');

    if (commitNumber) {
      const n = toNumberSafe(ev.overrideTotalSoldRaw, 0);
      ev.overrideTotalSold = (n > 0) ? Number(n.toFixed(2)) : '';
      ev.lastAppliedAvg = ev.lastAppliedAvg || '';
    }

    ev.updatedAt = nowISO();
    saveEvents();
  }

  // -------- Command Center / KPI --------
  function getTotalUnits(ev) {
    const lines = Array.isArray(ev.lines) ? ev.lines : [];
    let units = 0;
    for (const ln of lines) units += Math.max(1, Math.floor(Number(ln.qtySold || 1)));
    return units;
  }

  function setForcedPill(ev) {
    if (!forcedAvgPill || !forcedAvgText || !forcedLineCount) return;
    const avg = toNumberSafe(ev?.lastAppliedAvg, 0);
    const total = toNumberSafe(ev?.overrideTotalSold, 0);
    const lines = Array.isArray(ev?.lines) ? ev.lines : [];

    const show = (avg > 0) && (total > 0) && (lines.length > 0);
    if (!show) {
      forcedAvgPill.classList.add('hidden');
      return;
    }
    forcedAvgText.textContent = fmt$(avg);
    forcedLineCount.textContent = String(lines.length);
    forcedAvgPill.classList.remove('hidden');
  }

  function setCommandCenter(ev) {
    // safe no-ops if the new HTML isn't present
    if (!ev) return;

    const totals = recalcEventTotals(ev);
    const units = getTotalUnits(ev);

    // establish a start time if missing:
    // - prefer ev.startedAt (set when first line added)
    // - fallback to first line addedAt
    // - fallback to createdAt
    let startMs = 0;
    if (ev.startedAt) startMs = Date.parse(ev.startedAt) || 0;
    if (!startMs && Array.isArray(ev.lines) && ev.lines.length) startMs = Date.parse(ev.lines[ev.lines.length - 1]?.addedAt) || 0;
    if (!startMs && ev.createdAt) startMs = Date.parse(ev.createdAt) || 0;

    const nowMs = Date.now();
    const elapsedMin = Math.max(0.001, (nowMs - startMs) / 60000);
    const elapsedHr = elapsedMin / 60;

    const itemsPerMin = units / elapsedMin;
    const grossPerHr = totals.gross / elapsedHr;
    const avgSold = units > 0 ? (totals.gross / units) : 0;
    const margin = totals.gross > 0 ? (totals.profit / totals.gross) : 0;

    if (ccItemsPerMin) ccItemsPerMin.textContent = (units > 0 ? itemsPerMin.toFixed(2) : '—');
    if (ccGrossPerHr) ccGrossPerHr.textContent = (totals.gross > 0 ? fmt$(grossPerHr) : '—');
    if (ccAvgSold) ccAvgSold.textContent = (units > 0 ? fmt$(avgSold) : '—');
    if (ccMargin) ccMargin.textContent = (totals.gross > 0 ? `${(margin * 100).toFixed(1)}%` : '—');
  }

  function startKpiLoop() {
    stopKpiLoop();
    // light refresh while editor is open
    kpiTimer = setInterval(() => {
      if (!currentEventId) return;
      const ev = getEventById(currentEventId);
      if (!ev) return;
      setCommandCenter(ev);
      setForcedPill(ev);
    }, 750);
  }

  function stopKpiLoop() {
    if (kpiTimer) clearInterval(kpiTimer);
    kpiTimer = null;
  }

  // -------- View switching --------
  function showLanding() {
    stopKpiLoop();
    viewEditor.classList.add('hidden');
    viewLanding.classList.remove('hidden');
    currentEventId = null;
    renderEventsTable();
  }

  function showEditor(eventId) {
    const ev = getEventById(eventId);
    if (!ev) {
      alert('Event not found.');
      return;
    }
    currentEventId = eventId;

    viewLanding.classList.add('hidden');
    viewEditor.classList.remove('hidden');

    editorName.textContent = ev.name || '(untitled event)';
    editorMeta.textContent = `${ev.channel || 'other'} • created ${niceDate(ev.createdAt)} • updated ${niceDate(ev.updatedAt)}`;

    if (editorChannel) {
      editorChannel.value = ev.channel || 'other';
      editorChannel.disabled = isLocked(ev);
    }

    if (ev.status === 'voided') {
      editorStatusPill.className = 'pill voided';
      editorStatusPill.textContent = 'voided';
      btnFinalize.disabled = true;
      btnSaveDraft.disabled = true;
      smartSearch.disabled = true;
      btnClearLines.disabled = true;
      btnClearLines.classList.add('danger');
      if (btnVoidSale) btnVoidSale.style.display = 'none';
      searchHint.textContent = 'This event is voided (read-only).';
    } else if (ev.status === 'finalized') {
      editorStatusPill.className = 'pill final';
      editorStatusPill.textContent = 'finalized';
      btnFinalize.disabled = true;
      btnSaveDraft.disabled = true;
      smartSearch.disabled = true;
      btnClearLines.disabled = true;
      btnClearLines.classList.add('danger');
      if (btnVoidSale) btnVoidSale.style.display = ev.backendSaleId ? 'inline-block' : 'none';
      searchHint.textContent = 'This event is finalized (read-only).';
    } else {
      editorStatusPill.className = 'pill draft';
      editorStatusPill.textContent = 'draft';
      btnFinalize.disabled = false;
      btnSaveDraft.disabled = false;
      smartSearch.disabled = false;
      btnClearLines.disabled = false;
      if (btnVoidSale) btnVoidSale.style.display = 'none';
      searchHint.textContent = 'Type to search inventory…';
    }

    ensureAverageButtons();

    // Restore override value into the input (safe)
    // Prefer numeric overrideTotalSold; fall back to raw
    if (overrideTotalSold) {
      if (ev.overrideTotalSold !== undefined && ev.overrideTotalSold !== null && ev.overrideTotalSold !== '') {
        syncOverrideInputFromEvent(ev);
      } else if (ev.overrideTotalSoldRaw) {
        if (document.activeElement !== overrideTotalSold) overrideTotalSold.value = String(ev.overrideTotalSoldRaw);
      }
    }

    // Restore session notes (optional)
    if (sessionNotes) {
      sessionNotes.value = String(ev.sessionNotes ?? '');
      sessionNotes.disabled = isLocked(ev);
    }

    smartSearch.value = '';
    searchResults = [];
    renderResults();
    renderLines();
    smartSearch.focus();

    // Refresh top pill + command center
    setForcedPill(ev);
    setCommandCenter(ev);
    startKpiLoop();
  }

  // -------- Landing: Events table --------
  function renderEventsTable() {
    const fStatus = filterStatus.value;
    const fText = lc(filterText.value);

    let list = events.slice();
    if (fStatus) list = list.filter(e => e.status === fStatus);
    if (fText) list = list.filter(e => lc(e.name).includes(fText));

    list.sort((a,b) => String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
    eventCountPill.textContent = String(list.length);

    eventsTbody.innerHTML = '';
    if (!list.length) {
      eventsTbody.innerHTML = `<tr><td colspan="9" class="muted">No events yet. Create one above.</td></tr>`;
      return;
    }

    for (const ev of list) {
      const t = recalcEventTotals(ev);
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${eventStatusPillHtml(ev.status)}</td>
        <td><span class="linkish" data-open="${escapeHtml(ev.id)}">${escapeHtml(ev.name || '(untitled)')}</span></td>
        <td>${escapeHtml(ev.channel || 'other')}</td>
        <td class="small">${escapeHtml(niceDate(ev.updatedAt || ev.createdAt))}</td>
        <td class="right">${t.linesCount}</td>
        <td class="right">${fmt$(t.gross)}</td>
        <td class="right">${fmt$(t.cost)}</td>
        <td class="right">${fmt$(t.profit)}</td>
        <td>
          <button class="btn" data-open="${escapeHtml(ev.id)}">Open</button>
          <button class="btn danger" data-del="${escapeHtml(ev.id)}">Delete</button>
        </td>
      `;
      eventsTbody.appendChild(tr);
    }
  }

  // -------- Editor: Search results --------
  function renderResults() {
    resultsBox.innerHTML = '';

    if (!currentEventId) {
      resultsBox.innerHTML = `<div class="muted">No event loaded.</div>`;
      return;
    }

    const ev = getEventById(currentEventId);
    if (!ev) return;

    if (isLocked(ev)) {
      const msg = ev.status === 'voided' ? 'Voided event (search disabled).' : 'Finalized event (search disabled).';
      resultsBox.innerHTML = `<div class="muted">${msg}</div>`;
      return;
    }

    if (!searchResults.length) {
      resultsBox.innerHTML = `<div class="muted">No results.</div>`;
      return;
    }

    for (const it of searchResults) {
      const div = document.createElement('div');
      div.className = 'result-item';
      div.dataset.add = String(it.id);

      const price = Number(it.price || 0);
      const cost = Number(it.cost || 0);
      const qty = Number(it.qty || 0);

      div.innerHTML = `
        <div class="result-main">
          <div class="result-title">${escapeHtml(it.title || '(no title)')}</div>
          <div class="result-sub">SKU: <b>${escapeHtml(it.sku || '')}</b> • ${escapeHtml(it.platform || '')} • ${escapeHtml(it.category || '')}</div>
        </div>
        <div class="result-meta">
          <div>list: <b>${fmt$(price)}</b></div>
          <div class="muted">cost: ${fmt$(cost)} • qty: ${qty}</div>
        </div>
      `;

      resultsBox.appendChild(div);
    }
  }

  // -------- Editor: Lines --------
  function getLiveListPriceForLine(ln) {
    const skuKey = lc(ln.sku);
    const inv = skuKey ? itemsBySku.get(skuKey) : null;
    if (inv) {
      const p = toNumberSafe(inv.price, toNumberSafe(inv.listPrice, 0));
      return p;
    }
    return toNumberSafe(ln.listPrice, 0);
  }

  function updateSummaryOnly(ev) {
    if (!ev) return;
    const totals = recalcEventTotals(ev);

    sumLines.textContent = String(totals.linesCount);
    sumGross.textContent = fmt$(totals.gross);
    sumCost.textContent = fmt$(totals.cost);
    sumProfit.textContent = fmt$(totals.profit);

    // Keep override input restored (but don’t fight typing)
    syncOverrideInputFromEvent(ev);

    // Update pill + command center
    setForcedPill(ev);
    setCommandCenter(ev);
  }

  function renderLines() {
    linesBox.innerHTML = '';

    const ev = currentEventId ? getEventById(currentEventId) : null;
    if (!ev) {
      linesBox.innerHTML = `<div class="muted">No event loaded.</div>`;
      return;
    }

    const lines = Array.isArray(ev.lines) ? ev.lines : [];
    updateSummaryOnly(ev);

    if (!lines.length) {
      linesBox.innerHTML = `<div class="muted">No items added yet.</div>`;
      return;
    }

    for (const ln of lines) {
      const qtySold = Number(ln.qtySold || 1);
      const sell = (ln.sellPrice === '' || ln.sellPrice === null || ln.sellPrice === undefined) ? '' : Number(ln.sellPrice);
      const sellPer = (sell === '' ? '' : Number(sell).toFixed(2));

      const listLive = getLiveListPriceForLine(ln);

      const lineGross = (sell === '' ? 0 : (Number(sell) * qtySold));
      const lineCost = (Number(ln.cost || 0) * qtySold);
      const lineProfit = lineGross - lineCost;

      const card = document.createElement('div');
      card.className = 'line';
      card.dataset.line = String(ln.lineId);

      // Expose values to UI-only calculator in live-events.html
      card.dataset.qty = String(qtySold);
      card.dataset.cost = String(Number(ln.cost || 0));
      card.dataset.list = String(Number(listLive || 0));
      card.dataset.sold = String(sell === '' ? 0 : Number(sell));

      card.innerHTML = `
        <div class="line-top">
          <div>
            <div class="line-title">${escapeHtml(ln.title || '(no title)')}</div>
            <div class="line-sub">
              SKU: <b>${escapeHtml(ln.sku || '')}</b>
              • cost: <b>${fmt$(ln.cost)}</b>
              • list: <b>${fmt$(listLive)}</b>
              • platform: ${escapeHtml(ln.platform || '')}
            </div>

            <div class="line-controls">
              <label class="small">qty</label>
              <input class="input qty" type="number" min="1" step="1" value="${qtySold}" data-field="qtySold" />

              <label class="small">sold $</label>
              <input class="input sold" type="number" step="0.01" placeholder="per unit" value="${sellPer}" data-field="sellPrice" />

              <span class="small">line:</span>
              <span class="small"><b>${fmt$(lineGross)}</b> gross</span>
              <span class="small"><b>${fmt$(lineProfit)}</b> profit</span>

              <button class="btn danger" data-act="remove">Remove</button>
            </div>
          </div>

          <div class="small" style="text-align:right;">
            <div>${escapeHtml(ev.channel || '')}</div>
            <div class="muted">${escapeHtml(niceDate(ln.addedAt))}</div>
          </div>
        </div>
      `;

      linesBox.appendChild(card);
    }
  }

  function addLineFromItem(it) {
    const ev = getEventById(currentEventId);
    if (isLocked(ev)) return;

    if (!Array.isArray(ev.lines)) ev.lines = [];

    // Start timer on first added line (for pace KPIs)
    if (!ev.startedAt) ev.startedAt = nowISO();

    ev.lines.unshift({
      lineId: uid(),
      itemId: it.id,
      sku: it.sku || '',
      title: it.title || '',
      platform: it.platform || '',
      category: it.category || '',
      cost: Number(it.cost || 0),
      listPrice: Number(it.price || 0),
      qtySold: 1,
      sellPrice: '',
      autoSold: false,
      addedAt: nowISO()
    });

    ev.updatedAt = nowISO();
    saveEvents();
    renderLines();
  }

  function updateLine(lineId, field, value, opts = {}) {
    const ev = getEventById(currentEventId);
    if (isLocked(ev)) return;

    const ln = (ev.lines || []).find(x => x.lineId === lineId);
    if (!ln) return;

    if (field === 'qtySold') {
      const n = Math.max(1, Math.floor(Number(value || 1)));
      ln.qtySold = n;
    } else if (field === 'sellPrice') {
      if (value === '' || value === null || value === undefined) ln.sellPrice = '';
      else {
        const n = Number(value);
        ln.sellPrice = Number.isFinite(n) && n >= 0 ? Number(n.toFixed(2)) : '';
      }
      ln.autoSold = false; // user touched it
    }

    ev.updatedAt = nowISO();
    saveEvents();
    if (opts.skipRender) updateSummaryOnly(ev);
    else renderLines();
  }

  function removeLine(lineId) {
    const ev = getEventById(currentEventId);
    if (isLocked(ev)) return;

    ev.lines = (ev.lines || []).filter(x => x.lineId !== lineId);
    ev.updatedAt = nowISO();
    saveEvents();
    renderLines();
  }

  // -------- Overrides: average helpers --------
  function computeAvgFromOverride(ev) {
    if (!overrideTotalSold) return { ok: false, msg: 'Override input not found', total: 0, units: 0, avg: 0 };

    // Commit numeric once before applying
    persistOverrideFromInput({ commitNumber: true });

    const total = toNumberSafe(overrideTotalSold.value, 0);
    if (!(total > 0)) return { ok: false, msg: 'Enter a total sold amount first', total, units: 0, avg: 0 };

    const units = getTotalUnits(ev);
    if (!(units > 0)) return { ok: false, msg: 'No units in event', total, units, avg: 0 };

    const avg = Number((total / units).toFixed(2));
    return { ok: true, msg: '', total: Number(total.toFixed(2)), units, avg };
  }

  function applyAvgToBlanks() {
    const ev = getEventById(currentEventId);
    if (isLocked(ev)) return;

    const calc = computeAvgFromOverride(ev);
    if (!calc.ok) { setStatus(calc.msg, 'warn'); return; }

    let changed = 0;
    for (const ln of (ev.lines || [])) {
      const isBlank = (ln.sellPrice === '' || ln.sellPrice === null || ln.sellPrice === undefined);
      if (isBlank) {
        ln.sellPrice = calc.avg;
        ln.autoSold = true;
        changed++;
      }
    }

    ev.overrideTotalSold = calc.total;
    ev.lastAppliedAvg = calc.avg;

    ev.updatedAt = nowISO();
    saveEvents();
    renderLines();

    if (changed > 0) setStatus(`Applied avg ${fmt$(calc.avg)} to ${changed} blank line(s)`, 'ok');
    else setStatus('No blank sold prices to fill', 'warn');
  }

  function applyAvgToAutoOnly() {
    const ev = getEventById(currentEventId);
    if (isLocked(ev)) return;

    const calc = computeAvgFromOverride(ev);
    if (!calc.ok) { setStatus(calc.msg, 'warn'); return; }

    let changed = 0;
    for (const ln of (ev.lines || [])) {
      if (ln.autoSold === true) {
        ln.sellPrice = calc.avg;
        changed++;
      }
    }

    ev.overrideTotalSold = calc.total;
    ev.lastAppliedAvg = calc.avg;

    ev.updatedAt = nowISO();
    saveEvents();
    renderLines();

    if (changed > 0) setStatus(`Updated ${changed} auto-filled line(s) to ${fmt$(calc.avg)}`, 'ok');
    else setStatus('No auto-filled lines to update (use FORCE if this is an older event)', 'warn');
  }

  function applyAvgForceAll() {
    const ev = getEventById(currentEventId);
    if (isLocked(ev)) return;

    const calc = computeAvgFromOverride(ev);
    if (!calc.ok) { setStatus(calc.msg, 'warn'); return; }

    const ok = confirm(
      `FORCE overwrite SOLD $ on ALL lines to ${fmt$(calc.avg)} per unit?\n\n` +
      `This will replace any sold prices currently entered.`
    );
    if (!ok) return;

    let changed = 0;
    for (const ln of (ev.lines || [])) {
      ln.sellPrice = calc.avg;
      ln.autoSold = true;
      changed++;
    }

    ev.overrideTotalSold = calc.total;
    ev.lastAppliedAvg = calc.avg;

    ev.updatedAt = nowISO();
    saveEvents();
    renderLines();
    setStatus(`FORCED avg ${fmt$(calc.avg)} on ${changed} line(s)`, 'ok');
  }

  // Create 3 buttons under the override input
  // UPDATED: prefers #overrideActions container from new HTML
  function ensureAverageButtons() {
    if (!overrideTotalSold) return;

    // Choose the best injection point
    const host = overrideActions || overrideTotalSold.parentElement;

    if (!host) return;

    // If using the new host, keep it clean and vertical (HTML/CSS handles layout)
    if (!btnApplyBlanks) {
      btnApplyBlanks = document.createElement('button');
      btnApplyBlanks.id = 'btnApplyBlanks';
      btnApplyBlanks.className = 'btn ghost';
      btnApplyBlanks.textContent = 'Apply to blanks';
      btnApplyBlanks.title = 'Fills only blank sold prices (safe)';
      host.appendChild(btnApplyBlanks);
    }

    if (!btnApplyAuto) {
      btnApplyAuto = document.createElement('button');
      btnApplyAuto.id = 'btnApplyAuto';
      btnApplyAuto.className = 'btn';
      btnApplyAuto.textContent = 'Update auto-filled';
      btnApplyAuto.title = 'Updates only values that were auto-filled previously';
      host.appendChild(btnApplyAuto);
    }

    if (!btnApplyForce) {
      btnApplyForce = document.createElement('button');
      btnApplyForce.id = 'btnApplyForce';
      btnApplyForce.className = 'btn danger';
      btnApplyForce.textContent = 'FORCE overwrite all';
      btnApplyForce.title = 'Overwrites sold price on every line (confirmation required)';
      host.appendChild(btnApplyForce);
    }

    const ev = currentEventId ? getEventById(currentEventId) : null;
    const locked = isLocked(ev);
    btnApplyBlanks.disabled = locked;
    btnApplyAuto.disabled = locked;
    btnApplyForce.disabled = locked;
  }

  // -------- Save / Finalize --------
  function saveDraft() {
    const ev = getEventById(currentEventId);
    if (isLocked(ev)) return;

    ev.updatedAt = nowISO();
    saveEvents();
    setStatus('Draft saved', 'ok');
    renderLines();
  }

  async function finalizeEvent() {
    const ev = getEventById(currentEventId);
    if (isLocked(ev)) return;

    if (!ev.lines || !ev.lines.length) {
      alert('No lines to finalize.');
      return;
    }

    const missing = ev.lines.filter(ln => ln.sellPrice === '' || ln.sellPrice === null || ln.sellPrice === undefined);
    if (missing.length) {
      const ok = confirm(`You have ${missing.length} line(s) missing sold price. Finalize anyway?`);
      if (!ok) return;
    }

    const ok = confirm('Finalize this event and update inventory quantities? This will reduce qty on hand.');
    if (!ok) return;

    setStatus('Finalizing… posting sale to backend', 'warn');

    // Build a sale payload for backend source-of-truth
    const saleItems = (ev.lines || []).map((ln) => {
      const qty = Math.max(1, Math.floor(Number(ln.qtySold || 1)));
      const unitPrice = (ln.sellPrice === '' || ln.sellPrice === null || ln.sellPrice === undefined)
        ? Number(ln.listPrice || 0)
        : Number(ln.sellPrice || 0);
      return {
        sku: ln.sku || '',
        title: ln.title || '',
        platform: ln.platform || '',
        condition: ln.condition || '',
        qty,
        price: Number.isFinite(unitPrice) ? unitPrice : 0
      };
    }).filter(it => it.sku);

    if (!saleItems.length) {
      alert('Finalize failed: no valid SKUs found.');
      setStatus('Finalize failed (no SKUs)', 'bad');
      return;
    }

    try {
      const sale = {
        id: `EV-${ev.id}`,
        ts: nowISO(),
        payment_method: ev.channel || 'event',
        items: saleItems
      };

      const res = await fetch(`${API_BASE}/api/sales/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ sale })
      });

      if (!res.ok) {
        let detail = '';
        let j = {};
        try {
          j = await res.json();
        } catch {
          detail = await res.text().catch(() => '');
        }
        const skuMsg = j && j.sku ? ` (SKU: ${j.sku})` : '';
        const errMsg = j && j.error ? `${j.error}${skuMsg}` : `${res.status}${detail ? ` ${detail}` : ''}`;
        alert(`Finalize failed: ${errMsg}`);
        setStatus('Finalize failed (sale API error)', 'bad');
        return;
      }
      const j = await res.json().catch(() => ({}));
      if (j && j.saleId) {
        ev.backendSaleId = j.saleId;
      }
    } catch (err) {
      console.error(err);
      alert('Finalize failed. Check backend connectivity.');
      setStatus('Finalize failed (sale API error)', 'bad');
      return;
    }

    ev.status = 'finalized';
    ev.finalizedAt = nowISO();
    ev.updatedAt = nowISO();
    saveEvents();

    if (ev.backendSaleId) {
      setStatus(`Finalized ✅ Sale #${ev.backendSaleId} posted`, 'ok');
    } else {
      setStatus('Finalized ✅ Inventory updated', 'ok');
    }
    showEditor(ev.id);
  }

  async function voidEvent() {
    const ev = getEventById(currentEventId);
    if (!ev || ev.status !== 'finalized') return;

    if (!ev.backendSaleId) {
      alert('This event does not have a backend sale ID, so it cannot be voided automatically.');
      return;
    }

    const ok = confirm('Void this event sale and restore all inventory quantities? This will mark the sale as voided.');
    if (!ok) return;

    setStatus('Voiding… restoring inventory', 'warn');

    try {
      const res = await fetch(`${API_BASE}/api/sales/${ev.backendSaleId}/void`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }
      });

      if (!res.ok) {
        let detail = '';
        let j = {};
        try {
          j = await res.json();
        } catch {
          detail = await res.text().catch(() => '');
        }
        const errMsg = j && j.error ? j.error : `${res.status}${detail ? ` ${detail}` : ''}`;
        alert(`Void failed: ${errMsg}`);
        setStatus('Void failed (API error)', 'bad');
        return;
      }
    } catch (err) {
      console.error(err);
      alert('Void failed. Check backend connectivity.');
      setStatus('Void failed (API error)', 'bad');
      return;
    }

    ev.status = 'voided';
    ev.voidedAt = nowISO();
    ev.updatedAt = nowISO();
    saveEvents();

    setStatus('Voided ✅ Inventory restored', 'ok');
    showEditor(ev.id);
  }

  // -------- Persist meta: name + channel --------
  function setEventMeta({ name, channel }) {
    const ev = getEventById(currentEventId);
    if (isLocked(ev)) return;

    let changed = false;

    if (typeof name === 'string' && name.trim() && name.trim() !== ev.name) {
      ev.name = name.trim();
      changed = true;
    }

    if (typeof channel === 'string' && channel.trim() && channel.trim() !== ev.channel) {
      ev.channel = channel.trim();
      changed = true;
    }

    if (changed) {
      ev.updatedAt = nowISO();
      saveEvents();
      editorMeta.textContent = `${ev.channel || 'other'} • created ${niceDate(ev.createdAt)} • updated ${niceDate(ev.updatedAt)}`;
      setStatus('Event updated', 'ok');
      renderLines();
    }
  }

  // -------- Persist notes (optional) --------
  function persistNotes({ commit = false } = {}) {
    if (!sessionNotes) return;
    const ev = currentEventId ? getEventById(currentEventId) : null;
    if (isLocked(ev)) return;

    // store raw string; commit is here if you later want special behavior
    ev.sessionNotes = String(sessionNotes.value ?? '');
    ev.updatedAt = nowISO();
    saveEvents();

    if (commit) setStatus('Notes saved', 'ok');
  }

  // -------- Wiring --------
  function wireLanding() {
    btnCreateEvent.addEventListener('click', () => {
      const name = (newEventName.value || '').trim();
      const channel = newEventChannel.value || 'other';

      if (!name) {
        alert('Enter an event name.');
        newEventName.focus();
        return;
      }

      const ev = {
        id: uid(),
        name,
        channel,
        status: 'draft',
        createdAt: nowISO(),
        updatedAt: nowISO(),
        startedAt: '',     // optional, will be set when first line added
        sessionNotes: '',  // optional
        lines: []
      };

      events.unshift(ev);
      saveEvents();
      newEventName.value = '';
      renderEventsTable();
      showEditor(ev.id);
    });

    eventsTbody.addEventListener('click', (e) => {
      const openId = e.target?.dataset?.open;
      const delId = e.target?.dataset?.del;

      if (openId) {
        showEditor(openId);
        return;
      }
      if (delId) {
        const ev = getEventById(delId);
        if (!ev) return;
        const ok = confirm(`Delete event "${ev.name}"? This only removes the local record (does not change inventory).`);
        if (!ok) return;
        events = events.filter(x => x.id !== delId);
        saveEvents();
        renderEventsTable();
      }
    });

    filterStatus.addEventListener('change', renderEventsTable);
    filterText.addEventListener('input', () => {
      clearTimeout(filterText._t);
      filterText._t = setTimeout(renderEventsTable, 120);
    });

    btnClearAll.addEventListener('click', () => {
      const ok = confirm('Clear ALL saved events from this machine? (localStorage)');
      if (!ok) return;
      events = [];
      saveEvents();
      renderEventsTable();
    });

    btnExportEvents.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(events, null, 2)], { type:'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'retrocatz-live-events.json';
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  function wireEditor() {
    btnEditorBack.addEventListener('click', showLanding);
    btnSaveDraft.addEventListener('click', saveDraft);
    btnFinalize.addEventListener('click', finalizeEvent);
    if (btnVoidSale) btnVoidSale.addEventListener('click', voidEvent);

    // Command center quick actions (safe)
    if (btnCcFocusSearch) btnCcFocusSearch.addEventListener('click', () => smartSearch?.focus());
    if (btnCcJumpLines) btnCcJumpLines.addEventListener('click', () => linesBox?.scrollIntoView({ behavior:'smooth', block:'start' }));
    if (btnCcMarkBundle) btnCcMarkBundle.addEventListener('click', () => setStatus('Bundle Mode is a placeholder (we can build it)', 'warn'));

    // Notes persistence
    if (sessionNotes) {
      sessionNotes.addEventListener('input', () => {
        clearTimeout(sessionNotes._t);
        sessionNotes._t = setTimeout(() => persistNotes({ commit:false }), 250);
      });
      sessionNotes.addEventListener('blur', () => persistNotes({ commit:true }));
    }

    btnReloadInventory.addEventListener('click', async () => {
      try {
        await loadInventory();
        if (currentEventId) renderLines();
        setStatus('Inventory reloaded', 'ok');
      } catch (e) {
        console.error(e);
        setStatus('Inventory load failed', 'bad');
        alert('Inventory load failed. Is the server running on 127.0.0.1:5175?');
      }
    });

    // Persist override typing safely
    if (overrideTotalSold) {
      overrideTotalSold.addEventListener('input', () => {
        persistOverrideFromInput({ commitNumber: false });
      });
      overrideTotalSold.addEventListener('change', () => {
        persistOverrideFromInput({ commitNumber: true });
        const ev = currentEventId ? getEventById(currentEventId) : null;
        if (ev) { setForcedPill(ev); setCommandCenter(ev); }
      });
      overrideTotalSold.addEventListener('blur', () => {
        persistOverrideFromInput({ commitNumber: true });
        const ev = currentEventId ? getEventById(currentEventId) : null;
        if (ev) { setForcedPill(ev); setCommandCenter(ev); }
      });
    }

    if (editorChannel) {
      editorChannel.addEventListener('change', () => {
        setEventMeta({ channel: editorChannel.value });
      });
    }

    window.addEventListener('rcz:event-meta-changed', (e) => {
      const { name, channel } = e.detail || {};
      setEventMeta({ name, channel });
      if (editorChannel && channel) editorChannel.value = channel;
      if (name && editorName) editorName.textContent = name;
    });

    ensureAverageButtons();

    // Wire the avg buttons ONCE (avoid stacking duplicate handlers)
    if (btnApplyBlanks && !btnApplyBlanks.dataset.wired) {
      btnApplyBlanks.addEventListener('click', applyAvgToBlanks);
      btnApplyBlanks.dataset.wired = '1';
    }
    if (btnApplyAuto && !btnApplyAuto.dataset.wired) {
      btnApplyAuto.addEventListener('click', applyAvgToAutoOnly);
      btnApplyAuto.dataset.wired = '1';
    }
    if (btnApplyForce && !btnApplyForce.dataset.wired) {
      btnApplyForce.addEventListener('click', applyAvgForceAll);
      btnApplyForce.dataset.wired = '1';
    }

    btnClearLines.addEventListener('click', () => {
      const ev = getEventById(currentEventId);
      if (isLocked(ev)) return;
      const ok = confirm('Clear all lines from this event?');
      if (!ok) return;
      ev.lines = [];
      ev.updatedAt = nowISO();
      saveEvents();
      renderLines();
    });

    smartSearch.addEventListener('input', () => {
      const ev = getEventById(currentEventId);
      if (isLocked(ev)) return;

      const q = smartSearch.value.trim();
      if (!q) {
        searchResults = [];
        resultsBox.innerHTML = `<div class="muted">No search yet.</div>`;
        return;
      }

      searchResults = findItemMatches(q);
      renderResults();
    });

    smartSearch.addEventListener('keydown', (e) => {
      const ev = getEventById(currentEventId);
      if (isLocked(ev)) return;

      if (e.key === 'Enter') {
        e.preventDefault();
        if (searchResults.length) {
          addLineFromItem(searchResults[0]);
          smartSearch.select();
        }
      }
    });

    resultsBox.addEventListener('click', (e) => {
      const ev = getEventById(currentEventId);
      if (isLocked(ev)) return;

      const card = e.target.closest('.result-item');
      if (!card) return;
      const id = Number(card.dataset.add);
      const it = itemsCache.find(x => Number(x.id) === id);
      if (it) addLineFromItem(it);
    });

    linesBox.addEventListener('input', (e) => {
      const ev = getEventById(currentEventId);
      if (isLocked(ev)) return;

      const lineEl = e.target.closest('.line');
      if (!lineEl) return;

      const lineId = lineEl.dataset.line;
      const field = e.target.dataset.field;
      if (!field) return;

      updateLine(lineId, field, e.target.value, { skipRender: true });
    });

    linesBox.addEventListener('change', (e) => {
      const ev = getEventById(currentEventId);
      if (isLocked(ev)) return;

      const lineEl = e.target.closest('.line');
      if (!lineEl) return;

      const lineId = lineEl.dataset.line;
      const field = e.target.dataset.field;
      if (!field) return;

      updateLine(lineId, field, e.target.value);
    });

    linesBox.addEventListener('click', (e) => {
      const ev = getEventById(currentEventId);
      if (isLocked(ev)) return;

      const lineEl = e.target.closest('.line');
      if (!lineEl) return;

      const btn = e.target.closest('button[data-act]');
      if (!btn) return;

      if (btn.dataset.act === 'remove') {
        removeLine(lineEl.dataset.line);
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!viewEditor.classList.contains('hidden')) showLanding();
      }
    });
  }

  // -------- Nav / Back --------
  btnBack.addEventListener('click', () => {
    window.location.href = 'index.html';
  });

  // -------- Init --------
  async function init() {
    loadEvents();
    renderEventsTable();

    wireLanding();
    wireEditor();

    try {
      await loadInventory();
    } catch (e) {
      console.error(e);
      setStatus('Inventory not connected (server?)', 'warn');
    }

    setStatus('Ready', 'ok');
    showLanding();
  }

  init();
})();




