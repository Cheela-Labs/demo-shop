import { Link } from 'react-router-dom';

import { money } from '../api';
import { Trash } from '../components/Icons';
import { useShop } from '../store';

export default function Cart() {
  const { cart, updateItem, removeItem } = useShop();

  if (!cart) return <div className="skeleton" style={{ height: 320 }} />;

  if (cart.items.length === 0) {
    return (
      <div className="empty">
        <h2>Your bag is empty</h2>
        <p>Once you add something it will show up here.</p>
        <Link to="/shop" className="btn">Start shopping</Link>
      </div>
    );
  }

  const remaining = cart.freeShippingThreshold - cart.subtotal;

  return (
    <>
      <h1 style={{ fontSize: 27, marginBottom: 22 }}>Your bag</h1>

      <div className="cart-layout">
        <section>
          {cart.items.map((item) => (
            <div className="line-item" key={item.itemId}>
              <Link to={`/product/${item.product.id}`}>
                <img src={item.product.image.thumb} alt={item.product.name} width="96" height="96" loading="lazy" />
              </Link>

              <div className="meta">
                <Link to={`/product/${item.product.id}`}><strong>{item.product.name}</strong></Link>
                <small>{item.product.tagline}</small>
                <small>{money(item.product.price)} each</small>
              </div>

              <div className="right">
                <span className="price">{money(item.lineTotal)}</span>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <div className="qty">
                    <button type="button" onClick={() => updateItem(item.itemId, item.qty - 1)} aria-label="Decrease quantity">−</button>
                    <span>{item.qty}</span>
                    <button
                      type="button"
                      onClick={() => updateItem(item.itemId, item.qty + 1)}
                      disabled={item.qty >= item.product.stock}
                      aria-label="Increase quantity"
                    >
                      +
                    </button>
                  </div>
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => removeItem(item.itemId)}
                    aria-label={`Remove ${item.product.name}`}
                  >
                    <Trash width={16} height={16} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </section>

        <aside className="summary">
          <h3>Order summary</h3>

          {remaining > 0 && (
            <p className="free-ship">Spend {money(remaining)} more for free shipping.</p>
          )}

          <div className="summary-row"><span>Subtotal ({cart.count} items)</span><span>{money(cart.subtotal)}</span></div>
          <div className="summary-row">
            <span>Shipping</span>
            <span>{cart.shipping === 0 ? 'Free' : money(cart.shipping)}</span>
          </div>
          <div className="summary-row"><span>Estimated tax</span><span>{money(cart.tax)}</span></div>
          <div className="summary-row total"><span>Total</span><span>{money(cart.total)}</span></div>

          <Link to="/checkout" className="btn block" style={{ marginTop: 18 }}>Checkout</Link>
          <p className="note">Taxes calculated at 8%. No card is ever charged — this is a demo.</p>
        </aside>
      </div>
    </>
  );
}
