// backend/index.js - VaultCore POS (stabilized backend, condition-agnostic accessories)
// One DB at backend/inventory.db; backward-compatible migrations.

const path = require("path");
const fs = require("fs");

// Load .env from the backend folder explicitly
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");
const bodyParser = require("body-parser");
const { initDb, DB_PATH } = require("./db");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");
const bwipjs = require("bwip-js"); // REAL barcode generator (Code128)
const PDFDocument = require("pdfkit"); // <-- NEW: PDF generator for labels
const OpenAI = require("openai");  // <-- OpenAI client
const makeAuthMW = require("./auth_mw");
const makeUserRoutes = require("./users");
const mountStoreWorkflowRoutes = require("./workflows");
const mountAdvancedWorkflowRoutes = require("./advanced-workflows");

const PORT = Number(process.env.PORT || 5175);
const HOST = process.env.HOST || "127.0.0.1";
const POS_PERMISSION_KEYS = [
  "inv_add", "inv_edit", "inv_delete", "cost_change",
  "category_admin", "user_admin", "checkout", "reports",
  "discount_override", "void_refund", "settings_admin",
  "closeout_admin", "tax_admin", "sync_admin", "store_credit",
  "trade_override"
];
const PERMISSION_SELECT_SQL = POS_PERMISSION_KEYS.join(", ");
const managerApprovalTokens = new Map();

// --- OpenAI client setup (GPT-5.1) -----------------------------------------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
let openai = null;

if (!OPENAI_API_KEY) {
  console.warn("[OPENAI] No OPENAI_API_KEY set. AI pricing endpoints will be disabled.");
} else {
  openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  console.log("[OPENAI] Client initialized with GPT-5.1");
}

// --- Optional provider (won't crash if missing) ---
let findSoldComps = null;
let findActiveComps = null;
try {
  ({ findSoldComps, findActiveComps } = require("./providers/ebay"));
} catch {
  /* adapter optional */
}
let fetchPricecharting = null;
try {
  ({ fetchPricecharting } = require("./providers/pricecharting"));
} catch {
  /* adapter optional */
}
const app = express();
app.use(bodyParser.json({ limit: "100mb" }));

const ALLOWED_ORIGINS = new Set([
  "null",
  "file://",
  `http://${HOST}:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`
]);

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  return origin.startsWith("file://");
}

// Let the packaged file:// renderer call the local backend without opening it to web pages.
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  if (!isAllowedOrigin(origin)) {
    return res.status(403).json({ ok: false, error: "origin_not_allowed" });
  }
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, rc_session_id");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Boot + tiny log
console.log("[BOOT] Using file:", __filename);
app.use((req, _res, next) => {
  console.log(`[API] ${req.method} ${req.url}`);
  next();
});

// ---------------------------------------------------------------------------
// DB (single source of truth)
// ---------------------------------------------------------------------------
console.log(`[API] Using DB: ${DB_PATH}`);
const db = initDb();
try {
  const cleared = db.prepare(`DELETE FROM sessions`).run();
  if (cleared.changes) {
    console.log(`[AUTH] Cleared ${cleared.changes} stale session(s) on startup.`);
  }
} catch (e) {
  console.warn("[AUTH] Failed to clear sessions on startup:", e.message);
}

// Auth + Bootstrap
// ---------------------------------------------------------------------------
const { requireSession, requireRole, requirePerm } = makeAuthMW(db);
const requireAuth = requireSession;
const requireReports = requirePerm("reports");
let storeWorkflows = null;
let advancedWorkflows = null;

function getSessionIdFromReq(req) {
  return req.headers["rc_session_id"] || "";
}

function userCount() {
  return db.prepare(`SELECT COUNT(*) AS c FROM users`).get().c || 0;
}

app.get("/api/bootstrap/status", (_req, res) => {
  res.json({ ok: true, hasUsers: userCount() > 0 });
});

app.post("/api/bootstrap", (req, res) => {
  if (userCount() > 0) {
    return res.status(403).json({ ok: false, error: "users_exist" });
  }
  const { username, password, display_name } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: "missing_fields" });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ ok: false, error: "password_too_short" });
  }
  try {
    const hash = bcrypt.hashSync(String(password), 10);
    const info = db.prepare(`
      INSERT INTO users (username, pw_hash, role, active, display_name, created_at)
      VALUES (?, ?, 'owner', 1, ?, datetime('now'))
    `).run(String(username).trim(), hash, display_name || null);

    const userId = info.lastInsertRowid;
    db.prepare(`
      INSERT OR REPLACE INTO permissions
        (user_id, inv_add, inv_edit, inv_delete, cost_change, category_admin, user_admin, checkout, reports,
         discount_override, void_refund, settings_admin, closeout_admin, tax_admin, sync_admin, store_credit,
         trade_override)
      VALUES (?, 1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1)
    `).run(userId);

    res.json({ ok: true });
  } catch (e) {
    console.error("[BOOTSTRAP] failed:", e);
    res.status(500).json({ ok: false, error: "bootstrap_failed" });
  }
});

app.post("/api/login", (req, res) => {
  if (userCount() === 0) {
    return res.status(409).json({ ok: false, error: "no_users" });
  }
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: "missing_credentials" });
  }
  const user = db.prepare(`SELECT * FROM users WHERE lower(username)=? AND active=1`).get(String(username).toLowerCase());
  if (!user) return res.status(401).json({ ok: false, error: "invalid_login" });

  const ok = bcrypt.compareSync(String(password), user.pw_hash || "");
  if (!ok) return res.status(401).json({ ok: false, error: "invalid_login" });

  const sid = uuidv4();
  db.prepare(`INSERT INTO sessions (id, user_id) VALUES (?, ?)`).run(sid, user.id);

  const permissions = db.prepare(`
    SELECT ${PERMISSION_SELECT_SQL}
    FROM permissions WHERE user_id = ?
  `).get(user.id) || {};

  res.json({
    ok: true,
    session_id: sid,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      display_name: user.display_name || user.username,
      permissions
    }
  });
});

app.post("/api/logout", (req, res) => {
  const sid = getSessionIdFromReq(req) || (req.body && req.body.session_id) || "";
  if (sid) db.prepare(`DELETE FROM sessions WHERE id=?`).run(sid);
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  try {
    db.prepare("UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ?").run(req.user.session_id);
  } catch {}
  const permissions = db.prepare(`
    SELECT ${PERMISSION_SELECT_SQL}
    FROM permissions WHERE user_id = ?
  `).get(req.user.id) || {};

  res.json({
    session_id: req.user.session_id,
    user: {
      id: req.user.id,
      username: req.user.username,
      role: req.user.role,
      display_name: req.user.display_name || req.user.username,
      permissions
    }
  });
});

app.get("/api/ping", requireAuth, (req, res) => {
  res.json({ ok: true, user: { id: req.user.id, username: req.user.username, role: req.user.role } });
});

// User management
makeUserRoutes(app, db, { requireSession, requireRole, requirePerm, logUserAction });

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function logInventoryMovement({ item_id, sku, qty_delta, reason, sale_id, refund_id, user_id, note }) {
  try {
    db.prepare(`
      INSERT INTO inventory_movements
        (created_at, item_id, sku, qty_delta, reason, sale_id, refund_id, user_id, note)
      VALUES (datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      item_id || null,
      sku || null,
      Number(qty_delta || 0),
      reason || null,
      sale_id || null,
      refund_id || null,
      user_id || null,
      note || null
    );
  } catch (e) {
    console.warn("[INV_MOV] Failed to log movement:", e.message);
  }
}

const INVENTORY_BUCKETS = [
  { key: "sellable", label: "Sales Section", onHand: true, online: true },
  { key: "display", label: "Display", onHand: true, online: false },
  { key: "demo", label: "Demo", onHand: true, online: false },
  { key: "event_hold", label: "Event Hold", onHand: true, online: false },
  { key: "event_active", label: "Event Active", onHand: true, online: false },
  { key: "reserved", label: "Reserved", onHand: true, online: false },
  { key: "testing_hold", label: "Testing Hold", onHand: true, online: false },
  { key: "repair_hold", label: "Repair Hold", onHand: true, online: false },
  { key: "damaged", label: "Damaged", onHand: true, online: false },
  { key: "missing", label: "Missing", onHand: false, online: false },
  { key: "waste", label: "Waste", onHand: false, online: false },
  { key: "sold", label: "Sold", onHand: false, online: false }
];
const INVENTORY_BUCKET_KEYS = new Set(INVENTORY_BUCKETS.map((b) => b.key));
const INVENTORY_ON_HAND_KEYS = new Set(INVENTORY_BUCKETS.filter((b) => b.onHand).map((b) => b.key));
const DEFAULT_INVENTORY_LOCATIONS = [{ key: "store", label: "Store" }];

function normalizeInventoryStatus(value, fallback = "sellable") {
  const cleaned = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return INVENTORY_BUCKET_KEYS.has(cleaned) ? cleaned : fallback;
}

function normalizeInventoryLocation(value, fallback = "store") {
  const cleaned = String(value || "").trim().toLowerCase().replace(/\s+/g, "_").slice(0, 80);
  return cleaned || fallback;
}

function inventoryLocationLabel(key) {
  const clean = normalizeInventoryLocation(key, "store");
  return clean
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Store";
}

function normalizeInventoryLocationSettings(raw) {
  let source = raw;
  if (typeof raw === "string") {
    try {
      source = JSON.parse(raw);
    } catch {
      source = raw.split(/\r?\n|,/);
    }
  }
  const input = Array.isArray(source) ? source : [];
  const byKey = new Map();
  const add = (entry) => {
    const rawKey = typeof entry === "object" && entry
      ? (entry.key || entry.value || entry.name || entry.label)
      : entry;
    const key = normalizeInventoryLocation(rawKey, "");
    if (!key) return;
    const rawLabel = typeof entry === "object" && entry
      ? (entry.label || entry.name || entry.value || entry.key)
      : entry;
    const label = String(rawLabel || inventoryLocationLabel(key)).trim().slice(0, 60) || inventoryLocationLabel(key);
    if (!byKey.has(key)) byKey.set(key, { key, label });
  };

  for (const loc of DEFAULT_INVENTORY_LOCATIONS) add(loc);
  for (const loc of input) add(loc);
  return [...byKey.values()];
}

function readInventoryLocations() {
  return normalizeInventoryLocationSettings(
    getPosSettingValue("inventory_locations", JSON.stringify(DEFAULT_INVENTORY_LOCATIONS))
  );
}

function serializeInventoryLocationSettings() {
  return {
    locations: readInventoryLocations(),
    default_location: "store"
  };
}

function inventoryQty(value, fallback = 0) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.max(0, n) : fallback;
}

function getInventoryBucketRows(itemId) {
  return db.prepare(`
    SELECT item_id, status, location, qty, updated_at
    FROM inventory_quantities
    WHERE item_id=?
    ORDER BY
      CASE status
        WHEN 'sellable' THEN 0
        WHEN 'display' THEN 1
        WHEN 'demo' THEN 2
        WHEN 'event_hold' THEN 3
        WHEN 'event_active' THEN 4
        WHEN 'reserved' THEN 5
        WHEN 'testing_hold' THEN 6
        WHEN 'repair_hold' THEN 7
        WHEN 'damaged' THEN 8
        WHEN 'missing' THEN 9
        WHEN 'waste' THEN 10
        WHEN 'sold' THEN 11
        ELSE 99
      END,
      location COLLATE NOCASE ASC
  `).all(Number(itemId || 0));
}

function ensureItemBucketBaseline(itemOrId) {
  const item = typeof itemOrId === "object"
    ? itemOrId
    : db.prepare(`SELECT * FROM items WHERE id=?`).get(Number(itemOrId || 0));
  if (!item?.id) return null;
  const count = db.prepare(`SELECT COUNT(*) AS c FROM inventory_quantities WHERE item_id=?`).get(item.id)?.c || 0;
  if (!count) {
    const qty = inventoryQty(item.qty, 0);
    if (qty > 0) {
      db.prepare(`
        INSERT INTO inventory_quantities (item_id, status, location, qty, updated_at)
        VALUES (?, 'sellable', 'store', ?, datetime('now'))
        ON CONFLICT(item_id, status, location)
        DO UPDATE SET qty=excluded.qty, updated_at=datetime('now')
      `).run(item.id, qty);
    }
  }
  return item;
}

function setInventoryBucketQty(itemId, status, location, qty) {
  const cleanStatus = normalizeInventoryStatus(status);
  const cleanLocation = normalizeInventoryLocation(location);
  const cleanQty = inventoryQty(qty, 0);
  db.prepare(`
    INSERT INTO inventory_quantities (item_id, status, location, qty, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(item_id, status, location)
    DO UPDATE SET qty=excluded.qty, updated_at=datetime('now')
  `).run(Number(itemId || 0), cleanStatus, cleanLocation, cleanQty);
  return cleanQty;
}

function getInventoryBucketQty(itemId, status = "sellable", location = null) {
  const cleanStatus = normalizeInventoryStatus(status);
  if (location !== null && location !== undefined && String(location).trim()) {
    return inventoryQty(db.prepare(`
      SELECT COALESCE(SUM(qty),0) AS qty
      FROM inventory_quantities
      WHERE item_id=? AND status=? AND location=?
    `).get(Number(itemId || 0), cleanStatus, normalizeInventoryLocation(location))?.qty, 0);
  }
  return inventoryQty(db.prepare(`
    SELECT COALESCE(SUM(qty),0) AS qty
    FROM inventory_quantities
    WHERE item_id=? AND status=?
  `).get(Number(itemId || 0), cleanStatus)?.qty, 0);
}

function syncItemQtyFromBuckets(itemId) {
  const placeholders = [...INVENTORY_ON_HAND_KEYS].map(() => "?").join(",");
  const row = db.prepare(`
    SELECT COALESCE(SUM(qty),0) AS qty
    FROM inventory_quantities
    WHERE item_id=? AND status IN (${placeholders})
  `).get(Number(itemId || 0), ...INVENTORY_ON_HAND_KEYS);
  const qty = inventoryQty(row?.qty, 0);
  db.prepare(`UPDATE items SET qty=? WHERE id=?`).run(qty, Number(itemId || 0));
  return qty;
}

function changeInventoryBucketQty(itemOrId, status, location, qtyDelta) {
  const item = ensureItemBucketBaseline(itemOrId);
  if (!item?.id) throw new Error("item_not_found");
  const cleanStatus = normalizeInventoryStatus(status);
  const cleanLocation = normalizeInventoryLocation(location);
  const delta = Math.trunc(Number(qtyDelta || 0));
  if (!Number.isFinite(delta) || delta === 0) {
    return db.prepare(`SELECT * FROM items WHERE id=?`).get(item.id);
  }
  const current = getInventoryBucketQty(item.id, cleanStatus, cleanLocation);
  const nextQty = current + delta;
  if (nextQty < 0) {
    throw new Error(`insufficient_bucket_qty:${item.sku || item.id}:${cleanStatus}:${current}:${Math.abs(delta)}`);
  }
  setInventoryBucketQty(item.id, cleanStatus, cleanLocation, nextQty);
  syncItemQtyFromBuckets(item.id);
  return db.prepare(`SELECT * FROM items WHERE id=?`).get(item.id);
}

function consumeInventoryFromBuckets(itemOrId, qty, statuses = ["sellable"]) {
  const item = ensureItemBucketBaseline(itemOrId);
  if (!item?.id) throw new Error("item_not_found");
  let remaining = inventoryQty(qty, 0);
  if (remaining <= 0) return [];
  const consumed = [];
  for (const rawStatus of statuses) {
    if (remaining <= 0) break;
    const status = normalizeInventoryStatus(rawStatus);
    const rows = db.prepare(`
      SELECT status, location, qty
      FROM inventory_quantities
      WHERE item_id=? AND status=? AND qty > 0
      ORDER BY CASE location WHEN 'store' THEN 0 ELSE 1 END, location COLLATE NOCASE ASC
    `).all(item.id, status);
    for (const row of rows) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, inventoryQty(row.qty, 0));
      if (take <= 0) continue;
      setInventoryBucketQty(item.id, status, row.location, inventoryQty(row.qty, 0) - take);
      consumed.push({ status, location: row.location, qty: take });
      remaining -= take;
    }
  }
  if (remaining > 0) {
    throw new Error(`insufficient_bucket_qty:${item.sku || item.id}:${statuses.join(",")}`);
  }
  syncItemQtyFromBuckets(item.id);
  return consumed;
}

function moveInventoryBucket(itemOrId, options = {}) {
  const item = ensureItemBucketBaseline(itemOrId);
  if (!item?.id) throw new Error("item_not_found");
  const qty = inventoryQty(options.qty, 0);
  if (qty <= 0) throw new Error("invalid_qty");
  const fromStatus = normalizeInventoryStatus(options.from_status || options.fromStatus || "sellable");
  const toStatus = normalizeInventoryStatus(options.to_status || options.toStatus || "sellable");
  const fromLocation = normalizeInventoryLocation(options.from_location || options.fromLocation || "store");
  const toLocation = normalizeInventoryLocation(options.to_location || options.toLocation || fromLocation || "store");
  if (fromStatus === toStatus && fromLocation === toLocation) throw new Error("same_bucket");

  const current = getInventoryBucketQty(item.id, fromStatus, fromLocation);
  if (current < qty) {
    throw new Error(`insufficient_bucket_qty:${item.sku || item.id}:${fromStatus}:${current}:${qty}`);
  }

  const beforeTotalQty = syncItemQtyFromBuckets(item.id);
  setInventoryBucketQty(item.id, fromStatus, fromLocation, current - qty);
  const targetCurrent = getInventoryBucketQty(item.id, toStatus, toLocation);
  setInventoryBucketQty(item.id, toStatus, toLocation, targetCurrent + qty);
  const totalQty = syncItemQtyFromBuckets(item.id);
  const onHandDelta = totalQty - beforeTotalQty;

  db.prepare(`
    INSERT INTO inventory_bucket_movements
      (created_at, item_id, sku, qty, from_status, from_location, to_status, to_location, reason, user_id, note)
    VALUES
      (datetime('now'), @item_id, @sku, @qty, @from_status, @from_location, @to_status, @to_location, @reason, @user_id, @note)
  `).run({
    item_id: item.id,
    sku: item.sku || null,
    qty,
    from_status: fromStatus,
    from_location: fromLocation,
    to_status: toStatus,
    to_location: toLocation,
    reason: options.reason || "bucket_move",
    user_id: options.user_id || null,
    note: options.note || null
  });

  logInventoryMovement({
    item_id: item.id,
    sku: item.sku,
    qty_delta: onHandDelta,
    reason: options.reason || "bucket_move",
    user_id: options.user_id || null,
    note: `${qty} ${fromStatus}/${fromLocation} -> ${toStatus}/${toLocation}${options.note ? `: ${options.note}` : ""}`
  });

  return {
    item: db.prepare(`SELECT * FROM items WHERE id=?`).get(item.id),
    buckets: getInventoryBucketRows(item.id),
    totalQty
  };
}

function addBucketFieldsToRows(rows) {
  const input = Array.isArray(rows) ? rows : [];
  const ids = input.map((row) => Number(row?.id || 0)).filter(Boolean);
  const byItem = new Map();
  for (let i = 0; i < ids.length; i += 800) {
    const chunk = ids.slice(i, i + 800);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const bucketRows = db.prepare(`
      SELECT item_id, status, location, qty, updated_at
      FROM inventory_quantities
      WHERE item_id IN (${placeholders})
      ORDER BY item_id ASC, status ASC, location ASC
    `).all(...chunk);
    for (const bucket of bucketRows) {
      if (!byItem.has(bucket.item_id)) byItem.set(bucket.item_id, []);
      byItem.get(bucket.item_id).push(bucket);
    }
  }
  return input.map((row) => {
    const buckets = byItem.get(row.id) || [];
    const byStatus = {};
    for (const bucket of buckets) {
      byStatus[bucket.status] = (byStatus[bucket.status] || 0) + inventoryQty(bucket.qty, 0);
    }
    const rawQty = inventoryQty(row.qty, 0);
    const sellableQty = buckets.length ? inventoryQty(byStatus.sellable, 0) : rawQty;
    return {
      ...row,
      inventory_buckets: buckets,
      inventory_by_status: byStatus,
      sellable_qty: sellableQty,
      available_to_sell: sellableQty,
      total_on_hand_qty: rawQty
    };
  });
}

function logSaleEvent({ sale_id, action, user_id, metadata }) {
  try {
    db.prepare(`
      INSERT INTO sale_events
        (sale_id, created_at, action, user_id, metadata)
      VALUES (?, datetime('now'), ?, ?, ?)
    `).run(
      sale_id,
      action || "event",
      user_id || null,
      metadata ? JSON.stringify(metadata) : null
    );
  } catch (e) {
    console.warn("[SALE_EVT] Failed to log event:", e.message);
  }
}

function insertExpense(row) {
  try {
    db.prepare(`
      INSERT INTO expenses
        (expense_date, type, category, vendor, memo, amount, tax_amount, payment_method, receipt_path,
         source, item_id, sku, title, qty, unit_cost, user_id)
      VALUES
        (@expense_date, @type, @category, @vendor, @memo, @amount, @tax_amount, @payment_method, @receipt_path,
         @source, @item_id, @sku, @title, @qty, @unit_cost, @user_id)
    `).run({
      expense_date: row.expense_date,
      type: row.type || "operating",
      category: row.category || null,
      vendor: row.vendor || null,
      memo: row.memo || null,
      amount: Number(row.amount || 0),
      tax_amount: Number(row.tax_amount || 0),
      payment_method: row.payment_method || null,
      receipt_path: row.receipt_path || null,
      source: row.source || null,
      item_id: row.item_id || null,
      sku: row.sku || null,
      title: row.title || null,
      qty: Number.isFinite(Number(row.qty)) ? Number(row.qty) : null,
      unit_cost: Number.isFinite(Number(row.unit_cost)) ? Number(row.unit_cost) : null,
      user_id: row.user_id || null
    });
  } catch (e) {
    console.warn("[EXPENSE] Failed to insert:", e.message);
  }
}

// --- WIX SYNC CONFIG & HELPERS ---------------------------------------------
const WIX_SYNC_ENABLED = process.env.WIX_SYNC_ENABLED === "on";
const WIX_API_KEY = process.env.WIX_API_KEY || "";
const WIX_SITE_ID = process.env.WIX_SITE_ID || "";
const WIX_ACCOUNT_ID = process.env.WIX_ACCOUNT_ID || "";
const WIX_CURRENCY = process.env.WIX_CURRENCY || "USD";
const WIX_SYNC_SETTING_DEFAULTS = {
  wix_auto_sync_enabled: "1",
  wix_scheduled_sync_enabled: "0",
  wix_scheduled_sync_frequency: "daily",
  wix_scheduled_sync_next_run: "",
  wix_scheduled_sync_last_run: "",
  wix_scheduled_sync_last_result: "",
  wix_manual_sync_last_run: "",
  wix_manual_sync_last_result: ""
};
const WIX_SYNC_FREQUENCIES = new Set(["hourly", "daily", "weekly", "monthly"]);
let wixFullSyncRunning = false;

function logChannelSync({ channel = "wix", action = "sync", sku = "", ok = 0, message = "" } = {}) {
  try {
    db.prepare(`
      INSERT INTO channel_sync_log (created_at, channel, action, sku, ok, message)
      VALUES (datetime('now'), ?, ?, ?, ?, ?)
    `).run(String(channel), String(action), String(sku || ""), ok ? 1 : 0, String(message || ""));
  } catch (e) {
    console.warn("[SYNC_LOG] Failed to log sync:", e.message);
  }
}

function getPosSettingValue(key, fallback = "") {
  try {
    const row = db.prepare(`SELECT value FROM pos_settings WHERE key=?`).get(String(key));
    return row ? String(row.value ?? "") : String(fallback ?? "");
  } catch {
    return String(fallback ?? "");
  }
}

function setPosSettingValue(key, value, userId = null) {
  db.prepare(`
    INSERT INTO pos_settings (key, value, owner_locked, updated_by, updated_at)
    VALUES (@key, @value, 0, @updated_by, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value=excluded.value,
      updated_by=excluded.updated_by,
      updated_at=excluded.updated_at
  `).run({
    key: String(key),
    value: String(value ?? ""),
    updated_by: userId || null
  });
}

function getWixSyncSetting(key) {
  return getPosSettingValue(key, WIX_SYNC_SETTING_DEFAULTS[key] ?? "");
}

function boolFromSetting(value, fallback = false) {
  const raw = String(value ?? (fallback ? "1" : "0")).trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
}

function isWixConfigured() {
  return !!(WIX_SYNC_ENABLED && WIX_API_KEY && WIX_SITE_ID);
}

function isWixAutoSyncEnabled() {
  return boolFromSetting(getWixSyncSetting("wix_auto_sync_enabled"), true);
}

function normalizeWixScheduleFrequency(value) {
  const frequency = String(value || "daily").trim().toLowerCase();
  return WIX_SYNC_FREQUENCIES.has(frequency) ? frequency : "daily";
}

function nextWixScheduleDate(fromDate = new Date(), frequency = "daily") {
  const next = new Date(fromDate);
  switch (normalizeWixScheduleFrequency(frequency)) {
    case "hourly":
      next.setHours(next.getHours() + 1);
      break;
    case "weekly":
      next.setDate(next.getDate() + 7);
      break;
    case "monthly":
      next.setMonth(next.getMonth() + 1);
      break;
    case "daily":
    default:
      next.setDate(next.getDate() + 1);
      break;
  }
  return next;
}

function serializeWixSyncSettings() {
  const frequency = normalizeWixScheduleFrequency(getWixSyncSetting("wix_scheduled_sync_frequency"));
  const autoPushEnabled = isWixAutoSyncEnabled();
  const scheduledEnabled = boolFromSetting(getWixSyncSetting("wix_scheduled_sync_enabled"), false);
  return {
    auto_push_enabled: autoPushEnabled,
    scheduled_sync_enabled: scheduledEnabled,
    scheduled_sync_frequency: frequency,
    scheduled_sync_next_run: getWixSyncSetting("wix_scheduled_sync_next_run"),
    scheduled_sync_last_run: getWixSyncSetting("wix_scheduled_sync_last_run"),
    scheduled_sync_last_result: getWixSyncSetting("wix_scheduled_sync_last_result"),
    manual_sync_last_run: getWixSyncSetting("wix_manual_sync_last_run"),
    manual_sync_last_result: getWixSyncSetting("wix_manual_sync_last_result"),
    full_sync_running: wixFullSyncRunning,
    wix_env_enabled: WIX_SYNC_ENABLED,
    wix_configured: isWixConfigured(),
    has_api_key: !!WIX_API_KEY,
    has_site_id: !!WIX_SITE_ID,
    currency: WIX_CURRENCY || "USD"
  };
}

function queueWixAutoItemSync(item, source = "auto") {
  if (!item || !isWixAutoSyncEnabled()) return;
  syncItemToWix(item).catch((err) =>
    console.error(`[WIX] auto sync failed after ${source}:`, err.message || err)
  );
}

function queueWixAutoSkuSync(sku, source = "auto") {
  if (!sku || !isWixAutoSyncEnabled()) return;
  syncInventoryToWixBySku(sku).catch((err) =>
    console.error(`[WIX] auto inventory sync failed after ${source}:`, sku, err.message || err)
  );
}

function queueWixAutoHide(sku, source = "auto") {
  if (!sku || !isWixAutoSyncEnabled()) return;
  hideItemInWix(sku).catch((err) =>
    console.error(`[WIX] auto hide failed after ${source}:`, sku, err.message || err)
  );
}

console.log("[WIX] Boot config:", {
  enabled: WIX_SYNC_ENABLED,
  hasApiKey: !!WIX_API_KEY,
  hasSiteId: !!WIX_SITE_ID,
  hasAccountId: !!WIX_ACCOUNT_ID,
  currency: WIX_CURRENCY
});

// If your Node/Electron has global fetch (Node 18+), we'll use that.
// Otherwise, we lazy-load node-fetch *only if* Wix sync is actually enabled.
const hasGlobalFetch = typeof fetch === "function";
const nodeFetch = !hasGlobalFetch
  ? (...args) => import("node-fetch").then((m) => m.default(...args))
  : null;

function parseAccountIdFromApiKey(apiKey) {
  try {
    const parts = String(apiKey || "").split(".");
    if (parts.length < 2) return "";
    const payload = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const data = JSON.parse(payload);
    const inner = data?.data ? JSON.parse(data.data) : null;
    return inner?.tenant?.id || inner?.tenant?.accountId || "";
  } catch {
    return "";
  }
}

async function wixRequest(path, { method = "GET", body } = {}) {
  if (!WIX_SYNC_ENABLED || !WIX_API_KEY || !WIX_SITE_ID) {
    // Not configured -> just skip
    return null;
  }

  const url = `https://www.wixapis.com${path}`;
  const accountId = WIX_ACCOUNT_ID || parseAccountIdFromApiKey(WIX_API_KEY);
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    // Wix REST: API key usually sent in Authorization header
    Authorization: WIX_API_KEY,
    "wix-site-id": WIX_SITE_ID,
    ...(accountId ? { "wix-account-id": accountId } : {})
  };

  const fetchImpl = hasGlobalFetch ? fetch : nodeFetch;
  if (!fetchImpl) {
    console.warn("[WIX] No fetch available. Install node-fetch or upgrade Node.");
    return null;
  }

  const res = await fetchImpl(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("[WIX] API error:", res.status, text);
    // include body text in the error to make debugging easier
    throw new Error(`Wix API ${res.status}: ${text}`);
  }

  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function getWixCatalogVersion() {
  try {
    const data = await wixRequest("/stores/v3/provision/version");
    const v = data?.catalogVersion || data?.version || "";
    return String(v || "").toUpperCase(); // e.g., CATALOG_V3
  } catch (err) {
    const msg = String(err?.message || "");
    if (msg.includes("CATALOG_V1_SITE_CALLING_CATALOG_V3_API")) {
      return "CATALOG_V1";
    }
    return "";
  }
}

function isCatalogV1Error(err) {
  const msg = String(err?.message || "");
  return msg.includes("CATALOG_V1_SITE_CALLING_CATALOG_V3_API");
}

function isCatalogV3Error(err) {
  const msg = String(err?.message || "");
  return msg.includes("CATALOG_V3_SITE_CALLING_CATALOG_V1_API");
}

function extractWixProducts(data) {
  if (!data) return [];
  return data.products || data.items || [];
}

function extractWixPaging(data) {
  return data?.paging || data?.metadata?.paging || {};
}

async function listWixProductsV1({ limit = 100, offset = 0 } = {}) {
  return wixRequest("/stores/v1/products/query", {
    method: "POST",
    body: {
      query: {
        paging: { limit, offset }
      }
    }
  });
}

async function scanWixProductsV1({ onProduct, limit = 100, maxPages = 2000 } = {}) {
  let offset = 0;
  let pages = 0;
  while (pages < maxPages) {
    const data = await listWixProductsV1({ limit, offset });
    const products = extractWixProducts(data);
    for (const p of products) {
      const stop = await onProduct(p);
      if (stop === true) return true;
    }
    const paging = extractWixPaging(data);
    const total = Number(paging?.total ?? paging?.count ?? paging?.totalResults ?? NaN);
    const nextCursor = paging?.cursor || paging?.nextCursor || null;
    if (nextCursor) {
      // v1 shouldn't return cursor, but guard just in case
      offset += limit;
    } else if (Number.isFinite(total)) {
      offset += limit;
      if (offset >= total) break;
    } else if (products.length < limit) {
      break;
    } else {
      offset += limit;
    }
    pages += 1;
  }
  return false;
}

async function findWixProductBySku(sku) {
  if (!sku) return null;
  const cleanSku = String(sku).trim();
  if (!cleanSku) return null;

  try {
    // Prefer v1 first (CATALOG_V1 sites). If catalog mismatch, fall back to v3.
    try {
      const search = await wixRequest("/stores/v1/products/query", {
        method: "POST",
        body: {
          query: {
            filter: { sku: { $eq: cleanSku } },
            paging: { limit: 1 }
          }
        }
      });
      return extractWixProducts(search)?.[0] || null;
    } catch (err) {
      const msg = String(err?.message || "");
      if (isCatalogV3Error(err)) {
        // site is v3, try v3 query
      } else if (msg.includes("not declared as filterable")) {
        let found = null;
        await scanWixProductsV1({
          limit: 100,
          onProduct: async (p) => {
            const sku = String(p?.sku || "").trim();
            if (sku && sku === cleanSku) {
              found = p;
              return true;
            }
            return false;
          }
        });
        return found;
      } else {
        throw err;
      }
    }

    // Catalog v3: attempt v3 query endpoint.
    const search = await wixRequest("/stores/v3/products/query", {
      method: "POST",
      body: {
        query: {
          filter: { sku: { $eq: cleanSku } },
          paging: { limit: 1 }
        }
      }
    });
    return extractWixProducts(search)?.[0] || null;
  } catch (err) {
    console.warn("[WIX] SKU lookup failed; proceeding without lookup:", err.message);
    return null;
  }
}

async function upsertWixProduct(item) {
  if (!WIX_SYNC_ENABLED) return null;
  if (!item) return null;

  const name = item.title || item.sku || "Untitled Item";
  const price = Number(item.price) || 0;
  const sku = String(item.sku || "").trim();
  if (!sku) throw new Error("missing_sku");

  const parts = [];
  if (item.platform) parts.push(item.platform);
  if (item.condition) parts.push(`Condition: ${item.condition}`);
  if (item.category) parts.push(`Category: ${item.category}`);
  const description = parts.join(" - ");

  const productPayload = {
    name,
    productType: "physical",
    priceData: {
      price,
      currency: WIX_CURRENCY || "USD"
    },
    description,
    sku,
    visible: getWixSyncQty(item) > 0
  };

  const existingId = item.wix_product_id || null;
  if (existingId) {
    await wixRequest(`/stores/v1/products/${existingId}`, {
      method: "PATCH",
      body: { product: productPayload }
    });
    return existingId;
  }

  const existing = await findWixProductBySku(sku);
  if (existing && existing.id) {
    await wixRequest(`/stores/v1/products/${existing.id}`, {
      method: "PATCH",
      body: { product: productPayload }
    });
    return existing.id;
  }

  try {
    const created = await wixRequest("/stores/v1/products", {
      method: "POST",
      body: { product: productPayload }
    });
    return created?.product?.id || created?.id || null;
  } catch (err) {
    const msg = String(err?.message || "");
    if (msg.includes("sku is not unique")) {
      const e = new Error("wix_product_id_required");
      e.code = "wix_product_id_required";
      throw e;
    }
    throw err;
  }
}

// Minimal POS -> Wix product sync.
// Now sends a proper "product" object with productType + priceData.
function getWixSyncQty(item) {
  if (!item?.id) return inventoryQty(item?.qty, 0);
  ensureItemBucketBaseline(item);
  return getInventoryBucketQty(item.id, "sellable", null);
}

async function syncWixInventoryQuantity(productId, item) {
  if (!WIX_SYNC_ENABLED || !WIX_API_KEY || !WIX_SITE_ID || !productId || !item) return false;

  const qty = getWixSyncQty(item);
  const sku = item.sku || "";

  try {
    await wixRequest(`/stores/v2/inventoryItems/product/${encodeURIComponent(productId)}`, {
      method: "PATCH",
      body: {
        inventoryItem: {
          trackQuantity: true,
          variants: [
            {
              variantId: "00000000-0000-0000-0000-000000000000",
              quantity: qty,
              inStock: qty > 0
            }
          ]
        }
      }
    });
    logChannelSync({ channel: "wix", action: "sync_inventory", sku, ok: 1, message: `qty=${qty}` });
    return true;
  } catch (err) {
    logChannelSync({
      channel: "wix",
      action: "sync_inventory",
      sku,
      ok: 0,
      message: `qty_update_failed:${err.message || "unknown"}`
    });
    return false;
  }
}

async function syncItemToWix(item) {
  if (!WIX_SYNC_ENABLED || !WIX_API_KEY || !WIX_SITE_ID) return;
  if (!item) return;

  try {
    const productId = await upsertWixProduct(item);
    if (!productId) {
      logChannelSync({ channel: "wix", action: "sync_item", sku: item.sku || "", ok: 0, message: "wix_product_missing" });
      return null;
    }
    try {
      db.prepare(`UPDATE items SET wix_product_id=? WHERE id=?`).run(productId, item.id);
    } catch {}
    const inventorySynced = await syncWixInventoryQuantity(productId, item);
    console.log("[WIX] Synced item to Wix:", { sku: item.sku || "", wixProductId: productId || null });
    logChannelSync({
      channel: "wix",
      action: "sync_item",
      sku: item.sku || "",
      ok: 1,
      message: inventorySynced ? "synced_product_inventory" : "synced_product"
    });
    return productId;
  } catch (err) {
    console.error("[WIX] Failed to sync item:", item?.sku || "", err.message);
    logChannelSync({ channel: "wix", action: "sync_item", sku: item?.sku || "", ok: 0, message: err.message || "sync_failed" });
    return null;
  }
}

async function syncAllActiveItemsToWix({ source = "manual", userId = null } = {}) {
  if (!isWixConfigured()) {
    throw new Error("wix_not_configured");
  }
  if (wixFullSyncRunning) {
    throw new Error("sync_already_running");
  }

  wixFullSyncRunning = true;
  const startedAt = new Date().toISOString();
  const rows = db.prepare(`
    SELECT *
    FROM items
    WHERE deleted_at IS NULL
    ORDER BY id ASC
  `).all();

  const summary = {
    source,
    startedAt,
    finishedAt: null,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    total: rows.length
  };

  logChannelSync({
    channel: "wix",
    action: `${source}_sync_start`,
    ok: 1,
    message: `items=${rows.length}`
  });

  try {
    for (const item of rows) {
      summary.attempted += 1;
      try {
        const productId = await syncItemToWix(item);
        if (productId) summary.succeeded += 1;
        else summary.failed += 1;
      } catch (err) {
        summary.failed += 1;
        logChannelSync({
          channel: "wix",
          action: `${source}_sync_item`,
          sku: item.sku || "",
          ok: 0,
          message: err.message || "sync_failed"
        });
      }
    }
  } finally {
    summary.finishedAt = new Date().toISOString();
    wixFullSyncRunning = false;
  }

  const message = `attempted=${summary.attempted}; succeeded=${summary.succeeded}; failed=${summary.failed}`;
  logChannelSync({
    channel: "wix",
    action: `${source}_sync_complete`,
    ok: summary.failed === 0 ? 1 : 0,
    message
  });
  logUserAction({
    userId: String(userId || ""),
    action: "wix_full_sync",
    screen: "settings",
    metadata: summary
  });
  return summary;
}

async function runDueWixScheduledSync() {
  const settings = serializeWixSyncSettings();
  if (!settings.scheduled_sync_enabled || wixFullSyncRunning) return;

  const nextRunRaw = settings.scheduled_sync_next_run;
  if (!nextRunRaw) return;
  const nextRun = new Date(nextRunRaw);
  if (Number.isNaN(nextRun.getTime()) || nextRun > new Date()) return;

  const frequency = normalizeWixScheduleFrequency(settings.scheduled_sync_frequency);
  try {
    const summary = await syncAllActiveItemsToWix({ source: "scheduled" });
    setPosSettingValue("wix_scheduled_sync_last_run", summary.finishedAt);
    setPosSettingValue("wix_scheduled_sync_last_result", `Synced ${summary.succeeded}/${summary.attempted}; failed ${summary.failed}`);
    setPosSettingValue("wix_scheduled_sync_next_run", nextWixScheduleDate(new Date(), frequency).toISOString());
  } catch (err) {
    const now = new Date();
    setPosSettingValue("wix_scheduled_sync_last_run", now.toISOString());
    setPosSettingValue("wix_scheduled_sync_last_result", err.message || "scheduled_sync_failed");
    setPosSettingValue("wix_scheduled_sync_next_run", nextWixScheduleDate(now, frequency).toISOString());
    logChannelSync({
      channel: "wix",
      action: "scheduled_sync_failed",
      ok: 0,
      message: err.message || "scheduled_sync_failed"
    });
  }
}

setInterval(() => {
  runDueWixScheduledSync().catch((err) => {
    console.error("[WIX] scheduled sync loop failed:", err.message || err);
  });
}, 60 * 1000);

function guessMimeType(filePath) {
  const ext = String(path.extname(filePath || "")).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

async function uploadToWixMedia(filePath) {
  const mimeType = guessMimeType(filePath);
  const fileName = path.basename(filePath);
  const stats = fs.statSync(filePath);

  const gen = await wixRequest("/site-media/v1/files/generate-upload-url", {
    method: "POST",
    body: {
      mimeType,
      fileName,
      sizeInBytes: String(stats.size)
    }
  });

  const uploadUrl =
    gen?.uploadUrl?.url || gen?.uploadUrl || gen?.url || null;
  const fileId = gen?.file?.id || gen?.fileId || gen?.id || null;
  const fileUrl = gen?.file?.url || gen?.file?.fileUrl || gen?.fileUrl || null;

  console.log("[WIX] generate-upload-url (file):", {
    fileName,
    mimeType,
    size: stats.size,
    uploadUrl: uploadUrl ? String(uploadUrl).slice(0, 120) : null,
    fileId,
    fileUrl: fileUrl ? String(fileUrl).slice(0, 120) : null
  });

  if (!uploadUrl) throw new Error("no_upload_url");

  const urlWithName = uploadUrl.includes("filename=")
    ? uploadUrl
    : `${uploadUrl}${uploadUrl.includes("?") ? "&" : "?"}filename=${encodeURIComponent(fileName)}`;

  const boundary = `----rcwix${crypto.randomBytes(12).toString("hex")}`;
  const prelude = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
    "utf8"
  );
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");

  const buf = fs.readFileSync(filePath);
  const fetchImpl = hasGlobalFetch ? fetch : nodeFetch;
  if (!fetchImpl) throw new Error("no_fetch_for_upload");

  const body = Buffer.concat([prelude, buf, epilogue]);
  const upRes = await fetchImpl(urlWithName, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(body.length)
    },
    body
  });
  if (!upRes.ok) {
    const text = await upRes.text().catch(() => "");
    console.error("[WIX] upload response (file):", upRes.status, text.slice(0, 400));
    throw new Error(`upload_failed:${upRes.status}:${text}`);
  }

  let uploadFileId = fileId || null;
  let uploadFileUrl = fileUrl || null;
  try {
    const text = await upRes.text();
    if (text) {
      const data = JSON.parse(text);
      uploadFileId = uploadFileId || data?.file?.id || data?.fileId || data?.id || null;
      uploadFileUrl = uploadFileUrl || data?.file?.url || data?.file?.fileUrl || data?.fileUrl || null;
      console.log("[WIX] upload response (file) json:", {
        fileId: uploadFileId,
        fileUrl: uploadFileUrl ? String(uploadFileUrl).slice(0, 120) : null
      });
    }
  } catch {}

  return { fileId: uploadFileId, fileUrl: uploadFileUrl, uploadUrl: urlWithName };
}

async function uploadToWixMediaBuffer({ buffer, mimeType, fileName }) {
  if (!buffer || !buffer.length) throw new Error("empty_buffer");
  const gen = await wixRequest("/site-media/v1/files/generate-upload-url", {
    method: "POST",
    body: {
      mimeType: mimeType || "application/octet-stream",
      fileName: fileName || "upload.bin",
      sizeInBytes: String(buffer.length)
    }
  });

  const uploadUrl =
    gen?.uploadUrl?.url || gen?.uploadUrl || gen?.url || null;
  const fileId = gen?.file?.id || gen?.fileId || gen?.id || null;
  const fileUrl = gen?.file?.url || gen?.file?.fileUrl || gen?.fileUrl || null;

  console.log("[WIX] generate-upload-url (buffer):", {
    fileName,
    mimeType,
    size: buffer.length,
    uploadUrl: uploadUrl ? String(uploadUrl).slice(0, 120) : null,
    fileId,
    fileUrl: fileUrl ? String(fileUrl).slice(0, 120) : null
  });

  if (!uploadUrl) throw new Error("no_upload_url");

  const safeName = fileName || "upload.bin";
  const urlWithName = uploadUrl.includes("filename=")
    ? uploadUrl
    : `${uploadUrl}${uploadUrl.includes("?") ? "&" : "?"}filename=${encodeURIComponent(safeName)}`;

  const boundary = `----rcwix${crypto.randomBytes(12).toString("hex")}`;
  const prelude = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
      `Content-Type: ${mimeType || "application/octet-stream"}\r\n\r\n`,
    "utf8"
  );
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");

  const fetchImpl = hasGlobalFetch ? fetch : nodeFetch;
  if (!fetchImpl) throw new Error("no_fetch_for_upload");

  const body = Buffer.concat([prelude, buffer, epilogue]);
  const upRes = await fetchImpl(urlWithName, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(body.length)
    },
    body
  });
  if (!upRes.ok) {
    const text = await upRes.text().catch(() => "");
    console.error("[WIX] upload response (buffer):", upRes.status, text.slice(0, 400));
    throw new Error(`upload_failed:${upRes.status}:${text}`);
  }

  let uploadFileId = fileId || null;
  let uploadFileUrl = fileUrl || null;
  try {
    const text = await upRes.text();
    if (text) {
      const data = JSON.parse(text);
      uploadFileId = uploadFileId || data?.file?.id || data?.fileId || data?.id || null;
      uploadFileUrl = uploadFileUrl || data?.file?.url || data?.file?.fileUrl || data?.fileUrl || null;
      console.log("[WIX] upload response (buffer) json:", {
        fileId: uploadFileId,
        fileUrl: uploadFileUrl ? String(uploadFileUrl).slice(0, 120) : null
      });
    }
  } catch {}

  return { fileId: uploadFileId, fileUrl: uploadFileUrl, uploadUrl: urlWithName };
}

async function addWixProductMedia(productId, mediaEntries) {
  if (!productId) throw new Error("missing_product_id");
  const entries = (mediaEntries || [])
    .map((m) => {
      if (!m) return null;
      if (typeof m === "string") return { id: m };
      if (m.id) return { id: m.id };
      if (m.url) return { url: m.url };
      return null;
    })
    .filter(Boolean);
  if (!entries.length) throw new Error("missing_media_ids");

  return wixRequest(`/stores/v1/products/${productId}/media`, {
    method: "POST",
    body: {
      media: entries
    }
  });
}

// Helper: load by SKU and re-sync from local DB (used when qty changes, write-offs, etc.)
async function syncInventoryToWixBySku(sku) {
  if (!WIX_SYNC_ENABLED) return;
  if (!sku) return;

  try {
    const item = db.prepare(`SELECT * FROM items WHERE sku=?`).get(sku);
    if (!item) {
      console.log(
        "[WIX] Local item missing for SKU",
        sku,
        "- consider unpublishing in Wix if needed."
      );
      logChannelSync({ channel: "wix", action: "sync_inventory", sku, ok: 0, message: "local_item_missing" });
      return;
    }
    await syncItemToWix(item);
  } catch (err) {
    console.error("[WIX] syncInventoryToWixBySku failed for", sku, err.message);
    logChannelSync({ channel: "wix", action: "sync_inventory", sku, ok: 0, message: err.message || "sync_failed" });
  }
}

// NEW: Hide/unpublish on Wix after local deletion
async function hideItemInWix(sku) {
  if (!WIX_SYNC_ENABLED) return;
  if (!sku) return;

  try {
    const cleanSku = String(sku).trim();

    // Step 1 - find matching product on Wix by SKU
    const search = await wixRequest("/stores/v1/products/query", {
      method: "POST",
      body: {
        query: {
          filter: {
            // explicit equality operator for SKU
            sku: { $eq: cleanSku }
          }
        }
      }
    });

    const product = search?.products?.[0];
    if (!product) {
      console.log("[WIX] No Wix product found for SKU", cleanSku);
      logChannelSync({ channel: "wix", action: "hide", sku: cleanSku, ok: 0, message: "not_found" });
      return;
    }

    const wixId = product.id;

    // Step 2 - PATCH the product to hide/unpublish
    const updateBody = {
      product: {
        id: wixId,
        // visible is a simple boolean
        visible: false
      }
    };

    await wixRequest(`/stores/v1/products/${wixId}`, {
      method: "PATCH",
      body: updateBody
    });

    console.log(`[WIX] Successfully hid/unpublished Wix product for SKU ${cleanSku}`);
    logChannelSync({ channel: "wix", action: "hide", sku: cleanSku, ok: 1, message: "hidden" });
  } catch (err) {
    console.error("[WIX] Hide/unpublish failed for SKU", sku, err.message);
    logChannelSync({ channel: "wix", action: "hide", sku: String(sku), ok: 0, message: err.message || "hide_failed" });
  }
}

// ---------------------------------------------------------------------------
const val = (v) => String(v ?? "").trim();
const norm = (v) => val(v).toLowerCase().replace(/\s+/g, " ");

function normalizeCategory(raw) {
  const s = val(raw);
  if (!s) return "";
  const low = s.toLowerCase();
  const map = {
    game: "Games",
    games: "Games",
    movie: "Movies",
    movies: "Movies",
    console: "Consoles",
    consoles: "Consoles",
    accessory: "Accessories",
    accessories: "Accessories",
    other: "Other"
  };
  if (map[low]) return map[low];
  return s;
}

function categoryNameKey(name) {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function serializeCategory(row) {
  return {
    id: row.id,
    name: row.name,
    sort_order: Number(row.sort_order || 0),
    active: Number(row.active ?? 1) ? 1 : 0
  };
}

app.get("/api/categories", requireAuth, (req, res) => {
  try {
    const includeInactive = String(req.query.include_inactive || "").toLowerCase() === "true";
    const rows = db.prepare(`
      SELECT id, name, sort_order, active
      FROM categories
      ${includeInactive ? "" : "WHERE active = 1"}
      ORDER BY sort_order ASC, lower(name) ASC
    `).all();
    res.json({ ok: true, rows: rows.map(serializeCategory), categories: rows.map((r) => r.name) });
  } catch (err) {
    console.error("[API] /api/categories failed:", err);
    res.status(500).json({ ok: false, error: "categories_failed" });
  }
});

app.post("/api/categories", requireAuth, requirePerm("category_admin"), (req, res) => {
  try {
    const name = normalizeCategory(req.body?.name || "");
    if (!name) return res.status(400).json({ ok: false, error: "missing_name" });
    const nameKey = categoryNameKey(name);
    const now = new Date().toISOString();
    const maxOrder = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS n FROM categories`).get()?.n ?? -1;
    db.prepare(`
      INSERT INTO categories (name, name_key, sort_order, active, created_at, updated_at)
      VALUES (@name, @name_key, @sort_order, 1, @now, @now)
      ON CONFLICT(name_key) DO UPDATE SET
        name = excluded.name,
        active = 1,
        updated_at = excluded.updated_at
    `).run({ name, name_key: nameKey, sort_order: Number(maxOrder) + 1, now });
    const row = db.prepare(`SELECT id, name, sort_order, active FROM categories WHERE name_key=?`).get(nameKey);
    logUserAction({
      userId: String(req.user.id || ""),
      username: req.user.username || "",
      action: "category_saved",
      screen: "categories",
      metadata: { categoryId: row?.id || null, name }
    });
    res.json({ ok: true, category: serializeCategory(row) });
  } catch (err) {
    console.error("[API] /api/categories create failed:", err);
    res.status(500).json({ ok: false, error: "category_save_failed" });
  }
});

app.put("/api/categories/:id", requireAuth, requirePerm("category_admin"), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "invalid_id" });
  try {
    const existing = db.prepare(`SELECT * FROM categories WHERE id=?`).get(id);
    if (!existing) return res.status(404).json({ ok: false, error: "not_found" });
    const name = normalizeCategory(req.body?.name || existing.name);
    if (!name) return res.status(400).json({ ok: false, error: "missing_name" });
    db.prepare(`
      UPDATE categories
      SET name=@name, name_key=@name_key, active=@active, updated_at=@updated_at
      WHERE id=@id
    `).run({
      id,
      name,
      name_key: categoryNameKey(name),
      active: req.body?.active === false ? 0 : 1,
      updated_at: new Date().toISOString()
    });
    const row = db.prepare(`SELECT id, name, sort_order, active FROM categories WHERE id=?`).get(id);
    res.json({ ok: true, category: serializeCategory(row) });
  } catch (err) {
    const msg = String(err.message || err).toLowerCase();
    if (msg.includes("unique")) return res.status(409).json({ ok: false, error: "duplicate_category" });
    console.error("[API] /api/categories update failed:", err);
    res.status(500).json({ ok: false, error: "category_update_failed" });
  }
});

app.delete("/api/categories/:id", requireAuth, requirePerm("category_admin"), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "invalid_id" });
  try {
    const existing = db.prepare(`SELECT * FROM categories WHERE id=?`).get(id);
    if (!existing) return res.status(404).json({ ok: false, error: "not_found" });
    db.prepare(`UPDATE categories SET active=0, updated_at=? WHERE id=?`).run(new Date().toISOString(), id);
    logUserAction({
      userId: String(req.user.id || ""),
      username: req.user.username || "",
      action: "category_archived",
      screen: "categories",
      metadata: { categoryId: id, name: existing.name }
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("[API] /api/categories delete failed:", err);
    res.status(500).json({ ok: false, error: "category_delete_failed" });
  }
});

function md5To8Digits(text) {
  const md5 = crypto.createHash("md5").update(String(text)).digest("hex");
  const n = parseInt(md5.slice(0, 8), 16) % 1e8;
  return String(n).padStart(8, "0");
}

// Category helpers: treat accessories condition-agnostically
const ACCESSORY_HINTS = [
  "accessory",
  "accessories",
  "controller",
  "controllers",
  "cable",
  "cables",
  "power supply",
  "ac adapter",
  "adapter",
  "sensor bar",
  "battery",
  "memory card",
  "dock",
  "stand",
  "grip",
  "peripheral",
  "microphone",
  "headset"
];
function isAccessoryCategory(cat) {
  const c = norm(cat);
  return ACCESSORY_HINTS.some((h) => c.includes(h));
}

// Build stable grouping key (your rule):
// - Games: category + platform + title + (NEW/USED matters)
// - Accessories: category + platform + title (ignore NEW/USED)
function buildGroupingKey({ category, platform, title, condition }) {
  const cat = norm(category || "games");
  const sys = norm(platform || "");
  const t = norm(title || "");
  const condKey = (condition || "").trim().toLowerCase().startsWith("n") ? "new" : "used";
  if (isAccessoryCategory(cat)) return [cat, sys, t].join("|");
  return [cat, sys, t, condKey].join("|");
}

function skuFromInputs({ category, platform, title, condition }) {
  const key = buildGroupingKey({ category, platform, title, condition });
  return md5To8Digits(key);
}

// User activity logger (for future user-tracking AI)
function logUserAction({ userId = "", username = "", action = "", screen = "", metadata = {} } = {}) {
  try {
    const id = uuidv4();
    const createdAt = new Date().toISOString();
    const metaJson = JSON.stringify(metadata || {});
    db.prepare(
      `
      INSERT INTO user_activity (id,userId,username,action,screen,metadata,createdAt)
      VALUES (?,?,?,?,?,?,?)
    `
    ).run(id, userId, username, action, screen, metaJson, createdAt);
  } catch (e) {
    console.warn("[USER_ACTIVITY] Failed to log action:", e.message);
  }
}

storeWorkflows = mountStoreWorkflowRoutes(app, db, {
  requireAuth,
  requirePerm,
  requireRole,
  skuFromInputs,
  normalizeCategory,
  insertExpense,
  logInventoryMovement,
  logUserAction,
  changeInventoryBucketQty,
  consumeInventoryFromBuckets,
  ensureItemBucketBaseline,
  setInventoryBucketQty,
  syncItemQtyFromBuckets,
  toCents,
  toDollars
});

advancedWorkflows = mountAdvancedWorkflowRoutes(app, db, {
  dbPath: DB_PATH,
  requireAuth,
  requirePerm,
  requireRole,
  skuFromInputs,
  normalizeCategory,
  insertExpense,
  logInventoryMovement,
  logUserAction,
  changeInventoryBucketQty,
  consumeInventoryFromBuckets,
  ensureItemBucketBaseline,
  setInventoryBucketQty,
  syncItemQtyFromBuckets,
  toCents,
  toDollars,
  storeWorkflows
});

const REGISTER_SETTING_DEFAULTS = {
  tax_rate: "0.07",
  tax_label: "Sales Tax",
  require_pin_for_price_override: "1",
  require_pin_for_discounts: "1",
  require_pin_for_tax_exempt: "1",
  require_customer_for_sale: "0",
  allow_split_tender: "1",
  payment_cash_enabled: "1",
  payment_card_enabled: "1",
  payment_store_credit_enabled: "1",
  payment_other_enabled: "1",
  receipt_print_after_sale: "1",
  receipt_show_sku: "1",
  receipt_show_platform_condition: "1",
  receipt_show_tax_rate: "1",
  receipt_show_barcode: "1",
  receipt_show_customer: "0",
  receipt_return_policy: "All sales final. Defective items may be exchanged with receipt.",
  sale_id_prefix: "SO",
  max_held_sales: "20",
  quick_discount_percent_1: "5",
  quick_discount_percent_2: "10",
  quick_discount_amount_1: "5",
  quick_discount_amount_2: "10",
  closeout_variance_warn_cents: "500",
  closeout_require_note_on_variance: "1",
  closeout_require_opening_cash: "0"
};
const REGISTER_SETTING_KEYS = Object.keys(REGISTER_SETTING_DEFAULTS);
const REGISTER_BOOL_SETTING_KEYS = new Set([
  "require_pin_for_price_override",
  "require_pin_for_discounts",
  "require_pin_for_tax_exempt",
  "require_customer_for_sale",
  "allow_split_tender",
  "payment_cash_enabled",
  "payment_card_enabled",
  "payment_store_credit_enabled",
  "payment_other_enabled",
  "receipt_print_after_sale",
  "receipt_show_sku",
  "receipt_show_platform_condition",
  "receipt_show_tax_rate",
  "receipt_show_barcode",
  "receipt_show_customer",
  "closeout_require_note_on_variance",
  "closeout_require_opening_cash"
]);
const REGISTER_MONEY_SETTING_KEYS = new Set([
  "quick_discount_amount_1",
  "quick_discount_amount_2"
]);
const REGISTER_PERCENT_SETTING_KEYS = new Set([
  "quick_discount_percent_1",
  "quick_discount_percent_2"
]);

const STORE_SETTING_DEFAULTS = {
  store_name: "VaultCore POS",
  store_phone: "",
  store_email: "",
  store_website: "",
  store_address1: "",
  store_address2: "",
  store_city: "",
  store_state: "",
  store_zip: "",
  receipt_footer: "Thank you for shopping with us.",
  low_stock_threshold: "1",
  default_inventory_category: "Games",
  default_markup_percent: "100",
  inventory_locations: JSON.stringify(DEFAULT_INVENTORY_LOCATIONS)
};
const STORE_SETTING_KEYS = Object.keys(STORE_SETTING_DEFAULTS);

function isOwnerUser(user) {
  return String(user?.role || "").toLowerCase() === "owner";
}

function isManagementUser(user) {
  const role = String(user?.role || "").toLowerCase();
  return role === "owner" || role === "manager";
}

function hasUserPermission(user, key) {
  if (!key) return true;
  if (isOwnerUser(user)) return true;
  return !!(user && user.permissions && Number(user.permissions[key] || 0) === 1);
}

function canUsePermissionDirectly(user, key) {
  if (!hasUserPermission(user, key)) return false;
  if (key === "void_refund") {
    const role = String(user?.role || "").toLowerCase();
    return role === "owner" || role === "manager";
  }
  return true;
}

function canAcceptTradeOverrideWithoutPin(user) {
  const role = String(user?.role || "").toLowerCase();
  return role === "owner" || role === "manager";
}

function getRegisterSettingRows() {
  const rows = db.prepare(`
    SELECT key, value, owner_locked, updated_by, updated_at
    FROM pos_settings
    WHERE key IN (${REGISTER_SETTING_KEYS.map(() => "?").join(",")})
  `).all(...REGISTER_SETTING_KEYS);
  const map = new Map(rows.map((r) => [r.key, r]));
  for (const key of REGISTER_SETTING_KEYS) {
    if (!map.has(key)) {
      db.prepare(`
        INSERT OR IGNORE INTO pos_settings (key, value, owner_locked, updated_at)
        VALUES (?, ?, 0, datetime('now'))
      `).run(key, REGISTER_SETTING_DEFAULTS[key]);
      map.set(key, { key, value: REGISTER_SETTING_DEFAULTS[key], owner_locked: 0, updated_by: null, updated_at: null });
    }
  }
  return map;
}

function getStoreSettingRows() {
  const rows = db.prepare(`
    SELECT key, value, owner_locked, updated_by, updated_at
    FROM pos_settings
    WHERE key IN (${STORE_SETTING_KEYS.map(() => "?").join(",")})
  `).all(...STORE_SETTING_KEYS);
  const map = new Map(rows.map((r) => [r.key, r]));
  for (const key of STORE_SETTING_KEYS) {
    if (!map.has(key)) {
      db.prepare(`
        INSERT OR IGNORE INTO pos_settings (key, value, owner_locked, updated_at)
        VALUES (?, ?, 0, datetime('now'))
      `).run(key, STORE_SETTING_DEFAULTS[key]);
      map.set(key, {
        key,
        value: STORE_SETTING_DEFAULTS[key],
        owner_locked: 0,
        updated_by: null,
        updated_at: null
      });
    }
  }
  return map;
}

function readRegisterSetting(key, fallback = "") {
  const row = getRegisterSettingRows().get(key);
  return row ? String(row.value) : (REGISTER_SETTING_DEFAULTS[key] ?? fallback);
}

function readRegisterSettingBool(key, fallback = false) {
  const raw = readRegisterSetting(key, fallback ? "1" : "0").toLowerCase().trim();
  return raw === "1" || raw === "true" || raw === "yes";
}

function readRegisterSettingInt(key, fallback = 0) {
  const n = Number(readRegisterSetting(key, String(fallback)));
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function serializeRegisterSettings() {
  const rows = getRegisterSettingRows();
  const valueFor = (key) => String(rows.get(key)?.value ?? REGISTER_SETTING_DEFAULTS[key] ?? "");
  const settings = {};
  settings.tax_rate = Math.max(0, Math.min(0.25, Number(valueFor("tax_rate")) || 0.07));
  settings.tax_label = valueFor("tax_label").slice(0, 40) || "Sales Tax";
  for (const key of REGISTER_BOOL_SETTING_KEYS) {
    settings[key] = ["1", "true", "yes", "on"].includes(valueFor(key).toLowerCase().trim());
  }
  for (const key of REGISTER_PERCENT_SETTING_KEYS) {
    const n = Number(valueFor(key));
    settings[key] = Number.isFinite(n) ? Math.max(0, Math.min(100, Number(n.toFixed(2)))) : 0;
  }
  for (const key of REGISTER_MONEY_SETTING_KEYS) {
    const n = Number(valueFor(key));
    settings[key] = Number.isFinite(n) ? Math.max(0, Math.min(999, Number(n.toFixed(2)))) : 0;
  }
  settings.receipt_return_policy = valueFor("receipt_return_policy").slice(0, 240);
  settings.sale_id_prefix = normalizeRegisterSettingValue("sale_id_prefix", valueFor("sale_id_prefix"));
  settings.max_held_sales = Math.max(1, Math.min(100, readRegisterSettingInt("max_held_sales", 20)));
  settings.closeout_variance_warn_cents = Math.max(0, Math.min(999999, readRegisterSettingInt("closeout_variance_warn_cents", 500)));
  settings.owner_locked = Object.fromEntries(REGISTER_SETTING_KEYS.map((key) => [key, Number(rows.get(key)?.owner_locked || 0) === 1]));
  settings.updated_at = Object.fromEntries(REGISTER_SETTING_KEYS.map((key) => [key, rows.get(key)?.updated_at || null]));
  return settings;
}

function serializeStoreSettings() {
  const rows = getStoreSettingRows();
  const settings = {};
  const ownerLocked = {};
  const updatedAt = {};
  for (const key of STORE_SETTING_KEYS) {
    const row = rows.get(key);
    settings[key] = key === "inventory_locations"
      ? normalizeInventoryLocationSettings(row ? row.value : STORE_SETTING_DEFAULTS[key])
      : row ? String(row.value || "") : STORE_SETTING_DEFAULTS[key];
    ownerLocked[key] = Number(row?.owner_locked || 0) === 1;
    updatedAt[key] = row?.updated_at || null;
  }
  settings.low_stock_threshold = Math.max(0, Math.min(999, Math.floor(Number(settings.low_stock_threshold || 1))));
  settings.default_markup_percent = Math.max(0, Math.min(500, Number(settings.default_markup_percent || 100)));
  settings.owner_locked = ownerLocked;
  settings.updated_at = updatedAt;
  return settings;
}

function normalizeRegisterSettingValue(key, raw) {
  if (key === "tax_rate") {
    const rate = Number(raw);
    if (!Number.isFinite(rate) || rate < 0 || rate > 0.25) {
      throw new Error("invalid_tax_rate");
    }
    return String(Number(rate.toFixed(6)));
  }
  if (REGISTER_BOOL_SETTING_KEYS.has(key)) {
    return raw ? "1" : "0";
  }
  if (REGISTER_PERCENT_SETTING_KEYS.has(key)) {
    const n = Math.max(0, Math.min(100, Number(raw || 0)));
    return String(Number.isFinite(n) ? Number(n.toFixed(2)) : 0);
  }
  if (REGISTER_MONEY_SETTING_KEYS.has(key)) {
    const n = Math.max(0, Math.min(999, Number(raw || 0)));
    return String(Number.isFinite(n) ? Number(n.toFixed(2)) : 0);
  }
  if (key === "closeout_variance_warn_cents") {
    const n = Math.max(0, Math.min(999999, Math.round(Number(raw || 0))));
    return String(Number.isFinite(n) ? n : 500);
  }
  if (key === "max_held_sales") {
    const n = Math.max(1, Math.min(100, Math.round(Number(raw || 20))));
    return String(Number.isFinite(n) ? n : 20);
  }
  if (key === "sale_id_prefix") {
    const cleaned = String(raw || "SO").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 10);
    return cleaned || "SO";
  }
  if (key === "tax_label") {
    return String(raw || "Sales Tax").trim().slice(0, 40) || "Sales Tax";
  }
  if (key === "receipt_return_policy") {
    return String(raw || "").trim().slice(0, 240);
  }
  return String(raw ?? REGISTER_SETTING_DEFAULTS[key] ?? "").trim().slice(0, 120);
}

function normalizeStoreSettingValue(key, raw) {
  const value = raw === undefined || raw === null ? "" : String(raw).trim();
  const maxLengths = {
    store_name: 80,
    store_phone: 40,
    store_email: 120,
    store_website: 160,
    store_address1: 120,
    store_address2: 120,
    store_city: 80,
    store_state: 40,
    store_zip: 20,
    receipt_footer: 240,
    default_inventory_category: 80
  };
  if (key === "low_stock_threshold") {
    const n = Math.max(0, Math.min(999, Math.floor(Number(raw || 0))));
    return String(Number.isFinite(n) ? n : 1);
  }
  if (key === "default_markup_percent") {
    const n = Math.max(0, Math.min(500, Number(raw || 0)));
    return String(Number.isFinite(n) ? Number(n.toFixed(2)) : 100);
  }
  if (key === "inventory_locations") {
    return JSON.stringify(normalizeInventoryLocationSettings(raw));
  }
  const limit = maxLengths[key] || 120;
  return value.slice(0, limit);
}

function normalizeApprovalToken(raw) {
  return String(raw || "").trim();
}

function getApprovalTokenFromBody(body, permission) {
  const approvals = body?.manager_approvals || body?.managerApprovals || {};
  return normalizeApprovalToken(approvals[permission] || body?.manager_approval_token || body?.approval_token);
}

function createManagerApprovalToken({ approver, permission, reason }) {
  const token = crypto.randomUUID ? crypto.randomUUID() : uuidv4();
  const expiresAt = Date.now() + (5 * 60 * 1000);
  managerApprovalTokens.set(token, {
    token,
    approverId: approver.id,
    approverUsername: approver.username,
    approverDisplayName: approver.display_name || approver.username,
    approverRole: approver.role,
    permission,
    reason: reason || "",
    expiresAt
  });
  return managerApprovalTokens.get(token);
}

function getValidManagerApproval(body, permission) {
  const token = getApprovalTokenFromBody(body, permission);
  if (!token) return null;
  const approval = managerApprovalTokens.get(token);
  if (!approval) return null;
  if (approval.expiresAt < Date.now()) {
    managerApprovalTokens.delete(token);
    return null;
  }
  if (approval.permission !== permission) return null;
  return approval;
}

function requirePermissionOrApproval(req, body, permission, { forcePin = false } = {}) {
  if (!forcePin && canUsePermissionDirectly(req.user, permission)) {
    return { type: "user", userId: req.user.id, username: req.user.username };
  }
  const approval = getValidManagerApproval(body, permission);
  if (approval) {
    return { type: "manager_pin", ...approval };
  }
  throw new Error(`manager_approval_required:${permission}`);
}

function approvalLogMeta(approval) {
  if (!approval || approval.type === "user") return {};
  return {
    approvalType: approval.type,
    approverId: approval.approverId,
    approverUsername: approval.approverUsername,
    approverRole: approval.approverRole
  };
}

function registerSettingsCanEdit(user) {
  return {
    tax_rate: hasUserPermission(user, "tax_admin"),
    settings: hasUserPermission(user, "settings_admin"),
    owner_lock: isOwnerUser(user)
  };
}

function storeSettingsCanEdit(user) {
  return {
    settings: hasUserPermission(user, "settings_admin"),
    owner_lock: isOwnerUser(user)
  };
}

app.get("/api/settings/register", requireAuth, (req, res) => {
  res.json({
    ok: true,
    settings: serializeRegisterSettings(),
    can_edit: registerSettingsCanEdit(req.user)
  });
});

app.put("/api/settings/register", requireAuth, (req, res) => {
  const body = req.body || {};
  const rows = getRegisterSettingRows();
  const updates = [];

  try {
    for (const key of REGISTER_SETTING_KEYS) {
      if (body[key] !== undefined) {
        updates.push({ key, value: normalizeRegisterSettingValue(key, body[key]) });
      }
    }
  } catch (err) {
    const msg = String(err.message || "");
    if (msg === "invalid_tax_rate") {
      return res.status(400).json({ ok: false, error: "invalid_tax_rate" });
    }
    return res.status(400).json({ ok: false, error: "invalid_setting", detail: msg });
  }

  if (!updates.length && body.lock_owner_settings === undefined && body.owner_locked === undefined) {
    return res.status(400).json({ ok: false, error: "no_settings" });
  }

  try {
    const tx = db.transaction(() => {
      for (const update of updates) {
        const current = rows.get(update.key) || { owner_locked: 0 };
        const settingPermission = update.key === "tax_rate" || update.key === "tax_label" ? "tax_admin" : "settings_admin";
        if (!hasUserPermission(req.user, settingPermission)) {
          throw new Error(`permission_denied:${settingPermission}`);
        }
        if (!isOwnerUser(req.user) && Number(current.owner_locked || 0) === 1) {
          throw new Error(`owner_locked:${update.key}`);
        }

        let ownerLocked = Number(current.owner_locked || 0);
        if (isOwnerUser(req.user)) {
          const perKeyLocks = body.owner_locked && typeof body.owner_locked === "object" ? body.owner_locked : null;
          if (perKeyLocks && Object.prototype.hasOwnProperty.call(perKeyLocks, update.key)) {
            ownerLocked = perKeyLocks[update.key] ? 1 : 0;
          } else if (body.lock_owner_settings !== undefined) {
            ownerLocked = body.lock_owner_settings ? 1 : 0;
          }
        }

        db.prepare(`
          INSERT INTO pos_settings (key, value, owner_locked, updated_by, updated_at)
          VALUES (@key, @value, @owner_locked, @updated_by, @updated_at)
          ON CONFLICT(key) DO UPDATE SET
            value=@value,
            owner_locked=@owner_locked,
            updated_by=@updated_by,
            updated_at=@updated_at
        `).run({
          key: update.key,
          value: update.value,
          owner_locked: ownerLocked,
          updated_by: req.user.id,
          updated_at: new Date().toISOString()
        });
      }

      if (isOwnerUser(req.user) && body.lock_owner_settings !== undefined && !updates.length) {
        const ownerLocked = body.lock_owner_settings ? 1 : 0;
        for (const key of REGISTER_SETTING_KEYS) {
          db.prepare(`
            UPDATE pos_settings
            SET owner_locked=@owner_locked, updated_by=@updated_by, updated_at=@updated_at
            WHERE key=@key
          `).run({
            key,
            owner_locked: ownerLocked,
            updated_by: req.user.id,
            updated_at: new Date().toISOString()
          });
        }
      }
    });

    tx();
    logUserAction({
      userId: String(req.user.id || ""),
      username: req.user.username || "",
      action: "register_settings_updated",
      screen: "settings",
      metadata: { keys: updates.map((u) => u.key), ownerLocked: body.lock_owner_settings }
    });
    res.json({ ok: true, settings: serializeRegisterSettings(), can_edit: registerSettingsCanEdit(req.user) });
  } catch (err) {
    const msg = String(err.message || err);
    if (msg.startsWith("permission_denied:")) {
      return res.status(403).json({ ok: false, error: "permission_denied", permission: msg.split(":")[1] });
    }
    if (msg.startsWith("owner_locked:")) {
      logUserAction({
        userId: String(req.user.id || ""),
        username: req.user.username || "",
        action: "register_settings_blocked",
        screen: "settings",
        metadata: { key: msg.split(":")[1], reason: "owner_locked" }
      });
      return res.status(403).json({ ok: false, error: "owner_locked", key: msg.split(":")[1] });
    }
    console.error("[API] /api/settings/register failed:", err);
    res.status(500).json({ ok: false, error: "settings_save_failed" });
  }
});

app.get("/api/settings/store", requireAuth, (req, res) => {
  res.json({
    ok: true,
    settings: serializeStoreSettings(),
    can_edit: storeSettingsCanEdit(req.user)
  });
});

app.put("/api/settings/store", requireAuth, requirePerm("settings_admin"), (req, res) => {
  const body = req.body || {};
  const rows = getStoreSettingRows();
  const updates = [];

  for (const key of STORE_SETTING_KEYS) {
    if (body[key] !== undefined) {
      updates.push({ key, value: normalizeStoreSettingValue(key, body[key]) });
    }
  }

  if (!updates.length && body.lock_owner_settings === undefined) {
    return res.status(400).json({ ok: false, error: "no_settings" });
  }

  try {
    const tx = db.transaction(() => {
      for (const update of updates) {
        const current = rows.get(update.key) || { owner_locked: 0 };
        if (!isOwnerUser(req.user) && Number(current.owner_locked || 0) === 1) {
          throw new Error(`owner_locked:${update.key}`);
        }
        let ownerLocked = Number(current.owner_locked || 0) ? 1 : 0;
        if (isOwnerUser(req.user) && body.lock_owner_settings !== undefined) {
          ownerLocked = body.lock_owner_settings ? 1 : 0;
        }
        db.prepare(`
          INSERT INTO pos_settings (key, value, owner_locked, updated_by, updated_at)
          VALUES (@key, @value, @owner_locked, @updated_by, @updated_at)
          ON CONFLICT(key) DO UPDATE SET
            value=@value,
            owner_locked=@owner_locked,
            updated_by=@updated_by,
            updated_at=@updated_at
        `).run({
          key: update.key,
          value: update.value,
          owner_locked: ownerLocked,
          updated_by: req.user.id,
          updated_at: new Date().toISOString()
        });
      }

      if (isOwnerUser(req.user) && body.lock_owner_settings !== undefined && !updates.length) {
        const ownerLocked = body.lock_owner_settings ? 1 : 0;
        for (const key of STORE_SETTING_KEYS) {
          db.prepare(`
            UPDATE pos_settings
            SET owner_locked=@owner_locked, updated_by=@updated_by, updated_at=@updated_at
            WHERE key=@key
          `).run({
            key,
            owner_locked: ownerLocked,
            updated_by: req.user.id,
            updated_at: new Date().toISOString()
          });
        }
      }
    });

    tx();
    logUserAction({
      userId: String(req.user.id || ""),
      username: req.user.username || "",
      action: "store_settings_updated",
      screen: "settings",
      metadata: { keys: updates.map((u) => u.key), ownerLocked: body.lock_owner_settings }
    });
    res.json({ ok: true, settings: serializeStoreSettings(), can_edit: storeSettingsCanEdit(req.user) });
  } catch (err) {
    const msg = String(err.message || "");
    if (msg.startsWith("owner_locked:")) {
      const key = msg.split(":")[1] || "";
      logUserAction({
        userId: String(req.user.id || ""),
        username: req.user.username || "",
        action: "store_settings_blocked",
        screen: "settings",
        metadata: { key, reason: "owner_locked" }
      });
      return res.status(403).json({ ok: false, error: "owner_locked", key });
    }
    console.error("[API] /api/settings/store failed:", err);
    res.status(500).json({ ok: false, error: "store_settings_save_failed" });
  }
});

app.get("/api/settings/system", requireAuth, (req, res) => {
  const aiRow = db.prepare("SELECT mode, chattiness, lastInternalRun, lastMarketRun, lastTrendRun FROM ai_settings WHERE id = 1").get() || {};
  const canEdit = storeSettingsCanEdit(req.user);
  res.json({
    ok: true,
    can_edit: canEdit,
    api: {
      host: HOST,
      port: PORT
    },
    integrations: {
      ai_configured: !!openai,
      ai_mode: aiRow.mode || "lab",
      ai_chattiness: aiRow.chattiness || "normal",
      ebay_adapter: !!findSoldComps,
      wix_enabled: WIX_SYNC_ENABLED,
      wix_configured: !!(WIX_API_KEY && WIX_SITE_ID),
      wix_currency: WIX_CURRENCY || "USD"
    },
    last_runs: {
      store_oracle: aiRow.lastInternalRun || null,
      market_watcher: aiRow.lastMarketRun || null,
      trend_watcher: aiRow.lastTrendRun || null
    }
  });
});

app.post("/api/manager/verify-pin", requireAuth, (req, res) => {
  const pin = String(req.body?.pin || "").trim();
  const permission = String(req.body?.permission || "").trim();
  const reason = String(req.body?.reason || "").trim();
  if (!/^[0-9]{4,12}$/.test(pin)) {
    return res.status(400).json({ ok: false, error: "invalid_pin" });
  }
  if (permission && !POS_PERMISSION_KEYS.includes(permission)) {
    return res.status(400).json({ ok: false, error: "invalid_permission" });
  }

  const rows = db.prepare(`
    SELECT u.id, u.username, u.display_name, lower(u.role) AS role, u.pin_hash,
           ${PERMISSION_SELECT_SQL}
    FROM users u
    LEFT JOIN permissions p ON p.user_id = u.id
    WHERE u.active = 1
      AND COALESCE(u.pin_hash,'') <> ''
    ORDER BY CASE lower(u.role) WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, u.id ASC
  `).all();

  for (const row of rows) {
    if (!bcrypt.compareSync(pin, row.pin_hash || "")) continue;
    const approver = { ...row, permissions: row };
    if (!permission && !["owner", "manager"].includes(row.role)) {
      continue;
    }
    if (permission && !hasUserPermission(approver, permission)) {
      logUserAction({
        userId: String(req.user.id || ""),
        username: req.user.username || "",
        action: "manager_pin_denied",
        screen: "pos",
        metadata: { permission, reason, approverId: row.id, deniedReason: "permission" }
      });
      return res.status(403).json({ ok: false, error: "approver_missing_permission" });
    }

    const approval = createManagerApprovalToken({ approver, permission, reason });
    logUserAction({
      userId: String(req.user.id || ""),
      username: req.user.username || "",
      action: "manager_pin_approved",
      screen: "pos",
      metadata: { permission, reason, approverId: row.id, approverUsername: row.username }
    });
    return res.json({
      ok: true,
      approval_token: approval.token,
      expires_at: new Date(approval.expiresAt).toISOString(),
      approver: {
        id: row.id,
        username: row.username,
        display_name: row.display_name || row.username,
        role: row.role
      }
    });
  }

  logUserAction({
    userId: String(req.user.id || ""),
    username: req.user.username || "",
    action: "manager_pin_denied",
    screen: "pos",
    metadata: { permission, reason, deniedReason: "invalid_pin" }
  });
  res.status(401).json({ ok: false, error: "invalid_pin" });
});

// AI manager message helper
function addAiMessage({ severity = "info", source = "store_oracle", title = "", body = "" } = {}) {
  try {
    const id = uuidv4();
    const createdAt = new Date().toISOString();
    db.prepare(
      `
      INSERT INTO ai_messages (id, createdAt, severity, source, title, body, isRead)
      VALUES (?,?,?,?,?,?,0)
    `
    ).run(id, createdAt, severity, source, title, body);
  } catch (e) {
    console.warn("[AI_MESSAGES] Failed to insert message:", e.message);
  }
}

// ---- OpenAI helper for pricing & future AI endpoints -----------------------
async function askOpenAI(
  messages,
  { model = "gpt-5.1", max_tokens = 400, temperature = 0.3, timeout_ms = 12000 } = {}
) {
  if (!openai) {
    console.warn("[OPENAI] askOpenAI called without client (missing OPENAI_API_KEY)");
    return { ok: false, error: "missing_openai_api_key" };
  }

  try {
    const completion = await Promise.race([
      openai.chat.completions.create({
        model,
        messages,
        max_completion_tokens: max_tokens,
        temperature
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("openai_timeout")), Math.max(1000, Number(timeout_ms) || 12000))
      )
    ]);

    const text = completion.choices?.[0]?.message?.content?.trim() || "";
    return { ok: true, text };
  } catch (err) {
    console.error("[OPENAI] Error from API:", err);
    return { ok: false, error: err.message || "openai_error" };
  }
}

// Margin & Risk Coach - looks for bad margins & overstock
function runMarginRiskCoach() {
  try {
    const settings = db.prepare("SELECT * FROM ai_settings WHERE id = 1").get() || {};
    if (settings.mode === "off") return;

    const anyItems = db.prepare("SELECT COUNT(*) AS c FROM items WHERE deleted_at IS NULL").get();
    if (!anyItems || anyItems.c === 0) return;

    // Clear previous margin_risk messages to keep the feed tidy
    db.prepare(`DELETE FROM ai_messages WHERE source = 'margin_risk'`).run();

    let emittedSomething = false;

    // 1) Items priced below cost
    const negative = db
      .prepare(
        `
      SELECT title, platform, cost, price, qty
      FROM items
      WHERE price > 0
        AND deleted_at IS NULL
        AND cost > 0
        AND price < cost
      ORDER BY (cost - price) DESC
      LIMIT 10
    `
      )
      .all();

    if (negative.length) {
      const lines = negative.map((r) => {
        const loss = (r.cost - r.price).toFixed(2);
        return `- ${r.title} (${r.platform || "Unknown"}) - cost $${r.cost.toFixed(
          2
        )}, price $${r.price.toFixed(2)}, qty ${r.qty} (about $${loss} loss per unit)`;
      });

      const body = [
        "These items appear to be priced below cost:",
        ...lines,
        "",
        "Consider adjusting pricing or using them only as intentional loss-leaders (bundles, promos, etc.)."
      ].join("\n");

      addAiMessage({
        severity: "warning",
        source: "margin_risk",
        title: "Items Priced Below Cost",
        body
      });
      emittedSomething = true;
    }

    // 2) Thin-margin items
    const thin = db
      .prepare(
        `
      SELECT title, platform, cost, price, qty
      FROM items
      WHERE price > 0
        AND deleted_at IS NULL
        AND cost > 0
        AND (price - cost) / price BETWEEN 0 AND 0.25
      ORDER BY (price - cost) / price ASC
      LIMIT 10
    `
      )
      .all();

    if (thin.length) {
      const lines = thin.map((r) => {
        const marginPct = ((r.price - r.cost) / r.price) * 100;
        return `- ${r.title} (${r.platform || "Unknown"}) - cost $${r.cost.toFixed(
          2
        )}, price $${r.price.toFixed(2)}, qty ${r.qty} (about ${marginPct.toFixed(1)}% margin)`;
      });

      const body = [
        "These items are running on relatively thin gross margins (<= 25%):",
        ...lines,
        "",
        'If these are not deliberate "traffic builders", consider nudging prices up slightly.'
      ].join("\n");

      addAiMessage({
        severity: "warning",
        source: "margin_risk",
        title: "Thin-Margin Items",
        body
      });
      emittedSomething = true;
    }

    // 3) Overstock candidates
    const overstock = db
      .prepare(
        `
      SELECT title, platform, price, qty
      FROM items
      WHERE deleted_at IS NULL
        AND qty >= 3
        AND price BETWEEN 1 AND 40
      ORDER BY qty DESC, price ASC
      LIMIT 10
    `
      )
      .all();

    if (overstock.length) {
      const lines = overstock.map(
        (r) => `- ${r.title} (${r.platform || "Unknown"}) - $${r.price.toFixed(2)} x ${r.qty} units`
      );

      const body = [
        "Potential overstock / clearance candidates (higher qty at lower price points):",
        ...lines,
        "",
        "Consider bundle deals, BOGO-style offers, or event bins to move some of this stock."
      ].join("\n");

      addAiMessage({
        severity: "opportunity",
        source: "margin_risk",
        title: "Overstock & Clearance Ideas",
        body
      });
      emittedSomething = true;
    }

    if (!emittedSomething) {
      addAiMessage({
        severity: "info",
        source: "margin_risk",
        title: "Margins & Stock Look Healthy",
        body:
          "Margin & Risk Coach checked your current inventory and didn't find any below-cost items, thin margins, or obvious overstock based on current thresholds."
      });
    }

    console.log("[AI] Margin & Risk Coach snapshot refreshed");
  } catch (err) {
    console.error("[AI] Margin & Risk Coach failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Store Oracle v1 - internal inventory insights
// ---------------------------------------------------------------------------
function runStoreOracleSnapshot() {
  try {
    const settings = db.prepare("SELECT * FROM ai_settings WHERE id = 1").get() || {};
    if (settings.mode === "off") {
      return;
    }

    const totals = db
      .prepare(
        `
      SELECT
        COUNT(*) AS skus,
        COALESCE(SUM(qty), 0) AS units,
        COALESCE(SUM(price * qty), 0) AS shelfValue
      FROM items
      WHERE deleted_at IS NULL
    `
      )
      .get();

    const lowStockRow = db
      .prepare(
        `
      SELECT COUNT(*) AS c
      FROM items
      WHERE deleted_at IS NULL
        AND qty <= 1
    `
      )
      .get();

    const deadStockRow = db
      .prepare(
        `
      SELECT COUNT(*) AS c
      FROM items
      WHERE deleted_at IS NULL
        AND qty > 0
        AND createdAt IS NOT NULL
        AND datetime(createdAt) < datetime('now','-180 days')
    `
      )
      .get();

    const topPlatforms = db
      .prepare(
        `
      SELECT platform,
             COUNT(*) AS skus,
             COALESCE(SUM(qty), 0) AS units
      FROM items
      WHERE deleted_at IS NULL
      GROUP BY platform
      ORDER BY units DESC
      LIMIT 3
    `
      )
      .all();

    const expensive = db
      .prepare(
        `
      SELECT title, platform, price, qty
      FROM items
      WHERE deleted_at IS NULL
        AND price >= 40
      ORDER BY price DESC
      LIMIT 5
    `
      )
      .all();

    db.prepare(`DELETE FROM ai_messages WHERE source = 'store_oracle'`).run();

    if (totals.skus > 0) {
      const pulseBody = [
        `You currently track ${totals.skus} SKUs (${totals.units} total units).`,
        `Estimated shelf value (price x qty) is about $${totals.shelfValue.toFixed(2)}.`,
        "",
        `${lowStockRow.c} items are low stock (qty <= 1).`,
        `${deadStockRow.c} items look like dead stock (listed > 180 days ago and still in stock).`,
        "",
        "Consider:",
        "- Repricing or bundling some dead stock.",
        '- Making a small "low stock" highlight section at events or online.'
      ].join("\n");

      addAiMessage({
        severity: "info",
        source: "store_oracle",
        title: "Inventory Pulse",
        body: pulseBody
      });
    }

    if (topPlatforms.length) {
      const lines = topPlatforms.map(
        (p) => `- ${p.platform || "Unspecified"} -> ${p.units} units across ${p.skus} SKUs`
      );
      const body = [
        "Top platforms by total units in inventory:",
        ...lines,
        "",
        "You can lean into these when planning posts, events, or bundle deals."
      ].join("\n");

      addAiMessage({
        severity: "opportunity",
        source: "store_oracle",
        title: "Platform Mix Snapshot",
        body
      });
    }

    if (expensive.length) {
      const lines = expensive.map(
        (e) => `- ${e.title} (${e.platform || "Unknown"}) -> $${e.price.toFixed(2)} x ${e.qty} units`
      );
      const body = [
        "Higher-value items currently sitting on the shelf:",
        ...lines,
        "",
        'Consider featuring these in social posts, live events, or a "premium shelf" section.'
      ].join("\n");

      addAiMessage({
        severity: "opportunity",
        source: "store_oracle",
        title: "High-Value Shelf",
        body
      });
    }

    const nowIso = new Date().toISOString();
    db.prepare(
      `
      UPDATE ai_settings
         SET lastInternalRun = @ts
       WHERE id = 1
    `
    ).run({ ts: nowIso });

    console.log("[AI] Store Oracle snapshot refreshed at", nowIso);
  } catch (err) {
    console.error("[AI] Store Oracle snapshot failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Market Watcher v1 - external comps vs your shelf
// ---------------------------------------------------------------------------
async function runMarketWatcher() {
  try {
    const settings = db.prepare("SELECT * FROM ai_settings WHERE id = 1").get() || {};
    if (settings.mode === "off") {
      console.log("[AI] Market Watcher: AI is off, skipping");
      return;
    }

    if (typeof findSoldComps !== "function") {
      console.log("[AI] Market Watcher: eBay provider missing, skipping");
      return;
    }

    const candidates = db
      .prepare(
        `
      SELECT id, title, platform, category, condition, price, qty
      FROM items
      WHERE deleted_at IS NULL
        AND price > 0
      ORDER BY qty DESC, price DESC
      LIMIT 12
    `
      )
      .all();

    if (!candidates.length) {
      console.log("[AI] Market Watcher: no priced items to analyze");
      return;
    }

    db.prepare(`DELETE FROM ai_messages WHERE source = 'market'`).run();

    const opportunities = [];
    const risks = [];

    for (const item of candidates) {
      const q = {
        title: item.title || "",
        platform: item.platform || "",
        category: (item.category || "games").toLowerCase(),
        completeness: "disc_only",
        isNew: (item.condition || "").toLowerCase().startsWith("n"),
        excludeLots: true
      };

      let comps = [];
      try {
        const ebayRes = await findSoldComps(q);
        if (!ebayRes || !ebayRes.ok) {
          continue;
        }
        comps = (ebayRes.comps || []).filter(
          (c) => c && c.currency === "USD" && Number(c.price) > 0
        );
      } catch (err) {
        console.warn("[AI] Market Watcher: failed comps lookup for", item.title, err.message);
        continue;
      }

      if (!comps.length) continue;

      const prices = comps.map((c) => +c.price).sort((a, b) => a - b);
      const sum = prices.reduce((a, b) => a + b, 0);
      const mid = Math.floor(prices.length / 2);
      const median =
        prices.length % 2 === 0 ? (prices[mid - 1] + prices[mid]) / 2 : prices[mid];
      const low = prices[0];
      const high = prices[prices.length - 1];

      const shelf = Number(item.price || 0);
      if (!shelf) continue;

      const delta = median - shelf;
      const pct = delta / shelf;

      if (pct >= 0.2 && median >= shelf + 3) {
        opportunities.push({
          ...item,
          median,
          low,
          high,
          count: prices.length,
          pct: pct * 100
        });
      } else if (pct <= -0.2 && shelf >= median + 3) {
        risks.push({
          ...item,
          median,
          low,
          high,
          count: prices.length,
          pct: pct * 100
        });
      }
    }

    if (opportunities.length) {
      const top = opportunities.slice(0, 5);
      const lines = top.map((r) => {
        return `- ${r.title} (${r.platform || "Unknown"}) - shelf $${r.price.toFixed(
          2
        )}, market median ~$${r.median.toFixed(2)} (about ${r.pct.toFixed(0)}% above, ${r.count} comps)`;
      });

      const body = [
        "Market Watcher found items where your shelf price looks cheap versus recent sold comps:",
        ...lines,
        "",
        "These are good candidates for small price bumps or spotlight posts / live features."
      ].join("\n");

      addAiMessage({
        severity: "opportunity",
        source: "market",
        title: "Underpriced vs Market",
        body
      });
    }

    if (risks.length) {
      const top = risks.slice(0, 5);
      const lines = top.map((r) => {
        return `- ${r.title} (${r.platform || "Unknown"}) - shelf $${r.price.toFixed(
          2
        )}, market median ~$${r.median.toFixed(2)} (about ${r.pct.toFixed(0)}% above, ${r.count} comps)`;
      });

      const body = [
        "These items look rich compared to current sold comps:",
        ...lines,
        "",
        "You might consider nudging prices toward market, or keeping them premium but adding value (better photos, bundles, or extras)."
      ].join("\n");

      addAiMessage({
        severity: "warning",
        source: "market",
        title: "Overpriced vs Market",
        body
      });
    }

    if (!opportunities.length && !risks.length) {
      addAiMessage({
        severity: "info",
        source: "market",
        title: "Market Watcher Check-In",
        body:
          "Market Watcher scanned a slice of your catalog against recent sold listings and didn't see any strong underpriced or overpriced signals based on current thresholds."
      });
    }

    const nowIso = new Date().toISOString();
    db.prepare(
      `
      UPDATE ai_settings
         SET lastMarketRun = @ts
       WHERE id = 1
    `
    ).run({ ts: nowIso });

    console.log("[AI] Market Watcher snapshot refreshed at", nowIso);
  } catch (err) {
    console.error("[AI] Market Watcher failed:", err);
  }
}

// Kick once on boot, then every 15 minutes
runStoreOracleSnapshot();
runMarginRiskCoach();
runMarketWatcher();

setInterval(runStoreOracleSnapshot, 15 * 60 * 1000);
setInterval(runMarginRiskCoach, 15 * 60 * 1000);

setTimeout(() => {
  runMarketWatcher();
  setInterval(runMarketWatcher, 15 * 60 * 1000);
}, 10 * 1000);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Health + aliases
app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    auth: "sessions",
    adapter: !!findSoldComps ? "ebay:loaded" : "ebay:missing"
  })
);
app.get("/health", (_req, res) => res.redirect(307, "/api/health"));

// ---------------------------------------------------------------------------
// AI Manager APIs
// ---------------------------------------------------------------------------
app.get("/api/ai/settings", requireAuth, (_req, res) => {
  const row = db.prepare("SELECT * FROM ai_settings WHERE id = 1").get();
  res.json(row || { mode: "off", chattiness: "quiet" });
});

app.get("/api/ai/status", requireAuth, (_req, res) => {
  const row = db.prepare("SELECT mode, chattiness FROM ai_settings WHERE id = 1").get() || {};
  const mode = ["off", "lab", "on"].includes(row.mode) ? row.mode : "lab";
  const chattiness = ["quiet", "normal", "chatty"].includes(row.chattiness) ? row.chattiness : "normal";
  res.json({
    ok: true,
    mode,
    chattiness,
    liveConfigured: !!openai,
    liveReady: !!openai && mode !== "off"
  });
});

app.post("/api/ai/settings", requireAuth, requirePerm("settings_admin"), (req, res) => {
  const { mode, chattiness } = req.body || {};
  const safeMode = ["off", "lab", "on"].includes(mode) ? mode : "lab";
  const safeChat = ["quiet", "normal", "chatty"].includes(chattiness) ? chattiness : "normal";
  db.prepare(
    `
    UPDATE ai_settings
       SET mode = @mode,
           chattiness = @chat
     WHERE id = 1
  `
  ).run({ mode: safeMode, chat: safeChat });
  const row = db.prepare("SELECT * FROM ai_settings WHERE id = 1").get();
  res.json(row);
});

app.post("/api/ai/refresh", requireAuth, async (_req, res) => {
  try {
    runStoreOracleSnapshot();
    runMarginRiskCoach();
    await runMarketWatcher();

    const ts = new Date().toISOString();
    addAiMessage({
      severity: "info",
      source: "system",
      title: "Brain Refreshed",
      body: `You manually refreshed Store Oracle, Margin & Risk Coach, and Market Watcher at ${ts}.`
    });

    const rows = db
      .prepare(
        `
      SELECT * FROM ai_messages
      ORDER BY datetime(createdAt) DESC
      LIMIT 100
    `
      )
      .all();

    res.json({ ok: true, feed: rows });
  } catch (err) {
    console.error("[API] /api/ai/refresh failed:", err);
    res.status(500).json({ ok: false, error: "refresh_failed" });
  }
});

app.get("/api/ai/feed", requireAuth, (_req, res) => {
  const rows = db
    .prepare(
      `
    SELECT * FROM ai_messages
    ORDER BY datetime(createdAt) DESC
    LIMIT 100
  `
    )
    .all();
  res.json(rows);
});

app.post("/api/ai/feed/:id/read", requireAuth, (req, res) => {
  const id = String(req.params.id || "");
  db.prepare(`UPDATE ai_messages SET isRead=1 WHERE id=?`).run(id);
  res.json({ ok: true, id });
});

function median(nums) {
  const arr = (nums || []).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!arr.length) return 0;
  const mid = Math.floor(arr.length / 2);
  if (arr.length % 2 === 1) return arr[mid];
  return (arr[mid - 1] + arr[mid]) / 2;
}

function extractLookupQuery(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";

  const quoted = raw.match(/"([^"]{2,120})"/);
  if (quoted && quoted[1]) return quoted[1].trim();

  const cleaned = raw
    .replace(/\b(look|lookup|check|find|search|online|web|internet|ebay|sold|comps?|price|pricing|for|what|whats|what's|is|are|the|a|an|of|on|in|my|our|show|me|please)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.length >= 2 ? cleaned : raw.slice(0, 100);
}

const aiChatMemory = new Map();
function getChatMemory(key) {
  if (!key) return null;
  return aiChatMemory.get(key) || null;
}
function setChatMemory(key, value) {
  if (!key) return;
  if (aiChatMemory.size > 300) {
    const first = aiChatMemory.keys().next().value;
    if (first) aiChatMemory.delete(first);
  }
  aiChatMemory.set(key, { ...(value || {}), updatedAt: Date.now() });
}

const TREND_STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "new", "used", "complete", "edition", "bundle",
  "game", "games", "nintendo", "playstation", "xbox", "switch", "retro", "cib"
]);

function safeWordTokenize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function normalizeTrendTerm(raw) {
  const parts = safeWordTokenize(raw).filter((w) => w.length >= 3 && !TREND_STOP_WORDS.has(w));
  return parts.slice(0, 2).join(" ").trim();
}

function pickTrendSeedTerms(db) {
  const soldRows = db.prepare(
    `
    SELECT i.title, i.platform, COALESCE(SUM(si.qty),0) AS units_sold
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    JOIN items i ON i.id = si.item_id
    WHERE s.status='completed'
      AND datetime(s.created_at) >= datetime('now', '-30 days')
    GROUP BY i.id
    ORDER BY units_sold DESC
    LIMIT 12
  `
  ).all();

  const inStockRows = db.prepare(
    `
    SELECT title, platform, qty, price
    FROM items
    WHERE deleted_at IS NULL
      AND COALESCE(qty,0) > 0
    ORDER BY COALESCE(price,0) DESC, COALESCE(qty,0) DESC
    LIMIT 12
  `
  ).all();

  const out = [];
  soldRows.forEach((r) => {
    const t = normalizeTrendTerm(r.title);
    if (t) out.push(t);
    const p = normalizeTrendTerm(r.platform);
    if (p) out.push(p);
  });
  inStockRows.forEach((r) => {
    const t = normalizeTrendTerm(r.title);
    if (t) out.push(t);
  });

  const uniq = [];
  for (const term of out) {
    if (!uniq.includes(term)) uniq.push(term);
    if (uniq.length >= 6) break;
  }
  return uniq;
}

function computeCompMomentum(comps) {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const recentStart = now - (14 * dayMs);
  const priorStart = now - (28 * dayMs);
  const pricesRecent = [];
  let recent = 0;
  let prior = 0;

  for (const c of comps || []) {
    const t = Date.parse(String(c.endTime || ""));
    if (!Number.isFinite(t)) continue;
    if (t >= recentStart) {
      recent += 1;
      if (Number(c.price) > 0) pricesRecent.push(Number(c.price));
    } else if (t >= priorStart && t < recentStart) {
      prior += 1;
    }
  }

  const momentum = recent - prior;
  const ratio = recent / Math.max(1, prior);
  return {
    recentCount: recent,
    priorCount: prior,
    momentum,
    ratio,
    medianRecent: median(pricesRecent)
  };
}

app.post("/api/ai/chat", requireAuth, async (req, res) => {
  const { message } = req.body || {};
  const text = String(message || "").trim();
  if (!text) return res.status(400).json({ error: "empty_message" });

  try {
    const chatMemoryKey = String(getSessionIdFromReq(req) || "");
    const lastState = getChatMemory(chatMemoryKey) || {};
    const settings = db.prepare("SELECT mode, chattiness FROM ai_settings WHERE id = 1").get() || {};
    const mode = ["off", "lab", "on"].includes(settings.mode) ? settings.mode : "lab";
    const chattiness = ["quiet", "normal", "chatty"].includes(settings.chattiness)
      ? settings.chattiness
      : "normal";

    const inv = db.prepare(`
      SELECT
        COUNT(*) AS item_count,
        COALESCE(SUM(qty),0) AS units,
        COALESCE(SUM(price * qty),0) AS retail_value,
        COALESCE(SUM(cost * qty),0) AS cost_value
      FROM items
      WHERE deleted_at IS NULL
    `).get();

    const sales7 = db.prepare(`
      SELECT
        COUNT(*) AS sale_count,
        COALESCE(SUM(total),0) AS gross,
        COALESCE(SUM(tax),0) AS tax
      FROM sales
      WHERE status='completed'
        AND datetime(created_at) >= datetime('now', '-7 days')
    `).get();

    const salesPrev7 = db.prepare(`
      SELECT
        COUNT(*) AS sale_count,
        COALESCE(SUM(total),0) AS gross
      FROM sales
      WHERE status='completed'
        AND datetime(created_at) >= datetime('now', '-14 days')
        AND datetime(created_at) < datetime('now', '-7 days')
    `).get();

    const topCats = db.prepare(`
      SELECT COALESCE(category,'(uncategorized)') AS category,
             COUNT(*) AS count,
             COALESCE(SUM(qty),0) AS units
      FROM items
      WHERE deleted_at IS NULL
      GROUP BY COALESCE(category,'(uncategorized)')
      ORDER BY units DESC, count DESC
      LIMIT 5
    `).all();

    const topLowStock = db.prepare(`
      SELECT sku, title, qty
      FROM items
      WHERE deleted_at IS NULL
        AND qty > 0 AND qty <= 2
      ORDER BY qty ASC, datetime(createdAt) ASC
      LIMIT 8
    `).all();

    const topSold14 = db.prepare(`
      SELECT
        COALESCE(i.category,'(uncategorized)') AS category,
        COALESCE(SUM(si.qty),0) AS units_sold,
        COALESCE(SUM(si.line_total),0) AS sales_total
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      LEFT JOIN items i ON i.id = si.item_id
      WHERE s.status='completed'
        AND datetime(s.created_at) >= datetime('now', '-14 days')
      GROUP BY COALESCE(i.category,'(uncategorized)')
      ORDER BY units_sold DESC, sales_total DESC
      LIMIT 5
    `).all();

    const movement14 = db.prepare(`
      SELECT
        COALESCE(reason,'other') AS reason,
        COALESCE(SUM(CASE WHEN qty_delta < 0 THEN ABS(qty_delta) ELSE 0 END),0) AS units_out,
        COALESCE(SUM(CASE WHEN qty_delta > 0 THEN qty_delta ELSE 0 END),0) AS units_in
      FROM inventory_movements
      WHERE datetime(created_at) >= datetime('now', '-14 days')
      GROUP BY COALESCE(reason,'other')
      ORDER BY (units_out + units_in) DESC
      LIMIT 8
    `).all();

    const staleItems = db.prepare(`
      SELECT
        i.sku,
        i.title,
        i.qty,
        i.price,
        i.createdAt,
        MAX(CASE WHEN s.status='completed' THEN s.created_at END) AS last_sold_at
      FROM items i
      LEFT JOIN sale_items si ON si.item_id = i.id
      LEFT JOIN sales s ON s.id = si.sale_id
      WHERE i.deleted_at IS NULL
        AND COALESCE(i.qty,0) > 0
      GROUP BY i.id
      ORDER BY
        CASE WHEN last_sold_at IS NULL THEN 0 ELSE 1 END ASC,
        datetime(last_sold_at) ASC,
        datetime(COALESCE(i.createdAt,'1970-01-01')) ASC
      LIMIT 8
    `).all();

    const qLower = text.toLowerCase();
    const asksOnline = /\b(online|web|internet|ebay|comps?|sold listings?|market|price check)\b/.test(qLower);
    const forceOnlineMode = mode === "on";
    const shouldTryOnlineLookup = mode !== "off" && (forceOnlineMode || asksOnline);

    let marketLookup = null;
    if (shouldTryOnlineLookup && typeof findSoldComps === "function") {
      try {
        const lookupQuery = extractLookupQuery(text);
        if (lookupQuery) {
          const market = await findSoldComps({ title: lookupQuery, country: "US" });
          const comps = Array.isArray(market?.comps) ? market.comps.filter((c) => Number(c.price) > 0) : [];
          if (market?.ok && comps.length) {
            const prices = comps.map((c) => Number(c.price)).filter((n) => Number.isFinite(n) && n > 0);
            marketLookup = {
              query: lookupQuery,
              sampleCount: comps.length,
              avgPrice: prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : 0,
              medianPrice: median(prices),
              minPrice: prices.length ? Math.min(...prices) : 0,
              maxPrice: prices.length ? Math.max(...prices) : 0,
              comps: comps.slice(0, 8)
            };
          } else if (market && market.reason) {
            marketLookup = { query: lookupQuery, sampleCount: 0, error: String(market.reason) };
          }
        }
      } catch (e) {
        marketLookup = { query: extractLookupQuery(text), sampleCount: 0, error: "lookup_failed" };
      }
    }

    const socialCandidates = db.prepare(
      `
      SELECT
        i.sku,
        i.title,
        i.platform,
        i.price,
        i.qty,
        COALESCE(SUM(si.qty),0) AS units_sold_30d,
        COALESCE(SUM(si.line_total),0) AS sold_total_30d,
        MAX(s.created_at) AS last_sold_at
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      JOIN items i ON i.id = si.item_id
      WHERE s.status='completed'
        AND datetime(s.created_at) >= datetime('now', '-30 days')
        AND i.deleted_at IS NULL
        AND COALESCE(i.qty,0) > 0
      GROUP BY i.id
      ORDER BY units_sold_30d DESC, sold_total_30d DESC, datetime(last_sold_at) DESC
      LIMIT 12
    `
    ).all();

    const asksStrategicAdvice = /\b(suggest|idea|ideas|recommend|recommendation|social|facebook|fb|instagram|insta|trending|heating up|look for|source|sourcing|what should i post)\b/.test(qLower);
    const shouldTryTrendSignals = mode !== "off" && (mode === "on" || asksStrategicAdvice);
    let externalTrendSignals = [];
    if (shouldTryTrendSignals && typeof findSoldComps === "function") {
      const terms = pickTrendSeedTerms(db);
      try {
        const results = await Promise.all(
          terms.map(async (term) => {
            try {
              const r = await findSoldComps({ title: term, country: "US" });
              const comps = Array.isArray(r?.comps) ? r.comps.filter((c) => Number(c.price) > 0) : [];
              if (!r?.ok || !comps.length) return null;
              const m = computeCompMomentum(comps);
              const inStockCount = db.prepare(
                `
                SELECT COUNT(*) AS c
                FROM items
                WHERE deleted_at IS NULL
                  AND COALESCE(qty,0) > 0
                  AND (LOWER(COALESCE(title,'')) LIKE ? OR LOWER(COALESCE(platform,'')) LIKE ?)
              `
              ).get(`%${term}%`, `%${term}%`);
              return {
                term,
                sampleCount: comps.length,
                ...m,
                inStockMatches: Number(inStockCount?.c || 0)
              };
            } catch {
              return null;
            }
          })
        );

        externalTrendSignals = results
          .filter(Boolean)
          .sort((a, b) => {
            if (b.ratio !== a.ratio) return b.ratio - a.ratio;
            if (b.momentum !== a.momentum) return b.momentum - a.momentum;
            return b.recentCount - a.recentCount;
          })
          .slice(0, 5);
      } catch {
        externalTrendSignals = [];
      }
    }

    const context = {
      mode,
      chattiness,
      inventory: inv,
      salesLast7Days: sales7,
      salesPrevious7Days: salesPrev7,
      topCategories: topCats,
      lowStock: topLowStock,
      topSoldCategoriesLast14Days: topSold14,
      inventoryMovementLast14Days: movement14,
      staleInventoryCandidates: staleItems,
      onlineMarketLookup: marketLookup,
      socialCandidates,
      externalTrendSignals
    };

    let reply = "";
    let openaiUsed = false;
    let fallbackReason = "";

    if (openai && mode !== "off") {
      const styleGuide = chattiness === "chatty"
        ? "Be conversational and idea-forward. Include: quick read, what is moving, what should move next, and 3 practical experiments."
        : chattiness === "quiet"
          ? "Keep it tight: 4-5 short sentences max with one concrete next step."
          : "Use a concise manager style: short summary plus 3 action bullets with expected impact.";

      const ai = await askOpenAI(
        [
          {
            role: "system",
            content: [
              "You are VaultCore Brain, a store operations advisor for a used game shop POS.",
              "Prioritize practical recommendations tied to numbers from context.",
              "Call out: what is moving, what is not moving, and what to test next.",
              "If onlineMarketLookup exists, use it directly and mention that it came from recent online sold comps.",
              "If socialCandidates or externalTrendSignals exist, provide concrete sections: Post Now, Trend Watch, Source Next.",
              "For each recommendation include a short why-now reason from context numbers.",
              styleGuide
            ].join(" ")
          },
          {
            role: "user",
            content: [
              "User question:",
              text,
              "",
              "Store context JSON:",
              JSON.stringify(context)
            ].join("\n")
          }
        ],
        { model: "gpt-5.1", max_tokens: 550, temperature: 0.2 }
      );

      if (ai.ok && ai.text) {
        reply = ai.text;
        openaiUsed = true;
      } else {
        fallbackReason = ai.error || "openai_call_failed";
      }
    } else {
      fallbackReason = openai ? "ai_mode_off" : "missing_openai_api_key";
    }

    if (!reply) {
      const q = text.toLowerCase();
      const wantedTopCount = Math.min(
        25,
        Math.max(1, Number((q.match(/\btop\s+(\d{1,2})\b/) || [])[1] || 10))
      );
      const asksOnlineRequested = /\b(online|web|internet|ebay|comps?|sold listings?|market|price check)\b/.test(q);
      const asksTopPrice =
        /\b(highest|top|most expensive|expensive)\b/.test(q) &&
        /\b(price|priced|items|sku|inventory)\b/.test(q);
      const asksStrategicFallback =
        asksStrategicAdvice ||
        /\b(what should i post|what should we post|what should i buy|start looking for|heating up)\b/.test(q);
      const asksFastMoving =
        /\b(fast moving|moving items|top sellers?|best sellers?|trending|hot)\b/.test(q) ||
        (/\b(post|show)\b/.test(q) && /\b(fb|facebook|insta|instagram|social)\b/.test(q));
      const excludeMatch = q.match(/\b(exclude|without|remove)\s+(.+)/);
      const asksExcludePrevious =
        !!excludeMatch && /\b(that|those|last|previous|from that|from those)\b/.test(q);
      const isGreeting = /^(hey|hi|hello|yo|sup)\b/.test(q);

      if (asksStrategicFallback) {
        const currentGross = Number(sales7?.gross || 0);
        const previousGross = Number(salesPrev7?.gross || 0);
        const delta = currentGross - previousGross;
        const pct = previousGross > 0 ? (delta / previousGross) * 100 : 0;
        const trendLine = previousGross > 0
          ? `Sales trend: last 7 days $${currentGross.toFixed(2)} vs prior 7 days $${previousGross.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%).`
          : `Sales trend: last 7 days $${currentGross.toFixed(2)} (no prior-week baseline).`;

        const postNow = socialCandidates.slice(0, 5).map((r, idx) =>
          `${idx + 1}. ${r.title || r.sku} (${r.platform || "n/a"}) - sold ${Number(r.units_sold_30d || 0)} in 30d, in stock ${Number(r.qty || 0)}, $${Number(r.price || 0).toFixed(2)}`
        );

        const heatingUp = externalTrendSignals
          .filter((t) => Number(t.recentCount || 0) >= 2)
          .slice(0, 4)
          .map((t, idx) =>
            `${idx + 1}. ${t.term}: recent sold ${t.recentCount} vs prior ${t.priorCount}, momentum ${t.momentum >= 0 ? "+" : ""}${t.momentum}, median recent $${Number(t.medianRecent || 0).toFixed(2)}`
          );

        const sourceNext = externalTrendSignals
          .filter((t) => Number(t.inStockMatches || 0) <= 1)
          .slice(0, 3)
          .map((t, idx) =>
            `${idx + 1}. ${t.term} (hot online signal, low in-store coverage: ${t.inStockMatches} matches)`
          );

        const parts = [
          trendLine,
          "",
          "Post Now:",
          postNow.length ? postNow.join("\n") : "No strong in-stock movers found yet.",
          "",
          "Trend Watch (external sold comps):",
          heatingUp.length ? heatingUp.join("\n") : "No strong external momentum signals yet.",
          "",
          "Source Next:",
          sourceNext.length ? sourceNext.join("\n") : "No urgent low-coverage trend terms right now.",
          "",
          "Content angle: pair one premium collector piece with one affordable fast-mover and use a limited-hold call to action."
        ];

        reply = parts.join("\n");
      } else if (asksOnlineRequested) {
        if (marketLookup && Number(marketLookup.sampleCount || 0) > 0) {
          const sample = marketLookup.comps || [];
          const lines = sample.slice(0, 5).map((c, idx) =>
            `${idx + 1}. ${c.title || "(untitled)"} - $${Number(c.price || 0).toFixed(2)} (${c.condition || "n/a"})`
          );
          reply = [
            `Online market read for "${marketLookup.query}": ${Number(marketLookup.sampleCount || 0)} sold comps.`,
            `Range $${Number(marketLookup.minPrice || 0).toFixed(2)}-$${Number(marketLookup.maxPrice || 0).toFixed(2)}, median $${Number(marketLookup.medianPrice || 0).toFixed(2)}, avg $${Number(marketLookup.avgPrice || 0).toFixed(2)}.`,
            lines.length ? `Sample sold comps:\n${lines.join("\n")}` : "",
            "Ask me for a buy/sell recommendation and I can suggest a practical store price band."
          ].filter(Boolean).join("\n");
        } else {
          const why = marketLookup?.error ? ` (${marketLookup.error})` : "";
          reply = `I tried an online market lookup but could not get usable sold comps${why}. I can still give a local inventory-only recommendation.`;
        }
      } else if (asksExcludePrevious && lastState.type === "top_price" && Array.isArray(lastState.rows)) {
        const needle = String(excludeMatch[2] || "").replace(/\b(that|those|from|list|top|items?)\b/g, " ").trim();
        const tokens = needle.split(/\s+/).filter((t) => t.length >= 2);
        let rows = lastState.rows.slice();
        if (tokens.length) {
          rows = rows.filter((r) => {
            const hay = `${r.title || ""} ${r.platform || ""} ${r.sku || ""}`.toLowerCase();
            return !tokens.some((t) => hay.includes(t));
          });
        }
        const shown = rows.slice(0, Math.max(1, Number(lastState.limit || 10)));
        if (shown.length) {
          const lines = shown.map((r, idx) =>
            `${idx + 1}. ${(r.title || r.sku || "(untitled)")} (${r.platform || "n/a"}) - $${Number(r.price || 0).toFixed(2)} [qty ${Number(r.qty || 0)}]`
          );
          reply = [
            `Updated top-priced list with "${needle || "requested exclusion"}" removed:`,
            lines.join("\n")
          ].join("\n");
          setChatMemory(chatMemoryKey, { type: "top_price", rows, limit: lastState.limit || 10 });
        } else {
          reply = "That exclusion removed everything in the prior list. Try a narrower exclude phrase.";
        }
      } else if (asksFastMoving) {
        const movers = db.prepare(
          `
          SELECT
            i.sku,
            i.title,
            i.platform,
            i.price,
            i.qty,
            COALESCE(SUM(si.qty),0) AS units_sold,
            COALESCE(SUM(si.line_total),0) AS sold_total,
            MAX(s.created_at) AS last_sold_at
          FROM sale_items si
          JOIN sales s ON s.id = si.sale_id
          JOIN items i ON i.id = si.item_id
          WHERE s.status='completed'
            AND datetime(s.created_at) >= datetime('now', '-30 days')
            AND i.deleted_at IS NULL
            AND COALESCE(i.qty,0) > 0
          GROUP BY i.id
          ORDER BY units_sold DESC, sold_total DESC, datetime(last_sold_at) DESC
          LIMIT 10
        `
        ).all();

        if (movers.length) {
          const lines = movers.slice(0, 6).map((r, idx) =>
            `${idx + 1}. ${r.title || r.sku} (${r.platform || "n/a"}) - sold ${Number(r.units_sold || 0)} in 30d, in stock ${Number(r.qty || 0)}, price $${Number(r.price || 0).toFixed(2)}`
          );
          reply = [
            "Fast-moving in-stock items to feature on FB/Insta:",
            lines.join("\n"),
            "",
            "Post idea: spotlight one premium item + one affordable add-on and end with a same-day hold CTA."
          ].join("\n");
        } else {
          reply = "I do not see enough recent sold-item history with current stock to rank fast movers yet.";
        }
      } else if (asksTopPrice) {
        const rows = db.prepare(
          `
          SELECT sku, title, platform, price, qty
          FROM items
          WHERE deleted_at IS NULL
            AND COALESCE(qty,0) > 0
          ORDER BY COALESCE(price,0) DESC, COALESCE(qty,0) DESC, COALESCE(title,'') ASC
          LIMIT ?
        `
        ).all(wantedTopCount);

        if (rows.length) {
          const lines = rows.map((r, idx) =>
            `${idx + 1}. ${(r.title || r.sku || "(untitled)")} (${r.platform || "n/a"}) - $${Number(r.price || 0).toFixed(2)} [qty ${Number(r.qty || 0)}]`
          );
          reply =
            `Top ${rows.length} highest-priced in-stock items:\n` +
            lines.join("\n") +
            `\n\nWant this sorted by total on-hand value (price x qty) instead?`;
          setChatMemory(chatMemoryKey, { type: "top_price", rows, limit: rows.length });
        } else {
          reply = "I could not find in-stock items to rank by price yet.";
        }
      } else if (isGreeting) {
        const gross = Number(sales7?.gross || 0);
        const saleCount = Number(sales7?.sale_count || 0);
        reply = [
          "Hey. I am online.",
          `Quick pulse: ${Number(inv?.item_count || 0)} SKUs, ${Number(inv?.units || 0)} units in stock.`,
          `Last 7 days: ${saleCount} sales, $${gross.toFixed(2)} gross.`,
          "Ask me for: top priced items, low stock list, stale inventory, or reorder targets."
        ].join(" ");
      } else {
        const gross = Number(sales7?.gross || 0);
        const saleCount = Number(sales7?.sale_count || 0);
        const avgTicket = saleCount > 0 ? gross / saleCount : 0;
        const margin = Number(inv?.retail_value || 0) - Number(inv?.cost_value || 0);

        const lowStockLine = topLowStock.length
          ? `Low stock watch: ${topLowStock.slice(0, 3).map((r) => `${r.sku || r.title} (${r.qty})`).join(", ")}.`
          : "Low stock watch: no urgent low-stock items detected.";

        const catLine = topCats.length
          ? `Top categories by units: ${topCats.map((c) => `${c.category} (${c.units})`).join(", ")}.`
          : "Top categories by units: no inventory data.";

        const soldLine = topSold14.length
          ? `What is moving: ${topSold14.slice(0, 3).map((r) => `${r.category} (${r.units_sold} sold)`).join(", ")} in the last 14 days.`
          : "What is moving: not enough recent completed-sale detail yet.";

        const staleLine = staleItems.length
          ? `What should move next: review ${staleItems.slice(0, 3).map((r) => `${r.sku || r.title} (qty ${r.qty})`).join(", ")} for markdowns or bundles.`
          : "What should move next: no clear stale-inventory candidates right now.";

        reply = [
          `Quick store snapshot: ${Number(inv?.item_count || 0)} SKUs, ${Number(inv?.units || 0)} units, retail value $${Number(inv?.retail_value || 0).toFixed(2)}, potential margin $${margin.toFixed(2)}.`,
          `Last 7 days: ${saleCount} completed sales, gross $${gross.toFixed(2)}, avg ticket $${avgTicket.toFixed(2)}.`,
          soldLine,
          staleLine,
          catLine,
          lowStockLine,
          "Ideas to test this week: run one bundle offer for a stale title, restock one fast-moving category, and post one social spotlight on the top seller.",
          `On your question: "${text}" - ask me for a focused view like "pricing risk", "reorder list", "stale inventory", or "weekend promo ideas".`
        ].join(" ");
      }
    }

    return res.json({
      ok: true,
      reply,
      meta: {
        mode,
        chattiness,
        liveConfigured: !!openai,
        liveUsed: openaiUsed,
        fallback: !openaiUsed,
        fallbackReason: fallbackReason || null,
        onlineLookupUsed: Number(marketLookup?.sampleCount || 0) > 0,
        onlineLookupError: marketLookup?.error || null,
        externalTrendSignalCount: Array.isArray(externalTrendSignals) ? externalTrendSignals.length : 0
      }
    });
  } catch (err) {
    console.error("[AI] chat failed:", err);
    return res.status(500).json({ ok: false, error: "ai_chat_failed" });
  }
});
// ---- AI PRICING ENDPOINT ---------------------------------------------------
app.post("/api/ai/price", requireAuth, async (req, res) => {
  const { title, platform, condition, category } = req.body || {};

  if (!title) {
    return res.status(400).json({ ok: false, error: "missing_title" });
  }

  const userPrompt = `
You are the VaultCore pricing assistant.

Estimate fair resale prices for this game based on typical US retro market values
(think recent eBay sold listings, conventions, and local retro shops), focusing on
loose / CIB as appropriate. Do NOT assume sealed collector prices unless clearly stated.

Game title: ${title}
Platform: ${platform || "Unknown"}
Category: ${category || "games"}
Condition description: ${condition || "Used"}

Return ONLY valid JSON in this exact shape:

{
  "low": number,
  "mid": number,
  "high": number,
  "summary": "Short 1-2 sentence explanation of the pricing and any caveats."
}
`.trim();

  const ai = await askOpenAI(
    [
      {
        role: "system",
        content:
          "You are a pricing assistant for a retro game store. You know typical resale ranges for games, but you do NOT have real-time data. Give grounded estimates, not collector hype."
      },
      { role: "user", content: userPrompt }
    ],
    { model: "gpt-5.1", max_tokens: 350, temperature: 0.25 }
  );

  if (!ai.ok) {
    return res
      .status(500)
      .json({ ok: false, error: "openai_failed", detail: ai.error || "unknown" });
  }

  let low = 0;
  let mid = 0;
  let high = 0;
  let summary = "";

  try {
    const parsed = JSON.parse(ai.text);

    low = Number(parsed.low ?? parsed.min ?? 0) || 0;
    mid =
      Number(
        parsed.mid ??
          parsed.median ??
          parsed.typical ??
          parsed.average ??
          0
      ) || 0;
    high = Number(parsed.high ?? parsed.max ?? 0) || 0;
    summary = String(parsed.summary ?? parsed.notes ?? "").slice(0, 400);
  } catch (err) {
    console.warn("[/api/ai/price] JSON parse failed:", err.message, "raw:", ai.text);
    return res.status(500).json({ ok: false, error: "bad_ai_json" });
  }

  const avg =
    mid || (low && high ? (low + high) / 2 : low || high || 0);
  const median = mid || avg;
  const samples = low || mid || high ? 1 : 0;

  return res.json({
    ok: true,
    title,
    platform,
    category,
    condition,
    avg,
    median,
    low,
    high,
    samples,
    mid,
    summary
  });
});

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function tradeBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback ? 1 : 0;
  if (value === true || value === 1) return 1;
  const text = String(value).trim().toLowerCase();
  return ["1", "true", "yes", "on", "enabled"].includes(text) ? 1 : 0;
}

function tradePercent(value, fallback, min = 0, max = 100) {
  const n = Number(value);
  return Number.isFinite(n) ? clamp(n, min, max) : fallback;
}

function tradeInt(value, fallback, min = 0, max = 9999) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? clamp(n, min, max) : fallback;
}

function tradeConditionFactor(conditionRaw) {
  const condition = String(conditionRaw || "").trim().toLowerCase();
  if (condition.includes("excellent") || condition.includes("mint") || condition.includes("new")) return 1.0;
  if (condition.includes("good")) return 0.9;
  if (condition.includes("fair")) return 0.78;
  if (condition.includes("poor")) return 0.62;
  return 0.85;
}

function tradeCategoryFactor(categoryRaw, titleRaw = "") {
  const cat = String(categoryRaw || "").toLowerCase();
  const title = String(titleRaw || "").toLowerCase();
  if (cat.includes("console")) return 0.95;
  if (cat.includes("accessor") || title.includes("controller")) return 0.82;
  if (cat.includes("movie")) return 0.72;
  return 0.88;
}

function tryParseJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const sliced = raw.slice(first, last + 1);
    try {
      return JSON.parse(sliced);
    } catch {}
  }
  return null;
}

function getTradeSettingsRow() {
  const row = db.prepare(`SELECT * FROM trade_settings WHERE id=1`).get();
  return row || {
    quote_expiry_days: 30,
    approval_cash_limit_cents: 20000,
    approval_credit_limit_cents: 30000,
    ebay_sold_enabled: 1,
    ebay_active_enabled: 1,
    ebay_country: "US",
    require_customer: 0,
    require_seller_id: 0,
    require_agreement: 1,
    default_hold_days: 0,
    testing_queue_enabled: 1,
    auto_label_on_complete: 1,
    default_credit_percent: 50,
    default_cash_percent: 80,
    margin_floor_percent: 45,
    offer_basis: "sold_median",
    promo_active: 0,
    promo_label: "",
    promo_credit_bonus_percent: 0
  };
}

function getTradeSettingsForUser(userId) {
  const base = getTradeSettingsRow();
  const override = db.prepare(`
    SELECT approval_cash_limit_cents, approval_credit_limit_cents
    FROM trade_user_settings
    WHERE user_id=?
  `).get(userId) || {};

  return {
    base,
    userOverride: override,
    resolved: {
      ...base,
      approval_cash_limit_cents: Number.isFinite(override.approval_cash_limit_cents)
        ? override.approval_cash_limit_cents
        : base.approval_cash_limit_cents,
      approval_credit_limit_cents: Number.isFinite(override.approval_credit_limit_cents)
        ? override.approval_credit_limit_cents
        : base.approval_credit_limit_cents
    }
  };
}

function computeExpiryDate(days) {
  const d = new Date();
  const add = Math.max(1, Number(days || 30));
  d.setDate(d.getDate() + add);
  return d.toISOString();
}

function normalizeTradeKeep(value) {
  if (value === false || value === 0) return 0;
  const text = String(value ?? "").toLowerCase().trim();
  if (text === "0" || text === "false" || text === "no" || text === "off") return 0;
  return 1;
}

function safeTradeJson(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return value.slice(0, 10000);
  try {
    return JSON.stringify(value).slice(0, 10000);
  } catch {
    return "";
  }
}

const VALID_TRADE_QUOTE_STATUSES = new Set(["draft", "presented", "accepted", "declined", "expired"]);

function normalizeQuoteStatus(row) {
  if (!row) return row;
  const status = String(row.status || "draft");
  if (status === "accepted" || status === "declined") return status;
  if (row.expires_at) {
    const exp = new Date(row.expires_at).getTime();
    if (Number.isFinite(exp) && Date.now() > exp) return "expired";
  }
  return status;
}

// ---- TRADE-IN: offer suggestion --------------------------------------------
app.post("/api/trade/suggest", requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const title = String(body.title || "").trim();
    const platform = String(body.platform || "").trim();
    const category = String(body.category || "").trim();
    const condition = String(body.condition || "Good").trim();
    const retailPrice = Number(body.retailPrice || 0);
    const qty = clamp(Math.floor(Number(body.qty || 1)) || 1, 1, 100);
    const policy = body.policy || {};

    if (!title) {
      return res.status(400).json({ ok: false, error: "missing_title" });
    }
    if (!Number.isFinite(retailPrice) || retailPrice <= 0) {
      return res.status(400).json({ ok: false, error: "missing_retail_price" });
    }

    const creditPercent = clamp(Number(policy.creditPercent || 50), 5, 95);
    const cashPercentRaw = Number(policy.cashPercent || (creditPercent * 0.8));
    const cashPercent = clamp(cashPercentRaw, 3, creditPercent);

    let marketMedian = 0;
    let marketSamples = 0;

    const settingsRow = getTradeSettingsRow();
    if (settingsRow.ebay_sold_enabled && typeof findSoldComps === "function") {
      try {
        const market = await findSoldComps({
          title,
          platform,
          category: (category || "games").toLowerCase(),
          completeness: "disc_only",
          isNew: condition.toLowerCase().includes("new"),
          excludeLots: true
        });
        const prices = (market?.comps || [])
          .filter((c) => c && c.currency === "USD" && Number(c.price) > 0)
          .map((c) => Number(c.price))
          .sort((a, b) => a - b);
        if (prices.length) {
          marketSamples = prices.length;
          const m = Math.floor(prices.length / 2);
          marketMedian = prices.length % 2 === 0 ? (prices[m - 1] + prices[m]) / 2 : prices[m];
        }
      } catch (err) {
        console.warn("[TRADE] suggest: market lookup failed:", err.message);
      }
    }

    const conditionFactor = tradeConditionFactor(condition);
    const categoryFactor = tradeCategoryFactor(category, title);
    const blendedRetail = marketMedian > 0
      ? (retailPrice * 0.7 + marketMedian * 0.3)
      : retailPrice;

    const baseCredit = blendedRetail * (creditPercent / 100) * conditionFactor * categoryFactor;
    const minCredit = retailPrice * 0.1;
    const maxCredit = retailPrice * 0.8;
    const creditOffer = roundMoney(clamp(baseCredit, minCredit, maxCredit));

    const cashRatio = clamp(cashPercent / Math.max(creditPercent, 1), 0.45, 1);
    const cashOffer = roundMoney(clamp(creditOffer * cashRatio, 0, creditOffer));

    const reasonParts = [
      `Policy ${creditPercent.toFixed(0)}% credit / ${cashPercent.toFixed(0)}% cash`,
      `condition factor ${(conditionFactor * 100).toFixed(0)}%`,
      `category factor ${(categoryFactor * 100).toFixed(0)}%`
    ];
    if (marketMedian > 0) {
      reasonParts.push(`market median ~$${roundMoney(marketMedian).toFixed(2)} (${marketSamples} comps)`);
    } else {
      reasonParts.push("no market comps available");
    }

    res.json({
      ok: true,
      title,
      platform,
      qty,
      creditOffer,
      cashOffer,
      perUnit: { creditOffer, cashOffer },
      totals: {
        credit: roundMoney(creditOffer * qty),
        cash: roundMoney(cashOffer * qty)
      },
      reason: reasonParts.join("; "),
      confidence: marketMedian > 0 ? "medium" : "low"
    });
  } catch (err) {
    console.error("[TRADE] suggest failed:", err);
    res.status(500).json({ ok: false, error: "trade_suggest_failed" });
  }
});

// ---- TRADE-IN: analyze image ------------------------------------------------
app.post("/api/trade/analyze-image", requireAuth, async (req, res) => {
  try {
    const { imageBase64, mimeType } = req.body || {};
    const cleanBase64 = String(imageBase64 || "").trim();
    const type = String(mimeType || "image/jpeg").trim() || "image/jpeg";
    if (!cleanBase64) {
      return res.status(400).json({ ok: false, error: "missing_image" });
    }

    if (!openai) {
      return res.json({
        ok: true,
        items: [],
        warning: "ai_not_configured",
        message: "OpenAI API key is not configured. Add items manually or wire AI credentials."
      });
    }

    const prompt = [
      "You are classifying items for a used game store trade-in intake.",
      "Return strict JSON only:",
      "{ \"items\": [ { \"title\": string, \"platform\": string, \"itemType\": string, \"brand\": string, \"conditionGuess\": string, \"quantity\": number, \"notes\": string } ] }",
      "Use itemType values like game, console, controller, accessory, cable, collectible, other.",
      "Keep up to 8 items max, and never invent certainty. If unclear, leave fields empty and note uncertainty."
    ].join("\n");

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Respond only with valid JSON." },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:${type};base64,${cleanBase64}` } }
          ]
        }
      ],
      max_completion_tokens: 500,
      temperature: 0.1
    });

    const raw = completion?.choices?.[0]?.message?.content || "";
    const parsed = tryParseJsonObject(raw);
    const rows = Array.isArray(parsed?.items) ? parsed.items : [];
    const items = rows.slice(0, 8).map((r) => ({
      title: String(r?.title || "").trim(),
      platform: String(r?.platform || "").trim(),
      itemType: String(r?.itemType || "other").trim(),
      brand: String(r?.brand || "").trim(),
      conditionGuess: String(r?.conditionGuess || "Good").trim(),
      quantity: clamp(Math.floor(Number(r?.quantity || 1)) || 1, 1, 25),
      notes: String(r?.notes || "").trim()
    }));

    return res.json({ ok: true, items });
  } catch (err) {
    console.error("[TRADE] analyze-image failed:", err);
    return res.status(500).json({ ok: false, error: "trade_analyze_failed" });
  }
});

// ---- TRADE-IN: settings -----------------------------------------------------
app.get("/api/trade/settings", requireAuth, (req, res) => {
  const { base, userOverride, resolved } = getTradeSettingsForUser(req.user.id);
  res.json({ ok: true, base, userOverride, resolved });
});

app.put("/api/trade/settings", requireAuth, requirePerm("settings_admin"), (req, res) => {
  const body = req.body || {};
  const expiryDays = clamp(Number(body.quote_expiry_days || 30), 1, 365);
  const cashLimit = Math.max(0, Math.floor(Number(body.approval_cash_limit_cents || 0)));
  const creditLimit = Math.max(0, Math.floor(Number(body.approval_credit_limit_cents || 0)));
  const ebaySold = body.ebay_sold_enabled === undefined ? 1 : (body.ebay_sold_enabled ? 1 : 0);
  const ebayActive = body.ebay_active_enabled === undefined ? 1 : (body.ebay_active_enabled ? 1 : 0);
  const ebayCountry = String(body.ebay_country || "US").toUpperCase();
  const requireCustomer = tradeBool(body.require_customer, false);
  const requireSellerId = tradeBool(body.require_seller_id, false);
  const requireAgreement = tradeBool(body.require_agreement, true);
  const defaultHoldDays = tradeInt(body.default_hold_days, 0, 0, 365);
  const testingQueueEnabled = tradeBool(body.testing_queue_enabled, true);
  const autoLabelOnComplete = tradeBool(body.auto_label_on_complete, true);
  const defaultCreditPercent = tradePercent(body.default_credit_percent, 50, 5, 95);
  const defaultCashPercent = tradePercent(body.default_cash_percent, 80, 5, 100);
  const marginFloorPercent = tradePercent(body.margin_floor_percent, 45, 0, 95);
  const offerBasisRaw = String(body.offer_basis || "sold_median").trim().toLowerCase();
  const offerBasis = ["sold_median", "sold_average", "pricecharting", "store_history", "manual"].includes(offerBasisRaw)
    ? offerBasisRaw
    : "sold_median";
  const promoActive = tradeBool(body.promo_active, false);
  const promoLabel = String(body.promo_label || "").trim().slice(0, 120);
  const promoCreditBonusPercent = tradePercent(body.promo_credit_bonus_percent, 0, 0, 100);

  db.prepare(`
    UPDATE trade_settings SET
      quote_expiry_days=@quote_expiry_days,
      approval_cash_limit_cents=@approval_cash_limit_cents,
      approval_credit_limit_cents=@approval_credit_limit_cents,
      ebay_sold_enabled=@ebay_sold_enabled,
      ebay_active_enabled=@ebay_active_enabled,
      ebay_country=@ebay_country,
      require_customer=@require_customer,
      require_seller_id=@require_seller_id,
      require_agreement=@require_agreement,
      default_hold_days=@default_hold_days,
      testing_queue_enabled=@testing_queue_enabled,
      auto_label_on_complete=@auto_label_on_complete,
      default_credit_percent=@default_credit_percent,
      default_cash_percent=@default_cash_percent,
      margin_floor_percent=@margin_floor_percent,
      offer_basis=@offer_basis,
      promo_active=@promo_active,
      promo_label=@promo_label,
      promo_credit_bonus_percent=@promo_credit_bonus_percent
    WHERE id=1
  `).run({
    quote_expiry_days: expiryDays,
    approval_cash_limit_cents: cashLimit,
    approval_credit_limit_cents: creditLimit,
    ebay_sold_enabled: ebaySold,
    ebay_active_enabled: ebayActive,
    ebay_country: ebayCountry || "US",
    require_customer: requireCustomer,
    require_seller_id: requireSellerId,
    require_agreement: requireAgreement,
    default_hold_days: defaultHoldDays,
    testing_queue_enabled: testingQueueEnabled,
    auto_label_on_complete: autoLabelOnComplete,
    default_credit_percent: defaultCreditPercent,
    default_cash_percent: defaultCashPercent,
    margin_floor_percent: marginFloorPercent,
    offer_basis: offerBasis,
    promo_active: promoActive,
    promo_label: promoLabel,
    promo_credit_bonus_percent: promoCreditBonusPercent
  });

  const { base, userOverride, resolved } = getTradeSettingsForUser(req.user.id);
  res.json({ ok: true, base, userOverride, resolved });
});

app.put("/api/trade/settings/user/:id", requireAuth, requirePerm("settings_admin"), (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isFinite(userId)) {
    return res.status(400).json({ ok: false, error: "invalid_user_id" });
  }
  const body = req.body || {};
  const cash = body.approval_cash_limit_cents;
  const credit = body.approval_credit_limit_cents;

  const hasCash = Number.isFinite(Number(cash));
  const hasCredit = Number.isFinite(Number(credit));

  if (!hasCash && !hasCredit) {
    db.prepare(`DELETE FROM trade_user_settings WHERE user_id=?`).run(userId);
  } else {
    db.prepare(`
      INSERT INTO trade_user_settings (user_id, approval_cash_limit_cents, approval_credit_limit_cents)
      VALUES (@user_id, @cash, @credit)
      ON CONFLICT(user_id) DO UPDATE SET
        approval_cash_limit_cents=excluded.approval_cash_limit_cents,
        approval_credit_limit_cents=excluded.approval_credit_limit_cents
    `).run({
      user_id: userId,
      cash: hasCash ? Math.max(0, Math.floor(Number(cash))) : null,
      credit: hasCredit ? Math.max(0, Math.floor(Number(credit))) : null
    });
  }

  res.json({ ok: true });
});

// ---- TRADE-IN: comps --------------------------------------------------------
app.post("/api/trade/comps", requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const title = String(body.title || "").trim();
    const platform = String(body.platform || "").trim();
    const category = String(body.category || "").trim();
    const condition = String(body.condition || "").trim();
    const mode = String(body.mode || "sold").toLowerCase();
    const isNew = typeof body.isNew === "boolean"
      ? body.isNew
      : condition.toLowerCase().includes("new");

    if (!title && !platform) {
      return res.status(400).json({ ok: false, error: "missing_query" });
    }

    const { resolved } = getTradeSettingsForUser(req.user.id);
    const country = resolved.ebay_country || "US";

    if (mode === "sold") {
      if (!resolved.ebay_sold_enabled) {
        return res.json({ ok: false, error: "ebay_sold_disabled", comps: [] });
      }
      if (typeof findSoldComps !== "function") {
        return res.json({ ok: false, error: "ebay_not_configured", comps: [] });
      }
      const market = await findSoldComps({
        title,
        platform,
        category: (category || "games").toLowerCase(),
        completeness: "disc_only",
        isNew,
        excludeLots: true,
        country
      });
      return res.json({ ok: true, mode: "sold", comps: market?.comps || [] });
    }

    if (!resolved.ebay_active_enabled) {
      return res.json({ ok: false, error: "ebay_active_disabled", comps: [] });
    }
    if (typeof findActiveComps !== "function") {
      return res.json({ ok: false, error: "ebay_not_configured", comps: [] });
    }

    const market = await findActiveComps({
      title,
      platform,
      category: (category || "games").toLowerCase(),
      completeness: "disc_only",
      isNew,
      excludeLots: true,
      country
    });
    return res.json({ ok: true, mode: "active", comps: market?.comps || [] });
  } catch (err) {
    console.error("[TRADE] comps failed:", err);
    return res.status(500).json({ ok: false, error: "trade_comps_failed" });
  }
});

// ---- TRADE-IN: PriceCharting snapshot -------------------------------------
app.get("/api/trade/pricecharting", requireAuth, async (req, res) => {
  try {
    if (typeof fetchPricecharting !== "function") {
      return res.json({ ok: false, error: "pricecharting_not_configured" });
    }
    const title = String(req.query.title || "").trim();
    const platform = String(req.query.platform || "").trim();
    if (!title && !platform) {
      return res.status(400).json({ ok: false, error: "missing_query" });
    }
    const refresh = req.query.refresh === "1" || req.query.refresh === "true";
    const data = await fetchPricecharting({ title, platform, refresh });
    if (!data || !data.ok) {
      return res.status(502).json({ ok: false, error: data?.error || "pricecharting_failed" });
    }
    return res.json(data);
  } catch (err) {
    console.error("[TRADE] pricecharting failed:", err);
    return res.status(500).json({ ok: false, error: "trade_pricecharting_failed" });
  }
});

// ---- TRADE-IN: inventory stats --------------------------------------------
app.get("/api/trade/inventory-stats", requireAuth, (req, res) => {
  try {
    const title = String(req.query.title || "").trim();
    const platform = String(req.query.platform || "").trim();
    if (!title) {
      return res.status(400).json({ ok: false, error: "missing_title" });
    }

    const params = platform ? [title, platform] : [title];
    const where = platform
      ? "LOWER(title)=LOWER(?) AND LOWER(platform)=LOWER(?)"
      : "LOWER(title)=LOWER(?)";

    const inv = db.prepare(`
      SELECT
        COALESCE(SUM(qty), 0) AS qty,
        COALESCE(AVG(cost), 0) AS avg_cost,
        COALESCE(AVG(price), 0) AS avg_price
      FROM items
      WHERE deleted_at IS NULL
        AND ${where}
    `).get(...params);

    const sold = db.prepare(`
      SELECT
        COALESCE(AVG(si.unit_price), 0) AS sold_avg,
        COALESCE(SUM(si.qty), 0) AS sold_count
      FROM sale_items si
      JOIN items i ON i.id = si.item_id
      WHERE ${where}
    `).get(...params);

    res.json({
      ok: true,
      qty: inv?.qty || 0,
      avg_cost: inv?.avg_cost || 0,
      avg_price: inv?.avg_price || 0,
      sold_avg: sold?.sold_avg || 0,
      sold_count: sold?.sold_count || 0
    });
  } catch (err) {
    console.error("[TRADE] inventory-stats failed:", err);
    res.status(500).json({ ok: false, error: "trade_inventory_stats_failed" });
  }
});

function normalizeTradeItems(rawItems = []) {
  const list = Array.isArray(rawItems) ? rawItems : [];
  return list.map((it, idx) => {
    const qty = clamp(Math.floor(Number(it.qty || it.quantity || 1)) || 1, 1, 999);
    const retail = Number(it.retailPrice ?? it.retail_price ?? 0) || 0;
    const credit = Number(it.creditOffer ?? it.credit_offer ?? 0) || 0;
    const cash = Number(it.cashOffer ?? it.cash_offer ?? 0) || 0;
    const keep = normalizeTradeKeep(it.keep);
    const inventoryActionRaw = String(it.inventoryAction ?? it.inventory_action ?? "merge").toLowerCase();
    const inventoryAction = inventoryActionRaw === "new" || inventoryActionRaw === "force_new" ? "new" : "merge";
    const postStatusRaw = String(it.postStatus ?? it.post_status ?? "testing").toLowerCase().replace(/\s+/g, "_");
    const postStatus = ["ready", "testing", "hold", "repair", "parts", "pass"].includes(postStatusRaw) ? postStatusRaw : "testing";
    const holdUntil = String(it.holdUntil ?? it.hold_until ?? "").trim().slice(0, 40);
    const completenessRaw = String(it.completeness ?? it.complete_in_box ?? it.completeness_type ?? "loose").toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const completeness = ["loose", "cib", "new_sealed", "cart_only", "manual_only", "console_only", "console_cib"].includes(completenessRaw)
      ? completenessRaw
      : "loose";
    return {
      line_no: idx + 1,
      sku: String(it.sku || "").trim(),
      barcode: String(it.barcode || "").trim(),
      title: String(it.title || "").trim(),
      platform: String(it.platform || "").trim(),
      category: String(it.category || "").trim(),
      condition: String(it.condition || "").trim(),
      completeness,
      qty,
      retail_price: Math.max(0, retail),
      credit_offer: Math.max(0, credit),
      cash_offer: Math.max(0, cash),
      allocated_cost: Math.max(0, Number(it.allocatedCost ?? it.allocated_cost ?? 0) || 0),
      allocated_total_cost: Math.max(0, Number(it.allocatedTotalCost ?? it.allocated_total_cost ?? 0) || 0),
      reason: String(it.reason || "").trim(),
      pass_reason: String(it.passReason ?? it.pass_reason ?? "").trim().slice(0, 500),
      condition_notes: String(it.conditionNotes ?? it.condition_notes ?? "").trim().slice(0, 1000),
      accessories_json: safeTradeJson(it.accessories ?? it.accessories_json),
      inventory_action: inventoryAction,
      post_status: keep ? postStatus : "pass",
      hold_until: holdUntil,
      label_needed: tradeBool(it.labelNeeded ?? it.label_needed, true),
      test_needed: tradeBool(it.testNeeded ?? it.test_needed, true),
      pricing_basis: String(it.pricingBasis ?? it.pricing_basis ?? "").trim().slice(0, 120),
      offer_reason: String(it.offerReason ?? it.offer_reason ?? "").trim().slice(0, 1000),
      comps_json: safeTradeJson(it.comps ?? it.comps_json),
      keep
    };
  });
}

function computeTradeItemTotals(items) {
  let totalItems = 0;
  let suggestedCash = 0;
  let suggestedCredit = 0;
  let totalRetail = 0;
  for (const it of items) {
    if (!it.keep) continue;
    totalItems += Number(it.qty || 0);
    suggestedCash += Number(it.cash_offer || 0) * Number(it.qty || 0);
    suggestedCredit += Number(it.credit_offer || 0) * Number(it.qty || 0);
    totalRetail += Number(it.retail_price || 0) * Number(it.qty || 0);
  }
  return {
    totalItems,
    suggestedCash: roundMoney(suggestedCash),
    suggestedCredit: roundMoney(suggestedCredit),
    totalRetail: roundMoney(totalRetail)
  };
}

function offerNumber(value, fallback) {
  if (value === undefined || value === null || value === "") return roundMoney(fallback || 0);
  const n = Number(value);
  return Number.isFinite(n) ? roundMoney(Math.max(0, n)) : roundMoney(fallback || 0);
}

function computeTradeTotals(items, body = {}, fallback = {}) {
  const itemTotals = computeTradeItemTotals(items);
  const suggestedCash = itemTotals.suggestedCash;
  const suggestedCredit = itemTotals.suggestedCredit;
  const finalCash = offerNumber(
    body.final_cash_offer ?? body.finalCashOffer,
    fallback.final_cash_offer ?? fallback.total_cash ?? suggestedCash
  );
  const finalCredit = offerNumber(
    body.final_credit_offer ?? body.finalCreditOffer,
    fallback.final_credit_offer ?? fallback.total_credit ?? suggestedCredit
  );
  const overrideReason = String(body.offer_override_reason ?? body.overrideReason ?? fallback.offer_override_reason ?? "").trim().slice(0, 1000);
  const cashChanged = Math.abs(finalCash - suggestedCash) >= 0.01;
  const creditChanged = Math.abs(finalCredit - suggestedCredit) >= 0.01;
  const overrideChanged = cashChanged || creditChanged;
  const overrideAboveSuggestion = finalCash > suggestedCash + 0.01 || finalCredit > suggestedCredit + 0.01;
  return {
    totalItems: itemTotals.totalItems,
    totalCash: finalCash,
    totalCredit: finalCredit,
    totalRetail: itemTotals.totalRetail,
    suggestedCash,
    suggestedCredit,
    finalCashOffer: finalCash,
    finalCreditOffer: finalCredit,
    overrideReason,
    overrideChanged,
    overrideAboveSuggestion
  };
}

function normalizeTradeQuoteExtras(body = {}, fallback = {}) {
  const promoBonus = tradePercent(body.promo_credit_bonus_percent ?? fallback.promo_credit_bonus_percent, Number(fallback.promo_credit_bonus_percent || 0), 0, 100);
  return {
    seller_id_type: String(body.seller_id_type ?? fallback.seller_id_type ?? "").trim().slice(0, 80),
    seller_id_last4: String(body.seller_id_last4 ?? fallback.seller_id_last4 ?? "").replace(/\D/g, "").slice(-4),
    seller_dob: String(body.seller_dob ?? fallback.seller_dob ?? "").trim().slice(0, 40),
    seller_address1: String(body.seller_address1 ?? fallback.seller_address1 ?? "").trim().slice(0, 180),
    seller_city: String(body.seller_city ?? fallback.seller_city ?? "").trim().slice(0, 120),
    seller_state: String(body.seller_state ?? fallback.seller_state ?? "").trim().slice(0, 40),
    seller_zip: String(body.seller_zip ?? fallback.seller_zip ?? "").trim().slice(0, 20),
    agreement_signed: tradeBool(body.agreement_signed ?? fallback.agreement_signed, false),
    intake_checklist_json: safeTradeJson(body.intake_checklist ?? body.intake_checklist_json ?? fallback.intake_checklist_json),
    completion_checklist_json: safeTradeJson(body.completion_checklist ?? body.completion_checklist_json ?? fallback.completion_checklist_json),
    promo_label: String(body.promo_label ?? fallback.promo_label ?? "").trim().slice(0, 120),
    promo_credit_bonus_percent: promoBonus,
    hold_until: String(body.hold_until ?? fallback.hold_until ?? "").trim().slice(0, 40),
    offer_override_reason: String(body.offer_override_reason ?? body.overrideReason ?? fallback.offer_override_reason ?? "").trim().slice(0, 1000)
  };
}

function validateTradeQuoteRequirements({ settings, extras, body, status, totals }) {
  const nextStatus = String(status || body?.status || "draft").toLowerCase();
  if (!["accepted", "presented"].includes(nextStatus)) return null;
  if (Number(settings.require_customer || 0) && !Number(body.customer_id || 0)) return "customer_required";
  if (Number(settings.require_seller_id || 0) && !extras.seller_id_last4) return "seller_id_required";
  if (nextStatus === "accepted" && Number(settings.require_agreement || 0) && !extras.agreement_signed) return "agreement_required";
  return null;
}

// ---- TRADE-IN: quotes -------------------------------------------------------
app.get("/api/trade/quotes", requireAuth, (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "").trim().toLowerCase();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const offset = Math.max(0, Number(req.query.offset || 0));

    const where = [];
    const params = { limit, offset };
    if (search) {
      where.push(`(
        quote_id LIKE @q
        OR customer_name LIKE @q
        OR customer_phone LIKE @q
        OR customer_email LIKE @q
      )`);
      params.q = `%${search}%`;
    }
    if (status && status !== "all" && status !== "expired") {
      where.push(`status = @status`);
      params.status = status;
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = db.prepare(`
      SELECT *
      FROM trade_quotes
      ${whereSql}
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT @limit OFFSET @offset
    `).all(params);

    let out = rows.map((r) => ({
      ...r,
      status: normalizeQuoteStatus(r)
    }));
    if (status && status !== "all") {
      out = out.filter((r) => r.status === status);
    }

    res.json({ ok: true, rows: out });
  } catch (err) {
    console.error("[TRADE] quotes list failed:", err);
    res.status(500).json({ ok: false, error: "trade_quotes_list_failed" });
  }
});

app.get("/api/trade/quotes/:quoteId", requireAuth, (req, res) => {
  const quoteId = String(req.params.quoteId || "").trim();
  if (!quoteId) return res.status(400).json({ ok: false, error: "missing_quote_id" });
  try {
    const quote = db.prepare(`SELECT * FROM trade_quotes WHERE quote_id=?`).get(quoteId);
    if (!quote) return res.status(404).json({ ok: false, error: "quote_not_found" });
    const items = db.prepare(`
      SELECT *
      FROM trade_quote_items
      WHERE quote_id=?
      ORDER BY line_no ASC, id ASC
    `).all(quoteId);
    res.json({ ok: true, quote: { ...quote, status: normalizeQuoteStatus(quote) }, items });
  } catch (err) {
    console.error("[TRADE] quote detail failed:", err);
    res.status(500).json({ ok: false, error: "trade_quote_failed" });
  }
});

app.post("/api/trade/quotes", requireAuth, (req, res) => {
  try {
    const body = req.body || {};
    const items = normalizeTradeItems(body.items || []);
    const { resolved } = getTradeSettingsForUser(req.user.id);
    const extras = normalizeTradeQuoteExtras(body);
    const requestedStatus = String(body.status || "draft").toLowerCase();
    const nextStatus = VALID_TRADE_QUOTE_STATUSES.has(requestedStatus) ? requestedStatus : "draft";
    const totals = computeTradeTotals(items, body);
    const requirementError = validateTradeQuoteRequirements({
      settings: resolved,
      extras,
      body,
      status: nextStatus,
      totals
    });
    if (requirementError) return res.status(400).json({ ok: false, error: requirementError });

    const quoteId = String(body.quote_id || uuidv4());
    const existing = db.prepare(`SELECT quote_id FROM trade_quotes WHERE quote_id=?`).get(quoteId);
    if (existing) {
      return res.status(409).json({ ok: false, error: "quote_exists", quote_id: quoteId });
    }

    const approvalCash = Math.round(Number(totals.totalCash || 0) * 100);
    const approvalCredit = Math.round(Number(totals.totalCredit || 0) * 100);
    const requiresApproval =
      approvalCash > Number(resolved.approval_cash_limit_cents || 0) ||
      approvalCredit > Number(resolved.approval_credit_limit_cents || 0) ||
      totals.overrideChanged;
    const canAcceptWithoutPin = canAcceptTradeOverrideWithoutPin(req.user);
    const managerApproval = requiresApproval ? getValidManagerApproval(body, "trade_override") : null;
    if (nextStatus === "accepted" && requiresApproval && !canAcceptWithoutPin && !managerApproval) {
      return res.status(403).json({ ok: false, error: "manager_approval_required", permission: "trade_override" });
    }
    if (nextStatus === "accepted" && totals.overrideChanged && !canAcceptWithoutPin && !String(managerApproval?.reason || "").trim()) {
      return res.status(400).json({ ok: false, error: "manager_note_required" });
    }

    const now = new Date().toISOString();
    const expiresAt = computeExpiryDate(resolved.quote_expiry_days);

    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO trade_quotes (
          quote_id, status, created_at, updated_at, expires_at,
          customer_id, customer_name, customer_phone, customer_email, customer_notes,
          policy_credit_percent, policy_cash_percent,
          approval_cash_limit_cents, approval_credit_limit_cents,
          requires_approval, approved_by, approved_at,
          seller_id_type, seller_id_last4, seller_dob, seller_address1,
          seller_city, seller_state, seller_zip, agreement_signed,
          intake_checklist_json, completion_checklist_json,
          promo_label, promo_credit_bonus_percent, hold_until,
          suggested_cash, suggested_credit, final_cash_offer, final_credit_offer,
          offer_override_reason, offer_override_requires_approval,
          offer_override_approved_by, offer_override_approved_at,
          total_items, total_cash, total_credit, total_retail, notes
        ) VALUES (
          @quote_id, @status, @created_at, @updated_at, @expires_at,
          @customer_id, @customer_name, @customer_phone, @customer_email, @customer_notes,
          @policy_credit_percent, @policy_cash_percent,
          @approval_cash_limit_cents, @approval_credit_limit_cents,
          @requires_approval, @approved_by, @approved_at,
          @seller_id_type, @seller_id_last4, @seller_dob, @seller_address1,
          @seller_city, @seller_state, @seller_zip, @agreement_signed,
          @intake_checklist_json, @completion_checklist_json,
          @promo_label, @promo_credit_bonus_percent, @hold_until,
          @suggested_cash, @suggested_credit, @final_cash_offer, @final_credit_offer,
          @offer_override_reason, @offer_override_requires_approval,
          @offer_override_approved_by, @offer_override_approved_at,
          @total_items, @total_cash, @total_credit, @total_retail, @notes
        )
      `).run({
        quote_id: quoteId,
        status: nextStatus,
        created_at: now,
        updated_at: now,
        expires_at: expiresAt,
        customer_id: body.customer_id || null,
        customer_name: String(body.customer_name || "").trim(),
        customer_phone: String(body.customer_phone || "").trim(),
        customer_email: String(body.customer_email || "").trim(),
        customer_notes: String(body.customer_notes || "").trim(),
        policy_credit_percent: Number(body.policy_credit_percent || 50),
        policy_cash_percent: Number(body.policy_cash_percent || 80),
        approval_cash_limit_cents: resolved.approval_cash_limit_cents,
        approval_credit_limit_cents: resolved.approval_credit_limit_cents,
        requires_approval: requiresApproval ? 1 : 0,
        approved_by: nextStatus === "accepted" && canAcceptWithoutPin ? req.user.id : (managerApproval?.approverId || null),
        approved_at: nextStatus === "accepted" && (canAcceptWithoutPin || managerApproval) ? now : null,
        ...extras,
        suggested_cash: totals.suggestedCash,
        suggested_credit: totals.suggestedCredit,
        final_cash_offer: totals.finalCashOffer,
        final_credit_offer: totals.finalCreditOffer,
        offer_override_requires_approval: requiresApproval && totals.overrideChanged ? 1 : 0,
        offer_override_approved_by: managerApproval?.approverId || (nextStatus === "accepted" && canAcceptWithoutPin && requiresApproval ? req.user.id : null),
        offer_override_approved_at: (managerApproval || (nextStatus === "accepted" && canAcceptWithoutPin && requiresApproval)) ? now : null,
        offer_override_reason: extras.offer_override_reason || managerApproval?.reason || "",
        total_items: totals.totalItems,
        total_cash: totals.totalCash,
        total_credit: totals.totalCredit,
        total_retail: totals.totalRetail,
        notes: String(body.notes || "").trim()
      });

      const ins = db.prepare(`
        INSERT INTO trade_quote_items (
          quote_id, line_no, sku, barcode, title, platform, category, condition, completeness,
          qty, retail_price, credit_offer, cash_offer, allocated_cost, allocated_total_cost, reason,
          pass_reason, condition_notes, accessories_json, inventory_action,
          post_status, hold_until, label_needed, test_needed, pricing_basis,
          offer_reason, comps_json, keep
        ) VALUES (
          @quote_id, @line_no, @sku, @barcode, @title, @platform, @category, @condition, @completeness,
          @qty, @retail_price, @credit_offer, @cash_offer, @allocated_cost, @allocated_total_cost, @reason,
          @pass_reason, @condition_notes, @accessories_json, @inventory_action,
          @post_status, @hold_until, @label_needed, @test_needed, @pricing_basis,
          @offer_reason, @comps_json, @keep
        )
      `);
      for (const it of items) {
        ins.run({ ...it, quote_id: quoteId });
      }
    });

    tx();
    res.json({ ok: true, quote_id: quoteId, requires_approval: requiresApproval });
  } catch (err) {
    console.error("[TRADE] create quote failed:", err);
    res.status(500).json({ ok: false, error: "trade_quote_create_failed" });
  }
});

app.put("/api/trade/quotes/:quoteId", requireAuth, (req, res) => {
  const quoteId = String(req.params.quoteId || "").trim();
  if (!quoteId) return res.status(400).json({ ok: false, error: "missing_quote_id" });
  try {
    const current = db.prepare(`SELECT * FROM trade_quotes WHERE quote_id=?`).get(quoteId);
    if (!current) return res.status(404).json({ ok: false, error: "quote_not_found" });

    const body = req.body || {};
    const items = body.items ? normalizeTradeItems(body.items || []) : null;
    const totals = items ? computeTradeTotals(items, body, current) : {
      totalItems: current.total_items,
      totalCash: current.total_cash,
      totalCredit: current.total_credit,
      totalRetail: current.total_retail,
      suggestedCash: current.suggested_cash ?? current.total_cash,
      suggestedCredit: current.suggested_credit ?? current.total_credit,
      finalCashOffer: current.final_cash_offer ?? current.total_cash,
      finalCreditOffer: current.final_credit_offer ?? current.total_credit,
      overrideReason: String(body.offer_override_reason ?? current.offer_override_reason ?? "").trim(),
      overrideChanged: Math.abs(Number(current.final_cash_offer ?? current.total_cash ?? 0) - Number(current.suggested_cash ?? current.total_cash ?? 0)) >= 0.01
        || Math.abs(Number(current.final_credit_offer ?? current.total_credit ?? 0) - Number(current.suggested_credit ?? current.total_credit ?? 0)) >= 0.01,
      overrideAboveSuggestion: Number(current.final_cash_offer ?? current.total_cash ?? 0) > Number(current.suggested_cash ?? current.total_cash ?? 0) + 0.01
        || Number(current.final_credit_offer ?? current.total_credit ?? 0) > Number(current.suggested_credit ?? current.total_credit ?? 0) + 0.01
    };

    const approvalCash = Math.round(Number(totals.totalCash || 0) * 100);
    const approvalCredit = Math.round(Number(totals.totalCredit || 0) * 100);
    const requiresApproval =
      approvalCash > Number(current.approval_cash_limit_cents || 0) ||
      approvalCredit > Number(current.approval_credit_limit_cents || 0) ||
      totals.overrideChanged;

    const nextStatus = String(body.status || current.status || "draft").toLowerCase();
    if (!VALID_TRADE_QUOTE_STATUSES.has(nextStatus)) {
      return res.status(400).json({ ok: false, error: "invalid_quote_status" });
    }
    const settingsForUser = getTradeSettingsForUser(req.user.id).resolved;
    const extras = normalizeTradeQuoteExtras(body, current);
    const requirementError = validateTradeQuoteRequirements({
      settings: settingsForUser,
      extras,
      body: { ...current, ...body, customer_id: body.customer_id ?? current.customer_id },
      status: nextStatus,
      totals
    });
    if (requirementError) return res.status(400).json({ ok: false, error: requirementError });
    const canAcceptWithoutPin = canAcceptTradeOverrideWithoutPin(req.user);
    const managerApproval = requiresApproval ? getValidManagerApproval(body, "trade_override") : null;
    if (nextStatus === "accepted" && requiresApproval && !canAcceptWithoutPin && !managerApproval) {
      return res.status(403).json({ ok: false, error: "manager_approval_required", permission: "trade_override" });
    }
    if (nextStatus === "accepted" && totals.overrideChanged && !canAcceptWithoutPin && !String(managerApproval?.reason || "").trim()) {
      return res.status(400).json({ ok: false, error: "manager_note_required" });
    }

    const now = new Date().toISOString();
    const approvedBy = (nextStatus === "accepted" && canAcceptWithoutPin)
      ? req.user.id
      : (managerApproval?.approverId || current.approved_by);
    const approvedAt = approvedBy ? (current.approved_at || now) : current.approved_at;
    const expiresAt = String(body.expires_at ?? current.expires_at ?? "").trim()
      || computeExpiryDate(getTradeSettingsForUser(req.user.id).resolved.quote_expiry_days);

    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE trade_quotes SET
          status=@status,
          updated_at=@updated_at,
          expires_at=@expires_at,
          customer_id=@customer_id,
          customer_name=@customer_name,
          customer_phone=@customer_phone,
          customer_email=@customer_email,
          customer_notes=@customer_notes,
          policy_credit_percent=@policy_credit_percent,
          policy_cash_percent=@policy_cash_percent,
          requires_approval=@requires_approval,
          approved_by=@approved_by,
          approved_at=@approved_at,
          seller_id_type=@seller_id_type,
          seller_id_last4=@seller_id_last4,
          seller_dob=@seller_dob,
          seller_address1=@seller_address1,
          seller_city=@seller_city,
          seller_state=@seller_state,
          seller_zip=@seller_zip,
          agreement_signed=@agreement_signed,
          intake_checklist_json=@intake_checklist_json,
          completion_checklist_json=@completion_checklist_json,
          promo_label=@promo_label,
          promo_credit_bonus_percent=@promo_credit_bonus_percent,
          hold_until=@hold_until,
          suggested_cash=@suggested_cash,
          suggested_credit=@suggested_credit,
          final_cash_offer=@final_cash_offer,
          final_credit_offer=@final_credit_offer,
          offer_override_reason=@offer_override_reason,
          offer_override_requires_approval=@offer_override_requires_approval,
          offer_override_approved_by=@offer_override_approved_by,
          offer_override_approved_at=@offer_override_approved_at,
          total_items=@total_items,
          total_cash=@total_cash,
          total_credit=@total_credit,
          total_retail=@total_retail,
          notes=@notes
        WHERE quote_id=@quote_id
      `).run({
        quote_id: quoteId,
        status: nextStatus,
        updated_at: now,
        expires_at: expiresAt,
        customer_id: body.customer_id ?? current.customer_id,
        customer_name: String(body.customer_name ?? current.customer_name ?? "").trim(),
        customer_phone: String(body.customer_phone ?? current.customer_phone ?? "").trim(),
        customer_email: String(body.customer_email ?? current.customer_email ?? "").trim(),
        customer_notes: String(body.customer_notes ?? current.customer_notes ?? "").trim(),
        policy_credit_percent: Number(body.policy_credit_percent ?? current.policy_credit_percent ?? 50),
        policy_cash_percent: Number(body.policy_cash_percent ?? current.policy_cash_percent ?? 80),
        requires_approval: requiresApproval ? 1 : 0,
        approved_by: approvedBy || null,
        approved_at: approvedAt || null,
        ...extras,
        suggested_cash: totals.suggestedCash,
        suggested_credit: totals.suggestedCredit,
        final_cash_offer: totals.finalCashOffer,
        final_credit_offer: totals.finalCreditOffer,
        offer_override_requires_approval: requiresApproval && totals.overrideChanged ? 1 : 0,
        offer_override_approved_by: managerApproval?.approverId || (nextStatus === "accepted" && canAcceptWithoutPin && requiresApproval ? req.user.id : current.offer_override_approved_by || null),
        offer_override_approved_at: managerApproval || (nextStatus === "accepted" && canAcceptWithoutPin && requiresApproval)
          ? now
          : (current.offer_override_approved_at || null),
        offer_override_reason: extras.offer_override_reason || managerApproval?.reason || current.offer_override_reason || "",
        total_items: totals.totalItems,
        total_cash: totals.totalCash,
        total_credit: totals.totalCredit,
        total_retail: totals.totalRetail,
        notes: String(body.notes ?? current.notes ?? "").trim()
      });

      if (items) {
        db.prepare(`DELETE FROM trade_quote_items WHERE quote_id=?`).run(quoteId);
        const ins = db.prepare(`
          INSERT INTO trade_quote_items (
            quote_id, line_no, sku, barcode, title, platform, category, condition, completeness,
            qty, retail_price, credit_offer, cash_offer, allocated_cost, allocated_total_cost, reason,
            pass_reason, condition_notes, accessories_json, inventory_action,
            post_status, hold_until, label_needed, test_needed, pricing_basis,
            offer_reason, comps_json, keep
          ) VALUES (
            @quote_id, @line_no, @sku, @barcode, @title, @platform, @category, @condition, @completeness,
            @qty, @retail_price, @credit_offer, @cash_offer, @allocated_cost, @allocated_total_cost, @reason,
            @pass_reason, @condition_notes, @accessories_json, @inventory_action,
            @post_status, @hold_until, @label_needed, @test_needed, @pricing_basis,
            @offer_reason, @comps_json, @keep
          )
        `);
        for (const it of items) {
          ins.run({ ...it, quote_id: quoteId });
        }
      }
    });

    tx();
    res.json({ ok: true, quote_id: quoteId, status: nextStatus, requires_approval: requiresApproval });
  } catch (err) {
    console.error("[TRADE] update quote failed:", err);
    res.status(500).json({ ok: false, error: "trade_quote_update_failed" });
  }
});

function localDateString(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function localMonthString(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 7);
}

function addMonths(year, monthIndex, delta) {
  return new Date(year, monthIndex + delta, 1);
}

function insertSystemTask({ sourceKey, title, description, category, priority = "normal", dueAt = "", hardDue = 0, alert = 1 }) {
  db.prepare(`
    INSERT OR IGNORE INTO manager_tasks
      (source_key, title, description, category, priority, status, assigned_scope,
       due_at, hard_due, alert, created_at, updated_at)
    VALUES
      (@source_key, @title, @description, @category, @priority, 'open', 'management',
       @due_at, @hard_due, @alert, datetime('now'), datetime('now'))
  `).run({
    source_key: sourceKey,
    title,
    description: description || "",
    category,
    priority,
    due_at: dueAt || "",
    hard_due: hardDue ? 1 : 0,
    alert: alert ? 1 : 0
  });
}

function ensureSystemManagerTasks() {
  const today = localDateString();
  insertSystemTask({
    sourceKey: `opening:${today}`,
    title: "Opening checklist",
    description: "Start-of-day store check: register, cash drawer, signage, trade cash, pending pickups, and high-priority customer follow-ups.",
    category: "opening",
    priority: "high",
    dueAt: `${today}T10:00`,
    hardDue: 0
  });
  insertSystemTask({
    sourceKey: `closing:${today}`,
    title: "Closing checklist",
    description: "End-of-day store check: closeout, deposits, trash, floor recovery, pending holds, and lock-up.",
    category: "closing",
    priority: "high",
    dueAt: `${today}T21:00`,
    hardDue: 0
  });

  const now = new Date();
  const periodDate = addMonths(now.getFullYear(), now.getMonth(), -1);
  const periodStart = localMonthString(periodDate) + "-01";
  const periodEnd = localDateString(new Date(periodDate.getFullYear(), periodDate.getMonth() + 1, 0));
  const dueDate = localDateString(new Date(now.getFullYear(), now.getMonth(), 20));
  const filed = db.prepare(`
    SELECT 1
    FROM tax_filings
    WHERE period_start <= @periodStart
      AND period_end >= @periodEnd
      AND status IN ('filed','paid')
    LIMIT 1
  `).get({ periodStart, periodEnd });
  if (!filed) {
    insertSystemTask({
      sourceKey: `sales-tax:${periodStart}`,
      title: `Sales tax filing: ${periodStart.slice(0, 7)}`,
      description: `Review taxable sales and file/pay sales tax for ${periodStart} through ${periodEnd}.`,
      category: "tax",
      priority: "urgent",
      dueAt: `${dueDate}T17:00`,
      hardDue: 1
    });
  }

  const intake = db.prepare(`
    SELECT COUNT(*) AS count
    FROM trade_intake_tasks
    WHERE status='open' AND task_type='inventory_review'
  `).get();
  if (Number(intake?.count || 0) > 0) {
    insertSystemTask({
      sourceKey: `trade-intake:${today}`,
      title: `Review trade intake bucket (${intake.count})`,
      description: "Accepted trade items are waiting to be checked and posted through Add Item.",
      category: "trade",
      priority: "high",
      dueAt: `${today}T18:00`,
      hardDue: 0
    });
  }
}

function normalizeTaskStatus(raw, fallback = "open") {
  const value = String(raw || fallback).toLowerCase().trim();
  return ["open", "in_review", "done", "cancelled"].includes(value) ? value : fallback;
}

function normalizeTaskCategory(raw) {
  const value = String(raw || "store").toLowerCase().trim();
  return ["opening", "closing", "store", "tax", "trade", "inventory", "customer", "admin"].includes(value) ? value : "store";
}

function normalizeTaskPriority(raw) {
  const value = String(raw || "normal").toLowerCase().trim();
  return ["low", "normal", "high", "urgent"].includes(value) ? value : "normal";
}

function normalizeTaskScope(raw) {
  const value = String(raw || "management").toLowerCase().trim();
  return ["management", "all", "user"].includes(value) ? value : "management";
}

function canSeeTask(user, task) {
  if (isManagementUser(user)) return true;
  if (task.assigned_scope === "all") return true;
  return task.assigned_scope === "user" && Number(task.assigned_user_id || 0) === Number(user?.id || 0);
}

function serializeManagerTask(row) {
  if (!row) return null;
  return {
    ...row,
    assigned_label: row.assigned_scope === "user"
      ? (row.assigned_display_name || row.assigned_username || `User #${row.assigned_user_id}`)
      : (row.assigned_scope === "all" ? "All users" : "Management")
  };
}

function managerTaskSelectSql(whereSql = "") {
  return `
    SELECT mt.*, au.username AS assigned_username, au.display_name AS assigned_display_name,
           cu.username AS created_by_username, du.username AS completed_by_username
    FROM manager_tasks mt
    LEFT JOIN users au ON au.id=mt.assigned_user_id
    LEFT JOIN users cu ON cu.id=mt.created_by
    LEFT JOIN users du ON du.id=mt.completed_by
    ${whereSql}
  `;
}

app.get("/api/tasks/assignees", requireAuth, (req, res) => {
  if (!isManagementUser(req.user)) return res.status(403).json({ ok: false, error: "management_required" });
  const rows = db.prepare(`
    SELECT id, username, display_name, lower(role) AS role, active,
           CASE WHEN COALESCE(pin_hash,'') <> '' THEN 1 ELSE 0 END AS has_pin
    FROM users
    WHERE active=1
    ORDER BY CASE lower(role) WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, username ASC
  `).all();
  res.json({ ok: true, rows });
});

app.get("/api/tasks", requireAuth, (req, res) => {
  try {
    ensureSystemManagerTasks();
    const status = String(req.query.status || "open").toLowerCase().trim();
    const category = String(req.query.category || "all").toLowerCase().trim();
    const assignee = String(req.query.assignee || "visible").toLowerCase().trim();
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 150)));
    const where = [];
    const params = { userId: req.user.id, status, category, limit };
    if (status && status !== "all") where.push("mt.status=@status");
    if (category && category !== "all") where.push("mt.category=@category");
    if (!isManagementUser(req.user)) {
      where.push("(mt.assigned_scope='all' OR (mt.assigned_scope='user' AND mt.assigned_user_id=@userId))");
    } else if (assignee === "mine") {
      where.push("(mt.assigned_scope='management' OR mt.assigned_scope='all' OR mt.assigned_user_id=@userId)");
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = db.prepare(`
      ${managerTaskSelectSql(whereSql)}
      ORDER BY
        CASE mt.status WHEN 'open' THEN 0 WHEN 'in_review' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
        CASE mt.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
        CASE WHEN COALESCE(mt.due_at,'')='' THEN 1 ELSE 0 END,
        mt.due_at ASC,
        mt.id DESC
      LIMIT @limit
    `).all(params).filter((task) => canSeeTask(req.user, task));
    res.json({ ok: true, rows: rows.map(serializeManagerTask), can_manage: isManagementUser(req.user) });
  } catch (err) {
    console.error("[TASKS] list failed:", err);
    res.status(500).json({ ok: false, error: "tasks_failed" });
  }
});

app.get("/api/tasks/summary", requireAuth, (req, res) => {
  try {
    ensureSystemManagerTasks();
    const allRows = db.prepare(`${managerTaskSelectSql("")}`).all()
      .filter((task) => canSeeTask(req.user, task));
    const openRows = allRows.filter((task) => task.status === "open" || task.status === "in_review");
    const today = localDateString();
    const overdue = openRows.filter((task) => task.due_at && task.due_at.slice(0, 10) < today);
    const hardDue = openRows.filter((task) => Number(task.hard_due || 0) === 1);
    const trade = db.prepare(`
      SELECT COUNT(*) AS count
      FROM trade_intake_tasks
      WHERE status='open' AND task_type='inventory_review'
    `).get();
    res.json({
      ok: true,
      can_manage: isManagementUser(req.user),
      counts: {
        open: openRows.length,
        overdue: overdue.length,
        hard_due: hardDue.length,
        trade_intake: Number(trade?.count || 0)
      },
      rows: openRows
        .sort((a, b) => String(a.due_at || "9999").localeCompare(String(b.due_at || "9999")))
        .slice(0, 8)
        .map(serializeManagerTask)
    });
  } catch (err) {
    console.error("[TASKS] summary failed:", err);
    res.status(500).json({ ok: false, error: "tasks_summary_failed" });
  }
});

app.post("/api/tasks", requireAuth, (req, res) => {
  if (!isManagementUser(req.user)) return res.status(403).json({ ok: false, error: "management_required" });
  const body = req.body || {};
  const title = String(body.title || "").trim().slice(0, 180);
  if (!title) return res.status(400).json({ ok: false, error: "missing_title" });
  const assignedScope = normalizeTaskScope(body.assigned_scope || body.assignedScope);
  const assignedUserId = assignedScope === "user" ? Number(body.assigned_user_id || body.assignedUserId || 0) : null;
  if (assignedScope === "user" && !assignedUserId) return res.status(400).json({ ok: false, error: "missing_assignee" });
  const now = new Date().toISOString();
  try {
    const info = db.prepare(`
      INSERT INTO manager_tasks
        (source_key, title, description, category, priority, status, assigned_scope,
         assigned_user_id, due_at, hard_due, alert, created_by, created_at, updated_at)
      VALUES
        (NULL, @title, @description, @category, @priority, 'open', @assigned_scope,
         @assigned_user_id, @due_at, @hard_due, @alert, @created_by, @created_at, @updated_at)
    `).run({
      title,
      description: String(body.description || "").trim().slice(0, 2000),
      category: normalizeTaskCategory(body.category),
      priority: normalizeTaskPriority(body.priority),
      assigned_scope: assignedScope,
      assigned_user_id: assignedUserId || null,
      due_at: String(body.due_at || body.dueAt || "").trim().slice(0, 40),
      hard_due: body.hard_due || body.hardDue ? 1 : 0,
      alert: body.alert === false || body.alert === 0 ? 0 : 1,
      created_by: req.user.id,
      created_at: now,
      updated_at: now
    });
    logUserAction({
      userId: String(req.user.id || ""),
      username: req.user.username || "",
      action: "task_created",
      screen: "tasks",
      metadata: { taskId: info.lastInsertRowid, title, assignedScope, assignedUserId }
    });
    const row = db.prepare(`${managerTaskSelectSql("WHERE mt.id=?")}`).get(info.lastInsertRowid);
    res.json({ ok: true, task: serializeManagerTask(row) });
  } catch (err) {
    console.error("[TASKS] create failed:", err);
    res.status(500).json({ ok: false, error: "task_create_failed" });
  }
});

app.put("/api/tasks/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ ok: false, error: "invalid_task_id" });
  try {
    const existing = db.prepare(`SELECT * FROM manager_tasks WHERE id=?`).get(id);
    if (!existing) return res.status(404).json({ ok: false, error: "task_not_found" });
    if (!canSeeTask(req.user, existing)) return res.status(403).json({ ok: false, error: "task_not_visible" });
    const body = req.body || {};
    const nextStatus = normalizeTaskStatus(body.status, existing.status);
    const management = isManagementUser(req.user);
    const now = new Date().toISOString();
    const next = {
      id,
      title: management && body.title !== undefined ? String(body.title || "").trim().slice(0, 180) : existing.title,
      description: management && body.description !== undefined ? String(body.description || "").trim().slice(0, 2000) : existing.description,
      category: management && body.category !== undefined ? normalizeTaskCategory(body.category) : existing.category,
      priority: management && body.priority !== undefined ? normalizeTaskPriority(body.priority) : existing.priority,
      status: nextStatus,
      assigned_scope: management && (body.assigned_scope !== undefined || body.assignedScope !== undefined) ? normalizeTaskScope(body.assigned_scope || body.assignedScope) : existing.assigned_scope,
      assigned_user_id: existing.assigned_user_id,
      due_at: management && (body.due_at !== undefined || body.dueAt !== undefined) ? String(body.due_at || body.dueAt || "").trim().slice(0, 40) : existing.due_at,
      hard_due: management && (body.hard_due !== undefined || body.hardDue !== undefined) ? (body.hard_due || body.hardDue ? 1 : 0) : existing.hard_due,
      alert: management && body.alert !== undefined ? (body.alert ? 1 : 0) : existing.alert,
      updated_at: now,
      completed_by: nextStatus === "done" ? req.user.id : null,
      completed_at: nextStatus === "done" ? (existing.completed_at || now) : null
    };
    if (management && next.assigned_scope === "user") {
      next.assigned_user_id = Number(body.assigned_user_id || body.assignedUserId || existing.assigned_user_id || 0) || null;
    } else if (management && next.assigned_scope !== "user") {
      next.assigned_user_id = null;
    }
    db.prepare(`
      UPDATE manager_tasks SET
        title=@title,
        description=@description,
        category=@category,
        priority=@priority,
        status=@status,
        assigned_scope=@assigned_scope,
        assigned_user_id=@assigned_user_id,
        due_at=@due_at,
        hard_due=@hard_due,
        alert=@alert,
        updated_at=@updated_at,
        completed_by=@completed_by,
        completed_at=@completed_at
      WHERE id=@id
    `).run(next);
    logUserAction({
      userId: String(req.user.id || ""),
      username: req.user.username || "",
      action: "task_updated",
      screen: "tasks",
      metadata: { taskId: id, status: nextStatus }
    });
    const row = db.prepare(`${managerTaskSelectSql("WHERE mt.id=?")}`).get(id);
    res.json({ ok: true, task: serializeManagerTask(row) });
  } catch (err) {
    console.error("[TASKS] update failed:", err);
    res.status(500).json({ ok: false, error: "task_update_failed" });
  }
});

app.get("/api/trade/tasks", requireAuth, (req, res) => {
  try {
    const status = String(req.query.status || "open").trim().toLowerCase();
    const quoteId = String(req.query.quote_id || req.query.quoteId || "").trim();
    const taskType = String(req.query.task_type || req.query.taskType || "").trim();
    const where = [];
    const params = {};
    if (status && status !== "all") {
      where.push("status=@status");
      params.status = status;
    }
    if (quoteId) {
      where.push("quote_id=@quote_id");
      params.quote_id = quoteId;
    }
    if (taskType) {
      where.push("task_type=@task_type");
      params.task_type = taskType;
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = db.prepare(`
      SELECT *
      FROM trade_intake_tasks
      ${whereSql}
      ORDER BY
        CASE status WHEN 'open' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END,
        datetime(COALESCE(due_at, created_at)) ASC,
        id ASC
      LIMIT 200
    `).all(params);
    res.json({ ok: true, rows });
  } catch (err) {
    console.error("[TRADE] tasks list failed:", err);
    res.status(500).json({ ok: false, error: "trade_tasks_failed" });
  }
});

app.put("/api/trade/tasks/:id", requireAuth, (req, res) => {
  if (!hasUserPermission(req.user, "inv_edit") && !hasUserPermission(req.user, "inv_add")) {
    return res.status(403).json({ ok: false, error: "inventory_permission_required" });
  }
  try {
    const id = Number(req.params.id || 0);
    if (!id) return res.status(400).json({ ok: false, error: "invalid_task_id" });
    const existing = db.prepare(`SELECT * FROM trade_intake_tasks WHERE id=?`).get(id);
    if (!existing) return res.status(404).json({ ok: false, error: "task_not_found" });
    const statusRaw = String(req.body?.status || existing.status || "open").trim().toLowerCase();
    const status = ["open", "waiting", "done", "cancelled"].includes(statusRaw) ? statusRaw : "open";
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE trade_intake_tasks
      SET status=@status,
          notes=@notes,
          item_id=@item_id,
          sku=@sku,
          updated_at=@updated_at,
          completed_at=@completed_at
      WHERE id=@id
    `).run({
      id,
      status,
      notes: req.body?.notes !== undefined ? String(req.body.notes || "").trim().slice(0, 1000) : existing.notes,
      item_id: req.body?.item_id !== undefined ? Number(req.body.item_id || 0) || null : existing.item_id,
      sku: req.body?.sku !== undefined ? String(req.body.sku || "").trim().slice(0, 80) : existing.sku,
      updated_at: now,
      completed_at: status === "done" ? (existing.completed_at || now) : null
    });
    res.json({ ok: true, task: db.prepare(`SELECT * FROM trade_intake_tasks WHERE id=?`).get(id) });
  } catch (err) {
    console.error("[TRADE] task update failed:", err);
    res.status(500).json({ ok: false, error: "trade_task_update_failed" });
  }
});

app.get("/api/trade/reports/summary", requireAuth, requireReports, (req, res) => {
  try {
    const start = String(req.query.start || "").trim();
    const end = String(req.query.end || "").trim();
    const days = Math.max(1, Math.min(365, Number(req.query.days || 30)));
    const endExpr = end ? "date(@end)" : "date('now')";
    const startExpr = start ? "date(@start)" : `date(${endExpr}, '-' || @days || ' day')`;
    const params = { start, end, days };

    const byStatus = db.prepare(`
      SELECT status, COUNT(*) AS count,
             COALESCE(SUM(total_cash),0) AS cash,
             COALESCE(SUM(total_credit),0) AS credit,
             COALESCE(SUM(total_retail),0) AS retail,
             COALESCE(SUM(total_items),0) AS items
      FROM trade_quotes
      WHERE date(created_at) BETWEEN ${startExpr} AND ${endExpr}
      GROUP BY status
      ORDER BY count DESC
    `).all(params);

    const accepted = db.prepare(`
      SELECT COUNT(*) AS count,
             COALESCE(SUM(total_items),0) AS items,
             COALESCE(SUM(total_cash),0) AS cash,
             COALESCE(SUM(total_credit),0) AS credit,
             COALESCE(SUM(total_retail),0) AS retail
      FROM trade_quotes
      WHERE status='accepted'
        AND date(COALESCE(completed_at, updated_at, created_at)) BETWEEN ${startExpr} AND ${endExpr}
    `).get(params) || {};

    const tasks = db.prepare(`
      SELECT task_type, status, COUNT(*) AS count
      FROM trade_intake_tasks
      WHERE date(created_at) BETWEEN ${startExpr} AND ${endExpr}
      GROUP BY task_type, status
      ORDER BY task_type, status
    `).all(params);

    const topPlatforms = db.prepare(`
      SELECT COALESCE(NULLIF(platform,''), 'Unspecified') AS platform,
             COUNT(*) AS lines,
             COALESCE(SUM(qty),0) AS qty,
             COALESCE(SUM(retail_price * qty),0) AS retail
      FROM trade_quote_items tqi
      JOIN trade_quotes tq ON tq.quote_id=tqi.quote_id
      WHERE tq.status='accepted'
        AND tqi.keep != 0
        AND date(COALESCE(tq.completed_at, tq.updated_at, tq.created_at)) BETWEEN ${startExpr} AND ${endExpr}
      GROUP BY COALESCE(NULLIF(platform,''), 'Unspecified')
      ORDER BY qty DESC, retail DESC
      LIMIT 8
    `).all(params);

    const retail = Number(accepted.retail || 0);
    const cashEquivalent = Number(accepted.cash || 0);
    const estimatedMargin = retail > 0 ? Math.round((1 - cashEquivalent / retail) * 100) : 0;

    res.json({
      ok: true,
      range: { start: start || "", end: end || "", days },
      totals: {
        accepted_quotes: Number(accepted.count || 0),
        accepted_items: Number(accepted.items || 0),
        accepted_cash: Number(accepted.cash || 0),
        accepted_credit: Number(accepted.credit || 0),
        accepted_retail: retail,
        estimated_margin_percent: estimatedMargin
      },
      byStatus,
      tasks,
      topPlatforms
    });
  } catch (err) {
    console.error("[TRADE] report summary failed:", err);
    res.status(500).json({ ok: false, error: "trade_report_failed" });
  }
});

// ---- REAL BARCODE PNG ENDPOINT (Code128, used for your INTERNAL labels) ----
async function renderBarcodePng(res, code, label = "", { scale = 3, height = 12 } = {}) {
  if (!code) {
    return res.status(400).json({ error: "missing_code" });
  }
  try {
    const png = await bwipjs.toBuffer({
      bcid: "code128",
      text: code,
      scale: Math.max(1, Math.min(6, Number(scale) || 3)),
      height: Math.max(8, Math.min(80, Number(height) || 12)),
      includetext: true,
      textxalign: "center",
      textsize: 10,
      alttext: label || code,
      paddingwidth: 8,
      paddingheight: 8
    });
    res.type("image/png");
    return res.send(png);
  } catch (err) {
    console.error("[BARCODE]", err);
    return res.status(500).json({ error: "barcode_failed" });
  }
}

app.get("/barcode/:code", async (req, res) => {
  const code = val(req.params.code);
  const label = val(req.query.label || "");
  return renderBarcodePng(res, code, label, {
    scale: req.query.scale,
    height: req.query.height
  });
});

// POS compatibility endpoint: /barcode?text=...
app.get("/barcode", async (req, res) => {
  const code = val(req.query.text || req.query.code || "");
  const label = val(req.query.label || code);
  return renderBarcodePng(res, code, label, {
    scale: req.query.scale,
    height: req.query.height
  });
});

// ---- NEW: MULTI-LABEL PDF ENDPOINT FOR MUNBYN / THERMAL -------------------
// POST /print-labels
// Body: { labelSize: "2x1" | "2.25x1.25" | "1.5x1" | "2.25x1.375", items: [{ sku,title,barcode }] }
app.post("/print-labels", async (req, res) => {
  try {
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items : [];
    let labelSize = String(body.labelSize || "2x1");

    if (!items.length) {
      return res.status(400).json({ error: "no_items" });
    }

    const SIZE_MAP = {
      "2x1":        { wIn: 2.0,   hIn: 1.0   },
      "2.25x1.25":  { wIn: 2.25,  hIn: 1.25 },
      "1.5x1":      { wIn: 1.5,   hIn: 1.0   },
      "2.25x1.375": { wIn: 2.25,  hIn: 1.375 }
    };

    if (!SIZE_MAP[labelSize]) {
      labelSize = "2x1";
    }
    const { wIn, hIn } = SIZE_MAP[labelSize];

    const widthPts = wIn * 72;
    const heightPts = hIn * 72;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="labels.pdf"');

    const doc = new PDFDocument({
      size: [widthPts, heightPts],
      margin: 4
    });

    doc.pipe(res);

    const cleanCode = (val) =>
      String(val || "").replace(/\D/g, "").trim();

    const cleanText = (val) =>
      String(val || "").trim();

    let first = true;

    for (const it of items) {
      const code = cleanCode(it.sku || it.code || it.barcode);
      if (!code) continue;

      const labelText = cleanText(it.title || it.label || it.desc || code);

      // --- NEW: build price text for the same line as SKU ---
      let priceText = "";
      if (it.price !== undefined && it.price !== null && it.price !== "") {
        const priceNum = Number(it.price);
        if (!Number.isNaN(priceNum) && priceNum > 0) {
          priceText = ` - $${priceNum.toFixed(2)}`;
        }
      }
      // ------------------------------------------------------

      if (!first) {
        doc.addPage({ size: [widthPts, heightPts], margin: 4 });
      }
      first = false;

      const png = await bwipjs.toBuffer({
        bcid: "code128",
        text: code,
        scale: 3,
        height: 12,
        includetext: false,
        paddingwidth: 4,
        paddingheight: 4
      });

      const pageW = doc.page.width;
      const pageH = doc.page.height;

      const maxBarcodeW = pageW - 12;
      const maxBarcodeH = pageH * 0.55;
      const imgX = (pageW - maxBarcodeW) / 2;
      const imgY = 4;

      doc.image(png, imgX, imgY, {
        fit: [maxBarcodeW, maxBarcodeH],
        align: "center",
        valign: "top"
      });

      const textTop = pageH * 0.55 + 4;

      // Same line: SKU (code) + price
      doc.fontSize(7);
      doc.text(`${code}${priceText}`, 0, textTop, {
        width: pageW,
        align: "center"
      });

      // Title/label stays exactly where it was
      doc.fontSize(6);
      doc.text(labelText.slice(0, 60), 6, textTop + 10, {
        width: pageW - 12,
        align: "center"
      });
    }

    if (first) {
      doc.addPage({ size: [widthPts, heightPts], margin: 4 });
      doc.fontSize(8).text("No valid SKUs to print.", { align: "center" });
    }

    doc.end();
  } catch (err) {
    console.error("[PRINT-LABELS] error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "print_failed" });
    }
  }
});

// Items (list)
app.get("/api/items", requireAuth, (_req, res) => {
  storeWorkflows?.refreshAllBundleAvailability?.();
  const rows = db.prepare(`SELECT * FROM items WHERE deleted_at IS NULL ORDER BY createdAt DESC, id DESC`).all();
  res.json(addBucketFieldsToRows(rows));
});

app.get("/items", requireAuth, (_req, res) => {
  storeWorkflows?.refreshAllBundleAvailability?.();
  const rows = db.prepare(`SELECT * FROM items WHERE deleted_at IS NULL ORDER BY createdAt DESC, id DESC`).all();
  res.json(addBucketFieldsToRows(rows));
});

// Lookup by barcode or internal SKU
app.get("/api/items/by-barcode/:code", requireAuth, (req, res) => {
  const code = val(req.params.code);
  if (!code) {
    return res.status(400).json({ error: "missing_barcode" });
  }

  try {
    const row = db
      .prepare(
        `
      SELECT *
      FROM items
      WHERE deleted_at IS NULL
        AND (barcode = ? OR sku = ?)
      ORDER BY createdAt DESC, id DESC
      LIMIT 1
    `
      )
      .get(code, code);

    if (!row) {
      return res.status(404).json({ error: "not_found" });
    }

    res.json({ ok: true, item: addBucketFieldsToRows([row])[0] });
  } catch (err) {
    console.error("[API] lookup by barcode failed:", err);
    res.status(500).json({ error: "db_error" });
  }
});

// Stable grouping/SKU helpers
function parseGroupParams(q) {
  return {
    title: val(q.title || q.game || q.name),
    platform: val(q.platform || q.system || q.console || ""),
    category: val(q.category || q.cat || q.type || "games"),
    condition: val(q.condition || q.state || "used")
  };
}

app.get("/api/group-info", requireAuth, (req, res) => {
  const { title, platform, category, condition } = parseGroupParams(req.query || {});
  if (!title || !category) return res.status(400).json({ ok: false, error: "missing title/category" });

  const sku = skuFromInputs({ title, platform, category, condition });
  const row = db.prepare(`SELECT * FROM items WHERE sku=? AND deleted_at IS NULL`).get(sku);

  const internalCode = sku;
  const externalBarcode = row?.barcode || "";

  if (!row) {
    return res.json({
      exists: false,
      sku,
      barcode: internalCode,
      internalCode,
      externalBarcode,
      price: 0,
      qty: 0,
      sellableQty: 0,
      availableToSell: 0,
      cost: 0
    });
  }

  res.json({
    exists: true,
    sku,
    barcode: internalCode,
    internalCode,
    externalBarcode,
    price: row.price,
    qty: row.qty,
    sellableQty: getInventoryBucketQty(row.id, "sellable", null),
    availableToSell: getInventoryBucketQty(row.id, "sellable", null),
    cost: row.cost
  });
});

function parseControlEventPayload(row) {
  try {
    const payload = JSON.parse(row?.payload_json || "{}");
    return payload && typeof payload === "object" ? payload : {};
  } catch {
    return {};
  }
}

function controlLineQty(line) {
  const raw = line?.qtySold ?? line?.qty ?? line?.quantity ?? 0;
  const qty = Math.floor(Number(raw || 0));
  return Number.isFinite(qty) ? Math.max(0, qty) : 0;
}

function controlLineMoney(line, keys) {
  for (const key of keys) {
    if (line && line[key] !== "" && line[key] !== null && line[key] !== undefined) {
      const value = Number(line[key]);
      if (Number.isFinite(value)) return Math.max(0, value);
    }
  }
  return 0;
}

function summarizeControlEvent(row) {
  const payload = parseControlEventPayload(row);
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  const status = String(payload.status || row.status || "draft");
  const channel = String(payload.channel || row.channel || "other");
  const name = String(payload.name || row.name || "Untitled Event");
  let units = 0;
  let retail = 0;
  let cost = 0;
  const skuSet = new Set();

  for (const line of lines) {
    const qty = controlLineQty(line);
    if (!qty) continue;
    units += qty;
    retail += qty * controlLineMoney(line, ["sellPrice", "price", "listPrice"]);
    cost += qty * controlLineMoney(line, ["cost", "unitCost"]);
    const sku = String(line?.sku || "").trim();
    if (sku) skuSet.add(sku);
  }

  return {
    id: row.id,
    name,
    channel,
    status,
    units,
    skuCount: skuSet.size,
    retail,
    cost,
    backendSaleId: row.backend_sale_id || payload.backendSaleId || null,
    updatedAt: row.updated_at || payload.updatedAt || null,
    finalizedAt: row.finalized_at || payload.finalizedAt || null
  };
}

app.get("/api/inventory-control", requireAuth, (req, res) => {
  try {
    const lowSetting = db.prepare(`SELECT value FROM pos_settings WHERE key='low_stock_threshold'`).get();
    const lowStockThreshold = Math.max(0, Number(lowSetting?.value || 1));

    const inventory = db.prepare(`
      WITH bucketed AS (
        SELECT
          i.id,
          i.price,
          i.cost,
          COALESCE(SUM(CASE WHEN iq.status='sellable' THEN iq.qty ELSE 0 END), 0) AS sellable_qty,
          COALESCE(SUM(CASE WHEN iq.status IN (
            'sellable','display','demo','event_hold','event_active','reserved','testing_hold','repair_hold','damaged'
          ) THEN iq.qty ELSE 0 END), 0) AS on_hand_qty
        FROM items i
        LEFT JOIN inventory_quantities iq ON iq.item_id=i.id
        WHERE i.deleted_at IS NULL
        GROUP BY i.id
      )
      SELECT
        COUNT(*) AS active_skus,
        COALESCE(SUM(sellable_qty), 0) AS sellable_units,
        COALESCE(SUM(on_hand_qty), 0) AS on_hand_units,
        COALESCE(SUM(sellable_qty * COALESCE(price,0)), 0) AS retail_value,
        COALESCE(SUM(on_hand_qty * COALESCE(cost,0)), 0) AS cost_value,
        COALESCE(SUM(CASE WHEN sellable_qty > 0 AND sellable_qty <= @low THEN 1 ELSE 0 END), 0) AS low_stock_skus,
        COALESCE(SUM(CASE WHEN on_hand_qty <= 0 THEN 1 ELSE 0 END), 0) AS zero_stock_skus,
        0 AS negative_qty_skus
      FROM bucketed
    `).get({ low: lowStockThreshold });

    const bucketStatsRows = db.prepare(`
      SELECT iq.status,
             COUNT(DISTINCT iq.item_id) AS records,
             COALESCE(SUM(iq.qty), 0) AS units,
             COALESCE(SUM(iq.qty * COALESCE(i.price,0)), 0) AS value
      FROM inventory_quantities iq
      JOIN items i ON i.id=iq.item_id
      WHERE i.deleted_at IS NULL
      GROUP BY iq.status
    `).all();
    const bucketStats = new Map(bucketStatsRows.map((row) => [row.status, row]));
    const bucket = (key) => bucketStats.get(key) || { records: 0, units: 0, value: 0 };

    const reservations = db.prepare(`
      SELECT COUNT(*) AS records, COALESCE(SUM(qty),0) AS units
      FROM reservations
      WHERE status='active'
    `).get();

    const layaways = db.prepare(`
      SELECT COUNT(DISTINCT l.id) AS records, COALESCE(SUM(li.qty),0) AS units
      FROM layaways l
      LEFT JOIN layaway_items li ON li.layaway_id=l.id
      WHERE l.status='active'
    `).get();

    const onlineOrders = db.prepare(`
      SELECT COUNT(DISTINCT oo.id) AS records, COALESCE(SUM(ooi.qty),0) AS units
      FROM online_orders oo
      LEFT JOIN online_order_items ooi ON ooi.order_id=oo.id
      WHERE oo.status IN ('pending','paid','packed')
    `).get();

    const waste30 = db.prepare(`
      SELECT COUNT(*) AS records, COALESCE(SUM(qty),0) AS units, COALESCE(SUM(totalCost),0) AS cost, COALESCE(SUM(totalPrice),0) AS retail
      FROM waste_log
      WHERE datetime(createdAt) >= datetime('now', '-30 days')
    `).get();

    const deleted30 = db.prepare(`
      SELECT COUNT(*) AS records, COALESCE(SUM(qty),0) AS units, COALESCE(SUM(totalCost),0) AS cost, COALESCE(SUM(totalPrice),0) AS retail
      FROM deleted_items
      WHERE datetime(deletedAt) >= datetime('now', '-30 days')
    `).get();

    const openStockCounts = db.prepare(`
      SELECT COUNT(*) AS records
      FROM stock_counts
      WHERE status='open'
    `).get();

    const tradeTasks = db.prepare(`
      SELECT task_type, COUNT(*) AS records
      FROM trade_intake_tasks
      WHERE status='open'
      GROUP BY task_type
    `).all();

    const eventRows = db.prepare(`
      SELECT id, name, channel, status, payload_json, backend_sale_id, created_at, updated_at, finalized_at
      FROM live_events
      ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
      LIMIT 80
    `).all();
    const events = eventRows.map(summarizeControlEvent);
    const draftEvents = events.filter((event) => event.status === "draft");
    const finalizedEvents = events.filter((event) => event.status === "finalized");
    const eventDraftUnits = draftEvents.reduce((sum, event) => sum + Number(event.units || 0), 0);
    const eventFinalizedUnits = finalizedEvents.reduce((sum, event) => sum + Number(event.units || 0), 0);

    const recentMovements = db.prepare(`
      SELECT *
      FROM (
        SELECT im.id, im.created_at, im.item_id, im.sku, im.qty_delta, im.reason, im.sale_id, im.refund_id, im.note,
               u.username,
               i.title, i.platform, i.category, i.condition
        FROM inventory_movements im
        LEFT JOIN users u ON u.id=im.user_id
        LEFT JOIN items i ON i.id=im.item_id
        UNION ALL
        SELECT ibm.id, ibm.created_at, ibm.item_id, ibm.sku, 0 AS qty_delta, ibm.reason, NULL AS sale_id, NULL AS refund_id,
               (COALESCE(ibm.qty,0) || ' ' || COALESCE(ibm.from_status,'') || '/' || COALESCE(ibm.from_location,'') || ' -> ' || COALESCE(ibm.to_status,'') || '/' || COALESCE(ibm.to_location,'') ||
                CASE WHEN TRIM(COALESCE(ibm.note,'')) <> '' THEN ': ' || ibm.note ELSE '' END) AS note,
               u.username,
               i.title, i.platform, i.category, i.condition
        FROM inventory_bucket_movements ibm
        LEFT JOIN users u ON u.id=ibm.user_id
        LEFT JOIN items i ON i.id=ibm.item_id
      )
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT 80
    `).all();

    const topStock = db.prepare(`
      SELECT i.id, i.sku, i.title, i.platform, i.category, i.condition,
             COALESCE(SUM(CASE WHEN iq.status='sellable' THEN iq.qty ELSE 0 END), 0) AS qty,
             i.cost, i.price, i.barcode, i.wix_product_id,
             COALESCE(SUM(CASE WHEN iq.status='sellable' THEN iq.qty ELSE 0 END), 0) * COALESCE(i.price,0) AS retail_value
      FROM items i
      LEFT JOIN inventory_quantities iq ON iq.item_id=i.id
      WHERE i.deleted_at IS NULL
      GROUP BY i.id
      HAVING COALESCE(SUM(CASE WHEN iq.status='sellable' THEN iq.qty ELSE 0 END), 0) > 0
      ORDER BY retail_value DESC, COALESCE(SUM(CASE WHEN iq.status='sellable' THEN iq.qty ELSE 0 END), 0) DESC, i.title COLLATE NOCASE ASC
      LIMIT 40
    `).all();

    const exceptions = {
      negativeQty: db.prepare(`
        SELECT id, sku, title, platform, qty
        FROM items
        WHERE deleted_at IS NULL AND COALESCE(qty,0) < 0
        ORDER BY qty ASC
        LIMIT 25
      `).all(),
      missingPrice: db.prepare(`
        SELECT i.id, i.sku, i.title, i.platform,
               COALESCE(SUM(CASE WHEN iq.status IN ('sellable','display','demo','event_hold','event_active','reserved','testing_hold','repair_hold','damaged') THEN iq.qty ELSE 0 END), 0) AS on_hand_qty,
               i.price
        FROM items i
        LEFT JOIN inventory_quantities iq ON iq.item_id=i.id
        WHERE i.deleted_at IS NULL AND COALESCE(i.price,0) <= 0
        GROUP BY i.id
        HAVING on_hand_qty > 0
        ORDER BY on_hand_qty DESC, i.title COLLATE NOCASE ASC
        LIMIT 25
      `).all(),
      missingCost: db.prepare(`
        SELECT i.id, i.sku, i.title, i.platform,
               COALESCE(SUM(CASE WHEN iq.status IN ('sellable','display','demo','event_hold','event_active','reserved','testing_hold','repair_hold','damaged') THEN iq.qty ELSE 0 END), 0) AS on_hand_qty,
               i.cost
        FROM items i
        LEFT JOIN inventory_quantities iq ON iq.item_id=i.id
        WHERE i.deleted_at IS NULL AND COALESCE(i.cost,0) <= 0
        GROUP BY i.id
        HAVING on_hand_qty > 0
        ORDER BY on_hand_qty DESC, i.title COLLATE NOCASE ASC
        LIMIT 25
      `).all(),
      missingBarcode: db.prepare(`
        SELECT i.id, i.sku, i.title, i.platform,
               COALESCE(SUM(CASE WHEN iq.status IN ('sellable','display','demo','event_hold','event_active','reserved','testing_hold','repair_hold','damaged') THEN iq.qty ELSE 0 END), 0) AS on_hand_qty
        FROM items i
        LEFT JOIN inventory_quantities iq ON iq.item_id=i.id
        WHERE i.deleted_at IS NULL AND TRIM(COALESCE(i.barcode,'')) = ''
        GROUP BY i.id
        HAVING on_hand_qty > 0
        ORDER BY on_hand_qty DESC, i.title COLLATE NOCASE ASC
        LIMIT 25
      `).all(),
      duplicateBarcodes: db.prepare(`
        SELECT i.barcode, COUNT(DISTINCT i.id) AS item_count,
               COALESCE(SUM(CASE WHEN iq.status IN ('sellable','display','demo','event_hold','event_active','reserved','testing_hold','repair_hold','damaged') THEN iq.qty ELSE 0 END), 0) AS units,
               GROUP_CONCAT(DISTINCT i.sku) AS skus
        FROM items i
        LEFT JOIN inventory_quantities iq ON iq.item_id=i.id
        WHERE i.deleted_at IS NULL AND TRIM(COALESCE(i.barcode,'')) <> ''
        GROUP BY i.barcode
        HAVING COUNT(DISTINCT i.id) > 1
        ORDER BY item_count DESC, units DESC
        LIMIT 25
      `).all()
    };

    const reservedUnits =
      Number(reservations?.units || 0) +
      Number(layaways?.units || 0) +
      Number(onlineOrders?.units || 0);

    const lanes = [
      {
        key: "sellable",
        label: "Sales Section",
        support: "current",
        units: Number(bucket("sellable").units || 0),
        records: Number(bucket("sellable").records || 0),
        value: Number(bucket("sellable").value || 0),
        note: "Sellable bucket. POS sales and Wix sync pull from this bucket."
      },
      {
        key: "online",
        label: "Online Eligible",
        support: "current",
        units: Number(bucket("sellable").units || 0),
        records: Number(bucket("sellable").records || 0),
        value: Number(bucket("sellable").value || 0),
        note: "Online available quantity is sellable only. Other buckets do not sync by default."
      },
      {
        key: "reserved",
        label: "Reserved/Holds",
        support: "partial",
        units: Number(bucket("reserved").units || 0) + reservedUnits,
        records: Number(bucket("reserved").records || 0) + Number(reservations?.records || 0) + Number(layaways?.records || 0) + Number(onlineOrders?.records || 0),
        value: Number(bucket("reserved").value || 0),
        note: "Manual reserved bucket plus existing layaway/reservation/online hold workflows."
      },
      {
        key: "event_hold",
        label: "Event Hold",
        support: "current",
        units: Number(bucket("event_hold").units || 0),
        records: Number(bucket("event_hold").records || 0),
        value: Number(bucket("event_hold").value || 0),
        note: "Inventory protected for events. Draft live-event lines are still listed below until checkout/check-in is added."
      },
      { key: "event_active", label: "Event Active", support: "current", units: Number(bucket("event_active").units || 0), records: Number(bucket("event_active").records || 0), value: Number(bucket("event_active").value || 0), note: "Inventory currently out at an event." },
      { key: "display", label: "Display", support: "current", units: Number(bucket("display").units || 0), records: Number(bucket("display").records || 0), value: Number(bucket("display").value || 0), note: "Display shelf stock excluded from online sync." },
      { key: "demo", label: "Demo", support: "current", units: Number(bucket("demo").units || 0), records: Number(bucket("demo").records || 0), value: Number(bucket("demo").value || 0), note: "Playable/demo stock excluded from online sync." },
      { key: "testing_hold", label: "Testing", support: "current", units: Number(bucket("testing_hold").units || 0), records: Number(bucket("testing_hold").records || 0), value: Number(bucket("testing_hold").value || 0), note: `${tradeTasks.reduce((sum, row) => sum + Number(row.records || 0), 0)} open trade/service task record(s) may also need review.` },
      { key: "repair_hold", label: "Repair", support: "current", units: Number(bucket("repair_hold").units || 0), records: Number(bucket("repair_hold").records || 0), value: Number(bucket("repair_hold").value || 0), note: "Repair hold stock excluded from online sync." },
      { key: "damaged", label: "Damaged", support: "current", units: Number(bucket("damaged").units || 0), records: Number(bucket("damaged").records || 0), value: Number(bucket("damaged").value || 0), note: "Damaged stock is on hand but not online eligible." },
      { key: "missing", label: "Missing", support: "current", units: Number(bucket("missing").units || 0), records: Number(bucket("missing").records || 0), value: Number(bucket("missing").value || 0), note: "Missing stock is tracked but excluded from on-hand totals and online sync." },
      { key: "waste", label: "Waste", support: "partial", units: Number(bucket("waste").units || 0), records: Number(bucket("waste").records || 0), value: Number(bucket("waste").value || 0), note: `${Number(waste30?.units || 0)} unit(s) written off in the last 30 days.` },
      { key: "sold", label: "Sold/Event Finalized", support: "partial", units: Number(bucket("sold").units || 0) + eventFinalizedUnits, records: Number(bucket("sold").records || 0) + finalizedEvents.length, value: Number(bucket("sold").value || 0), note: "Normal POS sales remain in sales history; this bucket is available for manual status tracking." }
    ];

    res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      lowStockThreshold,
      locations: readInventoryLocations(),
      summary: {
        activeSkus: Number(inventory?.active_skus || 0),
        sellableSkus: Number(bucket("sellable").records || 0),
        sellableUnits: Number(inventory?.sellable_units || 0),
        retailValue: Number(inventory?.retail_value || 0),
        costValue: Number(inventory?.cost_value || 0),
        lowStockSkus: Number(inventory?.low_stock_skus || 0),
        zeroStockSkus: Number(inventory?.zero_stock_skus || 0),
        negativeQtySkus: Number(inventory?.negative_qty_skus || 0),
        eventDraftUnits,
        eventFinalizedUnits,
        reservedUnits,
        wasteUnits30d: Number(waste30?.units || 0),
        deletedUnits30d: Number(deleted30?.units || 0),
        openStockCounts: Number(openStockCounts?.records || 0)
      },
      lanes,
      holds: { reservations, layaways, onlineOrders },
      events,
      recentMovements,
      topStock,
      exceptions,
      tradeTasks,
      waste30,
      deleted30
    });
  } catch (err) {
    console.error("[API] /api/inventory-control failed:", err);
    res.status(500).json({ ok: false, error: "inventory_control_failed" });
  }
});

app.get("/api/inventory-control/items", requireAuth, (req, res) => {
  try {
    const rawStatus = String(req.query.status || "sellable").trim().toLowerCase();
    const status = rawStatus === "online" ? "sellable" : normalizeInventoryStatus(rawStatus, "sellable");
    const rawLocation = String(req.query.location || "").trim();
    const location = rawLocation ? normalizeInventoryLocation(rawLocation) : "";
    const params = { status };
    const locationClause = location ? "AND iq.location=@location" : "";
    if (location) params.location = location;

    const rows = db.prepare(`
      SELECT i.id, i.sku, i.title, i.platform, i.category, i.condition, i.variant,
             i.qty AS total_qty, i.cost, i.price, i.barcode,
             iq.status, iq.location, iq.qty AS bucket_qty,
             iq.qty * COALESCE(i.price,0) AS retail_value,
             iq.qty * COALESCE(i.cost,0) AS cost_value
      FROM inventory_quantities iq
      JOIN items i ON i.id=iq.item_id
      WHERE i.deleted_at IS NULL
        AND iq.status=@status
        AND iq.qty > 0
        ${locationClause}
      ORDER BY iq.qty DESC, i.title COLLATE NOCASE ASC, i.sku COLLATE NOCASE ASC
      LIMIT 500
    `).all(params);

    res.json({
      ok: true,
      status,
      location: location || null,
      locations: readInventoryLocations(),
      rows
    });
  } catch (err) {
    console.error("[API] /api/inventory-control/items failed:", err);
    res.status(500).json({ ok: false, error: "inventory_control_items_failed" });
  }
});

app.get("/api/inventory-locations", requireAuth, (_req, res) => {
  res.json({ ok: true, ...serializeInventoryLocationSettings() });
});

app.post("/api/sku", requireAuth, (req, res) => {
  const body = req.body || {};
  const sku = skuFromInputs(body);
  res.json({ ok: true, sku });
});

function parseJsonObject(raw, fallback = {}) {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function serializeHeldSaleRow(row) {
  const payload = parseJsonObject(row.payload_json, {});
  return {
    ...payload,
    id: row.id,
    label: payload.label || row.label || "Held Sale",
    createdAt: payload.createdAt || row.created_at,
    updatedAt: payload.updatedAt || row.updated_at
  };
}

function serializeLiveEventRow(row) {
  const payload = parseJsonObject(row.payload_json, {});
  return {
    ...payload,
    id: row.id,
    name: payload.name || row.name || "",
    channel: payload.channel || row.channel || "other",
    status: payload.status || row.status || "draft",
    backendSaleId: payload.backendSaleId || row.backend_sale_id || null,
    createdAt: payload.createdAt || row.created_at,
    updatedAt: payload.updatedAt || row.updated_at,
    finalizedAt: payload.finalizedAt || row.finalized_at || ""
  };
}

const COMMUNITY_EVENT_STATUSES = new Set(["scheduled", "check_in", "live", "completed", "cancelled"]);
const COMMUNITY_ATTENDEE_STATUSES = new Set(["reserved", "checked_in", "no_show", "cancelled"]);

function normalizeCommunityEventStatus(raw) {
  const status = String(raw || "scheduled").toLowerCase().trim();
  return COMMUNITY_EVENT_STATUSES.has(status) ? status : "scheduled";
}

function normalizeCommunityAttendeeStatus(raw) {
  const status = String(raw || "reserved").toLowerCase().trim();
  return COMMUNITY_ATTENDEE_STATUSES.has(status) ? status : "reserved";
}

function toBoolInt(value) {
  return value === true || value === 1 || value === "1" || String(value || "").toLowerCase() === "true" ? 1 : 0;
}

function cleanText(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function communityEventStats(eventId) {
  return db.prepare(`
    SELECT
      COUNT(*) AS attendee_count,
      SUM(CASE WHEN status IN ('reserved','checked_in') THEN 1 ELSE 0 END) AS active_count,
      SUM(CASE WHEN status='checked_in' THEN 1 ELSE 0 END) AS checked_in_count,
      SUM(CASE WHEN paid=1 THEN 1 ELSE 0 END) AS paid_count,
      COALESCE(SUM(CASE WHEN paid=1 THEN entry_fee_cents ELSE 0 END),0) AS paid_total_cents,
      SUM(CASE WHEN status='no_show' THEN 1 ELSE 0 END) AS no_show_count,
      SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled_count
    FROM community_event_attendees
    WHERE event_id = ?
  `).get(eventId) || {};
}

function serializeCommunityEventRow(row, includeStats = true) {
  if (!row) return null;
  const stats = includeStats ? communityEventStats(row.id) : {};
  return {
    id: row.id,
    title: row.title || "",
    game: row.game || "",
    event_type: row.event_type || "",
    eventType: row.event_type || "",
    status: row.status || "scheduled",
    starts_at: row.starts_at || "",
    startsAt: row.starts_at || "",
    ends_at: row.ends_at || "",
    endsAt: row.ends_at || "",
    capacity: Number(row.capacity || 0),
    entry_fee_cents: Number(row.entry_fee_cents || 0),
    entryFee: toDollars(row.entry_fee_cents),
    prize_pool_cents: Number(row.prize_pool_cents || 0),
    prizePool: toDollars(row.prize_pool_cents),
    prize_notes: row.prize_notes || "",
    prizeNotes: row.prize_notes || "",
    description: row.description || "",
    created_by: row.created_by || null,
    updated_by: row.updated_by || null,
    created_at: row.created_at || "",
    createdAt: row.created_at || "",
    updated_at: row.updated_at || "",
    updatedAt: row.updated_at || "",
    completed_at: row.completed_at || "",
    completedAt: row.completed_at || "",
    stats: {
      attendee_count: Number(stats.attendee_count || 0),
      active_count: Number(stats.active_count || 0),
      checked_in_count: Number(stats.checked_in_count || 0),
      paid_count: Number(stats.paid_count || 0),
      paid_total_cents: Number(stats.paid_total_cents || 0),
      paid_total: toDollars(stats.paid_total_cents),
      no_show_count: Number(stats.no_show_count || 0),
      cancelled_count: Number(stats.cancelled_count || 0)
    }
  };
}

function serializeCommunityAttendeeRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    event_id: row.event_id,
    eventId: row.event_id,
    customer_id: row.customer_id || null,
    customerId: row.customer_id || null,
    name: row.name || "",
    phone: row.phone || "",
    email: row.email || "",
    status: row.status || "reserved",
    paid: Number(row.paid || 0) === 1,
    entry_fee_cents: Number(row.entry_fee_cents || 0),
    entryFee: toDollars(row.entry_fee_cents),
    payment_method: row.payment_method || "",
    paymentMethod: row.payment_method || "",
    notes: row.notes || "",
    created_at: row.created_at || "",
    createdAt: row.created_at || "",
    updated_at: row.updated_at || "",
    updatedAt: row.updated_at || "",
    checked_in_at: row.checked_in_at || "",
    checkedInAt: row.checked_in_at || ""
  };
}

const COMMUNITY_TICKET_SOURCE_PREFIX = "community-event-ticket:";

function communityTicketScanCode(attendeeId) {
  return `CE:${String(attendeeId || "").trim()}`;
}

function communityTicketHumanCode(attendeeId) {
  const id = String(attendeeId || "").replace(/[^a-z0-9]/gi, "");
  if (!id) return "CE-UNKNOWN";
  return `CE-${id.slice(0, 8).toUpperCase()}-${id.slice(-4).toUpperCase()}`;
}

function communityTicketAttendeeIdFromBarcode(barcode) {
  const raw = String(barcode || "").trim();
  return /^CE:/i.test(raw) ? raw.slice(3).trim() : "";
}

function communityTicketSource(eventId) {
  return `${COMMUNITY_TICKET_SOURCE_PREFIX}${String(eventId || "").trim()}`;
}

function communityTicketSku(eventId, seatNumber) {
  const eventKey = String(eventId || "").replace(/[^a-z0-9]/gi, "").slice(0, 8).toUpperCase() || "EVENT";
  return `CE-${eventKey}-${String(seatNumber).padStart(3, "0")}`;
}

function appendCommunityTicketNote(existing, note) {
  const current = cleanText(existing || "", 850);
  const next = current ? `${current}\n${note}` : note;
  return cleanText(next, 1000);
}

function communityTicketItemFromSaleLine(line) {
  if (line?.barcode) return line;
  if (line?.item_id) {
    const row = db.prepare(`SELECT * FROM items WHERE id=?`).get(line.item_id);
    if (row) return row;
  }
  if (line?.sku) {
    const row = db.prepare(`SELECT * FROM items WHERE sku=?`).get(line.sku);
    if (row) return row;
  }
  return null;
}

function applyCommunityTicketSaleLine(line, { saleId, paymentMethod, userId, username, customerName, customerPhone } = {}) {
  const item = communityTicketItemFromSaleLine(line);
  const attendeeId = communityTicketAttendeeIdFromBarcode(item?.barcode);
  if (!attendeeId || Number(line?.qty || 0) < 1) return null;

  const attendee = db.prepare(`
    SELECT a.*, e.title AS event_title
    FROM community_event_attendees a
    JOIN community_events e ON e.id = a.event_id
    WHERE a.id=?
  `).get(attendeeId);
  if (!attendee) return null;

  const now = new Date().toISOString();
  const placeholderName = /\[POS_TICKET\]/i.test(String(attendee.notes || "")) || /^.+\s+\d+$/i.test(String(attendee.name || "").trim());
  const nextName = placeholderName && customerName ? cleanText(customerName, 160) : attendee.name;
  const nextPhone = !attendee.phone && customerPhone ? cleanText(customerPhone, 60) : attendee.phone;
  const salePriceCents = Math.max(0, toCents(line?.unit_price ?? item?.price ?? 0));
  const nextNotes = appendCommunityTicketNote(attendee.notes, `Sold in POS sale #${saleId}.`);

  db.prepare(`
    UPDATE community_event_attendees
    SET name=@name,
        phone=@phone,
        paid=1,
        payment_method=@payment_method,
        entry_fee_cents=@entry_fee_cents,
        notes=@notes,
        updated_at=@updated_at
    WHERE id=@id
  `).run({
    id: attendeeId,
    name: nextName,
    phone: nextPhone || null,
    payment_method: cleanText(paymentMethod || "pos", 60),
    entry_fee_cents: salePriceCents || Number(attendee.entry_fee_cents || 0),
    notes: nextNotes,
    updated_at: now
  });
  db.prepare(`UPDATE community_events SET updated_at=?, updated_by=? WHERE id=?`).run(now, userId || null, attendee.event_id);

  logUserAction({
    userId: String(userId || ""),
    username: username || "",
    action: "community_event_ticket_sold",
    screen: "pos",
    metadata: { eventId: attendee.event_id, attendeeId, saleId, sku: item?.sku || line?.sku || "" }
  });
  return attendeeId;
}

function reverseCommunityTicketSaleLine(line, { saleId, refundId, userId, username, reason = "reversed" } = {}) {
  const item = communityTicketItemFromSaleLine(line);
  const attendeeId = communityTicketAttendeeIdFromBarcode(item?.barcode);
  if (!attendeeId || Number(line?.qty || 0) < 1) return null;

  const attendee = db.prepare(`SELECT * FROM community_event_attendees WHERE id=?`).get(attendeeId);
  if (!attendee) return null;
  const now = new Date().toISOString();
  const nextNotes = appendCommunityTicketNote(
    attendee.notes,
    `${reason === "refund" ? "Refunded" : "Voided"} from POS sale #${saleId}${refundId ? ` / refund #${refundId}` : ""}.`
  );

  db.prepare(`
    UPDATE community_event_attendees
    SET paid=0,
        payment_method='',
        notes=@notes,
        updated_at=@updated_at
    WHERE id=@id
  `).run({ id: attendeeId, notes: nextNotes, updated_at: now });
  db.prepare(`UPDATE community_events SET updated_at=?, updated_by=? WHERE id=?`).run(now, userId || null, attendee.event_id);

  logUserAction({
    userId: String(userId || ""),
    username: username || "",
    action: reason === "refund" ? "community_event_ticket_refunded" : "community_event_ticket_voided",
    screen: "pos",
    metadata: { eventId: attendee.event_id, attendeeId, saleId, refundId: refundId || null, sku: item?.sku || line?.sku || "" }
  });
  return attendeeId;
}

app.get("/api/held-sales", requireAuth, (_req, res) => {
  try {
    const rows = db.prepare(`
      SELECT *
      FROM held_sales
      ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
      LIMIT 100
    `).all();
    res.json({ ok: true, rows: rows.map(serializeHeldSaleRow) });
  } catch (err) {
    console.error("[API] /api/held-sales failed:", err);
    res.status(500).json({ ok: false, error: "held_sales_failed" });
  }
});

app.post("/api/held-sales", requireAuth, requirePerm("checkout"), (req, res) => {
  try {
    const body = req.body || {};
    const id = String(body.id || uuidv4()).trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    const now = new Date().toISOString();
    const payload = {
      ...body,
      id,
      updatedAt: body.updatedAt || now,
      createdAt: body.createdAt || now
    };
    db.prepare(`
      INSERT INTO held_sales (id, label, payload_json, user_id, created_at, updated_at)
      VALUES (@id, @label, @payload_json, @user_id, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        label=excluded.label,
        payload_json=excluded.payload_json,
        user_id=excluded.user_id,
        updated_at=excluded.updated_at
    `).run({
      id,
      label: String(payload.label || "Held Sale"),
      payload_json: JSON.stringify(payload),
      user_id: req.user.id,
      created_at: payload.createdAt,
      updated_at: payload.updatedAt
    });
    const row = db.prepare(`SELECT * FROM held_sales WHERE id=?`).get(id);
    res.json({ ok: true, held: serializeHeldSaleRow(row) });
  } catch (err) {
    console.error("[API] /api/held-sales save failed:", err);
    res.status(500).json({ ok: false, error: "held_sale_save_failed" });
  }
});

app.delete("/api/held-sales/:id", requireAuth, requirePerm("checkout"), (req, res) => {
  try {
    db.prepare(`DELETE FROM held_sales WHERE id=?`).run(String(req.params.id || ""));
    res.json({ ok: true });
  } catch (err) {
    console.error("[API] /api/held-sales delete failed:", err);
    res.status(500).json({ ok: false, error: "held_sale_delete_failed" });
  }
});

app.get("/api/live-events", requireAuth, (_req, res) => {
  try {
    const rows = db.prepare(`
      SELECT *
      FROM live_events
      ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
      LIMIT 500
    `).all();
    res.json({ ok: true, rows: rows.map(serializeLiveEventRow) });
  } catch (err) {
    console.error("[API] /api/live-events failed:", err);
    res.status(500).json({ ok: false, error: "live_events_failed" });
  }
});

app.post("/api/live-events", requireAuth, requirePerm("checkout"), (req, res) => {
  try {
    const body = req.body || {};
    const id = String(body.id || uuidv4()).trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
    const now = new Date().toISOString();
    const status = ["draft", "finalized", "voided"].includes(String(body.status || "draft")) ? String(body.status || "draft") : "draft";
    const payload = {
      ...body,
      id,
      status,
      updatedAt: body.updatedAt || now,
      createdAt: body.createdAt || now
    };
    db.prepare(`
      INSERT INTO live_events
        (id, name, channel, status, payload_json, backend_sale_id, user_id, created_at, updated_at, finalized_at)
      VALUES
        (@id, @name, @channel, @status, @payload_json, @backend_sale_id, @user_id, @created_at, @updated_at, @finalized_at)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        channel=excluded.channel,
        status=excluded.status,
        payload_json=excluded.payload_json,
        backend_sale_id=excluded.backend_sale_id,
        user_id=excluded.user_id,
        updated_at=excluded.updated_at,
        finalized_at=excluded.finalized_at
    `).run({
      id,
      name: String(payload.name || ""),
      channel: String(payload.channel || "other"),
      status,
      payload_json: JSON.stringify(payload),
      backend_sale_id: Number(payload.backendSaleId || 0) || null,
      user_id: req.user.id,
      created_at: payload.createdAt,
      updated_at: payload.updatedAt,
      finalized_at: payload.finalizedAt || null
    });
    const row = db.prepare(`SELECT * FROM live_events WHERE id=?`).get(id);
    res.json({ ok: true, event: serializeLiveEventRow(row) });
  } catch (err) {
    console.error("[API] /api/live-events save failed:", err);
    res.status(500).json({ ok: false, error: "live_event_save_failed" });
  }
});

app.delete("/api/live-events", requireAuth, requirePerm("checkout"), (_req, res) => {
  try {
    db.prepare(`DELETE FROM live_events`).run();
    res.json({ ok: true });
  } catch (err) {
    console.error("[API] /api/live-events clear failed:", err);
    res.status(500).json({ ok: false, error: "live_events_clear_failed" });
  }
});

app.delete("/api/live-events/:id", requireAuth, requirePerm("checkout"), (req, res) => {
  try {
    db.prepare(`DELETE FROM live_events WHERE id=?`).run(String(req.params.id || ""));
    res.json({ ok: true });
  } catch (err) {
    console.error("[API] /api/live-events delete failed:", err);
    res.status(500).json({ ok: false, error: "live_event_delete_failed" });
  }
});

app.get("/api/community-events", requireAuth, (_req, res) => {
  try {
    const rows = db.prepare(`
      SELECT *
      FROM community_events
      ORDER BY
        CASE status
          WHEN 'check_in' THEN 0
          WHEN 'live' THEN 1
          WHEN 'scheduled' THEN 2
          WHEN 'completed' THEN 3
          ELSE 4
        END,
        datetime(COALESCE(starts_at, updated_at)) ASC,
        datetime(updated_at) DESC
      LIMIT 500
    `).all();
    res.json({ ok: true, rows: rows.map((row) => serializeCommunityEventRow(row)) });
  } catch (err) {
    console.error("[API] /api/community-events failed:", err);
    res.status(500).json({ ok: false, error: "community_events_failed" });
  }
});

app.post("/api/community-events", requireAuth, requirePerm("checkout"), (req, res) => {
  try {
    const body = req.body || {};
    const title = cleanText(body.title || body.name, 160);
    if (!title) return res.status(400).json({ ok: false, error: "missing_title" });

    const now = new Date().toISOString();
    const id = cleanText(body.id || uuidv4(), 80);
    const status = normalizeCommunityEventStatus(body.status);
    db.prepare(`
      INSERT INTO community_events
        (id, title, game, event_type, status, starts_at, ends_at, capacity,
         entry_fee_cents, prize_pool_cents, prize_notes, description,
         created_by, updated_by, created_at, updated_at, completed_at)
      VALUES
        (@id, @title, @game, @event_type, @status, @starts_at, @ends_at, @capacity,
         @entry_fee_cents, @prize_pool_cents, @prize_notes, @description,
         @created_by, @updated_by, @created_at, @updated_at, @completed_at)
    `).run({
      id,
      title,
      game: cleanText(body.game, 80),
      event_type: cleanText(body.event_type || body.eventType || "Tournament", 80),
      status,
      starts_at: cleanText(body.starts_at || body.startsAt, 40),
      ends_at: cleanText(body.ends_at || body.endsAt, 40),
      capacity: Math.max(0, Math.floor(Number(body.capacity || 0))),
      entry_fee_cents: Math.max(0, readMoneyCents(body, "entry_fee_cents", "entryFee")),
      prize_pool_cents: Math.max(0, readMoneyCents(body, "prize_pool_cents", "prizePool")),
      prize_notes: cleanText(body.prize_notes || body.prizeNotes, 1000),
      description: cleanText(body.description, 2000),
      created_by: req.user.id,
      updated_by: req.user.id,
      created_at: now,
      updated_at: now,
      completed_at: status === "completed" ? now : null
    });
    const row = db.prepare(`SELECT * FROM community_events WHERE id=?`).get(id);
    logUserAction({ userId: req.user.id, username: req.user.username, action: "community_event_created", screen: "community-events", metadata: { id, title } });
    res.json({ ok: true, event: serializeCommunityEventRow(row) });
  } catch (err) {
    console.error("[API] /api/community-events save failed:", err);
    res.status(500).json({ ok: false, error: "community_event_save_failed" });
  }
});

app.get("/api/community-events/:id", requireAuth, (req, res) => {
  try {
    const id = String(req.params.id || "");
    const row = db.prepare(`SELECT * FROM community_events WHERE id=?`).get(id);
    if (!row) return res.status(404).json({ ok: false, error: "event_not_found" });
    const attendees = db.prepare(`
      SELECT *
      FROM community_event_attendees
      WHERE event_id=?
      ORDER BY
        CASE status WHEN 'checked_in' THEN 0 WHEN 'reserved' THEN 1 WHEN 'no_show' THEN 2 ELSE 3 END,
        lower(name) ASC
    `).all(id);
    res.json({
      ok: true,
      event: serializeCommunityEventRow(row),
      attendees: attendees.map(serializeCommunityAttendeeRow)
    });
  } catch (err) {
    console.error("[API] /api/community-events/:id failed:", err);
    res.status(500).json({ ok: false, error: "community_event_failed" });
  }
});

app.put("/api/community-events/:id", requireAuth, requirePerm("checkout"), (req, res) => {
  try {
    const id = String(req.params.id || "");
    const existing = db.prepare(`SELECT * FROM community_events WHERE id=?`).get(id);
    if (!existing) return res.status(404).json({ ok: false, error: "event_not_found" });

    const body = req.body || {};
    const status = body.status !== undefined ? normalizeCommunityEventStatus(body.status) : existing.status;
    const now = new Date().toISOString();
    const completedAt = status === "completed"
      ? (existing.completed_at || now)
      : (status === "cancelled" ? existing.completed_at : null);

    const next = {
      id,
      title: body.title !== undefined ? cleanText(body.title, 160) : existing.title,
      game: body.game !== undefined ? cleanText(body.game, 80) : existing.game,
      event_type: body.event_type !== undefined || body.eventType !== undefined ? cleanText(body.event_type || body.eventType, 80) : existing.event_type,
      status,
      starts_at: body.starts_at !== undefined || body.startsAt !== undefined ? cleanText(body.starts_at || body.startsAt, 40) : existing.starts_at,
      ends_at: body.ends_at !== undefined || body.endsAt !== undefined ? cleanText(body.ends_at || body.endsAt, 40) : existing.ends_at,
      capacity: body.capacity !== undefined ? Math.max(0, Math.floor(Number(body.capacity || 0))) : existing.capacity,
      entry_fee_cents: body.entry_fee_cents !== undefined || body.entryFee !== undefined ? Math.max(0, readMoneyCents(body, "entry_fee_cents", "entryFee")) : existing.entry_fee_cents,
      prize_pool_cents: body.prize_pool_cents !== undefined || body.prizePool !== undefined ? Math.max(0, readMoneyCents(body, "prize_pool_cents", "prizePool")) : existing.prize_pool_cents,
      prize_notes: body.prize_notes !== undefined || body.prizeNotes !== undefined ? cleanText(body.prize_notes || body.prizeNotes, 1000) : existing.prize_notes,
      description: body.description !== undefined ? cleanText(body.description, 2000) : existing.description,
      updated_by: req.user.id,
      updated_at: now,
      completed_at: completedAt
    };

    if (!next.title) return res.status(400).json({ ok: false, error: "missing_title" });

    db.prepare(`
      UPDATE community_events
      SET title=@title, game=@game, event_type=@event_type, status=@status,
          starts_at=@starts_at, ends_at=@ends_at, capacity=@capacity,
          entry_fee_cents=@entry_fee_cents, prize_pool_cents=@prize_pool_cents,
          prize_notes=@prize_notes, description=@description,
          updated_by=@updated_by, updated_at=@updated_at, completed_at=@completed_at
      WHERE id=@id
    `).run(next);

    const row = db.prepare(`SELECT * FROM community_events WHERE id=?`).get(id);
    logUserAction({ userId: req.user.id, username: req.user.username, action: "community_event_updated", screen: "community-events", metadata: { id, status } });
    res.json({ ok: true, event: serializeCommunityEventRow(row) });
  } catch (err) {
    console.error("[API] /api/community-events update failed:", err);
    res.status(500).json({ ok: false, error: "community_event_update_failed" });
  }
});

app.delete("/api/community-events/:id", requireAuth, requireRole("manager", "owner"), (req, res) => {
  try {
    const id = String(req.params.id || "");
    db.prepare(`DELETE FROM community_events WHERE id=?`).run(id);
    logUserAction({ userId: req.user.id, username: req.user.username, action: "community_event_deleted", screen: "community-events", metadata: { id } });
    res.json({ ok: true });
  } catch (err) {
    console.error("[API] /api/community-events delete failed:", err);
    res.status(500).json({ ok: false, error: "community_event_delete_failed" });
  }
});

app.post("/api/community-events/:id/attendees", requireAuth, requirePerm("checkout"), (req, res) => {
  try {
    const eventId = String(req.params.id || "");
    const event = db.prepare(`SELECT * FROM community_events WHERE id=?`).get(eventId);
    if (!event) return res.status(404).json({ ok: false, error: "event_not_found" });

    const body = req.body || {};
    const customerId = Number(body.customer_id || body.customerId || 0) || null;
    const customer = customerId ? db.prepare(`SELECT * FROM customers WHERE id=?`).get(customerId) : null;
    const name = cleanText(body.name || customer?.name, 160);
    if (!name) return res.status(400).json({ ok: false, error: "missing_attendee_name" });

    const status = normalizeCommunityAttendeeStatus(body.status);
    if (["reserved", "checked_in"].includes(status) && Number(event.capacity || 0) > 0) {
      const active = Number(communityEventStats(eventId).active_count || 0);
      if (active >= Number(event.capacity || 0)) {
        return res.status(409).json({ ok: false, error: "event_full" });
      }
    }

    const now = new Date().toISOString();
    const id = cleanText(body.id || uuidv4(), 80);
    db.prepare(`
      INSERT INTO community_event_attendees
        (id, event_id, customer_id, name, phone, email, status, paid,
         entry_fee_cents, payment_method, notes, created_at, updated_at, checked_in_at)
      VALUES
        (@id, @event_id, @customer_id, @name, @phone, @email, @status, @paid,
         @entry_fee_cents, @payment_method, @notes, @created_at, @updated_at, @checked_in_at)
    `).run({
      id,
      event_id: eventId,
      customer_id: customerId,
      name,
      phone: cleanText(body.phone || customer?.phone, 60),
      email: cleanText(body.email || customer?.email, 160),
      status,
      paid: toBoolInt(body.paid),
      entry_fee_cents: body.entry_fee_cents !== undefined || body.entryFee !== undefined
        ? Math.max(0, readMoneyCents(body, "entry_fee_cents", "entryFee"))
        : Number(event.entry_fee_cents || 0),
      payment_method: cleanText(body.payment_method || body.paymentMethod, 60),
      notes: cleanText(body.notes, 1000),
      created_at: now,
      updated_at: now,
      checked_in_at: status === "checked_in" ? now : null
    });
    db.prepare(`UPDATE community_events SET updated_at=?, updated_by=? WHERE id=?`).run(now, req.user.id, eventId);
    const row = db.prepare(`SELECT * FROM community_event_attendees WHERE id=?`).get(id);
    logUserAction({ userId: req.user.id, username: req.user.username, action: "community_event_attendee_added", screen: "community-events", metadata: { eventId, id } });
    res.json({ ok: true, attendee: serializeCommunityAttendeeRow(row), event: serializeCommunityEventRow(db.prepare(`SELECT * FROM community_events WHERE id=?`).get(eventId)) });
  } catch (err) {
    console.error("[API] /api/community-events attendee save failed:", err);
    res.status(500).json({ ok: false, error: "community_attendee_save_failed" });
  }
});

app.put("/api/community-events/:eventId/attendees/:attendeeId", requireAuth, requirePerm("checkout"), (req, res) => {
  try {
    const eventId = String(req.params.eventId || "");
    const attendeeId = String(req.params.attendeeId || "");
    const event = db.prepare(`SELECT * FROM community_events WHERE id=?`).get(eventId);
    if (!event) return res.status(404).json({ ok: false, error: "event_not_found" });
    const existing = db.prepare(`SELECT * FROM community_event_attendees WHERE id=? AND event_id=?`).get(attendeeId, eventId);
    if (!existing) return res.status(404).json({ ok: false, error: "attendee_not_found" });

    const body = req.body || {};
    const status = body.status !== undefined ? normalizeCommunityAttendeeStatus(body.status) : existing.status;
    const movingIntoActive = ["cancelled", "no_show"].includes(existing.status) && ["reserved", "checked_in"].includes(status);
    if (movingIntoActive && Number(event.capacity || 0) > 0) {
      const active = Number(communityEventStats(eventId).active_count || 0);
      if (active >= Number(event.capacity || 0)) {
        return res.status(409).json({ ok: false, error: "event_full" });
      }
    }

    const now = new Date().toISOString();
    const next = {
      id: attendeeId,
      event_id: eventId,
      customer_id: body.customer_id !== undefined || body.customerId !== undefined ? (Number(body.customer_id || body.customerId || 0) || null) : existing.customer_id,
      name: body.name !== undefined ? cleanText(body.name, 160) : existing.name,
      phone: body.phone !== undefined ? cleanText(body.phone, 60) : existing.phone,
      email: body.email !== undefined ? cleanText(body.email, 160) : existing.email,
      status,
      paid: body.paid !== undefined ? toBoolInt(body.paid) : Number(existing.paid || 0),
      entry_fee_cents: body.entry_fee_cents !== undefined || body.entryFee !== undefined ? Math.max(0, readMoneyCents(body, "entry_fee_cents", "entryFee")) : existing.entry_fee_cents,
      payment_method: body.payment_method !== undefined || body.paymentMethod !== undefined ? cleanText(body.payment_method || body.paymentMethod, 60) : existing.payment_method,
      notes: body.notes !== undefined ? cleanText(body.notes, 1000) : existing.notes,
      updated_at: now,
      checked_in_at: status === "checked_in" ? (existing.checked_in_at || now) : (status === "reserved" ? null : existing.checked_in_at)
    };
    if (!next.name) return res.status(400).json({ ok: false, error: "missing_attendee_name" });

    db.prepare(`
      UPDATE community_event_attendees
      SET customer_id=@customer_id, name=@name, phone=@phone, email=@email, status=@status,
          paid=@paid, entry_fee_cents=@entry_fee_cents, payment_method=@payment_method,
          notes=@notes, updated_at=@updated_at, checked_in_at=@checked_in_at
      WHERE id=@id AND event_id=@event_id
    `).run(next);
    db.prepare(`UPDATE community_events SET updated_at=?, updated_by=? WHERE id=?`).run(now, req.user.id, eventId);
    const row = db.prepare(`SELECT * FROM community_event_attendees WHERE id=?`).get(attendeeId);
    logUserAction({ userId: req.user.id, username: req.user.username, action: "community_event_attendee_updated", screen: "community-events", metadata: { eventId, attendeeId, status } });
    res.json({ ok: true, attendee: serializeCommunityAttendeeRow(row), event: serializeCommunityEventRow(db.prepare(`SELECT * FROM community_events WHERE id=?`).get(eventId)) });
  } catch (err) {
    console.error("[API] /api/community-events attendee update failed:", err);
    res.status(500).json({ ok: false, error: "community_attendee_update_failed" });
  }
});

app.delete("/api/community-events/:eventId/attendees/:attendeeId", requireAuth, requirePerm("checkout"), (req, res) => {
  try {
    const eventId = String(req.params.eventId || "");
    const attendeeId = String(req.params.attendeeId || "");
    db.prepare(`DELETE FROM community_event_attendees WHERE id=? AND event_id=?`).run(attendeeId, eventId);
    db.prepare(`UPDATE community_events SET updated_at=?, updated_by=? WHERE id=?`).run(new Date().toISOString(), req.user.id, eventId);
    logUserAction({ userId: req.user.id, username: req.user.username, action: "community_event_attendee_deleted", screen: "community-events", metadata: { eventId, attendeeId } });
    res.json({ ok: true });
  } catch (err) {
    console.error("[API] /api/community-events attendee delete failed:", err);
    res.status(500).json({ ok: false, error: "community_attendee_delete_failed" });
  }
});

app.post("/api/community-events/:id/tickets/generate", requireAuth, requirePerm("checkout"), (req, res) => {
  try {
    const eventId = String(req.params.id || "");
    const event = db.prepare(`SELECT * FROM community_events WHERE id=?`).get(eventId);
    if (!event) return res.status(404).json({ ok: false, error: "event_not_found" });

    const stats = communityEventStats(eventId);
    const capacity = Math.max(0, Math.floor(Number(event.capacity || 0)));
    const requested = Math.max(0, Math.floor(Number(req.body?.count || 0)));
    const ticketKind = String(req.body?.kind || req.body?.mode || "pos").toLowerCase() === "generic" ? "generic" : "pos";
    const createPosItems = ticketKind === "pos";
    const ticketLabel = cleanText(req.body?.label || req.body?.ticketLabel || "Ticket", 40) || "Ticket";
    const active = Number(stats.active_count || 0);
    const openSpots = capacity > 0 ? Math.max(0, capacity - active) : requested;
    const toCreate = requested > 0 ? Math.min(requested, openSpots) : openSpots;
    if (toCreate <= 0) {
      return res.status(409).json({ ok: false, error: capacity > 0 ? "event_full" : "missing_ticket_count" });
    }

    const now = new Date().toISOString();
    const ticketCount = Number(db.prepare(`
      SELECT COUNT(*) AS c
      FROM community_event_attendees
      WHERE event_id=? AND (notes LIKE '%[POS_TICKET]%' OR notes LIKE '%[GENERIC_TICKET]%')
    `).get(eventId)?.c || 0);
    const entryFee = toDollars(event.entry_fee_cents);
    const created = [];

    const tx = db.transaction(() => {
      const insertAttendee = db.prepare(`
        INSERT INTO community_event_attendees
          (id, event_id, customer_id, name, phone, email, status, paid,
           entry_fee_cents, payment_method, notes, created_at, updated_at, checked_in_at)
        VALUES
          (@id, @event_id, null, @name, null, null, 'reserved', 0,
           @entry_fee_cents, '', @notes, @created_at, @updated_at, null)
      `);
      const insertItem = db.prepare(`
        INSERT INTO items
          (sku, title, platform, category, condition, variant, qty, cost, price, createdAt, barcode, source, deleted_at, deleted_reason)
        VALUES
          (@sku, @title, @platform, @category, @condition, @variant, 1, 0, @price, @createdAt, @barcode, @source, null, null)
      `);

      for (let i = 0; i < toCreate; i += 1) {
        const seatNumber = ticketCount + i + 1;
        const attendeeId = uuidv4();
        const name = `${ticketLabel} ${String(seatNumber).padStart(3, "0")}`;
        const marker = createPosItems ? "POS_TICKET" : "GENERIC_TICKET";
        const notes = createPosItems
          ? `[${marker}] ${communityTicketHumanCode(attendeeId)}. Sell this ticket in POS, then scan it at check-in.`
          : `[${marker}] ${communityTicketHumanCode(attendeeId)}. Printed generic event ticket.`;
        insertAttendee.run({
          id: attendeeId,
          event_id: eventId,
          name,
          entry_fee_cents: Number(event.entry_fee_cents || 0),
          notes,
          created_at: now,
          updated_at: now
        });

        let item = null;
        if (createPosItems) {
          let sku = communityTicketSku(eventId, seatNumber);
          if (db.prepare(`SELECT id FROM items WHERE sku=?`).get(sku)) {
            sku = `${sku}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
          }
          insertItem.run({
            sku,
            title: `${event.title} - ${name}`,
            platform: event.game || "Community Event",
            category: "Event Tickets",
            condition: "New",
            variant: "EVENT_TICKET",
            price: entryFee,
            createdAt: now,
            barcode: communityTicketScanCode(attendeeId),
            source: communityTicketSource(eventId)
          });
          item = db.prepare(`SELECT * FROM items WHERE sku=?`).get(sku);
          if (item?.id) {
            setInventoryBucketQty(item.id, "sellable", "store", 1);
            syncItemQtyFromBuckets(item.id);
            item = db.prepare(`SELECT * FROM items WHERE id=?`).get(item.id);
          }
        }
        const attendee = db.prepare(`SELECT * FROM community_event_attendees WHERE id=?`).get(attendeeId);
        created.push({
          attendee: serializeCommunityAttendeeRow(attendee),
          item,
          kind: ticketKind,
          code: communityTicketHumanCode(attendeeId),
          scanCode: communityTicketScanCode(attendeeId)
        });
      }

      db.prepare(`UPDATE community_events SET updated_at=?, updated_by=? WHERE id=?`).run(now, req.user.id, eventId);
    });

    tx();
    logUserAction({
      userId: String(req.user.id || ""),
      username: req.user.username || "",
      action: "community_event_tickets_generated",
      screen: "community-events",
      metadata: { eventId, count: created.length, kind: ticketKind, label: ticketLabel }
    });
    const row = db.prepare(`SELECT * FROM community_events WHERE id=?`).get(eventId);
    res.json({ ok: true, created, event: serializeCommunityEventRow(row) });
  } catch (err) {
    console.error("[API] /api/community-events tickets generate failed:", err);
    res.status(500).json({ ok: false, error: "community_tickets_generate_failed" });
  }
});

// Upsert items
app.post("/api/items", requireAuth, requirePerm("inv_add"), (req, res) => {
  try {
    let {
      title,
      platform = "",
      category = "",
      condition,
      qty = 1,
      cost = 0,
      price = 0,
      overridePrice = false,
      forceNewGroup = false,
      barcode,
      source = null
    } = req.body || {};

    if (!title || !condition) {
      return res.status(400).json({ error: "Missing required fields (title, condition)" });
    }

    title = String(title).trim();
    platform = String(platform || "").trim();
    category = normalizeCategory(category);
    condition = String(condition || "Used").trim();
    qty = Math.max(1, Number(qty || 1));
    cost = Number(cost || 0);
    price = Number(price || 0);
    barcode = barcode != null ? String(barcode).trim() : "";

    const baseSku = skuFromInputs({ title, platform, category, condition });
    const now = new Date().toISOString();

    if (overridePrice && !(req.user?.permissions && req.user.permissions.cost_change)) {
      return res.status(403).json({ ok: false, error: "permission_denied_cost_change" });
    }

    const tx = db.transaction(() => {
      let sku = baseSku;
      const externalBarcode = barcode || null;

      const existing = db.prepare(`SELECT * FROM items WHERE sku=?`).get(sku);

      if (forceNewGroup) {
        const suffix = "-" + crypto.randomBytes(2).toString("hex").toUpperCase();
        sku = `${baseSku}${suffix}`;

        db.prepare(
          `
                INSERT INTO items (sku,title,platform,category,condition,variant,qty,cost,price,createdAt,barcode,source)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        `
        ).run(sku, title, platform, category, condition, "UNLINKED", qty, cost, price, now, externalBarcode, source || null);

        const row = db.prepare(`SELECT * FROM items WHERE sku=? AND deleted_at IS NULL`).get(sku);
        if (row?.id) {
          setInventoryBucketQty(row.id, "sellable", "store", qty);
          syncItemQtyFromBuckets(row.id);
        }
        if (cost > 0 && qty > 0) {
          insertExpense({
            expense_date: now,
            type: "inventory",
            category: "Inventory",
            vendor: source || null,
            memo: `Inventory intake: ${title}${platform ? " - " + platform : ""}`,
            amount: Number((cost * qty).toFixed(2)),
            tax_amount: 0,
            payment_method: null,
            source: "add-item",
            item_id: row?.id || null,
            sku: row?.sku || sku,
            title: row?.title || title,
            qty,
            unit_cost: cost,
            user_id: req.user?.id || null
          });
        }
        return { created: true, grouped: false, priceOverridden: false, item: row?.id ? db.prepare(`SELECT * FROM items WHERE id=?`).get(row.id) : row };
      }

      if (!existing) {
        db.prepare(
          `
          INSERT INTO items (sku,title,platform,category,condition,variant,qty,cost,price,createdAt,barcode,source)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        `
        ).run(sku, title, platform, category, condition, "", qty, cost, price, now, externalBarcode, source || null);

        const row = db.prepare(`SELECT * FROM items WHERE sku=?`).get(sku);
        if (row?.id) {
          setInventoryBucketQty(row.id, "sellable", "store", qty);
          syncItemQtyFromBuckets(row.id);
        }
        if (cost > 0 && qty > 0) {
          insertExpense({
            expense_date: now,
            type: "inventory",
            category: "Inventory",
            vendor: source || null,
            memo: `Inventory intake: ${title}${platform ? " - " + platform : ""}`,
            amount: Number((cost * qty).toFixed(2)),
            tax_amount: 0,
            payment_method: null,
            source: "add-item",
            item_id: row?.id || null,
            sku: row?.sku || sku,
            title: row?.title || title,
            qty,
            unit_cost: cost,
            user_id: req.user?.id || null
          });
        }
        return { created: true, grouped: true, priceOverridden: false, item: row?.id ? db.prepare(`SELECT * FROM items WHERE id=?`).get(row.id) : row };
      }

      const currentPrice = Number(existing.price || 0);
      const barcodeToPersist = externalBarcode || existing.barcode || null;

      if (overridePrice) {
        ensureItemBucketBaseline(existing);
        const newQty = existing.qty + qty;
        const newAvgCost = (existing.cost * existing.qty + cost * qty) / newQty;
        db.prepare(
          `
          UPDATE items
             SET price=?, qty=?, cost=?, barcode=?, deleted_at=NULL, deleted_reason=NULL
           WHERE sku=?
        `
        ).run(price, newQty, newAvgCost, barcodeToPersist, sku);
        changeInventoryBucketQty(existing, "sellable", "store", qty);
        const row = db.prepare(`SELECT * FROM items WHERE sku=?`).get(sku);
        if (cost > 0 && qty > 0) {
          insertExpense({
            expense_date: now,
            type: "inventory",
            category: "Inventory",
            vendor: source || null,
            memo: `Inventory intake: ${title}${platform ? " - " + platform : ""}`,
            amount: Number((cost * qty).toFixed(2)),
            tax_amount: 0,
            payment_method: null,
            source: "add-item",
            item_id: row?.id || null,
            sku: row?.sku || sku,
            title: row?.title || title,
            qty,
            unit_cost: cost,
            user_id: req.user?.id || null
          });
        }
        return { updated: true, grouped: true, priceOverridden: true, item: row };
      }

      ensureItemBucketBaseline(existing);
      const newQty = existing.qty + qty;
      const newAvgCost = (existing.cost * existing.qty + cost * qty) / newQty;
      db.prepare(
        `
        UPDATE items
           SET qty=?, cost=?, price=?, barcode=?, deleted_at=NULL, deleted_reason=NULL
         WHERE sku=?
      `
      ).run(newQty, newAvgCost, currentPrice, barcodeToPersist, sku);
      changeInventoryBucketQty(existing, "sellable", "store", qty);
      const row = db.prepare(`SELECT * FROM items WHERE sku=?`).get(sku);
      if (cost > 0 && qty > 0) {
        insertExpense({
          expense_date: now,
          type: "inventory",
          category: "Inventory",
          vendor: source || null,
          memo: `Inventory intake: ${title}${platform ? " - " + platform : ""}`,
          amount: Number((cost * qty).toFixed(2)),
          tax_amount: 0,
          payment_method: null,
          source: "add-item",
          item_id: row?.id || null,
          sku: row?.sku || sku,
          title: row?.title || title,
          qty,
          unit_cost: cost,
          user_id: req.user?.id || null
        });
      }
      return { updated: true, grouped: true, priceOverridden: false, item: row };
    });

    const result = tx();
    storeWorkflows?.refreshAllBundleAvailability?.();
    if (result?.item) result.item = addBucketFieldsToRows([result.item])[0];

    queueWixAutoItemSync(result?.item, "POST /api/items");

    res.json({ ok: true, ...result });
  } catch (e) {
    console.error("[API] insert/upsert error:", e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Items (get one by id) - needed by live-events finalize
app.get("/api/items/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ ok: false, error: "invalid_id" });
  }

  try {
    const row = db.prepare(`SELECT * FROM items WHERE id=?`).get(id);
    if (!row) return res.status(404).json({ ok: false, error: "not_found" });
    return res.json({ ok: true, item: addBucketFieldsToRows([row])[0] });
  } catch (e) {
    console.error("[API] get item by id failed:", e);
    return res.status(500).json({ ok: false, error: "db_error" });
  }
});

app.get("/api/inventory-buckets/statuses", requireAuth, (_req, res) => {
  res.json({ ok: true, statuses: INVENTORY_BUCKETS });
});

app.get("/api/items/:id/buckets", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ ok: false, error: "invalid_id" });
  }

  try {
    const item = db.prepare(`SELECT * FROM items WHERE id=?`).get(id);
    if (!item) return res.status(404).json({ ok: false, error: "not_found" });
    ensureItemBucketBaseline(item);
    const updated = db.prepare(`SELECT * FROM items WHERE id=?`).get(id);
    return res.json({
      ok: true,
      item: addBucketFieldsToRows([updated])[0],
      buckets: getInventoryBucketRows(id),
      statuses: INVENTORY_BUCKETS
    });
  } catch (e) {
    console.error("[API] get item buckets failed:", e);
    return res.status(500).json({ ok: false, error: "bucket_lookup_failed" });
  }
});

app.post("/api/items/:id/buckets/move", requireAuth, requirePerm("inv_edit"), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ ok: false, error: "invalid_id" });
  }

  try {
    const item = db.prepare(`SELECT * FROM items WHERE id=? AND deleted_at IS NULL`).get(id);
    if (!item) return res.status(404).json({ ok: false, error: "not_found" });

    const result = db.transaction(() => moveInventoryBucket(item, {
      ...req.body,
      reason: req.body?.reason || "manual_bucket_move",
      user_id: req.user?.id || null,
      note: String(req.body?.note || "").trim()
    }))();

    storeWorkflows?.refreshAllBundleAvailability?.();
    if (result?.item?.sku) queueWixAutoSkuSync(result.item.sku, "POST /api/items/:id/buckets/move");

    return res.json({
      ok: true,
      item: addBucketFieldsToRows([result.item])[0],
      buckets: result.buckets,
      statuses: INVENTORY_BUCKETS
    });
  } catch (e) {
    const msg = String(e.message || e);
    if (msg === "invalid_qty" || msg === "same_bucket") {
      return res.status(400).json({ ok: false, error: msg });
    }
    if (msg.startsWith("insufficient_bucket_qty:")) {
      const parts = msg.split(":");
      return res.status(409).json({
        ok: false,
        error: "insufficient_bucket_qty",
        sku: parts[1] || "",
        status: parts[2] || "",
        available: Number(parts[3] || 0),
        requested: Number(parts[4] || 0)
      });
    }
    console.error("[API] move item bucket failed:", e);
    return res.status(500).json({ ok: false, error: "bucket_move_failed" });
  }
});

app.put("/api/items/:id", requireAuth, requirePerm("inv_edit"), (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare(`SELECT * FROM items WHERE id=?`).get(id);
  if (!existing) return res.status(404).json({ error: "not found" });

  try {
    const wantsCostOrPriceChange =
      Object.prototype.hasOwnProperty.call(req.body || {}, "cost") ||
      Object.prototype.hasOwnProperty.call(req.body || {}, "price");
    if (wantsCostOrPriceChange && !(req.user?.permissions && req.user.permissions.cost_change)) {
      return res.status(403).json({ ok: false, error: "permission_denied_cost_change" });
    }

    const qtyProvided = Object.prototype.hasOwnProperty.call(req.body || {}, "qty");
    const requestedQty = Number.isFinite(+req.body.qty) ? inventoryQty(req.body.qty, 0) : inventoryQty(existing.qty, 0);
    const qtyDelta = qtyProvided ? requestedQty - inventoryQty(existing.qty, 0) : 0;
    const patch = {
      id,
      sku: req.body.sku ?? existing.sku,
      title: req.body.title ?? existing.title,
      platform: req.body.platform ?? existing.platform,
      category: normalizeCategory(req.body.category ?? existing.category),
      condition: req.body.condition ?? existing.condition,
      variant: req.body.variant ?? existing.variant,
      qty: requestedQty,
      cost: Number.isFinite(+req.body.cost) ? +req.body.cost : existing.cost ?? 0,
      price: Number.isFinite(+req.body.price) ? +req.body.price : existing.price ?? 0,
      barcode: req.body.barcode ?? existing.barcode,
      wix_product_id: req.body.wix_product_id ?? existing.wix_product_id
    };
    const item = db.transaction(() => {
      ensureItemBucketBaseline(existing);
      db.prepare(
        `
        UPDATE items
           SET sku=@sku,title=@title,platform=@platform,category=@category,condition=@condition,
               variant=@variant,qty=@qty,cost=@cost,price=@price,barcode=@barcode,
               wix_product_id=@wix_product_id
         WHERE id=@id
      `
      ).run(patch);
      if (qtyProvided && qtyDelta) {
        changeInventoryBucketQty(existing, "sellable", "store", qtyDelta);
        logInventoryMovement({
          item_id: id,
          sku: patch.sku,
          qty_delta: qtyDelta,
          reason: "manual_edit",
          user_id: req.user.id,
          note: "Quantity edit adjusted the sellable bucket."
        });
      }
      return db.prepare(`SELECT * FROM items WHERE id=?`).get(id);
    })();
    storeWorkflows?.refreshAllBundleAvailability?.();

    queueWixAutoItemSync(item, "PUT /api/items/:id");

    res.json({ item: addBucketFieldsToRows([item])[0] });
  } catch (e) {
    console.error("[API] update error:", e);
    const msg = String(e.message || e);
    if (msg.startsWith("insufficient_bucket_qty:")) {
      return res.status(409).json({ ok: false, error: "insufficient_bucket_qty" });
    }
    res.status(400).json({ error: e.message });
  }
});

// Attach local photos to Wix product for this item (manager+)
// Body: { filePaths: [ "C:\\path\\to\\file.jpg", ... ] }
app.post("/api/items/:id/wix-media", requireAuth, requirePerm("sync_admin"), async (req, res) => {
  if (!WIX_SYNC_ENABLED || !WIX_API_KEY || !WIX_SITE_ID) {
    return res.status(400).json({ ok: false, error: "wix_not_configured" });
  }

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ ok: false, error: "invalid_id" });
  }

  const item = db.prepare(`SELECT * FROM items WHERE id=?`).get(id);
  if (!item) return res.status(404).json({ ok: false, error: "not_found" });

  const filePaths = Array.isArray(req.body?.filePaths) ? req.body.filePaths : [];
  const cleaned = filePaths.map((p) => String(p || "").trim()).filter(Boolean);
  if (!cleaned.length) return res.status(400).json({ ok: false, error: "no_files" });
  if (cleaned.length > 10) return res.status(400).json({ ok: false, error: "too_many_files" });

  try {
    const missing = cleaned.find((p) => !fs.existsSync(p));
    if (missing) return res.status(400).json({ ok: false, error: "file_missing", path: missing });

    let productId = item.wix_product_id;
    if (!productId) {
      const found = await findWixProductBySku(item.sku || "");
      productId = found?.id || null;
    }
    if (!productId) {
      productId = await syncItemToWix(item);
    }
    if (!productId) {
      return res.status(500).json({ ok: false, error: "wix_product_missing" });
    }

    const mediaEntries = [];
    for (const p of cleaned) {
      try {
        const up = await uploadToWixMedia(p);
        if (up.fileId) mediaEntries.push({ id: up.fileId });
        else if (up.fileUrl) mediaEntries.push({ url: up.fileUrl });
        logChannelSync({ channel: "wix", action: "media_upload", sku: item.sku || "", ok: 1, message: path.basename(p) });
      } catch (err) {
        console.error("[WIX] media upload failed:", p, err.message);
        logChannelSync({ channel: "wix", action: "media_upload", sku: item.sku || "", ok: 0, message: err.message || "upload_failed" });
      }
    }

    if (!mediaEntries.length) {
      return res.status(500).json({ ok: false, error: "no_media_uploaded" });
    }

    await addWixProductMedia(productId, mediaEntries);
    logChannelSync({ channel: "wix", action: "media_attach", sku: item.sku || "", ok: 1, message: `${mediaEntries.length} attached` });

    // Persist local photo paths + wix media ids (best effort)
    try {
      const existingPaths = item.photo_paths ? JSON.parse(item.photo_paths) : [];
      const mergedPaths = Array.from(new Set([...(existingPaths || []), ...cleaned]));
      const existingIds = item.wix_media_ids ? JSON.parse(item.wix_media_ids) : [];
      const newIds = mediaEntries.map((m) => m.id).filter(Boolean);
      const mergedIds = Array.from(new Set([...(existingIds || []), ...newIds]));
      db.prepare(`UPDATE items SET photo_paths=?, wix_media_ids=?, wix_product_id=? WHERE id=?`)
        .run(JSON.stringify(mergedPaths), JSON.stringify(mergedIds), productId, id);
    } catch {}

    res.json({ ok: true, productId, media: mediaEntries });
  } catch (err) {
    console.error("[API] /api/items/:id/wix-media failed:", err);
    res.status(500).json({ ok: false, error: "wix_media_failed" });
  }
});

// Attach photos (data URLs) to Wix product for this item (manager+)
// Body: { files: [ { name, dataUrl } ] }
app.post("/api/items/:id/wix-media-upload", requireAuth, requirePerm("sync_admin"), async (req, res) => {
  if (!WIX_SYNC_ENABLED || !WIX_API_KEY || !WIX_SITE_ID) {
    return res.status(400).json({ ok: false, error: "wix_not_configured" });
  }

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ ok: false, error: "invalid_id" });
  }

  const item = db.prepare(`SELECT * FROM items WHERE id=?`).get(id);
  if (!item) return res.status(404).json({ ok: false, error: "not_found" });

  const files = Array.isArray(req.body?.files) ? req.body.files : [];
  if (!files.length) return res.status(400).json({ ok: false, error: "no_files" });
  if (files.length > 10) return res.status(400).json({ ok: false, error: "too_many_files" });

  try {
    let productId = item.wix_product_id || null;
    if (!productId) {
      try {
        productId = await syncItemToWix(item);
      } catch (err) {
        if (err?.code === "wix_product_id_required") {
          return res.status(409).json({ ok: false, error: "wix_product_id_required" });
        }
        throw err;
      }
    }
    if (!productId) return res.status(500).json({ ok: false, error: "wix_product_missing" });

    const mediaEntries = [];
    for (const f of files) {
      const name = String(f?.name || "upload.jpg");
      const dataUrl = String(f?.dataUrl || "");
      const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!m) continue;
      const mimeType = m[1];
      const buffer = Buffer.from(m[2], "base64");
      try {
        const up = await uploadToWixMediaBuffer({ buffer, mimeType, fileName: name });
        if (up.fileId) mediaEntries.push({ id: up.fileId });
        else if (up.fileUrl) mediaEntries.push({ url: up.fileUrl });
        logChannelSync({ channel: "wix", action: "media_upload", sku: item.sku || "", ok: 1, message: name });
      } catch (err) {
        console.error("[WIX] media upload failed:", name, err.message);
        logChannelSync({ channel: "wix", action: "media_upload", sku: item.sku || "", ok: 0, message: err.message || "upload_failed" });
      }
    }

    if (!mediaEntries.length) {
      return res.status(500).json({ ok: false, error: "no_media_uploaded" });
    }

    await addWixProductMedia(productId, mediaEntries);
    logChannelSync({ channel: "wix", action: "media_attach", sku: item.sku || "", ok: 1, message: `${mediaEntries.length} attached` });

    try {
      const existingIds = item.wix_media_ids ? JSON.parse(item.wix_media_ids) : [];
      const newIds = mediaEntries.map((m) => m.id).filter(Boolean);
      const mergedIds = Array.from(new Set([...(existingIds || []), ...newIds]));
      db.prepare(`UPDATE items SET wix_media_ids=?, wix_product_id=? WHERE id=?`)
        .run(JSON.stringify(mergedIds), productId, id);
    } catch {}

    res.json({ ok: true, productId, media: mediaEntries });
  } catch (err) {
    console.error("[API] /api/items/:id/wix-media-upload failed:", err);
    res.status(500).json({ ok: false, error: "wix_media_failed" });
  }
});

// Link existing Wix products to local items by SKU (manager+)
// Scans Wix products and stores wix_product_id for matching SKUs
app.post("/api/wix/link-products", requireAuth, requirePerm("sync_admin"), async (_req, res) => {
  if (!WIX_SYNC_ENABLED || !WIX_API_KEY || !WIX_SITE_ID) {
    return res.status(400).json({ ok: false, error: "wix_not_configured" });
  }

  try {
    let linked = 0;
    let scanned = 0;
    const skuMap = new Map();

    // Load local items into map
    const localItems = db.prepare(`SELECT id, sku FROM items WHERE deleted_at IS NULL AND sku IS NOT NULL AND sku <> ''`).all();
    for (const it of localItems) {
      skuMap.set(String(it.sku).trim(), it.id);
    }

    // Try v1 scan first (CATALOG_V1 sites). If catalog mismatch, fall back to v3 paging.
    try {
      await scanWixProductsV1({
        limit: 100,
        onProduct: async (p) => {
          scanned += 1;
          const sku = String(p?.sku || "").trim();
          if (!sku) return false;
          const itemId = skuMap.get(sku);
          if (!itemId) return false;
          db.prepare(`UPDATE items SET wix_product_id=? WHERE id=?`).run(p.id, itemId);
          linked += 1;
          return false;
        }
      });
    } catch (err) {
      if (!isCatalogV3Error(err)) throw err;
      let cursor = null;
      while (true) {
        const body = { query: { paging: { limit: 100 } } };
        if (cursor) body.query.paging = { limit: 100, cursor };

        const data = await wixRequest("/stores/v3/products/query", { method: "POST", body });
        const products = extractWixProducts(data);
        scanned += products.length;

        for (const p of products) {
          const sku = String(p?.sku || "").trim();
          if (!sku) continue;
          const itemId = skuMap.get(sku);
          if (!itemId) continue;
          db.prepare(`UPDATE items SET wix_product_id=? WHERE id=?`).run(p.id, itemId);
          linked++;
        }

        const nextCursor = data?.paging?.cursor || data?.nextCursor || null;
        if (!nextCursor) break;
        cursor = nextCursor;
      }
    }

    res.json({ ok: true, scanned, linked });
  } catch (err) {
    console.error("[API] /api/wix/link-products failed:", err);
    res.status(500).json({ ok: false, error: "wix_link_failed" });
  }
});

app.delete("/api/items/:id", requireAuth, requirePerm("inv_delete"), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ ok: false, error: "invalid_id" });
  }

  try {
    const existing = db.prepare(`SELECT * FROM items WHERE id=?`).get(id);
    if (!existing) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    const now = new Date().toISOString();

    const tx = db.transaction(() => {
      // 1) Log into deleted_items BEFORE we delete it
      const qty = Number(existing.qty || 0);
      const cost = Number(existing.cost || 0);
      const price = Number(existing.price || 0);

      db.prepare(`
        INSERT INTO deleted_items
          (itemId, sku, title, platform, category, condition,
           qty, cost, price, totalCost, totalPrice,
           reason, deletedBy, deletedAt)
        VALUES
          (@itemId, @sku, @title, @platform, @category, @condition,
           @qty, @cost, @price, @totalCost, @totalPrice,
           @reason, @deletedBy, @deletedAt)
      `).run({
        itemId: existing.id,
        sku: existing.sku,
        title: existing.title,
        platform: existing.platform,
        category: existing.category,
        condition: existing.condition,
        qty,
        cost,
        price,
        totalCost: cost * qty,
        totalPrice: price * qty,
        reason: "manual_delete",
        deletedBy: req.user?.username || String(req.user?.id || ""),
        deletedAt: now
      });

      // 2) Soft-delete so sales, refunds, movements, and sync history keep their item link.
      const info = db.prepare(`
        UPDATE items
        SET qty = 0,
            deleted_at = @deleted_at,
            deleted_reason = @deleted_reason
        WHERE id = @id
      `).run({
        id,
        deleted_at: now,
        deleted_reason: "manual_delete"
      });
      if (info.changes === 0) {
        throw new Error("delete_failed");
      }
      db.prepare(`UPDATE inventory_quantities SET qty=0, updated_at=datetime('now') WHERE item_id=?`).run(existing.id);
      if (qty > 0) {
        logInventoryMovement({
          item_id: existing.id,
          sku: existing.sku,
          qty_delta: -qty,
          reason: "delete",
          user_id: req.user.id,
          note: "Manual delete archived the item instead of removing history."
        });
      }
    });

    tx();
    storeWorkflows?.refreshAllBundleAvailability?.();

    queueWixAutoHide(existing.sku, "DELETE /api/items/:id");

    // Optional: log user action in the activity table
    logUserAction({
      action: "delete_item",
      screen: "inventory",
      metadata: {
        itemId: existing.id,
        sku: existing.sku,
        title: existing.title,
        platform: existing.platform,
        category: existing.category,
        qty: existing.qty
      }
    });

    return res.json({ ok: true, id, softDeleted: true });

  } catch (e) {
    console.error("[API] delete error:", e);
    return res.status(400).json({ ok: false, error: e.message || "delete_failed" });
  }
});


// ---------------------------------------------------------------------------
// WASTE: Write off damaged / unsellable inventory
// POST /api/items/:id/waste
// Body: { qty, reason, notes }
// ---------------------------------------------------------------------------
app.post("/api/items/:id/waste", requireAuth, requirePerm("inv_delete"), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ ok: false, error: "invalid_id" });
  }

  const { qty, reason = "", notes = "" } = req.body || {};
  const wasteQtyReq = Number(qty);

  if (!Number.isFinite(wasteQtyReq) || wasteQtyReq <= 0) {
    return res.status(400).json({ ok: false, error: "invalid_qty" });
  }

  const existing = db.prepare(`SELECT * FROM items WHERE id=?`).get(id);
  if (!existing) {
    return res.status(404).json({ ok: false, error: "not_found" });
  }

  const currentQty = Number(existing.qty || 0);
  if (currentQty <= 0) {
    return res.status(400).json({ ok: false, error: "no_stock" });
  }

  const wasteQty = Math.min(wasteQtyReq, currentQty);
  const costPerUnit = Number(existing.cost || 0);
  const pricePerUnit = Number(existing.price || 0);

  const totalCost = costPerUnit * wasteQty;
  const totalPrice = pricePerUnit * wasteQty;

  const now = new Date().toISOString();

  try {
    const tx = db.transaction(() => {
      const newQty = currentQty - wasteQty;
      ensureItemBucketBaseline(existing);
      consumeInventoryFromBuckets(existing, wasteQty, [
        "sellable",
        "display",
        "demo",
        "event_hold",
        "event_active",
        "reserved",
        "testing_hold",
        "repair_hold",
        "damaged"
      ]);
      changeInventoryBucketQty(existing, "waste", "store", wasteQty);

      // 1) Update or archive the item. Keep the row so sale history remains intact.
      if (newQty <= 0) {
        db.prepare(`
          UPDATE items
          SET qty = 0,
              deleted_at = @deleted_at,
              deleted_reason = @deleted_reason
          WHERE id = @id
        `).run({
          id,
          deleted_at: now,
          deleted_reason: "waste"
        });
      } else {
        db.prepare(`UPDATE items SET qty=? WHERE id=?`).run(newQty, id);
      }

      // 2) Log to waste_log
      db.prepare(`
        INSERT INTO waste_log
          (itemId, sku, title, platform, category, condition,
           qty, costPerUnit, pricePerUnit, totalCost, totalPrice,
           reason, notes, createdAt)
        VALUES
          (@itemId, @sku, @title, @platform, @category, @condition,
           @qty, @costPerUnit, @pricePerUnit, @totalCost, @totalPrice,
           @reason, @notes, @createdAt)
      `).run({
        itemId: existing.id,
        sku: existing.sku,
        title: existing.title,
        platform: existing.platform,
        category: existing.category,
        condition: existing.condition,
        qty: wasteQty,
        costPerUnit,
        pricePerUnit,
        totalCost,
        totalPrice,
        reason: String(reason || "").trim(),
        notes: String(notes || "").trim(),
        createdAt: now
      });

      // 3) Optional activity log
      logUserAction({
        action: "write_off",
        screen: "inventory",
        metadata: {
          itemId: existing.id,
          sku: existing.sku,
          title: existing.title,
          platform: existing.platform,
          qty_before: currentQty,
          qty_written_off: wasteQty,
          qty_after: Math.max(newQty, 0),
          reason: String(reason || "").trim()
        }
      });
      logInventoryMovement({
        item_id: existing.id,
        sku: existing.sku,
        qty_delta: -wasteQty,
        reason: "waste",
        user_id: req.user.id,
        note: String(notes || reason || "").trim()
      });

      return newQty;
    });

    const newQty = tx();
    storeWorkflows?.refreshAllBundleAvailability?.();

    const updated =
      newQty > 0
        ? db.prepare(`SELECT * FROM items WHERE id=?`).get(id)
        : null;
    const responseItem = updated ? addBucketFieldsToRows([updated])[0] : null;

    if (updated && updated.sku) queueWixAutoSkuSync(updated.sku, "POST /api/items/:id/waste");
    else if (existing && existing.sku) queueWixAutoHide(existing.sku, "POST /api/items/:id/waste");

    return res.json({
      ok: true,
      deleted: !responseItem,
      item: responseItem,
      waste: {
        qty: wasteQty,
        totalCost,
        totalPrice,
        reason: String(reason || "").trim(),
        notes: String(notes || "").trim()
      }
    });

  } catch (e) {
    console.error("[API] waste error:", e);
    return res.status(500).json({ ok: false, error: "waste_failed" });
  }
});

// ---------------------------------------------------------------------------
// ACCOUNTING: Expenses + Tax Center
// ---------------------------------------------------------------------------
app.get("/api/accounting/expenses", requireAuth, requirePerm("reports"), (req, res) => {
  try {
    const { startDate, endDate } = parseOptionalDateRange(req, 30);
    const type = String(req.query.type || "").trim().toLowerCase();
    const category = String(req.query.category || "").trim();
    const search = String(req.query.search || "").trim().toLowerCase();

    const where = [`date(expense_date) BETWEEN date(@start) AND date(@end)`];
    const params = { start: startDate, end: endDate };

    if (type === "inventory" || type === "operating") {
      where.push(`type = @type`);
      params.type = type;
    }
    if (category) {
      where.push(`category = @category`);
      params.category = category;
    }
    if (search) {
      where.push(`(
        lower(COALESCE(vendor,'')) LIKE @q OR
        lower(COALESCE(memo,'')) LIKE @q OR
        lower(COALESCE(title,'')) LIKE @q OR
        lower(COALESCE(sku,'')) LIKE @q
      )`);
      params.q = `%${search}%`;
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const rows = db.prepare(`
      SELECT *
      FROM expenses
      ${whereSql}
      ORDER BY datetime(expense_date) DESC, id DESC
      LIMIT 5000
    `).all(params);

    const summary = db.prepare(`
      SELECT
        COALESCE(SUM(amount),0) AS amount,
        COALESCE(SUM(tax_amount),0) AS tax_amount
      FROM expenses
      ${whereSql}
    `).get(params) || { amount: 0, tax_amount: 0 };

    const byCategory = db.prepare(`
      SELECT
        type,
        COALESCE(NULLIF(category,''),'Uncategorized') AS category,
        COUNT(*) AS count,
        COALESCE(SUM(amount),0) AS amount,
        COALESCE(SUM(tax_amount),0) AS tax_amount,
        COALESCE(SUM(amount + tax_amount),0) AS total
      FROM expenses
      ${whereSql}
      GROUP BY type, COALESCE(NULLIF(category,''),'Uncategorized')
      ORDER BY total DESC, category ASC
    `).all(params);

    const byPayment = db.prepare(`
      SELECT
        COALESCE(NULLIF(payment_method,''),'Unspecified') AS payment_method,
        COUNT(*) AS count,
        COALESCE(SUM(amount),0) AS amount,
        COALESCE(SUM(tax_amount),0) AS tax_amount,
        COALESCE(SUM(amount + tax_amount),0) AS total
      FROM expenses
      ${whereSql}
      GROUP BY COALESCE(NULLIF(payment_method,''),'Unspecified')
      ORDER BY total DESC, payment_method ASC
    `).all(params);

    res.json({
      ok: true,
      range: { start: startDate, end: endDate },
      summary: {
        amount: Number(summary.amount || 0),
        tax_amount: Number(summary.tax_amount || 0),
        total: Number((Number(summary.amount || 0) + Number(summary.tax_amount || 0)).toFixed(2))
      },
      byCategory,
      byPayment,
      rows
    });
  } catch (e) {
    console.error("[API] /api/accounting/expenses failed:", e);
    res.status(500).json({ ok: false, error: "expenses_failed" });
  }
});

app.post("/api/accounting/expenses", requireAuth, requirePerm("reports"), (req, res) => {
  try {
    const body = req.body || {};
    const expense_date = String(body.expense_date || "").trim();
    const typeRaw = String(body.type || "operating").trim().toLowerCase();
    const type = (typeRaw === "inventory" || typeRaw === "operating") ? typeRaw : "operating";
    const category = String(body.category || "").trim() || null;
    const vendor = String(body.vendor || "").trim() || null;
    const memo = String(body.memo || "").trim() || null;
    const payment_method = String(body.payment_method || "").trim() || null;
    const receipt_path = String(body.receipt_path || "").trim() || null;
    const amount = Number(body.amount || 0);
    const tax_amount = Number(body.tax_amount || 0);

    if (!expense_date) {
      return res.status(400).json({ ok: false, error: "missing_expense_date" });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ ok: false, error: "invalid_amount" });
    }

    const info = db.prepare(`
      INSERT INTO expenses
        (expense_date, type, category, vendor, memo, amount, tax_amount, payment_method, receipt_path, source, user_id)
      VALUES
        (@expense_date, @type, @category, @vendor, @memo, @amount, @tax_amount, @payment_method, @receipt_path, @source, @user_id)
    `).run({
      expense_date,
      type,
      category,
      vendor,
      memo,
      amount,
      tax_amount: Number.isFinite(tax_amount) ? tax_amount : 0,
      payment_method,
      receipt_path,
      source: "manual",
      user_id: req.user?.id || null
    });

    logUserAction({
      userId: String(req.user?.id || ""),
      username: req.user?.username || "",
      action: "expense_created",
      screen: "accounting",
      metadata: { expenseId: info.lastInsertRowid, type, category, vendor, amount, taxAmount: tax_amount }
    });

    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    console.error("[API] /api/accounting/expenses create failed:", e);
    res.status(500).json({ ok: false, error: "expense_create_failed" });
  }
});

app.delete("/api/accounting/expenses/:id", requireAuth, requirePerm("reports"), (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "invalid_id" });
    const existing = db.prepare(`SELECT * FROM expenses WHERE id=?`).get(id);
    const info = db.prepare(`DELETE FROM expenses WHERE id=?`).run(id);
    if (!info.changes) return res.status(404).json({ ok: false, error: "not_found" });
    logUserAction({
      userId: String(req.user?.id || ""),
      username: req.user?.username || "",
      action: "expense_deleted",
      screen: "accounting",
      metadata: { expenseId: id, amount: existing?.amount || 0, category: existing?.category || "" }
    });
    res.json({ ok: true });
  } catch (e) {
    console.error("[API] /api/accounting/expenses delete failed:", e);
    res.status(500).json({ ok: false, error: "expense_delete_failed" });
  }
});

function discountedSaleLinesCte() {
  return `
    WITH sale_line_totals AS (
      SELECT
        sale_id,
        COALESCE(SUM(CASE WHEN line_type IS NULL OR line_type != 'discount' THEN line_total ELSE 0 END),0) AS item_total,
        COALESCE(SUM(CASE WHEN line_type = 'discount' THEN -line_total ELSE 0 END),0) AS discount_total
      FROM sale_items
      GROUP BY sale_id
    ),
    discounted_sale_lines AS (
      SELECT
        s.id AS sale_id,
        s.created_at,
        COALESCE(s.customer_tax_exempt,0) AS customer_tax_exempt,
        si.id AS sale_item_id,
        si.item_id,
        si.sku,
        si.title,
        si.qty,
        si.taxable,
        COALESCE(i.category,'(uncategorized)') AS category,
        si.line_total AS gross_line_total,
        CASE
          WHEN COALESCE(st.item_total,0) > 0
          THEN (
            CASE
              WHEN (
                si.line_total -
                ((CASE WHEN COALESCE(st.discount_total,0) > st.item_total THEN st.item_total ELSE COALESCE(st.discount_total,0) END)
                  * (si.line_total / st.item_total))
              ) < 0 THEN 0
              ELSE (
                si.line_total -
                ((CASE WHEN COALESCE(st.discount_total,0) > st.item_total THEN st.item_total ELSE COALESCE(st.discount_total,0) END)
                  * (si.line_total / st.item_total))
              )
            END
          )
          ELSE si.line_total
        END AS net_line_total,
        CASE
          WHEN COALESCE(st.item_total,0) > 0
          THEN ((CASE WHEN COALESCE(st.discount_total,0) > st.item_total THEN st.item_total ELSE COALESCE(st.discount_total,0) END)
            * (si.line_total / st.item_total))
          ELSE 0
        END AS discount_allocated
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      LEFT JOIN items i ON i.id = si.item_id
      LEFT JOIN sale_line_totals st ON st.sale_id = si.sale_id
      WHERE s.status = 'completed'
        AND (si.line_type IS NULL OR si.line_type != 'discount')
    )
  `;
}

app.get("/api/accounting/tax-summary", requireAuth, requirePerm("reports"), (req, res) => {
  const range = parseDateRange(req);
  if (range.error) return res.status(400).json({ ok: false, error: range.error });
  const { startDate, endDate } = range;

  try {
    const totals = db.prepare(`
      SELECT
        COALESCE(SUM(total),0) AS total_sales,
        COALESCE(SUM(tax),0) AS tax_collected,
        COALESCE(SUM(subtotal),0) AS subtotal
      FROM sales
      WHERE date(created_at) BETWEEN date(@start) AND date(@end)
        AND status = 'completed'
    `).get({ start: startDate, end: endDate }) || {};

    const taxables = db.prepare(`
      ${discountedSaleLinesCte()}
      SELECT
        COALESCE(SUM(CASE WHEN customer_tax_exempt = 0 AND taxable = 1 THEN net_line_total ELSE 0 END),0) AS taxable_sales,
        COALESCE(SUM(CASE WHEN customer_tax_exempt = 1 OR taxable = 0 THEN net_line_total ELSE 0 END),0) AS exempt_sales
      FROM discounted_sale_lines
      WHERE date(created_at) BETWEEN date(@start) AND date(@end)
    `).get({ start: startDate, end: endDate }) || {};

    const dailySales = db.prepare(`
      SELECT
        date(created_at) AS day,
        COALESCE(SUM(total),0) AS total_sales,
        COALESCE(SUM(tax),0) AS tax_collected
      FROM sales
      WHERE date(created_at) BETWEEN date(@start) AND date(@end)
        AND status = 'completed'
      GROUP BY date(created_at)
      ORDER BY date(created_at) ASC
    `).all({ start: startDate, end: endDate });

    const dailyTaxable = db.prepare(`
      ${discountedSaleLinesCte()}
      SELECT
        date(created_at) AS day,
        COALESCE(SUM(CASE WHEN customer_tax_exempt = 0 AND taxable = 1 THEN net_line_total ELSE 0 END),0) AS taxable_sales,
        COALESCE(SUM(CASE WHEN customer_tax_exempt = 1 OR taxable = 0 THEN net_line_total ELSE 0 END),0) AS exempt_sales
      FROM discounted_sale_lines
      WHERE date(created_at) BETWEEN date(@start) AND date(@end)
      GROUP BY date(created_at)
      ORDER BY date(created_at) ASC
    `).all({ start: startDate, end: endDate });

    const dailyMap = new Map();
    for (const d of dailySales) {
      dailyMap.set(d.day, {
        day: d.day,
        total_sales: Number(d.total_sales || 0),
        tax_collected: Number(d.tax_collected || 0),
        taxable_sales: 0,
        exempt_sales: 0
      });
    }
    for (const d of dailyTaxable) {
      const row = dailyMap.get(d.day) || {
        day: d.day,
        total_sales: 0,
        tax_collected: 0,
        taxable_sales: 0,
        exempt_sales: 0
      };
      row.taxable_sales = Number(d.taxable_sales || 0);
      row.exempt_sales = Number(d.exempt_sales || 0);
      dailyMap.set(d.day, row);
    }

    const rows = Array.from(dailyMap.values()).sort((a, b) => a.day.localeCompare(b.day));

    res.json({
      ok: true,
      range: { start: startDate, end: endDate },
      summary: {
        total_sales: Number(totals.total_sales || 0),
        subtotal: Number(totals.subtotal || 0),
        tax_collected: Number(totals.tax_collected || 0),
        taxable_sales: Number(taxables.taxable_sales || 0),
        exempt_sales: Number(taxables.exempt_sales || 0)
      },
      rows
    });
  } catch (e) {
    console.error("[API] /api/accounting/tax-summary failed:", e);
    res.status(500).json({ ok: false, error: "tax_summary_failed" });
  }
});

app.get("/api/accounting/summary", requireAuth, requirePerm("reports"), (req, res) => {
  const { startDate, endDate } = parseOptionalDateRange(req, 30);
  try {
    const sales = db.prepare(`
      SELECT
        COUNT(*) AS transaction_count,
        COALESCE(SUM(subtotal),0) AS subtotal,
        COALESCE(SUM(tax),0) AS tax_collected,
        COALESCE(SUM(total),0) AS total_sales
      FROM sales
      WHERE status='completed'
        AND date(created_at) BETWEEN date(@start) AND date(@end)
    `).get({ start: startDate, end: endDate }) || {};

    const refunds = db.prepare(`
      SELECT
        COUNT(DISTINCT r.id) AS refund_count,
        COALESCE(SUM(ri.line_total),0) AS refund_total
      FROM refunds r
      LEFT JOIN refund_items ri ON ri.refund_id=r.id
      WHERE date(r.created_at) BETWEEN date(@start) AND date(@end)
    `).get({ start: startDate, end: endDate }) || {};

    const expenses = db.prepare(`
      SELECT
        COUNT(*) AS expense_count,
        COALESCE(SUM(amount),0) AS expense_amount,
        COALESCE(SUM(tax_amount),0) AS expense_tax,
        COALESCE(SUM(amount + tax_amount),0) AS expense_total,
        COALESCE(SUM(CASE WHEN type='inventory' THEN amount + tax_amount ELSE 0 END),0) AS inventory_total,
        COALESCE(SUM(CASE WHEN type='operating' THEN amount + tax_amount ELSE 0 END),0) AS operating_total
      FROM expenses
      WHERE date(expense_date) BETWEEN date(@start) AND date(@end)
    `).get({ start: startDate, end: endDate }) || {};

    const taxables = db.prepare(`
      ${discountedSaleLinesCte()}
      SELECT
        COALESCE(SUM(CASE WHEN customer_tax_exempt = 0 AND taxable = 1 THEN net_line_total ELSE 0 END),0) AS taxable_sales,
        COALESCE(SUM(CASE WHEN customer_tax_exempt = 1 OR taxable = 0 THEN net_line_total ELSE 0 END),0) AS exempt_sales
      FROM discounted_sale_lines
      WHERE date(created_at) BETWEEN date(@start) AND date(@end)
    `).get({ start: startDate, end: endDate }) || {};

    const closeouts = db.prepare(`
      SELECT
        COUNT(*) AS closeout_count,
        COALESCE(SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END),0) AS closed_count,
        COALESCE(SUM(CASE WHEN status!='closed' THEN 1 ELSE 0 END),0) AS draft_count,
        COALESCE(SUM(variance_cents),0) AS variance_cents,
        COALESCE(SUM(ABS(variance_cents)),0) AS absolute_variance_cents,
        COALESCE(SUM(net_sales_cents),0) AS closeout_net_sales_cents,
        COALESCE(SUM(cash_sales_cents),0) AS cash_sales_cents,
        COALESCE(SUM(card_sales_cents),0) AS card_sales_cents,
        COALESCE(SUM(store_credit_sales_cents),0) AS store_credit_sales_cents,
        COALESCE(SUM(other_sales_cents),0) AS other_sales_cents
      FROM register_closeouts
      WHERE date(business_date) BETWEEN date(@start) AND date(@end)
    `).get({ start: startDate, end: endDate }) || {};

    const totalSales = Number(sales.total_sales || 0);
    const refundTotal = Number(refunds.refund_total || 0);
    const expenseTotal = Number(expenses.expense_total || 0);
    const netSales = Number((totalSales - refundTotal).toFixed(2));
    const netAfterExpenses = Number((netSales - expenseTotal).toFixed(2));

    res.json({
      ok: true,
      range: { start: startDate, end: endDate },
      summary: {
        transaction_count: Number(sales.transaction_count || 0),
        subtotal: Number(sales.subtotal || 0),
        total_sales: totalSales,
        refund_count: Number(refunds.refund_count || 0),
        refund_total: refundTotal,
        net_sales: netSales,
        tax_collected: Number(sales.tax_collected || 0),
        taxable_sales: Number(taxables.taxable_sales || 0),
        exempt_sales: Number(taxables.exempt_sales || 0),
        expense_count: Number(expenses.expense_count || 0),
        expense_amount: Number(expenses.expense_amount || 0),
        expense_tax: Number(expenses.expense_tax || 0),
        expense_total: expenseTotal,
        inventory_expenses: Number(expenses.inventory_total || 0),
        operating_expenses: Number(expenses.operating_total || 0),
        net_after_expenses: netAfterExpenses,
        closeout_count: Number(closeouts.closeout_count || 0),
        closed_count: Number(closeouts.closed_count || 0),
        draft_count: Number(closeouts.draft_count || 0),
        variance: toDollars(closeouts.variance_cents),
        absolute_variance: toDollars(closeouts.absolute_variance_cents),
        closeout_net_sales: toDollars(closeouts.closeout_net_sales_cents),
        closeout_cash_sales: toDollars(closeouts.cash_sales_cents),
        closeout_card_sales: toDollars(closeouts.card_sales_cents),
        closeout_store_credit_sales: toDollars(closeouts.store_credit_sales_cents),
        closeout_other_sales: toDollars(closeouts.other_sales_cents)
      }
    });
  } catch (e) {
    console.error("[API] /api/accounting/summary failed:", e);
    res.status(500).json({ ok: false, error: "accounting_summary_failed" });
  }
});

app.get("/api/accounting/closeouts", requireAuth, requirePerm("reports"), (req, res) => {
  const { startDate, endDate } = parseOptionalDateRange(req, 30);
  try {
    const rows = db.prepare(`
      SELECT rc.*, ou.username AS opened_by_username, cu.username AS closed_by_username
      FROM register_closeouts rc
      LEFT JOIN users ou ON ou.id = rc.opened_by
      LEFT JOIN users cu ON cu.id = rc.closed_by
      WHERE date(rc.business_date) BETWEEN date(@start) AND date(@end)
      ORDER BY date(rc.business_date) DESC, rc.id DESC
    `).all({ start: startDate, end: endDate });

    const summary = rows.reduce((acc, r) => {
      acc.count += 1;
      if (r.status === "closed") acc.closed_count += 1;
      else acc.draft_count += 1;
      acc.transaction_count += Number(r.transaction_count || 0);
      acc.item_count += Number(r.item_count || 0);
      acc.total_sales_cents += Number(r.total_sales_cents || 0);
      acc.total_refunds_cents += Number(r.total_refunds_cents || 0);
      acc.net_sales_cents += Number(r.net_sales_cents || 0);
      acc.cash_sales_cents += Number(r.cash_sales_cents || 0);
      acc.card_sales_cents += Number(r.card_sales_cents || 0);
      acc.store_credit_sales_cents += Number(r.store_credit_sales_cents || 0);
      acc.other_sales_cents += Number(r.other_sales_cents || 0);
      acc.expected_cash_cents += Number(r.expected_cash_cents || 0);
      acc.counted_cash_cents += Number(r.counted_cash_cents || 0);
      acc.variance_cents += Number(r.variance_cents || 0);
      acc.absolute_variance_cents += Math.abs(Number(r.variance_cents || 0));
      return acc;
    }, {
      count: 0,
      closed_count: 0,
      draft_count: 0,
      transaction_count: 0,
      item_count: 0,
      total_sales_cents: 0,
      total_refunds_cents: 0,
      net_sales_cents: 0,
      cash_sales_cents: 0,
      card_sales_cents: 0,
      store_credit_sales_cents: 0,
      other_sales_cents: 0,
      expected_cash_cents: 0,
      counted_cash_cents: 0,
      variance_cents: 0,
      absolute_variance_cents: 0
    });

    res.json({
      ok: true,
      range: { start: startDate, end: endDate },
      summary: {
        ...summary,
        total_sales: toDollars(summary.total_sales_cents),
        total_refunds: toDollars(summary.total_refunds_cents),
        net_sales: toDollars(summary.net_sales_cents),
        cash_sales: toDollars(summary.cash_sales_cents),
        card_sales: toDollars(summary.card_sales_cents),
        store_credit_sales: toDollars(summary.store_credit_sales_cents),
        other_sales: toDollars(summary.other_sales_cents),
        expected_cash: toDollars(summary.expected_cash_cents),
        counted_cash: toDollars(summary.counted_cash_cents),
        variance: toDollars(summary.variance_cents),
        absolute_variance: toDollars(summary.absolute_variance_cents)
      },
      rows: rows.map(serializeCloseout)
    });
  } catch (e) {
    console.error("[API] /api/accounting/closeouts failed:", e);
    res.status(500).json({ ok: false, error: "accounting_closeouts_failed" });
  }
});

function serializeTaxFiling(row) {
  if (!row) return null;
  const amountDue = Number(row.amount_due || 0);
  const amountPaid = Number(row.amount_paid || 0);
  return {
    ...row,
    amount_due: amountDue,
    amount_paid: amountPaid,
    balance_due: Number((amountDue - amountPaid).toFixed(2))
  };
}

app.get("/api/accounting/tax-filings", requireAuth, requirePerm("reports"), (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit || 120)));
  try {
    const rows = db.prepare(`
      SELECT tf.*, u.username
      FROM tax_filings tf
      LEFT JOIN users u ON u.id=tf.user_id
      ORDER BY date(tf.period_end) DESC, tf.id DESC
      LIMIT ?
    `).all(limit);
    res.json({ ok: true, rows: rows.map(serializeTaxFiling) });
  } catch (e) {
    console.error("[API] /api/accounting/tax-filings failed:", e);
    res.status(500).json({ ok: false, error: "tax_filings_failed" });
  }
});

app.post("/api/accounting/tax-filings", requireAuth, requirePerm("reports"), (req, res) => {
  const body = req.body || {};
  const periodStart = String(body.period_start || "").trim();
  const periodEnd = String(body.period_end || "").trim();
  const statusRaw = String(body.status || "draft").toLowerCase().trim();
  const status = ["draft", "filed", "paid"].includes(statusRaw) ? statusRaw : "draft";
  const amountDue = Number(body.amount_due || 0);
  const amountPaid = Number(body.amount_paid || 0);
  const filedAt = String(body.filed_at || "").trim() || null;
  const notes = String(body.notes || "").trim() || null;
  const now = new Date().toISOString();

  if (!periodStart || !periodEnd) {
    return res.status(400).json({ ok: false, error: "missing_period" });
  }
  if (periodStart > periodEnd) {
    return res.status(400).json({ ok: false, error: "invalid_period" });
  }
  if (!Number.isFinite(amountDue) || amountDue < 0 || !Number.isFinite(amountPaid) || amountPaid < 0) {
    return res.status(400).json({ ok: false, error: "invalid_amount" });
  }

  try {
    const info = db.prepare(`
      INSERT INTO tax_filings
        (created_at, updated_at, period_start, period_end, status, amount_due, amount_paid, filed_at, notes, user_id)
      VALUES
        (@created_at, @updated_at, @period_start, @period_end, @status, @amount_due, @amount_paid, @filed_at, @notes, @user_id)
    `).run({
      created_at: now,
      updated_at: now,
      period_start: periodStart,
      period_end: periodEnd,
      status,
      amount_due: amountDue,
      amount_paid: amountPaid,
      filed_at: filedAt,
      notes,
      user_id: req.user?.id || null
    });
    logUserAction({
      userId: String(req.user?.id || ""),
      username: req.user?.username || "",
      action: "tax_filing_saved",
      screen: "accounting",
      metadata: { filingId: info.lastInsertRowid, periodStart, periodEnd, status, amountDue, amountPaid }
    });
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    console.error("[API] /api/accounting/tax-filings create failed:", e);
    res.status(500).json({ ok: false, error: "tax_filing_create_failed" });
  }
});

app.delete("/api/accounting/tax-filings/:id", requireAuth, requirePerm("reports"), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "invalid_id" });
  try {
    const existing = db.prepare(`SELECT * FROM tax_filings WHERE id=?`).get(id);
    const info = db.prepare(`DELETE FROM tax_filings WHERE id=?`).run(id);
    if (!info.changes) return res.status(404).json({ ok: false, error: "not_found" });
    logUserAction({
      userId: String(req.user?.id || ""),
      username: req.user?.username || "",
      action: "tax_filing_deleted",
      screen: "accounting",
      metadata: { filingId: id, periodStart: existing?.period_start || "", periodEnd: existing?.period_end || "" }
    });
    res.json({ ok: true });
  } catch (e) {
    console.error("[API] /api/accounting/tax-filings delete failed:", e);
    res.status(500).json({ ok: false, error: "tax_filing_delete_failed" });
  }
});

// ---------------------------------------------------------------------------
// REGISTER CLOSEOUT: End-of-day cash reconciliation
// ---------------------------------------------------------------------------
function normalizeBusinessDate(raw) {
  const value = String(raw || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return new Date().toISOString().slice(0, 10);
}

function toCents(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function toDollars(cents) {
  return Number((Number(cents || 0) / 100).toFixed(2));
}

function readMoneyCents(body, centsKey, moneyKey) {
  if (Number.isFinite(Number(body?.[centsKey]))) {
    return Math.round(Number(body[centsKey]));
  }
  return toCents(body?.[moneyKey]);
}

function methodBucket(method) {
  const m = String(method || "unknown").toLowerCase().trim();
  if (m.includes("store") && m.includes("credit")) return "store_credit";
  if (m.includes("cash")) return "cash";
  if (m.includes("card") || m.includes("credit") || m.includes("debit")) return "card";
  return "other";
}

function serializeCloseout(row) {
  if (!row) return null;
  const out = { ...row };
  [
    "opening_cash_cents",
    "paid_in_cents",
    "paid_out_cents",
    "cash_sales_cents",
    "cash_refunds_cents",
    "card_sales_cents",
    "store_credit_sales_cents",
    "other_sales_cents",
    "total_sales_cents",
    "total_refunds_cents",
    "net_sales_cents",
    "expected_cash_cents",
    "counted_cash_cents",
    "variance_cents"
  ].forEach((key) => {
    out[key.replace(/_cents$/, "")] = toDollars(out[key]);
  });
  return out;
}

function computeRegisterCloseout({ businessDate, openingCashCents = 0, paidInCents = 0, paidOutCents = 0, countedCashCents = 0 }) {
  const payments = db.prepare(`
    SELECT COALESCE(payment_method,'unknown') AS method,
           COUNT(*) AS transaction_count,
           COALESCE(SUM(total),0) AS total
    FROM sales
    WHERE status='completed'
      AND date(created_at)=date(@date)
    GROUP BY COALESCE(payment_method,'unknown')
  `).all({ date: businessDate });

  const refunds = db.prepare(`
    SELECT COALESCE(s.payment_method,'unknown') AS method,
           COALESCE(SUM(ri.line_total),0) AS total
    FROM refunds r
    JOIN refund_items ri ON ri.refund_id = r.id
    JOIN sales s ON s.id = r.sale_id
    WHERE date(r.created_at)=date(@date)
    GROUP BY COALESCE(s.payment_method,'unknown')
  `).all({ date: businessDate });

  const itemRow = db.prepare(`
    SELECT COALESCE(SUM(si.qty),0) AS item_count
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    WHERE s.status='completed'
      AND date(s.created_at)=date(@date)
      AND (si.line_type IS NULL OR si.line_type!='discount')
  `).get({ date: businessDate }) || {};

  const totals = {
    cashSalesCents: 0,
    cashRefundsCents: 0,
    cardSalesCents: 0,
    storeCreditSalesCents: 0,
    otherSalesCents: 0,
    totalSalesCents: 0,
    totalRefundsCents: 0,
    transactionCount: 0,
    itemCount: Number(itemRow.item_count || 0)
  };

  for (const row of payments) {
    const cents = toCents(row.total);
    totals.totalSalesCents += cents;
    totals.transactionCount += Number(row.transaction_count || 0);
    const bucket = methodBucket(row.method);
    if (bucket === "cash") totals.cashSalesCents += cents;
    else if (bucket === "card") totals.cardSalesCents += cents;
    else if (bucket === "store_credit") totals.storeCreditSalesCents += cents;
    else totals.otherSalesCents += cents;
  }

  for (const row of refunds) {
    const cents = toCents(row.total);
    totals.totalRefundsCents += cents;
    if (methodBucket(row.method) === "cash") {
      totals.cashRefundsCents += cents;
    }
  }

  const netSalesCents = totals.totalSalesCents - totals.totalRefundsCents;
  const expectedCashCents =
    openingCashCents + paidInCents - paidOutCents + totals.cashSalesCents - totals.cashRefundsCents;
  const varianceCents = countedCashCents - expectedCashCents;

  return {
    ...totals,
    openingCashCents,
    paidInCents,
    paidOutCents,
    countedCashCents,
    netSalesCents,
    expectedCashCents,
    varianceCents
  };
}

function closeoutPayload(metrics) {
  return {
    cash_sales_cents: metrics.cashSalesCents,
    cash_refunds_cents: metrics.cashRefundsCents,
    card_sales_cents: metrics.cardSalesCents,
    store_credit_sales_cents: metrics.storeCreditSalesCents,
    other_sales_cents: metrics.otherSalesCents,
    total_sales_cents: metrics.totalSalesCents,
    total_refunds_cents: metrics.totalRefundsCents,
    net_sales_cents: metrics.netSalesCents,
    expected_cash_cents: metrics.expectedCashCents,
    variance_cents: metrics.varianceCents,
    transaction_count: metrics.transactionCount,
    item_count: metrics.itemCount
  };
}

app.get("/api/register/closeout", requireAuth, requirePerm("reports"), (req, res) => {
  const businessDate = normalizeBusinessDate(req.query.date);
  try {
    const existing = db.prepare(`SELECT * FROM register_closeouts WHERE business_date=?`).get(businessDate);
    const openingCashCents = Number(existing?.opening_cash_cents || 0);
    const paidInCents = Number(existing?.paid_in_cents || 0);
    const paidOutCents = Number(existing?.paid_out_cents || 0);
    const countedCashCents = Number(existing?.counted_cash_cents || 0);
    const metrics = computeRegisterCloseout({
      businessDate,
      openingCashCents,
      paidInCents,
      paidOutCents,
      countedCashCents
    });
    res.json({
      ok: true,
      business_date: businessDate,
      closeout: serializeCloseout(existing),
      settings: {
        variance_warn_cents: Math.max(0, readRegisterSettingInt("closeout_variance_warn_cents", 500)),
        require_note_on_variance: readRegisterSettingBool("closeout_require_note_on_variance", true),
        require_opening_cash: readRegisterSettingBool("closeout_require_opening_cash", false)
      },
      metrics: serializeCloseout({
        ...closeoutPayload(metrics),
        opening_cash_cents: openingCashCents,
        paid_in_cents: paidInCents,
        paid_out_cents: paidOutCents,
        counted_cash_cents: countedCashCents,
        transaction_count: metrics.transactionCount,
        item_count: metrics.itemCount
      })
    });
  } catch (e) {
    console.error("[API] /api/register/closeout failed:", e);
    res.status(500).json({ ok: false, error: "closeout_summary_failed" });
  }
});

app.get("/api/register/closeouts", requireAuth, requirePerm("reports"), (req, res) => {
  const limit = Math.min(120, Math.max(1, Number(req.query.limit || 30)));
  try {
    const rows = db.prepare(`
      SELECT rc.*, ou.username AS opened_by_username, cu.username AS closed_by_username
      FROM register_closeouts rc
      LEFT JOIN users ou ON ou.id = rc.opened_by
      LEFT JOIN users cu ON cu.id = rc.closed_by
      ORDER BY date(rc.business_date) DESC, rc.id DESC
      LIMIT ?
    `).all(limit);
    res.json({ ok: true, rows: rows.map(serializeCloseout) });
  } catch (e) {
    console.error("[API] /api/register/closeouts failed:", e);
    res.status(500).json({ ok: false, error: "closeout_list_failed" });
  }
});

app.post("/api/register/closeout", requireAuth, requirePerm("closeout_admin"), (req, res) => {
  const body = req.body || {};
  const businessDate = normalizeBusinessDate(body.business_date || body.date);
  const statusRaw = String(body.status || "draft").toLowerCase().trim();
  const status = statusRaw === "closed" ? "closed" : "draft";
  const openingCashCents = readMoneyCents(body, "opening_cash_cents", "opening_cash");
  const paidInCents = readMoneyCents(body, "paid_in_cents", "paid_in");
  const paidOutCents = readMoneyCents(body, "paid_out_cents", "paid_out");
  const countedCashCents = readMoneyCents(body, "counted_cash_cents", "counted_cash");
  const notes = String(body.notes || "").trim() || null;
  const now = new Date().toISOString();

  try {
    const metrics = computeRegisterCloseout({
      businessDate,
      openingCashCents,
      paidInCents,
      paidOutCents,
      countedCashCents
    });
    const varianceWarnCents = Math.max(0, readRegisterSettingInt("closeout_variance_warn_cents", 500));
    if (status === "closed" && readRegisterSettingBool("closeout_require_opening_cash", false) && openingCashCents <= 0) {
      return res.status(409).json({ ok: false, error: "opening_cash_required" });
    }
    if (
      status === "closed" &&
      readRegisterSettingBool("closeout_require_note_on_variance", true) &&
      varianceWarnCents > 0 &&
      Math.abs(metrics.varianceCents) >= varianceWarnCents &&
      !notes
    ) {
      return res.status(409).json({
        ok: false,
        error: "closeout_note_required",
        variance_cents: metrics.varianceCents,
        threshold_cents: varianceWarnCents
      });
    }
    const payload = closeoutPayload(metrics);
    const existing = db.prepare(`SELECT * FROM register_closeouts WHERE business_date=?`).get(businessDate);

    if (existing) {
      db.prepare(`
        UPDATE register_closeouts
        SET status=@status,
            closed_at=@closed_at,
            closed_by=@closed_by,
            opening_cash_cents=@opening_cash_cents,
            paid_in_cents=@paid_in_cents,
            paid_out_cents=@paid_out_cents,
            counted_cash_cents=@counted_cash_cents,
            cash_sales_cents=@cash_sales_cents,
            cash_refunds_cents=@cash_refunds_cents,
            card_sales_cents=@card_sales_cents,
            store_credit_sales_cents=@store_credit_sales_cents,
            other_sales_cents=@other_sales_cents,
            total_sales_cents=@total_sales_cents,
            total_refunds_cents=@total_refunds_cents,
            net_sales_cents=@net_sales_cents,
            expected_cash_cents=@expected_cash_cents,
            variance_cents=@variance_cents,
            transaction_count=@transaction_count,
            item_count=@item_count,
            notes=@notes,
            updated_at=@updated_at
        WHERE id=@id
      `).run({
        id: existing.id,
        status,
        closed_at: status === "closed" ? now : null,
        closed_by: status === "closed" ? req.user.id : null,
        opening_cash_cents: openingCashCents,
        paid_in_cents: paidInCents,
        paid_out_cents: paidOutCents,
        counted_cash_cents: countedCashCents,
        notes,
        updated_at: now,
        ...payload
      });
    } else {
      db.prepare(`
        INSERT INTO register_closeouts
          (business_date, status, opened_at, closed_at, opened_by, closed_by,
           opening_cash_cents, paid_in_cents, paid_out_cents, counted_cash_cents,
           cash_sales_cents, cash_refunds_cents, card_sales_cents, store_credit_sales_cents,
           other_sales_cents, total_sales_cents, total_refunds_cents, net_sales_cents,
           expected_cash_cents, variance_cents, transaction_count, item_count, notes, updated_at)
        VALUES
          (@business_date, @status, @opened_at, @closed_at, @opened_by, @closed_by,
           @opening_cash_cents, @paid_in_cents, @paid_out_cents, @counted_cash_cents,
           @cash_sales_cents, @cash_refunds_cents, @card_sales_cents, @store_credit_sales_cents,
           @other_sales_cents, @total_sales_cents, @total_refunds_cents, @net_sales_cents,
           @expected_cash_cents, @variance_cents, @transaction_count, @item_count, @notes, @updated_at)
      `).run({
        business_date: businessDate,
        status,
        opened_at: now,
        closed_at: status === "closed" ? now : null,
        opened_by: req.user.id,
        closed_by: status === "closed" ? req.user.id : null,
        opening_cash_cents: openingCashCents,
        paid_in_cents: paidInCents,
        paid_out_cents: paidOutCents,
        counted_cash_cents: countedCashCents,
        notes,
        updated_at: now,
        ...payload
      });
    }

    const row = db.prepare(`SELECT * FROM register_closeouts WHERE business_date=?`).get(businessDate);
    logUserAction({
      userId: String(req.user.id || ""),
      username: req.user.username || "",
      action: status === "closed" ? "register_closeout_closed" : "register_closeout_saved",
      screen: "register_closeout",
      metadata: {
        businessDate,
        varianceCents: metrics.varianceCents,
        expectedCashCents: metrics.expectedCashCents,
        countedCashCents
      }
    });
    res.json({ ok: true, closeout: serializeCloseout(row) });
  } catch (e) {
    console.error("[API] /api/register/closeout save failed:", e);
    res.status(500).json({ ok: false, error: "closeout_save_failed" });
  }
});

// REPORTS: Sales summary (supports single date OR range)
// GET /api/reports/daily-sales?date=YYYY-MM-DD
// OR  /api/reports/daily-sales?start=YYYY-MM-DD&end=YYYY-MM-DD
// ---------------------------------------------------------------------------
function parseDateRange(req) {
  const single = String(req.query.date || "").trim();
  const start = String(req.query.start || "").trim();
  const end = String(req.query.end || "").trim();

  let startDate = "";
  let endDate = "";

  if (start && end) {
    startDate = start;
    endDate = end;
  } else if (single) {
    startDate = single;
    endDate = single;
  } else {
    return { error: "missing_date_or_range" };
  }
  return { startDate, endDate };
}

function parseOptionalDateRange(req, defaultDays = 30) {
  const single = String(req.query.date || "").trim();
  const start = String(req.query.start || "").trim();
  const end = String(req.query.end || "").trim();

  if (start && end) return { startDate: start, endDate: end };
  if (single) return { startDate: single, endDate: single };

  const today = new Date();
  const endDate = today.toISOString().slice(0, 10);
  const startDateObj = new Date(today);
  startDateObj.setDate(startDateObj.getDate() - (defaultDays - 1));
  const startDate = startDateObj.toISOString().slice(0, 10);
  return { startDate, endDate };
}

function parseSyncLimit(raw, fallback = 200) {
  const num = Number(raw);
  if (!Number.isFinite(num)) return fallback;
  if (num < 1) return 1;
  return Math.min(Math.floor(num), 1000);
}

// ---------------------------------------------------------------------------
// CHANNEL SYNC MONITOR
// ---------------------------------------------------------------------------
app.get("/api/settings/sync", requireAuth, requirePerm("sync_admin"), (_req, res) => {
  res.json({ ok: true, settings: serializeWixSyncSettings() });
});

app.put("/api/settings/sync", requireAuth, requirePerm("sync_admin"), (req, res) => {
  const body = req.body || {};
  const current = serializeWixSyncSettings();
  const now = new Date();
  const frequency = normalizeWixScheduleFrequency(body.wix_scheduled_sync_frequency || current.scheduled_sync_frequency);
  const scheduledEnabled = body.wix_scheduled_sync_enabled !== undefined
    ? !!body.wix_scheduled_sync_enabled
    : !!current.scheduled_sync_enabled;
  const autoPushEnabled = body.wix_auto_sync_enabled !== undefined
    ? !!body.wix_auto_sync_enabled
    : !!current.auto_push_enabled;
  const shouldResetNextRun =
    scheduledEnabled &&
    (!current.scheduled_sync_enabled ||
      current.scheduled_sync_frequency !== frequency ||
      !current.scheduled_sync_next_run);

  try {
    const tx = db.transaction(() => {
      setPosSettingValue("wix_auto_sync_enabled", autoPushEnabled ? "1" : "0", req.user.id);
      setPosSettingValue("wix_scheduled_sync_enabled", scheduledEnabled ? "1" : "0", req.user.id);
      setPosSettingValue("wix_scheduled_sync_frequency", frequency, req.user.id);
      if (scheduledEnabled && shouldResetNextRun) {
        setPosSettingValue("wix_scheduled_sync_next_run", nextWixScheduleDate(now, frequency).toISOString(), req.user.id);
      } else if (!scheduledEnabled) {
        setPosSettingValue("wix_scheduled_sync_next_run", "", req.user.id);
      }
    });
    tx();
    logUserAction({
      userId: String(req.user.id || ""),
      username: req.user.username || "",
      action: "wix_sync_settings_saved",
      screen: "settings",
      metadata: { autoPushEnabled, scheduledEnabled, frequency }
    });
    res.json({ ok: true, settings: serializeWixSyncSettings() });
  } catch (err) {
    console.error("[API] /api/settings/sync failed:", err);
    res.status(500).json({ ok: false, error: "sync_settings_failed" });
  }
});

app.post("/api/wix/sync-all", requireAuth, requirePerm("sync_admin"), async (req, res) => {
  try {
    const summary = await syncAllActiveItemsToWix({ source: "manual", userId: req.user.id });
    setPosSettingValue("wix_manual_sync_last_run", summary.finishedAt, req.user.id);
    setPosSettingValue("wix_manual_sync_last_result", `Synced ${summary.succeeded}/${summary.attempted}; failed ${summary.failed}`, req.user.id);
    res.json({ ok: true, summary, settings: serializeWixSyncSettings() });
  } catch (err) {
    const msg = String(err.message || err);
    if (msg === "wix_not_configured") {
      return res.status(400).json({ ok: false, error: "wix_not_configured" });
    }
    if (msg === "sync_already_running") {
      return res.status(409).json({ ok: false, error: "sync_already_running" });
    }
    console.error("[API] /api/wix/sync-all failed:", err);
    res.status(500).json({ ok: false, error: "wix_sync_all_failed" });
  }
});

app.get(
  "/api/sync/log",
  requireAuth,
  requirePerm("sync_admin"),
  (req, res) => {
    const channel = String(req.query.channel || "wix").trim() || "wix";
    const limit = parseSyncLimit(req.query.limit, 200);

    const rows = db
      .prepare(
        `
        SELECT id, created_at, channel, action, sku, ok, message
        FROM channel_sync_log
        WHERE channel = ?
        ORDER BY id DESC
        LIMIT ?
      `
      )
      .all(channel, limit);

    res.json({ ok: true, channel, limit, rows });
  }
);

app.get(
  "/api/sync/status",
  requireAuth,
  requirePerm("sync_admin"),
  (req, res) => {
    const channel = String(req.query.channel || "wix").trim() || "wix";
    const limit = parseSyncLimit(req.query.limit, 200);

    const rows = db
      .prepare(
        `
        SELECT l.id, l.created_at, l.channel, l.action, l.sku, l.ok, l.message
        FROM channel_sync_log l
        JOIN (
          SELECT sku, MAX(id) AS max_id
          FROM channel_sync_log
          WHERE channel = ? AND COALESCE(sku,'') <> ''
          GROUP BY sku
        ) m ON l.sku = m.sku AND l.id = m.max_id
        ORDER BY l.id DESC
        LIMIT ?
      `
      )
      .all(channel, limit);

    res.json({ ok: true, channel, limit, rows });
  }
);

app.get(
  "/api/sync/lookup",
  requireAuth,
  requirePerm("sync_admin"),
  async (req, res) => {
    const channel = String(req.query.channel || "wix").trim() || "wix";
    const sku = String(req.query.sku || "").trim();

    if (!sku) {
      return res.status(400).json({ ok: false, error: "missing_sku" });
    }

    if (channel !== "wix") {
      return res.status(400).json({ ok: false, error: "unsupported_channel" });
    }

    if (!WIX_SYNC_ENABLED || !WIX_API_KEY || !WIX_SITE_ID) {
      return res.status(400).json({ ok: false, error: "wix_not_configured" });
    }

    try {
      const data = await wixRequest("/stores/v1/products/query", {
        method: "POST",
        body: {
          query: {
            filter: {
              sku: { $eq: sku }
            }
          }
        }
      });

      const product = data?.products?.[0] || null;
      res.json({
        ok: true,
        channel,
        sku,
        product: product
          ? {
              id: product.id || null,
              name: product.name || null,
              sku: product.sku || null,
              visible: Boolean(product.visible),
              stock: product?.stock?.quantity ?? null
            }
          : null
      });
    } catch (err) {
      console.error("[SYNC] lookup error:", err.message);
      res.status(500).json({ ok: false, error: "lookup_failed" });
    }
  }
);

// ---------------------------------------------------------------------------
// Dashboard endpoints (minimal analytics)
// ---------------------------------------------------------------------------
function parseRangeParam(range) {
  const r = String(range || "7d").toLowerCase().trim();
  if (r === "today") return { kind: "today", days: 1 };
  const m = r.match(/^(\d+)\s*d$/);
  if (m) return { kind: "days", days: Math.max(1, Number(m[1]) || 7) };
  return { kind: "days", days: 7 };
}

function salesWhereClause(alias, rangeInfo) {
  if (rangeInfo.kind === "today") {
    return { clause: `date(${alias}.created_at)=date('now')`, params: [] };
  }
  const daysBack = Math.max(1, rangeInfo.days) - 1;
  return { clause: `datetime(${alias}.created_at) >= datetime('now', ?)`, params: [`-${daysBack} days`] };
}

function toLevels(values) {
  const max = Math.max(0, ...values);
  if (!max) return values.map(() => 0);
  return values.map((v) => {
    const pct = v / max;
    if (pct <= 0.25) return 1;
    if (pct <= 0.55) return 2;
    return 3;
  });
}

app.get("/api/dashboard/summary", requireAuth, (req, res) => {
  const rangeInfo = parseRangeParam(req.query.range || "today");
  const salesWhere = salesWhereClause("s", rangeInfo);
  const refundWhere = salesWhereClause("r", rangeInfo);
  const marginWhere = salesWhereClause("dsl", rangeInfo);
  const tradeWhere = salesWhereClause("tq", rangeInfo);

  const grossRow = db
    .prepare(`SELECT COUNT(*) AS txns, COALESCE(SUM(total),0) AS total FROM sales s WHERE s.status='completed' AND ${salesWhere.clause}`)
    .get(...salesWhere.params);
  const itemsRow = db
    .prepare(
      `SELECT COALESCE(SUM(si.qty),0) AS qty
       FROM sale_items si
       JOIN sales s ON s.id=si.sale_id
       WHERE s.status='completed'
         AND (si.line_type IS NULL OR si.line_type!='discount')
         AND ${salesWhere.clause}`
    )
    .get(...salesWhere.params);
  const refundRow = db
    .prepare(
      `SELECT COALESCE(SUM(ri.line_total),0) AS total
       FROM refund_items ri
       JOIN refunds r ON r.id=ri.refund_id
       WHERE ${refundWhere.clause}`
    )
    .get(...refundWhere.params);

  const grossSales = Number(grossRow?.total || 0);
  const refundTotal = Number(refundRow?.total || 0);
  const netSales = grossSales - refundTotal;
  const itemsSold = Number(itemsRow?.qty || 0);

  const invRow = db.prepare(`SELECT COUNT(*) AS c FROM items WHERE deleted_at IS NULL`).get();
  const lowRow = db.prepare(`SELECT COUNT(*) AS c FROM items WHERE deleted_at IS NULL AND COALESCE(qty,0) <= 1`).get();
  const tradeOpenRow = db.prepare(`
    SELECT COUNT(*) AS c
    FROM trade_quotes
    WHERE status IN ('draft','presented')
  `).get();
  const tradeAcceptedRow = db.prepare(`
    SELECT COUNT(*) AS c
    FROM trade_quotes tq
    WHERE tq.status='accepted' AND ${tradeWhere.clause}
  `).get(...tradeWhere.params);
  const marginRow = db.prepare(`
    ${discountedSaleLinesCte()}
    SELECT COALESCE(SUM(dsl.net_line_total),0) AS revenue,
           COALESCE(SUM(COALESCE(i.cost,0) * dsl.qty),0) AS cost
    FROM discounted_sale_lines dsl
    LEFT JOIN items i ON i.id=dsl.item_id
    WHERE ${marginWhere.clause}
  `).get(...marginWhere.params);
  const revenueForMargin = Number(marginRow?.revenue || 0);
  const costForMargin = Number(marginRow?.cost || 0);
  const marginPct = revenueForMargin > 0
    ? ((revenueForMargin - costForMargin) / revenueForMargin) * 100
    : null;

  res.json({
    ok: true,
    range: req.query.range || "today",
    inventoryTotalItems: Number(invRow?.c || 0),
    todaySalesTotal: netSales,
    pendingTradeIns: Number(tradeOpenRow?.c || 0),
    acceptedTradeIns: Number(tradeAcceptedRow?.c || 0),
    lowStockCount: Number(lowRow?.c || 0),
    grossSales,
    refundTotal,
    netSales,
    itemsSold,
    transactionCount: Number(grossRow?.txns || 0),
    marginRevenue: revenueForMargin,
    marginCost: costForMargin,
    marginPct
  });
});

function buildSalesHeatmap(rangeInfo) {
  const salesWhere = salesWhereClause("s", rangeInfo);
  const rows = db
    .prepare(`SELECT created_at FROM sales s WHERE s.status='completed' AND ${salesWhere.clause}`)
    .all(...salesWhere.params);

  const cols = 7;
  const rowsCount = 4;
  const buckets = new Array(cols * rowsCount).fill(0);

  rows.forEach((r) => {
    const d = new Date(r.created_at);
    if (Number.isNaN(d.getTime())) return;
    const day = d.getDay();
    const hour = d.getHours();
    const band = hour < 6 ? 0 : hour < 12 ? 1 : hour < 18 ? 2 : 3;
    const idx = band * cols + day;
    buckets[idx] += 1;
  });

  const levels = toLevels(buckets);
  const maxVal = Math.max(0, ...buckets);
  let peakLabel = "No data yet";
  if (maxVal > 0) {
    const idx = buckets.indexOf(maxVal);
    const band = Math.floor(idx / cols);
    const day = idx % cols;
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const bandNames = ["overnight", "morning", "afternoon", "evening"];
    peakLabel = `peak: ${dayNames[day]} ${bandNames[band]}`;
  }
  return { grid: { rows: rowsCount, cols, levels }, summary: peakLabel, points: [] };
}

function buildCategoryMovement(rangeInfo) {
  const salesWhere = salesWhereClause("dsl", rangeInfo);
  const rows = db
    .prepare(
      `${discountedSaleLinesCte()}
       SELECT category,
              SUM(net_line_total) AS total,
              SUM(qty) AS qty
       FROM discounted_sale_lines dsl
       WHERE ${salesWhere.clause}
       GROUP BY category
       ORDER BY total DESC`
    )
    .all(...salesWhere.params);

  const cols = 6;
  const rowsCount = 3;
  const values = rows.map((r) => Number(r.total || 0));
  const levels = toLevels(values).slice(0, cols * rowsCount);
  while (levels.length < cols * rowsCount) levels.push(0);

  const points = rows.slice(0, 12).map((r) => {
    const sales = Number(r.total || 0);
    const qty = Number(r.qty || 0);
    const maxSales = Math.max(1, ...values);
    const maxQty = Math.max(1, ...rows.map((x) => Number(x.qty || 0)));
    return {
      x: Math.min(1, sales / maxSales),
      y: Math.min(1, qty / maxQty),
      name: r.category,
      detail: `${qty} sold - $${sales.toFixed(2)}`,
      secondary: false
    };
  });

  return {
    grid: { rows: rowsCount, cols, levels },
    summary: rows.length ? `top: ${rows[0].category}` : "No data yet",
    points
  };
}

function buildInventoryHealth(platform) {
  const plat = String(platform || "all").trim().toLowerCase();
  const rows = db
    .prepare(
      `SELECT COALESCE(platform,'Unknown') AS platform,
              SUM(qty) AS qty,
              COUNT(*) AS items
       FROM items
       WHERE deleted_at IS NULL
         ${plat !== "all" ? "AND lower(platform)=?" : ""}
       GROUP BY COALESCE(platform,'Unknown')
       ORDER BY qty DESC`
    )
    .all(...(plat !== "all" ? [plat] : []));

  const cols = 4;
  const rowsCount = 3;
  const values = rows.map((r) => Number(r.qty || 0));
  const levels = toLevels(values).slice(0, cols * rowsCount);
  while (levels.length < cols * rowsCount) levels.push(0);

  const maxQty = Math.max(1, ...values);
  const points = rows.slice(0, 12).map((r) => {
    const qty = Number(r.qty || 0);
    const norm = qty / maxQty;
    return {
      x: 1 - norm,
      y: norm,
      name: r.platform,
      detail: `${qty} units - ${r.items} items`,
      secondary: false
    };
  });

  return {
    platform: plat || "all",
    grid: { rows: rowsCount, cols, levels },
    summary: rows.length ? `watch: ${rows[rows.length - 1].platform}` : "No data yet",
    points
  };
}

function buildDormantInventory(ageBand) {
  const band = String(ageBand || "60d").toLowerCase();
  const rows = db
    .prepare(`SELECT title, qty, createdAt FROM items WHERE deleted_at IS NULL`)
    .all();

  const now = Date.now();
  const buckets = { "60d": 0, "90d": 0, "180d": 0, "360d": 0 };
  rows.forEach((r) => {
    const ts = r.createdAt ? new Date(r.createdAt).getTime() : NaN;
    if (!Number.isFinite(ts)) return;
    const days = Math.floor((now - ts) / (1000 * 60 * 60 * 24));
    if (days <= 60) buckets["60d"] += 1;
    else if (days <= 90) buckets["90d"] += 1;
    else if (days <= 180) buckets["180d"] += 1;
    else buckets["360d"] += 1;
  });

  const cols = 5;
  const rowsCount = 2;
  const values = [buckets["60d"], buckets["90d"], buckets["180d"], buckets["360d"], 0];
  const levels = toLevels(values);
  while (levels.length < cols * rowsCount) levels.push(0);

  return {
    ageBand: band,
    grid: { rows: rowsCount, cols, levels },
    summary: rows.length ? "oldest: 180+ days" : "No data yet",
    points: []
  };
}

function buildTradeinFlow(rangeInfo) {
  const where = salesWhereClause("tq", rangeInfo);
  const rows = db.prepare(`
    SELECT status,
           COUNT(*) AS quote_count,
           COALESCE(SUM(total_items),0) AS total_items,
           COALESCE(SUM(total_cash),0) AS total_cash,
           COALESCE(SUM(total_credit),0) AS total_credit,
           COALESCE(SUM(total_retail),0) AS total_retail
    FROM trade_quotes tq
    WHERE ${where.clause.replaceAll("tq.created_at", "tq.created_at")}
    GROUP BY status
    ORDER BY quote_count DESC
  `).all(...where.params);
  const cols = 5;
  const rowsCount = 2;
  const values = rows.map((r) => Number(r.quote_count || 0));
  const levels = toLevels(values).slice(0, cols * rowsCount);
  while (levels.length < cols * rowsCount) levels.push(0);
  const totalQuotes = rows.reduce((sum, r) => sum + Number(r.quote_count || 0), 0);
  const accepted = rows.find((r) => r.status === "accepted");
  const points = rows.map((r, idx) => ({
    x: rows.length <= 1 ? 0.5 : idx / Math.max(1, rows.length - 1),
    y: Math.min(1, Number(r.quote_count || 0) / Math.max(1, ...values)),
    name: r.status,
    detail: `${Number(r.quote_count || 0)} quotes - $${Number(r.total_credit || 0).toFixed(2)} credit`,
    secondary: r.status !== "accepted"
  }));
  return {
    grid: { rows: rowsCount, cols, levels },
    summary: totalQuotes ? `${totalQuotes} quotes, ${Number(accepted?.quote_count || 0)} accepted` : "No trade-in quotes yet",
    points,
    rows
  };
}

app.get("/api/dashboard/heatmap", requireAuth, (req, res) => {
  const rangeInfo = parseRangeParam(req.query.range || "7d");
  const data = buildSalesHeatmap(rangeInfo);
  res.json({ ok: true, range: req.query.range || "7d", ...data });
});

app.get("/api/dashboard/category-movement", requireAuth, (req, res) => {
  const rangeInfo = parseRangeParam(req.query.range || "7d");
  const data = buildCategoryMovement(rangeInfo);
  res.json({ ok: true, range: req.query.range || "7d", ...data });
});

app.get("/api/dashboard/inventory-health", requireAuth, (req, res) => {
  const data = buildInventoryHealth(req.query.platform || "all");
  res.json({ ok: true, ...data });
});

app.get("/api/dashboard/dormant-inventory", requireAuth, (req, res) => {
  const data = buildDormantInventory(req.query.ageBand || "60d");
  res.json({ ok: true, ...data });
});

app.get("/api/dashboard/tradein-flow", requireAuth, (req, res) => {
  const rangeInfo = parseRangeParam(req.query.range || "30d");
  const data = buildTradeinFlow(rangeInfo);
  res.json({ ok: true, range: req.query.range || "30d", ...data });
});

app.get("/api/dashboard/widgets", requireAuth, (req, res) => {
  const rangeInfo = parseRangeParam(req.query.range || "7d");
  res.json({
    ok: true,
    range: req.query.range || "7d",
    weeklySalesHeatmap: buildSalesHeatmap(rangeInfo),
    categoryMovement: buildCategoryMovement(rangeInfo),
    inventoryHealth: buildInventoryHealth("all"),
    dormantInventory: buildDormantInventory("60d"),
    tradeInFlow: buildTradeinFlow(rangeInfo)
  });
});

function eventReportRows(startDate, endDate) {
  return db.prepare(`
    SELECT le.id, le.name, le.channel, le.status, le.created_at, le.updated_at, le.finalized_at,
           le.backend_sale_id, s.total AS sale_total, s.status AS sale_status
    FROM live_events le
    LEFT JOIN sales s ON s.id = le.backend_sale_id
    WHERE date(le.created_at) BETWEEN date(@start) AND date(@end)
    ORDER BY datetime(le.updated_at) DESC, le.id DESC
  `).all({ start: startDate, end: endDate });
}

function sendEventsList(req, res) {
  const { startDate, endDate } = parseOptionalDateRange(req, 90);
  try {
    const rows = eventReportRows(startDate, endDate);
    res.json({ ok: true, range: { start: startDate, end: endDate }, rows });
  } catch (e) {
    console.error("[API] events list failed:", e);
    res.status(500).json({ ok: false, error: "events_list_failed" });
  }
}

app.get("/api/reports/events/list", requireAuth, requireReports, sendEventsList);
app.get("/api/events/list", requireAuth, requireReports, sendEventsList);

app.get("/api/reports/dashboard", requireAuth, requireReports, (req, res) => {
  const { startDate, endDate } = parseOptionalDateRange(req, 30);
  try {
    const sales = db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total, COALESCE(SUM(tax),0) AS tax
      FROM sales
      WHERE status='completed' AND date(created_at) BETWEEN date(@start) AND date(@end)
    `).get({ start: startDate, end: endDate });
    const discounts = db.prepare(`
      SELECT COALESCE(SUM(ABS(line_total)),0) AS total, COUNT(*) AS count
      FROM sale_items si
      JOIN sales s ON s.id=si.sale_id
      WHERE s.status='completed'
        AND si.line_type='discount'
        AND date(s.created_at) BETWEEN date(@start) AND date(@end)
    `).get({ start: startDate, end: endDate });
    const events = eventReportRows(startDate, endDate);
    const waste = db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(qty),0) AS units, COALESCE(SUM(totalCost),0) AS cost
      FROM waste_log
      WHERE date(createdAt) BETWEEN date(@start) AND date(@end)
    `).get({ start: startDate, end: endDate });
    const trade = db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(total_items),0) AS items,
             COALESCE(SUM(total_cash),0) AS cash, COALESCE(SUM(total_credit),0) AS credit
      FROM trade_quotes
      WHERE date(created_at) BETWEEN date(@start) AND date(@end)
    `).get({ start: startDate, end: endDate });
    res.json({
      ok: true,
      range: { start: startDate, end: endDate },
      summary: {
        sales_count: Number(sales?.count || 0),
        sales_total: Number(sales?.total || 0),
        tax_total: Number(sales?.tax || 0),
        discount_count: Number(discounts?.count || 0),
        discount_total: Number(discounts?.total || 0),
        event_count: events.length,
        event_sales_total: events.reduce((sum, e) => sum + Number(e.sale_total || 0), 0),
        waste_events: Number(waste?.count || 0),
        waste_units: Number(waste?.units || 0),
        waste_cost: Number(waste?.cost || 0),
        trade_quotes: Number(trade?.count || 0),
        trade_items: Number(trade?.items || 0),
        trade_cash: Number(trade?.cash || 0),
        trade_credit: Number(trade?.credit || 0)
      }
    });
  } catch (e) {
    console.error("[API] /api/reports/dashboard failed:", e);
    res.status(500).json({ ok: false, error: "reports_dashboard_failed" });
  }
});

app.get("/api/reports/discounts", requireAuth, requireReports, (req, res) => {
  const { startDate, endDate } = parseOptionalDateRange(req, 30);
  try {
    const rows = db.prepare(`
      SELECT s.id AS sale_id, s.created_at, s.user_id, u.username,
             ABS(SUM(si.line_total)) AS discount_total
      FROM sale_items si
      JOIN sales s ON s.id=si.sale_id
      LEFT JOIN users u ON u.id=s.user_id
      WHERE s.status='completed'
        AND si.line_type='discount'
        AND date(s.created_at) BETWEEN date(@start) AND date(@end)
      GROUP BY s.id
      ORDER BY datetime(s.created_at) DESC
    `).all({ start: startDate, end: endDate });
    res.json({
      ok: true,
      range: { start: startDate, end: endDate },
      summary: {
        count: rows.length,
        total: rows.reduce((sum, r) => sum + Number(r.discount_total || 0), 0)
      },
      rows
    });
  } catch (e) {
    console.error("[API] /api/reports/discounts failed:", e);
    res.status(500).json({ ok: false, error: "discount_report_failed" });
  }
});

app.get("/api/reports/fees", requireAuth, requireReports, (req, res) => {
  const { startDate, endDate } = parseOptionalDateRange(req, 30);
  try {
    const rows = db.prepare(`
      SELECT s.id AS sale_id, s.created_at, si.title, si.sku, si.line_total AS fee_total
      FROM sale_items si
      JOIN sales s ON s.id=si.sale_id
      WHERE s.status='completed'
        AND si.line_type='fee'
        AND date(s.created_at) BETWEEN date(@start) AND date(@end)
      ORDER BY datetime(s.created_at) DESC
    `).all({ start: startDate, end: endDate });
    res.json({
      ok: true,
      range: { start: startDate, end: endDate },
      summary: {
        count: rows.length,
        total: rows.reduce((sum, r) => sum + Number(r.fee_total || 0), 0)
      },
      rows
    });
  } catch (e) {
    console.error("[API] /api/reports/fees failed:", e);
    res.status(500).json({ ok: false, error: "fee_report_failed" });
  }
});

app.get("/api/reports/store-credit", requireAuth, requireReports, (req, res) => {
  const { startDate, endDate } = parseOptionalDateRange(req, 30);
  try {
    const rows = db.prepare(`
      SELECT ca.id, ca.created_at, ca.customer_id, c.name AS customer_name,
             ca.amount_cents, ROUND(ca.amount_cents / 100.0, 2) AS amount,
             ca.reason, ca.user_id,
             COALESCE(NULLIF(u.display_name,''), u.username, '') AS username
      FROM customer_adjustments ca
      LEFT JOIN customers c ON c.id=ca.customer_id
      LEFT JOIN users u ON u.id=ca.user_id
      WHERE date(ca.created_at) BETWEEN date(@start) AND date(@end)
      ORDER BY datetime(ca.created_at) DESC, ca.id DESC
      LIMIT 1000
    `).all({ start: startDate, end: endDate });
    const balance = db.prepare(`
      SELECT COALESCE(SUM(store_credit_cents),0) AS current_balance_cents
      FROM customers
      WHERE active = 1
    `).get() || { current_balance_cents: 0 };
    const summary = rows.reduce((acc, r) => {
      const cents = Number(r.amount_cents || 0);
      acc.count += 1;
      acc.net_cents += cents;
      if (cents > 0) acc.issued_cents += cents;
      if (cents < 0) acc.redeemed_cents += Math.abs(cents);
      return acc;
    }, { count: 0, issued_cents: 0, redeemed_cents: 0, net_cents: 0 });
    summary.current_balance_cents = Number(balance.current_balance_cents || 0);
    res.json({ ok: true, range: { start: startDate, end: endDate }, summary, rows });
  } catch (e) {
    console.error("[API] /api/reports/store-credit failed:", e);
    res.status(500).json({ ok: false, error: "store_credit_report_failed" });
  }
});

app.get("/api/reports/staff-performance", requireAuth, requireReports, (req, res) => {
  const { startDate, endDate } = parseOptionalDateRange(req, 30);
  try {
    const salesRows = db.prepare(`
      SELECT COALESCE(CAST(s.user_id AS TEXT),'unassigned') AS user_key,
             s.user_id,
             COALESCE(NULLIF(u.display_name,''), u.username, 'Unassigned') AS username,
             COALESCE(u.role, '') AS role,
             COUNT(*) AS transactions,
             COALESCE(SUM(s.subtotal),0) AS subtotal,
             COALESCE(SUM(s.tax),0) AS tax,
             COALESCE(SUM(s.total),0) AS total
      FROM sales s
      LEFT JOIN users u ON u.id=s.user_id
      WHERE s.status='completed'
        AND date(s.created_at) BETWEEN date(@start) AND date(@end)
      GROUP BY COALESCE(CAST(s.user_id AS TEXT),'unassigned'), s.user_id, username, role
      ORDER BY total DESC
    `).all({ start: startDate, end: endDate });

    const itemRows = db.prepare(`
      SELECT COALESCE(CAST(s.user_id AS TEXT),'unassigned') AS user_key,
             COALESCE(SUM(CASE WHEN si.line_type='item' THEN si.qty ELSE 0 END),0) AS items_sold
      FROM sales s
      LEFT JOIN sale_items si ON si.sale_id=s.id
      WHERE s.status='completed'
        AND date(s.created_at) BETWEEN date(@start) AND date(@end)
      GROUP BY COALESCE(CAST(s.user_id AS TEXT),'unassigned')
    `).all({ start: startDate, end: endDate });

    const discountRows = db.prepare(`
      SELECT COALESCE(CAST(s.user_id AS TEXT),'unassigned') AS user_key,
             COUNT(DISTINCT s.id) AS discount_transactions,
             COALESCE(SUM(ABS(si.line_total)),0) AS discount_total
      FROM sale_items si
      JOIN sales s ON s.id=si.sale_id
      WHERE s.status='completed'
        AND si.line_type='discount'
        AND date(s.created_at) BETWEEN date(@start) AND date(@end)
      GROUP BY COALESCE(CAST(s.user_id AS TEXT),'unassigned')
    `).all({ start: startDate, end: endDate });

    const refundRows = db.prepare(`
      SELECT COALESCE(CAST(r.user_id AS TEXT),'unassigned') AS user_key,
             COUNT(DISTINCT r.id) AS refund_count,
             COALESCE(SUM(ri.line_total),0) AS refund_total
      FROM refunds r
      LEFT JOIN refund_items ri ON ri.refund_id=r.id
      WHERE date(r.created_at) BETWEEN date(@start) AND date(@end)
      GROUP BY COALESCE(CAST(r.user_id AS TEXT),'unassigned')
    `).all({ start: startDate, end: endDate });

    const voidRows = db.prepare(`
      SELECT COALESCE(CAST(s.user_id AS TEXT),'unassigned') AS user_key,
             COUNT(*) AS void_count,
             COALESCE(SUM(s.total),0) AS void_total
      FROM sales s
      WHERE s.status='voided'
        AND date(s.created_at) BETWEEN date(@start) AND date(@end)
      GROUP BY COALESCE(CAST(s.user_id AS TEXT),'unassigned')
    `).all({ start: startDate, end: endDate });

    const rowMap = new Map();
    for (const row of salesRows) {
      rowMap.set(row.user_key, {
        user_key: row.user_key,
        user_id: row.user_id,
        username: row.username || "Unassigned",
        role: row.role || "",
        transactions: Number(row.transactions || 0),
        items_sold: 0,
        subtotal: Number(row.subtotal || 0),
        tax: Number(row.tax || 0),
        total: Number(row.total || 0),
        discount_transactions: 0,
        discount_total: 0,
        refund_count: 0,
        refund_total: 0,
        void_count: 0,
        void_total: 0
      });
    }
    function ensureRow(userKey) {
      if (!rowMap.has(userKey)) {
        rowMap.set(userKey, {
          user_key: userKey,
          user_id: userKey === "unassigned" ? null : Number(userKey),
          username: "Unassigned",
          role: "",
          transactions: 0,
          items_sold: 0,
          subtotal: 0,
          tax: 0,
          total: 0,
          discount_transactions: 0,
          discount_total: 0,
          refund_count: 0,
          refund_total: 0,
          void_count: 0,
          void_total: 0
        });
      }
      return rowMap.get(userKey);
    }
    for (const row of itemRows) ensureRow(row.user_key).items_sold = Number(row.items_sold || 0);
    for (const row of discountRows) {
      const target = ensureRow(row.user_key);
      target.discount_transactions = Number(row.discount_transactions || 0);
      target.discount_total = Number(row.discount_total || 0);
    }
    for (const row of refundRows) {
      const target = ensureRow(row.user_key);
      target.refund_count = Number(row.refund_count || 0);
      target.refund_total = Number(row.refund_total || 0);
    }
    for (const row of voidRows) {
      const target = ensureRow(row.user_key);
      target.void_count = Number(row.void_count || 0);
      target.void_total = Number(row.void_total || 0);
    }

    const rows = Array.from(rowMap.values()).sort((a, b) => b.total - a.total);
    const summary = rows.reduce((acc, row) => {
      acc.transactions += row.transactions;
      acc.items_sold += row.items_sold;
      acc.total += row.total;
      acc.discount_total += row.discount_total;
      acc.refund_total += row.refund_total;
      acc.void_total += row.void_total;
      return acc;
    }, { transactions: 0, items_sold: 0, total: 0, discount_total: 0, refund_total: 0, void_total: 0 });

    res.json({ ok: true, range: { start: startDate, end: endDate }, summary, rows });
  } catch (e) {
    console.error("[API] /api/reports/staff-performance failed:", e);
    res.status(500).json({ ok: false, error: "staff_performance_report_failed" });
  }
});

app.get("/api/reports/event-summary", requireAuth, requireReports, (req, res) => {
  const { startDate, endDate } = parseOptionalDateRange(req, 90);
  try {
    const rows = db.prepare(`
      SELECT COALESCE(le.channel,'other') AS channel,
             COALESCE(le.status,'draft') AS status,
             COUNT(*) AS event_count,
             COALESCE(SUM(s.total),0) AS sales_total
      FROM live_events le
      LEFT JOIN sales s ON s.id = le.backend_sale_id
      WHERE date(le.created_at) BETWEEN date(@start) AND date(@end)
      GROUP BY COALESCE(le.channel,'other'), COALESCE(le.status,'draft')
      ORDER BY event_count DESC, sales_total DESC
    `).all({ start: startDate, end: endDate });
    res.json({ ok: true, range: { start: startDate, end: endDate }, rows });
  } catch (e) {
    console.error("[API] /api/reports/event-summary failed:", e);
    res.status(500).json({ ok: false, error: "event_summary_failed" });
  }
});

app.get("/api/reports/event-items", requireAuth, requireReports, (req, res) => {
  const { startDate, endDate } = parseOptionalDateRange(req, 90);
  try {
    const events = db.prepare(`
      SELECT id, name, channel, status, payload_json, created_at, updated_at
      FROM live_events
      WHERE date(created_at) BETWEEN date(@start) AND date(@end)
      ORDER BY datetime(updated_at) DESC
    `).all({ start: startDate, end: endDate });
    const rows = [];
    for (const ev of events) {
      const payload = parseJsonObject(ev.payload_json, {});
      for (const line of Array.isArray(payload.lines) ? payload.lines : []) {
        rows.push({
          event_id: ev.id,
          event_name: ev.name,
          channel: ev.channel,
          status: ev.status,
          sku: line.sku || "",
          title: line.title || "",
          qty: Number(line.qtySold || line.qty || 0),
          list_price: Number(line.listPrice || 0),
          sell_price: Number(line.sellPrice || 0),
          cost: Number(line.cost || 0)
        });
      }
    }
    res.json({ ok: true, range: { start: startDate, end: endDate }, rows });
  } catch (e) {
    console.error("[API] /api/reports/event-items failed:", e);
    res.status(500).json({ ok: false, error: "event_items_failed" });
  }
});

app.get("/api/reports/waste-analytics", requireAuth, requireReports, (req, res) => {
  const { startDate, endDate } = parseOptionalDateRange(req, 30);
  try {
    const byReason = db.prepare(`
      SELECT COALESCE(NULLIF(reason,''),'unspecified') AS reason,
             COUNT(*) AS events,
             COALESCE(SUM(qty),0) AS units,
             COALESCE(SUM(totalCost),0) AS cost,
             COALESCE(SUM(totalPrice),0) AS price
      FROM waste_log
      WHERE date(createdAt) BETWEEN date(@start) AND date(@end)
      GROUP BY COALESCE(NULLIF(reason,''),'unspecified')
      ORDER BY cost DESC, units DESC
    `).all({ start: startDate, end: endDate });
    const byCategory = db.prepare(`
      SELECT COALESCE(NULLIF(category,''),'uncategorized') AS category,
             COUNT(*) AS events,
             COALESCE(SUM(qty),0) AS units,
             COALESCE(SUM(totalCost),0) AS cost,
             COALESCE(SUM(totalPrice),0) AS price
      FROM waste_log
      WHERE date(createdAt) BETWEEN date(@start) AND date(@end)
      GROUP BY COALESCE(NULLIF(category,''),'uncategorized')
      ORDER BY cost DESC, units DESC
    `).all({ start: startDate, end: endDate });
    res.json({
      ok: true,
      range: { start: startDate, end: endDate },
      summary: {
        events: byReason.reduce((sum, r) => sum + Number(r.events || 0), 0),
        units: byReason.reduce((sum, r) => sum + Number(r.units || 0), 0),
        cost: byReason.reduce((sum, r) => sum + Number(r.cost || 0), 0),
        price: byReason.reduce((sum, r) => sum + Number(r.price || 0), 0)
      },
      byReason,
      byCategory
    });
  } catch (e) {
    console.error("[API] /api/reports/waste-analytics failed:", e);
    res.status(500).json({ ok: false, error: "waste_analytics_failed" });
  }
});
app.get("/api/reports/sales-by-item", requireAuth, requireReports, (req, res) => {
  const range = parseDateRange(req);
  if (range.error) return res.status(400).json({ ok: false, error: range.error });
  const { startDate, endDate } = range;

  try {
    const soldRows = db.prepare(
      `
      ${discountedSaleLinesCte()}
      SELECT
        item_id,
        sku,
        title,
        SUM(qty) AS sold_qty,
        SUM(gross_line_total) AS gross_sold_total,
        SUM(discount_allocated) AS discount_allocated,
        SUM(net_line_total) AS sold_total
      FROM discounted_sale_lines
      WHERE date(created_at) BETWEEN date(@start) AND date(@end)
      GROUP BY item_id, sku, title
    `
    ).all({ start: startDate, end: endDate });

    const refundRows = db.prepare(
      `
      ${discountedSaleLinesCte()}
      SELECT
        dsl.item_id,
        dsl.sku,
        SUM(ri.qty_refunded) AS refunded_qty,
        SUM(ri.line_total) AS gross_refunded_total,
        SUM(
          CASE
            WHEN COALESCE(dsl.qty,0) > 0 THEN (dsl.net_line_total / dsl.qty) * ri.qty_refunded
            ELSE ri.line_total
          END
        ) AS refunded_total
      FROM refund_items ri
      JOIN refunds r ON r.id = ri.refund_id
      JOIN discounted_sale_lines dsl ON dsl.sale_item_id = ri.sale_item_id
      WHERE date(r.created_at) BETWEEN date(@start) AND date(@end)
      GROUP BY dsl.item_id, dsl.sku
    `
    ).all({ start: startDate, end: endDate });

    const refundsByItem = new Map();
    for (const r of refundRows) {
      refundsByItem.set(String(r.item_id || r.sku || ""), {
        refunded_qty: Number(r.refunded_qty || 0),
        refunded_total: Number(r.refunded_total || 0),
        gross_refunded_total: Number(r.gross_refunded_total || 0)
      });
    }

    const rows = soldRows.map((s) => {
      const r = refundsByItem.get(String(s.item_id || s.sku || "")) || { refunded_qty: 0, refunded_total: 0, gross_refunded_total: 0 };
      const sold_qty = Number(s.sold_qty || 0);
      const sold_total = Number(s.sold_total || 0);
      const net_qty = Math.max(0, sold_qty - Number(r.refunded_qty || 0));
      const net_total = Number((sold_total - Number(r.refunded_total || 0)).toFixed(2));
      return {
        item_id: s.item_id,
        sku: s.sku,
        title: s.title || "",
        sold_qty,
        gross_sold_total: Number(s.gross_sold_total || 0),
        discount_allocated: Number(s.discount_allocated || 0),
        sold_total: Number(sold_total.toFixed(2)),
        refunded_qty: Number(r.refunded_qty || 0),
        refunded_total: Number(r.refunded_total || 0),
        gross_refunded_total: Number(r.gross_refunded_total || 0),
        net_qty,
        net_total
      };
    }).sort((a, b) => b.net_total - a.net_total);

    res.json({ ok: true, range: { start: startDate, end: endDate }, rows });
  } catch (e) {
    console.error("[API] /api/reports/sales-by-item failed:", e);
    res.status(500).json({ ok: false, error: "sales_by_item_failed" });
  }
});

app.get("/api/reports/sales-by-category", requireAuth, requireReports, (req, res) => {
  const range = parseDateRange(req);
  if (range.error) return res.status(400).json({ ok: false, error: range.error });
  const { startDate, endDate } = range;

  try {
    const soldRows = db.prepare(
      `
      ${discountedSaleLinesCte()}
      SELECT
        category,
        SUM(qty) AS sold_qty,
        SUM(gross_line_total) AS gross_sold_total,
        SUM(discount_allocated) AS discount_allocated,
        SUM(net_line_total) AS sold_total
      FROM discounted_sale_lines
      WHERE date(created_at) BETWEEN date(@start) AND date(@end)
      GROUP BY category
    `
    ).all({ start: startDate, end: endDate });

    const refundRows = db.prepare(
      `
      ${discountedSaleLinesCte()}
      SELECT
        dsl.category,
        SUM(ri.qty_refunded) AS refunded_qty,
        SUM(ri.line_total) AS gross_refunded_total,
        SUM(
          CASE
            WHEN COALESCE(dsl.qty,0) > 0 THEN (dsl.net_line_total / dsl.qty) * ri.qty_refunded
            ELSE ri.line_total
          END
        ) AS refunded_total
      FROM refund_items ri
      JOIN refunds r ON r.id = ri.refund_id
      JOIN discounted_sale_lines dsl ON dsl.sale_item_id = ri.sale_item_id
      WHERE date(r.created_at) BETWEEN date(@start) AND date(@end)
      GROUP BY dsl.category
    `
    ).all({ start: startDate, end: endDate });

    const refundsByCat = new Map();
    for (const r of refundRows) {
      refundsByCat.set(String(r.category), {
        refunded_qty: Number(r.refunded_qty || 0),
        refunded_total: Number(r.refunded_total || 0),
        gross_refunded_total: Number(r.gross_refunded_total || 0)
      });
    }

    const rows = soldRows.map((s) => {
      const r = refundsByCat.get(String(s.category)) || { refunded_qty: 0, refunded_total: 0, gross_refunded_total: 0 };
      const sold_qty = Number(s.sold_qty || 0);
      const sold_total = Number(s.sold_total || 0);
      const net_qty = Math.max(0, sold_qty - Number(r.refunded_qty || 0));
      const net_total = Number((sold_total - Number(r.refunded_total || 0)).toFixed(2));
      return {
        category: s.category,
        sold_qty,
        gross_sold_total: Number(s.gross_sold_total || 0),
        discount_allocated: Number(s.discount_allocated || 0),
        sold_total: Number(sold_total.toFixed(2)),
        refunded_qty: Number(r.refunded_qty || 0),
        refunded_total: Number(r.refunded_total || 0),
        gross_refunded_total: Number(r.gross_refunded_total || 0),
        net_qty,
        net_total
      };
    }).sort((a, b) => b.net_total - a.net_total);

    res.json({ ok: true, range: { start: startDate, end: endDate }, rows });
  } catch (e) {
    console.error("[API] /api/reports/sales-by-category failed:", e);
    res.status(500).json({ ok: false, error: "sales_by_category_failed" });
  }
});

app.get("/api/reports/payment-mix", requireAuth, requireReports, (req, res) => {
  const range = parseDateRange(req);
  if (range.error) return res.status(400).json({ ok: false, error: range.error });
  const { startDate, endDate } = range;

  try {
    const rows = db.prepare(
      `
      SELECT
        COALESCE(payment_method,'unknown') AS method,
        COALESCE(SUM(total),0) AS total,
        COALESCE(SUM(total),0) AS amount
      FROM sales
      WHERE status = 'completed'
        AND date(created_at) BETWEEN date(@start) AND date(@end)
      GROUP BY COALESCE(payment_method,'unknown')
      ORDER BY total DESC
    `
    ).all({ start: startDate, end: endDate });

    res.json({ ok: true, range: { start: startDate, end: endDate }, rows });
  } catch (e) {
    console.error("[API] /api/reports/payment-mix failed:", e);
    res.status(500).json({ ok: false, error: "payment_mix_failed" });
  }
});

app.get("/api/reports/inventory", requireAuth, requireReports, (_req, res) => {
  try {
    const items = db.prepare(`SELECT * FROM items WHERE deleted_at IS NULL ORDER BY createdAt DESC, id DESC`).all();
    const now = Date.now();
    const rows = items.map((it) => {
      const qty = Number(it.qty || 0);
      const price = Number(it.price || 0);
      const cost = Number(it.cost || 0);
      const createdAt = it.createdAt || "";
      let ageDays = 0;
      if (createdAt) {
        const ts = new Date(createdAt).getTime();
        if (!Number.isNaN(ts)) {
          ageDays = Math.max(0, Math.floor((now - ts) / (24 * 60 * 60 * 1000)));
        }
      }
      return {
        id: it.id,
        sku: it.sku || "",
        title: it.title || "",
        platform: it.platform || "",
        category: it.category || "",
        condition: it.condition || "",
        qty,
        cost,
        price,
        createdAt,
        ageDays,
        value: Number((price * qty).toFixed(2))
      };
    });

    const summary = rows.reduce(
      (acc, it) => {
        acc.itemCount += 1;
        acc.totalUnits += it.qty;
        acc.totalValue += it.price * it.qty;
        acc.totalCost += it.cost * it.qty;
        if (it.qty <= 1) acc.lowStockCount += 1;
        if (it.qty === 0) acc.zeroStockCount += 1;
        return acc;
      },
      { itemCount: 0, totalUnits: 0, totalValue: 0, totalCost: 0, lowStockCount: 0, zeroStockCount: 0 }
    );
    summary.totalValue = Number(summary.totalValue.toFixed(2));
    summary.totalCost = Number(summary.totalCost.toFixed(2));
    summary.totalProfit = Number((summary.totalValue - summary.totalCost).toFixed(2));

    const agingBuckets = [
      { label: "0-30", min: 0, max: 30, count: 0, value: 0 },
      { label: "31-90", min: 31, max: 90, count: 0, value: 0 },
      { label: "91-180", min: 91, max: 180, count: 0, value: 0 },
      { label: "181+", min: 181, max: Infinity, count: 0, value: 0 }
    ];
    for (const it of rows) {
      const b = agingBuckets.find((x) => it.ageDays >= x.min && it.ageDays <= x.max);
      if (b) {
        b.count += 1;
        b.value += it.value;
      }
    }
    for (const b of agingBuckets) b.value = Number(b.value.toFixed(2));

    const byPlatformMap = new Map();
    const byCategoryMap = new Map();
    for (const it of rows) {
      const p = it.platform || "(no platform)";
      const c = it.category || "(uncategorized)";
      const pRow = byPlatformMap.get(p) || { platform: p, count: 0, units: 0, value: 0 };
      pRow.count += 1;
      pRow.units += it.qty;
      pRow.value += it.value;
      byPlatformMap.set(p, pRow);

      const cRow = byCategoryMap.get(c) || { category: c, count: 0, units: 0, value: 0 };
      cRow.count += 1;
      cRow.units += it.qty;
      cRow.value += it.value;
      byCategoryMap.set(c, cRow);
    }
    const byPlatform = Array.from(byPlatformMap.values()).sort((a, b) => b.value - a.value);
    const byCategory = Array.from(byCategoryMap.values()).sort((a, b) => b.value - a.value);

    const lowStock = rows.filter((it) => it.qty <= 1).sort((a, b) => a.qty - b.qty);
    const zeroStock = rows.filter((it) => it.qty === 0);
    const topValue = rows.slice().sort((a, b) => b.value - a.value).slice(0, 50);

    res.json({
      ok: true,
      asOf: new Date().toISOString(),
      summary,
      agingBuckets,
      byPlatform,
      byCategory,
      lowStock,
      zeroStock,
      topValue,
      items: rows
    });
  } catch (e) {
    console.error("[API] /api/reports/inventory failed:", e);
    res.status(500).json({ ok: false, error: "inventory_report_failed" });
  }
});
app.get("/api/reports/daily-sales", requireAuth, requireReports, (req, res) => {
  const single = String(req.query.date || "").trim();
  const start = String(req.query.start || "").trim();
  const end   = String(req.query.end || "").trim();

  let startDate = "";
  let endDate = "";

  if (start && end) {
    // range mode
    startDate = start;
    endDate = end;
  } else if (single) {
    // backwards compatible: single-day mode
    startDate = single;
    endDate = single;
  } else {
    return res.status(400).json({ ok: false, error: "missing_date_or_range" });
  }

  try {
    const summary = db
      .prepare(
        `
        SELECT
          COUNT(*)                  AS transactionCount,
          COALESCE(SUM(subtotal),0) AS subtotal,
          COALESCE(SUM(tax),0)      AS tax,
          COALESCE(SUM(total),0)    AS total
        FROM sales
        WHERE date(created_at) BETWEEN date(@start) AND date(@end)
          AND status = 'completed'
      `
      )
      .get({ start: startDate, end: endDate }) || {};

    const refundsTotal = db
      .prepare(
        `
        SELECT COALESCE(SUM(ri.line_total),0) AS total
        FROM refunds r
        JOIN refund_items ri ON ri.refund_id = r.id
        WHERE date(r.created_at) BETWEEN date(@start) AND date(@end)
      `
      )
      .get({ start: startDate, end: endDate }) || { total: 0 };

    const discountTotal = db
      .prepare(
        `
        SELECT COALESCE(SUM(-si.line_total),0) AS total
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id
        WHERE date(s.created_at) BETWEEN date(@start) AND date(@end)
          AND s.status = 'completed'
          AND si.line_type = 'discount'
      `
      )
      .get({ start: startDate, end: endDate }) || { total: 0 };

    const payments = db
      .prepare(
        `
        SELECT
          COALESCE(payment_method,'unknown') AS method,
          COALESCE(SUM(total),0)             AS amount
        FROM sales
        WHERE date(created_at) BETWEEN date(@start) AND date(@end)
          AND status = 'completed'
        GROUP BY payment_method
        ORDER BY amount DESC
      `
      )
      .all({ start: startDate, end: endDate });

    const label =
      startDate === endDate ? startDate : `${startDate}..${endDate}`;

    res.json({
      ok: true,
      date: label, // keeps your existing frontend happy (it reads data.date)
      range: { start: startDate, end: endDate },
      summary: {
        transactionCount: Number(summary.transactionCount || 0),
        subtotal: Number(summary.subtotal || 0),
        tax: Number(summary.tax || 0),
        discount: Number(discountTotal.total || 0),
        fees: 0,
        total: Number(summary.total || 0),
        refunds: Number(refundsTotal.total || 0),
        net: Number((Number(summary.total || 0) - Number(refundsTotal.total || 0)).toFixed(2))
      },
      payments: payments.map((p) => ({
        method: p.method || "unknown",
        amount: Number(p.amount || 0),
        total: Number(p.amount || 0)
      }))
    });
  } catch (e) {
    console.error("[API] /api/reports/daily-sales failed:", e);
    res.status(500).json({ ok: false, error: "report_failed" });
  }
});


// ---------------------------------------------------------------------------
// REPORTS: Write-Offs / Waste (single date OR range)
// GET /api/reports/waste?date=YYYY-MM-DD
// OR  /api/reports/waste?start=YYYY-MM-DD&end=YYYY-MM-DD
// ---------------------------------------------------------------------------
app.get("/api/reports/waste", requireAuth, requireReports, (req, res) => {
  const single = String(req.query.date || "").trim();
  const start = String(req.query.start || "").trim();
  const end   = String(req.query.end || "").trim();

  let startDate = "";
  let endDate = "";

  if (start && end) {
    startDate = start;
    endDate = end;
  } else if (single) {
    startDate = single;
    endDate = single;
  } else {
    return res.status(400).json({ ok: false, error: "missing_date_or_range" });
  }

  try {
    const rows = db
      .prepare(
        `
        SELECT *
        FROM waste_log
        WHERE date(createdAt) BETWEEN date(@start) AND date(@end)
        ORDER BY datetime(createdAt) ASC, id ASC
      `
      )
      .all({ start: startDate, end: endDate });

    const summary = db
      .prepare(
        `
        SELECT
          COUNT(*)                   AS totalEvents,
          COALESCE(SUM(qty),0)       AS totalUnits,
          COALESCE(SUM(totalCost),0) AS totalCost
        FROM waste_log
        WHERE date(createdAt) BETWEEN date(@start) AND date(@end)
      `
      )
      .get({ start: startDate, end: endDate }) || {};

    const label =
      startDate === endDate ? startDate : `${startDate}..${endDate}`;

    res.json({
      ok: true,
      date: label,
      range: { start: startDate, end: endDate },
      summary: {
        totalEvents: summary.totalEvents || 0,
        totalUnits: summary.totalUnits || 0,
        totalCost: Number(summary.totalCost || 0)
      },
      rows
    });
  } catch (e) {
    console.error("[API] /api/reports/waste failed:", e);
    res.status(500).json({ ok: false, error: "report_failed" });
  }
});


// ---------------------------------------------------------------------------
// REPORTS: Deleted Items (single date OR range)
// GET /api/reports/deleted?date=YYYY-MM-DD
// OR  /api/reports/deleted?start=YYYY-MM-DD&end=YYYY-MM-DD
// ---------------------------------------------------------------------------
app.get("/api/reports/deleted", requireAuth, requireReports, (req, res) => {
  const single = String(req.query.date || "").trim();
  const start = String(req.query.start || "").trim();
  const end   = String(req.query.end || "").trim();

  let startDate = "";
  let endDate = "";

  if (start && end) {
    startDate = start;
    endDate = end;
  } else if (single) {
    startDate = single;
    endDate = single;
  } else {
    return res.status(400).json({ ok: false, error: "missing_date_or_range" });
  }

  try {
    const rows = db
      .prepare(
        `
        SELECT *
        FROM deleted_items
        WHERE date(deletedAt) BETWEEN date(@start) AND date(@end)
        ORDER BY datetime(deletedAt) ASC, id ASC
      `
      )
      .all({ start: startDate, end: endDate });

    const summary = db
      .prepare(
        `
        SELECT
          COUNT(*)                    AS totalEvents,
          COALESCE(SUM(qty),0)        AS totalUnits,
          COALESCE(SUM(totalCost),0)  AS totalCost,
          COALESCE(SUM(totalPrice),0) AS totalPrice
        FROM deleted_items
        WHERE date(deletedAt) BETWEEN date(@start) AND date(@end)
      `
      )
      .get({ start: startDate, end: endDate }) || {};

    const label =
      startDate === endDate ? startDate : `${startDate}..${endDate}`;

    res.json({
      ok: true,
      date: label,
      range: { start: startDate, end: endDate },
      summary: {
        totalEvents: Number(summary.totalEvents || 0),
        totalUnits: Number(summary.totalUnits || 0),
        totalCost: Number(summary.totalCost || 0),
        totalPrice: Number(summary.totalPrice || 0)
      },
      rows
    });
  } catch (e) {
    console.error("[API] /api/reports/deleted failed:", e);
    res.status(500).json({ ok: false, error: "report_failed" });
  }
});


// ---------------------------------------------------------------------------
// RESTORE: Bring a deleted item back into inventory
// POST /api/deleted-items/:id/restore
// ---------------------------------------------------------------------------
app.post("/api/deleted-items/:id/restore", requireAuth, requirePerm("inv_delete"), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ ok: false, error: "invalid_id" });
  }

  try {
    const deletedRow = db
      .prepare(`SELECT * FROM deleted_items WHERE id = ?`)
      .get(id);

    if (!deletedRow) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    const now = new Date().toISOString();
    const qty = Number(deletedRow.qty || 0);
    const price = Number(deletedRow.price || 0);
    const cost = Number(deletedRow.cost || 0);

    if (qty <= 0) {
      return res.status(400).json({ ok: false, error: "invalid_qty" });
    }

    const tx = db.transaction(() => {
      // 1) Check if an active item already exists with this SKU
      const existing = db
        .prepare(`SELECT * FROM items WHERE sku = ?`)
        .get(deletedRow.sku);

      if (!existing) {
        // Recreate the item fresh
        db.prepare(
          `
          INSERT INTO items
            (sku, title, platform, category, condition,
             variant, qty, cost, price, createdAt, barcode, source)
          VALUES
            (@sku, @title, @platform, @category, @condition,
             @variant, @qty, @cost, @price, @createdAt, @barcode, @source)
        `
        ).run({
          sku: deletedRow.sku,
          title: deletedRow.title || "",
          platform: deletedRow.platform || "",
          category: deletedRow.category || "games",
          condition: deletedRow.condition || "Used",
          variant: "", // keep variant simple for restored items
          qty,
          cost,
          price,
          createdAt: now,
          barcode: null,
          source: "restore"
        });
        const row = db.prepare(`SELECT * FROM items WHERE sku = ? ORDER BY id DESC LIMIT 1`).get(deletedRow.sku);
        if (row?.id) {
          setInventoryBucketQty(row.id, "sellable", "store", qty);
          syncItemQtyFromBuckets(row.id);
        }
      } else {
        // Merge qty back into existing row; keep existing price/cost
        ensureItemBucketBaseline(existing);
        const newQty = (existing.qty || 0) + qty;
        db.prepare(`
          UPDATE items
          SET qty = ?, deleted_at = NULL, deleted_reason = NULL
          WHERE id = ?
        `).run(newQty, existing.id);
        changeInventoryBucketQty(existing, "sellable", "store", qty);
      }

      // 2) Optional: mark this deleted row as restored (so you know it was undone)
      // If you want an explicit flag, add a migration to deleted_items first.
      // For now we just leave the row as historical record.

      // 3) Log activity
      logUserAction({
        userId: String(req.user.id || ""),
        username: req.user.username || "",
        action: "restore_deleted_item",
        screen: "reports_deleted",
        metadata: {
          deletedRowId: deletedRow.id,
          itemId: deletedRow.itemId,
          sku: deletedRow.sku,
          title: deletedRow.title,
          qtyRestored: qty
        }
      });
    });

    tx();
    storeWorkflows?.refreshAllBundleAvailability?.();

    const restoredItem = db
      .prepare(`SELECT * FROM items WHERE sku = ? ORDER BY id DESC LIMIT 1`)
      .get(deletedRow.sku);

    return res.json({
      ok: true,
      restored: restoredItem || null
    });
  } catch (e) {
    console.error("[API] restore deleted item failed:", e);
    return res.status(500).json({ ok: false, error: "restore_failed" });
  }
});


// ---------------------------------------------------------------------------
// SALES: Complete Sale (decrement inventory + log to sales tables)
// POST /api/sales/complete
// Body: { sale } or { items, tax, total, payment_method }
// ---------------------------------------------------------------------------
function normalizeClientTxnUuid(value) {
  const uuid = String(value || "").trim();
  return uuid ? uuid : null;
}

function findSaleByClientTxnUuid(uuid) {
  if (!uuid) return null;
  return db.prepare(`
    SELECT id, status, subtotal, tax, total, client_txn_uuid
    FROM sales
    WHERE client_txn_uuid = ?
    ORDER BY id ASC
    LIMIT 1
  `).get(uuid);
}

function saleCompletionResponse(row, { idempotent = false } = {}) {
  return {
    ok: true,
    saleId: row.id,
    idempotent,
    status: row.status || "completed",
    client_txn_uuid: row.client_txn_uuid || null,
    totals: {
      subtotal: Number(row.subtotal || 0),
      tax: Number(row.tax || 0),
      total: Number(row.total || 0)
    }
  };
}

function tenderLineAmountCents(line) {
  if (Number.isFinite(Number(line?.amount_cents))) {
    return Math.max(0, Math.round(Number(line.amount_cents)));
  }
  return Math.max(0, toCents(line?.amount ?? line?.paid ?? line?.total ?? 0));
}

function storeCreditTenderCents(raw, paymentMethod, total) {
  const tender = raw?.tender || {};
  const totalCents = Math.max(0, toCents(total));
  if (!totalCents) return 0;

  const lines = Array.isArray(tender.lines)
    ? tender.lines
    : (Array.isArray(raw?.tender_lines) ? raw.tender_lines : []);

  let cents = 0;
  for (const line of lines) {
    if (methodBucket(line?.method || line?.type) === "store_credit") {
      cents += tenderLineAmountCents(line);
    }
  }

  if (cents <= 0 && Number.isFinite(Number(tender.store_credit_cents))) {
    cents = Math.max(0, Math.round(Number(tender.store_credit_cents)));
  }
  if (cents <= 0 && Number.isFinite(Number(tender.store_credit_amount))) {
    cents = Math.max(0, toCents(tender.store_credit_amount));
  }
  if (cents <= 0 && methodBucket(paymentMethod) === "store_credit") {
    cents = Number.isFinite(Number(tender.paid)) ? toCents(tender.paid) : totalCents;
  }

  return Math.min(totalCents, Math.max(0, cents));
}

function saleTenderBuckets(raw, paymentMethod) {
  const tender = raw?.tender || {};
  const lines = Array.isArray(tender.lines)
    ? tender.lines
    : (Array.isArray(raw?.tender_lines) ? raw.tender_lines : []);
  const buckets = [];
  const pushBucket = (value) => {
    const bucket = methodBucket(value);
    if (!buckets.includes(bucket)) buckets.push(bucket);
  };
  if (lines.length) {
    for (const line of lines) pushBucket(line?.method || line?.type || paymentMethod);
  } else {
    pushBucket(paymentMethod || tender.type || raw.payment_method || "unknown");
  }
  return buckets;
}

function paymentMethodSettingKey(bucket) {
  if (bucket === "cash") return "payment_cash_enabled";
  if (bucket === "card") return "payment_card_enabled";
  if (bucket === "store_credit") return "payment_store_credit_enabled";
  return "payment_other_enabled";
}

function clampCents(value, min, max) {
  const n = Math.round(Number(value || 0));
  return Math.max(min, Math.min(max, n));
}

function lineLooksTaxExempt(line) {
  const category = String(line?.category || "").trim().toLowerCase();
  const variant = String(line?.variant || "").trim().toLowerCase();
  const source = String(line?.source || "").trim().toLowerCase();
  return category === "event tickets" || variant === "event_ticket" || source.startsWith("community-event-ticket:");
}

function saleTenderPaidCents(raw) {
  const tender = raw?.tender || {};
  const lines = Array.isArray(tender.lines)
    ? tender.lines
    : (Array.isArray(raw?.tender_lines) ? raw.tender_lines : []);

  if (lines.length) {
    return lines.reduce((sum, line) => sum + tenderLineAmountCents(line), 0);
  }
  if (Number.isFinite(Number(tender.paid))) {
    return Math.max(0, toCents(tender.paid));
  }
  if (Number.isFinite(Number(raw.paid))) {
    return Math.max(0, toCents(raw.paid));
  }
  return null;
}

app.post("/api/sales/complete", requireAuth, requirePerm("checkout"), (req, res) => {
  let client_txn_uuid = null;
  try {
    const raw = (req.body && req.body.sale) ? req.body.sale : (req.body || {});
    const items = Array.isArray(raw.items) ? raw.items : [];
    if (!items.length) return res.status(400).json({ ok: false, error: "no_items" });

    const nowIso = new Date().toISOString();
    const payment_method = raw?.tender?.type || raw.payment_method || "unknown";
    client_txn_uuid = normalizeClientTxnUuid(raw.client_txn_uuid || raw.id);
    const customer = raw?.customer || {};
    const customer_type_raw = (customer.type || raw.customer_type || "regular");
    const customer_type = String(customer_type_raw).toLowerCase() === "business" ? "business" : "regular";
    const customer_name = customer.name || raw.customer_name || "";
    const customer_phone = customer.phone || raw.customer_phone || "";
    const customer_ein = customer.ein || raw.customer_ein || "";
    const taxExemptRaw =
      raw.tax_exempt ?? raw.taxExempt ?? customer.tax_exempt ?? customer.taxExempt;
    const customer_tax_exempt = taxExemptRaw ? 1 : 0;
    let customer_id = Number(raw.customer_id || customer.id || 0) || null;
    if (!customer_id) {
      // Try to match existing customer by phone or name (best-effort, case-insensitive)
      const phoneMatch = String(customer_phone || "").trim();
      const nameMatch = String(customer_name || "").trim();
      if (phoneMatch) {
        const row = db.prepare(`
          SELECT id FROM customers
          WHERE phone = ? OR phone2 = ? OR phone3 = ?
          ORDER BY id DESC LIMIT 1
        `).get(phoneMatch, phoneMatch, phoneMatch);
        if (row) customer_id = row.id;
      }
      if (!customer_id && nameMatch) {
        const row = db.prepare(`
          SELECT id FROM customers
          WHERE lower(name) = lower(?)
          ORDER BY id DESC LIMIT 1
        `).get(nameMatch);
        if (row) customer_id = row.id;
      }
    }
    const registerSettings = serializeRegisterSettings();
    const tenderBuckets = saleTenderBuckets(raw, payment_method);
    if (!registerSettings.allow_split_tender && tenderBuckets.length > 1) {
      throw new Error("split_tender_disabled");
    }
    for (const bucket of tenderBuckets) {
      const settingKey = paymentMethodSettingKey(bucket);
      if (registerSettings[settingKey] === false) {
        throw new Error(`payment_method_disabled:${bucket}`);
      }
    }
    if (registerSettings.require_customer_for_sale && !customer_id && !String(customer_name || customer_phone || customer_ein).trim()) {
      throw new Error("customer_required");
    }

    const tx = db.transaction(() => {
      const existing = findSaleByClientTxnUuid(client_txn_uuid);
      if (existing) return { ...saleCompletionResponse(existing, { idempotent: true }), alreadyCompleted: true };

      let computedSubtotalCents = 0;
      let taxableSubtotalCents = 0;
      const lineRows = [];
      const priceOverrideEvents = [];
      let priceApproval = null;
      let discountApproval = null;
      let taxExemptApproval = null;

      for (const line of items) {
        const sku = String(line.sku || "").trim();
        const qty = Math.max(1, Number(line.qty || 1));
        if (!sku) throw new Error("missing_sku");

        const row = db.prepare(`SELECT * FROM items WHERE sku=?`).get(sku);
        if (!row) throw new Error(`sku_not_found:${sku}`);

        storeWorkflows?.assertBundleAvailableItem?.(row, qty);

        ensureItemBucketBaseline(row);
        const sellableQty = getInventoryBucketQty(row.id, "sellable", null);
        if (sellableQty < qty) {
          throw new Error(`insufficient_qty:${sku}`);
        }

        const submittedUnitPrice = Number.isFinite(+line.price) ? Number(line.price) : Number(row.price || 0);
        const unitPriceCents = Math.max(0, toCents(submittedUnitPrice));
        const unit_price = toDollars(unitPriceCents);
        const catalogPrice = toDollars(Math.max(0, toCents(row.price || 0)));
        if (Math.abs(unit_price - catalogPrice) > 0.005) {
          priceApproval = priceApproval || requirePermissionOrApproval(req, raw, "cost_change", {
            forcePin: registerSettings.require_pin_for_price_override !== false
          });
          priceOverrideEvents.push({
            itemId: row.id,
            sku,
            title: row.title || line.title || "",
            originalPrice: catalogPrice,
            overridePrice: unit_price,
            qty
          });
        }
        const lineTotalCents = unitPriceCents * qty;
        const line_total = toDollars(lineTotalCents);
        computedSubtotalCents += lineTotalCents;
        const source = row.source || line.source || "";
        const taxable = lineLooksTaxExempt({
          category: row.category || line.category || "",
          variant: row.variant || line.variant || "",
          source
        }) ? 0 : 1;
        if (taxable) taxableSubtotalCents += lineTotalCents;

        lineRows.push({
          item_id: row.id,
          sku,
          title: row.title || line.title || "",
          category: row.category || line.category || "",
          variant: row.variant || line.variant || "",
          unit_price,
          qty,
          taxable,
          line_total,
          line_type: "item",
          barcode: row.barcode || "",
          source
        });
      }

      const submittedDiscountCents = Number.isFinite(Number(raw.discount_cents))
        ? Math.round(Number(raw.discount_cents))
        : toCents(raw.discount);
      const discountCents = clampCents(submittedDiscountCents, 0, computedSubtotalCents);
      const netSubtotalCents = Math.max(0, computedSubtotalCents - discountCents);
      const taxableDiscountCents = computedSubtotalCents > 0
        ? clampCents(Math.round(discountCents * (taxableSubtotalCents / computedSubtotalCents)), 0, taxableSubtotalCents)
        : 0;
      const taxableCents = Math.max(0, taxableSubtotalCents - taxableDiscountCents);
      const taxRate = Math.max(0, Math.min(0.25, Number(registerSettings.tax_rate) || 0));
      const taxCents = customer_tax_exempt
        ? 0
        : Math.round(taxableCents * taxRate);
      const feeCents = 0;
      const totalCents = netSubtotalCents + taxCents + feeCents;

      const paidCents = saleTenderPaidCents(raw);
      if (paidCents !== null && paidCents + 1 < totalCents) {
        throw new Error(`insufficient_tender:${paidCents}:${totalCents}`);
      }

      const subtotal = toDollars(computedSubtotalCents);
      const discount = toDollars(discountCents);
      const tax = toDollars(taxCents);
      const total = toDollars(totalCents);
      const storeCreditCents = storeCreditTenderCents(raw, payment_method, total);

      if (discount > 0) {
        discountApproval = requirePermissionOrApproval(req, raw, "discount_override", {
          forcePin: registerSettings.require_pin_for_discounts !== false
        });
      }
      if (customer_tax_exempt) {
        taxExemptApproval = requirePermissionOrApproval(req, raw, "tax_admin", {
          forcePin: registerSettings.require_pin_for_tax_exempt !== false
        });
      }
      if (storeCreditCents > 0) {
        if (!customer_id) throw new Error("store_credit_customer_required");
        const creditRow = db.prepare(`
          SELECT id, COALESCE(store_credit_cents,0) AS store_credit_cents
          FROM customers
          WHERE id = ?
        `).get(customer_id);
        if (!creditRow) throw new Error("store_credit_customer_not_found");
        const availableCents = Number(creditRow.store_credit_cents || 0);
        if (availableCents < storeCreditCents) {
          throw new Error(`store_credit_insufficient:${availableCents}:${storeCreditCents}`);
        }
      }

      const saleInfo = db.prepare(`
        INSERT INTO sales
          (created_at, status, subtotal, tax, total, payment_method, customer_id, customer_type, customer_name, customer_phone, customer_ein, customer_tax_exempt, user_id, client_txn_uuid)
        VALUES
          (@created_at, 'completed', @subtotal, @tax, @total, @payment_method, @customer_id, @customer_type, @customer_name, @customer_phone, @customer_ein, @customer_tax_exempt, @user_id, @client_txn_uuid)
      `).run({
        created_at: raw.ts || nowIso,
        subtotal,
        tax,
        total,
        payment_method,
        customer_id,
        customer_type,
        customer_name,
        customer_phone,
        customer_ein,
        customer_tax_exempt,
        user_id: req.user.id,
        client_txn_uuid
      });

      const saleId = saleInfo.lastInsertRowid;
      const insertItem = db.prepare(`
        INSERT INTO sale_items
          (sale_id, item_id, sku, title, unit_price, qty, taxable, line_total, line_type)
        VALUES
          (@sale_id, @item_id, @sku, @title, @unit_price, @qty, @taxable, @line_total, @line_type)
      `);

      for (const line of lineRows) {
        insertItem.run({ sale_id: saleId, ...line });
        consumeInventoryFromBuckets(line.item_id, line.qty, ["sellable"]);
        logInventoryMovement({
          item_id: line.item_id,
          sku: line.sku,
          qty_delta: -line.qty,
          reason: "sale",
          sale_id: saleId,
          user_id: req.user.id
        });
        applyCommunityTicketSaleLine(line, {
          saleId,
          paymentMethod: payment_method,
          userId: req.user.id,
          username: req.user.username || "",
          customerName: customer_name,
          customerPhone: customer_phone
        });
        storeWorkflows?.applyBundleSaleLine?.(line, {
          saleId,
          userId: req.user.id,
          username: req.user.username || ""
        });
      }

      if (discount > 0) {
        insertItem.run({
          sale_id: saleId,
          item_id: null,
          sku: "DISCOUNT",
          title: "Discount",
          unit_price: -Number(discount.toFixed(2)),
          qty: 1,
          taxable: 0,
          line_total: -Number(discount.toFixed(2)),
          line_type: "discount"
        });
      }
      if (storeCreditCents > 0) {
        const update = db.prepare(`
          UPDATE customers
          SET store_credit_cents = COALESCE(store_credit_cents,0) - @amount_cents,
              updated_at = @updated_at
          WHERE id = @customer_id
            AND COALESCE(store_credit_cents,0) >= @amount_cents
        `).run({
          amount_cents: storeCreditCents,
          updated_at: nowIso,
          customer_id
        });
        if (!update.changes) {
          const current = db.prepare(`
            SELECT COALESCE(store_credit_cents,0) AS store_credit_cents
            FROM customers
            WHERE id = ?
          `).get(customer_id);
          const availableCents = Number(current?.store_credit_cents || 0);
          throw new Error(`store_credit_insufficient:${availableCents}:${storeCreditCents}`);
        }
        db.prepare(`
          INSERT INTO customer_adjustments (customer_id, amount_cents, reason, user_id)
          VALUES (@customer_id, @amount_cents, @reason, @user_id)
        `).run({
          customer_id,
          amount_cents: -storeCreditCents,
          reason: `Store credit tender on sale #${saleId}`,
          user_id: req.user.id
        });
      }

      return {
        saleId,
        subtotal,
        tax,
        total,
        discount,
        subtotalCents: computedSubtotalCents,
        discountCents,
        taxCents,
        totalCents,
        storeCreditCents,
        customer_id,
        priceOverrideEvents,
        priceApproval,
        discountApproval,
        taxExemptApproval,
        customer_tax_exempt
      };
    });

    const result = tx();
    if (result.alreadyCompleted) {
      return res.json(result);
    }
    storeWorkflows?.refreshAllBundleAvailability?.();
    storeWorkflows?.awardLoyaltyForSale?.({
      id: result.saleId,
      customer_id: result.customer_id,
      total: result.total
    }, req.user.id);

    logSaleEvent({
      sale_id: result.saleId,
      action: "completed",
      user_id: req.user.id,
      metadata: { subtotal: result.subtotal, tax: result.tax, total: result.total }
    });
    if (result.discount > 0) {
      logUserAction({
        userId: String(req.user.id || ""),
        username: req.user.username || "",
        action: "discount_applied",
        screen: "pos",
        metadata: {
          saleId: result.saleId,
          discount: result.discount,
          ...approvalLogMeta(result.discountApproval)
        }
      });
    }
    for (const event of result.priceOverrideEvents || []) {
      logUserAction({
        userId: String(req.user.id || ""),
        username: req.user.username || "",
        action: "price_override",
        screen: "pos",
        metadata: {
          saleId: result.saleId,
          ...event,
          ...approvalLogMeta(result.priceApproval)
        }
      });
    }
    if (result.storeCreditCents > 0) {
      logUserAction({
        userId: String(req.user.id || ""),
        username: req.user.username || "",
        action: "store_credit_redeemed",
        screen: "pos",
        metadata: {
          saleId: result.saleId,
          customerId: result.customer_id,
          amountCents: result.storeCreditCents
        }
      });
    }
    if (result.customer_tax_exempt) {
      logUserAction({
        userId: String(req.user.id || ""),
        username: req.user.username || "",
        action: "tax_exempt_sale",
        screen: "pos",
        metadata: {
          saleId: result.saleId,
          customerId: result.customer_id,
          ...approvalLogMeta(result.taxExemptApproval)
        }
      });
    }

    const skusToSync = [...new Set(items.map((line) => String(line.sku || "").trim()).filter(Boolean))];
    for (const sku of skusToSync) queueWixAutoSkuSync(sku, "POST /api/sales/complete");

    res.json({
      ok: true,
      saleId: result.saleId,
      idempotent: false,
      client_txn_uuid,
      store_credit_cents: result.storeCreditCents || 0,
      totals: { subtotal: result.subtotal, discount: result.discount, tax: result.tax, total: result.total }
    });
  } catch (err) {
    const msg = String(err.message || err);
    const duplicateClientTxn =
      err.code === "SQLITE_CONSTRAINT_UNIQUE" ||
      msg.includes("ux_sales_client_txn_uuid") ||
      (msg.toLowerCase().includes("unique") && msg.includes("client_txn_uuid"));
    if (client_txn_uuid && duplicateClientTxn) {
      const existing = findSaleByClientTxnUuid(client_txn_uuid);
      if (existing) return res.json(saleCompletionResponse(existing, { idempotent: true }));
    }
    if (msg.startsWith("insufficient_qty:")) {
      return res.status(409).json({ ok: false, error: "insufficient_qty", sku: msg.split(":")[1] });
    }
    if (msg.startsWith("insufficient_bucket_qty:")) {
      return res.status(409).json({ ok: false, error: "insufficient_qty", sku: msg.split(":")[1] });
    }
    if (msg.startsWith("sku_not_found:")) {
      return res.status(404).json({ ok: false, error: "sku_not_found", sku: msg.split(":")[1] });
    }
    if (msg.startsWith("manager_approval_required:")) {
      return res.status(403).json({ ok: false, error: "manager_approval_required", permission: msg.split(":")[1] });
    }
    if (msg === "customer_required") {
      return res.status(400).json({ ok: false, error: "customer_required" });
    }
    if (msg === "split_tender_disabled") {
      return res.status(409).json({ ok: false, error: "split_tender_disabled" });
    }
    if (msg.startsWith("payment_method_disabled:")) {
      return res.status(409).json({ ok: false, error: "payment_method_disabled", method: msg.split(":")[1] });
    }
    if (msg === "store_credit_customer_required") {
      return res.status(400).json({ ok: false, error: "store_credit_customer_required" });
    }
    if (msg === "store_credit_customer_not_found") {
      return res.status(404).json({ ok: false, error: "store_credit_customer_not_found" });
    }
    if (msg.startsWith("insufficient_tender:")) {
      const parts = msg.split(":");
      return res.status(409).json({
        ok: false,
        error: "insufficient_tender",
        paid_cents: Number(parts[1] || 0),
        total_cents: Number(parts[2] || 0)
      });
    }
    if (msg.startsWith("store_credit_insufficient:")) {
      const parts = msg.split(":");
      return res.status(409).json({
        ok: false,
        error: "store_credit_insufficient",
        balance_cents: Number(parts[1] || 0),
        needed_cents: Number(parts[2] || 0)
      });
    }
    if (msg.startsWith("bundle_unavailable:")) {
      return res.status(409).json({ ok: false, error: "bundle_unavailable", bundle_id: Number(msg.split(":")[1] || 0) });
    }
    if (msg.startsWith("bundle_qty_limit:")) {
      return res.status(409).json({ ok: false, error: "bundle_qty_limit", bundle_id: Number(msg.split(":")[1] || 0) });
    }
    console.error("[API] /api/sales/complete failed:", err);
    res.status(500).json({ ok: false, error: "sale_failed" });
  }
});

// ---------------------------------------------------------------------------
// SALES: Void Sale (manager+)
// POST /api/sales/:saleId/void
// ---------------------------------------------------------------------------
app.post("/api/sales/:saleId/void", requireAuth, (req, res) => {
  const saleId = Number(req.params.saleId);
  if (!Number.isFinite(saleId)) return res.status(400).json({ ok: false, error: "invalid_sale_id" });
  let approval = null;
  try {
    approval = requirePermissionOrApproval(req, req.body || {}, "void_refund");
  } catch (err) {
    return res.status(403).json({ ok: false, error: "manager_approval_required", permission: "void_refund" });
  }

  try {
    const sale = db.prepare(`SELECT * FROM sales WHERE id=?`).get(saleId);
    if (!sale) return res.status(404).json({ ok: false, error: "sale_not_found" });
    if (sale.status === "voided") return res.status(409).json({ ok: false, error: "already_voided" });

    let skusToSync = [];
    const tx = db.transaction(() => {
      const items = db.prepare(`
        SELECT * FROM sale_items
        WHERE sale_id=? AND (line_type IS NULL OR line_type!='discount')
      `).all(saleId);
      skusToSync = items.map((it) => String(it.sku || "").trim()).filter(Boolean);
      for (const it of items) {
        const qty = Number(it.qty || 0);
        if (!qty) continue;
        if (it.item_id) {
          const row = db.prepare(`SELECT * FROM items WHERE id=?`).get(it.item_id);
          if (row) {
            db.prepare(`
              UPDATE items
              SET deleted_at=NULL, deleted_reason=NULL
              WHERE id=?
            `).run(it.item_id);
            changeInventoryBucketQty(row, "sellable", "store", qty);
          } else {
            db.prepare(`
              INSERT INTO items (sku, title, qty, price, cost, createdAt)
              VALUES (?, ?, ?, ?, 0, ?)
            `).run(it.sku || "", it.title || "", qty, Number(it.unit_price || 0), new Date().toISOString());
            const restored = db.prepare(`SELECT * FROM items WHERE sku=? ORDER BY id DESC LIMIT 1`).get(it.sku || "");
            if (restored?.id) {
              setInventoryBucketQty(restored.id, "sellable", "store", qty);
              syncItemQtyFromBuckets(restored.id);
            }
          }
          logInventoryMovement({
            item_id: it.item_id,
            sku: it.sku,
            qty_delta: qty,
            reason: "void",
            sale_id: saleId,
            user_id: req.user.id
          });
        } else if (it.sku) {
          const row = db.prepare(`SELECT * FROM items WHERE sku=?`).get(it.sku);
          if (row) {
            db.prepare(`
              UPDATE items
              SET deleted_at=NULL, deleted_reason=NULL
              WHERE sku=?
            `).run(it.sku);
            changeInventoryBucketQty(row, "sellable", "store", qty);
          } else {
            db.prepare(`
              INSERT INTO items (sku, title, qty, price, cost, createdAt)
              VALUES (?, ?, ?, ?, 0, ?)
            `).run(it.sku || "", it.title || "", qty, Number(it.unit_price || 0), new Date().toISOString());
            const restored = db.prepare(`SELECT * FROM items WHERE sku=? ORDER BY id DESC LIMIT 1`).get(it.sku || "");
            if (restored?.id) {
              setInventoryBucketQty(restored.id, "sellable", "store", qty);
              syncItemQtyFromBuckets(restored.id);
            }
          }
          logInventoryMovement({
            item_id: row ? row.id : null,
            sku: it.sku,
            qty_delta: qty,
            reason: "void",
            sale_id: saleId,
            user_id: req.user.id
          });
        }
        reverseCommunityTicketSaleLine(it, {
          saleId,
          userId: req.user.id,
          username: req.user.username || "",
          reason: "void"
        });
        storeWorkflows?.reverseBundleSaleLine?.(it, {
          saleId,
          userId: req.user.id,
          username: req.user.username || "",
          reason: "void"
        });
      }
      db.prepare(`UPDATE sales SET status='voided' WHERE id=?`).run(saleId);
    });

    tx();
    storeWorkflows?.refreshAllBundleAvailability?.();
    storeWorkflows?.reverseLoyaltyForSale?.(saleId, toCents(sale.total || 0), req.user.id, "Void");
    logSaleEvent({
      sale_id: saleId,
      action: "voided",
      user_id: req.user.id
    });
    logUserAction({
      userId: String(req.user.id || ""),
      username: req.user.username || "",
      action: "sale_voided",
      screen: "pos",
      metadata: { saleId, ...approvalLogMeta(approval) }
    });

    for (const sku of [...new Set(skusToSync)]) queueWixAutoSkuSync(sku, "POST /api/sales/:saleId/void");

    res.json({ ok: true });
  } catch (err) {
    console.error("[API] /api/sales/:saleId/void failed:", err);
    res.status(500).json({ ok: false, error: "void_failed" });
  }
});

// ---------------------------------------------------------------------------
// SALES: Refund Sale Items (manager+)
// POST /api/sales/:saleId/refund
// Body: { items: [{ sale_item_id, qty }], reason }
// ---------------------------------------------------------------------------
app.post("/api/sales/:saleId/refund", requireAuth, (req, res) => {
  const saleId = Number(req.params.saleId);
  if (!Number.isFinite(saleId)) return res.status(400).json({ ok: false, error: "invalid_sale_id" });

  const { items = [], reason = "" } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ ok: false, error: "no_items" });
  }
  let approval = null;
  try {
    approval = requirePermissionOrApproval(req, req.body || {}, "void_refund");
  } catch (err) {
    return res.status(403).json({ ok: false, error: "manager_approval_required", permission: "void_refund" });
  }

  try {
    const sale = db.prepare(`SELECT * FROM sales WHERE id=?`).get(saleId);
    if (!sale) return res.status(404).json({ ok: false, error: "sale_not_found" });
    if (sale.status === "voided") return res.status(409).json({ ok: false, error: "sale_voided" });

    const skusToSync = [];
    const tx = db.transaction(() => {
      const refundInfo = db.prepare(`
        INSERT INTO refunds (sale_id, created_at, reason, user_id)
        VALUES (?, ?, ?, ?)
      `).run(saleId, new Date().toISOString(), String(reason || ""), req.user.id);
      const refundId = refundInfo.lastInsertRowid;

      let refundTotal = 0;
      for (const line of items) {
        const saleItemId = Number(line.sale_item_id);
        const qtyReq = Math.max(1, Number(line.qty || 1));
        if (!Number.isFinite(saleItemId)) throw new Error("invalid_sale_item_id");

        const saleItem = db.prepare(`
          SELECT * FROM sale_items
          WHERE id=? AND sale_id=? AND (line_type IS NULL OR line_type!='discount')
        `).get(saleItemId, saleId);
        if (!saleItem) throw new Error("sale_item_not_found");

        const alreadyRefunded = db.prepare(`
          SELECT COALESCE(SUM(ri.qty_refunded),0) AS c
          FROM refund_items ri
          JOIN refunds r ON r.id = ri.refund_id
          WHERE r.sale_id = ? AND ri.sale_item_id = ?
        `).get(saleId, saleItemId).c;

        const remaining = Math.max(0, Number(saleItem.qty || 0) - Number(alreadyRefunded || 0));
        if (qtyReq > remaining) {
          throw new Error("refund_qty_exceeds");
        }

        const unit_price = Number(saleItem.unit_price || 0);
        const line_total = unit_price * qtyReq;
        refundTotal += line_total;
        if (saleItem.sku) skusToSync.push(String(saleItem.sku || "").trim());

        db.prepare(`
          INSERT INTO refund_items (refund_id, sale_item_id, qty_refunded, unit_price, line_total)
          VALUES (?, ?, ?, ?, ?)
        `).run(refundId, saleItemId, qtyReq, unit_price, line_total);

        if (saleItem.item_id) {
          const row = db.prepare(`SELECT * FROM items WHERE id=?`).get(saleItem.item_id);
          if (row) {
            db.prepare(`
              UPDATE items
              SET deleted_at=NULL, deleted_reason=NULL
              WHERE id=?
            `).run(saleItem.item_id);
            changeInventoryBucketQty(row, "sellable", "store", qtyReq);
          } else {
            db.prepare(`
              INSERT INTO items (sku, title, qty, price, cost, createdAt)
              VALUES (?, ?, ?, ?, 0, ?)
            `).run(saleItem.sku || "", saleItem.title || "", qtyReq, unit_price, new Date().toISOString());
            const restored = db.prepare(`SELECT * FROM items WHERE sku=? ORDER BY id DESC LIMIT 1`).get(saleItem.sku || "");
            if (restored?.id) {
              setInventoryBucketQty(restored.id, "sellable", "store", qtyReq);
              syncItemQtyFromBuckets(restored.id);
            }
          }
          logInventoryMovement({
            item_id: saleItem.item_id,
            sku: saleItem.sku,
            qty_delta: qtyReq,
            reason: "refund",
            sale_id: saleId,
            refund_id: refundId,
            user_id: req.user.id
          });
        } else if (saleItem.sku) {
          const row = db.prepare(`SELECT * FROM items WHERE sku=?`).get(saleItem.sku);
          if (row) {
            db.prepare(`
              UPDATE items
              SET deleted_at=NULL, deleted_reason=NULL
              WHERE sku=?
            `).run(saleItem.sku);
            changeInventoryBucketQty(row, "sellable", "store", qtyReq);
          } else {
            db.prepare(`
              INSERT INTO items (sku, title, qty, price, cost, createdAt)
              VALUES (?, ?, ?, ?, 0, ?)
            `).run(saleItem.sku || "", saleItem.title || "", qtyReq, unit_price, new Date().toISOString());
            const restored = db.prepare(`SELECT * FROM items WHERE sku=? ORDER BY id DESC LIMIT 1`).get(saleItem.sku || "");
            if (restored?.id) {
              setInventoryBucketQty(restored.id, "sellable", "store", qtyReq);
              syncItemQtyFromBuckets(restored.id);
            }
          }
          logInventoryMovement({
            item_id: row ? row.id : null,
            sku: saleItem.sku,
            qty_delta: qtyReq,
            reason: "refund",
            sale_id: saleId,
            refund_id: refundId,
            user_id: req.user.id
          });
        }
        reverseCommunityTicketSaleLine({ ...saleItem, qty: qtyReq }, {
          saleId,
          refundId,
          userId: req.user.id,
          username: req.user.username || "",
          reason: "refund"
        });
        storeWorkflows?.reverseBundleSaleLine?.({ ...saleItem, qty: qtyReq }, {
          saleId,
          refundId,
          userId: req.user.id,
          username: req.user.username || "",
          reason: "refund"
        });
      }

      return { refundId, refundTotal };
    });

    const result = tx();
    storeWorkflows?.refreshAllBundleAvailability?.();
    storeWorkflows?.reverseLoyaltyForSale?.(saleId, toCents(result.refundTotal || 0), req.user.id, "Refund");
    logSaleEvent({
      sale_id: saleId,
      action: "refund",
      user_id: req.user.id,
      metadata: { refundId: result.refundId, refundTotal: result.refundTotal }
    });
    logUserAction({
      userId: String(req.user.id || ""),
      username: req.user.username || "",
      action: "sale_refunded",
      screen: "pos",
      metadata: {
        saleId,
        refundId: result.refundId,
        refundTotal: result.refundTotal,
        reason,
        ...approvalLogMeta(approval)
      }
    });

    for (const sku of [...new Set(skusToSync)].filter(Boolean)) queueWixAutoSkuSync(sku, "POST /api/sales/:saleId/refund");

    res.json({ ok: true, refundId: result.refundId, refundTotal: result.refundTotal });
  } catch (err) {
    const msg = String(err.message || err);
    if (msg === "refund_qty_exceeds") return res.status(409).json({ ok: false, error: "refund_qty_exceeds" });
    if (msg === "sale_item_not_found") return res.status(404).json({ ok: false, error: "sale_item_not_found" });
    console.error("[API] /api/sales/:saleId/refund failed:", err);
    res.status(500).json({ ok: false, error: "refund_failed" });
  }
});

// ---------------------------------------------------------------------------
// SALES: List + Detail
// ---------------------------------------------------------------------------
app.get("/api/sales", requireAuth, (_req, res) => {
  try {
    const rows = db.prepare(`
      SELECT
        s.*,
        COALESCE(SUM(ri.line_total),0) AS refunded_total
      FROM sales s
      LEFT JOIN refunds r ON r.sale_id = s.id
      LEFT JOIN refund_items ri ON ri.refund_id = r.id
      GROUP BY s.id
      ORDER BY datetime(s.created_at) DESC, s.id DESC
    `).all();
    res.json({ ok: true, rows });
  } catch (e) {
    console.error("[API] /api/sales failed:", e);
    res.status(500).json({ ok: false, error: "sales_list_failed" });
  }
});

app.get("/api/sales/:saleId", requireAuth, (req, res) => {
  const saleId = Number(req.params.saleId);
  if (!Number.isFinite(saleId)) return res.status(400).json({ ok: false, error: "invalid_sale_id" });
  try {
    const sale = db.prepare(`SELECT * FROM sales WHERE id=?`).get(saleId);
    if (!sale) return res.status(404).json({ ok: false, error: "sale_not_found" });

    const items = db.prepare(`
      SELECT
        si.*,
        COALESCE(SUM(ri.qty_refunded),0) AS refunded_qty
      FROM sale_items si
      LEFT JOIN refunds r ON r.sale_id = si.sale_id
      LEFT JOIN refund_items ri ON ri.refund_id = r.id AND ri.sale_item_id = si.id
      WHERE si.sale_id = ? AND (si.line_type IS NULL OR si.line_type!='discount')
      GROUP BY si.id
      ORDER BY si.id ASC
    `).all(saleId);

    const refunds = db.prepare(`
      SELECT r.*,
             COALESCE(SUM(ri.line_total),0) AS refund_total
      FROM refunds r
      LEFT JOIN refund_items ri ON ri.refund_id = r.id
      WHERE r.sale_id = ?
      GROUP BY r.id
      ORDER BY datetime(r.created_at) ASC
    `).all(saleId);

    res.json({ ok: true, sale, items, refunds });
  } catch (e) {
    console.error("[API] /api/sales/:saleId failed:", e);
    res.status(500).json({ ok: false, error: "sales_detail_failed" });
  }
});

// ---------------------------------------------------------------------------
// CUSTOMERS: List + Detail + Create + Update + Activate
// ---------------------------------------------------------------------------
app.get("/api/customers", requireAuth, (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const type = String(req.query.type || "").trim().toLowerCase();
    const tax = String(req.query.tax || "").trim().toLowerCase(); // exempt | standard
    const active = String(req.query.active || "").trim().toLowerCase(); // active | inactive
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 200)));
    const offset = Math.max(0, Number(req.query.offset || 0));

    const where = [];
    const params = {};
    if (search) {
      where.push(`(
        name LIKE @q OR phone LIKE @q OR phone2 LIKE @q OR phone3 LIKE @q
        OR email LIKE @q OR email2 LIKE @q OR email3 LIKE @q OR ein LIKE @q
      )`);
      params.q = `%${search}%`;
    }
    if (type === "regular" || type === "business") {
      where.push(`type = @type`);
      params.type = type;
    }
    if (tax === "exempt") {
      where.push(`tax_exempt = 1`);
    } else if (tax === "standard") {
      where.push(`tax_exempt = 0`);
    }
    if (active === "active") {
      where.push(`active = 1`);
    } else if (active === "inactive") {
      where.push(`active = 0`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = db.prepare(`
      SELECT *
      FROM customers
      ${whereSql}
      ORDER BY active DESC, name ASC, id DESC
      LIMIT @limit OFFSET @offset
    `).all({ ...params, limit, offset });

    res.json({ ok: true, rows });
  } catch (e) {
    console.error("[API] /api/customers failed:", e);
    res.status(500).json({ ok: false, error: "customers_list_failed" });
  }
});

app.get("/api/customers/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "invalid_customer_id" });
  try {
    const customer = db.prepare(`SELECT * FROM customers WHERE id=?`).get(id);
    if (!customer) return res.status(404).json({ ok: false, error: "customer_not_found" });
    // Summary + history
    const summary = db.prepare(`
      SELECT
        COUNT(*) AS txn_count,
        COALESCE(SUM(total),0) AS total_spend,
        COALESCE(MAX(created_at),'') AS last_visit
      FROM sales
      WHERE status='completed'
        AND (
          customer_id = @id
          OR (customer_id IS NULL AND customer_name = @name)
          OR (customer_id IS NULL AND customer_phone IN (@p1,@p2,@p3))
          OR (customer_id IS NULL AND customer_ein = @ein)
        )
    `).get({
      id,
      name: customer.name || "",
      p1: customer.phone || "",
      p2: customer.phone2 || "",
      p3: customer.phone3 || "",
      ein: customer.ein || ""
    }) || { txn_count: 0, total_spend: 0, last_visit: "" };

    const history = db.prepare(`
      SELECT
        s.id AS sale_id,
        s.created_at,
        s.total,
        si.sku,
        si.title,
        si.qty,
        si.unit_price,
        si.line_total
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      WHERE s.status='completed'
        AND (
          s.customer_id = @id
          OR (s.customer_id IS NULL AND s.customer_name = @name)
          OR (s.customer_id IS NULL AND s.customer_phone IN (@p1,@p2,@p3))
          OR (s.customer_id IS NULL AND s.customer_ein = @ein)
        )
        AND (si.line_type IS NULL OR si.line_type!='discount')
      ORDER BY datetime(s.created_at) DESC, s.id DESC, si.id ASC
      LIMIT 500
    `).all({
      id,
      name: customer.name || "",
      p1: customer.phone || "",
      p2: customer.phone2 || "",
      p3: customer.phone3 || "",
      ein: customer.ein || ""
    });

    const notes = db.prepare(`
      SELECT * FROM customer_notes
      WHERE customer_id = ?
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT 200
    `).all(id);

    const adjustments = db.prepare(`
      SELECT * FROM customer_adjustments
      WHERE customer_id = ?
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT 200
    `).all(id);

    const refunds = db.prepare(`
      SELECT r.id, r.created_at, COALESCE(SUM(ri.line_total),0) AS total
      FROM refunds r
      JOIN sales s ON s.id = r.sale_id
      LEFT JOIN refund_items ri ON ri.refund_id = r.id
      WHERE s.status='completed'
        AND (
          s.customer_id = @id
          OR (s.customer_id IS NULL AND s.customer_name = @name)
          OR (s.customer_id IS NULL AND s.customer_phone IN (@p1,@p2,@p3))
          OR (s.customer_id IS NULL AND s.customer_ein = @ein)
        )
      GROUP BY r.id
      ORDER BY datetime(r.created_at) DESC
      LIMIT 200
    `).all({
      id,
      name: customer.name || "",
      p1: customer.phone || "",
      p2: customer.phone2 || "",
      p3: customer.phone3 || "",
      ein: customer.ein || ""
    });

    const salesTimeline = db.prepare(`
      SELECT id, created_at, total
      FROM sales
      WHERE status='completed'
        AND (
          customer_id = @id
          OR (customer_id IS NULL AND customer_name = @name)
          OR (customer_id IS NULL AND customer_phone IN (@p1,@p2,@p3))
          OR (customer_id IS NULL AND customer_ein = @ein)
        )
      ORDER BY datetime(created_at) DESC
      LIMIT 200
    `).all({
      id,
      name: customer.name || "",
      p1: customer.phone || "",
      p2: customer.phone2 || "",
      p3: customer.phone3 || "",
      ein: customer.ein || ""
    });

    const timeline = [];
    for (const s of salesTimeline) {
      timeline.push({
        kind: "sale",
        created_at: s.created_at,
        title: `Sale #${s.id}`,
        amount: Number(s.total || 0)
      });
    }
    for (const r of refunds) {
      timeline.push({
        kind: "refund",
        created_at: r.created_at,
        title: `Refund #${r.id}`,
        amount: -Number(r.total || 0)
      });
    }
    for (const n of notes) {
      timeline.push({
        kind: "note",
        created_at: n.created_at,
        title: n.note || ""
      });
    }
    for (const a of adjustments) {
      timeline.push({
        kind: "adjustment",
        created_at: a.created_at,
        title: a.reason || "Store credit adjustment",
        amount: Number(a.amount_cents || 0) / 100
      });
    }
    timeline.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const alerts = [];
    if (customer.flagged) {
      alerts.push({ kind: "flagged", message: customer.flag_reason || "Customer flagged." });
    }
    if (customer.tax_exempt && customer.tax_exempt_expires_at) {
      const exp = new Date(customer.tax_exempt_expires_at);
      const days = Math.ceil((exp.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
      if (Number.isFinite(days) && days <= 30) {
        alerts.push({ kind: "tax_expiring", message: `Tax exempt expires in ${days} day(s).` });
      }
    }

    res.json({ ok: true, customer, summary, history, notes, adjustments, refunds, timeline, alerts });
  } catch (e) {
    console.error("[API] /api/customers/:id failed:", e);
    res.status(500).json({ ok: false, error: "customer_detail_failed" });
  }
});

app.post("/api/customers", requireRole("clerk", "manager", "owner"), (req, res) => {
  try {
    const raw = req.body || {};
    const name = String(raw.name || "").trim();
    if (!name) return res.status(400).json({ ok: false, error: "missing_name" });

    const type = String(raw.type || "regular").toLowerCase() === "business" ? "business" : "regular";
    const now = new Date().toISOString();

    const info = db.prepare(`
      INSERT INTO customers
        (type, name, phone, phone2, phone3, email, email2, email3, ein, tax_exempt, tax_exempt_expires_at, tags, store_credit_cents, flagged, flag_reason, notes, address1, address2, city, state, zip, active, created_at, updated_at)
      VALUES
        (@type, @name, @phone, @phone2, @phone3, @email, @email2, @email3, @ein, @tax_exempt, @tax_exempt_expires_at, @tags, @store_credit_cents, @flagged, @flag_reason, @notes, @address1, @address2, @city, @state, @zip, 1, @created_at, @updated_at)
    `).run({
      type,
      name,
      phone: String(raw.phone || "").trim(),
      phone2: String(raw.phone2 || "").trim(),
      phone3: String(raw.phone3 || "").trim(),
      email: String(raw.email || "").trim(),
      email2: String(raw.email2 || "").trim(),
      email3: String(raw.email3 || "").trim(),
      ein: String(raw.ein || "").trim(),
      tax_exempt: raw.tax_exempt ? 1 : 0,
      tax_exempt_expires_at: String(raw.tax_exempt_expires_at || "").trim() || null,
      tags: String(raw.tags || "").trim(),
      store_credit_cents: Number(raw.store_credit_cents || 0) || 0,
      flagged: raw.flagged ? 1 : 0,
      flag_reason: String(raw.flag_reason || "").trim(),
      notes: String(raw.notes || "").trim(),
      address1: String(raw.address1 || "").trim(),
      address2: String(raw.address2 || "").trim(),
      city: String(raw.city || "").trim(),
      state: String(raw.state || "").trim(),
      zip: String(raw.zip || "").trim(),
      created_at: now,
      updated_at: now
    });

    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    console.error("[API] /api/customers create failed:", e);
    res.status(500).json({ ok: false, error: "customer_create_failed" });
  }
});

app.put("/api/customers/:id", requireRole("clerk", "manager", "owner"), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "invalid_customer_id" });
  try {
    const raw = req.body || {};
    const name = String(raw.name || "").trim();
    if (!name) return res.status(400).json({ ok: false, error: "missing_name" });
    const type = String(raw.type || "regular").toLowerCase() === "business" ? "business" : "regular";
    const now = new Date().toISOString();

    const info = db.prepare(`
      UPDATE customers SET
        type=@type,
        name=@name,
        phone=@phone,
        phone2=@phone2,
        phone3=@phone3,
        email=@email,
        email2=@email2,
        email3=@email3,
        ein=@ein,
        tax_exempt=@tax_exempt,
        tax_exempt_expires_at=@tax_exempt_expires_at,
        tags=@tags,
        store_credit_cents=@store_credit_cents,
        flagged=@flagged,
        flag_reason=@flag_reason,
        notes=@notes,
        address1=@address1,
        address2=@address2,
        city=@city,
        state=@state,
        zip=@zip,
        updated_at=@updated_at
      WHERE id=@id
    `).run({
      id,
      type,
      name,
      phone: String(raw.phone || "").trim(),
      phone2: String(raw.phone2 || "").trim(),
      phone3: String(raw.phone3 || "").trim(),
      email: String(raw.email || "").trim(),
      email2: String(raw.email2 || "").trim(),
      email3: String(raw.email3 || "").trim(),
      ein: String(raw.ein || "").trim(),
      tax_exempt: raw.tax_exempt ? 1 : 0,
      tax_exempt_expires_at: String(raw.tax_exempt_expires_at || "").trim() || null,
      tags: String(raw.tags || "").trim(),
      store_credit_cents: Number(raw.store_credit_cents || 0) || 0,
      flagged: raw.flagged ? 1 : 0,
      flag_reason: String(raw.flag_reason || "").trim(),
      notes: String(raw.notes || "").trim(),
      address1: String(raw.address1 || "").trim(),
      address2: String(raw.address2 || "").trim(),
      city: String(raw.city || "").trim(),
      state: String(raw.state || "").trim(),
      zip: String(raw.zip || "").trim(),
      updated_at: now
    });

    if (!info.changes) return res.status(404).json({ ok: false, error: "customer_not_found" });
    res.json({ ok: true });
  } catch (e) {
    console.error("[API] /api/customers update failed:", e);
    res.status(500).json({ ok: false, error: "customer_update_failed" });
  }
});

app.post("/api/customers/:id/active", requireRole("clerk", "manager", "owner"), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "invalid_customer_id" });
  try {
    const active = req.body && req.body.active ? 1 : 0;
    const now = new Date().toISOString();
    const info = db.prepare(`
      UPDATE customers SET active=@active, updated_at=@updated_at WHERE id=@id
    `).run({ id, active, updated_at: now });
    if (!info.changes) return res.status(404).json({ ok: false, error: "customer_not_found" });
    res.json({ ok: true });
  } catch (e) {
    console.error("[API] /api/customers/:id/active failed:", e);
    res.status(500).json({ ok: false, error: "customer_active_failed" });
  }
});

app.post("/api/customers/:id/notes", requireRole("clerk", "manager", "owner"), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "invalid_customer_id" });
  try {
    const note = String(req.body?.note || "").trim();
    if (!note) return res.status(400).json({ ok: false, error: "missing_note" });
    const info = db.prepare(`
      INSERT INTO customer_notes (customer_id, note, user_id)
      VALUES (@customer_id, @note, @user_id)
    `).run({ customer_id: id, note, user_id: req.user.id });
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    console.error("[API] /api/customers/:id/notes failed:", e);
    res.status(500).json({ ok: false, error: "customer_note_failed" });
  }
});

app.post("/api/customers/:id/adjustments", requireAuth, requirePerm("store_credit"), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "invalid_customer_id" });
  try {
    const amount_cents = Number(req.body?.amount_cents || 0);
    if (!Number.isFinite(amount_cents) || amount_cents === 0) {
      return res.status(400).json({ ok: false, error: "invalid_amount" });
    }
    const reason = String(req.body?.reason || "").trim();
    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO customer_adjustments (customer_id, amount_cents, reason, user_id)
        VALUES (@customer_id, @amount_cents, @reason, @user_id)
      `).run({ customer_id: id, amount_cents, reason, user_id: req.user.id });
      db.prepare(`
        UPDATE customers SET store_credit_cents = COALESCE(store_credit_cents,0) + @amount_cents,
          updated_at = @updated_at
        WHERE id = @id
      `).run({ amount_cents, updated_at: new Date().toISOString(), id });
    });
    tx();
    logUserAction({
      userId: String(req.user.id || ""),
      username: req.user.username || "",
      action: "store_credit_adjusted",
      screen: "customers",
      metadata: { customerId: id, amountCents: amount_cents, reason }
    });
    res.json({ ok: true });
  } catch (e) {
    console.error("[API] /api/customers/:id/adjustments failed:", e);
    res.status(500).json({ ok: false, error: "customer_adjustment_failed" });
  }
});

app.get("/api/customers/duplicates", requireAuth, (_req, res) => {
  try {
    const rows = db.prepare(`
      SELECT name, COUNT(*) AS cnt
      FROM customers
      WHERE name IS NOT NULL AND name != ''
      GROUP BY lower(name)
      HAVING cnt > 1
      ORDER BY cnt DESC, name ASC
      LIMIT 200
    `).all();

    const dupes = [];
    for (const r of rows) {
      const items = db.prepare(`
        SELECT id, name, phone, phone2, phone3, email, email2, email3, active
        FROM customers
        WHERE lower(name) = lower(?)
        ORDER BY active DESC, id DESC
      `).all(r.name);
      dupes.push({ key: r.name, count: r.cnt, items });
    }
    res.json({ ok: true, rows: dupes });
  } catch (e) {
    console.error("[API] /api/customers/duplicates failed:", e);
    res.status(500).json({ ok: false, error: "customer_duplicates_failed" });
  }
});

app.post("/api/customers/merge", requireRole("manager", "owner"), (req, res) => {
  try {
    const source_id = Number(req.body?.source_id || 0);
    const target_id = Number(req.body?.target_id || 0);
    if (!source_id || !target_id || source_id === target_id) {
      return res.status(400).json({ ok: false, error: "invalid_merge_ids" });
    }

    const tx = db.transaction(() => {
      const source = db.prepare(`SELECT * FROM customers WHERE id=?`).get(source_id);
      const target = db.prepare(`SELECT * FROM customers WHERE id=?`).get(target_id);
      if (!source || !target) throw new Error("customer_not_found");

      // Move sales to target
      db.prepare(`UPDATE sales SET customer_id=? WHERE customer_id=?`).run(target_id, source_id);

      // Move notes/adjustments
      db.prepare(`UPDATE customer_notes SET customer_id=? WHERE customer_id=?`).run(target_id, source_id);
      db.prepare(`UPDATE customer_adjustments SET customer_id=? WHERE customer_id=?`).run(target_id, source_id);

      // Merge contact fields (fill blanks)
      const merged = {
        phone: target.phone || source.phone || "",
        phone2: target.phone2 || source.phone2 || "",
        phone3: target.phone3 || source.phone3 || "",
        email: target.email || source.email || "",
        email2: target.email2 || source.email2 || "",
        email3: target.email3 || source.email3 || "",
        ein: target.ein || source.ein || "",
        tags: [target.tags, source.tags].filter(Boolean).join(", "),
        tax_exempt: target.tax_exempt || source.tax_exempt ? 1 : 0,
        tax_exempt_expires_at: target.tax_exempt_expires_at || source.tax_exempt_expires_at || null,
        store_credit_cents: (Number(target.store_credit_cents || 0) + Number(source.store_credit_cents || 0)),
        flagged: target.flagged || source.flagged ? 1 : 0,
        flag_reason: target.flag_reason || source.flag_reason || ""
      };

      db.prepare(`
        UPDATE customers SET
          phone=@phone, phone2=@phone2, phone3=@phone3,
          email=@email, email2=@email2, email3=@email3,
          ein=@ein, tags=@tags, tax_exempt=@tax_exempt,
          tax_exempt_expires_at=@tax_exempt_expires_at,
          store_credit_cents=@store_credit_cents,
          flagged=@flagged, flag_reason=@flag_reason,
          updated_at=@updated_at
        WHERE id=@id
      `).run({ ...merged, updated_at: new Date().toISOString(), id: target_id });

      // Remove source
      db.prepare(`DELETE FROM customers WHERE id=?`).run(source_id);
    });
    tx();

    res.json({ ok: true });
  } catch (e) {
    const msg = String(e.message || e);
    if (msg === "customer_not_found") return res.status(404).json({ ok: false, error: "customer_not_found" });
    console.error("[API] /api/customers/merge failed:", e);
    res.status(500).json({ ok: false, error: "customer_merge_failed" });
  }
});

// ---------------------------------------------------------------------------
// CUSTOMERS: Export Emails (CSV)
// ---------------------------------------------------------------------------
app.get("/api/customers/export/emails", requireAuth, (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const type = String(req.query.type || "").trim().toLowerCase();
    const tax = String(req.query.tax || "").trim().toLowerCase();
    const active = String(req.query.active || "").trim().toLowerCase();

    const where = [];
    const params = {};
    if (search) {
      where.push(`(
        name LIKE @q OR phone LIKE @q OR phone2 LIKE @q OR phone3 LIKE @q
        OR email LIKE @q OR email2 LIKE @q OR email3 LIKE @q OR ein LIKE @q
      )`);
      params.q = `%${search}%`;
    }
    if (type === "regular" || type === "business") {
      where.push(`type = @type`);
      params.type = type;
    }
    if (tax === "exempt") where.push(`tax_exempt = 1`);
    if (tax === "standard") where.push(`tax_exempt = 0`);
    if (active === "active") where.push(`active = 1`);
    if (active === "inactive") where.push(`active = 0`);

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = db.prepare(`
      SELECT id, name, type, tags, active, email, email2, email3
      FROM customers
      ${whereSql}
      ORDER BY name ASC, id ASC
    `).all(params);

    const seen = new Set();
    const csvRows = [["customer_id", "name", "email", "type", "tags", "active"]];
    for (const c of rows) {
      const emails = [c.email, c.email2, c.email3].map((e) => String(e || "").trim()).filter(Boolean);
      for (const e of emails) {
        const key = e.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        csvRows.push([c.id, c.name || "", e, c.type || "", c.tags || "", c.active ? "active" : "inactive"]);
      }
    }

    const escape = (v) => {
      const s = String(v ?? "");
      if (s.includes('"') || s.includes(",") || s.includes("\n")) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };
    const csv = csvRows.map((r) => r.map(escape).join(",")).join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=customers-emails.csv");
    res.send(csv);
  } catch (e) {
    console.error("[API] /api/customers/export/emails failed:", e);
    res.status(500).json({ ok: false, error: "customer_export_failed" });
  }
});
// ---- Market Lookup API -----------------------------------------------------
app.get("/market/lookup", async (req, res) => {
  try {
    const q = {
      title: req.query.title || "",
      platform: req.query.platform || "",
      category: (req.query.category || "games").toLowerCase(),
      completeness: req.query.completeness || "disc_only",
      isNew: req.query.isNew === "true",
      excludeLots: req.query.excludeLots === "true"
    };

    let comps = [];
    const providers = [];

    if (typeof findSoldComps !== "function") {
      providers.push("ebay:no_app_id");
    } else {
      const ebayRes = await findSoldComps(q);
      if (ebayRes.ok) {
        providers.push("ebay");
        comps = ebayRes.comps || [];
      } else {
        providers.push(`ebay:${ebayRes.reason || "unknown"}`);
      }
    }

    if (q.excludeLots) {
      const lotRe = /\b(lot|bundle|set|bulk|job\s*lot|wholesale)\b/i;
      comps = comps.filter((c) => !lotRe.test(c.title || ""));
    }

    const usd = (comps || []).filter((c) => c && c.currency === "USD" && Number(c.price) > 0);

    let stats = { avg: 0, median: 0, low: 0, high: 0, count: 0 };

    if (usd.length) {
      const prices = usd.map((c) => +c.price).sort((a, b) => a - b);
      const sum = prices.reduce((a, b) => a + b, 0);
      const mid = Math.floor(prices.length / 2);
      const median = prices.length % 2 === 0 ? (prices[mid - 1] + prices[mid]) / 2 : prices[mid];

      stats = {
        avg: +(sum / prices.length).toFixed(2),
        median: +median.toFixed(2),
        low: +prices[0].toFixed(2),
        high: +prices[prices.length - 1].toFixed(2),
        count: prices.length
      };
    }

    res.json({
      query: q,
      stats,
      comps: usd.slice(0, 25),
      providers
    });
  } catch (e) {
    console.error("[/market/lookup]", e);
    res.status(500).json({ error: "market_lookup_failed" });
  }
});

// ---- Start server -----------------------------------------------------------
app.listen(PORT, HOST, () => console.log(`[API] http://${HOST}:${PORT}`));
