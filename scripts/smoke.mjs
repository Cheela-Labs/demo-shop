#!/usr/bin/env node
/**
 * End-to-end API check against a running server.
 * Usage: npm run smoke   (API_URL overrides the default localhost:4000)
 */

const BASE = process.env.API_URL || 'http://localhost:4000';

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function json(path, options = {}) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : {} };
}

console.log(`\nsmoke test → ${BASE}\n`);

// --- catalogue ---------------------------------------------------------
const health = await json('/api/health');
check('health responds', health.status === 200 && health.body.ok);
check('products are seeded', health.body.products > 0, `got ${health.body.products}`);
check('images are stored in the db', health.body.images > 0, `got ${health.body.images}`);

const all = await json('/api/products?limit=100');
check('product list returns items', all.body.items.length > 0);

const search = await json('/api/products?q=headphones');
check('search filters results', search.body.items.length > 0 && search.body.items.length < all.body.total);

const sorted = await json('/api/products?sort=price-asc&limit=5');
const prices = sorted.body.items.map((p) => p.price);
check('sorting works', prices.every((p, i) => i === 0 || prices[i - 1] <= p), prices.join(','));

const cats = await json('/api/categories');
check('categories are listed', cats.body.items.length > 0);

const missing = await json('/api/products/does-not-exist');
check('unknown product 404s', missing.status === 404);

// --- images ------------------------------------------------------------
const sample = all.body.items[0];
const img = await fetch(`${BASE}/api/products/${sample.id}/image?size=800`);
const bytes = Buffer.from(await img.arrayBuffer());
const isPng = bytes[0] === 0x89 && bytes.toString('latin1', 1, 4) === 'PNG';
check('image endpoint serves PNG bytes', img.status === 200 && isPng);
check('image is served from sqlite', img.headers.get('x-image-source') === 'sqlite:product_images');
check('image sets an immutable cache header', /immutable/.test(img.headers.get('cache-control') || ''));

const etag = img.headers.get('etag');
const revalidated = await fetch(`${BASE}/api/products/${sample.id}/image?size=800`, {
  headers: { 'If-None-Match': etag },
});
check('image revalidates with 304', revalidated.status === 304);

const small = await fetch(`${BASE}/api/products/${sample.id}/image?size=400`);
check('multiple sizes are available', small.status === 200);

// --- cart --------------------------------------------------------------
const created = await json('/api/cart', { method: 'POST' });
const cartId = created.body.cart.id;
check('cart is created', created.status === 201 && Boolean(cartId));

const added = await json(`/api/cart/${cartId}/items`, {
  method: 'POST',
  body: { productId: sample.id, qty: 2 },
});
check('item is added to cart', added.body.cart.count === 2);
check('line total is correct', added.body.cart.items[0].lineTotal === sample.price * 2);

const itemId = added.body.cart.items[0].itemId;
const bumped = await json(`/api/cart/${cartId}/items/${itemId}`, { method: 'PATCH', body: { qty: 3 } });
check('quantity updates', bumped.body.cart.count === 3);

const second = all.body.items[1];
const twoItems = await json(`/api/cart/${cartId}/items`, {
  method: 'POST',
  body: { productId: second.id, qty: 1 },
});
check('a second product can be added', twoItems.body.cart.items.length === 2);

const expectedSubtotal = sample.price * 3 + second.price;
check('subtotal adds up', twoItems.body.cart.subtotal === expectedSubtotal,
  `${twoItems.body.cart.subtotal} vs ${expectedSubtotal}`);
check('GST is 18% of subtotal', twoItems.body.cart.tax === Math.round(expectedSubtotal * 0.18));

const overStock = await json(`/api/cart/${cartId}/items`, {
  method: 'POST',
  body: { productId: sample.id, qty: 99999 },
});
check('stock limit is enforced', overStock.status === 409);

const removed = await json(`/api/cart/${cartId}/items/${itemId}`, { method: 'DELETE' });
check('item is removed', removed.body.cart.items.length === 1);

// --- auth --------------------------------------------------------------
const email = `smoke-${Date.now()}@example.com`;
const registered = await json('/api/auth/register', {
  method: 'POST',
  body: { email, name: 'Smoke Tester', password: 'hunter2hunter2' },
});
check('register returns a token', registered.status === 201 && Boolean(registered.body.token));

const token = registered.body.token;
const auth = { Authorization: `Bearer ${token}` };

const me = await json('/api/auth/me', { headers: auth });
check('token identifies the user', me.body.user?.email === email);

const noAuth = await json('/api/auth/me');
check('protected route rejects anonymous', noAuth.status === 401);

const dupe = await json('/api/auth/register', {
  method: 'POST',
  body: { email, name: 'Dupe', password: 'hunter2hunter2' },
});
check('duplicate email is rejected', dupe.status === 409);

const badLogin = await json('/api/auth/login', { method: 'POST', body: { email, password: 'wrong-password' } });
check('wrong password is rejected', badLogin.status === 401);

const goodLogin = await json('/api/auth/login', { method: 'POST', body: { email, password: 'hunter2hunter2' } });
check('correct password logs in', goodLogin.status === 200 && Boolean(goodLogin.body.token));

const shortPw = await json('/api/auth/register', {
  method: 'POST',
  body: { email: `x-${Date.now()}@example.com`, name: 'X', password: 'short' },
});
check('short password is rejected', shortPw.status === 400);

// --- checkout ----------------------------------------------------------
const stockBefore = (await json(`/api/products/${second.id}`)).body.product.stock;

const order = await json('/api/orders', {
  method: 'POST',
  headers: auth,
  body: {
    cartId,
    email,
    name: 'Smoke Tester',
    address: { line1: '1 Test Way', city: 'Testville', state: 'Maharashtra', postcode: '400001', country: 'India' },
  },
});
check('order is placed', order.status === 201 && Boolean(order.body.order.number));
check('order starts unpaid', order.body.order.status === 'pending_payment');
check('a payment awaits a method', order.body.order.payment?.status === 'requires_payment');
check('order total matches cart', order.body.order.total === removed.body.cart.total);

const stockAfter = (await json(`/api/products/${second.id}`)).body.product.stock;
check('stock is decremented', stockAfter === stockBefore - 1, `${stockBefore} → ${stockAfter}`);

const emptied = await json(`/api/cart/${cartId}`);
check('cart is emptied after checkout', emptied.body.cart.items.length === 0);

const fetched = await json(`/api/orders/${order.body.order.number}`);
check('order is retrievable by number', fetched.body.order.id === order.body.order.id);

const history = await json('/api/orders', { headers: auth });
check('order appears in user history', history.body.items.some((o) => o.id === order.body.order.id));

const emptyOrder = await json('/api/orders', {
  method: 'POST',
  body: {
    cartId,
    email,
    name: 'Smoke Tester',
    address: { line1: '1 Test Way', city: 'Testville', state: 'Maharashtra', postcode: '400001' },
  },
});
check('empty cart cannot be ordered', emptyOrder.status === 400);

const badAddress = await json('/api/orders', {
  method: 'POST',
  body: { cartId, email, name: 'Smoke Tester', address: { line1: '1 Test Way' } },
});
check('incomplete address is rejected', badAddress.status === 400);

// --- payments ----------------------------------------------------------
const methods = await json('/api/payment-methods');
check('payment methods are listed', methods.body.items.length >= 4);

const declined = await json(`/api/orders/${order.body.order.number}/pay`, {
  method: 'POST', headers: auth, body: { paymentMethod: 'pm_card_declined' },
});
check('a decline returns 402', declined.status === 402);
check('decline marks the order failed', declined.body.order.status === 'payment_failed');

const badToken = await json(`/api/orders/${order.body.order.number}/pay`, {
  method: 'POST', headers: auth, body: { paymentMethod: 'pm_nonsense' },
});
check('an unknown payment token is a 400, not a decline', badToken.status === 400);

const stillFailed = await json(`/api/orders/${order.body.order.number}`);
check('a bad token leaves the order untouched', stillFailed.body.order.status === 'payment_failed');

const paidRes = await json(`/api/orders/${order.body.order.number}/pay`, {
  method: 'POST', headers: auth, body: { cardNumber: '4242424242424242' },
});
check('paying with a test card succeeds', paidRes.status === 200 && paidRes.body.order.status === 'paid');
check('capture records the card', paidRes.body.order.payment.last4 === '4242');

const twice = await json(`/api/orders/${order.body.order.number}/pay`, {
  method: 'POST', headers: auth, body: { paymentMethod: 'pm_card_visa' },
});
check('paying an already-paid order is refused', twice.status === 409);

// --- logout ------------------------------------------------------------
await json('/api/auth/logout', { method: 'POST', headers: auth });
const afterLogout = await json('/api/auth/me', { headers: auth });
check('logout revokes the token', afterLogout.status === 401);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
