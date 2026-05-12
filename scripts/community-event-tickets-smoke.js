const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, ".codex-community-ticket-smoke");
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
          const err = new Error(data.error || `${res.statusCode} ${res.statusMessage}`);
          err.data = data;
          reject(err);
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

  const created = await requestJson(baseUrl, "/api/community-events", {
    method: "POST",
    sid,
    body: {
      title: "Pokemon League",
      game: "Pokemon",
      eventType: "League",
      startsAt: "2026-05-09T13:00",
      capacity: 4,
      entryFee: "7.00"
    }
  });
  const eventId = created.event.id;

  const generated = await requestJson(baseUrl, `/api/community-events/${eventId}/tickets/generate`, {
    method: "POST",
    sid,
    body: { count: 2, label: "Raffle" }
  });
  if (generated.created.length !== 2) {
    throw new Error(`expected 2 tickets, got ${generated.created.length}`);
  }
  const first = generated.created[0];
  if (first.attendee.name !== "Raffle 001") {
    throw new Error(`custom ticket label was not applied: ${first.attendee.name}`);
  }
  if (!first.item?.sku || !String(first.item?.barcode || "").startsWith("CE:")) {
    throw new Error("ticket item missing POS barcode");
  }

  const sale = await requestJson(baseUrl, "/api/sales/complete", {
    method: "POST",
    sid,
    body: {
      sale: {
        id: "ticket-smoke-1",
        items: [{ sku: first.item.sku, qty: 1, price: 7 }],
        subtotal: 7,
        tax: 0,
        total: 7,
        tender: { type: "cash", paid: 7, change: 0 },
        customer: { name: "Jordan Player", phone: "555-0102" }
      }
    }
  });
  if (!sale.saleId) throw new Error("ticket sale failed");

  const detail = await requestJson(baseUrl, `/api/community-events/${eventId}`, { sid });
  const attendee = detail.attendees.find((row) => row.id === first.attendee.id);
  if (!attendee?.paid || attendee.paymentMethod !== "cash") {
    throw new Error("sold ticket did not mark attendee paid");
  }
  if (attendee.name !== "Jordan Player") {
    throw new Error(`ticket buyer name was not applied: ${attendee.name}`);
  }

  const generic = await requestJson(baseUrl, `/api/community-events/${eventId}/tickets/generate`, {
    method: "POST",
    sid,
    body: { count: 1, kind: "generic", label: "Door Prize" }
  });
  if (generic.created.length !== 1) {
    throw new Error(`expected 1 generic ticket, got ${generic.created.length}`);
  }
  const genericTicket = generic.created[0];
  if (genericTicket.kind !== "generic" || genericTicket.item !== null) {
    throw new Error("generic ticket should not create a POS item");
  }
  if (!String(genericTicket.scanCode || "").startsWith("CE:")) {
    throw new Error("generic ticket missing scan code");
  }

  console.log("community POS and generic ticket smoke passed");
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
