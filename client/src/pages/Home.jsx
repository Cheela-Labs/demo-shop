import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../api';
import ProductCard from '../components/ProductCard';
import { ArrowRight, Leaf, Shield, Truck } from '../components/Icons';

export default function Home() {
  const [featured, setFeatured] = useState([]);
  const [recent, setRecent] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.products({ featured: 'true', limit: 8 }),
      api.products({ sort: 'rating', limit: 4 }),
      api.categories(),
    ])
      .then(([f, r, c]) => {
        setFeatured(f.items);
        setRecent(r.items);
        setCategories(c.items);
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <>
      <section className="hero">
        <div>
          <span className="eyebrow">New season</span>
          <h1>Things worth keeping.</h1>
          <p>
            A short catalogue of everyday objects, chosen because they are built properly
            and get better with use. No filler, no forty near-identical variants.
          </p>
          <div className="hero-actions">
            <Link to="/shop" className="btn">Shop everything <ArrowRight width={17} height={17} /></Link>
            <Link to="/shop?category=Audio" className="btn ghost">Browse audio</Link>
          </div>
        </div>

        <div className="hero-art">
          {featured.slice(0, 4).map((p) => (
            <Link key={p.id} to={`/product/${p.id}`}>
              <img src={p.image.thumb} alt={p.name} width="400" height="400" />
            </Link>
          ))}
        </div>
      </section>

      <section style={{ marginBottom: 46 }}>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
          {[
            [<Truck key="t" />, 'Free shipping over $75', 'Two to four working days, tracked.'],
            [<Shield key="s" />, '2-year guarantee', 'Covers everything but obvious abuse.'],
            [<Leaf key="l" />, 'Recycled where we can', 'And honest about where we cannot.'],
          ].map(([icon, title, body]) => (
            <div key={title} className="panel" style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
              <span style={{ color: 'var(--brand)', flex: 'none', marginTop: 2 }}>{icon}</span>
              <div>
                <strong style={{ display: 'block', fontSize: 15 }}>{title}</strong>
                <small style={{ color: 'var(--muted)' }}>{body}</small>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section style={{ marginBottom: 46 }}>
        <div className="section-head">
          <div>
            <h2>Featured</h2>
            <p>The ones we keep recommending.</p>
          </div>
          <Link to="/shop" className="btn link">View all</Link>
        </div>

        <div className="grid">
          {loading
            ? Array.from({ length: 4 }, (_, i) => <div key={i} className="skeleton skeleton-card" />)
            : featured.map((p) => <ProductCard key={p.id} product={p} />)}
        </div>
      </section>

      <section style={{ marginBottom: 46 }}>
        <div className="section-head">
          <div>
            <h2>Shop by category</h2>
          </div>
        </div>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
          {categories.map((c) => (
            <Link key={c.name} to={`/shop?category=${encodeURIComponent(c.name)}`} className="panel" style={{ textAlign: 'center' }}>
              <strong style={{ display: 'block' }}>{c.name}</strong>
              <small style={{ color: 'var(--muted)' }}>{c.count} item{c.count === 1 ? '' : 's'}</small>
            </Link>
          ))}
        </div>
      </section>

      <section>
        <div className="section-head">
          <div>
            <h2>Highest rated</h2>
            <p>Ranked by the people who actually bought them.</p>
          </div>
        </div>
        <div className="grid">
          {recent.map((p) => <ProductCard key={p.id} product={p} />)}
        </div>
      </section>
    </>
  );
}
