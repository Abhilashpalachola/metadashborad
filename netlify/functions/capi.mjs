// GET  /api/capi          → status: last runs and stages sent so far
// GET  /api/capi?dry=1    → preview the events the next run would send (nothing is sent)
// POST /api/capi          → run now
// Team-only (session cookie).
import { isAuthed, json } from '../lib/auth.mjs';
import { run, status } from '../lib/capi.mjs';

export default async (req) => {
  if (!isAuthed(req)) return json({ error: 'login' }, 401);
  try {
    if (req.method === 'POST') return json(await run());
    if (new URL(req.url).searchParams.get('dry')) return json(await run({ dry: true }));
    return json(await status());
  } catch (e) {
    return json({ error: String(e.message || e) }, 500);
  }
};

export const config = { path: '/api/capi' };
