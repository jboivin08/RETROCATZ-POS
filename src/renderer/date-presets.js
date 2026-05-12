(function () {
  const DAY_MS = 24 * 60 * 60 * 1000;

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function localDay(date = new Date()) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function parseInputDate(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return localDay();
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }

  function formatDate(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function addDays(date, days) {
    const d = localDay(date);
    d.setDate(d.getDate() + days);
    return d;
  }

  function startOfWeek(date) {
    const d = localDay(date);
    d.setDate(d.getDate() - d.getDay());
    return d;
  }

  function endOfWeek(date) {
    return addDays(startOfWeek(date), 6);
  }

  function startOfMonth(date) {
    const d = localDay(date);
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }

  function endOfMonth(date) {
    const d = localDay(date);
    return new Date(d.getFullYear(), d.getMonth() + 1, 0);
  }

  const today = () => localDay();

  const rangePresets = {
    today: {
      label: "Today",
      get: () => {
        const d = today();
        return [d, d];
      }
    },
    yesterday: {
      label: "Yesterday",
      get: () => {
        const d = addDays(today(), -1);
        return [d, d];
      }
    },
    last7: {
      label: "Last 7",
      get: () => [addDays(today(), -6), today()]
    },
    thisWeek: {
      label: "This Week",
      get: () => [startOfWeek(today()), today()]
    },
    lastWeek: {
      label: "Last Week",
      get: () => {
        const end = addDays(startOfWeek(today()), -1);
        return [startOfWeek(end), end];
      }
    },
    last30: {
      label: "Last 30",
      get: () => [addDays(today(), -29), today()]
    },
    thisMonth: {
      label: "This Month",
      get: () => [startOfMonth(today()), today()]
    },
    lastMonth: {
      label: "Last Month",
      get: () => {
        const end = addDays(startOfMonth(today()), -1);
        return [startOfMonth(end), endOfMonth(end)];
      }
    }
  };

  const singlePresets = {
    today: {
      label: "Today",
      get: () => today()
    },
    yesterday: {
      label: "Yesterday",
      get: () => addDays(today(), -1)
    },
    previous: {
      label: "Previous Day",
      get: (currentValue) => addDays(parseInputDate(currentValue), -1)
    },
    next: {
      label: "Next Day",
      get: (currentValue) => addDays(parseInputDate(currentValue), 1)
    }
  };

  function ensureStyles() {
    if (document.getElementById("vaultcore-date-preset-styles")) return;
    const style = document.createElement("style");
    style.id = "vaultcore-date-preset-styles";
    style.textContent = `
      .date-preset-bar {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
        margin-top: 8px;
      }
      .date-preset-label {
        font-size: 12px;
        color: var(--muted, #9ca3af);
        margin-right: 2px;
      }
      .date-preset-btn {
        min-height: 30px;
        padding: 5px 9px;
        border: 1px solid var(--border, #334155);
        border-radius: 8px;
        background: transparent;
        color: var(--text, #e5e7eb);
        cursor: pointer;
        font-size: 12px;
        white-space: nowrap;
      }
      .date-preset-btn:hover {
        border-color: #64748b;
        box-shadow: 0 0 0 1px rgba(148, 163, 184, 0.25);
      }
      .date-preset-btn.active {
        background: var(--blue, #2563eb);
        border-color: var(--blue, #2563eb);
        color: #fff;
      }
    `;
    document.head.appendChild(style);
  }

  function resolveContainer(container) {
    if (!container) return null;
    if (typeof container === "string") return document.getElementById(container);
    return container;
  }

  function makeButton(label) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "date-preset-btn";
    btn.textContent = label;
    return btn;
  }

  function installRangePresets(options) {
    ensureStyles();
    const container = resolveContainer(options.container);
    const start = resolveContainer(options.start);
    const end = resolveContainer(options.end);
    if (!container || !start || !end) return;

    const keys = options.presets || ["today", "yesterday", "last7", "thisWeek", "lastWeek", "last30", "thisMonth", "lastMonth"];
    const buttons = [];
    container.classList.add("date-preset-bar");
    container.replaceChildren();
    if (options.label !== false) {
      const label = document.createElement("span");
      label.className = "date-preset-label";
      label.textContent = options.label || "Quick dates";
      container.appendChild(label);
    }

    function updateActive() {
      for (const item of buttons) {
        const [rangeStart, rangeEnd] = item.preset.get();
        item.button.classList.toggle(
          "active",
          start.value === formatDate(rangeStart) && end.value === formatDate(rangeEnd)
        );
      }
    }

    for (const key of keys) {
      const preset = typeof key === "string" ? rangePresets[key] : key;
      if (!preset) continue;
      const button = makeButton(preset.label);
      button.addEventListener("click", () => {
        const [rangeStart, rangeEnd] = preset.get();
        start.value = formatDate(rangeStart);
        end.value = formatDate(rangeEnd);
        updateActive();
        if (typeof options.onApply === "function") options.onApply({ start: start.value, end: end.value, preset });
      });
      buttons.push({ button, preset });
      container.appendChild(button);
    }

    start.addEventListener("change", updateActive);
    end.addEventListener("change", updateActive);
    updateActive();
  }

  function installSingleDatePresets(options) {
    ensureStyles();
    const container = resolveContainer(options.container);
    const input = resolveContainer(options.input);
    if (!container || !input) return;

    const keys = options.presets || ["today", "yesterday", "previous", "next"];
    const buttons = [];
    container.classList.add("date-preset-bar");
    container.replaceChildren();
    if (options.label !== false) {
      const label = document.createElement("span");
      label.className = "date-preset-label";
      label.textContent = options.label || "Quick dates";
      container.appendChild(label);
    }

    function updateActive() {
      for (const item of buttons) {
        const presetValue = formatDate(item.preset.get(input.value));
        item.button.classList.toggle("active", input.value === presetValue && item.staticPreset);
      }
    }

    for (const key of keys) {
      const preset = typeof key === "string" ? singlePresets[key] : key;
      if (!preset) continue;
      const button = makeButton(preset.label);
      const staticPreset = key === "today" || key === "yesterday";
      button.addEventListener("click", () => {
        input.value = formatDate(preset.get(input.value));
        updateActive();
        if (typeof options.onApply === "function") options.onApply({ date: input.value, preset });
      });
      buttons.push({ button, preset, staticPreset });
      container.appendChild(button);
    }

    input.addEventListener("change", updateActive);
    updateActive();
  }

  window.VaultCoreDatePresets = {
    formatDate,
    addDays,
    installRangePresets,
    installSingleDatePresets
  };
})();
