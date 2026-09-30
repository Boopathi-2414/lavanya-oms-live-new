import BusinessHub from './components/BusinessHub.jsx';
import { exportRows } from './businessLogic.js';
import { backupLocal } from './automaticBackup.js';
import { version } from '../package.json';
import { useState, useEffect, useCallback, useRef } from 'react';
import { loadDB, saveDB } from './db.js';
import { journalDispatch } from './dispatchJournal.js';
import * as XLSX from 'xlsx';
import { today } from './db.js';
import { isSupabaseConfigured } from './supabase.js';
import { fetchFreshDB, syncDBToSupabase, snapshotIds, mergeMissingLocalIntoFresh, subscribeToChanges, migrateHistoricalData, flushPendingQueue, loadOutbox, saveOutbox, outboxCount, mergeUnsyncedOverFresh } from './supabaseData.js';

import ToastContainer, { toast } from './components/Toast.jsx';

import Dashboard      from './components/Dashboard.jsx';
import Sales          from './components/Sales.jsx';
import Dispatch       from './components/Dispatch.jsx';
import Returns        from './components/Returns.jsx';
import Received       from './components/Received.jsx';
import Payments       from './components/Payments.jsx';
import Products       from './components/Products.jsx';
import Reports        from './components/Reports.jsx';
import Trash          from './components/Trash.jsx';
import FraudAnalysis    from './components/FraudAnalysis.jsx';
import ReturnAnalytics  from './components/ReturnAnalytics.jsx';
import ProfitAnalysis   from './components/ProfitAnalysis.jsx';
import PickupDashboard  from './components/PickupDashboard.jsx';
import NavIcon          from './components/NavIcon.jsx';

const NAV = [
  { section: 'Overview' },
  { id: 'business', label: 'Business Workspace', ico: '▦' },
  { id: 'dashboard', label: 'Dashboard',        ico: '📊' },
  { section: 'Operations' },
  { id: 'sales',     label: 'Sales Entry',      ico: '📦' },
  { id: 'dispatch',  label: 'Scan & Dispatch',  ico: '🚀' },
  { id: 'pickup',    label: 'Pickup Dashboard', ico: '📦' },
  { id: 'returns',   label: 'Return Transit',   ico: '🔄' },
  { id: 'received',  label: 'Return Received',  ico: '✅' },
  { section: 'Finance' },
  { id: 'payments',  label: 'Payment Entry',    ico: '💰' },
  { id: 'products',  label: 'Purchase Rates',   ico: '🏷️' },
  { section: 'Analytics' },
  { id: 'fraud',     label: 'Fraud Analysis',   ico: '🚨', badge: 'fraud' },
  { id: 'returnAnalytics', label: 'Return Analytics', ico: '📉' },
  { id: 'profitAnalysis',  label: 'Profit Analysis',  ico: '💵' },
  { section: 'Reports' },
  { id: 'reports',   label: 'Monthly Report',   ico: '📈' },
  { id: 'trash',     label: 'Trash',            ico: '🗑️' },
];

export default function App({ user, onLogout }) {
  const [tab,     setTab]     = useState('dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [db,      setDbRaw]   = useState(() => loadDB());

  // Sync status surfaced on the Dashboard's "Refresh Data" button.
  const [syncState,      setSyncState]      = useState('idle'); // idle | syncing | synced | offline | error
  const [lastSynced,     setLastSynced]     = useState(null);
  const [initialLoading, setInitialLoading] = useState(true);

  // Diff baseline for pushing only changed rows to Supabase — captured
  // separately from `db` itself (see supabaseData.js for why: every screen
  // mutates db.orders/db.trash/etc. in place before calling setDb).
  // Start with empty snapshot — will be populated after Supabase fetch
  // This ensures all orders are diffed correctly on first sync
  const snapshotRef = useRef({});
  const syncingRef = useRef(false);
  // localVersionRef/syncedVersionRef: bumped on every local-only change
  // and every confirmed Supabase sync respectively — see setDbLocal/
  // runSync below and the realtime-refresh effect that reads them.
  const localVersionRef  = useRef(0);
  const syncedVersionRef = useRef(0);

  // Ids changed on this device that Supabase has not confirmed yet.
  // Loaded from localStorage on mount so anything still unsent when the
  // tab was closed (or the phone went to sleep mid-shift) is picked back
  // up and pushed on the next load instead of being silently dropped.
  const outboxRef = useRef(loadOutbox());
  const [unsyncedCount, setUnsyncedCount] = useState(() => outboxCount(outboxRef.current));
  // Every local write protects the not-yet-synced records first, and
  // tells us if the cache had to be trimmed to fit (see saveDB).
  const cacheWarnedRef = useRef(false);
  const persist = useCallback((next) => {
    const res = saveDB(next, outboxRef.current.orders);
    if (!res.ok && !cacheWarnedRef.current) {
      cacheWarnedRef.current = true;
      toast('This device could not save an offline copy. Your work still syncs to Supabase, but avoid closing the tab while the "unsynced" badge shows a number.', 'error');
    }
    return res;
  }, []);

  const noteUnsynced = useCallback((collection, ids) => {
    if (!ids || !ids.length) return;
    const set = outboxRef.current[collection] || (outboxRef.current[collection] = new Set());
    ids.forEach((id) => id && set.add(id));
    saveOutbox(outboxRef.current);
    setUnsyncedCount(outboxCount(outboxRef.current));
  }, []);

  // Fetches the real, shared data straight from Supabase — used both on
  // page load and from the Dashboard's "Refresh Data" button, so the
  // person always sees current data instead of a stale local copy.
  const refreshSequenceRef = useRef(0);
  const refreshFromSupabase = useCallback(async ({ silent } = {}) => {
    if (!isSupabaseConfigured()) { setSyncState('offline'); return; }
    const request = ++refreshSequenceRef.current;
    const localAtStart = localVersionRef.current;
    const syncedAtStart = syncedVersionRef.current;
    setSyncState('syncing');
    try {
      const fresh = await fetchFreshDB();
      // A fetch may predate scans which have already been acknowledged.
      // Such records are no longer in the outbox, so merging cannot protect
      // them. Discard this stale response instead of rewinding local data.
      if (request !== refreshSequenceRef.current) return;
      if (localAtStart !== localVersionRef.current ||
          syncedAtStart !== syncedVersionRef.current || syncInFlightRef.current) {
        setSyncState(outboxCount(outboxRef.current) ? 'syncing' : 'synced');
        if (!silent) toast('Local changes were kept. Refresh again after scanning finishes.', 'info');
        return;
      }

      // Supabase is the source of truth for everything EXCEPT records
      // this device has changed and Supabase has not confirmed yet.
      //
      // FIX (bug report Aug 2026 — "fast scanning loses parcels"): this
      // used to be a straight `setDbRaw(fresh); saveDB(fresh)`. The
      // fetch above takes seconds on a 20k-order account, and the
      // pickup person keeps scanning throughout it. Every scan made
      // during the fetch was wiped the moment it landed — wiped from
      // React state, from localStorage, AND from snapshotRef (the diff
      // baseline), so the scan never reached Supabase either and the
      // parcel had to be scanned again. Reproduced: 6 scans across one
      // refresh, 3 survived.
      //
      // Overlaying the outbox makes a refresh incapable of erasing
      // unsynced work no matter when it lands, and those records stay
      // flagged until Supabase actually acknowledges them.
      const merged = mergeUnsyncedOverFresh(fresh, dbRef.current, outboxRef.current);
      setDbRaw(merged);
      persist(merged);
      dbRef.current = merged;
      // Baseline is the SERVER state — so anything the overlay kept is
      // still seen as changed and gets pushed on the next sync.
      snapshotRef.current = snapshotIds(fresh);
      if (outboxCount(outboxRef.current) > 0) runSyncRef.current?.();
      setSyncState('synced');
      setLastSynced(new Date());
      if (!silent) toast('Dashboard refreshed with the latest data from Supabase', 'success');
    } catch (e) {
      console.error('Supabase refresh failed:', e);
      setSyncState('error');
      if (!silent) toast('Could not reach Supabase — showing the last saved data instead', 'error');
    }
  }, []);

  // On load, show the copy already on this device IMMEDIATELY and pull
  // the fresh copy in the background.
  //
  // FIX (bug report Aug 2026 — "the app is very slow to open"): this
  // used to hold the whole UI behind a "Loading the latest data…"
  // screen until a full fetch of every table finished. At ~20,000
  // orders that is 20+ paginated requests before anything at all is
  // usable — which is the lag, and it was paid on every single open.
  // The local copy is already correct in almost every case, and it is
  // now safe to show it first because refreshFromSupabase() merges
  // rather than overwrites (see above), so the background refresh can
  // land at any moment without disturbing anything.
  useEffect(() => {
    if (!user) return;
    setInitialLoading(false);            // render straight away
    if (isSupabaseConfigured()) {
      flushPendingQueue();
      if(outboxCount(outboxRef.current)>0)runSyncRef.current?.();
      refreshFromSupabase({ silent: true });
    }
  }, [user]); // eslint-disable-line

  useEffect(()=>{
    const retry=()=>{if(outboxCount(outboxRef.current)>0)runSyncRef.current?.();};
    window.addEventListener('online',retry);
    return ()=>window.removeEventListener('online',retry);
  },[]);

  // Live cross-device updates: once signed in, listen for any insert/
  // update/delete on the core tables (from THIS device or any other —
  // laptop, phone, whatever else is open) and pull the fresh copy down
  // automatically, instead of waiting for a manual "Refresh Data" click
  // or the next full page load. Multiple changes that land in a quick
  // burst (e.g. a PDF import writing 40 orders at once) are coalesced
  // into a single refetch via a short debounce, rather than firing one
  // fetchFreshDB() per row.
  //
  // FIX (bug report Aug 2026): this used to guard on the `syncState`
  // REACT STATE, but this effect's deps are [user, initialLoading], so
  // that comparison closed over syncState's value from login time and
  // never saw a later 'syncing' — the guard was permanently a no-op.
  // Rapid Dispatch scanning made the real bug visible: a scan updates
  // local state instantly (setDbLocal) but its Supabase push is
  // debounced/batched (see Dispatch.jsx), so for up to ~1s the scan
  // exists ONLY locally. If a realtime notification (e.g. an earlier
  // scan's own sync landing in Supabase) fires refreshFromSupabase in
  // that window, it does a full overwrite of local state with the
  // server copy — which doesn't have the just-scanned order yet — and
  // the scan silently disappears (count drops).
  // tryRefresh() below checks syncingRef/localVersionRef/syncedVersionRef
  // — plain refs, always current even in a stale closure — and if a
  // sync is in flight OR local has changes Supabase hasn't confirmed
  // yet, it re-checks again shortly instead of refreshing (and instead
  // of just dropping the refresh, so multi-device updates still land
  // once things settle).
  useEffect(() => {
    if (!user || initialLoading || !isSupabaseConfigured()) return;

    let debounceTimer = null;
    function tryRefresh() {
      if (syncingRef.current || localVersionRef.current !== syncedVersionRef.current) {
        debounceTimer = setTimeout(tryRefresh, 800);
        return;
      }
      refreshFromSupabase({ silent: true });
    }
    const unsubscribe = subscribeToChanges(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(tryRefresh, 600);
    });
    return () => {
      clearTimeout(debounceTimer);
      unsubscribe();
    };
  }, [user, initialLoading]); // eslint-disable-line

  function handleManualRefresh() {
    if (isSupabaseConfigured()) {
      refreshFromSupabase({});
    } else {
      setDbRaw(loadDB());
      toast('Reloaded from local storage — Supabase is not configured, so this device has no shared copy to refresh from.', 'info');
    }
  }
  // ── Local-only update (no Supabase call) ─────────────────────
  // For flows that mutate `db` rapidly in a tight loop (e.g. barcode
  // scanning in Dispatch.jsx) — updates React state + localStorage
  // instantly (both synchronous, so the UI/count never waits on the
  // network), without kicking off a Supabase round trip on every
  // single call. Pair with syncNow() (below), called on a debounce,
  // to push everything in one batched request once scanning pauses.
  // Bumps localVersionRef so the realtime-refresh effect above knows
  // this change hasn't been confirmed synced yet.
  // `changedIds` — the record ids this call touched, e.g.
  // setDbLocal(next, { orders: [order.id] }) from a scan. They go into
  // the outbox immediately (synchronously, to localStorage) and only
  // come out once Supabase confirms them, which is what guarantees a
  // scan can never be lost to a refresh, a reload or a dead network.
  const dispatchPersistTimer = useRef(null);
  const setDbLocal = useCallback((next, changedIds, options) => {
    let journaled=false;
    if(options?.dispatch) {
      try { for(const id of changedIds?.orders || []) {const order=next.orders.find(o=>o.id===id);if(order)journalDispatch(order);} journaled=true; }
      catch (_) { /* Full persistence below reports storage failures. */ }
    }
    if (changedIds) Object.keys(changedIds).forEach((k) => noteUnsynced(k, changedIds[k]));
    dbRef.current = next;
    localVersionRef.current += 1;
    setDbRaw(next);
    if(journaled) {
      if(!dispatchPersistTimer.current)dispatchPersistTimer.current=setTimeout(()=>{dispatchPersistTimer.current=null;persist(dbRef.current);},150);
    } else persist(next);
  }, [noteUnsynced]);

  // Always-current ref to `db` so syncNow() (called from a debounce
  // timer closure) never pushes a stale snapshot. Assigned eagerly in
  // setDb/setDbLocal too — waiting for this effect to run left a window
  // where a sync fired from an event handler pushed the previous value.
  const dbRef = useRef(db);
  useEffect(() => { dbRef.current = db; }, [db]);
  const runSyncRef = useRef(null);

  // ── Explicit, de-duplicated Supabase sync ─────────────────────
  // If a sync is already in flight when this is called again (e.g. two
  // debounce timers firing close together), it just queues the latest
  // `db` for right after the current one finishes, instead of firing a
  // second overlapping request — this is what actually caused rapid
  // scans to "fall behind" before: every scan fired its own
  // syncDBToSupabase call, all racing to read/write snapshotRef.current.
  const syncInFlightRef = useRef(false);
  const syncPendingRef  = useRef(false);
  const runSync = useCallback(() => {
    if (syncInFlightRef.current) { syncPendingRef.current = true; return; }
    if (!isSupabaseConfigured()) return;
    const versionAtStart = localVersionRef.current;
    syncInFlightRef.current = true;
    syncingRef.current = true;
    const pushedFrom = JSON.parse(JSON.stringify(dbRef.current));
    let failed=true;
    syncDBToSupabase(pushedFrom, snapshotRef.current)
      .then((result) => {
        if (result.snapshot) snapshotRef.current = result.snapshot;
        if (result.ok) {
          failed=false;
          syncedVersionRef.current = versionAtStart;
          // Clear the outbox, but ONLY for records whose current local
          // value is exactly what the server just accepted. A record
          // edited again while this request was in flight stays flagged
          // and goes out on the next sync — that check is what stops a
          // mid-flight scan from being marked "saved" when it wasn't.
          let changed = false;
          Object.keys(outboxRef.current).forEach((key) => {
            const set = outboxRef.current[key];
            if (!set || !set.size) return;
            const confirmed = result.snapshot?.[key];
            const current = new Map((dbRef.current?.[key] || []).map((r) => [r?.id, r]));
            for (const id of [...set]) {
              const rec = current.get(id);
              if (!rec) { set.delete(id); changed = true; continue; }
              if (confirmed && confirmed.get(id) === JSON.stringify(rec)) {
                set.delete(id); changed = true;
              }
            }
          });
          if (changed) { saveOutbox(outboxRef.current); setUnsyncedCount(outboxCount(outboxRef.current)); }
        } else {
          toast('Some changes did not sync yet — they are saved on this device and will be retried automatically.', 'info');
        }
      })
      .catch((err) => console.error('Supabase sync error:', err))
      .finally(() => {
        syncInFlightRef.current = false;
        setTimeout(() => { syncingRef.current = false; }, 1500);
        // Anything still flagged means work is outstanding — either a
        // queued call arrived mid-flight, or the push failed. Go again.
        if (syncPendingRef.current || outboxCount(outboxRef.current) > 0) {
          syncPendingRef.current = false;
          setTimeout(() => runSync(), failed ? 1200 : 0);
        }
      });
  }, []);
  runSyncRef.current = runSync;
  const syncNow = useCallback(() => { runSync(); }, [runSync]);

const setDb = useCallback((next, changedIds) => {
  const previous=loadDB();
  if (next.orders?.length !== previous.orders?.length || next.payments?.length !== previous.payments?.length) {
    backupLocal(previous,(import.meta.env.VITE_SUPABASE_URL||'local')+':'+user.id,'before-import').catch(()=>toast('Pre-import recovery copy failed; download a JSON backup.', 'error'));
  }

  if (changedIds) Object.keys(changedIds).forEach((k) => noteUnsynced(k, changedIds[k]));
  dbRef.current = next;
  localVersionRef.current += 1;
  setDbRaw(next);
  persist(next);

  if (isSupabaseConfigured()) {
    runSync();
  } else {
    syncingRef.current = false;
  }
}, [noteUnsynced]);

  useEffect(() => {
    if (user && !initialLoading && db.orders.length === 0)
      toast(`Welcome to Lavanya OMS v${version}! Upload PDF labels to get started.`, 'info');
  }, [user, initialLoading]); // eslint-disable-line

  useEffect(() => {
    if (!user || syncState !== 'synced' || unsyncedCount) return;
    const scope=(import.meta.env.VITE_SUPABASE_URL||'local')+':'+user.id;
    const timer=setTimeout(()=>{backupLocal(dbRef.current,scope,'latest-synced').catch(()=>toast('Automatic recovery copy failed. Download a JSON backup.', 'error'));},1500);
    return ()=>clearTimeout(timer);
  }, [db, syncState, unsyncedCount, user]);

  function exportAllData() {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(exportRows(db.orders.filter((x) => !x.deleted))), 'Orders');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(exportRows(db.payments)), 'Payments');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(exportRows(db.products)), 'Products');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(exportRows(db.fraudList || [])), 'FraudBlocklist');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(exportRows(db.businessRecords || [])), 'BusinessRecords');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(exportRows(db.payments.flatMap(p=>(p.transactions||[]).map(t=>({...t,orderId:p.orderId}))))), 'PaymentTransactions');
    XLSX.writeFile(wb, `Lavanya_AllData_${today()}.xlsx`);
    toast('Report exported. Use Business Workspace → Backup for a full JSON backup.', 'success');
  }

  if (initialLoading) {
    return (
      <>
        <ToastContainer />
        <div className="login-wrapper">
          <div className="login-card" style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>🪡</div>
            <p style={{ color: 'var(--muted)' }}>Loading the latest data from Supabase…</p>
          </div>
        </div>
      </>
    );
  }

  const activeOrders  = db.orders.filter((o) => !o.deleted);
  const fraudCount    = activeOrders.filter((o) => o.fraudAlert).length;
  const exchangeCount = activeOrders.filter((o) => o.orderType === 'Exchange').length;

  const tabTitles = {
    business: 'Business Workspace', dashboard: 'Dashboard', sales: 'Sales Entry', dispatch: 'Scan & Dispatch', pickup: 'Pickup Dashboard',
    returns: 'Return Transit', received: 'Return Received', payments: 'Payment Entry',
    products: 'Purchase Rates', reports: 'Monthly Report', trash: 'Trash',
    fraud: 'Fraud Analysis / Blocklist', returnAnalytics: 'Return Analytics', profitAnalysis: 'Profit Analysis',
  };

  function renderTab() {
    const props = {
      db, setDb, setDbLocal, syncNow, user, getDb: () => dbRef.current,
      onRefresh: handleManualRefresh,
      unsyncedCount,
      syncState,
      lastSynced,
      supabaseConfigured: isSupabaseConfigured(),
    };
    switch (tab) {
      case 'business': return <BusinessHub {...props} />;
      case 'dashboard': return <Dashboard    {...props} />;
      case 'sales':     return <Sales        {...props} />;
      case 'dispatch':  return <Dispatch     {...props} />;
      case 'pickup':    return <PickupDashboard db={db} />;
      case 'returns':   return <Returns      {...props} />;
      case 'received':  return <Received     {...props} />;
      case 'payments':  return <Payments     {...props} />;
      case 'products':  return <Products     {...props} />;
      case 'reports':   return <Reports      {...props} />;
      case 'trash':     return <Trash        {...props} />;
      case 'fraud':     return <FraudAnalysis {...props} />;
      case 'returnAnalytics': return <ReturnAnalytics {...props} />;
      case 'profitAnalysis':  return <ProfitAnalysis {...props} />;
      default:          return <Dashboard    {...props} />;
    }
  }

  return (
    <>
      <ToastContainer />

      {/* ── SIDEBAR ── */}
      <nav className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <button
    className="close-menu"
    onClick={() => setSidebarOpen(false)}
>
    ✕
</button>
        <div className="brand">
          {db.businessRecords?.find(r=>r.id==='brand')?.logo ? <img className="brand-logo" src={db.businessRecords.find(r=>r.id==='brand').logo} alt="Company logo"/> : <img className="brand-logo supplied-logo" src="/company-logo.jpeg" alt="Lavanya’s Mart — Aari Materials"/>}
          <div className="brand-name">Lavanya Aari Materials</div>
          <div className="brand-sub">Order Management</div>
        </div>

        <div className="nav">
          {NAV.map((item, i) => {
            if (item.section) {
              return <div key={i} className="nav-section">{item.section}</div>;
            }
            const badgeCount = item.badge === 'fraud' ? fraudCount : 0;
            return (
              <button
                key={item.id}
                className={`nav-item${tab === item.id ? ' active' : ''}`}
                onClick={() => {
    setTab(item.id);
    setSidebarOpen(false);
}}
              >
                <span className="ico"><NavIcon name={item.id} /></span>
                {item.label}
                {badgeCount > 0 && (
                  <span className="nav-badge">{badgeCount}</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Exchange quick-link */}
        {exchangeCount > 0 && (
          <div className="nav-exchange">
            <button
              className="nav-item"
              onClick={() => setTab('dashboard')}
            >
              <span className="ico"><NavIcon name="exchange" /></span>{exchangeCount} Exchange{exchangeCount > 1 ? 's' : ''}
            </button>
          </div>
        )}

        <div className="sidebar-footer">
          <span>v{version} · {user.role} · {isSupabaseConfigured() ? 'Synced via Supabase' : 'Local Storage'}</span>

        </div>
      </nav>

      {/* ── MAIN ── */}
      <div className="main">
       
          <div className="topbar">

  <button
    className="menu-btn"
    onClick={() => setSidebarOpen(!sidebarOpen)}
  >
    ☰
  </button>
          <div className="page-title">{tabTitles[tab] || tab}</div>
          <div className="topbar-right">
            <button className="btn btn-outline btn-sm" onClick={exportAllData}>Export all</button>
            <span className="badge">{activeOrders.length} orders</span>
            {fraudCount > 0 && (
              <span
                className="badge badge-danger"
                onClick={() => setTab('fraud')}
                title="View fraud alerts"
              >
                {fraudCount} fraud alerts
              </span>
            )}
            <button
              className="btn btn-ghost btn-sm"
              onClick={onLogout}
            >
              Sign Out
            </button>
          </div>
        </div>

        <div className="content">
          {renderTab()}
        </div>
      </div>
    </>
  );
}
