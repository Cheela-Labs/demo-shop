import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { api } from '../api';
import ProductCard from '../components/ProductCard';

const SORTS = [
  ['featured', 'Featured'],
  ['price-asc', 'Price: low to high'],
  ['price-desc', 'Price: high to low'],
  ['rating', 'Top rated'],
  ['name', 'Name A–Z'],
];

export default function Catalog() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState({ items: [], total: 0, pages: 1, page: 1 });
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);

  const category = params.get('category') || 'All';
  const sort = params.get('sort') || 'featured';
  const q = params.get('q') || '';
  const page = Number(params.get('page') || 1);
  const inStock = params.get('inStock') === 'true';

  useEffect(() => { api.categories().then((r) => setCategories(r.items)); }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    api.products({ category, sort, q, page, inStock: inStock ? 'true' : '', limit: 12 })
      .then(setData)
      .catch((err) => { if (err.name !== 'AbortError') setData({ items: [], total: 0, pages: 1, page: 1 }); })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [category, sort, q, page, inStock]);

  /** Patch the query string, resetting pagination whenever filters change. */
  const patch = (changes) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value == null || value === '' || value === 'All' || value === false) next.delete(key);
      else next.set(key, String(value));
    }
    if (!('page' in changes)) next.delete('page');
    setParams(next);
  };

  const total = categories.reduce((sum, c) => sum + c.count, 0);

  return (
    <div className="catalog">
      <aside>
        <div className="filters">
          <h3>Category</h3>
          <div className="filter-list">
            <button
              type="button"
              className={category === 'All' ? 'active' : ''}
              onClick={() => patch({ category: null })}
            >
              All products <small>{total}</small>
            </button>
            {categories.map((c) => (
              <button
                key={c.name}
                type="button"
                className={category === c.name ? 'active' : ''}
                onClick={() => patch({ category: c.name })}
              >
                {c.name} <small>{c.count}</small>
              </button>
            ))}
          </div>
        </div>

        <div className="filters">
          <h3>Availability</h3>
          <label style={{ display: 'flex', gap: 9, alignItems: 'center', fontSize: 14.5, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={inStock}
              onChange={(e) => patch({ inStock: e.target.checked })}
            />
            In stock only
          </label>
        </div>
      </aside>

      <section>
        <div className="toolbar">
          <div>
            <h1 style={{ fontSize: 25, marginBottom: 4 }}>
              {q ? `Results for “${q}”` : category === 'All' ? 'All products' : category}
            </h1>
            <span className="count">
              {loading ? 'Loading…' : `${data.total} product${data.total === 1 ? '' : 's'}`}
            </span>
          </div>

          <select
            className="select"
            value={sort}
            onChange={(e) => patch({ sort: e.target.value })}
            aria-label="Sort products"
          >
            {SORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>

        {loading ? (
          <div className="grid">
            {Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton skeleton-card" />)}
          </div>
        ) : data.items.length === 0 ? (
          <div className="empty">
            <h2>Nothing matched</h2>
            <p>Try a different search or clear the filters.</p>
            <button type="button" className="btn ghost" onClick={() => setParams(new URLSearchParams())}>
              Clear filters
            </button>
          </div>
        ) : (
          <>
            <div className="grid">
              {data.items.map((p) => <ProductCard key={p.id} product={p} />)}
            </div>

            {data.pages > 1 && (
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 34, alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={data.page <= 1}
                  onClick={() => patch({ page: data.page - 1 })}
                >
                  Previous
                </button>
                <span className="count">Page {data.page} of {data.pages}</span>
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={data.page >= data.pages}
                  onClick={() => patch({ page: data.page + 1 })}
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
