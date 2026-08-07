import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';

import { api, money } from '../api';
import { useShop } from '../store';
import AddressForm, { BLANK_ADDRESS, addressLines } from '../components/AddressForm';

export default function Account() {
  const { user, ready, signOut } = useShop();
  const [orders, setOrders] = useState(null);

  useEffect(() => {
    if (user) api.myOrders().then((r) => setOrders(r.items)).catch(() => setOrders([]));
  }, [user]);

  if (!ready) return <div className="skeleton" style={{ height: 280 }} />;
  if (!user) return <Navigate to="/login" replace />;

  return (
    <>
      <div className="section-head">
        <div>
          <h1 style={{ fontSize: 27 }}>Your account</h1>
          <p>{user.name} · {user.email}</p>
        </div>
        <button type="button" className="btn ghost" onClick={signOut}>Sign out</button>
      </div>

      <AddressBook />

      <h2 style={{ fontSize: 19, margin: '30px 0 16px' }}>Order history</h2>

      {orders === null ? (
        <div className="skeleton" style={{ height: 120 }} />
      ) : orders.length === 0 ? (
        <div className="empty">
          <h2>No orders yet</h2>
          <p>Orders you place while signed in will show up here.</p>
          <Link to="/shop" className="btn">Browse products</Link>
        </div>
      ) : (
        orders.map((order) => (
          <Link key={order.id} to={`/order/${order.number}`} className="order-card">
            <header>
              <div>
                <strong style={{ fontFamily: 'ui-monospace, monospace' }}>{order.number}</strong>
                <div style={{ color: 'var(--muted)', fontSize: 13.5 }}>
                  {new Date(`${order.createdAt}Z`).toLocaleDateString(undefined, {
                    year: 'numeric', month: 'short', day: 'numeric',
                  })}
                </div>
              </div>
              <span className="pill">{order.status}</span>
            </header>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {order.items.slice(0, 5).map((item) => (
                <img
                  key={item.productId}
                  src={item.image.thumb}
                  alt={item.name}
                  width="44"
                  height="44"
                  style={{ width: 44, height: 44, borderRadius: 8, border: '1px solid var(--line)' }}
                  loading="lazy"
                />
              ))}
              <span style={{ marginLeft: 'auto', fontWeight: 700 }}>{money(order.total)}</span>
            </div>
          </Link>
        ))
      )}
    </>
  );
}

/**
 * The saved address book.
 *
 * Deleting is confirmed inline rather than with `window.confirm`, which blocks
 * the whole page and cannot be styled — and, in this project, would also freeze
 * the assistant panel's event loop if one were ever open behind it.
 */
function AddressBook() {
  const [items, setItems] = useState(null);
  const [editing, setEditing] = useState(null); // address id, or 'new'
  const [draft, setDraft] = useState(BLANK_ADDRESS);
  const [confirming, setConfirming] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = () => api.addresses()
    .then(({ items: list }) => setItems(list))
    .catch((err) => { setError(err.message); setItems([]); });

  useEffect(() => { load(); }, []);

  const startNew = () => { setDraft(BLANK_ADDRESS); setEditing('new'); setError(null); };
  const startEdit = (a) => { setDraft(a); setEditing(a.id); setError(null); };
  const cancel = () => { setEditing(null); setError(null); };

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (editing === 'new') await api.addAddress(draft);
      else await api.updateAddress(editing, draft);
      await load();
      setEditing(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn) => {
    setBusy(true);
    setError(null);
    try { await fn(); await load(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <section style={{ marginTop: 30 }}>
      <div className="section-head" style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 19 }}>Saved addresses</h2>
        {editing === null && (
          <button type="button" className="btn ghost sm" onClick={startNew}>Add address</button>
        )}
      </div>

      {error && <div className="alert error" style={{ marginBottom: 14 }}>{error}</div>}

      {editing !== null && (
        <form className="panel" onSubmit={save} style={{ marginBottom: 18 }}>
          <AddressForm value={draft} onChange={setDraft} />
          <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
            <button type="submit" className="btn" disabled={busy}>
              {busy ? 'Saving…' : editing === 'new' ? 'Save address' : 'Save changes'}
            </button>
            <button type="button" className="btn ghost" onClick={cancel} disabled={busy}>Cancel</button>
          </div>
        </form>
      )}

      {items === null ? (
        <div className="skeleton" style={{ height: 110 }} />
      ) : items.length === 0 && editing === null ? (
        <p style={{ color: 'var(--muted)' }}>
          No saved addresses yet. Add one and checkout becomes a single click.
        </p>
      ) : (
        <div className="address-grid">
          {items.map((a) => (
            <article key={a.id} className={`address-card ${a.isDefault ? 'is-default' : ''}`}>
              <header>
                <strong>{a.label}</strong>
                {a.isDefault && <em className="tag">Default</em>}
              </header>
              <p className="who">{a.name}</p>
              {addressLines(a).map((line) => <p key={line} className="line">{line}</p>)}

              {confirming === a.id ? (
                <div className="address-actions">
                  <span style={{ color: 'var(--muted)', fontSize: 13 }}>Delete this address?</span>
                  <button type="button" className="link danger" disabled={busy}
                    onClick={() => act(() => api.deleteAddress(a.id)).then(() => setConfirming(null))}>
                    Yes, delete
                  </button>
                  <button type="button" className="link" onClick={() => setConfirming(null)}>Keep</button>
                </div>
              ) : (
                <div className="address-actions">
                  {!a.isDefault && (
                    <button type="button" className="link" disabled={busy}
                      onClick={() => act(() => api.makeDefaultAddress(a.id))}>
                      Make default
                    </button>
                  )}
                  <button type="button" className="link" onClick={() => startEdit(a)}>Edit</button>
                  <button type="button" className="link danger" onClick={() => setConfirming(a.id)}>Delete</button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
