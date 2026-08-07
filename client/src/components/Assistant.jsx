/**
 * Shopping assistant — the in-store surface for the Cheela capabilities.
 *
 * The runtime (server/.cheela) is what actually browses the catalogue, edits
 * the cart, places orders and takes payment; this is just the panel a shopper
 * talks to.
 *
 * It renders only when VITE_CHEELA_PUBLIC_KEY is set, so the storefront runs
 * exactly as before when Cheela is not configured. The key here is the runtime's
 * **public** key (`ch_pk_…`), which is meant to be embedded — never the deploy
 * key (`ch_sk_…`), which must stay on the server.
 */

import { useCallback, useEffect, useState } from 'react';
import { Chat, CheelaProvider } from '@cheela/ui';
import '@cheela/ui/style.css';

import { getToken } from '../api';
import { useShop } from '../store';
import { Bag } from './Icons';

const PUBLIC_KEY = import.meta.env.VITE_CHEELA_PUBLIC_KEY;

/**
 * Workaround for an upstream bug in @cheela/client.
 *
 * Still required on @cheela/client@0.5.0, which @cheela/ui@0.3.0 pins. Checked
 * again at that version — the constructor below is unchanged since 0.2.0, and
 * `CheelaProviderProps` still exposes no `fetchImpl`, so there is still nowhere
 * to inject a bound copy. Re-check on the next @cheela/ui release.
 *
 * Its ExecutionClient stores the global fetch on the instance
 * (`this.fetchImpl = options.fetchImpl ?? fetch`) and later calls
 * `this.fetchImpl(url, init)`. Invoking it as a method rebinds `this` to the
 * client instead of `window`, and browsers reject that outright:
 *
 *   TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation
 *
 * The client catches everything around that call and rethrows it as
 * `CheelaNetworkError: Could not reach the Cheela API`, which sends you looking
 * at DNS and CORS when the network was never the problem — every chat message
 * fails, in every browser, regardless of configuration.
 *
 * `CheelaProvider` exposes no `fetchImpl` prop, so there is nowhere to inject a
 * bound copy. Binding the global is the smallest fix available and is
 * semantically inert: `fetch` is specified to work with any receiver, so
 * pre-binding it changes nothing for other callers. Remove once upstream binds
 * its own reference.
 */
if (typeof window !== 'undefined' && typeof window.fetch === 'function' && !window.fetch.__cheelaBound) {
  const native = window.fetch.bind(window);

  /**
   * The same wrapper also rescues a second silent failure.
   *
   * When the model picks a capability but the platform cannot invoke it — the
   * runtime has no HTTPS endpoint, say — the response is **HTTP 200** carrying
   * `{ status: "failed", error }`. Nothing throws, the reply has no assistant
   * text, and the shopper is left staring at their own message with no
   * indication anything went wrong.
   *
   * Turning that into a rejection routes it through the client's existing error
   * path, so `onError` fires and the panel can explain it.
   */
  const wrapped = async (input, init) => {
    const response = await native(input, init);

    const url = typeof input === 'string' ? input : input?.url ?? '';
    if (!url.includes('/v1/runtime/execute') || !response.ok) return response;

    // Never touch a streaming response. `.json()` on an SSE body does not
    // reject until the stream *ends*, so awaiting it here would hold the
    // response back until the reply was complete — which is precisely the
    // token-by-token rendering this wrapper would then be defeating. The
    // check below only applies to the non-streaming JSON shape anyway.
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      return response;
    }

    // Read from a clone so the client still gets an unconsumed body.
    try {
      const result = await response.clone().json();
      if (result?.status === 'failed' && result?.error) {
        throw new Error(result.error);
      }
    } catch (err) {
      if (err instanceof SyntaxError) return response; // not JSON — leave it alone
      throw err;
    }
    return response;
  };

  wrapped.__cheelaBound = true;
  window.fetch = wrapped;
}

/**
 * Turns a CheelaClientError into something a shopper can act on.
 *
 * The library's own wording is aimed at whoever wired the integration up
 * ("Could not reach the Cheela API. Check the network connection and baseUrl.")
 * which is the wrong audience for a chat panel, and — for the failure this
 * project actually hit — the wrong diagnosis: the API was reachable, the
 * runtime just had no HTTPS endpoint for Cheela to call back on.
 */
function explain(error) {
  // The client wraps anything thrown during the request as CheelaNetworkError
  // and keeps the original as `cause`, so the real reason is usually one level
  // down — including the platform errors surfaced by the fetch wrapper above.
  const raw = [error?.message, error?.cause?.message].filter(Boolean).join(' | ');

  if (/no HTTPS endpoint/i.test(raw)) {
    return {
      shopper: 'The assistant is not connected to the store right now.',
      developer:
        'The runtime has no HTTPS endpoint. Cheela calls in, so localhost is unreachable: ' +
        'start a tunnel to :4000, set CHEELA_ENDPOINT to https://…/cheela/execute, and redeploy.',
    };
  }
  if (/Invalid or missing runtime API key/i.test(raw)) {
    return {
      shopper: 'The assistant is not configured correctly.',
      developer: 'VITE_CHEELA_PUBLIC_KEY is missing or is not a valid ch_pk_ key.',
    };
  }
  if (/Could not reach/i.test(raw)) {
    return {
      shopper: 'The assistant is unreachable at the moment.',
      developer: 'The browser could not reach api.cheelalabs.com — network, DNS or a blocked request.',
    };
  }
  return { shopper: 'The assistant hit a problem. Try again in a moment.', developer: raw };
}

export default function Assistant() {
  const { user, refreshCart } = useShop();
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState(null);

  // A function, not a value: the shopper can sign in long after the widget
  // mounted, and a token read once would pin whatever was true then. Returning
  // null while signed out is correct — the order capabilities are declared
  // `requiresEndUser`, so the runtime refuses them rather than acting as nobody.
  const endUserToken = useCallback(() => getToken() ?? null, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!PUBLIC_KEY) return null;

  return (
    <CheelaProvider apiKey={PUBLIC_KEY} theme="light" endUserToken={endUserToken}>
      <button
        type="button"
        className="assistant-launcher"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="assistant-panel"
      >
        <Bag width={18} height={18} />
        {open ? 'Close' : 'Ask about anything'}
      </button>

      {open && (
        <section id="assistant-panel" className="assistant-panel" aria-label="Shopping assistant">
          <header>
            <strong>Shopping assistant</strong>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close assistant">×</button>
          </header>

          {problem && (
            <p className="assistant-error" role="status">
              {problem.shopper}
              {problem.developer && <span className="assistant-error-detail">{problem.developer}</span>}
            </p>
          )}

          {!user && !problem && (
            <p className="assistant-note">
              Browsing and cart work as a guest. Sign in to place, pay for or look up orders.
            </p>
          )}

          <div className="assistant-body">
            <Chat
              placeholder="Find me wireless headphones under ₹20,000…"
              // The assistant edits the cart through a completely different
              // path, so the bag in the header has no idea anything changed.
              // Re-read it after every turn — cheap, and the alternative is a
              // shopper being told an item was added while the count stays 0.
              onMessage={() => { refreshCart(); }}
              onError={(error) => {
                setProblem(explain(error));
                // Keep the library's own message in the console: the panel shows
                // the shopper-facing version, but whoever is debugging wants the
                // original and its cause chain.
                console.error('[cheela] assistant call failed', error);
              }}
            />
          </div>
        </section>
      )}
    </CheelaProvider>
  );
}
