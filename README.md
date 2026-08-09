# Cheela Shop — demo storefront

A complete, working ecommerce site — React + Express + SQLite — with the **Cheela agent
integration** on top. Nothing is stubbed for show: the catalogue, cart, orders, sessions and
even the **product images** live in a real database, and payments go through Razorpay with
real signature verification.

It exists to answer one question honestly: *what does it actually take to make an existing
shop usable by an agent?*

> **Two branches, on purpose.**
> `without-cheela` is the storefront on its own. `main` is the same shop with Cheela added.
> ```bash
> git diff without-cheela..main
> ```
> Setting aside the README, which each branch owns, that diff **is** the integration:
> **19 files, +5,321 / −39**. Of those 39 deleted lines, 30 are `package-lock.json` churn
> and 9 are storefront code — the rest is purely additive, which is the point. Removing
> `server/.cheela/`, the `/cheela/execute` mount and `Assistant.jsx` leaves the shop
> running exactly as before.
>
> ```bash
> git diff without-cheela..main -- . ':(exclude)README.md'
> ```

---

## Quick start

```bash
npm install
npm run dev
```

- Storefront → http://localhost:5173
- API → http://localhost:4000/api

First boot draws the artwork, rasterises it to PNG and seeds the database (a few seconds on
the 16 curated products). Every boot after that is instant. **No credentials are required** —
with Cheela and Razorpay unconfigured the shop runs on a simulated payment processor and
simply doesn't render the chat widget.

### The bulk catalogue

The 16 hand-written products are enough to read the code by and far too few to see how any of
this behaves at the size of a real store. `npm run dataset` writes a **2,000-product,
16,900-review** catalogue and `npm run seed` loads it:

```bash
npm run dataset          # writes server/data/dataset/*.csv
npm run seed             # loads them, then rasterises the artwork
```

The CSVs use the column layout of the [Kaggle e-commerce
dataset](https://www.kaggle.com/datasets/abhayayare/e-commerce-dataset) —
`product_id, product_name, category, price, rating` and `review_id, user_id, product_id,
rating, review_text, review_date`. Kaggle needs an account to download, and this repo should
not, so `scripts/generate-dataset.mjs` writes files in that layout instead. **Dropping the
real Kaggle CSVs into `server/data/dataset/` works with no code change** — `dataset.js` reads
those column names and nothing else. The Kaggle download carries three more tables (orders,
order_items, events) that this shop has no use for: it generates real orders through its own
checkout.

The generator is seeded, so the same command always produces the same catalogue. Prices are
banded per product *type* rather than per category — a mouse and a monitor priced from one
range gives you an ₹80,000 mouse and an assistant that looks broken.

Two things get noticeably slower, both on purpose:

| | 16 curated | + 2,000 dataset |
| --- | --- | --- |
| PNGs rasterised | 48 | 6,048 |
| SQLite on disk | 2.3 MB | ~205 MB |
| Seed time (16 cores) | ~10 s | ~7.5 min |

The artwork is seeded per product id, so those 2,000 products really are 2,000 different
pictures rather than one picture repeated. That is what makes the image step the cost it is.
`server/data/` is git- and docker-ignored, so the container generates and seeds its own copy
at build time.

Sign in with the seeded account:

```
demo@cheela.shop  /  demo-password-1234
```

### Tests

```bash
npm run smoke            # 48 — REST API, end to end, against a running server
npm run smoke:cheela     # 35 — capabilities and the auth boundary, in-process
npm run smoke:cart       # 13 — the assistant and the browser tab share one cart
npm run smoke:actions    # 39 — the pay button, the payment poll, product cards
npm run smoke:addresses  # 17 — address book, including cross-account isolation
npm run smoke:sandbox    # 16 — payment pass/fail, no network to Razorpay
npm run smoke:razorpay   # 20 — signature tampering and webhook settlement
npm run smoke:reviews    # 42 — CSV parsing, paise conversion, review paging, rating shrinkage
npm run typecheck        # the .cheela TypeScript
```

230 checks. None of them need a Razorpay account or a Cheela API key.

---

## What's interesting here

### The images are real

Product art is drawn as SVG in code, rasterised to PNG at three widths with `sharp`, and
stored as **BLOBs in SQLite**. The browser only ever receives PNG, with a content-addressed
`ETag` and `Cache-Control: immutable`, so repeat views get a `304`. Re-seeding only re-renders
when the artwork's hash changes.

```
draw SVG (server/src/svg.js)
  └─ rasterise to PNG at 400 / 800 / 1600 px (sharp)
       └─ store bytes as BLOBs in SQLite (product_images)
            └─ serve at /api/products/:id/image?size=800
```

### Money is integers, in paise

₹14,999 is `1499900`. No floats anywhere, on the wire or in the database. Shipping is ₹99,
free over ₹1,999; GST is 18%, shown as its own line so the total reads like an invoice.

Paise is also Razorpay's smallest unit, so amounts reach the gateway untouched — nothing
converts between what a shopper is quoted and what they are charged.

### Payments are real Razorpay

With `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` set, checkout opens Razorpay's own modal (UPI,
cards, netbanking, wallets). **Two independent things settle an order, deliberately:**

- the **browser callback**, whose signature is verified server-side — those values arrive
  through the shopper's own browser and mean nothing until the HMAC checks out; and
- the **webhook** (`POST /webhooks/razorpay`), which is the only path that still completes an
  order for someone who pays and then closes the tab.

Both run through the same idempotent settlement, so whichever lands first wins. A webhook
paying less than the order total does not mark it paid.

Without keys, a simulated processor stands in so the shop and every test still work.

**Sandbox** — `RAZORPAY_SIMULATE=1` runs the whole flow with **no network to Razorpay**, for
when an account's business details aren't approved yet. `createOrder`, `createPaymentLink` and
`fetchPayment` return the shapes Razorpay would; signing and verification are *not* stubbed,
so the code deciding whether an order is paid is the code that runs in production. Enabling it
with `NODE_ENV=production` throws at startup.

### Stock is reserved at placement, not payment

```
POST /api/orders            → pending_payment, stock reserved, cart emptied
  → payment captured        → paid
  → payment failed          → payment_failed, stock released
```

Reserving at placement stops two shoppers both checking out the last unit and racing at the
card step. A failure puts the stock back, so a dead order can't hold inventory hostage.

### Saved addresses

Signed-in shoppers keep an address book — Indian shape (state, 6-digit PIN, 10-digit mobile),
one default, managed from **Your account**. An address is **copied onto an order**, not
referenced, so editing or deleting it later cannot rewrite where a past order shipped.

---

## The Cheela integration

16 capabilities expose the shop to agents. They call `repo.js` directly — the same code the
REST API uses — so a human clicking buttons and an agent invoking capabilities cannot end up
with different rules about stock, totals or payment.

| Capability | Auth | Does |
| --- | --- | --- |
| `catalog-search-products` | — | Search/filter by text, category, budget, stock |
| `catalog-get-product` | — | Full detail: description, specs, stock, related, rating summary |
| `catalog-get-product-reviews` | — | Review text and the star histogram, sortable to most critical |
| `catalog-list-categories` | — | Categories with counts |
| `cart-view` | — | Contents and totals |
| `cart-add-item` | — | Add a product |
| `cart-update-item` | — | Change a line quantity (0 removes) |
| `cart-remove-item` | — | Drop a line |
| `cart-clear` | — | Empty the cart |
| `store-list-payment-methods` | — | Accepted payment methods |
| `store-get-policies` | — | Shipping, GST, returns, guarantee |
| `checkout-place-order` | 🔒 | Place an **unpaid** order owned by the shopper |
| `checkout-pay-order` | 🔒 | Issue a payment link for their own order |
| `orders-get-order` | 🔒 | One of their own orders, with payment status |
| `orders-list` | 🔒 | Their order history |
| `addresses-list` | 🔒 | Their saved delivery addresses |

🔒 = `requiresEndUser: true` — the runtime refuses the call outright when it carries no
credential, before the handler runs.

### Three properties worth stating

**Ownership comes from the credential, never the input.** `checkout-place-order` takes no user
id; it files the order against the token's user. An agent cannot place an order on someone
else's account even if it tries.

**Cross-account access fails identically to "not found".** Reading or paying another shopper's
order gives the same message as a nonexistent order number, so an agent cannot probe for which
orders exist.

**There is no sign-in capability.** Authenticating through a capability would put a password
through the model. Shoppers sign in on the storefront; the widget passes the resulting token
down as `endUserToken`.

### The agent cannot charge anyone

Razorpay Checkout is a browser modal, and paying requires a card, a UPI PIN or a bank login —
credentials that must never travel through a language model. So the agent does the part it
legitimately can: it creates a **Razorpay payment link** and hands over the URL. The shopper
authenticates with their own bank; the webhook settles the order.

The chat then finds out on its own. `checkout-pay-order` attaches a `cheela.pending` spec, so
the panel polls `orders-get-order` every 15s until the order stops being `pending_payment` —
no asking the shopper whether they paid, and no relying on the model to re-check.
`INTEGRATION.md` §15 has the details.

That link is rendered as a real button, not left to prose. Capability results declare their
own UI actions (`cheela.actions`), so the pay button doesn't depend on the model choosing to
repeat a long signed URL without mangling it. Action URLs must be `https:` — `http:` is
rejected, since these links carry payment sessions.

### Nobody buys a bag from a paragraph

The same argument, applied to the things shoppers actually look at before buying them.
`catalog-search-products` and `catalog-get-product` attach `cheela.cards` (protocol 0.5), so
the matches arrive as **product cards — picture, name, price, link** — instead of whatever
prose the model chose to write about them. Prices are formatted by the runtime, which knows
the currency, rather than retyped from the model's memory of the tool result.

The capability descriptions were rewritten to match: the model is told the cards are already
on screen, so it compares and recommends rather than relisting six names and prices the
shopper can see. Underneath the shortlist sits one button to the equivalent `/shop` search —
worded neutrally for a budget search, because `/shop` has no price filter and the count would
be a promise the page cannot keep. `INTEGRATION.md` §16 has the details.

### One cart, not two

The assistant has no access to `localStorage`, so the naive integration fills a cart the
shopper cannot see — the item really is added, just not to the bag on screen. Carts are
resolved by **owner**: a signed-in shopper has one cart, shared by the tab and the assistant.
A `cartId` the model repeats from an earlier turn is ignored; a *non-empty* cart handed over
explicitly is adopted, which is the genuine "filled a bag as a guest, then signed in" case.

### The chat panel is ours

`Assistant.jsx` is this project's own React and CSS, not a drop-in widget. It runs on the
headless half of `@cheela/web-component` — `getSession` owns the conversation, the HTTP
client and the streaming; the panel, bubbles and composer are written here so the chat
matches the storefront instead of a shadow root that its stylesheet cannot reach.

What stays borrowed on purpose is `renderMessage`, which builds everything inside a bubble:
model prose as DOM nodes rather than a markup string, and product cards and action buttons
whose URLs it drops unless they are `https:` — the rule that keeps `javascript:` in a
capability's output from becoming stored XSS on this domain. `INTEGRATION.md` §14 has the
full reasoning.

---

## Layout

```
server/
  src/
    db.js            schema + connection (node:sqlite, no native deps)
    svg.js           the illustrations
    products.js      the 16 curated products, hand-written
    dataset.js       CSV → product mapping for the 2,000-product bulk catalogue
    seed.js          SVG → PNG → BLOB pipeline, on a worker pool
    repo.js          all queries; the one implementation REST and capabilities share
    auth.js          scrypt passwords, revocable bearer sessions
    routes.js        the REST API
    razorpay.js      gateway client, signature + webhook verification, sandbox
    webhooks.js      signed Razorpay webhooks
    mock-payments.js the simulated processor used when Razorpay is unconfigured
    index.js         Express assembly + /cheela/execute
  .cheela/
    capabilities.ts  the 16 capabilities
    runtime.ts       registers them 
  cheela.config.ts   endpoint + ADP namespace
client/
  src/
    pages/           Home, Catalog, Product, Cart, Checkout, Pay, Order, Login, Account
    components/      Layout, ProductCard, AddressForm, Assistant (chat panel), Icons
    store.jsx        cart + auth context
    api.js           fetch wrapper, INR formatting
  public/.well-known/agent-discovery.json   published manifest, served statically
scripts/             the seven test suites
```

`server/data/shop.db` is created on first run and git-ignored.

---

## API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/health` | row counts, uptime |
| GET | `/api/products` | `q`, `category`, `sort`, `page`, `limit`, `minPrice`, `maxPrice`, `inStock`, `featured` |
| GET | `/api/products/:id` | product + related |
| GET | `/api/products/:id/image?size=` | **PNG bytes from the database** (400/800/1600) |
| GET | `/api/categories` | names with counts |
| POST | `/api/cart` | a signed-in shopper gets their existing cart |
| POST | `/api/cart/:id/claim` | 🔒 bind a guest cart to the account |
| GET/POST/PATCH/DELETE | `/api/cart/...` | read and edit the cart |
| POST | `/api/orders` | place an order; reserves stock, **does not** take payment |
| GET | `/api/orders/:id` | by id **or** order number |
| GET | `/api/orders` | 🔒 the shopper's orders |
| GET | `/api/payment-methods` | which processor is live |
| POST | `/api/orders/:id/payment-intent` | create the Razorpay order the modal opens against |
| POST | `/api/orders/:id/payment/verify` | verify the signature and settle |
| POST | `/api/orders/:id/pay` | simulated processor (fallback path) |
| POST | `/webhooks/razorpay` | signed webhook — the authoritative confirmation |
| GET/POST | `/api/addresses` | 🔒 the address book |
| PATCH/DELETE | `/api/addresses/:id` | 🔒 edit or remove |
| POST | `/api/addresses/:id/default` | 🔒 make one the default |
| POST | `/api/auth/register` · `/login` · `/logout` | sessions |
| GET | `/api/auth/me` | 🔒 current user |

🔒 = send `Authorization: Bearer <token>`.

Passwords use `scrypt` with a per-user salt and timing-safe comparison. Tokens are opaque
random strings in a `sessions` table, so logout genuinely revokes them.

---

## Configuration

Two `.env` files, and the split is a security boundary rather than tidiness.

| Where | Variable | Secret? |
| --- | --- | --- |
| `server/.env` | `CHEELA_API_KEY` (`ch_sk_…`) | 🔒 yes |
| `server/.env` | `CHEELA_RUNTIME_SECRET` | 🔒 yes — verifies the HMAC on incoming calls |
| `server/.env` | `CHEELA_RUNTIME_ID`, `CHEELA_ENDPOINT` | no |
| `server/.env` | `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | 🔒 yes |
| `server/.env` | `RAZORPAY_KEY_ID`, `RAZORPAY_SIMULATE` | no |
| `server/.env` | `PUBLIC_BASE_URL`, `STOREFRONT_URL` | no |
| `client/.env` | `VITE_CHEELA_PUBLIC_KEY` (`ch_pk_…`) | no |

**Anything in `client/.env` is compiled into the JavaScript visitors download.** A `ch_sk_`
key there would be readable by everyone. That is the entire reason the files are separate.

Copy `.env.example` in each directory to get started. Neither `.env` is committed.

### Cheela requires a public HTTPS endpoint

Cheela calls *in*, so `localhost` is unreachable from its side. Without `CHEELA_ENDPOINT` the
model picks a capability and then fails with *"Runtime … has no HTTPS endpoint configured"*,
which surfaces in the browser as "could not reach the assistant".

```bash
npx cloudflared tunnel --url http://localhost:4000
# then set CHEELA_ENDPOINT=https://<subdomain>.trycloudflare.com/cheela/execute
npm run cheela:deploy
```

Use cloudflared rather than localtunnel: measured on the same server, localtunnel answered in
**9.6s** against cloudflared's **0.84s**, and Cheela times the callback out (HTTP 408) long
before that — which reads like a broken integration but is purely tunnel latency.

A quick tunnel gets a new hostname every restart, so `CHEELA_ENDPOINT` (and the Razorpay
webhook URL) go stale and need redeploying.

---

`INTEGRATION.md` covers the runtime, deploy and authentication flows in detail, including the
decisions that are non-obvious and the upstream issues worked around.
