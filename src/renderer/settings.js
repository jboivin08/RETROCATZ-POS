const EXPORT_COLS_KEY = "customersExportColumns";
const LOADING_DISABLED_KEY = "vaultcore_loading_disabled";
const VISUAL_THEME_KEY = "vaultcore_visual_theme";
const API_BASE = "http://127.0.0.1:5175";

const els = {
  topStatus: document.getElementById("settingsTopStatus"),
  storeStatus: document.getElementById("storeStatus"),
  inventoryLocationStatus: document.getElementById("inventoryLocationStatus"),
  registerStatus: document.getElementById("registerStatus"),
  syncStatus: document.getElementById("syncStatus"),
  tradeStatus: document.getElementById("tradeStatus"),
  aiStatus: document.getElementById("aiStatus"),
  localStatus: document.getElementById("localStatus"),
  systemStatus: document.getElementById("systemStatus"),
  exportColsStatus: document.getElementById("exportColsStatus"),
  aiStatusCards: document.getElementById("aiStatusCards"),
  syncCards: document.getElementById("syncCards"),
  systemCards: document.getElementById("systemCards"),
  visualThemeName: document.getElementById("visualThemeName"),
  visualThemeNote: document.getElementById("visualThemeNote")
};

const fields = {
  storeName: document.getElementById("storeName"),
  storePhone: document.getElementById("storePhone"),
  storeEmail: document.getElementById("storeEmail"),
  storeWebsite: document.getElementById("storeWebsite"),
  storeAddress1: document.getElementById("storeAddress1"),
  storeAddress2: document.getElementById("storeAddress2"),
  storeCity: document.getElementById("storeCity"),
  storeState: document.getElementById("storeState"),
  storeZip: document.getElementById("storeZip"),
  receiptFooter: document.getElementById("receiptFooter"),
  lowStockThreshold: document.getElementById("lowStockThreshold"),
  defaultInventoryCategory: document.getElementById("defaultInventoryCategory"),
  defaultMarkupPercent: document.getElementById("defaultMarkupPercent"),
  lockStoreSettings: document.getElementById("lockStoreSettings"),
  inventoryLocationName: document.getElementById("inventoryLocationName"),
  inventoryLocationsList: document.getElementById("inventoryLocationsList"),
  btnAddInventoryLocation: document.getElementById("btnAddInventoryLocation"),
  btnSaveStoreLocations: document.getElementById("btnSaveStoreLocations"),
  taxRate: document.getElementById("settingsTaxRate"),
  taxLabel: document.getElementById("settingsTaxLabel"),
  saleIdPrefix: document.getElementById("saleIdPrefix"),
  maxHeldSales: document.getElementById("maxHeldSales"),
  lockOwnerSettings: document.getElementById("lockOwnerSettings"),
  pinPriceOverride: document.getElementById("settingsPinPriceOverride"),
  pinDiscounts: document.getElementById("settingsPinDiscounts"),
  pinTaxExempt: document.getElementById("settingsPinTaxExempt"),
  requireCustomerForSale: document.getElementById("requireCustomerForSale"),
  allowSplitTender: document.getElementById("allowSplitTender"),
  paymentCashEnabled: document.getElementById("paymentCashEnabled"),
  paymentCardEnabled: document.getElementById("paymentCardEnabled"),
  paymentStoreCreditEnabled: document.getElementById("paymentStoreCreditEnabled"),
  paymentOtherEnabled: document.getElementById("paymentOtherEnabled"),
  quickDiscountPercent1: document.getElementById("quickDiscountPercent1"),
  quickDiscountPercent2: document.getElementById("quickDiscountPercent2"),
  quickDiscountAmount1: document.getElementById("quickDiscountAmount1"),
  quickDiscountAmount2: document.getElementById("quickDiscountAmount2"),
  receiptPrintAfterSale: document.getElementById("receiptPrintAfterSale"),
  receiptShowSku: document.getElementById("receiptShowSku"),
  receiptShowPlatformCondition: document.getElementById("receiptShowPlatformCondition"),
  receiptShowTaxRate: document.getElementById("receiptShowTaxRate"),
  receiptShowBarcode: document.getElementById("receiptShowBarcode"),
  receiptShowCustomer: document.getElementById("receiptShowCustomer"),
  receiptReturnPolicy: document.getElementById("receiptReturnPolicy"),
  closeoutVarianceWarn: document.getElementById("closeoutVarianceWarn"),
  closeoutRequireNoteOnVariance: document.getElementById("closeoutRequireNoteOnVariance"),
  closeoutRequireOpeningCash: document.getElementById("closeoutRequireOpeningCash"),
  wixAutoSyncEnabled: document.getElementById("wixAutoSyncEnabled"),
  wixScheduledSyncEnabled: document.getElementById("wixScheduledSyncEnabled"),
  wixScheduledFrequency: document.getElementById("wixScheduledFrequency"),
  btnManualWixPush: document.getElementById("btnManualWixPush"),
  btnSaveSync: document.getElementById("btnSaveSync"),
  tradeExpiryDays: document.getElementById("tradeExpiryDays"),
  tradeCashLimit: document.getElementById("tradeCashLimit"),
  tradeCreditLimit: document.getElementById("tradeCreditLimit"),
  tradeCountry: document.getElementById("tradeCountry"),
  tradeEbaySold: document.getElementById("tradeEbaySold"),
  tradeEbayActive: document.getElementById("tradeEbayActive"),
  tradeDefaultCreditPercent: document.getElementById("tradeDefaultCreditPercent"),
  tradeDefaultCashPercent: document.getElementById("tradeDefaultCashPercent"),
  tradeMarginFloorPercent: document.getElementById("tradeMarginFloorPercent"),
  tradeOfferBasis: document.getElementById("tradeOfferBasis"),
  tradeDefaultHoldDays: document.getElementById("tradeDefaultHoldDays"),
  tradeRequireCustomer: document.getElementById("tradeRequireCustomer"),
  tradeRequireSellerId: document.getElementById("tradeRequireSellerId"),
  tradeRequireAgreement: document.getElementById("tradeRequireAgreement"),
  tradeTestingQueueEnabled: document.getElementById("tradeTestingQueueEnabled"),
  tradeAutoLabelOnComplete: document.getElementById("tradeAutoLabelOnComplete"),
  tradePromoActive: document.getElementById("tradePromoActive"),
  tradePromoLabel: document.getElementById("tradePromoLabel"),
  tradePromoCreditBonus: document.getElementById("tradePromoCreditBonus"),
  aiMode: document.getElementById("aiMode"),
  aiChattiness: document.getElementById("aiChattiness"),
  vaultcoreLoadingEnabled: document.getElementById("vaultcoreLoadingEnabled"),
  visualThemeSelect: document.getElementById("visualThemeSelect")
};
let inventoryLocations = [{ key: "store", label: "Store" }];

function getAuthHeaders() {
  const sid = localStorage.getItem("rc_session_id") || "";
  return sid ? { "rc_session_id": sid, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { ...getAuthHeaders(), ...(options.headers || {}) }
  });
  if (response.status === 401) {
    localStorage.removeItem("rc_session_id");
    window.location.href = "../../public/index.html";
    throw new Error("session_invalid");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.error || "request_failed");
    err.data = data;
    throw err;
  }
  return data;
}

function apiGet(path) {
  return api(path);
}

function apiPut(path, body) {
  return api(path, { method: "PUT", body: JSON.stringify(body || {}) });
}

function apiPost(path, body) {
  return api(path, { method: "POST", body: JSON.stringify(body || {}) });
}

function setStatus(el, message, level = "info") {
  if (!el) return;
  el.textContent = message || "";
  el.style.color = level === "error" ? "#fca5a5" : level === "success" ? "#86efac" : "#9ca3af";
}

function setTopStatus(message, level = "info") {
  setStatus(els.topStatus, message, level);
}

function toCents(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.round(n * 100)) : 0;
}

function fromCents(value) {
  return (Number(value || 0) / 100).toFixed(2);
}

function boolText(value) {
  return value ? "Yes" : "No";
}

function dateText(value) {
  if (!value) return "Never";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}

function kpiCard(label, value, tone = "") {
  const div = document.createElement("div");
  div.className = `kpi-card${tone ? ` ${tone}` : ""}`;
  const labelEl = document.createElement("div");
  labelEl.className = "label";
  labelEl.textContent = String(label || "");
  const valueEl = document.createElement("div");
  valueEl.className = "value";
  valueEl.textContent = String(value ?? "");
  div.append(labelEl, valueEl);
  return div;
}

function renderCards(container, cards) {
  if (!container) return;
  container.replaceChildren(...cards.map((card) => kpiCard(card.label, card.value, card.tone || "")));
}

function normalizeLocationKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_/-]/g, "")
    .slice(0, 80);
}

function labelFromLocationKey(key) {
  return String(key || "store")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeLocationList(raw) {
  const input = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const list = [];
  const add = (entry) => {
    const rawKey = entry && typeof entry === "object" ? (entry.key || entry.value || entry.name || entry.label) : entry;
    const key = normalizeLocationKey(rawKey || "store") || "store";
    if (seen.has(key)) return;
    seen.add(key);
    const rawLabel = entry && typeof entry === "object" ? (entry.label || entry.name || entry.value || entry.key) : entry;
    const label = String(rawLabel || labelFromLocationKey(key)).trim().slice(0, 60) || labelFromLocationKey(key);
    list.push({ key, label });
  };
  add({ key: "store", label: "Store" });
  input.forEach(add);
  return list;
}

function renderInventoryLocations(canEdit = true) {
  if (!fields.inventoryLocationsList) return;
  const rows = inventoryLocations.map((loc) => {
    const isDefault = loc.key === "store";
    const button = isDefault
      ? `<span class="pill good">Default</span>`
      : `<button class="btn ghost" type="button" data-remove-location="${loc.key}" ${canEdit ? "" : "disabled"}>Remove</button>`;
    return `
      <div class="location-row">
        <strong>${loc.label}</strong>
        <span class="location-key">${loc.key}</span>
        ${button}
      </div>
    `;
  }).join("");
  fields.inventoryLocationsList.innerHTML = rows || `<div class="local-note">No locations configured.</div>`;
  if (fields.inventoryLocationName) fields.inventoryLocationName.disabled = !canEdit;
  if (fields.btnAddInventoryLocation) fields.btnAddInventoryLocation.disabled = !canEdit;
  if (fields.btnSaveStoreLocations) fields.btnSaveStoreLocations.disabled = !canEdit;
}

function addInventoryLocation() {
  const label = String(fields.inventoryLocationName?.value || "").trim();
  const key = normalizeLocationKey(label);
  if (!key) {
    setStatus(els.inventoryLocationStatus, "Enter a location name.", "error");
    return;
  }
  if (inventoryLocations.some((loc) => loc.key === key)) {
    setStatus(els.inventoryLocationStatus, "That location already exists.", "error");
    return;
  }
  inventoryLocations.push({ key, label: label.slice(0, 60) || labelFromLocationKey(key) });
  if (fields.inventoryLocationName) fields.inventoryLocationName.value = "";
  renderInventoryLocations(true);
  setStatus(els.inventoryLocationStatus, "Location added. Save locations when ready.", "success");
}

function removeInventoryLocation(key) {
  if (key === "store") return;
  inventoryLocations = normalizeLocationList(inventoryLocations.filter((loc) => loc.key !== key));
  renderInventoryLocations(true);
  setStatus(els.inventoryLocationStatus, "Location removed. Save locations when ready.", "success");
}

function goSettingsDashboard() {
  window.location.href = "index.html";
}

function switchSettingsTab(tab) {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("active", view.dataset.view === tab);
  });
}

function setDisabled(list, disabled) {
  list.forEach((el) => {
    if (el) el.disabled = disabled;
  });
}

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
  document.querySelectorAll(".export-col").forEach((input) => {
    const key = input.getAttribute("data-col");
    input.checked = cols.includes(key);
  });
  setStatus(els.exportColsStatus, `Saved ${cols.length} column(s).`, "success");
}

function saveExportColumnsFromUI() {
  const inputs = Array.from(document.querySelectorAll(".export-col"));
  const cols = inputs.filter((input) => input.checked).map((input) => input.getAttribute("data-col")).filter(Boolean);
  try {
    localStorage.setItem(EXPORT_COLS_KEY, JSON.stringify(cols));
    setStatus(els.exportColsStatus, `Saved ${cols.length} column(s).`, "success");
  } catch {
    setStatus(els.exportColsStatus, "Failed to save export settings.", "error");
  }
}

function themeList() {
  if (window.VaultCoreTheme && Array.isArray(window.VaultCoreTheme.themes)) {
    return window.VaultCoreTheme.themes;
  }
  return [{ id: "classic", label: "VaultCore Classic", note: "The current dark professional look." }];
}

function normalizeTheme(value) {
  if (window.VaultCoreTheme && typeof window.VaultCoreTheme.normalize === "function") {
    return window.VaultCoreTheme.normalize(value);
  }
  return themeList().some((theme) => theme.id === value) ? value : "classic";
}

function getCurrentTheme() {
  if (window.VaultCoreTheme && typeof window.VaultCoreTheme.get === "function") {
    return window.VaultCoreTheme.get();
  }
  try {
    return normalizeTheme(localStorage.getItem(VISUAL_THEME_KEY));
  } catch {
    return "classic";
  }
}

function applyThemeChoice(value, { persist = true } = {}) {
  const theme = normalizeTheme(value);
  if (persist && window.VaultCoreTheme && typeof window.VaultCoreTheme.set === "function") {
    window.VaultCoreTheme.set(theme);
  } else if (window.VaultCoreTheme && typeof window.VaultCoreTheme.apply === "function") {
    window.VaultCoreTheme.apply(theme);
  } else {
    if (document.documentElement) document.documentElement.setAttribute("data-theme", theme);
  }
  updateThemePreview(theme);
  return theme;
}

function populateThemeSelect() {
  if (!fields.visualThemeSelect) return;
  fields.visualThemeSelect.replaceChildren();
  themeList().forEach((theme) => {
    const option = document.createElement("option");
    option.value = theme.id;
    option.textContent = theme.label;
    fields.visualThemeSelect.appendChild(option);
  });
}

function updateThemePreview(value) {
  const theme = themeList().find((entry) => entry.id === normalizeTheme(value)) || themeList()[0];
  if (fields.visualThemeSelect && fields.visualThemeSelect.value !== theme.id) {
    fields.visualThemeSelect.value = theme.id;
  }
  if (els.visualThemeName) els.visualThemeName.textContent = theme.label;
  if (els.visualThemeNote) els.visualThemeNote.textContent = theme.note || "";
}

function loadLocalSettings() {
  const disabled = localStorage.getItem(LOADING_DISABLED_KEY) === "1";
  if (fields.vaultcoreLoadingEnabled) fields.vaultcoreLoadingEnabled.checked = !disabled;
  populateThemeSelect();
  applyThemeChoice(getCurrentTheme(), { persist: false });
}

function saveLocalSettings() {
  const enabled = !!fields.vaultcoreLoadingEnabled?.checked;
  localStorage.setItem(LOADING_DISABLED_KEY, enabled ? "0" : "1");
  if (fields.visualThemeSelect) applyThemeChoice(fields.visualThemeSelect.value, { persist: true });
  setStatus(els.localStatus, "Local settings saved.", "success");
}

function applyStoreSettings(settings = {}, canEdit = {}) {
  fields.storeName.value = settings.store_name || "";
  fields.storePhone.value = settings.store_phone || "";
  fields.storeEmail.value = settings.store_email || "";
  fields.storeWebsite.value = settings.store_website || "";
  fields.storeAddress1.value = settings.store_address1 || "";
  fields.storeAddress2.value = settings.store_address2 || "";
  fields.storeCity.value = settings.store_city || "";
  fields.storeState.value = settings.store_state || "";
  fields.storeZip.value = settings.store_zip || "";
  fields.receiptFooter.value = settings.receipt_footer || "";
  fields.lowStockThreshold.value = Number(settings.low_stock_threshold || 1);
  fields.defaultInventoryCategory.value = settings.default_inventory_category || "Games";
  fields.defaultMarkupPercent.value = Number(settings.default_markup_percent || 100);
  inventoryLocations = normalizeLocationList(settings.inventory_locations);
  const locks = settings.owner_locked || {};
  fields.lockStoreSettings.checked = Object.values(locks).some(Boolean);
  fields.lockStoreSettings.disabled = canEdit.owner_lock === false;
  renderInventoryLocations(canEdit.settings !== false);
  setDisabled([
    fields.storeName, fields.storePhone, fields.storeEmail, fields.storeWebsite,
    fields.storeAddress1, fields.storeAddress2, fields.storeCity, fields.storeState,
    fields.storeZip, fields.receiptFooter, fields.lowStockThreshold,
    fields.defaultInventoryCategory, fields.defaultMarkupPercent
  ], canEdit.settings === false);
}

async function loadStoreSettings() {
  try {
    const data = await apiGet("/api/settings/store");
    applyStoreSettings(data.settings || {}, data.can_edit || {});
    setStatus(els.storeStatus, "Store settings loaded.", "success");
    setStatus(els.inventoryLocationStatus, "Inventory locations loaded.", "success");
  } catch (err) {
    console.error(err);
    setStatus(els.storeStatus, "Store settings could not be loaded.", "error");
    setStatus(els.inventoryLocationStatus, "Inventory locations could not be loaded.", "error");
  }
}

async function saveStoreSettings() {
  const body = {
    store_name: fields.storeName.value,
    store_phone: fields.storePhone.value,
    store_email: fields.storeEmail.value,
    store_website: fields.storeWebsite.value,
    store_address1: fields.storeAddress1.value,
    store_address2: fields.storeAddress2.value,
    store_city: fields.storeCity.value,
    store_state: fields.storeState.value,
    store_zip: fields.storeZip.value,
    receipt_footer: fields.receiptFooter.value,
    low_stock_threshold: fields.lowStockThreshold.value,
    default_inventory_category: fields.defaultInventoryCategory.value,
    default_markup_percent: fields.defaultMarkupPercent.value,
    inventory_locations: inventoryLocations,
    lock_owner_settings: fields.lockStoreSettings && !fields.lockStoreSettings.disabled ? fields.lockStoreSettings.checked : undefined
  };
  try {
    const data = await apiPut("/api/settings/store", body);
    applyStoreSettings(data.settings || {}, data.can_edit || {});
    setStatus(els.storeStatus, "Store settings saved.", "success");
    setStatus(els.inventoryLocationStatus, "Inventory locations saved.", "success");
    setTopStatus("Settings saved.", "success");
  } catch (err) {
    console.error(err);
    setStatus(els.storeStatus, err.message === "owner_locked" ? "Store settings are owner locked." : "Store settings were not saved.", "error");
    setStatus(els.inventoryLocationStatus, "Inventory locations were not saved.", "error");
  }
}

function applyRegisterSettings(settings = {}, canEdit = {}) {
  const taxRate = Number(settings.tax_rate);
  const baseRate = Number.isFinite(taxRate) && taxRate >= 0 && taxRate <= 0.25 ? taxRate : 0.07;
  fields.taxRate.value = (baseRate * 100).toFixed(2);
  fields.taxLabel.value = settings.tax_label || "Sales Tax";
  fields.saleIdPrefix.value = settings.sale_id_prefix || "SO";
  fields.maxHeldSales.value = Number(settings.max_held_sales || 20);
  fields.pinPriceOverride.checked = settings.require_pin_for_price_override !== false;
  fields.pinDiscounts.checked = settings.require_pin_for_discounts !== false;
  fields.pinTaxExempt.checked = settings.require_pin_for_tax_exempt !== false;
  fields.requireCustomerForSale.checked = settings.require_customer_for_sale === true;
  fields.allowSplitTender.checked = settings.allow_split_tender !== false;
  fields.paymentCashEnabled.checked = settings.payment_cash_enabled !== false;
  fields.paymentCardEnabled.checked = settings.payment_card_enabled !== false;
  fields.paymentStoreCreditEnabled.checked = settings.payment_store_credit_enabled !== false;
  fields.paymentOtherEnabled.checked = settings.payment_other_enabled !== false;
  fields.quickDiscountPercent1.value = Number(settings.quick_discount_percent_1 ?? 5);
  fields.quickDiscountPercent2.value = Number(settings.quick_discount_percent_2 ?? 10);
  fields.quickDiscountAmount1.value = Number(settings.quick_discount_amount_1 ?? 5).toFixed(2);
  fields.quickDiscountAmount2.value = Number(settings.quick_discount_amount_2 ?? 10).toFixed(2);
  fields.receiptPrintAfterSale.checked = settings.receipt_print_after_sale !== false;
  fields.receiptShowSku.checked = settings.receipt_show_sku !== false;
  fields.receiptShowPlatformCondition.checked = settings.receipt_show_platform_condition !== false;
  fields.receiptShowTaxRate.checked = settings.receipt_show_tax_rate !== false;
  fields.receiptShowBarcode.checked = settings.receipt_show_barcode !== false;
  fields.receiptShowCustomer.checked = settings.receipt_show_customer === true;
  fields.receiptReturnPolicy.value = settings.receipt_return_policy || "";
  fields.closeoutVarianceWarn.value = fromCents(settings.closeout_variance_warn_cents ?? 500);
  fields.closeoutRequireNoteOnVariance.checked = settings.closeout_require_note_on_variance !== false;
  fields.closeoutRequireOpeningCash.checked = settings.closeout_require_opening_cash === true;
  const locks = settings.owner_locked || {};
  const locked = Object.values(locks).some(Boolean);
  fields.lockOwnerSettings.value = locked ? "1" : "0";
  fields.lockOwnerSettings.disabled = canEdit.owner_lock === false;
  fields.taxRate.disabled = canEdit.tax_rate === false;
  fields.taxLabel.disabled = canEdit.tax_rate === false;
  setDisabled([
    fields.saleIdPrefix,
    fields.maxHeldSales,
    fields.pinPriceOverride,
    fields.pinDiscounts,
    fields.pinTaxExempt,
    fields.requireCustomerForSale,
    fields.allowSplitTender,
    fields.paymentCashEnabled,
    fields.paymentCardEnabled,
    fields.paymentStoreCreditEnabled,
    fields.paymentOtherEnabled,
    fields.quickDiscountPercent1,
    fields.quickDiscountPercent2,
    fields.quickDiscountAmount1,
    fields.quickDiscountAmount2,
    fields.receiptPrintAfterSale,
    fields.receiptShowSku,
    fields.receiptShowPlatformCondition,
    fields.receiptShowTaxRate,
    fields.receiptShowBarcode,
    fields.receiptShowCustomer,
    fields.receiptReturnPolicy,
    fields.closeoutVarianceWarn,
    fields.closeoutRequireNoteOnVariance,
    fields.closeoutRequireOpeningCash
  ], canEdit.settings === false);
}

async function loadRegisterSettings() {
  try {
    const data = await apiGet("/api/settings/register");
    applyRegisterSettings(data.settings || {}, data.can_edit || {});
    setStatus(els.registerStatus, "Register settings loaded.", "success");
  } catch (err) {
    console.error(err);
    setStatus(els.registerStatus, "Register settings could not be loaded.", "error");
  }
}

async function saveRegisterSettings() {
  const pct = Number(fields.taxRate.value || 0);
  if (!Number.isFinite(pct) || pct < 0 || pct > 25) {
    setStatus(els.registerStatus, "Enter a tax rate between 0 and 25%.", "error");
    return;
  }
  const paymentEnabled = [
    fields.paymentCashEnabled,
    fields.paymentCardEnabled,
    fields.paymentStoreCreditEnabled,
    fields.paymentOtherEnabled
  ].some((input) => input && input.checked);
  if (!paymentEnabled) {
    setStatus(els.registerStatus, "Keep at least one payment method enabled.", "error");
    return;
  }
  try {
    const data = await apiPut("/api/settings/register", {
      tax_rate: pct / 100,
      tax_label: fields.taxLabel.value,
      sale_id_prefix: fields.saleIdPrefix.value,
      max_held_sales: Number(fields.maxHeldSales.value || 20),
      require_pin_for_price_override: !!fields.pinPriceOverride.checked,
      require_pin_for_discounts: !!fields.pinDiscounts.checked,
      require_pin_for_tax_exempt: !!fields.pinTaxExempt.checked,
      require_customer_for_sale: !!fields.requireCustomerForSale.checked,
      allow_split_tender: !!fields.allowSplitTender.checked,
      payment_cash_enabled: !!fields.paymentCashEnabled.checked,
      payment_card_enabled: !!fields.paymentCardEnabled.checked,
      payment_store_credit_enabled: !!fields.paymentStoreCreditEnabled.checked,
      payment_other_enabled: !!fields.paymentOtherEnabled.checked,
      quick_discount_percent_1: Number(fields.quickDiscountPercent1.value || 0),
      quick_discount_percent_2: Number(fields.quickDiscountPercent2.value || 0),
      quick_discount_amount_1: Number(fields.quickDiscountAmount1.value || 0),
      quick_discount_amount_2: Number(fields.quickDiscountAmount2.value || 0),
      receipt_print_after_sale: !!fields.receiptPrintAfterSale.checked,
      receipt_show_sku: !!fields.receiptShowSku.checked,
      receipt_show_platform_condition: !!fields.receiptShowPlatformCondition.checked,
      receipt_show_tax_rate: !!fields.receiptShowTaxRate.checked,
      receipt_show_barcode: !!fields.receiptShowBarcode.checked,
      receipt_show_customer: !!fields.receiptShowCustomer.checked,
      receipt_return_policy: fields.receiptReturnPolicy.value,
      closeout_variance_warn_cents: toCents(fields.closeoutVarianceWarn.value),
      closeout_require_note_on_variance: !!fields.closeoutRequireNoteOnVariance.checked,
      closeout_require_opening_cash: !!fields.closeoutRequireOpeningCash.checked,
      lock_owner_settings: fields.lockOwnerSettings && !fields.lockOwnerSettings.disabled ? fields.lockOwnerSettings.value === "1" : undefined
    });
    applyRegisterSettings(data.settings || {}, data.can_edit || {});
    setStatus(els.registerStatus, "Register settings saved.", "success");
    setTopStatus("Settings saved.", "success");
  } catch (err) {
    console.error(err);
    const label = err.message === "owner_locked" ? "That setting is owner locked." : "Register settings were not saved.";
    setStatus(els.registerStatus, label, "error");
  }
}

function applySyncSettings(data = {}) {
  const settings = data.settings || data;
  const configured = !!settings.wix_configured;
  if (fields.wixAutoSyncEnabled) fields.wixAutoSyncEnabled.checked = !!settings.auto_push_enabled;
  if (fields.wixScheduledSyncEnabled) fields.wixScheduledSyncEnabled.checked = !!settings.scheduled_sync_enabled;
  if (fields.wixScheduledFrequency) fields.wixScheduledFrequency.value = settings.scheduled_sync_frequency || "daily";
  if (fields.btnManualWixPush) fields.btnManualWixPush.disabled = !configured || !!settings.full_sync_running;
  if (fields.btnSaveSync) fields.btnSaveSync.disabled = false;

  renderCards(els.syncCards, [
    { label: "Wix Configured", value: configured ? "Yes" : "No", tone: configured ? "good" : "warn" },
    { label: "Automatic Push", value: settings.auto_push_enabled ? "On" : "Off", tone: settings.auto_push_enabled ? "good" : "warn" },
    { label: "Scheduled Full Push", value: settings.scheduled_sync_enabled ? settings.scheduled_sync_frequency : "Off", tone: settings.scheduled_sync_enabled ? "good" : "" },
    { label: "Next Scheduled Push", value: dateText(settings.scheduled_sync_next_run) },
    { label: "Last Scheduled Result", value: settings.scheduled_sync_last_result || "Never" },
    { label: "Last Manual Result", value: settings.manual_sync_last_result || "Never" }
  ]);

  const envNote = !settings.wix_env_enabled
    ? "Wix environment switch is off. Add WIX_SYNC_ENABLED=on before pushing."
    : !configured
      ? "Wix API key or site ID is missing."
      : "Wix sync settings loaded.";
  setStatus(els.syncStatus, envNote, configured ? "success" : "error");
}

async function loadSyncSettings() {
  try {
    const data = await apiGet("/api/settings/sync");
    applySyncSettings(data);
  } catch (err) {
    console.error(err);
    setStatus(els.syncStatus, err.message === "Permission denied" ? "Sync admin permission is required." : "Sync settings could not be loaded.", "error");
  }
}

async function saveSyncSettings() {
  try {
    const data = await apiPut("/api/settings/sync", {
      wix_auto_sync_enabled: !!fields.wixAutoSyncEnabled?.checked,
      wix_scheduled_sync_enabled: !!fields.wixScheduledSyncEnabled?.checked,
      wix_scheduled_sync_frequency: fields.wixScheduledFrequency?.value || "daily"
    });
    applySyncSettings(data);
    setStatus(els.syncStatus, "Sync settings saved.", "success");
    setTopStatus("Settings saved.", "success");
  } catch (err) {
    console.error(err);
    setStatus(els.syncStatus, "Sync settings were not saved.", "error");
  }
}

async function manualWixPush() {
  const ok = confirm("Push all active POS inventory rows to Wix now? This may take a few minutes.");
  if (!ok) return;
  let keepManualDisabled = false;
  try {
    if (fields.btnManualWixPush) {
      fields.btnManualWixPush.disabled = true;
      fields.btnManualWixPush.textContent = "Pushing...";
    }
    setStatus(els.syncStatus, "Manual Wix push running...", "info");
    const data = await apiPost("/api/wix/sync-all", {});
    applySyncSettings(data);
    const s = data.summary || {};
    setStatus(els.syncStatus, `Manual push complete. Synced ${s.succeeded || 0}/${s.attempted || 0}; failed ${s.failed || 0}.`, s.failed ? "error" : "success");
    setTopStatus("Manual Wix push complete.", s.failed ? "error" : "success");
  } catch (err) {
    console.error(err);
    const message = err.message === "wix_not_configured"
      ? "Wix is not configured."
      : err.message === "sync_already_running"
        ? "A full Wix sync is already running."
        : "Manual Wix push failed.";
    keepManualDisabled = err.message === "wix_not_configured" || err.message === "sync_already_running";
    setStatus(els.syncStatus, message, "error");
  } finally {
    if (fields.btnManualWixPush) {
      fields.btnManualWixPush.disabled = keepManualDisabled;
      fields.btnManualWixPush.textContent = "Manual Push Now";
    }
  }
}

function applyTradeSettings(data = {}) {
  const base = data.base || data.resolved || {};
  fields.tradeExpiryDays.value = Number(base.quote_expiry_days || 30);
  fields.tradeCashLimit.value = fromCents(base.approval_cash_limit_cents);
  fields.tradeCreditLimit.value = fromCents(base.approval_credit_limit_cents);
  fields.tradeCountry.value = base.ebay_country || "US";
  fields.tradeEbaySold.checked = base.ebay_sold_enabled !== 0;
  fields.tradeEbayActive.checked = base.ebay_active_enabled !== 0;
  fields.tradeDefaultCreditPercent.value = Number(base.default_credit_percent ?? 50);
  fields.tradeDefaultCashPercent.value = Number(base.default_cash_percent ?? 80);
  fields.tradeMarginFloorPercent.value = Number(base.margin_floor_percent ?? 45);
  fields.tradeOfferBasis.value = base.offer_basis || "sold_median";
  fields.tradeDefaultHoldDays.value = Number(base.default_hold_days || 0);
  fields.tradeRequireCustomer.checked = base.require_customer === 1;
  fields.tradeRequireSellerId.checked = base.require_seller_id === 1;
  fields.tradeRequireAgreement.checked = base.require_agreement !== 0;
  fields.tradeTestingQueueEnabled.checked = base.testing_queue_enabled !== 0;
  fields.tradeAutoLabelOnComplete.checked = base.auto_label_on_complete !== 0;
  fields.tradePromoActive.checked = base.promo_active === 1;
  fields.tradePromoLabel.value = base.promo_label || "";
  fields.tradePromoCreditBonus.value = Number(base.promo_credit_bonus_percent || 0);
}

async function loadTradeSettings() {
  try {
    const data = await apiGet("/api/trade/settings");
    applyTradeSettings(data);
    setStatus(els.tradeStatus, "Trade-in settings loaded.", "success");
  } catch (err) {
    console.error(err);
    setStatus(els.tradeStatus, "Trade-in settings could not be loaded.", "error");
  }
}

async function saveTradeSettings() {
  try {
    const data = await apiPut("/api/trade/settings", {
      quote_expiry_days: Number(fields.tradeExpiryDays.value || 30),
      approval_cash_limit_cents: toCents(fields.tradeCashLimit.value),
      approval_credit_limit_cents: toCents(fields.tradeCreditLimit.value),
      ebay_sold_enabled: !!fields.tradeEbaySold.checked,
      ebay_active_enabled: !!fields.tradeEbayActive.checked,
      ebay_country: String(fields.tradeCountry.value || "US").toUpperCase().slice(0, 2),
      default_credit_percent: Number(fields.tradeDefaultCreditPercent.value || 50),
      default_cash_percent: Number(fields.tradeDefaultCashPercent.value || 80),
      margin_floor_percent: Number(fields.tradeMarginFloorPercent.value || 45),
      offer_basis: fields.tradeOfferBasis.value || "sold_median",
      default_hold_days: Number(fields.tradeDefaultHoldDays.value || 0),
      require_customer: !!fields.tradeRequireCustomer.checked,
      require_seller_id: !!fields.tradeRequireSellerId.checked,
      require_agreement: !!fields.tradeRequireAgreement.checked,
      testing_queue_enabled: !!fields.tradeTestingQueueEnabled.checked,
      auto_label_on_complete: !!fields.tradeAutoLabelOnComplete.checked,
      promo_active: !!fields.tradePromoActive.checked,
      promo_label: fields.tradePromoLabel.value,
      promo_credit_bonus_percent: Number(fields.tradePromoCreditBonus.value || 0)
    });
    applyTradeSettings(data);
    setStatus(els.tradeStatus, "Trade-in settings saved.", "success");
    setTopStatus("Settings saved.", "success");
  } catch (err) {
    console.error(err);
    setStatus(els.tradeStatus, err.message === "Permission denied" ? "Settings permission is required." : "Trade-in settings were not saved.", "error");
  }
}

function applyAiSettings(data = {}) {
  fields.aiMode.value = ["off", "lab", "on"].includes(data.mode) ? data.mode : "lab";
  fields.aiChattiness.value = ["quiet", "normal", "chatty"].includes(data.chattiness) ? data.chattiness : "normal";
}

async function loadAiSettings() {
  try {
    const data = await apiGet("/api/ai/settings");
    applyAiSettings(data);
    setStatus(els.aiStatus, "AI settings loaded.", "success");
  } catch (err) {
    console.error(err);
    setStatus(els.aiStatus, "AI settings could not be loaded.", "error");
  }
}

async function saveAiSettings() {
  try {
    const data = await apiPost("/api/ai/settings", {
      mode: fields.aiMode.value,
      chattiness: fields.aiChattiness.value
    });
    applyAiSettings(data);
    await loadSystemStatus();
    setStatus(els.aiStatus, "AI settings saved.", "success");
    setTopStatus("Settings saved.", "success");
  } catch (err) {
    console.error(err);
    setStatus(els.aiStatus, "AI settings were not saved.", "error");
  }
}

async function loadSystemStatus() {
  try {
    const data = await apiGet("/api/settings/system");
    const integrations = data.integrations || {};
    const lastRuns = data.last_runs || {};
    renderCards(els.systemCards, [
      { label: "API", value: `${data.api?.host || "127.0.0.1"}:${data.api?.port || "5175"}`, tone: "good" },
      { label: "AI Configured", value: boolText(integrations.ai_configured), tone: integrations.ai_configured ? "good" : "warn" },
      { label: "AI Mode", value: integrations.ai_mode || "lab" },
      { label: "eBay Adapter", value: boolText(integrations.ebay_adapter), tone: integrations.ebay_adapter ? "good" : "warn" },
      { label: "Wix Enabled", value: boolText(integrations.wix_enabled), tone: integrations.wix_enabled ? "good" : "" },
      { label: "Wix Configured", value: boolText(integrations.wix_configured), tone: integrations.wix_configured ? "good" : "warn" }
    ]);
    renderCards(els.aiStatusCards, [
      { label: "Configured", value: boolText(integrations.ai_configured), tone: integrations.ai_configured ? "good" : "warn" },
      { label: "Mode", value: integrations.ai_mode || "lab" },
      { label: "Chattiness", value: integrations.ai_chattiness || "normal" },
      { label: "Store Oracle", value: dateText(lastRuns.store_oracle) },
      { label: "Market Watcher", value: dateText(lastRuns.market_watcher) },
      { label: "Trend Watcher", value: dateText(lastRuns.trend_watcher) }
    ]);
    setStatus(els.systemStatus, "System status loaded.", "success");
  } catch (err) {
    console.error(err);
    setStatus(els.systemStatus, "System status could not be loaded.", "error");
  }
}

function wireTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.onclick = () => switchSettingsTab(btn.dataset.tab);
  });
}

function wireEvents() {
  const bindClick = (id, handler) => {
    const el = document.getElementById(id);
    if (el) el.onclick = handler;
  };
  bindClick("back-btn", goSettingsDashboard);
  bindClick("btnSaveStore", saveStoreSettings);
  bindClick("btnSaveStoreLocations", saveStoreSettings);
  bindClick("btnAddInventoryLocation", addInventoryLocation);
  bindClick("btnSaveTaxSettings", saveRegisterSettings);
  bindClick("btnSaveSync", saveSyncSettings);
  bindClick("btnManualWixPush", manualWixPush);
  bindClick("btnSaveTrade", saveTradeSettings);
  bindClick("btnSaveAi", saveAiSettings);
  bindClick("btnSaveLocal", saveLocalSettings);
  bindClick("btnSaveExportCols", saveExportColumnsFromUI);
  bindClick("btnRefreshSystem", loadSystemStatus);
  if (fields.visualThemeSelect) {
    fields.visualThemeSelect.addEventListener("change", () => {
      const theme = applyThemeChoice(fields.visualThemeSelect.value, { persist: true });
      const label = themeList().find((entry) => entry.id === theme)?.label || "visual style";
      setStatus(els.localStatus, `${label} applied on this register.`, "success");
    });
  }
  if (fields.inventoryLocationsList) {
    fields.inventoryLocationsList.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-remove-location]");
      if (!btn) return;
      removeInventoryLocation(btn.getAttribute("data-remove-location") || "");
    });
  }
  if (fields.inventoryLocationName) {
    fields.inventoryLocationName.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        addInventoryLocation();
      }
    });
  }
}

async function loadAll() {
  setTopStatus("Loading settings...");
  await Promise.all([
    loadStoreSettings(),
    loadRegisterSettings(),
    loadSyncSettings(),
    loadTradeSettings(),
    loadAiSettings(),
    loadSystemStatus()
  ]);
  loadLocalSettings();
  applyExportColumnsToUI();
  setTopStatus("Settings loaded.", "success");
}

function bootSettingsPage() {
  wireTabs();
  wireEvents();
  loadAll();
}

window.goSettingsDashboard = goSettingsDashboard;
window.switchSettingsTab = switchSettingsTab;
window.saveStoreSettings = saveStoreSettings;
window.addInventoryLocation = addInventoryLocation;
window.saveRegisterSettings = saveRegisterSettings;
window.saveSyncSettings = saveSyncSettings;
window.manualWixPush = manualWixPush;
window.saveTradeSettings = saveTradeSettings;
window.saveAiSettings = saveAiSettings;
window.saveLocalSettings = saveLocalSettings;
window.saveExportColumnsFromUI = saveExportColumnsFromUI;
window.loadSystemStatus = loadSystemStatus;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootSettingsPage, { once: true });
} else {
  bootSettingsPage();
}
