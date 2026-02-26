const TAX_RATE_KEY = "posTaxRate";
const MANAGER_PIN_KEY = "posManagerPin";
const EXPORT_COLS_KEY = "customersExportColumns";

function getDefaultExportColumns() {
  return ["name", "type", "email", "phone", "address1", "city", "state", "zip", "tags", "active"];
}

function loadExportColumns() {
  try {
    const raw = localStorage.getItem(EXPORT_COLS_KEY);
    const list = raw ? JSON.parse(raw) : null;
    if (Array.isArray(list) && list.length) return list;
  } catch {}
  return getDefaultExportColumns();
}

function applyExportColumnsToUI() {
  const cols = loadExportColumns();
  document.querySelectorAll(".export-col").forEach((i) => {
    const key = i.getAttribute("data-col");
    i.checked = cols.includes(key);
  });
  const msg = document.getElementById("exportColsStatus");
  if (msg) msg.textContent = `Saved ${cols.length} column(s).`;
}

function saveExportColumnsFromUI() {
  const inputs = Array.from(document.querySelectorAll(".export-col"));
  const cols = inputs.filter((i) => i.checked).map((i) => i.getAttribute("data-col")).filter(Boolean);
  const msg = document.getElementById("exportColsStatus");
  try {
    localStorage.setItem(EXPORT_COLS_KEY, JSON.stringify(cols));
    if (msg) msg.textContent = `Saved ${cols.length} column(s).`;
  } catch {
    if (msg) msg.textContent = "Failed to save export settings.";
  }
}

function loadTaxRate() {
  let baseRate = 0.07;
  try {
    const stored = localStorage.getItem(TAX_RATE_KEY);
    if (stored != null) {
      const v = parseFloat(stored);
      if (!isNaN(v) && v >= 0 && v <= 0.25) {
        baseRate = v;
      }
    }
  } catch {}
  const input = document.getElementById("settingsTaxRate");
  if (input) input.value = (baseRate * 100).toFixed(2);
  const pinInput = document.getElementById("settingsManagerPin");
  if (pinInput) {
    try { pinInput.value = localStorage.getItem(MANAGER_PIN_KEY) || ""; } catch {}
  }
}

function saveTaxRateFromSettings() {
  const input = document.getElementById("settingsTaxRate");
  const msg = document.getElementById("settingsStatus");
  if (!input || !msg) return;
  const raw = input.value;
  let pct = parseFloat(raw || "0");
  if (isNaN(pct) || pct < 0 || pct > 25) {
    msg.textContent = "Enter a tax rate between 0 and 25%.";
    msg.style.color = "#f97373";
    return;
  }
  const rate = pct / 100;
  try { localStorage.setItem(TAX_RATE_KEY, rate.toString()); } catch {}
  const pinInput = document.getElementById("settingsManagerPin");
  if (pinInput) {
    try { localStorage.setItem(MANAGER_PIN_KEY, pinInput.value.trim()); } catch {}
  }
  msg.textContent = "Tax rate saved as " + pct.toFixed(2) + "%.";
  msg.style.color = "#9ca3af";
}

function wireEvents() {
  const backBtn = document.getElementById("back-btn");
  if (backBtn) backBtn.addEventListener("click", () => { window.location.href = "index.html"; });

  const btnSaveTaxSettings = document.getElementById("btnSaveTaxSettings");
  if (btnSaveTaxSettings) btnSaveTaxSettings.addEventListener("click", saveTaxRateFromSettings);

  const btnSaveExportCols = document.getElementById("btnSaveExportCols");
  if (btnSaveExportCols) btnSaveExportCols.addEventListener("click", saveExportColumnsFromUI);
}

document.addEventListener("DOMContentLoaded", () => {
  loadTaxRate();
  applyExportColumnsToUI();
  wireEvents();
});
