const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function mountAdvancedWorkflowRoutes(app, db, deps) {
  const {
    dbPath,
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
  } = deps;

  const clean = (value, max = 500) => String(value ?? "").trim().slice(0, max);
  const lower = (value) => clean(value).toLowerCase().replace(/\s+/g, " ");
  const intVal = (value, fallback = 0) => {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) ? n : fallback;
  };
  const centsFrom = (body, centsKey, moneyKey) => {
    if (Number.isFinite(Number(body?.[centsKey]))) return Math.round(Number(body[centsKey]));
    return toCents(body?.[moneyKey]);
  };
  const dollars = (cents) => toDollars(Number(cents || 0));
  const nowIso = () => new Date().toISOString();
  const todayIso = () => new Date().toISOString().slice(0, 10);
  const shortCode = (prefix) => `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;

  function respondError(res, err, fallback = "request_failed") {
    const msg = String(err?.message || err || fallback);
    const known = {
      item_not_found: 404,
      customer_not_found: 404,
      purchase_order_not_found: 404,
      stock_count_not_found: 404,
      reservation_not_found: 404,
      gift_card_not_found: 404,
      house_account_not_found: 404,
      active_clock_entry_not_found: 404,
      rental_not_found: 404,
      backup_not_found: 404,
      insufficient_inventory: 409,
      bundle_reservation_use_layaway: 409,
      duplicate_serial: 409,
      house_account_limit_exceeded: 409,
      clock_already_open: 409,
      restore_requires_restart: 409
    };
    const status = known[msg] || 500;
    if (status >= 500) console.error("[ADV_WORKFLOWS]", err);
    res.status(status).json({ ok: false, error: status >= 500 ? fallback : msg });
  }

  function audit(req, action, screen, metadata = {}) {
    try {
      logUserAction({
        userId: String(req.user?.id || ""),
        username: req.user?.username || "",
        action,
        screen,
        metadata
      });
    } catch {}
  }

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

  function itemByRef(ref) {
    const itemId = Number(ref?.item_id || ref?.itemId || ref || 0);
    if (itemId) return db.prepare(`SELECT * FROM items WHERE id=? AND deleted_at IS NULL`).get(itemId);
    const sku = clean(ref?.sku || ref, 120);
    if (sku) return db.prepare(`SELECT * FROM items WHERE sku=? AND deleted_at IS NULL`).get(sku);
    return null;
  }

  function bundleIdFromSource(source) {
    const m = /^bundle:(\d+)$/i.exec(clean(source));
    return m ? Number(m[1]) : 0;
  }

  function createOrReceiveInventory(raw, qty, userId, note) {
    const count = Math.max(0, intVal(qty, 0));
    if (!count) return itemByRef(raw);

    const existing = itemByRef(raw);
    if (existing) {
      ensureItemBucketBaseline(existing);
      db.prepare(`UPDATE items SET qty=?, deleted_at=NULL, deleted_reason=NULL WHERE id=?`)
        .run(Number(existing.qty || 0) + count, existing.id);
      changeInventoryBucketQty(existing, "sellable", "store", count);
      logInventoryMovement({
        item_id: existing.id,
        sku: existing.sku,
        qty_delta: count,
        reason: "inventory_received",
        user_id: userId || null,
        note
      });
      return db.prepare(`SELECT * FROM items WHERE id=?`).get(existing.id);
    }

    const title = clean(raw.title, 240);
    if (!title) throw new Error("item_not_found");
    const platform = clean(raw.platform, 120);
    const category = normalizeCategory(clean(raw.category || "Games", 80)) || "Games";
    const condition = clean(raw.condition || "Good", 80) || "Good";
    const sku = clean(raw.sku, 120) || skuFromInputs({ title, platform, category, condition });
    const found = db.prepare(`SELECT * FROM items WHERE sku=?`).get(sku);
    if (found) {
      ensureItemBucketBaseline(found);
      db.prepare(`UPDATE items SET qty=?, deleted_at=NULL, deleted_reason=NULL WHERE id=?`)
        .run(Number(found.qty || 0) + count, found.id);
      changeInventoryBucketQty(found, "sellable", "store", count);
      logInventoryMovement({
        item_id: found.id,
        sku,
        qty_delta: count,
        reason: "inventory_received",
        user_id: userId || null,
        note
      });
      return db.prepare(`SELECT * FROM items WHERE id=?`).get(found.id);
    }

    const cost = dollars(centsFrom(raw, "unit_cost_cents", "unit_cost") || centsFrom(raw, "cost_cents", "cost"));
    const price = dollars(centsFrom(raw, "unit_price_cents", "unit_price") || centsFrom(raw, "price_cents", "price"));
    db.prepare(`
      INSERT INTO items (sku,title,platform,category,condition,variant,qty,cost,price,createdAt,barcode,source,deleted_at,deleted_reason)
      VALUES (@sku,@title,@platform,@category,@condition,'',@qty,@cost,@price,@createdAt,null,@source,null,null)
    `).run({
      sku,
      title,
      platform,
      category,
      condition,
      qty: count,
      cost,
      price,
      createdAt: nowIso(),
      source: clean(raw.source || "purchase_order", 120)
    });
    const row = db.prepare(`SELECT * FROM items WHERE sku=?`).get(sku);
    if (row?.id) {
      setInventoryBucketQty(row.id, "sellable", "store", count);
      syncItemQtyFromBuckets(row.id);
    }
    logInventoryMovement({
      item_id: row?.id || null,
      sku,
      qty_delta: count,
      reason: "inventory_received",
      user_id: userId || null,
      note
    });
    return row;
  }

  function serializeMoney(row, fields) {
    const out = { ...row };
    for (const [centsKey, moneyKey] of fields) out[moneyKey] = dollars(out[centsKey]);
    return out;
  }

  function listPoItems(poId) {
    return db.prepare(`
      SELECT *
      FROM purchase_order_items
      WHERE purchase_order_id=?
      ORDER BY id ASC
    `).all(poId).map((row) => serializeMoney(row, [["unit_cost_cents", "unit_cost"], ["unit_price_cents", "unit_price"]]));
  }

  function serializePurchaseOrder(row) {
    return {
      ...serializeMoney(row, [["subtotal_cents", "subtotal"]]),
      items: listPoItems(row.id)
    };
  }

  function updatePurchaseOrderStatus(poId) {
    const lines = db.prepare(`SELECT qty_ordered, qty_received FROM purchase_order_items WHERE purchase_order_id=?`).all(poId);
    const ordered = lines.reduce((sum, row) => sum + Number(row.qty_ordered || 0), 0);
    const received = lines.reduce((sum, row) => sum + Number(row.qty_received || 0), 0);
    const status = ordered > 0 && received >= ordered ? "received" : (received > 0 ? "partial" : "ordered");
    db.prepare(`UPDATE purchase_orders SET status=?, updated_at=datetime('now') WHERE id=?`).run(status, poId);
  }

  function reserveItem(item, qty, userId, note, reason = "reserved") {
    if (!item) throw new Error("item_not_found");
    if (bundleIdFromSource(item.source)) throw new Error("bundle_reservation_use_layaway");
    const count = Math.max(1, intVal(qty, 1));
    if (Number(item.qty || 0) < count) throw new Error("insufficient_inventory");
    consumeInventoryFromBuckets(item.id, count, ["sellable"]);
    logInventoryMovement({
      item_id: item.id,
      sku: item.sku,
      qty_delta: -count,
      reason,
      user_id: userId || null,
      note
    });
  }

  function restoreItem(itemId, qty, userId, note, reason = "reservation_released") {
    const item = db.prepare(`SELECT * FROM items WHERE id=?`).get(Number(itemId || 0));
    if (!item) return;
    const count = Math.max(1, intVal(qty, 1));
    db.prepare(`UPDATE items SET deleted_at=NULL, deleted_reason=NULL WHERE id=?`).run(item.id);
    changeInventoryBucketQty(item, "sellable", "store", count);
    logInventoryMovement({
      item_id: item.id,
      sku: item.sku,
      qty_delta: count,
      reason,
      user_id: userId || null,
      note
    });
  }

  function upsertFollowup(row, userId) {
    try {
      db.prepare(`
        INSERT OR IGNORE INTO followups
          (customer_id, customer_name, customer_phone, customer_email, type, status, subject, due_at, source_type, source_id, notes, user_id)
        VALUES
          (@customer_id, @customer_name, @customer_phone, @customer_email, @type, 'open', @subject, @due_at, @source_type, @source_id, @notes, @user_id)
      `).run({
        customer_id: row.customer_id || null,
        customer_name: clean(row.customer_name, 160),
        customer_phone: clean(row.customer_phone, 60),
        customer_email: clean(row.customer_email, 160),
        type: clean(row.type || "general", 80),
        subject: clean(row.subject, 240),
        due_at: row.due_at || todayIso(),
        source_type: clean(row.source_type, 80),
        source_id: clean(row.source_id, 80),
        notes: clean(row.notes, 1000),
        user_id: userId || null
      });
    } catch {}
  }

  // -------------------------------------------------------------------------
  // Dashboard summary
  // -------------------------------------------------------------------------
  app.get("/api/operations/summary", requireAuth, (_req, res) => {
    try {
      const one = (sql) => db.prepare(sql).get()?.c || 0;
      res.json({
        ok: true,
        counts: {
          purchase_orders: one(`SELECT COUNT(*) AS c FROM purchase_orders WHERE status IN ('draft','ordered','partial')`),
          reservations: one(`SELECT COUNT(*) AS c FROM reservations WHERE status='active'`),
          special_orders: one(`SELECT COUNT(*) AS c FROM special_orders WHERE status IN ('open','ordered','arrived')`),
          followups: one(`SELECT COUNT(*) AS c FROM followups WHERE status='open'`),
          online_orders: one(`SELECT COUNT(*) AS c FROM online_orders WHERE status IN ('pending','paid','packed')`),
          rentals: one(`SELECT COUNT(*) AS c FROM rentals WHERE status='out'`),
          warranties: one(`SELECT COUNT(*) AS c FROM warranties WHERE status='active'`),
          offline_queue: one(`SELECT COUNT(*) AS c FROM offline_queue WHERE status='queued'`)
        }
      });
    } catch (err) {
      respondError(res, err, "summary_failed");
    }
  });

  // -------------------------------------------------------------------------
  // Vendors + purchasing
  // -------------------------------------------------------------------------
  app.get("/api/vendors", requireAuth, (req, res) => {
    try {
      const search = `%${lower(req.query.search || "")}%`;
      const rows = db.prepare(`
        SELECT *
        FROM vendors
        WHERE (?='%%' OR lower(name || ' ' || COALESCE(contact_name,'') || ' ' || COALESCE(email,'')) LIKE ?)
        ORDER BY active DESC, lower(name) ASC
        LIMIT 250
      `).all(search, search);
      res.json({ ok: true, rows });
    } catch (err) {
      respondError(res, err, "vendors_failed");
    }
  });

  app.post("/api/vendors", requireAuth, requirePerm("settings_admin"), (req, res) => {
    try {
      const body = req.body || {};
      const name = clean(body.name, 160);
      if (!name) return res.status(400).json({ ok: false, error: "missing_name" });
      const info = db.prepare(`
        INSERT INTO vendors (name, contact_name, phone, email, website, notes, active)
        VALUES (@name, @contact_name, @phone, @email, @website, @notes, @active)
      `).run({
        name,
        contact_name: clean(body.contact_name || body.contactName, 160),
        phone: clean(body.phone, 60),
        email: clean(body.email, 160),
        website: clean(body.website, 240),
        notes: clean(body.notes, 1000),
        active: body.active === false || body.active === 0 ? 0 : 1
      });
      audit(req, "vendor_created", "operations", { vendorId: info.lastInsertRowid, name });
      res.json({ ok: true, vendor: db.prepare(`SELECT * FROM vendors WHERE id=?`).get(info.lastInsertRowid) });
    } catch (err) {
      respondError(res, err, "vendor_create_failed");
    }
  });

  app.get("/api/purchase-orders", requireAuth, (req, res) => {
    try {
      const status = clean(req.query.status || "open", 40);
      const rows = db.prepare(`
        SELECT *
        FROM purchase_orders
        WHERE @status='all'
           OR (@status='open' AND status IN ('draft','ordered','partial'))
           OR status=@status
        ORDER BY datetime(created_at) DESC, id DESC
        LIMIT 150
      `).all({ status }).map(serializePurchaseOrder);
      res.json({ ok: true, rows });
    } catch (err) {
      respondError(res, err, "purchase_orders_failed");
    }
  });

  app.get("/api/purchase-orders/:id", requireAuth, (req, res) => {
    try {
      const row = db.prepare(`SELECT * FROM purchase_orders WHERE id=?`).get(Number(req.params.id));
      if (!row) throw new Error("purchase_order_not_found");
      res.json({ ok: true, purchase_order: serializePurchaseOrder(row) });
    } catch (err) {
      respondError(res, err, "purchase_order_failed");
    }
  });

  app.post("/api/purchase-orders", requireAuth, requirePerm("inv_add"), (req, res) => {
    try {
      const body = req.body || {};
      const vendorId = Number(body.vendor_id || body.vendorId || 0) || null;
      const vendor = vendorId ? db.prepare(`SELECT * FROM vendors WHERE id=?`).get(vendorId) : null;
      const items = Array.isArray(body.items) ? body.items : [];
      const subtotalCents = items.reduce((sum, line) => {
        const qty = Math.max(1, intVal(line.qty_ordered || line.qty || 1, 1));
        return sum + (qty * Math.max(0, centsFrom(line, "unit_cost_cents", "unit_cost")));
      }, 0);
      const tx = db.transaction(() => {
        const info = db.prepare(`
          INSERT INTO purchase_orders (vendor_id, vendor_name, status, order_date, expected_at, subtotal_cents, notes, user_id)
          VALUES (@vendor_id, @vendor_name, @status, @order_date, @expected_at, @subtotal_cents, @notes, @user_id)
        `).run({
          vendor_id: vendor?.id || null,
          vendor_name: clean(body.vendor_name || body.vendorName || vendor?.name, 160),
          status: clean(body.status || "ordered", 40),
          order_date: clean(body.order_date || body.orderDate || todayIso(), 40),
          expected_at: clean(body.expected_at || body.expectedAt, 40),
          subtotal_cents: subtotalCents,
          notes: clean(body.notes, 1000),
          user_id: req.user.id
        });
        const poId = info.lastInsertRowid;
        const ins = db.prepare(`
          INSERT INTO purchase_order_items
            (purchase_order_id, item_id, sku, title, platform, category, condition, qty_ordered, qty_received, unit_cost_cents, unit_price_cents)
          VALUES
            (@purchase_order_id, @item_id, @sku, @title, @platform, @category, @condition, @qty_ordered, 0, @unit_cost_cents, @unit_price_cents)
        `);
        for (const line of items) {
          const item = itemByRef(line);
          ins.run({
            purchase_order_id: poId,
            item_id: item?.id || Number(line.item_id || line.itemId || 0) || null,
            sku: clean(line.sku || item?.sku, 120),
            title: clean(line.title || item?.title, 240),
            platform: clean(line.platform || item?.platform, 120),
            category: clean(line.category || item?.category, 80),
            condition: clean(line.condition || item?.condition || "Good", 80),
            qty_ordered: Math.max(1, intVal(line.qty_ordered || line.qty || 1, 1)),
            unit_cost_cents: Math.max(0, centsFrom(line, "unit_cost_cents", "unit_cost")),
            unit_price_cents: Math.max(0, centsFrom(line, "unit_price_cents", "unit_price"))
          });
        }
        return poId;
      });
      const poId = tx();
      audit(req, "purchase_order_created", "operations", { purchaseOrderId: poId });
      res.json({ ok: true, purchase_order: serializePurchaseOrder(db.prepare(`SELECT * FROM purchase_orders WHERE id=?`).get(poId)) });
    } catch (err) {
      respondError(res, err, "purchase_order_create_failed");
    }
  });

  app.post("/api/purchase-orders/:id/receive", requireAuth, requirePerm("inv_add"), (req, res) => {
    try {
      const poId = Number(req.params.id);
      const po = db.prepare(`SELECT * FROM purchase_orders WHERE id=?`).get(poId);
      if (!po) throw new Error("purchase_order_not_found");
      const requested = new Map((Array.isArray(req.body?.lines) ? req.body.lines : []).map((line) => [Number(line.id), Math.max(0, intVal(line.qty || line.qty_received || line.received, 0))]));
      const lines = db.prepare(`SELECT * FROM purchase_order_items WHERE purchase_order_id=?`).all(poId);
      const received = [];
      const tx = db.transaction(() => {
        for (const line of lines) {
          const remaining = Math.max(0, Number(line.qty_ordered || 0) - Number(line.qty_received || 0));
          const qty = requested.has(line.id) ? Math.min(remaining, requested.get(line.id)) : remaining;
          if (!qty) continue;
          const item = createOrReceiveInventory(line, qty, req.user.id, `Purchase order #${poId}`);
          db.prepare(`UPDATE purchase_order_items SET item_id=?, sku=?, qty_received=qty_received+? WHERE id=?`)
            .run(item?.id || line.item_id || null, item?.sku || line.sku || null, qty, line.id);
          if (line.unit_cost_cents > 0) {
            insertExpense({
              expense_date: todayIso(),
              type: "inventory",
              category: "Inventory",
              vendor: po.vendor_name || null,
              memo: `PO #${poId}: ${line.title || item?.title || line.sku || "Inventory"}`,
              amount: dollars(Number(line.unit_cost_cents || 0) * qty),
              tax_amount: 0,
              payment_method: null,
              source: `purchase_order:${poId}`,
              item_id: item?.id || null,
              sku: item?.sku || line.sku || null,
              title: item?.title || line.title || null,
              qty,
              unit_cost: dollars(line.unit_cost_cents),
              user_id: req.user.id
            });
          }
          received.push({ line_id: line.id, qty, item });
        }
        updatePurchaseOrderStatus(poId);
      });
      tx();
      storeWorkflows?.refreshAllBundleAvailability?.();
      audit(req, "purchase_order_received", "operations", { purchaseOrderId: poId, lines: received.length });
      res.json({ ok: true, received, purchase_order: serializePurchaseOrder(db.prepare(`SELECT * FROM purchase_orders WHERE id=?`).get(poId)) });
    } catch (err) {
      respondError(res, err, "purchase_order_receive_failed");
    }
  });

  // -------------------------------------------------------------------------
  // Stock counts
  // -------------------------------------------------------------------------
  app.get("/api/stock-counts", requireAuth, (_req, res) => {
    try {
      const rows = db.prepare(`
        SELECT sc.*,
               COUNT(sci.id) AS line_count,
               COALESCE(SUM(ABS(sci.variance)),0) AS total_variance
        FROM stock_counts sc
        LEFT JOIN stock_count_items sci ON sci.stock_count_id=sc.id
        GROUP BY sc.id
        ORDER BY datetime(sc.started_at) DESC, sc.id DESC
        LIMIT 100
      `).all();
      res.json({ ok: true, rows });
    } catch (err) {
      respondError(res, err, "stock_counts_failed");
    }
  });

  app.post("/api/stock-counts", requireAuth, requirePerm("inv_edit"), (req, res) => {
    try {
      const label = clean(req.body?.label || `Stock Count ${todayIso()}`, 160);
      const info = db.prepare(`INSERT INTO stock_counts (label, notes, user_id) VALUES (?, ?, ?)`)
        .run(label, clean(req.body?.notes, 1000), req.user.id);
      audit(req, "stock_count_created", "operations", { stockCountId: info.lastInsertRowid });
      res.json({ ok: true, stock_count: db.prepare(`SELECT * FROM stock_counts WHERE id=?`).get(info.lastInsertRowid) });
    } catch (err) {
      respondError(res, err, "stock_count_create_failed");
    }
  });

  app.post("/api/stock-counts/:id/lines", requireAuth, requirePerm("inv_edit"), (req, res) => {
    try {
      const count = db.prepare(`SELECT * FROM stock_counts WHERE id=?`).get(Number(req.params.id));
      if (!count) throw new Error("stock_count_not_found");
      if (count.status !== "open") return res.status(409).json({ ok: false, error: "stock_count_closed" });
      const item = itemByRef(req.body || {});
      if (!item) throw new Error("item_not_found");
      const counted = Math.max(0, intVal(req.body?.counted_qty ?? req.body?.qty, 0));
      const expected = Math.max(0, intVal(req.body?.expected_qty ?? item.qty, 0));
      const existing = db.prepare(`SELECT * FROM stock_count_items WHERE stock_count_id=? AND item_id=?`).get(count.id, item.id);
      if (existing) {
        db.prepare(`
          UPDATE stock_count_items
          SET expected_qty=?, counted_qty=?, variance=?, notes=?
          WHERE id=?
        `).run(expected, counted, counted - expected, clean(req.body?.notes, 500), existing.id);
      } else {
        db.prepare(`
          INSERT INTO stock_count_items (stock_count_id, item_id, sku, title, expected_qty, counted_qty, variance, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(count.id, item.id, item.sku, item.title, expected, counted, counted - expected, clean(req.body?.notes, 500));
      }
      res.json({ ok: true, rows: db.prepare(`SELECT * FROM stock_count_items WHERE stock_count_id=? ORDER BY id`).all(count.id) });
    } catch (err) {
      respondError(res, err, "stock_count_line_failed");
    }
  });

  app.post("/api/stock-counts/:id/complete", requireAuth, requirePerm("inv_edit"), (req, res) => {
    try {
      const count = db.prepare(`SELECT * FROM stock_counts WHERE id=?`).get(Number(req.params.id));
      if (!count) throw new Error("stock_count_not_found");
      const lines = db.prepare(`SELECT * FROM stock_count_items WHERE stock_count_id=?`).all(count.id);
      const tx = db.transaction(() => {
        for (const line of lines) {
          const item = db.prepare(`SELECT * FROM items WHERE id=?`).get(line.item_id);
          if (!item) continue;
          ensureItemBucketBaseline(item);
          const countedQty = Math.max(0, Number(line.counted_qty || 0));
          const variance = countedQty - Number(item.qty || 0);
          if (variance > 0) {
            changeInventoryBucketQty(item, "sellable", "store", variance);
          } else if (variance < 0) {
            consumeInventoryFromBuckets(item.id, Math.abs(variance), [
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
          }
          if (variance) {
            logInventoryMovement({
              item_id: item.id,
              sku: item.sku,
              qty_delta: variance,
              reason: "stock_count_adjustment",
              user_id: req.user.id,
              note: count.label
            });
          }
        }
        db.prepare(`UPDATE stock_counts SET status='completed', completed_at=datetime('now') WHERE id=?`).run(count.id);
      });
      tx();
      storeWorkflows?.refreshAllBundleAvailability?.();
      audit(req, "stock_count_completed", "operations", { stockCountId: count.id, lines: lines.length });
      res.json({ ok: true, stock_count: db.prepare(`SELECT * FROM stock_counts WHERE id=?`).get(count.id) });
    } catch (err) {
      respondError(res, err, "stock_count_complete_failed");
    }
  });

  // -------------------------------------------------------------------------
  // Customer promises: special orders, reservations, follow-ups
  // -------------------------------------------------------------------------
  app.get("/api/special-orders", requireAuth, (req, res) => {
    try {
      const status = clean(req.query.status || "open", 40);
      const rows = db.prepare(`
        SELECT *
        FROM special_orders
        WHERE @status='all'
           OR (@status='open' AND status IN ('open','ordered','arrived'))
           OR status=@status
        ORDER BY datetime(created_at) DESC, id DESC
        LIMIT 200
      `).all({ status }).map((row) => serializeMoney(row, [["deposit_cents", "deposit"]]));
      res.json({ ok: true, rows });
    } catch (err) {
      respondError(res, err, "special_orders_failed");
    }
  });

  app.post("/api/special-orders", requireAuth, requireRole("clerk", "manager", "owner"), (req, res) => {
    try {
      const body = req.body || {};
      const snap = customerSnapshot(body);
      const item = itemByRef(body);
      const title = clean(body.title || item?.title, 240);
      if (!title) return res.status(400).json({ ok: false, error: "missing_title" });
      const info = db.prepare(`
        INSERT INTO special_orders
          (status, customer_id, customer_name, customer_phone, customer_email, item_id, sku, title, platform, category, qty, deposit_cents, due_at, notes, user_id)
        VALUES
          (@status, @customer_id, @customer_name, @customer_phone, @customer_email, @item_id, @sku, @title, @platform, @category, @qty, @deposit_cents, @due_at, @notes, @user_id)
      `).run({
        status: clean(body.status || "open", 40),
        ...snap,
        item_id: item?.id || null,
        sku: clean(body.sku || item?.sku, 120),
        title,
        platform: clean(body.platform || item?.platform, 120),
        category: clean(body.category || item?.category, 80),
        qty: Math.max(1, intVal(body.qty, 1)),
        deposit_cents: Math.max(0, centsFrom(body, "deposit_cents", "deposit")),
        due_at: clean(body.due_at || body.dueAt, 40),
        notes: clean(body.notes, 1000),
        user_id: req.user.id
      });
      audit(req, "special_order_created", "operations", { specialOrderId: info.lastInsertRowid, title });
      res.json({ ok: true, special_order: serializeMoney(db.prepare(`SELECT * FROM special_orders WHERE id=?`).get(info.lastInsertRowid), [["deposit_cents", "deposit"]]) });
    } catch (err) {
      respondError(res, err, "special_order_create_failed");
    }
  });

  app.put("/api/special-orders/:id", requireAuth, requireRole("clerk", "manager", "owner"), (req, res) => {
    try {
      const existing = db.prepare(`SELECT * FROM special_orders WHERE id=?`).get(Number(req.params.id));
      if (!existing) return res.status(404).json({ ok: false, error: "special_order_not_found" });
      const status = clean(req.body?.status || existing.status, 40);
      db.prepare(`
        UPDATE special_orders
        SET status=?, due_at=?, notes=?, updated_at=datetime('now')
        WHERE id=?
      `).run(status, clean(req.body?.due_at || existing.due_at, 40), clean(req.body?.notes ?? existing.notes, 1000), existing.id);
      if (status === "arrived") {
        upsertFollowup({
          customer_id: existing.customer_id,
          customer_name: existing.customer_name,
          customer_phone: existing.customer_phone,
          customer_email: existing.customer_email,
          type: "special_order",
          subject: `${existing.title} arrived`,
          source_type: "special_order",
          source_id: String(existing.id),
          notes: "Special order is ready for pickup."
        }, req.user.id);
      }
      res.json({ ok: true, special_order: serializeMoney(db.prepare(`SELECT * FROM special_orders WHERE id=?`).get(existing.id), [["deposit_cents", "deposit"]]) });
    } catch (err) {
      respondError(res, err, "special_order_update_failed");
    }
  });

  app.get("/api/reservations", requireAuth, (req, res) => {
    try {
      const status = clean(req.query.status || "active", 40);
      const rows = db.prepare(`
        SELECT *
        FROM reservations
        WHERE (@status='all' OR status=@status)
        ORDER BY datetime(created_at) DESC, id DESC
        LIMIT 200
      `).all({ status }).map((row) => serializeMoney(row, [["deposit_cents", "deposit"]]));
      res.json({ ok: true, rows });
    } catch (err) {
      respondError(res, err, "reservations_failed");
    }
  });

  app.post("/api/reservations", requireAuth, requireRole("clerk", "manager", "owner"), (req, res) => {
    try {
      const body = req.body || {};
      const item = itemByRef(body);
      if (!item) throw new Error("item_not_found");
      const qty = Math.max(1, intVal(body.qty, 1));
      const snap = customerSnapshot(body);
      const tx = db.transaction(() => {
        reserveItem(item, qty, req.user.id, `Reservation for ${snap.customer_name || "customer"}`, "reservation_hold");
        const info = db.prepare(`
          INSERT INTO reservations
            (customer_id, customer_name, customer_phone, customer_email, item_id, sku, title, qty, deposit_cents, due_at, notes, user_id)
          VALUES
            (@customer_id, @customer_name, @customer_phone, @customer_email, @item_id, @sku, @title, @qty, @deposit_cents, @due_at, @notes, @user_id)
        `).run({
          ...snap,
          item_id: item.id,
          sku: item.sku,
          title: item.title,
          qty,
          deposit_cents: Math.max(0, centsFrom(body, "deposit_cents", "deposit")),
          due_at: clean(body.due_at || body.dueAt, 40),
          notes: clean(body.notes, 1000),
          user_id: req.user.id
        });
        return info.lastInsertRowid;
      });
      const id = tx();
      storeWorkflows?.refreshAllBundleAvailability?.();
      audit(req, "reservation_created", "operations", { reservationId: id, itemId: item.id, qty });
      res.json({ ok: true, reservation: serializeMoney(db.prepare(`SELECT * FROM reservations WHERE id=?`).get(id), [["deposit_cents", "deposit"]]) });
    } catch (err) {
      respondError(res, err, "reservation_create_failed");
    }
  });

  app.put("/api/reservations/:id", requireAuth, requireRole("clerk", "manager", "owner"), (req, res) => {
    try {
      const row = db.prepare(`SELECT * FROM reservations WHERE id=?`).get(Number(req.params.id));
      if (!row) throw new Error("reservation_not_found");
      const nextStatus = clean(req.body?.status || row.status, 40);
      const tx = db.transaction(() => {
        if (row.status === "active" && ["cancelled", "expired"].includes(nextStatus)) {
          restoreItem(row.item_id, row.qty, req.user.id, `Reservation #${row.id}`, "reservation_released");
        }
        db.prepare(`UPDATE reservations SET status=?, notes=?, updated_at=datetime('now') WHERE id=?`)
          .run(nextStatus, clean(req.body?.notes ?? row.notes, 1000), row.id);
      });
      tx();
      storeWorkflows?.refreshAllBundleAvailability?.();
      audit(req, "reservation_updated", "operations", { reservationId: row.id, status: nextStatus });
      res.json({ ok: true, reservation: serializeMoney(db.prepare(`SELECT * FROM reservations WHERE id=?`).get(row.id), [["deposit_cents", "deposit"]]) });
    } catch (err) {
      respondError(res, err, "reservation_update_failed");
    }
  });

  app.get("/api/followups", requireAuth, (req, res) => {
    try {
      const status = clean(req.query.status || "open", 40);
      const rows = db.prepare(`
        SELECT *
        FROM followups
        WHERE (@status='all' OR status=@status)
        ORDER BY COALESCE(due_at, created_at) ASC, id ASC
        LIMIT 250
      `).all({ status });
      res.json({ ok: true, rows });
    } catch (err) {
      respondError(res, err, "followups_failed");
    }
  });

  app.post("/api/followups", requireAuth, requireRole("clerk", "manager", "owner"), (req, res) => {
    try {
      const body = req.body || {};
      const snap = customerSnapshot(body);
      const subject = clean(body.subject, 240);
      if (!subject) return res.status(400).json({ ok: false, error: "missing_subject" });
      const info = db.prepare(`
        INSERT INTO followups
          (customer_id, customer_name, customer_phone, customer_email, type, status, subject, due_at, source_type, source_id, notes, user_id)
        VALUES
          (@customer_id, @customer_name, @customer_phone, @customer_email, @type, @status, @subject, @due_at, @source_type, @source_id, @notes, @user_id)
      `).run({
        ...snap,
        type: clean(body.type || "general", 80),
        status: clean(body.status || "open", 40),
        subject,
        due_at: clean(body.due_at || body.dueAt || todayIso(), 40),
        source_type: clean(body.source_type || body.sourceType, 80),
        source_id: clean(body.source_id || body.sourceId, 80),
        notes: clean(body.notes, 1000),
        user_id: req.user.id
      });
      res.json({ ok: true, followup: db.prepare(`SELECT * FROM followups WHERE id=?`).get(info.lastInsertRowid) });
    } catch (err) {
      respondError(res, err, "followup_create_failed");
    }
  });

  app.put("/api/followups/:id", requireAuth, requireRole("clerk", "manager", "owner"), (req, res) => {
    try {
      const row = db.prepare(`SELECT * FROM followups WHERE id=?`).get(Number(req.params.id));
      if (!row) return res.status(404).json({ ok: false, error: "followup_not_found" });
      db.prepare(`
        UPDATE followups
        SET status=?, due_at=?, notes=?, updated_at=datetime('now')
        WHERE id=?
      `).run(
        clean(req.body?.status || row.status, 40),
        clean(req.body?.due_at || row.due_at, 40),
        clean(req.body?.notes ?? row.notes, 1000),
        row.id
      );
      res.json({ ok: true, followup: db.prepare(`SELECT * FROM followups WHERE id=?`).get(row.id) });
    } catch (err) {
      respondError(res, err, "followup_update_failed");
    }
  });

  app.post("/api/followups/generate", requireAuth, requireRole("clerk", "manager", "owner"), (req, res) => {
    try {
      const before = db.prepare(`SELECT COUNT(*) AS c FROM followups`).get().c || 0;
      const wishRows = db.prepare(`
        SELECT wr.*, c.name AS c_name, c.phone AS c_phone, c.email AS c_email, i.id AS item_id, i.sku, i.title AS item_title
        FROM wishlist_requests wr
        LEFT JOIN customers c ON c.id=wr.customer_id
        JOIN items i ON i.deleted_at IS NULL AND COALESCE(i.qty,0) > 0
        WHERE wr.status='active'
      `).all();
      for (const row of wishRows) {
        const wanted = lower(row.title);
        const itemText = lower(`${row.item_title || ""} ${row.sku || ""} ${row.platform || ""}`);
        if (!wanted || !itemText.includes(wanted)) continue;
        upsertFollowup({
          customer_id: row.customer_id,
          customer_name: row.customer_name || row.c_name,
          customer_phone: row.customer_phone || row.c_phone,
          customer_email: row.customer_email || row.c_email,
          type: "wishlist",
          subject: `${row.item_title || row.title} matches wishlist`,
          source_type: "wishlist",
          source_id: `${row.id}:${row.item_id}`,
          notes: `Wishlist match in stock: ${row.sku || ""}`
        }, req.user.id);
      }
      const readyRepairs = db.prepare(`SELECT * FROM repair_tickets WHERE status='ready'`).all();
      for (const row of readyRepairs) {
        upsertFollowup({
          customer_id: row.customer_id,
          customer_name: row.customer_name,
          customer_phone: row.customer_phone,
          customer_email: row.customer_email,
          type: "repair",
          subject: `${row.device || "Repair"} is ready`,
          source_type: "repair",
          source_id: String(row.id),
          notes: "Repair is ready for pickup."
        }, req.user.id);
      }
      const arrivedSpecials = db.prepare(`SELECT * FROM special_orders WHERE status='arrived'`).all();
      for (const row of arrivedSpecials) {
        upsertFollowup({
          customer_id: row.customer_id,
          customer_name: row.customer_name,
          customer_phone: row.customer_phone,
          customer_email: row.customer_email,
          type: "special_order",
          subject: `${row.title} arrived`,
          source_type: "special_order",
          source_id: String(row.id),
          notes: "Special order is ready for pickup."
        }, req.user.id);
      }
      const after = db.prepare(`SELECT COUNT(*) AS c FROM followups`).get().c || 0;
      res.json({ ok: true, created: Math.max(0, after - before) });
    } catch (err) {
      respondError(res, err, "followup_generate_failed");
    }
  });

  // -------------------------------------------------------------------------
  // Gift cards, promos, warranties, serials
  // -------------------------------------------------------------------------
  app.get("/api/gift-cards", requireAuth, (req, res) => {
    try {
      const search = `%${lower(req.query.search || "")}%`;
      const rows = db.prepare(`
        SELECT gc.*, c.name AS customer_name
        FROM gift_cards gc
        LEFT JOIN customers c ON c.id=gc.customer_id
        WHERE (?='%%' OR lower(gc.code || ' ' || COALESCE(c.name,'')) LIKE ?)
        ORDER BY datetime(gc.updated_at) DESC, gc.id DESC
        LIMIT 200
      `).all(search, search).map((row) => serializeMoney(row, [["balance_cents", "balance"], ["issued_cents", "issued"]]));
      res.json({ ok: true, rows });
    } catch (err) {
      respondError(res, err, "gift_cards_failed");
    }
  });

  app.get("/api/gift-cards/by-code/:code", requireAuth, (req, res) => {
    try {
      const row = db.prepare(`SELECT * FROM gift_cards WHERE code=?`).get(clean(req.params.code, 80));
      if (!row) throw new Error("gift_card_not_found");
      res.json({ ok: true, gift_card: serializeMoney(row, [["balance_cents", "balance"], ["issued_cents", "issued"]]) });
    } catch (err) {
      respondError(res, err, "gift_card_failed");
    }
  });

  app.post("/api/gift-cards", requireAuth, requirePerm("checkout"), (req, res) => {
    try {
      const body = req.body || {};
      const amount = Math.max(0, centsFrom(body, "amount_cents", "amount") || centsFrom(body, "issued_cents", "issued"));
      const code = clean(body.code, 80) || shortCode("GC");
      const info = db.prepare(`
        INSERT INTO gift_cards (code, balance_cents, issued_cents, customer_id, notes, user_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(code, amount, amount, Number(body.customer_id || 0) || null, clean(body.notes, 1000), req.user.id);
      db.prepare(`INSERT INTO gift_card_transactions (gift_card_id, amount_cents, reason, user_id) VALUES (?, ?, ?, ?)`)
        .run(info.lastInsertRowid, amount, "issued", req.user.id);
      res.json({ ok: true, gift_card: serializeMoney(db.prepare(`SELECT * FROM gift_cards WHERE id=?`).get(info.lastInsertRowid), [["balance_cents", "balance"], ["issued_cents", "issued"]]) });
    } catch (err) {
      respondError(res, err, "gift_card_create_failed");
    }
  });

  app.post("/api/gift-cards/:id/adjust", requireAuth, requirePerm("checkout"), (req, res) => {
    try {
      const card = db.prepare(`SELECT * FROM gift_cards WHERE id=?`).get(Number(req.params.id));
      if (!card) throw new Error("gift_card_not_found");
      const amount = centsFrom(req.body || {}, "amount_cents", "amount");
      const next = Math.max(0, Number(card.balance_cents || 0) + amount);
      db.prepare(`UPDATE gift_cards SET balance_cents=?, updated_at=datetime('now') WHERE id=?`).run(next, card.id);
      db.prepare(`INSERT INTO gift_card_transactions (gift_card_id, amount_cents, reason, sale_id, user_id) VALUES (?, ?, ?, ?, ?)`)
        .run(card.id, amount, clean(req.body?.reason || "adjustment", 160), Number(req.body?.sale_id || 0) || null, req.user.id);
      res.json({ ok: true, gift_card: serializeMoney(db.prepare(`SELECT * FROM gift_cards WHERE id=?`).get(card.id), [["balance_cents", "balance"], ["issued_cents", "issued"]]) });
    } catch (err) {
      respondError(res, err, "gift_card_adjust_failed");
    }
  });

  app.get("/api/promotions", requireAuth, (_req, res) => {
    try {
      const rows = db.prepare(`SELECT * FROM promotions ORDER BY status DESC, datetime(created_at) DESC, id DESC`).all()
        .map((row) => serializeMoney(row, [["value_cents", "value"]]));
      res.json({ ok: true, rows });
    } catch (err) {
      respondError(res, err, "promotions_failed");
    }
  });

  app.post("/api/promotions", requireAuth, requirePerm("settings_admin"), (req, res) => {
    try {
      const body = req.body || {};
      const name = clean(body.name, 160);
      if (!name) return res.status(400).json({ ok: false, error: "missing_name" });
      const info = db.prepare(`
        INSERT INTO promotions (name, code, type, value_cents, value_percent, scope, status, start_at, end_at, notes, user_id)
        VALUES (@name, @code, @type, @value_cents, @value_percent, @scope, @status, @start_at, @end_at, @notes, @user_id)
      `).run({
        name,
        code: clean(body.code, 80),
        type: clean(body.type || "percent", 40),
        value_cents: Math.max(0, centsFrom(body, "value_cents", "value")),
        value_percent: Math.max(0, Number(body.value_percent || body.percent || 0)),
        scope: clean(body.scope || "cart", 80),
        status: clean(body.status || "active", 40),
        start_at: clean(body.start_at || body.startAt, 40),
        end_at: clean(body.end_at || body.endAt, 40),
        notes: clean(body.notes, 1000),
        user_id: req.user.id
      });
      res.json({ ok: true, promotion: serializeMoney(db.prepare(`SELECT * FROM promotions WHERE id=?`).get(info.lastInsertRowid), [["value_cents", "value"]]) });
    } catch (err) {
      respondError(res, err, "promotion_create_failed");
    }
  });

  app.post("/api/promotions/preview", requireAuth, (req, res) => {
    try {
      const body = req.body || {};
      const code = lower(body.code || "");
      const subtotal = Math.max(0, centsFrom(body, "subtotal_cents", "subtotal"));
      const promos = db.prepare(`
        SELECT *
        FROM promotions
        WHERE status='active' AND (?='' OR lower(code)=? OR lower(name)=?)
        ORDER BY id DESC
      `).all(code, code, code);
      const promo = promos[0] || null;
      let discount = 0;
      if (promo) {
        if (promo.type === "fixed") discount = Math.min(subtotal, Number(promo.value_cents || 0));
        else discount = Math.min(subtotal, Math.round(subtotal * (Number(promo.value_percent || 0) / 100)));
      }
      res.json({ ok: true, promotion: promo, discount_cents: discount, discount: dollars(discount), total_cents: Math.max(0, subtotal - discount), total: dollars(Math.max(0, subtotal - discount)) });
    } catch (err) {
      respondError(res, err, "promotion_preview_failed");
    }
  });

  app.get("/api/warranties", requireAuth, (_req, res) => {
    try {
      const rows = db.prepare(`
        SELECT w.*, i.title, i.sku, c.name AS customer_name
        FROM warranties w
        LEFT JOIN items i ON i.id=w.item_id
        LEFT JOIN customers c ON c.id=w.customer_id
        ORDER BY datetime(w.created_at) DESC, w.id DESC
        LIMIT 200
      `).all();
      res.json({ ok: true, rows });
    } catch (err) {
      respondError(res, err, "warranties_failed");
    }
  });

  app.post("/api/warranties", requireAuth, requireRole("clerk", "manager", "owner"), (req, res) => {
    try {
      const body = req.body || {};
      const days = Math.max(1, intVal(body.coverage_days || body.coverageDays, 30));
      const created = body.created_at ? new Date(body.created_at) : new Date();
      const expires = body.expires_at || new Date(created.getTime() + days * 86400000).toISOString().slice(0, 10);
      const info = db.prepare(`
        INSERT INTO warranties (item_id, sale_id, customer_id, serial_number, coverage_days, expires_at, status, notes, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        Number(body.item_id || 0) || null,
        Number(body.sale_id || 0) || null,
        Number(body.customer_id || 0) || null,
        clean(body.serial_number || body.serialNumber, 160),
        days,
        clean(expires, 40),
        clean(body.status || "active", 40),
        clean(body.notes, 1000),
        req.user.id
      );
      res.json({ ok: true, warranty: db.prepare(`SELECT * FROM warranties WHERE id=?`).get(info.lastInsertRowid) });
    } catch (err) {
      respondError(res, err, "warranty_create_failed");
    }
  });

  app.get("/api/serials", requireAuth, (_req, res) => {
    try {
      const rows = db.prepare(`
        SELECT su.*, i.title, c.name AS customer_name
        FROM serialized_units su
        LEFT JOIN items i ON i.id=su.item_id
        LEFT JOIN customers c ON c.id=su.customer_id
        ORDER BY datetime(su.created_at) DESC, su.id DESC
        LIMIT 200
      `).all();
      res.json({ ok: true, rows });
    } catch (err) {
      respondError(res, err, "serials_failed");
    }
  });

  app.post("/api/serials", requireAuth, requirePerm("inv_edit"), (req, res) => {
    try {
      const body = req.body || {};
      const serial = clean(body.serial_number || body.serialNumber, 160);
      if (!serial) return res.status(400).json({ ok: false, error: "missing_serial" });
      const item = itemByRef(body);
      const info = db.prepare(`
        INSERT INTO serialized_units (item_id, sku, serial_number, status, source_type, source_id, customer_id, notes, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        item?.id || null,
        clean(body.sku || item?.sku, 120),
        serial,
        clean(body.status || "in_stock", 40),
        clean(body.source_type || body.sourceType, 80),
        clean(body.source_id || body.sourceId, 80),
        Number(body.customer_id || 0) || null,
        clean(body.notes, 1000),
        req.user.id
      );
      res.json({ ok: true, serial: db.prepare(`SELECT * FROM serialized_units WHERE id=?`).get(info.lastInsertRowid) });
    } catch (err) {
      if (String(err?.message || "").includes("UNIQUE")) return respondError(res, new Error("duplicate_serial"), "serial_create_failed");
      respondError(res, err, "serial_create_failed");
    }
  });

  app.get("/api/items/:id/collectible-details", requireAuth, (req, res) => {
    try {
      const item = db.prepare(`SELECT * FROM items WHERE id=? AND deleted_at IS NULL`).get(Number(req.params.id));
      if (!item) throw new Error("item_not_found");
      const details = db.prepare(`SELECT * FROM item_collectible_details WHERE item_id=?`).get(item.id) || { item_id: item.id };
      res.json({ ok: true, item, details });
    } catch (err) {
      respondError(res, err, "collectible_details_failed");
    }
  });

  app.post("/api/items/:id/collectible-details", requireAuth, requirePerm("inv_edit"), (req, res) => {
    try {
      const item = db.prepare(`SELECT * FROM items WHERE id=? AND deleted_at IS NULL`).get(Number(req.params.id));
      if (!item) throw new Error("item_not_found");
      const body = req.body || {};
      db.prepare(`
        INSERT INTO item_collectible_details
          (item_id, card_set, card_number, rarity, finish, language, grade_company, grade, cert_number, notes, updated_at, user_id)
        VALUES
          (@item_id, @card_set, @card_number, @rarity, @finish, @language, @grade_company, @grade, @cert_number, @notes, datetime('now'), @user_id)
        ON CONFLICT(item_id) DO UPDATE SET
          card_set=excluded.card_set,
          card_number=excluded.card_number,
          rarity=excluded.rarity,
          finish=excluded.finish,
          language=excluded.language,
          grade_company=excluded.grade_company,
          grade=excluded.grade,
          cert_number=excluded.cert_number,
          notes=excluded.notes,
          updated_at=datetime('now'),
          user_id=excluded.user_id
      `).run({
        item_id: item.id,
        card_set: clean(body.card_set || body.cardSet, 160),
        card_number: clean(body.card_number || body.cardNumber, 80),
        rarity: clean(body.rarity, 80),
        finish: clean(body.finish, 80),
        language: clean(body.language || "English", 80),
        grade_company: clean(body.grade_company || body.gradeCompany, 80),
        grade: clean(body.grade, 80),
        cert_number: clean(body.cert_number || body.certNumber, 120),
        notes: clean(body.notes, 1000),
        user_id: req.user.id
      });
      res.json({ ok: true, details: db.prepare(`SELECT * FROM item_collectible_details WHERE item_id=?`).get(item.id) });
    } catch (err) {
      respondError(res, err, "collectible_details_save_failed");
    }
  });

  // -------------------------------------------------------------------------
  // House accounts and time clock
  // -------------------------------------------------------------------------
  app.get("/api/house-accounts", requireAuth, (_req, res) => {
    try {
      const rows = db.prepare(`
        SELECT ha.*, c.phone AS customer_phone, c.email AS customer_email
        FROM house_accounts ha
        LEFT JOIN customers c ON c.id=ha.customer_id
        ORDER BY datetime(ha.updated_at) DESC, ha.id DESC
        LIMIT 200
      `).all().map((row) => serializeMoney(row, [["credit_limit_cents", "credit_limit"], ["balance_cents", "balance"]]));
      res.json({ ok: true, rows });
    } catch (err) {
      respondError(res, err, "house_accounts_failed");
    }
  });

  app.post("/api/house-accounts", requireAuth, requirePerm("store_credit"), (req, res) => {
    try {
      const body = req.body || {};
      const snap = customerSnapshot(body);
      if (!snap.customer_id || !snap.customer) throw new Error("customer_not_found");
      const limit = Math.max(0, centsFrom(body, "credit_limit_cents", "credit_limit"));
      db.prepare(`
        INSERT INTO house_accounts (customer_id, customer_name, credit_limit_cents, balance_cents, status, notes, user_id)
        VALUES (?, ?, ?, 0, ?, ?, ?)
        ON CONFLICT(customer_id) DO UPDATE SET
          customer_name=excluded.customer_name,
          credit_limit_cents=excluded.credit_limit_cents,
          status=excluded.status,
          notes=excluded.notes,
          updated_at=datetime('now'),
          user_id=excluded.user_id
      `).run(snap.customer_id, snap.customer_name, limit, clean(body.status || "active", 40), clean(body.notes, 1000), req.user.id);
      res.json({ ok: true, house_account: serializeMoney(db.prepare(`SELECT * FROM house_accounts WHERE customer_id=?`).get(snap.customer_id), [["credit_limit_cents", "credit_limit"], ["balance_cents", "balance"]]) });
    } catch (err) {
      respondError(res, err, "house_account_create_failed");
    }
  });

  function adjustHouseAccount(req, res, mode) {
    try {
      const acct = db.prepare(`SELECT * FROM house_accounts WHERE id=?`).get(Number(req.params.id));
      if (!acct) throw new Error("house_account_not_found");
      const amount = Math.max(0, centsFrom(req.body || {}, "amount_cents", "amount"));
      const signed = mode === "payment" ? -amount : amount;
      const next = Math.max(0, Number(acct.balance_cents || 0) + signed);
      if (signed > 0 && Number(acct.credit_limit_cents || 0) > 0 && next > Number(acct.credit_limit_cents || 0)) {
        throw new Error("house_account_limit_exceeded");
      }
      db.prepare(`UPDATE house_accounts SET balance_cents=?, updated_at=datetime('now') WHERE id=?`).run(next, acct.id);
      db.prepare(`INSERT INTO house_account_entries (house_account_id, amount_cents, reason, sale_id, user_id) VALUES (?, ?, ?, ?, ?)`)
        .run(acct.id, signed, clean(req.body?.reason || mode, 160), Number(req.body?.sale_id || 0) || null, req.user.id);
      res.json({ ok: true, house_account: serializeMoney(db.prepare(`SELECT * FROM house_accounts WHERE id=?`).get(acct.id), [["credit_limit_cents", "credit_limit"], ["balance_cents", "balance"]]) });
    } catch (err) {
      respondError(res, err, `house_account_${mode}_failed`);
    }
  }

  app.post("/api/house-accounts/:id/charge", requireAuth, requirePerm("store_credit"), (req, res) => adjustHouseAccount(req, res, "charge"));
  app.post("/api/house-accounts/:id/payment", requireAuth, requirePerm("store_credit"), (req, res) => adjustHouseAccount(req, res, "payment"));

  app.get("/api/time-clock", requireAuth, (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT tce.*, u.username, COALESCE(u.display_name, u.username) AS display_name
        FROM time_clock_entries tce
        JOIN users u ON u.id=tce.user_id
        WHERE (?=1 OR tce.user_id=?)
        ORDER BY datetime(tce.clock_in_at) DESC
        LIMIT 200
      `).all(req.user.role === "owner" || req.user.role === "manager" ? 1 : 0, req.user.id);
      res.json({ ok: true, rows });
    } catch (err) {
      respondError(res, err, "time_clock_failed");
    }
  });

  app.post("/api/time-clock/clock-in", requireAuth, (req, res) => {
    try {
      const open = db.prepare(`SELECT * FROM time_clock_entries WHERE user_id=? AND clock_out_at IS NULL`).get(req.user.id);
      if (open) throw new Error("clock_already_open");
      const info = db.prepare(`INSERT INTO time_clock_entries (user_id, notes) VALUES (?, ?)`).run(req.user.id, clean(req.body?.notes, 500));
      res.json({ ok: true, entry: db.prepare(`SELECT * FROM time_clock_entries WHERE id=?`).get(info.lastInsertRowid) });
    } catch (err) {
      respondError(res, err, "clock_in_failed");
    }
  });

  app.post("/api/time-clock/clock-out", requireAuth, (req, res) => {
    try {
      const open = db.prepare(`SELECT * FROM time_clock_entries WHERE user_id=? AND clock_out_at IS NULL ORDER BY id DESC LIMIT 1`).get(req.user.id);
      if (!open) throw new Error("active_clock_entry_not_found");
      db.prepare(`UPDATE time_clock_entries SET clock_out_at=datetime('now'), notes=COALESCE(NULLIF(?,''), notes) WHERE id=?`)
        .run(clean(req.body?.notes, 500), open.id);
      res.json({ ok: true, entry: db.prepare(`SELECT * FROM time_clock_entries WHERE id=?`).get(open.id) });
    } catch (err) {
      respondError(res, err, "clock_out_failed");
    }
  });

  // -------------------------------------------------------------------------
  // Game-store services: buylist, consignment, rentals
  // -------------------------------------------------------------------------
  app.get("/api/buylist-rules", requireAuth, (_req, res) => {
    try {
      const rows = db.prepare(`SELECT * FROM buylist_rules ORDER BY status DESC, lower(title) ASC LIMIT 250`).all()
        .map((row) => serializeMoney(row, [["cash_cents", "cash"], ["credit_cents", "credit"]]));
      res.json({ ok: true, rows });
    } catch (err) {
      respondError(res, err, "buylist_failed");
    }
  });

  app.post("/api/buylist-rules", requireAuth, requirePerm("settings_admin"), (req, res) => {
    try {
      const body = req.body || {};
      const title = clean(body.title, 240);
      if (!title) return res.status(400).json({ ok: false, error: "missing_title" });
      const info = db.prepare(`
        INSERT INTO buylist_rules (title, platform, category, condition, cash_cents, credit_cents, status, notes, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        title,
        clean(body.platform, 120),
        clean(body.category, 80),
        clean(body.condition || "Any", 80),
        Math.max(0, centsFrom(body, "cash_cents", "cash")),
        Math.max(0, centsFrom(body, "credit_cents", "credit")),
        clean(body.status || "active", 40),
        clean(body.notes, 1000),
        req.user.id
      );
      res.json({ ok: true, rule: serializeMoney(db.prepare(`SELECT * FROM buylist_rules WHERE id=?`).get(info.lastInsertRowid), [["cash_cents", "cash"], ["credit_cents", "credit"]]) });
    } catch (err) {
      respondError(res, err, "buylist_create_failed");
    }
  });

  app.get("/api/consignments", requireAuth, (_req, res) => {
    try {
      const rows = db.prepare(`SELECT * FROM consignments ORDER BY datetime(created_at) DESC, id DESC LIMIT 200`).all()
        .map((row) => serializeMoney(row, [["payout_cents", "payout"]]));
      res.json({ ok: true, rows });
    } catch (err) {
      respondError(res, err, "consignments_failed");
    }
  });

  app.post("/api/consignments", requireAuth, requirePerm("inv_add"), (req, res) => {
    try {
      const body = req.body || {};
      const snap = customerSnapshot(body);
      const item = itemByRef(body);
      const title = clean(body.title || item?.title, 240);
      if (!title) return res.status(400).json({ ok: false, error: "missing_title" });
      const info = db.prepare(`
        INSERT INTO consignments (customer_id, customer_name, item_id, sku, title, status, split_percent, payout_cents, notes, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        snap.customer_id,
        snap.customer_name,
        item?.id || null,
        clean(body.sku || item?.sku, 120),
        title,
        clean(body.status || "active", 40),
        Math.max(0, Number(body.split_percent || body.splitPercent || 60)),
        Math.max(0, centsFrom(body, "payout_cents", "payout")),
        clean(body.notes, 1000),
        req.user.id
      );
      res.json({ ok: true, consignment: serializeMoney(db.prepare(`SELECT * FROM consignments WHERE id=?`).get(info.lastInsertRowid), [["payout_cents", "payout"]]) });
    } catch (err) {
      respondError(res, err, "consignment_create_failed");
    }
  });

  app.post("/api/consignments/:id/settle", requireAuth, requirePerm("store_credit"), (req, res) => {
    try {
      const row = db.prepare(`SELECT * FROM consignments WHERE id=?`).get(Number(req.params.id));
      if (!row) return res.status(404).json({ ok: false, error: "consignment_not_found" });
      const payout = Math.max(0, centsFrom(req.body || {}, "payout_cents", "payout") || Number(row.payout_cents || 0));
      db.prepare(`UPDATE consignments SET status='settled', payout_cents=?, sale_id=?, updated_at=datetime('now') WHERE id=?`)
        .run(payout, Number(req.body?.sale_id || row.sale_id || 0) || null, row.id);
      if (row.customer_id && payout > 0) {
        db.prepare(`UPDATE customers SET store_credit_cents=COALESCE(store_credit_cents,0)+?, updated_at=datetime('now') WHERE id=?`).run(payout, row.customer_id);
        db.prepare(`INSERT INTO customer_adjustments (customer_id, amount_cents, reason, user_id) VALUES (?, ?, ?, ?)`)
          .run(row.customer_id, payout, `Consignment payout #${row.id}`, req.user.id);
      }
      res.json({ ok: true, consignment: serializeMoney(db.prepare(`SELECT * FROM consignments WHERE id=?`).get(row.id), [["payout_cents", "payout"]]) });
    } catch (err) {
      respondError(res, err, "consignment_settle_failed");
    }
  });

  app.get("/api/rentals", requireAuth, (_req, res) => {
    try {
      const rows = db.prepare(`SELECT * FROM rentals ORDER BY datetime(created_at) DESC, id DESC LIMIT 200`).all()
        .map((row) => serializeMoney(row, [["deposit_cents", "deposit"], ["fee_cents", "fee"]]));
      res.json({ ok: true, rows });
    } catch (err) {
      respondError(res, err, "rentals_failed");
    }
  });

  app.post("/api/rentals", requireAuth, requireRole("clerk", "manager", "owner"), (req, res) => {
    try {
      const body = req.body || {};
      const item = itemByRef(body);
      if (!item) throw new Error("item_not_found");
      const snap = customerSnapshot(body);
      const tx = db.transaction(() => {
        reserveItem(item, 1, req.user.id, `Rental to ${snap.customer_name || "customer"}`, "rental_out");
        const info = db.prepare(`
          INSERT INTO rentals (customer_id, customer_name, item_id, sku, title, deposit_cents, fee_cents, due_at, notes, user_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          snap.customer_id,
          snap.customer_name,
          item.id,
          item.sku,
          item.title,
          Math.max(0, centsFrom(body, "deposit_cents", "deposit")),
          Math.max(0, centsFrom(body, "fee_cents", "fee")),
          clean(body.due_at || body.dueAt, 40),
          clean(body.notes, 1000),
          req.user.id
        );
        return info.lastInsertRowid;
      });
      const id = tx();
      storeWorkflows?.refreshAllBundleAvailability?.();
      res.json({ ok: true, rental: serializeMoney(db.prepare(`SELECT * FROM rentals WHERE id=?`).get(id), [["deposit_cents", "deposit"], ["fee_cents", "fee"]]) });
    } catch (err) {
      respondError(res, err, "rental_create_failed");
    }
  });

  app.post("/api/rentals/:id/return", requireAuth, requireRole("clerk", "manager", "owner"), (req, res) => {
    try {
      const row = db.prepare(`SELECT * FROM rentals WHERE id=?`).get(Number(req.params.id));
      if (!row) throw new Error("rental_not_found");
      const tx = db.transaction(() => {
        if (row.status === "out") restoreItem(row.item_id, 1, req.user.id, `Rental #${row.id}`, "rental_returned");
        db.prepare(`UPDATE rentals SET status='returned', returned_at=datetime('now'), notes=COALESCE(NULLIF(?,''), notes), updated_at=datetime('now') WHERE id=?`)
          .run(clean(req.body?.notes, 1000), row.id);
      });
      tx();
      storeWorkflows?.refreshAllBundleAvailability?.();
      res.json({ ok: true, rental: serializeMoney(db.prepare(`SELECT * FROM rentals WHERE id=?`).get(row.id), [["deposit_cents", "deposit"], ["fee_cents", "fee"]]) });
    } catch (err) {
      respondError(res, err, "rental_return_failed");
    }
  });

  // -------------------------------------------------------------------------
  // Safety: backups, audit, movement history, markdowns, pricing rules
  // -------------------------------------------------------------------------
  app.get("/api/backups", requireAuth, requirePerm("settings_admin"), (_req, res) => {
    try {
      const rows = db.prepare(`SELECT * FROM backups ORDER BY datetime(created_at) DESC, id DESC LIMIT 100`).all();
      res.json({ ok: true, rows });
    } catch (err) {
      respondError(res, err, "backups_failed");
    }
  });

  app.post("/api/backups/create", requireAuth, requirePerm("settings_admin"), async (req, res) => {
    try {
      const dir = path.join(path.dirname(dbPath), "backups");
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dest = path.join(dir, `inventory-${stamp}.db`);
      if (typeof db.backup === "function") await db.backup(dest);
      else fs.copyFileSync(dbPath, dest);
      const stat = fs.statSync(dest);
      const info = db.prepare(`INSERT INTO backups (path, size_bytes, status, user_id, notes) VALUES (?, ?, 'created', ?, ?)`)
        .run(dest, stat.size, req.user.id, clean(req.body?.notes || "Manual backup", 500));
      audit(req, "backup_created", "operations", { backupId: info.lastInsertRowid });
      res.json({ ok: true, backup: db.prepare(`SELECT * FROM backups WHERE id=?`).get(info.lastInsertRowid) });
    } catch (err) {
      respondError(res, err, "backup_create_failed");
    }
  });

  app.post("/api/backups/:id/restore", requireAuth, requirePerm("settings_admin"), (req, res) => {
    try {
      const backup = db.prepare(`SELECT * FROM backups WHERE id=?`).get(Number(req.params.id));
      if (!backup) throw new Error("backup_not_found");
      if (!fs.existsSync(backup.path)) return res.status(404).json({ ok: false, error: "backup_file_missing" });
      res.status(409).json({
        ok: false,
        error: "restore_requires_restart",
        message: "Restore is guarded while the POS database is open. Use the backup path after closing the app."
      });
    } catch (err) {
      respondError(res, err, "backup_restore_failed");
    }
  });

  app.get("/api/audit-log", requireAuth, requirePerm("reports"), (req, res) => {
    try {
      const limit = Math.min(500, Math.max(1, intVal(req.query.limit, 200)));
      const rows = db.prepare(`
        SELECT *
        FROM (
          SELECT createdAt AS created_at, 'staff' AS type, action AS title, username AS actor, screen AS detail, metadata AS metadata
          FROM user_activity
          UNION ALL
          SELECT created_at, 'inventory' AS type, reason AS title, COALESCE(sku,'') AS actor, note AS detail,
                 json_object('item_id', item_id, 'qty_delta', qty_delta, 'sale_id', sale_id, 'refund_id', refund_id) AS metadata
          FROM inventory_movements
          UNION ALL
          SELECT created_at, 'customer_credit' AS type, reason AS title, CAST(customer_id AS TEXT) AS actor, CAST(amount_cents AS TEXT) AS detail,
                 json_object('amount_cents', amount_cents) AS metadata
          FROM customer_adjustments
        )
        ORDER BY datetime(created_at) DESC
        LIMIT ?
      `).all(limit);
      res.json({ ok: true, rows });
    } catch (err) {
      respondError(res, err, "audit_log_failed");
    }
  });

  app.get("/api/items/:id/movements", requireAuth, (req, res) => {
    try {
      const item = db.prepare(`SELECT * FROM items WHERE id=?`).get(Number(req.params.id));
      if (!item) throw new Error("item_not_found");
      const rows = db.prepare(`
        SELECT im.*, u.username
        FROM inventory_movements im
        LEFT JOIN users u ON u.id=im.user_id
        WHERE im.item_id=? OR (im.sku IS NOT NULL AND im.sku=?)
        ORDER BY datetime(im.created_at) DESC, im.id DESC
        LIMIT 250
      `).all(item.id, item.sku);
      res.json({ ok: true, item, rows });
    } catch (err) {
      respondError(res, err, "item_movements_failed");
    }
  });

  app.get("/api/markdowns/suggestions", requireAuth, (req, res) => {
    try {
      const days = Math.max(1, intVal(req.query.days, 90));
      const rows = db.prepare(`
        SELECT id, sku, title, platform, category, condition, qty, cost, price, createdAt,
               CAST(julianday('now') - julianday(COALESCE(createdAt, datetime('now'))) AS INTEGER) AS age_days
        FROM items
        WHERE deleted_at IS NULL
          AND COALESCE(qty,0) > 0
          AND (createdAt IS NULL OR julianday('now') - julianday(createdAt) >= ?)
        ORDER BY age_days DESC, qty DESC
        LIMIT 250
      `).all(days).map((item) => ({
        ...item,
        current_price_cents: toCents(item.price),
        suggested_price_cents: Math.max(99, Math.round(toCents(item.price) * 0.9)),
        suggested_price: dollars(Math.max(99, Math.round(toCents(item.price) * 0.9)))
      }));
      res.json({ ok: true, rows });
    } catch (err) {
      respondError(res, err, "markdown_suggestions_failed");
    }
  });

  app.post("/api/markdowns/apply", requireAuth, requirePerm("cost_change"), (req, res) => {
    try {
      const ids = Array.isArray(req.body?.item_ids) ? req.body.item_ids.map(Number).filter(Boolean) : [];
      const percentOff = Math.max(0, Math.min(95, Number(req.body?.percent_off || req.body?.percentOff || 10)));
      const rows = ids.length ? db.prepare(`SELECT * FROM items WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) : [];
      const tx = db.transaction(() => {
        for (const item of rows) {
          const oldPrice = toCents(item.price);
          const nextCents = Math.max(0, Math.round(oldPrice * (1 - percentOff / 100)));
          db.prepare(`UPDATE items SET price=? WHERE id=?`).run(dollars(nextCents), item.id);
          logInventoryMovement({
            item_id: item.id,
            sku: item.sku,
            qty_delta: 0,
            reason: "markdown_applied",
            user_id: req.user.id,
            note: `${percentOff}% off: ${dollars(oldPrice)} -> ${dollars(nextCents)}`
          });
        }
      });
      tx();
      audit(req, "markdown_applied", "operations", { itemCount: rows.length, percentOff });
      res.json({ ok: true, updated: rows.length });
    } catch (err) {
      respondError(res, err, "markdown_apply_failed");
    }
  });

  app.get("/api/pricing-rules", requireAuth, (_req, res) => {
    try {
      const rows = db.prepare(`SELECT * FROM pricing_rules ORDER BY status DESC, lower(name) ASC`).all();
      res.json({ ok: true, rows });
    } catch (err) {
      respondError(res, err, "pricing_rules_failed");
    }
  });

  app.post("/api/pricing-rules", requireAuth, requirePerm("settings_admin"), (req, res) => {
    try {
      const body = req.body || {};
      const name = clean(body.name, 160);
      if (!name) return res.status(400).json({ ok: false, error: "missing_name" });
      const info = db.prepare(`
        INSERT INTO pricing_rules (name, scope, percent_markup, round_to_cents, min_margin_percent, status, notes, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        name,
        clean(body.scope || "all", 80),
        Number(body.percent_markup || body.percentMarkup || 0),
        Math.max(0, Math.min(99, intVal(body.round_to_cents || body.roundToCents, 99))),
        Math.max(0, Number(body.min_margin_percent || body.minMarginPercent || 0)),
        clean(body.status || "active", 40),
        clean(body.notes, 1000),
        req.user.id
      );
      res.json({ ok: true, rule: db.prepare(`SELECT * FROM pricing_rules WHERE id=?`).get(info.lastInsertRowid) });
    } catch (err) {
      respondError(res, err, "pricing_rule_create_failed");
    }
  });

  app.post("/api/pricing-rules/:id/preview", requireAuth, (req, res) => {
    try {
      const rule = db.prepare(`SELECT * FROM pricing_rules WHERE id=?`).get(Number(req.params.id));
      if (!rule) return res.status(404).json({ ok: false, error: "pricing_rule_not_found" });
      const item = itemByRef(req.body || {});
      const costCents = item ? toCents(item.cost) : Math.max(0, centsFrom(req.body || {}, "cost_cents", "cost"));
      let target = Math.round(costCents * (1 + Number(rule.percent_markup || 0) / 100));
      if (Number(rule.min_margin_percent || 0) > 0) {
        const marginTarget = Math.round(costCents / Math.max(0.01, 1 - Number(rule.min_margin_percent || 0) / 100));
        target = Math.max(target, marginTarget);
      }
      const roundTo = Math.max(0, Math.min(99, intVal(rule.round_to_cents, 99)));
      if (target > 0) {
        const base = Math.floor(target / 100) * 100 + roundTo;
        target = base < target ? base + 100 : base;
      }
      res.json({ ok: true, rule, item, suggested_cents: target, suggested: dollars(target) });
    } catch (err) {
      respondError(res, err, "pricing_rule_preview_failed");
    }
  });

  // -------------------------------------------------------------------------
  // Online/storefront, shipping, offline queue, decklists, messages, kiosk
  // -------------------------------------------------------------------------
  app.get("/api/offline-queue", requireAuth, (_req, res) => {
    try {
      const rows = db.prepare(`SELECT * FROM offline_queue ORDER BY datetime(created_at) DESC, id DESC LIMIT 200`).all();
      res.json({ ok: true, rows: rows.map((row) => ({ ...row, payload: JSON.parse(row.payload_json || "{}") })) });
    } catch (err) {
      respondError(res, err, "offline_queue_failed");
    }
  });

  app.post("/api/offline-queue", requireAuth, (req, res) => {
    try {
      const body = req.body || {};
      const clientKey = clean(body.client_key || body.clientKey || shortCode("OFF"), 120);
      const info = db.prepare(`
        INSERT OR IGNORE INTO offline_queue (client_key, payload_json, status, user_id)
        VALUES (?, ?, 'queued', ?)
      `).run(clientKey, JSON.stringify(body.payload || body), req.user.id);
      const row = db.prepare(`SELECT * FROM offline_queue WHERE client_key=?`).get(clientKey);
      res.json({ ok: true, queued: info.changes > 0, row });
    } catch (err) {
      respondError(res, err, "offline_queue_create_failed");
    }
  });

  app.post("/api/offline-queue/:id/process", requireAuth, requirePerm("checkout"), (req, res) => {
    try {
      const row = db.prepare(`SELECT * FROM offline_queue WHERE id=?`).get(Number(req.params.id));
      if (!row) return res.status(404).json({ ok: false, error: "offline_queue_not_found" });
      db.prepare(`UPDATE offline_queue SET status='processed', processed_at=datetime('now'), error=NULL WHERE id=?`).run(row.id);
      res.json({ ok: true, row: db.prepare(`SELECT * FROM offline_queue WHERE id=?`).get(row.id) });
    } catch (err) {
      respondError(res, err, "offline_queue_process_failed");
    }
  });

  function serializeOnlineOrder(row) {
    return {
      ...serializeMoney(row, [["total_cents", "total"]]),
      items: db.prepare(`SELECT * FROM online_order_items WHERE order_id=? ORDER BY id`).all(row.id)
        .map((line) => serializeMoney(line, [["unit_price_cents", "unit_price"]]))
    };
  }

  app.get("/api/online-orders", requireAuth, (req, res) => {
    try {
      const status = clean(req.query.status || "open", 40);
      const rows = db.prepare(`
        SELECT *
        FROM online_orders
        WHERE @status='all'
           OR (@status='open' AND status IN ('pending','paid','packed'))
           OR status=@status
        ORDER BY datetime(created_at) DESC, id DESC
        LIMIT 200
      `).all({ status }).map(serializeOnlineOrder);
      res.json({ ok: true, rows });
    } catch (err) {
      respondError(res, err, "online_orders_failed");
    }
  });

  app.post("/api/online-orders", requireAuth, requirePerm("checkout"), (req, res) => {
    try {
      const body = req.body || {};
      const snap = customerSnapshot(body);
      const lines = Array.isArray(body.items) ? body.items : [];
      if (!lines.length) return res.status(400).json({ ok: false, error: "missing_items" });
      const orderNo = clean(body.order_no || body.orderNo, 80) || shortCode("WEB");
      const tx = db.transaction(() => {
        const prepared = lines.map((line) => {
          const item = itemByRef(line);
          if (!item) throw new Error("item_not_found");
          const qty = Math.max(1, intVal(line.qty, 1));
          reserveItem(item, qty, req.user.id, `Online order ${orderNo}`, "online_order_reserved");
          const unit = centsFrom(line, "unit_price_cents", "unit_price") || toCents(item.price);
          return { item, qty, unit };
        });
        const total = prepared.reduce((sum, line) => sum + line.qty * line.unit, 0);
        const info = db.prepare(`
          INSERT INTO online_orders
            (order_no, customer_id, customer_name, customer_phone, customer_email, status, fulfillment_method, total_cents, shipping_address, tracking_number, notes, user_id)
          VALUES
            (@order_no, @customer_id, @customer_name, @customer_phone, @customer_email, @status, @fulfillment_method, @total_cents, @shipping_address, @tracking_number, @notes, @user_id)
        `).run({
          order_no: orderNo,
          ...snap,
          status: clean(body.status || "pending", 40),
          fulfillment_method: clean(body.fulfillment_method || body.fulfillmentMethod || "pickup", 80),
          total_cents: total,
          shipping_address: clean(body.shipping_address || body.shippingAddress, 1000),
          tracking_number: clean(body.tracking_number || body.trackingNumber, 160),
          notes: clean(body.notes, 1000),
          user_id: req.user.id
        });
        const ins = db.prepare(`INSERT INTO online_order_items (order_id, item_id, sku, title, qty, unit_price_cents) VALUES (?, ?, ?, ?, ?, ?)`);
        for (const line of prepared) {
          ins.run(info.lastInsertRowid, line.item.id, line.item.sku, line.item.title, line.qty, line.unit);
        }
        return info.lastInsertRowid;
      });
      const id = tx();
      storeWorkflows?.refreshAllBundleAvailability?.();
      res.json({ ok: true, online_order: serializeOnlineOrder(db.prepare(`SELECT * FROM online_orders WHERE id=?`).get(id)) });
    } catch (err) {
      respondError(res, err, "online_order_create_failed");
    }
  });

  app.put("/api/online-orders/:id/status", requireAuth, requirePerm("checkout"), (req, res) => {
    try {
      const order = db.prepare(`SELECT * FROM online_orders WHERE id=?`).get(Number(req.params.id));
      if (!order) return res.status(404).json({ ok: false, error: "online_order_not_found" });
      const next = clean(req.body?.status || order.status, 40);
      const lines = db.prepare(`SELECT * FROM online_order_items WHERE order_id=?`).all(order.id);
      const tx = db.transaction(() => {
        if (order.status !== "cancelled" && next === "cancelled") {
          for (const line of lines) restoreItem(line.item_id, line.qty, req.user.id, `Online order ${order.order_no}`, "online_order_cancelled");
        }
        if (order.status === "cancelled" && next !== "cancelled") {
          for (const line of lines) reserveItem(itemByRef({ item_id: line.item_id }), line.qty, req.user.id, `Online order ${order.order_no}`, "online_order_reserved");
        }
        db.prepare(`
          UPDATE online_orders
          SET status=?, tracking_number=COALESCE(NULLIF(?,''), tracking_number), updated_at=datetime('now')
          WHERE id=?
        `).run(next, clean(req.body?.tracking_number || req.body?.trackingNumber, 160), order.id);
      });
      tx();
      storeWorkflows?.refreshAllBundleAvailability?.();
      res.json({ ok: true, online_order: serializeOnlineOrder(db.prepare(`SELECT * FROM online_orders WHERE id=?`).get(order.id)) });
    } catch (err) {
      respondError(res, err, "online_order_status_failed");
    }
  });

  function parseDeckLine(rawLine) {
    const line = clean(rawLine, 240);
    if (!line) return null;
    const match = /^(\d+)\s*x?\s+(.+)$/i.exec(line);
    const qty = match ? Math.max(1, intVal(match[1], 1)) : 1;
    const title = clean(match ? match[2] : line, 240).replace(/\s+\[[^\]]+\]$/, "").replace(/\s+\([^)]+\)$/, "");
    return title ? { qty, title } : null;
  }

  app.get("/api/decklists", requireAuth, (_req, res) => {
    try {
      const rows = db.prepare(`SELECT * FROM decklists ORDER BY datetime(created_at) DESC, id DESC LIMIT 100`).all();
      res.json({ ok: true, rows });
    } catch (err) {
      respondError(res, err, "decklists_failed");
    }
  });

  app.post("/api/decklists/parse", requireAuth, (req, res) => {
    try {
      const body = req.body || {};
      const raw = clean(body.raw_text || body.rawText || body.decklist, 20000);
      if (!raw) return res.status(400).json({ ok: false, error: "missing_decklist" });
      const snap = customerSnapshot(body);
      const lines = raw.split(/\r?\n/).map(parseDeckLine).filter(Boolean);
      const tx = db.transaction(() => {
        const info = db.prepare(`
          INSERT INTO decklists (customer_id, customer_name, title, raw_text, user_id)
          VALUES (?, ?, ?, ?, ?)
        `).run(snap.customer_id, snap.customer_name, clean(body.title || "Decklist", 160), raw, req.user.id);
        const deckId = info.lastInsertRowid;
        const insertMatch = db.prepare(`
          INSERT INTO decklist_matches (decklist_id, item_id, sku, title, requested_qty, available_qty, price_cents)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const line of lines) {
          const search = `%${lower(line.title)}%`;
          const matches = db.prepare(`
            SELECT *
            FROM items
            WHERE deleted_at IS NULL AND COALESCE(qty,0) > 0 AND lower(title) LIKE ?
            ORDER BY qty DESC, price ASC
            LIMIT 5
          `).all(search);
          if (!matches.length) {
            insertMatch.run(deckId, null, null, line.title, line.qty, 0, 0);
          } else {
            for (const item of matches) insertMatch.run(deckId, item.id, item.sku, item.title, line.qty, Number(item.qty || 0), toCents(item.price));
          }
        }
        return deckId;
      });
      const deckId = tx();
      const matches = db.prepare(`SELECT * FROM decklist_matches WHERE decklist_id=? ORDER BY id ASC`).all(deckId)
        .map((row) => serializeMoney(row, [["price_cents", "price"]]));
      res.json({ ok: true, decklist: db.prepare(`SELECT * FROM decklists WHERE id=?`).get(deckId), matches });
    } catch (err) {
      respondError(res, err, "decklist_parse_failed");
    }
  });

  app.get("/api/decklists/:id", requireAuth, (req, res) => {
    try {
      const decklist = db.prepare(`SELECT * FROM decklists WHERE id=?`).get(Number(req.params.id));
      if (!decklist) return res.status(404).json({ ok: false, error: "decklist_not_found" });
      const matches = db.prepare(`SELECT * FROM decklist_matches WHERE decklist_id=? ORDER BY id ASC`).all(decklist.id)
        .map((row) => serializeMoney(row, [["price_cents", "price"]]));
      res.json({ ok: true, decklist, matches });
    } catch (err) {
      respondError(res, err, "decklist_failed");
    }
  });

  app.get("/api/customer-messages", requireAuth, (_req, res) => {
    try {
      const rows = db.prepare(`SELECT * FROM customer_messages ORDER BY datetime(created_at) DESC, id DESC LIMIT 200`).all();
      res.json({ ok: true, rows });
    } catch (err) {
      respondError(res, err, "messages_failed");
    }
  });

  app.post("/api/customer-messages", requireAuth, requireRole("clerk", "manager", "owner"), (req, res) => {
    try {
      const body = req.body || {};
      const snap = customerSnapshot(body);
      const info = db.prepare(`
        INSERT INTO customer_messages (customer_id, customer_name, channel, subject, body, status, source_type, source_id, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        snap.customer_id,
        snap.customer_name,
        clean(body.channel || "phone", 40),
        clean(body.subject, 240),
        clean(body.body, 2000),
        clean(body.status || "draft", 40),
        clean(body.source_type || body.sourceType, 80),
        clean(body.source_id || body.sourceId, 80),
        req.user.id
      );
      res.json({ ok: true, message: db.prepare(`SELECT * FROM customer_messages WHERE id=?`).get(info.lastInsertRowid) });
    } catch (err) {
      respondError(res, err, "message_create_failed");
    }
  });

  app.get("/api/customer-kiosk/search", requireAuth, (req, res) => {
    try {
      const q = lower(req.query.q || "");
      const rows = q ? db.prepare(`
        SELECT id, sku, title, platform, category, condition, qty, price
        FROM items
        WHERE deleted_at IS NULL AND COALESCE(qty,0) > 0
          AND lower(title || ' ' || COALESCE(platform,'') || ' ' || COALESCE(category,'') || ' ' || COALESCE(sku,'')) LIKE ?
        ORDER BY lower(title) ASC
        LIMIT 50
      `).all(`%${q}%`) : [];
      res.json({ ok: true, rows });
    } catch (err) {
      respondError(res, err, "kiosk_search_failed");
    }
  });

  return {};
}

module.exports = mountAdvancedWorkflowRoutes;
