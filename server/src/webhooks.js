/**
 * Razorpay webhooks.
 *
 * ## Why this exists even though the browser already confirms the payment
 *
 * The browser callback runs in the shopper's tab. A shopper who pays and then
 * closes the tab, loses signal, or gets a UPI collect request approved minutes
 * later in a banking app never runs it — and their money has still moved. The
 * webhook is the only path that completes those orders, which makes it the
 * authoritative one rather than a backup.
 *
 * Both paths settle through the same idempotent `settleRazorpayPayment`, so
 * whichever arrives first wins and the second is a no-op.
 *
 * ## Why it is mounted on the raw body
 *
 * The signature is an HMAC over the exact bytes Razorpay sent. `express.json()`
 * consumes the stream and re-serialising the parsed object produces different
 * bytes — different key order, different whitespace — so every signature would
 * fail. This router is mounted before the JSON parser for that reason.
 */

import { Router } from 'express';

import * as repo from './repo.js';
import * as razorpay from './razorpay.js';

export const webhooks = Router();

/**
 * Razorpay retries on any non-2xx, so the status codes here are chosen for what
 * they make Razorpay *do*:
 *
 *   - bad signature      401, no retry wanted — it was never ours
 *   - unknown order      200, retrying will not make the order exist
 *   - handler blew up    500, so Razorpay retries and the payment is not lost
 */
webhooks.post('/razorpay', async (req, res) => {
  if (!razorpay.webhooksConfigured()) {
    return res.status(503).json({ error: 'RAZORPAY_WEBHOOK_SECRET is not set' });
  }

  // express.raw() leaves a Buffer here; the signature is over these exact bytes.
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');

  const valid = razorpay.verifyWebhookSignature({
    rawBody,
    signature: req.get('x-razorpay-signature'),
  });

  if (!valid) {
    console.warn('[razorpay] webhook rejected — signature mismatch');
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Webhook body was not JSON' });
  }

  try {
    await handleEvent(event);
  } catch (err) {
    // 500 so Razorpay retries: dropping this would leave a paid order unpaid.
    console.error('[razorpay] webhook handler failed', err);
    return res.status(500).json({ error: 'Handler failed' });
  }

  return res.json({ ok: true });
});

async function handleEvent(event) {
  const type = event?.event;
  const payment = event?.payload?.payment?.entity;
  const paymentLink = event?.payload?.payment_link?.entity;

  switch (type) {
    case 'payment.captured':
    case 'payment.authorized': {
      const order = payment?.order_id ? repo.orderByRazorpayOrderId(payment.order_id) : null;
      if (!order) {
        console.warn(`[razorpay] ${type} for unknown order ${payment?.order_id}`);
        return;
      }
      // Amount is re-checked here too. The webhook is authenticated, but an
      // underpayment is still an underpayment.
      if (payment.amount !== order.total) {
        console.warn(`[razorpay] ${type} amount ${payment.amount} != order total ${order.total}`);
        return;
      }
      const settled = repo.settleRazorpayPayment(order.id, {
        ...razorpay.describePayment(payment),
        razorpayOrderId: payment.order_id,
        razorpayPaymentId: payment.id,
      });
      console.log(
        `[razorpay] ${order.number} ${settled.alreadyPaid ? 'already settled' : 'settled via webhook'}`,
      );
      return;
    }

    case 'payment.failed': {
      const order = payment?.order_id ? repo.orderByRazorpayOrderId(payment.order_id) : null;
      if (!order) return;
      // Only fail an order that is still waiting. A `payment.failed` for a first
      // attempt can arrive after a successful retry, and marking a paid order
      // failed would release stock that has already been sold.
      if (order.status === 'paid') return;
      repo.failPayment(order.id, {
        ...razorpay.describeFailure(payment),
        provider: 'razorpay',
        method: payment.method,
        razorpayPaymentId: payment.id,
      });
      console.log(`[razorpay] ${order.number} payment failed`);
      return;
    }

    case 'payment_link.paid': {
      // The agent path: the shopper paid on a hosted link rather than in the
      // browser modal, so there is no callback into this app at all.
      const order = paymentLink?.id ? repo.orderByPaymentLinkId(paymentLink.id) : null;
      if (!order) return;
      const settled = repo.settleRazorpayPayment(order.id, {
        ...razorpay.describePayment(payment),
        razorpayPaymentId: payment?.id,
      });
      console.log(
        `[razorpay] ${order.number} ${settled.alreadyPaid ? 'already settled' : 'settled via payment link'}`,
      );
      return;
    }

    default:
      // Razorpay sends whatever the dashboard subscribes to; unknown events are
      // acknowledged rather than retried forever.
      console.log(`[razorpay] ignoring event ${type}`);
  }
}
