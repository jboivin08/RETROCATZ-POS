const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, ".codex-community-events-smoke");
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
      title: "Friday Night Magic",
      game: "Magic: The Gathering",
      eventType: "Tournament",
      status: "scheduled",
      startsAt: "2026-05-08T18:00",
      capacity: 2,
      entryFee: "5.00",
      prizePool: "10.00",
      prizeNotes: "Pack per win"
    }
  });
  if (!created.event?.id) throw new Error("event create failed");
  const eventId = created.event.id;

  const attendeeOne = await requestJson(baseUrl, `/api/community-events/${eventId}/attendees`, {
    method: "POST",
    sid,
    body: {
      name: "Alex Player",
      phone: "555-0101",
      status: "checked_in",
      paid: true,
      paymentMethod: "card",
      entryFee: "5.00"
    }
  });
  if (!attendeeOne.attendee?.id || attendeeOne.event?.stats?.checked_in_count !== 1) {
    throw new Error("checked-in attendee failed");
  }

  const attendeeTwo = await requestJson(baseUrl, `/api/community-events/${eventId}/attendees`, {
    method: "POST",
    sid,
    body: { name: "Sam Signup", status: "reserved", entryFee: "5.00" }
  });
  if (!attendeeTwo.attendee?.id) throw new Error("reserved attendee failed");

  let fullBlocked = false;
  try {
    await requestJson(baseUrl, `/api/community-events/${eventId}/attendees`, {
      method: "POST",
      sid,
      body: { name: "Capacity Block", status: "reserved" }
    });
  } catch (err) {
    fullBlocked = err.message === "event_full";
  }
  if (!fullBlocked) throw new Error("capacity guard failed");

  await requestJson(baseUrl, `/api/community-events/${eventId}/attendees/${attendeeTwo.attendee.id}`, {
    method: "PUT",
    sid,
    body: { status: "no_show", paid: false }
  });

  const completed = await requestJson(baseUrl, `/api/community-events/${eventId}`, {
    method: "PUT",
    sid,
    body: { status: "completed" }
  });
  if (completed.event.status !== "completed") throw new Error("event complete failed");

  const detail = await requestJson(baseUrl, `/api/community-events/${eventId}`, { sid });
  if (detail.attendees.length !== 2 || detail.event.stats.paid_total_cents !== 500) {
    throw new Error("event detail stats failed");
  }

  await requestJson(baseUrl, `/api/community-events/${eventId}`, { method: "DELETE", sid });
  console.log("community events smoke passed");
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
