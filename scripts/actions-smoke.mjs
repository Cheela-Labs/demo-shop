/**
 * Runs a capability result through the same extractor the chat panel uses —
 * `renderActions` in @cheela/web-component calls exactly this — so we see what
 * the panel would actually render, not what we intended it to.
 */
import {
  extractActions, isSafeActionUrl, MAX_ACTIONS_PER_RESULT,
  extractPending, isSettled, MIN_POLL_INTERVAL_MS, MAX_POLL_TIMEOUT_MS,
} from '@cheela/protocol';
import runtime from '../server/.cheela/runtime.ts';
import * as repo from '../server/src/repo.js';
import { DEMO_ACCOUNT } from '../server/src/seed.js';

const TOKEN = DEMO_ACCOUNT.token;
const call = async (name, input = {}, tok) =>
  (await runtime.execute(name, input, tok ? { endUserToken: tok } : {})).output;

let pass = 0, fail = 0;
const check = (l, ok, d = '') => { ok ? (pass++, console.log(`  ok   ${l}`)) : (fail++, console.log(`  FAIL ${l}${d ? ' — ' + d : ''}`)); };

console.log('\nui actions — what the panel would render\n');

console.log(`  MAX_ACTIONS_PER_RESULT = ${MAX_ACTIONS_PER_RESULT}`);

// place an order to pay for
const search = await call('catalog-search-products', { query: 'wireless', limit: 1 });
const cart = await call('cart-add-item', { productId: search.items[0].id, quantity: 1 });
const addresses = await call('addresses-list', {}, TOKEN);
const order = await call('checkout-place-order',
  { cartId: cart.cartId, addressId: addresses.addresses[0].addressId }, TOKEN);

const placeActions = extractActions(order);
check('place-order renders an action', placeActions.length === 1, JSON.stringify(placeActions));
check('it is an https link', placeActions[0] && isSafeActionUrl(placeActions[0].url),
  placeActions[0]?.url);

const payResult = await call('checkout-pay-order', { orderNumber: order.orderNumber }, TOKEN);
const payActions = extractActions(payResult);

check('pay-order renders exactly one action', payActions.length === 1, JSON.stringify(payActions));
const a = payActions[0] || {};
check('it is a link action', a.type === 'link', a.type);
check('the label carries the amount', /₹/.test(a.label || ''), a.label);
check('it is styled primary', a.style === 'primary', a.style);
check('the url is the payment link', a.url === payResult.paymentUrl, a.url);
check('the url passes the safety check', isSafeActionUrl(a.url || ''), a.url);
check('it has a description line', Boolean(a.description), a.description);

// The whole point: the shopper gets the button even if the model never repeats
// the URL in prose.
check('the instruction no longer depends on the model repeating the URL',
  !payResult.instruction.includes(payResult.paymentUrl), payResult.instruction);

// An http URL must be dropped rather than rendered.
const unsafe = extractActions({ cheela: { actions: [
  { type: 'link', label: 'http', url: 'http://localhost:5173/pay/x' },
  { type: 'link', label: 'js', url: 'javascript:alert(1)' },
] } });
check('http and javascript: urls are dropped', unsafe.length === 0, JSON.stringify(unsafe));

/* --------------------------- pending / settled ---------------------------
 * Protocol 0.4. The pay result asks the panel to poll the order until it
 * stops being in flight, so the shopper paying in another tab no longer
 * depends on them coming back and saying so.
 *
 * Run through `extractPending` for the same reason the actions above run
 * through `extractActions`: it is the function the widget actually uses, and
 * it drops a malformed spec silently rather than throwing — so a spec this
 * shop got subtly wrong would cost the poll and nothing would say why.
 */
const pending = extractPending(payResult);

check('pay-order emits a pending spec', pending !== null, JSON.stringify(payResult.cheela));
check('it polls the order status capability',
  pending?.capability === 'orders-get-order', pending?.capability);
check('it names a capability the runtime actually has',
  runtime.getCapabilities().some((c) => c.name === pending?.capability), pending?.capability);
check('it passes the order number through',
  pending?.input?.orderNumber === order.orderNumber, JSON.stringify(pending?.input));
check('the interval survives clamping', pending?.intervalMs >= MIN_POLL_INTERVAL_MS,
  `${pending?.intervalMs} (floor ${MIN_POLL_INTERVAL_MS})`);
check('the timeout survives clamping', pending?.timeoutMs <= MAX_POLL_TIMEOUT_MS,
  `${pending?.timeoutMs} (ceiling ${MAX_POLL_TIMEOUT_MS})`);

// The poll stops on `settled`, so an unpaid order must NOT report it — get this
// backwards and the panel stops watching the instant it starts.
const unpaid = await call('orders-get-order', { orderNumber: order.orderNumber }, TOKEN);
check('an unpaid order is not settled', isSettled(unpaid) === false,
  `status=${unpaid.status} settled=${unpaid.cheela?.settled}`);

/*
 * Settle it the way it actually gets settled.
 *
 * `checkout-pay-order` only *issues* a payment link whenever Razorpay is
 * configured — sandbox included — so calling it again would leave the order
 * exactly as pending as before. Money lands later, on the webhook, and
 * `repo.capturePayment` is the function that webhook calls. Going straight to
 * it is the honest simulation of a shopper finishing on Razorpay's page, and it
 * is the transition the poll is waiting for.
 */
repo.capturePayment(repo.getOrder(order.orderNumber).id, { provider: 'razorpay', method: 'upi' });
const afterPay = await call('orders-get-order', { orderNumber: order.orderNumber }, TOKEN);
check('a settled order reports settled', isSettled(afterPay) === true,
  `status=${afterPay.status} settled=${afterPay.cheela?.settled}`);
check('settled means "stop polling", not "paid"',
  afterPay.status !== 'pending_payment', afterPay.status);

console.log(`\n  rendered button: "${a.label}" -> ${a.url}`);
console.log(`  polls ${pending?.capability} every ${pending?.intervalMs}ms for up to ${pending?.timeoutMs}ms`);
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
