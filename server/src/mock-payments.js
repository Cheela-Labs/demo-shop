/**
 * Mock payment processor.
 *
 * No network, no real processor, no real card. The outcome is decided entirely
 * by the payment-method token, which makes every path — success, decline,
 * insufficient funds, expiry — reproducible in a test rather than something you
 * can only hit by accident against a sandbox.
 *
 * Two deliberate choices worth knowing:
 *
 *   1. Callers pass an opaque token (`pm_card_visa`), never a card number. This
 *      mirrors how real integrations work — the PAN goes from the browser to
 *      the processor and never touches your server — and it matters even more
 *      for the agent path, where a raw card number would otherwise pass through
 *      a language model.
 *
 *   2. The card form in the UI maps well-known test numbers onto these same
 *      tokens client-side, so the browser flow and the agent flow exercise one
 *      code path rather than two.
 */

/** The tokens a caller (or an agent) may present. */
export const PAYMENT_METHODS = {
  pm_card_visa: {
    outcome: 'succeed', brand: 'Visa', last4: '4242',
    description: 'Always succeeds',
  },
  pm_card_mastercard: {
    outcome: 'succeed', brand: 'Mastercard', last4: '4444',
    description: 'Always succeeds',
  },
  pm_card_declined: {
    outcome: 'fail', brand: 'Visa', last4: '0002',
    code: 'card_declined',
    message: 'The card was declined.',
    description: 'Always declined by the issuer',
  },
  pm_card_insufficient_funds: {
    outcome: 'fail', brand: 'Visa', last4: '9995',
    code: 'insufficient_funds',
    message: 'The card has insufficient funds.',
    description: 'Declined for insufficient funds',
  },
  pm_card_expired: {
    outcome: 'fail', brand: 'Visa', last4: '0069',
    code: 'expired_card',
    message: 'The card has expired.',
    description: 'Declined as expired',
  },
};

/** Test card numbers the demo checkout form accepts, mapped to the tokens above. */
export const TEST_CARDS = {
  '4242424242424242': 'pm_card_visa',
  '5555555555554444': 'pm_card_mastercard',
  '4000000000000002': 'pm_card_declined',
  '4000000000009995': 'pm_card_insufficient_funds',
  '4000000000000069': 'pm_card_expired',
};

export function listPaymentMethods() {
  return Object.entries(PAYMENT_METHODS).map(([token, m]) => ({
    token,
    brand: m.brand,
    last4: m.last4,
    outcome: m.outcome,
    description: m.description,
  }));
}

/** Resolves a raw test card number to a token, for the browser form only. */
export function tokenForCardNumber(number) {
  return TEST_CARDS[String(number || '').replace(/\D/g, '')] || null;
}

/**
 * "Charges" a payment method.
 *
 * @param {string} token   one of PAYMENT_METHODS
 * @param {number} amount  in cents, for the record only — the mock never
 *                         declines on amount, so tests stay deterministic
 */
export function charge(token, amount) {
  const method = PAYMENT_METHODS[token];

  if (!method) {
    return {
      ok: false,
      brand: null,
      last4: null,
      code: 'invalid_payment_method',
      message:
        `Unknown payment method "${token}". Valid tokens: ${Object.keys(PAYMENT_METHODS).join(', ')}.`,
    };
  }

  if (method.outcome === 'fail') {
    return {
      ok: false,
      brand: method.brand,
      last4: method.last4,
      code: method.code,
      message: method.message,
    };
  }

  return { ok: true, brand: method.brand, last4: method.last4, amount };
}
