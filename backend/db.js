const path = require("path");
const fs = require("fs");
const os = require("os");
const Database = require("better-sqlite3");

const LEGACY_DB_PATH = path.join(__dirname, "inventory.db");
const APP_DATA_DIR_NAME = "vaultcore-pos";
const DEFAULT_CATEGORIES = ["Games", "Consoles", "Accessories", "Apparel", "Music", "Movies", "Other"];

function copyIfExists(src, dest) {
  if (!fs.existsSync(src) || fs.existsSync(dest)) return;
  fs.copyFileSync(src, dest);
}

function getDefaultDataDir() {
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, APP_DATA_DIR_NAME);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", APP_DATA_DIR_NAME);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), APP_DATA_DIR_NAME);
}

function resolveDbPath() {
  const dataDir = process.env.RETROCATZ_POS_DATA_DIR || getDefaultDataDir();

  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "inventory.db");

  if (!fs.existsSync(dbPath) && fs.existsSync(LEGACY_DB_PATH)) {
    try {
      copyIfExists(LEGACY_DB_PATH, dbPath);
      copyIfExists(`${LEGACY_DB_PATH}-wal`, `${dbPath}-wal`);
      copyIfExists(`${LEGACY_DB_PATH}-shm`, `${dbPath}-shm`);
    } catch (err) {
      console.warn("[DB] Could not migrate legacy DB into app data:", err.message);
    }
  }

  return dbPath;
}

const DB_PATH = resolveDbPath();

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
      pin_hash TEXT,
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
      discount_override INTEGER NOT NULL DEFAULT 0,
      void_refund INTEGER NOT NULL DEFAULT 0,
      settings_admin INTEGER NOT NULL DEFAULT 0,
      closeout_admin INTEGER NOT NULL DEFAULT 0,
      tax_admin INTEGER NOT NULL DEFAULT 0,
      sync_admin INTEGER NOT NULL DEFAULT 0,
      store_credit INTEGER NOT NULL DEFAULT 0,
      trade_override INTEGER NOT NULL DEFAULT 0,
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
      source TEXT,
      photo_paths TEXT,
      wix_product_id TEXT,
      wix_media_ids TEXT,
      deleted_at TEXT,
      deleted_reason TEXT
    )
  `);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_items_sku ON items(sku);`);
  if (columnExists(db, "items", "deleted_at")) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_items_deleted_at ON items(deleted_at);`);
  }

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
      loyalty_points INTEGER NOT NULL DEFAULT 0,
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
    CREATE TABLE IF NOT EXISTS inventory_quantities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'sellable',
      location TEXT NOT NULL DEFAULT 'store',
      qty INTEGER NOT NULL DEFAULT 0 CHECK(qty >= 0),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE,
      UNIQUE(item_id, status, location)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_inv_qty_item ON inventory_quantities(item_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_inv_qty_status_location ON inventory_quantities(status, location);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS inventory_bucket_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      item_id INTEGER NOT NULL,
      sku TEXT,
      qty INTEGER NOT NULL DEFAULT 0,
      from_status TEXT,
      from_location TEXT,
      to_status TEXT,
      to_location TEXT,
      reason TEXT,
      user_id INTEGER,
      note TEXT,
      FOREIGN KEY(item_id) REFERENCES items(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_inv_bucket_mov_item ON inventory_bucket_movements(item_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_inv_bucket_mov_created ON inventory_bucket_movements(created_at);`);

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
    CREATE TABLE IF NOT EXISTS held_sales (
      id TEXT PRIMARY KEY,
      label TEXT,
      payload_json TEXT NOT NULL,
      user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_held_sales_updated ON held_sales(updated_at);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS wishlist_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER,
      customer_name TEXT,
      customer_phone TEXT,
      customer_email TEXT,
      title TEXT NOT NULL,
      platform TEXT,
      category TEXT,
      condition_pref TEXT,
      max_price_cents INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      notes TEXT,
      matched_item_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      fulfilled_at TEXT,
      user_id INTEGER,
      FOREIGN KEY(customer_id) REFERENCES customers(id),
      FOREIGN KEY(matched_item_id) REFERENCES items(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wishlist_status ON wishlist_requests(status, updated_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wishlist_customer ON wishlist_requests(customer_id);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS layaways (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER,
      customer_name TEXT,
      customer_phone TEXT,
      label TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      total_cents INTEGER NOT NULL DEFAULT 0,
      deposit_cents INTEGER NOT NULL DEFAULT 0,
      paid_cents INTEGER NOT NULL DEFAULT 0,
      due_at TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      cancelled_at TEXT,
      user_id INTEGER,
      FOREIGN KEY(customer_id) REFERENCES customers(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_layaways_status_due ON layaways(status, due_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_layaways_customer ON layaways(customer_id);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS layaway_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      layaway_id INTEGER NOT NULL,
      item_id INTEGER,
      sku TEXT,
      title TEXT,
      qty INTEGER NOT NULL DEFAULT 1,
      unit_price_cents INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(layaway_id) REFERENCES layaways(id) ON DELETE CASCADE,
      FOREIGN KEY(item_id) REFERENCES items(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_layaway_items_layaway ON layaway_items(layaway_id);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS layaway_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      layaway_id INTEGER NOT NULL,
      amount_cents INTEGER NOT NULL,
      method TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER,
      FOREIGN KEY(layaway_id) REFERENCES layaways(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_layaway_payments_layaway ON layaway_payments(layaway_id);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS preorders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER,
      customer_name TEXT,
      customer_phone TEXT,
      title TEXT NOT NULL,
      platform TEXT,
      qty INTEGER NOT NULL DEFAULT 1,
      expected_price_cents INTEGER NOT NULL DEFAULT 0,
      deposit_cents INTEGER NOT NULL DEFAULT 0,
      release_at TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      notes TEXT,
      matched_item_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      fulfilled_at TEXT,
      user_id INTEGER,
      FOREIGN KEY(customer_id) REFERENCES customers(id),
      FOREIGN KEY(matched_item_id) REFERENCES items(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_preorders_status_release ON preorders(status, release_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_preorders_customer ON preorders(customer_id);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS repair_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_no TEXT UNIQUE,
      customer_id INTEGER,
      customer_name TEXT,
      customer_phone TEXT,
      device TEXT NOT NULL,
      issue TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'intake',
      estimate_cents INTEGER NOT NULL DEFAULT 0,
      deposit_cents INTEGER NOT NULL DEFAULT 0,
      parts_cents INTEGER NOT NULL DEFAULT 0,
      labor_cents INTEGER NOT NULL DEFAULT 0,
      due_at TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT,
      user_id INTEGER,
      FOREIGN KEY(customer_id) REFERENCES customers(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_repair_status_due ON repair_tickets(status, due_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_repair_customer ON repair_tickets(customer_id);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS loyalty_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      sale_id INTEGER,
      points_delta INTEGER NOT NULL,
      reason TEXT,
      amount_cents INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER,
      FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY(sale_id) REFERENCES sales(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_loyalty_customer ON loyalty_transactions(customer_id, created_at);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS bundles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT UNIQUE,
      title TEXT NOT NULL,
      price_cents INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      available INTEGER NOT NULL DEFAULT 0,
      bundle_item_id INTEGER,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      sold_at TEXT,
      user_id INTEGER,
      FOREIGN KEY(bundle_item_id) REFERENCES items(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bundles_status_available ON bundles(status, available);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS bundle_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bundle_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      sku TEXT,
      title TEXT,
      qty INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(bundle_id) REFERENCES bundles(id) ON DELETE CASCADE,
      FOREIGN KEY(item_id) REFERENCES items(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bundle_items_bundle ON bundle_items(bundle_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bundle_items_item ON bundle_items(item_id);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS live_events (
      id TEXT PRIMARY KEY,
      name TEXT,
      channel TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      payload_json TEXT NOT NULL,
      backend_sale_id INTEGER,
      user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      finalized_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(backend_sale_id) REFERENCES sales(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_live_events_status_updated ON live_events(status, updated_at);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS community_events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      game TEXT,
      event_type TEXT,
      status TEXT NOT NULL DEFAULT 'scheduled',
      starts_at TEXT,
      ends_at TEXT,
      capacity INTEGER NOT NULL DEFAULT 0,
      entry_fee_cents INTEGER NOT NULL DEFAULT 0,
      prize_pool_cents INTEGER NOT NULL DEFAULT 0,
      prize_notes TEXT,
      description TEXT,
      created_by INTEGER,
      updated_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      FOREIGN KEY(created_by) REFERENCES users(id),
      FOREIGN KEY(updated_by) REFERENCES users(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_community_events_status_start ON community_events(status, starts_at);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS community_event_attendees (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      customer_id INTEGER,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      status TEXT NOT NULL DEFAULT 'reserved',
      paid INTEGER NOT NULL DEFAULT 0,
      entry_fee_cents INTEGER NOT NULL DEFAULT 0,
      payment_method TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      checked_in_at TEXT,
      FOREIGN KEY(event_id) REFERENCES community_events(id) ON DELETE CASCADE,
      FOREIGN KEY(customer_id) REFERENCES customers(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_community_event_attendees_event ON community_event_attendees(event_id, status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_community_event_attendees_customer ON community_event_attendees(customer_id);`);

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
    CREATE TABLE IF NOT EXISTS pos_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      owner_locked INTEGER NOT NULL DEFAULT 0,
      updated_by INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(updated_by) REFERENCES users(id)
    )
  `);
  db.prepare(`
    INSERT OR IGNORE INTO pos_settings (key, value, owner_locked, updated_at)
    VALUES ('tax_rate', '0.07', 0, datetime('now'))
  `).run();
  db.prepare(`
    INSERT OR IGNORE INTO pos_settings (key, value, owner_locked, updated_at)
    VALUES ('require_pin_for_price_override', '1', 0, datetime('now'))
  `).run();
  db.prepare(`
    INSERT OR IGNORE INTO pos_settings (key, value, owner_locked, updated_at)
    VALUES ('require_pin_for_discounts', '1', 0, datetime('now'))
  `).run();
  const defaultPosSettings = {
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
    inventory_locations: JSON.stringify([{ key: "store", label: "Store" }]),
    tax_label: "Sales Tax",
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
  const insertPosSetting = db.prepare(`
    INSERT OR IGNORE INTO pos_settings (key, value, owner_locked, updated_at)
    VALUES (@key, @value, 0, datetime('now'))
  `);
  for (const [key, value] of Object.entries(defaultPosSettings)) {
    insertPosSetting.run({ key, value });
  }

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
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tax_filings_period ON tax_filings(period_start, period_end);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS register_closeouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_date TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft','closed')) DEFAULT 'draft',
      opened_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT,
      opened_by INTEGER,
      closed_by INTEGER,
      opening_cash_cents INTEGER NOT NULL DEFAULT 0,
      paid_in_cents INTEGER NOT NULL DEFAULT 0,
      paid_out_cents INTEGER NOT NULL DEFAULT 0,
      cash_sales_cents INTEGER NOT NULL DEFAULT 0,
      cash_refunds_cents INTEGER NOT NULL DEFAULT 0,
      card_sales_cents INTEGER NOT NULL DEFAULT 0,
      store_credit_sales_cents INTEGER NOT NULL DEFAULT 0,
      other_sales_cents INTEGER NOT NULL DEFAULT 0,
      total_sales_cents INTEGER NOT NULL DEFAULT 0,
      total_refunds_cents INTEGER NOT NULL DEFAULT 0,
      net_sales_cents INTEGER NOT NULL DEFAULT 0,
      expected_cash_cents INTEGER NOT NULL DEFAULT 0,
      counted_cash_cents INTEGER NOT NULL DEFAULT 0,
      variance_cents INTEGER NOT NULL DEFAULT 0,
      transaction_count INTEGER NOT NULL DEFAULT 0,
      item_count INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(opened_by) REFERENCES users(id),
      FOREIGN KEY(closed_by) REFERENCES users(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_register_closeouts_date ON register_closeouts(business_date);`);

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
      ebay_country TEXT NOT NULL DEFAULT 'US',
      require_customer INTEGER NOT NULL DEFAULT 0,
      require_seller_id INTEGER NOT NULL DEFAULT 0,
      require_agreement INTEGER NOT NULL DEFAULT 1,
      default_hold_days INTEGER NOT NULL DEFAULT 0,
      testing_queue_enabled INTEGER NOT NULL DEFAULT 1,
      auto_label_on_complete INTEGER NOT NULL DEFAULT 1,
      default_credit_percent REAL NOT NULL DEFAULT 50,
      default_cash_percent REAL NOT NULL DEFAULT 80,
      margin_floor_percent REAL NOT NULL DEFAULT 45,
      offer_basis TEXT NOT NULL DEFAULT 'sold_median',
      promo_active INTEGER NOT NULL DEFAULT 0,
      promo_label TEXT NOT NULL DEFAULT '',
      promo_credit_bonus_percent REAL NOT NULL DEFAULT 0
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
      payout_method TEXT,
      payout_amount_cents INTEGER NOT NULL DEFAULT 0,
      inventory_posted INTEGER NOT NULL DEFAULT 0,
      inventory_posted_at TEXT,
      completed_at TEXT,
      seller_id_type TEXT,
      seller_id_last4 TEXT,
      seller_dob TEXT,
      seller_address1 TEXT,
      seller_city TEXT,
      seller_state TEXT,
      seller_zip TEXT,
      agreement_signed INTEGER NOT NULL DEFAULT 0,
      intake_checklist_json TEXT,
      completion_checklist_json TEXT,
      promo_label TEXT,
      promo_credit_bonus_percent REAL NOT NULL DEFAULT 0,
      hold_until TEXT,
      suggested_cash REAL NOT NULL DEFAULT 0,
      suggested_credit REAL NOT NULL DEFAULT 0,
      final_cash_offer REAL NOT NULL DEFAULT 0,
      final_credit_offer REAL NOT NULL DEFAULT 0,
      offer_override_reason TEXT,
      offer_override_requires_approval INTEGER NOT NULL DEFAULT 0,
      offer_override_approved_by INTEGER,
      offer_override_approved_at TEXT,
      intake_created_at TEXT,
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
      completeness TEXT NOT NULL DEFAULT 'loose',
      qty INTEGER NOT NULL DEFAULT 1,
      retail_price REAL NOT NULL DEFAULT 0,
      credit_offer REAL NOT NULL DEFAULT 0,
      cash_offer REAL NOT NULL DEFAULT 0,
      allocated_cost REAL NOT NULL DEFAULT 0,
      allocated_total_cost REAL NOT NULL DEFAULT 0,
      reason TEXT,
      pass_reason TEXT,
      condition_notes TEXT,
      accessories_json TEXT,
      inventory_action TEXT NOT NULL DEFAULT 'merge',
      post_status TEXT NOT NULL DEFAULT 'testing',
      hold_until TEXT,
      label_needed INTEGER NOT NULL DEFAULT 1,
      test_needed INTEGER NOT NULL DEFAULT 1,
      pricing_basis TEXT,
      offer_reason TEXT,
      comps_json TEXT,
      keep INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(quote_id) REFERENCES trade_quotes(quote_id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_trade_items_quote ON trade_quote_items(quote_id);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS trade_intake_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quote_id TEXT NOT NULL,
      quote_item_id INTEGER,
      item_id INTEGER,
      sku TEXT,
      task_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      title TEXT,
      platform TEXT,
      category TEXT,
      condition TEXT,
      completeness TEXT,
      qty INTEGER NOT NULL DEFAULT 1,
      retail_price REAL NOT NULL DEFAULT 0,
      allocated_cost REAL NOT NULL DEFAULT 0,
      allocated_total_cost REAL NOT NULL DEFAULT 0,
      inventory_action TEXT,
      post_status TEXT,
      due_at TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      user_id INTEGER,
      FOREIGN KEY(quote_id) REFERENCES trade_quotes(quote_id) ON DELETE CASCADE,
      FOREIGN KEY(quote_item_id) REFERENCES trade_quote_items(id) ON DELETE SET NULL,
      FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE SET NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_trade_tasks_status ON trade_intake_tasks(status, task_type);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_trade_tasks_quote ON trade_intake_tasks(quote_id);`);
}

function ensurePermissionsForAllUsers(db) {
  if (!tableExists(db, "permissions")) return;
  const users = db.prepare(`SELECT id FROM users`).all();
  const ins = db.prepare(`INSERT OR IGNORE INTO permissions (user_id) VALUES (?)`);
  for (const u of users) ins.run(u.id);
}

function normalizeUserRoles(db) {
  if (!tableExists(db, "users") || !columnExists(db, "users", "role")) return;

  // Legacy compatibility: "admin" role is equivalent to owner in this POS.
  db.prepare(`
    UPDATE users
    SET role = 'owner'
    WHERE lower(trim(role)) = 'admin'
  `).run();

  // Keep role values canonical/lowercase for consistent auth checks.
  db.prepare(`
    UPDATE users
    SET role = lower(trim(role))
    WHERE role IS NOT NULL
  `).run();
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
  if (!columnExists(db, "users", "pin_hash")) {
    db.prepare(`ALTER TABLE users ADD COLUMN pin_hash TEXT`).run();
  }
  if (!columnExists(db, "users", "created_at")) {
    db.prepare(`ALTER TABLE users ADD COLUMN created_at TEXT`).run();
  }
  if (columnExists(db, "users", "createdAt")) {
    db.prepare(`UPDATE users SET created_at = COALESCE(NULLIF(created_at,''), createdAt)`).run();
  }
}

function ensurePermissionColumns(db) {
  if (!tableExists(db, "permissions")) return;
  let addedAny = false;
  const add = (name, sqlType) => {
    if (!columnExists(db, "permissions", name)) {
      db.prepare(`ALTER TABLE permissions ADD COLUMN ${name} ${sqlType}`).run();
      addedAny = true;
    }
  };

  add("discount_override", "INTEGER NOT NULL DEFAULT 0");
  add("void_refund", "INTEGER NOT NULL DEFAULT 0");
  add("settings_admin", "INTEGER NOT NULL DEFAULT 0");
  add("closeout_admin", "INTEGER NOT NULL DEFAULT 0");
  add("tax_admin", "INTEGER NOT NULL DEFAULT 0");
  add("sync_admin", "INTEGER NOT NULL DEFAULT 0");
  add("store_credit", "INTEGER NOT NULL DEFAULT 0");
  add("trade_override", "INTEGER NOT NULL DEFAULT 0");

  // Owners always keep full authority.
  db.prepare(`
    UPDATE permissions
    SET inv_add=1, inv_edit=1, inv_delete=1, cost_change=1,
        category_admin=1, user_admin=1, checkout=1, reports=1,
        discount_override=1, void_refund=1, settings_admin=1,
        closeout_admin=1, tax_admin=1, sync_admin=1, store_credit=1,
        trade_override=1
    WHERE user_id IN (SELECT id FROM users WHERE role='owner')
  `).run();

  if (addedAny) {
    db.prepare(`
      UPDATE permissions
      SET discount_override=1, void_refund=1, settings_admin=1,
          closeout_admin=1, tax_admin=1, sync_admin=1, store_credit=1,
          trade_override=1
      WHERE user_id IN (SELECT id FROM users WHERE role='manager')
    `).run();
  }
}

function categoryKey(name) {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function ensureCategories(db) {
  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_categories_active_sort ON categories(active, sort_order, name);`);

  const existingCount = db.prepare(`SELECT COUNT(*) AS c FROM categories`).get()?.c || 0;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO categories (name, name_key, sort_order, active)
    VALUES (@name, @name_key, @sort_order, 1)
  `);
  DEFAULT_CATEGORIES.forEach((name, idx) => {
    insert.run({ name, name_key: categoryKey(name), sort_order: idx });
  });

  if (existingCount === 0 && tableExists(db, "items") && columnExists(db, "items", "category")) {
    const rows = db.prepare(`
      SELECT DISTINCT trim(category) AS name
      FROM items
      WHERE category IS NOT NULL AND trim(category) <> ''
      ORDER BY lower(trim(category))
    `).all();
    rows.forEach((row, idx) => {
      const name = String(row.name || "").trim();
      if (name) insert.run({ name, name_key: categoryKey(name), sort_order: DEFAULT_CATEGORIES.length + idx });
    });
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
  add("deleted_at", "TEXT");
  add("deleted_reason", "TEXT");
  db.exec(`CREATE INDEX IF NOT EXISTS idx_items_deleted_at ON items(deleted_at);`);
}

function ensureInventoryQuantityBackfill(db) {
  if (!tableExists(db, "items") || !tableExists(db, "inventory_quantities")) return;
  const activeFilter = columnExists(db, "items", "deleted_at") ? "AND i.deleted_at IS NULL" : "";
  db.exec(`
    INSERT INTO inventory_quantities (item_id, status, location, qty, updated_at)
    SELECT i.id, 'sellable', 'store',
           CASE WHEN COALESCE(i.qty, 0) > 0 THEN COALESCE(i.qty, 0) ELSE 0 END,
           datetime('now')
    FROM items i
    WHERE COALESCE(i.qty, 0) > 0
      ${activeFilter}
      AND NOT EXISTS (
        SELECT 1 FROM inventory_quantities iq WHERE iq.item_id = i.id
      )
  `);
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
  add("client_txn_uuid", "TEXT");
}

function ensureSalesClientTxnUuidIndex(db) {
  if (!tableExists(db, "sales") || !columnExists(db, "sales", "client_txn_uuid")) return;

  const duplicates = db.prepare(`
    SELECT client_txn_uuid
    FROM sales
    WHERE client_txn_uuid IS NOT NULL AND trim(client_txn_uuid) <> ''
    GROUP BY client_txn_uuid
    HAVING COUNT(*) > 1
  `).all();

  for (const dup of duplicates) {
    const uuid = String(dup.client_txn_uuid || "");
    const rows = db.prepare(`
      SELECT id
      FROM sales
      WHERE client_txn_uuid = ?
      ORDER BY id ASC
    `).all(uuid);
    for (const row of rows.slice(1)) {
      db.prepare(`
        UPDATE sales
        SET client_txn_uuid = ?
        WHERE id = ?
      `).run(`${uuid}:duplicate:${row.id}`, row.id);
    }
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_sales_client_txn_uuid
    ON sales(client_txn_uuid)
    WHERE client_txn_uuid IS NOT NULL AND trim(client_txn_uuid) <> ''
  `);
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
  add("loyalty_points", "INTEGER NOT NULL DEFAULT 0");
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

function ensureTradeQuoteColumns(db) {
  if (!tableExists(db, "trade_quotes")) return;
  const add = (name, sqlType) => {
    if (!columnExists(db, "trade_quotes", name)) {
      db.prepare(`ALTER TABLE trade_quotes ADD COLUMN ${name} ${sqlType}`).run();
    }
  };
  add("payout_method", "TEXT");
  add("payout_amount_cents", "INTEGER NOT NULL DEFAULT 0");
  add("inventory_posted", "INTEGER NOT NULL DEFAULT 0");
  add("inventory_posted_at", "TEXT");
  add("completed_at", "TEXT");
  add("seller_id_type", "TEXT");
  add("seller_id_last4", "TEXT");
  add("seller_dob", "TEXT");
  add("seller_address1", "TEXT");
  add("seller_city", "TEXT");
  add("seller_state", "TEXT");
  add("seller_zip", "TEXT");
  add("agreement_signed", "INTEGER NOT NULL DEFAULT 0");
  add("intake_checklist_json", "TEXT");
  add("completion_checklist_json", "TEXT");
  add("promo_label", "TEXT");
  add("promo_credit_bonus_percent", "REAL NOT NULL DEFAULT 0");
  add("hold_until", "TEXT");
  add("suggested_cash", "REAL NOT NULL DEFAULT 0");
  add("suggested_credit", "REAL NOT NULL DEFAULT 0");
  add("final_cash_offer", "REAL NOT NULL DEFAULT 0");
  add("final_credit_offer", "REAL NOT NULL DEFAULT 0");
  add("offer_override_reason", "TEXT");
  add("offer_override_requires_approval", "INTEGER NOT NULL DEFAULT 0");
  add("offer_override_approved_by", "INTEGER");
  add("offer_override_approved_at", "TEXT");
  add("intake_created_at", "TEXT");
}

function ensureTradeSettingsColumns(db) {
  if (!tableExists(db, "trade_settings")) return;
  const add = (name, sqlType) => {
    if (!columnExists(db, "trade_settings", name)) {
      db.prepare(`ALTER TABLE trade_settings ADD COLUMN ${name} ${sqlType}`).run();
    }
  };
  add("ebay_sold_enabled", "INTEGER NOT NULL DEFAULT 1");
  add("ebay_active_enabled", "INTEGER NOT NULL DEFAULT 1");
  add("ebay_country", "TEXT NOT NULL DEFAULT 'US'");
  add("require_customer", "INTEGER NOT NULL DEFAULT 0");
  add("require_seller_id", "INTEGER NOT NULL DEFAULT 0");
  add("require_agreement", "INTEGER NOT NULL DEFAULT 1");
  add("default_hold_days", "INTEGER NOT NULL DEFAULT 0");
  add("testing_queue_enabled", "INTEGER NOT NULL DEFAULT 1");
  add("auto_label_on_complete", "INTEGER NOT NULL DEFAULT 1");
  add("default_credit_percent", "REAL NOT NULL DEFAULT 50");
  add("default_cash_percent", "REAL NOT NULL DEFAULT 80");
  add("margin_floor_percent", "REAL NOT NULL DEFAULT 45");
  add("offer_basis", "TEXT NOT NULL DEFAULT 'sold_median'");
  add("promo_active", "INTEGER NOT NULL DEFAULT 0");
  add("promo_label", "TEXT NOT NULL DEFAULT ''");
  add("promo_credit_bonus_percent", "REAL NOT NULL DEFAULT 0");
}

function ensureTradeItemColumns(db) {
  if (!tableExists(db, "trade_quote_items")) return;
  const add = (name, sqlType) => {
    if (!columnExists(db, "trade_quote_items", name)) {
      db.prepare(`ALTER TABLE trade_quote_items ADD COLUMN ${name} ${sqlType}`).run();
    }
  };
  add("completeness", "TEXT NOT NULL DEFAULT 'loose'");
  add("allocated_cost", "REAL NOT NULL DEFAULT 0");
  add("allocated_total_cost", "REAL NOT NULL DEFAULT 0");
  add("pass_reason", "TEXT");
  add("condition_notes", "TEXT");
  add("accessories_json", "TEXT");
  add("inventory_action", "TEXT NOT NULL DEFAULT 'merge'");
  add("post_status", "TEXT NOT NULL DEFAULT 'testing'");
  add("hold_until", "TEXT");
  add("label_needed", "INTEGER NOT NULL DEFAULT 1");
  add("test_needed", "INTEGER NOT NULL DEFAULT 1");
  add("pricing_basis", "TEXT");
  add("offer_reason", "TEXT");
}

function ensureTradeTaskSchema(db) {
  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS trade_intake_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quote_id TEXT NOT NULL,
      quote_item_id INTEGER,
      item_id INTEGER,
      sku TEXT,
      task_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      title TEXT,
      platform TEXT,
      category TEXT,
      condition TEXT,
      completeness TEXT,
      qty INTEGER NOT NULL DEFAULT 1,
      retail_price REAL NOT NULL DEFAULT 0,
      allocated_cost REAL NOT NULL DEFAULT 0,
      allocated_total_cost REAL NOT NULL DEFAULT 0,
      inventory_action TEXT,
      post_status TEXT,
      due_at TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      user_id INTEGER,
      FOREIGN KEY(quote_id) REFERENCES trade_quotes(quote_id) ON DELETE CASCADE,
      FOREIGN KEY(quote_item_id) REFERENCES trade_quote_items(id) ON DELETE SET NULL,
      FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE SET NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_trade_tasks_status ON trade_intake_tasks(status, task_type);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_trade_tasks_quote ON trade_intake_tasks(quote_id);`);
  const add = (name, sqlType) => {
    if (!columnExists(db, "trade_intake_tasks", name)) {
      db.prepare(`ALTER TABLE trade_intake_tasks ADD COLUMN ${name} ${sqlType}`).run();
    }
  };
  add("category", "TEXT");
  add("completeness", "TEXT");
  add("qty", "INTEGER NOT NULL DEFAULT 1");
  add("retail_price", "REAL NOT NULL DEFAULT 0");
  add("allocated_cost", "REAL NOT NULL DEFAULT 0");
  add("allocated_total_cost", "REAL NOT NULL DEFAULT 0");
  add("inventory_action", "TEXT");
  add("post_status", "TEXT");
}

function ensureManagerTaskSchema(db) {
  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS manager_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_key TEXT UNIQUE,
      title TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL DEFAULT 'store',
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'open',
      assigned_scope TEXT NOT NULL DEFAULT 'management',
      assigned_user_id INTEGER,
      due_at TEXT,
      hard_due INTEGER NOT NULL DEFAULT 0,
      alert INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER,
      completed_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      FOREIGN KEY(assigned_user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY(completed_by) REFERENCES users(id) ON DELETE SET NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_manager_tasks_status_due ON manager_tasks(status, due_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_manager_tasks_assigned ON manager_tasks(assigned_scope, assigned_user_id);`);
}

function ensureAdvancedOperationsSchema(db) {
  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      contact_name TEXT,
      phone TEXT,
      email TEXT,
      website TEXT,
      notes TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_vendors_active_name ON vendors(active, name);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_id INTEGER,
      vendor_name TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      order_date TEXT,
      expected_at TEXT,
      subtotal_cents INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER,
      FOREIGN KEY(vendor_id) REFERENCES vendors(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders(status);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS purchase_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_order_id INTEGER NOT NULL,
      item_id INTEGER,
      sku TEXT,
      title TEXT,
      platform TEXT,
      category TEXT,
      condition TEXT,
      qty_ordered INTEGER NOT NULL DEFAULT 1,
      qty_received INTEGER NOT NULL DEFAULT 0,
      unit_cost_cents INTEGER NOT NULL DEFAULT 0,
      unit_price_cents INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(purchase_order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
      FOREIGN KEY(item_id) REFERENCES items(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_purchase_order_items_po ON purchase_order_items(purchase_order_id);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS stock_counts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      notes TEXT,
      user_id INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS stock_count_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_count_id INTEGER NOT NULL,
      item_id INTEGER,
      sku TEXT,
      title TEXT,
      expected_qty INTEGER NOT NULL DEFAULT 0,
      counted_qty INTEGER NOT NULL DEFAULT 0,
      variance INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      FOREIGN KEY(stock_count_id) REFERENCES stock_counts(id) ON DELETE CASCADE,
      FOREIGN KEY(item_id) REFERENCES items(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_stock_count_items_count ON stock_count_items(stock_count_id);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS special_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL DEFAULT 'open',
      customer_id INTEGER,
      customer_name TEXT,
      customer_phone TEXT,
      customer_email TEXT,
      item_id INTEGER,
      sku TEXT,
      title TEXT NOT NULL,
      platform TEXT,
      category TEXT,
      qty INTEGER NOT NULL DEFAULT 1,
      deposit_cents INTEGER NOT NULL DEFAULT 0,
      due_at TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER,
      FOREIGN KEY(customer_id) REFERENCES customers(id),
      FOREIGN KEY(item_id) REFERENCES items(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_special_orders_status ON special_orders(status);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL DEFAULT 'active',
      customer_id INTEGER,
      customer_name TEXT,
      customer_phone TEXT,
      customer_email TEXT,
      item_id INTEGER NOT NULL,
      sku TEXT,
      title TEXT,
      qty INTEGER NOT NULL DEFAULT 1,
      deposit_cents INTEGER NOT NULL DEFAULT 0,
      due_at TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER,
      FOREIGN KEY(customer_id) REFERENCES customers(id),
      FOREIGN KEY(item_id) REFERENCES items(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_reservations_status ON reservations(status);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS followups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER,
      customer_name TEXT,
      customer_phone TEXT,
      customer_email TEXT,
      type TEXT NOT NULL DEFAULT 'general',
      status TEXT NOT NULL DEFAULT 'open',
      subject TEXT NOT NULL,
      due_at TEXT,
      source_type TEXT,
      source_id TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER,
      FOREIGN KEY(customer_id) REFERENCES customers(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_followups_status_due ON followups(status, due_at);`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_followups_source_open ON followups(source_type, source_id, customer_id, subject) WHERE status='open';`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS gift_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      balance_cents INTEGER NOT NULL DEFAULT 0,
      issued_cents INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      customer_id INTEGER,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER,
      FOREIGN KEY(customer_id) REFERENCES customers(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS gift_card_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gift_card_id INTEGER NOT NULL,
      amount_cents INTEGER NOT NULL,
      reason TEXT,
      sale_id INTEGER,
      user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(gift_card_id) REFERENCES gift_cards(id) ON DELETE CASCADE,
      FOREIGN KEY(sale_id) REFERENCES sales(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS promotions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code TEXT,
      type TEXT NOT NULL DEFAULT 'percent',
      value_cents INTEGER NOT NULL DEFAULT 0,
      value_percent REAL NOT NULL DEFAULT 0,
      scope TEXT NOT NULL DEFAULT 'cart',
      status TEXT NOT NULL DEFAULT 'active',
      start_at TEXT,
      end_at TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_promotions_status_code ON promotions(status, code);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS warranties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER,
      sale_id INTEGER,
      customer_id INTEGER,
      serial_number TEXT,
      coverage_days INTEGER NOT NULL DEFAULT 30,
      expires_at TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER,
      FOREIGN KEY(item_id) REFERENCES items(id),
      FOREIGN KEY(sale_id) REFERENCES sales(id),
      FOREIGN KEY(customer_id) REFERENCES customers(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS serialized_units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER,
      sku TEXT,
      serial_number TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'in_stock',
      source_type TEXT,
      source_id TEXT,
      customer_id INTEGER,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER,
      FOREIGN KEY(item_id) REFERENCES items(id),
      FOREIGN KEY(customer_id) REFERENCES customers(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_serialized_units_serial ON serialized_units(serial_number);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS house_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      customer_name TEXT,
      credit_limit_cents INTEGER NOT NULL DEFAULT 0,
      balance_cents INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER,
      FOREIGN KEY(customer_id) REFERENCES customers(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_house_accounts_customer ON house_accounts(customer_id);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS house_account_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      house_account_id INTEGER NOT NULL,
      amount_cents INTEGER NOT NULL,
      reason TEXT,
      sale_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER,
      FOREIGN KEY(house_account_id) REFERENCES house_accounts(id) ON DELETE CASCADE,
      FOREIGN KEY(sale_id) REFERENCES sales(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS time_clock_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      clock_in_at TEXT NOT NULL DEFAULT (datetime('now')),
      clock_out_at TEXT,
      notes TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_time_clock_user_open ON time_clock_entries(user_id, clock_out_at);`);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS buylist_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      platform TEXT,
      category TEXT,
      condition TEXT,
      cash_cents INTEGER NOT NULL DEFAULT 0,
      credit_cents INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS consignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER,
      customer_name TEXT,
      item_id INTEGER,
      sku TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      split_percent REAL NOT NULL DEFAULT 60,
      payout_cents INTEGER NOT NULL DEFAULT 0,
      sale_id INTEGER,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER,
      FOREIGN KEY(customer_id) REFERENCES customers(id),
      FOREIGN KEY(item_id) REFERENCES items(id),
      FOREIGN KEY(sale_id) REFERENCES sales(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS rentals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER,
      customer_name TEXT,
      item_id INTEGER NOT NULL,
      sku TEXT,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'out',
      deposit_cents INTEGER NOT NULL DEFAULT 0,
      fee_cents INTEGER NOT NULL DEFAULT 0,
      due_at TEXT,
      returned_at TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER,
      FOREIGN KEY(customer_id) REFERENCES customers(id),
      FOREIGN KEY(item_id) REFERENCES items(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'created',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER,
      notes TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS pricing_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'all',
      percent_markup REAL NOT NULL DEFAULT 0,
      round_to_cents INTEGER NOT NULL DEFAULT 99,
      min_margin_percent REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS offline_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_key TEXT UNIQUE,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      processed_at TEXT,
      user_id INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS online_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT UNIQUE NOT NULL,
      customer_id INTEGER,
      customer_name TEXT,
      customer_phone TEXT,
      customer_email TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      fulfillment_method TEXT NOT NULL DEFAULT 'pickup',
      total_cents INTEGER NOT NULL DEFAULT 0,
      shipping_address TEXT,
      tracking_number TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER,
      FOREIGN KEY(customer_id) REFERENCES customers(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS online_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      item_id INTEGER,
      sku TEXT,
      title TEXT,
      qty INTEGER NOT NULL DEFAULT 1,
      unit_price_cents INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(order_id) REFERENCES online_orders(id) ON DELETE CASCADE,
      FOREIGN KEY(item_id) REFERENCES items(id)
    )
  `);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS decklists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER,
      customer_name TEXT,
      title TEXT,
      raw_text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'parsed',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER,
      FOREIGN KEY(customer_id) REFERENCES customers(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS decklist_matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      decklist_id INTEGER NOT NULL,
      item_id INTEGER,
      sku TEXT,
      title TEXT,
      requested_qty INTEGER NOT NULL DEFAULT 1,
      available_qty INTEGER NOT NULL DEFAULT 0,
      price_cents INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(decklist_id) REFERENCES decklists(id) ON DELETE CASCADE,
      FOREIGN KEY(item_id) REFERENCES items(id)
    )
  `);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS customer_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER,
      customer_name TEXT,
      channel TEXT NOT NULL DEFAULT 'phone',
      subject TEXT,
      body TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      source_type TEXT,
      source_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER,
      FOREIGN KEY(customer_id) REFERENCES customers(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  ensureTable(db, `
    CREATE TABLE IF NOT EXISTS item_collectible_details (
      item_id INTEGER PRIMARY KEY,
      card_set TEXT,
      card_number TEXT,
      rarity TEXT,
      finish TEXT,
      language TEXT,
      grade_company TEXT,
      grade TEXT,
      cert_number TEXT,
      notes TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER,
      FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
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
  ensureInventoryQuantityBackfill(db);
  ensureCategories(db);
  ensureSaleItemColumns(db);
  ensureSaleColumns(db);
  ensureCustomerColumns(db);
  ensureTradeSettingsColumns(db);
  ensureTradeQuoteColumns(db);
  ensureTradeItemColumns(db);
  ensureTradeTaskSchema(db);
  ensureManagerTaskSchema(db);
  ensureAdvancedOperationsSchema(db);
  normalizeUserRoles(db);
  ensurePermissionsForAllUsers(db);
  ensurePermissionColumns(db);
  ensureSalesClientTxnUuidIndex(db);

  return db;
}

module.exports = { initDb, DB_PATH };
