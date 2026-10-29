// Zoho CRM (read only) through COQL. Needs ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN
// (scopes ZohoCRM.coql.READ,ZohoCRM.modules.leads.READ) and ZOHO_DC (in, com, eu …; default in).
import { getStore } from '@netlify/blobs';

const dc = () => process.env.ZOHO_DC || 'in';
const SOURCES = (process.env.ZOHO_LEAD_SOURCES || 'Meta Ads,Facebook Ads').split(',').map((s) => s.trim()).filter(Boolean);
let mem = null; // { token, exp }

async function accessToken() {
  if (mem && mem.exp > Date.now() + 60e3) return mem.token;
  const store = getStore('cache');
  const cached = await store.get('zoho-token', { type: 'json' }).catch(() => null);
  if (cached && cached.exp > Date.now() + 60e3) { mem = cached; return cached.token; }
  for (const k of ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN']) if (!process.env[k]) throw new Error(k + ' is not set.');
  const u = new URL(`https://accounts.zoho.${dc()}/oauth/v2/token`);
  u.searchParams.set('refresh_token', process.env.ZOHO_REFRESH_TOKEN);
  u.searchParams.set('client_id', process.env.ZOHO_CLIENT_ID);
  u.searchParams.set('client_secret', process.env.ZOHO_CLIENT_SECRET);
  u.searchParams.set('grant_type', 'refresh_token');
  const r = await fetch(u, { method: 'POST' });
  const b = await r.json().catch(() => ({}));
  if (!b.access_token) throw new Error('Zoho token: ' + (b.error || r.status));
  mem = { token: b.access_token, exp: Date.now() + (Number(b.expires_in) || 3600) * 1000 };
  await store.setJSON('zoho-token', mem).catch(() => {});
  return mem.token;
}

export async function coql(select_query) {
  const r = await fetch(`https://www.zohoapis.${dc()}/crm/v6/coql`, {
    method: 'POST',
    headers: { Authorization: 'Zoho-oauthtoken ' + (await accessToken()), 'content-type': 'application/json' },
    body: JSON.stringify({ select_query }),
  });
  if (r.status === 204) return { data: [], info: { more_records: false } };
  const b = await r.json().catch(() => ({}));
  if (!r.ok || b.status === 'error') throw new Error('Zoho: ' + (b.message || b.code || r.status));
  return b;
}

const srcWhere = () => '(' + SOURCES.map((s) => `Lead_Source = '${s.replace(/'/g, '')}'`).join(' or ') + ')';
const between = (a, b) => `(Created_Time between '${a}' and '${b}')`;

// Lead counts per status, ad and ad set for a time range (one call, any period length).
export async function leadGroups(since, until) {
  const q = `select Lead_Status, Ad_Name, Adset_Name, COUNT(id) from Leads where (${srcWhere()} and ${between(since, until)}) group by Lead_Status, Ad_Name, Adset_Name limit 2000`;
  const b = await coql(q);
  return (b.data || []).map((g) => [g.Lead_Status ?? null, g.Ad_Name ?? null, g.Adset_Name ?? null, Number(g['COUNT(id)']) || 0]);
}

// Individual leads (with mobile, kept in memory only) for the ERPNext match.
export async function leadsForMatch(since, until) {
  const out = [];
  // Quarter-sized windows keep each window under COQL's 10,000-row offset limit.
  let a = new Date(since.slice(0, 10) + 'T00:00:00Z');
  const end = new Date(until.slice(0, 10) + 'T00:00:00Z');
  while (a <= end) {
    const b = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + 3, 0));
    const s = a.toISOString().slice(0, 10) + 'T00:00:00+05:30', u = (b < end ? b : end).toISOString().slice(0, 10) + 'T23:59:59+05:30';
    for (let off = 0; off < 10000; off += 2000) {
      const r = await coql(`select id, Mobile, Created_Time, Lead_Status, Ad_Name, Adset_Name, Lead_Form, Brands from Leads where (${srcWhere()} and ${between(s, u)}) order by Created_Time asc limit ${off}, 2000`);
      out.push(...(r.data || []));
      if (!(r.info && r.info.more_records)) break;
    }
    a = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + 3, 1));
  }
  return out;
}
