/**
 * Accounts, sessions, roles and the per-person register list.
 *
 * Passwords are hashed with scrypt, so a leaked database holds no readable
 * password. Sessions are signed tokens rather than server-side state, because a
 * free instance restarts several times a day and everybody being signed out each
 * time trains the team to pick a short password.
 */

import { createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

const KEY_LENGTH = 64;
const SESSION_DAYS = 30;

/**
 * Two roles answer *what kind of thing* somebody may do; the register list
 * answers *where*. They are separate because folding them together would mean
 * inventing a role per combination — "editor but only IWS and MOC".
 */
export const ROLES = ['viewer', 'editor', 'admin'];

export const CAPABILITIES = {
  viewer: new Set(['read', 'export']),
  editor: new Set(['read', 'export', 'write', 'import']),
  admin: new Set(['read', 'export', 'write', 'import', 'admin']),
};

export function can(user, capability) {
  if (!user) return false;
  return CAPABILITIES[user.role]?.has(capability) ?? false;
}

/**
 * Which registers this account may open. An empty list means all of them —
 * the common case, and the one that must not need every register naming.
 */
export function allowedRegisters(user, allIds) {
  if (!user) return [];
  const list = user.registers ?? [];
  return list.length === 0 ? allIds.slice() : allIds.filter((id) => list.includes(id));
}

export function mayUseRegister(user, registerId) {
  if (!user) return false;
  const list = user.registers ?? [];
  return list.length === 0 || list.includes(registerId);
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt, KEY_LENGTH);
  return `scrypt:${salt}:${derived.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, salt, hex] = String(stored ?? '').split(':');
  if (scheme !== 'scrypt' || !salt || !hex) return false;
  const derived = await scryptAsync(password, salt, KEY_LENGTH);
  const expected = Buffer.from(hex, 'hex');
  // Length has to match before `timingSafeEqual`, which throws rather than
  // returning false when it does not.
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */

const base64url = (buffer) => Buffer.from(buffer).toString('base64url');

/**
 * A token is `payload.signature`.
 *
 * `purpose` is signed into the payload so a session token cannot be replayed as
 * a password confirmation: the two are signed by the same secret and would
 * otherwise be interchangeable.
 */
export function signToken(secret, payload, purpose = 'session', ttlMs = SESSION_DAYS * 86400000) {
  const body = base64url(JSON.stringify({ ...payload, purpose, exp: Date.now() + ttlMs }));
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function verifyToken(secret, token, purpose = 'session') {
  const [body, signature] = String(token ?? '').split('.');
  if (!body || !signature) return null;

  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (payload.purpose !== purpose) return null;
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

/** Everything about an account except the one thing nobody may read back. */
export function publicUser(user) {
  if (!user) return null;
  const { password, ...rest } = user;
  return rest;
}

export async function createUser({ email, name, role = 'viewer', registers = [], password }) {
  if (!ROLES.includes(role)) throw new Error(`Unknown role: ${role}`);
  return {
    id: randomUUID(),
    email: String(email).trim().toLowerCase(),
    name: String(name).trim(),
    role,
    registers,
    password: await hashPassword(password),
  };
}

/**
 * The last administrator cannot be demoted or deleted.
 *
 * It is the one change that could not be undone from inside the app — there
 * would be nobody left who could grant the role back.
 */
export function isLastAdmin(users, userId) {
  const admins = users.filter((u) => u.role === 'admin');
  return admins.length === 1 && admins[0].id === userId;
}
