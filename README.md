# Cheela Shop

A small but complete ecommerce site — React frontend, Express + SQLite backend. Nothing is
mocked: the catalogue, cart, orders, sessions and **product images** all live in a real
database, and payments go through Razorpay.

> This is the **`without-cheela`** branch — the storefront on its own. The `main` branch is
> the same shop with the Cheela agent integration added on top, so
> `git diff without-cheela..main` is exactly what integrating Cheela involves.

## Quick start

```bash
npm install
npm run dev
```

- Frontend → http://localhost:5173
- API → http://localhost:4000/api

The first boot draws the artwork, rasterises it to PNG and seeds the database (a few seconds).
Every boot after that is instant.

```bash
npm run smoke           # 48-check end-to-end API test against a running server
npm run smoke:addresses # 17-check address book, incl. cross-account isolation
npm run smoke:razorpay  # 20-check signature + webhook suite (needs no Razorpay account)
npm run smoke:sandbox   # 16-check pass/fail through sandbox mode, no network to Razorpay
npm run build         # build the SPA
npm start             # serve API + built SPA from Express alone, on :4000
```

## How the images work

You asked for SVG art stored the way a real site stores it, so the pipeline is:

```
draw SVG (server/src/svg.js)
  └─ rasterise to PNG at 400 / 800 / 1600 px  (sharp)
       └─ store the bytes as BLOBs in SQLite (product_images)
            └─ serve at /api/products/:id/image?size=800
```

- The browser only ever receives **PNG**. No SVG is sent to the client for product art.
- Each product has three widths; the frontend ships a `srcset` so the browser picks one.
- The master SVG is kept in the same table (`format = 'svg'`) for provenance, never served.
- Responses carry an `ETag` and `Cache-Control: immutable`; repeat requests get a `304`.
- Re-seeding is cheap — artwork is only re-rendered when its hash changes.

There are 14 hand-drawn illustrations (headphones, sneaker, watch, backpack, camera, mug,
chair, lamp, keyboard, plant, sunglasses, bottle, speaker, tote, earbuds) across 8 colour
palettes, so all 16 products look distinct.

## Layout

```
server/
  src/
    db.js            schema + connection (node:sqlite, no native deps)
    svg.js           the illustrations
    products.js      catalogue seed data
    seed.js          SVG -> PNG -> BLOB pipeline
    repo.js          queries; maps rows to API shapes
    auth.js          scrypt passwords, bearer sessions
    routes.js        the REST API
    index.js         Express app assembly
  data/shop.db       created on first run
client/
  src/
    pages/           Home, Catalog, Product, Cart, Checkout, Order, Login, Account
    components/      Layout, ProductCard, AddressForm, Icons
    store.jsx        cart + auth context
    api.js           fetch wrapper
scripts/
  smoke.mjs          end-to-end API test
```

## Demo account and payments

The database seeds a shopper you can sign in as immediately:

```
demo@cheela.shop  /  demo-password-1234
```

It also gets a **fixed session token**, `demo-session-token-do-not-use-in-production`,
because capability calls carry an end-user credential and a test needs one it can
predict. That is only acceptable for a seeded demo — set `DEMO_ACCOUNT=off` to skip
seeding it entirely.

Payments are simulated by `server/src/mock-payments.js`. There is no processor and
no real card: the outcome is decided by an opaque method token, so every branch is
reproducible.

| Token | Test card | Outcome |
| --- | --- | --- |
| `pm_card_visa` | 4242 4242 4242 4242 | Succeeds |
| `pm_card_mastercard` | 5555 5555 5555 4444 | Succeeds |
| `pm_card_declined` | 4000 0000 0000 0002 | `card_declined` |
| `pm_card_insufficient_funds` | 4000 0000 0000 9995 | `insufficient_funds` |
| `pm_card_expired` | 4000 0000 0000 0069 | `expired_card` |

Checkout is two steps, because an order and its payment are different things:

```
POST /api/orders            → status pending_payment, stock reserved, cart emptied
POST /api/orders/:id/pay    → captured  → status paid
                            → declined  → status payment_failed, stock released
```

Reserving stock at placement rather than at payment stops two shoppers both
checking out the last unit and then racing at the card step. A decline puts the
stock back, so a dead order cannot hold inventory hostage. Paying an already-paid
order is a 409; an **unrecognised method token is a 400 that leaves the order
untouched**, because a typo is a caller error, not an issuer decision.

## API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/health` | row counts, uptime |
| GET | `/api/products` | `q`, `category`, `sort`, `page`, `limit`, `minPrice`, `maxPrice`, `inStock`, `featured` |
| GET | `/api/products/:id` | product + related items |
| GET | `/api/products/:id/image?size=` | **PNG bytes from the database** (400/800/1600) |
| GET | `/api/categories` | names with counts |
| POST | `/api/cart` | create a cart |
| GET | `/api/cart/:id` | cart with totals |
| POST | `/api/cart/:id/items` | `{ productId, qty }` |
| PATCH | `/api/cart/:id/items/:itemId` | `{ qty }` — 0 removes |
| DELETE | `/api/cart/:id/items/:itemId` | remove one line |
| DELETE | `/api/cart/:id` | empty the cart |
| POST | `/api/orders` | place an order; reserves stock, empties cart, **does not** take payment |
| POST | `/api/orders/:id/pay` | `{ paymentMethod }` or `{ cardNumber }`; 200 paid, 402 declined |
| GET | `/api/payment-methods` | which processor is live, plus the simulated methods |
| POST | `/api/orders/:id/payment-intent` | creates the Razorpay order the modal opens against |
| POST | `/api/orders/:id/payment/verify` | verifies the signature and settles the order |
| POST | `/webhooks/razorpay` | signed webhook — the authoritative confirmation |
| GET/POST | `/api/addresses` | the address book (signed in) |
| PATCH/DELETE | `/api/addresses/:id` | edit or remove a saved address |
| POST | `/api/addresses/:id/default` | make one the default |
| GET | `/api/orders/:id` | by id **or** order number |
| GET | `/api/orders` | 🔒 the signed-in user's orders |
| POST | `/api/auth/register` | `{ email, name, password }` → `{ user, token }` |
| POST | `/api/auth/login` | `{ email, password }` → `{ user, token }` |
| POST | `/api/auth/logout` | revokes the token server-side |
| GET | `/api/auth/me` | 🔒 current user |

🔒 = send `Authorization: Bearer <token>`.

### Auth

Passwords are hashed with `scrypt` and a per-user salt; comparison is timing-safe. Tokens are
opaque random strings stored in a `sessions` table, so logout genuinely revokes them rather
than just dropping the token client-side. Checkout works signed in *or* as a guest — signing
in just attaches the order to the account so it shows up under Orders.

### Money and stock

Prices are integer **paise** everywhere, on the wire and in the database — no floats. Shipping
is ₹99, free over ₹1,999. GST is 18%, shown as its own line. Stock is re-checked inside the
checkout transaction, not just when adding to the cart, so a stale cart cannot oversell.

Paise is also the unit Razorpay works in, so amounts pass to the gateway untouched — no
currency conversion sits between what the shopper is quoted and what they are charged.

### Payments

Razorpay, in test mode. The shop reads `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`; with them
set, checkout opens Razorpay's own modal (UPI, cards, netbanking, wallets) and the server
verifies the returned signature before an order is ever marked paid. **Without them the shop
falls back to the simulated processor below**, so a clean clone still checks out and every
test still passes.

**Sandbox mode** — `RAZORPAY_SIMULATE=1` runs the entire Razorpay flow without sending
anything to Razorpay. Useful before the account's business details are approved, which
otherwise makes every payment fail for reasons unrelated to this code. `createOrder`,
`createPaymentLink` and `fetchPayment` return the shapes Razorpay would; **signing and
verification are not stubbed** — signatures are minted with the real key secret and checked
by the same verifier the live path uses, so the code deciding whether an order is paid is
the code that runs in production. Checkout renders pass/fail buttons instead of the modal.
Enabling it with `NODE_ENV=production` throws at startup.

Two things settle an order, deliberately:

- the **browser callback**, verified by HMAC — the values arrive through the shopper's own
  browser and mean nothing until that check passes; and
- the **webhook** (`POST /webhooks/razorpay`), which is the only path that still completes an
  order for a shopper who pays and then closes the tab.

Both go through the same idempotent settlement, so whichever lands first wins.

### Saved addresses

Signed-in shoppers keep an address book: Indian shape (state + 6-digit PIN + mobile), one
default, managed from **Your account**. Checkout preselects the default, and the agent can
place an order against an `addressId` without ever being told the street. An address is
**copied onto the order** rather than referenced, so editing or deleting it later cannot
rewrite where a past order shipped.

## Notes

- `node:sqlite` is used, so there is no native database module to compile. `sharp` is the only
  binary dependency and ships prebuilt.
- Reset everything: `rm -rf server/data` then restart.
- Re-render artwork after editing `svg.js`: `npm run seed:force --workspace server`.
- This is a demo — no payment details are collected and nothing is charged.
