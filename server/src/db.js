/**
 * SQLite database (node:sqlite — built into Node, no native install).
 *
 * Everything lives here, including the product imagery: artwork is drawn as
 * SVG, rasterised to PNG at seed time, and the PNG bytes are stored as BLOBs
 * in `product_images`. The API streams those bytes back with real caching
 * headers, so the browser never sees an SVG.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(HERE, '..', 'data');
export const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'shop.db');

mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id                TEXT PRIMARY KEY,
  name              TEXT    NOT NULL,
  tagline           TEXT    NOT NULL DEFAULT '',
  description       TEXT    NOT NULL DEFAULT '',
  price             INTEGER NOT NULL,              -- cents
  compare_at_price  INTEGER,
  category          TEXT    NOT NULL,
  tags              TEXT    NOT NULL DEFAULT '[]', -- json array
  rating            REAL    NOT NULL DEFAULT 0,
  reviews           INTEGER NOT NULL DEFAULT 0,
  stock             INTEGER NOT NULL DEFAULT 0,
  featured          INTEGER NOT NULL DEFAULT 0,
  art               TEXT    NOT NULL,
  palette           TEXT    NOT NULL,
  specs             TEXT    NOT NULL DEFAULT '{}', -- json object
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_featured ON products(featured);

-- Rasterised artwork. One row per (product, size, format); the data column
-- holds the binary payload served straight to the browser.
CREATE TABLE IF NOT EXISTS product_images (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  TEXT    NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size        INTEGER NOT NULL,
  format      TEXT    NOT NULL,
  mime        TEXT    NOT NULL,
  width       INTEGER NOT NULL,
  height      INTEGER NOT NULL,
  bytes       INTEGER NOT NULL,
  hash        TEXT    NOT NULL,
  is_primary  INTEGER NOT NULL DEFAULT 0,
  data        BLOB    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (product_id, size, format)
);

CREATE INDEX IF NOT EXISTS idx_images_product ON product_images(product_id);

CREATE TABLE IF NOT EXISTS carts (
  id          TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cart_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  cart_id     TEXT    NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id  TEXT    NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty         INTEGER NOT NULL CHECK (qty > 0),
  added_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (cart_id, product_id)
);

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  salt           TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Opaque bearer tokens. Stored server-side so logout can actually revoke.
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS orders (
  id          TEXT    PRIMARY KEY,
  number      TEXT    NOT NULL UNIQUE,
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  email       TEXT    NOT NULL,
  customer    TEXT    NOT NULL,
  address     TEXT    NOT NULL DEFAULT '{}',
  subtotal    INTEGER NOT NULL,
  shipping    INTEGER NOT NULL,
  tax         INTEGER NOT NULL,
  total       INTEGER NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'confirmed',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Payments. The provider column says who actually handled it: 'razorpay' when keys are
-- configured, 'mock' when they are not. The Razorpay columns stay null on the
-- mock path, so one table serves both without a second schema.
CREATE TABLE IF NOT EXISTS payments (
  id              TEXT    PRIMARY KEY,
  order_id        TEXT    NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status          TEXT    NOT NULL DEFAULT 'requires_payment',
  method          TEXT    NOT NULL DEFAULT 'card',
  brand           TEXT,
  last4           TEXT,
  amount          INTEGER NOT NULL,
  failure_code    TEXT,
  failure_message TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Saved addresses. A shopper's address book: checkout picks one rather than
-- retyping it, and the agent can place an order against a saved address id
-- without ever being told the street.
CREATE TABLE IF NOT EXISTS addresses (
  id          TEXT    PRIMARY KEY,
  user_id     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       TEXT    NOT NULL DEFAULT 'Home',
  name        TEXT    NOT NULL,
  phone       TEXT    NOT NULL DEFAULT '',
  line1       TEXT    NOT NULL,
  line2       TEXT    NOT NULL DEFAULT '',
  city        TEXT    NOT NULL,
  state       TEXT    NOT NULL DEFAULT '',
  postcode    TEXT    NOT NULL,
  country     TEXT    NOT NULL DEFAULT 'India',
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_addresses_user ON addresses(user_id);

CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);

CREATE TABLE IF NOT EXISTS order_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    TEXT    NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  unit_price  INTEGER NOT NULL,
  qty         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

-- Customer-written reviews, loaded in bulk from the dataset CSVs.
--
-- The author column is denormalised rather than a users(id) reference: these
-- are dataset rows, not shop accounts, and joining them to the table that holds
-- real sign-ins and password hashes would put synthetic people in the account
-- system. products.rating / products.reviews stay as denormalised aggregates
-- over this table, recomputed at seed time — the catalogue sorts and filters on
-- them on every request, and a COUNT/AVG per row does not survive 2,000
-- products.
CREATE TABLE IF NOT EXISTS product_reviews (
  id          TEXT    PRIMARY KEY,
  product_id  TEXT    NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  author      TEXT    NOT NULL DEFAULT 'Verified buyer',
  rating      INTEGER NOT NULL,
  body        TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reviews_product ON product_reviews(product_id, rating DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_recent  ON product_reviews(product_id, created_at DESC);

-- The catalogue is searched by name far more than anything else, and at 2,000+
-- rows an unindexed prefix scan is the difference between a snappy list and a
-- visible pause. LIKE '%x%' cannot use this, but the ORDER BY clauses can.
CREATE INDEX IF NOT EXISTS idx_products_rating ON products(rating DESC, reviews DESC);
CREATE INDEX IF NOT EXISTS idx_products_price  ON products(price);
`);

/**
 * Additive column migrations.
 *
 * `CREATE TABLE IF NOT EXISTS` above does nothing to a table that already
 * exists, so a database created before Razorpay was wired in would silently
 * lack these columns and every insert naming them would fail. Checked against
 * the live schema rather than a version counter, which keeps it idempotent.
 */
function addColumn(table, column, definition) {
  const present = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!present) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

addColumn('payments', 'provider', "TEXT NOT NULL DEFAULT 'mock'");
// Razorpay's own identifiers, kept so a payment can be reconciled against the
// dashboard and so a webhook arriving before the browser redirect can find its
// order.
addColumn('payments', 'razorpay_order_id', 'TEXT');
addColumn('payments', 'razorpay_payment_id', 'TEXT');
addColumn('payments', 'razorpay_signature', 'TEXT');
// Razorpay reports how it was actually paid — upi / card / netbanking / wallet.
addColumn('payments', 'wallet', 'TEXT');
addColumn('payments', 'vpa', 'TEXT');
addColumn('payments', 'bank', 'TEXT');
// Set once a payment link has been issued for the agent flow.
addColumn('payments', 'payment_link_id', 'TEXT');
addColumn('payments', 'payment_link_url', 'TEXT');
// Which saved address an order shipped to, when one was used.
addColumn('orders', 'address_id', 'TEXT');

db.exec('CREATE INDEX IF NOT EXISTS idx_payments_rzp_order ON payments(razorpay_order_id)');

/** Run `fn` inside a transaction, rolling back on throw. */
export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function tableCount(table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}
