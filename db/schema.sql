-- schema.sql -- RetroCatz POS database (unified, current)
PRAGMA foreign_keys = ON;

-- ------------------------
-- USERS & PERMISSIONS
-- ------------------------
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  pw_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','manager','clerk','viewer')),
  active INTEGER NOT NULL DEFAULT 1,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ------------------------
-- INVENTORY (items)
-- ------------------------
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
  wix_media_ids TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_sku ON items(sku);

-- ------------------------
-- SALES & REFUNDS
-- ------------------------
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
);
CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);

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
);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);

CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  reason TEXT,
  user_id INTEGER,
  FOREIGN KEY(sale_id) REFERENCES sales(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_refunds_sale ON refunds(sale_id);

CREATE TABLE IF NOT EXISTS refund_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  refund_id INTEGER NOT NULL,
  sale_item_id INTEGER NOT NULL,
  qty_refunded INTEGER NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  line_total REAL NOT NULL DEFAULT 0,
  FOREIGN KEY(refund_id) REFERENCES refunds(id) ON DELETE CASCADE,
  FOREIGN KEY(sale_item_id) REFERENCES sale_items(id)
);
CREATE INDEX IF NOT EXISTS idx_refund_items_refund ON refund_items(refund_id);

-- ------------------------
-- INVENTORY MOVEMENTS & SALE EVENTS
-- ------------------------
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
);
CREATE INDEX IF NOT EXISTS idx_inv_mov_item ON inventory_movements(item_id);
CREATE INDEX IF NOT EXISTS idx_inv_mov_sale ON inventory_movements(sale_id);

CREATE TABLE IF NOT EXISTS sale_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  action TEXT NOT NULL,
  user_id INTEGER,
  metadata TEXT,
  FOREIGN KEY(sale_id) REFERENCES sales(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_sale_events_sale ON sale_events(sale_id);

-- ------------------------
-- CUSTOMERS
-- ------------------------
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
);
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
CREATE INDEX IF NOT EXISTS idx_customers_ein ON customers(ein);

CREATE TABLE IF NOT EXISTS customer_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER,
  FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_customer_notes_customer ON customer_notes(customer_id);

CREATE TABLE IF NOT EXISTS customer_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER,
  FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_customer_adj_customer ON customer_adjustments(customer_id);

-- ------------------------
-- AUDIT / ACTIVITY
-- ------------------------
CREATE TABLE IF NOT EXISTS user_activity (
  id TEXT PRIMARY KEY,
  userId TEXT,
  username TEXT,
  action TEXT,
  screen TEXT,
  metadata TEXT,
  createdAt TEXT
);

-- ------------------------
-- AI TABLES
-- ------------------------
CREATE TABLE IF NOT EXISTS ai_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT DEFAULT 'lab',
  chattiness TEXT DEFAULT 'normal',
  lastInternalRun TEXT,
  lastMarketRun TEXT,
  lastTrendRun TEXT
);
INSERT OR IGNORE INTO ai_settings (id, mode, chattiness)
VALUES (1, 'lab', 'normal');

CREATE TABLE IF NOT EXISTS ai_messages (
  id TEXT PRIMARY KEY,
  createdAt TEXT,
  severity TEXT,
  source TEXT,
  title TEXT,
  body TEXT,
  isRead INTEGER DEFAULT 0
);

-- ------------------------
-- WASTE / DELETE LOGS
-- ------------------------
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
);

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
);

-- ------------------------
-- CHANNEL SYNC LOG
-- ------------------------
CREATE TABLE IF NOT EXISTS channel_sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  channel TEXT NOT NULL,
  action TEXT NOT NULL,
  sku TEXT,
  ok INTEGER NOT NULL DEFAULT 0,
  message TEXT
);
