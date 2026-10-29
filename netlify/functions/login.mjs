// POST /api/login {password}  → sets the team session cookie
// POST /api/logout             → clears it
import { passwordOk, sessionCookie, clearCookie, json } from '../lib/auth.mjs';

const tries = new Map(); // simple per-instance throttle against password guessing

export default async (req) => {
  const u = new URL(req.url);
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (u.pathname.endsWith('/logout')) return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
  const ip = req.headers.get('x-nf-client-connection-ip') || 'x';
  const t = tries.get(ip) || { n: 0, at: Date.now() };
  if (Date.now() - t.at > 15 * 60e3) { t.n = 0; t.at = Date.now(); }
  if (t.n >= 10) return json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429);
  const body = await req.json().catch(() => ({}));
  if (!passwordOk(body.password)) { t.n++; tries.set(ip, t); return json({ error: 'Wrong password' }, 401); }
  tries.delete(ip);
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie() });
};

export const config = { path: ['/api/login', '/api/logout'] };
