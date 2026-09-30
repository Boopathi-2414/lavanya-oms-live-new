import { CACHE_PREFIX } from './environment.js';
// ============================================================
// SUPABASE — core data sync (orders / payments / products / trash / fraudList)
// ============================================================
// FIX v7: Added persistent sync queue — if Supabase is unreachable when
// a save happens, the changes are queued in localStorage and retried
// automatically when the connection comes back. No data loss even if
// window is closed — queue persists across sessions.

import { getClient, isSupabaseConfigured } from './supabase.js';

const TABLES = {
  businessRecords: 'oms_business_records',
  orders:    'oms_orders',
  payments:  'oms_payments',
  products:  'oms_products',
  trash:     'oms_trash',
  fraudList: 'oms_fraud_list',
};

// ── UNSYNCED-RECORD OUTBOX ───────────────────────────────────
// The set of record ids that have been changed on this device but not
// yet CONFIRMED written to Supabase. Persisted in localStorage, so it
// survives a tab close, a crash or going offline mid-shift.
//
// WHY THIS EXISTS (bug report Aug 2026 — the "fast scanning loses
// parcels" problem): refreshFromSupabase() fetches the whole database
// and then overwrites local state with the result. That fetch takes
// seconds on a 20k-order account, and any scan made during it was
// simply erased when the fetch landed — erased locally AND erased from
// the sync diff baseline, so it never reached Supabase either and the
// parcel had to be re-scanned. Reproduced deterministically: 6 scans
// during one refresh, 3 survived.
//
// With this outbox, a record stays flagged until Supabase actually
// confirms it, and a refresh is never allowed to overwrite a flagged
// record. Nothing can be lost by a race, only delayed.
const OUTBOX_KEY = CACHE_PREFIX + 'unsynced_ids_v1';

export function loadOutbox() {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    const out = {};
    Object.keys(TABLES).forEach((k) => { out[k] = new Set(obj[k] || []); });
    return out;
  } catch (_) {
    const out = {}; Object.keys(TABLES).forEach((k) => { out[k] = new Set(); }); return out;
  }
}

export function saveOutbox(outbox) {
  try {
    const obj = {};
    Object.keys(TABLES).forEach((k) => { obj[k] = [...(outbox[k] || [])]; });
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(obj));
  } catch (_) {}
}

export function outboxCount(outbox) {
  return Object.keys(TABLES).reduce((n, k) => n + (outbox?.[k]?.size || 0), 0);
}

// ── PENDING QUEUE (persists in localStorage across sessions) ──
const QUEUE_KEY = CACHE_PREFIX + 'sync_queue_v1';

function loadQueue() {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

function saveQueue(db) {
  try {
    if (db) localStorage.setItem(QUEUE_KEY, JSON.stringify(db));
    else localStorage.removeItem(QUEUE_KEY);
  } catch (_) {}
}

function clearQueue() {
  localStorage.removeItem(QUEUE_KEY);
}

// Retry pending queue on startup / when connection returns
export async function flushPendingQueue() {
  const pending = loadQueue();
  if (!pending) return;
  if (!isSupabaseConfigured()) return;
  const client = await getClient().catch(() => null);
  if (!client) return;

  console.log('[OMS] Flushing pending sync queue...');
  let allOk = true;

  await Promise.all(Object.keys(TABLES).map(async (key) => {
    const table = TABLES[key];
    const arr = pending[key] || [];
    if (!arr.length) return;
    const toUpsert = arr.map((r) => ({ id: r.id, data: r, updated_at: new Date().toISOString() }));
    try {
      const { error } = await client.from(table).upsert(toUpsert, { onConflict: 'id' });
      if (error) throw error;
    } catch (e) {
      console.error(`[OMS] Queue flush failed for ${table}:`, e);
      allOk = false;
    }
  }));

  if (allOk) {
    clearQueue();
    console.log('[OMS] Pending queue flushed successfully.');
  }
}

function rowsToArray(rows) {
  return (rows || []).map((r) => ({ ...(r.data || {}), id: r.id }));
}

// Fetches the current, real, shared data straight from Supabase — no
// cache, no localStorage involved.
export async function fetchFreshDB() {
  if (!isSupabaseConfigured()) throw new Error('not_configured');
  const client = await getClient();
  if (!client) throw new Error('not_configured');

  // Supabase free plan default limit = 1000 rows per query.
  // We use pagination (range) to fetch ALL rows — no cap.
  async function fetchAllRows(table) {
    const PAGE_SIZE = 1000;
    let allRows = [];
    let from = 0;
    while (true) {
      // Ordered by `id`, which is the primary key and therefore unique
      // and stable. This used to order by `updated_at`: that column is
      // NOT unique — a bulk import or a batched scan sync stamps
      // hundreds of rows with the same value, and Postgres is free to
      // return equal-ranked rows in any order between one page query
      // and the next. On a 20k-order account that silently duplicated
      // some rows across page boundaries and skipped others entirely,
      // and because the fetch result overwrites localStorage, a skipped
      // order simply vanished from the app.
      const { data, error } = await client
        .from(table)
        .select('id, data')
        .order('id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      allRows = allRows.concat(data || []);
      if (!data || data.length < PAGE_SIZE) break; // last page
      from += PAGE_SIZE;
    }
    return allRows;
  }

  const results = await Promise.all(
    Object.keys(TABLES).map(async (key) => {
      const rows = await fetchAllRows(TABLES[key]);
      return [key, rowsToArray(rows)];
    })
  );

  return Object.fromEntries(results);
}

// Snapshot = Map<id, json-string> per collection — used as diff baseline
export function snapshotIds(db) {
  const snap = {};
  Object.keys(TABLES).forEach((key) => {
    const m = new Map();
    (db?.[key] || []).forEach((r) => { if (r?.id) m.set(r.id, JSON.stringify(r)); });
    snap[key] = m;
  });
  return snap;
}

// ── mergeUnsyncedOverFresh ───────────────────────────────────
// Overlay every still-unconfirmed local record on top of a freshly
// fetched server copy.
//
// This is what makes a refresh safe to run at any moment, including
// in the middle of a scanning burst. Records the server knows about
// come from `fresh` (so other devices' work still lands); records this
// device has changed but Supabase has not yet acknowledged come from
// `local` and win, because the server copy of those is stale by
// definition. A record that only exists locally is appended rather
// than dropped.
export function mergeUnsyncedOverFresh(fresh, local, outbox) {
  const merged = { ...fresh };
  Object.keys(TABLES).forEach((key) => {
    const ids = outbox?.[key];
    if (!ids || !ids.size) { merged[key] = fresh?.[key] || []; return; }
    const localById = new Map((local?.[key] || []).map((r) => [r?.id, r]).filter(([id]) => id));
    const out = [];
    const seen = new Set();
    for (const row of fresh?.[key] || []) {
      if (row?.id && ids.has(row.id) && localById.has(row.id)) {
        out.push(localById.get(row.id)); // unsynced local change wins
      } else {
        out.push(row);
      }
      if (row?.id) seen.add(row.id);
    }
    // Unsynced records the server has never seen at all.
    for (const id of ids) {
      if (!seen.has(id) && localById.has(id)) out.push(localById.get(id));
    }
    merged[key] = out;
  });
  return merged;
}

// Merge local records that are missing from Supabase (for migration)
export function mergeMissingLocalIntoFresh(freshDb, localDb) {
  const merged = { ...freshDb };
  Object.keys(TABLES).forEach((key) => {
    const freshIds = new Set((freshDb[key] || []).map((r) => r.id));
    const missing = (localDb[key] || []).filter((r) => r?.id && !freshIds.has(r.id));
    if (missing.length) merged[key] = [...(freshDb[key] || []), ...missing];
  });
  return merged;
}

// ── MAIN SYNC ────────────────────────────────────────────────
// Diffs nextDb against prevSnapshot, upserts only changed rows.
// On failure: saves entire DB to pending queue so next session retries.
export async function syncDBToSupabase(nextDb, prevSnapshot) {
  if (!isSupabaseConfigured()) {
    return { ok: false, errors: ['not_configured'], snapshot: prevSnapshot };
  }
  const client = await getClient().catch(() => null);
  if (!client) {
    // Save to queue so it retries next time
    saveQueue(nextDb);
    return { ok: false, errors: ['not_configured'], snapshot: prevSnapshot };
  }

  const errors = [];
  const nextSnapshot = {};

  await Promise.all(Object.keys(TABLES).map(async (key) => {
    const table = TABLES[key];
    const arr = nextDb?.[key] || [];
    const prevMap = prevSnapshot?.[key] || new Map();
    const nextMap = new Map();
    const toUpsert = [];

    arr.forEach((r) => {
      if (!r || !r.id) return;
      const json = JSON.stringify(r);
      nextMap.set(r.id, json);
      if (prevMap.get(r.id) !== json) {
        toUpsert.push({ id: r.id, data: r, updated_at: new Date().toISOString() });
      }
    });

    const toDelete = [...prevMap.keys()].filter((id) => !nextMap.has(id));

    try {
      if (toUpsert.length) {
        const { error } = await client.from(table).upsert(toUpsert, { onConflict: 'id' });
        if (error) throw error;
      }
      if (toDelete.length) {
        const { error } = await client.from(table).delete().in('id', toDelete);
        if (error) throw error;
      }
      nextSnapshot[key] = nextMap;
    } catch (e) {
      console.error(`[OMS] Supabase sync failed for ${table}:`, e);
      errors.push(key);
      nextSnapshot[key] = prevMap;
    }
  }));

  if (errors.length > 0) {
    // Save to persistent queue — will retry on next session/load
    saveQueue(nextDb);
    console.log('[OMS] Sync failed, saved to pending queue for retry.');
  } else {
    // All ok — clear any pending queue
    clearQueue();
  }

  return { ok: errors.length === 0, errors, snapshot: nextSnapshot };
}

// ── REALTIME ─────────────────────────────────────────────────
export function subscribeToChanges(onChange) {
  if (!isSupabaseConfigured()) return () => {};
  let client;
  let channel;
  let debounceTimer;

  getClient().then((c) => {
    client = c;
    if (!client) return;
    channel = client
      .channel('oms-realtime-all')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'oms_business_records' }, () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(onChange, 800); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'oms_orders' },    () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(onChange, 800); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'oms_payments' },  () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(onChange, 800); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'oms_products' },  () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(onChange, 800); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'oms_trash' },     () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(onChange, 800); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'oms_fraud_list' },() => { clearTimeout(debounceTimer); debounceTimer = setTimeout(onChange, 800); })
      .subscribe();
  });

  return () => {
    clearTimeout(debounceTimer);
    if (channel && client) client.removeChannel(channel);
  };
}

export async function fetchCourierBreakdown() {
  if (!isSupabaseConfigured()) return {};
  try {
    const client = await getClient();
    if (!client) return {};
    const { data, error } = await client
      .from('oms_orders')
      .select('data')
      .eq('data->>status', 'Dispatched');
    if (error) throw error;
    const breakdown = {};
    (data || []).forEach(({ data: d }) => {
      const courier = d?.courier || 'Unknown';
      breakdown[courier] = (breakdown[courier] || 0) + 1;
    });
    return breakdown;
  } catch (e) {
    console.error('[OMS] fetchCourierBreakdown failed:', e);
    return {};
  }
}

export async function migrateHistoricalData(onProgress) {
  // No-op stub — migration already done
  if (onProgress) onProgress(100);
}
