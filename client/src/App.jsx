import { Link, Route, Routes } from 'react-router-dom';

import Layout from './components/Layout';
import Account from './pages/Account';
import Cart from './pages/Cart';
import Catalog from './pages/Catalog';
import Checkout from './pages/Checkout';
import Home from './pages/Home';
import Login from './pages/Login';
import Order from './pages/Order';
import Pay from './pages/Pay';
import Product from './pages/Product';

function NotFound() {
  return (
    <div className="empty">
      <h2>Page not found</h2>
      <p>That link does not go anywhere.</p>
      <Link to="/" className="btn">Go home</Link>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="shop" element={<Catalog />} />
        <Route path="product/:id" element={<Product />} />
        <Route path="cart" element={<Cart />} />
        <Route path="checkout" element={<Checkout />} />
        <Route path="order/:id" element={<Order />} />
        <Route path="pay/:id" element={<Pay />} />
        <Route path="login" element={<Login />} />
        <Route path="account" element={<Account />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
