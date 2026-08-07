/**
 * Cheela capabilities for the storefront.
 *
 * Each capability is the agent-facing contract for one shop operation. They
 * call `repo.js` directly — the same code path the REST API uses — so stock
 * checks, cart totals, payment settlement and order transactions behave
 * identically whether a human clicks a button or an agent invokes a capability.
 *
 * Names are hyphen-only (`cart-add-item`, never `cart.add_item`): dots are
 * rejected by LLM tool-calling APIs and underscores by the Agent Discovery
 * Specification, so hyphens are the only separator that satisfies both. The
 * dots ADS wants come from `adp.namespace` in cheela.config.ts.
 *
 * ## Authentication
 *
 * Browsing and cart work for anonymous visitors. Anything touching an order —
 * placing, paying, reading — sets `requiresEndUser: true`, so the runtime
 * refuses the call outright when it carries no credential. The handler then
 * resolves `context.endUserToken` through the same session table the REST API
 * uses, which is what stops a capability and `GET /api/orders` disagreeing
 * about who someone is.
 *
 * ## Conventions
 *
 *   - Money is returned twice: `*Cents` (integer, for arithmetic) and a
 *     preformatted display string, so the model never does currency maths.
 *   - Anything a user might want to open comes back as a `*Url`, which turns
 *     a capability result directly into a CTA.
 *   - Payment takes an opaque method token, never a card number — card data
 *     must never pass through a language model.
 */

import { createAction, createCapability } from '@cheela/sdk';
import type { Action, ActionContext, Capability } from '@cheela/sdk';
import type { Runtime } from '@cheela/runtime';
import { isSafeActionUrl } from '@cheela/protocol';
import { z } from 'zod';

import * as repoModule from '../src/repo.js';
// Same session table and expiry check the REST API uses, so a capability and
// `GET /api/orders` can never disagree about who someone is.
import { userByToken } from '../src/auth.js';
import { listPaymentMethods } from '../src/mock-payments.js';
import * as razorpayModule from '../src/razorpay.js';

const razorpay = razorpayModule as unknown as {
  isConfigured(): boolean;
  createPaymentLink(input: {
    amount: number; description: string; reference: string;
    customer?: { name?: string; email?: string; phone?: string };
    callbackUrl?: string;
  }): Promise<{ id: string; short_url: string }>;
};

/** Whether a real gateway is in play, or the simulated processor stands in. */
const PAYMENTS_ARE_LIVE = razorpay.isConfigured();

/* ------------------------------ registration ----------------------------- */

/**
 * A capability and the action implementing it, ready to register.
 *
 * `defineCapability` pairs them in one call so SDK 0.7's generics can do the
 * work: `TInput`/`TOutput` are inferred from the zod schemas on the capability
 * and then contextually type the handler. That is why no handler below repeats
 * its input shape as a type annotation, and why returning the wrong shape is a
 * compile error rather than a runtime schema failure.
 *
 * Registration is a closure rather than a `{ capability, action }` pair because
 * the pair's two halves are inferred from different places — schemas on one
 * side, the handler on the other — and putting them in a homogeneous array
 * collapses both to `unknown`, which is what forced the previous version of
 * this file to fall back to `Action<any, any>`. Capturing them here keeps every
 * pair precisely typed at its own definition site.
 */
export interface CapabilityRegistration {
  readonly capability: Capability;
  register(runtime: Runtime): void;
}

function defineCapability<TInput, TOutput>(
  capability: Capability<TInput, TOutput>,
  action: Action<TInput, TOutput>,
): CapabilityRegistration {
  return {
    capability: capability as Capability,
    register: (runtime) => runtime.register(capability, action),
  };
}

/* --------------------------- repo type facade ---------------------------- */

/**
 * `repo.js` is plain JavaScript, so describe the shapes consumed here rather
 * than relying on inference through an untyped module — that keeps this file
 * type-checking on its own terms and documents the contract in one place.
 */
interface ShopProduct {
  id: string;
  name: string;
  tagline: string;
  description: string;
  price: number;
  compareAtPrice: number | null;
  category: string;
  tags: string[];
  rating: number;
  reviews: number;
  stock: number;
  inStock: boolean;
  featured: boolean;
  specs: Record<string, string>;
  image: { src: string; thumb: string; srcset: string; width: number; height: number };
}

interface ShopCart {
  id: string;
  count: number;
  subtotal: number;
  shipping: number;
  tax: number;
  total: number;
  freeShippingThreshold: number;
  items: { itemId: number; qty: number; lineTotal: number; product: ShopProduct }[];
}

interface ShopPayment {
  id: string;
  status: string;
  method: string;
  brand: string | null;
  last4: string | null;
  amount: number;
  failureCode: string | null;
  failureMessage: string | null;
}

interface ShopOrder {
  id: string;
  number: string;
  /** Null for a guest order. */
  userId: string | null;
  status: string;
  customer: string;
  email: string;
  address: Record<string, string>;
  subtotal: number;
  shipping: number;
  tax: number;
  total: number;
  createdAt: string;
  items: { productId: string; name: string; unitPrice: number; qty: number; lineTotal: number }[];
  payment: ShopPayment | null;
}

const repo = repoModule as unknown as {
  listProducts(query: {
    q?: string; category?: string; sort?: string;
    minPrice?: number | null; maxPrice?: number | null;
    inStock?: boolean; featured?: boolean; limit?: number; page?: number;
  }): { items: ShopProduct[]; total: number; page: number; pages: number };
  getProduct(id: string): ShopProduct | null;
  relatedProducts(id: string, limit?: number): ShopProduct[];
  listCategories(): { name: string; count: number }[];
  createCart(userId?: string | null): ShopCart;
  cartExists(id: string): boolean;
  getCart(id: string): ShopCart | null;
  addToCart(cartId: string, productId: string, qty?: number): ShopCart;
  updateCartItem(cartId: string, itemId: number, qty: number): ShopCart;
  removeCartItem(cartId: string, itemId: number): ShopCart;
  clearCart(cartId: string): ShopCart;
  createOrder(input: {
    cartId: string; email: string; customer: string;
    // Either a saved address row or a freshly-collected one; repo.js serialises
    // whatever it is given onto the order.
    address: Partial<ShopAddress> | Record<string, string | undefined>;
    userId?: string | null; addressId?: string | null;
  }): ShopOrder;
  getOrder(idOrNumber: string): ShopOrder | null;
  listOrdersForUser(userId: string): ShopOrder[];
  payOrder(idOrNumber: string, paymentMethod: string): {
    ok: boolean; order: ShopOrder; error: { code: string; message: string } | null;
  };
  totals(items: { qty: number; lineTotal: number }[]): {
    count: number; subtotal: number; shipping: number;
    tax: number; total: number; freeShippingThreshold: number;
  };
  activeCartForUser(userId: string): ShopCart | null;
  claimCart(cartId: string, userId: string): ShopCart;
  ensureCartForUser(userId: string): ShopCart;
  listAddresses(userId: string): ShopAddress[];
  getAddress(id: string, userId: string): ShopAddress | null;
  formatAddress(address: Partial<ShopAddress> | null): string;
  attachPaymentLink(orderId: string, link: { id?: string; url?: string }): unknown;
};

interface ShopAddress {
  id: string;
  label: string;
  name: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postcode: string;
  country: string;
  isDefault: boolean;
}

/** Where the API serves images from — used to absolutise image URLs. */
const API_URL = process.env.PUBLIC_BASE_URL || 'http://localhost:4000';
/** Where the storefront runs — used to build links the agent can offer. */
const SHOP_URL = process.env.STOREFRONT_URL || 'http://localhost:5173';

/**
 * Paise -> display string, matching the storefront exactly so the agent and the
 * page never quote different-looking prices for the same product.
 */
const money = (paise: number) =>
  (paise / 100).toLocaleString('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });

/* --------------------------------- auth ---------------------------------- */

/**
 * Resolves the signed-in shopper for a capability call.
 *
 * The runtime already refuses a `requiresEndUser` capability that carries no
 * token at all. This covers the other half: a token that is present but
 * expired, revoked or simply wrong. Both failures have to be handled — only
 * one of them is the platform's job.
 */
function requireShopper(context: ActionContext) {
  const user = userByToken(context.endUserToken);
  if (!user) {
    throw new Error(
      'That sign-in has expired or is not valid. Ask the shopper to sign in again before retrying.',
    );
  }
  return user;
}

/* ------------------------------- ui actions ------------------------------ */

/**
 * Buttons the chat panel renders from a capability result.
 *
 * Protocol 0.3 added these to fix exactly the failure this shop had: a payment
 * URL was only ever seen by the shopper if the *model* chose to repeat it in
 * prose, which made the pay button conditional on the model's mood and on it
 * transcribing a long signed URL without mangling it. Declaring the action puts
 * the rendering beyond the model's reach — it still decides whether to call the
 * capability, but not how the result looks.
 */
const actionsShape = z.object({
  actions: z.array(z.object({
    type: z.literal('link'),
    label: z.string(),
    url: z.string(),
    description: z.string().optional(),
    style: z.enum(['primary', 'secondary']).optional(),
  })),
}).optional();

interface LinkActionInput {
  label: string;
  url: string | null | undefined;
  description?: string;
  style?: 'primary' | 'secondary';
}

/**
 * Builds the `cheela.actions` block, dropping anything the UI would refuse.
 *
 * `isSafeActionUrl` permits `https:` only — not even `http:`, since these links
 * carry payment sessions. Filtering here rather than shipping a doomed action
 * means a local `http://localhost` storefront quietly renders no button instead
 * of appearing to and silently failing. Set `STOREFRONT_URL`/`PUBLIC_BASE_URL`
 * to an https tunnel to see them in development.
 */
function cheelaActions(...candidates: LinkActionInput[]) {
  const actions = candidates
    .filter((a): a is LinkActionInput & { url: string } =>
      typeof a.url === 'string' && isSafeActionUrl(a.url))
    .map((a) => ({
      type: 'link' as const,
      label: a.label,
      url: a.url,
      ...(a.description ? { description: a.description } : {}),
      ...(a.style ? { style: a.style } : {}),
    }));

  return actions.length ? { actions } : undefined;
}

/* ----------------------------- shared shapes ----------------------------- */

const productSummary = z.object({
  id: z.string(),
  name: z.string(),
  tagline: z.string(),
  category: z.string(),
  price: z.string().describe('Display price, e.g. "₹14,999"'),
  priceCents: z.number().int(),
  compareAtPrice: z.string().nullable().describe('Original price when on sale'),
  onSale: z.boolean(),
  rating: z.number(),
  reviews: z.number().int(),
  inStock: z.boolean(),
  stock: z.number().int(),
  imageUrl: z.string(),
  productUrl: z.string().describe('Storefront page for this product'),
});

const cartShape = z.object({
  cartId: z.string(),
  itemCount: z.number().int(),
  items: z.array(
    z.object({
      itemId: z.number().int().describe('Use this to update or remove the line'),
      productId: z.string(),
      name: z.string(),
      quantity: z.number().int(),
      unitPrice: z.string(),
      lineTotal: z.string(),
      lineTotalCents: z.number().int(),
    }),
  ),
  subtotal: z.string(),
  shipping: z.string(),
  tax: z.string(),
  total: z.string(),
  totalCents: z.number().int(),
  freeShippingRemaining: z.string().nullable()
    .describe('Spend this much more for free shipping; null once qualified'),
  cartUrl: z.string(),
  checkoutUrl: z.string(),
});

const orderShape = z.object({
  orderNumber: z.string(),
  status: z.string().describe('pending_payment | paid | payment_failed | cancelled'),
  paid: z.boolean().describe('True only once payment has been captured'),
  customer: z.string(),
  email: z.string(),
  items: z.array(
    z.object({
      productId: z.string(),
      name: z.string(),
      quantity: z.number().int(),
      unitPrice: z.string(),
      lineTotal: z.string(),
    }),
  ),
  subtotal: z.string(),
  shipping: z.string(),
  tax: z.string(),
  total: z.string(),
  totalCents: z.number().int(),
  shippingAddress: z.string(),
  placedAt: z.string(),
  orderUrl: z.string(),
  payment: z.object({
    status: z.string().describe('requires_payment | captured | failed'),
    brand: z.string().nullable(),
    last4: z.string().nullable(),
    failureReason: z.string().nullable(),
  }).nullable(),
});

/* -------------------------------- mappers -------------------------------- */

function toSummary(p: ShopProduct) {
  const onSale = Boolean(p.compareAtPrice && p.compareAtPrice > p.price);
  return {
    id: p.id,
    name: p.name,
    tagline: p.tagline,
    category: p.category,
    price: money(p.price),
    priceCents: p.price,
    compareAtPrice: onSale ? money(p.compareAtPrice as number) : null,
    onSale,
    rating: p.rating,
    reviews: p.reviews,
    inStock: p.inStock,
    stock: p.stock,
    imageUrl: `${API_URL}${p.image.src}`,
    productUrl: `${SHOP_URL}/product/${p.id}`,
  };
}

function toCart(cart: ShopCart | null) {
  if (!cart) throw new Error('Cart not found. Create one with cart-add-item first.');
  const remaining = cart.freeShippingThreshold - cart.subtotal;
  return {
    cartId: cart.id,
    itemCount: cart.count,
    items: cart.items.map((item) => ({
      itemId: item.itemId,
      productId: item.product.id,
      name: item.product.name,
      quantity: item.qty,
      unitPrice: money(item.product.price),
      lineTotal: money(item.lineTotal),
      lineTotalCents: item.lineTotal,
    })),
    subtotal: money(cart.subtotal),
    shipping: cart.shipping === 0 ? 'Free' : money(cart.shipping),
    tax: money(cart.tax),
    total: money(cart.total),
    totalCents: cart.total,
    freeShippingRemaining: remaining > 0 ? money(remaining) : null,
    cartUrl: `${SHOP_URL}/cart`,
    checkoutUrl: `${SHOP_URL}/checkout`,
  };
}

function toOrder(order: ShopOrder | null) {
  if (!order) throw new Error('Order not found');
  const a = order.address;
  return {
    orderNumber: order.number,
    status: order.status,
    paid: order.status === 'paid',
    customer: order.customer,
    email: order.email,
    items: order.items.map((i) => ({
      productId: i.productId,
      name: i.name,
      quantity: i.qty,
      unitPrice: money(i.unitPrice),
      lineTotal: money(i.lineTotal),
    })),
    subtotal: money(order.subtotal),
    shipping: order.shipping === 0 ? 'Free' : money(order.shipping),
    tax: money(order.tax),
    total: money(order.total),
    totalCents: order.total,
    shippingAddress: [a.line1, a.line2, a.city, a.state, a.postcode, a.country]
      .filter(Boolean)
      .join(', '),
    placedAt: order.createdAt,
    orderUrl: `${SHOP_URL}/order/${order.number}`,
    payment: order.payment
      ? {
        status: order.payment.status,
        brand: order.payment.brand,
        last4: order.payment.last4,
        failureReason: order.payment.failureMessage,
      }
      : null,
  };
}

/**
 * Returns the order only if it belongs to this shopper.
 *
 * Deliberately gives the same message whether the order does not exist or
 * belongs to someone else — otherwise an agent could confirm which order
 * numbers are real by probing them.
 */
function ownedOrder(orderNumber: string, userId: string) {
  const order = repo.getOrder(orderNumber);
  if (!order || order.userId !== userId) {
    throw new Error(`No order "${orderNumber}" found on this account.`);
  }
  return order;
}

/**
 * Which cart a capability call should act on.
 *
 * The shopper's own cart wins whenever we can identify them, even if the model
 * passed a `cartId` — otherwise the assistant fills a cart the shopper cannot
 * see, and the item genuinely was added, just not to the bag on screen. That
 * was the single most confusing failure in this integration.
 *
 * An anonymous visitor still gets the old behaviour: whatever `cartId` they
 * were given, or a fresh cart.
 */
function resolveCart(context: ActionContext, cartId?: string) {
  const shopper = context.endUserToken ? userByToken(context.endUserToken) : null;

  if (!shopper) {
    // Anonymous visitor: carry on with whatever cart they were given.
    if (cartId && repo.cartExists(cartId)) return cartId;
    return repo.createCart().id;
  }

  // A cart handed over explicitly is adopted only when it actually holds
  // something. That splits the two cases which otherwise look identical:
  //
  //   - a guest filled a bag and then signed in — real items, keep them;
  //   - the model repeated a stale cartId from an earlier turn — empty, and
  //     honouring it would put the shopper back on a cart they cannot see,
  //     which is the exact bug this function exists to stop.
  //
  // `claimCart` refuses a cart owned by someone else, so that falls through.
  if (cartId && repo.cartExists(cartId)) {
    const candidate = repo.getCart(cartId);
    if (candidate && candidate.items.length > 0) {
      try {
        return repo.claimCart(cartId, shopper.id).id;
      } catch { /* another account's cart — use this shopper's own below */ }
    }
  }

  return repo.ensureCartForUser(shopper.id).id;
}

/* ------------------------------- browsing -------------------------------- */

export const searchProducts = defineCapability(
  createCapability({
    name: 'catalog-search-products',
    description:
      'Search and filter the product catalogue. Use this for any question about what is for sale, ' +
      'what is available in a category, what is on sale, or what fits a budget.',
    version: '1.1.0',
    input: z.object({
      query: z.string().optional().describe('Free-text search over name, tagline, description and tags'),
      category: z.enum(['Accessories', 'Audio', 'Bags', 'Footwear', 'Home', 'Outdoors', 'Tech'])
        .optional()
        .describe('Restrict to one category'),
      sort: z.enum(['featured', 'price-asc', 'price-desc', 'rating', 'name'])
        .optional()
        .describe('Result ordering; defaults to featured'),
      minPriceCents: z.number().int().nonnegative().optional(),
      maxPriceCents: z.number().int().nonnegative().optional().describe('Budget ceiling, in cents'),
      inStockOnly: z.boolean().optional(),
      limit: z.number().int().min(1).max(24).optional().describe('Defaults to 8'),
      page: z.number().int().min(1).optional(),
    }),
    output: z.object({
      items: z.array(productSummary),
      total: z.number().int().describe('Total matches, not just this page'),
      page: z.number().int(),
      pages: z.number().int(),
    }),
  }),
  createAction({
    name: 'searchProducts',
    description: 'Query the catalogue.',
    handler: (_ctx, input) => {
      const result = repo.listProducts({
        q: input.query,
        category: input.category,
        sort: input.sort,
        minPrice: input.minPriceCents ?? null,
        maxPrice: input.maxPriceCents ?? null,
        inStock: input.inStockOnly ?? false,
        limit: input.limit ?? 8,
        page: input.page ?? 1,
      });
      return {
        items: result.items.map(toSummary),
        total: result.total,
        page: result.page,
        pages: result.pages,
      };
    },
  }),
);

export const getProduct = defineCapability(
  createCapability({
    name: 'catalog-get-product',
    description:
      'Full detail for one product: description, specifications, stock level and related items. ' +
      'Call this before adding something to the cart if the shopper asked about specifics.',
    version: '1.1.0',
    input: z.object({
      productId: z.string().describe('Product id, e.g. "aurora-over-ear"'),
    }),
    output: z.object({
      product: productSummary.extend({
        description: z.string(),
        specs: z.record(z.string(), z.string()).describe('Spec name to value'),
        tags: z.array(z.string()),
      }),
      related: z.array(productSummary),
    }),
  }),
  createAction({
    name: 'getProduct',
    description: 'Fetch one product with its specifications.',
    handler: (_ctx, input) => {
      const product = repo.getProduct(input.productId);
      if (!product) {
        throw new Error(
          `No product with id "${input.productId}". Use catalog-search-products to find valid ids.`,
        );
      }
      return {
        product: {
          ...toSummary(product),
          description: product.description,
          specs: product.specs,
          tags: product.tags,
        },
        related: repo.relatedProducts(input.productId).map(toSummary),
      };
    },
  }),
);

export const listCategories = defineCapability(
  createCapability({
    name: 'catalog-list-categories',
    description: 'List every product category with how many products it holds.',
    version: '1.1.0',
    input: z.object({}),
    output: z.object({
      categories: z.array(z.object({
        name: z.string(),
        count: z.number().int(),
        categoryUrl: z.string(),
      })),
    }),
  }),
  createAction({
    name: 'listCategories',
    description: 'Enumerate categories.',
    handler: () => ({
      categories: repo.listCategories().map((c) => ({
        name: c.name,
        count: c.count,
        categoryUrl: `${SHOP_URL}/shop?category=${encodeURIComponent(c.name)}`,
      })),
    }),
  }),
);

/* --------------------------------- cart ---------------------------------- */

export const viewCart = defineCapability(
  createCapability({
    name: 'cart-view',
    description: 'Show the current contents and totals of a cart.',
    version: '1.1.0',
    input: z.object({
      cartId: z.string().optional()
        .describe('Omit for a signed-in shopper — their own cart is used automatically'),
    }),
    output: cartShape,
  }),
  createAction({
    name: 'viewCart',
    description: 'Read a cart.',
    handler: (ctx, input) => toCart(repo.getCart(resolveCart(ctx, input.cartId))),
  }),
);

export const addToCart = defineCapability(
  createCapability({
    name: 'cart-add-item',
    description:
      'Add a product to the cart. Omit cartId to start a new cart — the id comes back in the ' +
      'result, and every later cart call needs it. Stock is enforced, so this fails if the ' +
      'requested quantity exceeds what is available.',
    version: '1.1.0',
    input: z.object({
      productId: z.string(),
      quantity: z.number().int().min(1).optional().describe('Defaults to 1'),
      cartId: z.string().optional().describe('Omit to create a new cart'),
    }),
    output: cartShape.extend({
      added: z.string().describe('Confirmation of what was added'),
    }),
  }),
  createAction({
    name: 'addToCart',
    description: 'Add a line to the cart, creating the cart when needed.',
    permissions: ['cart:write'],
    handler: (ctx, input) => {
      const product = repo.getProduct(input.productId);
      if (!product) {
        throw new Error(
          `No product with id "${input.productId}". Use catalog-search-products to find valid ids.`,
        );
      }
      if (!product.inStock) throw new Error(`${product.name} is sold out.`);

      const qty = input.quantity ?? 1;
      const cartId = resolveCart(ctx, input.cartId);

      return {
        ...toCart(repo.addToCart(cartId, input.productId, qty)),
        added: `${qty} × ${product.name}`,
      };
    },
  }),
);

export const updateCartItem = defineCapability(
  createCapability({
    name: 'cart-update-item',
    description: 'Change the quantity of a line already in the cart. Setting quantity to 0 removes it.',
    version: '1.1.0',
    input: z.object({
      cartId: z.string().optional().describe('Omit for a signed-in shopper — their own cart is used'),
      itemId: z.number().int().describe('The itemId from a cart result, not the product id'),
      quantity: z.number().int().min(0),
    }),
    output: cartShape,
  }),
  createAction({
    name: 'updateCartItem',
    description: 'Set a line quantity.',
    permissions: ['cart:write'],
    handler: (ctx, input) =>
      toCart(repo.updateCartItem(resolveCart(ctx, input.cartId), input.itemId, input.quantity)),
  }),
);

export const removeCartItem = defineCapability(
  createCapability({
    name: 'cart-remove-item',
    description: 'Remove a line from the cart entirely.',
    version: '1.1.0',
    input: z.object({
      cartId: z.string().optional().describe('Omit for a signed-in shopper — their own cart is used'),
      itemId: z.number().int().describe('The itemId from a cart result'),
    }),
    output: cartShape,
  }),
  createAction({
    name: 'removeCartItem',
    description: 'Drop a cart line.',
    permissions: ['cart:write'],
    handler: (ctx, input) => toCart(repo.removeCartItem(resolveCart(ctx, input.cartId), input.itemId)),
  }),
);

export const clearCart = defineCapability(
  createCapability({
    name: 'cart-clear',
    description: 'Empty the cart without placing an order.',
    version: '1.1.0',
    input: z.object({ cartId: z.string().optional().describe('Omit for a signed-in shopper — their own cart is used') }),
    output: cartShape,
  }),
  createAction({
    name: 'clearCart',
    description: 'Remove every line.',
    permissions: ['cart:write'],
    handler: (ctx, input) => toCart(repo.clearCart(resolveCart(ctx, input.cartId))),
  }),
);

/* ------------------------- addresses (signed in) -------------------------- */

export const listAddresses = defineCapability(
  createCapability({
    name: 'addresses-list',
    description:
      "List the shopper's saved delivery addresses. Requires a signed-in shopper. Call this " +
      'before placing an order so you can offer their saved addresses instead of asking them ' +
      'to dictate one — pass the chosen addressId to checkout-place-order.',
    version: '1.0.0',
    requiresEndUser: true,
    input: z.object({}),
    output: z.object({
      addresses: z.array(z.object({
        addressId: z.string().describe('Pass this to checkout-place-order'),
        label: z.string().describe('What the shopper calls it, e.g. "Home"'),
        recipient: z.string(),
        summary: z.string().describe('The address on one line, safe to read back'),
        city: z.string(),
        state: z.string(),
        postcode: z.string(),
        isDefault: z.boolean(),
      })),
      total: z.number().int(),
    }),
  }),
  createAction({
    name: 'listAddresses',
    description: 'Saved addresses for the signed-in shopper.',
    handler: (context) => {
      const shopper = requireShopper(context);
      const addresses = repo.listAddresses(shopper.id);
      return {
        addresses: addresses.map((a) => ({
          addressId: a.id,
          label: a.label,
          recipient: a.name,
          summary: repo.formatAddress(a),
          city: a.city,
          state: a.state,
          postcode: a.postcode,
          isDefault: a.isDefault,
        })),
        total: addresses.length,
      };
    },
  }),
);

/* ------------------------- checkout (signed in) --------------------------- */

export const placeOrder = defineCapability(
  createCapability({
    name: 'checkout-place-order',
    description:
      'Place the order for a cart. Requires a signed-in shopper. This reserves stock and empties ' +
      'the cart, but does NOT take payment — the order comes back as pending_payment and you must ' +
      'then call checkout-pay-order. Confirm the items and the total with the shopper first, and ' +
      'never invent an address: ask for one.',
    version: '3.0.0',
    requiresEndUser: true,
    input: z.object({
      cartId: z.string().optional()
        .describe("Omit to use the shopper's current cart"),
      addressId: z.string().optional()
        .describe('A saved address from addresses-list. Prefer this — ask the shopper which ' +
          'saved address to use rather than collecting one field by field. When set, every ' +
          'address field below is ignored.'),
      addressLine1: z.string().optional().describe('Flat, house number, building, street'),
      addressLine2: z.string().optional().describe('Area or landmark'),
      city: z.string().optional(),
      state: z.string().optional().describe('Indian state or union territory'),
      postcode: z.string().optional().describe('6-digit PIN code'),
      phone: z.string().optional().describe('10-digit Indian mobile, for delivery updates'),
      country: z.string().optional().describe('Defaults to India'),
      name: z.string().optional()
        .describe("Recipient name; defaults to the signed-in shopper's name"),
      email: z.string().optional()
        .describe("Where the receipt goes; defaults to the signed-in shopper's email"),
    }),
    output: orderShape.extend({
      nextStep: z.string().describe('What has to happen before the order is complete'),
      cheela: actionsShape,
    }),
  }),
  createAction({
    name: 'placeOrder',
    description: 'Convert a cart into an unpaid order owned by the signed-in shopper.',
    permissions: ['orders:write'],
    handler: (context, input) => {
      const shopper = requireShopper(context);
      const email = input.email ?? shopper.email;

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new Error('A valid email address is required to place the order.');
      }

      // A saved address is resolved from the shopper's own book, so an agent
      // handed someone else's id gets "not found" rather than their address.
      let address;
      let addressId: string | null = null;

      if (input.addressId) {
        const saved = repo.getAddress(input.addressId, shopper.id);
        if (!saved) {
          throw new Error(
            `No saved address "${input.addressId}" on this account. Call addresses-list for valid ids.`,
          );
        }
        address = saved;
        addressId = saved.id;
      } else {
        const missing = (['addressLine1', 'city', 'state', 'postcode'] as const)
          .filter((f) => !String(input[f] ?? '').trim());
        if (missing.length) {
          throw new Error(
            `Missing ${missing.join(', ')}. Either pass addressId from addresses-list, or supply ` +
            'the full address including state and a 6-digit PIN code.',
          );
        }
        if (!/^[1-9][0-9]{5}$/.test(String(input.postcode).trim())) {
          throw new Error('postcode must be a 6-digit Indian PIN code.');
        }
        address = {
          name: input.name ?? shopper.name,
          phone: input.phone ?? '',
          line1: input.addressLine1,
          line2: input.addressLine2 ?? '',
          city: input.city,
          state: input.state,
          postcode: input.postcode,
          country: input.country ?? 'India',
        };
      }

      const order = repo.createOrder({
        cartId: resolveCart(context, input.cartId),
        email,
        customer: input.name ?? address.name ?? shopper.name,
        // Ownership comes from the credential, never from the input — an agent
        // must not be able to file an order against somebody else's account.
        userId: shopper.id,
        address,
        addressId,
      });

      return {
        ...toOrder(order),
        cheela: cheelaActions({
          label: 'View order',
          url: `${SHOP_URL}/order/${order.number}`,
          style: 'secondary',
        }),
        nextStep:
          `Not paid yet. Call checkout-pay-order with orderNumber "${order.number}" to ` +
          (PAYMENTS_ARE_LIVE
            ? 'get a secure Razorpay payment link for the shopper to open.'
            : 'settle it with a payment method from store-list-payment-methods.'),
      };
    },
  }),
);

export const payOrder = defineCapability(
  createCapability({
    name: 'checkout-pay-order',
    description: PAYMENTS_ARE_LIVE
      ? 'Get a secure payment link for an order the shopper already placed. Requires a ' +
        'signed-in shopper, and only works on their own orders. Payment happens on ' +
        "Razorpay's own page — give the shopper the paymentUrl and ask them to open it. " +
        'You cannot complete the payment yourself, and you must never ask for card, UPI or ' +
        'bank details. Check back with orders-get-order to see whether it went through.'
      : 'Pay for an order the shopper already placed. Requires a signed-in shopper, and only ' +
        'works on their own orders. This is the final, irreversible step — confirm the total ' +
        'first. A declined card is a normal result, not an error: the reply says paid=false ' +
        'and explains why, and the shopper can retry with a different method.',
    version: '2.0.0',
    requiresEndUser: true,
    input: z.object({
      orderNumber: z.string().describe('The order number, e.g. "CHL-ESIRMIJV"'),
      paymentMethod: z.string().optional()
        .describe(PAYMENTS_ARE_LIVE
          ? 'Ignored — the shopper chooses how to pay on the Razorpay page.'
          : 'An opaque token from store-list-payment-methods, e.g. "pm_card_visa". ' +
            'Never a card number — do not ask the shopper for card details.'),
    }),
    output: orderShape.extend({
      declineReason: z.string().nullable()
        .describe('Why the payment failed, when paid is false'),
      paymentUrl: z.string().nullable()
        .describe('Give this to the shopper to open and pay. Null when payment is already settled.'),
      instruction: z.string().describe('What to tell the shopper next'),
      // Rendered by the chat panel as a real button, so the shopper gets a
      // reliable way to pay even if the model never repeats the URL.
      cheela: actionsShape,
    }),
  }),
  createAction({
    name: 'payOrder',
    description: 'Issue a payment link, or settle the order with the simulated processor.',
    permissions: ['orders:write'],
    handler: async (context, input) => {
      const shopper = requireShopper(context);
      const order = ownedOrder(input.orderNumber, shopper.id);

      /*
       * The agent cannot pay on the shopper's behalf.
       *
       * Razorpay Checkout is a browser modal, and paying requires a card, a UPI
       * PIN or a bank login — credentials that must never travel through a
       * language model. So the agent does the part it legitimately can: it
       * creates a hosted payment link on the real Razorpay account and hands
       * over the URL. The shopper authenticates with their bank, and the
       * webhook settles the order.
       */
      if (PAYMENTS_ARE_LIVE) {
        if (order.status === 'paid') {
          return {
            ...toOrder(order),
            declineReason: null,
            paymentUrl: null,
            instruction: `Order ${order.number} is already paid. Nothing further is needed.`,
            cheela: cheelaActions({
              label: 'View order',
              url: `${SHOP_URL}/order/${order.number}`,
              style: 'secondary',
            }),
          };
        }

        const link = await razorpay.createPaymentLink({
          amount: order.total,
          description: `Cheela order ${order.number}`,
          reference: order.number,
          customer: { name: order.customer, email: order.email, phone: order.address?.phone },
          callbackUrl: `${SHOP_URL}/order/${order.number}`,
        });

        repo.attachPaymentLink(order.id, { id: link.id, url: link.short_url });

        return {
          ...toOrder(order),
          declineReason: null,
          paymentUrl: link.short_url,
          instruction:
            `Tell the shopper their payment button is ready below — ${money(order.total)}, ` +
            'payable by UPI, card, netbanking or wallet. You do not need to repeat the URL; ' +
            'it is rendered for them. Once they confirm they have paid, call orders-get-order ' +
            `with "${order.number}" to check it settled.`,
          cheela: cheelaActions({
            label: `Pay ${money(order.total)}`,
            url: link.short_url,
            description: `Order ${order.number} · UPI, card, netbanking or wallet`,
            style: 'primary',
          }),
        };
      }

      const result = repo.payOrder(order.id, input.paymentMethod ?? 'pm_card_visa');
      return {
        ...toOrder(result.order),
        declineReason: result.ok ? null : result.error?.message ?? 'Payment failed',
        paymentUrl: null,
        instruction: result.ok
          ? `Payment captured. Order ${result.order.number} is confirmed.`
          : 'The payment was declined. Offer to retry with a different method.',
        cheela: result.ok
          ? cheelaActions({
            label: 'View order',
            url: `${SHOP_URL}/order/${result.order.number}`,
            style: 'secondary',
          })
          : undefined,
      };
    },
  }),
);

export const getOrder = defineCapability(
  createCapability({
    name: 'orders-get-order',
    description:
      "Look up one of the shopper's own orders by number, including its payment status. " +
      'Requires a signed-in shopper.',
    version: '2.0.0',
    requiresEndUser: true,
    input: z.object({ orderNumber: z.string() }),
    output: orderShape,
  }),
  createAction({
    name: 'getOrder',
    description: 'Fetch one order belonging to the signed-in shopper.',
    handler: (context, input) => {
      const shopper = requireShopper(context);
      return toOrder(ownedOrder(input.orderNumber, shopper.id));
    },
  }),
);

export const listOrders = defineCapability(
  createCapability({
    name: 'orders-list',
    description:
      "List the signed-in shopper's order history, newest first. Use this for \"where is my order\", " +
      '"what did I buy" or "did that payment go through".',
    version: '1.0.0',
    requiresEndUser: true,
    input: z.object({
      limit: z.number().int().min(1).max(20).optional().describe('Defaults to 10'),
    }),
    output: z.object({
      orders: z.array(orderShape),
      total: z.number().int(),
    }),
  }),
  createAction({
    name: 'listOrders',
    description: 'Order history for the signed-in shopper.',
    handler: (context, input) => {
      const shopper = requireShopper(context);
      const all = repo.listOrdersForUser(shopper.id);
      return {
        orders: all.slice(0, input.limit ?? 10).map(toOrder),
        total: all.length,
      };
    },
  }),
);

/* ------------------------------ store info ------------------------------- */

export const getPaymentMethods = defineCapability(
  createCapability({
    name: 'store-list-payment-methods',
    description:
      'List the payment method tokens checkout-pay-order accepts. Call this before paying so you ' +
      'pass a valid token. This is a demo store: these are simulated methods, no real card is ' +
      'ever charged, and you must never ask the shopper for real card details.',
    version: '1.0.0',
    input: z.object({}),
    output: z.object({
      methods: z.array(z.object({
        token: z.string(),
        brand: z.string(),
        last4: z.string(),
        outcome: z.string().describe('succeed | fail'),
        description: z.string(),
      })),
      note: z.string(),
    }),
  }),
  createAction({
    name: 'getPaymentMethods',
    description: 'Enumerate the mock payment methods.',
    handler: () => ({
      methods: listPaymentMethods(),
      note: 'Simulated payment methods for a demo storefront. No real card is charged.',
    }),
  }),
);

export const getStorePolicies = defineCapability(
  createCapability({
    name: 'store-get-policies',
    description:
      'Shipping, tax, returns and guarantee terms. Use this to answer "how much is shipping", ' +
      '"when will it arrive" or "can I return it" rather than guessing.',
    version: '1.1.0',
    input: z.object({}),
    output: z.object({
      freeShippingThreshold: z.string(),
      flatShipping: z.string(),
      taxRate: z.string(),
      delivery: z.string(),
      returns: z.string(),
      guarantee: z.string(),
      payment: z.string(),
    }),
  }),
  createAction({
    name: 'getStorePolicies',
    description: 'Return the store policies.',
    handler: () => {
      // Derived from the cart engine so the numbers cannot drift out of sync.
      const empty = repo.totals([]);
      const belowThreshold = repo.totals([{ qty: 1, lineTotal: 100 }]);
      return {
        freeShippingThreshold: money(empty.freeShippingThreshold),
        flatShipping: money(belowThreshold.shipping),
        taxRate: 'GST 18%',
        delivery: 'Two to four working days, tracked. Delivered across India.',
        returns: '30 days, unused and in original packaging.',
        guarantee: 'Two years against manufacturing defects.',
        payment: PAYMENTS_ARE_LIVE
          ? 'Card, UPI, netbanking and wallets via Razorpay. This is a test storefront: use Razorpay test credentials, no real money moves.'
          : 'This is a demo storefront — payments are simulated and nothing is charged.',
      };
    },
  }),
);

export const allCapabilities: readonly CapabilityRegistration[] = [
  searchProducts,
  getProduct,
  listCategories,
  viewCart,
  addToCart,
  updateCartItem,
  removeCartItem,
  clearCart,
  placeOrder,
  payOrder,
  getOrder,
  listOrders,
  listAddresses,
  getPaymentMethods,
  getStorePolicies,
];
