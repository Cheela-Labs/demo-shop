import { useState } from 'react';

import { api } from '../api';
import { Star } from './Icons';

const PAGE = 5;

const SORTS = [
  ['recent', 'Most recent'],
  ['helpful', 'Highest rated'],
  ['critical', 'Most critical'],
];

/** "12 Mar 2025" — short, unambiguous, and not a relative time that goes stale. */
function formatDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function Stars({ value }) {
  return (
    <span className="review-stars" aria-label={`${value} out of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} width={13} height={13} filled={n <= value} />
      ))}
    </span>
  );
}

/**
 * The star breakdown.
 *
 * Bars are drawn from the largest bucket rather than from the total, so the
 * shape stays readable on a product where 90% of reviews are five stars — the
 * point of the histogram is the relative distribution, and scaling to the total
 * flattens every other row into an invisible sliver.
 */
function Histogram({ histogram, total }) {
  const peak = Math.max(...Object.values(histogram), 1);

  return (
    <div className="review-histogram">
      {[5, 4, 3, 2, 1].map((stars) => {
        const n = histogram[stars] ?? 0;
        return (
          <div key={stars} className="review-histogram-row">
            <span className="review-histogram-label">{stars}★</span>
            <span className="review-histogram-track">
              <span className="review-histogram-fill" style={{ width: `${(n / peak) * 100}%` }} />
            </span>
            <span className="review-histogram-count">
              {total ? `${Math.round((n / total) * 100)}%` : '—'}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Reviews for one product.
 *
 * The first page arrives with the product itself, so the common case renders
 * without a second request. Paging and re-sorting go back to the server rather
 * than fetching everything up front: the busiest product in the catalogue
 * carries a few hundred reviews and nobody scrolls all of them.
 */
export default function Reviews({ productId, summary, initial }) {
  const [items, setItems] = useState(initial?.items ?? []);
  const [total, setTotal] = useState(initial?.total ?? 0);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState('recent');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (!summary || summary.total === 0) {
    return (
      <section className="reviews" id="reviews">
        <div className="section-head"><h2>Reviews</h2></div>
        <p className="muted">No reviews yet. Yours would be the first.</p>
      </section>
    );
  }

  async function load(nextPage, nextSort) {
    setBusy(true);
    setError(null);
    try {
      const data = await api.reviews(productId, { page: nextPage, limit: PAGE, sort: nextSort });
      // Re-sorting replaces the list; paging appends to it.
      setItems((prev) => (nextPage === 1 ? data.items : [...prev, ...data.items]));
      setTotal(data.total);
      setPage(nextPage);
      setSort(nextSort);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const shown = items.length;
  const more = shown < total;

  return (
    <section className="reviews" id="reviews">
      <div className="section-head">
        <h2>Reviews</h2>
        <div className="review-sorts">
          {SORTS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`btn link${sort === value ? ' is-active' : ''}`}
              aria-pressed={sort === value}
              disabled={busy}
              onClick={() => load(1, value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="review-summary">
        <div className="review-average">
          <strong>{summary.average?.toFixed(1)}</strong>
          <Stars value={Math.round(summary.average ?? 0)} />
          <span className="muted">{summary.total.toLocaleString('en-IN')} reviews</span>
        </div>
        <Histogram histogram={summary.histogram} total={summary.total} />
      </div>

      <ol className="review-list">
        {items.map((review) => {
          const date = formatDate(review.createdAt);
          return (
            <li key={review.id} className="review">
              <div className="review-head">
                <Stars value={review.rating} />
                <span className="review-author">{review.author}</span>
                {date && <time className="muted" dateTime={review.createdAt}>{date}</time>}
              </div>
              <p>{review.body}</p>
            </li>
          );
        })}
      </ol>

      {error && <p className="form-error">{error}</p>}

      {more && (
        <button type="button" className="btn ghost" disabled={busy} onClick={() => load(page + 1, sort)}>
          {busy ? 'Loading…' : `Show more — ${(total - shown).toLocaleString('en-IN')} left`}
        </button>
      )}
    </section>
  );
}
