import { defineConfig } from "@cheela/cli";

/**
 * Provider and model are not set here — they live on the runtime's Provider &
 * endpoint card in the Cheela dashboard.
 */
export default defineConfig({
  apiKey: process.env.CHEELA_API_KEY!,

  // Public HTTPS endpoint where this runtime serves capability calls.
  //
  // This is the setting whose absence produces "Runtime … has no HTTPS endpoint
  // configured" — the model picks a capability, then Cheela has nowhere to call
  // back to. Cheela calls *in*, so localhost is not reachable on its own: expose
  // http://localhost:4000/cheela/execute through a tunnel and set
  // CHEELA_ENDPOINT to that URL.
  //
  // Only sent when actually set, so a deploy never overwrites a working
  // dashboard value with a placeholder.
  ...(process.env.CHEELA_ENDPOINT ? { endpoint: process.env.CHEELA_ENDPOINT } : {}),

  // Required by the adp generator (Agent Discovery Specification output).
  // The namespace supplies the dots ADS wants; capability names themselves are
  // hyphen-only, giving published names like "com.example.cheelashop.cart-view".
  website: {
    name: "Cheela Shop",
    description:
      "A small storefront selling well-made everyday goods — audio, bags, footwear, home and tech.",
    url: process.env.STOREFRONT_URL ?? "http://localhost:5173",
  },
  adp: {
    // Reverse-DNS of the storefront's own hostname, demo-shop.cheelalabs.com.
    //
    // This is baked into every published capability name
    // ("com.cheelalabs.demo-shop.cart-view"), so it is effectively permanent:
    // changing it after an agent has discovered the store renames every
    // capability that agent knows about.
    namespace: "com.cheelalabs.demo-shop",
  },
});
