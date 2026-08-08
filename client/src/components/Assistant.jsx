/**
 * Shopping assistant — the in-store surface for the Cheela capabilities.
 *
 * The runtime (server/.cheela) is what actually browses the catalogue, edits
 * the cart, places orders and takes payment; this is just the panel a shopper
 * talks to.
 *
 * The panel itself is ours. `@cheela/web-component` ships a drop-in
 * `<cheela-chat>` custom element, but it renders into a shadow root with its
 * own styling, which is the one thing a storefront with an existing design
 * cannot use. So this imports the half of that package that has no opinion
 * about looks — `getSession`, the conversation controller — and draws the
 * transcript, composer and status with the shop's own markup and CSS.
 *
 * What stays borrowed is the part where a mistake is a security bug rather
 * than a cosmetic one: `renderMarkdown` and `renderActions` (see `Bubble`).
 *
 * It renders only when VITE_CHEELA_PUBLIC_KEY is set, so the storefront runs
 * exactly as before when Cheela is not configured. The key here is the runtime's
 * **public** key (`ch_pk_…`), which is meant to be embedded — never the deploy
 * key (`ch_sk_…`), which must stay on the server.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  DEFAULT_SESSION,
  DEFAULT_WAITING_LABEL,
  getSession,
  renderActions,
  renderMarkdown,
} from '@cheela/web-component/headless';

import { getToken } from '../api';
import { useShop } from '../store';
import { Bag } from './Icons';

const PUBLIC_KEY = import.meta.env.VITE_CHEELA_PUBLIC_KEY;

/** How close to the bottom still counts as "following along". */
const PINNED_PX = 32;

/**
 * Workaround for an upstream bug in @cheela/client.
 *
 * Still required on @cheela/client@0.5.0, which @cheela/web-component@0.3.0
 * pins *exactly* — so dropping @cheela/ui did not drop the bug with it.
 * Re-checked at that version: `createChatController` builds the client itself
 * with `new ExecutionClient({ apiKey, baseUrl, endUserToken })`, and
 * `ControllerConfig` has no `fetchImpl` among its fields, so there is still
 * nowhere to inject a bound copy. Re-check on the next release.
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
 * Binding the global is the smallest fix available and is semantically inert:
 * `fetch` is specified to work with any receiver, so pre-binding it changes
 * nothing for other callers. Remove once upstream binds its own reference.
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
   * path, so the panel can explain it.
   */
  const wrapped = async (input, init) => {
    const response = await native(input, init);

    const url = typeof input === 'string' ? input : input?.url ?? '';
    if (!url.includes('/v1/runtime/execute') || !response.ok) return response;

    // Never touch a streaming response. `.json()` on an SSE body does not
    // reject until the stream *ends*, so awaiting it here would hold the
    // response back until the reply was complete — which is precisely the
    // token-by-token rendering this wrapper would then be defeating. The
    // check below only applies to the non-streaming JSON shape anyway; the
    // streaming path is covered instead by the stall guard in `useAssistant`.
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

/** The text parts of a message, joined — the same rule the package's renderers use. */
function textOf(message) {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.content)
    .join('\n');
}

/**
 * One message in the transcript.
 *
 * The bubble is ours; its contents are built by `@cheela/web-component` and
 * adopted into it. That split is deliberate. Everything inside a bubble is
 * written by a model, steered by tool results this shop does not fully control,
 * and rendered on a page that also holds a signed-in session — so the two
 * functions that decide what is allowed through are the two worth taking from a
 * package that is tested on them rather than re-deriving here:
 *
 *   - `renderMarkdown` walks the parsed tree building DOM nodes, so no markup
 *     string is ever assembled and there is no sanitiser to keep ahead of.
 *   - `renderActions` drops any action URL that is not `https:`, which is what
 *     stops `javascript:` in a capability's output becoming stored XSS on this
 *     domain, against this shop's own customers.
 *
 * Both hand back detached DOM, so the nodes are attached in an effect. They are
 * rebuilt on every run rather than memoised: a DocumentFragment is emptied by
 * the insertion, so a re-run holding the previous one would blank the message —
 * which is exactly what StrictMode's second pass would do.
 */
function Bubble({ message }) {
  const host = useRef(null);

  useEffect(() => {
    const node = host.current;
    if (!node) return;

    const content = [];
    const text = textOf(message);
    if (text) content.push(renderMarkdown(text));
    const actions = renderActions(message);
    if (actions) content.push(actions);

    node.replaceChildren(...content);
    // A turn carries messages a shopper has no business seeing — the model's
    // bare tool_call, or a tool_result with no actions in it. They belong in
    // the transcript but have nothing to draw, so the bubble takes itself out
    // rather than leaving an empty box in the log.
    node.hidden = content.length === 0;
  }, [message]);

  return <div className={`chat-msg chat-msg--${message.role}`} ref={host} />;
}

/**
 * Everything that is not markup: the conversation, the cart refresh, and the
 * two ways a turn can go wrong.
 */
function useAssistant() {
  const { refreshCart } = useShop();
  const [stalled, setStalled] = useState(false);

  // A function, not a value: the shopper can sign in long after the widget
  // mounted, and a token read once would pin whatever was true then. Returning
  // undefined while signed out is correct — the order capabilities are declared
  // `requiresEndUser`, so the runtime refuses them rather than acting as nobody.
  const endUserToken = useCallback(() => getToken() ?? undefined, []);

  // One conversation for the life of the tab.
  //
  // `getSession` keys the controller by name at module scope, so the transcript
  // outlives this component — including StrictMode's deliberate
  // mount/unmount/remount in development, which a controller owned by the
  // component would lose. Nothing calls `destroySession`: the panel is a
  // fixture of the layout, and `destroy()` detaches the controller from its
  // store for good, so a remount would find a session that never updates again.
  const [chat] = useState(() =>
    getSession(DEFAULT_SESSION, {
      apiKey: PUBLIC_KEY,
      baseUrl: null,
      theme: 'light',
      // Read only by the composer this package would have drawn for us. Ours
      // has its own, below.
      placeholder: null,
      endUserToken,
    }),
  );

  // `getState` returns the stored object rather than a fresh one, so React can
  // compare snapshots by identity and this stays a normal external store.
  const state = useSyncExternalStore(chat.subscribe, chat.getState, chat.getState);

  const previousStatus = useRef(state.status);
  useEffect(() => {
    const before = previousStatus.current;
    previousStatus.current = state.status;

    // Only act on the edge where a turn finishes. Since protocol 0.4 that edge
    // can land on `waiting` rather than `idle` — a turn that ended by handing
    // the panel something to poll. Refreshing the bag there is right (the
    // capability that produced the pending spec may well have changed the
    // cart), and the stall check below is guarded on `idle`, so a wait is
    // never mistaken for a turn that failed to reply.
    if (before !== 'submitting' || state.status === 'submitting') return;

    // The assistant edits the cart through a completely different path, so the
    // bag in the header has no idea anything changed. Re-read it after every
    // turn — cheap, and the alternative is a shopper being told an item was
    // added while the count stays 0.
    refreshCart();

    // The failure that reports success.
    //
    // A streamed execution ends with a `done` event whether it worked or not,
    // and `ConversationStore` takes the transcript from it without looking at
    // `result.status`. So a platform-side failure — no HTTPS endpoint, a
    // timeout calling back into the runtime — lands here as a perfectly normal
    // idle turn that simply has no reply in it. Nothing throws, `state.error`
    // stays empty, and without this the shopper just watches their own message
    // sit there. A settled turn whose last word is still the shopper's is that
    // case, and nothing else: a real reply always ends on an assistant message.
    setStalled(state.status === 'idle' && state.messages.at(-1)?.role !== 'assistant');
  }, [state, refreshCart]);

  const logged = useRef(undefined);
  useEffect(() => {
    if (!state.error || state.error === logged.current) return;
    logged.current = state.error;
    // Keep the library's own message in the console: the panel shows the
    // shopper-facing version, but whoever is debugging wants the original and
    // its cause chain.
    console.error('[cheela] assistant call failed', state.error);
  }, [state.error]);

  const problem = useMemo(() => {
    if (state.error) return explain(state.error);
    if (stalled) {
      return {
        shopper: 'The assistant could not finish that. Try again in a moment.',
        developer:
          'The execution completed with no assistant turn — the platform accepted the message ' +
          'but got nothing usable back from the runtime. Check the execution trace in the dashboard.',
      };
    }
    return null;
  }, [state.error, stalled]);

  const send = useCallback(
    (text) => {
      setStalled(false);
      chat.sendMessage(text);
    },
    [chat],
  );

  const clear = useCallback(() => {
    setStalled(false);
    chat.reset();
  }, [chat]);

  return {
    messages: state.messages,
    busy: state.status === 'submitting',
    // The turn is over and the panel is now watching a capability on its own —
    // for this shop, an order waiting to be paid on Razorpay's page. Sends stay
    // allowed while this is true, which is why it is separate from `busy`
    // rather than folded into it.
    waiting: state.status === 'waiting',
    problem,
    send,
    clear,
  };
}

function ShoppingAssistant() {
  const { user } = useShop();
  const { messages, busy, waiting, problem, send, clear } = useAssistant();

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');

  const log = useRef(null);
  const input = useRef(null);
  const pinned = useRef(true);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Also covers the end of a turn, when the composer comes back enabled and
  // would otherwise drop focus on the floor.
  useEffect(() => {
    if (open && !busy) input.current?.focus();
  }, [open, busy]);

  // Follow the conversation down, unless the shopper has scrolled up to read
  // something — in which case new text must not yank them away from it.
  useEffect(() => {
    const node = log.current;
    if (!node || !pinned.current) return;
    node.scrollTop = node.scrollHeight;
  }, [messages, busy, waiting, open, problem]);

  const trackScroll = () => {
    const node = log.current;
    if (!node) return;
    pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight <= PINNED_PX;
  };

  const submit = (event) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    send(text);
    setDraft('');
  };

  // Until the first token lands there is nothing to show but the shopper's own
  // message, and a capability can take a few seconds to run.
  const thinking = busy && messages.at(-1)?.role !== 'assistant';

  return (
    <>
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
            <div className="assistant-actions">
              {messages.length > 0 && (
                <button type="button" className="assistant-clear" onClick={clear}>
                  Clear
                </button>
              )}
              <button
                type="button"
                className="assistant-close"
                onClick={() => setOpen(false)}
                aria-label="Close assistant"
              >
                ×
              </button>
            </div>
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
            <div className="chat-log" ref={log} onScroll={trackScroll} role="log" aria-live="polite">
              {messages.length === 0 && (
                <p className="chat-empty">
                  Ask for anything in the shop — “wireless headphones under ₹20,000”, “what’s in my
                  cart?”, “where has my last order got to?”
                </p>
              )}

              {messages.map((message, index) => (
                // No id on the wire, and the index is as stable as anything on
                // offer: within a turn the transcript only grows, and at the end
                // of one it is replaced wholesale by the server's own copy.
                <Bubble key={index} message={message} />
              ))}

              {thinking && (
                <div className="chat-msg chat-msg--assistant chat-thinking" role="status" aria-label="Thinking">
                  <span />
                  <span />
                  <span />
                </div>
              )}

              {/*
                The turn has finished and the panel is polling on its own —
                here, an order sitting on Razorpay's page. Without this the
                shopper sees a settled-looking conversation for up to fifteen
                minutes and has no idea anything is still happening. Deliberately
                not a bubble: nobody said this, and it disappears when the poll
                resolves rather than staying in the transcript.
              */}
              {waiting && (
                <p className="chat-waiting" role="status">
                  <span className="chat-waiting-dot" />
                  {DEFAULT_WAITING_LABEL}
                </p>
              )}
            </div>

            <form className="chat-composer" onSubmit={submit}>
              <input
                ref={input}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Find me wireless headphones under ₹20,000…"
                aria-label="Message the shopping assistant"
                disabled={busy}
              />
              <button type="submit" disabled={busy || !draft.trim()}>
                Send
              </button>
            </form>
          </div>
        </section>
      )}
    </>
  );
}

export default function Assistant() {
  // A build-time constant, so the hooks below it are never conditional.
  if (!PUBLIC_KEY) return null;
  return <ShoppingAssistant />;
}
