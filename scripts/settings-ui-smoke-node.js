const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");

const failures = [];

function log(message) {
  console.log(`[settings-ui] ${message}`);
}

function assert(ok, message) {
  if (!ok) failures.push(message);
  log(`${ok ? "PASS" : "FAIL"} ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class ClassList {
  constructor(el) {
    this.el = el;
    this.set = new Set();
  }
  syncFromName(name) {
    this.set = new Set(String(name || "").split(/\s+/).filter(Boolean));
  }
  syncToName() {
    this.el._className = Array.from(this.set).join(" ");
  }
  add(name) {
    this.set.add(name);
    this.syncToName();
  }
  remove(name) {
    this.set.delete(name);
    this.syncToName();
  }
  contains(name) {
    return this.set.has(name);
  }
  toggle(name, force) {
    const next = force === undefined ? !this.set.has(name) : !!force;
    if (next) this.set.add(name);
    else this.set.delete(name);
    this.syncToName();
    return next;
  }
}

class Element {
  constructor(tagName, document) {
    this.tagName = String(tagName || "div").toUpperCase();
    this.ownerDocument = document;
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.attributes = {};
    this.eventListeners = {};
    this.style = {};
    this.textContent = "";
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this._className = "";
    this.classList = new ClassList(this);
  }
  get id() {
    return this.attributes.id || "";
  }
  set id(value) {
    this.setAttribute("id", value);
  }
  get className() {
    return this._className;
  }
  set className(value) {
    this._className = String(value || "");
    this.classList.syncFromName(this._className);
  }
  setAttribute(name, value) {
    const key = String(name);
    const val = String(value);
    this.attributes[key] = val;
    if (key === "id") this.ownerDocument.byId.set(val, this);
    if (key === "class") this.className = val;
    if (key.startsWith("data-")) {
      const dataKey = key.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
      this.dataset[dataKey] = val;
    }
  }
  getAttribute(name) {
    return this.attributes[String(name)] || null;
  }
  append(...nodes) {
    for (const node of nodes) {
      if (!node) continue;
      node.parentNode = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  addEventListener(type, handler) {
    if (!this.eventListeners[type]) this.eventListeners[type] = [];
    this.eventListeners[type].push(handler);
  }
  dispatchEvent(event) {
    const evt = event || { type: "" };
    evt.target = evt.target || this;
    const propHandler = this[`on${evt.type}`];
    if (typeof propHandler === "function") propHandler.call(this, evt);
    for (const handler of this.eventListeners[evt.type] || []) handler.call(this, evt);
    return true;
  }
  click() {
    this.dispatchEvent({ type: "click", target: this });
  }
  focus() {}
  querySelectorAll(selector) {
    return this.ownerDocument.querySelectorAll(selector, this);
  }
}

class Document {
  constructor() {
    this.byId = new Map();
    this.nodes = [];
    this.eventListeners = {};
    this.body = this.createElement("body");
  }
  createElement(tagName) {
    const el = new Element(tagName, this);
    this.nodes.push(el);
    return el;
  }
  getElementById(id) {
    return this.byId.get(String(id)) || null;
  }
  addEventListener(type, handler) {
    if (!this.eventListeners[type]) this.eventListeners[type] = [];
    this.eventListeners[type].push(handler);
  }
  dispatchEvent(event) {
    for (const handler of this.eventListeners[event.type] || []) handler.call(this, event);
  }
  querySelectorAll(selector, root = null) {
    const pool = root ? collect(root) : this.nodes;
    return pool.filter((el) => matches(el, selector));
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

function collect(root) {
  const out = [];
  const visit = (node) => {
    out.push(node);
    for (const child of node.children || []) visit(child);
  };
  visit(root);
  return out;
}

function matches(el, selector) {
  const exact = String(selector || "").trim();
  const attrMatch = exact.match(/^\.([a-zA-Z0-9_-]+)\[data-([a-zA-Z0-9_-]+)="([^"]+)"\]$/);
  if (attrMatch) {
    const dataKey = attrMatch[2].replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
    return el.classList.contains(attrMatch[1]) && el.dataset[dataKey] === attrMatch[3];
  }
  if (exact.startsWith(".")) return el.classList.contains(exact.slice(1));
  if (exact.startsWith("#")) return el.id === exact.slice(1);
  return el.tagName.toLowerCase() === exact.toLowerCase();
}

class LocalStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    this.map.set(String(key), String(value));
  }
  removeItem(key) {
    this.map.delete(String(key));
  }
}

function add(document, tag, { id, className, dataset, value, checked, disabled } = {}) {
  const el = document.createElement(tag);
  if (id) el.id = id;
  if (className) el.className = className;
  if (dataset) {
    for (const [key, val] of Object.entries(dataset)) {
      el.dataset[key] = String(val);
      el.attributes[`data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`] = String(val);
    }
  }
  if (value !== undefined) el.value = value;
  if (checked !== undefined) el.checked = !!checked;
  if (disabled !== undefined) el.disabled = !!disabled;
  document.body.append(el);
  return el;
}

function buildSettingsDom(sessionId) {
  const document = new Document();
  const localStorage = new LocalStorage();
  localStorage.setItem("rc_session_id", sessionId);

  [
    "settingsTopStatus", "storeStatus", "registerStatus", "tradeStatus", "aiStatus",
    "localStatus", "systemStatus", "exportColsStatus", "aiStatusCards", "systemCards"
  ].forEach((id) => add(document, "div", { id }));

  [
    "back-btn", "btnSaveStore", "btnSaveTaxSettings", "btnSaveTrade", "btnSaveAi",
    "btnSaveLocal", "btnSaveExportCols", "btnRefreshSystem"
  ].forEach((id) => add(document, "button", { id }));

  for (const tab of ["store", "register", "trade", "ai", "local", "system"]) {
    add(document, "button", { className: `tab${tab === "store" ? " active" : ""}`, dataset: { tab } });
    add(document, "section", { className: `view${tab === "store" ? " active" : ""}`, dataset: { view: tab } });
  }

  [
    "storeName", "storePhone", "storeEmail", "storeWebsite", "storeAddress1", "storeAddress2",
    "storeCity", "storeState", "storeZip", "receiptFooter", "lowStockThreshold",
    "defaultInventoryCategory", "defaultMarkupPercent", "settingsTaxRate",
    "settingsTaxLabel", "saleIdPrefix", "maxHeldSales",
    "quickDiscountPercent1", "quickDiscountPercent2", "quickDiscountAmount1", "quickDiscountAmount2",
    "receiptReturnPolicy", "closeoutVarianceWarn",
    "tradeExpiryDays", "tradeCashLimit", "tradeCreditLimit", "tradeCountry",
    "tradeDefaultCreditPercent", "tradeDefaultCashPercent", "tradeMarginFloorPercent",
    "tradeDefaultHoldDays", "tradePromoLabel", "tradePromoCreditBonus"
  ].forEach((id) => add(document, "input", { id }));

  ["lockOwnerSettings", "tradeOfferBasis", "aiMode", "aiChattiness"].forEach((id) => add(document, "select", { id }));
  [
    "lockStoreSettings", "settingsPinPriceOverride", "settingsPinDiscounts",
    "settingsPinTaxExempt", "requireCustomerForSale", "allowSplitTender",
    "paymentCashEnabled", "paymentCardEnabled", "paymentStoreCreditEnabled", "paymentOtherEnabled",
    "receiptPrintAfterSale", "receiptShowSku", "receiptShowPlatformCondition", "receiptShowTaxRate",
    "receiptShowBarcode", "receiptShowCustomer", "closeoutRequireNoteOnVariance", "closeoutRequireOpeningCash",
    "tradeEbaySold", "tradeEbayActive", "tradeRequireCustomer", "tradeRequireSellerId",
    "tradeRequireAgreement", "tradeTestingQueueEnabled", "tradeAutoLabelOnComplete",
    "tradePromoActive", "vaultcoreLoadingEnabled"
  ].forEach((id) => add(document, "input", { id }));

  [
    "name", "type", "email", "email2", "email3", "phone", "phone2", "phone3",
    "address1", "address2", "city", "state", "zip", "ein", "tags",
    "tax_exempt", "store_credit_cents", "active"
  ].forEach((col) => add(document, "input", { className: "export-col", dataset: { col } }));

  return { document, localStorage };
}

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data
  };
}

function makeMockFetch() {
  const state = {
    store: {
      store_name: "VaultCore",
      store_phone: "",
      store_email: "",
      store_website: "",
      store_address1: "",
      store_address2: "",
      store_city: "",
      store_state: "",
      store_zip: "",
      receipt_footer: "Thanks for shopping with us.",
      low_stock_threshold: "1",
      default_inventory_category: "Games",
      default_markup_percent: "100",
      owner_locked: {}
    },
    register: {
      tax_rate: 0.07,
      tax_label: "Sales Tax",
      require_pin_for_price_override: true,
      require_pin_for_discounts: true,
      require_pin_for_tax_exempt: true,
      require_customer_for_sale: false,
      allow_split_tender: true,
      payment_cash_enabled: true,
      payment_card_enabled: true,
      payment_store_credit_enabled: true,
      payment_other_enabled: true,
      receipt_print_after_sale: true,
      receipt_show_sku: true,
      receipt_show_platform_condition: true,
      receipt_show_tax_rate: true,
      receipt_show_barcode: true,
      receipt_show_customer: false,
      receipt_return_policy: "All sales final.",
      sale_id_prefix: "SO",
      max_held_sales: 20,
      quick_discount_percent_1: 5,
      quick_discount_percent_2: 10,
      quick_discount_amount_1: 5,
      quick_discount_amount_2: 10,
      closeout_variance_warn_cents: 500,
      closeout_require_note_on_variance: true,
      closeout_require_opening_cash: false,
      owner_locked: {}
    },
    trade: {
      quote_expiry_days: 30,
      approval_cash_limit_cents: 10000,
      approval_credit_limit_cents: 15000,
      ebay_country: "US",
      ebay_sold_enabled: 1,
      ebay_active_enabled: 1,
      default_credit_percent: 50,
      default_cash_percent: 80,
      margin_floor_percent: 45,
      offer_basis: "sold_median",
      default_hold_days: 0,
      require_customer: 0,
      require_seller_id: 0,
      require_agreement: 1,
      testing_queue_enabled: 1,
      auto_label_on_complete: 1,
      promo_active: 0,
      promo_label: "",
      promo_credit_bonus_percent: 0
    },
    ai: {
      mode: "lab",
      chattiness: "normal"
    }
  };
  const canEdit = {
    settings: true,
    owner_lock: true,
    tax_rate: true
  };

  return async function mockFetch(url, options = {}) {
    const target = new URL(url);
    const method = String(options.method || "GET").toUpperCase();
    const body = options.body ? JSON.parse(options.body) : {};

    if (target.pathname === "/api/settings/store" && method === "GET") {
      return response({ ok: true, settings: state.store, can_edit: canEdit });
    }
    if (target.pathname === "/api/settings/store" && method === "PUT") {
      Object.assign(state.store, body);
      if (body.lock_owner_settings !== undefined) {
        state.store.owner_locked = Object.fromEntries(Object.keys(state.store).map((key) => [key, !!body.lock_owner_settings]));
      }
      return response({ ok: true, settings: state.store, can_edit: canEdit });
    }
    if (target.pathname === "/api/settings/register" && method === "GET") {
      return response({ ok: true, settings: state.register, can_edit: canEdit });
    }
    if (target.pathname === "/api/settings/register" && method === "PUT") {
      Object.assign(state.register, body);
      if (body.lock_owner_settings !== undefined) {
        state.register.owner_locked = {
          tax_rate: !!body.lock_owner_settings,
          require_pin_for_price_override: !!body.lock_owner_settings,
          require_pin_for_discounts: !!body.lock_owner_settings
        };
      }
      return response({ ok: true, settings: state.register, can_edit: canEdit });
    }
    if (target.pathname === "/api/trade/settings" && method === "GET") {
      return response({ ok: true, base: state.trade });
    }
    if (target.pathname === "/api/trade/settings" && method === "PUT") {
      Object.assign(state.trade, body);
      return response({ ok: true, base: state.trade });
    }
    if (target.pathname === "/api/ai/settings" && method === "GET") {
      return response({ ...state.ai });
    }
    if (target.pathname === "/api/ai/settings" && method === "POST") {
      Object.assign(state.ai, body);
      return response({ ...state.ai });
    }
    if (target.pathname === "/api/settings/system" && method === "GET") {
      return response({
        ok: true,
        api: { host: "127.0.0.1", port: 5175 },
        integrations: {
          ai_configured: true,
          ai_mode: state.ai.mode,
          ai_chattiness: state.ai.chattiness,
          ebay_adapter: true,
          wix_enabled: true,
          wix_configured: true
        },
        last_runs: {
          store_oracle: "2026-05-07T05:00:00.000Z",
          market_watcher: "2026-05-07T05:00:00.000Z",
          trend_watcher: null
        }
      });
    }
    return response({ ok: false, error: "not_found" }, 404);
  };
}

async function waitFor(fn, message) {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (fn()) {
      assert(true, message);
      return;
    }
    await sleep(100);
  }
  assert(false, message);
}

function fill(document, id, value) {
  const el = document.getElementById(id);
  el.value = String(value);
  el.dispatchEvent({ type: "input", target: el });
  el.dispatchEvent({ type: "change", target: el });
}

function setChecked(document, id, checked) {
  const el = document.getElementById(id);
  el.checked = !!checked;
  el.dispatchEvent({ type: "change", target: el });
}

async function runSettingsScript(sessionId) {
  const { document, localStorage } = buildSettingsDom(sessionId);
  const window = { location: { href: "file:///src/renderer/settings.html" }, localStorage };
  const context = {
    document,
    window,
    localStorage,
    fetch: makeMockFetch(),
    console,
    Headers,
    Event: class Event {
      constructor(type) {
        this.type = type;
      }
    },
    setTimeout,
    clearTimeout,
    Promise,
    Number,
    String,
    Date,
    JSON,
    Array,
    Object,
    Math
  };

  const script = fs.readFileSync(path.join(ROOT, "src", "renderer", "settings.js"), "utf8");
  vm.runInNewContext(script, context, { filename: "settings.js" });
  document.dispatchEvent({ type: "DOMContentLoaded" });

  const text = (id) => (document.getElementById(id).textContent || "").trim();
  const val = (id) => document.getElementById(id).value;

  await waitFor(() => text("settingsTopStatus") === "Settings loaded.", "initial settings load");

  for (const tab of ["store", "register", "trade", "ai", "local", "system"]) {
    document.querySelector(`.tab[data-tab="${tab}"]`).click();
    assert(document.querySelector(`.view[data-view="${tab}"]`).classList.contains("active"), `tab opens: ${tab}`);
  }

  document.querySelector('.tab[data-tab="store"]').click();
  fill(document, "storeName", "VaultCore Smoke Store");
  fill(document, "lowStockThreshold", "3");
  fill(document, "defaultMarkupPercent", "125");
  setChecked(document, "lockStoreSettings", false);
  document.getElementById("btnSaveStore").click();
  await waitFor(() => text("storeStatus").includes("saved"), "save store settings");
  assert(val("storeName") === "VaultCore Smoke Store", "store value remains after save");

  document.querySelector('.tab[data-tab="register"]').click();
  fill(document, "settingsTaxRate", "8.25");
  fill(document, "settingsTaxLabel", "NJ Sales Tax");
  fill(document, "saleIdPrefix", "RC");
  fill(document, "maxHeldSales", "30");
  setChecked(document, "settingsPinPriceOverride", true);
  setChecked(document, "settingsPinDiscounts", true);
  setChecked(document, "settingsPinTaxExempt", true);
  setChecked(document, "requireCustomerForSale", true);
  setChecked(document, "allowSplitTender", false);
  setChecked(document, "paymentCashEnabled", true);
  setChecked(document, "paymentCardEnabled", true);
  setChecked(document, "paymentStoreCreditEnabled", true);
  setChecked(document, "paymentOtherEnabled", true);
  fill(document, "quickDiscountPercent1", "7");
  fill(document, "quickDiscountPercent2", "12");
  fill(document, "quickDiscountAmount1", "3.00");
  fill(document, "quickDiscountAmount2", "8.00");
  setChecked(document, "receiptPrintAfterSale", false);
  setChecked(document, "receiptShowSku", true);
  setChecked(document, "receiptShowPlatformCondition", true);
  setChecked(document, "receiptShowTaxRate", true);
  setChecked(document, "receiptShowBarcode", true);
  setChecked(document, "receiptShowCustomer", true);
  fill(document, "receiptReturnPolicy", "Smoke returns policy.");
  fill(document, "closeoutVarianceWarn", "10.00");
  setChecked(document, "closeoutRequireNoteOnVariance", true);
  setChecked(document, "closeoutRequireOpeningCash", false);
  document.getElementById("btnSaveTaxSettings").click();
  await waitFor(() => text("registerStatus").includes("saved"), "save register settings");
  assert(val("settingsTaxLabel") === "NJ Sales Tax", "register tax label remains after save");
  assert(document.getElementById("allowSplitTender").checked === false, "split tender toggle remains after save");

  document.querySelector('.tab[data-tab="trade"]').click();
  fill(document, "tradeExpiryDays", "21");
  fill(document, "tradeCashLimit", "50.00");
  fill(document, "tradeCreditLimit", "75.00");
  fill(document, "tradeCountry", "US");
  fill(document, "tradeDefaultCreditPercent", "55");
  fill(document, "tradeDefaultCashPercent", "75");
  fill(document, "tradeMarginFloorPercent", "40");
  fill(document, "tradeDefaultHoldDays", "7");
  fill(document, "tradePromoLabel", "Bonus weekend");
  fill(document, "tradePromoCreditBonus", "10");
  document.getElementById("tradeOfferBasis").value = "pricecharting";
  setChecked(document, "tradeEbaySold", true);
  setChecked(document, "tradeEbayActive", false);
  setChecked(document, "tradeRequireCustomer", true);
  setChecked(document, "tradeRequireSellerId", true);
  setChecked(document, "tradeRequireAgreement", true);
  setChecked(document, "tradeTestingQueueEnabled", true);
  setChecked(document, "tradeAutoLabelOnComplete", true);
  setChecked(document, "tradePromoActive", true);
  document.getElementById("btnSaveTrade").click();
  await waitFor(() => text("tradeStatus").includes("saved"), "save trade settings");

  document.querySelector('.tab[data-tab="ai"]').click();
  fill(document, "aiMode", "lab");
  fill(document, "aiChattiness", "quiet");
  document.getElementById("btnSaveAi").click();
  await waitFor(() => text("aiStatus").includes("saved"), "save AI settings");

  document.querySelector('.tab[data-tab="local"]').click();
  setChecked(document, "vaultcoreLoadingEnabled", false);
  document.getElementById("btnSaveLocal").click();
  await waitFor(() => text("localStatus").includes("saved"), "save local settings");
  assert(localStorage.getItem("vaultcore_loading_disabled") === "1", "local loading toggle persisted");

  const nameCol = document.querySelector('.export-col[data-col="name"]');
  nameCol.checked = false;
  document.getElementById("btnSaveExportCols").click();
  await waitFor(() => text("exportColsStatus").includes("Saved"), "save export columns");
  assert(!JSON.parse(localStorage.getItem("customersExportColumns") || "[]").includes("name"), "export columns persisted");

  document.querySelector('.tab[data-tab="system"]').click();
  document.getElementById("btnRefreshSystem").click();
  await waitFor(() => text("systemStatus").includes("loaded"), "refresh system status");
  assert(document.getElementById("systemCards").children.length >= 4, "system cards render");

  document.getElementById("back-btn").click();
  assert(window.location.href === "index.html", "dashboard button navigates");
}

async function main() {
  await runSettingsScript("smoke-session");
  if (failures.length) throw new Error(failures.join("\n"));
  log("settings UI smoke passed");
}

main()
  .catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode || 0));
