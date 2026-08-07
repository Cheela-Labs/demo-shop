/**
 * Seeds the database, including the image pipeline:
 *
 *   draw SVG  ->  rasterise to PNG (sharp)  ->  store bytes in product_images
 *
 * The SVG is the master asset, so it is stored alongside the PNGs, but the
 * site only ever serves the rasterised versions. Re-running is safe: rows are
 * upserted, and images are only re-rendered when the artwork hash changes.
 */

import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';

import { db, transaction, tableCount } from './db.js';
import { registerUser } from './auth.js';
import { products as catalog } from './products.js';
import { renderProduct } from './svg.js';

/** Widths shipped to the browser; the client picks via srcset. */
export const IMAGE_SIZES = [400, 800, 1600];

const upsertProduct = db.prepare(`
  INSERT INTO products
    (id, name, tagline, description, price, compare_at_price, category, tags,
     rating, reviews, stock, featured, art, palette, specs)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name, tagline = excluded.tagline,
    description = excluded.description, price = excluded.price,
    compare_at_price = excluded.compare_at_price, category = excluded.category,
    tags = excluded.tags, rating = excluded.rating, reviews = excluded.reviews,
    stock = excluded.stock, featured = excluded.featured, art = excluded.art,
    palette = excluded.palette, specs = excluded.specs
`);

const upsertImage = db.prepare(`
  INSERT INTO product_images
    (product_id, size, format, mime, width, height, bytes, hash, is_primary, data)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(product_id, size, format) DO UPDATE SET
    mime = excluded.mime, width = excluded.width, height = excluded.height,
    bytes = excluded.bytes, hash = excluded.hash,
    is_primary = excluded.is_primary, data = excluded.data,
    created_at = datetime('now')
`);

const currentHash = db.prepare(
  `SELECT hash FROM product_images WHERE product_id = ? AND format = 'png' AND size = ? LIMIT 1`,
);

function sha(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, 32);
}

/** SVG -> PNG buffer at the requested square size. */
async function rasterise(svg, size) {
  return sharp(Buffer.from(svg), { density: 384 })
    .resize(size, size, { fit: 'cover' })
    .png({ compressionLevel: 9, effort: 7 })
    .toBuffer();
}

/**
 * Render and store every image for one product.
 * Returns the number of PNGs actually rasterised.
 */
async function buildImages(product, { force = false } = {}) {
  const svg = renderProduct(product, { size: 1600 });
  const svgHash = sha(svg);

  // Cheap skip: if the artwork hasn't changed, the stored PNGs are still valid.
  if (!force) {
    const existing = currentHash.get(product.id, IMAGE_SIZES[0]);
    if (existing && existing.hash.startsWith(svgHash.slice(0, 12))) return 0;
  }

  const rendered = await Promise.all(
    IMAGE_SIZES.map(async (size) => ({ size, buf: await rasterise(svg, size) })),
  );

  transaction(() => {
    // Master SVG kept for provenance; never served to the browser.
    upsertImage.run(
      product.id, 0, 'svg', 'image/svg+xml', 1600, 1600,
      Buffer.byteLength(svg), svgHash, 0, Buffer.from(svg),
    );

    for (const { size, buf } of rendered) {
      // Prefix the PNG hash with the SVG hash so staleness is detectable above.
      const tag = `${svgHash.slice(0, 12)}${sha(buf).slice(0, 20)}`;
      upsertImage.run(
        product.id, size, 'png', 'image/png', size, size,
        buf.length, tag, size === 800 ? 1 : 0, buf,
      );
    }
  });

  return rendered.length;
}

/**
 * The demo account, so the signed-in paths (order history, agent checkout) are
 * testable without registering someone first.
 *
 * The session token is fixed and printed at boot on purpose: capability calls
 * carry an end-user token, and a test needs one it can predict. That is only
 * acceptable because this is a seeded demo — a real deployment must never ship
 * a known-in-advance session token, which is why it is skipped when
 * DEMO_ACCOUNT=off.
 */
export const DEMO_ACCOUNT = {
  email: 'demo@cheela.shop',
  password: 'demo-password-1234',
  name: 'Demo Shopper',
  token: 'demo-session-token-do-not-use-in-production',
};

function seedDemoAccount(log) {
  if (process.env.DEMO_ACCOUNT === 'off') return;

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(DEMO_ACCOUNT.email);
  let userId = existing?.id;

  if (!userId) {
    const created = registerUser({
      email: DEMO_ACCOUNT.email,
      name: DEMO_ACCOUNT.name,
      password: DEMO_ACCOUNT.password,
    });
    userId = created.user.id;
  }

  // Refresh the fixed token's expiry so a long-lived checkout never 401s
  // halfway through a demo.
  const expires = new Date(Date.now() + 365 * 864e5).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare('DELETE FROM sessions WHERE token = ?').run(DEMO_ACCOUNT.token);
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(DEMO_ACCOUNT.token, userId, expires);

  seedDemoAddress(userId, log);

  log(`seed: demo account ${DEMO_ACCOUNT.email} / ${DEMO_ACCOUNT.password}`);
}

/**
 * One saved address on the demo account, so the address book and the "ship to a
 * saved address" path are exercisable the moment the shop boots — including by
 * an agent, which has no way to add one for itself.
 */
function seedDemoAddress(userId, log) {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM addresses WHERE user_id = ?').get(userId).n;
  if (existing > 0) return;

  db.prepare(
    `INSERT INTO addresses (id, user_id, label, name, phone, line1, line2, city, state, postcode, country, is_default)
     VALUES (?, ?, 'Home', ?, '9876543210', '221B Turner Road', 'Bandra West', 'Mumbai', 'Maharashtra', '400050', 'India', 1)`,
  ).run(randomUUID(), userId, DEMO_ACCOUNT.name);

  log('seed: demo address (Mumbai, default)');
}

export async function seed({ force = false, quiet = false } = {}) {
  const log = quiet ? () => {} : (msg) => console.log(msg);

  transaction(() => {
    for (const p of catalog) {
      upsertProduct.run(
        p.id, p.name, p.tagline, p.description, p.price, p.compareAtPrice ?? null,
        p.category, JSON.stringify(p.tags ?? []), p.rating, p.reviews, p.stock,
        p.featured ? 1 : 0, p.art, p.palette, JSON.stringify(p.specs ?? {}),
      );
    }
  });

  let rasterised = 0;
  for (const p of catalog) {
    rasterised += await buildImages(p, { force });
  }

  const stored = db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM product_images WHERE format = 'png'`)
    .get();

  seedDemoAccount(log);

  log(
    `seed: ${tableCount('products')} products, ` +
      `${stored.n} PNGs in db (${(stored.b / 1024 / 1024).toFixed(2)} MB)` +
      (rasterised ? `, ${rasterised} freshly rasterised` : ', artwork up to date'),
  );
}

if (process.argv[1]?.endsWith('seed.js')) {
  await seed({ force: process.argv.includes('--force') });
}
