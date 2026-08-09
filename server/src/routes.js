/**
 * REST API. Every response is JSON except the image endpoint, which streams
 * PNG bytes out of the database.
 */

import { Router } from 'express';

import { attachUser, loginUser, logout, registerUser, requireUser } from './auth.js';
import * as repo from './repo.js';
import { tableCount } from './db.js';
import { listPaymentMethods, TEST_CARDS, tokenForCardNumber } from './mock-payments.js';
import * as razorpay from './razorpay.js';

export const api = Router();

api.use(attachUser);

/** Wraps async handlers so rejections reach the error middleware. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Loads `:id` into `req.order` and enforces ownership.
 *
 * Guest orders (no user_id) stay payable by whoever holds the number, which is
 * what makes guest checkout work at all; an order attached to an account is
 * only ever touchable by that account.
 */
function requireOrderAccess(req, res, next) {
  const order = repo.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.userId && order.userId !== req.user?.id) {
    return res.status(403).json({ error: 'That order belongs to a different account' });
  }
  req.order = order;
  return next();
}

/* ------------------------------ health ------------------------------ */

api.get('/health', (_req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    products: tableCount('products'),
    images: tableCount('product_images'),
    orders: tableCount('orders'),
    time: new Date().toISOString(),
  });
});

/* ----------------------------- products ----------------------------- */

api.get('/products', (req, res) => {
  const { q, category, sort, page, limit, minPrice, maxPrice } = req.query;
  res.json(
    repo.listProducts({
      q: q ? String(q).trim() : undefined,
      category: category ? String(category) : undefined,
      sort: sort ? String(sort) : undefined,
      page,
      limit,
      minPrice: minPrice ? Number(minPrice) : null,
      maxPrice: maxPrice ? Number(maxPrice) : null,
      featured: req.query.featured === 'true' ? true : undefined,
      inStock: req.query.inStock === 'true',
    }),
  );
});

api.get('/categories', (_req, res) => res.json({ items: repo.listCategories() }));

api.get('/products/:id', (req, res) => {
  const product = repo.getProduct(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  return res.json({
    product,
    related: repo.relatedProducts(req.params.id),
    reviews: repo.listReviews(req.params.id, { limit: 5 }),
    reviewSummary: repo.reviewSummary(req.params.id),
  });
});

/** Paged reviews, so the product page can go past the first five. */
api.get('/products/:id/reviews', (req, res) => {
  if (!repo.getProduct(req.params.id)) return res.status(404).json({ error: 'Product not found' });
  return res.json({
    ...repo.listReviews(req.params.id, req.query),
    summary: repo.reviewSummary(req.params.id),
  });
});

/**
 * Serves the rasterised PNG stored in `product_images`.
 * Content-addressed ETag + immutable caching, so repeat views hit the cache.
 */
api.get('/products/:id/image', (req, res) => {
  const size = Number(req.query.size) || 800;
  const row = repo.getImage(req.params.id, size);
  if (!row) return res.status(404).json({ error: 'Image not found' });

  const etag = `"${row.hash}"`;
  res.set({
    'Content-Type': row.mime,
    'Cache-Control': 'public, max-age=31536000, immutable',
    ETag: etag,
    'X-Image-Source': 'sqlite:product_images',
    'X-Image-Size': String(row.size),
  });

  if (req.get('if-none-match') === etag) return res.status(304).end();
  return res.send(Buffer.from(row.data));
});

/* ------------------------------- cart ------------------------------- */

/**
 * Opens a cart.
 *
 * A signed-in shopper gets their existing one rather than a new one every time
 * the tab loses its localStorage id. Minting a second cart per visit is what
 * let the assistant and the browser drift onto different carts in the first
 * place — one shopper, one cart.
 */
api.post('/cart', (req, res) => {
  const cart = req.user ? repo.ensureCartForUser(req.user.id) : repo.createCart(null);
  res.status(201).json({ cart });
});

/**
 * Binds an anonymous cart to the signed-in shopper.
 *
 * Called by the browser right after sign-in so the bag someone filled as a
 * guest survives — and, from that point, so the chat assistant is looking at
 * the same cart rather than quietly starting its own.
 */
api.post('/cart/:id/claim', requireUser, wrap((req, res) => {
  res.json({ cart: repo.claimCart(req.params.id, req.user.id) });
}));

api.get('/cart/:id', (req, res) => {
  const cart = repo.getCart(req.params.id);
  if (!cart) return res.status(404).json({ error: 'Cart not found' });
  return res.json({ cart });
});

api.post('/cart/:id/items', (req, res) => {
  if (!repo.cartExists(req.params.id)) return res.status(404).json({ error: 'Cart not found' });

  const { productId } = req.body || {};
  const qty = Math.max(Number(req.body?.qty) || 1, 1);
  if (!productId) return res.status(400).json({ error: 'productId is required' });

  return res.status(201).json({ cart: repo.addToCart(req.params.id, productId, qty) });
});

api.patch('/cart/:id/items/:itemId', (req, res) => {
  if (!repo.cartExists(req.params.id)) return res.status(404).json({ error: 'Cart not found' });

  const qty = Number(req.body?.qty);
  if (!Number.isFinite(qty)) return res.status(400).json({ error: 'qty must be a number' });

  return res.json({ cart: repo.updateCartItem(req.params.id, Number(req.params.itemId), qty) });
});

api.delete('/cart/:id/items/:itemId', (req, res) => {
  if (!repo.cartExists(req.params.id)) return res.status(404).json({ error: 'Cart not found' });
  res.json({ cart: repo.removeCartItem(req.params.id, Number(req.params.itemId)) });
});

api.delete('/cart/:id', (req, res) => {
  if (!repo.cartExists(req.params.id)) return res.status(404).json({ error: 'Cart not found' });
  res.json({ cart: repo.clearCart(req.params.id) });
});

/* ------------------------------ orders ------------------------------ */

api.post('/orders', (req, res) => {
  const { cartId, email, name, address, addressId, saveAddress } = req.body || {};
  if (!cartId) return res.status(400).json({ error: 'cartId is required' });

  const finalEmail = email || req.user?.email;
  if (!finalEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(finalEmail)) {
    return res.status(400).json({ error: 'A valid email is required' });
  }

  // A saved address is resolved server-side from the id. The client never
  // sends the address back for one it already saved, so a tampered payload
  // cannot ship someone else's order to a new destination.
  let shipTo = address;
  let usedAddressId = null;

  if (addressId) {
    if (!req.user) return res.status(401).json({ error: 'Sign in to use a saved address' });
    const saved = repo.getAddress(addressId, req.user.id);
    if (!saved) return res.status(404).json({ error: 'Address not found' });
    shipTo = saved;
    usedAddressId = saved.id;
  }

  const customer = name || shipTo?.name || req.user?.name;
  if (!customer) return res.status(400).json({ error: 'name is required' });

  if (!usedAddressId) {
    const invalid = repo.validateAddress({ ...shipTo, name: customer });
    if (invalid) return res.status(400).json({ error: `address: ${invalid}` });
  }

  // "Save this for next time" — best effort. A duplicate or invalid address
  // must never cost the shopper the order they just placed, so a failure here
  // is swallowed rather than surfaced.
  if (saveAddress && req.user && !usedAddressId) {
    try {
      const created = repo.createAddress(req.user.id, { ...shipTo, name: customer });
      usedAddressId = created.id;
    } catch { /* keep going: the order matters more than the address book */ }
  }

  const order = repo.createOrder({
    cartId,
    email: finalEmail,
    customer,
    address: shipTo,
    userId: req.user?.id ?? null,
    addressId: usedAddressId,
  });
  return res.status(201).json({ order });
});

/* ---------------------------- addresses ----------------------------- */

api.get('/addresses', requireUser, (req, res) => {
  res.json({ items: repo.listAddresses(req.user.id) });
});

api.post('/addresses', requireUser, wrap((req, res) => {
  res.status(201).json({ address: repo.createAddress(req.user.id, req.body || {}) });
}));

api.patch('/addresses/:id', requireUser, wrap((req, res) => {
  res.json({ address: repo.updateAddress(req.params.id, req.user.id, req.body || {}) });
}));

api.delete('/addresses/:id', requireUser, wrap((req, res) => {
  res.json(repo.deleteAddress(req.params.id, req.user.id));
}));

api.post('/addresses/:id/default', requireUser, wrap((req, res) => {
  res.json({ address: repo.setDefaultAddress(req.params.id, req.user.id) });
}));

api.get('/orders', requireUser, (req, res) => {
  res.json({ items: repo.listOrdersForUser(req.user.id) });
});

/**
 * What the checkout should render.
 *
 * The browser asks this before drawing anything, so a shop with Razorpay keys
 * gets the real gateway and one without falls back to the simulated card form
 * — without the frontend needing to know which is configured.
 */
api.get('/payment-methods', (_req, res) => {
  res.json({
    provider: razorpay.isConfigured() ? 'razorpay' : 'mock',
    // Sandbox runs the Razorpay flow with the wire cut, so the checkout page
    // renders its own instrument picker instead of loading Razorpay's modal.
    simulated: razorpay.isSimulated(),
    currency: razorpay.CURRENCY,
    razorpayKeyId: razorpay.isConfigured() ? razorpay.KEY_ID : null,
    items: listPaymentMethods(),
    testCards: TEST_CARDS,
  });
});

/**
 * Sandbox stand-in for paying in the Razorpay modal.
 *
 * Mints a real signature over a synthetic payment and then goes through
 * `/payment/verify` logic unchanged — so this proves the verification path,
 * not a bypass of it. Available only when RAZORPAY_SIMULATE is on.
 */
api.post('/orders/:id/payment/simulate', requireOrderAccess, wrap(async (req, res) => {
  if (!razorpay.isSimulated()) {
    return res.status(404).json({ error: 'Sandbox payments are not enabled on this server.' });
  }

  const order = req.order;
  if (order.status === 'paid') {
    return res.status(409).json({ error: `Order ${order.number} is already paid` });
  }

  const outcome = req.body?.outcome === 'fail' ? 'fail' : 'pass';
  const method = ['upi', 'card', 'netbanking', 'wallet'].includes(req.body?.method)
    ? req.body.method
    : 'upi';

  // A Razorpay order id is needed either way — the browser would already have
  // one from /payment-intent, but a sandbox caller may come straight here.
  let razorpayOrderId = order.payment?.razorpayOrderId;
  if (!razorpayOrderId) {
    const created = await razorpay.createOrder({ amount: order.total, receipt: order.number });
    razorpayOrderId = created.id;
    repo.attachRazorpayOrder(order.id, razorpayOrderId);
  }

  const paymentId = `pay_sim${outcome === 'fail' ? 'fail' : 'ok'}${Date.now().toString(36)}`;
  const signature = razorpay.simulateCheckoutSignature(razorpayOrderId, paymentId);

  const valid = razorpay.verifyPaymentSignature({
    orderId: razorpayOrderId, paymentId, signature,
  });
  if (!valid) {
    // Would mean the sandbox and the verifier disagree about the secret, which
    // is worth failing loudly rather than papering over.
    return res.status(500).json({ error: 'Sandbox signature failed verification.' });
  }

  const payment = await razorpay.fetchPayment(paymentId, { amount: order.total, method });

  if (payment.status !== 'captured' && payment.status !== 'authorized') {
    const failure = razorpay.describeFailure(payment);
    const failed = repo.failPayment(order.id, {
      ...failure, provider: 'razorpay', method: payment.method, razorpayPaymentId: paymentId,
    });
    return res.status(402).json({ ok: false, order: failed, error: failure });
  }

  const settled = repo.settleRazorpayPayment(order.id, {
    ...razorpay.describePayment(payment),
    razorpayOrderId,
    razorpayPaymentId: paymentId,
    razorpaySignature: signature,
  });

  return res.json({ ok: true, order: settled.order, alreadyPaid: settled.alreadyPaid });
}));

/**
 * Opens a payment attempt: creates the Razorpay order the browser checkout is
 * mounted on and hands back everything the modal needs.
 *
 * Only the key id goes to the browser — never the secret, which is what signs
 * and verifies. A fresh Razorpay order is created per attempt so a shopper who
 * abandons the modal and comes back is not blocked by a stale one.
 */
api.post('/orders/:id/payment-intent', requireOrderAccess, wrap(async (req, res) => {
  const order = req.order;

  if (order.status === 'paid') {
    return res.status(409).json({ error: `Order ${order.number} is already paid` });
  }
  if (!razorpay.isConfigured()) {
    return res.status(503).json({
      error: 'Razorpay is not configured on this server.',
      hint: 'Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in server/.env, or pay with the simulated processor via POST /orders/:id/pay.',
    });
  }

  const rzpOrder = await razorpay.createOrder({
    amount: order.total,
    receipt: order.number,
    notes: { orderNumber: order.number, shopOrderId: order.id },
  });

  repo.attachRazorpayOrder(order.id, rzpOrder.id);

  return res.json({
    keyId: razorpay.KEY_ID,
    razorpayOrderId: rzpOrder.id,
    amount: rzpOrder.amount,
    currency: rzpOrder.currency,
    orderNumber: order.number,
    customer: { name: order.customer, email: order.email, phone: order.address?.phone || '' },
  });
}));

/**
 * Completes a payment from what Razorpay Checkout handed the browser.
 *
 * The signature check is the whole security of this endpoint: these three
 * values arrive through the shopper's own browser, so until the HMAC matches
 * they are simply numbers a caller typed. A mismatch is a 400 and the order
 * stays unpaid.
 */
api.post('/orders/:id/payment/verify', requireOrderAccess, wrap(async (req, res) => {
  const order = req.order;
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body || {};

  const valid = razorpay.verifyPaymentSignature({
    orderId: razorpayOrderId,
    paymentId: razorpayPaymentId,
    signature: razorpaySignature,
  });

  if (!valid) {
    return res.status(400).json({
      error: 'Payment signature verification failed. The order has not been marked paid.',
    });
  }

  // Verified — now ask Razorpay what actually happened rather than trusting the
  // browser's word for the method, amount or status.
  const payment = await razorpay.fetchPayment(razorpayPaymentId);

  if (payment.amount !== order.total) {
    return res.status(400).json({
      error: 'Paid amount does not match the order total.',
    });
  }

  if (payment.status !== 'captured' && payment.status !== 'authorized') {
    const failure = razorpay.describeFailure(payment);
    const failed = repo.failPayment(order.id, {
      ...failure, provider: 'razorpay', method: payment.method, razorpayPaymentId,
    });
    return res.status(402).json({ ok: false, order: failed, error: failure });
  }

  const settled = repo.settleRazorpayPayment(order.id, {
    ...razorpay.describePayment(payment),
    razorpayOrderId,
    razorpayPaymentId,
    razorpaySignature,
  });

  return res.json({ ok: true, order: settled.order, alreadyPaid: settled.alreadyPaid });
}));

/**
 * Pay for an order with the simulated processor.
 *
 * Still the path used when Razorpay is unconfigured, and the one the tests
 * drive — the outcome is decided by the token, so every branch is reproducible
 * without a network call.
 */
api.post('/orders/:id/pay', requireOrderAccess, (req, res) => {
  const order = req.order;

  const { paymentMethod, cardNumber } = req.body || {};
  const token = paymentMethod || tokenForCardNumber(cardNumber);
  if (!token) {
    return res.status(400).json({
      error: 'paymentMethod (or a demo cardNumber) is required',
      hint: 'GET /api/payment-methods lists the accepted tokens and test cards.',
    });
  }

  const result = repo.payOrder(order.id, token);
  // A decline is a real outcome, not a transport failure: 402 with the order
  // attached, so the caller can show status without a second request.
  return res.status(result.ok ? 200 : 402).json(result);
});

api.get('/orders/:id', (req, res) => {
  const order = repo.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  return res.json({ order });
});

/* ------------------------------- auth ------------------------------- */

api.post('/auth/register', wrap((req, res) => {
  const { email, name, password } = req.body || {};
  res.status(201).json(registerUser({ email, name, password }));
}));

api.post('/auth/login', wrap((req, res) => {
  const { email, password } = req.body || {};
  res.json(loginUser({ email, password }));
}));

api.post('/auth/logout', (req, res) => {
  logout(req.token);
  res.json({ ok: true });
});

api.get('/auth/me', requireUser, (req, res) => res.json({ user: req.user }));
