import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { api, money } from '../api';
import ProductCard, { Rating } from '../components/ProductCard';
import Reviews from '../components/Reviews';
import { ArrowLeft, Shield, Truck } from '../components/Icons';
import { useShop } from '../store';

export default function Product() {
  const { id } = useParams();
  const { addItem, cart } = useShop();
  const [data, setData] = useState(null);
  const [qty, setQty] = useState(1);
  const [error, setError] = useState(null);

  useEffect(() => {
    setData(null);
    setQty(1);
    setError(null);
    window.scrollTo({ top: 0 });
    api.product(id).then(setData).catch((err) => setError(err.message));
  }, [id]);

  if (error) {
    return (
      <div className="empty">
        <h2>Product not found</h2>
        <p>{error}</p>
        <Link to="/shop" className="btn">Back to shop</Link>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="product">
        <div className="skeleton" style={{ aspectRatio: 1 }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="skeleton" style={{ height: 34, width: '70%' }} />
          <div className="skeleton" style={{ height: 20, width: '45%' }} />
          <div className="skeleton" style={{ height: 120 }} />
        </div>
      </div>
    );
  }

  const { product, related, reviews, reviewSummary } = data;
  const onSale = product.compareAtPrice && product.compareAtPrice > product.price;
  const stockTone = !product.inStock ? 'none' : product.stock <= 10 ? 'low' : '';

  return (
    <>
      <Link to="/shop" className="btn link" style={{ marginBottom: 20, display: 'inline-flex', gap: 6 }}>
        <ArrowLeft width={16} height={16} /> All products
      </Link>

      <div className="product">
        <div className="product-media">
          <img
            src={product.image.src}
            srcSet={product.image.srcset}
            sizes="(max-width: 940px) 92vw, 540px"
            width={product.image.width}
            height={product.image.height}
            alt={product.name}
          />
        </div>

        <div>
          <span className="card-cat">{product.category}</span>
          <h1>{product.name}</h1>
          <p className="lede">{product.tagline}</p>

          <Rating value={product.rating} count={product.reviews} />

          <div className="price-row">
            <span className="price">{money(product.price)}</span>
            {onSale && (
              <>
                <s style={{ color: 'var(--muted)' }}>{money(product.compareAtPrice)}</s>
                <span className="badge sale" style={{ position: 'static' }}>
                  Save {money(product.compareAtPrice - product.price)}
                </span>
              </>
            )}
          </div>

          <div className={`stock-line ${stockTone}`}>
            <span className="dot" />
            {!product.inStock
              ? 'Out of stock'
              : product.stock <= 10
                ? `Only ${product.stock} left`
                : 'In stock, ships tomorrow'}
          </div>

          <div className="buy-row">
            <div className="qty">
              <button type="button" onClick={() => setQty((n) => Math.max(1, n - 1))} disabled={qty <= 1} aria-label="Decrease quantity">−</button>
              <span>{qty}</span>
              <button type="button" onClick={() => setQty((n) => Math.min(product.stock, n + 1))} disabled={qty >= product.stock} aria-label="Increase quantity">+</button>
            </div>
            <button
              type="button"
              className="btn"
              style={{ flex: 1, minWidth: 180 }}
              disabled={!product.inStock}
              onClick={() => addItem(product, qty)}
            >
              {product.inStock ? `Add to bag — ${money(product.price * qty)}` : 'Sold out'}
            </button>
          </div>

          <p className="desc">{product.description}</p>

          <dl className="specs">
            {Object.entries(product.specs).map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>

          <div style={{ display: 'flex', gap: 22, marginTop: 22, color: 'var(--muted)', fontSize: 14, flexWrap: 'wrap' }}>
            {/* Threshold comes from the cart the server priced, not a literal —
                the shop is INR, and this line used to promise "$75". */}
            {cart?.freeShippingThreshold != null && (
              <span style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
                <Truck width={17} height={17} /> Free delivery over {money(cart.freeShippingThreshold)}
              </span>
            )}
            <span style={{ display: 'flex', gap: 7, alignItems: 'center' }}><Shield width={17} height={17} /> 2-year guarantee</span>
          </div>
        </div>
      </div>

      <Reviews productId={product.id} summary={reviewSummary} initial={reviews} />

      {related.length > 0 && (
        <section style={{ marginTop: 64 }}>
          <div className="section-head"><h2>More in {product.category}</h2></div>
          <div className="grid">
            {related.map((p) => <ProductCard key={p.id} product={p} />)}
          </div>
        </section>
      )}
    </>
  );
}
