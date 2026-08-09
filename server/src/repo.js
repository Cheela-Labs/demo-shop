/**
 * Query layer. Rows come out of SQLite flat and snake_cased; everything the
 * API hands to the client is shaped here.
 */

import { randomUUID } from 'node:crypto';

import { db, transaction } from './db.js';
import { IMAGE_SIZES } from './seed.js';
import { charge } from './mock-payments.js';
import { isConfigured as razorpayConfigured } from './razorpay.js';

/**
 * Who settles payments for orders created from now on.
 *
 * Recorded per payment rather than read at settlement time, so an order placed
 * while Razorpay was configured is still reconciled as a Razorpay payment even
 * if the keys are pulled afterwards.
 */
const PAYMENT_PROVIDER = razorpayConfigured() ? 'razorpay' : 'mock';

/* ----------------------------- products ----------------------------- */

/** Builds the image descriptor the client renders (src + srcset + dimensions). */
function imageFor(id) {
  const url = (size) => `/api/products/${encodeURIComponent(id)}/image?size=${size}`;
  return {
    src: url(800),
    thumb: url(400),
    srcset: IMAGE_SIZES.map((s) => `${url(s)} ${s}w`).join(', '),
    sizes: '(max-width: 700px) 92vw, 420px',
    width: 800,
    height: 800,
  };
}

function mapProduct(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    tagline: row.tagline,
    description: row.description,
    price: row.price,
    compareAtPrice: row.compare_at_price,
    category: row.category,
    tags: JSON.parse(row.tags),
    rating: row.rating,
    reviews: row.reviews,
    stock: row.stock,
    inStock: row.stock > 0,
    featured: Boolean(row.featured),
    specs: JSON.parse(row.specs),
    image: imageFor(row.id),
  };
}

/**
 * Sorting by raw average is wrong once the catalogue is large enough to contain
 * one-review products: a lone 5★ outranks a 4.7 carrying three hundred reviews,
 * and the "top rated" page fills with things nobody has bought. This is the
 * standard shrinkage fix — pull every average toward the catalogue mean in
 * proportion to how little evidence backs it, so a rating has to be earned by
 * volume before it can win.
 *
 * PRIOR_WEIGHT is how many average-rated reviews a new product is treated as
 * already having. At 25 a product needs roughly that many before its own score
 * dominates the prior.
 */
const PRIOR_WEIGHT = 25;
const BAYESIAN_RATING = `
  ((rating * reviews) + (${PRIOR_WEIGHT} * (SELECT AVG(rating) FROM products WHERE reviews > 0)))
  / (reviews + ${PRIOR_WEIGHT})
`;

const SORTS = {
  featured: 'featured DESC, reviews DESC',
  'price-asc': 'price ASC',
  'price-desc': 'price DESC',
  rating: `${BAYESIAN_RATING} DESC, reviews DESC`,
  newest: 'created_at DESC, id ASC',
  name: 'name ASC',
};

export function listProducts(query = {}) {
  const where = [];
  const params = [];

  if (query.category && query.category !== 'All') {
    where.push('category = ?');
    params.push(query.category);
  }
  if (query.q) {
    where.push('(name LIKE ? OR tagline LIKE ? OR description LIKE ? OR tags LIKE ?)');
    const like = `%${query.q}%`;
    params.push(like, like, like, like);
  }
  if (query.featured === true) where.push('featured = 1');
  if (query.minPrice != null) { where.push('price >= ?'); params.push(query.minPrice); }
  if (query.maxPrice != null) { where.push('price <= ?'); params.push(query.maxPrice); }
  if (query.inStock) where.push('stock > 0');

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const order = SORTS[query.sort] || SORTS.featured;

  const total = db.prepare(`SELECT COUNT(*) AS n FROM products ${clause}`).get(...params).n;

  const limit = Math.min(Math.max(Number(query.limit) || 24, 1), 100);
  const page = Math.max(Number(query.page) || 1, 1);
  const offset = (page - 1) * limit;

  const rows = db
    .prepare(`SELECT * FROM products ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);

  return {
    items: rows.map(mapProduct),
    total,
    page,
    limit,
    pages: Math.max(Math.ceil(total / limit), 1),
  };
}

export function getProduct(id) {
  return mapProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
}

export function relatedProducts(id, limit = 4) {
  const product = db.prepare('SELECT category FROM products WHERE id = ?').get(id);
  if (!product) return [];
  return db
    .prepare('SELECT * FROM products WHERE category = ? AND id != ? ORDER BY rating DESC LIMIT ?')
    .all(product.category, id, limit)
    .map(mapProduct);
}

/* --------------------------------- reviews -------------------------------- */

const REVIEW_SORTS = {
  recent: 'created_at DESC, id ASC',
  helpful: 'rating DESC, created_at DESC',
  critical: 'rating ASC, created_at DESC',
};

/**
 * Reviews for one product, newest first by default.
 *
 * Always paged. The busiest product in the dataset carries a few hundred
 * reviews, and neither the product page nor a capability result has any use for
 * all of them at once.
 */
export function listReviews(productId, query = {}) {
  const order = REVIEW_SORTS[query.sort] || REVIEW_SORTS.recent;
  const limit = Math.min(Math.max(Number(query.limit) || 10, 1), 100);
  const page = Math.max(Number(query.page) || 1, 1);

  const total = db
    .prepare('SELECT COUNT(*) AS n FROM product_reviews WHERE product_id = ?')
    .get(productId).n;

  const items = db
    .prepare(`SELECT * FROM product_reviews WHERE product_id = ? ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(productId, limit, (page - 1) * limit)
    .map((row) => ({
      id: row.id,
      author: row.author,
      rating: row.rating,
      body: row.body,
      createdAt: row.created_at,
    }));

  return { items, total, page, pages: Math.max(Math.ceil(total / limit), 1) };
}

/**
 * Average and star histogram for one product.
 *
 * The histogram is what makes a rating legible: 4.2 from a flat spread and 4.2
 * from "mostly fives and a few ones" are different products, and a shopper
 * asking "is this any good?" is really asking which of those it is.
 */
export function reviewSummary(productId) {
  const rows = db
    .prepare('SELECT rating, COUNT(*) AS n FROM product_reviews WHERE product_id = ? GROUP BY rating')
    .all(productId);

  const histogram = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let total = 0;
  let sum = 0;
  for (const { rating, n } of rows) {
    histogram[rating] = n;
    total += n;
    sum += rating * n;
  }

  return {
    total,
    average: total ? Number((sum / total).toFixed(2)) : null,
    histogram,
  };
}

export function listCategories() {
  return db
    .prepare('SELECT category AS name, COUNT(*) AS count FROM products GROUP BY category ORDER BY category')
    .all();
}

/** Raw image row straight from the DB — `data` is a Uint8Array of PNG bytes. */
export function getImage(productId, size) {
  const nearest = IMAGE_SIZES.reduce((best, s) =>
    Math.abs(s - size) < Math.abs(best - size) ? s : best, IMAGE_SIZES[0]);
  return db
    .prepare(`SELECT * FROM product_images WHERE product_id = ? AND format = 'png' AND size = ?`)
    .get(productId, nearest);
}

/* ------------------------------- cart ------------------------------- */

// Money is in paise throughout — ₹99 is 9900. Integers everywhere, no floats.
const SHIPPING_FLAT = 9900;        // ₹99
const FREE_SHIPPING_OVER = 199900; // ₹1,999
// GST. Shown as its own line rather than folded into the displayed price, so
// the order breakdown reads like an invoice and the arithmetic stays visible.
const TAX_RATE = 0.18;

export function createCart(userId = null) {
  const id = randomUUID();
  db.prepare('INSERT INTO carts (id, user_id) VALUES (?, ?)').run(id, userId);
  return getCart(id);
}

export function cartExists(id) {
  return Boolean(db.prepare('SELECT 1 AS x FROM carts WHERE id = ?').get(id));
}

export function getCart(id) {
  const cart = db.prepare('SELECT * FROM carts WHERE id = ?').get(id);
  if (!cart) return null;

  const rows = db
    .prepare(
      `SELECT ci.id AS item_id, ci.qty, p.*
         FROM cart_items ci JOIN products p ON p.id = ci.product_id
        WHERE ci.cart_id = ?
        ORDER BY ci.added_at, ci.id`,
    )
    .all(id);

  const items = rows.map((row) => {
    const product = mapProduct(row);
    return {
      itemId: row.item_id,
      qty: row.qty,
      lineTotal: row.qty * product.price,
      product,
    };
  });

  return { id: cart.id, ...totals(items), items, updatedAt: cart.updated_at };
}

export function totals(items) {
  const subtotal = items.reduce((sum, i) => sum + i.lineTotal, 0);
  const count = items.reduce((sum, i) => sum + i.qty, 0);
  const shipping = subtotal === 0 || subtotal >= FREE_SHIPPING_OVER ? 0 : SHIPPING_FLAT;
  const tax = Math.round(subtotal * TAX_RATE);
  return {
    count,
    subtotal,
    shipping,
    tax,
    total: subtotal + shipping + tax,
    freeShippingThreshold: FREE_SHIPPING_OVER,
  };
}

const touchCart = db.prepare(`UPDATE carts SET updated_at = datetime('now') WHERE id = ?`);

export function addToCart(cartId, productId, qty = 1) {
  const product = db.prepare('SELECT stock FROM products WHERE id = ?').get(productId);
  if (!product) throw Object.assign(new Error('No such product'), { status: 404 });

  return transaction(() => {
    const existing = db
      .prepare('SELECT id, qty FROM cart_items WHERE cart_id = ? AND product_id = ?')
      .get(cartId, productId);

    const desired = (existing?.qty || 0) + qty;
    if (desired > product.stock) {
      throw Object.assign(new Error(`Only ${product.stock} left in stock`), { status: 409 });
    }

    if (existing) {
      db.prepare('UPDATE cart_items SET qty = ? WHERE id = ?').run(desired, existing.id);
    } else {
      db.prepare('INSERT INTO cart_items (cart_id, product_id, qty) VALUES (?, ?, ?)')
        .run(cartId, productId, qty);
    }
    touchCart.run(cartId);
    return getCart(cartId);
  });
}

export function updateCartItem(cartId, itemId, qty) {
  const item = db
    .prepare('SELECT ci.id, ci.product_id, p.stock FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.id = ? AND ci.cart_id = ?')
    .get(itemId, cartId);
  if (!item) throw Object.assign(new Error('Item is not in this cart'), { status: 404 });

  if (qty <= 0) return removeCartItem(cartId, itemId);
  if (qty > item.stock) {
    throw Object.assign(new Error(`Only ${item.stock} left in stock`), { status: 409 });
  }

  db.prepare('UPDATE cart_items SET qty = ? WHERE id = ?').run(qty, itemId);
  touchCart.run(cartId);
  return getCart(cartId);
}

export function removeCartItem(cartId, itemId) {
  db.prepare('DELETE FROM cart_items WHERE id = ? AND cart_id = ?').run(itemId, cartId);
  touchCart.run(cartId);
  return getCart(cartId);
}

export function clearCart(cartId) {
  db.prepare('DELETE FROM cart_items WHERE cart_id = ?').run(cartId);
  touchCart.run(cartId);
  return getCart(cartId);
}

/* ------------------------------ orders ------------------------------ */

function orderNumber() {
  const stamp = Date.now().toString(36).toUpperCase().slice(-5);
  const rand = Math.random().toString(36).toUpperCase().slice(2, 5);
  return `CHL-${stamp}${rand}`;
}

export function createOrder({ cartId, email, customer, address, userId = null, addressId = null }) {
  const cart = getCart(cartId);
  if (!cart) throw Object.assign(new Error('Cart not found'), { status: 404 });
  if (cart.items.length === 0) throw Object.assign(new Error('Your cart is empty'), { status: 400 });

  return transaction(() => {
    // Re-check stock inside the transaction; the cart may be minutes old.
    for (const item of cart.items) {
      const stock = db.prepare('SELECT stock, name FROM products WHERE id = ?').get(item.product.id);
      if (!stock || stock.stock < item.qty) {
        throw Object.assign(
          new Error(`${stock?.name || 'An item'} no longer has enough stock`),
          { status: 409 },
        );
      }
    }

    const id = randomUUID();
    const number = orderNumber();

    // Orders start unpaid. Stock is reserved here rather than at payment time,
    // so two shoppers cannot both check out the last unit and then race for it
    // at the card step; `failPayment` puts it back if the charge fails.
    db.prepare(
      `INSERT INTO orders (id, number, user_id, email, customer, address, address_id, subtotal, shipping, tax, total, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_payment')`,
    ).run(
      id, number, userId, email, customer, JSON.stringify(address || {}), addressId,
      cart.subtotal, cart.shipping, cart.tax, cart.total,
    );

    // The address is copied onto the order, not referenced — an order is a
    // record of where it actually shipped, and editing or deleting the saved
    // address later must not rewrite history.
    db.prepare(
      `INSERT INTO payments (id, order_id, amount, status, provider)
       VALUES (?, ?, ?, 'requires_payment', ?)`,
    ).run(randomUUID(), id, cart.total, PAYMENT_PROVIDER);

    const addItem = db.prepare(
      'INSERT INTO order_items (order_id, product_id, name, unit_price, qty) VALUES (?, ?, ?, ?, ?)',
    );
    const decStock = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?');

    for (const item of cart.items) {
      addItem.run(id, item.product.id, item.product.name, item.product.price, item.qty);
      decStock.run(item.qty, item.product.id);
    }

    db.prepare('DELETE FROM cart_items WHERE cart_id = ?').run(cartId);
    return getOrder(id);
  });
}

export function getOrder(idOrNumber) {
  const order = db
    .prepare('SELECT * FROM orders WHERE id = ? OR number = ?')
    .get(idOrNumber, idOrNumber);
  if (!order) return null;

  const items = db
    .prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id')
    .all(order.id)
    .map((i) => ({
      productId: i.product_id,
      name: i.name,
      unitPrice: i.unit_price,
      qty: i.qty,
      lineTotal: i.unit_price * i.qty,
      image: imageFor(i.product_id),
    }));

  return {
    id: order.id,
    number: order.number,
    // Exposed so callers can check ownership. The Cheela capability needs it to
    // refuse an order that belongs to somebody else.
    userId: order.user_id,
    email: order.email,
    customer: order.customer,
    address: JSON.parse(order.address),
    subtotal: order.subtotal,
    shipping: order.shipping,
    tax: order.tax,
    total: order.total,
    status: order.status,
    createdAt: order.created_at,
    items,
    payment: getPaymentForOrder(order.id),
  };
}

export function listOrdersForUser(userId) {
  return db
    .prepare('SELECT id FROM orders WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId)
    .map((row) => getOrder(row.id));
}

/* ----------------------------- payments ----------------------------- */

function mapPayment(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderId: row.order_id,
    status: row.status,
    provider: row.provider || 'mock',
    method: row.method,
    brand: row.brand,
    last4: row.last4,
    wallet: row.wallet ?? null,
    vpa: row.vpa ?? null,
    bank: row.bank ?? null,
    amount: row.amount,
    razorpayOrderId: row.razorpay_order_id ?? null,
    razorpayPaymentId: row.razorpay_payment_id ?? null,
    paymentLinkUrl: row.payment_link_url ?? null,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getPaymentForOrder(orderId) {
  return mapPayment(
    db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY created_at DESC LIMIT 1').get(orderId),
  );
}

/**
 * Marks a payment captured and its order paid.
 * Idempotent-ish: paying an already-paid order is rejected by the caller.
 */
export function capturePayment(orderId, details = {}) {
  const {
    brand, last4, provider, method, wallet, vpa, bank,
    razorpayOrderId, razorpayPaymentId, razorpaySignature,
  } = details;

  return transaction(() => {
    db.prepare(
      `UPDATE payments SET status = 'captured', brand = ?, last4 = ?,
         provider    = COALESCE(?, provider),
         method      = COALESCE(?, method),
         wallet      = ?, vpa = ?, bank = ?,
         razorpay_order_id   = COALESCE(?, razorpay_order_id),
         razorpay_payment_id = COALESCE(?, razorpay_payment_id),
         razorpay_signature  = COALESCE(?, razorpay_signature),
         failure_code = NULL, failure_message = NULL, updated_at = datetime('now')
       WHERE order_id = ?`,
    ).run(
      brand ?? null, last4 ?? null, provider ?? null, method ?? null,
      wallet ?? null, vpa ?? null, bank ?? null,
      razorpayOrderId ?? null, razorpayPaymentId ?? null, razorpaySignature ?? null,
      orderId,
    );

    db.prepare(`UPDATE orders SET status = 'paid' WHERE id = ?`).run(orderId);
    return getOrder(orderId);
  });
}

/**
 * Runs a payment attempt against an order and settles it either way.
 *
 * The one implementation both the REST route and the Cheela capability call, so
 * the browser and an agent cannot end up with different rules about what a
 * declined card does to stock or order status.
 */
export function payOrder(idOrNumber, paymentMethod) {
  const order = getOrder(idOrNumber);
  if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });

  if (order.status === 'paid') {
    throw Object.assign(new Error(`Order ${order.number} is already paid`), { status: 409 });
  }
  if (order.status === 'cancelled') {
    throw Object.assign(new Error(`Order ${order.number} was cancelled`), { status: 409 });
  }

  const result = charge(paymentMethod, order.total);

  // A token the processor does not recognise is a caller mistake, not an
  // issuer decision. Settling it as a decline would mark the order failed and
  // release its stock over what is really a typo, so it throws instead and
  // leaves the order exactly as it was.
  if (!result.ok && result.code === 'invalid_payment_method') {
    throw Object.assign(new Error(result.message), { status: 400 });
  }

  if (!result.ok) {
    const failed = failPayment(order.id, result);
    return { ok: false, order: failed, error: { code: result.code, message: result.message } };
  }

  return { ok: true, order: capturePayment(order.id, result), error: null };
}

/**
 * Records a failed charge and releases the stock the order was holding, so a
 * declined card does not quietly keep inventory out of circulation.
 */
export function failPayment(orderId, { brand, last4, code, message, provider, method, razorpayPaymentId } = {}) {
  return transaction(() => {
    db.prepare(
      `UPDATE payments SET status = 'failed', brand = ?, last4 = ?,
         provider = COALESCE(?, provider),
         method   = COALESCE(?, method),
         razorpay_payment_id = COALESCE(?, razorpay_payment_id),
         failure_code = ?, failure_message = ?, updated_at = datetime('now')
       WHERE order_id = ?`,
    ).run(
      brand ?? null, last4 ?? null, provider ?? null, method ?? null,
      razorpayPaymentId ?? null, code ?? null, message ?? null, orderId,
    );

    db.prepare(`UPDATE orders SET status = 'payment_failed' WHERE id = ?`).run(orderId);

    const restock = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?');
    for (const item of db.prepare('SELECT product_id, qty FROM order_items WHERE order_id = ?').all(orderId)) {
      restock.run(item.qty, item.product_id);
    }

    return getOrder(orderId);
  });
}

/* ---------------------------- addresses ----------------------------- */

function mapAddress(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    name: row.name,
    phone: row.phone,
    line1: row.line1,
    line2: row.line2,
    city: row.city,
    state: row.state,
    postcode: row.postcode,
    country: row.country,
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at,
  };
}

/** One line, the way it would be printed on a shipping label. */
export function formatAddress(address) {
  if (!address) return '';
  return [
    address.line1, address.line2, address.city,
    address.state, address.postcode, address.country,
  ].filter(Boolean).join(', ');
}

export function listAddresses(userId) {
  return db
    .prepare('SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, created_at DESC')
    .all(userId)
    .map(mapAddress);
}

export function getAddress(id, userId) {
  const row = db.prepare('SELECT * FROM addresses WHERE id = ? AND user_id = ?').get(id, userId);
  return mapAddress(row);
}

export function defaultAddress(userId) {
  const row = db
    .prepare('SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, created_at DESC LIMIT 1')
    .get(userId);
  return mapAddress(row);
}

const ADDRESS_REQUIRED = ['name', 'line1', 'city', 'state', 'postcode'];

/**
 * Validates an address the way an Indian courier would need it.
 *
 * PIN codes are exactly six digits and never start with zero; phone numbers are
 * ten digits starting 6-9. Rejecting these here rather than at the courier
 * means a bad address fails while the shopper is still looking at the form.
 */
export function validateAddress(input) {
  for (const field of ADDRESS_REQUIRED) {
    if (!String(input?.[field] || '').trim()) return `${field} is required`;
  }
  if (!/^[1-9][0-9]{5}$/.test(String(input.postcode).trim())) {
    return 'postcode must be a 6-digit Indian PIN code';
  }
  const phone = String(input.phone || '').replace(/\s|-/g, '');
  if (phone && !/^(\+91)?[6-9]\d{9}$/.test(phone)) {
    return 'phone must be a 10-digit Indian mobile number';
  }
  return null;
}

export function createAddress(userId, input) {
  const invalid = validateAddress(input);
  if (invalid) throw Object.assign(new Error(invalid), { status: 400 });

  return transaction(() => {
    const id = randomUUID();
    // The first address a shopper saves becomes their default with no extra
    // step — an address book with nothing marked default is just friction.
    const isFirst = db.prepare('SELECT COUNT(*) AS n FROM addresses WHERE user_id = ?').get(userId).n === 0;
    const makeDefault = input.isDefault || isFirst;

    if (makeDefault) {
      db.prepare('UPDATE addresses SET is_default = 0 WHERE user_id = ?').run(userId);
    }

    db.prepare(
      `INSERT INTO addresses (id, user_id, label, name, phone, line1, line2, city, state, postcode, country, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, userId,
      String(input.label || 'Home').trim(),
      String(input.name).trim(),
      String(input.phone || '').trim(),
      String(input.line1).trim(),
      String(input.line2 || '').trim(),
      String(input.city).trim(),
      String(input.state).trim(),
      String(input.postcode).trim(),
      String(input.country || 'India').trim(),
      makeDefault ? 1 : 0,
    );

    return getAddress(id, userId);
  });
}

export function updateAddress(id, userId, input) {
  const existing = getAddress(id, userId);
  if (!existing) throw Object.assign(new Error('Address not found'), { status: 404 });

  const merged = { ...existing, ...input };
  const invalid = validateAddress(merged);
  if (invalid) throw Object.assign(new Error(invalid), { status: 400 });

  return transaction(() => {
    if (input.isDefault) {
      db.prepare('UPDATE addresses SET is_default = 0 WHERE user_id = ?').run(userId);
    }
    db.prepare(
      `UPDATE addresses SET label = ?, name = ?, phone = ?, line1 = ?, line2 = ?,
         city = ?, state = ?, postcode = ?, country = ?, is_default = ?,
         updated_at = datetime('now')
       WHERE id = ? AND user_id = ?`,
    ).run(
      merged.label, merged.name, merged.phone || '', merged.line1, merged.line2 || '',
      merged.city, merged.state, merged.postcode, merged.country || 'India',
      input.isDefault ? 1 : (existing.isDefault ? 1 : 0),
      id, userId,
    );
    return getAddress(id, userId);
  });
}

export function deleteAddress(id, userId) {
  const existing = getAddress(id, userId);
  if (!existing) throw Object.assign(new Error('Address not found'), { status: 404 });

  return transaction(() => {
    db.prepare('DELETE FROM addresses WHERE id = ? AND user_id = ?').run(id, userId);

    // Deleting the default promotes the next most recent, so the shopper is
    // never left with a book full of addresses and nothing selected.
    if (existing.isDefault) {
      const next = db
        .prepare('SELECT id FROM addresses WHERE user_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(userId);
      if (next) db.prepare('UPDATE addresses SET is_default = 1 WHERE id = ?').run(next.id);
    }
    return { ok: true };
  });
}

export function setDefaultAddress(id, userId) {
  const existing = getAddress(id, userId);
  if (!existing) throw Object.assign(new Error('Address not found'), { status: 404 });

  return transaction(() => {
    db.prepare('UPDATE addresses SET is_default = 0 WHERE user_id = ?').run(userId);
    db.prepare('UPDATE addresses SET is_default = 1 WHERE id = ?').run(id);
    return getAddress(id, userId);
  });
}

/* -------------------------- razorpay payments ------------------------ */

/**
 * Records the Razorpay order the browser checkout will be opened against.
 *
 * Stored before the shopper is sent to Razorpay, so the webhook — which may
 * arrive before the browser comes back, or instead of it — can always find the
 * order it belongs to.
 */
export function attachRazorpayOrder(orderId, razorpayOrderId) {
  db.prepare(
    `UPDATE payments SET razorpay_order_id = ?, provider = 'razorpay',
       updated_at = datetime('now') WHERE order_id = ?`,
  ).run(razorpayOrderId, orderId);
  return getPaymentForOrder(orderId);
}

export function attachPaymentLink(orderId, { id, url }) {
  db.prepare(
    `UPDATE payments SET payment_link_id = ?, payment_link_url = ?, provider = 'razorpay',
       updated_at = datetime('now') WHERE order_id = ?`,
  ).run(id ?? null, url ?? null, orderId);
  return getPaymentForOrder(orderId);
}

/** Finds the order a Razorpay webhook is talking about. */
export function orderByRazorpayOrderId(razorpayOrderId) {
  const row = db
    .prepare('SELECT order_id FROM payments WHERE razorpay_order_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(razorpayOrderId);
  return row ? getOrder(row.order_id) : null;
}

export function orderByPaymentLinkId(linkId) {
  const row = db
    .prepare('SELECT order_id FROM payments WHERE payment_link_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(linkId);
  return row ? getOrder(row.order_id) : null;
}

/**
 * Settles an order as paid from a verified Razorpay payment.
 *
 * Deliberately idempotent. The browser callback and the webhook describe the
 * same payment and routinely both arrive; capturing twice would be harmless for
 * status but would fire any downstream side effect twice, so an already-paid
 * order short-circuits instead.
 */
export function settleRazorpayPayment(orderId, details) {
  const order = getOrder(orderId);
  if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
  if (order.status === 'paid') return { ok: true, order, alreadyPaid: true };

  return {
    ok: true,
    alreadyPaid: false,
    order: capturePayment(orderId, { ...details, provider: 'razorpay' }),
  };
}

/* --------------------------- cart ownership -------------------------- */

/**
 * The cart a signed-in shopper is currently filling.
 *
 * Exists so the chat assistant and the browser tab operate on *one* cart. The
 * agent has no access to localStorage, so without this it would call
 * `createCart()` and quietly fill a second cart the shopper never sees — the
 * item really was added, just not to the bag on screen.
 *
 * Picks the most recently touched cart rather than creating eagerly, so a
 * shopper with an abandoned cart from last week continues the current one.
 */
export function activeCartForUser(userId) {
  // Ordered so a cart with something in it always wins. `datetime('now')` has
  // one-second granularity, so several carts touched in the same second tie on
  // timestamp — and picking the empty one would strand the shopper's items.
  // `rowid` breaks any remaining tie deterministically.
  const row = db
    .prepare(`
      SELECT c.id
        FROM carts c
        LEFT JOIN cart_items ci ON ci.cart_id = c.id
       WHERE c.user_id = ?
       GROUP BY c.id
       ORDER BY (COUNT(ci.id) > 0) DESC, c.updated_at DESC, c.rowid DESC
       LIMIT 1
    `)
    .get(userId);
  return row ? getCart(row.id) : null;
}

/** The shopper's cart, creating one bound to them if they have none. */
export function ensureCartForUser(userId) {
  return activeCartForUser(userId) || createCart(userId);
}

/**
 * Binds an existing (anonymous) cart to a user.
 *
 * A shopper who fills a bag and *then* signs in should keep it — and from that
 * moment the assistant can see it too. Refuses to steal a cart already owned by
 * somebody else.
 */
export function claimCart(cartId, userId) {
  const cart = db.prepare('SELECT id, user_id FROM carts WHERE id = ?').get(cartId);
  if (!cart) throw Object.assign(new Error('Cart not found'), { status: 404 });
  if (cart.user_id && cart.user_id !== userId) {
    throw Object.assign(new Error('That cart belongs to a different account'), { status: 403 });
  }
  db.prepare(`UPDATE carts SET user_id = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(userId, cartId);
  return getCart(cartId);
}
