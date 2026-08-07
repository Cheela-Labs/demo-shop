import { Runtime } from '@cheela/runtime';

import { allCapabilities } from './capabilities.ts';

/**
 * The storefront runtime.
 *
 * `cheela deploy` discovers capabilities through `runtime.getRegistrations()`,
 * so registering here is the only place a capability becomes real — there is
 * no separate manifest to keep in step.
 *
 * Permissions are granted at construction and required per action, keeping the
 * mutating operations (cart writes, order placement, payment) explicitly gated.
 * Shopper identity is a separate axis: see `requiresEndUser` on the order
 * capabilities.
 */
const runtime = new Runtime({
  permissions: ['cart:write', 'orders:write'],
});

for (const capability of allCapabilities) {
  capability.register(runtime);
}

export default runtime;
