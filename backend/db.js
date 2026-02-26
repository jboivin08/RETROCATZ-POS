const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = path.join(__dirname, "inventory.db");

function getTableColumns(db, table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all();
  } catch {
    return [];
  }
}

function tableExists(db, table) {
  try {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
    return !!row;
  } catch {
    return false;
  }
}

function columnExists(db, table, col) {
  const cols = getTableColumns(db, table);
  return cols.some((c) => c.name === col);
}

function ensureTable(db, sql) {
  db.prepare(sql).run();
}

function migrateUsersToIntegerIds(db) {
  if (!tableExists(db, "users")) return;

  const cols = getTableColumns(db, "users");
  const idCol = cols.find((c) => c.name === "id");
  const idType = (idCol?.type || "").toUpperCase();
  const idIsInteger = idType.includes("INT");
  if (idIsInteger) return;

  // Build new users table with INTEGER ids.
  db.exec(`
    CREATE TABLE IF NOT EXISTS users_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      pw_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner','manager','clerk','viewer')),
      active INTEGER NOT NULL DEFAULT 1,
      display_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const rows = db.prepare(`SELECT * FROM users ORDER BY rowid ASC`).all();
  const insert = db.prepare(`
    INSERT INTO users_new (username, pw_hash, role, active, display_name, created_at)
    VALUES (@username, @pw_hash, @role, @active, @display_name, @created_at)
  `);

  const map = new Map();
  for (const r of rows) {
    const username = r.username;
    const pw_hash = r.pw_hash || r.password_hash || "";
    const role = r.role || "manager";
    const active = (r.active === 0 || r.active === "0") ? 0 : 1;
    const display_name = r.display_name ?? null;
    const created_at = r.created_at || r.createdAt || new Date().toISOString();
    const info = insert.run({ username, pw_hash, role, active, display_name, created_at });
    map.set(String(r.id), info.lastInsertRowid);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_id_map (
      old_id TEXT PRIMARY KEY,
      new_id INTEGER NOT NULL
    );
    DELETE FROM user_id_map;
  `);
  const mapInsert = db.prepare(`INSERT INTO user_id_map (old_id, new_id) VALUES (?, ?)`);
  for (const [oldId, newId] of map.entries()) {
    mapInsert.run(oldId, newId);
  }

  db.exec(`
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
  `);
}

function migrateUserIdForeignKeys(db) {
  if (!tableExists(db, "user_id_map")) return;

  const mapJoin = `LEFT JOIN user_id_map m ON m.old_id = t.user_id`;

  if (tableExists(db, "sessions")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions_new (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
    db.exec(`
      INSERT INTO sessions_new (id, user_id, created_at, last_seen_at)
      SELECT t.id, COALESCE(m.new_id, CAST(t.user_id AS INTEGER)), t.created_at, t.last_seen_at
      FROM sessions t ${mapJoin};
      DROP TABLE sessions;
      ALTER TABLE sessions_new RENAME TO sessions;
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    `);
  }

  if (tableExists(db, "permissions")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS permissions_new (
        user_id INTEGER PRIMARY KEY,
        inv_add INTEGER NOT NULL DEFAULT 1,
        inv_edit INTEGER NOT NULL DEFAULT 1,
        inv_delete INTEGER NOT NULL DEFAULT 0,
        cost_change INTEGER NOT NULL DEFAULT 0,
        category_admin INTEGER NOT NULL DEFAULT 0,
        user_admin INTEGER NOT NULL DEFAULT 0,
        checkout INTEGER NOT NULL DEFAULT 1,
        reports INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
    db.exec(`
      INSERT INTO permissions_new
        (user_id, inv_add, inv_edit, inv_delete, cost_change, category_admin, user_admin, checkout, reports)
      SELECT COALESCE(m.new_id, CAST(t.user_id AS INTEGER)),
             t.inv_add, t.inv_edit, t.inv_delete, t.cost_change,
             t.category_admin, t.user_admin, t.checkout, t.reports
      FROM permissions t ${mapJoin};
      DROP TABLE permissions;
      ALTER TABLE permissions_new RENAME TO permissions;
    `);
  }

  if (tableExists(db, "sales")) {
    const cols = getTableColumns(db, "sales").map((c) => c.name);
    if (!cols.includes("created_at")) {
      // legacy sales table: migrate to new schema with INTEGER id
      db.exec(`
        CREATE TABLE IF NOT EXISTS sales_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('completed','voided')),
          subtotal REAL NOT NULL DEFAULT 0,
          tax REAL NOT NULL DEFAULT 0,
          total REAL NOT NULL DEFAULT 0,
          payment_method TEXT NOT NULL DEFAULT 'unknown',
          customer_id INTEGER,
          customer_type TEXT,
          customer_name TEXT,
          customer_phone TEXT,
          customer_ein TEXT,
          customer_tax_exempt INTEGER NOT NULL DEFAULT 0,
          user_id INTEGER,
          client_txn_uuid TEXT,
          FOREIGN KEY(user_id) REFERENCES users(id),
          FOREIGN KEY(customer_id) REFERENCES customers(id)
        );
      `);

      const legacySales = db.prepare(`SELECT * FROM sales ORDER BY rowid ASC`).all();
      const insertSale = db.prepare(`
        INSERT INTO sales_new
          (created_at, status, subtotal, tax, total, payment_method, customer_id, customer_type, customer_name, customer_phone, customer_ein, customer_tax_exempt, user_id, client_txn_uuid)
        VALUES
          (@created_at, @status, @subtotal, @tax, @total, @payment_method, @customer_id, @customer_type, @customer_name, @customer_phone, @customer_ein, @customer_tax_exempt, @user_id, @client_txn_uuid)
      `);

      const saleIdMap = new Map();
      for (const s of legacySales) {
        const created_at = s.ts || s.createdAt || new Date().toISOString();
        const status = (s.status && String(s.status).toLowerCase().includes("void")) ? "voided" : "completed";
        const subtotal = Number(s.subtotal || 0);
        const tax = Number(s.tax || 0);
        const total = Number(s.total || 0);
        const payment_method = s.tender_type || "unknown";
        const mappedUser =
          s.user ? db.prepare(`SELECT id FROM users WHERE username = ?`).get(String(s.user))?.id : null;
        const info = insertSale.run({
          created_at,
          status,
          subtotal,
          tax,
          total,
          payment_method,
          customer_id: null,
          customer_type: null,
          customer_name: null,
          customer_phone: null,
          customer_ein: null,
          customer_tax_exempt: 0,
          user_id: mappedUser,
          client_txn_uuid: String(s.id || "")
        });
        saleIdMap.set(String(s.id), info.lastInsertRowid);
      }

      if (tableExists(db, "sale_items")) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS sale_items_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sale_id INTEGER NOT NULL,
            item_id INTEGER,
            sku TEXT,
            title TEXT,
            unit_price REAL NOT NULL DEFAULT 0,
            qty INTEGER NOT NULL DEFAULT 1,
            taxable INTEGER NOT NULL DEFAULT 1,
            line_total REAL NOT NULL DEFAULT 0,
            FOREIGN KEY(sale_id) REFERENCES sales(id) ON DELETE CASCADE,
            FOREIGN KEY(item_id) REFERENCES items(id)
          );
        `);
        const legacyItems = db.prepare(`SELECT * FROM sale_items ORDER BY rowid ASC`).all();
        const insertItem = db.prepare(`
          INSERT INTO sale_items_new
            (sale_id, item_id, sku, title, unit_price, qty, taxable, line_total)
          VALUES
            (@sale_id, @item_id, @sku, @title, @unit_price, @qty, @taxable, @line_total)
        `);
        for (const si of legacyItems) {
          const newSaleId = saleIdMap.get(String(si.sale_id));
          if (!newSaleId) continue;
          const unit_price = Number(si.unit_price || si.price || 0);
          const qty = Number(si.qty || 1);
          const line_total = Number(si.line_subtotal || (unit_price * qty) || 0);
          insertItem.run({
            sale_id: newSaleId,
            item_id: null,
            sku: si.sku || "",
            title: si.title || "",
            unit_price,
            qty,
            taxable: 1,
            line_total
          });
        }
        db.exec(`DROP TABLE sale_items; ALTER TABLE sale_items_new RENAME TO sale_items;`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);`);
      }

      db.exec(`DROP TABLE sales; ALTER TABLE sales_new RENAME TO sales;`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);`);
    } else if (columnExists(db, "sales", "user_id")) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sales_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('completed','voided')),
          subtotal REAL NOT NULL DEFAULT 0,
          tax REAL NOT NULL DEFAULT 0,
          total REAL NOT NULL DEFAULT 0,
          payment_method TEXT NOT NULL DEFAULT 'unknown',
          customer_id INTEGER,
          customer_type TEXT,
          customer_name TEXT,
          customer_phone TEXT,
          customer_ein TEXT,
          customer_tax_exempt INTEGER NOT NULL DEFAULT 0,
          user_id INTEGER,
          client_txn_uuid TEXT,
          FOREIGN KEY(user_id) REFERENCES users(id),
          FOREIGN KEY(customer_id) REFERENCES customers(id)
        );
      `);
      db.exec(`
        INSERT INTO sales_new
          (id, created_at, status, subtotal, tax, total, payment_method, customer_id, customer_type, customer_name, customer_phone, customer_ein, customer_tax_exempt, user_id, client_txn_uuid)
        SELECT
          id, created_at, status, subtotal, tax, total, payment_method,
          NULL, NULL, NULL, NULL, NULL, 0,
          COALESCE(m.new_id, CAST(t.user_id AS INTEGER)), client_txn_uuid
        FROM sales t ${mapJoin};
        DROP TABLE sales;
        ALTER TABLE sales_new RENAME TO sales;
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);`);
    }
  }

  if (tableExists(db, "refunds")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS refunds_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        reason TEXT,
        user_id INTEGER,
        FOREIGN KEY(sale_id) REFERENCES sales(id) ON DELETE CASCADE,
        FOREIGN KEY(user_id) REFERENCES users(id)
      );
    `);
    db.exec(`
      INSERT INTO refunds_new (id, sale_id, created_at, reason, user_id)
      SELECT t.id, t.sale_id, t.created_at, t.reason,
             COALESCE(m.new_id, CAST(t.user_id AS INTEGER))
      FROM refunds t ${mapJoin};
      DROP TABLE refunds;
      ALTER TABLE refunds_new RENAME TO refunds;
      CREATE INDEX IF NOT EXISTS idx_refunds_sale ON refunds(sale_id);
    `);
  }
}

function migrateLegacySales(db) {
  if (!tableExists(db, "sales")) return;
  const cols = getTableColumns(db, "sales").map((c) => c.name);
  if (cols.includes("created_at")) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS sales_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('completed','voided')),
      subtotal REAL NOT NULL DEFAULT 0,
      tax REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      payment_method TEXT NOT NULL DEFAULT 'unknown',
      customer_id INTEGER,
      customer_type TEXT,
      customer_name TEXT,
      customer_phone TEXT,
      customer_ein TEXT,
      customer_tax_exempt INTEGER NOT NULL DEFAULT 0,
      user_id INTEGER,
      client_txn_uuid TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(customer_id) REFERENCES customers(id)
    );
  `);

  const legacySales = db.prepare(`SELECT * FROM sales ORDER BY rowid ASC`).all();
  const insertSale = db.prepare(`
    INSERT INTO sales_new
      (created_at, status, subtotal, tax, total, payment_method, customer_id, customer_type, customer_name, customer_phone, customer_ein, customer_tax_exempt, user_id, client_txn_uuid)
    VALUES
      (@created_at, @status, @subtotal, @tax, @total, @payment_method, @customer_id, @customer_type, @customer_name, @customer_phone, @customer_ein, @customer_tax_exempt, @user_id, @client_txn_uuid)
  `);

  const saleIdMap = new Map();
  for (const s of legacySales) {
    const created_at = s.ts || s.createdAt || new Date().toISOString();
    const status = (s.status && String(s.status).toLowerCase().includes("void")) ? "voided" : "completed";
    const subtotal = Number(s.subtotal || 0);
    const tax = Number(s.tax || 0);
    const total = Number(s.total || 0);
    const payment_method = s.tender_type || "unknown";
    const info = insertSale.run({
      created_at,
      status,
      subtotal,
      tax,
      total,
      payment_method,
      customer_id: null,
      customer_type: null,
      customer_name: null,
      customer_phone: null,
      customer_ein: null,
      customer_tax_exempt: 0,
      user_id: null,
      client_txn_uuid: String(s.id || "")
    });
    saleIdMap.set(String(s.id), info.lastInsertRowid);
  }

  if (tableExists(db, "sale_items")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sale_items_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id INTEGER NOT NULL,
        item_id INTEGER,
        sku TEXT,
        title TEXT,
        unit_price REAL NOT NULL DEFAULT 0,
        qty INTEGER NOT NULL DEFAULT 1,
        taxable INTEGER NOT NULL DEFAULT 1,
        line_total REAL NOT NULL DEFAULT 0,
        FOREIGN KEY(sale_id) REFERENCES sales(id) ON DELETE CASCADE,
        FOREIGN KEY(item_id) REFERENCES items(id)
      );
    `);
    const legacyItems = db.prepare(`SELECT * FROM sale_items ORDER BY rowid ASC`).all();
    const insertItem = db.prepare(`
      INSERT INTO sale_items_new
        (sale_id, item_id, sku, title, unit_price, qty, taxable, line_total)
      VALUES
        (@sale_id, @item_id, @sku, @title, @unit_price, @qty, @taxable, @line_total)
    `);
    for (const si of legacyItems) {
      const newSaleId = saleIdMap.get(String(si.sale_id));
      if (!newSaleId) continue;
      const unit_price = Number(si.unit_price || si.price || 0);
      const qty = Number(si.qty || 1);
      const line_total = Number(si.line_subtotal || (unit_price * qty) || 0);
      insertItem.run({
        sale_id: newSaleId,
        item_id: null,
        sku: si.sku || "",
        title: si.title || "",
        unit_price,
        qty,
        taxable: 1,
        line_total
      });
    }
    db.exec(`DROP TABLE sale_items; ALTER TABLE sale_items_new RENAME TO sale_items;`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);`);
  }

  db.exec(`DROP TABLE sales; ALTER TABLE sales_new RENAME TO sales;`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);`);
}

function ensureCoreSchema(db) {
  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      pw_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner','manager','clerk','viewer')),
      active INTEGER NOT NULL DEFAULT 1,
      display_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS permissions (
      user_id INTEGER PRIMARY KEY,
      inv_add INTEGER NOT NULL DEFAULT 1,
      inv_edit INTEGER NOT NULL DEFAULT 1,
      inv_delete INTEGER NOT NULL DEFAULT 0,
      cost_change INTEGER NOT NULL DEFAULT 0,
      category_admin INTEGER NOT NULL DEFAULT 0,
      user_admin INTEGER NOT NULL DEFAULT 0,
      checkout INTEGER NOT NULL DEFAULT 1,
      reports INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT UNIQUE,
      title TEXT,
      platform TEXT,
      category TEXT,
      condition TEXT,
      variant TEXT,
      qty INTEGER DEFAULT 1,
      cost REAL DEFAULT 0,
      price REAL DEFAULT 0,
      createdAt TEXT,
      barcode TEXT,
      source TEXT
    )
  `);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_items_sku ON items(sku);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('completed','voided')),
      subtotal REAL NOT NULL DEFAULT 0,
      tax REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      payment_method TEXT NOT NULL DEFAULT 'unknown',
      customer_id INTEGER,
      customer_type TEXT,
      customer_name TEXT,
      customer_phone TEXT,
      customer_ein TEXT,
      customer_tax_exempt INTEGER NOT NULL DEFAULT 0,
      user_id INTEGER,
      client_txn_uuid TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(customer_id) REFERENCES customers(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS sale_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id INTEGER NOT NULL,
      item_id INTEGER,
      sku TEXT,
      title TEXT,
      unit_price REAL NOT NULL DEFAULT 0,
      qty INTEGER NOT NULL DEFAULT 1,
      taxable INTEGER NOT NULL DEFAULT 1,
      line_total REAL NOT NULL DEFAULT 0,
      line_type TEXT NOT NULL DEFAULT 'item',
      FOREIGN KEY(sale_id) REFERENCES sales(id) ON DELETE CASCADE,
      FOREIGN KEY(item_id) REFERENCES items(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('regular','business')) DEFAULT 'regular',
      name TEXT NOT NULL,
      phone TEXT,
      phone2 TEXT,
      phone3 TEXT,
      email TEXT,
      email2 TEXT,
      email3 TEXT,
      ein TEXT,
      tax_exempt INTEGER NOT NULL DEFAULT 0,
      tax_exempt_expires_at TEXT,
      tags TEXT,
      store_credit_cents INTEGER NOT NULL DEFAULT 0,
      flagged INTEGER NOT NULL DEFAULT 0,
      flag_reason TEXT,
      notes TEXT,
      address1 TEXT,
      address2 TEXT,
      city TEXT,
      state TEXT,
      zip TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_customers_ein ON customers(ein);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS customer_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER,
      FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_customer_notes_customer ON customer_notes(customer_id);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS customer_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      amount_cents INTEGER NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER,
      FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_customer_adj_customer ON customer_adjustments(customer_id);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS refunds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      reason TEXT,
      user_id INTEGER,
      FOREIGN KEY(sale_id) REFERENCES sales(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_refunds_sale ON refunds(sale_id);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS refund_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      refund_id INTEGER NOT NULL,
      sale_item_id INTEGER NOT NULL,
      qty_refunded INTEGER NOT NULL DEFAULT 1,
      unit_price REAL NOT NULL DEFAULT 0,
      line_total REAL NOT NULL DEFAULT 0,
      FOREIGN KEY(refund_id) REFERENCES refunds(id) ON DELETE CASCADE,
      FOREIGN KEY(sale_item_id) REFERENCES sale_items(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_refund_items_refund ON refund_items(refund_id);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS inventory_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      item_id INTEGER,
      sku TEXT,
      qty_delta INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      sale_id INTEGER,
      refund_id INTEGER,
      user_id INTEGER,
      note TEXT,
      FOREIGN KEY(item_id) REFERENCES items(id),
      FOREIGN KEY(sale_id) REFERENCES sales(id),
      FOREIGN KEY(refund_id) REFERENCES refunds(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_inv_mov_item ON inventory_movements(item_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_inv_mov_sale ON inventory_movements(sale_id);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS sale_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      action TEXT NOT NULL,
      user_id INTEGER,
      metadata TEXT,
      FOREIGN KEY(sale_id) REFERENCES sales(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sale_events_sale ON sale_events(sale_id);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS user_activity (
      id TEXT PRIMARY KEY,
      userId TEXT,
      username TEXT,
      action TEXT,
      screen TEXT,
      metadata TEXT,
      createdAt TEXT
    )
  `);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS ai_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      mode TEXT DEFAULT 'lab',
      chattiness TEXT DEFAULT 'normal',
      lastInternalRun TEXT,
      lastMarketRun TEXT,
      lastTrendRun TEXT
    )
  `);
  db.prepare(`
    INSERT OR IGNORE INTO ai_settings (id, mode, chattiness)
    VALUES (1, 'lab', 'normal')
  `).run();

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS ai_messages (
      id TEXT PRIMARY KEY,
      createdAt TEXT,
      severity TEXT,
      source TEXT,
      title TEXT,
      body TEXT,
      isRead INTEGER DEFAULT 0
    )
  `);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS waste_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      itemId INTEGER,
      sku TEXT,
      title TEXT,
      platform TEXT,
      category TEXT,
      condition TEXT,
      qty INTEGER,
      costPerUnit REAL,
      pricePerUnit REAL,
      totalCost REAL,
      totalPrice REAL,
      reason TEXT,
      notes TEXT,
      createdAt TEXT
    )
  `);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS deleted_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      itemId INTEGER,
      sku TEXT,
      title TEXT,
      platform TEXT,
      category TEXT,
      condition TEXT,
      qty INTEGER,
      cost REAL,
      price REAL,
      totalCost REAL,
      totalPrice REAL,
      reason TEXT,
      deletedBy TEXT,
      deletedAt TEXT
    )
  `);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS channel_sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      channel TEXT NOT NULL,
      action TEXT NOT NULL,
      sku TEXT,
      ok INTEGER NOT NULL DEFAULT 0,
      message TEXT
    )
  `);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expense_date TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('inventory','operating')) DEFAULT 'operating',
      category TEXT,
      vendor TEXT,
      memo TEXT,
      amount REAL NOT NULL DEFAULT 0,
      tax_amount REAL NOT NULL DEFAULT 0,
      payment_method TEXT,
      receipt_path TEXT,
      source TEXT,
      item_id INTEGER,
      sku TEXT,
      title TEXT,
      qty INTEGER,
      unit_cost REAL,
      user_id INTEGER,
      FOREIGN KEY(item_id) REFERENCES items(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_expenses_type ON expenses(type);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS tax_filings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      amount_due REAL NOT NULL DEFAULT 0,
      amount_paid REAL NOT NULL DEFAULT 0,
      filed_at TEXT,
      notes TEXT,
      user_id INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  // -------------------------------------------------------------------------
  // Trade-in quotes + settings
  // -------------------------------------------------------------------------
  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS trade_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      quote_expiry_days INTEGER NOT NULL DEFAULT 30,
      approval_cash_limit_cents INTEGER NOT NULL DEFAULT 20000,
      approval_credit_limit_cents INTEGER NOT NULL DEFAULT 30000,
      ebay_sold_enabled INTEGER NOT NULL DEFAULT 1,
      ebay_active_enabled INTEGER NOT NULL DEFAULT 1,
      ebay_country TEXT NOT NULL DEFAULT 'US'
    )
  `);
  db.prepare(`
    INSERT OR IGNORE INTO trade_settings (id, quote_expiry_days, approval_cash_limit_cents, approval_credit_limit_cents)
    VALUES (1, 30, 20000, 30000)
  `).run();

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS trade_user_settings (
      user_id INTEGER PRIMARY KEY,
      approval_cash_limit_cents INTEGER,
      approval_credit_limit_cents INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS trade_quotes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quote_id TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft','presented','accepted','declined','expired')) DEFAULT 'draft',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT,
      customer_id INTEGER,
      customer_name TEXT,
      customer_phone TEXT,
      customer_email TEXT,
      customer_notes TEXT,
      policy_credit_percent REAL NOT NULL DEFAULT 50,
      policy_cash_percent REAL NOT NULL DEFAULT 80,
      approval_cash_limit_cents INTEGER,
      approval_credit_limit_cents INTEGER,
      requires_approval INTEGER NOT NULL DEFAULT 0,
      approved_by INTEGER,
      approved_at TEXT,
      total_items INTEGER NOT NULL DEFAULT 0,
      total_cash REAL NOT NULL DEFAULT 0,
      total_credit REAL NOT NULL DEFAULT 0,
      total_retail REAL NOT NULL DEFAULT 0,
      notes TEXT,
      FOREIGN KEY(customer_id) REFERENCES customers(id),
      FOREIGN KEY(approved_by) REFERENCES users(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_trade_quotes_created ON trade_quotes(created_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_trade_quotes_status ON trade_quotes(status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_trade_quotes_customer ON trade_quotes(customer_id);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS trade_quote_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quote_id TEXT NOT NULL,
      line_no INTEGER NOT NULL DEFAULT 0,
      sku TEXT,
      barcode TEXT,
      title TEXT,
      platform TEXT,
      category TEXT,
      condition TEXT,
      qty INTEGER NOT NULL DEFAULT 1,
      retail_price REAL NOT NULL DEFAULT 0,
      credit_offer REAL NOT NULL DEFAULT 0,
      cash_offer REAL NOT NULL DEFAULT 0,
      reason TEXT,
      comps_json TEXT,
      keep INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(quote_id) REFERENCES trade_quotes(quote_id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_trade_items_quote ON trade_quote_items(quote_id);`);
}

function ensurePermissionsForAllUsers(db) {
  if (!tableExists(db, "permissions")) return;
  const users = db.prepare(`SELECT id FROM users`).all();
  const ins = db.prepare(`INSERT OR IGNORE INTO permissions (user_id) VALUES (?)`);
  for (const u of users) ins.run(u.id);
}

function ensureUserColumns(db) {
  if (!tableExists(db, "users")) return;
  if (!columnExists(db, "users", "pw_hash")) {
    db.prepare(`ALTER TABLE users ADD COLUMN pw_hash TEXT`).run();
  }
  if (columnExists(db, "users", "password_hash")) {
    db.prepare(`UPDATE users SET pw_hash = COALESCE(NULLIF(pw_hash,''), password_hash)`).run();
  }
  if (!columnExists(db, "users", "role")) {
    db.prepare(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'manager'`).run();
  }
  if (!columnExists(db, "users", "active")) {
    db.prepare(`ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1`).run();
  }
  if (!columnExists(db, "users", "display_name")) {
    db.prepare(`ALTER TABLE users ADD COLUMN display_name TEXT`).run();
  }
  if (!columnExists(db, "users", "created_at")) {
    db.prepare(`ALTER TABLE users ADD COLUMN created_at TEXT`).run();
  }
  if (columnExists(db, "users", "createdAt")) {
    db.prepare(`UPDATE users SET created_at = COALESCE(NULLIF(created_at,''), createdAt)`).run();
  }
}

function ensureItemColumns(db) {
  if (!tableExists(db, "items")) return;
  const add = (name, sqlType) => {
    if (!columnExists(db, "items", name)) {
      db.prepare(`ALTER TABLE items ADD COLUMN ${name} ${sqlType}`).run();
    }
  };
  add("category", "TEXT");
  add("variant", "TEXT");
  add("createdAt", "TEXT");
  add("barcode", "TEXT");
  add("source", "TEXT");
  add("photo_paths", "TEXT");
  add("wix_product_id", "TEXT");
  add("wix_media_ids", "TEXT");
}

function ensureSaleItemColumns(db) {
  if (!tableExists(db, "sale_items")) return;
  if (!columnExists(db, "sale_items", "line_type")) {
    db.prepare(`ALTER TABLE sale_items ADD COLUMN line_type TEXT DEFAULT 'item'`).run();
  }
}

function ensureSaleColumns(db) {
  if (!tableExists(db, "sales")) return;
  const add = (name, sqlType) => {
    if (!columnExists(db, "sales", name)) {
      db.prepare(`ALTER TABLE sales ADD COLUMN ${name} ${sqlType}`).run();
    }
  };
  add("customer_id", "INTEGER");
  add("customer_type", "TEXT");
  add("customer_name", "TEXT");
  add("customer_phone", "TEXT");
  add("customer_ein", "TEXT");
  add("customer_tax_exempt", "INTEGER NOT NULL DEFAULT 0");
}

function ensureCustomerColumns(db) {
  if (!tableExists(db, "customers")) return;
  const add = (name, sqlType) => {
    if (!columnExists(db, "customers", name)) {
      db.prepare(`ALTER TABLE customers ADD COLUMN ${name} ${sqlType}`).run();
    }
  };
  add("type", "TEXT DEFAULT 'regular'");
  add("name", "TEXT");
  add("phone", "TEXT");
  add("phone2", "TEXT");
  add("phone3", "TEXT");
  add("email", "TEXT");
  add("email2", "TEXT");
  add("email3", "TEXT");
  add("ein", "TEXT");
  add("tax_exempt", "INTEGER NOT NULL DEFAULT 0");
  add("tax_exempt_expires_at", "TEXT");
  add("tags", "TEXT");
  add("store_credit_cents", "INTEGER NOT NULL DEFAULT 0");
  add("flagged", "INTEGER NOT NULL DEFAULT 0");
  add("flag_reason", "TEXT");
  add("notes", "TEXT");
  add("address1", "TEXT");
  add("address2", "TEXT");
  add("city", "TEXT");
  add("state", "TEXT");
  add("zip", "TEXT");
  add("active", "INTEGER NOT NULL DEFAULT 1");
  add("created_at", "TEXT");
  add("updated_at", "TEXT");
}

function initDb() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  migrateUsersToIntegerIds(db);
  migrateUserIdForeignKeys(db);
  migrateLegacySales(db);
  ensureCoreSchema(db);
  ensureUserColumns(db);
  ensureItemColumns(db);
  ensureSaleItemColumns(db);
  ensureSaleColumns(db);
  ensureCustomerColumns(db);
  ensurePermissionsForAllUsers(db);

  return db;
}

module.exports = { initDb, DB_PATH };
