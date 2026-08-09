/**
 * Generates a large product + review dataset as CSV.
 *
 * The column layout is deliberately the one from the Kaggle e-commerce dataset
 * (abhayayare/e-commerce-dataset), because that dataset needs an account to
 * download and this repo should not need one to build:
 *
 *   products.csv   product_id, product_name, category, price, rating
 *   reviews.csv    review_id, user_id, product_id, rating, review_text, review_date
 *   users.csv      user_id, name, email, gender, city, signup_date
 *
 * Dropping the real Kaggle CSVs into the same directory therefore works with no
 * code change — `dataset.js` reads these column names and nothing else. The
 * Kaggle files carry three more tables (orders, order_items, events) which this
 * shop has no use for: it generates real orders through its own checkout.
 *
 * Everything here is seeded, so the same command produces byte-identical files.
 * That matters because the output is baked into the container image: a
 * non-deterministic generator would invalidate the Docker layer cache and
 * re-rasterise 6,000 PNGs on every build.
 *
 *   node scripts/generate-dataset.mjs [--products 2000] [--reviews 15000]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { products as curated } from '../server/src/products.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'server', 'data', 'dataset');

/* ---------------------------------- rng ---------------------------------- */

/** mulberry32 — small, fast, and identical across Node versions. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

/* -------------------------------- vocabulary ------------------------------ */

/**
 * Categories are the shop's own, not Kaggle's generic ones. The artwork is
 * drawn from a fixed set of 15 templates (see svg.js), so a catalogue of
 * "Electronics / Beauty / Clothing" would render as noise. `dataset.js` maps
 * unknown categories onto a template by hash, so the real Kaggle file still
 * loads — it just looks less deliberate than this does.
 */
/*
 * Price bands are per *type*, not per category, and they are in paise. A single
 * band for "Tech" prices a mouse like a monitor, which produces a catalogue no
 * one believes and makes the assistant look broken when it recommends an
 * ₹80,000 mouse. Bands overlap across brands on purpose — that is what makes
 * "cheapest X" and price-bounded search a real question.
 */
const CATEGORIES = {
  Audio: {
    Headphones: [499900, 3499900],
    Earbuds: [249900, 1999900],
    Speaker: [349900, 4499900],
    Soundbar: [999900, 5999900],
    Turntable: [1499900, 7999900],
    Microphone: [399900, 2499900],
  },
  Tech: {
    Keyboard: [299900, 1899900],
    Mouse: [149900, 999900],
    Webcam: [349900, 1499900],
    Monitor: [1499900, 8999900],
    Camera: [2499900, 8999900],
    Smartwatch: [699900, 4499900],
    'Tablet Stand': [99900, 599900],
  },
  Footwear: {
    Sneakers: [299900, 1499900],
    Runners: [399900, 1699900],
    'Trail Shoes': [449900, 1899900],
    Loafers: [349900, 1299900],
    Boots: [549900, 1899900],
  },
  Bags: {
    Backpack: [249900, 1299900],
    Tote: [129900, 699900],
    Duffel: [299900, 1499900],
    Sling: [149900, 799900],
    'Laptop Sleeve': [99900, 499900],
  },
  Home: {
    Mug: [49900, 199900],
    'Desk Lamp': [199900, 1299900],
    'Lounge Chair': [1499900, 4999900],
    Planter: [79900, 499900],
    'Throw Blanket': [149900, 899900],
    'Cutting Board': [99900, 599900],
  },
  Outdoors: {
    'Water Bottle': [79900, 399900],
    'Camp Stove': [349900, 1799900],
    Hammock: [199900, 899900],
    'Trekking Poles': [249900, 1199900],
    'Dry Bag': [99900, 499900],
  },
  Accessories: {
    Sunglasses: [199900, 1899900],
    Watch: [499900, 3499900],
    Wallet: [99900, 699900],
    Belt: [79900, 499900],
    Cap: [59900, 299900],
  },
};

const BRANDS = [
  'Aurora', 'Drift', 'Northsound', 'Kestrel', 'Lumen', 'Vantage', 'Basalt', 'Meridian',
  'Halcyon', 'Ironwood', 'Cinder', 'Tessellate', 'Orbit', 'Fathom', 'Quill', 'Sable',
  'Alcove', 'Bellwether', 'Cobalt', 'Dovetail', 'Ember', 'Foundry', 'Grove', 'Harbour',
  'Indigo', 'Junction', 'Keystone', 'Lantern', 'Marrow', 'Nimbus', 'Onyx', 'Prairie',
  'Quarry', 'Ridgeline', 'Solstice', 'Thicket', 'Umber', 'Verdant', 'Windrow', 'Yarrow',
];

const LINES = [
  'Pro', 'Studio', 'Lite', 'Max', 'Field', 'Classic', 'Trail', 'Everyday', 'Compact',
  'Signature', 'Nomad', 'Core', 'Alpine', 'Urban', 'Heritage', 'Atlas', 'Range', 'Works',
];

const MATERIALS = [
  'brushed aluminium', 'oiled walnut', 'recycled polyester', 'full-grain leather',
  'anodised steel', 'organic cotton canvas', 'matte polycarbonate', 'cork composite',
  'powder-coated steel', 'merino wool', 'ripstop nylon', 'borosilicate glass',
];

const VIRTUES = [
  'built to be repaired rather than replaced',
  'tested to 500 cycles and still square',
  'quiet enough to forget it is there',
  'the same weight empty as it feels full',
  'finished by hand, then checked twice',
  'designed around one job and no others',
  'lighter than the thing it replaces',
  'the fasteners are standard, on purpose',
];

const FIRST = [
  'Aarav', 'Priya', 'Rohan', 'Ananya', 'Vikram', 'Meera', 'Arjun', 'Divya', 'Karan',
  'Nisha', 'Sanjay', 'Ishita', 'Rahul', 'Kavya', 'Aditya', 'Tara', 'Nikhil', 'Sneha',
  'Farhan', 'Leela', 'Omar', 'Ritu', 'Dev', 'Anjali', 'Yusuf', 'Pooja', 'Manav', 'Zoya',
];
const LAST = [
  'Sharma', 'Iyer', 'Nair', 'Kapoor', 'Reddy', 'Bose', 'Menon', 'Chatterjee', 'Rao',
  'Gupta', 'Desai', 'Khan', 'Pillai', 'Verma', 'Joshi', 'Banerjee', 'Shetty', 'Malhotra',
];
const CITIES = [
  'Mumbai', 'Bengaluru', 'Delhi', 'Chennai', 'Hyderabad', 'Pune', 'Kolkata', 'Jaipur',
  'Ahmedabad', 'Kochi', 'Chandigarh', 'Indore', 'Lucknow', 'Surat', 'Bhopal',
];
const GENDERS = ['Male', 'Female', 'Other'];

/**
 * Review text, bucketed by star rating so sentiment matches the score. A
 * sentiment classifier run over this data should find the obvious signal — that
 * is the point of shipping text rather than a lorem-ipsum filler.
 */
const REVIEW_TEXT = {
  5: [
    'Exactly what I wanted. Third one I have bought from this brand and the quality has not slipped.',
    'Arrived two days early and the finish is better than the photos suggest.',
    'I use it every single day. Nothing has come loose, nothing rattles.',
    'Worth the money. I compared four alternatives and this was the only one that felt solid.',
    'Bought it for my partner and ended up ordering a second for myself.',
  ],
  4: [
    'Very good overall. Half a star off only because the packaging was excessive.',
    'Does the job well. Slightly heavier than I expected but I have got used to it.',
    'Happy with it. Instructions were thin, but it is self-explanatory once unboxed.',
    'Solid build and good value. Would prefer more colour options.',
    'Great for the price. The finish scuffs a little more easily than I hoped.',
  ],
  3: [
    'Fine. Not remarkable, not bad — it does what it says and no more.',
    'Decent, though I think it is priced about fifteen percent too high.',
    'Works, but the first one had a loose seam and had to be exchanged.',
    'Mixed feelings. Good design, average materials.',
    'It is okay. I would probably try a different brand next time.',
  ],
  2: [
    'Disappointed. Started showing wear inside a month of light use.',
    'Looks the part but feels cheap in the hand. Returning it.',
    'Not as described — the dimensions are noticeably smaller than listed.',
    'Two of the three I ordered had the same defect.',
    'Support was helpful, but the product itself did not hold up.',
  ],
  1: [
    'Broke on the second day. Do not recommend.',
    'Completely the wrong item arrived and the return took three weeks.',
    'Fell apart immediately. Not worth a fraction of the price.',
    'Stopped working within a week with no warning.',
    'Poor quality control. Mine arrived already damaged.',
  ],
};

/* ---------------------------------- csv ---------------------------------- */

/** RFC 4180: quote anything containing a comma, quote or newline. */
function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csv(header, rows) {
  const out = [header.join(',')];
  for (const row of rows) out.push(header.map((h) => csvCell(row[h])).join(','));
  return `${out.join('\n')}\n`;
}

/** ISO date `days` before 2026-08-01, so the data does not drift into the future. */
function dateBefore(days) {
  const base = Date.UTC(2026, 7, 1);
  return new Date(base - days * 86400000).toISOString().slice(0, 10);
}

/* -------------------------------- generate -------------------------------- */

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
}

const PRODUCT_COUNT = arg('products', 2000);
const REVIEW_COUNT = arg('reviews', 15000);
const USER_COUNT = arg('users', 10000);

const r = rng(20260810);
const categoryNames = Object.keys(CATEGORIES);

/* Users --------------------------------------------------------------------
 * These are review authors, not shop accounts. They are never inserted into
 * the `users` table — that one holds real sign-ins with password hashes, and
 * mixing 10,000 synthetic rows into it would put fake people in the account
 * system. `dataset.js` only reads the name, to attribute a review. */
const users = [];
for (let i = 1; i <= USER_COUNT; i += 1) {
  const first = pick(r, FIRST);
  const last = pick(r, LAST);
  users.push({
    user_id: `U${String(i).padStart(6, '0')}`,
    name: `${first} ${last}`,
    email: `${first.toLowerCase()}.${last.toLowerCase()}${i}@example.com`,
    gender: pick(r, GENDERS),
    city: pick(r, CITIES),
    signup_date: dateBefore(int(r, 30, 1460)),
  });
}

/* Products ---------------------------------------------------------------- */
const products = [];
const seenNames = new Set();

for (let i = 1; i <= PRODUCT_COUNT; i += 1) {
  const category = categoryNames[i % categoryNames.length];
  const types = Object.keys(CATEGORIES[category]);

  // Names must be unique: the storefront searches them, and duplicates would
  // make "which one did the agent mean?" ambiguous in a way a real shop is not.
  let name;
  let type;
  let guard = 0;
  do {
    const brand = pick(r, BRANDS);
    const line = pick(r, LINES);
    type = pick(r, types);
    const model = r() < 0.45 ? ` ${pick(r, 'ABCFHKMNRSTVX'.split(''))}${int(r, 2, 9)}${int(r, 0, 9)}0` : '';
    name = `${brand} ${line}${model} ${type}`;
    guard += 1;
  } while (seenNames.has(name) && guard < 40);
  if (seenNames.has(name)) name = `${name} ${i}`;
  seenNames.add(name);

  // Rounded to the nearest ₹100 and shaved by ₹1, so the catalogue reads like a
  // shop (₹2,499) rather than like a random number generator (₹2,473).
  const [lo, hi] = CATEGORIES[category][type];
  const paise = Math.round(int(r, lo, hi) / 10000) * 10000 - 100;

  products.push({
    product_id: `P${String(i).padStart(6, '0')}`,
    product_name: name,
    category,
    price: (paise / 100).toFixed(2),
    // Placeholder: recomputed from reviews.csv below, so the two agree.
    rating: '0.00',
  });
}

/* Reviews ------------------------------------------------------------------
 * Distribution is deliberately lumpy. A uniform spread of reviews across
 * products would hide the thing this dataset exists to exercise: ranking by
 * popularity when a handful of products own most of the reviews. */
const reviews = [];
const perProduct = new Map();

for (let i = 1; i <= REVIEW_COUNT; i += 1) {
  // Square the draw so low indices (a small head of popular products) win often.
  const idx = Math.floor(r() ** 2 * products.length);
  const product = products[idx];

  // Ratings skew high, as they do on every real storefront.
  const roll = r();
  const stars = roll < 0.52 ? 5 : roll < 0.78 ? 4 : roll < 0.90 ? 3 : roll < 0.96 ? 2 : 1;

  reviews.push({
    review_id: `R${String(i).padStart(7, '0')}`,
    user_id: users[int(r, 0, users.length - 1)].user_id,
    product_id: product.product_id,
    rating: stars,
    review_text: pick(r, REVIEW_TEXT[stars]),
    review_date: dateBefore(int(r, 1, 900)),
  });

  const agg = perProduct.get(product.product_id) || { n: 0, sum: 0 };
  agg.n += 1;
  agg.sum += stars;
  perProduct.set(product.product_id, agg);
}

// Reconcile products.rating with reviews.csv. A product with no reviews keeps a
// plausible standalone rating rather than 0.00, which would sort it last and
// read as "terrible" instead of "new".
for (const p of products) {
  const agg = perProduct.get(p.product_id);
  p.rating = agg ? (agg.sum / agg.n).toFixed(2) : (3.6 + r() * 1.3).toFixed(2);
}

/* Reviews for the curated 16 -----------------------------------------------
 * These products are declared in server/src/products.js, not in products.csv,
 * and they are the ones a demo actually opens. Seeding recomputes every
 * product's review count from the review table, so without rows here the
 * flagship products would show a 4.8 next to "no reviews yet" — the count they
 * declare in source would simply be overwritten with zero.
 *
 * Generated last so the draws above are untouched: the dataset products keep
 * the same names, prices and artwork, and re-running the generator does not
 * invalidate 6,000 rasterised PNGs.
 *
 * Counts are capped well below the declared figures. The point is a review list
 * with a believable shape, not 987 rows nobody scrolls. */
const curatedIds = new Set();
for (const p of curated) {
  // Aim the distribution at the rating the product declares, so the recomputed
  // average lands near the number the hand-written copy was built around.
  const target = Number(p.rating) || 4.5;
  const count = Math.min(Number(p.reviews) || 40, 120);
  curatedIds.add(p.id);

  for (let i = 0; i < count; i += 1) {
    // Draw around the target: mostly the two stars either side of it, with a
    // thin tail, which is what a real product's histogram looks like.
    const roll = r();
    let stars = Math.round(target);
    if (roll > 0.62) stars = Math.min(5, stars + 1);
    else if (roll > 0.44) stars = Math.max(1, stars - 1);
    else if (roll > 0.38) stars = Math.max(1, stars - 2);
    stars = Math.max(1, Math.min(5, stars));

    reviews.push({
      review_id: `RC${String(reviews.length + 1).padStart(6, '0')}`,
      user_id: users[int(r, 0, users.length - 1)].user_id,
      product_id: p.id,
      rating: stars,
      review_text: pick(r, REVIEW_TEXT[stars]),
      review_date: dateBefore(int(r, 1, 900)),
    });
  }
}

/* ---------------------------------- write --------------------------------- */

mkdirSync(OUT_DIR, { recursive: true });

writeFileSync(join(OUT_DIR, 'users.csv'), csv(
  ['user_id', 'name', 'email', 'gender', 'city', 'signup_date'], users,
));
writeFileSync(join(OUT_DIR, 'products.csv'), csv(
  ['product_id', 'product_name', 'category', 'price', 'rating'], products,
));
writeFileSync(join(OUT_DIR, 'reviews.csv'), csv(
  ['review_id', 'user_id', 'product_id', 'rating', 'review_text', 'review_date'], reviews,
));

const reviewed = perProduct.size;
console.log(
  `dataset: ${products.length} products, ${reviews.length} reviews, ${users.length} users\n` +
  `dataset: ${reviewed} products carry reviews (${(reviewed / products.length * 100).toFixed(0)}%), ` +
  `busiest has ${Math.max(...[...perProduct.values()].map((a) => a.n))}\n` +
  `dataset: written to ${OUT_DIR}`,
);
