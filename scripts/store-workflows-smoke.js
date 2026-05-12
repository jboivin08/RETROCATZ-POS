const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, ".codex-store-workflows-smoke");
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

function requestJsonResponse(baseUrl, pathName, options = {}) {
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
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch (err) { return reject(err); }
        resolve({ statusCode: res.statusCode, data });
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
  if (!server.address()) await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

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
  const ownerId = login.user.id;

  const customer = await requestJson(baseUrl, "/api/customers", {
    method: "POST",
    sid,
    body: { name: "Wishlist Buyer", phone: "555-0100", tax_exempt: 1 }
  });
  const customerId = customer.id;

  await requestJson(baseUrl, `/api/users/${ownerId}/pin`, {
    method: "PUT",
    sid,
    body: { pin: "1234" }
  });
  const tradeClerk = await requestJson(baseUrl, "/api/users", {
    method: "POST",
    sid,
    body: { username: "tradeclerk", display_name: "Trade Clerk", password: "Tradeclerk123", role: "clerk", active: 1, pin: "5678" }
  });
  await requestJson(baseUrl, `/api/users/${tradeClerk.id}/permissions`, {
    method: "PUT",
    sid,
    body: {
      inv_add: 0,
      inv_edit: 0,
      inv_delete: 0,
      cost_change: 0,
      category_admin: 0,
      user_admin: 0,
      checkout: 1,
      reports: 1,
      discount_override: 0,
      void_refund: 0,
      settings_admin: 0,
      closeout_admin: 0,
      tax_admin: 0,
      sync_admin: 0,
      store_credit: 0,
      trade_override: 1
    }
  });
  const tradeClerkLogin = await requestJson(baseUrl, "/api/login", {
    method: "POST",
    body: { username: "tradeclerk", password: "Tradeclerk123" }
  });
  const blockedOverride = await requestJsonResponse(baseUrl, "/api/trade/quotes", {
    method: "POST",
    sid: tradeClerkLogin.session_id,
    body: {
      customer_id: customerId,
      customer_name: "Wishlist Buyer",
      status: "accepted",
      agreement_signed: true,
      intake_checklist: { agreement_signed: true, items_present: true, condition_reviewed: true },
      final_credit_offer: 25,
      final_cash_offer: 15,
      offer_override_reason: "bundle negotiation",
      items: [{ title: "Override Trade Game", platform: "Xbox", condition: "Good", completeness: "cib", qty: 1, retailPrice: 40, creditOffer: 20, cashOffer: 12, keep: true }]
    }
  });
  if (blockedOverride.statusCode !== 403 || blockedOverride.data.permission !== "trade_override") {
    throw new Error("trade override accepted without a trade override PIN");
  }
  const tradeOverrideApproval = await requestJson(baseUrl, "/api/manager/verify-pin", {
    method: "POST",
    sid: tradeClerkLogin.session_id,
    body: { pin: "5678", permission: "trade_override", reason: "bundle negotiation" }
  });
  const overrideQuote = await requestJson(baseUrl, "/api/trade/quotes", {
    method: "POST",
    sid: tradeClerkLogin.session_id,
    body: {
      customer_id: customerId,
      customer_name: "Wishlist Buyer",
      status: "accepted",
      agreement_signed: true,
      intake_checklist: { agreement_signed: true, items_present: true, condition_reviewed: true },
      final_credit_offer: 25,
      final_cash_offer: 15,
      offer_override_reason: "bundle negotiation",
      manager_approvals: { trade_override: tradeOverrideApproval.approval_token },
      items: [{ title: "Override Trade Game", platform: "Xbox", condition: "Good", completeness: "cib", qty: 1, retailPrice: 40, creditOffer: 20, cashOffer: 12, keep: true }]
    }
  });
  const overrideDetail = await requestJson(baseUrl, `/api/trade/quotes/${encodeURIComponent(overrideQuote.quote_id)}`, { sid });
  if (overrideDetail.quote.offer_override_reason !== "bundle negotiation") throw new Error("trade override note was not saved");
  if (Number(overrideDetail.quote.offer_override_approved_by || 0) !== Number(tradeClerk.id)) throw new Error("trade override approval user was not saved");

  const taskSummary = await requestJson(baseUrl, "/api/tasks/summary", { sid });
  if (!taskSummary.counts || Number(taskSummary.counts.open || 0) < 1) throw new Error("task summary did not return seeded manager tasks");
  const managerTask = await requestJson(baseUrl, "/api/tasks", {
    method: "POST",
    sid,
    body: { title: "Smoke task", description: "verify task queue", category: "store", assigned_scope: "all", priority: "normal" }
  });
  const taskDone = await requestJson(baseUrl, `/api/tasks/${managerTask.task.id}`, {
    method: "PUT",
    sid,
    body: { status: "done" }
  });
  if (taskDone.task.status !== "done") throw new Error("manager task did not complete");

  const itemA = await requestJson(baseUrl, "/api/items", {
    method: "POST",
    sid,
    body: { title: "Chrono Trigger", platform: "SNES", category: "Games", condition: "Good", qty: 1, cost: 20, price: 99.99 }
  });
  const itemB = await requestJson(baseUrl, "/api/items", {
    method: "POST",
    sid,
    body: { title: "SNES Controller", platform: "SNES", category: "Accessories", condition: "Good", qty: 1, cost: 8, price: 29.99 }
  });

  await requestJson(baseUrl, "/api/wishlist", {
    method: "POST",
    sid,
    body: { customer_id: customerId, title: "Chrono Trigger", platform: "SNES", max_price: 120 }
  });
  const matches = await requestJson(baseUrl, "/api/wishlist/matches", { sid });
  if (!matches.rows.some((row) => row.sku === itemA.item.sku && row.matches.length)) {
    throw new Error("wishlist did not match inventory item");
  }
  const customerWorkflows = await requestJson(baseUrl, `/api/customers/${customerId}/workflows`, { sid });
  if (!customerWorkflows.wishlist.some((row) => row.title === "Chrono Trigger" && row.matches.length)) {
    throw new Error("customer workflow snapshot did not include wishlist matches");
  }

  const bundle = await requestJson(baseUrl, "/api/bundles", {
    method: "POST",
    sid,
    body: {
      title: "SNES Starter Bundle",
      price: 119.99,
      components: [
        { item_id: itemA.item.id, qty: 1 },
        { item_id: itemB.item.id, qty: 1 }
      ]
    }
  });
  if (!bundle.bundle.available) throw new Error("bundle should start available");

  await requestJson(baseUrl, "/api/sales/complete", {
    method: "POST",
    sid,
    body: {
      sale: {
        id: "component-sale-1",
        customer_id: customerId,
        tax_exempt: false,
        items: [{ sku: itemA.item.sku, qty: 1, price: 99.99 }],
        tender: { type: "cash", paid: 110, change: 3.01 }
      }
    }
  });
  const bundlesAfterSale = await requestJson(baseUrl, "/api/bundles", { sid });
  const soldComponentBundle = bundlesAfterSale.rows.find((row) => row.id === bundle.bundle.id);
  if (!soldComponentBundle || soldComponentBundle.available) {
    throw new Error("bundle stayed available after component sold");
  }

  const layItem = await requestJson(baseUrl, "/api/items", {
    method: "POST",
    sid,
    body: { title: "Layaway Game", platform: "PS2", category: "Games", condition: "Good", qty: 2, cost: 5, price: 25 }
  });
  const layaway = await requestJson(baseUrl, "/api/layaways", {
    method: "POST",
    sid,
    body: { customer_id: customerId, deposit: 5, items: [{ item_id: layItem.item.id, qty: 1 }] }
  });
  const reservedItem = await requestJson(baseUrl, `/api/items/${layItem.item.id}`, { sid });
  if (Number(reservedItem.item.qty) !== 1) throw new Error("layaway did not reserve inventory");
  await requestJson(baseUrl, `/api/layaways/${layaway.layaway.id}/cancel`, { method: "POST", sid });
  const restoredItem = await requestJson(baseUrl, `/api/items/${layItem.item.id}`, { sid });
  if (Number(restoredItem.item.qty) !== 2) throw new Error("layaway cancel did not restore inventory");

  const bundleLayA = await requestJson(baseUrl, "/api/items", {
    method: "POST",
    sid,
    body: { title: "Bundle Lay Console", platform: "PS2", category: "Consoles", condition: "Good", qty: 1, cost: 20, price: 60 }
  });
  const bundleLayB = await requestJson(baseUrl, "/api/items", {
    method: "POST",
    sid,
    body: { title: "Bundle Lay Controller", platform: "PS2", category: "Accessories", condition: "Good", qty: 1, cost: 5, price: 20 }
  });
  const layBundle = await requestJson(baseUrl, "/api/bundles", {
    method: "POST",
    sid,
    body: {
      title: "PS2 Layaway Bundle",
      price: 79.99,
      components: [
        { item_id: bundleLayA.item.id, qty: 1 },
        { item_id: bundleLayB.item.id, qty: 1 }
      ]
    }
  });
  const bundleLayaway = await requestJson(baseUrl, "/api/layaways", {
    method: "POST",
    sid,
    body: { customer_id: customerId, deposit: 10, items: [{ item_id: layBundle.bundle.bundle_item_id, qty: 1 }] }
  });
  const reservedBundleComponent = await requestJson(baseUrl, `/api/items/${bundleLayA.item.id}`, { sid });
  if (Number(reservedBundleComponent.item.qty) !== 0) throw new Error("bundle layaway did not reserve components");
  const inactiveBundle = await requestJson(baseUrl, "/api/bundles", { sid });
  if (inactiveBundle.rows.find((row) => row.id === layBundle.bundle.id)?.available) {
    throw new Error("bundle stayed available after bundle layaway reserve");
  }
  await requestJson(baseUrl, `/api/layaways/${bundleLayaway.layaway.id}/cancel`, { method: "POST", sid });
  const restoredBundleComponent = await requestJson(baseUrl, `/api/items/${bundleLayA.item.id}`, { sid });
  if (Number(restoredBundleComponent.item.qty) !== 1) throw new Error("bundle layaway cancel did not restore components");

  const preorder = await requestJson(baseUrl, "/api/preorders", {
    method: "POST",
    sid,
    body: { customer_id: customerId, title: "Future Game", platform: "Switch 2", deposit: 10 }
  });
  await requestJson(baseUrl, `/api/preorders/${preorder.preorder.id}`, {
    method: "PUT",
    sid,
    body: { status: "fulfilled" }
  });

  const repair = await requestJson(baseUrl, "/api/repairs", {
    method: "POST",
    sid,
    body: { customer_id: customerId, device: "PS2 Console", issue: "No video", estimate: 45 }
  });
  await requestJson(baseUrl, `/api/repairs/${repair.repair.id}`, {
    method: "PUT",
    sid,
    body: { status: "ready" }
  });

  const loyaltyItem = await requestJson(baseUrl, "/api/items", {
    method: "POST",
    sid,
    body: { title: "Loyalty Console", platform: "Xbox", category: "Consoles", condition: "Good", qty: 1, cost: 30, price: 120 }
  });
  await requestJson(baseUrl, "/api/sales/complete", {
    method: "POST",
    sid,
    body: {
      sale: {
        id: "loyalty-sale-1",
        customer_id: customerId,
        tax_exempt: false,
        items: [{ sku: loyaltyItem.item.sku, qty: 1, price: 120 }],
        tender: { type: "cash", paid: 130, change: 1.60 }
      }
    }
  });
  const loyaltyCustomer = await requestJson(baseUrl, `/api/customers/${customerId}`, { sid });
  if (Number(loyaltyCustomer.customer.loyalty_points || 0) < 100) {
    throw new Error("loyalty points were not awarded");
  }
  await requestJson(baseUrl, `/api/customers/${customerId}/loyalty/redeem`, {
    method: "POST",
    sid,
    body: { points: 100 }
  });
  const redeemedCustomer = await requestJson(baseUrl, `/api/customers/${customerId}`, { sid });
  if (Number(redeemedCustomer.customer.store_credit_cents || 0) < 500) {
    throw new Error("loyalty redemption did not add store credit");
  }

  const quote = await requestJson(baseUrl, "/api/trade/quotes", {
    method: "POST",
    sid,
    body: {
      customer_id: customerId,
      customer_name: "Wishlist Buyer",
      agreement_signed: true,
      intake_checklist: { agreement_signed: true, items_present: true, condition_reviewed: true },
      final_credit_offer: 20,
      final_cash_offer: 12,
      items: [{ title: "Trade Game", platform: "GameCube", condition: "Good", completeness: "cib", qty: 1, retailPrice: 40, creditOffer: 20, cashOffer: 12, keep: true }]
    }
  });
  const completed = await requestJson(baseUrl, `/api/trade/quotes/${quote.quote_id}/complete`, {
    method: "POST",
    sid,
    body: { payout_method: "store_credit" }
  });
  if (!completed.intakeItems || !completed.intakeItems.length) throw new Error("trade completion did not create intake items");
  if (completed.intakeItems[0].task_type !== "inventory_review") throw new Error("trade intake item was not an inventory review task");
  if (Number(completed.intakeItems[0].allocated_cost || 0) <= 0) throw new Error("trade intake item did not receive allocated cost");
  if (!completed.tasks || completed.tasks.length < 2) throw new Error("trade completion did not create follow-up tasks");
  const tradeTasks = await requestJson(baseUrl, `/api/trade/tasks?quote_id=${encodeURIComponent(quote.quote_id)}&status=all`, { sid });
  if (!tradeTasks.rows || !tradeTasks.rows.some((row) => row.task_type === "inventory_review")) throw new Error("trade tasks endpoint did not return intake review task");
  const inventoryTask = tradeTasks.rows.find((row) => row.task_type === "inventory_review");
  const completedTask = await requestJson(baseUrl, `/api/trade/tasks/${inventoryTask.id}`, {
    method: "PUT",
    sid,
    body: { status: "done", item_id: itemA.item.id, sku: itemA.item.sku, notes: "posted from add item bucket smoke" }
  });
  if (completedTask.task.status !== "done" || completedTask.task.sku !== itemA.item.sku) throw new Error("trade intake task was not marked posted");
  const tradeReport = await requestJson(baseUrl, "/api/trade/reports/summary?days=30", { sid });
  if (!tradeReport.totals || Number(tradeReport.totals.accepted_quotes || 0) < 1) throw new Error("trade report did not include accepted quote");

  console.log("store workflows smoke passed");
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
