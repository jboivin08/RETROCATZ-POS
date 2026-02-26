// backend/providers/ebay.js
// eBay comps provider for RetroCatz POS
// Uses Finding API:
// - findCompletedItems for SOLD comps
// - findItemsByKeywords for ACTIVE comps

const https = require("https");
const querystring = require("querystring");
const path = require("path");

// Load env from backend/.env explicitly so we don't depend on cwd
// Make sure you have backend/.env with: EBAY_APP_ID=your-app-id-here
require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
});

// Grab APP ID from env (after dotenv)
const EBAY_APP_ID = (process.env.EBAY_APP_ID || "").trim() || null;

// Optional debug (comment out later if noisy)
console.log("[EBAY PROVIDER] EBAY_APP_ID present:", EBAY_APP_ID ? "yes" : "no");

// Small helper to call the eBay FindingService
function callEbayFinding(params) {
  return new Promise((resolve, reject) => {
    const base = "https://svcs.ebay.com/services/search/FindingService/v1";
    const qs = querystring.stringify(params);
    const url = `${base}?${qs}`;

    // console.log("[eBay] GET", url.replace(EBAY_APP_ID, "****APP_ID****"));

    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch (err) {
            reject(err);
          }
        });
      })
      .on("error", (err) => reject(err));
  });
}

/**
 * Build a rough keyword string from POS query.
 * We keep this simple and do most filtering client-side.
 */
function buildKeywords(q) {
  const bits = [];
  if (q.title) bits.push(q.title);
  if (q.platform) bits.push(q.platform);

  // Slight bias based on completeness
  const c = (q.completeness || "").toLowerCase();
  if (c.includes("cib") || c.includes("disc_case")) bits.push("complete");
  if (c.includes("box_only")) bits.push("box");
  if (c.includes("cart_only") || c.includes("disc_only")) bits.push("cartridge");

  // Don’t try to encode isNew here; we’ll filter on condition afterwards
  return bits.join(" ").trim() || "video game";
}

/**
 * Public adapter function used by /market/lookup
 * NOTE: Despite the name, this returns *active listings*, not sold.
 */
function normalizeComps(items, source) {
  return (items || [])
    .map((item) => {
      const title = item.title?.[0] || "";
      const priceNode = item.sellingStatus?.[0]?.currentPrice?.[0] || {};
      const price = parseFloat(priceNode.__value__ || "0");
      const currency = priceNode["@currencyId"] || "USD";
      const url = item.viewItemURL?.[0] || "";
      const endTime =
        item.listingInfo?.[0]?.endTime?.[0] || null;
      const conditionName =
        item.condition?.[0]?.conditionDisplayName?.[0] || "";
      const listingType =
        item.listingInfo?.[0]?.listingType?.[0] || "";

      return {
        title,
        price,
        currency,
        url,
        endTime,
        condition: conditionName,
        listingType,
        source
      };
    })
    .filter((c) => c.price && c.price > 0);
}

async function findSoldComps(q) {
  if (!EBAY_APP_ID) {
    console.error("[eBay] No EBAY_APP_ID found in env");
    return { ok: false, reason: "no_app_id", comps: [] };
  }

  const keywords = buildKeywords(q);
  const country = String(q.country || "US").toUpperCase();
  const params = {
    "OPERATION-NAME": "findCompletedItems",
    "SERVICE-VERSION": "1.0.0",
    "SECURITY-APPNAME": EBAY_APP_ID,
    "RESPONSE-DATA-FORMAT": "JSON",
    "REST-PAYLOAD": "",
    keywords,
    "paginationInput.entriesPerPage": 50,
    "GLOBAL-ID": "EBAY-US",
    "itemFilter(0).name": "SoldItemsOnly",
    "itemFilter(0).value": "true",
    "itemFilter(1).name": "LocatedIn",
    "itemFilter(1).value": country
  };

  let json;
  try {
    json = await callEbayFinding(params);
  } catch (err) {
    console.error("[eBay] HTTP / parse error", err);
    return { ok: false, reason: "http_error", comps: [] };
  }

  try {
    const resp = json.findCompletedItemsResponse?.[0];
    const ack = resp?.ack?.[0];
    if (ack !== "Success") {
      console.error("[eBay] Non-success ACK:", ack);
      return { ok: false, reason: ack || "ebay_error", comps: [] };
    }

    const items = resp.searchResult?.[0]?.item || [];

    const comps = normalizeComps(items, "sold");

    // Optional: filter by "new"/"used" based on q.isNew
    if (typeof q.isNew === "boolean") {
      const wantNew = q.isNew;
      const isNewWord = (s) => String(s || "").toLowerCase().includes("new");
      const filtered = comps.filter((c) => {
        const cond = c.condition || "";
        const t = c.title || "";
        const looksNew = isNewWord(cond) || /sealed|brand new|new\b/i.test(t);
        return wantNew ? looksNew : !looksNew;
      });
      return { ok: true, reason: "ok", comps: filtered.length ? filtered : comps };
    }

    return { ok: true, reason: "ok", comps };
  } catch (err) {
    console.error("[eBay] normalize error", err);
    return { ok: false, reason: "normalize_error", comps: [] };
  }
}

async function findActiveComps(q) {
  if (!EBAY_APP_ID) {
    console.error("[eBay] No EBAY_APP_ID found in env");
    return { ok: false, reason: "no_app_id", comps: [] };
  }

  const keywords = buildKeywords(q);
  const params = {
    "OPERATION-NAME": "findItemsByKeywords",
    "SERVICE-VERSION": "1.0.0",
    "SECURITY-APPNAME": EBAY_APP_ID,
    "RESPONSE-DATA-FORMAT": "JSON",
    "REST-PAYLOAD": "",
    keywords,
    "paginationInput.entriesPerPage": 50,
    "GLOBAL-ID": "EBAY-US",
    sortOrder: "PricePlusShippingLowest"
  };

  let json;
  try {
    json = await callEbayFinding(params);
  } catch (err) {
    console.error("[eBay] HTTP / parse error", err);
    return { ok: false, reason: "http_error", comps: [] };
  }

  try {
    const resp = json.findItemsByKeywordsResponse?.[0];
    const ack = resp?.ack?.[0];
    if (ack !== "Success") {
      console.error("[eBay] Non-success ACK:", ack);
      return { ok: false, reason: ack || "ebay_error", comps: [] };
    }

    const items = resp.searchResult?.[0]?.item || [];
    const comps = normalizeComps(items, "active");

    if (typeof q.isNew === "boolean") {
      const wantNew = q.isNew;
      const isNewWord = (s) => String(s || "").toLowerCase().includes("new");
      const filtered = comps.filter((c) => {
        const cond = c.condition || "";
        const t = c.title || "";
        const looksNew = isNewWord(cond) || /sealed|brand new|new\b/i.test(t);
        return wantNew ? looksNew : !looksNew;
      });
      return { ok: true, reason: "ok", comps: filtered.length ? filtered : comps };
    }

    return { ok: true, reason: "ok", comps };
  } catch (err) {
    console.error("[eBay] normalize error", err);
    return { ok: false, reason: "normalize_error", comps: [] };
  }
}

module.exports = { findSoldComps, findActiveComps };
