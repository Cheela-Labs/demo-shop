/**
 * Razorpay integration.
 *
 * Talks to Razorpay's REST API directly over `fetch` rather than pulling in the
 * SDK: the three calls this shop makes are small, and doing them by hand keeps
 * the signature arithmetic — the part that actually matters for security —
 * visible in this file instead of buried in a dependency.
 *
 * ## The flow, and why it is shaped this way
 *
 * Razorpay is a *client-side* checkout. The browser opens Razorpay's modal, the
 * shopper pays Razorpay directly, and Razorpay hands the browser back three
 * values. Your server never sees a card, a UPI PIN or a netbanking password —
 * which is the entire point, and the reason PCI scope stays off this box.
 *
 *   1. `POST /orders`            (here)     — reserve an amount, get an order_id
 *   2. Razorpay Checkout         (browser)  — shopper pays
 *   3. handler receives          (browser)  — razorpay_payment_id/order_id/signature
 *   4. verify the signature      (here)     — proves 3 came from Razorpay
 *   5. webhook `payment.captured`(here)     — the authoritative confirmation
 *
 * **Step 4 is not optional and step 5 is not redundant.** The values in step 3
 * arrive via the shopper's own browser, so they are attacker-controlled until
 * the HMAC checks out. And a shopper who pays and then closes the tab never
 * runs step 3 at all — the webhook is the only path that still completes that
 * order. Treating either one as sufficient on its own loses money or ships
 * goods for free.
 *
 * ## Amounts
 *
 * Razorpay works in the smallest currency unit — paise for INR — which is
 * exactly how this shop stores money, so amounts pass through untouched. No
 * float ever enters the conversion.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const API = 'https://api.razorpay.com/v1';

export const KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
/**
 * Separate from the API secret. Razorpay signs webhooks with the secret you
 * typed into the dashboard when creating the webhook, not with your API key —
 * using the wrong one here fails every webhook with a signature mismatch.
 */
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';

export const CURRENCY = 'INR';

/**
 * Sandbox mode: behave exactly like Razorpay without ever calling it.
 *
 * Razorpay refuses payments until the account has its business/web-app details
 * filled in, which blocks testing for reasons that have nothing to do with this
 * code. With this set, `createOrder`, `createPaymentLink` and `fetchPayment`
 * return the shapes Razorpay would return and no request leaves the machine.
 *
 * **The signing and verification below are NOT stubbed.** Sandbox mode still
 * signs with the real `RAZORPAY_KEY_SECRET` and still verifies every signature
 * for real, so the code that decides whether an order is paid is the same code
 * that runs in production — which is the only part worth testing.
 *
 * Refused outright when NODE_ENV=production: a server that mints its own
 * "successful" payments must never be reachable by a real shopper.
 */
export const SIMULATE =
  /^(1|true|yes)$/i.test(process.env.RAZORPAY_SIMULATE || '') &&
  process.env.NODE_ENV !== 'production';

if (/^(1|true|yes)$/i.test(process.env.RAZORPAY_SIMULATE || '') && process.env.NODE_ENV === 'production') {
  throw new Error('RAZORPAY_SIMULATE must never be enabled with NODE_ENV=production.');
}

/** Ids shaped like Razorpay's, but obviously synthetic when read in a log. */
const simId = (prefix) => `${prefix}_sim${randomBytes(9).toString('hex').slice(0, 14)}`;

/**
 * Whether real Razorpay calls are possible.
 *
 * Everything below degrades to the simulated processor when this is false, so
 * the shop, its tests and the agent flow all keep working on a clean checkout
 * with no credentials — you drop keys into server/.env and the same code path
 * goes live with no edit.
 */
export const isConfigured = () => Boolean(KEY_ID && KEY_SECRET);

/** Sandbox counts as configured — the flow is identical, only the wire is cut. */
export const isSimulated = () => SIMULATE && isConfigured();

/** True once webhooks can actually be verified. */
export const webhooksConfigured = () => Boolean(WEBHOOK_SECRET);

function authHeader() {
  return `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`;
}

/**
 * One place where every Razorpay HTTP call goes through.
 *
 * Razorpay reports failures as a 4xx with `{ error: { description } }`; that
 * description is written for developers and is far more useful than "request
 * failed", so it is surfaced rather than swallowed.
 */
async function call(method, path, body) {
  if (!isConfigured()) {
    throw Object.assign(new Error('Razorpay is not configured'), { status: 503 });
  }

  let response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: authHeader(),
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (cause) {
    throw Object.assign(new Error(`Could not reach Razorpay: ${cause.message}`), {
      status: 502,
      cause,
    });
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const description = payload?.error?.description || `Razorpay returned ${response.status}`;
    throw Object.assign(new Error(description), {
      status: response.status,
      razorpayCode: payload?.error?.code,
    });
  }

  return payload;
}

/**
 * Creates a Razorpay order — the object the browser checkout is opened against.
 *
 * `receipt` carries our own order number so a payment in the Razorpay dashboard
 * can be traced back to a row in this database without a lookup table.
 */
export function createOrder({ amount, receipt, notes }) {
  if (SIMULATE) {
    return Promise.resolve({
      id: simId('order'),
      entity: 'order',
      amount,
      amount_paid: 0,
      amount_due: amount,
      currency: CURRENCY,
      receipt,
      status: 'created',
      notes: notes || {},
      created_at: Math.floor(Date.now() / 1000),
    });
  }

  return call('POST', '/orders', {
    amount,
    currency: CURRENCY,
    receipt,
    // Razorpay may capture automatically or hold for manual capture depending on
    // the account; asking for automatic capture makes the outcome the same
    // either way, so a paid order is never left waiting on a dashboard click.
    payment_capture: 1,
    notes: notes || {},
  });
}

/**
 * In sandbox mode the outcome is encoded in the payment id, the same way the
 * simulated card processor encodes it in a token: `pay_simfail…` comes back
 * failed, anything else captured. That keeps a failing payment reproducible
 * instead of something you can only hit by luck.
 */
export function fetchPayment(paymentId, { amount, method = 'upi' } = {}) {
  if (SIMULATE) {
    const failed = String(paymentId).includes('fail');
    return Promise.resolve({
      id: paymentId,
      entity: 'payment',
      amount,
      currency: CURRENCY,
      status: failed ? 'failed' : 'captured',
      method,
      ...(method === 'upi' ? { vpa: failed ? 'failure@razorpay' : 'success@razorpay' } : {}),
      ...(method === 'card' ? { card: { network: 'Visa', last4: '1111' } } : {}),
      ...(failed
        ? {
          error_code: 'BAD_REQUEST_ERROR',
          error_reason: 'payment_failed',
          error_description: 'The payment was declined by the issuing bank.',
        }
        : {}),
    });
  }

  return call('GET', `/payments/${paymentId}`);
}

/**
 * Mints the signature Razorpay Checkout would hand the browser.
 *
 * Sandbox only, and deliberately using the real signing key: the point is that
 * `/payment/verify` performs a genuine verification rather than being told to
 * skip one, so the branch that runs here is the branch that runs in production.
 */
export function simulateCheckoutSignature(orderId, paymentId) {
  if (!SIMULATE) throw new Error('Signatures may only be minted in sandbox mode.');
  return createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
}

/** Sandbox equivalent for webhook deliveries the simulator sends to itself. */
export function simulateWebhookSignature(rawBody) {
  if (!SIMULATE) throw new Error('Signatures may only be minted in sandbox mode.');
  return createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
}

/**
 * Issues a hosted payment page for an order.
 *
 * This exists for the agent path. Razorpay Checkout is a browser modal that has
 * to be opened by a human — an agent has no way to drive it — so instead of
 * pretending otherwise, the agent hands the shopper a link they open themselves
 * and pay on Razorpay's own page. The money still moves through exactly the
 * same Razorpay account, and the webhook settles the order either way.
 */
export function createPaymentLink({ amount, description, reference, customer, callbackUrl }) {
  if (SIMULATE) {
    // Points at the storefront's own sandbox payment page rather than rzp.io,
    // so the agent flow is followable end to end without Razorpay.
    const storefront = process.env.STOREFRONT_URL || 'http://localhost:5173';
    const id = simId('plink');
    return Promise.resolve({
      id,
      short_url: `${storefront}/pay/${encodeURIComponent(reference)}`,
      reference_id: reference,
      amount,
      currency: CURRENCY,
      description,
      status: 'created',
    });
  }

  return call('POST', '/payment_links', {
    amount,
    currency: CURRENCY,
    description,
    reference_id: reference,
    customer: {
      name: customer?.name || undefined,
      email: customer?.email || undefined,
      contact: customer?.phone || undefined,
    },
    notify: { sms: false, email: false },
    reminder_enable: false,
    ...(callbackUrl ? { callback_url: callbackUrl, callback_method: 'get' } : {}),
  });
}

export function refundPayment(paymentId, amount) {
  return call('POST', `/payments/${paymentId}/refund`, amount ? { amount } : {});
}

/** Constant-time compare that tolerates length mismatch without throwing. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Verifies the triple Razorpay Checkout hands back to the browser.
 *
 * The signature is `HMAC-SHA256(key_secret, "<razorpay_order_id>|<razorpay_payment_id>")`.
 * Without this check anyone could POST a made-up payment id to the verify
 * endpoint and walk away with the goods, because those values reach us through
 * the shopper's browser and nothing else about them is trustworthy.
 */
export function verifyPaymentSignature({ orderId, paymentId, signature }) {
  if (!orderId || !paymentId || !signature) return false;
  const expected = createHmac('sha256', KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return safeEqual(expected, signature);
}

/**
 * Verifies the callback from a **payment link**.
 *
 * A different signature scheme from the Checkout modal above, and the reason
 * the agent flow could not settle itself. The modal signs `order_id|payment_id`
 * and redirects with `razorpay_order_id`; a payment link signs four fields and
 * redirects with none of them:
 *
 *   HMAC-SHA256(`${linkId}|${referenceId}|${status}|${paymentId}`, KEY_SECRET)
 *
 * Same key, same trust model as `verifyPaymentSignature`: these values reach us
 * through the shopper's own browser, so they mean nothing until the HMAC checks
 * out, and the amount is confirmed against Razorpay afterwards rather than
 * taken from the query string.
 *
 * `reference_id` is the order number — `createPaymentLink` sets it — so a
 * signature that verifies also proves which order was paid for.
 */
export function verifyPaymentLinkSignature({
  paymentLinkId, referenceId, status, paymentId, signature,
}) {
  if (!paymentLinkId || !referenceId || !status || !paymentId || !signature) return false;
  const expected = createHmac('sha256', KEY_SECRET)
    .update(`${paymentLinkId}|${referenceId}|${status}|${paymentId}`)
    .digest('hex');
  return safeEqual(expected, signature);
}

/**
 * Verifies a webhook delivery.
 *
 * Signed over the **raw** request bytes with the webhook secret, so the route
 * must not let `express.json()` touch the body first — re-serialising the
 * parsed object produces different bytes and every signature fails.
 */
export function verifyWebhookSignature({ rawBody, signature }) {
  if (!WEBHOOK_SECRET || !signature) return false;
  const expected = createHmac('sha256', WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  return safeEqual(expected, signature);
}

/**
 * Flattens the bits of a Razorpay payment worth storing.
 *
 * Razorpay puts the interesting detail in different fields depending on how the
 * shopper paid — `vpa` for UPI, `card` for cards, `bank` for netbanking,
 * `wallet` for wallets — so this normalises them into the shape `payments`
 * holds, and produces the "UPI · shopper@bank" style label the UI shows.
 */
export function describePayment(payment) {
  if (!payment) return {};

  const method = payment.method || 'card';
  const card = payment.card || {};

  return {
    method,
    brand: card.network || (method === 'upi' ? 'UPI' : method === 'netbanking' ? payment.bank : payment.wallet) || null,
    last4: card.last4 || null,
    wallet: payment.wallet || null,
    vpa: payment.vpa || null,
    bank: payment.bank || null,
  };
}

/**
 * Maps a Razorpay failure onto the shape the rest of the shop already speaks,
 * so a Razorpay decline and a simulated decline reach the UI identically.
 */
export function describeFailure(payment) {
  return {
    code: payment?.error_code || payment?.error_reason || 'payment_failed',
    message:
      payment?.error_description ||
      'The payment did not go through. Try again or use a different method.',
  };
}
