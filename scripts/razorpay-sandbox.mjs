#!/usr/bin/env node
/**
 * Drives both payment outcomes through the sandbox, with no network access to
 * Razorpay at all.
 *
 * What makes this worth trusting: the signatures are minted with the real
 * `RAZORPAY_KEY_SECRET` and then verified by the same `verifyPaymentSignature`
 * the live path uses, so nothing here is a bypass — only the outbound HTTP call
 * to Razorpay is replaced.
 *
 * Usage: npm run smoke:sandbox
 */

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TOKEN = 'demo-session-token-do-not-use-in-production';

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  ok   ${label}`); }
  else { failed += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };

async function shop(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts, headers,
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function placeOrder() {
  // POST /cart returns the signed-in shopper's existing cart, so empty it
  // first — these checks depend on knowing exactly what is in the order.
  const { body: cartBody } = await shop('/api/cart', { method: 'POST' });
  await shop(`/api/cart/${cartBody.cart.id}`, { method: 'DELETE' });
  const { body: products } = await shop('/api/products?limit=1&inStock=true');
  await shop(`/api/cart/${cartBody.cart.id}/items`, {
    method: 'POST', body: { productId: products.items[0].id, qty: 1 },
  });
  const { body: addr } = await shop('/api/addresses');
  const { body } = await shop('/api/orders', {
    method: 'POST', body: { cartId: cartBody.cart.id, addressId: addr.items[0].id },
  });
  return body.order;
}

const stockOf = async (id) => (await shop(`/api/products/${id}`)).body.product.stock;

console.log('\nrazorpay sandbox — pass and fail, no network to Razorpay\n');

const config = (await shop('/api/payment-methods')).body;
check('the shop reports sandbox mode', config.simulated === true, JSON.stringify(config.provider));

/* --------------------------------- pass ---------------------------------- */

const good = await placeOrder();
check('an order can be placed', good.status === 'pending_payment', good.status);

const paid = await shop(`/api/orders/${good.number}/payment/simulate`, {
  method: 'POST', body: { outcome: 'pass', method: 'upi' },
});
check('a successful sandbox payment returns ok', paid.status === 200 && paid.body.ok === true,
  `HTTP ${paid.status}`);
check('the order is marked paid', paid.body?.order?.status === 'paid', paid.body?.order?.status);
check('it records the UPI instrument', paid.body?.order?.payment?.method === 'upi',
  JSON.stringify(paid.body?.order?.payment?.method));
check('it stores a razorpay payment id', /^pay_sim/.test(paid.body?.order?.payment?.razorpayPaymentId || ''),
  paid.body?.order?.payment?.razorpayPaymentId);
check('the provider is razorpay, not mock', paid.body?.order?.payment?.provider === 'razorpay',
  paid.body?.order?.payment?.provider);

const payTwice = await shop(`/api/orders/${good.number}/payment/simulate`, {
  method: 'POST', body: { outcome: 'pass' },
});
check('paying an already-paid order is refused', payTwice.status === 409, `HTTP ${payTwice.status}`);

/* --------------------------------- fail ---------------------------------- */

const doomed = await placeOrder();
const productId = doomed.items[0].productId;
const stockWhileReserved = await stockOf(productId);

const declined = await shop(`/api/orders/${doomed.number}/payment/simulate`, {
  method: 'POST', body: { outcome: 'fail', method: 'card' },
});
check('a failed sandbox payment returns 402', declined.status === 402, `HTTP ${declined.status}`);
check('it is reported as a result, not thrown', declined.body?.ok === false);
check('the failure explains itself', Boolean(declined.body?.error?.message),
  JSON.stringify(declined.body?.error));
check('the order is marked payment_failed', declined.body?.order?.status === 'payment_failed',
  declined.body?.order?.status);

const stockAfterFailure = await stockOf(productId);
check('a failed payment releases the reserved stock', stockAfterFailure === stockWhileReserved + 1,
  `${stockWhileReserved} → ${stockAfterFailure}`);

/* ------------------------------ retry after fail ------------------------- */

const retried = await shop(`/api/orders/${doomed.number}/payment/simulate`, {
  method: 'POST', body: { outcome: 'pass', method: 'netbanking' },
});
check('a failed order can be retried successfully', retried.status === 200 && retried.body.ok === true,
  `HTTP ${retried.status}`);
check('the retry marks it paid', retried.body?.order?.status === 'paid', retried.body?.order?.status);

/* ----------------------------- still verifying --------------------------- */

// The verify endpoint must keep rejecting junk even in sandbox: sandbox
// replaces the network, not the security.
const forged = await shop(`/api/orders/${good.number}/payment/verify`, {
  method: 'POST',
  body: { razorpayOrderId: 'order_fake', razorpayPaymentId: 'pay_fake', razorpaySignature: 'nope' },
});
check('the verify endpoint still rejects a forged signature in sandbox', forged.status === 400,
  `HTTP ${forged.status}`);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
