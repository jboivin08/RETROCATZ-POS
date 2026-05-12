const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, ".codex-advanced-workflows-smoke");
const TEST_PASSWORD = "Ownerpass123";
let server = null;

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

async function bootstrap(baseUrl) {
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
  return login.session_id;
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
  if (!server.address()) await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sid = await bootstrap(baseUrl);

  const customer = await requestJson(baseUrl, "/api/customers", {
    method: "POST",
    sid,
    body: { name: "Operations Buyer", phone: "555-0200", email: "ops@example.com" }
  });
  const customerId = customer.id;

  const item = await requestJson(baseUrl, "/api/items", {
    method: "POST",
    sid,
    body: { title: "Operations Console", platform: "PS5", category: "Consoles", condition: "Good", qty: 6, cost: 120, price: 249.99 }
  });
  const itemId = item.item.id;

  const cardItem = await requestJson(baseUrl, "/api/items", {
    method: "POST",
    sid,
    body: { title: "Lightning Bolt", platform: "Magic", category: "TCG", condition: "Near Mint", qty: 4, cost: 1, price: 3.99 }
  });

  const vendor = await requestJson(baseUrl, "/api/vendors", {
    method: "POST",
    sid,
    body: { name: "Retro Distributor", contact_name: "Riley", email: "vendor@example.com" }
  });
  if (!vendor.vendor.id) throw new Error("vendor create failed");

  const po = await requestJson(baseUrl, "/api/purchase-orders", {
    method: "POST",
    sid,
    body: {
      vendor_id: vendor.vendor.id,
      items: [{ title: "Operation Restock Game", platform: "Switch", category: "Games", condition: "Good", qty: 2, unit_cost: 8, unit_price: 24.99 }]
    }
  });
  await requestJson(baseUrl, `/api/purchase-orders/${po.purchase_order.id}/receive`, { method: "POST", sid });
  const poAfter = await requestJson(baseUrl, `/api/purchase-orders/${po.purchase_order.id}`, { sid });
  if (poAfter.purchase_order.status !== "received") throw new Error("purchase order did not receive");

  const stock = await requestJson(baseUrl, "/api/stock-counts", { method: "POST", sid, body: { label: "Smoke Count" } });
  await requestJson(baseUrl, `/api/stock-counts/${stock.stock_count.id}/lines`, {
    method: "POST",
    sid,
    body: { item_id: itemId, counted_qty: 7 }
  });
  await requestJson(baseUrl, `/api/stock-counts/${stock.stock_count.id}/complete`, { method: "POST", sid });
  const countedItem = await requestJson(baseUrl, `/api/items/${itemId}`, { sid });
  if (Number(countedItem.item.qty) !== 7) throw new Error("stock count did not adjust inventory");

  const special = await requestJson(baseUrl, "/api/special-orders", {
    method: "POST",
    sid,
    body: { customer_id: customerId, title: "Special RPG", qty: 1, deposit: 5 }
  });
  await requestJson(baseUrl, `/api/special-orders/${special.special_order.id}`, {
    method: "PUT",
    sid,
    body: { status: "arrived" }
  });

  const reservation = await requestJson(baseUrl, "/api/reservations", {
    method: "POST",
    sid,
    body: { customer_id: customerId, item_id: itemId, qty: 1 }
  });
  const reservedItem = await requestJson(baseUrl, `/api/items/${itemId}`, { sid });
  if (Number(reservedItem.item.qty) !== 6) throw new Error("reservation did not reserve stock");
  await requestJson(baseUrl, `/api/reservations/${reservation.reservation.id}`, {
    method: "PUT",
    sid,
    body: { status: "cancelled" }
  });
  const restoredItem = await requestJson(baseUrl, `/api/items/${itemId}`, { sid });
  if (Number(restoredItem.item.qty) !== 7) throw new Error("reservation cancel did not restore stock");

  await requestJson(baseUrl, "/api/followups/generate", { method: "POST", sid });
  const followups = await requestJson(baseUrl, "/api/followups", { sid });
  if (!followups.rows.some((row) => row.source_type === "special_order")) throw new Error("followups did not generate");

  const gift = await requestJson(baseUrl, "/api/gift-cards", {
    method: "POST",
    sid,
    body: { amount: 25, customer_id: customerId }
  });
  const adjustedGift = await requestJson(baseUrl, `/api/gift-cards/${gift.gift_card.id}/adjust`, {
    method: "POST",
    sid,
    body: { amount: -5, reason: "test redemption" }
  });
  if (Number(adjustedGift.gift_card.balance) !== 20) throw new Error("gift card adjustment failed");

  const promo = await requestJson(baseUrl, "/api/promotions", {
    method: "POST",
    sid,
    body: { name: "Ten Off", code: "TEN", type: "percent", value_percent: 10 }
  });
  const preview = await requestJson(baseUrl, "/api/promotions/preview", {
    method: "POST",
    sid,
    body: { code: promo.promotion.code, subtotal: 100 }
  });
  if (Number(preview.discount_cents) !== 1000) throw new Error("promotion preview failed");

  await requestJson(baseUrl, "/api/serials", {
    method: "POST",
    sid,
    body: { item_id: itemId, serial_number: "OPS-SERIAL-1" }
  });
  await requestJson(baseUrl, "/api/warranties", {
    method: "POST",
    sid,
    body: { item_id: itemId, customer_id: customerId, serial_number: "OPS-SERIAL-1", coverage_days: 45 }
  });
  await requestJson(baseUrl, `/api/items/${cardItem.item.id}/collectible-details`, {
    method: "POST",
    sid,
    body: { card_set: "Smoke Set", card_number: "001", rarity: "Rare", finish: "Foil" }
  });

  const house = await requestJson(baseUrl, "/api/house-accounts", {
    method: "POST",
    sid,
    body: { customer_id: customerId, credit_limit: 100 }
  });
  await requestJson(baseUrl, `/api/house-accounts/${house.house_account.id}/charge`, {
    method: "POST",
    sid,
    body: { amount: 30 }
  });
  const paidHouse = await requestJson(baseUrl, `/api/house-accounts/${house.house_account.id}/payment`, {
    method: "POST",
    sid,
    body: { amount: 10 }
  });
  if (Number(paidHouse.house_account.balance) !== 20) throw new Error("house account balance failed");

  await requestJson(baseUrl, "/api/time-clock/clock-in", { method: "POST", sid });
  await requestJson(baseUrl, "/api/time-clock/clock-out", { method: "POST", sid });
  const clock = await requestJson(baseUrl, "/api/time-clock", { sid });
  if (!clock.rows.length || !clock.rows[0].clock_out_at) throw new Error("time clock failed");

  await requestJson(baseUrl, "/api/buylist-rules", {
    method: "POST",
    sid,
    body: { title: "Operations Console", platform: "PS5", condition: "Good", cash: 80, credit: 100 }
  });

  const consignment = await requestJson(baseUrl, "/api/consignments", {
    method: "POST",
    sid,
    body: { customer_id: customerId, item_id: itemId, split_percent: 60, payout: 12 }
  });
  await requestJson(baseUrl, `/api/consignments/${consignment.consignment.id}/settle`, {
    method: "POST",
    sid,
    body: { payout: 12 }
  });

  const rental = await requestJson(baseUrl, "/api/rentals", {
    method: "POST",
    sid,
    body: { customer_id: customerId, item_id: itemId, fee: 9.99 }
  });
  await requestJson(baseUrl, `/api/rentals/${rental.rental.id}/return`, { method: "POST", sid });

  const backup = await requestJson(baseUrl, "/api/backups/create", { method: "POST", sid });
  if (!backup.backup.path || !fs.existsSync(backup.backup.path)) throw new Error("backup file missing");

  const movements = await requestJson(baseUrl, `/api/items/${itemId}/movements`, { sid });
  if (!movements.rows.length) throw new Error("movement history missing");

  await requestJson(baseUrl, "/api/markdowns/apply", {
    method: "POST",
    sid,
    body: { item_ids: [itemId], percent_off: 5 }
  });

  const rule = await requestJson(baseUrl, "/api/pricing-rules", {
    method: "POST",
    sid,
    body: { name: "Keystone", percent_markup: 100, min_margin_percent: 40 }
  });
  const rulePreview = await requestJson(baseUrl, `/api/pricing-rules/${rule.rule.id}/preview`, {
    method: "POST",
    sid,
    body: { item_id: itemId }
  });
  if (Number(rulePreview.suggested_cents) <= 0) throw new Error("pricing rule preview failed");

  const offline = await requestJson(baseUrl, "/api/offline-queue", {
    method: "POST",
    sid,
    body: { client_key: "offline-smoke-1", payload: { type: "note" } }
  });
  await requestJson(baseUrl, `/api/offline-queue/${offline.row.id}/process`, { method: "POST", sid });

  const online = await requestJson(baseUrl, "/api/online-orders", {
    method: "POST",
    sid,
    body: { customer_id: customerId, fulfillment_method: "pickup", items: [{ item_id: itemId, qty: 1 }] }
  });
  await requestJson(baseUrl, `/api/online-orders/${online.online_order.id}/status`, {
    method: "PUT",
    sid,
    body: { status: "cancelled" }
  });

  const deck = await requestJson(baseUrl, "/api/decklists/parse", {
    method: "POST",
    sid,
    body: { customer_id: customerId, title: "Burn", raw_text: "4 Lightning Bolt" }
  });
  if (!deck.matches.some((row) => row.item_id === cardItem.item.id)) throw new Error("decklist did not match card inventory");

  await requestJson(baseUrl, "/api/customer-messages", {
    method: "POST",
    sid,
    body: { customer_id: customerId, channel: "phone", subject: "Pickup", body: "Your item is ready." }
  });

  const kiosk = await requestJson(baseUrl, "/api/customer-kiosk/search?q=Lightning", { sid });
  if (!kiosk.rows.length) throw new Error("kiosk search failed");

  const audit = await requestJson(baseUrl, "/api/audit-log?limit=25", { sid });
  if (!audit.rows.length) throw new Error("audit log missing");

  const summary = await requestJson(baseUrl, "/api/operations/summary", { sid });
  if (!summary.counts) throw new Error("operations summary missing");

  console.log("advanced workflows smoke passed");
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
