(() => {
  const API_BASE = "http://127.0.0.1:5175";
  const STATUS_ORDER = {
    check_in: 0,
    live: 1,
    scheduled: 2,
    completed: 3,
    cancelled: 4
  };
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
  const ACTIVE_EVENT_STATUSES = new Set(["scheduled", "check_in", "live"]);
  const ACTIVE_ATTENDEE_STATUSES = new Set(["reserved", "checked_in"]);

  const state = {
    events: [],
    selectedId: "",
    selectedEvent: null,
    attendees: [],
    loading: false
  };

  const ids = [
    "pageStatus",
    "eventCount",
    "btnRefreshEvents",
    "btnToggleCreate",
    "eventSearch",
    "eventStatusFilter",
    "eventList",
    "createPanel",
    "createStatus",
    "btnCancelCreate",
    "newTitle",
    "newGame",
    "newType",
    "newDate",
    "newTime",
    "newCapacity",
    "newEntryFee",
    "newNotes",
    "btnCreateEvent",
    "emptyWorkspace",
    "eventWorkspace",
    "detailTitle",
    "detailStatus",
    "detailMeta",
    "btnSaveEvent",
    "btnDeleteEvent",
    "statusStrip",
    "kpiSignups",
    "kpiCheckedIn",
    "kpiUnpaid",
    "kpiSales",
    "checkinStatus",
    "checkinForm",
    "ticketScanInput",
    "ticketBatchStatus",
    "btnOpenTicketBuilder",
    "btnPrintTicketsInline",
    "attendeeName",
    "attendeeFee",
    "attendeePhone",
    "attendeeEmail",
    "attendeePayment",
    "attendeeNotes",
    "btnAddSignup",
    "btnAddCheckIn",
    "detailSaveStatus",
    "healthNote",
    "editTitle",
    "editGame",
    "editType",
    "editDate",
    "editTime",
    "editCapacity",
    "editEntryFee",
    "editPrizePool",
    "editPrizeNotes",
    "editDescription",
    "attendeeCount",
    "btnPrintTickets",
    "btnExportAttendees",
    "attendeeSearch",
    "attendeeFilter",
    "attendeeList"
  ];

  const els = {};

  function $(id) {
    return document.getElementById(id);
  }

  function bootEls() {
    ids.forEach((id) => {
      els[id] = $(id);
    });
  }

  function getAuthHeaders() {
    const sid = localStorage.getItem("rc_session_id") || "";
    return {
      "Content-Type": "application/json",
      ...(sid ? { rc_session_id: sid } : {})
    };
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = 7000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: options.signal || controller.signal });
    } catch (err) {
      if (err && err.name === "AbortError") {
        const timeoutErr = new Error("server_timeout");
        timeoutErr.status = 0;
        throw timeoutErr;
      }
      err.status = err.status || 0;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function api(path, options = {}) {
    const res = await fetchWithTimeout(`${API_BASE}${path}`, {
      ...options,
      headers: { ...getAuthHeaders(), ...(options.headers || {}) }
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      localStorage.removeItem("rc_session_id");
      setPageStatus("Please log in again.", "bad");
      window.location.href = "../../public/index.html";
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

  function setCreateStatus(message) {
    els.createStatus.textContent = message || "";
  }

  function setCheckinStatus(message) {
    els.checkinStatus.textContent = message || "";
  }

  function setTicketBatchStatus(message) {
    els.ticketBatchStatus.textContent = message || "";
  }

  function setDetailStatus(message) {
    els.detailSaveStatus.textContent = message || "";
  }

  function apiErrorMessage(err) {
    if (!err) return "Something went wrong.";
    if (err.status === 0 || err.message === "server_timeout") return "VaultCore server is offline or still starting.";
    if (err.status === 403) return "This login needs checkout or manager permission.";
    if (err.status === 404) return "That event was not found.";
    if (err.message === "missing_ticket_count") return "Enter how many tickets to generate.";
    if (err.status === 409 || err.message === "event_full") return "This event is at capacity.";
    if (err.message === "missing_title") return "Enter an event name.";
    if (err.message === "missing_attendee_name") return "Enter a player name.";
    if (err.message === "session_invalid") return "Please log in again.";
    return `${String(err.message || "Request failed").replace(/_/g, " ")}.`;
  }

  function toNumber(value) {
    const next = Number(value || 0);
    return Number.isFinite(next) ? next : 0;
  }

  function dollarsToCents(value) {
    return Math.max(0, Math.round(toNumber(value) * 100));
  }

  function centsToMoney(value) {
    return `$${(Number(value || 0) / 100).toFixed(2)}`;
  }

  function moneyInputFromCents(value) {
    return (Number(value || 0) / 100).toFixed(2);
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function ymd(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function defaultTime() {
    return "18:00";
  }

  function combineDateTime(date, time) {
    return date ? `${date}T${time || defaultTime()}` : "";
  }

  function splitDateTime(value) {
    if (!value) return { date: "", time: "" };
    const raw = String(value);
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) {
      return { date: raw.slice(0, 10), time: raw.slice(11, 16) };
    }
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return { date: "", time: "" };
    return {
      date: ymd(parsed),
      time: `${pad2(parsed.getHours())}:${pad2(parsed.getMinutes())}`
    };
  }

  function parseDate(value) {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function dateLabel(value) {
    const parsed = parseDate(value);
    if (!parsed) return "No date";
    return parsed.toLocaleString([], {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
  }

  function statusLabel(status) {
    const labels = {
      scheduled: "Scheduled",
      check_in: "Check-In",
      live: "Live",
      completed: "Completed",
      cancelled: "Cancelled",
      reserved: "Reserved",
      checked_in: "Checked In",
      no_show: "No-Show"
    };
    return labels[status] || "Scheduled";
  }

  function statusTone(status) {
    if (status === "completed" || status === "checked_in") return "good";
    if (status === "cancelled" || status === "no_show") return "bad";
    if (status === "check_in" || status === "live") return "info";
    return "warn";
  }

  function normalizeStats(stats = {}) {
    return {
      attendee_count: Number(stats.attendee_count || 0),
      active_count: Number(stats.active_count || 0),
      checked_in_count: Number(stats.checked_in_count || 0),
      paid_count: Number(stats.paid_count || 0),
      paid_total_cents: Number(stats.paid_total_cents || 0),
      no_show_count: Number(stats.no_show_count || 0),
      cancelled_count: Number(stats.cancelled_count || 0)
    };
  }

  function normalizeEvent(row) {
    if (!row || !row.id) return null;
    const entryFeeCents = row.entry_fee_cents !== undefined
      ? Number(row.entry_fee_cents || 0)
      : dollarsToCents(row.entryFee);
    const prizePoolCents = row.prize_pool_cents !== undefined
      ? Number(row.prize_pool_cents || 0)
      : dollarsToCents(row.prizePool);
    return {
      ...row,
      id: String(row.id),
      title: String(row.title || row.name || "Untitled event"),
      game: String(row.game || "Other"),
      eventType: String(row.eventType || row.event_type || "Event"),
      status: String(row.status || "scheduled"),
      startsAt: row.startsAt || row.starts_at || "",
      endsAt: row.endsAt || row.ends_at || "",
      capacity: Math.max(0, Math.floor(Number(row.capacity || 0))),
      entry_fee_cents: entryFeeCents,
      prize_pool_cents: prizePoolCents,
      prizeNotes: row.prizeNotes || row.prize_notes || "",
      description: row.description || "",
      updatedAt: row.updatedAt || row.updated_at || "",
      stats: normalizeStats(row.stats || {})
    };
  }

  function normalizeAttendee(row) {
    if (!row || !row.id) return null;
    const fee = row.entry_fee_cents !== undefined
      ? Number(row.entry_fee_cents || 0)
      : dollarsToCents(row.entryFee);
    return {
      ...row,
      id: String(row.id),
      name: String(row.name || "Player"),
      phone: row.phone || "",
      email: row.email || "",
      status: String(row.status || "reserved"),
      paid: !!row.paid,
      entry_fee_cents: fee,
      paymentMethod: row.paymentMethod || row.payment_method || "",
      notes: row.notes || "",
      checkedInAt: row.checkedInAt || row.checked_in_at || ""
    };
  }

  function currentStats() {
    const attendees = state.attendees || [];
    const active = attendees.filter((att) => ACTIVE_ATTENDEE_STATUSES.has(att.status));
    const paid = attendees.filter((att) => att.paid);
    return {
      attendee_count: attendees.length,
      active_count: active.length,
      checked_in_count: attendees.filter((att) => att.status === "checked_in").length,
      paid_count: paid.length,
      paid_total_cents: paid.reduce((sum, att) => sum + Number(att.entry_fee_cents || 0), 0),
      no_show_count: attendees.filter((att) => att.status === "no_show").length,
      cancelled_count: attendees.filter((att) => att.status === "cancelled").length
    };
  }

  function eventSort(a, b) {
    const ao = STATUS_ORDER[a.status] ?? 9;
    const bo = STATUS_ORDER[b.status] ?? 9;
    if (ao !== bo) return ao - bo;
    const ad = Date.parse(a.startsAt || a.updatedAt || "") || 0;
    const bd = Date.parse(b.startsAt || b.updatedAt || "") || 0;
    return ad - bd;
  }

  function filteredEvents() {
    const status = els.eventStatusFilter.value;
    const q = String(els.eventSearch.value || "").trim().toLowerCase();
    return state.events
      .filter((event) => {
        if (status === "active" && !ACTIVE_EVENT_STATUSES.has(event.status)) return false;
        if (status && status !== "active" && event.status !== status) return false;
        if (!q) return true;
        return [event.title, event.game, event.eventType, event.status]
          .some((value) => String(value || "").toLowerCase().includes(q));
      })
      .sort(eventSort);
  }

  function clearNode(node) {
    node.replaceChildren();
  }

  function textEl(tag, text, className = "") {
    const el = document.createElement(tag);
    if (className) el.className = className;
    el.textContent = text == null ? "" : String(text);
    return el;
  }

  function actionButton(label, className, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = className;
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    return btn;
  }

  function renderEventList() {
    clearNode(els.eventList);
    const rows = filteredEvents();
    els.eventCount.textContent = `${rows.length} shown / ${state.events.length} total`;
    if (!rows.length) {
      els.eventList.append(textEl("div", "No events match this view.", "small"));
      return;
    }

    rows.forEach((event) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `event-row${event.id === state.selectedId ? " active" : ""}`;
      btn.addEventListener("click", () => selectEvent(event.id));

      const title = document.createElement("div");
      title.className = "event-row-title";
      title.append(textEl("span", event.title));
      title.append(textEl("span", statusLabel(event.status), `pill ${statusTone(event.status)}`));

      const stats = normalizeStats(event.stats || {});
      const meta = document.createElement("div");
      meta.className = "event-row-meta";
      meta.append(
        textEl("div", dateLabel(event.startsAt)),
        textEl("div", `${event.game || "Other"} / ${event.eventType || "Event"}`),
        textEl("div", `${stats.active_count}/${event.capacity || "open"} signups / ${stats.checked_in_count} checked in`)
      );

      btn.append(title, meta);
      els.eventList.append(btn);
    });
  }

  function renderWorkspace() {
    const event = state.selectedEvent;
    const hasEvent = !!event;
    els.emptyWorkspace.classList.toggle("hidden", hasEvent);
    els.eventWorkspace.classList.toggle("hidden", !hasEvent);
    els.btnExportAttendees.disabled = !hasEvent;
    els.btnPrintTickets.disabled = !hasEvent;
    els.btnOpenTicketBuilder.disabled = !hasEvent;
    els.btnPrintTicketsInline.disabled = !hasEvent;
    if (!hasEvent) {
      els.attendeeCount.textContent = "No event selected";
      clearNode(els.attendeeList);
      return;
    }

    const stats = currentStats();
    const active = stats.active_count;
    const capacity = Number(event.capacity || 0);
    const unpaid = state.attendees.filter((att) => ACTIVE_ATTENDEE_STATUSES.has(att.status) && !att.paid).length;
    const checkedIn = stats.checked_in_count;

    els.detailTitle.textContent = event.title || "Event";
    els.detailStatus.textContent = statusLabel(event.status);
    els.detailStatus.className = `pill ${statusTone(event.status)}`;
    els.detailMeta.textContent = `${dateLabel(event.startsAt)} / ${event.game || "Other"} / ${event.eventType || "Event"}`;
    els.kpiSignups.textContent = capacity > 0 ? `${active}/${capacity}` : String(active);
    els.kpiCheckedIn.textContent = String(checkedIn);
    els.kpiUnpaid.textContent = String(unpaid);
    els.kpiSales.textContent = centsToMoney(stats.paid_total_cents);
    els.healthNote.textContent = healthText(event, stats, unpaid);
    setTicketBatchStatus(capacity > 0 ? `${Math.max(0, capacity - active)} open spot${Math.max(0, capacity - active) === 1 ? "" : "s"}` : "Open capacity");

    [...els.statusStrip.querySelectorAll("[data-status]")].forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.status === event.status);
    });

    const split = splitDateTime(event.startsAt);
    els.editTitle.value = event.title || "";
    els.editGame.value = event.game || "";
    els.editType.value = event.eventType || "";
    els.editDate.value = split.date;
    els.editTime.value = split.time;
    els.editCapacity.value = event.capacity || "";
    els.editEntryFee.value = moneyInputFromCents(event.entry_fee_cents);
    els.editPrizePool.value = moneyInputFromCents(event.prize_pool_cents);
    els.editPrizeNotes.value = event.prizeNotes || "";
    els.editDescription.value = event.description || "";
    els.attendeeFee.value = moneyInputFromCents(event.entry_fee_cents);
  }

  function healthText(event, stats, unpaid) {
    const capacity = Number(event.capacity || 0);
    const active = Number(stats.active_count || 0);
    const checkedIn = Number(stats.checked_in_count || 0);
    const fillRate = capacity > 0 ? Math.round((active / capacity) * 100) : 0;
    const checkRate = active > 0 ? Math.round((checkedIn / active) * 100) : 0;

    if (event.status === "cancelled") return "Cancelled. Player records are retained for review.";
    if (event.status === "completed") {
      return `Completed with ${active} active signup${active === 1 ? "" : "s"}, ${checkedIn} checked in, and ${centsToMoney(stats.paid_total_cents)} in tracked entry fees.`;
    }
    if (event.status === "check_in") {
      return `Check-in is open. ${checkedIn} of ${active} active player${active === 1 ? "" : "s"} checked in${unpaid ? `, ${unpaid} unpaid` : ""}.`;
    }
    if (event.status === "live") {
      return `Event is live. Check-in rate is ${checkRate}%${capacity > 0 ? ` and capacity is ${fillRate}% filled` : ""}.`;
    }
    if (capacity > 0) {
      return `Scheduled. Capacity is ${fillRate}% filled with ${active} active signup${active === 1 ? "" : "s"}${unpaid ? ` and ${unpaid} unpaid` : ""}.`;
    }
    return `Scheduled. Open capacity with ${active} active signup${active === 1 ? "" : "s"}${unpaid ? ` and ${unpaid} unpaid` : ""}.`;
  }

  function filteredAttendees() {
    const filter = els.attendeeFilter.value;
    const q = String(els.attendeeSearch.value || "").trim().toLowerCase();
    return state.attendees.filter((att) => {
      if (filter === "unpaid" && (att.paid || !ACTIVE_ATTENDEE_STATUSES.has(att.status))) return false;
      if (filter && filter !== "unpaid" && att.status !== filter) return false;
      if (!q) return true;
      return [att.name, att.phone, att.email, att.notes, att.paymentMethod]
        .some((value) => String(value || "").toLowerCase().includes(q));
    });
  }

  function renderAttendees() {
    clearNode(els.attendeeList);
    const stats = currentStats();
    const rows = filteredAttendees();
    els.attendeeCount.textContent = state.selectedEvent
      ? `${rows.length} shown / ${state.attendees.length} total / ${stats.checked_in_count} checked in`
      : "No event selected";

    if (!state.selectedEvent) {
      els.attendeeList.append(textEl("div", "Select an event to manage players.", "small"));
      return;
    }
    if (!rows.length) {
      els.attendeeList.append(textEl("div", "No players match this view.", "small"));
      return;
    }

    rows.forEach((attendee) => {
      const row = document.createElement("article");
      row.className = "attendee-row";

      const top = document.createElement("div");
      top.className = "attendee-top";
      const nameBlock = document.createElement("div");
      nameBlock.append(
        textEl("div", attendee.name, "attendee-name"),
        textEl("div", attendeeMeta(attendee), "attendee-meta")
      );
      const status = textEl("span", statusLabel(attendee.status), `pill ${statusTone(attendee.status)}`);
      top.append(nameBlock, status);

      const paid = attendee.paid
        ? textEl("span", attendee.paymentMethod || "paid", "pill good")
        : textEl("span", "unpaid", "pill warn");

      const actions = document.createElement("div");
      actions.className = "attendee-actions";
      actions.append(paid);
      actions.append(actionButton("Ticket", "btn slim ghost", () => printTickets([attendee])));

      if (attendee.status !== "checked_in") {
        actions.append(actionButton("Check In", "btn slim good", () => updateAttendee(attendee.id, { status: "checked_in" }, "Player checked in.")));
      } else {
        actions.append(actionButton("Undo", "btn slim ghost", () => updateAttendee(attendee.id, { status: "reserved" }, "Check-in undone.")));
      }

      actions.append(
        actionButton(attendee.paid ? "Unpay" : "Paid", "btn slim ghost", () => {
          updateAttendee(attendee.id, {
            paid: !attendee.paid,
            paymentMethod: attendee.paid ? "" : "manual"
          }, attendee.paid ? "Payment cleared." : "Payment marked.");
        })
      );

      if (attendee.status !== "no_show") {
        actions.append(actionButton("No-Show", "btn slim warn", () => updateAttendee(attendee.id, { status: "no_show" }, "Player marked no-show.")));
      }
      if (attendee.status !== "cancelled") {
        actions.append(actionButton("Cancel", "btn slim ghost", () => updateAttendee(attendee.id, { status: "cancelled" }, "Player cancelled.")));
      }
      actions.append(actionButton("Remove", "btn slim danger", () => deleteAttendee(attendee.id)));

      row.append(top, actions);
      els.attendeeList.append(row);
    });
  }

  function attendeeMeta(attendee) {
    const contact = [attendee.phone, attendee.email].filter(Boolean).join(" / ");
    const checked = attendee.checkedInAt ? `Checked ${dateLabel(attendee.checkedInAt)}` : "";
    return [
      contact,
      centsToMoney(attendee.entry_fee_cents),
      checked,
      attendee.notes
    ].filter(Boolean).join(" / ");
  }

  function renderAll() {
    renderEventList();
    renderWorkspace();
    renderAttendees();
  }

  async function loadEvents({ selectId = "", keepSelection = true, silent = false } = {}) {
    if (!silent) setPageStatus("Loading community events...", "warn");
    state.loading = true;
    try {
      const data = await api("/api/community-events");
      state.events = (data.rows || []).map(normalizeEvent).filter(Boolean);
      const existingSelected = keepSelection && state.selectedId && state.events.some((event) => event.id === state.selectedId)
        ? state.selectedId
        : "";
      const nextId = selectId || existingSelected || state.events.find((event) => ACTIVE_EVENT_STATUSES.has(event.status))?.id || state.events[0]?.id || "";
      renderEventList();
      if (nextId) {
        await selectEvent(nextId, { silent: true });
      } else {
        clearSelection();
      }
      if (!silent) setPageStatus("Community events loaded.", "good");
    } catch (err) {
      console.error(err);
      state.events = [];
      clearSelection();
      renderAll();
      setPageStatus(apiErrorMessage(err), "bad");
    } finally {
      state.loading = false;
    }
  }

  async function selectEvent(id, { silent = false } = {}) {
    if (!id) return;
    if (!silent) setPageStatus("Opening event...", "warn");
    try {
      const data = await api(`/api/community-events/${encodeURIComponent(id)}`);
      state.selectedId = id;
      state.selectedEvent = normalizeEvent(data.event);
      state.attendees = (data.attendees || []).map(normalizeAttendee).filter(Boolean);
      renderAll();
      if (!silent) setPageStatus("Event ready.", "good");
      setCheckinStatus("Ready");
      setDetailStatus("Ready");
    } catch (err) {
      console.error(err);
      setPageStatus(apiErrorMessage(err), "bad");
    }
  }

  function clearSelection() {
    state.selectedId = "";
    state.selectedEvent = null;
    state.attendees = [];
    renderAll();
  }

  function collectCreateBody() {
    return {
      title: els.newTitle.value,
      game: els.newGame.value,
      eventType: els.newType.value,
      status: "scheduled",
      startsAt: combineDateTime(els.newDate.value, els.newTime.value),
      capacity: els.newCapacity.value,
      entryFee: els.newEntryFee.value,
      description: els.newNotes.value
    };
  }

  function collectEditBody() {
    return {
      title: els.editTitle.value,
      game: els.editGame.value,
      eventType: els.editType.value,
      startsAt: combineDateTime(els.editDate.value, els.editTime.value),
      capacity: els.editCapacity.value,
      entryFee: els.editEntryFee.value,
      prizePool: els.editPrizePool.value,
      prizeNotes: els.editPrizeNotes.value,
      description: els.editDescription.value
    };
  }

  async function createEvent(event) {
    event.preventDefault();
    const body = collectCreateBody();
    if (!String(body.title || "").trim()) {
      setCreateStatus("Enter an event name.");
      els.newTitle.focus();
      return;
    }
    setCreateStatus("Creating event...");
    setPageStatus("Creating event...", "warn");
    els.btnCreateEvent.disabled = true;
    try {
      const data = await api("/api/community-events", { method: "POST", body: JSON.stringify(body) });
      const created = normalizeEvent(data.event);
      resetCreateForm();
      toggleCreatePanel(false);
      await loadEvents({ selectId: created.id, keepSelection: false, silent: true });
      setPageStatus("Event created.", "good");
      setCreateStatus("Ready");
    } catch (err) {
      console.error(err);
      setPageStatus(apiErrorMessage(err), "bad");
      setCreateStatus(apiErrorMessage(err));
    } finally {
      els.btnCreateEvent.disabled = false;
    }
  }

  async function saveEvent(patch = null, message = "Event saved.") {
    if (!state.selectedId) return;
    const body = patch || collectEditBody();
    if (!patch && !String(body.title || "").trim()) {
      setDetailStatus("Enter an event name.");
      els.editTitle.focus();
      return;
    }
    setDetailStatus("Saving...");
    setPageStatus("Saving event...", "warn");
    try {
      await api(`/api/community-events/${encodeURIComponent(state.selectedId)}`, {
        method: "PUT",
        body: JSON.stringify(body)
      });
      await loadEvents({ selectId: state.selectedId, silent: true });
      setPageStatus(message, "good");
      setDetailStatus("Saved");
    } catch (err) {
      console.error(err);
      setPageStatus(apiErrorMessage(err), "bad");
      setDetailStatus(apiErrorMessage(err));
    }
  }

  async function setEventStatus(status) {
    if (!state.selectedEvent || state.selectedEvent.status === status) return;
    if (status === "cancelled" && !confirm(`Cancel "${state.selectedEvent.title}"?`)) return;
    if (status === "completed" && !confirm(`Complete "${state.selectedEvent.title}"?`)) return;
    await saveEvent({ status }, `${statusLabel(status)} status saved.`);
  }

  async function deleteEvent() {
    if (!state.selectedEvent) return;
    if (!confirm(`Delete "${state.selectedEvent.title}"?`)) return;
    setPageStatus("Deleting event...", "warn");
    try {
      await api(`/api/community-events/${encodeURIComponent(state.selectedId)}`, { method: "DELETE" });
      clearSelection();
      await loadEvents({ keepSelection: false, silent: true });
      setPageStatus("Event deleted.", "good");
    } catch (err) {
      console.error(err);
      setPageStatus(apiErrorMessage(err), "bad");
    }
  }

  function collectAttendeeBody(status) {
    const paymentMethod = els.attendeePayment.value;
    return {
      name: els.attendeeName.value,
      phone: els.attendeePhone.value,
      email: els.attendeeEmail.value,
      status,
      paid: !!paymentMethod,
      paymentMethod,
      entryFee: els.attendeeFee.value,
      notes: els.attendeeNotes.value
    };
  }

  function normalizedName(value) {
    return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  function exactActiveMatch(name) {
    const needle = normalizedName(name);
    if (!needle) return null;
    return state.attendees.find((attendee) => {
      return normalizedName(attendee.name) === needle && ACTIVE_ATTENDEE_STATUSES.has(attendee.status);
    }) || null;
  }

  async function addAttendee(status) {
    if (!state.selectedId) return;
    const body = collectAttendeeBody(status);
    if (!String(body.name || "").trim()) {
      setCheckinStatus("Enter a player name.");
      els.attendeeName.focus();
      return;
    }

    const existing = exactActiveMatch(body.name);
    if (existing && status === "checked_in") {
      const patch = {
        status: "checked_in",
        paid: body.paid || existing.paid,
        paymentMethod: body.paymentMethod || existing.paymentMethod,
        entryFee: body.entryFee || moneyInputFromCents(existing.entry_fee_cents),
        phone: body.phone || existing.phone,
        email: body.email || existing.email,
        notes: body.notes || existing.notes
      };
      await updateAttendee(existing.id, patch, "Existing signup checked in.");
      clearAttendeeForm();
      if (state.selectedEvent && state.selectedEvent.status === "scheduled") {
        await saveEvent({ status: "check_in" }, "Check-in opened.");
      }
      return;
    }
    if (existing && status === "reserved") {
      setCheckinStatus("That player is already on the signup list.");
      return;
    }

    setCheckinStatus(status === "checked_in" ? "Checking in player..." : "Adding signup...");
    setPageStatus(status === "checked_in" ? "Checking in player..." : "Adding signup...", "warn");
    try {
      await api(`/api/community-events/${encodeURIComponent(state.selectedId)}/attendees`, {
        method: "POST",
        body: JSON.stringify(body)
      });
      clearAttendeeForm();
      if (status === "checked_in" && state.selectedEvent && state.selectedEvent.status === "scheduled") {
        await api(`/api/community-events/${encodeURIComponent(state.selectedId)}`, {
          method: "PUT",
          body: JSON.stringify({ status: "check_in" })
        });
      }
      await loadEvents({ selectId: state.selectedId, silent: true });
      setPageStatus(status === "checked_in" ? "Player checked in." : "Signup added.", "good");
      setCheckinStatus("Ready");
    } catch (err) {
      console.error(err);
      setPageStatus(apiErrorMessage(err), "bad");
      setCheckinStatus(apiErrorMessage(err));
    }
  }

  async function updateAttendee(id, patch, message = "Player updated.") {
    if (!state.selectedId) return;
    setPageStatus("Updating player...", "warn");
    try {
      await api(`/api/community-events/${encodeURIComponent(state.selectedId)}/attendees/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(patch)
      });
      await loadEvents({ selectId: state.selectedId, silent: true });
      setPageStatus(message, "good");
      setCheckinStatus("Ready");
    } catch (err) {
      console.error(err);
      setPageStatus(apiErrorMessage(err), "bad");
      setCheckinStatus(apiErrorMessage(err));
    }
  }

  async function deleteAttendee(id) {
    if (!state.selectedId || !confirm("Remove this player from the event?")) return;
    setPageStatus("Removing player...", "warn");
    try {
      await api(`/api/community-events/${encodeURIComponent(state.selectedId)}/attendees/${encodeURIComponent(id)}`, {
        method: "DELETE"
      });
      await loadEvents({ selectId: state.selectedId, silent: true });
      setPageStatus("Player removed.", "good");
    } catch (err) {
      console.error(err);
      setPageStatus(apiErrorMessage(err), "bad");
    }
  }

  function ticketCodeForAttendee(attendee) {
    const id = String(attendee?.id || "").replace(/[^a-z0-9]/gi, "");
    if (!id) return "CE-UNKNOWN";
    return `CE-${id.slice(0, 8).toUpperCase()}-${id.slice(-4).toUpperCase()}`;
  }

  function ticketScanCodeForAttendee(attendee) {
    return `CE:${String(attendee?.id || "").trim()}`;
  }

  function normalizeTicketInput(value) {
    return String(value || "").trim().replace(/\s+/g, "").toUpperCase();
  }

  function findAttendeeByTicket(raw) {
    const code = normalizeTicketInput(raw);
    if (!code) return null;
    return state.attendees.find((attendee) => {
      return [
        ticketCodeForAttendee(attendee),
        attendee.id,
        ticketScanCodeForAttendee(attendee)
      ].some((candidate) => normalizeTicketInput(candidate) === code);
    }) || null;
  }

  async function scanTicket() {
    if (!state.selectedEvent) {
      setCheckinStatus("Select an event before scanning tickets.");
      return;
    }
    const raw = els.ticketScanInput.value;
    const attendee = findAttendeeByTicket(raw);
    if (!attendee) {
      setCheckinStatus("No matching ticket found on this event.");
      els.ticketScanInput.select();
      return;
    }
    if (attendee.status === "checked_in") {
      setPageStatus(`${attendee.name} is already checked in.`, "warn");
      setCheckinStatus("Ticket already checked in.");
      els.ticketScanInput.value = "";
      return;
    }
    const shouldOpenCheckIn = state.selectedEvent.status === "scheduled";
    await updateAttendee(attendee.id, { status: "checked_in" }, `${attendee.name} checked in from ticket.`);
    els.ticketScanInput.value = "";
    if (shouldOpenCheckIn) {
      await saveEvent({ status: "check_in" }, "Check-in opened.");
    }
  }

  function openTicketBuilder() {
    if (!state.selectedEvent) return;
    const url = `ticket-builder.html?eventId=${encodeURIComponent(state.selectedEvent.id)}`;
    const win = window.open(url, "communityTicketBuilder", "width=980,height=760");
    if (!win) {
      setTicketBatchStatus("Ticket Builder window was blocked.");
      setPageStatus("Ticket Builder window was blocked.", "bad");
      return;
    }
    setTicketBatchStatus("Ticket Builder opened.");
  }

  function printTickets(rows = null) {
    if (!state.selectedEvent) return;
    const tickets = (rows || state.attendees.filter((attendee) => ACTIVE_ATTENDEE_STATUSES.has(attendee.status)))
      .filter(Boolean);
    if (!tickets.length) {
      setPageStatus("No active players to print tickets for.", "warn");
      return;
    }

    const popup = window.open("", "_blank", "width=900,height=720");
    if (!popup) {
      setPageStatus("Ticket print window was blocked.", "bad");
      return;
    }

    const event = state.selectedEvent;
    const cards = tickets.map((attendee) => ticketCardHtml(event, attendee)).join("");
    popup.document.open();
    popup.document.write(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(event.title)} Tickets</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 18px;
      color: #111827;
      background: #f5f7fb;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .sheet {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .ticket {
      min-height: 250px;
      break-inside: avoid;
      border: 2px solid #111827;
      border-radius: 8px;
      background: white;
      padding: 12px;
      display: grid;
      gap: 8px;
    }
    .brand {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      border-bottom: 1px solid #d1d5db;
      padding-bottom: 7px;
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    h1, h2, p { margin: 0; letter-spacing: 0; }
    h1 { font-size: 16px; line-height: 1.2; }
    h2 { font-size: 22px; line-height: 1.15; overflow-wrap: anywhere; }
    .meta { color: #4b5563; font-size: 12px; line-height: 1.35; }
    .barcode {
      width: 100%;
      min-height: 78px;
      display: grid;
      place-items: center;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      padding: 6px;
    }
    .code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 13px;
      font-weight: 800;
      text-align: center;
      letter-spacing: 0;
    }
    @media print {
      body { background: white; padding: 0; }
      .sheet { gap: 0; grid-template-columns: repeat(2, 1fr); }
      .ticket { margin: 0.15in; }
    }
  </style>
</head>
<body>
  <section class="sheet">${cards}</section>
  <script>
    window.addEventListener("load", () => setTimeout(() => window.print(), 180));
  </script>
</body>
</html>`);
    popup.document.close();
    setPageStatus(`${tickets.length} ticket${tickets.length === 1 ? "" : "s"} ready to print.`, "good");
  }

  function ticketCardHtml(event, attendee) {
    const code = ticketCodeForAttendee(attendee);
    const contact = [attendee.phone, attendee.email].filter(Boolean).join(" / ");
    return `<article class="ticket">
  <div class="brand">
    <span>VaultCore Community Event</span>
    <span>${escapeHtml(statusLabel(attendee.status))}</span>
  </div>
  <div>
    <h1>${escapeHtml(event.title)}</h1>
    <p class="meta">${escapeHtml(dateLabel(event.startsAt))} / ${escapeHtml(event.game || "Other")} / ${escapeHtml(event.eventType || "Event")}</p>
  </div>
  <div>
    <h2>${escapeHtml(attendee.name)}</h2>
    <p class="meta">${escapeHtml(contact || "No contact")} / ${escapeHtml(centsToMoney(attendee.entry_fee_cents))} / ${attendee.paid ? "Paid" : "Unpaid"}</p>
  </div>
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
        if (index % 2 === 0 && width > 0) {
          rects.push(`<rect x="${x}" y="0" width="${width}" height="${height}" />`);
        }
        x += width;
      });
    });
    const totalWidth = x + 10;
    return `<svg viewBox="0 0 ${totalWidth} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeHtml(payload)}"><rect width="${totalWidth}" height="${height}" fill="#fff" />${rects.join("")}</svg>`;
  }

  function clearAttendeeForm() {
    els.attendeeName.value = "";
    els.attendeePhone.value = "";
    els.attendeeEmail.value = "";
    els.attendeePayment.value = "";
    els.attendeeNotes.value = "";
  }

  function resetCreateForm() {
    els.newTitle.value = "";
    els.newCapacity.value = "";
    els.newEntryFee.value = "";
    els.newNotes.value = "";
    setDefaultCreateDate();
  }

  function setDefaultCreateDate() {
    const now = new Date();
    els.newDate.value = ymd(now);
    els.newTime.value = defaultTime();
  }

  function toggleCreatePanel(open = null) {
    const shouldOpen = open === null ? els.createPanel.classList.contains("hidden") : open;
    els.createPanel.classList.toggle("hidden", !shouldOpen);
    if (shouldOpen) {
      setDefaultCreateDate();
      setCreateStatus("Ready");
      setTimeout(() => els.newTitle.focus(), 0);
    }
  }

  function exportAttendees() {
    if (!state.selectedEvent) return;
    const headers = ["event", "name", "phone", "email", "status", "paid", "payment", "entry_fee", "notes"];
    const rows = state.attendees.map((attendee) => ({
      event: state.selectedEvent.title,
      name: attendee.name,
      phone: attendee.phone,
      email: attendee.email,
      status: statusLabel(attendee.status),
      paid: attendee.paid ? "yes" : "no",
      payment: attendee.paymentMethod || "",
      entry_fee: moneyInputFromCents(attendee.entry_fee_cents),
      notes: attendee.notes || ""
    }));
    const csv = [
      headers.join(","),
      ...rows.map((row) => headers.map((key) => csvCell(row[key])).join(","))
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${safeFileName(state.selectedEvent.title || "community-event")}-players.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function csvCell(value) {
    return `"${String(value ?? "").replace(/"/g, '""')}"`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function safeFileName(value) {
    return String(value || "community-event")
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "community-event";
  }

  function wireEvents() {
    els.btnRefreshEvents.addEventListener("click", () => loadEvents({ keepSelection: true }));
    els.btnToggleCreate.addEventListener("click", () => toggleCreatePanel());
    els.btnCancelCreate.addEventListener("click", () => toggleCreatePanel(false));
    els.createPanel.addEventListener("submit", createEvent);
    els.eventSearch.addEventListener("input", renderEventList);
    els.eventStatusFilter.addEventListener("change", renderEventList);
    els.btnSaveEvent.addEventListener("click", () => saveEvent());
    els.btnDeleteEvent.addEventListener("click", deleteEvent);
    els.statusStrip.querySelectorAll("[data-status]").forEach((btn) => {
      btn.addEventListener("click", () => setEventStatus(btn.dataset.status));
    });
    els.checkinForm.addEventListener("submit", (event) => {
      event.preventDefault();
      addAttendee("checked_in");
    });
    els.ticketScanInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        scanTicket();
      }
    });
    els.btnAddSignup.addEventListener("click", () => addAttendee("reserved"));
    els.attendeeSearch.addEventListener("input", renderAttendees);
    els.attendeeFilter.addEventListener("change", renderAttendees);
    els.btnOpenTicketBuilder.addEventListener("click", openTicketBuilder);
    els.btnPrintTicketsInline.addEventListener("click", () => printTickets());
    els.btnPrintTickets.addEventListener("click", () => printTickets());
    els.btnExportAttendees.addEventListener("click", exportAttendees);
  }

  function boot() {
    bootEls();
    setDefaultCreateDate();
    wireEvents();
    renderAll();
    loadEvents({ keepSelection: false });
  }

  window.addEventListener("error", (event) => {
    if (!els.pageStatus) return;
    setPageStatus("Community Events hit a page error.", "bad");
    setCreateStatus(event.message || "Page error.");
  });

  window.addEventListener("unhandledrejection", (event) => {
    if (!els.pageStatus) return;
    setPageStatus(apiErrorMessage(event.reason), "bad");
  });

  window.addEventListener("message", (event) => {
    if (!event?.data || event.data.type !== "community-events:tickets-created") return;
    if (state.selectedId) {
      loadEvents({ selectId: state.selectedId, silent: true });
      setTicketBatchStatus("Tickets updated.");
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
