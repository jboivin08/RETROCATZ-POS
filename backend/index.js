// backend/index.js â€” RetroCatz POS (stabilized backend, condition-agnostic accessories) 
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

const PORT = 5175;

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

// Let file:// renderer call http://127.0.0.1:5175
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
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

// Auth + Bootstrap
// ---------------------------------------------------------------------------
const { requireSession, requireRole, requirePerm } = makeAuthMW(db);
const requireAuth = requireSession;

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
        (user_id, inv_add, inv_edit, inv_delete, cost_change, category_admin, user_admin, checkout, reports)
      VALUES (?, 1,1,1,1,1,1,1,1)
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
    SELECT inv_add, inv_edit, inv_delete, cost_change,
           category_admin, user_admin, checkout, reports
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
    SELECT inv_add, inv_edit, inv_delete, cost_change,
           category_admin, user_admin, checkout, reports
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
makeUserRoutes(app, db, { requireSession, requireRole, requirePerm });

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

// --- WIX SYNC CONFIG & HELPERS ---------------------------------------------
const WIX_SYNC_ENABLED = process.env.WIX_SYNC_ENABLED === "on";
const WIX_API_KEY = process.env.WIX_API_KEY || "";
const WIX_SITE_ID = process.env.WIX_SITE_ID || "";
const WIX_ACCOUNT_ID = process.env.WIX_ACCOUNT_ID || "";
const WIX_CURRENCY = process.env.WIX_CURRENCY || "USD";

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
    // Not configured â†’ just skip
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

  const parts = [];
  if (item.platform) parts.push(item.platform);
  if (item.condition) parts.push(`Condition: ${item.condition}`);
  if (item.category) parts.push(`Category: ${item.category}`);
  const description = parts.join(" â€¢ ");

  const productPayload = {
    name,
    productType: "physical",
    priceData: {
      price,
      currency: WIX_CURRENCY || "USD"
    },
    description,
    sku,
    visible: true
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

// Minimal POS â†’ Wix product sync.
// Now sends a proper "product" object with productType + priceData.
async function syncItemToWix(item) {
  if (!WIX_SYNC_ENABLED) return;
  if (!item) return;

  try {
    const productId = await upsertWixProduct(item);
    if (productId) {
      try {
        db.prepare(`UPDATE items SET wix_product_id=? WHERE id=?`).run(productId, item.id);
      } catch {}
    }
    console.log("[WIX] Synced item to Wix:", { sku: item.sku || "", wixProductId: productId || null });
    logChannelSync({ channel: "wix", action: "sync_item", sku: item.sku || "", ok: 1, message: "synced" });
    return productId;
  } catch (err) {
    console.error("[WIX] Failed to sync item:", item?.sku || "", err.message);
    logChannelSync({ channel: "wix", action: "sync_item", sku: item?.sku || "", ok: 0, message: err.message || "sync_failed" });
    return null;
  }
}

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

    // Step 1 â€” find matching product on Wix by SKU
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

    // Step 2 â€” PATCH the product to hide/unpublish
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

// Margin & Risk Coach â€“ looks for bad margins & overstock
function runMarginRiskCoach() {
  try {
    const settings = db.prepare("SELECT * FROM ai_settings WHERE id = 1").get() || {};
    if (settings.mode === "off") return;

    const anyItems = db.prepare("SELECT COUNT(*) AS c FROM items").get();
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
        return `â€¢ ${r.title} (${r.platform || "Unknown"}) â€” cost $${r.cost.toFixed(
          2
        )}, price $${r.price.toFixed(2)}, qty ${r.qty} (â‰ˆ $${loss} loss per unit)`;
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
        return `â€¢ ${r.title} (${r.platform || "Unknown"}) â€” cost $${r.cost.toFixed(
          2
        )}, price $${r.price.toFixed(2)}, qty ${r.qty} (â‰ˆ ${marginPct.toFixed(1)}% margin)`;
      });

      const body = [
        "These items are running on relatively thin gross margins (â‰¤ 25%):",
        ...lines,
        "",
        "If these are not deliberate â€œtraffic buildersâ€, consider nudging prices up slightly."
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
      WHERE qty >= 3
        AND price BETWEEN 1 AND 40
      ORDER BY qty DESC, price ASC
      LIMIT 10
    `
      )
      .all();

    if (overstock.length) {
      const lines = overstock.map(
        (r) => `â€¢ ${r.title} (${r.platform || "Unknown"}) â€” $${r.price.toFixed(2)} Ã— ${r.qty} units`
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
          "Margin & Risk Coach checked your current inventory and didnâ€™t find any below-cost items, thin margins, or obvious overstock based on current thresholds."
      });
    }

    console.log("[AI] Margin & Risk Coach snapshot refreshed");
  } catch (err) {
    console.error("[AI] Margin & Risk Coach failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Store Oracle v1 â€“ internal inventory insights
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
    `
      )
      .get();

    const lowStockRow = db
      .prepare(
        `
      SELECT COUNT(*) AS c
      FROM items
      WHERE qty <= 1
    `
      )
      .get();

    const deadStockRow = db
      .prepare(
        `
      SELECT COUNT(*) AS c
      FROM items
      WHERE qty > 0
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
      WHERE price >= 40
      ORDER BY price DESC
      LIMIT 5
    `
      )
      .all();

    db.prepare(`DELETE FROM ai_messages WHERE source = 'store_oracle'`).run();

    if (totals.skus > 0) {
      const pulseBody = [
        `You currently track ${totals.skus} SKUs (${totals.units} total units).`,
        `Estimated shelf value (price Ã— qty) is about $${totals.shelfValue.toFixed(2)}.`,
        "",
        `${lowStockRow.c} items are low stock (qty â‰¤ 1).`,
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
        (p) => `â€¢ ${p.platform || "Unspecified"} â†’ ${p.units} units across ${p.skus} SKUs`
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
        (e) => `â€¢ ${e.title} (${e.platform || "Unknown"}) â†’ $${e.price.toFixed(2)} Ã— ${e.qty} units`
      );
      const body = [
        "Higher-value items currently sitting on the shelf:",
        ...lines,
        "",
        "Consider featuring these in social posts, live events, or a â€œpremium shelfâ€ section."
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
// Market Watcher v1 â€“ external comps vs your shelf
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
      WHERE price > 0
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
        return `â€¢ ${r.title} (${r.platform || "Unknown"}) â€” shelf $${r.price.toFixed(
          2
        )}, market median ~$${r.median.toFixed(2)} (â‰ˆ ${r.pct.toFixed(0)}% above, ${r.count} comps)`;
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
        return `â€¢ ${r.title} (${r.platform || "Unknown"}) â€” shelf $${r.price.toFixed(
          2
        )}, market median ~$${r.median.toFixed(2)} (â‰ˆ ${r.pct.toFixed(0)}% above, ${r.count} comps)`;
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

app.post("/api/ai/settings", requireAuth, (req, res) => {
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
    WHERE COALESCE(qty,0) > 0
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
      GROUP BY COALESCE(category,'(uncategorized)')
      ORDER BY units DESC, count DESC
      LIMIT 5
    `).all();

    const topLowStock = db.prepare(`
      SELECT sku, title, qty
      FROM items
      WHERE qty > 0 AND qty <= 2
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
      WHERE COALESCE(i.qty,0) > 0
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
                WHERE COALESCE(qty,0) > 0
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
              "You are RetroCatz Brain, a store operations advisor for a used game shop POS.",
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
          WHERE COALESCE(qty,0) > 0
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
You are the RetroCatz Games pricing assistant.

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
  "summary": "Short 1â€“2 sentence explanation of the pricing and any caveats."
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
    ebay_country: "US"
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

app.put("/api/trade/settings", requireAuth, requireRole("manager", "owner"), (req, res) => {
  const body = req.body || {};
  const expiryDays = clamp(Number(body.quote_expiry_days || 30), 1, 365);
  const cashLimit = Math.max(0, Math.floor(Number(body.approval_cash_limit_cents || 0)));
  const creditLimit = Math.max(0, Math.floor(Number(body.approval_credit_limit_cents || 0)));
  const ebaySold = body.ebay_sold_enabled === undefined ? 1 : (body.ebay_sold_enabled ? 1 : 0);
  const ebayActive = body.ebay_active_enabled === undefined ? 1 : (body.ebay_active_enabled ? 1 : 0);
  const ebayCountry = String(body.ebay_country || "US").toUpperCase();

  db.prepare(`
    UPDATE trade_settings SET
      quote_expiry_days=@quote_expiry_days,
      approval_cash_limit_cents=@approval_cash_limit_cents,
      approval_credit_limit_cents=@approval_credit_limit_cents,
      ebay_sold_enabled=@ebay_sold_enabled,
      ebay_active_enabled=@ebay_active_enabled,
      ebay_country=@ebay_country
    WHERE id=1
  `).run({
    quote_expiry_days: expiryDays,
    approval_cash_limit_cents: cashLimit,
    approval_credit_limit_cents: creditLimit,
    ebay_sold_enabled: ebaySold,
    ebay_active_enabled: ebayActive,
    ebay_country: ebayCountry || "US"
  });

  const { base, userOverride, resolved } = getTradeSettingsForUser(req.user.id);
  res.json({ ok: true, base, userOverride, resolved });
});

app.put("/api/trade/settings/user/:id", requireAuth, requireRole("manager", "owner"), (req, res) => {
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
    const data = await fetchPricecharting({ title, platform });
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
      WHERE ${where}
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
    const keep = it.keep === false ? 0 : 1;
    let compsJson = "";
    if (it.comps) {
      try { compsJson = JSON.stringify(it.comps); } catch {}
    } else if (it.comps_json) {
      compsJson = String(it.comps_json || "");
    }
    return {
      line_no: idx + 1,
      sku: String(it.sku || "").trim(),
      barcode: String(it.barcode || "").trim(),
      title: String(it.title || "").trim(),
      platform: String(it.platform || "").trim(),
      category: String(it.category || "").trim(),
      condition: String(it.condition || "").trim(),
      qty,
      retail_price: Math.max(0, retail),
      credit_offer: Math.max(0, credit),
      cash_offer: Math.max(0, cash),
      reason: String(it.reason || "").trim(),
      comps_json: compsJson,
      keep
    };
  });
}

function computeTradeTotals(items) {
  let totalItems = 0;
  let totalCash = 0;
  let totalCredit = 0;
  let totalRetail = 0;
  for (const it of items) {
    if (!it.keep) continue;
    totalItems += Number(it.qty || 0);
    totalCash += Number(it.cash_offer || 0) * Number(it.qty || 0);
    totalCredit += Number(it.credit_offer || 0) * Number(it.qty || 0);
    totalRetail += Number(it.retail_price || 0) * Number(it.qty || 0);
  }
  return {
    totalItems,
    totalCash: roundMoney(totalCash),
    totalCredit: roundMoney(totalCredit),
    totalRetail: roundMoney(totalRetail)
  };
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

    const quoteId = String(body.quote_id || uuidv4());
    const existing = db.prepare(`SELECT quote_id FROM trade_quotes WHERE quote_id=?`).get(quoteId);
    if (existing) {
      return res.status(409).json({ ok: false, error: "quote_exists", quote_id: quoteId });
    }

    const totals = computeTradeTotals(items);
    const approvalCash = Math.round(Number(totals.totalCash || 0) * 100);
    const approvalCredit = Math.round(Number(totals.totalCredit || 0) * 100);
    const requiresApproval =
      approvalCash > Number(resolved.approval_cash_limit_cents || 0) ||
      approvalCredit > Number(resolved.approval_credit_limit_cents || 0);

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
          total_items, total_cash, total_credit, total_retail, notes
        ) VALUES (
          @quote_id, @status, @created_at, @updated_at, @expires_at,
          @customer_id, @customer_name, @customer_phone, @customer_email, @customer_notes,
          @policy_credit_percent, @policy_cash_percent,
          @approval_cash_limit_cents, @approval_credit_limit_cents,
          @requires_approval, @approved_by, @approved_at,
          @total_items, @total_cash, @total_credit, @total_retail, @notes
        )
      `).run({
        quote_id: quoteId,
        status: "draft",
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
        approved_by: null,
        approved_at: null,
        total_items: totals.totalItems,
        total_cash: totals.totalCash,
        total_credit: totals.totalCredit,
        total_retail: totals.totalRetail,
        notes: String(body.notes || "").trim()
      });

      const ins = db.prepare(`
        INSERT INTO trade_quote_items (
          quote_id, line_no, sku, barcode, title, platform, category, condition,
          qty, retail_price, credit_offer, cash_offer, reason, comps_json, keep
        ) VALUES (
          @quote_id, @line_no, @sku, @barcode, @title, @platform, @category, @condition,
          @qty, @retail_price, @credit_offer, @cash_offer, @reason, @comps_json, @keep
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
    const totals = items ? computeTradeTotals(items) : {
      totalItems: current.total_items,
      totalCash: current.total_cash,
      totalCredit: current.total_credit,
      totalRetail: current.total_retail
    };

    const approvalCash = Math.round(Number(totals.totalCash || 0) * 100);
    const approvalCredit = Math.round(Number(totals.totalCredit || 0) * 100);
    const requiresApproval =
      approvalCash > Number(current.approval_cash_limit_cents || 0) ||
      approvalCredit > Number(current.approval_credit_limit_cents || 0);

    const nextStatus = String(body.status || current.status || "draft").toLowerCase();
    if (nextStatus === "accepted" && requiresApproval && !["manager", "owner"].includes(req.user.role)) {
      return res.status(403).json({ ok: false, error: "approval_required" });
    }

    const now = new Date().toISOString();
    const approvedBy = (nextStatus === "accepted" && ["manager", "owner"].includes(req.user.role))
      ? req.user.id
      : current.approved_by;
    const approvedAt = approvedBy ? (current.approved_at || now) : current.approved_at;

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
            quote_id, line_no, sku, barcode, title, platform, category, condition,
            qty, retail_price, credit_offer, cash_offer, reason, comps_json, keep
          ) VALUES (
            @quote_id, @line_no, @sku, @barcode, @title, @platform, @category, @condition,
            @qty, @retail_price, @credit_offer, @cash_offer, @reason, @comps_json, @keep
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
          priceText = ` â€¢ $${priceNum.toFixed(2)}`;
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

      // ðŸ‘‡ SAME LINE: SKU (code) + price
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
  const rows = db.prepare(`SELECT * FROM items ORDER BY createdAt DESC, id DESC`).all();
  res.json(rows);
});

app.get("/items", requireAuth, (_req, res) => {
  const rows = db.prepare(`SELECT * FROM items ORDER BY createdAt DESC, id DESC`).all();
  res.json(rows);
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
      WHERE barcode = ? OR sku = ?
      ORDER BY createdAt DESC, id DESC
      LIMIT 1
    `
      )
      .get(code, code);

    if (!row) {
      return res.status(404).json({ error: "not_found" });
    }

    res.json({ ok: true, item: row });
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
  const row = db.prepare(`SELECT * FROM items WHERE sku=?`).get(sku);

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
    cost: row.cost
  });
});

app.post("/api/sku", requireAuth, (req, res) => {
  const body = req.body || {};
  const sku = skuFromInputs(body);
  res.json({ ok: true, sku });
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

        const row = db.prepare(`SELECT * FROM items WHERE sku=?`).get(sku);
        return { created: true, grouped: false, priceOverridden: false, item: row };
      }

      if (!existing) {
        db.prepare(
          `
          INSERT INTO items (sku,title,platform,category,condition,variant,qty,cost,price,createdAt,barcode,source)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        `
        ).run(sku, title, platform, category, condition, "", qty, cost, price, now, externalBarcode, source || null);

        const row = db.prepare(`SELECT * FROM items WHERE sku=?`).get(sku);
        return { created: true, grouped: true, priceOverridden: false, item: row };
      }

      const currentPrice = Number(existing.price || 0);
      const barcodeToPersist = externalBarcode || existing.barcode || null;

      if (overridePrice) {
        const newQty = existing.qty + qty;
        const newAvgCost = (existing.cost * existing.qty + cost * qty) / newQty;
        db.prepare(
          `
          UPDATE items
             SET price=?, qty=?, cost=?, barcode=?
           WHERE sku=?
        `
        ).run(price, newQty, newAvgCost, barcodeToPersist, sku);
        const row = db.prepare(`SELECT * FROM items WHERE sku=?`).get(sku);
        return { updated: true, grouped: true, priceOverridden: true, item: row };
      }

      const newQty = existing.qty + qty;
      const newAvgCost = (existing.cost * existing.qty + cost * qty) / newQty;
      db.prepare(
        `
        UPDATE items
           SET qty=?, cost=?, price=?, barcode=?
         WHERE sku=?
      `
      ).run(newQty, newAvgCost, currentPrice, barcodeToPersist, sku);
      const row = db.prepare(`SELECT * FROM items WHERE sku=?`).get(sku);
      return { updated: true, grouped: true, priceOverridden: false, item: row };
    });

    const result = tx();

    // NEW: fire-and-forget Wix sync
    if (result && result.item) {
      syncItemToWix(result.item).catch((err) =>
        console.error("[WIX] sync after POST /api/items failed:", err)
      );
    }

    res.json({ ok: true, ...result });
  } catch (e) {
    console.error("[API] insert/upsert error:", e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Items (get one by id) â€” needed by live-events finalize
app.get("/api/items/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ ok: false, error: "invalid_id" });
  }

  try {
    const row = db.prepare(`SELECT * FROM items WHERE id=?`).get(id);
    if (!row) return res.status(404).json({ ok: false, error: "not_found" });
    return res.json({ ok: true, item: row });
  } catch (e) {
    console.error("[API] get item by id failed:", e);
    return res.status(500).json({ ok: false, error: "db_error" });
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

    const patch = {
      id,
      sku: req.body.sku ?? existing.sku,
      title: req.body.title ?? existing.title,
      platform: req.body.platform ?? existing.platform,
      category: normalizeCategory(req.body.category ?? existing.category),
      condition: req.body.condition ?? existing.condition,
      variant: req.body.variant ?? existing.variant,
      qty: Number.isFinite(+req.body.qty) ? +req.body.qty : existing.qty ?? 1,
      cost: Number.isFinite(+req.body.cost) ? +req.body.cost : existing.cost ?? 0,
      price: Number.isFinite(+req.body.price) ? +req.body.price : existing.price ?? 0,
      barcode: req.body.barcode ?? existing.barcode
    };
    db.prepare(
      `
      UPDATE items
         SET sku=@sku,title=@title,platform=@platform,category=@category,condition=@condition,
             variant=@variant,qty=@qty,cost=@cost,price=@price,barcode=@barcode
       WHERE id=@id
    `
    ).run(patch);
    const item = db.prepare(`SELECT * FROM items WHERE id=?`).get(id);

    // NEW: fire-and-forget Wix sync on update
    if (item) {
      syncItemToWix(item).catch((err) =>
        console.error("[WIX] sync after PUT /api/items/:id failed:", err)
      );
    }

    res.json({ item });
  } catch (e) {
    console.error("[API] update error:", e);
    res.status(400).json({ error: e.message });
  }
});

// Attach local photos to Wix product for this item (manager+)
// Body: { filePaths: [ "C:\\path\\to\\file.jpg", ... ] }
app.post("/api/items/:id/wix-media", requireRole("manager", "owner"), async (req, res) => {
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
        if (up.fileId) mediaIds.push(up.fileId);
        logChannelSync({ channel: "wix", action: "media_upload", sku: item.sku || "", ok: 1, message: path.basename(p) });
      } catch (err) {
        console.error("[WIX] media upload failed:", p, err.message);
        logChannelSync({ channel: "wix", action: "media_upload", sku: item.sku || "", ok: 0, message: err.message || "upload_failed" });
      }
    }

    if (!mediaIds.length) {
      return res.status(500).json({ ok: false, error: "no_media_uploaded" });
    }

    await addWixProductMedia(productId, mediaIds);
    logChannelSync({ channel: "wix", action: "media_attach", sku: item.sku || "", ok: 1, message: `${mediaIds.length} attached` });

    // Persist local photo paths + wix media ids (best effort)
    try {
      const existingPaths = item.photo_paths ? JSON.parse(item.photo_paths) : [];
      const mergedPaths = Array.from(new Set([...(existingPaths || []), ...cleaned]));
      const existingIds = item.wix_media_ids ? JSON.parse(item.wix_media_ids) : [];
      const mergedIds = Array.from(new Set([...(existingIds || []), ...mediaIds]));
      db.prepare(`UPDATE items SET photo_paths=?, wix_media_ids=?, wix_product_id=? WHERE id=?`)
        .run(JSON.stringify(mergedPaths), JSON.stringify(mergedIds), productId, id);
    } catch {}

    res.json({ ok: true, productId, mediaIds });
  } catch (err) {
    console.error("[API] /api/items/:id/wix-media failed:", err);
    res.status(500).json({ ok: false, error: "wix_media_failed" });
  }
});

// Attach photos (data URLs) to Wix product for this item (manager+)
// Body: { files: [ { name, dataUrl } ] }
app.post("/api/items/:id/wix-media-upload", requireRole("manager", "owner"), async (req, res) => {
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

    const mediaIds = [];
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
app.post("/api/wix/link-products", requireRole("manager", "owner"), async (_req, res) => {
  if (!WIX_SYNC_ENABLED || !WIX_API_KEY || !WIX_SITE_ID) {
    return res.status(400).json({ ok: false, error: "wix_not_configured" });
  }

  try {
    let linked = 0;
    let scanned = 0;
    const skuMap = new Map();

    // Load local items into map
    const localItems = db.prepare(`SELECT id, sku FROM items WHERE sku IS NOT NULL AND sku <> ''`).all();
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
        // In the future we can wire this to the logged-in user.
        deletedBy: null,
        deletedAt: now
      });

      // 2) Actually delete from items
      const info = db.prepare(`DELETE FROM items WHERE id=?`).run(id);
      if (info.changes === 0) {
        throw new Error("delete_failed");
      }
    });

    tx();

    // 3) Fire-and-forget Wix hide
    if (existing.sku) {
      hideItemInWix(existing.sku).catch((err) =>
        console.error("[WIX] hide after local delete failed:", err.message)
      );
      console.log(
        "[WIX] Local item deleted, attempted hide/unpublish in Wix:",
        existing.sku
      );
    }

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

    return res.json({ ok: true, id });

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

      // 1) Update or remove the item
      if (newQty <= 0) {
        db.prepare(`DELETE FROM items WHERE id=?`).run(id);
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

      return newQty;
    });

    const newQty = tx();

    const updated =
      newQty > 0
        ? db.prepare(`SELECT * FROM items WHERE id=?`).get(id)
        : null;

    // NEW: tell Wix about the new inventory state for this SKU
    try {
      if (updated && updated.sku) {
        syncInventoryToWixBySku(updated.sku).catch((err) =>
          console.error("[WIX] sync after WASTE failed:", err.message)
        );
      } else if (existing && existing.sku) {
        // Item fully removed locally; we just log for now.
        console.log("[WIX] Item fully written off locally, consider hiding in Wix:", existing.sku);
      }
    } catch (err) {
      console.error("[WIX] post-waste sync error:", err.message);
    }

    return res.json({
      ok: true,
      deleted: !updated,
      item: updated,
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

// REPORTS: Sales summary (supports single date OR range)
// GET /api/reports/daily-sales?date=YYYY-MM-DD
// OR  /api/reports/daily-sales?start=YYYY-MM-DD&end=YYYY-MM-DD
// ---------------------------------------------------------------------------
function notImplemented(_req, res) {
  res.json({ ok: true, rows: [], summary: "coming_soon", error: "not_implemented" });
}

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

function parseSyncLimit(raw, fallback = 200) {
  const num = Number(raw);
  if (!Number.isFinite(num)) return fallback;
  if (num < 1) return 1;
  return Math.min(Math.floor(num), 1000);
}

// ---------------------------------------------------------------------------
// CHANNEL SYNC MONITOR
// ---------------------------------------------------------------------------
app.get(
  "/api/sync/log",
  requireAuth,
  requireRole("manager", "owner"),
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
  requireRole("manager", "owner"),
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
  requireRole("manager", "owner"),
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

  const grossRow = db
    .prepare(`SELECT COALESCE(SUM(total),0) AS total FROM sales s WHERE s.status='completed' AND ${salesWhere.clause}`)
    .get(...salesWhere.params);
  const itemsRow = db
    .prepare(
      `SELECT COALESCE(SUM(si.qty),0) AS qty
       FROM sale_items si
       JOIN sales s ON s.id=si.sale_id
       WHERE s.status='completed' AND ${salesWhere.clause}`
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

  const invRow = db.prepare(`SELECT COUNT(*) AS c FROM items`).get();
  const lowRow = db.prepare(`SELECT COUNT(*) AS c FROM items WHERE COALESCE(qty,0) <= 1`).get();

  res.json({
    ok: true,
    range: req.query.range || "today",
    inventoryTotalItems: Number(invRow?.c || 0),
    todaySalesTotal: netSales,
    pendingTradeIns: 0,
    lowStockCount: Number(lowRow?.c || 0),
    grossSales,
    refundTotal,
    netSales,
    itemsSold,
    marginPct: null
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
  const salesWhere = salesWhereClause("s", rangeInfo);
  const rows = db
    .prepare(
      `SELECT COALESCE(i.category,'Uncategorized') AS category,
              SUM(si.line_total) AS total,
              SUM(si.qty) AS qty
       FROM sale_items si
       JOIN sales s ON s.id=si.sale_id
       LEFT JOIN items i ON (i.id=si.item_id OR i.sku=si.sku)
       WHERE s.status='completed' AND ${salesWhere.clause}
       GROUP BY COALESCE(i.category,'Uncategorized')
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
      detail: `${qty} sold â€¢ $${sales.toFixed(2)}`,
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
       ${plat !== "all" ? "WHERE lower(platform)=?" : ""}
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
      detail: `${qty} units â€¢ ${r.items} items`,
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
    .prepare(`SELECT title, qty, createdAt FROM items`)
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
  const cols = 5;
  const rowsCount = 2;
  const levels = new Array(cols * rowsCount).fill(0);
  const summary = "Coming soon: trade-in analytics";
  return { grid: { rows: rowsCount, cols, levels }, summary, points: [] };
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

app.get("/api/reports/events/list", requireAuth, notImplemented);
app.get("/api/events/list", requireAuth, notImplemented);
app.get("/api/reports/dashboard", requireAuth, notImplemented);
app.get("/api/reports/discounts", requireAuth, notImplemented);
app.get("/api/reports/fees", requireAuth, notImplemented);
app.get("/api/reports/event-summary", requireAuth, notImplemented);
app.get("/api/reports/event-items", requireAuth, notImplemented);
app.get("/api/reports/waste-analytics", requireAuth, notImplemented);
app.get("/api/reports/sales-by-item", requireAuth, (req, res) => {
  const range = parseDateRange(req);
  if (range.error) return res.status(400).json({ ok: false, error: range.error });
  const { startDate, endDate } = range;

  try {
    const soldRows = db.prepare(
      `
      SELECT
        si.item_id,
        si.sku,
        si.title,
        SUM(si.qty) AS sold_qty,
        SUM(si.line_total) AS sold_total
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      WHERE s.status = 'completed'
        AND (si.line_type IS NULL OR si.line_type!='discount')
        AND date(s.created_at) BETWEEN date(@start) AND date(@end)
      GROUP BY si.item_id, si.sku, si.title
    `
    ).all({ start: startDate, end: endDate });

    const refundRows = db.prepare(
      `
      SELECT
        si.item_id,
        si.sku,
        SUM(ri.qty_refunded) AS refunded_qty,
        SUM(ri.line_total) AS refunded_total
      FROM refund_items ri
      JOIN refunds r ON r.id = ri.refund_id
      JOIN sale_items si ON si.id = ri.sale_item_id
      WHERE date(r.created_at) BETWEEN date(@start) AND date(@end)
      GROUP BY si.item_id, si.sku
    `
    ).all({ start: startDate, end: endDate });

    const refundsByItem = new Map();
    for (const r of refundRows) {
      refundsByItem.set(String(r.item_id), {
        refunded_qty: Number(r.refunded_qty || 0),
        refunded_total: Number(r.refunded_total || 0)
      });
    }

    const rows = soldRows.map((s) => {
      const r = refundsByItem.get(String(s.item_id)) || { refunded_qty: 0, refunded_total: 0 };
      const sold_qty = Number(s.sold_qty || 0);
      const sold_total = Number(s.sold_total || 0);
      const net_qty = Math.max(0, sold_qty - Number(r.refunded_qty || 0));
      const net_total = Number((sold_total - Number(r.refunded_total || 0)).toFixed(2));
      return {
        item_id: s.item_id,
        sku: s.sku,
        title: s.title || "",
        sold_qty,
        sold_total,
        refunded_qty: Number(r.refunded_qty || 0),
        refunded_total: Number(r.refunded_total || 0),
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

app.get("/api/reports/sales-by-category", requireAuth, (req, res) => {
  const range = parseDateRange(req);
  if (range.error) return res.status(400).json({ ok: false, error: range.error });
  const { startDate, endDate } = range;

  try {
    const soldRows = db.prepare(
      `
      SELECT
        COALESCE(i.category,'(uncategorized)') AS category,
        SUM(si.qty) AS sold_qty,
        SUM(si.line_total) AS sold_total
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      LEFT JOIN items i ON i.id = si.item_id
      WHERE s.status = 'completed'
        AND (si.line_type IS NULL OR si.line_type!='discount')
        AND date(s.created_at) BETWEEN date(@start) AND date(@end)
      GROUP BY COALESCE(i.category,'(uncategorized)')
    `
    ).all({ start: startDate, end: endDate });

    const refundRows = db.prepare(
      `
      SELECT
        COALESCE(i.category,'(uncategorized)') AS category,
        SUM(ri.qty_refunded) AS refunded_qty,
        SUM(ri.line_total) AS refunded_total
      FROM refund_items ri
      JOIN refunds r ON r.id = ri.refund_id
      JOIN sale_items si ON si.id = ri.sale_item_id
      LEFT JOIN items i ON i.id = si.item_id
      WHERE date(r.created_at) BETWEEN date(@start) AND date(@end)
      GROUP BY COALESCE(i.category,'(uncategorized)')
    `
    ).all({ start: startDate, end: endDate });

    const refundsByCat = new Map();
    for (const r of refundRows) {
      refundsByCat.set(String(r.category), {
        refunded_qty: Number(r.refunded_qty || 0),
        refunded_total: Number(r.refunded_total || 0)
      });
    }

    const rows = soldRows.map((s) => {
      const r = refundsByCat.get(String(s.category)) || { refunded_qty: 0, refunded_total: 0 };
      const sold_qty = Number(s.sold_qty || 0);
      const sold_total = Number(s.sold_total || 0);
      const net_qty = Math.max(0, sold_qty - Number(r.refunded_qty || 0));
      const net_total = Number((sold_total - Number(r.refunded_total || 0)).toFixed(2));
      return {
        category: s.category,
        sold_qty,
        sold_total,
        refunded_qty: Number(r.refunded_qty || 0),
        refunded_total: Number(r.refunded_total || 0),
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

app.get("/api/reports/payment-mix", requireAuth, (req, res) => {
  const range = parseDateRange(req);
  if (range.error) return res.status(400).json({ ok: false, error: range.error });
  const { startDate, endDate } = range;

  try {
    const rows = db.prepare(
      `
      SELECT
        COALESCE(payment_method,'unknown') AS method,
        COALESCE(SUM(total),0) AS total
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

app.get("/api/reports/inventory", requireAuth, (_req, res) => {
  try {
    const items = db.prepare(`SELECT * FROM items ORDER BY createdAt DESC, id DESC`).all();
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
app.get("/api/reports/daily-sales", requireAuth, (req, res) => {
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
        discount: 0,
        fees: 0,
        total: Number(summary.total || 0),
        refunds: Number(refundsTotal.total || 0),
        net: Number((Number(summary.total || 0) - Number(refundsTotal.total || 0)).toFixed(2))
      },
      payments: payments.map((p) => ({
        method: p.method || "unknown",
        amount: Number(p.amount || 0)
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
app.get("/api/reports/waste", requireAuth, (req, res) => {
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
app.get("/api/reports/deleted", requireAuth, (req, res) => {
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
app.post("/api/deleted-items/:id/restore", requireAuth, (req, res) => {
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
      } else {
        // Merge qty back into existing row; keep existing price/cost
        const newQty = (existing.qty || 0) + qty;
        db.prepare(`UPDATE items SET qty = ? WHERE id = ?`).run(newQty, existing.id);
      }

      // 2) Optional: mark this deleted row as restored (so you know it was undone)
      // If you want an explicit flag, add a migration to deleted_items first.
      // For now we just leave the row as historical record.

      // 3) Log activity
      logUserAction({
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
app.post("/api/sales/complete", requireRole("clerk", "manager", "owner"), (req, res) => {
  try {
    const raw = (req.body && req.body.sale) ? req.body.sale : (req.body || {});
    const items = Array.isArray(raw.items) ? raw.items : [];
    if (!items.length) return res.status(400).json({ ok: false, error: "no_items" });

    const nowIso = new Date().toISOString();
    const payment_method = raw?.tender?.type || raw.payment_method || "unknown";
    const client_txn_uuid = raw.id || raw.client_txn_uuid || null;
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

    const tx = db.transaction(() => {
      let computedSubtotal = 0;
      const lineRows = [];

      for (const line of items) {
        const sku = String(line.sku || "").trim();
        const qty = Math.max(1, Number(line.qty || 1));
        if (!sku) throw new Error("missing_sku");

        const row = db.prepare(`SELECT * FROM items WHERE sku=?`).get(sku);
        if (!row) throw new Error(`sku_not_found:${sku}`);

        if (Number(row.qty || 0) < qty) {
          throw new Error(`insufficient_qty:${sku}`);
        }

        const unit_price = Number.isFinite(+line.price) ? Number(line.price) : Number(row.price || 0);
        const line_total = unit_price * qty;
        computedSubtotal += line_total;

        lineRows.push({
          item_id: row.id,
          sku,
          title: row.title || line.title || "",
          unit_price,
          qty,
          taxable: 1,
          line_total,
          line_type: "item"
        });
      }

      const discount =
        Number.isFinite(+raw.discount) ? Number(raw.discount)
          : Number.isFinite(+raw.discount_cents) ? Number(raw.discount_cents) / 100 : 0;
      const subtotal =
        Number.isFinite(+raw.subtotal) ? Number(raw.subtotal)
          : Number(computedSubtotal - Math.min(Math.max(0, discount), computedSubtotal));
      const tax =
        Number.isFinite(+raw.tax) ? Number(raw.tax)
          : Number.isFinite(+raw.tax_cents) ? Number(raw.tax_cents) / 100 : 0;
      const total =
        Number.isFinite(+raw.total) ? Number(raw.total) : subtotal + tax;

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
        const current = db.prepare(`SELECT qty FROM items WHERE id=?`).get(line.item_id);
        const newQty = Math.max(0, Number(current.qty || 0) - line.qty);
        db.prepare(`UPDATE items SET qty=? WHERE id=?`).run(newQty, line.item_id);
        logInventoryMovement({
          item_id: line.item_id,
          sku: line.sku,
          qty_delta: -line.qty,
          reason: "sale",
          sale_id: saleId,
          user_id: req.user.id
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

      return { saleId, subtotal, tax, total };
    });

    const result = tx();
    logSaleEvent({
      sale_id: result.saleId,
      action: "completed",
      user_id: req.user.id,
      metadata: { subtotal: result.subtotal, tax: result.tax, total: result.total }
    });

    // fire-and-forget Wix sync for affected SKUs
    try {
      const skusToSync = [...new Set(items.map((line) => String(line.sku || "").trim()).filter(Boolean))];
      for (const sku of skusToSync) {
        syncInventoryToWixBySku(sku).catch((err) =>
          console.error("[WIX] sync after SALE failed:", sku, err.message)
        );
      }
    } catch (err) {
      console.error("[WIX] post-sale sync error:", err.message);
    }

    res.json({ ok: true, saleId: result.saleId, totals: { subtotal: result.subtotal, tax: result.tax, total: result.total } });
  } catch (err) {
    const msg = String(err.message || err);
    if (msg.startsWith("insufficient_qty:")) {
      return res.status(409).json({ ok: false, error: "insufficient_qty", sku: msg.split(":")[1] });
    }
    if (msg.startsWith("sku_not_found:")) {
      return res.status(404).json({ ok: false, error: "sku_not_found", sku: msg.split(":")[1] });
    }
    console.error("[API] /api/sales/complete failed:", err);
    res.status(500).json({ ok: false, error: "sale_failed" });
  }
});

// ---------------------------------------------------------------------------
// SALES: Void Sale (manager+)
// POST /api/sales/:saleId/void
// ---------------------------------------------------------------------------
app.post("/api/sales/:saleId/void", requireRole("manager", "owner"), (req, res) => {
  const saleId = Number(req.params.saleId);
  if (!Number.isFinite(saleId)) return res.status(400).json({ ok: false, error: "invalid_sale_id" });

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
            db.prepare(`UPDATE items SET qty=? WHERE id=?`).run(Number(row.qty || 0) + qty, it.item_id);
          } else {
            db.prepare(`
              INSERT INTO items (sku, title, qty, price, cost, createdAt)
              VALUES (?, ?, ?, ?, 0, ?)
            `).run(it.sku || "", it.title || "", qty, Number(it.unit_price || 0), new Date().toISOString());
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
            db.prepare(`UPDATE items SET qty=? WHERE sku=?`).run(Number(row.qty || 0) + qty, it.sku);
          } else {
            db.prepare(`
              INSERT INTO items (sku, title, qty, price, cost, createdAt)
              VALUES (?, ?, ?, ?, 0, ?)
            `).run(it.sku || "", it.title || "", qty, Number(it.unit_price || 0), new Date().toISOString());
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
      }
      db.prepare(`UPDATE sales SET status='voided' WHERE id=?`).run(saleId);
    });

    tx();
    logSaleEvent({
      sale_id: saleId,
      action: "voided",
      user_id: req.user.id
    });

    try {
      for (const sku of [...new Set(skusToSync)]) {
        syncInventoryToWixBySku(sku).catch((err) =>
          console.error("[WIX] sync after VOID failed:", sku, err.message)
        );
      }
    } catch (err) {
      console.error("[WIX] post-void sync error:", err.message);
    }

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
app.post("/api/sales/:saleId/refund", requireRole("manager", "owner"), (req, res) => {
  const saleId = Number(req.params.saleId);
  if (!Number.isFinite(saleId)) return res.status(400).json({ ok: false, error: "invalid_sale_id" });

  const { items = [], reason = "" } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ ok: false, error: "no_items" });
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
            db.prepare(`UPDATE items SET qty=? WHERE id=?`).run(Number(row.qty || 0) + qtyReq, saleItem.item_id);
          } else {
            db.prepare(`
              INSERT INTO items (sku, title, qty, price, cost, createdAt)
              VALUES (?, ?, ?, ?, 0, ?)
            `).run(saleItem.sku || "", saleItem.title || "", qtyReq, unit_price, new Date().toISOString());
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
            db.prepare(`UPDATE items SET qty=? WHERE sku=?`).run(Number(row.qty || 0) + qtyReq, saleItem.sku);
          } else {
            db.prepare(`
              INSERT INTO items (sku, title, qty, price, cost, createdAt)
              VALUES (?, ?, ?, ?, 0, ?)
            `).run(saleItem.sku || "", saleItem.title || "", qtyReq, unit_price, new Date().toISOString());
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
      }

      return { refundId, refundTotal };
    });

    const result = tx();
    logSaleEvent({
      sale_id: saleId,
      action: "refund",
      user_id: req.user.id,
      metadata: { refundId: result.refundId, refundTotal: result.refundTotal }
    });

    try {
      for (const sku of [...new Set(skusToSync)].filter(Boolean)) {
        syncInventoryToWixBySku(sku).catch((err) =>
          console.error("[WIX] sync after REFUND failed:", sku, err.message)
        );
      }
    } catch (err) {
      console.error("[WIX] post-refund sync error:", err.message);
    }

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

app.post("/api/customers/:id/adjustments", requireRole("manager", "owner"), (req, res) => {
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
app.listen(PORT, () => console.log(`[API] http://localhost:${PORT}`));




