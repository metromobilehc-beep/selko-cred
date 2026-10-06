'use strict';
// OIG LEIE loader (runs as a Vercel Node function, like the SAM.gov one).
//
// Once a month it downloads OIG's "Updated LEIE Database" CSV (free: no key, no daily limit), keeps the individuals
// (80,544 of the 84,001 records in the file this was built against), and stores them in public.leie_exclusions in
// batches. The new list replaces the old one only when it is COMPLETE (leie_finalize_load): a failed or partial
// run changes nothing.
//
// The address of the file is not trusted blindly: the known address is tried first, then the real link is found on OIG's
// own download pages, and whatever is downloaded must LOOK like the LEIE (right columns, plausible size) before it is used.
//
// Shares the CSV reader and the database helper with the SAM.gov loader (_sam-loader.js). No dependencies.

const { readCsv, makeDb, redact } = require('./_sam-loader.js');

const DIRECT_URL = 'https://oig.hhs.gov/exclusions/downloadables/UPDATED.csv';
const PAGES = ['https://oig.hhs.gov/exclusions/exclusions_list.asp', 'https://oig.hhs.gov/exclusions/leie-database-supplement-downloads/'];
const BATCH_SIZE = 5000;
const CONCURRENCY = 3;
const MAX_BYTES = 200 * 1024 * 1024;
const MIN_BYTES = 1024 * 1024;               // the real file is about 15 MB; anything under 1 MB is not the list
const MIN_INDIVIDUALS = 40000;               // the real file has about 80,000
const MAX_BAD_ROWS = 50;
const REQUIRED = ['LASTNAME', 'FIRSTNAME', 'MIDNAME', 'GENERAL', 'SPECIALTY', 'NPI', 'DOB', 'CITY', 'STATE', 'EXCLTYPE', 'EXCLDATE', 'REINDATE', 'WAIVERDATE', 'WVRSTATE'];

// "20200319" -> "2020-03-19"; the all-zero date, blanks and impossible dates -> null
function isoDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(s || '').trim());
  if (!m || m[0] === '00000000') return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1850 || y > 2100 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}
// An NPI is exactly 10 digits and not one repeated digit. 90% of the file carries the placeholder 0000000000, stored as null.
function cleanNpi(s) {
  const d = String(s || '').replace(/\D/g, '');
  return /^\d{10}$/.test(d) && !/^(\d)\1+$/.test(d) ? d : null;
}

function headerLooksRight(fields) {
  const have = new Set(fields.map((f) => String(f).replace(/^\uFEFF/, '').trim().toUpperCase()));
  return REQUIRED.every((c) => have.has(c));
}

// Reads just the first few KB of a candidate address, to learn whether it is the LEIE, without downloading all of it.
async function probe(url, fetchImpl, timeoutMs = 30000) {
  const res = await fetchImpl(url, { redirect: 'follow', headers: { Range: 'bytes=0-4095' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return { ok: false, url, why: `HTTP ${res.status}` };
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  let head = '';
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader(); const { value } = await reader.read();
    try { await reader.cancel(); } catch { /* the rest is not needed */ }
    head = Buffer.from(value || []).toString('utf8', 0, 4096);
  } else head = Buffer.from(await res.arrayBuffer()).toString('utf8', 0, 4096);
  if (/^\s*</.test(head) || ct.includes('text/html')) return { ok: false, url, why: 'it is a web page, not the CSV' };
  const first = head.split(/\r?\n/)[0] || '';
  let fields = []; try { readCsv(first + '\n', (f) => { fields = f; }); } catch { /* not CSV */ }
  if (!headerLooksRight(fields)) return { ok: false, url, why: 'its columns are not the LEIE layout' };
  const range = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
  return { ok: true, url, bytes: range ? +range[1] : (+res.headers.get('content-length') || null), last_modified: res.headers.get('last-modified') || null };
}

// Finds file links on OIG's download pages (in case the address has moved).
async function discover(fetchImpl, log = () => {}) {
  const found = [];
  for (const page of PAGES) {
    try {
      const res = await fetchImpl(page, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
      if (!res.ok) { log(`[leie] page ${page} answered HTTP ${res.status}`); continue; }
      const html = await res.text();
      for (const m of html.matchAll(/href\s*=\s*["']([^"']+?\.csv(?:\?[^"']*)?)["']/gi)) {
        const href = m[1].replace(/&amp;/g, '&');
        // the full database is called UPDATED.csv; the monthly supplements (…EXCL.csv, …REIN.csv) are partial and must not be used
        if (/updated/i.test(href) && !/excl\.csv|rein\.csv/i.test(href)) { try { found.push(new URL(href, page).toString()); } catch { /* not a usable link */ } }
      }
    } catch (e) { log(`[leie] page ${page} could not be read: ${redact(e && e.message)}`); }
  }
  return [...new Set(found)];
}

async function locate(fetchImpl, log = () => {}) {
  const tried = [];
  const tryUrl = async (u) => {
    try { const p = await probe(u, fetchImpl); tried.push(`${u}: ${p.ok ? 'ok' : p.why}`); return p.ok ? p : null; }
    catch (e) { tried.push(`${u}: ${redact(e && e.message)}`); return null; }
  };
  let p = await tryUrl(DIRECT_URL);
  if (p) return p;
  log('[leie] the known address did not work; looking for the link on OIG\'s download pages');
  for (const u of await discover(fetchImpl, log)) { if (u === DIRECT_URL) continue; p = await tryUrl(u); if (p) return p; }
  const err = new Error(`The OIG LEIE file could not be found. Tried: ${tried.join('; ')}.`);
  err.tried = tried; throw err;
}

// ── Turn the file into the rows we store ───────────────────────────────────────────
function extractIndividuals(csvText, loadId) {
  const rows = []; let header = null, idx = null, total = 0, bad = 0, entities = 0, reinstated = 0;
  readCsv(csvText, (f, n) => {
    if (header === null) {
      header = f.map((h) => String(h).replace(/^\uFEFF/, '').trim().toUpperCase());
      if (!headerLooksRight(header)) throw new Error(`The file is not in the OIG LEIE layout. Found columns: ${header.slice(0, 20).join(', ')}.`);
      idx = {}; header.forEach((h, i) => { idx[h] = i; });
      return;
    }
    total++;
    if (f.length !== header.length) { if (++bad > MAX_BAD_ROWS) throw new Error(`More than ${MAX_BAD_ROWS} rows do not have the expected ${header.length} columns (row ${n} has ${f.length}). The file is not in the expected format, so nothing was loaded.`); return; }
    const v = (k) => (f[idx[k]] || '').trim();
    if (!v('LASTNAME')) { entities++; return; }                  // a business: not a person on anyone's staff
    const rein = isoDate(v('REINDATE'));
    if (rein) { reinstated++; return; }                          // reinstated: no longer excluded (the real file has none, but the rule is OIG's own)
    rows.push({ load_id: loadId, first_name: v('FIRSTNAME') || null, middle_name: v('MIDNAME') || null, last_name: v('LASTNAME'), general: v('GENERAL') || null, specialty: v('SPECIALTY') || null,
      npi: cleanNpi(v('NPI')), dob: isoDate(v('DOB')), city: v('CITY') || null, state: v('STATE') || null, excl_type: v('EXCLTYPE') || null,
      excl_date: isoDate(v('EXCLDATE')), rein_date: null, waiver_date: isoDate(v('WAIVERDATE')), waiver_state: v('WVRSTATE') || null });
  });
  if (header === null) throw new Error('The OIG file is empty.');
  return { rows, total, bad, entities, reinstated };
}

async function runWithLimit(items, limit, fn) {
  let next = 0; const failures = [];
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) { const i = next++; if (i >= items.length || failures.length) return; try { await fn(items[i], i); } catch (e) { failures.push(e); return; } }
  }));
  if (failures.length) throw failures[0];
}

// ── The whole refresh ──────────────────────────────────────────────────────────────
async function runLeieRefresh({ supabaseUrl, serviceKey, fetchImpl = fetch, log = () => {}, now = () => Date.now() }) {
  const secrets = [serviceKey];
  if (!supabaseUrl || !serviceKey) throw new Error('The worker has no database address or key. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the Vercel project.');
  const db = makeDb(supabaseUrl, serviceKey, fetchImpl);
  const t0 = now(); const step = (m) => log(`[leie] ${m} (${Math.round(now() - t0)} ms)`);
  const loadId = (globalThis.crypto && globalThis.crypto.randomUUID) ? globalThis.crypto.randomUUID() : require('crypto').randomUUID();
  let recorded = false;
  try {
    step('start');
    await db.rpc('leie_cleanup_partial');
    const where = await locate(fetchImpl, log);
    step(`found the file at ${where.url}`);
    const res = await fetchImpl(where.url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`OIG answered HTTP ${res.status} when the file was downloaded.`);
    const buf = Buffer.from(await res.arrayBuffer());
    step(`downloaded ${buf.length} bytes`);
    if (buf.length < MIN_BYTES) throw new Error(`The download is only ${buf.length} bytes, which is too small to be the LEIE (about 15 MB), so nothing was loaded.`);
    if (buf.length > MAX_BYTES) throw new Error(`The download is ${Math.round(buf.length / 1048576)} MB, which is far larger than the LEIE, so nothing was loaded.`);
    const { rows, total, bad, entities, reinstated } = extractIndividuals(buf.toString('utf8'), loadId);
    step(`read ${total} records: ${rows.length} individuals, ${entities} businesses${reinstated ? `, ${reinstated} reinstated` : ''}${bad ? `, ${bad} oddly shaped row(s) skipped` : ''}`);
    if (rows.length < MIN_INDIVIDUALS) throw new Error(`Only ${rows.length} individuals were found (the LEIE has about 80,000), so the file looks damaged and nothing was loaded.`);
    const batches = []; for (let i = 0; i < rows.length; i += BATCH_SIZE) batches.push(rows.slice(i, i + BATCH_SIZE));
    let stored = 0;
    await runWithLimit(batches, CONCURRENCY, async (b) => { await db.insert('leie_exclusions', b); stored += b.length; });
    step(`stored ${stored} individuals in ${batches.length} batches`);
    const modified = where.last_modified && !isNaN(Date.parse(where.last_modified)) ? new Date(where.last_modified).toISOString().slice(0, 10) : null;
    const source = `OIG LEIE database (UPDATED.csv), downloaded ${new Date(now()).toISOString().slice(0, 10)}${modified ? `, file dated ${modified}` : ''}`;
    const n = await db.rpc('leie_finalize_load', { p_load: loadId, p_source: source, p_total: total });
    step(`finalized ${n} individuals`);
    return { individuals: typeof n === 'number' ? n : stored, total_rows: total, entities, source, elapsed_ms: Math.round(now() - t0) };
  } catch (e) {
    const msg = redact(e && e.message ? e.message : e, secrets);
    log(`[leie] FAILED: ${msg}`);
    try { await db.rpc('leie_fail_load', { p_load: loadId, p_error: msg }); recorded = true; } catch { /* the database itself may be what failed */ }
    const err = new Error(msg); err.recorded = recorded; throw err;
  }
}

module.exports = { runLeieRefresh, extractIndividuals, locate, probe, discover, isoDate, cleanNpi, headerLooksRight, DIRECT_URL, PAGES };
