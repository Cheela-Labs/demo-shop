/**
 * App-wide state: the server-side cart (kept in SQLite, referenced by an id in
 * localStorage) and the signed-in user.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { api, getToken, setToken } from './api';

const ShopContext = createContext(null);
const CART_KEY = 'cheela.cartId';

export function ShopProvider({ children }) {
  const [cart, setCart] = useState(null);
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [toast, setToast] = useState(null);

  // Resolve the cart once on mount: reuse the stored one, or ask for a new one.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const stored = localStorage.getItem(CART_KEY);
      try {
        const { cart: loaded } = stored
          ? await api.cart(stored)
          : await api.createCart();
        if (!cancelled) {
          localStorage.setItem(CART_KEY, loaded.id);
          setCart(loaded);
        }
      } catch {
        // Stored cart is gone (fresh database, say) — start a new one.
        const { cart: fresh } = await api.createCart();
        if (!cancelled) {
          localStorage.setItem(CART_KEY, fresh.id);
          setCart(fresh);
        }
      }

      if (getToken()) {
        try {
          const { user: me } = await api.me();
          if (!cancelled) setUser(me);
        } catch {
          setToken(null);
        }
      }

      if (!cancelled) setReady(true);
    })();

    return () => { cancelled = true; };
  }, []);

  const notify = useCallback((message, tone = 'ok') => {
    setToast({ message, tone, key: Date.now() });
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const addItem = useCallback(async (product, qty = 1) => {
    if (!cart) return;
    try {
      const { cart: next } = await api.addItem(cart.id, product.id, qty);
      setCart(next);
      notify(`${product.name} added to bag`);
    } catch (err) {
      notify(err.message, 'error');
    }
  }, [cart, notify]);

  const updateItem = useCallback(async (itemId, qty) => {
    if (!cart) return;
    try {
      const { cart: next } = await api.updateItem(cart.id, itemId, qty);
      setCart(next);
    } catch (err) {
      notify(err.message, 'error');
    }
  }, [cart, notify]);

  const removeItem = useCallback(async (itemId) => {
    if (!cart) return;
    const { cart: next } = await api.removeItem(cart.id, itemId);
    setCart(next);
  }, [cart]);

  /**
   * Re-reads the cart from the server.
   *
   * Called after the assistant acts, because it writes to the same cart through
   * a completely different path — without this the bag on screen silently
   * disagrees with the database.
   */
  const refreshCart = useCallback(async () => {
    if (!cart) return;
    try {
      const { cart: next } = await api.cart(cart.id);
      setCart(next);
    } catch { /* cart vanished (reseeded db) — leave what we have */ }
  }, [cart]);

  const signIn = useCallback(async (credentials, mode = 'login') => {
    const result = mode === 'register'
      ? await api.register(credentials)
      : await api.login(credentials);
    setToken(result.token);
    setUser(result.user);

    // Bind the guest cart to the account. Two things depend on it: the bag
    // survives signing in, and the chat assistant — which can only find a cart
    // by its owner — starts operating on this one instead of its own.
    if (cart) {
      try {
        const { cart: claimed } = await api.claimCart(cart.id);
        setCart(claimed);
      } catch { /* a cart owned elsewhere just stays as it was */ }
    }

    notify(`Signed in as ${result.user.name}`);
    return result.user;
  }, [cart, notify]);

  const signOut = useCallback(async () => {
    try { await api.logout(); } catch { /* token already dead — fine */ }
    setToken(null);
    setUser(null);
    notify('Signed out');
  }, [notify]);

  const value = useMemo(() => ({
    cart, user, ready, toast,
    addItem, updateItem, removeItem, refreshCart,
    signIn, signOut, notify,
  }), [cart, user, ready, toast, addItem, updateItem, removeItem, refreshCart, signIn, signOut, notify]);

  return <ShopContext.Provider value={value}>{children}</ShopContext.Provider>;
}

export function useShop() {
  const ctx = useContext(ShopContext);
  if (!ctx) throw new Error('useShop must be used inside <ShopProvider>');
  return ctx;
}
