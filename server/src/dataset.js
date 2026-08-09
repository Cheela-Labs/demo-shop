/**
 * Reads the bulk catalogue from CSV and maps it onto the shop's product shape.
 *
 * The CSVs live in `server/data/dataset/` and use the column names from the
 * Kaggle e-commerce dataset (abhayayare/e-commerce-dataset):
 *
 *   products.csv   product_id, product_name, category, price, rating
 *   reviews.csv    review_id, user_id, product_id, rating, review_text, review_date
 *   users.csv      user_id, name, ...
 *
 * `scripts/generate-dataset.mjs` writes files in exactly that layout, so the
 * repo builds without a Kaggle account. Swapping in the real download is a file
 * copy — nothing here reads a column the Kaggle files do not have.
 *
 * What the CSVs do *not* carry is everything that makes a product page worth
 * looking at: no tagline, no description, no stock, no specs, no artwork. Those
 * are synthesised here, deterministically from the product id, so the same CSV
 * always produces the same catalogue and the image cache stays valid across
 * builds.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { artNames, paletteNames } from './svg.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATASET_DIR = join(HERE, '..', 'data', 'dataset');

/* ---------------------------------- csv ----------------------------------- */

/**
 * Minimal RFC 4180 parser.
 *
 * Hand-rolled rather than pulled from npm because the review text contains
 * commas and quotes, which is exactly the case a `split(',')` gets wrong, and
 * exactly the case a 40-line parser gets right. Handles quoted fields, escaped
 * `""`, and CRLF.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];

    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += c;
      continue;
    }

    if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      // A trailing newline must not produce a phantom row of one empty cell.
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])));
}

function readCsv(name) {
  const path = join(DATASET_DIR, name);
  if (!existsSync(path)) return null;
  return parseCsv(readFileSync(path, 'utf8'));
}

/* -------------------------------- synthesis -------------------------------- */

/** Same hash as svg.js uses for artwork seeding — stable, and good enough here. */
function hash(text) {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) n = (n * 31 + text.charCodeAt(i)) % 1000003;
  return n;
}

const at = (list, n) => list[n % list.length];

/**
 * Product type -> artwork template. The 15 templates in svg.js are the whole
 * vocabulary, so this is a best fit rather than a match: a Soundbar is drawn as
 * a speaker because that is closer than the alternative, and a Monitor borrows
 * the keyboard's desk silhouette.
 *
 * Checked longest-first, so "Trail Shoes" is not caught by "shoe" landing on a
 * different rule than "trail" would.
 */
const ART_BY_KEYWORD = [
  ['headphone', 'headphones'], ['earbud', 'earbuds'], ['soundbar', 'speaker'],
  ['turntable', 'speaker'], ['microphone', 'speaker'], ['speaker', 'speaker'],
  ['keyboard', 'keyboard'], ['mouse', 'keyboard'], ['monitor', 'keyboard'],
  ['tablet stand', 'keyboard'], ['webcam', 'camera'], ['camera', 'camera'],
  ['smartwatch', 'watch'], ['watch', 'watch'],
  ['sneaker', 'sneaker'], ['runner', 'sneaker'], ['shoe', 'sneaker'],
  ['loafer', 'sneaker'], ['boot', 'sneaker'],
  ['backpack', 'backpack'], ['duffel', 'backpack'], ['sling', 'backpack'],
  ['dry bag', 'backpack'], ['tote', 'tote'], ['sleeve', 'tote'],
  ['wallet', 'tote'], ['belt', 'tote'], ['cap', 'tote'],
  ['mug', 'mug'], ['cutting board', 'mug'], ['lamp', 'lamp'],
  ['chair', 'chair'], ['hammock', 'chair'], ['blanket', 'chair'],
  ['planter', 'plant'], ['plant', 'plant'],
  ['sunglass', 'sunglasses'],
  ['bottle', 'bottle'], ['stove', 'bottle'], ['pole', 'bottle'],
];

function artFor(name, seed) {
  const lower = name.toLowerCase();
  for (const [needle, art] of ART_BY_KEYWORD) {
    if (lower.includes(needle)) return art;
  }
  // Unknown vocabulary — the real Kaggle categories land here. Deterministic
  // fallback keeps every product looking like *something*.
  return at(artNames, seed);
}

const MATERIALS = [
  'brushed aluminium', 'oiled walnut', 'recycled polyester', 'full-grain leather',
  'anodised steel', 'organic cotton canvas', 'matte polycarbonate', 'cork composite',
  'powder-coated steel', 'merino wool', 'ripstop nylon', 'borosilicate glass',
];

const OPENERS = [
  'Built around one job and finished properly',
  'The unfussy option, and the one that lasts',
  'Designed to be the last one you buy',
  'Quietly over-engineered where it matters',
  'Everything it needs and nothing it does not',
  'Made to be used daily, not admired occasionally',
];

const CLOSERS = [
  'Ships flat-packed and needs no tools.',
  'Covered by a two-year warranty and a real repair service.',
  'Every unit is checked by hand before it is boxed.',
  'Spare parts are stocked for five years after the last one sells.',
  'Packed in moulded pulp — no foam, no plastic film.',
  'Returns are free for thirty days, opened or not.',
];

const TAGLINES = [
  'Small footprint, long service life',
  'The details you only notice later',
  'Honest materials, sensible price',
  'Tested harder than you will use it',
  'Simple to live with',
  'Made to disappear into daily use',
];

/**
 * Maps one CSV row onto the shop's product shape.
 *
 * Prices arrive as a float in rupees — that is how the Kaggle file expresses
 * them — and the shop stores integer paise, so this is the one place the
 * conversion happens. `Math.round` rather than truncation: 1299.99 must not
 * become ₹1,299.98.
 */
export function toProduct(row) {
  const id = String(row.product_id || '').trim();
  const name = String(row.product_name || '').trim();
  if (!id || !name) return null;

  const category = String(row.category || 'General').trim() || 'General';
  const price = Math.round(Number(row.price) * 100);
  if (!Number.isFinite(price) || price <= 0) return null;

  const seed = hash(id);
  const material = at(MATERIALS, seed);
  const type = name.split(' ').slice(-1)[0].toLowerCase();

  // Roughly a third carry a strike-through price. Always higher than the real
  // one — a compare-at below the price renders as a negative saving.
  const discounted = seed % 3 === 0;

  // One in eleven is out of stock, so `inStock` filtering and the "sold out"
  // path have something to act on in a catalogue this size.
  const soldOut = seed % 11 === 0;

  return {
    id: `d-${id.toLowerCase()}`,
    name,
    tagline: at(TAGLINES, seed >> 3),
    description:
      `${at(OPENERS, seed >> 5)}. The ${name} is made from ${material}, ` +
      `and sized for everyday use rather than for a spec sheet. ` +
      `${at(CLOSERS, seed >> 7)}`,
    price,
    compareAtPrice: discounted ? Math.round((price * (115 + (seed % 25))) / 10000) * 100 : null,
    category,
    tags: [type, category.toLowerCase(), material.split(' ').slice(-1)[0]],
    rating: Number(row.rating) || 0,
    reviews: 0, // recomputed from reviews.csv during seeding
    stock: soldOut ? 0 : 3 + (seed % 140),
    featured: false, // assigned after load, from the top of the rating order
    art: artFor(name, seed),
    palette: at(paletteNames, seed >> 2),
    specs: {
      Material: material[0].toUpperCase() + material.slice(1),
      Category: category,
      Warranty: `${1 + (seed % 3)} years`,
      SKU: id,
    },
  };
}

/* ---------------------------------- load ----------------------------------- */

/**
 * Loads the dataset, or returns empty arrays if it has not been generated.
 *
 * Missing files are not an error: the shop still boots on its 16 curated
 * products, which is what `npm run dev` wants when nobody has run the generator
 * yet. The Dockerfile runs the generator explicitly, so a deployed image always
 * has the full catalogue.
 */
export function loadDataset() {
  const productRows = readCsv('products.csv');
  if (!productRows) return { products: [], reviews: [], present: false };

  const products = productRows.map(toProduct).filter(Boolean);

  const userRows = readCsv('users.csv') || [];
  const names = new Map(userRows.map((u) => [u.user_id, u.name]));

  const reviewRows = readCsv('reviews.csv') || [];
  const reviews = [];
  for (const row of reviewRows) {
    const rating = Number(row.rating);
    const productId = String(row.product_id || '').trim();
    const body = String(row.review_text || '').trim();
    // A review with no text or no score is a row the product page cannot draw.
    if (!productId || !body || !(rating >= 1 && rating <= 5)) continue;

    reviews.push({
      id: String(row.review_id || '').trim() || `r-${reviews.length}`,
      productId: `d-${productId.toLowerCase()}`,
      author: names.get(row.user_id) || 'Verified buyer',
      rating: Math.round(rating),
      body,
      createdAt: String(row.review_date || '').trim() || null,
    });
  }

  return { products, reviews, present: true };
}
