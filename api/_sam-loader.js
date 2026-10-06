'use strict';
// SAM.gov exclusions loader (runs as a Vercel Node function, not an Edge Function).
//
// Why here: Supabase Edge Functions are capped at about 256 MB of memory and 2 seconds of CPU, and the
// real SAM.gov file (79 MB of CSV, 169,000 rows, every field quoted) was stopped there. This runs on
// Node with no such cap and is tested end to end against the real file.
//
// What it does, once a day:  download SAM.gov's daily Exclusions extract (one request, the key is allowed
// 10 a day) -> unzip -> read the CSV (quote-aware: line breaks and quotes inside fields are fine) ->
// keep the individuals -> store them in public.sam_exclusions in batches -> swap the new list in only
// when it is COMPLETE (sam_finalize_load). A failed or partial run changes nothing.
//
// No dependencies: Node built-ins and fetch only. The API key and the database key are never logged.

const zlib = require('zlib');

const EXTRACTS_URL = 'https://api.sam.gov/data-services/v1/extracts';   // production. NOT api-alpha (the test system)
const BATCH_SIZE = 5000;
const CONCURRENCY = 3;
const MAX_UNZIPPED = 600 * 1024 * 1024;       // refuse anything larger than this once unpacked
const MAX_BAD_ROWS = 50;                        // a few oddly shaped rows are tolerated; more than this and the file is not what we expect

// Columns we need, by NAME (not position), so a re-ordered file still loads correctly.
const NEEDED = ['Classification', 'First', 'Middle', 'Last', 'Suffix', 'State / Province', 'NPI',
                'Exclusion Type', 'Exclusion Program', 'Excluding Agency', 'Active Date', 'Termination Date', 'SAM Number'];

const redact = (s, secrets = []) => {
  let out = String(s == null ? '' : s);
  for (const k of secrets) if (k) out = out.split(k).join('[key]');
  return out.replace(/api_key=[^&\s"']+/gi, 'api_key=[key]');
};

// ── ZIP: read the entry's exact sizes from the index at the end, then inflate ──────────────
function readZip(buf) {
  if (buf.length < 22 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('The download is not a ZIP file.');
  let e = buf.length - 22;
  const stop = Math.max(0, buf.length - 22 - 65535);
  while (e >= stop && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < stop) throw new Error('The ZIP file is incomplete (its index is missing), so it was not loaded.');
  const cdOffset = buf.readUInt32LE(e + 16);
  if (cdOffset === 0xFFFFFFFF || cdOffset + 46 > buf.length || buf.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error('The ZIP file index could not be read.');
  const method = buf.readUInt16LE(cdOffset + 10);
  const csize = buf.readUInt32LE(cdOffset + 20), usize = buf.readUInt32LE(cdOffset + 24);
  const nameLen = buf.readUInt16LE(cdOffset + 28);
  const localOffset = buf.readUInt32LE(cdOffset + 42);
  const name = buf.toString('utf8', cdOffset + 46, cdOffset + 46 + nameLen);
  if (csize === 0xFFFFFFFF || usize === 0xFFFFFFFF) throw new Error('The ZIP file uses a format this loader does not handle (zip64).');
  if (usize > MAX_UNZIPPED) throw new Error(`The unpacked file would be ${Math.round(usize / 1048576)} MB, which is more than expected, so it was not loaded.`);
  if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('The ZIP file entry could not be read.');
  const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
  if (start + csize > buf.length) throw new Error(`The download ended early (${buf.length} bytes, expected at least ${start + csize}), so nothing was loaded.`);
  const packed = buf.subarray(start, start + csize);
  let data;
  if (method === 8) data = zlib.inflateRawSync(packed, { maxOutputLength: MAX_UNZIPPED });
  else if (method === 0) data = packed;
  else throw new Error(`The ZIP uses compression method ${method}, which is not supported.`);
  if (data.length !== usize) throw new Error(`The file unpacked to ${data.length} bytes but the ZIP says ${usize}, so it was not loaded.`);
  return { name, data };
}

// ── CSV: a real quote-aware reader (RFC 4180): "" is a quote, line breaks inside quotes are kept ──
function readCsv(text, onRecord) {
  const n = text.length;
  let pos = 0, count = 0;
  if (text.charCodeAt(0) === 0xFEFF) pos = 1;                       // a byte-order mark, if any
  while (pos < n) {
    const fields = [];
    for (;;) {
      let value;
      if (text.charCodeAt(pos) === 34) {                              // a quoted field
        let j = pos + 1, start = j, acc = null;
        for (;;) {
          const k = text.indexOf('"', j);
          if (k < 0) throw new Error(`The CSV ends inside a quoted field (row ${count + 1}).`);
          if (text.charCodeAt(k + 1) === 34) { acc = (acc === null ? '' : acc) + text.slice(start, k + 1); j = start = k + 2; continue; }
          value = acc === null ? text.slice(start, k) : acc + text.slice(start, k);
          pos = k + 1; break;
        }
      } else {                                                         // an unquoted field
        let k = pos;
        while (k < n) { const c = text.charCodeAt(k); if (c === 44 || c === 10 || c === 13) break; k++; }
        value = text.slice(pos, k); pos = k;
      }
      fields.push(value);
      const c = text.charCodeAt(pos);
      if (c === 44) { pos++; continue; }
      if (c === 13) { pos++; if (text.charCodeAt(pos) === 10) pos++; }
      else if (c === 10) pos++;
      else if (pos < n) throw new Error(`Unexpected text after a field (row ${count + 1}).`);
      break;
    }
    count++;
    onRecord(fields, count);
  }
  return count;
}

// 2026277 -> '2026-10-04' for names like SAM_Exclusions_Public_Extract_V2_26277.CSV
function julianToIso(name) {
  const m = /(\d{2})(\d{3})(?=\D*$)/.exec(String(name).replace(/\.\w+$/, ''));
  if (!m) return null;
  const d = new Date(Date.UTC(2000 + parseInt(m[1], 10), 0, parseInt(m[2], 10)));
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// ── Turn the CSV into the rows we store (individuals only) ────────────────────────────────
function extractIndividuals(csvText, loadId) {
  const rows = [];
  let header = null, idx = null, total = 0, bad = 0;
  const count = readCsv(csvText, (f, n) => {
    if (header === null) {
      header = f.map((h) => h.trim());
      idx = {};
      for (const name of NEEDED) {
        const i = header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
        if (i < 0) throw new Error(`The SAM.gov file has no "${name}" column. Its layout may have changed. Found: ${header.slice(0, 40).join(', ')}.`);
        idx[name] = i;
      }
      // Optional: SAM.gov's list of other names for a person ("(also Jose Ibarra GOMEZ, ...)"). If a future file lacks it the load still works, just without aliases.
      idx['Cross-Reference'] = header.findIndex((h) => h.toLowerCase() === 'cross-reference');
      return;
    }
    total++;
    if (f.length !== header.length) { if (++bad > MAX_BAD_ROWS) throw new Error(`More than ${MAX_BAD_ROWS} rows do not have the expected ${header.length} columns (row ${n} has ${f.length}). The file is not in the expected format, so nothing was loaded.`); return; }
    if (f[idx.Classification] !== 'Individual') return;                // firms, vessels and special entities are not people
    const v = (k) => (f[idx[k]] || '').trim() || null;
    rows.push({
      load_id: loadId, sam_number: v('SAM Number'), first_name: v('First'), middle_name: v('Middle'), last_name: v('Last'), suffix: v('Suffix'),
      state: v('State / Province'), npi: (f[idx.NPI] || '').replace(/\D/g, '') || null, exclusion_type: v('Exclusion Type'),
      exclusion_program: v('Exclusion Program'), excluding_agency: v('Excluding Agency'), active_date: v('Active Date'), termination_date: v('Termination Date'),
      cross_reference: v('Cross-Reference'),
    });
  });
  if (header === null) throw new Error('The SAM.gov file is empty.');
  return { rows, total, bad, columns: header.length };
}

// ── Database access through PostgREST (service role) ──────────────────────────────────────
function makeDb(url, key, fetchImpl) {
  const base = url.replace(/\/+$/, '');
  // Supabase has two kinds of secret key. The older service_role key is a JWT (three parts, starts "eyJ") and
  // is sent as both apikey and Authorization. The newer "sb_secret_..." key is NOT a JWT: it goes in the apikey
  // header ONLY, and sending it as a Bearer token is rejected as an invalid JWT. Either kind works here.
  const isJwt = String(key).split('.').length === 3;
  const headers = { apikey: key, ...(isJwt ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' };
  return {
    async rpc(fn, args) {
      const r = await fetchImpl(`${base}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args || {}) });
      const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch { /* not JSON */ }
      if (!r.ok) throw new Error(`${fn}: ${(j && (j.message || j.error)) || t.slice(0, 200) || 'HTTP ' + r.status}`);
      return j;
    },
    async remove(table, filter) {
      const r = await fetchImpl(`${base}/rest/v1/${table}?${filter}`, { method: 'DELETE', headers: { ...headers, Prefer: 'return=minimal' } });
      if (!r.ok) { const t = await r.text(); throw new Error(`Could not remove the test rows: ${t.slice(0, 200)}`); }
    },
    async insert(table, rows) {
      const r = await fetchImpl(`${base}/rest/v1/${table}`, { method: 'POST', headers: { ...headers, Prefer: 'return=minimal' }, body: JSON.stringify(rows) });
      if (!r.ok) { const t = await r.text(); let m = t; try { m = JSON.parse(t).message || t; } catch { /* keep text */ } throw new Error(`Could not store the list: ${String(m).slice(0, 200)}`); }
    },
  };
}

async function runWithLimit(items, limit, fn) {
  let next = 0; const workers = [];
  const failures = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) {
    workers.push((async () => { for (;;) { const i = next++; if (i >= items.length || failures.length) return; try { await fn(items[i], i); } catch (e) { failures.push(e); return; } } })());
  }
  await Promise.all(workers);
  if (failures.length) throw failures[0];
}

// ── The whole refresh ─────────────────────────────────────────────────────────────────────
async function runRefresh({ samKey, supabaseUrl, serviceKey, fetchImpl = fetch, log = () => {}, now = () => Date.now() }) {
  const secrets = [samKey, serviceKey];
  if (!samKey) throw new Error('No SAM.gov API key was supplied.');
  if (!supabaseUrl || !serviceKey) throw new Error('The worker has no database address or key. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the Vercel project.');
  const db = makeDb(supabaseUrl, serviceKey, fetchImpl);
  const t0 = now();
  const step = (m) => log(`[sam] ${m} (${Math.round(now() - t0)} ms)`);
  const loadId = (globalThis.crypto && globalThis.crypto.randomUUID) ? globalThis.crypto.randomUUID() : require('crypto').randomUUID();
  let recorded = false;
  try {
    step('start');
    await db.rpc('sam_cleanup_partial');                              // anything left behind by an interrupted run

    // fileType=EXCLUSION with no date = the most recent daily file (all active exclusions)
    const res = await fetchImpl(`${EXTRACTS_URL}?api_key=${encodeURIComponent(samKey)}&fileType=EXCLUSION`, { redirect: 'follow' });
    step(`SAM.gov answered HTTP ${res.status}, ${res.headers.get('content-type') || 'no content-type'}, content-length ${res.headers.get('content-length') || 'unknown'}`);
    if (res.status === 401 || res.status === 403) throw new Error(`SAM.gov rejected the API key (HTTP ${res.status}). SAM.gov keys expire, reportedly every 90 days: sign in at sam.gov, request a new Public API Key on Account Details, and update the SAM_API_KEY secret.`);
    if (res.status === 429) throw new Error("SAM.gov's daily request limit was reached for this key (10 a day for a personal key). It resets at midnight UTC.");
    const buf = Buffer.from(await res.arrayBuffer());
    if (!res.ok || buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
      let msg = buf.toString('utf8', 0, 2000);
      try { const j = JSON.parse(msg); msg = j.message || j.error || j.errorMessage || JSON.stringify(j); } catch { msg = msg.slice(0, 300); }
      throw new Error(`SAM.gov did not return the file (HTTP ${res.status}): ${redact(msg, secrets).slice(0, 300)}`);
    }
    step(`downloaded ${buf.length} bytes`);

    const { name, data } = readZip(buf);
    step(`unpacked ${name}: ${data.length} bytes`);
    const text = data.toString('utf8');
    const { rows, total, bad, columns } = extractIndividuals(text, loadId);
    step(`read ${total} rows (${columns} columns${bad ? `, ${bad} oddly shaped row(s) skipped` : ''}), ${rows.length} individuals`);
    if (!total) throw new Error('The SAM.gov file had no records.');
    if (!rows.length) throw new Error('The SAM.gov file contained no individuals, so the current list was kept.');

    const batches = [];
    for (let i = 0; i < rows.length; i += BATCH_SIZE) batches.push(rows.slice(i, i + BATCH_SIZE));
    let stored = 0;
    await runWithLimit(batches, CONCURRENCY, async (b) => { await db.insert('sam_exclusions', b); stored += b.length; });
    step(`stored ${stored} individuals in ${batches.length} batches`);

    const iso = julianToIso(name);
    const source = `SAM.gov exclusions extract${iso ? ' dated ' + iso : ''} (${name})`;
    const n = await db.rpc('sam_finalize_load', { p_load: loadId, p_source: source, p_total: total });
    step(`finalized ${n} individuals`);
    return { individuals: typeof n === 'number' ? n : stored, total_rows: total, source, elapsed_ms: Math.round(now() - t0) };
  } catch (e) {
    const msg = redact(e && e.message ? e.message : e, secrets);
    log(`[sam] FAILED: ${msg}`);
    try { await db.rpc('sam_fail_load', { p_load: loadId, p_error: msg }); recorded = true; } catch { /* the database itself may be what failed */ }
    const err = new Error(msg); err.recorded = recorded; throw err;
  }
}

// ── A safe rehearsal: proves the worker can reach the database, and times it, WITHOUT calling SAM.gov ──
// Writes dummy rows under a throwaway load id (never the current list, so no check can ever see them), then
// removes them. If removal fails they are still harmless: the next real refresh clears them (sam_cleanup_partial).
async function runSelfTest({ supabaseUrl, serviceKey, fetchImpl = fetch, rows = 12000, now = () => Date.now() }) {
  if (!supabaseUrl || !serviceKey) throw new Error('The worker has no database address or key. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the Vercel project.');
  const secrets = [serviceKey];
  const db = makeDb(supabaseUrl, serviceKey, fetchImpl);
  const keyKind = String(serviceKey).split('.').length === 3 ? 'legacy service_role key' : String(serviceKey).startsWith('sb_secret_') ? 'new sb_secret key' : 'unrecognised key format';
  const id = (globalThis.crypto && globalThis.crypto.randomUUID) ? globalThis.crypto.randomUUID() : require('crypto').randomUUID();
  const t0 = now();
  try {
    await db.rpc('sam_current_load');                                  // read-only: proves the key may call the database functions
    const data = Array.from({ length: rows }, (_, i) => ({ load_id: id, sam_number: `SELFTEST-${i}`, first_name: 'SELFTEST', middle_name: null, last_name: 'DELETEME', suffix: null,
      state: 'ZZ', npi: null, exclusion_type: 'Self test', exclusion_program: null, excluding_agency: 'Selko', active_date: '2026-01-01', termination_date: 'Indefinite' }));
    const batches = [];
    for (let i = 0; i < data.length; i += BATCH_SIZE) batches.push(data.slice(i, i + BATCH_SIZE));
    const tIns = now();
    let removed = false;
    try {
      await runWithLimit(batches, CONCURRENCY, async (b) => { await db.insert('sam_exclusions', b); });
    } finally {
      try { await db.remove('sam_exclusions', `load_id=eq.${id}`); removed = true; } catch (e) { removed = false; }
    }
    const insertMs = Math.round(now() - tIns);
    const FULL = 133835;                                                // individuals in the real file on 2026-10-04
    return { rows, batches: batches.length, insert_ms: insertMs, total_ms: Math.round(now() - t0), key_kind: keyKind, test_rows_removed: removed,
             est_full_ms: Math.round(insertMs * (FULL / rows) + 3500) };
  } catch (e) {
    const err = new Error(redact(e && e.message ? e.message : e, secrets)); throw err;
  }
}

module.exports = { runRefresh, runSelfTest, readZip, readCsv, extractIndividuals, julianToIso, redact, makeDb, NEEDED };
