#!/usr/bin/env node
/**
 * Exercises the Razorpay paths that decide whether money is real: signature
 * verification and webhook settlement.
 *
 * Runs without a Razorpay account. Every check here is either pure HMAC
 * arithmetic or a webhook this script signs itself with the same secret the
 * server holds — which is exactly what Razorpay does, so the code under test
 * cannot tell the difference. What it deliberately does *not* cover is calls
 * that leave the machine (creating an order or a payment link); those need real
 * keys and are the one part you should retest once yours are in.
 *
 * Usage:
 *   RAZORPAY_KEY_ID=rzp_test_x RAZORPAY_KEY_SECRET=s RAZORPAY_WEBHOOK_SECRET=w \
 *     node scripts/razorpay-smoke.mjs
 */

import { createHmac } from 'node:crypto';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TOKEN = 'demo-session-token-do-not-use-in-production';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  ok   ${label}`); }
  else { failed += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

const authed = (extra = {}) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${TOKEN}`,
  ...extra,
});

async function json(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: opts.headers || authed(),
    ...(opts.body && typeof opts.body !== 'string' ? { body: JSON.stringify(opts.body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Places a fresh unpaid order and returns it. */
async function placeOrder() {
  const cart = (await json('/api/cart', { method: 'POST' })).body.cart;
  // Shared with the browser now, so start from empty.
  await json(`/api/cart/${cart.id}`, { method: 'DELETE' });
  const products = (await json('/api/products?limit=1&inStock=true')).body;
  await json(`/api/cart/${cart.id}/items`, {
    method: 'POST', body: { productId: products.items[0].id, qty: 1 },
  });
  const addresses = (await json('/api/addresses')).body.items;
  const placed = await json('/api/orders', {
    method: 'POST', body: { cartId: cart.id, addressId: addresses[0].id },
  });
  return placed.body.order;
}

/** Signs a webhook exactly as Razorpay does: HMAC-SHA256 over the raw bytes. */
function signWebhook(rawBody) {
  return createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
}

function paymentCaptured({ razorpayOrderId, amount, paymentId = 'pay_TESTPAYMENT01' }) {
  return JSON.stringify({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: razorpayOrderId,
          amount,
          currency: 'INR',
          status: 'captured',
          method: 'upi',
          vpa: 'shopper@okhdfcbank',
        },
      },
    },
  });
}

console.log('\nrazorpay smoke test\n');

if (!WEBHOOK_SECRET || !KEY_SECRET) {
  console.log('  RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET must be set for this test.');
  console.log('  Any values work — the point is that this script and the server share them.\n');
  process.exit(2);
}

/* ------------------------- payment signature (pure) ----------------------- */

const { verifyPaymentSignature, verifyWebhookSignature } = await import('../server/src/razorpay.js');

const orderId = 'order_TESTORDER0001';
const paymentId = 'pay_TESTPAYMENT01';
const goodSig = createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');

check('a genuine payment signature verifies',
  verifyPaymentSignature({ orderId, paymentId, signature: goodSig }));
check('a tampered payment id is rejected',
  !verifyPaymentSignature({ orderId, paymentId: 'pay_ATTACKER', signature: goodSig }));
check('a tampered order id is rejected',
  !verifyPaymentSignature({ orderId: 'order_ATTACKER', paymentId, signature: goodSig }));
check('a missing signature is rejected',
  !verifyPaymentSignature({ orderId, paymentId, signature: '' }));
check('a signature of the wrong length is rejected (no throw)',
  !verifyPaymentSignature({ orderId, paymentId, signature: 'short' }));

const body = '{"event":"payment.captured"}';
check('a genuine webhook signature verifies',
  verifyWebhookSignature({ rawBody: body, signature: signWebhook(body) }));
check('a webhook signed over different bytes is rejected',
  !verifyWebhookSignature({ rawBody: '{"event":"payment.failed"}', signature: signWebhook(body) }));

/* ---------------------------- webhook endpoint ---------------------------- */

const unsigned = await fetch(`${BASE}/webhooks/razorpay`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"event":"payment.captured"}',
});
check('an unsigned webhook is refused', unsigned.status === 401, `HTTP ${unsigned.status}`);

const forged = await fetch(`${BASE}/webhooks/razorpay`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': 'deadbeef' },
  body: '{"event":"payment.captured"}',
});
check('a forged webhook signature is refused', forged.status === 401, `HTTP ${forged.status}`);

/* --------------------- webhook settles an unpaid order -------------------- */

const order = await placeOrder();
check('an order can be placed to a saved address', Boolean(order?.number), JSON.stringify(order).slice(0, 120));
check('it starts unpaid', order.status === 'pending_payment', order.status);

// Attach a Razorpay order id the way POST /payment-intent would.
const repo = await import('../server/src/repo.js');
const rzpOrderId = `order_TEST${Date.now()}`;
repo.attachRazorpayOrder(order.id, rzpOrderId);

const payload = paymentCaptured({ razorpayOrderId: rzpOrderId, amount: order.total });
const delivered = await fetch(`${BASE}/webhooks/razorpay`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signWebhook(payload) },
  body: payload,
});
check('a correctly signed webhook is accepted', delivered.status === 200, `HTTP ${delivered.status}`);

const afterWebhook = (await json(`/api/orders/${order.number}`)).body.order;
check('the webhook settles the order', afterWebhook.status === 'paid', afterWebhook.status);
check('the payment records the UPI method', afterWebhook.payment?.method === 'upi',
  JSON.stringify(afterWebhook.payment));
check('the razorpay payment id is stored for reconciliation',
  afterWebhook.payment?.razorpayPaymentId === 'pay_TESTPAYMENT01',
  JSON.stringify(afterWebhook.payment?.razorpayPaymentId));

// Delivered twice — Razorpay retries, and a retry must not double-settle.
const again = await fetch(`${BASE}/webhooks/razorpay`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signWebhook(payload) },
  body: payload,
});
check('a repeated delivery is accepted', again.status === 200, `HTTP ${again.status}`);
const afterReplay = (await json(`/api/orders/${order.number}`)).body.order;
check('settling twice is idempotent', afterReplay.status === 'paid', afterReplay.status);

/* ----------------------- underpayment is not settled ---------------------- */

const short = await placeOrder();
const shortRzpId = `order_SHORT${Date.now()}`;
repo.attachRazorpayOrder(short.id, shortRzpId);

const shortPayload = paymentCaptured({
  razorpayOrderId: shortRzpId,
  amount: Math.round(short.total / 2), // paid half
  paymentId: 'pay_SHORTPAYMENT',
});
await fetch(`${BASE}/webhooks/razorpay`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signWebhook(shortPayload) },
  body: shortPayload,
});
const afterShort = (await json(`/api/orders/${short.number}`)).body.order;
check('a webhook paying less than the total does NOT mark the order paid',
  afterShort.status !== 'paid', afterShort.status);

/* ------------------------ verify endpoint rejects junk -------------------- */

const junk = await json(`/api/orders/${short.number}/payment/verify`, {
  method: 'POST',
  body: { razorpayOrderId: shortRzpId, razorpayPaymentId: 'pay_FAKE', razorpaySignature: 'nope' },
});
check('the verify endpoint refuses an invalid signature', junk.status === 400, `HTTP ${junk.status}`);
const afterJunk = (await json(`/api/orders/${short.number}`)).body.order;
check('a refused verification leaves the order unpaid', afterJunk.status !== 'paid', afterJunk.status);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
