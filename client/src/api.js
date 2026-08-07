/** Thin fetch wrapper around the Express API. */

const BASE = '/api';

let authToken = localStorage.getItem('cheela.token') || null;

export function setToken(token) {
  authToken = token;
  if (token) localStorage.setItem('cheela.token', token);
  else localStorage.removeItem('cheela.token');
}

export function getToken() {
  return authToken;
}

async function request(path, { method = 'GET', body, signal, allowStatuses = [] } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const res = await fetch(BASE + path, {
    method,
    headers,
    signal,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};

  if (!res.ok && !allowStatuses.includes(res.status)) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  health: () => request('/health'),

  products: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== '' && v != null && v !== 'All'),
    );
    return request(`/products?${qs}`);
  },
  product: (id) => request(`/products/${encodeURIComponent(id)}`),
  categories: () => request('/categories'),

  createCart: () => request('/cart', { method: 'POST' }),
  cart: (id) => request(`/cart/${id}`),
  claimCart: (id) => request(`/cart/${id}/claim`, { method: 'POST' }),
  addItem: (cartId, productId, qty = 1) =>
    request(`/cart/${cartId}/items`, { method: 'POST', body: { productId, qty } }),
  updateItem: (cartId, itemId, qty) =>
    request(`/cart/${cartId}/items/${itemId}`, { method: 'PATCH', body: { qty } }),
  removeItem: (cartId, itemId) =>
    request(`/cart/${cartId}/items/${itemId}`, { method: 'DELETE' }),

  checkout: (payload) => request('/orders', { method: 'POST', body: payload }),
  order: (id) => request(`/orders/${id}`),
  paymentMethods: () => request('/payment-methods'),
  // A decline comes back as 402 with the order attached, so it is a resolved
  // result rather than a thrown error the caller has to unpick.
  pay: (orderNumber, payload) =>
    request(`/orders/${orderNumber}/pay`, { method: 'POST', body: payload, allowStatuses: [402] }),
  myOrders: () => request('/orders'),

  // Razorpay. `paymentIntent` creates the Razorpay order the modal is opened
  // against; `verifyPayment` hands back what the modal returned so the server
  // can check the signature — the client is never the one deciding a payment
  // succeeded.
  paymentIntent: (orderNumber) =>
    request(`/orders/${orderNumber}/payment-intent`, { method: 'POST' }),
  verifyPayment: (orderNumber, payload) =>
    request(`/orders/${orderNumber}/payment/verify`, {
      method: 'POST', body: payload, allowStatuses: [402],
    }),
  // Sandbox: the server stands in for the Razorpay modal. A declined payment
  // is a 402 with the order attached, same as every other decline here.
  simulatePayment: (orderNumber, payload) =>
    request(`/orders/${orderNumber}/payment/simulate`, {
      method: 'POST', body: payload, allowStatuses: [402],
    }),

  addresses: () => request('/addresses'),
  addAddress: (payload) => request('/addresses', { method: 'POST', body: payload }),
  updateAddress: (id, payload) => request(`/addresses/${id}`, { method: 'PATCH', body: payload }),
  deleteAddress: (id) => request(`/addresses/${id}`, { method: 'DELETE' }),
  makeDefaultAddress: (id) => request(`/addresses/${id}/default`, { method: 'POST' }),

  register: (payload) => request('/auth/register', { method: 'POST', body: payload }),
  login: (payload) => request('/auth/login', { method: 'POST', body: payload }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  me: () => request('/auth/me'),
};

/**
 * Paise -> display string. Prices are integers everywhere on the wire.
 *
 * `en-IN` gives the Indian digit grouping (₹1,49,999 rather than ₹149,999),
 * which is what a shopper here expects to see. Fractions are dropped because
 * every price in the catalogue is a whole rupee.
 */
export function money(paise) {
  return (paise / 100).toLocaleString('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}
