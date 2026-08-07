#!/usr/bin/env node
/**
 * Drives one real payment through the live Razorpay test account, end to end,
 * and waits for the webhook to settle it.
 *
 * Places a real order in the shop, creates a real Razorpay payment link for it,
 * prints the link, then polls until the order stops being `pending_payment`.
 * Whether it passes or fails is decided by what you enter on Razorpay's page —
 * see the table it prints — so the same command exercises both branches.
 *
 * This is the check that cannot be faked locally: it proves the webhook is
 * registered on the right URL, that its secret matches, and that a payment made
 * on Razorpay's own page reaches this server and settles the order.
 *
 * Usage:
 *   npm run razorpay:drive           # expect success
 *   npm run razorpay:drive -- --fail # expect failure
 */

import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TOKEN = 'demo-session-token-do-not-use-in-production';
const WANT_FAILURE = process.argv.includes('--fail');
const TIMEOUT_MS = 5 * 60_000;

const KEY_ID = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

if (!KEY_ID || !KEY_SECRET) {
  console.error('\nRAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set — nothing to drive.\n');
  process.exit(2);
}

const authed = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };

async function shop(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: authed,
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

const rupees = (paise) => `₹${(paise / 100).toLocaleString('en-IN')}`;

/* ------------------------------- place an order ------------------------- */

console.log('\nrazorpay drive — real payment against the test account\n');

const { cart } = await shop('/api/cart', { method: 'POST' });
const { items: products } = await shop('/api/products?limit=1&inStock=true');
const product = products[0];
await shop(`/api/cart/${cart.id}/items`, {
  method: 'POST', body: { productId: product.id, qty: 1 },
});

const { items: addresses } = await shop('/api/addresses');
if (!addresses.length) {
  console.error('The demo account has no saved address. Start the server once to seed one.');
  process.exit(1);
}

const { order } = await shop('/api/orders', {
  method: 'POST', body: { cartId: cart.id, addressId: addresses[0].id },
});

console.log(`  order      ${order.number}`);
console.log(`  item       ${product.name}`);
console.log(`  total      ${rupees(order.total)}  (incl. GST ${rupees(order.tax)})`);
console.log(`  ship to    ${addresses[0].city}, ${addresses[0].state} ${addresses[0].postcode}`);
console.log(`  status     ${order.status}`);

/* ---------------------------- create a payment link --------------------- */

const auth = 'Basic ' + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');

const linkRes = await fetch('https://api.razorpay.com/v1/payment_links', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    amount: order.total,
    currency: 'INR',
    description: `Cheela order ${order.number}`,
    reference_id: `${order.number}-${Date.now()}`,
    customer: {
      name: order.customer,
      email: order.email,
      contact: addresses[0].phone || undefined,
    },
    notify: { sms: false, email: false },
    reminder_enable: false,
  }),
});

const link = await linkRes.json();
if (!linkRes.ok) {
  console.error('\nCould not create the payment link:', JSON.stringify(link));
  process.exit(1);
}

// Record it so the payment_link.paid webhook can find this order.
const repo = await import('../server/src/repo.js');
repo.attachPaymentLink(order.id, { id: link.id, url: link.short_url });

console.log(`\n  PAY HERE   ${link.short_url}\n`);

if (WANT_FAILURE) {
  console.log('  To make it FAIL:');
  console.log('    UPI   — enter  failure@razorpay');
  console.log('    Card  — any test card, then an OTP of fewer than 4 digits');
} else {
  console.log('  To make it PASS:');
  console.log('    UPI   — enter  success@razorpay');
  console.log('    Card  — any test card, then an OTP of 4-10 digits');
}

console.log(`\n  waiting up to ${TIMEOUT_MS / 60000} minutes for the webhook…\n`);

/* ------------------------------- wait for it ---------------------------- */

const started = Date.now();
let final = null;

while (Date.now() - started < TIMEOUT_MS) {
  await sleep(3000);
  const { order: current } = await shop(`/api/orders/${order.number}`);
  if (current.status !== 'pending_payment') { final = current; break; }
  process.stdout.write('.');
}

console.log('\n');

if (!final) {
  console.log('  timed out — the order is still pending_payment.');
  console.log('  If you did pay, the webhook did not arrive. Check that the URL registered in');
  console.log('  Razorpay matches this tunnel and that RAZORPAY_WEBHOOK_SECRET matches too.\n');
  process.exit(1);
}

const p = final.payment || {};
console.log(`  status     ${final.status}`);
console.log(`  provider   ${p.provider}`);
console.log(`  method     ${p.method}${p.vpa ? ` (${p.vpa})` : ''}${p.brand ? ` (${p.brand})` : ''}`);
if (p.razorpayPaymentId) console.log(`  payment id ${p.razorpayPaymentId}`);
if (p.failureMessage) console.log(`  reason     ${p.failureMessage}`);

const settledOk = final.status === 'paid';
const expected = WANT_FAILURE ? !settledOk : settledOk;

console.log(`\n  ${expected ? 'as expected' : 'NOT what was expected'} — ` +
  `wanted ${WANT_FAILURE ? 'failure' : 'success'}, got ${final.status}\n`);

process.exit(expected ? 0 : 1);
