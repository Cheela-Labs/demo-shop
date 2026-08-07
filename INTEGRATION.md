# Integration guide — how this project fits together

Every file that exists here, where it lives, and why. Written to explain the
**Cheela integration flow** end to end, with the storefront underneath it
described in enough detail that the integration makes sense.

Two independent things are going on:

1. **A storefront** — React + Express + SQLite. Works entirely on its own.
2. **A Cheela runtime** — exposes that storefront's operations as capabilities an
   agent can invoke.

The integration is deliberately *additive*: delete `server/.cheela/`, the
`/cheela/execute` mount and `Assistant.jsx`, and the shop still runs unchanged.

---

## 1. The mental model

The single idea worth internalising:

> **Cheela calls into your server. Your server does not call Cheela.**

The chat widget in the browser talks to Cheela's cloud. Cheela's cloud runs the
model, decides which capability to invoke, and then makes a **signed HTTPS request
back into your Express server**. Your capability code runs on your own machine,
against your own database, and returns JSON.

That single fact explains nearly every design decision below: why the runtime lives
on the server and not in React, why a public HTTPS endpoint (or tunnel) is required,
why there is an HMAC secret, and why the raw request body matters.

---

## 2. Runtime flow — what happens when a shopper asks for something

```mermaid
sequenceDiagram
    participant U as Shopper (browser)
    participant W as Assistant.jsx<br/>@cheela/ui
    participant C as Cheela cloud<br/>(openrouter / gpt-oss-20b)
    participant E as Express :4000<br/>/cheela/execute
    participant R as Runtime<br/>.cheela/runtime.ts
    participant D as repo.js → SQLite

    U->>W: "wireless headphones under $200"
    W->>C: message + endUserToken() (public key ch_pk_…)
    C->>C: model picks a capability
    C->>E: POST /cheela/execute<br/>signed: runtime-id, timestamp, nonce, HMAC<br/>body carries endUserToken
    E->>E: verify signature over RAW bytes
    E->>R: runtime.execute(name, input, { endUserToken })
    R->>R: requiresEndUser? refuse if no credential
    R->>R: validate input against zod schema
    R->>D: userByToken(...) then repo.*(...)
    D-->>R: rows
    R->>R: validate output against zod schema
    R-->>E: { items, … } or { paid, declineReason }
    E-->>C: 200 { output }
    C-->>W: reply, with product / order links
    U->>U: clicks productUrl → normal storefront page
```

**Why each hop exists**

| Hop | Why |
| --- | --- |
| Widget → Cheela cloud | The model runs on Cheela's side; the browser never sees a model key. Only the **public** key `ch_pk_…` is embedded. |
| Cheela → your server | Your data never leaves your box. Cheela sends *which* capability to run, not the data. |
| Signature verification | The endpoint is public HTTPS. Without verification, anyone who found the URL could place orders. |
| End-user token | Proves *which shopper* this is. The signature proves the call came from Cheela; it says nothing about who is asking. Both are needed. |
| Schema validation | The runtime validates **both** input and output, so a model hallucinating a field fails loudly instead of corrupting a cart. |

---

## 3. Deploy flow — how capabilities reach the platform

Cheela has to know what your capabilities *are* before the model can call them.
That is what `cheela deploy` does. It never uploads your handler code — only the
declarative metadata (names, descriptions, JSON Schemas).

```mermaid
flowchart TD
    A["capabilities.ts<br/>createCapability + createAction"] --> B["runtime.ts<br/>runtime.register(...)"]
    B --> C["cheela deploy<br/>reads runtime.getRegistrations()"]
    C --> D["4 generators →<br/>.cheela/generated/"]
    C --> E["manifest → Cheela platform<br/>Deployment 1 active"]
    E --> F["cheela manifest pull<br/>--runtime rt_…"]
    F --> G["client/public/.well-known/<br/>agent-discovery.json"]
    G --> H["Served statically so<br/>agents can discover the store"]
```

**Discovery is by registration, not by file scanning.** The CLI calls
`runtime.getRegistrations()`. A capability that is defined but never `register()`ed
in `runtime.ts` simply does not exist as far as the platform is concerned. There is
no second manifest to keep in sync — which is the whole point.

---

## 4. Authentication — how a capability knows who is asking

The signature proves a call came *from Cheela*. It says nothing about *which
shopper* is asking. Those are two different questions, and order capabilities need
both answered.

```mermaid
flowchart LR
    A["Shopper signs in<br/>on the storefront"] --> B["token in localStorage"]
    B --> C["Assistant.jsx<br/>endUserToken: () => getToken()"]
    C --> D["Cheela cloud"]
    D --> E["request body<br/>endUserToken"]
    E --> F["runtime.execute(name, input,<br/>{ endUserToken })"]
    F --> G{"capability declares<br/>requiresEndUser?"}
    G -->|no token| H["refused before<br/>the handler runs"]
    G -->|token| I["handler: userByToken(...)"]
    I --> J{"valid session?"}
    J -->|no| K["refused: expired / invalid"]
    J -->|yes| L["scoped to that user"]
```

**Two layers, deliberately.** The platform checks a credential *exists*
(`requiresEndUser`). Only your code can check it is still *valid* — expiry,
revocation — which is what `requireShopper()` in `capabilities.ts` does. Relying on
the platform alone would accept a token that was revoked an hour ago.

`endUserToken` is passed as a **function**, not a string. A shopper can sign in long
after the widget mounted, and a value read once would pin whatever was true then.

### What is gated, and what that buys

| Capability | Gated | Why |
| --- | --- | --- |
| `catalog-*`, `cart-*`, `store-*` | no | A visitor can browse and fill a cart without an account, exactly as in the UI |
| `checkout-place-order` | yes | Orders belong to someone |
| `checkout-pay-order` | yes | Money |
| `orders-get-order`, `orders-list` | yes | Someone else's purchase history |

Three properties, each covered by a test in `cheela-smoke.mjs`:

- **Ownership comes from the credential, never the input.** `checkout-place-order`
  takes no user id — it files the order against the token's user. An agent cannot
  place an order on somebody else's account even if it tries.
- **Cross-account access fails identically to "not found".** Reading or paying
  another shopper's order gives the same message as a nonexistent order number,
  so an agent cannot probe for which orders exist.
- **No sign-in capability exists.** Authenticating through a capability would put a
  password through the model. Shoppers sign in on the storefront; the widget passes
  the resulting token down.

---

## 5. The mock payment flow

There is no processor. `server/src/mock-payments.js` decides the outcome from an
opaque method token, so every branch — success, decline, insufficient funds, expiry
— is reproducible in a test rather than something you can only hit by luck against
a sandbox.

```mermaid
stateDiagram-v2
    [*] --> pending_payment: POST /api/orders<br/>stock reserved, cart emptied
    pending_payment --> paid: charge succeeds<br/>payment captured
    pending_payment --> payment_failed: issuer declines<br/>stock released
    payment_failed --> paid: retry with another method
    pending_payment --> pending_payment: unknown token → 400<br/>order untouched
```

**Why an order and its payment are separate.** Placing reserves stock; paying
settles it. Reserving at placement stops two shoppers both checking out the last
unit and then racing at the card step. Releasing on decline stops a dead order
holding inventory hostage.

**Why an unknown token is a 400, not a decline.** A token the processor does not
recognise is a caller typo, not an issuer decision. Treating it as a decline would
mark the order failed and release its stock over a spelling mistake, so it throws
and leaves the order exactly as it was.

**Why tokens rather than card numbers.** `checkout-pay-order` accepts
`pm_card_visa`, never a PAN. That mirrors real integrations — the card goes from
browser to processor and never touches your server — and it matters more here,
because the alternative is a card number passing through a language model. The
browser form maps well-known test numbers onto the same tokens server-side, so the
UI and the agent exercise one code path.

| Token | Test card | Outcome |
| --- | --- | --- |
| `pm_card_visa` | 4242 4242 4242 4242 | Succeeds |
| `pm_card_mastercard` | 5555 5555 5555 4444 | Succeeds |
| `pm_card_declined` | 4000 0000 0000 0002 | `card_declined` |
| `pm_card_insufficient_funds` | 4000 0000 0000 9995 | `insufficient_funds` |
| `pm_card_expired` | 4000 0000 0000 0069 | `expired_card` |

A decline is a **normal result**, not a thrown error: `paid: false` with a
`declineReason`, so the model explains it and offers a retry instead of reporting a
failed tool call.

### The demo account

```
demo@cheela.shop  /  demo-password-1234
token: demo-session-token-do-not-use-in-production
```

Seeded by `seed.js`. The token is fixed on purpose — capability calls carry an
end-user credential and a test needs one it can predict. That is only acceptable
for a seeded demo; `DEMO_ACCOUNT=off` skips it entirely, and a real deployment must
never ship a known-in-advance session token.

---

## 6. Files I created

### 6.1 The Cheela integration (the part you asked about)

| File | Why it exists |
| --- | --- |
| **`server/.cheela/capabilities.ts`** (854 lines) | **The heart of the integration.** All 14 capabilities: zod input/output schemas, descriptions the model reads, `requiresEndUser` on the four order capabilities, and handlers that call `repo.js`. Also holds `defineCapability()`, `requireShopper()` and a typed facade over `repo.js` (plain JS) so this file type-checks on its own terms. |
| **`server/.cheela/runtime.ts`** (25) | Creates the `Runtime`, grants the `cart:write` / `orders:write` permissions, and registers every capability. This is the file the CLI loads to discover what to deploy. |
| **`server/cheela.config.ts`** (34) | Deploy config: API key (from env), ADP namespace, website metadata, and a conditionally-set endpoint. Scaffolded by `cheela init` — the 0.7 template still omits `provider`/`model`, which live on the dashboard. |
| **`server/tsconfig.json`** (24) | The `.cheela` files are TypeScript. Node strips types natively at runtime, so this exists purely so the IDE and `npm run typecheck` agree. Needs `allowImportingTsExtensions` because Node requires the real `.ts` extension on imports, and `checkJs: false` so the plain-JS storefront resolves without being type-checked. |
| **`client/src/components/Assistant.jsx`** (204) | The shopper-facing chat panel — `<CheelaProvider>` + `<Chat/>` from `@cheela/ui` behind a floating launcher. Passes `endUserToken` as a function so a later sign-in is picked up. Renders **only** if `VITE_CHEELA_PUBLIC_KEY` is set. Replies stream in and render as markdown (`@cheela/ui` 0.2.0). |
| **`client/public/.well-known/agent-discovery.json`** (2063) | The published manifest, fetched by `cheela manifest pull`. Served as a static asset so external agents can discover the store. Committed, because a static host will not run the CLI. |
| **`scripts/cheela-smoke.mjs`** (187) | 39-check test driving the capabilities as an agent would, including the auth boundary (no token, bad token, another shopper's order) and the full pay/decline/retry cycle. Runs the runtime in-process — no server, no API key — yet proves every schema, because `execute()` validates both directions. |
| **`server/.env`** | 🔒 Git-ignored. Holds the real `ch_sk_…` deploy key. The CLI reads this automatically. |
| **`server/.env.example`** | Committed template, key redacted. |
| **`server/src/mock-payments.js`** (108) | The simulated processor: method tokens, test-card mapping, and the outcome table. No network, no real card. |
| **`client/.env`** / **`.env.example`** | Browser config, kept separate because **anything here ships in the JS bundle** — so it only ever holds the public key. |

### 6.2 Files I modified to wire it in

| File | The change |
| --- | --- |
| **`server/src/index.js`** | Mounts `POST /cheela/execute` with `express.raw()` **before** `express.json()`; returns 503 when the secret is unset; excludes `/cheela` from the SPA catch-all; reports capability + gated counts at boot. |
| **`server/src/db.js`** | Added the `payments` table. |
| **`server/src/repo.js`** | Order status lifecycle, `payOrder` / `capturePayment` / `failPayment`, stock release on decline. The one implementation both REST and capabilities call. |
| **`server/src/seed.js`** | Seeds the demo account and its fixed session token. |
| **`server/src/routes.js`** | `POST /orders/:id/pay` and `GET /payment-methods`. |
| **`server/src/auth.js`** | `userByToken()` — resolves a token held directly, rather than an `Authorization` header, which is the shape a capability gets. |
| **`client/src/pages/Checkout.jsx`** | Split into place-then-pay, with a `PaymentStep` card form. |
| **`client/src/api.js`** | `pay()` / `paymentMethods()`, and `allowStatuses` so a 402 decline resolves rather than throws. |
| **`client/src/components/Layout.jsx`** | Renders `<Assistant />` on every page. |
| **`client/src/styles.css`** | The `.assistant-launcher` / `.assistant-panel` block. |
| **`.gitignore`** | Root ignores `.env` and explicitly **un-ignores** `.env.example`; `server/.gitignore` (from `cheela init`) covers the CLI's generated output and cache. |
| **`package.json`** (root + workspaces) | Scripts for dev/deploy/status/manifest/typecheck, and `--env-file-if-exists=.env` on the server scripts. |

### 6.3 The storefront underneath (built before Cheela)

**Backend — `server/src/`**

| File | Why |
| --- | --- |
| `db.js` (146) | SQLite schema + connection via `node:sqlite` (built into Node — no native module to compile). Tables for products, images, carts, orders, users, sessions. |
| `svg.js` (307) | The 14 hand-drawn product illustrations, as code. |
| `products.js` (303) | The 16-product catalogue seed data. |
| `seed.js` (131) | The image pipeline: draw SVG → rasterise to PNG at 3 widths (sharp) → store bytes as BLOBs. Hash-checked so it only re-renders when art changes. |
| `repo.js` (326) | **All queries.** The single source of truth for cart totals, stock rules and order transactions — which is exactly why the capabilities call it directly rather than re-implementing anything. |
| `auth.js` (108) | scrypt password hashing + revocable bearer sessions. |
| `routes.js` (177) | The REST API the React app uses. |
| `index.js` (81) | Express app assembly. |

**Frontend — `client/src/`**

| File | Why |
| --- | --- |
| `main.jsx`, `App.jsx` | Entry point and routes. |
| `api.js` (74) | `fetch` wrapper + money formatting. |
| `store.jsx` (130) | Cart + auth context. The cart lives server-side; only its id is in `localStorage`. |
| `styles.css` (365) | All styling — no CSS framework. |
| `components/` | `Layout`, `ProductCard`, `Icons` (inline SVG), `Assistant`. |
| `pages/` | `Home`, `Catalog`, `Product`, `Cart`, `Checkout`, `Order`, `Login`, `Account`. |
| `public/logo.svg` | Favicon, generated from the same SVG code as the product art. |

**Other:** `scripts/smoke.mjs` (38-check REST API test), `client/index.html`,
`client/vite.config.js` (proxies `/api` → :4000), `README.md`.

### 6.4 Files I did *not* create

- `server/.cheela/generated/**` and `generate.cache.json` — written by `cheela deploy`.
  Git-ignored; regenerated on demand.
- `server/.gitignore` — written by `cheela init`, which appends `.env` and
  `.cheela/generate.cache.json` to whatever it finds. `.cheela/generated/` is added
  on top by hand. `client/.gitignore` now only carries its `.env` line; the stale
  `.cheela/` entry left by the original `cheela init` in `client/` is gone.
- `node_modules/`, `package-lock.json`, `.claude/settings.local.json`.

---

## 7. Configuration and secrets

Two `.env` files, deliberately. The split is a security boundary, not tidiness.

| Where | Variable | Secret? | Used by |
| --- | --- | --- | --- |
| `server/.env` | `CHEELA_API_KEY` (`ch_sk_…`) | 🔒 **Yes** | `cheela deploy`, `cheela status` |
| `server/.env` | `CHEELA_RUNTIME_SECRET` | 🔒 **Yes** | Verifying the HMAC on incoming calls |
| `server/.env` | `CHEELA_RUNTIME_ID` | No | Rejecting signatures meant for another runtime |
| `server/.env` | `CHEELA_ENDPOINT` | No | The public URL Cheela calls back on |
| `server/.env` | `PUBLIC_BASE_URL`, `STOREFRONT_URL` | No | Building image and CTA links in results |
| `client/.env` | `VITE_CHEELA_PUBLIC_KEY` (`ch_pk_…`) | No | The chat widget |

**Anything in `client/.env` is compiled into the JavaScript the user downloads.** A
`ch_sk_` key placed there would be readable by every visitor. That is the entire
reason the files are separate.

The CLI loads `server/.env` by itself. The Express scripts use
`node --env-file-if-exists=.env` so the app and the CLI read the same file.

**Current state:** the deploy key is configured and working.
`CHEELA_RUNTIME_SECRET` is intentionally **blank** — it is shown only once at
registration, so paste it in yourself. Until then `/cheela/execute` returns 503
rather than trusting unsigned requests. It fails closed on purpose.

---

## 8. Why the code looks the way it does

Five constraints that are non-obvious and will bite if changed:

**1. Capability names are hyphen-only.** `cart-add-item`, never `cart.add_item`.
LLM tool-calling APIs reject dots outright — a name the model cannot emit can never
be invoked — and the Agent Discovery Specification rejects underscores. Hyphens are
the only character satisfying both. The dots ADS wants come from `adp.namespace`,
producing `com.example.cheelashop.cart-add-item`. `cheela-smoke.mjs` asserts this
against the SDK's own validator so it cannot silently regress.

**2. The handler is mounted before `express.json()`.** The signature is an HMAC over
the *exact bytes received*. `express.json()` consumes the stream and re-serialising
the parsed object produces different bytes — key order, whitespace — so every
signature would fail. Hence `express.raw({ type: '*/*' })`.

**3. The runtime is in `server/`, not `client/`.** `cheela init` scaffolds wherever
you run it, and it was first run in `client/`. But capability calls arrive over
HTTPS and must land on Express; Vite cannot serve them in production. Putting the
runtime on the server also lets capabilities call `repo.js` directly — no self-HTTP
hop, and cart/stock/order logic stays in one place.

**4. `endpoint` is only sent when `CHEELA_ENDPOINT` is set.** Your dashboard already
holds a working endpoint. Deploying a placeholder would overwrite it with a dead
URL and silently break the runtime.

**5. There is no sign-in capability.** Authenticating through a capability means
putting a password through the model. Shoppers sign in on the storefront and the
widget passes the resulting token down as `endUserToken`.

**6. Placing and paying are separate capabilities.** A single "buy this" call would
have to both reserve stock and take money in one step, which leaves no state for the
model to reason about when a card is declined. Splitting them means a decline is a
recoverable position — the order still exists, and `checkout-pay-order` can be
retried with another method.

Also worth knowing: **provider and model are not in `cheela.config.ts`.** As of CLI
0.5 they live on the dashboard's Provider & endpoint card. `cheela status` reports
which are in force — currently openrouter / `openai/gpt-oss-20b:free`.

### What the 0.7 build changed here

Current versions: `@cheela/cli@0.9.0`, `@cheela/{runtime,sdk}@0.7.0`,
`@cheela/ui@0.2.0`, `@cheela/client@0.4.0` (see §12 for what the UI side
brought). Three things mattered on the 0.7 core:

**1. `createCapability` is generic, and it is the reason this file shrank in
concept if not in lines.** In 0.6 it returned `Capability<unknown, unknown>`, so
every handler had to restate its own input shape as a type annotation —
`handler: (_ctx: ActionContext, input: { cartId: string }) => …` — a cast the API
gave you no way to avoid, and a second place for the schema to drift. In 0.7 the
zod schemas flow through to the handler, so the annotations are gone and **both
directions are checked at compile time**:

```
input.cartIdTypo  →  Property 'cartIdTypo' does not exist on type '{ cartId: string; }'
total: String(x)  →  Action<…> is not assignable to Action<…>
```

Under 0.6 both were `unknown` and survived until `execute()` validated them at
runtime. `defineCapability()` at the top of `capabilities.ts` exists to make that
inference reachable: pairing the capability and action in one call is what lets
TypeScript infer from the schemas and contextually type the handler.

**2. The SDK dropped `CAPABILITY_NAME_PATTERN`, `suggestCapabilityName`,
`createPermission`, the `Permission` type and `RuntimeError`.** Nothing here
imported them, so the upgrade was a no-op — but a project that did will not
compile. `isValidCapabilityName` and `describeCapabilityNameError` survive.

**3. `Runtime.execute()` accepts Cheela's `executionId`.** The Express handler
forwards it, so a handler that logs it can be joined to the trace in the
dashboard instead of minting an unrelated id.

What did **not** change: the four generated artifacts are byte-identical to the
0.6 output apart from their timestamps, and the published ADP manifest is
unchanged. Upgrading did not alter what agents see.

### CLI 0.9.0

There is no 0.8.0 — the CLI went 0.7.0 → 0.9.0. Its **public type surface is
identical**, and the whole behavioural diff is one thing:

**`CHEELA_API_URL` is gone.** 0.7.0 resolved the control-plane base URL as
`options.baseUrl ?? process.env.CHEELA_API_URL ?? "https://api.cheelalabs.com/"`;
0.9.0 drops the env var, hardcoding the default. The matching
"Check CHEELA_API_URL and your network connection" error text and the
`# Optional: CHEELA_API_URL=http://localhost:3000` line in the generated
`.env.example` went with it. Pointing the CLI at a local control plane now
requires passing `baseUrl` programmatically.

Nothing else moved: same generators, same config schema, same commands, same
deployment manifest. This project never set `CHEELA_API_URL`, so the upgrade is
a no-op here.

---

## 9. Commands

```bash
npm run dev                 # storefront: :5173 (UI) + :4000 (API)

npm run smoke               # 48 checks — REST API incl. payments (needs the server)
npm run smoke:cheela        # 39 checks — capabilities, auth and payment, in-process
npm run typecheck           # the .cheela TypeScript

npm run cheela:dev          # list what the runtime would deploy, ship nothing
npm run cheela:status       # what the platform currently holds
npm run cheela:deploy:dry   # validate + generate, ship nothing
npm run cheela:deploy       # publish the capability set

# refresh the served discovery manifest after a deploy (run in client/)
cd client && npx cheela manifest pull --runtime rt_23fc70839a4b02f45b91ae6c9794f8e1
```

**Current deployment**

```
Runtime        rt_23fc70839a4b02f45b91ae6c9794f8e1
Deployment     7 — active
Connection     online (Signed HTTPS)
Provider       openrouter / openai/gpt-oss-20b:free
Capabilities   15, in sync (5 require a signed-in shopper)
Endpoint       https://<quick-tunnel>.trycloudflare.com/cheela/execute
```

The endpoint is a **cloudflared quick tunnel**, which gets a fresh hostname every
time it starts. Restarting it means updating `CHEELA_ENDPOINT` and redeploying,
because the platform stores the URL rather than resolving it.

**One gap worth knowing.** `requiresEndUser` reaches the *generated* capability
manifest (`.cheela/generated/capability-manifest/capabilities.json`) and, as of CLI
0.7, is a declared field on the deployment manifest sent to the control plane. It
still does **not** appear in the published ADP document that
`cheela manifest pull` returns — checked against the live manifest on 0.7 — so an
agent discovering the store externally cannot see which capabilities need a
credential until a call fails. That is a platform limitation, not a setting. The
mitigation is in the descriptions: each gated capability says "Requires a signed-in
shopper" in prose, and descriptions *are* published.

---

## 10. To take this live

1. **Paste `CHEELA_RUNTIME_SECRET`** into `server/.env` — until then the endpoint 503s.
2. **Expose the endpoint.** Cheela calls in, so `localhost` is unreachable. Tunnel it
   (`ngrok http 4000`), set `CHEELA_ENDPOINT` to `https://…/cheela/execute`, redeploy.
3. **Set `VITE_CHEELA_PUBLIC_KEY`** in `client/.env` to make the chat widget appear.
4. **Change the ADP namespace.** It is still the placeholder `com.example.cheelashop`
   and is baked into every published capability name — use your real domain before
   this is public, then redeploy and re-pull the manifest.
5. **Remove the demo account.** Set `DEMO_ACCOUNT=off`. Its session token is fixed
   and documented, which is fine for a demo and unacceptable anywhere real.
6. **Replace the mock processor.** `server/src/mock-payments.js` is the only thing
   standing in for a payment provider; `repo.payOrder` is the seam to swap.

---

## 11. Known upstream issue: the chat widget and `fetch`

**Symptom.** Every message in the assistant fails immediately with
*"Could not reach the Cheela API. Check the network connection and baseUrl."* —
even though the API is reachable, CORS is correct, and the key is valid.

**Still present on 0.4.0**, the version `@cheela/ui@0.2.0` pins. Re-checked at
that release: the constructor is byte-for-byte the same as 0.2.0's, and
`CheelaProviderProps` still exposes no `fetchImpl` prop, so there is still
nowhere to inject a bound copy. Re-check on the next `@cheela/ui`.

**Cause.** `@cheela/client@0.2.0` stores the global fetch on its instance and
then calls it as a method:

```js
this.fetchImpl = options.fetchImpl ?? fetch;   // constructor
response = await this.fetchImpl(url, init);    // execute()
```

That rebinds `this` from `window` to the client, and browsers reject it:

```
TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation
```

The client catches everything around that call and rethrows it as
`CheelaNetworkError`, so the message points at DNS and CORS when the network was
never involved. It fails for every message, in every browser, whatever the
configuration.

**Fix here.** `CheelaProvider` exposes no `fetchImpl` prop, so there is nowhere
to inject a bound copy. `Assistant.jsx` binds the global once at module load.
This is semantically inert — `fetch` is specified to work with any receiver — and
should be removed once upstream binds its own reference.

The same wrapper rescues a second silent failure: when the platform cannot
invoke a capability it answers **HTTP 200** with `{ status: "failed", error }`.
Nothing throws, the reply carries no assistant text, and the shopper is left
looking at their own message. The wrapper turns that into a rejection so the
existing `onError` path can explain it.

**Verify the transport independently of the widget:**

```js
await fetch('https://api.cheelalabs.com/v1/runtime/execute', {
  method: 'POST',
  headers: { Authorization: 'Bearer ch_pk_…', 'Content-Type': 'application/json' },
  body: JSON.stringify({ messages: [{ role: 'user', parts: [{ type: 'text', content: 'hi' }] }] }),
}).then(r => r.json());
```

A 401 means the public key is wrong. A 200 with `status: "failed"` and
*"has no HTTPS endpoint configured"* means the transport is fine and the runtime
simply has nowhere to be called back on — see below.

---

## 12. Streaming, and the override that enables it

**Symptom.** The assistant's reply appears all at once after a long pause,
rather than filling in word by word.

**Cause.** Nothing to do with the runtime — the platform has always streamed.
`POST /v1/runtime/execute` with `Accept: text/event-stream` returns
`content-type: text/event-stream` and token-level `event: text` frames. But
`@cheela/client@0.2.0` contains **no streaming code at all** — no
`executeStream`, no `Accept: text/event-stream`, nothing — and
`@cheela/ui@0.1.1` pins that version *exactly*.

**Fix.** Streaming arrived in `@cheela/client@0.3.0` via `executeStream()`, and —
the part that matters — its `ConversationStore.sendMessage` consumes it
internally, pushing a state update per token. `ConversationStore` is exactly what
`@cheela/ui` drives, and its public API has not changed since 0.2.0, so a newer
client makes the widget stream with **no UI code change**.

**`@cheela/ui@0.2.0` now depends on `@cheela/client@0.4.0` directly, so nothing
special is needed — just install it.** An earlier revision of this project forced
the newer client under `ui@0.1.1` with a root `overrides` entry; that is gone,
and should not be reintroduced. If you ever do need it again, note that npm only
honours `overrides` in the **workspace root**, a stale `node_modules` ignores the
change entirely (only `rm -rf node_modules package-lock.json && npm install`
applies it), and it never appears in `package-lock.json` — so confirm with the
installed version rather than the lockfile:

```bash
node -p "require('./node_modules/@cheela/client/package.json').version"
```

Verified by driving `ConversationStore` directly against the live API on 0.4.0:
**20** incremental state updates, the reply growing 3 → 66 characters. On 0.2.0
that is a single update.

**The fetch wrapper had to learn about SSE.** `Assistant.jsx` inspects
execute responses with `await response.clone().json()` to catch the
HTTP-200-with-`status: "failed"` case. On a streaming body `.json()` does not
reject until the stream *ends*, so awaiting it held the response back until the
reply was complete — defeating the streaming it was meant to coexist with. It
now returns immediately for `text/event-stream`.

**One consequence to be aware of.** That silent-failure guard therefore no
longer covers the streaming path, and `ConversationStore.sendMessage` ignores
`result.status` on the `done` event. So a platform-side failure — the 408 in §13,
for instance — again surfaces as an empty assistant turn rather than an error in
the panel. The `capability_end` event carries an `error` field, which is where a
proper fix would read it from.

---

## 13. The endpoint is not optional

Cheela calls *in*. Until the runtime has a public HTTPS endpoint, the model picks
a capability and then the platform fails with:

```
Runtime rt_… has no HTTPS endpoint configured
```

which is what the assistant surfaces as *"not connected to the store"*. Browsing,
the REST API and the capability code are all fine — there is simply no route from
Cheela back to this machine.

```bash
# 1. expose the local server
npx cloudflared tunnel --url http://localhost:4000

# 2. point the runtime at it (server/.env)
CHEELA_ENDPOINT=https://<subdomain>.trycloudflare.com/cheela/execute
CHEELA_RUNTIME_SECRET=<the secret shown once at registration>

# 3. republish
npm run cheela:deploy
```

**Use cloudflared, not localtunnel.** Measured here on the same server:
localtunnel answered in **9.6s**, cloudflared in **0.84s**. Cheela gives up well
before 9s and reports the capability call as

```
Runtime unreachable while calling "catalog-search-products":
Runtime HTTP transport failed with status 408
```

which reads like a broken integration but is purely tunnel latency — signed
requests sent by hand over that same localtunnel succeeded. localtunnel also
dropped its process unprompted mid-session, turning the 408s into 502s. Neither
failure says anything about the runtime.

`CHEELA_RUNTIME_SECRET` matters just as much: without it `/cheela/execute` answers
503 rather than trusting unsigned requests, so Cheela would reach the server and
still be turned away.
