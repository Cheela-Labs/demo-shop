#!/usr/bin/env node
/**
 * Exercises the Cheela capabilities the way an agent would: browse, inspect,
 * add to cart, place an order, pay for it, look it up again.
 *
 * Runs the runtime in-process, so it needs no server and no API key — but it
 * proves every input *and* output schema, because Runtime.execute() validates
 * both sides of each call. It also proves the auth boundary, by calling the
 * gated capabilities with no token, a bad token, and another shopper's order.
 *
 * Usage: npm run smoke:cheela
 */

import runtime from '../server/.cheela/runtime.ts';
import { DEMO_ACCOUNT } from '../server/src/seed.js';
import { registerUser } from '../server/src/auth.js';
import * as repo from '../server/src/repo.js';

/** Settles an order the way a verified Razorpay webhook would. */
function repoSettle(orderNumber) {
  const o = repo.getOrder(orderNumber);
  return repo.settleRazorpayPayment(o.id, {
    method: 'upi', vpa: 'success@razorpay', razorpayPaymentId: 'pay_smoke',
  }).order;
}

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

/** Anonymous call — no end-user credential. */
async function call(name, input = {}) {
  const { output } = await runtime.execute(name, input);
  return output;
}

/** Signed-in call, the way Cheela invokes a `requiresEndUser` capability. */
async function callAs(token, name, input = {}) {
  const { output } = await runtime.execute(name, input, { endUserToken: token });
  return output;
}

async function expectFailure(label, fn, matcher) {
  try {
    await fn();
    check(label, false, 'expected it to throw');
  } catch (err) {
    check(label, matcher ? matcher.test(err.message) : true, err.message);
  }
}

console.log('\ncheela capability smoke test\n');

const TOKEN = DEMO_ACCOUNT.token;

// --- naming + declaration ----------------------------------------------
// The rule the SDK enforces: hyphens only. Dots are rejected by LLM
// tool-calling APIs, underscores by the Agent Discovery Specification.
const caps = runtime.getCapabilities();
const badNames = caps.map((c) => c.name).filter((n) => !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(n));
check('every capability name is valid for both LLM tools and ADS',
  badNames.length === 0, badNames.join(', '));

const gated = caps.filter((c) => c.requiresEndUser).map((c) => c.name).sort();
check('exactly the order and address capabilities require an end user',
  JSON.stringify(gated) === JSON.stringify([
    'addresses-list', 'checkout-pay-order', 'checkout-place-order',
    'orders-get-order', 'orders-list',
  ]), gated.join(', '));

// --- browsing stays anonymous ------------------------------------------
const search = await call('catalog-search-products', { query: 'wireless' });
check('anonymous browsing works', search.items.length > 0);
check('prices are preformatted in rupees', /^₹[\d,]/.test(search.items[0].price));

const cats = await call('catalog-list-categories');
check('categories are listed', cats.categories.length > 0);

const target = search.items[0];
const detail = await call('catalog-get-product', { productId: target.id });
check('product detail includes specs', Object.keys(detail.product.specs).length > 0);
await expectFailure('unknown product id is rejected', () => call('catalog-get-product', { productId: 'nope' }));

const methods = await call('store-list-payment-methods');
check('payment methods are advertised', methods.methods.length >= 4);
check('payment methods are labelled simulated', /simulated/i.test(methods.note));

// --- the auth boundary --------------------------------------------------
await expectFailure('placing an order with no credential is refused',
  () => call('checkout-place-order', { cartId: 'x', addressLine1: '1 St', city: 'X', state: 'Goa', postcode: '400001' }),
  /requires an authenticated end user/);

await expectFailure('reading orders with no credential is refused',
  () => call('orders-list', {}), /requires an authenticated end user/);

await expectFailure('an invalid token is refused',
  () => callAs('not-a-real-token', 'orders-list', {}), /expired or is not valid/);

// --- cart (anonymous) ---------------------------------------------------
const opened = await call('cart-add-item', { productId: target.id, quantity: 2 });
check('cart is created implicitly', Boolean(opened.cartId));
check('item lands in the cart', opened.itemCount === 2);

const cartId = opened.cartId;
const viewed = await call('cart-view', { cartId });
check('cart-view agrees with the write', viewed.totalCents === opened.totalCents);

const bumped = await call('cart-update-item', { cartId, itemId: viewed.items[0].itemId, quantity: 1 });
check('quantity updates', bumped.items[0].quantity === 1);
await expectFailure('over-stock add is refused',
  () => call('cart-add-item', { cartId, productId: target.id, quantity: 99999 }));

// --- place an order (signed in) -----------------------------------------
const stockBefore = (await call('catalog-get-product', { productId: target.id })).product.stock;

const order = await callAs(TOKEN, 'checkout-place-order', {
  cartId, addressLine1: '1 Example Street', city: 'Testville', state: 'Maharashtra', postcode: '400001',
});
check('order is placed', /^CHL-/.test(order.orderNumber));
check('order starts unpaid', order.status === 'pending_payment' && order.paid === false);
check('payment awaits a method', order.payment.status === 'requires_payment');
check('next step tells the agent to pay', /checkout-pay-order/.test(order.nextStep));
check('identity comes from the credential, not input', order.email === DEMO_ACCOUNT.email);

const stockReserved = (await call('catalog-get-product', { productId: target.id })).product.stock;
check('stock is reserved at placement', stockReserved === stockBefore - 1, `${stockBefore} → ${stockReserved}`);

// --- payment ------------------------------------------------------------
//
// The agent's payment path depends on which processor is live, so this branches
// the same way the capability does. With Razorpay configured (including
// sandbox) an agent cannot charge anybody — it can only hand over a link — so
// asserting a decline/retry cycle there would be testing behaviour that no
// longer exists.
const { isConfigured: razorpayConfigured } = await import('../server/src/razorpay.js');
let paid;

if (razorpayConfigured()) {
  const link = await callAs(TOKEN, 'checkout-pay-order', { orderNumber: order.orderNumber });
  check('the agent gets a payment link rather than charging', typeof link.paymentUrl === 'string' && link.paymentUrl.length > 0,
    String(link.paymentUrl));
  check('the order stays unpaid until the shopper pays', link.paid === false, link.status);
  check('the agent is told to hand the link over', /link|pay/i.test(link.instruction), link.instruction);
  check('no card details are requested', !/card number|cvv|expiry/i.test(link.instruction));

  // Settle it the way the gateway would, so the rest of the script has a paid
  // order to read back.
  const settled = repoSettle(order.orderNumber);
  check('the order settles once payment completes', settled.status === 'paid', settled.status);
  paid = { totalCents: link.totalCents };
} else {
  const declined = await callAs(TOKEN, 'checkout-pay-order', {
    orderNumber: order.orderNumber, paymentMethod: 'pm_card_declined',
  });
  check('a decline is reported, not thrown', declined.paid === false);
  check('decline explains itself', /declined/i.test(declined.declineReason));
  check('order reflects the failed payment', declined.status === 'payment_failed');

  const stockRestored = (await call('catalog-get-product', { productId: target.id })).product.stock;
  check('declining releases the reserved stock', stockRestored === stockBefore,
    `${stockReserved} → ${stockRestored}`);

  await expectFailure('an unknown payment method is refused',
    () => callAs(TOKEN, 'checkout-pay-order', {
      orderNumber: order.orderNumber, paymentMethod: 'pm_not_real',
    }));

  paid = await callAs(TOKEN, 'checkout-pay-order', {
    orderNumber: order.orderNumber, paymentMethod: 'pm_card_visa',
  });
  check('retrying with a good method succeeds', paid.paid === true && paid.status === 'paid');
  check('captured payment records the card', paid.payment.status === 'captured' && paid.payment.last4 === '4242');
  check('no decline reason once paid', paid.declineReason === null);

  await expectFailure('paying twice is refused',
    () => callAs(TOKEN, 'checkout-pay-order', {
      orderNumber: order.orderNumber, paymentMethod: 'pm_card_visa',
    }), /already paid/);
}

// --- reading orders back -------------------------------------------------
const fetched = await callAs(TOKEN, 'orders-get-order', { orderNumber: order.orderNumber });
check('order is retrievable by its owner', fetched.totalCents === paid.totalCents);

const history = await callAs(TOKEN, 'orders-list', {});
check('order appears in history', history.orders.some((o) => o.orderNumber === order.orderNumber));

// --- cross-account isolation --------------------------------------------
const other = registerUser({
  email: `other-${Date.now()}@example.com`, name: 'Other Shopper', password: 'other-password-1234',
});

await expectFailure('another shopper cannot read this order',
  () => callAs(other.token, 'orders-get-order', { orderNumber: order.orderNumber }),
  /No order .* found on this account/);

await expectFailure('another shopper cannot pay this order',
  () => callAs(other.token, 'checkout-pay-order', {
    orderNumber: order.orderNumber, paymentMethod: 'pm_card_visa',
  }), /No order .* found on this account/);

const otherHistory = await callAs(other.token, 'orders-list', {});
check('a new shopper sees an empty history', otherHistory.total === 0);

// --- registry ------------------------------------------------------------
check('every capability has an input schema',
  runtime.getRegistrations().every((r) => Boolean(r.capability.input)));
check('every capability has a description',
  runtime.getRegistrations().every((r) => Boolean(r.capability.description)));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
