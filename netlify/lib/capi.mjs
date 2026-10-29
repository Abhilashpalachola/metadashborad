// Sends Zoho lead stages to Meta (Conversions API for CRM), so Meta learns which leads became
// qualified, quoted and won. Zoho is only read. Needs META_DATASET_ID and META_CAPI_TOKEN,
// plus the Zoho variables the dashboard already uses. Optional: META_CAPI_TEST_CODE.
import { createHash } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { coql } from './zoho.mjs';

const ver = () => process.env.META_API_VERSION || 'v23.0';
const SOURCES = (process.env.ZOHO_LEAD_SOURCES || 'Meta Ads,Facebook Ads').split(',').map((s) => s.trim()).filter(Boolean);
const CRM_NAME = 'Zoho CRM';
const DAY = 864e5;
const MAX_AGE = 7 * DAY;      // Meta accepts events up to 7 days old
const KEEP = 35 * DAY;        // remember what was sent for a little longer than Meta's 28-day window
const BATCH = 200;            // Meta allows 1,000; smaller batches lose less if one is refused

// Funnel order. Each lead is sent every stage up to the one its Zoho status reaches.
export const FUNNEL = ['Lead', 'Contacted', 'Qualified', 'Quotation', 'Won'];
export const STAGE_OF = {
  'Incoming': 'Lead', 'Attempted to Contact': 'Lead', '3 Attempt': 'Lead',
  'Future': 'Contacted', 'NEW LEAD FUTURE': 'Contacted',
  'Prospect': 'Qualified', 'Opportunity WARM': 'Qualified', 'Opportunity HOT': 'Qualified',
  'Waiting for Floor Plan': 'Qualified', 'AR/ ID': 'Qualified',
  'Price Quotation Shared': 'Quotation', 'Negotiation': 'Quotation',
  'Booked': 'Won',
  // Rejections: the lead was contacted, then ruled out.
  'Un Qualified': 'Disqualified', 'FULLY BUILD': 'Disqualified', 'CASUAL ENQUARY': 'Disqualified',
  'BUDGET ISSUE': 'Disqualified', 'WRONG PROUDUCT': 'Disqualified', 'Lost': 'Disqualified', 'Dealers': 'Disqualified',
};

// Stages a lead should have been sent, in order, for its current Zoho status.
export function stagesFor(status) {
  const s = STAGE_OF[status];
  if (!s) return ['Lead'];                 // unknown status: count the lead only
  if (s === 'Disqualified') return ['Lead', 'Contacted', 'Disqualified'];
  return FUNNEL.slice(0, FUNNEL.indexOf(s) + 1);
}

const sha = (v) => createHash('sha256').update(v).digest('hex');
export const normPhone = (...vals) => {
  for (const v of vals) {
    const d = String(v || '').replace(/\D/g, '');
    if (d.length >= 10) return '91' + d.slice(-10); // Indian numbers; also fixes "+1 98480…" style entries
  }
  return null;
};
const normEmail = (e) => (e && /@/.test(e) ? String(e).trim().toLowerCase() : null);
const secs = (t) => Math.floor(new Date(t).getTime() / 1000);

export function eventsFor(lead, already, now = Date.now()) {
  const created = new Date(lead.Created_Time).getTime();
  const changed = new Date(lead.Modified_Time || lead.Created_Time).getTime();
  const want = stagesFor(lead.Lead_Status);
  const todo = want.filter((s) => !already.includes(s));
  const user = {};
  const lid = String(lead.leadchain0__Social_Lead_ID || '').replace(/\D/g, '');
  if (lid.length >= 10) user.lead_id = lid; // written as a whole number when the batch is serialised
  const ph = normPhone(lead.Mobile, lead.Phone); if (ph) user.ph = [sha(ph)];
  const em = normEmail(lead.Email); if (em) user.em = [sha(em)];
  if (!Object.keys(user).length) return { events: [], skipped: 'no lead id, phone or email' };
  const events = [];
  todo.forEach((stage, i) => {
    // "Lead" happened when the form was filled; later stages at the last Zoho change, a second apart to keep order.
    let t = stage === 'Lead' ? created : Math.max(changed - (todo.length - 1 - i) * 1000, created + 1000);
    t = Math.min(t, now);
    if (now - t > MAX_AGE) return; // Meta would discard it
    events.push({ stage, body: {
      event_name: stage, event_time: Math.floor(t / 1000), action_source: 'system_generated',
      user_data: user, custom_data: { event_source: 'crm', lead_event_source: CRM_NAME },
    } });
  });
  return { events };
}

// JSON with lead_id as an exact whole number (17-digit IDs are too long for a JavaScript number).
export const serialise = (data, test) =>
  JSON.stringify(test ? { data, test_event_code: test } : { data }).replace(/"lead_id":"(\d+)"/g, '"lead_id":$1');

async function post(events) {
  const id = process.env.META_DATASET_ID, tok = process.env.META_CAPI_TOKEN;
  if (!id || !tok) throw new Error('META_DATASET_ID and META_CAPI_TOKEN must be set.');
  const r = await fetch(`https://graph.facebook.com/${ver()}/${id}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + tok },
    body: serialise(events, process.env.META_CAPI_TEST_CODE),
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok || b.error) throw new Error((b.error && b.error.message) || 'HTTP ' + r.status);
  return b;
}

const srcWhere = () => '(' + SOURCES.map((s) => `Lead_Source = '${s.replace(/'/g, '')}'`).join(' or ') + ')';
const ist = (ms) => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 19) + '+05:30';

async function changedLeads(fromMs, toMs) {
  const out = [];
  for (let off = 0; off < 10000; off += 200) {
    const r = await coql(`select id, Created_Time, Modified_Time, Lead_Status, Mobile, Phone, Email, leadchain0__Social_Lead_ID from Leads where (${srcWhere()} and (Modified_Time between '${ist(fromMs)}' and '${ist(toMs)}')) order by Modified_Time asc limit ${off}, 200`);
    out.push(...(r.data || []));
    if (!(r.info && r.info.more_records)) break;
  }
  return out;
}

// One run: find leads changed since the last run (first run: last 7 days), send their new stages.
// dry = build the events without sending or remembering anything.
export async function run({ dry = false, now = Date.now() } = {}) {
  const store = getStore('capi');
  const state = (await store.get('state', { type: 'json' }).catch(() => null)) || { sent: {}, last: 0 };
  const from = Math.max((state.last || 0) - 15 * 60e3, now - MAX_AGE); // 15 min overlap: no gaps
  const leads = await changedLeads(from, now);
  const queue = [], skipped = [];
  for (const l of leads) {
    if (now - new Date(l.Created_Time).getTime() > 28 * DAY) continue; // outside Meta's 28-day window
    const { events, skipped: why } = eventsFor(l, (state.sent[l.id] || {}).s || [], now);
    if (why) skipped.push({ id: l.id, why });
    for (const e of events) queue.push({ lead: l.id, created: l.Created_Time, ...e });
  }
  // Test mode: a sample only, and nothing is remembered, so the same events go live later.
  const test = !!process.env.META_CAPI_TEST_CODE;
  if (test) queue.splice(50);
  const result = { at: now, test, checked: leads.length, events: queue.length, sent: 0, failed: 0, skipped: skipped.length, errors: [] };
  if (dry) return { ...result, dry: true, preview: queue.slice(0, 20).map((q) => ({ lead: q.lead, ...q.body, user_data: Object.keys(q.body.user_data) })) };

  const mark = (q) => {
    const rec = state.sent[q.lead] || (state.sent[q.lead] = { c: q.created, s: [] });
    if (!rec.s.includes(q.stage)) rec.s.push(q.stage);
  };
  for (let i = 0; i < queue.length; i += BATCH) {
    const chunk = queue.slice(i, i + BATCH);
    try { await post(chunk.map((q) => q.body)); chunk.forEach(mark); result.sent += chunk.length; }
    catch (e) {
      // Meta drops the whole batch if one event is bad: retry one by one to find it.
      for (const q of chunk) {
        try { await post([q.body]); mark(q); result.sent++; }
        catch (e2) { result.failed++; if (result.errors.length < 5) result.errors.push(`${q.lead} ${q.stage}: ${e2.message}`); }
      }
    }
  }
  if (!test) {
    for (const [id, rec] of Object.entries(state.sent)) if (now - new Date(rec.c).getTime() > KEEP) delete state.sent[id];
    state.last = now;
    await store.setJSON('state', state);
  }
  const hist = ((await store.get('runs', { type: 'json' }).catch(() => null)) || []).slice(-47);
  hist.push(result);
  await store.setJSON('runs', hist);
  return result;
}

export async function status() {
  const store = getStore('capi');
  const runs = (await store.get('runs', { type: 'json' }).catch(() => null)) || [];
  const state = (await store.get('state', { type: 'json' }).catch(() => null)) || { sent: {} };
  const byStage = {};
  for (const rec of Object.values(state.sent)) for (const s of rec.s) byStage[s] = (byStage[s] || 0) + 1;
  return { configured: !!(process.env.META_DATASET_ID && process.env.META_CAPI_TOKEN), test_mode: !!process.env.META_CAPI_TEST_CODE, last_run: runs[runs.length - 1] || null, recent_runs: runs.slice(-10), leads_tracked: Object.keys(state.sent).length, stages_sent: byStage };
}
