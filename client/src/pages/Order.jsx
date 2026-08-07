import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { api, money } from '../api';
import { Check } from '../components/Icons';

export default function Order() {
  const { id } = useParams();
  const [order, setOrder] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.order(id).then((r) => setOrder(r.order)).catch((err) => setError(err.message));
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
