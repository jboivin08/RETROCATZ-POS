const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, ".codex-register-permissions-smoke");
const OWNER_PASSWORD = "Ownerpass123";
const CLERK_PASSWORD = "Clerkpass123";
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
        const result = { status: res.statusCode, data };
        if (options.allowStatus && options.allowStatus.includes(res.statusCode)) {
          resolve(result);
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(data.error || `${res.statusCode} ${res.statusMessage}`));
          return;
        }
        resolve(options.raw ? result : data);
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
      body: { username: "owner", display_name: "Owner", password: OWNER_PASSWORD }
    });
  }
  return requestJson(baseUrl, "/api/login", {
    method: "POST",
    body: { username: "owner", password: OWNER_PASSWORD }
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

  const ownerLogin = await bootstrap(baseUrl);
  const ownerSid = ownerLogin.session_id;
  const ownerId = ownerLogin.user.id;

  await requestJson(baseUrl, `/api/users/${ownerId}/pin`, {
    method: "PUT",
    sid: ownerSid,
    body: { pin: "1234" }
  });

  const clerk = await requestJson(baseUrl, "/api/users", {
    method: "POST",
    sid: ownerSid,
    body: { username: "clerk", display_name: "Clerk", password: CLERK_PASSWORD, role: "clerk", active: 1 }
  });

  await requestJson(baseUrl, `/api/users/${clerk.id}/permissions`, {
    method: "PUT",
    sid: ownerSid,
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
      void_refund: 1,
      settings_admin: 0,
      closeout_admin: 0,
      tax_admin: 0,
      sync_admin: 0,
      store_credit: 0
    }
  });

  const clerkLogin = await requestJson(baseUrl, "/api/login", {
    method: "POST",
    body: { username: "clerk", password: CLERK_PASSWORD }
  });
  const clerkSid = clerkLogin.session_id;
  if (Number(clerkLogin.user.permissions.void_refund || 0) !== 1) {
    throw new Error("test setup did not grant clerk void_refund bit");
  }

  const item = await requestJson(baseUrl, "/api/items", {
    method: "POST",
    sid: ownerSid,
    body: { title: "Permission Smoke Game", platform: "PS2", category: "Games", condition: "Good", qty: 3, cost: 1, price: 10 }
  });

  const sale = await requestJson(baseUrl, "/api/sales/complete", {
    method: "POST",
    sid: ownerSid,
    body: {
      sale: {
        id: "void-permission-sale",
        items: [{ sku: item.item.sku, qty: 1, price: 10 }],
        tender: { type: "cash", paid: 11, change: 0.3 }
      }
    }
  });

  const directVoid = await requestJson(baseUrl, `/api/sales/${sale.saleId}/void`, {
    method: "POST",
    sid: clerkSid,
    body: {},
    allowStatus: [403]
  });
  if (directVoid.status !== 403 || directVoid.data.error !== "manager_approval_required") {
    throw new Error("clerk direct void was not blocked");
  }

  const approval = await requestJson(baseUrl, "/api/manager/verify-pin", {
    method: "POST",
    sid: clerkSid,
    body: { pin: "1234", permission: "void_refund", reason: "void smoke" }
  });
  await requestJson(baseUrl, `/api/sales/${sale.saleId}/void`, {
    method: "POST",
    sid: clerkSid,
    body: { manager_approvals: { void_refund: approval.approval_token } }
  });
  const voidedSale = await requestJson(baseUrl, `/api/sales/${sale.saleId}`, { sid: ownerSid });
  if (voidedSale.sale.status !== "voided") throw new Error("manager-approved clerk void did not complete");

  const refundSale = await requestJson(baseUrl, "/api/sales/complete", {
    method: "POST",
    sid: ownerSid,
    body: {
      sale: {
        id: "refund-permission-sale",
        items: [{ sku: item.item.sku, qty: 1, price: 10 }],
        tender: { type: "cash", paid: 11, change: 0.3 }
      }
    }
  });
  const refundDetail = await requestJson(baseUrl, `/api/sales/${refundSale.saleId}`, { sid: clerkSid });
  const saleItemId = refundDetail.items[0].id;
  const directRefund = await requestJson(baseUrl, `/api/sales/${refundSale.saleId}/refund`, {
    method: "POST",
    sid: clerkSid,
    body: { items: [{ sale_item_id: saleItemId, qty: 1 }], reason: "direct clerk test" },
    allowStatus: [403]
  });
  if (directRefund.status !== 403 || directRefund.data.error !== "manager_approval_required") {
    throw new Error("clerk direct refund was not blocked");
  }

  const refundApproval = await requestJson(baseUrl, "/api/manager/verify-pin", {
    method: "POST",
    sid: clerkSid,
    body: { pin: "1234", permission: "void_refund", reason: "refund smoke" }
  });
  const refund = await requestJson(baseUrl, `/api/sales/${refundSale.saleId}/refund`, {
    method: "POST",
    sid: clerkSid,
    body: {
      items: [{ sale_item_id: saleItemId, qty: 1 }],
      reason: "manager-approved clerk refund",
      manager_approvals: { void_refund: refundApproval.approval_token }
    }
  });
  if (!refund.refundId) throw new Error("manager-approved clerk refund did not complete");

  console.log("register permissions smoke passed");
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
