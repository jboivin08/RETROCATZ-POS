// src/renderer/index.js
// Handles dashboard layout switching + basic dashboard logic

(function () {
  document.addEventListener("DOMContentLoaded", () => {
    const root = document.body;
    const layoutSelect = document.getElementById("layout-select");
    const STORAGE_KEY_LAYOUT = "rc_dashboard_layout";
    const STORAGE_KEY_NOTES = "rc_store_notes";

    /* ---------------- LAYOUT SWITCHING ---------------- */

    function setLayout(mode) {
      const value = String(mode || "1");
      root.setAttribute("data-layout", value);
      try {
        localStorage.setItem(STORAGE_KEY_LAYOUT, value);
      } catch (err) {
        console.warn("[RetroCatz] Could not persist layout:", err);
      }
      if (layoutSelect && layoutSelect.value !== value) {
        layoutSelect.value = value;
      }
    }

    // Load saved layout
    let savedLayout = "1";
    try {
      const stored = localStorage.getItem(STORAGE_KEY_LAYOUT);
      if (stored && ["1", "2", "3", "4", "5"].includes(stored)) {
        savedLayout = stored;
      }
    } catch {
      /* ignore */
    }
    if (layoutSelect) {
      layoutSelect.value = savedLayout;
      layoutSelect.addEventListener("change", (e) => {
        const value = e.target.value;
        if (["1", "2", "3", "4", "5"].includes(value)) {
          setLayout(value);
        }
      });
    }
    setLayout(savedLayout);

    // Keyboard shortcuts 1–5
    document.addEventListener("keydown", (e) => {
      const tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key >= "1" && e.key <= "5") {
        setLayout(e.key);
      }
    });

    /* ---------------- HERO TIME ---------------- */

    const heroTimeEl = document.getElementById("hero-time");
    if (heroTimeEl) {
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, "0");
      const mm = String(now.getMinutes()).padStart(2, "0");
      heroTimeEl.textContent = `${hh}:${mm}`;
    }

    /* ---------------- DASHBOARD DATA ---------------- */

    const heroInventoryCount = document.getElementById("hero-inventory-count");
    const heroLowStock = document.getElementById("hero-low-stock");
    const heroReorderCount = document.getElementById("hero-reorder-count");
    const heroReorderCard = document.getElementById("hero-reorder-card");
    const REORDER_KEY = "rc_reorder_flags";
    const STOCK_FILTER_KEY = "rc_inventory_stock_filter";
    const activityList = document.getElementById("recent-activity-list");
    const hotSheetList = document.getElementById("hot-sheet-list");

    function getReorderCount() {
      try {
        const raw = localStorage.getItem(REORDER_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr.length : 0;
      } catch {
        return 0;
      }
    }

    function refreshReorderFlagCount() {
      if (!heroReorderCount) return;
      heroReorderCount.textContent = String(getReorderCount());
    }

    function renderActivity(rows) {
      if (!activityList) return;
      activityList.innerHTML = "";

      if (!rows || !rows.length) {
        const li = document.createElement("li");
        li.className = "hint";
        li.textContent = "No items yet. Add your first item to see activity.";
        activityList.appendChild(li);
        return;
      }

      rows.slice(0, 6).forEach((item) => {
        const li = document.createElement("li");
        const platform = item.platform ? ` (${item.platform})` : "";
        li.textContent = `Added: ${item.title}${platform} • SKU ${item.sku}`;
        activityList.appendChild(li);
      });
    }

    function renderHotSheet(rows) {
      if (!hotSheetList) return;
      hotSheetList.innerHTML = "";

      if (!rows || !rows.length) {
        const li = document.createElement("li");
        li.className = "hint";
        li.textContent = "Hot sheet will populate as inventory grows.";
        hotSheetList.appendChild(li);
        return;
      }

      // Super simple preview: top 3 by price
      const sorted = [...rows].sort((a, b) => (b.price || 0) - (a.price || 0));
      sorted.slice(0, 3).forEach((item) => {
        const li = document.createElement("li");
        const price = (item.price && item.price > 0) ? `$${item.price.toFixed(2)}` : "$--";
        li.textContent = `${item.title} • ${price}`;
        hotSheetList.appendChild(li);
      });
    }

    function refreshDashboardFromItems(rows) {
      if (heroInventoryCount) {
        heroInventoryCount.textContent = rows.length.toString();
      }
      if (heroLowStock) {
        const lowCount = rows.filter((r) => Number(r.qty || 0) <= 1).length;
        heroLowStock.textContent = lowCount.toString();
      }

      renderActivity(rows);
      renderHotSheet(rows);
    }

    const SESSION_KEY = "rc_session_id";
    const API_BASE = "http://127.0.0.1:5175";

    const btnLogout = document.getElementById("btnLogout");
    if (btnLogout) {
      btnLogout.addEventListener("click", async () => {
        const sid = localStorage.getItem(SESSION_KEY) || "";
        try {
          await fetch("http://127.0.0.1:5175/api/logout", {
            method: "POST",
            headers: { "Content-Type": "application/json", "rc_session_id": sid }
          });
        } catch (err) {
          console.warn("[RetroCatz] Logout failed:", err);
        } finally {
          localStorage.removeItem(SESSION_KEY);
          window.location.href = "login.html";
        }
      });
    }

    window.addEventListener("focus", () => {
      refreshReorderFlagCount();
    });

    function getAuthHeaders() {
      const sid = localStorage.getItem(SESSION_KEY) || "";
      return sid ? { "rc_session_id": sid } : {};
    }

    async function fetchJson(url) {
      const res = await fetch(url, { headers: getAuthHeaders() });
      if (res.status === 401) {
        window.location.href = "login.html";
        throw new Error("unauthorized");
      }
      return res.json();
    }

    function fetchItemsForDashboard() {
      const sid = localStorage.getItem(SESSION_KEY) || "";
      const headers = sid ? { "rc_session_id": sid } : {};
      fetchJson(API_BASE + "/api/items")
        .then((rows) => {
          if (!Array.isArray(rows)) return;
          refreshDashboardFromItems(rows);
          window.__RC_ITEMS_CACHE = rows; // simple cache for quick scan
        })
        .catch((err) => {
          console.warn("[RetroCatz] Could not load items for dashboard:", err);
        });
    }

    fetchItemsForDashboard();
    refreshReorderFlagCount();

    if (heroReorderCard) {
      heroReorderCard.addEventListener("click", () => {
        try { localStorage.setItem(STOCK_FILTER_KEY, "reorder"); } catch {}
        window.location.href = "inventory.html";
      });
    }

    /* ---------------- QUICK SCAN ---------------- */

    const quickScanInput = document.getElementById("quick-scan-input");
    const quickScanResult = document.getElementById("quick-scan-result");

    function showQuickScanMessage(text, isError = false) {
      if (!quickScanResult) return;
      quickScanResult.textContent = text;
      quickScanResult.style.color = isError ? "#fca5a5" : "#a5b4fc";
    }

    function handleQuickScan(value) {
      const sku = String(value || "").trim();
      if (!sku) {
        showQuickScanMessage("Please scan or enter a SKU.", true);
        return;
      }

      const rows = Array.isArray(window.__RC_ITEMS_CACHE) ? window.__RC_ITEMS_CACHE : [];

      if (!rows.length) {
        showQuickScanMessage("No inventory loaded yet. Try adding an item first.", true);
        return;
      }

      const match = rows.find((r) => String(r.sku) === sku);
      if (!match) {
        showQuickScanMessage(
          `No match found for SKU ${sku}. You can create it on the Add Item screen.`,
          true
        );
        return;
      }

      const platform = match.platform ? ` (${match.platform})` : "";
      showQuickScanMessage(`Found: ${match.title}${platform} • Qty: ${match.qty} • Price: $${match.price?.toFixed?.(2) || "--"}`);

      // Simple: offer a link to open inventory page
      if (quickScanResult) {
        const link = document.createElement("a");
        link.href = "inventory.html";
        link.textContent = "Open Inventory";
        link.style.display = "block";
        link.style.marginTop = "4px";
        link.style.color = "#38bdf8";
        link.style.textDecoration = "underline";
        quickScanResult.appendChild(link);
      }
    }

    if (quickScanInput) {
      quickScanInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          handleQuickScan(quickScanInput.value);
        }
      });
    }

    /* ---------------- QUICK ACTION BUTTONS ---------------- */

    document.querySelectorAll(".quick-btn[data-nav]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const href = btn.getAttribute("data-nav");
        if (href) {
          window.location.href = href;
        }
      });
    });

    /* ---------------- NOTES PERSISTENCE ---------------- */

    const notesEl = document.getElementById("store-notes");
    if (notesEl) {
      try {
        const savedNotes = localStorage.getItem(STORAGE_KEY_NOTES);
        if (savedNotes) {
          notesEl.value = savedNotes;
        }
      } catch {
        /* ignore */
      }

      notesEl.addEventListener("input", () => {
        try {
          localStorage.setItem(STORAGE_KEY_NOTES, notesEl.value || "");
        } catch (err) {
          console.warn("[RetroCatz] Could not save notes:", err);
        }
      });
    }

    /* ---------------- DASHBOARD HEATMAPS ---------------- */

    const heatmapCards = Array.from(document.querySelectorAll(".heatmap-card"));
    const heatmapModalRoot = document.getElementById("heatmap-modal-root");
    const heatmapCloseBtn = document.getElementById("heatmap-close-btn");
    const heatmapRangeSel = document.getElementById("heatmap-range");
    const heatmapTitleEl = document.getElementById("heatmap-modal-title");
    const heatmapSubEl = document.getElementById("heatmap-modal-sub");
    const heatmapSummaryEl = document.getElementById("heatmap-modal-summary");
    const quadrantPoints = document.getElementById("quadrant-points");
    const quadLabels = {
      tl: document.getElementById("quad-label-tl"),
      tr: document.getElementById("quad-label-tr"),
      bl: document.getElementById("quad-label-bl"),
      br: document.getElementById("quad-label-br")
    };
    const axisLabels = {
      xLow: document.getElementById("quad-x-low"),
      xHigh: document.getElementById("quad-x-high"),
      yLow: document.getElementById("quad-y-low"),
      yHigh: document.getElementById("quad-y-high")
    };

    const HEATMAP_CONFIG = {
      sales: {
        chipOptions: ["7 days", "30 days", "today"],
        rangeMap: { "7 days": "7d", "30 days": "30d", today: "today" },
        dims: { rows: 4, cols: 7 },
        summaryEl: document.getElementById("mini-hm-sales-summary"),
        gridEl: document.getElementById("mini-hm-sales"),
        endpoint: "heatmap",
        modalSub: "Which items bring customers back? Popularity vs repeat sales.",
        axes: {
          xLow: "Low popularity",
          xHigh: "High popularity",
          yLow: "Low repeat",
          yHigh: "High repeat",
          quads: {
            tl: "Hidden Gems",
            tr: "Greatest Hits",
            bl: "Underperformers",
            br: "One Hit Wonders"
          }
        }
      },
      category: {
        chipOptions: ["7 days", "30 days", "today"],
        rangeMap: { "7 days": "7d", "30 days": "30d", today: "today" },
        dims: { rows: 3, cols: 6 },
        summaryEl: document.getElementById("mini-hm-category-summary"),
        gridEl: document.getElementById("mini-hm-category"),
        endpoint: "category-movement",
        modalSub: "Categories by total sales vs profit margin.",
        axes: {
          xLow: "Low sales",
          xHigh: "High sales",
          yLow: "Low margin",
          yHigh: "High margin",
          quads: {
            tl: "High-margin sleepers",
            tr: "Core profit engines",
            bl: "Low value",
            br: "Volume, low margin"
          }
        }
      },
      inventory: {
        chipOptions: ["by platform", "all"],
        rangeMap: { "by platform": "all", all: "all" },
        dims: { rows: 3, cols: 4 },
        summaryEl: document.getElementById("mini-hm-inventory-summary"),
        gridEl: document.getElementById("mini-hm-inventory"),
        endpoint: "inventory-health",
        modalSub: "Platforms by sell-through vs stock level.",
        axes: {
          xLow: "Overstocked",
          xHigh: "Lean / scarce",
          yLow: "Slow sell-through",
          yHigh: "Fast sell-through",
          quads: {
            tl: "Healthy movers",
            tr: "Hot & scarce",
            bl: "Dead stock risk",
            br: "Shortage risk"
          }
        }
      },
      dormant: {
        chipOptions: ["age bands", "60 days", "90 days", "180 days"],
        rangeMap: { "age bands": "60d", "60 days": "60d", "90 days": "90d", "180 days": "180d" },
        dims: { rows: 2, cols: 5 },
        summaryEl: document.getElementById("mini-hm-dormant-summary"),
        gridEl: document.getElementById("mini-hm-dormant"),
        endpoint: "dormant-inventory",
        modalSub: "How long items sit vs discount depth.",
        axes: {
          xLow: "Small discount",
          xHigh: "Heavy discount",
          yLow: "Move slowly",
          yHigh: "Move quickly",
          quads: {
            tl: "Gently cut",
            tr: "Discounts that work",
            bl: "Price traps",
            br: "Fire sale heroes"
          }
        }
      },
      tradein: {
        chipOptions: ["30 days", "7 days"],
        rangeMap: { "30 days": "30d", "7 days": "7d" },
        dims: { rows: 2, cols: 5 },
        summaryEl: document.getElementById("mini-hm-tradein-summary"),
        gridEl: document.getElementById("mini-hm-tradein"),
        endpoint: "tradein-flow",
        modalSub: "Trade-ins by frequency vs resale velocity.",
        axes: {
          xLow: "Few trades",
          xHigh: "Many trades",
          yLow: "Hard to resell",
          yHigh: "Easy to resell",
          quads: {
            tl: "Occasional but strong",
            tr: "Trade-in goldmine",
            bl: "Problem trades",
            br: "Churn machines"
          }
        }
      }
    };

    const heatmapState = {};
    heatmapCards.forEach((card) => {
      const kind = card.getAttribute("data-heatmap") || "sales";
      const chipEl = card.querySelector(".heatmap-chip");
      const cfg = HEATMAP_CONFIG[kind];
      if (!cfg || !chipEl) return;
      heatmapState[kind] = { chipEl, active: chipEl.textContent.trim() };
      chipEl.style.cursor = "pointer";
      chipEl.addEventListener("click", (e) => {
        e.stopPropagation();
        cycleChip(kind);
      });
    });

    function cycleChip(kind) {
      const cfg = HEATMAP_CONFIG[kind];
      const state = heatmapState[kind];
      if (!cfg || !state) return;
      const opts = cfg.chipOptions || [];
      const idx = Math.max(0, opts.indexOf(state.active));
      const next = opts[(idx + 1) % opts.length];
      state.active = next;
      state.chipEl.textContent = next;
      updateChipActive(kind);
      loadHeatmapMini(kind);
      if (currentHeatmapKind === kind) {
        updateModalRangeOptions(kind);
        loadHeatmapDetail(kind);
      }
    }

    function buildEmptyLevels(rows, cols) {
      return new Array(rows * cols).fill(0);
    }

    function applyMiniGrid(kind, levels) {
      const cfg = HEATMAP_CONFIG[kind];
      if (!cfg || !cfg.gridEl) return;
      const cells = Array.from(cfg.gridEl.querySelectorAll(".heatmap-cell"));
      const target = levels && levels.length ? levels : buildEmptyLevels(cfg.dims.rows, cfg.dims.cols);
      for (let i = 0; i < cells.length; i++) {
        const lvl = Math.max(0, Math.min(3, Number(target[i] || 0)));
        cells[i].className = "heatmap-cell level-" + lvl;
      }
    }

    async function loadHeatmapMini(kind) {
      const cfg = HEATMAP_CONFIG[kind];
      if (!cfg) return;
      const state = heatmapState[kind];
      const active = state?.active || cfg.chipOptions?.[0] || "";
      const param = cfg.rangeMap?.[active] || active || "7d";
      let url = `${API_BASE}/api/dashboard/${cfg.endpoint}`;
      if (cfg.endpoint === "inventory-health") {
        url += `?platform=${encodeURIComponent(param || "all")}`;
      } else if (cfg.endpoint === "dormant-inventory") {
        url += `?ageBand=${encodeURIComponent(param || "60d")}`;
      } else {
        url += `?range=${encodeURIComponent(param || "7d")}`;
      }

      try {
        const data = await fetchJson(url);
        const levels = data?.grid?.levels || [];
        applyMiniGrid(kind, levels);
        if (cfg.summaryEl) {
          cfg.summaryEl.textContent = data?.summary || "No data yet";
        }
      } catch (err) {
        console.warn("[Dashboard] heatmap load failed:", err);
        applyMiniGrid(kind, buildEmptyLevels(cfg.dims.rows, cfg.dims.cols));
        if (cfg.summaryEl) cfg.summaryEl.textContent = "No data yet";
      }

      if (kind === "sales" || kind === "category" || kind === "tradein") {
        if (param === "7d" || param === "30d") {
          loadWidgetsRange(param);
          loadDashboardSummary(param);
        }
      }
    }

    let currentHeatmapKind = null;

    function clearPoints() {
      if (!quadrantPoints) return;
      while (quadrantPoints.firstChild) quadrantPoints.removeChild(quadrantPoints.firstChild);
    }

    function renderPoints(points) {
      if (!quadrantPoints) return;
      clearPoints();
      (points || []).forEach((p) => {
        const dot = document.createElement("div");
        dot.className = "quadrant-point" + (p.secondary ? " secondary" : "");
        const x = Math.max(0.02, Math.min(0.98, Number(p.x || 0)));
        const y = Math.max(0.02, Math.min(0.98, Number(p.y || 0)));
        dot.style.left = x * 100 + "%";
        dot.style.bottom = y * 100 + "%";
        const tip = document.createElement("div");
        tip.className = "heatmap-tooltip";
        tip.innerHTML =
          "<strong>" +
          (p.name || "Point") +
          "</strong><br><span style=\"color:#9ca3af\">" +
          (p.detail || "Coming soon") +
          "</span>";
        dot.appendChild(tip);
        quadrantPoints.appendChild(dot);
      });
    }

    function updateModalRangeOptions(kind) {
      if (!heatmapRangeSel) return;
      const cfg = HEATMAP_CONFIG[kind];
      if (!cfg) return;
      heatmapRangeSel.innerHTML = "";
      const opts = cfg.chipOptions || ["7 days"];
      opts.forEach((label) => {
        const opt = document.createElement("option");
        opt.value = cfg.rangeMap?.[label] || label;
        opt.textContent = label;
        heatmapRangeSel.appendChild(opt);
      });
      const state = heatmapState[kind];
      const active = state?.active || opts[0];
      heatmapRangeSel.value = cfg.rangeMap?.[active] || active;
    }

    function updateChipActive(kind) {
      const cfg = HEATMAP_CONFIG[kind];
      const state = heatmapState[kind];
      if (!cfg || !state) return;
      state.chipEl.classList.add("active");
    }

    function initChipActive() {
      Object.keys(heatmapState).forEach((k) => {
        heatmapState[k].chipEl.classList.add("active");
      });
    }

    async function loadHeatmapDetail(kind) {
      const cfg = HEATMAP_CONFIG[kind];
      if (!cfg) return;
      const state = heatmapState[kind];
      const active = state?.active || cfg.chipOptions?.[0] || "";
      const param = cfg.rangeMap?.[active] || active || "7d";
      let url = `${API_BASE}/api/dashboard/${cfg.endpoint}`;
      if (cfg.endpoint === "inventory-health") {
        url += `?platform=${encodeURIComponent(param || "all")}`;
      } else if (cfg.endpoint === "dormant-inventory") {
        url += `?ageBand=${encodeURIComponent(param || "60d")}`;
      } else {
        url += `?range=${encodeURIComponent(param || "7d")}`;
      }

      try {
        const data = await fetchJson(url);
        if (heatmapSummaryEl) {
          heatmapSummaryEl.textContent = data?.summary || "Coming soon";
        }
        renderPoints(data?.points || []);
      } catch (err) {
        console.warn("[Dashboard] heatmap detail load failed:", err);
        if (heatmapSummaryEl) heatmapSummaryEl.textContent = "Coming soon";
        renderPoints([]);
      }
    }

    function applyModalConfig(kind) {
      const cfg = HEATMAP_CONFIG[kind] || HEATMAP_CONFIG.sales;
      if (heatmapSubEl) heatmapSubEl.textContent = cfg.modalSub || "";
      if (axisLabels.xLow) axisLabels.xLow.textContent = cfg.axes.xLow;
      if (axisLabels.xHigh) axisLabels.xHigh.textContent = cfg.axes.xHigh;
      if (axisLabels.yLow) axisLabels.yLow.textContent = cfg.axes.yLow;
      if (axisLabels.yHigh) axisLabels.yHigh.textContent = cfg.axes.yHigh;
      if (quadLabels.tl) quadLabels.tl.textContent = cfg.axes.quads.tl;
      if (quadLabels.tr) quadLabels.tr.textContent = cfg.axes.quads.tr;
      if (quadLabels.bl) quadLabels.bl.textContent = cfg.axes.quads.bl;
      if (quadLabels.br) quadLabels.br.textContent = cfg.axes.quads.br;
    }

    function openHeatmap(kind, title) {
      currentHeatmapKind = kind;
      if (heatmapTitleEl) heatmapTitleEl.textContent = title || "Heatmap Detail";
      updateModalRangeOptions(kind);
      applyModalConfig(kind);
      loadHeatmapDetail(kind);
      if (heatmapModalRoot) heatmapModalRoot.style.display = "block";
    }

    function closeHeatmap() {
      if (heatmapModalRoot) heatmapModalRoot.style.display = "none";
      currentHeatmapKind = null;
    }

    heatmapCards.forEach((card) => {
      card.addEventListener("click", () => {
        const kind = card.getAttribute("data-heatmap") || "sales";
        const niceTitle =
          card.getAttribute("data-heatmap-title") ||
          card.querySelector(".heatmap-title")?.textContent ||
          "Heatmap Detail";
        openHeatmap(kind, niceTitle);
      });
      const expand = card.querySelector(".heatmap-expand");
      if (expand) {
        expand.addEventListener("click", (e) => {
          e.stopPropagation();
          const kind = card.getAttribute("data-heatmap") || "sales";
          const niceTitle =
            card.getAttribute("data-heatmap-title") ||
            card.querySelector(".heatmap-title")?.textContent ||
            "Heatmap Detail";
          openHeatmap(kind, niceTitle);
        });
      }
    });

    if (heatmapCloseBtn) heatmapCloseBtn.addEventListener("click", closeHeatmap);
    if (heatmapModalRoot) {
      heatmapModalRoot.addEventListener("click", (e) => {
        if (e.target === heatmapModalRoot || e.target.classList.contains("heatmap-modal-backdrop")) {
          closeHeatmap();
        }
      });
    }
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeHeatmap();
    });

    if (heatmapRangeSel) {
      heatmapRangeSel.addEventListener("change", () => {
        if (!currentHeatmapKind) return;
        const cfg = HEATMAP_CONFIG[currentHeatmapKind];
        if (!cfg) return;
        const label = Array.from(heatmapRangeSel.options).find((o) => o.value === heatmapRangeSel.value)?.textContent;
        if (label && heatmapState[currentHeatmapKind]) {
          heatmapState[currentHeatmapKind].active = label;
          heatmapState[currentHeatmapKind].chipEl.textContent = label;
          updateChipActive(currentHeatmapKind);
        }
        loadHeatmapDetail(currentHeatmapKind);
        loadHeatmapMini(currentHeatmapKind);
        const param = cfg.rangeMap?.[label] || label;
        if (param === "7d" || param === "30d") {
          loadWidgetsRange(param);
          loadDashboardSummary(param);
        }
      });
    }

    heatmapCards.forEach((card) => {
      const kind = card.getAttribute("data-heatmap") || "sales";
      loadHeatmapMini(kind);
    });
    initChipActive();

    /* ---------------- DASHBOARD SUMMARY ---------------- */

    const heroSalesToday = document.getElementById("hero-sales-today");
    const statsSales = document.getElementById("stats-sales");
    const statsItemsSold = document.getElementById("stats-items-sold");
    const statsMargin = document.getElementById("stats-margin");

    function money(v) {
      const n = Number(v || 0);
      return "$" + n.toFixed(2);
    }

    async function loadDashboardSummary(range = "today") {
      try {
        const data = await fetchJson(`${API_BASE}/api/dashboard/summary?range=${encodeURIComponent(range)}`);
        if (heroInventoryCount) heroInventoryCount.textContent = String(data?.inventoryTotalItems ?? "--");
        if (heroLowStock) heroLowStock.textContent = String(data?.lowStockCount ?? "--");
        if (heroSalesToday) heroSalesToday.textContent = money(data?.todaySalesTotal ?? 0);
        if (statsSales) statsSales.textContent = money(data?.todaySalesTotal ?? 0);
        if (statsItemsSold) statsItemsSold.textContent = String(data?.itemsSold ?? "--");
        if (statsMargin) statsMargin.textContent = data?.marginPct != null ? `${data.marginPct.toFixed(1)}%` : "--%";
      } catch (err) {
        console.warn("[Dashboard] summary load failed:", err);
      }
    }

    loadDashboardSummary("today");
    loadWidgetsRange("7d");

    async function loadWidgetsRange(range) {
      try {
        const data = await fetchJson(`${API_BASE}/api/dashboard/widgets?range=${encodeURIComponent(range)}`);
        if (data?.weeklySalesHeatmap) {
          applyMiniGrid("sales", data.weeklySalesHeatmap.grid?.levels || []);
          const cfg = HEATMAP_CONFIG.sales;
          if (cfg?.summaryEl) cfg.summaryEl.textContent = data.weeklySalesHeatmap.summary || "No data yet";
        }
        if (data?.categoryMovement) {
          applyMiniGrid("category", data.categoryMovement.grid?.levels || []);
          const cfg = HEATMAP_CONFIG.category;
          if (cfg?.summaryEl) cfg.summaryEl.textContent = data.categoryMovement.summary || "No data yet";
        }
        if (data?.inventoryHealth) {
          applyMiniGrid("inventory", data.inventoryHealth.grid?.levels || []);
          const cfg = HEATMAP_CONFIG.inventory;
          if (cfg?.summaryEl) cfg.summaryEl.textContent = data.inventoryHealth.summary || "No data yet";
        }
        if (data?.dormantInventory) {
          applyMiniGrid("dormant", data.dormantInventory.grid?.levels || []);
          const cfg = HEATMAP_CONFIG.dormant;
          if (cfg?.summaryEl) cfg.summaryEl.textContent = data.dormantInventory.summary || "No data yet";
        }
        if (data?.tradeInFlow) {
          applyMiniGrid("tradein", data.tradeInFlow.grid?.levels || []);
          const cfg = HEATMAP_CONFIG.tradein;
          if (cfg?.summaryEl) cfg.summaryEl.textContent = data.tradeInFlow.summary || "No data yet";
        }
      } catch (err) {
        console.warn("[Dashboard] widgets load failed:", err);
      }
    }

    console.log("[RetroCatz] Dashboard initialized.");
  });
})();
