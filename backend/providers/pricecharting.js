const CACHE_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours
const cache = new Map();

function normalizeQuery(q) {
  return String(q || "").trim().toLowerCase();
}

function decodeHtml(str) {
  return String(str || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(html) {
  return decodeHtml(String(html || "").replace(/<[^>]*>/g, " "));
}

function buildSearchUrl(query) {
  return `https://www.pricecharting.com/search-products?type=prices&q=${encodeURIComponent(query)}`;
}

function parseResults(html) {
  const rows = [];
  let headers = null;
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowRegex.exec(html)) !== null) {
    const rowHtml = match[1] || "";
    if (rowHtml.includes("<th")) {
      const ths = Array.from(rowHtml.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)).map(m => stripTags(m[1]).toLowerCase());
      if (ths.length) headers = ths;
      continue;
    }
    const linkMatch = rowHtml.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const href = linkMatch[1] || "";
    const url = href.startsWith("http") ? href : `https://www.pricecharting.com${href}`;
    const linkText = stripTags(linkMatch[2]);
    const cells = Array.from(rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)).map(m => stripTags(m[1]));
    if (!cells.length) continue;
    let platform = "";
    let loose = "";
    let cib = "";
    let newPrice = "";
    let graded = "";
    let volume = "";
    if (headers && headers.length === cells.length) {
      headers.forEach((h, i) => {
        const val = cells[i];
        if (h.includes("console") || h.includes("platform")) platform = val;
        if (h.includes("loose")) loose = val;
        if (h.includes("cib") || h.includes("complete")) cib = val;
        if (h.includes("new")) newPrice = val;
        if (h.includes("graded")) graded = val;
        if (h.includes("volume") || h.includes("sales")) volume = val;
      });
    } else {
      // Best-effort fallback: assume first is title, second is platform, last four are prices
      platform = cells[1] || "";
      const tail = cells.slice(-4);
      [loose, cib, newPrice, graded] = tail;
    }
    rows.push({
      title: linkText || cells[0] || "",
      platform,
      url,
      loose,
      cib,
      new: newPrice,
      graded,
      volume
    });
    if (rows.length >= 5) break;
  }
  return rows;
}

async function fetchPricecharting({ title, platform }) {
  const query = [title, platform].filter(Boolean).join(" ").trim();
  if (!query) {
    return { ok: false, error: "missing_query" };
  }
  const key = normalizeQuery(query);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { ok: true, cached: true, url: cached.url, results: cached.results, fetchedAt: cached.fetchedAt };
  }
  const url = buildSearchUrl(query);
  const res = await fetch(url, {
    headers: {
      "User-Agent": "RetroCatzPOS/1.0 (+local)"
    }
  });
  if (!res.ok) {
    return { ok: false, error: `pricecharting_${res.status}` };
  }
  const html = await res.text();
  const results = parseResults(html);
  const payload = {
    ok: true,
    cached: false,
    url,
    results,
    fetchedAt: new Date().toISOString()
  };
  cache.set(key, { ts: Date.now(), ...payload });
  return payload;
}

module.exports = {
  fetchPricecharting
};
