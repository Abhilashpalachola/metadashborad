// ERPNext (read only) and the Zoho ↔ ERPNext match by phone number.
// Needs ERP_URL (https://portal.incygys.in), ERP_API_KEY and ERP_API_SECRET of a read-only user.
const base = () => {
  const u = (process.env.ERP_URL || '').replace(/\/+$/, '');
  if (!u) throw new Error('ERP_URL is not set.');
  return u;
};
const headers = () => {
  if (!process.env.ERP_API_KEY || !process.env.ERP_API_SECRET) throw new Error('ERP_API_KEY / ERP_API_SECRET are not set.');
  return { Authorization: `token ${process.env.ERP_API_KEY}:${process.env.ERP_API_SECRET}`, Accept: 'application/json' };
};

async function call(method, params) {
  const u = new URL(`${base()}/api/method/${method}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  const r = await fetch(u, { headers: headers() });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`ERPNext ${method}: ${b.exc_type || b._error_message || r.status}`);
  return b;
}

// Only ask for fields that exist on this site (custom fields differ between installs).
const fieldCache = new Map();
async function fieldsOf(doctype) {
  if (fieldCache.has(doctype)) return fieldCache.get(doctype);
  const b = await call('frappe.desk.form.load.getdoctype', { doctype });
  const set = new Set(['name', 'creation', 'docstatus']);
  for (const d of b.docs || []) for (const f of d.fields || []) set.add(f.fieldname);
  fieldCache.set(doctype, set);
  return set;
}
async function list(doctype, wanted, extra = []) {
  const have = await fieldsOf(doctype);
  const fields = wanted.filter((f) => have.has(f)).concat(extra);
  const b = await call('frappe.client.get_list', { doctype, fields, limit_page_length: 0 });
  return b.message || [];
}

export const phone10 = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : null; };
const phones = (o, keys) => [...new Set(keys.map((k) => phone10(o[k])).filter(Boolean))];

export async function loadErp() {
  const [leads, opps, customers, soRows] = await Promise.all([
    list('Lead', ['name', 'creation', 'mobile_no', 'phone', 'whatsapp_no', 'status']),
    list('Opportunity', ['name', 'transaction_date', 'creation', 'status', 'opportunity_from', 'party_name', 'contact_mobile', 'phone', 'whatsapp', 'mobile_no', 'opportunity_amount']),
    list('Customer', ['name', 'mobile_no', 'phone', 'lead_name', 'customer_group']),
    list('Sales Order', ['name', 'transaction_date', 'status', 'docstatus', 'net_total', 'customer', 'contact_mobile', 'contact_phone', 'customer_group'],
      ['`tabSales Order Item`.item_group as item_group', '`tabSales Order Item`.net_amount as item_net']),
  ]);
  const leadPh = new Map(leads.map((l) => [l.name, phones(l, ['mobile_no', 'phone', 'whatsapp_no'])]));
  const custPh = new Map(customers.map((c) => [c.name, [...new Set([...phones(c, ['mobile_no', 'phone']), ...(leadPh.get(c.lead_name) || [])])]]));
  const O = opps.map((o) => ({
    date: String(o.transaction_date || o.creation || '').slice(0, 10), status: o.status, amount: Number(o.opportunity_amount) || 0,
    p: [...new Set([...phones(o, ['contact_mobile', 'phone', 'whatsapp', 'mobile_no']), ...(o.opportunity_from === 'Lead' ? leadPh.get(o.party_name) || [] : custPh.get(o.party_name) || [])])],
  }));
  const so = new Map();
  for (const r of soRows) {
    let s = so.get(r.name);
    if (!s) {
      s = { date: String(r.transaction_date || '').slice(0, 10), status: r.status, docstatus: Number(r.docstatus), net: Number(r.net_total) || 0, groups: {},
        p: [...new Set([...phones(r, ['contact_mobile', 'contact_phone']), ...(custPh.get(r.customer) || [])])] };
      so.set(r.name, s);
    }
    if (r.item_group) s.groups[r.item_group] = (s.groups[r.item_group] || 0) + (Number(r.item_net) || 0);
  }
  const L = leads.map((l) => ({ date: String(l.creation || '').slice(0, 10), p: leadPh.get(l.name) || [] }));
  return { L, O, S: [...so.values()].filter((s) => s.docstatus === 1 && s.status !== 'Cancelled') };
}

// Zoho status groups (same as the dashboard page).
const Q = new Set(['Prospect', 'Opportunity WARM', 'Opportunity HOT', 'Waiting for Floor Plan', 'Price Quotation Shared', 'Negotiation', 'Booked', 'AR/ ID', 'AR/ID']);
const brandOf = (z) => {
  const s = [z.Brands, z.Ad_Name, z.Adset_Name, z.Lead_Form].map((x) => String(x || '')).join(' ').toLowerCase();
  if (/invac|vacuum/.test(s)) return 'InVac';
  if (/inair|in air|fresh air|\berv\b/.test(s)) return 'InAir';
  return 'Unknown';
};

// One row per lead month and brand: what Meta leads became in ERPNext.
// An ERPNext record counts for a Zoho lead with the same phone (last 10 digits) when it is dated
// no earlier than 30 days before the lead; each record goes to the earliest such lead.
export function cohort(zohoLeads, erp) {
  const leads = zohoLeads
    .map((z) => ({ t: String(z.Created_Time || '').slice(0, 10), p: phone10(z.Mobile), q: Q.has(z.Lead_Status), brand: brandOf(z), out: { erp: false, opp: null, won: false, value: 0, quote: 0 } }))
    .filter((z) => z.t)
    .sort((a, b) => a.t.localeCompare(b.t));
  const byPhone = new Map();
  for (const z of leads) if (z.p) { if (!byPhone.has(z.p)) byPhone.set(z.p, []); byPhone.get(z.p).push(z); }
  const shift = (d, k) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
  const owner = (rec) => {
    for (const p of rec.p) for (const z of byPhone.get(p) || []) if (z.t <= shift(rec.date, 30)) return z;
    return null;
  };
  const rank = { Converted: 5, Quotation: 4, Open: 3, Replied: 3, Lost: 1, Closed: 1 };
  for (const l of erp.L) { const z = owner(l); if (z) z.out.erp = true; }
  for (const o of erp.O) {
    const z = owner(o); if (!z) continue;
    z.out.erp = true;
    if (!z.out.opp || (rank[o.status] || 2) > (rank[z.out.opp.status] || 2)) z.out.opp = o;
  }
  for (const s of erp.S) { const z = owner(s); if (!z) continue; z.out.erp = true; z.out.won = true; z.out.value += s.net; }
  const rows = new Map();
  for (const z of leads) {
    if (z.t < '2025-01-01') continue;
    const k = z.t.slice(0, 7) + '|' + z.brand;
    const r = rows.get(k) || { lead_month: z.t.slice(0, 7), brand: z.brand, leads: 0, qualified_zoho: 0, in_erpnext: 0, opportunity_open: 0, quotation_open: 0, quotation_value: 0, lost_erpnext: 0, won: 0, order_value: 0 };
    r.leads++; if (z.q) r.qualified_zoho++;
    const o = z.out, st = o.opp && o.opp.status;
    if (o.erp) r.in_erpnext++;
    if (o.won || st === 'Converted') { r.won++; r.order_value += o.value || (o.opp ? o.opp.amount : 0); }
    else if (st === 'Quotation') { r.quotation_open++; r.quotation_value += o.opp.amount; }
    else if (st === 'Open' || st === 'Replied') r.opportunity_open++;
    else if (st === 'Lost' || st === 'Closed') r.lost_erpnext++;
    rows.set(k, r);
  }
  return [...rows.values()].map((r) => ({ ...r, quotation_value: Math.round(r.quotation_value), order_value: Math.round(r.order_value) }));
}
