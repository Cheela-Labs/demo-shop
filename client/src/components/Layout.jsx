import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate, useSearchParams } from 'react-router-dom';

import { useShop } from '../store';
import Assistant from './Assistant';
import { Bag, Logo, Search, User } from './Icons';

function Header() {
  const { cart, user } = useShop();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [term, setTerm] = useState(params.get('q') || '');

  // Keep the box in step with the URL when navigating back/forward.
  useEffect(() => { setTerm(params.get('q') || ''); }, [params]);

  const submit = (event) => {
    event.preventDefault();
    navigate(term.trim() ? `/shop?q=${encodeURIComponent(term.trim())}` : '/shop');
  };

  return (
    <header className="header">
      <div className="wrap header-inner">
        <Link to="/" className="brand">
          <Logo />
          Cheela
        </Link>

        <nav className="nav">
          <NavLink to="/" end>Home</NavLink>
          <NavLink to="/shop">Shop</NavLink>
          {user && <NavLink to="/account">Orders</NavLink>}
        </nav>

        <div className="header-right">
          <form className="search" onSubmit={submit} role="search">
            <Search width={17} height={17} />
            <input
              type="search"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Search products"
              aria-label="Search products"
            />
          </form>

          <Link to={user ? '/account' : '/login'} className="btn ghost sm" title={user ? user.name : 'Sign in'}>
            <User width={17} height={17} />
          </Link>

          <Link to="/cart" className="cart-btn">
            <Bag width={17} height={17} />
            <span className="label">Bag</span>
            {cart?.count > 0 && <span className="cart-count">{cart.count}</span>}
          </Link>
        </div>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <div className="wrap footer-inner">
        <span>© {new Date().getFullYear()} Cheela — a demo storefront.</span>
        <span>React + Express + SQLite · artwork drawn as SVG, served as PNG</span>
      </div>
    </footer>
  );
}

export default function Layout() {
  const { toast } = useShop();

  return (
    <div className="shell">
      <Header />
      <main className="main">
        <div className="wrap"><Outlet /></div>
      </main>
      <Footer />
      <Assistant />
      {toast && (
        <div className={`toast ${toast.tone === 'error' ? 'error' : ''}`} key={toast.key} role="status">
          {toast.message}
        </div>
      )}
    </div>
  );
}
