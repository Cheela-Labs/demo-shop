const BASE = 'http://localhost:4000';
const TOKEN = 'demo-session-token-do-not-use-in-production';

let pass = 0, fail = 0;
const check = (l, ok, d = '') => { ok ? (pass++, console.log(`  ok   ${l}`)) : (fail++, console.log(`  FAIL ${l}${d ? ' — ' + d : ''}`)); };

const call = async (path, opts = {}) => {
  const r = await fetch(`${BASE}/api${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...(opts.headers || {}) },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

console.log('\nsaved addresses\n');

const seeded = await call('/addresses');
check('demo account has a seeded address', seeded.body?.items?.length >= 1);
check('it is the default', seeded.body?.items?.[0]?.isDefault === true);
check('Indian shape (state + 6-digit PIN)',
  /^[1-9]\d{5}$/.test(seeded.body?.items?.[0]?.postcode || '') && Boolean(seeded.body?.items?.[0]?.state),
  JSON.stringify(seeded.body?.items?.[0]));

const created = await call('/addresses', { method: 'POST', body: {
  label: 'Office', name: 'Demo Shopper', phone: '9876501234',
  line1: '5th Floor, Prestige Tower', city: 'Bengaluru', state: 'Karnataka', postcode: '560001',
} });
check('a second address can be added', created.status === 201, JSON.stringify(created.body));
const officeId = created.body?.address?.id;
check('the new one does not steal default', created.body?.address?.isDefault === false);

const badPin = await call('/addresses', { method: 'POST', body: {
  name: 'X', line1: 'Y', city: 'Z', state: 'S', postcode: '12345',
} });
check('a 5-digit PIN is rejected', badPin.status === 400, JSON.stringify(badPin.body));

const badPhone = await call('/addresses', { method: 'POST', body: {
  name: 'X', line1: 'Y', city: 'Z', state: 'S', postcode: '560001', phone: '12345',
} });
check('a non-Indian mobile is rejected', badPhone.status === 400, JSON.stringify(badPhone.body));

const promoted = await call(`/addresses/${officeId}/default`, { method: 'POST' });
check('default can be moved', promoted.body?.address?.isDefault === true);
const after = await call('/addresses');
check('exactly one default at a time', after.body.items.filter((a) => a.isDefault).length === 1);
check('the default sorts first', after.body.items[0].id === officeId);

// place an order against a saved address
const cart = await (await fetch(`${BASE}/api/cart`, { method: 'POST' })).json();
const cartId = cart.cart.id;
const products = await (await fetch(`${BASE}/api/products?limit=1&inStock=true`)).json();
await call(`/cart/${cartId}/items`, { method: 'POST', body: { productId: products.items[0].id, qty: 1 } });

const order = await call('/orders', { method: 'POST', body: { cartId, addressId: officeId } });
check('order ships to the saved address', order.status === 201, JSON.stringify(order.body).slice(0, 200));
check('address was copied onto the order', order.body?.order?.address?.city === 'Bengaluru',
  JSON.stringify(order.body?.order?.address));

// deleting an address must not rewrite an order already shipped to it
await call(`/addresses/${officeId}`, { method: 'DELETE' });
const reread = await call(`/orders/${order.body.order.id}`);
check('deleting the address leaves the order intact',
  reread.body?.order?.address?.city === 'Bengaluru', JSON.stringify(reread.body?.order?.address));
const afterDelete = await call('/addresses');
check('deleting the default promotes another',
  afterDelete.body.items.filter((a) => a.isDefault).length === 1);

// another account must not see or use these
const other = await (await fetch(`${BASE}/api/auth/register`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: `a${Date.now()}@example.com`, name: 'Other', password: 'other-password-1234' }),
})).json();
const theirs = await fetch(`${BASE}/api/addresses`, { headers: { Authorization: `Bearer ${other.token}` } });
const theirsBody = await theirs.json();
check('a new account sees an empty address book', theirsBody.items.length === 0);

const stolen = await fetch(`${BASE}/api/orders`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${other.token}` },
  body: JSON.stringify({ cartId, addressId: seeded.body.items[0].id }),
});
check("another account cannot ship to someone else's saved address", stolen.status === 404, `HTTP ${stolen.status}`);

const anon = await fetch(`${BASE}/api/addresses`);
check('addresses require a signed-in shopper', anon.status === 401, `HTTP ${anon.status}`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
