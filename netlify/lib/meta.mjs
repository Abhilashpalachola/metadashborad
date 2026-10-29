// Meta Marketing API (read only). Needs META_TOKEN (ads_read) and META_AD_ACCOUNT.
// Returns rows in the shape the dashboard page expects.
const ver = () => process.env.META_API_VERSION || 'v23.0';
const acct = () => {
  const a = String(process.env.META_AD_ACCOUNT || '').replace(/^act_/, '');
  if (!a) throw new Error('META_AD_ACCOUNT is not set.');
  return 'act_' + a;
};
const token = () => {
  const t = process.env.META_TOKEN;
  if (!t) throw new Error('META_TOKEN is not set.');
  return t;
};

const LEAD_TYPES = ['lead', 'onsite_conversion.lead_grouped', 'leadgen_grouped', 'offsite_conversion.fb_pixel_lead'];
export const leadsFrom = (actions) => {
  if (!Array.isArray(actions)) return 0;
  for (const t of LEAD_TYPES) { const a = actions.find((x) => x.action_type === t); if (a) return Number(a.value) || 0; }
  return 0;
};
const num = (v) => (v == null || v === '' ? null : Number(v));

async function graph(path, params = {}, maxPages = 10) {
  const url = new URL(`https://graph.facebook.com/${ver()}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  url.searchParams.set('access_token', token());
  let next = url.toString(), out = [], pages = 0;
  while (next && pages < maxPages) {
    const r = await fetch(next);
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body.error) throw new Error('Meta: ' + ((body.error && body.error.message) || r.status));
    if (Array.isArray(body.data)) out = out.concat(body.data); else return body;
    next = body.paging && body.paging.next; pages++;
  }
  return out;
}

const insights = (level, preset, fields, extra = {}) =>
  graph(`${acct()}/insights`, { level, date_preset: preset, fields: fields.join(','), limit: '500', ...extra });

// Campaigns: status and daily budget from the campaign list, metrics from insights.
export async function campaigns(preset, { includeZero = false } = {}) {
  const [list, ins] = await Promise.all([
    graph(`${acct()}/campaigns`, { fields: 'id,name,effective_status,daily_budget', limit: '500' }),
    insights('campaign', preset, ['campaign_id', 'campaign_name', 'spend', 'impressions', 'reach', 'clicks', 'ctr', 'cpm', 'frequency', 'actions']),
  ]);
  const m = new Map(ins.map((r) => [r.campaign_id, r]));
  return list
    .map((c) => {
      const r = m.get(c.id) || {};
      return {
        id: c.id, name: c.name, effective_status: c.effective_status,
        daily_budget: c.daily_budget != null ? Number(c.daily_budget) / 100 : null, // minor units → ₹
        amount_spent: num(r.spend) || 0, lead: leadsFrom(r.actions), impressions: num(r.impressions) || 0, reach: num(r.reach),
        clicks: num(r.clicks) || 0, ctr: num(r.ctr), cpm: num(r.cpm), frequency: num(r.frequency),
      };
    })
    .filter((c) => includeZero || c.amount_spent > 0 || c.effective_status === 'ACTIVE');
}

// Ads that spent in the period, with their delivery status.
export async function ads(preset) {
  const ins = (await insights('ad', preset, ['ad_id', 'ad_name', 'adset_name', 'campaign_name', 'spend', 'impressions', 'clicks', 'ctr', 'frequency', 'actions']))
    .filter((r) => Number(r.spend) > 0 || leadsFrom(r.actions) > 0);
  const status = new Map();
  for (let i = 0; i < ins.length; i += 50) {
    const ids = ins.slice(i, i + 50).map((r) => r.ad_id).join(',');
    if (!ids) continue;
    const body = await graph('', { ids, fields: 'effective_status' }, 1);
    for (const [id, v] of Object.entries(body || {})) status.set(id, v.effective_status);
  }
  return ins.map((r) => ({
    id: r.ad_id, name: r.ad_name, adset_name: r.adset_name, campaign_name: r.campaign_name, effective_status: status.get(r.ad_id) || null,
    amount_spent: num(r.spend) || 0, lead: leadsFrom(r.actions), impressions: num(r.impressions) || 0, clicks: num(r.clicks) || 0, ctr: num(r.ctr), frequency: num(r.frequency),
  }));
}

// Account totals per day or per month.
export async function account(preset, increment) {
  const rows = await insights('account', preset, ['spend', 'impressions', 'clicks', 'actions'], { time_increment: increment });
  return rows.map((r) => ({ date_start: r.date_start, amount_spent: num(r.spend) || 0, lead: leadsFrom(r.actions), impressions: num(r.impressions) || 0, clicks: num(r.clicks) || 0 }));
}
