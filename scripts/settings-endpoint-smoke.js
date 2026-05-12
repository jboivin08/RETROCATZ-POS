const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, ".codex-settings-endpoint-smoke");
const TEST_PASSWORD = "Ownerpass123";

let server = null;

function log(message) {
  console.log(`[settings-api] ${message}`);
}

function requestJson(baseUrl, pathName, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ? JSON.stringify(options.body) : "";
    const url = new URL(pathName, baseUrl);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: options.method || "GET",
      headers: {
        "Content-Type": "application/json",
        ...(options.sid ? { rc_session_id: options.sid } : {}),
        ...(body ? { "Content-Length": Buffer.byteLength(body) } : {})
      }
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        const data = raw ? JSON.parse(raw) : {};
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(data.error || `${res.statusCode} ${res.statusMessage}`));
          return;
        }
        resolve(data);
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.closeSync(fs.openSync(path.join(DATA_DIR, "inventory.db"), "w"));

  process.env.RETROCATZ_POS_DATA_DIR = DATA_DIR;
  process.env.PORT = "0";
  process.env.OPENAI_API_KEY = "";
  process.env.EBAY_APP_ID = "";
  process.env.WIX_SYNC_ENABLED = "0";

  const express = require("express");
  const originalListen = express.application.listen;
  express.application.listen = function patchedListen(_port, _host, callback) {
    server = originalListen.call(this, 0, "127.0.0.1", callback);
    return server;
  };

  require(path.join(ROOT, "backend", "index.js"));

  if (!server.address()) {
    await new Promise((resolve) => server.once("listening", resolve));
  }
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  log(`private API ${baseUrl}`);

  const status = await requestJson(baseUrl, "/api/bootstrap/status");
  if (status.hasUsers === false) {
    await requestJson(baseUrl, "/api/bootstrap", {
      method: "POST",
      body: { username: "owner", display_name: "Owner", password: TEST_PASSWORD }
    });
  }

  const login = await requestJson(baseUrl, "/api/login", {
    method: "POST",
    body: { username: "owner", password: TEST_PASSWORD }
  });
  const sid = login.session_id;

  const store = await requestJson(baseUrl, "/api/settings/store", { sid });
  if (!store.settings || store.can_edit?.settings !== true) throw new Error("store settings did not load editable");
  await requestJson(baseUrl, "/api/settings/store", {
    method: "PUT",
    sid,
    body: {
      store_name: "VaultCore Smoke Store",
      low_stock_threshold: 3,
      default_markup_percent: 125,
      lock_owner_settings: false
    }
  });

  await requestJson(baseUrl, "/api/settings/register", {
    method: "PUT",
    sid,
    body: {
      tax_rate: 0.0825,
      tax_label: "NJ Sales Tax",
      require_pin_for_price_override: true,
      require_pin_for_discounts: true,
      require_pin_for_tax_exempt: true,
      require_customer_for_sale: false,
      allow_split_tender: true,
      payment_cash_enabled: true,
      payment_card_enabled: true,
      payment_store_credit_enabled: true,
      payment_other_enabled: true,
      receipt_print_after_sale: false,
      receipt_show_sku: true,
      receipt_show_platform_condition: true,
      receipt_show_tax_rate: true,
      receipt_show_barcode: true,
      receipt_show_customer: true,
      receipt_return_policy: "Smoke returns policy.",
      sale_id_prefix: "RC",
      max_held_sales: 30,
      quick_discount_percent_1: 7,
      quick_discount_percent_2: 12,
      quick_discount_amount_1: 3,
      quick_discount_amount_2: 8,
      closeout_variance_warn_cents: 1000,
      closeout_require_note_on_variance: true,
      closeout_require_opening_cash: false,
      lock_owner_settings: false
    }
  });
  const register = await requestJson(baseUrl, "/api/settings/register", { sid });
  if (register.settings.tax_label !== "NJ Sales Tax") throw new Error("register tax label did not persist");
  if (register.settings.sale_id_prefix !== "RC") throw new Error("sale prefix did not persist");
  if (register.settings.receipt_print_after_sale !== false) throw new Error("receipt auto-print setting did not persist");

  await requestJson(baseUrl, "/api/trade/settings", {
    method: "PUT",
    sid,
    body: {
      quote_expiry_days: 21,
      approval_cash_limit_cents: 5000,
      approval_credit_limit_cents: 7500,
      ebay_sold_enabled: true,
      ebay_active_enabled: false,
      ebay_country: "US",
      default_credit_percent: 55,
      default_cash_percent: 75,
      margin_floor_percent: 40,
      offer_basis: "pricecharting",
      default_hold_days: 7,
      require_customer: true,
      require_seller_id: true,
      require_agreement: true,
      testing_queue_enabled: true,
      auto_label_on_complete: true,
      promo_active: true,
      promo_label: "Bonus weekend",
      promo_credit_bonus_percent: 10
    }
  });
  const trade = await requestJson(baseUrl, "/api/trade/settings", { sid });
  if (trade.base.default_credit_percent !== 55) throw new Error("trade credit percent did not persist");
  if (trade.base.require_seller_id !== 1) throw new Error("trade seller ID requirement did not persist");
  if (trade.base.promo_label !== "Bonus weekend") throw new Error("trade promo label did not persist");

  await requestJson(baseUrl, "/api/ai/settings", {
    method: "POST",
    sid,
    body: { mode: "lab", chattiness: "quiet" }
  });

  const system = await requestJson(baseUrl, "/api/settings/system", { sid });
  if (!system.integrations) throw new Error("system status did not return integrations");

  log("settings endpoint smoke passed");
}

main()
  .catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  })
  .finally(() => {
    if (server) {
      try { server.close(); } catch {}
    }
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
    process.exit(process.exitCode || 0);
  });
