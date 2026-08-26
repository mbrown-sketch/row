// Read-only proxy to the Hevy API. The account-wide Hevy API key stays
// server-side (Vercel env var HEVY_API_KEY) and is never exposed to the
// browser. GET only — writes (POST/PUT) are not proxied.
//
//   GET /api/hevy?path=/v1/workouts&page=1&pageSize=10
//   GET /api/hevy?path=/v1/workouts/count
//
// Set HEVY_API_KEY in Vercel → Settings → Environment Variables
// (generate the key at hevy.com/settings?api — requires Hevy Pro).

const ALLOWED = [
  '/v1/workouts',
  '/v1/workouts/count',
  '/v1/workouts/events',
  '/v1/routines',
  '/v1/routine_folders',
  '/v1/exercise_templates',
  '/v1/exercise_history',
  '/v1/body_measurements',
  '/v1/user/info',
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const key = process.env.HEVY_API_KEY;
  if (!key) return res.status(500).json({ error: 'server not configured (missing HEVY_API_KEY)' });

  const path = (req.query && req.query.path) || '';
  if (typeof path !== 'string' || !path.startsWith('/v1/')) {
    return res.status(400).json({ error: 'path must start with /v1/' });
  }
  if (path.includes('..') || !ALLOWED.some((p) => path === p || path.startsWith(p + '/'))) {
    return res.status(403).json({ error: 'path not allowed' });
  }

  const fwd = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query || {})) {
    if (k !== 'path') fwd.set(k, String(v));
  }
  const qs = fwd.toString();
  const url = 'https://api.hevyapp.com' + path + (qs ? '?' + qs : '');

  try {
    const r = await fetch(url, { headers: { 'api-key': key, 'Accept': 'application/json' } });
    const text = await r.text();
    res.status(r.status);
    res.setHeader('Content-Type', 'application/json');
    // Cache at the edge so repeat page loads don't hammer the Hevy API.
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.send(text);
  } catch (e) {
    return res.status(500).json({ error: 'proxy fetch failed: ' + (e.message || String(e)) });
  }
}
