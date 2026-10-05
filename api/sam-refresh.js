'use strict';
// Vercel Node function: /api/sam-refresh
// Called ONLY by the Supabase function sam-exclusions-refresh (never by browsers). It does the heavy part of the
// daily SAM.gov refresh (download, unzip, read, store) because it needs more memory and CPU than a Supabase
// Edge Function allows. See _sam-loader.js.
//
// Vercel environment variables (Project > Settings > Environment Variables, Production):
//   SAM_WORKER_SECRET           a long random string; the SAME value is the Supabase secret SAM_WORKER_SECRET
//   SUPABASE_URL                https://zxserlkhwkfoqiepurdr.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   mark it "Sensitive" so it cannot be read back
// The SAM.gov API key is NOT stored here: the Supabase function sends it with each call, so renewing the key
// is still just updating the one Supabase secret.

const crypto = require('crypto');
const { runRefresh } = require('./_sam-loader.js');

function sameSecret(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected || ''));
  if (!b.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  const b = req.body;
  if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return b;
  if (typeof b === 'string' && b) { try { return JSON.parse(b); } catch { return {}; } }
  return {};
}

module.exports = async function handler(req, res, deps = {}) {
  const env = deps.env || process.env;
  const send = (code, body) => { res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.status(code).json(body); };
  if (req.method !== 'POST') return send(405, { error: 'POST only.' });
  if (!sameSecret(req.headers['x-sam-worker-secret'], env.SAM_WORKER_SECRET)) return send(401, { error: 'Unauthorized.' });

  const body = readBody(req);
  if (body.action === 'ping') {                    // checks the setup WITHOUT calling SAM.gov
    return send(200, { success: true, ping: true, node: process.version, region: env.VERCEL_REGION || null,
                       supabase_configured: !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) });
  }
  try {
    const result = await runRefresh({
      samKey: String(req.headers['x-sam-api-key'] || ''),
      supabaseUrl: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
      fetchImpl: deps.fetchImpl || fetch, log: deps.log || console.log,
    });
    return send(200, { success: true, ...result });
  } catch (e) {
    return send(500, { error: e.message, recorded: !!e.recorded });
  }
};
