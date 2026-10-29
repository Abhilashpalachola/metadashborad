// Every night at 2:00 am IST (20:30 UTC): start the ERPNext match in the background.
import { syncKey } from '../lib/auth.mjs';

export default async () => {
  const key = syncKey();
  const site = process.env.URL; // provided by Netlify
  await fetch(`${site}/api/erpnext-sync`, { method: 'POST', headers: { 'x-sync-key': key } });
};

export const config = { schedule: '30 20 * * *' };
