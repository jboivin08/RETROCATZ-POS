(() => {
  const API_BASE = "http://127.0.0.1:5175";
  const CODE128_PATTERNS = [
    "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312",
    "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222",
    "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131",
    "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321",
    "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
    "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121",
    "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321",
    "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224",
    "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114",
    "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
    "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112",
    "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113",
    "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412",
    "211214", "211232", "2331112"
  ];
  const ACTIVE_STATUSES = new Set(["reserved", "checked_in"]);

  const state = {
    eventId: new URLSearchParams(window.location.search).get("eventId") || "",
    event: null,
    attendees: [],
    lastBatch: []
  };

  const els = {
    eventMeta: $("eventMeta"),
    pageStatus: $("pageStatus"),
    batchStatus: $("batchStatus"),
    metricCapacity: $("metricCapacity"),
    metricActive: $("metricActive"),
    metricOpen: $("metricOpen"),
    ticketQty: $("ticketQty"),
    ticketLabel: $("ticketLabel"),
    btnCreatePos: $("btnCreatePos"),
    btnCreateGeneric: $("btnCreateGeneric"),
    btnPrintLast: $("btnPrintLast"),
    lastBatchStatus: $("lastBatchStatus"),
    ticketList: $("ticketList")
  };

  function $(id) {
    return document.getElementById(id);
  }

  function getAuthHeaders() {
    const sid = localStorage.getItem("rc_session_id") || "";
    return {
      "Content-Type": "application/json",
      ...(sid ? { rc_session_id: sid } : {})
    };
  }

  async function api(path, options = {}) {
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: { ...getAuthHeaders(), ...(options.headers || {}) }
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      localStorage.removeItem("rc_session_id");
      throw new Error("session_invalid");
    }
    if (!res.ok) {
      const err = new Error(data.error || `request_failed_${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function setPageStatus(message, tone = "") {
    els.pageStatus.textContent = message || "";
    els.pageStatus.className = `pill${tone ? ` ${tone}` : ""}`;
  }

  function setBatchStatus(message) {
    els.batchStatus.textContent = message || "";
  }

  function apiErrorMessage(err) {
    if (!err) return "Something went wrong.";
    if (err.message === "session_invalid") return "Please log in again.";
    if (err.status === 403) return "This login needs checkout permission.";
    if (err.status === 404) return "Ticket creation is not available in this backend yet.";
    if (err.status === 409 || err.message === "event_full") return "This event is at capacity.";
    if (err.message === "missing_ticket_count") return "Enter a ticket quantity.";
    return `${String(err.message || "Request failed").replace(/_/g, " ")}.`;
  }

  function normalizeEvent(row) {
    if (!row) return null;
    return {
      ...row,
      id: String(row.id || ""),
      title: row.title || "Event",
      game: row.game || "Other",
      eventType: row.eventType || row.event_type || "Event",
      startsAt: row.startsAt || row.starts_at || "",
      capacity: Math.max(0, Math.floor(Number(row.capacity || 0))),
      entry_fee_cents: Number(row.entry_fee_cents || 0),
      stats: row.stats || {}
    };
  }

  function normalizeAttendee(row) {
    if (!row) return null;
    return {
      ...row,
      id: String(row.id || ""),
      name: row.name || "Ticket",
      phone: row.phone || "",
      email: row.email || "",
      status: row.status || "reserved",
      paid: !!row.paid,
      paymentMethod: row.paymentMethod || row.payment_method || "",
      entry_fee_cents: Number(row.entry_fee_cents || 0),
      notes: row.notes || ""
    };
  }

  function stats() {
    const active = state.attendees.filter((att) => ACTIVE_STATUSES.has(att.status));
    const capacity = Number(state.event?.capacity || 0);
    return {
      active: active.length,
      capacity,
      open: capacity > 0 ? Math.max(0, capacity - active.length) : 0
    };
  }

  function dateLabel(value) {
    const date = new Date(value || "");
    if (Number.isNaN(date.getTime())) return "No date";
    return date.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function moneyInputFromCents(value) {
    return (Number(value || 0) / 100).toFixed(2);
  }

  function ticketCodeForAttendee(attendee) {
    const id = String(attendee?.id || "").replace(/[^a-z0-9]/gi, "");
    if (!id) return "CE-UNKNOWN";
    return `CE-${id.slice(0, 8).toUpperCase()}-${id.slice(-4).toUpperCase()}`;
  }

  function ticketScanCodeForAttendee(attendee) {
    return `CE:${String(attendee?.id || "").trim()}`;
  }

  async function loadEvent() {
    if (!state.eventId) {
      setPageStatus("Missing event.", "bad");
      return;
    }
    setPageStatus("Loading", "warn");
    try {
      const data = await api(`/api/community-events/${encodeURIComponent(state.eventId)}`);
      state.event = normalizeEvent(data.event);
      state.attendees = (data.attendees || []).map(normalizeAttendee).filter(Boolean);
      render();
      setPageStatus("Ready", "good");
    } catch (err) {
      console.error(err);
      setPageStatus(apiErrorMessage(err), "bad");
      setBatchStatus(apiErrorMessage(err));
    }
  }

  function render() {
    const event = state.event;
    if (!event) return;
    const s = stats();
    els.eventMeta.textContent = `${event.title} / ${dateLabel(event.startsAt)} / ${event.game} / ${event.eventType}`;
    els.metricCapacity.textContent = event.capacity ? String(event.capacity) : "Open";
    els.metricActive.textContent = String(s.active);
    els.metricOpen.textContent = event.capacity ? String(s.open) : "Any";
    if (!els.ticketQty.value) els.ticketQty.placeholder = event.capacity ? String(s.open) : "Qty";
    els.btnPrintLast.disabled = !state.lastBatch.length;
    renderLastBatch();
  }

  function renderLastBatch() {
    els.ticketList.replaceChildren();
    if (!state.lastBatch.length) {
      els.ticketList.append(textEl("div", "No tickets created yet.", "small"));
      els.lastBatchStatus.textContent = "No tickets created yet";
      return;
    }
    els.lastBatchStatus.textContent = `${state.lastBatch.length} ticket${state.lastBatch.length === 1 ? "" : "s"} in last batch`;
    state.lastBatch.forEach((ticket) => {
      const attendee = ticket.attendee || ticket;
      const row = document.createElement("article");
      row.className = "ticket-row";
      row.append(
        textEl("strong", attendee.name || "Ticket"),
        textEl("div", `${ticketCodeForAttendee(attendee)} / ${ticket.kind === "generic" ? "Generic print" : "POS sellable"}`, "small"),
        textEl("div", ticket.item?.sku ? `POS SKU: ${ticket.item.sku}` : "No POS item", "small")
      );
      els.ticketList.append(row);
    });
  }

  function textEl(tag, text, className = "") {
    const el = document.createElement(tag);
    if (className) el.className = className;
    el.textContent = text == null ? "" : String(text);
    return el;
  }

  function readTicketQty() {
    const explicit = Math.floor(Number(els.ticketQty.value || 0));
    if (explicit > 0) return explicit;
    const s = stats();
    if (state.event?.capacity && s.open > 0) return s.open;
    return 0;
  }

  function ticketLabel() {
    return String(els.ticketLabel.value || "Ticket").trim().slice(0, 40) || "Ticket";
  }

  async function createTickets(kind) {
    const count = readTicketQty();
    if (count <= 0) {
      setBatchStatus("Enter a ticket quantity.");
      els.ticketQty.focus();
      return;
    }
    const label = ticketLabel();
    const actionLabel = kind === "generic" ? "print-only" : "POS sellable";
    if (!confirm(`Create ${count} ${actionLabel} ${label.toLowerCase()} ticket${count === 1 ? "" : "s"}?`)) return;

    setPageStatus("Creating tickets", "warn");
    setBatchStatus("Creating tickets...");
    try {
      const data = await createTicketsWithFallback({ kind, count, label });
      const rows = (data.created || []).map((ticket) => ({
        ...ticket,
        attendee: normalizeAttendee(ticket.attendee),
        kind: ticket.kind || kind
      })).filter((ticket) => ticket.attendee);
      state.lastBatch = rows;
      await loadEvent();
      notifyOpener();
      setPageStatus("Tickets created", "good");
      setBatchStatus(`${rows.length} ticket${rows.length === 1 ? "" : "s"} created.`);
      if (kind === "generic") printLastBatch();
    } catch (err) {
      console.error(err);
      setPageStatus(apiErrorMessage(err), "bad");
      setBatchStatus(apiErrorMessage(err));
    }
  }

  async function createTicketsWithFallback({ kind, count, label }) {
    try {
      return await api(`/api/community-events/${encodeURIComponent(state.eventId)}/tickets/generate`, {
        method: "POST",
        body: JSON.stringify({ count, kind, label })
      });
    } catch (err) {
      const message = String(err?.message || "").toLowerCase();
      if (!(err?.status === 404 || message.includes("unsupported") || message.includes("not supported"))) throw err;
      return createTicketsCompatibility({ kind, count, label });
    }
  }

  async function createTicketsCompatibility({ kind, count, label }) {
    const created = [];
    for (let i = 0; i < count; i += 1) {
      const ticketNumber = state.attendees.filter((attendee) => {
        return String(attendee.notes || "").includes("_TICKET]") || /^.+\s+\d+$/i.test(String(attendee.name || ""));
      }).length + created.length + 1;
      const name = `${label} ${String(ticketNumber).padStart(3, "0")}`;
      const marker = kind === "generic" ? "GENERIC_TICKET" : "POS_TICKET";
      const attendeeData = await api(`/api/community-events/${encodeURIComponent(state.eventId)}/attendees`, {
        method: "POST",
        body: JSON.stringify({
          name,
          status: "reserved",
          paid: false,
          entryFee: moneyInputFromCents(state.event.entry_fee_cents),
          notes: `[${marker}] Compatibility ticket.`
        })
      });
      const attendee = normalizeAttendee(attendeeData.attendee);
      if (!attendee) continue;
      let item = null;
      if (kind !== "generic") {
        const itemData = await api("/api/items", {
          method: "POST",
          body: JSON.stringify({
            title: `${state.event.title} - ${name}`,
            platform: state.event.game || "Community Event",
            category: "Event Tickets",
            condition: "New",
            qty: 1,
            cost: 0,
            price: moneyInputFromCents(state.event.entry_fee_cents),
            barcode: ticketScanCodeForAttendee(attendee),
            source: `community-event-ticket:${state.eventId}`,
            forceNewGroup: true
          })
        });
        item = itemData.item || null;
      }
      created.push({ attendee, item, kind, code: ticketCodeForAttendee(attendee), scanCode: ticketScanCodeForAttendee(attendee) });
    }
    return { ok: true, created };
  }

  function notifyOpener() {
    try {
      window.opener?.postMessage({ type: "community-events:tickets-created", eventId: state.eventId }, "*");
    } catch {}
  }

  function printLastBatch() {
    if (!state.lastBatch.length || !state.event) return;
    printTickets(state.lastBatch.map((ticket) => ticket.attendee).filter(Boolean));
  }

  function printTickets(tickets) {
    const popup = window.open("", "_blank", "width=900,height=720");
    if (!popup) {
      setBatchStatus("Print window was blocked.");
      return;
    }
    const cards = tickets.map((attendee) => ticketCardHtml(state.event, attendee)).join("");
    popup.document.open();
    popup.document.write(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(state.event.title)} Tickets</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 18px; color: #111827; background: #f5f7fb; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .sheet { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .ticket { min-height: 250px; break-inside: avoid; border: 2px solid #111827; border-radius: 8px; background: white; padding: 12px; display: grid; gap: 8px; }
    .brand { display: flex; align-items: center; justify-content: space-between; gap: 8px; border-bottom: 1px solid #d1d5db; padding-bottom: 7px; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0; }
    h1, h2, p { margin: 0; letter-spacing: 0; }
    h1 { font-size: 16px; line-height: 1.2; }
    h2 { font-size: 22px; line-height: 1.15; overflow-wrap: anywhere; }
    .meta { color: #4b5563; font-size: 12px; line-height: 1.35; }
    .barcode { width: 100%; min-height: 78px; display: grid; place-items: center; border: 1px solid #d1d5db; border-radius: 6px; padding: 6px; }
    .code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; font-size: 13px; font-weight: 800; text-align: center; letter-spacing: 0; }
    @media print { body { background: white; padding: 0; } .sheet { gap: 0; grid-template-columns: repeat(2, 1fr); } .ticket { margin: 0.15in; } }
  </style>
</head>
<body>
  <section class="sheet">${cards}</section>
  <script>window.addEventListener("load", () => setTimeout(() => window.print(), 180));</script>
</body>
</html>`);
    popup.document.close();
  }

  function ticketCardHtml(event, attendee) {
    const code = ticketCodeForAttendee(attendee);
    return `<article class="ticket">
  <div class="brand"><span>VaultCore Ticket</span><span>${escapeHtml(attendee.paid ? "Paid" : "Unpaid")}</span></div>
  <div><h1>${escapeHtml(event.title)}</h1><p class="meta">${escapeHtml(dateLabel(event.startsAt))} / ${escapeHtml(event.game)} / ${escapeHtml(event.eventType)}</p></div>
  <div><h2>${escapeHtml(attendee.name)}</h2><p class="meta">${escapeHtml(code)} / ${escapeHtml(moneyInputFromCents(attendee.entry_fee_cents))}</p></div>
  <div class="barcode">${barcodeSvg(ticketScanCodeForAttendee(attendee))}</div>
  <div class="code">${escapeHtml(code)}</div>
</article>`;
  }

  function barcodeSvg(payload) {
    const values = [104];
    let checksum = 104;
    String(payload).split("").forEach((char, index) => {
      const value = char.charCodeAt(0) - 32;
      if (value < 0 || value > 95) return;
      values.push(value);
      checksum += value * (index + 1);
    });
    values.push(checksum % 103, 106);
    let x = 10;
    const height = 62;
    const rects = [];
    values.forEach((value) => {
      const pattern = CODE128_PATTERNS[value] || "";
      pattern.split("").forEach((unit, index) => {
        const width = Number(unit || 0);
        if (index % 2 === 0 && width > 0) rects.push(`<rect x="${x}" y="0" width="${width}" height="${height}" />`);
        x += width;
      });
    });
    const totalWidth = x + 10;
    return `<svg viewBox="0 0 ${totalWidth} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeHtml(payload)}"><rect width="${totalWidth}" height="${height}" fill="#fff" />${rects.join("")}</svg>`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function wire() {
    els.btnCreatePos.addEventListener("click", () => createTickets("pos"));
    els.btnCreateGeneric.addEventListener("click", () => createTickets("generic"));
    els.btnPrintLast.addEventListener("click", printLastBatch);
  }

  wire();
  loadEvent();
})();
