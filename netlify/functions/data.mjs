// GET /api/data?set=period|today|trend|erpnext&period=this_month[&fresh=1]
// Team-only (session cookie). Results are cached for 2 minutes unless fresh=1.
import { getStore } from '@netlify/blobs';
import { isAuthed, json } from '../lib/auth.mjs';
import { PERIODS, zohoRange } from '../lib/periods.mjs';
import * as meta from '../lib/meta.mjs';
import { leadGroups } from '../lib/zoho.mjs';
import SEED, { SEED_AT } from '../lib/seed-erpnext.mjs';

const TTL = 120e3;

async function cached(key, fresh, build) {
  const store = getStore('cache');
  if (!fresh) {
    const hit = await store.get(key, { type: 'json' }).catch(() => null);
    if (hit && hit.at > Date.now() - TTL) return hit;
  }
  const value = { at: Date.now(), ...(await build()) };
  await store.setJSON(key, value).catch(() => {});
  return value;
}

// Run parts independently so one failing source doesn't blank the others.
const settle = async (parts) => {
  const keys = Object.keys(parts);
  const res = await Promise.allSettled(keys.map((k) => parts[k]()));
  const out = {}, errors = {};
  res.forEach((r, i) => { if (r.status === 'fulfilled') out[keys[i]] = r.value; else errors[keys[i]] = String(r.reason && r.reason.message || r.reason); });
  return { data: out, errors };
};

export default async (req) => {
  if (!isAuthed(req)) return json({ error: 'login' }, 401);
  const u = new URL(req.url);
  const set = u.searchParams.get('set');
  const fresh = u.searchParams.get('fresh') === '1';
  try {
    if (set === 'period') {
      const p = u.searchParams.get('period');
      if (!PERIODS.includes(p)) return json({ error: 'bad period' }, 400);
      const r = zohoRange(p);
      return json(await cached('period-' + p, fresh, () => settle({
        meta_campaigns: () => meta.campaigns(p),
        meta_ads: () => meta.ads(p),
        zoho_leads: async () => ({ groups: await leadGroups(r.since, r.until) }),
      })));
    }
    if (set === 'today') {
      const r = zohoRange('today');
      return json(await cached('today', fresh, () => settle({
        meta_today: () => meta.campaigns('today', { includeZero: true }),
        zoho_today: async () => ({ groups: await leadGroups(r.since, r.until) }),
      })));
    }
    if (set === 'trend') {
      return json(await cached('trend', fresh, () => settle({
        meta_daily: () => meta.account('last_30d', '1'),
        meta_monthly: () => meta.account('maximum', 'monthly'),
      })));
    }
    if (set === 'erpnext') {
      const v = await getStore('cache').get('erpnext-cohort', { type: 'json' }).catch(() => null);
      const has = v && Array.isArray(v.rows) && v.rows.length;
      return json({
        at: has ? v.at : SEED_AT, data: { erpnext: has ? v.rows : SEED }, seed: !has, running: !!(v && v.running),
        errors: {}, lastError: v && v.error ? { message: v.error, at: v.errorAt } : null,
      });
    }
    return json({ error: 'unknown set' }, 400);
  } catch (e) {
    return json({ error: String(e.message || e) }, 500);
  }
};

export const config = { path: '/api/data' };
