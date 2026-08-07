/**
 * Loads Razorpay Checkout and opens it.
 *
 * The script is fetched on demand rather than from a <script> tag in
 * index.html: it is only needed by shoppers who reach the payment step, and a
 * shop configured without Razorpay should not be pulling a third-party script
 * into every page load.
 */

const SDK_URL = 'https://checkout.razorpay.com/v1/checkout.js';

let loader = null;

/** Loads checkout.js once; concurrent callers share the same promise. */
export function loadRazorpay() {
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  if (loader) return loader;

  loader = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.onload = () => {
      if (window.Razorpay) resolve(window.Razorpay);
      else reject(new Error('Razorpay checkout loaded but did not register.'));
    };
    script.onerror = () => {
      // Reset so a shopper who fixes their connection can retry rather than
      // being stuck with a permanently rejected promise.
      loader = null;
      reject(new Error('Could not load Razorpay Checkout. Check your connection and any blockers.'));
    };
    document.head.appendChild(script);
  });

  return loader;
}

/**
 * Opens the Razorpay modal and resolves with what it hands back.
 *
 * Resolves `{ dismissed: true }` when the shopper closes the modal, because
 * that is a normal thing to do and not an error — the order simply stays
 * unpaid and they can try again.
 *
 * The values in a success resolution are *unverified*. They come from the
 * browser and mean nothing until the server checks the signature.
 */
export function openCheckout({ keyId, razorpayOrderId, amount, currency, orderNumber, customer, onFailed }) {
  return loadRazorpay().then(
    (Razorpay) =>
      new Promise((resolve, reject) => {
        let settled = false;

        const checkout = new Razorpay({
          key: keyId,
          amount,
          currency,
          order_id: razorpayOrderId,
          name: 'Cheela',
          description: `Order ${orderNumber}`,
          image: '/logo.svg',
          prefill: {
            name: customer?.name || '',
            email: customer?.email || '',
            contact: customer?.phone || '',
          },
          notes: { orderNumber },
          theme: { color: '#111827' },
          handler: (response) => {
            settled = true;
            resolve({
              dismissed: false,
              razorpayOrderId: response.razorpay_order_id,
              razorpayPaymentId: response.razorpay_payment_id,
              razorpaySignature: response.razorpay_signature,
            });
          },
          modal: {
            ondismiss: () => {
              if (!settled) resolve({ dismissed: true });
            },
          },
        });

        // Razorpay reports a failed attempt here rather than through `handler`.
        // The modal stays open so the shopper can pick another method, so this
        // reports upward without settling the promise.
        checkout.on('payment.failed', (event) => {
          onFailed?.(
            event?.error?.description || 'That payment attempt failed. Try another method.',
          );
        });

        try {
          checkout.open();
        } catch (err) {
          reject(err);
        }
      }),
  );
}
