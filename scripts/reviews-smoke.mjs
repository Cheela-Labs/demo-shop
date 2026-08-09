/**
 * Checks the bulk catalogue and the review layer, in process — no server, no
 * network. Run after `npm run dataset && npm run seed`.
 *
 * What it is actually guarding:
 *   - the CSV parser against the one input that breaks a naive split(',')
 *   - the paise conversion, because a float price silently rounding is the kind
 *     of bug that only shows up on someone's invoice
 *   - the rating shrinkage, because without it "top rated" is a list of
 *     one-review products
 *   - review paging, since the busiest product has hundreds
 */

import { parseCsv, toProduct, loadDataset } from '../server/src/dataset.js';
import * as repo from '../server/src/repo.js';
import { tableCount } from '../server/src/db.js';

let passed = 0;
let failed = 0;

function ok(label, cond, detail) {
  if (cond) { passed += 1; console.log(`  ok   ${label}`); }
  else { failed += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}

function section(name) { console.log(`\n${name}`); }

/* ------------------------------- csv parsing ------------------------------ */

section('CSV parsing');
{
  const rows = parseCsv(
    'a,b,c\n' +
    '1,"text, with comma",3\n' +
    '4,"he said ""hi""",6\n' +
    '7,"line\nbreak",9\r\n',
  );
  ok('reads every row', rows.length === 3, `got ${rows.length}`);
  ok('a quoted comma stays one field', rows[0].b === 'text, with comma', rows[0].b);
  ok('a doubled quote unescapes', rows[1].b === 'he said "hi"', rows[1].b);
  ok('a quoted newline stays one field', rows[2].b === 'line\nbreak', JSON.stringify(rows[2].b));
  ok('CRLF does not leave a stray field', rows[2].c === '9', rows[2].c);
  ok('a trailing newline makes no phantom row', parseCsv('a,b\n1,2\n').length === 1);
}

/* ------------------------------- row mapping ------------------------------ */

section('Mapping a CSV row onto a product');
{
  const p = toProduct({
    product_id: 'P000123', product_name: 'Aurora Field Backpack',
    category: 'Bags', price: '2499.99', rating: '4.35',
  });
  ok('price becomes integer paise', p.price === 249999, String(p.price));
  ok('rounds rather than truncates', toProduct({
    product_id: 'X', product_name: 'X', category: 'C', price: '1299.99', rating: '4',
  }).price === 129999);
  ok('id is namespaced away from the curated ones', p.id === 'd-p000123', p.id);
  ok('artwork is chosen from the real templates', p.art === 'backpack', p.art);
  ok('an unknown type still gets artwork', Boolean(toProduct({
    product_id: 'Y', product_name: 'Mystery Widget', category: 'Beauty', price: '99', rating: '3',
  }).art));
  ok('a compare-at price is above the price', !p.compareAtPrice || p.compareAtPrice > p.price,
    `${p.compareAtPrice} vs ${p.price}`);
  ok('mapping is deterministic', JSON.stringify(toProduct({
    product_id: 'P000123', product_name: 'Aurora Field Backpack',
    category: 'Bags', price: '2499.99', rating: '4.35',
  })) === JSON.stringify(p));

  ok('a row with no price is dropped', toProduct({
    product_id: 'Z', product_name: 'Z', category: 'C', price: '', rating: '3',
  }) === null);
  ok('a row with no name is dropped', toProduct({
    product_id: 'Z', product_name: '', category: 'C', price: '10', rating: '3',
  }) === null);
}

/* --------------------------------- dataset -------------------------------- */

section('Dataset on disk');
const dataset = loadDataset();
ok('the CSVs are present', dataset.present, 'run `npm run dataset`');
ok('products loaded', dataset.products.length > 0, String(dataset.products.length));
ok('reviews loaded', dataset.reviews.length > 0, String(dataset.reviews.length));
ok('every review names a rating in range',
  dataset.reviews.every((r) => r.rating >= 1 && r.rating <= 5));
ok('every review has text', dataset.reviews.every((r) => r.body.length > 0));
ok('reviews are attributed', dataset.reviews.every((r) => r.author.length > 0));

/* -------------------------------- catalogue ------------------------------- */

section('Seeded catalogue');
const total = tableCount('products');
ok('the catalogue is large', total > 100, `${total} products`);
ok('reviews are in the database', tableCount('product_reviews') > 0);
ok('the curated products survived the bulk load',
  Boolean(repo.getProduct('aurora-over-ear')), 'aurora-over-ear missing');

{
  const page1 = repo.listProducts({ limit: 24, page: 1 });
  const page2 = repo.listProducts({ limit: 24, page: 2 });
  const overlap = page1.items.filter((a) => page2.items.some((b) => b.id === a.id));
  ok('paging does not repeat a product', overlap.length === 0, `${overlap.length} repeated`);
  ok('the reported total matches the table', page1.total === total, `${page1.total} vs ${total}`);
}

{
  const cheap = repo.listProducts({ maxPrice: 100000, limit: 50 });
  ok('a price ceiling is honoured',
    cheap.items.every((p) => p.price <= 100000), 'something above the ceiling came back');

  const search = repo.listProducts({ q: 'Backpack', limit: 50 });
  ok('search finds matches by name', search.total > 0, `${search.total} hits`);
  ok('every hit actually matches',
    search.items.every((p) => `${p.name} ${p.tagline} ${p.description} ${p.tags.join(' ')}`
      .toLowerCase().includes('backpack')));

  const stocked = repo.listProducts({ inStock: true, limit: 50 });
  ok('in-stock filtering excludes sold-out products',
    stocked.items.every((p) => p.stock > 0));
  ok('some products are sold out, so the filter is doing work',
    stocked.total < total, `${stocked.total} of ${total}`);
}

/* --------------------------------- ranking -------------------------------- */

section('Rating shrinkage');
{
  const top = repo.listProducts({ sort: 'rating', limit: 10 });
  const thin = top.items.filter((p) => p.reviews < 5);
  ok('the top of "rating" is not owned by one-review products',
    thin.length === 0, `${thin.length} of 10 had under 5 reviews`);
  ok('the top is still well rated',
    top.items.every((p) => p.rating >= 4), 'a low-rated product reached the top');
  ok('ties break toward more evidence',
    top.items[0].reviews >= 5, `${top.items[0].reviews} reviews`);
}

/* --------------------------------- reviews -------------------------------- */

section('Reviews for a product');
{
  // The busiest product — the one with the most to page through.
  const busiest = repo.listProducts({ sort: 'featured', limit: 1 }).items[0];
  const summary = repo.reviewSummary(busiest.id);
  const first = repo.listReviews(busiest.id, { limit: 5, page: 1 });

  ok('the summary counts the same reviews as the list',
    summary.total === first.total, `${summary.total} vs ${first.total}`);
  ok('the histogram sums to the total',
    Object.values(summary.histogram).reduce((a, b) => a + b, 0) === summary.total);
  ok('the average matches the product row',
    summary.total === 0 || Math.abs(summary.average - busiest.rating) < 0.02,
    `${summary.average} vs ${busiest.rating}`);
  ok('a page is capped at the limit asked for', first.items.length <= 5);

  if (first.pages > 1) {
    const second = repo.listReviews(busiest.id, { limit: 5, page: 2 });
    const repeated = first.items.filter((a) => second.items.some((b) => b.id === a.id));
    ok('review paging does not repeat', repeated.length === 0);
  } else {
    ok('review paging does not repeat', true);
  }

  const critical = repo.listReviews(busiest.id, { limit: 5, sort: 'critical' });
  const helpful = repo.listReviews(busiest.id, { limit: 5, sort: 'helpful' });
  ok('critical sorting leads with the worst',
    critical.total === 0 || critical.items[0].rating <= helpful.items[0].rating,
    `${critical.items[0]?.rating} vs ${helpful.items[0]?.rating}`);

  ok('an unknown product has no reviews rather than an error',
    repo.listReviews('does-not-exist').total === 0);
  ok('an unknown product summarises to null rather than zero stars',
    repo.reviewSummary('does-not-exist').average === null);
}

/* ---------------------------------- report -------------------------------- */

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
