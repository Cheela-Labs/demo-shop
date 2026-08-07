/**
 * Runs a capability result through the same extractor @cheela/ui uses, so we
 * see what the chat panel would actually render — not what we intended it to.
 */
import { extractActions, isSafeActionUrl, MAX_ACTIONS_PER_RESULT } from '@cheela/protocol';
import runtime from '../server/.cheela/runtime.ts';
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

console.log(`\n  rendered button: "${a.label}" -> ${a.url}`);
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
