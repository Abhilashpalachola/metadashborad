// Background job (up to 15 min): match Zoho Meta leads to ERPNext and store the monthly outcome table.
// Started by the nightly schedule or the "Update ERPNext" button. No phone numbers are stored —
// only the aggregated table.
import { getStore } from '@netlify/blobs';
import { isAuthed, syncKey } from '../lib/auth.mjs';
import { leadsForMatch } from '../lib/zoho.mjs';
import { loadErp, cohort } from '../lib/erpnext.mjs';
import { istToday } from '../lib/periods.mjs';

export default async (req) => {
  if (!isAuthed(req) && req.headers.get('x-sync-key') !== syncKey()) return new Response('login', { status: 401 });
  const store = getStore('cache');
  const prev = await store.get('erpnext-cohort', { type: 'json' }).catch(() => null);
  await store.setJSON('erpnext-cohort', { ...(prev || { rows: [] }), running: true }).catch(() => {});
  try {
    const from = process.env.MATCH_FROM || '2024-01-01';
    const until = istToday().toISOString().slice(0, 10);
    const [zoho, erp] = await Promise.all([leadsForMatch(from + 'T00:00:00+05:30', until + 'T23:59:59+05:30'), loadErp()]);
    const rows = cohort(zoho, erp);
    await store.setJSON('erpnext-cohort', { at: Date.now(), rows, running: false, counts: { zoho: zoho.length, erp_leads: erp.L.length, opps: erp.O.length, orders: erp.S.length } });
  } catch (e) {
    await store.setJSON('erpnext-cohort', { ...(prev || { rows: [] }), running: false, error: String(e.message || e), errorAt: Date.now() });
  }
};

export const config = { path: '/api/erpnext-sync', background: true };
