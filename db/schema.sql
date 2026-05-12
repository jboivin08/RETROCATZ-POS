-- schema.sql -- VaultCore POS database (unified, current)
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
  discount_override INTEGER NOT NULL DEFAULT 0,
  void_refund INTEGER NOT NULL DEFAULT 0,
  settings_admin INTEGER NOT NULL DEFAULT 0,
  closeout_admin INTEGER NOT NULL DEFAULT 0,
  tax_admin INTEGER NOT NULL DEFAULT 0,
  sync_admin INTEGER NOT NULL DEFAULT 0,
  store_credit INTEGER NOT NULL DEFAULT 0,
  trade_override INTEGER NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS pos_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  owner_locked INTEGER NOT NULL DEFAULT 0,
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(updated_by) REFERENCES users(id)
);
INSERT OR IGNORE INTO pos_settings (key, value, owner_locked, updated_at) VALUES
  ('tax_rate', '0.07', 0, datetime('now')),
  ('require_pin_for_price_override', '1', 0, datetime('now')),
  ('require_pin_for_discounts', '1', 0, datetime('now')),
  ('store_name', 'VaultCore POS', 0, datetime('now')),
  ('store_phone', '', 0, datetime('now')),
  ('store_email', '', 0, datetime('now')),
  ('store_website', '', 0, datetime('now')),
  ('store_address1', '', 0, datetime('now')),
  ('store_address2', '', 0, datetime('now')),
  ('store_city', '', 0, datetime('now')),
  ('store_state', '', 0, datetime('now')),
  ('store_zip', '', 0, datetime('now')),
  ('receipt_footer', 'Thank you for shopping with us.', 0, datetime('now')),
  ('low_stock_threshold', '1', 0, datetime('now')),
  ('default_inventory_category', 'Games', 0, datetime('now')),
  ('default_markup_percent', '100', 0, datetime('now')),
  ('tax_label', 'Sales Tax', 0, datetime('now')),
  ('require_pin_for_tax_exempt', '1', 0, datetime('now')),
  ('require_customer_for_sale', '0', 0, datetime('now')),
  ('allow_split_tender', '1', 0, datetime('now')),
  ('payment_cash_enabled', '1', 0, datetime('now')),
  ('payment_card_enabled', '1', 0, datetime('now')),
  ('payment_store_credit_enabled', '1', 0, datetime('now')),
  ('payment_other_enabled', '1', 0, datetime('now')),
  ('receipt_print_after_sale', '1', 0, datetime('now')),
  ('receipt_show_sku', '1', 0, datetime('now')),
  ('receipt_show_platform_condition', '1', 0, datetime('now')),
  ('receipt_show_tax_rate', '1', 0, datetime('now')),
  ('receipt_show_barcode', '1', 0, datetime('now')),
  ('receipt_show_customer', '0', 0, datetime('now')),
  ('receipt_return_policy', 'All sales final. Defective items may be exchanged with receipt.', 0, datetime('now')),
  ('sale_id_prefix', 'SO', 0, datetime('now')),
  ('max_held_sales', '20', 0, datetime('now')),
  ('quick_discount_percent_1', '5', 0, datetime('now')),
  ('quick_discount_percent_2', '10', 0, datetime('now')),
  ('quick_discount_amount_1', '5', 0, datetime('now')),
  ('quick_discount_amount_2', '10', 0, datetime('now')),
  ('closeout_variance_warn_cents', '500', 0, datetime('now')),
  ('closeout_require_note_on_variance', '1', 0, datetime('now')),
  ('closeout_require_opening_cash', '0', 0, datetime('now'));

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
  wix_media_ids TEXT,
  deleted_at TEXT,
  deleted_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_sku ON items(sku);
CREATE INDEX IF NOT EXISTS idx_items_deleted_at ON items(deleted_at);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_categories_active_sort ON categories(active, sort_order, name);

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
CREATE UNIQUE INDEX IF NOT EXISTS ux_sales_client_txn_uuid
  ON sales(client_txn_uuid)
  WHERE client_txn_uuid IS NOT NULL AND trim(client_txn_uuid) <> '';

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

CREATE TABLE IF NOT EXISTS inventory_quantities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'sellable',
  location TEXT NOT NULL DEFAULT 'store',
  qty INTEGER NOT NULL DEFAULT 0 CHECK(qty >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE,
  UNIQUE(item_id, status, location)
);
CREATE INDEX IF NOT EXISTS idx_inv_qty_item ON inventory_quantities(item_id);
CREATE INDEX IF NOT EXISTS idx_inv_qty_status_location ON inventory_quantities(status, location);

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
);
CREATE INDEX IF NOT EXISTS idx_inv_bucket_mov_item ON inventory_bucket_movements(item_id);
CREATE INDEX IF NOT EXISTS idx_inv_bucket_mov_created ON inventory_bucket_movements(created_at);

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

CREATE TABLE IF NOT EXISTS held_sales (
  id TEXT PRIMARY KEY,
  label TEXT,
  payload_json TEXT NOT NULL,
  user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_held_sales_updated ON held_sales(updated_at);

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
);
CREATE INDEX IF NOT EXISTS idx_live_events_status_updated ON live_events(status, updated_at);

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
);
CREATE INDEX IF NOT EXISTS idx_community_events_status_start ON community_events(status, starts_at);

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
);
CREATE INDEX IF NOT EXISTS idx_community_event_attendees_event ON community_event_attendees(event_id, status);
CREATE INDEX IF NOT EXISTS idx_community_event_attendees_customer ON community_event_attendees(customer_id);

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
-- TRADE-IN QUOTES
-- ------------------------
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
);
INSERT OR IGNORE INTO trade_settings (id, quote_expiry_days, approval_cash_limit_cents, approval_credit_limit_cents)
VALUES (1, 30, 20000, 30000);

CREATE TABLE IF NOT EXISTS trade_user_settings (
  user_id INTEGER PRIMARY KEY,
  approval_cash_limit_cents INTEGER,
  approval_credit_limit_cents INTEGER,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

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
);
CREATE INDEX IF NOT EXISTS idx_trade_quotes_created ON trade_quotes(created_at);
CREATE INDEX IF NOT EXISTS idx_trade_quotes_status ON trade_quotes(status);
CREATE INDEX IF NOT EXISTS idx_trade_quotes_customer ON trade_quotes(customer_id);

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
);
CREATE INDEX IF NOT EXISTS idx_trade_items_quote ON trade_quote_items(quote_id);

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
);
CREATE INDEX IF NOT EXISTS idx_trade_tasks_status ON trade_intake_tasks(status, task_type);
CREATE INDEX IF NOT EXISTS idx_trade_tasks_quote ON trade_intake_tasks(quote_id);

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
);
CREATE INDEX IF NOT EXISTS idx_manager_tasks_status_due ON manager_tasks(status, due_at);
CREATE INDEX IF NOT EXISTS idx_manager_tasks_assigned ON manager_tasks(assigned_scope, assigned_user_id);

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

-- ------------------------
-- REGISTER CLOSEOUTS
-- ------------------------
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
);
CREATE INDEX IF NOT EXISTS idx_register_closeouts_date ON register_closeouts(business_date);

-- ------------------------
-- ACCOUNTING
-- ------------------------
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
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
CREATE INDEX IF NOT EXISTS idx_expenses_type ON expenses(type);

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
);
CREATE INDEX IF NOT EXISTS idx_tax_filings_period ON tax_filings(period_start, period_end);
