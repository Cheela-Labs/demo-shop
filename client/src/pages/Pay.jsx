import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { api, money } from '../api';
import { openCheckout } from '../razorpay';

/**
 * The hosted payment page an agent's link points at.
 *
 * Razorpay's own hosted page fills this role when live keys are in play; in
 * sandbox there is no such page, so the shop serves its own. Either way the
 * shopper lands somewhere that only ever asks them to pay — no cart, no
 * address form, nothing to re-confirm — because they arrived from a link that
 * already committed to a specific order.
 *
 * Deliberately reachable without signing in: a payment link is a bearer
 * capability for one order, the same as an emailed invoice. It exposes only
 * what is already on the link — the order number and what is owed.
 */
export default function Pay() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [order, setOrder] = useState(null);
  const [config, setConfig] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [method, setMethod] = useState('upi');

  useEffect(() => {
    Promise.all([api.order(id), api.paymentMethods()])
      .then(([{ order: found }, cfg]) => { setOrder(found); setConfig(cfg); })
      .catch((err) => setError(err.message));
  }, [id]);

  if (error) {
    return (
      <div className="empty">
        <h2>We couldn't find that order</h2>
        <p>{error}</p>
        <Link to="/shop" className="btn">Browse products</Link>
      </div>
    );
  }

  if (!order || !config) return <div className="skeleton" style={{ height: 280 }} />;

  if (order.status === 'paid') {
    return (
      <div className="empty">
        <h2>Already paid</h2>
        <p>Order <span className="num">{order.number}</span> is settled — nothing more to do.</p>
        <Link to={`/order/${order.number}`} className="btn">View order</Link>
      </div>
    );
  }

  const settle = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      const result = await fn();
      if (result.ok) navigate(`/order/${order.number}`, { replace: true });
      else setError(result.error?.message || 'The payment did not go through.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const payLive = () => settle(async () => {
    const intent = await api.paymentIntent(order.number);
    const result = await openCheckout({ ...intent, onFailed: setError });
    if (result.dismissed) return { ok: false, error: { message: 'Payment cancelled — the order is still reserved.' } };
    return api.verifyPayment(order.number, {
      razorpayOrderId: result.razorpayOrderId,
      razorpayPaymentId: result.razorpayPaymentId,
      razorpaySignature: result.razorpaySignature,
    });
  });

  const paySandbox = (outcome) =>
    settle(() => api.simulatePayment(order.number, { outcome, method }));

  return (
    <div style={{ maxWidth: 470, margin: '0 auto' }}>
      <h1 style={{ fontSize: 26, marginBottom: 4 }}>Complete your payment</h1>
      <p style={{ color: 'var(--muted)', marginTop: 0 }}>
        Order <span className="num">{order.number}</span>
      </p>

      <div className="panel">
        {error && <div className="alert error" style={{ marginBottom: 18 }}>{error}</div>}

        <div className="summary-row" style={{ marginTop: 0 }}>
          <span>{order.items.reduce((n, i) => n + i.qty, 0)} item(s)</span>
          <span>{money(order.subtotal)}</span>
        </div>
        <div className="summary-row">
          <span>Shipping</span><span>{order.shipping === 0 ? 'Free' : money(order.shipping)}</span>
        </div>
        <div className="summary-row"><span>GST (18%)</span><span>{money(order.tax)}</span></div>
        <div className="summary-row total"><span>Amount due</span><span>{money(order.total)}</span></div>

        {config.simulated ? (
          <>
            <div className="alert info" style={{ margin: '18px 0' }}>
              <strong>Sandbox.</strong> Nothing is sent to Razorpay — choose an outcome.
            </div>

            <div className="form" style={{ marginBottom: 16 }}>
              <div className="field">
                <label htmlFor="pay-method">Pay using</label>
                <select id="pay-method" className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
                  <option value="upi">UPI</option>
                  <option value="card">Card</option>
                  <option value="netbanking">Netbanking</option>
                  <option value="wallet">Wallet</option>
                </select>
              </div>
            </div>

            <div style={{ display: 'grid', gap: 10 }}>
              <button type="button" className="btn block" onClick={() => paySandbox('pass')} disabled={busy}>
                {busy ? 'Processing…' : `Pay ${money(order.total)}`}
              </button>
              <button type="button" className="btn ghost block" onClick={() => paySandbox('fail')} disabled={busy}>
                Simulate a failed payment
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="pay-methods" style={{ marginTop: 18 }}>
              {['UPI', 'Cards', 'Netbanking', 'Wallets'].map((m) => (
                <span key={m} className="pay-method">{m}</span>
              ))}
            </div>
            <button type="button" className="btn block" style={{ marginTop: 18 }} onClick={payLive} disabled={busy}>
              {busy ? 'Opening Razorpay…' : `Pay ${money(order.total)}`}
            </button>
          </>
        )}

        <p style={{ textAlign: 'center', marginTop: 14, fontSize: 13, color: 'var(--muted)' }}>
          Your card details never reach this shop.
        </p>
      </div>
    </div>
  );
}
