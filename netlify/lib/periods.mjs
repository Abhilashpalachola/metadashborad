// Period presets shared by Meta (date_preset) and Zoho (Created_Time range, IST).
export const PERIODS = ['today', 'yesterday', 'this_week_mon_today', 'last_7d', 'this_month', 'last_30d', 'last_90d', 'maximum'];

const IST = 5.5 * 3600e3;
const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (d, k) => new Date(d.getTime() + k * 864e5);

export const istToday = (now = Date.now()) => {
  const n = new Date(now + IST);
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
};

// Same windows Meta uses for its presets: the "last_N" presets end yesterday.
export const zohoRange = (p, now = Date.now()) => {
  const t = istToday(now);
  let a = t, b = t;
  if (p === 'yesterday') { a = b = addDays(t, -1); }
  else if (p === 'this_week_mon_today') { a = addDays(t, -((t.getUTCDay() + 6) % 7)); }
  else if (p === 'last_7d') { a = addDays(t, -7); b = addDays(t, -1); }
  else if (p === 'this_month') { a = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1)); }
  else if (p === 'last_30d') { a = addDays(t, -30); b = addDays(t, -1); }
  else if (p === 'last_90d') { a = addDays(t, -90); b = addDays(t, -1); }
  else if (p === 'maximum') { a = new Date(Date.UTC(2018, 0, 1)); }
  return { since: ymd(a) + 'T00:00:00+05:30', until: ymd(b) + 'T23:59:59+05:30' };
};
