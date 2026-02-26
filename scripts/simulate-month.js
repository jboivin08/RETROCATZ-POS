// Simulate one month of POS activity into a new SQLite DB (no impact on production DB).
// Usage: node scripts/simulate-month.js --days 30 --items 800 --out data/sim-month.db --seed 12345

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const val = args[i + 1];
    if (val && !val.startsWith("--")) {
      out[key] = val;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function randChoice(rng, arr) {
  return arr[randInt(rng, 0, arr.length - 1)];
}

function randWeighted(rng, entries) {
  const total = entries.reduce((a, e) => a + e.w, 0);
  let r = rng() * total;
  for (const e of entries) {
    r -= e.w;
    if (r <= 0) return e.v;
  }
  return entries[entries.length - 1].v;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function isoAt(day, rng) {
  const hour = randInt(rng, 10, 20);
  const min = randInt(rng, 0, 59);
  const sec = randInt(rng, 0, 59);
  const d = new Date(day);
  d.setHours(hour, min, sec, 0);
  return d.toISOString();
}

function makeSku(rng, idx) {
  const suffix = String(idx).padStart(6, "0");
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  return `RC-${letters[randInt(rng, 0, letters.length - 1)]}${suffix}`;
}

function main() {
  const args = parseArgs();
  const days = Number(args.days || 30);
  const itemsCount = Number(args.items || 800);
  const seed = Number(args.seed || Date.now());
  const outPath = args.out
    ? path.resolve(args.out)
    : path.resolve(__dirname, "..", "data", `sim-month-${Date.now()}.db`);

  const schemaPath = path.resolve(__dirname, "..", "db", "schema.sql");
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Schema not found: ${schemaPath}`);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  if (fs.existsSync(outPath)) {
    fs.unlinkSync(outPath);
  }

  const rng = mulberry32(seed);
  const db = new Database(outPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const schemaSql = fs.readFileSync(schemaPath, "utf8");
  db.exec(schemaSql);

  const insertUser = db.prepare(`
    INSERT INTO users (username, pw_hash, role, active, display_name, created_at)
    VALUES (@username, @pw_hash, @role, 1, @display_name, datetime('now'))
  `);
  const insertPerms = db.prepare(`INSERT OR IGNORE INTO permissions (user_id) VALUES (?)`);

  const ownerId = insertUser.run({
    username: "owner",
    pw_hash: "x",
    role: "owner",
    display_name: "Owner"
  }).lastInsertRowid;
  insertPerms.run(ownerId);

  const clerkId = insertUser.run({
    username: "clerk",
    pw_hash: "x",
    role: "clerk",
    display_name: "Clerk"
  }).lastInsertRowid;
  insertPerms.run(clerkId);

  const platforms = [
    "Switch", "PS5", "PS4", "PS3", "Xbox One", "Xbox 360", "GameCube", "N64", "NES", "SNES"
  ];
  const categories = ["games", "consoles", "accessories", "controllers", "cables"];
  const conditions = ["new", "like_new", "very_good", "good", "acceptable"];

  const insertItem = db.prepare(`
    INSERT INTO items (sku, title, platform, category, condition, variant, qty, cost, price, createdAt, barcode, source)
    VALUES (@sku, @title, @platform, @category, @condition, '', @qty, @cost, @price, @createdAt, @barcode, @source)
  `);

  for (let i = 1; i <= itemsCount; i++) {
    const price = randInt(rng, 5, 120) + (randInt(rng, 0, 99) / 100);
    const cost = Math.max(0, price * randWeighted(rng, [
      { v: 0.35, w: 2 },
      { v: 0.45, w: 3 },
      { v: 0.55, w: 2 },
      { v: 0.65, w: 1 }
    ]));
    const qty = randInt(rng, 0, 5);
    const sku = makeSku(rng, i);
    insertItem.run({
      sku,
      title: `Item ${sku}`,
      platform: randChoice(rng, platforms),
      category: randChoice(rng, categories),
      condition: randChoice(rng, conditions),
      qty,
      cost: Number(cost.toFixed(2)),
      price: Number(price.toFixed(2)),
      createdAt: new Date(Date.now() - randInt(rng, 1, 240) * 86400000).toISOString(),
      barcode: "",
      source: "seed"
    });
  }

  const insertSale = db.prepare(`
    INSERT INTO sales (created_at, status, subtotal, tax, total, payment_method, user_id, client_txn_uuid)
    VALUES (@created_at, @status, @subtotal, @tax, @total, @payment_method, @user_id, @client_txn_uuid)
  `);
  const insertSaleItem = db.prepare(`
    INSERT INTO sale_items (sale_id, item_id, sku, title, unit_price, qty, taxable, line_total)
    VALUES (@sale_id, @item_id, @sku, @title, @unit_price, @qty, 1, @line_total)
  `);
  const updateQty = db.prepare(`UPDATE items SET qty = @qty WHERE id = @id`);

  const insertRefund = db.prepare(`
    INSERT INTO refunds (sale_id, created_at, reason, user_id)
    VALUES (@sale_id, @created_at, @reason, @user_id)
  `);
  const insertRefundItem = db.prepare(`
    INSERT INTO refund_items (refund_id, sale_item_id, qty_refunded, unit_price, line_total)
    VALUES (@refund_id, @sale_item_id, @qty_refunded, @unit_price, @line_total)
  `);

  const insertWaste = db.prepare(`
    INSERT INTO waste_log (itemId, sku, title, platform, category, condition, qty, costPerUnit, pricePerUnit, totalCost, totalPrice, reason, notes, createdAt)
    VALUES (@itemId, @sku, @title, @platform, @category, @condition, @qty, @costPerUnit, @pricePerUnit, @totalCost, @totalPrice, @reason, @notes, @createdAt)
  `);

  const insertDeleted = db.prepare(`
    INSERT INTO deleted_items (itemId, sku, title, platform, category, condition, qty, cost, price, totalCost, totalPrice, reason, deletedBy, deletedAt)
    VALUES (@itemId, @sku, @title, @platform, @category, @condition, @qty, @cost, @price, @totalCost, @totalPrice, @reason, @deletedBy, @deletedAt)
  `);

  const getAllItems = () => db.prepare("SELECT * FROM items").all();
  const getSaleItems = (saleId) => db.prepare("SELECT * FROM sale_items WHERE sale_id=?").all(saleId);
  const getRefundedQty = (saleItemId) => db.prepare(`
    SELECT COALESCE(SUM(ri.qty_refunded),0) AS c
    FROM refund_items ri
    WHERE ri.sale_item_id = ?
  `).get(saleItemId).c || 0;

  const salesForRefund = [];

  const startDate = new Date();
  startDate.setHours(0, 0, 0, 0);
  startDate.setDate(startDate.getDate() - (days - 1));

  for (let d = 0; d < days; d++) {
    const day = new Date(startDate.getTime() + d * 86400000);
    const tradeIns = randInt(rng, 3, 18);

    for (let i = 0; i < tradeIns; i++) {
      const idx = itemsCount + d * 20 + i + 1;
      const sku = makeSku(rng, idx);
      const price = randInt(rng, 5, 90) + (randInt(rng, 0, 99) / 100);
      const cost = price * randWeighted(rng, [
        { v: 0.25, w: 3 },
        { v: 0.35, w: 3 },
        { v: 0.45, w: 2 }
      ]);
      insertItem.run({
        sku,
        title: `Trade-In ${sku}`,
        platform: randChoice(rng, platforms),
        category: randChoice(rng, categories),
        condition: randChoice(rng, conditions.slice(2)),
        qty: randInt(rng, 1, 3),
        cost: Number(cost.toFixed(2)),
        price: Number(price.toFixed(2)),
        createdAt: isoAt(day, rng),
        barcode: "",
        source: "trade_in"
      });
    }

    const salesToday = randInt(rng, 35, 140);
    for (let s = 0; s < salesToday; s++) {
      const cartLines = randInt(rng, 1, 9);
      const items = getAllItems().filter((it) => Number(it.qty || 0) > 0);
      if (!items.length) break;

      const picked = [];
      for (let i = 0; i < cartLines; i++) {
        const it = randChoice(rng, items);
        if (!it || it.qty <= 0) continue;
        const qty = Math.min(randInt(rng, 1, 3), it.qty);
        const overrideChance = rng() < 0.08;
        const unitPrice = overrideChance
          ? Number((Number(it.price || 0) * randWeighted(rng, [
              { v: 0.75, w: 2 },
              { v: 0.85, w: 3 },
              { v: 0.95, w: 2 },
              { v: 1.05, w: 1 }
            ])).toFixed(2))
          : Number(it.price || 0);
        picked.push({ it, qty });
        picked[picked.length - 1].unitPrice = unitPrice;
      }
      if (!picked.length) continue;

      const created_at = isoAt(day, rng);
      const payment_method = randWeighted(rng, [
        { v: "cash", w: 3 },
        { v: "card", w: 6 },
        { v: "store_credit", w: 1 }
      ]);

      let subtotal = 0;
      for (const line of picked) {
        subtotal += Number(line.unitPrice || line.it.price || 0) * line.qty;
      }
      const discountPct = rng() < 0.15 ? randWeighted(rng, [
        { v: 0.05, w: 4 },
        { v: 0.10, w: 3 },
        { v: 0.15, w: 2 },
        { v: 0.20, w: 1 }
      ]) : 0;
      const discountAmt = rng() < 0.08 ? randInt(rng, 1, 10) : 0;
      const discount = Math.min(subtotal, subtotal * discountPct + discountAmt);
      subtotal = Number((subtotal - discount).toFixed(2));

      const taxExempt = rng() < 0.07;
      const tax = Number((subtotal * 0.07).toFixed(2));
      const total = Number((subtotal + (taxExempt ? 0 : tax)).toFixed(2));

      const saleId = insertSale.run({
        created_at,
        status: "completed",
        subtotal,
        tax: taxExempt ? 0 : tax,
        total,
        payment_method,
        user_id: randChoice(rng, [ownerId, clerkId]),
        client_txn_uuid: `SIM-${d}-${s}-${seed}`
      }).lastInsertRowid;

      for (const line of picked) {
        const it = line.it;
        insertSaleItem.run({
          sale_id: saleId,
          item_id: it.id,
          sku: it.sku,
          title: it.title,
          unit_price: Number(line.unitPrice || it.price || 0),
          qty: line.qty,
          line_total: Number((Number(line.unitPrice || it.price || 0) * line.qty).toFixed(2))
        });
        updateQty.run({ id: it.id, qty: Math.max(0, it.qty - line.qty) });
      }

      salesForRefund.push({ id: saleId, created_at });
    }

    // void a few sales from today
    const voidCount = Math.min(randInt(rng, 0, 4), salesForRefund.length);
    for (let i = 0; i < voidCount; i++) {
      const idx = randInt(rng, 0, salesForRefund.length - 1);
      const sale = salesForRefund.splice(idx, 1)[0];
      if (!sale) continue;
      const lines = getSaleItems(sale.id);
      for (const line of lines) {
        const it = db.prepare("SELECT * FROM items WHERE id=?").get(line.item_id);
        if (it) updateQty.run({ id: it.id, qty: Number(it.qty || 0) + Number(line.qty || 0) });
      }
      db.prepare("UPDATE sales SET status='voided' WHERE id=?").run(sale.id);
    }

    // refunds from recent sales
    const refundCount = randInt(rng, 0, 6);
    for (let i = 0; i < refundCount; i++) {
      if (!salesForRefund.length) break;
      const saleRef = randChoice(rng, salesForRefund);
      if (!saleRef) continue;

      const lines = getSaleItems(saleRef.id);
      if (!lines.length) continue;

      const chosen = randChoice(rng, lines);
      if (!chosen) continue;
      const already = getRefundedQty(chosen.id);
      const remaining = Math.max(0, Number(chosen.qty || 0) - Number(already || 0));
      if (remaining <= 0) continue;

      const qty = Math.max(1, Math.min(remaining, randInt(rng, 1, 2)));
      const refundId = insertRefund.run({
        sale_id: saleRef.id,
        created_at: isoAt(day, rng),
        reason: randWeighted(rng, [
          { v: "customer_return", w: 4 },
          { v: "damaged", w: 1 },
          { v: "price_adjust", w: 1 }
        ]),
        user_id: randChoice(rng, [ownerId, clerkId])
      }).lastInsertRowid;

      insertRefundItem.run({
        refund_id: refundId,
        sale_item_id: chosen.id,
        qty_refunded: qty,
        unit_price: Number(chosen.unit_price || 0),
        line_total: Number((Number(chosen.unit_price || 0) * qty).toFixed(2))
      });

      const it = db.prepare("SELECT * FROM items WHERE id=?").get(chosen.item_id);
      if (it) updateQty.run({ id: it.id, qty: Number(it.qty || 0) + qty });
    }

    // waste write-offs
    const wasteCount = randInt(rng, 0, 2);
    const allItems = getAllItems().filter((it) => Number(it.qty || 0) > 0);
    for (let i = 0; i < wasteCount; i++) {
      if (!allItems.length) break;
      const it = randChoice(rng, allItems);
      if (!it || it.qty <= 0) continue;
      const qty = 1;
      insertWaste.run({
        itemId: it.id,
        sku: it.sku,
        title: it.title,
        platform: it.platform,
        category: it.category,
        condition: it.condition,
        qty,
        costPerUnit: Number(it.cost || 0),
        pricePerUnit: Number(it.price || 0),
        totalCost: Number((Number(it.cost || 0) * qty).toFixed(2)),
        totalPrice: Number((Number(it.price || 0) * qty).toFixed(2)),
        reason: "damaged",
        notes: "",
        createdAt: isoAt(day, rng)
      });
      updateQty.run({ id: it.id, qty: Math.max(0, it.qty - qty) });
    }

    // delete a dead item occasionally
    if (randInt(rng, 0, 20) === 0) {
      const dead = getAllItems().find((it) => Number(it.qty || 0) === 0);
      if (dead) {
        insertDeleted.run({
          itemId: dead.id,
          sku: dead.sku,
          title: dead.title,
          platform: dead.platform,
          category: dead.category,
          condition: dead.condition,
          qty: dead.qty,
          cost: Number(dead.cost || 0),
          price: Number(dead.price || 0),
          totalCost: Number((Number(dead.cost || 0) * Number(dead.qty || 0)).toFixed(2)),
          totalPrice: Number((Number(dead.price || 0) * Number(dead.qty || 0)).toFixed(2)),
          reason: "cleanup",
          deletedBy: "system",
          deletedAt: isoAt(day, rng)
        });
        db.prepare("DELETE FROM items WHERE id=?").run(dead.id);
      }
    }
  }

  const totalSales = db.prepare("SELECT COUNT(*) AS c FROM sales").get().c;
  const totalVoids = db.prepare("SELECT COUNT(*) AS c FROM sales WHERE status='voided'").get().c;
  const totalRefunds = db.prepare("SELECT COUNT(*) AS c FROM refunds").get().c;
  const inventoryCount = db.prepare("SELECT COUNT(*) AS c FROM items").get().c;
  const inventoryUnits = db.prepare("SELECT COALESCE(SUM(qty),0) AS c FROM items").get().c;
  const negativeQty = db.prepare("SELECT COUNT(*) AS c FROM items WHERE qty < 0").get().c;
  const subtotalMismatches = db.prepare(`
    SELECT COUNT(*) AS c
    FROM (
      SELECT s.id,
             ROUND(COALESCE(SUM(si.line_total),0),2) AS lines_total,
             ROUND(s.subtotal,2) AS sale_subtotal
      FROM sales s
      LEFT JOIN sale_items si ON si.sale_id = s.id
      GROUP BY s.id
    )
    WHERE sale_subtotal > lines_total
  `).get().c;
  const discountGaps = db.prepare(`
    SELECT COUNT(*) AS c
    FROM (
      SELECT s.id,
             ROUND(COALESCE(SUM(si.line_total),0),2) AS lines_total,
             ROUND(s.subtotal,2) AS sale_subtotal
      FROM sales s
      LEFT JOIN sale_items si ON si.sale_id = s.id
      GROUP BY s.id
    )
    WHERE sale_subtotal < lines_total
  `).get().c;
  const totalMismatches = db.prepare(`
    SELECT COUNT(*) AS c
    FROM (
      SELECT s.id,
             ROUND(s.subtotal + s.tax,2) AS calc_total,
             ROUND(s.total,2) AS sale_total
      FROM sales s
    )
    WHERE calc_total <> sale_total
  `).get().c;
  const refundOverages = db.prepare(`
    SELECT COUNT(*) AS c
    FROM (
      SELECT si.id,
             si.qty AS sold_qty,
             COALESCE(SUM(ri.qty_refunded),0) AS refunded_qty
      FROM sale_items si
      LEFT JOIN refund_items ri ON ri.sale_item_id = si.id
      GROUP BY si.id
    )
    WHERE refunded_qty > sold_qty
  `).get().c;
  const taxExemptCount = db.prepare("SELECT COUNT(*) AS c FROM sales WHERE tax = 0").get().c;
  const overridePriceCount = db.prepare(`
    SELECT COUNT(*) AS c
    FROM sale_items si
    JOIN items i ON i.id = si.item_id
    WHERE ROUND(si.unit_price,2) <> ROUND(i.price,2)
  `).get().c;
  const orphanSaleItems = db.prepare(`
    SELECT COUNT(*) AS c
    FROM sale_items si
    LEFT JOIN sales s ON s.id = si.sale_id
    WHERE s.id IS NULL
  `).get().c;
  const orphanRefundItems = db.prepare(`
    SELECT COUNT(*) AS c
    FROM refund_items ri
    LEFT JOIN refunds r ON r.id = ri.refund_id
    WHERE r.id IS NULL
  `).get().c;

  const report = {
    outPath,
    seed,
    days,
    items: itemsCount,
    totals: {
      sales: totalSales,
      voids: totalVoids,
      refunds: totalRefunds,
      inventoryCount,
      inventoryUnits,
      taxExemptCount,
      overridePriceCount
    },
    validations: {
      negativeQty,
      subtotalMismatches,
      discountGaps,
      totalMismatches,
      refundOverages,
      orphanSaleItems,
      orphanRefundItems
    }
  };

  const reportPath = outPath.replace(/\.db$/i, ".json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");

  console.log("Simulation complete.");
  console.log(JSON.stringify(report, null, 2));
  console.log("DB:", outPath);
  console.log("Report:", reportPath);
}

main();
