import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';

import { api, money } from '../api';
import { Check } from '../components/Icons';

/**
 * Razorpay redirects here after a **payment link** is paid, with the outcome in
 * the query string. Four of these five are what the signature is computed over;
 * all five have to be present for the callback to be worth sending on.
 */
function paymentLinkCallback(params) {
  const payload = {
    razorpayPaymentLinkId: params.get('razorpay_payment_link_id'),
    razorpayPaymentLinkReferenceId: params.get('razorpay_payment_link_reference_id'),
    razorpayPaymentLinkStatus: params.get('razorpay_payment_link_status'),
    razorpayPaymentId: params.get('razorpay_payment_id'),
    razorpaySignature: params.get('razorpay_signature'),
  };
  return Object.values(payload).every(Boolean) ? payload : null;
}

export default function Order() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const [order, setOrder] = useState(null);
  const [error, setError] = useState(null);

  /*
   * Settle first, then load — otherwise the page renders the order as still
   * unpaid for as long as the round trip takes, which is the one moment the
   * shopper is looking hardest at whether it worked.
   *
   * The values here arrive through the shopper's own browser and are worth
   * nothing until the server verifies the HMAC, which is why this posts them
   * rather than deciding anything itself. A failure is deliberately not shown:
   * the `payment_link.paid` webhook settles the same order independently, so
   * the honest thing to display is whatever the order says once it loads.
   */
  useEffect(() => {
    let cancelled = false;

    async function load() {
      const callback = paymentLinkCallback(params);
      if (callback) {
        try {
          await api.verifyPaymentLink(id, callback);
        } catch {
          // Swallowed on purpose — see above.
        }
        if (cancelled) return;
        // Drop the credentials from the address bar before anything can copy,
        // bookmark or share it. `replace` so Back does not re-run the callback.
        setParams({}, { replace: true });
      }

      try {
        const { order: loaded } = await api.order(id);
        if (!cancelled) setOrder(loaded);
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    }

    load();
    return () => { cancelled = true; };
    // `params` is deliberately not a dependency: this consumes the callback and
    // then clears it, and re-running on that change would fetch the order twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (error) {
    return (
      <div className="empty">
        <h2>Order not found</h2>
        <p>{error}</p>
        <Link to="/shop" className="btn">Back to shop</Link>
      </div>
    );
  }

  if (!order) return <div className="skeleton" style={{ height: 320, maxWidth: 620, margin: '0 auto' }} />;

  return (
    <div className="confirm">
      <div className="tick"><Check width={32} height={32} /></div>
      <h1>Thank you, {order.customer.split(' ')[0]}</h1>
      <p style={{ color: 'var(--muted)', marginBottom: 6 }}>
        Your order is confirmed. A receipt is on its way to {order.email}.
      </p>
      <p>Order <span className="num">{order.number}</span></p>

      <div className="panel order-items">
        {order.items.map((item) => (
          <div className="line-item" key={item.productId} style={{ gridTemplateColumns: '64px 1fr auto' }}>
            <img src={item.image.thumb} alt="" width="64" height="64" style={{ width: 64, height: 64 }} loading="lazy" />
            <div className="meta">
              <strong>{item.name}</strong>
              <small>Qty {item.qty} × {money(item.unitPrice)}</small>
            </div>
            <span className="price">{money(item.lineTotal)}</span>
          </div>
        ))}

        <div className="summary-row" style={{ marginTop: 14 }}><span>Subtotal</span><span>{money(order.subtotal)}</span></div>
        <div className="summary-row"><span>Shipping</span><span>{order.shipping === 0 ? 'Free' : money(order.shipping)}</span></div>
        <div className="summary-row"><span>Tax</span><span>{money(order.tax)}</span></div>
        <div className="summary-row total"><span>Total paid</span><span>{money(order.total)}</span></div>

        <div style={{ marginTop: 22, paddingTop: 18, borderTop: '1px solid var(--line)', fontSize: 14, color: 'var(--muted)' }}>
          <strong style={{ color: 'var(--ink)', display: 'block', marginBottom: 6 }}>Shipping to</strong>
          {order.customer}<br />
          {order.address.line1}{order.address.line2 ? `, ${order.address.line2}` : ''}<br />
          {order.address.city} {order.address.postcode}<br />
          {order.address.country}
        </div>
      </div>

      <Link to="/shop" className="btn ghost" style={{ marginTop: 26 }}>Continue shopping</Link>
    </div>
  );
}
