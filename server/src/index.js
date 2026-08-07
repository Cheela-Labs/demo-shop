import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import cors from 'cors';
import express from 'express';
import morgan from 'morgan';

import { api } from './routes.js';
import { webhooks } from './webhooks.js';
import { seed } from './seed.js';
import { DB_PATH, tableCount } from './db.js';
import { isConfigured as razorpayConfigured, isSimulated as razorpaySimulated, webhooksConfigured } from './razorpay.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.resolve(HERE, '..', '..', 'client', 'dist');

const PORT = Number(process.env.PORT) || 4000;
const app = express();

app.disable('x-powered-by');
app.use(cors());

// Razorpay webhooks, for the same reason as above: the signature is an HMAC
// over the exact bytes received, so this must see the raw body.
app.use('/webhooks', express.raw({ type: '*/*', limit: '256kb' }), webhooks);

app.use(express.json({ limit: '256kb' }));
app.use(morgan('dev', { skip: (req) => req.path.includes('/image') }));

app.use('/api', api);

// Production: serve the built SPA and let client-side routing handle the rest.
if (existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST, { maxAge: '1h' }));
  app.get(/^(?!\/api|\/webhooks).*/, (_req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));
}

app.use((req, res) => res.status(404).json({ error: `No route for ${req.method} ${req.path}` }));

// eslint-disable-next-line no-unused-vars -- Express needs the 4-arg signature.
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Something went wrong' });
});

// Products and their imagery are seeded on boot; rasterising only happens the
// first time (or when the artwork changes), so restarts stay fast.
if (tableCount('products') === 0) {
  console.log('database is empty — seeding');
}
await seed();

app.listen(PORT, () => {
  console.log(`\n  API     http://localhost:${PORT}/api`);
  if (razorpaySimulated()) {
    console.log(`  Payments Razorpay SANDBOX (${process.env.RAZORPAY_KEY_ID}) — INR`);
    console.log('          ↳ nothing is sent to Razorpay; signatures are still signed and verified for real');
  } else if (razorpayConfigured()) {
    console.log(`  Payments Razorpay (${process.env.RAZORPAY_KEY_ID}) — INR`);
    if (!webhooksConfigured()) {
      console.log('          ⚠ RAZORPAY_WEBHOOK_SECRET unset — a shopper who closes the tab mid-payment leaves the order unpaid');
    }
  } else {
    console.log('  Payments simulated — set RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET for the real gateway');
  }
  console.log(`  DB      ${DB_PATH}`);
  console.log(`  Ready with ${tableCount('products')} products, ${tableCount('product_images')} image rows\n`);
});
