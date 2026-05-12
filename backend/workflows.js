const { v4: uuidv4 } = require("uuid");

function mountStoreWorkflowRoutes(app, db, deps) {
  const {
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
  } = deps;

  const clean = (value, max = 500) => String(value ?? "").trim().slice(0, max);
  const lower = (value) => clean(value).toLowerCase().replace(/\s+/g, " ");
  const intVal = (value, fallback = 0) => {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) ? n : fallback;
  };
  const centsFrom = (body, centsKey, moneyKey) => {
    if (Number.isFinite(Number(body?.[centsKey]))) return Math.max(0, Math.round(Number(body[centsKey])));
    return Math.max(0, toCents(body?.[moneyKey]));
  };
  const dollars = (cents) => toDollars(Number(cents || 0));

  function customerSnapshot(body = {}) {
    const id = Number(body.customer_id || body.customerId || 0) || null;
    const customer = id ? db.prepare(`SELECT * FROM customers WHERE id=?`).get(id) : null;
    return {
      customer,
      customer_id: customer?.id || id || null,
      customer_name: clean(body.customer_name || body.customerName || customer?.name, 160),
      customer_phone: clean(body.customer_phone || body.customerPhone || customer?.phone, 60),
      customer_email: clean(body.customer_email || body.customerEmail || customer?.email, 160)
    };
  }

  function itemSummary(itemIdOrSku) {
    if (Number.isFinite(Number(itemIdOrSku))) {
      return db.prepare(`SELECT * FROM items WHERE id=? AND deleted_at IS NULL`).get(Number(itemIdOrSku));
    }
    return db.prepare(`SELECT * FROM items WHERE sku=? AND deleted_at IS NULL`).get(String(itemIdOrSku || ""));
  }

  function serializeWishlist(row, matches = null) {
    return {
      ...row,
      max_price: dollars(row.max_price_cents),
      matches: matches || undefined
    };
  }

  function requestMatchesItem(request, item) {
    if (!request || !item || Number(item.qty || 0) <= 0) return false;
    if (request.status && request.status !== "active") return false;
    if (Number(request.max_price_cents || 0) > 0 && toCents(item.price) > Number(request.max_price_cents || 0)) return false;

    const reqPlatform = lower(request.platform);
    const itemPlatform = lower(item.platform);
    if (reqPlatform && itemPlatform && !itemPlatform.includes(reqPlatform) && !reqPlatform.includes(itemPlatform)) return false;

    const reqCategory = lower(request.category);
    const itemCategory = lower(item.category);
    if (reqCategory && itemCategory && !itemCategory.includes(reqCategory) && !reqCategory.includes(itemCategory)) return false;

    const reqCondition = lower(request.condition_pref);
    const itemCondition = lower(item.condition);
    if (reqCondition && itemCondition && !itemCondition.includes(reqCondition) && !reqCondition.includes(itemCondition)) return false;

    const wanted = lower(request.title);
    const itemText = lower(`${item.title || ""} ${item.platform || ""} ${item.sku || ""}`);
    if (!wanted) return false;
    if (itemText.includes(wanted) || wanted.includes(lower(item.title))) return true;
    const tokens = wanted.split(/[^a-z0-9]+/).filter((token) => token.length >= 3);
    if (!tokens.length) return false;
    return tokens.every((token) => itemText.includes(token));
  }

  function activeWishlistRows() {
    return db.prepare(`
      SELECT *
      FROM wishlist_requests
      WHERE status='active'
      ORDER BY datetime(updated_at) DESC, id DESC
    `).all();
  }

  function requestInventoryMatches(request, limit = 25) {
    const items = db.prepare(`
      SELECT id, sku, title, platform, category, condition, qty, price
      FROM items
      WHERE deleted_at IS NULL AND COALESCE(qty,0) > 0
      ORDER BY datetime(COALESCE(createdAt, '1970-01-01')) DESC, id DESC
      LIMIT 1000
    `).all();
    return items
      .filter((item) => requestMatchesItem(request, item))
      .slice(0, limit)
      .map((item) => ({ ...item, price: Number(item.price || 0) }));
  }

  function wishlistMatchesForItem(item) {
    return activeWishlistRows()
      .filter((request) => requestMatchesItem(request, item))
      .map((request) => serializeWishlist(request));
  }

  function allWishlistMatches() {
    const requests = activeWishlistRows();
    const items = db.prepare(`SELECT * FROM items WHERE deleted_at IS NULL AND COALESCE(qty,0) > 0`).all();
    const rows = [];
    for (const item of items) {
      const matches = requests
        .filter((request) => requestMatchesItem(request, item))
        .map((request) => serializeWishlist(request));
      if (matches.length) rows.push({ item_id: item.id, sku: item.sku, title: item.title, matches });
    }
    return rows;
  }

  function customerWorkflowFilter(customer, { email = false } = {}) {
    const clauses = ["customer_id=@customer_id"];
    const params = { customer_id: customer.id };
    const name = clean(customer.name, 160);
    if (name) {
      clauses.push("(customer_id IS NULL AND customer_name=@customer_name)");
      params.customer_name = name;
    }
    const phones = [customer.phone, customer.phone2, customer.phone3].map((v) => clean(v, 60)).filter(Boolean);
    phones.forEach((phone, idx) => {
      const key = `phone_${idx}`;
      clauses.push(`(customer_id IS NULL AND customer_phone=@${key})`);
      params[key] = phone;
    });
    if (email) {
      const emails = [customer.email, customer.email2, customer.email3].map((v) => clean(v, 160)).filter(Boolean);
      emails.forEach((addr, idx) => {
        const key = `email_${idx}`;
        clauses.push(`(customer_id IS NULL AND customer_email=@${key})`);
        params[key] = addr;
      });
    }
    return { where: `(${clauses.join(" OR ")})`, params };
  }

  function serializeLayaway(row) {
    const items = db.prepare(`
      SELECT *
      FROM layaway_items
      WHERE layaway_id=?
      ORDER BY id ASC
    `).all(row.id);
    const payments = db.prepare(`
      SELECT *
      FROM layaway_payments
      WHERE layaway_id=?
      ORDER BY datetime(created_at) DESC, id DESC
    `).all(row.id);
    const paid = Number(row.paid_cents || 0);
    const total = Number(row.total_cents || 0);
    return {
      ...row,
      total: dollars(total),
      deposit: dollars(row.deposit_cents),
      paid: dollars(paid),
      balance: dollars(Math.max(0, total - paid)),
      items: items.map((item) => ({ ...item, unit_price: dollars(item.unit_price_cents), line_total: dollars(item.unit_price_cents * item.qty) })),
      payments: payments.map((payment) => ({ ...payment, amount: dollars(payment.amount_cents) }))
    };
  }

  function serializePreorder(row) {
    return {
      ...row,
      expected_price: dollars(row.expected_price_cents),
      deposit: dollars(row.deposit_cents)
    };
  }

  function serializeRepair(row) {
    return {
      ...row,
      estimate: dollars(row.estimate_cents),
      deposit: dollars(row.deposit_cents),
      parts: dollars(row.parts_cents),
      labor: dollars(row.labor_cents),
      total: dollars(Number(row.parts_cents || 0) + Number(row.labor_cents || 0))
    };
  }

  function serializeBundle(row) {
    const components = db.prepare(`
      SELECT bi.*, i.qty AS current_qty, i.price AS current_price, i.cost AS current_cost
      FROM bundle_items bi
      LEFT JOIN items i ON i.id=bi.item_id
      WHERE bi.bundle_id=?
      ORDER BY bi.id ASC
    `).all(row.id);
    return {
      ...row,
      price: dollars(row.price_cents),
      components,
      availability_label: Number(row.available || 0) ? "available" : "unavailable"
    };
  }

  function repairTicketNo(id) {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    return `REP-${day}-${String(id).padStart(4, "0")}`;
  }

  function normalizeWorkflowStatus(value, allowed, fallback) {
    const status = lower(value || fallback).replace(/\s+/g, "_");
    return allowed.has(status) ? status : fallback;
  }

  function intakeInventoryItem({ title, platform, category, condition, qty, costCents, priceCents, source, userId, forceNewGroup = false }) {
    const cleanTitle = clean(title, 240);
    const cleanCondition = clean(condition || "Good", 80) || "Good";
    const cleanPlatform = clean(platform, 120);
    const cleanCategory = normalizeCategory(category || "Games") || "Games";
    const count = Math.max(1, intVal(qty, 1));
    const cost = dollars(costCents);
    const price = dollars(priceCents);
    const baseSku = skuFromInputs({ title: cleanTitle, platform: cleanPlatform, category: cleanCategory, condition: cleanCondition });
    let sku = baseSku;
    const now = new Date().toISOString();

    const existing = db.prepare(`SELECT * FROM items WHERE sku=?`).get(sku);
    if (forceNewGroup && existing) {
      sku = `${baseSku}-${String(Date.now()).slice(-5)}${Math.floor(Math.random() * 90 + 10)}`;
    }
    const rowToMerge = forceNewGroup ? null : existing;
    if (!rowToMerge) {
      db.prepare(`
        INSERT INTO items (sku,title,platform,category,condition,variant,qty,cost,price,createdAt,barcode,source,deleted_at,deleted_reason)
        VALUES (@sku,@title,@platform,@category,@condition,'',@qty,@cost,@price,@createdAt,null,@source,null,null)
      `).run({
        sku,
        title: cleanTitle,
        platform: cleanPlatform,
        category: cleanCategory,
        condition: cleanCondition,
        qty: count,
        cost,
        price,
        createdAt: now,
        source: source || null
      });
      const created = db.prepare(`SELECT * FROM items WHERE sku=?`).get(sku);
      if (created?.id) {
        setInventoryBucketQty(created.id, "sellable", "store", count);
        syncItemQtyFromBuckets(created.id);
      }
    } else {
      ensureItemBucketBaseline(rowToMerge);
      const oldQty = Math.max(0, Number(rowToMerge.qty || 0));
      const nextQty = oldQty + count;
      const nextCost = nextQty > 0
        ? ((Number(rowToMerge.cost || 0) * oldQty) + (cost * count)) / nextQty
        : cost;
      const nextPrice = Number(rowToMerge.price || 0) > 0 ? Number(rowToMerge.price || 0) : price;
      db.prepare(`
        UPDATE items
        SET qty=@qty,
            cost=@cost,
            price=@price,
            source=COALESCE(source, @source),
            deleted_at=NULL,
            deleted_reason=NULL
        WHERE sku=@sku
      `).run({ sku, qty: nextQty, cost: Number(nextCost.toFixed(2)), price: nextPrice, source: source || null });
      changeInventoryBucketQty(rowToMerge, "sellable", "store", count);
    }

    const row = db.prepare(`SELECT * FROM items WHERE sku=?`).get(sku);
    logInventoryMovement({
      item_id: row?.id || null,
      sku,
      qty_delta: count,
      reason: "workflow_intake",
      user_id: userId || null,
      note: source || ""
    });
    if (costCents > 0 && count > 0) {
      insertExpense({
        expense_date: now,
        type: "inventory",
        category: "Inventory",
        vendor: source || null,
        memo: `Inventory intake: ${cleanTitle}${cleanPlatform ? " - " + cleanPlatform : ""}`,
        amount: dollars(costCents * count),
        tax_amount: 0,
        payment_method: source && source.includes("store_credit") ? "store_credit" : null,
        source: source || "workflow",
        item_id: row?.id || null,
        sku,
        title: cleanTitle,
        qty: count,
        unit_cost: cost,
        user_id: userId || null
      });
    }
    return row;
  }

  function adjustLoyalty(customerId, points, reason, { saleId = null, amountCents = 0, userId = null } = {}) {
    const id = Number(customerId || 0);
    const delta = intVal(points, 0);
    if (!id || !delta) return null;
    const customer = db.prepare(`SELECT * FROM customers WHERE id=?`).get(id);
    if (!customer) return null;
    const current = Number(customer.loyalty_points || 0);
    const next = Math.max(0, current + delta);
    const actualDelta = next - current;
    db.prepare(`UPDATE customers SET loyalty_points=?, updated_at=datetime('now') WHERE id=?`).run(next, id);
    db.prepare(`
      INSERT INTO loyalty_transactions (customer_id, sale_id, points_delta, reason, amount_cents, user_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, saleId || null, actualDelta, clean(reason || "Loyalty adjustment", 200), Number(amountCents || 0), userId || null);
    return db.prepare(`SELECT * FROM customers WHERE id=?`).get(id);
  }

  function awardLoyaltyForSale(sale, userId) {
    const customerId = Number(sale?.customer_id || 0);
    const totalCents = Math.max(0, toCents(sale?.total || 0));
    const points = Math.floor(totalCents / 100);
    if (!customerId || !points) return null;
    return adjustLoyalty(customerId, points, `Sale #${sale.id}`, {
      saleId: sale.id,
      amountCents: totalCents,
      userId
    });
  }

  function reverseLoyaltyForSale(saleId, amountCents, userId, reason = "Sale reversal") {
    const sale = db.prepare(`SELECT * FROM sales WHERE id=?`).get(Number(saleId || 0));
    const customerId = Number(sale?.customer_id || 0);
    const cents = Math.max(0, Number(amountCents || toCents(sale?.total || 0)));
    const points = Math.floor(cents / 100);
    if (!customerId || !points) return null;
    return adjustLoyalty(customerId, -points, `${reason} #${saleId}`, {
      saleId,
      amountCents: cents,
      userId
    });
  }

  function bundleIdFromSource(source) {
    const m = /^bundle:(\d+)$/i.exec(clean(source));
    return m ? Number(m[1]) : 0;
  }

  function bundleItemSource(bundleId) {
    return `bundle:${Number(bundleId || 0)}`;
  }

  function bundleBuildable(bundleId) {
    const components = db.prepare(`
      SELECT bi.qty AS needed_qty, i.qty AS current_qty, i.deleted_at
      FROM bundle_items bi
      JOIN items i ON i.id=bi.item_id
      WHERE bi.bundle_id=?
    `).all(bundleId);
    if (!components.length) return 0;
    let buildable = Infinity;
    for (const component of components) {
      const needed = Math.max(1, Number(component.needed_qty || 1));
      const current = component.deleted_at ? 0 : Math.max(0, Number(component.current_qty || 0));
      buildable = Math.min(buildable, Math.floor(current / needed));
    }
    return Number.isFinite(buildable) ? Math.max(0, buildable) : 0;
  }

  function refreshBundleAvailability(bundleId) {
    const bundle = db.prepare(`SELECT * FROM bundles WHERE id=?`).get(Number(bundleId || 0));
    if (!bundle) return null;
    const buildable = bundleBuildable(bundle.id);
    const active = bundle.status === "active";
    const available = active && buildable > 0 ? 1 : 0;
    const now = new Date().toISOString();
    db.prepare(`UPDATE bundles SET available=?, updated_at=? WHERE id=?`).run(available, now, bundle.id);

    const bundleItem = bundle.bundle_item_id
      ? db.prepare(`SELECT * FROM items WHERE id=?`).get(bundle.bundle_item_id)
      : null;
    if (bundleItem) {
      db.prepare(`
        UPDATE items
        SET title=@title,
            category='Bundles',
            condition='Bundle',
            variant='BUNDLE',
            qty=@qty,
            price=@price,
            source=@source,
            deleted_at=NULL,
            deleted_reason=NULL
        WHERE id=@id
      `).run({
        id: bundleItem.id,
        title: bundle.title,
        qty: available ? 1 : 0,
        price: dollars(bundle.price_cents),
        source: bundleItemSource(bundle.id)
      });
      db.prepare(`UPDATE inventory_quantities SET qty=0, updated_at=datetime('now') WHERE item_id=?`).run(bundleItem.id);
      if (available) setInventoryBucketQty(bundleItem.id, "sellable", "store", 1);
      syncItemQtyFromBuckets(bundleItem.id);
    }
    return serializeBundle(db.prepare(`SELECT * FROM bundles WHERE id=?`).get(bundle.id));
  }

  function refreshAllBundleAvailability() {
    const rows = db.prepare(`SELECT id FROM bundles`).all();
    return rows.map((row) => refreshBundleAvailability(row.id)).filter(Boolean);
  }

  function assertBundleAvailableItem(item, qty = 1) {
    const bundleId = bundleIdFromSource(item?.source);
    if (!bundleId) return null;
    const wanted = Math.max(1, Number(qty || 1));
    const bundle = db.prepare(`SELECT * FROM bundles WHERE id=?`).get(bundleId);
    if (!bundle || bundle.status !== "active") throw new Error(`bundle_unavailable:${bundleId}`);
    if (wanted > 1) throw new Error(`bundle_qty_limit:${bundleId}`);
    if (bundleBuildable(bundleId) < wanted) throw new Error(`bundle_unavailable:${bundleId}`);
    return bundle;
  }

  function applyBundleSaleLine(line, { saleId, userId, username } = {}) {
    const bundleId = bundleIdFromSource(line?.source);
    if (!bundleId) return null;
    const qty = Math.max(1, Number(line?.qty || 1));
    const bundle = assertBundleAvailableItem({ source: bundleItemSource(bundleId) }, qty);
    const components = db.prepare(`
      SELECT bi.*, i.qty AS current_qty
      FROM bundle_items bi
      JOIN items i ON i.id=bi.item_id
      WHERE bi.bundle_id=?
    `).all(bundleId);
    for (const component of components) {
      const need = Math.max(1, Number(component.qty || 1)) * qty;
      if (Number(component.current_qty || 0) < need) throw new Error(`bundle_unavailable:${bundleId}`);
      consumeInventoryFromBuckets(component.item_id, need, ["sellable"]);
      logInventoryMovement({
        item_id: component.item_id,
        sku: component.sku,
        qty_delta: -need,
        reason: "bundle_component_sale",
        sale_id: saleId || null,
        user_id: userId || null,
        note: `Bundle #${bundleId}: ${bundle.title || ""}`
      });
    }
    const now = new Date().toISOString();
    db.prepare(`UPDATE bundles SET status='sold', available=0, sold_at=?, updated_at=? WHERE id=?`).run(now, now, bundleId);
    if (bundle.bundle_item_id) {
      db.prepare(`UPDATE inventory_quantities SET qty=0, updated_at=datetime('now') WHERE item_id=?`).run(bundle.bundle_item_id);
      syncItemQtyFromBuckets(bundle.bundle_item_id);
    }
    logUserAction({
      userId: String(userId || ""),
      username: username || "",
      action: "bundle_sold",
      screen: "pos",
      metadata: { bundleId, saleId: saleId || null }
    });
    refreshAllBundleAvailability();
    return bundleId;
  }

  function reverseBundleSaleLine(line, { saleId, refundId, userId, username, reason = "reversed" } = {}) {
    const bundleId = bundleIdFromSource(line?.source);
    if (!bundleId) return null;
    const qty = Math.max(1, Number(line?.qty || 1));
    const bundle = db.prepare(`SELECT * FROM bundles WHERE id=?`).get(bundleId);
    if (!bundle) return null;
    const components = db.prepare(`
      SELECT *
      FROM bundle_items
      WHERE bundle_id=?
      ORDER BY id ASC
    `).all(bundleId);
    for (const component of components) {
      const restoreQty = Math.max(1, Number(component.qty || 1)) * qty;
      const item = db.prepare(`SELECT * FROM items WHERE id=?`).get(component.item_id);
      if (!item) continue;
      db.prepare(`UPDATE items SET deleted_at=NULL, deleted_reason=NULL WHERE id=?`).run(component.item_id);
      changeInventoryBucketQty(item, "sellable", "store", restoreQty);
      logInventoryMovement({
        item_id: component.item_id,
        sku: component.sku,
        qty_delta: restoreQty,
        reason: reason === "refund" ? "bundle_component_refund" : "bundle_component_void",
        sale_id: saleId || null,
        refund_id: refundId || null,
        user_id: userId || null,
        note: `Bundle #${bundleId}: ${bundle.title || ""}`
      });
    }
    db.prepare(`UPDATE bundles SET status='active', sold_at=NULL, updated_at=datetime('now') WHERE id=?`).run(bundleId);
    logUserAction({
      userId: String(userId || ""),
      username: username || "",
      action: reason === "refund" ? "bundle_refunded" : "bundle_voided",
      screen: "pos",
      metadata: { bundleId, saleId: saleId || null, refundId: refundId || null }
    });
    refreshAllBundleAvailability();
    return bundleId;
  }

  function reserveBundleLayawayLine(line, { layawayId, userId, username } = {}) {
    const bundleId = bundleIdFromSource(line?.source);
    if (!bundleId) return null;
    const qty = Math.max(1, Number(line?.qty || 1));
    const bundle = assertBundleAvailableItem({ source: bundleItemSource(bundleId) }, qty);
    const components = db.prepare(`
      SELECT bi.*, i.qty AS current_qty
      FROM bundle_items bi
      JOIN items i ON i.id=bi.item_id
      WHERE bi.bundle_id=?
    `).all(bundleId);
    for (const component of components) {
      const need = Math.max(1, Number(component.qty || 1)) * qty;
      if (Number(component.current_qty || 0) < need) throw new Error(`bundle_unavailable:${bundleId}`);
      consumeInventoryFromBuckets(component.item_id, need, ["sellable"]);
      logInventoryMovement({
        item_id: component.item_id,
        sku: component.sku,
        qty_delta: -need,
        reason: "bundle_component_layaway",
        user_id: userId || null,
        note: `Layaway #${layawayId || ""}: ${bundle.title || ""}`.trim()
      });
    }
    const now = new Date().toISOString();
    db.prepare(`UPDATE bundles SET status='inactive', available=0, updated_at=? WHERE id=?`).run(now, bundleId);
    if (bundle.bundle_item_id) {
      db.prepare(`UPDATE inventory_quantities SET qty=0, updated_at=datetime('now') WHERE item_id=?`).run(bundle.bundle_item_id);
      syncItemQtyFromBuckets(bundle.bundle_item_id);
    }
    logUserAction({
      userId: String(userId || ""),
      username: username || "",
      action: "bundle_layaway_reserved",
      screen: "pos",
      metadata: { bundleId, layawayId: layawayId || null }
    });
    refreshAllBundleAvailability();
    return bundleId;
  }

  function releaseBundleLayawayLine(line, { layawayId, userId, username } = {}) {
    const bundleId = bundleIdFromSource(line?.source);
    if (!bundleId) return null;
    const qty = Math.max(1, Number(line?.qty || 1));
    const bundle = db.prepare(`SELECT * FROM bundles WHERE id=?`).get(bundleId);
    if (!bundle) return null;
    const components = db.prepare(`SELECT * FROM bundle_items WHERE bundle_id=? ORDER BY id ASC`).all(bundleId);
    for (const component of components) {
      const restoreQty = Math.max(1, Number(component.qty || 1)) * qty;
      const item = db.prepare(`SELECT * FROM items WHERE id=?`).get(component.item_id);
      if (!item) continue;
      db.prepare(`UPDATE items SET deleted_at=NULL, deleted_reason=NULL WHERE id=?`).run(component.item_id);
      changeInventoryBucketQty(item, "sellable", "store", restoreQty);
      logInventoryMovement({
        item_id: component.item_id,
        sku: component.sku,
        qty_delta: restoreQty,
        reason: "bundle_component_layaway_cancel",
        user_id: userId || null,
        note: `Layaway #${layawayId || ""}: ${bundle.title || ""}`.trim()
      });
    }
    db.prepare(`UPDATE bundles SET status='active', sold_at=NULL, updated_at=datetime('now') WHERE id=?`).run(bundleId);
    logUserAction({
      userId: String(userId || ""),
      username: username || "",
      action: "bundle_layaway_cancelled",
      screen: "pos",
      metadata: { bundleId, layawayId: layawayId || null }
    });
    refreshAllBundleAvailability();
    return bundleId;
  }

  function completeBundleLayawayLine(line, { layawayId, userId, username } = {}) {
    const bundleId = bundleIdFromSource(line?.source);
    if (!bundleId) return null;
    const bundle = db.prepare(`SELECT * FROM bundles WHERE id=?`).get(bundleId);
    if (!bundle) return null;
    const now = new Date().toISOString();
    db.prepare(`UPDATE bundles SET status='sold', available=0, sold_at=?, updated_at=? WHERE id=?`).run(now, now, bundleId);
    if (bundle.bundle_item_id) {
      db.prepare(`UPDATE inventory_quantities SET qty=0, updated_at=datetime('now') WHERE item_id=?`).run(bundle.bundle_item_id);
      syncItemQtyFromBuckets(bundle.bundle_item_id);
    }
    logUserAction({
      userId: String(userId || ""),
      username: username || "",
      action: "bundle_layaway_completed",
      screen: "pos",
      metadata: { bundleId, layawayId: layawayId || null }
    });
    refreshAllBundleAvailability();
    return bundleId;
  }

  function allocateTradeCosts(rows, payoutAmountCents) {
    const kept = rows.filter((row) => Number(row.keep || 0) !== 0 && Number(row.qty || 0) > 0);
    const weighted = kept.map((row) => {
      const qty = Math.max(1, Number(row.qty || 1));
      const retailCents = Math.max(0, Math.round(Number(row.retail_price || 0) * 100));
      return {
        row,
        qty,
        weight: retailCents > 0 ? retailCents * qty : qty
      };
    });
    const totalWeight = weighted.reduce((sum, entry) => sum + entry.weight, 0) || weighted.reduce((sum, entry) => sum + entry.qty, 0) || 1;
    let allocated = 0;
    return weighted.map((entry, index) => {
      const lineTotalCents = index === weighted.length - 1
        ? Math.max(0, payoutAmountCents - allocated)
        : Math.round(payoutAmountCents * (entry.weight / totalWeight));
      allocated += lineTotalCents;
      return {
        row: entry.row,
        qty: entry.qty,
        lineTotalCents,
        unitCostCents: Math.round(lineTotalCents / entry.qty)
      };
    });
  }

  function completeTradeQuote(quoteId, body, user) {
    const quote = db.prepare(`SELECT * FROM trade_quotes WHERE quote_id=?`).get(clean(quoteId, 120));
    if (!quote) throw new Error("quote_not_found");
    if (Number(quote.inventory_posted || 0) === 1 || quote.intake_created_at || quote.completed_at) {
      return {
        quote: db.prepare(`SELECT * FROM trade_quotes WHERE quote_id=?`).get(quote.quote_id),
        items: db.prepare(`SELECT * FROM trade_intake_tasks WHERE quote_id=? AND task_type='inventory_review' ORDER BY id ASC`).all(quote.quote_id),
        intakeItems: db.prepare(`SELECT * FROM trade_intake_tasks WHERE quote_id=? AND task_type='inventory_review' ORDER BY id ASC`).all(quote.quote_id),
        tasks: db.prepare(`SELECT * FROM trade_intake_tasks WHERE quote_id=? ORDER BY id ASC`).all(quote.quote_id),
        alreadyCompleted: true
      };
    }
    const rows = db.prepare(`SELECT * FROM trade_quote_items WHERE quote_id=? ORDER BY line_no ASC, id ASC`).all(quote.quote_id);
    const keepRows = rows.filter((row) => Number(row.keep || 0) !== 0 && Number(row.qty || 0) > 0);
    if (!keepRows.length) throw new Error("no_trade_items");

    const settings = db.prepare(`SELECT * FROM trade_settings WHERE id=1`).get() || {};
    if (Number(settings.require_customer || 0) && !Number(quote.customer_id || 0)) throw new Error("customer_required");
    if (Number(settings.require_seller_id || 0) && !clean(quote.seller_id_last4, 20)) throw new Error("seller_id_required");
    if (Number(settings.require_agreement || 0) && Number(quote.agreement_signed || 0) !== 1) throw new Error("agreement_required");
    if (Number(quote.requires_approval || 0) && !quote.approved_by && !["manager", "owner"].includes(user?.role)) {
      throw new Error("approval_required");
    }

    const payoutMethod = lower(body?.payout_method || body?.payoutMethod || "store_credit") === "cash" ? "cash" : "store_credit";
    if (payoutMethod === "store_credit" && !Number(quote.customer_id || 0)) throw new Error("customer_required_for_credit");
    const payoutAmountCents = payoutMethod === "cash"
      ? toCents(quote.final_cash_offer || quote.total_cash || 0)
      : toCents(quote.final_credit_offer || quote.total_credit || 0);
    const now = new Date().toISOString();
    const intakeRows = [];
    const createdTasks = [];
    const allocations = allocateTradeCosts(keepRows, payoutAmountCents);

    const tx = db.transaction(() => {
      const insertTask = db.prepare(`
        INSERT INTO trade_intake_tasks
          (quote_id, quote_item_id, item_id, sku, task_type, status,
           title, platform, category, condition, completeness, qty,
           retail_price, allocated_cost, allocated_total_cost,
           inventory_action, post_status, due_at, notes,
           created_at, updated_at, user_id)
        VALUES
          (@quote_id, @quote_item_id, @item_id, @sku, @task_type, 'open',
           @title, @platform, @category, @condition, @completeness, @qty,
           @retail_price, @allocated_cost, @allocated_total_cost,
           @inventory_action, @post_status, @due_at, @notes,
           @created_at, @updated_at, @user_id)
      `);
      for (const allocation of allocations) {
        const row = allocation.row;
        const qty = allocation.qty;
        const allocatedCost = allocation.unitCostCents / 100;
        const allocatedTotalCost = allocation.lineTotalCents / 100;
        db.prepare(`
          UPDATE trade_quote_items
          SET allocated_cost=@allocated_cost,
              allocated_total_cost=@allocated_total_cost
          WHERE id=@id
        `).run({
          id: row.id,
          allocated_cost: allocatedCost,
          allocated_total_cost: allocatedTotalCost
        });
        const taskBase = {
          quote_id: quote.quote_id,
          quote_item_id: row.id || null,
          item_id: null,
          sku: row.sku || null,
          title: row.title || "",
          platform: row.platform || "",
          category: row.category || "Games",
          condition: row.condition || "",
          completeness: row.completeness || "loose",
          qty,
          retail_price: Number(row.retail_price || 0),
          allocated_cost: allocatedCost,
          allocated_total_cost: allocatedTotalCost,
          inventory_action: row.inventory_action || "merge",
          post_status: row.post_status || "testing",
          user_id: user?.id || null
        };
        const holdUntil = clean(row.hold_until || quote.hold_until, 40);
        const postStatus = lower(row.post_status || "");
        insertTask.run({
          ...taskBase,
          task_type: "inventory_review",
          due_at: holdUntil || null,
          notes: clean(row.condition_notes || row.offer_reason || "Review title, platform, completeness, price, cost, and SKU before adding to inventory.", 1000),
          created_at: now,
          updated_at: now
        });
        if (Number(settings.testing_queue_enabled || 0) && (Number(row.test_needed || 0) || ["testing", "repair", "parts"].includes(postStatus))) {
          insertTask.run({
            ...taskBase,
            task_type: postStatus === "repair" || postStatus === "parts" ? "repair_review" : "test",
            due_at: holdUntil || null,
            notes: clean(row.condition_notes || row.offer_reason || "", 1000),
            created_at: now,
            updated_at: now
          });
        }
        if (Number(row.label_needed || 0) || Number(settings.auto_label_on_complete || 0)) {
          insertTask.run({
            ...taskBase,
            task_type: "label",
            due_at: null,
            notes: "Print shelf label after intake.",
            created_at: now,
            updated_at: now
          });
        }
        if (postStatus === "hold" || holdUntil) {
          insertTask.run({
            ...taskBase,
            task_type: "hold",
            due_at: holdUntil || null,
            notes: "Do not sell until hold is cleared.",
            created_at: now,
            updated_at: now
          });
        }
      }

      if (payoutMethod === "store_credit" && Number(quote.customer_id || 0) && payoutAmountCents > 0) {
        db.prepare(`
          UPDATE customers
          SET store_credit_cents=COALESCE(store_credit_cents,0)+@amount,
              updated_at=@updated_at
          WHERE id=@customer_id
        `).run({ amount: payoutAmountCents, updated_at: now, customer_id: quote.customer_id });
        db.prepare(`
          INSERT INTO customer_adjustments (customer_id, amount_cents, reason, created_at, user_id)
          VALUES (@customer_id, @amount_cents, @reason, @created_at, @user_id)
        `).run({
          customer_id: quote.customer_id,
          amount_cents: payoutAmountCents,
          reason: `Trade-in ${quote.quote_id}`,
          created_at: now,
          user_id: user?.id || null
        });
      }

      db.prepare(`
        UPDATE trade_quotes
        SET status='accepted',
            payout_method=@payout_method,
            payout_amount_cents=@payout_amount_cents,
            inventory_posted=0,
            inventory_posted_at=NULL,
            intake_created_at=@now,
            completed_at=@now,
            updated_at=@now
        WHERE quote_id=@quote_id
      `).run({
        quote_id: quote.quote_id,
        payout_method: payoutMethod,
        payout_amount_cents: payoutAmountCents,
        now
      });
    });

    tx();
    createdTasks.push(...db.prepare(`SELECT * FROM trade_intake_tasks WHERE quote_id=? ORDER BY id ASC`).all(quote.quote_id));
    intakeRows.push(...createdTasks.filter((task) => task.task_type === "inventory_review"));
    return {
      quote: db.prepare(`SELECT * FROM trade_quotes WHERE quote_id=?`).get(quote.quote_id),
      items: intakeRows,
      intakeItems: intakeRows,
      tasks: createdTasks,
      alreadyCompleted: false
    };
  }

  // Wishlist
  app.get("/api/wishlist", requireAuth, (req, res) => {
    try {
      const status = clean(req.query.status || "active", 40);
      const where = status === "all" ? "" : "WHERE status=@status";
      const rows = db.prepare(`
        SELECT *
        FROM wishlist_requests
        ${where}
        ORDER BY
          CASE status WHEN 'active' THEN 0 WHEN 'fulfilled' THEN 1 ELSE 2 END,
          datetime(updated_at) DESC,
          id DESC
        LIMIT 500
      `).all(status === "all" ? {} : { status });
      res.json({ ok: true, rows: rows.map((row) => serializeWishlist(row)) });
    } catch (err) {
      console.error("[WORKFLOWS] wishlist list failed:", err);
      res.status(500).json({ ok: false, error: "wishlist_list_failed" });
    }
  });

  app.post("/api/wishlist", requireAuth, (req, res) => {
    try {
      const body = req.body || {};
      const title = clean(body.title, 200);
      if (!title) return res.status(400).json({ ok: false, error: "missing_title" });
      const customer = customerSnapshot(body);
      const now = new Date().toISOString();
      const info = db.prepare(`
        INSERT INTO wishlist_requests
          (customer_id, customer_name, customer_phone, customer_email, title, platform, category, condition_pref,
           max_price_cents, status, notes, created_at, updated_at, user_id)
        VALUES
          (@customer_id, @customer_name, @customer_phone, @customer_email, @title, @platform, @category, @condition_pref,
           @max_price_cents, 'active', @notes, @created_at, @updated_at, @user_id)
      `).run({
        ...customer,
        title,
        platform: clean(body.platform, 120),
        category: clean(body.category, 120),
        condition_pref: clean(body.condition_pref || body.condition, 120),
        max_price_cents: centsFrom(body, "max_price_cents", "max_price"),
        notes: clean(body.notes, 1000),
        created_at: now,
        updated_at: now,
        user_id: req.user.id
      });
      const row = db.prepare(`SELECT * FROM wishlist_requests WHERE id=?`).get(info.lastInsertRowid);
      res.json({ ok: true, wishlist: serializeWishlist(row) });
    } catch (err) {
      console.error("[WORKFLOWS] wishlist create failed:", err);
      res.status(500).json({ ok: false, error: "wishlist_create_failed" });
    }
  });

  app.put("/api/wishlist/:id", requireAuth, (req, res) => {
    try {
      const id = Number(req.params.id);
      const existing = db.prepare(`SELECT * FROM wishlist_requests WHERE id=?`).get(id);
      if (!existing) return res.status(404).json({ ok: false, error: "wishlist_not_found" });
      const body = req.body || {};
      const customer = customerSnapshot({ ...existing, ...body });
      const status = normalizeWorkflowStatus(body.status || existing.status, new Set(["active", "fulfilled", "cancelled"]), existing.status);
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE wishlist_requests
        SET customer_id=@customer_id,
            customer_name=@customer_name,
            customer_phone=@customer_phone,
            customer_email=@customer_email,
            title=@title,
            platform=@platform,
            category=@category,
            condition_pref=@condition_pref,
            max_price_cents=@max_price_cents,
            status=@status,
            notes=@notes,
            matched_item_id=@matched_item_id,
            updated_at=@updated_at,
            fulfilled_at=@fulfilled_at
        WHERE id=@id
      `).run({
        id,
        ...customer,
        title: clean(body.title ?? existing.title, 200),
        platform: clean(body.platform ?? existing.platform, 120),
        category: clean(body.category ?? existing.category, 120),
        condition_pref: clean(body.condition_pref ?? body.condition ?? existing.condition_pref, 120),
        max_price_cents: body.max_price_cents !== undefined || body.max_price !== undefined ? centsFrom(body, "max_price_cents", "max_price") : existing.max_price_cents,
        status,
        notes: clean(body.notes ?? existing.notes, 1000),
        matched_item_id: Number(body.matched_item_id || body.matchedItemId || existing.matched_item_id || 0) || null,
        updated_at: now,
        fulfilled_at: status === "fulfilled" ? (existing.fulfilled_at || now) : existing.fulfilled_at
      });
      const row = db.prepare(`SELECT * FROM wishlist_requests WHERE id=?`).get(id);
      res.json({ ok: true, wishlist: serializeWishlist(row) });
    } catch (err) {
      console.error("[WORKFLOWS] wishlist update failed:", err);
      res.status(500).json({ ok: false, error: "wishlist_update_failed" });
    }
  });

  app.delete("/api/wishlist/:id", requireAuth, (req, res) => {
    try {
      db.prepare(`UPDATE wishlist_requests SET status='cancelled', updated_at=datetime('now') WHERE id=?`).run(Number(req.params.id));
      res.json({ ok: true });
    } catch (err) {
      console.error("[WORKFLOWS] wishlist cancel failed:", err);
      res.status(500).json({ ok: false, error: "wishlist_cancel_failed" });
    }
  });

  app.get("/api/wishlist/matches", requireAuth, (_req, res) => {
    try {
      res.json({ ok: true, rows: allWishlistMatches() });
    } catch (err) {
      console.error("[WORKFLOWS] wishlist matches failed:", err);
      res.status(500).json({ ok: false, error: "wishlist_matches_failed" });
    }
  });

  app.get("/api/wishlist/matches/:itemId", requireAuth, (req, res) => {
    try {
      const item = itemSummary(req.params.itemId);
      if (!item) return res.status(404).json({ ok: false, error: "item_not_found" });
      res.json({ ok: true, item, matches: wishlistMatchesForItem(item) });
    } catch (err) {
      console.error("[WORKFLOWS] wishlist item matches failed:", err);
      res.status(500).json({ ok: false, error: "wishlist_item_matches_failed" });
    }
  });

  // Layaway
  app.get("/api/layaways", requireAuth, (req, res) => {
    try {
      const status = clean(req.query.status || "active", 40);
      const where = status === "all" ? "" : "WHERE status=@status";
      const rows = db.prepare(`
        SELECT *
        FROM layaways
        ${where}
        ORDER BY
          CASE status WHEN 'active' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END,
          datetime(COALESCE(due_at, updated_at)) ASC,
          id DESC
        LIMIT 300
      `).all(status === "all" ? {} : { status });
      res.json({ ok: true, rows: rows.map(serializeLayaway) });
    } catch (err) {
      console.error("[WORKFLOWS] layaway list failed:", err);
      res.status(500).json({ ok: false, error: "layaway_list_failed" });
    }
  });

  app.post("/api/layaways", requireAuth, requirePerm("checkout"), (req, res) => {
    try {
      const body = req.body || {};
      const lines = Array.isArray(body.items) ? body.items : [];
      if (!lines.length) return res.status(400).json({ ok: false, error: "missing_items" });
      const customer = customerSnapshot(body);
      const now = new Date().toISOString();
      const normalized = lines.map((line) => {
        const item = itemSummary(line.item_id || line.itemId || line.sku);
        if (!item) throw new Error("item_not_found");
        const qty = Math.max(1, intVal(line.qty, 1));
        const bundleId = bundleIdFromSource(item.source);
        if (bundleId) {
          assertBundleAvailableItem(item, qty);
        } else if (Number(item.qty || 0) < qty) {
          throw new Error(`insufficient_qty:${item.sku || item.id}`);
        }
        return { item, qty, bundleId, unit_price_cents: centsFrom(line, "unit_price_cents", "unit_price") || toCents(item.price || 0) };
      });
      const totalCents = normalized.reduce((sum, line) => sum + line.unit_price_cents * line.qty, 0);
      const depositCents = centsFrom(body, "deposit_cents", "deposit");
      const info = db.transaction(() => {
        const layawayInfo = db.prepare(`
          INSERT INTO layaways
            (customer_id, customer_name, customer_phone, label, status, total_cents, deposit_cents, paid_cents,
             due_at, notes, created_at, updated_at, user_id)
          VALUES
            (@customer_id, @customer_name, @customer_phone, @label, 'active', @total_cents, @deposit_cents, @paid_cents,
             @due_at, @notes, @created_at, @updated_at, @user_id)
        `).run({
          customer_id: customer.customer_id,
          customer_name: customer.customer_name,
          customer_phone: customer.customer_phone,
          label: clean(body.label || customer.customer_name || "Layaway", 160),
          total_cents: totalCents,
          deposit_cents: depositCents,
          paid_cents: depositCents,
          due_at: clean(body.due_at || body.dueAt, 40) || null,
          notes: clean(body.notes, 1000),
          created_at: now,
          updated_at: now,
          user_id: req.user.id
        });
        const layawayId = layawayInfo.lastInsertRowid;
        const ins = db.prepare(`
          INSERT INTO layaway_items (layaway_id, item_id, sku, title, qty, unit_price_cents)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const line of normalized) {
          ins.run(layawayId, line.item.id, line.item.sku, line.item.title, line.qty, line.unit_price_cents);
          if (line.bundleId) {
            reserveBundleLayawayLine({ source: line.item.source, qty: line.qty }, {
              layawayId,
              userId: req.user.id,
              username: req.user.username || ""
            });
          } else {
            consumeInventoryFromBuckets(line.item.id, line.qty, ["sellable"]);
            logInventoryMovement({
              item_id: line.item.id,
              sku: line.item.sku,
              qty_delta: -line.qty,
              reason: "layaway_reserve",
              user_id: req.user.id,
              note: `Layaway #${layawayId}`
            });
          }
        }
        if (depositCents > 0) {
          db.prepare(`
            INSERT INTO layaway_payments (layaway_id, amount_cents, method, notes, user_id)
            VALUES (?, ?, ?, ?, ?)
          `).run(layawayId, depositCents, clean(body.payment_method || body.paymentMethod || "deposit", 60), "Initial deposit", req.user.id);
        }
        return layawayId;
      })();
      refreshAllBundleAvailability();
      res.json({ ok: true, layaway: serializeLayaway(db.prepare(`SELECT * FROM layaways WHERE id=?`).get(info)) });
    } catch (err) {
      const msg = String(err.message || err);
      if (msg.startsWith("insufficient_qty:")) return res.status(409).json({ ok: false, error: "insufficient_qty", sku: msg.split(":")[1] });
      if (msg.startsWith("bundle_unavailable:")) return res.status(409).json({ ok: false, error: "bundle_unavailable", bundle_id: msg.split(":")[1] });
      if (msg.startsWith("bundle_qty_limit:")) return res.status(409).json({ ok: false, error: "bundle_qty_limit", bundle_id: msg.split(":")[1] });
      if (msg === "item_not_found") return res.status(404).json({ ok: false, error: "item_not_found" });
      console.error("[WORKFLOWS] layaway create failed:", err);
      res.status(500).json({ ok: false, error: "layaway_create_failed" });
    }
  });

  app.post("/api/layaways/:id/payment", requireAuth, requirePerm("checkout"), (req, res) => {
    try {
      const id = Number(req.params.id);
      const layaway = db.prepare(`SELECT * FROM layaways WHERE id=?`).get(id);
      if (!layaway) return res.status(404).json({ ok: false, error: "layaway_not_found" });
      if (layaway.status !== "active") return res.status(409).json({ ok: false, error: "layaway_not_active" });
      const amount = centsFrom(req.body || {}, "amount_cents", "amount");
      if (amount <= 0) return res.status(400).json({ ok: false, error: "missing_amount" });
      db.prepare(`INSERT INTO layaway_payments (layaway_id, amount_cents, method, notes, user_id) VALUES (?, ?, ?, ?, ?)`)
        .run(id, amount, clean(req.body?.method || "payment", 60), clean(req.body?.notes, 500), req.user.id);
      db.prepare(`UPDATE layaways SET paid_cents=paid_cents+?, updated_at=datetime('now') WHERE id=?`).run(amount, id);
      res.json({ ok: true, layaway: serializeLayaway(db.prepare(`SELECT * FROM layaways WHERE id=?`).get(id)) });
    } catch (err) {
      console.error("[WORKFLOWS] layaway payment failed:", err);
      res.status(500).json({ ok: false, error: "layaway_payment_failed" });
    }
  });

  app.post("/api/layaways/:id/complete", requireAuth, requirePerm("checkout"), (req, res) => {
    try {
      const id = Number(req.params.id);
      const layaway = db.prepare(`SELECT * FROM layaways WHERE id=?`).get(id);
      if (!layaway) return res.status(404).json({ ok: false, error: "layaway_not_found" });
      db.transaction(() => {
        const rows = db.prepare(`SELECT * FROM layaway_items WHERE layaway_id=?`).all(id);
        for (const row of rows) {
          const item = db.prepare(`SELECT * FROM items WHERE id=?`).get(row.item_id);
          if (item && bundleIdFromSource(item.source)) {
            completeBundleLayawayLine({ source: item.source, qty: row.qty }, {
              layawayId: id,
              userId: req.user.id,
              username: req.user.username || ""
            });
          }
        }
        db.prepare(`UPDATE layaways SET status='completed', completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).run(id);
      })();
      res.json({ ok: true, layaway: serializeLayaway(db.prepare(`SELECT * FROM layaways WHERE id=?`).get(id)) });
    } catch (err) {
      console.error("[WORKFLOWS] layaway complete failed:", err);
      res.status(500).json({ ok: false, error: "layaway_complete_failed" });
    }
  });

  app.post("/api/layaways/:id/cancel", requireAuth, requirePerm("checkout"), (req, res) => {
    try {
      const id = Number(req.params.id);
      const layaway = db.prepare(`SELECT * FROM layaways WHERE id=?`).get(id);
      if (!layaway) return res.status(404).json({ ok: false, error: "layaway_not_found" });
      if (layaway.status !== "active") return res.status(409).json({ ok: false, error: "layaway_not_active" });
      db.transaction(() => {
        const rows = db.prepare(`SELECT * FROM layaway_items WHERE layaway_id=?`).all(id);
        for (const row of rows) {
          const item = db.prepare(`SELECT * FROM items WHERE id=?`).get(row.item_id);
          if (!item) continue;
          if (bundleIdFromSource(item.source)) {
            releaseBundleLayawayLine({ source: item.source, qty: row.qty }, {
              layawayId: id,
              userId: req.user.id,
              username: req.user.username || ""
            });
          } else {
            db.prepare(`UPDATE items SET deleted_at=NULL, deleted_reason=NULL WHERE id=?`).run(row.item_id);
            changeInventoryBucketQty(item, "sellable", "store", Number(row.qty || 0));
            logInventoryMovement({
              item_id: row.item_id,
              sku: row.sku,
              qty_delta: Number(row.qty || 0),
              reason: "layaway_cancel",
              user_id: req.user.id,
              note: `Layaway #${id} cancelled`
            });
          }
        }
        db.prepare(`UPDATE layaways SET status='cancelled', cancelled_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).run(id);
      })();
      refreshAllBundleAvailability();
      res.json({ ok: true, layaway: serializeLayaway(db.prepare(`SELECT * FROM layaways WHERE id=?`).get(id)) });
    } catch (err) {
      console.error("[WORKFLOWS] layaway cancel failed:", err);
      res.status(500).json({ ok: false, error: "layaway_cancel_failed" });
    }
  });

  // Preorders
  app.get("/api/preorders", requireAuth, (req, res) => {
    try {
      const status = clean(req.query.status || "open", 40);
      const where = status === "all" ? "" : "WHERE status=@status";
      const rows = db.prepare(`SELECT * FROM preorders ${where} ORDER BY datetime(COALESCE(release_at, updated_at)) ASC, id DESC LIMIT 500`)
        .all(status === "all" ? {} : { status });
      res.json({ ok: true, rows: rows.map(serializePreorder) });
    } catch (err) {
      console.error("[WORKFLOWS] preorder list failed:", err);
      res.status(500).json({ ok: false, error: "preorder_list_failed" });
    }
  });

  app.post("/api/preorders", requireAuth, requirePerm("checkout"), (req, res) => {
    try {
      const body = req.body || {};
      const title = clean(body.title, 200);
      if (!title) return res.status(400).json({ ok: false, error: "missing_title" });
      const customer = customerSnapshot(body);
      const now = new Date().toISOString();
      const info = db.prepare(`
        INSERT INTO preorders
          (customer_id, customer_name, customer_phone, title, platform, qty, expected_price_cents, deposit_cents,
           release_at, status, notes, created_at, updated_at, user_id)
        VALUES
          (@customer_id, @customer_name, @customer_phone, @title, @platform, @qty, @expected_price_cents, @deposit_cents,
           @release_at, 'open', @notes, @created_at, @updated_at, @user_id)
      `).run({
        customer_id: customer.customer_id,
        customer_name: customer.customer_name,
        customer_phone: customer.customer_phone,
        title,
        platform: clean(body.platform, 120),
        qty: Math.max(1, intVal(body.qty, 1)),
        expected_price_cents: centsFrom(body, "expected_price_cents", "expected_price"),
        deposit_cents: centsFrom(body, "deposit_cents", "deposit"),
        release_at: clean(body.release_at || body.releaseAt, 40) || null,
        notes: clean(body.notes, 1000),
        created_at: now,
        updated_at: now,
        user_id: req.user.id
      });
      res.json({ ok: true, preorder: serializePreorder(db.prepare(`SELECT * FROM preorders WHERE id=?`).get(info.lastInsertRowid)) });
    } catch (err) {
      console.error("[WORKFLOWS] preorder create failed:", err);
      res.status(500).json({ ok: false, error: "preorder_create_failed" });
    }
  });

  app.put("/api/preorders/:id", requireAuth, requirePerm("checkout"), (req, res) => {
    try {
      const id = Number(req.params.id);
      const existing = db.prepare(`SELECT * FROM preorders WHERE id=?`).get(id);
      if (!existing) return res.status(404).json({ ok: false, error: "preorder_not_found" });
      const body = req.body || {};
      const customer = customerSnapshot({ ...existing, ...body });
      const status = normalizeWorkflowStatus(body.status || existing.status, new Set(["open", "notified", "fulfilled", "cancelled"]), existing.status);
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE preorders
        SET customer_id=@customer_id,
            customer_name=@customer_name,
            customer_phone=@customer_phone,
            title=@title,
            platform=@platform,
            qty=@qty,
            expected_price_cents=@expected_price_cents,
            deposit_cents=@deposit_cents,
            release_at=@release_at,
            status=@status,
            notes=@notes,
            matched_item_id=@matched_item_id,
            updated_at=@updated_at,
            fulfilled_at=@fulfilled_at
        WHERE id=@id
      `).run({
        id,
        customer_id: customer.customer_id,
        customer_name: customer.customer_name,
        customer_phone: customer.customer_phone,
        title: clean(body.title ?? existing.title, 200),
        platform: clean(body.platform ?? existing.platform, 120),
        qty: Math.max(1, intVal(body.qty ?? existing.qty, 1)),
        expected_price_cents: body.expected_price_cents !== undefined || body.expected_price !== undefined ? centsFrom(body, "expected_price_cents", "expected_price") : existing.expected_price_cents,
        deposit_cents: body.deposit_cents !== undefined || body.deposit !== undefined ? centsFrom(body, "deposit_cents", "deposit") : existing.deposit_cents,
        release_at: clean(body.release_at ?? body.releaseAt ?? existing.release_at, 40) || null,
        status,
        notes: clean(body.notes ?? existing.notes, 1000),
        matched_item_id: Number(body.matched_item_id || existing.matched_item_id || 0) || null,
        updated_at: now,
        fulfilled_at: status === "fulfilled" ? (existing.fulfilled_at || now) : existing.fulfilled_at
      });
      res.json({ ok: true, preorder: serializePreorder(db.prepare(`SELECT * FROM preorders WHERE id=?`).get(id)) });
    } catch (err) {
      console.error("[WORKFLOWS] preorder update failed:", err);
      res.status(500).json({ ok: false, error: "preorder_update_failed" });
    }
  });

  // Repairs
  app.get("/api/repairs", requireAuth, (req, res) => {
    try {
      const status = clean(req.query.status || "open", 40);
      const openStatuses = new Set(["intake", "diagnosing", "waiting_parts", "ready", "approved"]);
      const where = status === "all" ? "" : (status === "open" ? `WHERE status IN ('intake','diagnosing','waiting_parts','ready','approved')` : "WHERE status=@status");
      const rows = db.prepare(`SELECT * FROM repair_tickets ${where} ORDER BY datetime(updated_at) DESC, id DESC LIMIT 500`)
        .all(status === "all" || status === "open" ? {} : { status: openStatuses.has(status) ? status : "intake" });
      res.json({ ok: true, rows: rows.map(serializeRepair) });
    } catch (err) {
      console.error("[WORKFLOWS] repair list failed:", err);
      res.status(500).json({ ok: false, error: "repair_list_failed" });
    }
  });

  app.post("/api/repairs", requireAuth, requirePerm("checkout"), (req, res) => {
    try {
      const body = req.body || {};
      const device = clean(body.device, 200);
      const issue = clean(body.issue, 1000);
      if (!device || !issue) return res.status(400).json({ ok: false, error: "missing_repair_info" });
      const customer = customerSnapshot(body);
      const now = new Date().toISOString();
      const info = db.prepare(`
        INSERT INTO repair_tickets
          (customer_id, customer_name, customer_phone, device, issue, status, estimate_cents, deposit_cents,
           parts_cents, labor_cents, due_at, notes, created_at, updated_at, user_id)
        VALUES
          (@customer_id, @customer_name, @customer_phone, @device, @issue, @status, @estimate_cents, @deposit_cents,
           @parts_cents, @labor_cents, @due_at, @notes, @created_at, @updated_at, @user_id)
      `).run({
        customer_id: customer.customer_id,
        customer_name: customer.customer_name,
        customer_phone: customer.customer_phone,
        device,
        issue,
        status: normalizeWorkflowStatus(body.status || "intake", new Set(["intake", "diagnosing", "approved", "waiting_parts", "ready", "picked_up", "cancelled"]), "intake"),
        estimate_cents: centsFrom(body, "estimate_cents", "estimate"),
        deposit_cents: centsFrom(body, "deposit_cents", "deposit"),
        parts_cents: centsFrom(body, "parts_cents", "parts"),
        labor_cents: centsFrom(body, "labor_cents", "labor"),
        due_at: clean(body.due_at || body.dueAt, 40) || null,
        notes: clean(body.notes, 1000),
        created_at: now,
        updated_at: now,
        user_id: req.user.id
      });
      const id = info.lastInsertRowid;
      db.prepare(`UPDATE repair_tickets SET ticket_no=? WHERE id=?`).run(repairTicketNo(id), id);
      res.json({ ok: true, repair: serializeRepair(db.prepare(`SELECT * FROM repair_tickets WHERE id=?`).get(id)) });
    } catch (err) {
      console.error("[WORKFLOWS] repair create failed:", err);
      res.status(500).json({ ok: false, error: "repair_create_failed" });
    }
  });

  app.put("/api/repairs/:id", requireAuth, requirePerm("checkout"), (req, res) => {
    try {
      const id = Number(req.params.id);
      const existing = db.prepare(`SELECT * FROM repair_tickets WHERE id=?`).get(id);
      if (!existing) return res.status(404).json({ ok: false, error: "repair_not_found" });
      const body = req.body || {};
      const customer = customerSnapshot({ ...existing, ...body });
      const status = normalizeWorkflowStatus(body.status || existing.status, new Set(["intake", "diagnosing", "approved", "waiting_parts", "ready", "picked_up", "cancelled"]), existing.status);
      const closedAt = ["picked_up", "cancelled"].includes(status) ? (existing.closed_at || new Date().toISOString()) : existing.closed_at;
      db.prepare(`
        UPDATE repair_tickets
        SET customer_id=@customer_id,
            customer_name=@customer_name,
            customer_phone=@customer_phone,
            device=@device,
            issue=@issue,
            status=@status,
            estimate_cents=@estimate_cents,
            deposit_cents=@deposit_cents,
            parts_cents=@parts_cents,
            labor_cents=@labor_cents,
            due_at=@due_at,
            notes=@notes,
            updated_at=datetime('now'),
            closed_at=@closed_at
        WHERE id=@id
      `).run({
        id,
        customer_id: customer.customer_id,
        customer_name: customer.customer_name,
        customer_phone: customer.customer_phone,
        device: clean(body.device ?? existing.device, 200),
        issue: clean(body.issue ?? existing.issue, 1000),
        status,
        estimate_cents: body.estimate_cents !== undefined || body.estimate !== undefined ? centsFrom(body, "estimate_cents", "estimate") : existing.estimate_cents,
        deposit_cents: body.deposit_cents !== undefined || body.deposit !== undefined ? centsFrom(body, "deposit_cents", "deposit") : existing.deposit_cents,
        parts_cents: body.parts_cents !== undefined || body.parts !== undefined ? centsFrom(body, "parts_cents", "parts") : existing.parts_cents,
        labor_cents: body.labor_cents !== undefined || body.labor !== undefined ? centsFrom(body, "labor_cents", "labor") : existing.labor_cents,
        due_at: clean(body.due_at ?? body.dueAt ?? existing.due_at, 40) || null,
        notes: clean(body.notes ?? existing.notes, 1000),
        closed_at: closedAt || null
      });
      res.json({ ok: true, repair: serializeRepair(db.prepare(`SELECT * FROM repair_tickets WHERE id=?`).get(id)) });
    } catch (err) {
      console.error("[WORKFLOWS] repair update failed:", err);
      res.status(500).json({ ok: false, error: "repair_update_failed" });
    }
  });

  // Customer workflow snapshot
  app.get("/api/customers/:id/workflows", requireAuth, (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "invalid_customer_id" });
      const customer = db.prepare(`SELECT * FROM customers WHERE id=?`).get(id);
      if (!customer) return res.status(404).json({ ok: false, error: "customer_not_found" });

      const wishFilter = customerWorkflowFilter(customer, { email: true });
      const workFilter = customerWorkflowFilter(customer);
      const wishlist = db.prepare(`
        SELECT *
        FROM wishlist_requests
        WHERE ${wishFilter.where}
        ORDER BY
          CASE status WHEN 'active' THEN 0 WHEN 'fulfilled' THEN 1 ELSE 2 END,
          datetime(updated_at) DESC,
          id DESC
        LIMIT 200
      `).all(wishFilter.params).map((row) => serializeWishlist(row, requestInventoryMatches(row)));
      const layaways = db.prepare(`
        SELECT *
        FROM layaways
        WHERE ${workFilter.where}
        ORDER BY
          CASE status WHEN 'active' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END,
          datetime(COALESCE(due_at, updated_at)) ASC,
          id DESC
        LIMIT 100
      `).all(workFilter.params).map(serializeLayaway);
      const preorders = db.prepare(`
        SELECT *
        FROM preorders
        WHERE ${workFilter.where}
        ORDER BY
          CASE status WHEN 'open' THEN 0 WHEN 'notified' THEN 1 WHEN 'fulfilled' THEN 2 ELSE 3 END,
          datetime(COALESCE(release_at, updated_at)) ASC,
          id DESC
        LIMIT 100
      `).all(workFilter.params).map(serializePreorder);
      const repairs = db.prepare(`
        SELECT *
        FROM repair_tickets
        WHERE ${workFilter.where}
        ORDER BY
          CASE status WHEN 'ready' THEN 0 WHEN 'waiting_parts' THEN 1 WHEN 'diagnosing' THEN 2 ELSE 3 END,
          datetime(updated_at) DESC,
          id DESC
        LIMIT 100
      `).all(workFilter.params).map(serializeRepair);
      const loyalty = db.prepare(`
        SELECT *
        FROM loyalty_transactions
        WHERE customer_id=?
        ORDER BY datetime(created_at) DESC, id DESC
        LIMIT 100
      `).all(id).map((row) => ({ ...row, amount: dollars(row.amount_cents) }));

      res.json({ ok: true, wishlist, layaways, preorders, repairs, loyalty });
    } catch (err) {
      console.error("[WORKFLOWS] customer workflow snapshot failed:", err);
      res.status(500).json({ ok: false, error: "customer_workflows_failed" });
    }
  });

  // Loyalty
  app.get("/api/loyalty/summary", requireAuth, (_req, res) => {
    try {
      const rows = db.prepare(`
        SELECT id, name, phone, email, loyalty_points, store_credit_cents
        FROM customers
        WHERE active=1 AND COALESCE(loyalty_points,0) > 0
        ORDER BY loyalty_points DESC, name ASC
        LIMIT 300
      `).all();
      res.json({ ok: true, rows: rows.map((row) => ({ ...row, store_credit: dollars(row.store_credit_cents) })) });
    } catch (err) {
      console.error("[WORKFLOWS] loyalty summary failed:", err);
      res.status(500).json({ ok: false, error: "loyalty_summary_failed" });
    }
  });

  app.post("/api/customers/:id/loyalty/adjust", requireAuth, requirePerm("store_credit"), (req, res) => {
    try {
      const customer = adjustLoyalty(Number(req.params.id), intVal(req.body?.points, 0), req.body?.reason || "Manual loyalty adjustment", { userId: req.user.id });
      if (!customer) return res.status(404).json({ ok: false, error: "customer_not_found_or_no_points" });
      res.json({ ok: true, customer });
    } catch (err) {
      console.error("[WORKFLOWS] loyalty adjust failed:", err);
      res.status(500).json({ ok: false, error: "loyalty_adjust_failed" });
    }
  });

  app.post("/api/customers/:id/loyalty/redeem", requireAuth, requirePerm("store_credit"), (req, res) => {
    try {
      const customerId = Number(req.params.id);
      const customer = db.prepare(`SELECT * FROM customers WHERE id=?`).get(customerId);
      if (!customer) return res.status(404).json({ ok: false, error: "customer_not_found" });
      const requested = Math.max(100, intVal(req.body?.points, 100));
      const points = Math.min(Number(customer.loyalty_points || 0), requested);
      if (points < 100) return res.status(409).json({ ok: false, error: "not_enough_points" });
      const creditCents = Math.floor(points / 100) * 500;
      const pointsToSpend = Math.floor(points / 100) * 100;
      db.transaction(() => {
        adjustLoyalty(customerId, -pointsToSpend, "Redeemed to store credit", { amountCents: creditCents, userId: req.user.id });
        db.prepare(`UPDATE customers SET store_credit_cents=COALESCE(store_credit_cents,0)+?, updated_at=datetime('now') WHERE id=?`).run(creditCents, customerId);
        db.prepare(`
          INSERT INTO customer_adjustments (customer_id, amount_cents, reason, user_id)
          VALUES (?, ?, ?, ?)
        `).run(customerId, creditCents, `Loyalty redemption (${pointsToSpend} points)`, req.user.id);
      })();
      res.json({ ok: true, customer: db.prepare(`SELECT * FROM customers WHERE id=?`).get(customerId), credit_cents: creditCents, points_spent: pointsToSpend });
    } catch (err) {
      console.error("[WORKFLOWS] loyalty redeem failed:", err);
      res.status(500).json({ ok: false, error: "loyalty_redeem_failed" });
    }
  });

  // Bundles
  app.get("/api/bundles", requireAuth, (_req, res) => {
    try {
      refreshAllBundleAvailability();
      const rows = db.prepare(`SELECT * FROM bundles ORDER BY status ASC, available DESC, datetime(updated_at) DESC, id DESC LIMIT 300`).all();
      res.json({ ok: true, rows: rows.map(serializeBundle) });
    } catch (err) {
      console.error("[WORKFLOWS] bundle list failed:", err);
      res.status(500).json({ ok: false, error: "bundle_list_failed" });
    }
  });

  app.post("/api/bundles", requireAuth, requirePerm("inv_add"), (req, res) => {
    try {
      const body = req.body || {};
      const title = clean(body.title, 200);
      const components = Array.isArray(body.components) ? body.components : [];
      if (!title) return res.status(400).json({ ok: false, error: "missing_title" });
      if (!components.length) return res.status(400).json({ ok: false, error: "missing_components" });
      const priceCents = centsFrom(body, "price_cents", "price");
      const now = new Date().toISOString();
      const bundleId = db.transaction(() => {
        const info = db.prepare(`
          INSERT INTO bundles (title, price_cents, status, available, notes, created_at, updated_at, user_id)
          VALUES (?, ?, 'active', 0, ?, ?, ?, ?)
        `).run(title, priceCents, clean(body.notes, 1000), now, now, req.user.id);
        const id = info.lastInsertRowid;
        const sku = clean(body.sku, 80) || `BND-${String(id).padStart(5, "0")}`;
        db.prepare(`UPDATE bundles SET sku=? WHERE id=?`).run(sku, id);
        const insertComponent = db.prepare(`
          INSERT INTO bundle_items (bundle_id, item_id, sku, title, qty)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const raw of components) {
          const item = itemSummary(raw.item_id || raw.itemId || raw.sku);
          if (!item) throw new Error("component_not_found");
          if (bundleIdFromSource(item.source)) throw new Error("bundle_component_nested");
          const qty = Math.max(1, intVal(raw.qty, 1));
          insertComponent.run(id, item.id, item.sku, item.title, qty);
        }
        const bundleCost = db.prepare(`
          SELECT COALESCE(SUM(COALESCE(i.cost,0) * bi.qty),0) AS cost
          FROM bundle_items bi
          JOIN items i ON i.id=bi.item_id
          WHERE bi.bundle_id=?
        `).get(id)?.cost || 0;
        db.prepare(`
          INSERT INTO items (sku,title,platform,category,condition,variant,qty,cost,price,createdAt,barcode,source)
          VALUES (?, ?, 'Bundle', 'Bundles', 'Bundle', 'BUNDLE', 0, ?, ?, ?, ?, ?)
        `).run(sku, title, Number(bundleCost || 0), dollars(priceCents), now, sku, bundleItemSource(id));
        const bundleItem = db.prepare(`SELECT id FROM items WHERE sku=?`).get(sku);
        db.prepare(`UPDATE bundles SET bundle_item_id=? WHERE id=?`).run(bundleItem?.id || null, id);
        return id;
      })();
      const bundle = refreshBundleAvailability(bundleId);
      res.json({ ok: true, bundle });
    } catch (err) {
      const msg = String(err.message || err);
      if (msg === "component_not_found") return res.status(404).json({ ok: false, error: "component_not_found" });
      if (msg === "bundle_component_nested") return res.status(409).json({ ok: false, error: "bundle_component_nested" });
      if (msg.toLowerCase().includes("unique")) return res.status(409).json({ ok: false, error: "bundle_sku_exists" });
      console.error("[WORKFLOWS] bundle create failed:", err);
      res.status(500).json({ ok: false, error: "bundle_create_failed" });
    }
  });

  app.put("/api/bundles/:id", requireAuth, requirePerm("inv_edit"), (req, res) => {
    try {
      const id = Number(req.params.id);
      const existing = db.prepare(`SELECT * FROM bundles WHERE id=?`).get(id);
      if (!existing) return res.status(404).json({ ok: false, error: "bundle_not_found" });
      const body = req.body || {};
      const status = normalizeWorkflowStatus(body.status || existing.status, new Set(["active", "inactive", "sold", "archived"]), existing.status);
      db.transaction(() => {
        db.prepare(`
          UPDATE bundles
          SET title=@title,
              price_cents=@price_cents,
              status=@status,
              notes=@notes,
              updated_at=datetime('now')
          WHERE id=@id
        `).run({
          id,
          title: clean(body.title ?? existing.title, 200),
          price_cents: body.price_cents !== undefined || body.price !== undefined ? centsFrom(body, "price_cents", "price") : existing.price_cents,
          status,
          notes: clean(body.notes ?? existing.notes, 1000)
        });
        if (Array.isArray(body.components)) {
          db.prepare(`DELETE FROM bundle_items WHERE bundle_id=?`).run(id);
          const insertComponent = db.prepare(`INSERT INTO bundle_items (bundle_id, item_id, sku, title, qty) VALUES (?, ?, ?, ?, ?)`);
          for (const raw of body.components) {
            const item = itemSummary(raw.item_id || raw.itemId || raw.sku);
            if (!item) throw new Error("component_not_found");
            if (bundleIdFromSource(item.source)) throw new Error("bundle_component_nested");
            insertComponent.run(id, item.id, item.sku, item.title, Math.max(1, intVal(raw.qty, 1)));
          }
        }
      })();
      const bundle = refreshBundleAvailability(id);
      res.json({ ok: true, bundle });
    } catch (err) {
      const msg = String(err.message || err);
      if (msg === "component_not_found") return res.status(404).json({ ok: false, error: "component_not_found" });
      if (msg === "bundle_component_nested") return res.status(409).json({ ok: false, error: "bundle_component_nested" });
      console.error("[WORKFLOWS] bundle update failed:", err);
      res.status(500).json({ ok: false, error: "bundle_update_failed" });
    }
  });

  app.delete("/api/bundles/:id", requireAuth, requirePerm("inv_delete"), (req, res) => {
    try {
      const id = Number(req.params.id);
      const bundle = db.prepare(`SELECT * FROM bundles WHERE id=?`).get(id);
      if (!bundle) return res.status(404).json({ ok: false, error: "bundle_not_found" });
      db.prepare(`UPDATE bundles SET status='archived', available=0, updated_at=datetime('now') WHERE id=?`).run(id);
      if (bundle.bundle_item_id) {
        db.prepare(`UPDATE inventory_quantities SET qty=0, updated_at=datetime('now') WHERE item_id=?`).run(bundle.bundle_item_id);
        syncItemQtyFromBuckets(bundle.bundle_item_id);
        db.prepare(`UPDATE items SET qty=0, deleted_at=datetime('now'), deleted_reason='Bundle archived' WHERE id=?`).run(bundle.bundle_item_id);
      }
      res.json({ ok: true });
    } catch (err) {
      console.error("[WORKFLOWS] bundle archive failed:", err);
      res.status(500).json({ ok: false, error: "bundle_archive_failed" });
    }
  });

  app.post("/api/bundles/refresh", requireAuth, (_req, res) => {
    try {
      res.json({ ok: true, rows: refreshAllBundleAvailability() });
    } catch (err) {
      console.error("[WORKFLOWS] bundle refresh failed:", err);
      res.status(500).json({ ok: false, error: "bundle_refresh_failed" });
    }
  });

  // Trade-in completion
  app.post("/api/trade/quotes/:quoteId/complete", requireAuth, requirePerm("inv_add"), (req, res) => {
    try {
      const result = completeTradeQuote(req.params.quoteId, req.body || {}, req.user);
      logUserAction({
        userId: String(req.user.id || ""),
        username: req.user.username || "",
        action: "trade_quote_completed",
        screen: "trade-in",
        metadata: { quoteId: req.params.quoteId, payoutMethod: result.quote?.payout_method || "" }
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      const msg = String(err.message || err);
      if (msg === "quote_not_found") return res.status(404).json({ ok: false, error: "quote_not_found" });
      if (msg === "no_trade_items") return res.status(400).json({ ok: false, error: "no_trade_items" });
      if (msg === "customer_required" || msg === "customer_required_for_credit") return res.status(400).json({ ok: false, error: msg });
      if (msg === "seller_id_required" || msg === "agreement_required") return res.status(400).json({ ok: false, error: msg });
      if (msg === "approval_required") return res.status(403).json({ ok: false, error: "approval_required" });
      console.error("[WORKFLOWS] trade completion failed:", err);
      res.status(500).json({ ok: false, error: "trade_completion_failed" });
    }
  });

  return {
    refreshAllBundleAvailability,
    refreshBundleAvailability,
    assertBundleAvailableItem,
    applyBundleSaleLine,
    reverseBundleSaleLine,
    awardLoyaltyForSale,
    reverseLoyaltyForSale,
    completeTradeQuote
  };
}

module.exports = mountStoreWorkflowRoutes;
