import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { api, money } from '../api';
import { openCheckout } from '../razorpay';
import { useShop } from '../store';
import AddressForm, { BLANK_ADDRESS, addressLines } from '../components/AddressForm';

export default function Checkout() {
  const { cart, user, refreshCart } = useShop();
  const navigate = useNavigate();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [placedOrder, setPlacedOrder] = useState(null);

  const [saved, setSaved] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  // `null` id means "use the form below" — a new address rather than a saved one.
  const [useNew, setUseNew] = useState(false);
  const [saveForNextTime, setSaveForNextTime] = useState(true);

  const [contact, setContact] = useState({ name: user?.name || '', email: user?.email || '' });
  const [address, setAddress] = useState(BLANK_ADDRESS);

  // The session resolves after mount, so the initial state above sees a null
  // user. Fill in what we learn, but never overwrite something already typed.
  useEffect(() => {
    if (!user) return;
    setContact((c) => ({ name: c.name || user.name, email: c.email || user.email }));
  }, [user]);

  useEffect(() => {
    if (!user) { setSaved([]); setUseNew(true); return; }
    api.addresses()
      .then(({ items }) => {
        setSaved(items);
        // Preselect the default so the common case is a single click.
        const preferred = items.find((a) => a.isDefault) || items[0];
        setSelectedId(preferred?.id ?? null);
        setUseNew(items.length === 0);
      })
      .catch(() => { setSaved([]); setUseNew(true); });
  }, [user]);

  // Checked before the empty-cart guard on purpose: placing the order empties
  // the cart, so testing the cart first would bounce the shopper to "your bag
  // is empty" at exactly the moment they still owe us a payment.
  if (placedOrder) {
    return (
      <PaymentStep
        order={placedOrder}
        onPaid={(o) => navigate(`/order/${o.number}`, { replace: true })}
      />
    );
  }

  if (!cart) return <div className="skeleton" style={{ height: 320 }} />;

  if (cart.items.length === 0) {
    return (
      <div className="empty">
        <h2>Nothing to check out</h2>
        <p>Your bag is empty.</p>
        <Link to="/shop" className="btn">Browse products</Link>
      </div>
    );
  }

  const usingSaved = Boolean(user) && !useNew && selectedId;

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const { order } = await api.checkout({
        cartId: cart.id,
        email: contact.email,
        name: contact.name,
        // A saved address goes by id only — the server resolves it, so the
        // browser cannot quietly redirect an order somewhere else.
        ...(usingSaved
          ? { addressId: selectedId }
          : { address, saveAddress: Boolean(user) && saveForNextTime }),
      });
      await refreshCart();
      // The order exists but is unpaid; move to payment rather than straight to
      // the confirmation, which would imply it was complete.
      setPlacedOrder(order);
      setBusy(false);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <>
      <h1 style={{ fontSize: 27, marginBottom: 22 }}>Checkout</h1>

      <div className="cart-layout">
        <form className="panel" onSubmit={submit}>
          {error && <div className="alert error" style={{ marginBottom: 18 }}>{error}</div>}

          {!user && (
            <div className="alert info" style={{ marginBottom: 18 }}>
              Checking out as a guest. <Link to="/login" style={{ fontWeight: 600 }}>Sign in</Link> to save addresses and track your orders.
            </div>
          )}

          <h2>Contact</h2>
          <div className="form" style={{ marginBottom: 26 }}>
            <div className="row-2">
              <div className="field">
                <label htmlFor="name">Full name</label>
                <input
                  id="name" className="input" required autoComplete="name"
                  value={contact.name}
                  onChange={(e) => setContact((c) => ({ ...c, name: e.target.value }))}
                />
              </div>
              <div className="field">
                <label htmlFor="email">Email</label>
                <input
                  id="email" type="email" className="input" required autoComplete="email"
                  value={contact.email}
                  onChange={(e) => setContact((c) => ({ ...c, email: e.target.value }))}
                />
              </div>
            </div>
          </div>

          <h2>Delivery address</h2>

          {saved.length > 0 && (
            <div className="address-choices">
              {saved.map((a) => (
                <label key={a.id} className={`address-choice ${!useNew && selectedId === a.id ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="address"
                    checked={!useNew && selectedId === a.id}
                    onChange={() => { setSelectedId(a.id); setUseNew(false); }}
                  />
                  <span>
                    <strong>
                      {a.label}
                      {a.isDefault && <em className="tag">Default</em>}
                    </strong>
                    {addressLines(a).map((line) => <span key={line} className="line">{line}</span>)}
                  </span>
                </label>
              ))}

              <label className={`address-choice ${useNew ? 'selected' : ''}`}>
                <input type="radio" name="address" checked={useNew} onChange={() => setUseNew(true)} />
                <span><strong>Deliver somewhere else</strong></span>
              </label>
            </div>
          )}

          {(useNew || saved.length === 0) && (
            <>
              <AddressForm value={address} onChange={setAddress} />
              {user && (
                <label className="check" style={{ marginTop: 12 }}>
                  <input
                    type="checkbox"
                    checked={saveForNextTime}
                    onChange={(e) => setSaveForNextTime(e.target.checked)}
                  />
                  Save this address for next time
                </label>
              )}
            </>
          )}

          <button type="submit" className="btn block" style={{ marginTop: 24 }} disabled={busy}>
            {busy ? 'Placing order…' : `Continue to payment — ${money(cart.total)}`}
          </button>
        </form>

        <aside className="summary">
          <h3>In your bag</h3>
          {cart.items.map((item) => (
            <div key={item.itemId} style={{ display: 'flex', gap: 12, padding: '10px 0', alignItems: 'center' }}>
              <img
                src={item.product.image.thumb}
                alt=""
                width="48"
                height="48"
                style={{ borderRadius: 8, border: '1px solid var(--line)' }}
                loading="lazy"
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{item.product.name}</div>
                <small style={{ color: 'var(--muted)' }}>Qty {item.qty}</small>
              </div>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{money(item.lineTotal)}</span>
            </div>
          ))}

          <div className="summary-row" style={{ marginTop: 12 }}><span>Subtotal</span><span>{money(cart.subtotal)}</span></div>
          <div className="summary-row"><span>Shipping</span><span>{cart.shipping === 0 ? 'Free' : money(cart.shipping)}</span></div>
          <div className="summary-row"><span>GST (18%)</span><span>{money(cart.tax)}</span></div>
          <div className="summary-row total"><span>Total</span><span>{money(cart.total)}</span></div>
          {cart.shipping === 0 && (
            <p className="hint" style={{ marginTop: 8 }}>Free delivery applied.</p>
          )}
        </aside>
      </div>
    </>
  );
}

/**
 * The payment step. The order already exists and is holding stock; this settles it.
 *
 * Which processor is in play is decided by the server, not by a build flag —
 * `/payment-methods` reports `razorpay` once keys are configured and `mock`
 * otherwise, so the same page serves a real gateway and a dry demo.
 */
function PaymentStep({ order, onPaid }) {
  const [config, setConfig] = useState(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [card, setCard] = useState('4242424242424242');
  const [sandboxMethod, setSandboxMethod] = useState('upi');

  useEffect(() => {
    api.paymentMethods().then(setConfig).catch((err) => setProblem(err.message));
  }, []);

  /* ------------------------------ razorpay ------------------------------ */

  const payWithRazorpay = async () => {
    setBusy(true);
    setProblem(null);

    try {
      // 1. Server creates the Razorpay order and returns the public key id.
      const intent = await api.paymentIntent(order.number);

      // 2. Shopper pays in Razorpay's modal. Nothing sensitive touches us.
      const result = await openCheckout({ ...intent, onFailed: setProblem });

      if (result.dismissed) {
        setProblem('Payment cancelled. Your order is still reserved — you can pay when ready.');
        setBusy(false);
        return;
      }

      // 3. Server verifies the signature. Until this returns ok, the order is
      //    not paid, whatever the browser was handed.
      const verified = await api.verifyPayment(order.number, {
        razorpayOrderId: result.razorpayOrderId,
        razorpayPaymentId: result.razorpayPaymentId,
        razorpaySignature: result.razorpaySignature,
      });

      if (verified.ok) onPaid(verified.order);
      else setProblem(verified.error?.message || 'The payment did not complete.');
    } catch (err) {
      setProblem(err.message);
    } finally {
      setBusy(false);
    }
  };

  /* ------------------------------- simulated ---------------------------- */

  const payWithMock = async (event) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const result = await api.pay(order.number, { cardNumber: card });
      if (result.ok) onPaid(result.order);
      else setProblem(result.error?.message || 'The payment was declined.');
    } catch (err) {
      setProblem(err.message);
    } finally {
      setBusy(false);
    }
  };

  /* ------------------------------- sandbox ------------------------------ */

  const paySandbox = async (outcome) => {
    setBusy(true);
    setProblem(null);
    try {
      const result = await api.simulatePayment(order.number, { outcome, method: sandboxMethod });
      if (result.ok) onPaid(result.order);
      else setProblem(result.error?.message || 'The payment failed.');
    } catch (err) {
      setProblem(err.message);
    } finally {
      setBusy(false);
    }
  };

  const razorpay = config?.provider === 'razorpay';
  const sandbox = Boolean(config?.simulated);

  return (
    <div style={{ maxWidth: 520, margin: '0 auto' }}>
      <h1 style={{ fontSize: 27, marginBottom: 6 }}>Payment</h1>
      <p style={{ color: 'var(--muted)', marginTop: 0 }}>
        Order <span className="num">{order.number}</span> is reserved but not yet paid.
      </p>

      <div className="panel">
        {problem && <div className="alert error" style={{ marginBottom: 18 }}>{problem}</div>}

        {!config && <div className="skeleton" style={{ height: 120 }} />}

        {razorpay && sandbox && (
          <>
            <div className="alert info" style={{ marginBottom: 18 }}>
              <strong>Razorpay sandbox.</strong> Nothing is sent to Razorpay — the server
              stands in for the gateway, signing and verifying with your real keys so the
              same verification runs. Choose an outcome below.
            </div>

            <div className="form" style={{ marginBottom: 18 }}>
              <div className="field">
                <label htmlFor="sandbox-method">Pay using</label>
                <select
                  id="sandbox-method" className="input"
                  value={sandboxMethod} onChange={(e) => setSandboxMethod(e.target.value)}
                >
                  <option value="upi">UPI</option>
                  <option value="card">Card</option>
                  <option value="netbanking">Netbanking</option>
                  <option value="wallet">Wallet</option>
                </select>
              </div>
            </div>

            <div style={{ display: 'grid', gap: 10 }}>
              <button
                type="button" className="btn block"
                onClick={() => paySandbox('pass')} disabled={busy}
              >
                {busy ? 'Processing…' : `Pay ${money(order.total)} — succeed`}
              </button>
              <button
                type="button" className="btn ghost block"
                onClick={() => paySandbox('fail')} disabled={busy}
              >
                Simulate a failed payment
              </button>
            </div>

            <p style={{ textAlign: 'center', marginTop: 12, fontSize: 13, color: 'var(--muted)' }}>
              A failure releases the reserved stock — you can retry.
            </p>
          </>
        )}

        {razorpay && !sandbox && (
          <>
            <div className="alert info" style={{ marginBottom: 18 }}>
              <strong>Test mode.</strong> Pay by UPI, card, netbanking or wallet through
              Razorpay. These are test credentials — no real money moves.
            </div>

            <div className="pay-methods">
              {['UPI', 'Cards', 'Netbanking', 'Wallets'].map((m) => (
                <span key={m} className="pay-method">{m}</span>
              ))}
            </div>

            <button
              type="button"
              className="btn block"
              style={{ marginTop: 22 }}
              onClick={payWithRazorpay}
              disabled={busy}
            >
              {busy ? 'Opening Razorpay…' : `Pay ${money(order.total)}`}
            </button>

            <p style={{ textAlign: 'center', marginTop: 12, fontSize: 13, color: 'var(--muted)' }}>
              You'll pay on Razorpay's secure checkout. Card details never reach this shop.
            </p>
          </>
        )}

        {config && !razorpay && (
          <form onSubmit={payWithMock}>
            <div className="alert info" style={{ marginBottom: 18 }}>
              <strong>Simulated payments.</strong> Razorpay is not configured on this server,
              so the demo processor is standing in — pick a test card to choose the outcome.
            </div>

            <div className="form">
              <div className="field">
                <label htmlFor="card">Test card number</label>
                <select id="card" className="input" value={card} onChange={(e) => setCard(e.target.value)}>
                  <option value="4242424242424242">4242 4242 4242 4242 — Visa, succeeds</option>
                  <option value="5555555555554444">5555 5555 5555 4444 — Mastercard, succeeds</option>
                  <option value="4000000000000002">4000 0000 0000 0002 — declined</option>
                  <option value="4000000000009995">4000 0000 0000 9995 — insufficient funds</option>
                  <option value="4000000000000069">4000 0000 0000 0069 — expired card</option>
                </select>
              </div>
            </div>

            <button type="submit" className="btn block" style={{ marginTop: 22 }} disabled={busy}>
              {busy ? 'Processing…' : `Pay ${money(order.total)}`}
            </button>

            <p style={{ textAlign: 'center', marginTop: 12, fontSize: 13, color: 'var(--muted)' }}>
              A declined card releases the reserved stock — you can retry with another card.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
