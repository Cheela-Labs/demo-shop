/**
 * Basic session auth: scrypt-hashed passwords, opaque bearer tokens kept in
 * the `sessions` table so logout genuinely revokes.
 *
 * Deliberately dependency-free — node:crypto covers all of it.
 */

import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

import { db } from './db.js';

const SESSION_DAYS = 30;

const insertUser = db.prepare(
  'INSERT INTO users (id, email, name, password_hash, salt) VALUES (?, ?, ?, ?, ?)',
);
const userByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const userById = db.prepare('SELECT * FROM users WHERE id = ?');
const insertSession = db.prepare(
  'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)',
);
const sessionByToken = db.prepare(
  `SELECT s.token, s.expires_at, u.id, u.email, u.name, u.created_at
     FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > datetime('now')`,
);
const deleteSession = db.prepare('DELETE FROM sessions WHERE token = ?');

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}

function verifyPassword(password, salt, expected) {
  const actual = scryptSync(password, salt, 64);
  const expectedBuf = Buffer.from(expected, 'hex');
  return actual.length === expectedBuf.length && timingSafeEqual(actual, expectedBuf);
}

export function publicUser(row) {
  return { id: row.id, email: row.email, name: row.name, createdAt: row.created_at };
}

function issueToken(userId) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString().replace('T', ' ').slice(0, 19);
  insertSession.run(token, userId, expires);
  return { token, expiresAt: expires };
}

export function registerUser({ email, name, password }) {
  const normalised = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalised)) {
    throw Object.assign(new Error('A valid email is required'), { status: 400 });
  }
  if (!password || String(password).length < 8) {
    throw Object.assign(new Error('Password must be at least 8 characters'), { status: 400 });
  }
  if (userByEmail.get(normalised)) {
    throw Object.assign(new Error('That email is already registered'), { status: 409 });
  }

  const id = randomUUID();
  const { salt, hash } = hashPassword(String(password));
  insertUser.run(id, normalised, String(name || '').trim() || normalised.split('@')[0], hash, salt);

  const user = userById.get(id);
  return { user: publicUser(user), ...issueToken(id) };
}

export function loginUser({ email, password }) {
  const normalised = String(email || '').trim().toLowerCase();
  const user = userByEmail.get(normalised);
  const unauthorized = Object.assign(new Error('Email or password is incorrect'), { status: 401 });

  if (!user) throw unauthorized;
  if (!verifyPassword(String(password || ''), user.salt, user.password_hash)) throw unauthorized;

  return { user: publicUser(user), ...issueToken(user.id) };
}

export function logout(token) {
  if (token) deleteSession.run(token);
}

function tokenFrom(req) {
  const header = req.get('authorization') || '';
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value : null;
}

/** Populates req.user when a valid token is present; never rejects. */
export function attachUser(req, _res, next) {
  const token = tokenFrom(req);
  if (token) {
    const session = sessionByToken.get(token);
    if (session) {
      req.token = token;
      req.user = { id: session.id, email: session.email, name: session.name, createdAt: session.created_at };
    }
  }
  next();
}

/** Gate for routes that genuinely need a signed-in user. */
export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue' });
  return next();
}

/**
 * Resolves a session token to a user, for callers that hold the token directly
 * rather than an Express request.
 *
 * Cheela capabilities are the reason this exists: a capability is invoked with
 * the shopper's token in its execution context, not as an `Authorization`
 * header on a request object, so `attachUser` does not apply. The lookup is the
 * same one — same table, same expiry check — so a capability and the REST API
 * cannot disagree about who someone is.
 *
 * Annotated because the row comes back as SQL scalars, which TypeScript widens
 * to `string | number | null | …` — the callers need a user, not a row.
 *
 * @param {string | undefined} token
 * @returns {{ id: string, email: string, name: string, createdAt: string } | null}
 */
export function userByToken(token) {
  if (!token) return null;
  const session = sessionByToken.get(token);
  if (!session) return null;
  return {
    id: String(session.id),
    email: String(session.email),
    name: String(session.name),
    createdAt: String(session.created_at),
  };
}
