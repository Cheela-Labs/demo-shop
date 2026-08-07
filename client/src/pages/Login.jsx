import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';

import { useShop } from '../store';

export default function Login() {
  const { user, signIn } = useShop();
  const navigate = useNavigate();
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/account" replace />;

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(
        mode === 'register' ? form : { email: form.email, password: form.password },
        mode,
      );
      navigate('/account', { replace: true });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="panel auth-card">
      <div className="tabs">
        <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setError(null); }}>
          Sign in
        </button>
        <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => { setMode('register'); setError(null); }}>
          Create account
        </button>
      </div>

      <form className="form" onSubmit={submit}>
        {error && <div className="alert error">{error}</div>}

        {mode === 'register' && (
          <div className="field">
            <label htmlFor="auth-name">Name</label>
            <input id="auth-name" className="input" value={form.name} onChange={set('name')} required autoComplete="name" />
          </div>
        )}

        <div className="field">
          <label htmlFor="auth-email">Email</label>
          <input id="auth-email" type="email" className="input" value={form.email} onChange={set('email')} required autoComplete="email" />
        </div>

        <div className="field">
          <label htmlFor="auth-password">Password</label>
          <input
            id="auth-password"
            type="password"
            className="input"
            value={form.password}
            onChange={set('password')}
            required
            minLength={8}
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
          />
          {mode === 'register' && <span className="hint">At least 8 characters.</span>}
        </div>

        <button type="submit" className="btn block" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'register' ? 'Create account' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
