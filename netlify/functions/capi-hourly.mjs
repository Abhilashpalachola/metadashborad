// Every hour at :20: send new Zoho lead stages to Meta (Conversions API for CRM).
import { run } from '../lib/capi.mjs';

export default async () => {
  if (!process.env.META_DATASET_ID || !process.env.META_CAPI_TOKEN) return; // not set up yet
  const r = await run();
  console.log('capi', JSON.stringify(r));
};

export const config = { schedule: '20 * * * *' };
