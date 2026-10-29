// Team login: one shared password (DASH_PASSWORD) and a signed, HttpOnly session cookie.
// With no DASH_PASSWORD set, the dashboard is open: anyone with the address can view it.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const isOpen = () => !(process.env.DASH_PASSWORD || '').trim();

const COOKIE = 'inair_sess';
const DAYS = 7;

// SESSION_SECRET is optional: without it, a secret is derived from the site's other private keys.
const secret = () => {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 24) return s;
  return createHash('sha256').update(['inair-dashboard', process.env.META_TOKEN, process.env.ZOHO_CLIENT_SECRET, process.env.ZOHO_REFRESH_TOKEN, process.env.DASH_PASSWORD].join('|')).digest('hex');
};
const sign = (payload) => createHmac('sha256', secret()).update(payload).digest('base64url');

export const passwordOk = (given) => {
  const want = (process.env.DASH_PASSWORD || '').trim();
  if (!want || typeof given !== 'string') return false;
  given = given.trim();
  const a = Buffer.from(createHmac('sha256', 'pw').update(given).digest());
  const b = Buffer.from(createHmac('sha256', 'pw').update(want).digest());
  return timingSafeEqual(a, b);
};

export const sessionCookie = () => {
  const exp = Date.now() + DAYS * 864e5;
  const payload = String(exp);
  return `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${DAYS * 86400}`;
};

export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

export const isAuthed = (req) => {
  if (isOpen()) return true;
  const raw = (req.headers.get('cookie') || '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  if (!raw) return false;
  const [payload, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!payload || !sig) return false;
  const good = sign(payload);
  if (good.length !== sig.length || !timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return false;
  return Number(payload) > Date.now();
};

export const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });

// Key the nightly job uses to start the ERPNext match without a browser session.
export const syncKey = () => createHmac('sha256', secret()).update('erpnext-sync').digest('hex');
