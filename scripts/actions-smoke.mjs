/**
 * Runs a capability result through the same extractor the chat panel uses —
 * `renderActions` in @cheela/web-component calls exactly this — so we see what
 * the panel would actually render, not what we intended it to.
 */
import {
  extractActions, isSafeActionUrl, MAX_ACTIONS_PER_RESULT,
  extractPending, isSettled, MIN_POLL_INTERVAL_MS, MAX_POLL_TIMEOUT_MS,
  extractCards, MAX_CARDS_PER_RESULT,
  MAX_REPLY_VALUE_LENGTH,
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

/* ------------------------------ product cards ----------------------------
 * Protocol 0.5. The catalogue capabilities describe what the shopper should
 * see, so a search result arrives as pictures and prices rather than as
 * whatever the model chose to retype about them.
 *
 * Through `extractCards` for the third time for the same reason: it is the
 * function `renderMessage` calls, and it drops a malformed card silently. A
 * card this shop got subtly wrong would simply not appear, and nothing in the
 * output would say so.
 */
console.log(`\n  MAX_CARDS_PER_RESULT = ${MAX_CARDS_PER_RESULT}`);

// Ask for far more than the protocol will render, to prove the runtime clips
// its own payload rather than shipping 24 cards for the 6 that get drawn.
const browse = await call('catalog-search-products', { limit: 24 });
const cards = extractCards(browse);

/*
 * Whether the storefront is reachable over https decides how much of a card
 * survives, and both are legitimate: a fresh clone runs on http://localhost,
 * and `.env` here points at a tunnel. So assert the rule rather than one
 * side of it — the card itself renders either way, and only its link and
 * picture depend on the scheme. This is the difference from actions, which
 * vanish entirely without https because an action is nothing but its URL.
 */
const secure = isSafeActionUrl(browse.items[0].productUrl);

check('search renders cards', cards.length > 0, JSON.stringify(browse.cheela)?.slice(0, 120));
check('every card is a product card', cards.every((c) => c.type === 'product'));
check('every card has the one field it cannot do without',
  cards.every((c) => typeof c.title === 'string' && c.title.length > 0));
check('the runtime clips to MAX_CARDS_PER_RESULT rather than leaving it to the widget',
  browse.cheela.cards.length <= MAX_CARDS_PER_RESULT, `sent ${browse.cheela.cards.length}`);
check('more matched than were shown', browse.total > cards.length, `total=${browse.total}`);
check('the cards are the first results, in order',
  cards.every((c, i) => c.title === browse.items[i].name));
check('the price is preformatted by the runtime, not a number for the widget to guess at',
  cards.every((c) => typeof c.price === 'string' && c.price.includes('₹')), cards[0]?.price);
check('a card links to its product page only when that page is https',
  cards.every((c) => (c.url !== undefined) === secure), `https storefront: ${secure}`);
check('a card carries a picture only when it is https',
  cards.every((c) => (c.image !== undefined) === isSafeActionUrl(browse.items[0].imageUrl)));
// The runtime sends no `alt` and the extractor normalises that to `""`, which
// is what marks an image decorative. Right here: the title sits beside the
// picture, so a screen reader reading the product name twice is noise.
check('the picture is marked decorative — the title beside it already names the product',
  cards.every((c) => c.image === undefined || c.image.alt === ''),
  JSON.stringify(cards[0]?.image));

// Cards and buttons share one envelope: a shortlist, and a way to see the rest.
const browseActions = extractActions(browse);
// Counted as links rather than as actions: protocol 0.6 lets a refinement reply
// ride in the same envelope, and this assertion is about the one that navigates.
const browseLinks = browseActions.filter((x) => x.type === 'link');
check('a "see all" button rides alongside the cards',
  browseLinks.length === (secure ? 1 : 0), JSON.stringify(browseActions));
if (secure) {
  check('it says how many results there are',
    browseLinks[0].label.includes(String(browse.total)), browseLinks[0].label);
}

// A budget search cannot be reproduced as a URL — /shop has no price filter —
// so the button must not promise a count the page behind it will not honour.
const bounded = await call('catalog-search-products', { maxPriceCents: 2000000, limit: 24 });
const boundedActions = extractActions(bounded);
check('a price-bounded search does not promise a result count it cannot honour',
  boundedActions.every((x) => !/\d/.test(x.label)), JSON.stringify(boundedActions.map((x) => x.label)));

const detail = await call('catalog-get-product', { productId: browse.items[0].id });
const detailCards = extractCards(detail);
check('get-product renders exactly one card', detailCards.length === 1, JSON.stringify(detailCards));
check('it is the product asked about, not one of the related ones',
  detailCards[0]?.title === detail.product.name, detailCards[0]?.title);
check('the related products are left for the model rather than put on screen',
  detail.related.length > 0 && detailCards.length === 1, `related=${detail.related.length}`);

/*
 * The failure modes, which are scoped more tightly than an action's.
 *
 * An action IS its URL, so an unsafe one leaves nothing to render and the
 * action goes. A card is a product: the name and the price survive a link
 * that cannot be opened, so the URL is stripped and the card stays.
 */
const hostile = extractCards({ cheela: { cards: [
  { type: 'product', title: 'Kept, minus its link', price: '₹1,499', url: 'javascript:alert(1)' },
  { type: 'product', title: 'Kept, minus its picture', image: { url: 'http://cdn/x.png' } },
  { type: 'product', price: '₹99' },
  { type: 'link', title: 'Not a product card' },
] } });
check('an unsafe card url is stripped and the card survives',
  hostile[0]?.title === 'Kept, minus its link' && hostile[0]?.url === undefined,
  JSON.stringify(hostile[0]));
check('an unsafe image is dropped and the card survives',
  hostile[1]?.title === 'Kept, minus its picture' && hostile[1]?.image === undefined,
  JSON.stringify(hostile[1]));
check('a card with no title is dropped — there would be nothing to read',
  hostile.length === 2, JSON.stringify(hostile.map((c) => c.title)));

/*
 * Reply actions — protocol 0.6.
 *
 * The other half of `cheela.actions`: a button that submits a turn instead of
 * navigating. Everything here goes through `extractActions`, the same function
 * `renderActions` calls, because the interesting failures are the silent ones —
 * a reply the widget drops still validates against the capability's own schema
 * and still looks correct in the runtime's output.
 */
console.log(`\n  MAX_REPLY_VALUE_LENGTH = ${MAX_REPLY_VALUE_LENGTH}`);

const detailActions = extractActions(detail);
const replyOnDetail = detailActions.find((x) => x.type === 'reply');

check('a product with reviews offers a reply button',
  Boolean(replyOnDetail), JSON.stringify(detailActions.map((x) => x.type)));
check('its value names the product rather than saying "this one"',
  replyOnDetail?.value?.includes(detail.product.name), replyOnDetail?.value);
check('label and value are allowed to differ',
  replyOnDetail && replyOnDetail.label !== replyOnDetail.value);

const reviewsRecent = await call('catalog-get-product-reviews',
  { productId: detail.product.id, limit: 3 });
const reviewsCritical = await call('catalog-get-product-reviews',
  { productId: detail.product.id, limit: 3, sort: 'critical' });

check('reading reviews offers the opposite sort',
  extractActions(reviewsRecent).some((x) => x.type === 'reply'));
check('but not when the critical ones are already on screen',
  extractActions(reviewsCritical).every((x) => x.type !== 'reply'),
  JSON.stringify(extractActions(reviewsCritical)));

/*
 * A refinement's value is submitted with no surrounding context, so it has to
 * restate the search rather than say "the same, but in stock".
 */
const refinable = await call('catalog-search-products',
  { query: 'backpack', limit: 6, category: 'Bags', maxPriceCents: 900000 });
const refinement = extractActions(refinable).find((x) => x.type === 'reply');

if (refinement) {
  check('a refinement restates every filter it was built from',
    refinement.value.includes('backpack')
      && refinement.value.includes('Bags')
      && refinement.value.includes('in stock'),
    refinement.value);
  check('a refinement value stays inside the protocol cap',
    refinement.value.length <= MAX_REPLY_VALUE_LENGTH, String(refinement.value.length));
} else {
  check('a refinement restates every filter it was built from', true, 'nothing sold out');
  check('a refinement value stays inside the protocol cap', true, 'nothing sold out');
}

const alreadyFiltered = await call('catalog-search-products',
  { query: 'backpack', limit: 6, inStockOnly: true });
check('no refinement when the shopper already asked for it',
  extractActions(alreadyFiltered).every((x) => x.type !== 'reply'));

/*
 * The widget drops an over-length value rather than truncating it, because half
 * of "cancel order #1042" is a different instruction. A capability that builds
 * one gets no button at all, so the runtime must not claim it either.
 */
const overlong = extractActions({ cheela: { actions: [
  { type: 'reply', label: 'Fine', value: 'x'.repeat(MAX_REPLY_VALUE_LENGTH) },
  { type: 'reply', label: 'Dropped', value: 'x'.repeat(MAX_REPLY_VALUE_LENGTH + 1) },
  { type: 'reply', label: 'Defaults to its label' },
  { type: 'reply', value: 'No label' },
] } });
check('a reply at exactly the cap survives',
  overlong.some((x) => x.label === 'Fine'), JSON.stringify(overlong.map((x) => x.label)));
check('a reply one character over is dropped, not truncated',
  !overlong.some((x) => x.label === 'Dropped'));
// Documented behaviour, not an oversight: `value` defaults to `label`, so a
// button whose text already reads as a sentence needs to say it only once.
check('a reply with no value falls back to its label',
  overlong.find((x) => x.label === 'Defaults to its label')?.value === 'Defaults to its label',
  JSON.stringify(overlong.find((x) => x.label === 'Defaults to its label')));
check('a reply with no label is dropped',
  overlong.every((x) => x.label));

/*
 * A reply carries no URL, so it cannot be a navigation exploit — but it must
 * not become one by having a url honoured on it either.
 */
const mixed = extractActions({ cheela: { actions: [
  { type: 'reply', label: 'Reply', value: 'ok', url: 'javascript:alert(1)' },
  { type: 'link', label: 'Unsafe link', url: 'javascript:alert(1)' },
] } });
check('an unsafe link is still dropped alongside replies',
  !mixed.some((x) => x.label === 'Unsafe link'), JSON.stringify(mixed));
check('a url smuggled onto a reply is not navigable',
  mixed.every((x) => x.type !== 'reply' || !isSafeActionUrl(x.url ?? '')));

console.log(`\n  rendered button: "${a.label}" -> ${a.url}`);
console.log(`  polls ${pending?.capability} every ${pending?.intervalMs}ms for up to ${pending?.timeoutMs}ms`);
console.log(`  rendered ${cards.length} of ${browse.total} matches as cards` +
  `${cards[0] ? `, first: "${cards[0].title}" ${cards[0].price}` : ''}`);
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
