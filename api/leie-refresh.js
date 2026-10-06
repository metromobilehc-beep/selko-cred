'use strict';
// Vercel Node function: /api/leie-refresh
// Called ONLY by the Supabase function leie-exclusions-refresh (never by browsers). It downloads OIG's monthly LEIE file
// and stores it (see _leie-loader.js). Same secret and same Vercel settings as /api/sam-refresh:
//   SAM_WORKER_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.   OIG's file needs no key.

const crypto = require('crypto');
const { runLeieRefresh, locate } = require('./_leie-loader.js');

function sameSecret(given, expected) {
  const a = Buffer.from(String(given || '')); const b = Buffer.from(String(expected || ''));
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
  const fetchImpl = deps.fetchImpl || fetch;
  const send = (code, body) => { res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.status(code).json(body); };
  if (req.method !== 'POST') return send(405, { error: 'POST only.' });
  if (!sameSecret(req.headers['x-sam-worker-secret'], env.SAM_WORKER_SECRET)) return send(401, { error: 'Unauthorized.' });
  const body = readBody(req);

  if (body.action === 'ping') {                   // checks the setup and that OIG's file can be found, WITHOUT downloading it
    const out = { success: true, ping: true, node: process.version, region: env.VERCEL_REGION || null,
                  supabase_configured: !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) };
    try { const p = await locate(fetchImpl, () => {}); out.source_ok = true; out.source_url = p.url; out.source_bytes = p.bytes; out.source_modified = p.last_modified; }
    catch (e) { out.source_ok = false; out.source_error = String(e.message).slice(0, 600); }
    return send(200, out);
  }
  try {
    const result = await runLeieRefresh({ supabaseUrl: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY, fetchImpl, log: deps.log || console.log });
    return send(200, { success: true, ...result });
  } catch (e) {
    return send(500, { error: e.message, recorded: !!e.recorded });
  }
};
