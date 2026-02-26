const API_BASE = "http://127.0.0.1:5175";

function getSessionId() {
  return localStorage.getItem("rc_session_id") || "";
}

async function apiGet(path) {
  const res = await fetch(API_BASE + path, {
    headers: { rc_session_id: getSessionId() }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${text}`.trim());
  }
  return res.json();
}

function formatOk(ok) {
  return ok ? "Yes" : "No";
}

function renderStatus(rows) {
  const body = document.getElementById("status-body");
  body.innerHTML = "";
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono">${row.sku || ""}</td>
      <td>${row.action || ""}</td>
      <td class="${row.ok ? "ok" : "fail"}">${formatOk(row.ok)}</td>
      <td>${row.message || ""}</td>
      <td class="mono">${row.created_at || ""}</td>
    `;
    body.appendChild(tr);
  });
}

function renderLog(rows) {
  const body = document.getElementById("log-body");
  body.innerHTML = "";
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono">${row.created_at || ""}</td>
      <td class="mono">${row.sku || ""}</td>
      <td>${row.action || ""}</td>
      <td class="${row.ok ? "ok" : "fail"}">${formatOk(row.ok)}</td>
      <td>${row.message || ""}</td>
    `;
    body.appendChild(tr);
  });
}

async function loadStatus() {
  const channel = document.getElementById("channel-select").value;
  const meta = document.getElementById("status-meta");
  meta.textContent = "Loading...";
  try {
    const data = await apiGet(`/api/sync/status?channel=${encodeURIComponent(channel)}&limit=200`);
    renderStatus(data.rows || []);
    meta.textContent = `Showing ${data.rows?.length || 0} latest entries`;
  } catch (err) {
    meta.textContent = `Failed to load status: ${err.message}`;
  }
}

async function loadLog() {
  const channel = document.getElementById("channel-select").value;
  const meta = document.getElementById("log-meta");
  meta.textContent = "Loading...";
  try {
    const data = await apiGet(`/api/sync/log?channel=${encodeURIComponent(channel)}&limit=200`);
    renderLog(data.rows || []);
    meta.textContent = `Showing ${data.rows?.length || 0} recent entries`;
  } catch (err) {
    meta.textContent = `Failed to load log: ${err.message}`;
  }
}

async function lookupSku() {
  const channel = document.getElementById("channel-select").value;
  const sku = document.getElementById("lookup-sku").value.trim();
  const result = document.getElementById("lookup-result");

  if (!sku) {
    result.textContent = "Enter a SKU.";
    return;
  }

  result.textContent = "Looking up...";
  try {
    const data = await apiGet(`/api/sync/lookup?channel=${encodeURIComponent(channel)}&sku=${encodeURIComponent(sku)}`);
    if (!data.product) {
      result.textContent = "Not found in channel.";
      return;
    }
    const p = data.product;
    result.textContent = `Found: ${p.name || "(unnamed)"} | visible=${p.visible ? "yes" : "no"} | stock=${p.stock ?? "n/a"}`;
  } catch (err) {
    result.textContent = `Lookup failed: ${err.message}`;
  }
}

document.getElementById("refresh-status").addEventListener("click", loadStatus);
document.getElementById("refresh-log").addEventListener("click", loadLog);
document.getElementById("lookup-btn").addEventListener("click", lookupSku);
const linkBtn = document.getElementById("link-wix");
if (linkBtn) {
  linkBtn.addEventListener("click", async () => {
    const ok = confirm("Link Wix products by SKU? This may take a minute.");
    if (!ok) return;
    linkBtn.disabled = true;
    linkBtn.textContent = "Linking...";
    try {
      const res = await fetch(API_BASE + "/api/wix/link-products", {
        method: "POST",
        headers: { "Content-Type": "application/json", rc_session_id: getSessionId() }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(`Link failed: ${data.error || res.status}`);
      } else {
        alert(`Linked ${data.linked || 0} product(s). Scanned ${data.scanned || 0}.`);
      }
    } catch (err) {
      alert("Link failed. Check backend logs.");
    } finally {
      linkBtn.disabled = false;
      linkBtn.textContent = "Link Wix Products by SKU";
      loadStatus();
      loadLog();
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  loadStatus();
  loadLog();
});
