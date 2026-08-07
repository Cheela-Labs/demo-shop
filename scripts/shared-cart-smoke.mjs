#!/usr/bin/env node
/**
 * Proves the chat assistant and the browser tab share one cart.
 *
 * The bug this pins down: the agent has no access to localStorage, so it used
 * to call `createCart()` and fill a cart the shopper could not see. The item
 * really was added — just not to the bag on screen, which is the most
 * confusing failure mode available.
 *
 * Usage: npm run smoke:cart
 */

import runtime from '../server/.cheela/runtime.ts';
import { DEMO_ACCOUNT } from '../server/src/seed.js';
import * as repo from '../server/src/repo.js';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TOKEN = DEMO_ACCOUNT.token;

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  ok   ${label}`); }
  else { failed += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

const authed = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };
const shop = async (path, opts = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...opts, headers: opts.headers || authed,
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const agent = async (name, input = {}, signedIn = true) =>
  (await runtime.execute(name, input, signedIn ? { endUserToken: TOKEN } : {})).output;

console.log('\nshared cart — assistant and browser tab\n');

// Start from a clean slate for the demo shopper.
const me = (await shop('/api/auth/me')).body.user;
for (let guard = 0; guard < 20; guard += 1) {
  const active = repo.activeCartForUser(me.id);
  if (!active || active.items.length === 0) break;
  repo.clearCart(active.id);
}

const { items: products } = (await shop('/api/products?limit=2&inStock=true')).body;
const [first, second] = products;

/* ---------------- the browser's cart is the shopper's cart --------------- */

const browserCart = (await shop('/api/cart', { method: 'POST' })).body.cart;
await shop(`/api/cart/${browserCart.id}/items`, {
  method: 'POST', body: { productId: first.id, qty: 1 },
});

const seenByAgent = await agent('cart-view', {});
check('the assistant sees the cart the browser filled',
  seenByAgent.cartId === browserCart.id, `${browserCart.id} vs ${seenByAgent.cartId}`);
check('with the same contents', seenByAgent.itemCount === 1, String(seenByAgent.itemCount));

/* ---------------- the assistant's write lands in that cart --------------- */

const afterAgentAdd = await agent('cart-add-item', { productId: second.id, quantity: 2 });
check('the assistant adds to the same cart',
  afterAgentAdd.cartId === browserCart.id, `${browserCart.id} vs ${afterAgentAdd.cartId}`);

const reread = (await shop(`/api/cart/${browserCart.id}`)).body.cart;
check('the browser sees the assistant\'s item on refresh',
  reread.count === 3, `count=${reread.count}`);
check('and its totals include it', reread.subtotal === first.price + second.price * 2,
  `${reread.subtotal}`);

/* ------------- the assistant ignores a stale cartId it is given ---------- */

// An *empty* stale cartId — what a model repeats from an earlier turn — must
// not divert the shopper onto a cart they cannot see.
const strayCart = (await shop('/api/cart', { method: 'POST', headers: { 'Content-Type': 'application/json' } })).body.cart;
const withStray = await agent('cart-add-item', { productId: first.id, quantity: 1, cartId: strayCart.id });
check('an empty stale cartId does not divert a signed-in shopper',
  withStray.cartId === browserCart.id, `${withStray.cartId}`);


/* ---------------------- updates and removals too ------------------------ */

const line = withStray.items.find((i) => i.productId === second.id);
const bumped = await agent('cart-update-item', { itemId: line.itemId, quantity: 1 });
check('the assistant can update a line in the shared cart',
  bumped.items.find((i) => i.productId === second.id)?.quantity === 1);
check('still the same cart', bumped.cartId === browserCart.id);

/* ------------------- checkout uses the shared cart too ------------------ */

const addresses = await agent('addresses-list', {});
const order = await agent('checkout-place-order', {
  addressId: addresses.addresses[0].addressId,
});
check('placing an order with no cartId uses the shared cart',
  /^CHL-/.test(order.orderNumber), order.orderNumber);

const emptied = (await shop(`/api/cart/${browserCart.id}`)).body.cart;
check('and that cart is emptied by checkout', emptied.count === 0, `count=${emptied.count}`);

/* --------------------- anonymous visitors still work -------------------- */

const anonCart = await agent('cart-add-item', { productId: first.id, quantity: 1 }, false);
check('an anonymous visitor still gets their own cart',
  Boolean(anonCart.cartId) && anonCart.cartId !== browserCart.id, anonCart.cartId);
check('and it holds what they added', anonCart.itemCount === 1);

/* ------------- a filled guest cart handed over is adopted --------------- */
//
// Last, deliberately: adopting a cart changes which one is active, so running
// this earlier would pull the checks above onto a different cart.
const guestCart = (await shop('/api/cart', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
})).body.cart;
await fetch(`${BASE}/api/cart/${guestCart.id}/items`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ productId: second.id, qty: 1 }),
});
const adopted = await agent('cart-view', { cartId: guestCart.id });
check('a filled guest cart handed over is adopted', adopted.cartId === guestCart.id, adopted.cartId);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
