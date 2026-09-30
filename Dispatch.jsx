import { useState, useRef, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { toast } from './Toast.jsx';
import { COMPANIES } from '../db.js';

// ── LOUD Error Beep ────────────────────────────────────────────────────────
// Same sound for any error (not found / already scanned / returned).
// DynamicsCompressor + 3 oscillators → browser-maximum volume.
// Also flashes the screen — noticeable even without looking at a mobile screen.
function playErrorBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Resume if suspended (mobile browsers require user-gesture unlock)
    ctx.resume().then(() => {
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -3;
      compressor.knee.value      = 0;
      compressor.ratio.value     = 20;
      compressor.attack.value    = 0;
      compressor.release.value   = 0.05;
      compressor.connect(ctx.destination);

      // 3 oscillators in unison = louder perceived volume
      [300, 310, 320].forEach((freq) => {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(compressor);
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq, ctx.currentTime);
        osc.frequency.linearRampToValueAtTime(140, ctx.currentTime + 0.55);
        gain.gain.setValueAtTime(1.0, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.6);
      });
      setTimeout(() => ctx.close(), 800);
    });
  } catch (_) {}

  // Visual flash — red overlay for 300ms (helps on mobile)
  const flash = document.createElement('div');
  Object.assign(flash.style, {
    position: 'fixed', inset: '0', background: 'rgba(220,38,38,0.35)',
    zIndex: '99999', pointerEvents: 'none', transition: 'opacity 0.2s',
  });
  document.body.appendChild(flash);
  setTimeout(() => { flash.style.opacity = '0'; setTimeout(() => flash.remove(), 250); }, 200);
}

// Today's date string for daily courier count reset
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ── Short success beep ───────────────────────────────────────────────────
// Quick, quiet, single-oscillator "blip" — deliberately brief (150ms) and
// non-blocking (Web Audio scheduling returns immediately; the next scan
// never waits on this) so rapid back-to-back scans each get their own
// audible confirmation without stacking up or delaying input focus.
let successAudioContext;
let lastSuccessBeep=0;
function playSuccessBeep() {
  const now=performance.now();
  if(now-lastSuccessBeep<100)return;
  lastSuccessBeep=now;
  try {
    const ctx = successAudioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume().then(() => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      gain.gain.setValueAtTime(0.35, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.15);

    });
  } catch (_) {}
}

export default function Dispatch({ db, setDb, setDbLocal, syncNow, getDb, unsyncedCount = 0 }) {
  const currentDbRef = useRef(db);
  currentDbRef.current = db;
  const [scanValue,    setScanValue]    = useState('');
  const [result,       setResult]       = useState(null);
  const [fCompany,     setFCompany]     = useState('');
  const [cameraOpen,   setCameraOpen]   = useState(false);
  const [cameraError,  setCameraError]  = useState('');
  const [dispatchPage, setDispatchPage] = useState(1);
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  // FIX (bug report Aug 2026, round 3): the on-screen count during rapid
  // scanning was still derived from db.orders.filter(...) every render —
  // which depends on React/network timing however careful the sync logic
  // is, and could still visibly "step backward" for a frame if any prop
  // update landed out of order. sessionScanCount is a plain local counter
  // that increments exactly once per successful scan, with NO dependency
  // on db/network/sync at all — it can never revert, regardless of what
  // else is happening. This is what should be trusted while scanning;
  // the "Dispatched" table below remains the authoritative saved record.
  const [sessionScanCount, setSessionScanCount] = useState(0);
  const DISPATCH_PAGE_SIZE = 50;
  const inputRef    = useRef();
  const videoRef    = useRef();
  const streamRef   = useRef(null);
  const scanLoopRef = useRef(null);

  // ── Scan batching ─────────────────────────────────────────────
  // Every successful scan updates local state + localStorage INSTANTLY
  // (setDbLocal — synchronous, no network wait, so the on-screen count
  // and the next scan are never blocked). The Supabase push is debounced:
  // a burst of rapid scans (scanner/phone firing every few hundred ms)
  // collapses into ONE syncNow() call, fired 700ms after the last scan
  // (or immediately after 15 unsynced scans, so a long continuous
  // session still flushes periodically instead of only at the very end).
  const syncTimerRef = useRef(null);
  const unsyncedCountRef = useRef(0);

  // FIX (bug report Aug 2026): the old debounce waited 700ms after the
  // LAST scan before pushing anything, so a steady scanning rhythm kept
  // re-arming the timer and nothing reached Supabase until the packer
  // stopped — leaving a long window in which a refresh could land and
  // wipe the batch. Every scan is now flagged in the outbox
  // synchronously (App.jsx setDbLocal) and pushed almost immediately;
  // the 150ms coalesce only exists so two scans a fraction of a second
  // apart share one request. syncNow() de-duplicates in-flight calls,
  // so this can safely be called on every single scan.
  function queueSync() {
    unsyncedCountRef.current += 1;
    setPendingSyncCount(unsyncedCountRef.current);
    if (syncTimerRef.current) return;
    syncTimerRef.current = setTimeout(() => {
      syncTimerRef.current = null;
      unsyncedCountRef.current = 0;
      setPendingSyncCount(0);
      if (setDbLocal) syncNow?.();
    }, 150);
  }
  // Flush any still-pending scans if the user leaves this tab.
  useEffect(() => () => {
    clearTimeout(syncTimerRef.current);
    if (unsyncedCountRef.current > 0 && setDbLocal) syncNow?.();
  }, []); // eslint-disable-line

  // ── AWB helpers ──────────────────────────────────────────────
  function normalise(s) {
    return (s || '').trim().toUpperCase().replace(/\s+/g, '');
  }

  function extractAwbFromUrl(raw) {
    const s = (raw || '').trim();
    if (!s.startsWith('http')) return s;
    try {
      const url = new URL(s);
      for (const key of ['trackingId', 'awbNo', 'awb', 'tracking_id', 'waybill', 'id']) {
        const v = url.searchParams.get(key);
        if (v && v.trim()) return v.trim().toUpperCase();
      }
      const segments = (url.hash ? url.hash.replace('#', '') : url.pathname)
        .split('/').filter(Boolean);
      if (segments.length) {
        const last = segments[segments.length - 1];
        if (last && last.length >= 8) return last.toUpperCase();
      }
    } catch (_) {}
    return s;
  }

  function findOrder(rawQ) {
    const db = getDb ? getDb() : currentDbRef.current;
    const q       = extractAwbFromUrl(rawQ.trim());
    const stripped = q.replace(/^AWB#?\s*/i, '').trim();
    const nq      = normalise(stripped);
    const nqOrig  = normalise(q);
    let o = db.orders.find((x) => !x.deleted && (normalise(x.awb) === nq || normalise(x.awb) === nqOrig));
    if (o) return o;
    o = db.orders.find((x) => !x.deleted && (normalise(x.orderId) === nq || normalise(x.orderId) === nqOrig));
    if (o) return o;
    o = db.orders.find((x) => !x.deleted && (normalise(x.invoice) === nq || normalise(x.invoice) === nqOrig));
    if (o) return o;
    // Alternate barcodes printed on the same label (see extractAltAwbs in
    // db.js — some Flipkart labels carry two scannable barcodes, e.g. a
    // Shadowfax "SF…" one and an Ekart "FMPP…" one). Whichever of the two
    // the packer's scanner happens to hit, the parcel is found.
    o = db.orders.find((x) => !x.deleted && Array.isArray(x.altAwbs) &&
      x.altAwbs.some((a) => normalise(a) === nq || normalise(a) === nqOrig));
    if (o) return o;
    if (nq.length >= 10) {
      const tail = nq.slice(-10);
      o = db.orders.find((x) => !x.deleted && x.awb && normalise(x.awb).endsWith(tail));
      if (o) return o;
    }
    return null;
  }

  // ── Bulk Dispatch via Excel/CSV ─────────────────────────────────
  // Alternative to live-scanning into the browser: scan AWBs directly
  // into an Excel sheet (or any spreadsheet app) with a physical
  // scanner — that's a native desktop app, completely unaffected by
  // any React/network timing, so nothing can ever be lost while
  // scanning. Upload the resulting sheet here; this does ONE local
  // mutation + ONE sync call for the whole batch (not one per row),
  // so none of the rapid-fire race conditions from live scanning can
  // occur here at all.
  const [bulkStatus, setBulkStatus] = useState('');
  // BUG THIS FIXES (Sep 2026): the list read `/^awb$/`, which matches the
  // heading "AWB" and nothing else. A scan sheet whose first cell said
  // "AWB NO" — the heading on the template actually in daily use —
  // therefore matched no pattern at all, so the header row was never
  // skipped and the literal text "AWB NO" went through findOrder() as if
  // it were a scanned waybill. Every upload reported one phantom
  // "not found", which reads exactly like a lost parcel. The same miss
  // also meant the AWB column was never located, so the code fell back to
  // reading column A blindly — fine while the AWBs happen to sit there,
  // silently wrong the day they don't.
  const AWB_COL_RE = [
    /^(sub)?order(id|no|number)$/,
    /^awb(no|number|nos)?$/,
    /^tracking(id|no|number)?$/,
    /^waybill(no|number)?$/,
    /^ref(erence)?$/,
  ];
  function normHeader(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  // A scanned waybill never contains a space and is never letters alone.
  // Used to drop a heading this list still doesn't know, so a future
  // rename can't reintroduce the phantom "not found" above.
  function looksLikeHeading(v) {
    const s = String(v || '').trim();
    return !!s && (/\s/.test(s) || !/\d/.test(s));
  }
  function bulkDispatchExcel(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const db = getDb ? getDb() : currentDbRef.current;
        const wb = XLSX.read(e.target.result, { type: 'array' });
        // First sheet, first column if no recognizable header — accept
        // either a single bare column of scanned values, or a proper
        // header row (Order ID / AWB / Tracking Number / etc).
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
        let values = [];
        if (rows.length && rows[0].some((c) => AWB_COL_RE.some((re) => re.test(normHeader(c))))) {
          const colIdx = rows[0].findIndex((c) => AWB_COL_RE.some((re) => re.test(normHeader(c))));
          values = rows.slice(1).map((r) => String(r[colIdx] || '').trim()).filter(Boolean);
        } else {
          values = rows.map((r) => String(r[0] || '').trim()).filter(Boolean);
          // Unrecognised heading in the first cell — drop it rather than
          // scanning it (see looksLikeHeading above).
          if (values.length && looksLikeHeading(values[0])) values = values.slice(1);
        }

        let dispatched = 0, alreadyDone = 0, notFound = 0, returns = 0;
        const changedIds = [];
        const misses = [];
        for (const raw of values) {
          const order = findOrder(raw);
          if (!order) { notFound++; misses.push(raw); continue; }
          if (order.status === 'Dispatched') { alreadyDone++; continue; }
          if (order.status && order.status.includes('Return')) { returns++; continue; }
          order.status = 'Dispatched';
          order.dispatchedAt = new Date().toISOString();
          changedIds.push(order.id);
          dispatched++;
        }

        // ONE state update + ONE sync call for the entire batch.
        const touched = changedIds.length ? { orders: changedIds } : null;
        if (setDbLocal) { setDbLocal({ ...db }, touched); syncNow?.(); } else { setDb({ ...db }, touched); }
        setSessionScanCount((n) => n + dispatched);

        const parts = [`✅ ${dispatched} dispatched`];
        if (alreadyDone > 0) parts.push(`${alreadyDone} already dispatched`);
        if (returns    > 0) parts.push(`${returns} are return orders (skipped)`);
        if (notFound   > 0) parts.push(`${notFound} not found`);
        setBulkStatus(parts.join(' · ') + (misses.length ? ` — not found: ${misses.slice(0, 10).join(', ')}${misses.length > 10 ? '…' : ''}` : ''));
        toast(`Bulk dispatch: ${dispatched} orders marked Dispatched`, dispatched > 0 ? 'success' : 'info');
      } catch (err) {
        console.error(err);
        setBulkStatus('❌ Could not read this file — check it is a valid .xlsx/.csv.');
      }
    };
    reader.readAsArrayBuffer(file);
  }

  // ── Process dispatch ─────────────────────────────────────────
  function processDispatch(rawOverride) {
    const db = getDb ? getDb() : currentDbRef.current;
    const rawQ = (rawOverride || inputRef.current?.value || scanValue).trim();
    if (!rawQ) return;

    // FIX (bug report Aug 2026): clear the input IMMEDIATELY — both the
    // raw DOM node (inputRef.current.value, synchronous) and React state
    // (setScanValue, async) — before any lookup/mutation work below.
    // Previously this only happened via setScanValue('') at the very end
    // of this function, AFTER the order lookup + array mutation + local
    // save (real work, taking real time). Since <input value={scanValue}>
    // is a controlled component, React's clear doesn't reach the actual
    // DOM until the next render; a fast barcode scanner firing the NEXT
    // scan's keystrokes into that window types them straight into the
    // still-not-yet-cleared DOM value, appending onto this scan's text
    // and corrupting it — the garbled combined string then fails order
    // lookup, which is exactly the "have to re-scan the same order
    // again" symptom. Clearing the DOM node directly here closes that
    // window almost entirely, regardless of how long the rest of this
    // function takes.
    if (inputRef.current) inputRef.current.value = '';
    setScanValue('');

    const q     = extractAwbFromUrl(rawQ);
    const order = findOrder(rawQ);
    if (!order) {
      setResult({ ok: false, msg: `❌ "${q}" not found. Try Order ID or Invoice Ref (IN-xxx).` });
      playErrorBeep();
      return;
    }
    if (order.status === 'Dispatched') {
      setResult({ ok: 'warn', msg: `⚠️ Already dispatched: ${order.orderId}` });
      playErrorBeep();
      return;
    }
    if (order.status && order.status.includes('Return')) {
      setResult({ ok: 'warn', msg: `⚠️ Return order — cannot dispatch: ${order.orderId}` });
      playErrorBeep();
      return;
    }
    const cleanQ = q.replace(/^AWB#?\s*/i, '').trim();
    if (order.channel === 'Amazon' && order.awb && order.awb.startsWith('IN-') && /^\d{10,16}$/.test(cleanQ)) {
      order.awb = cleanQ;
    }
    order.status      = 'Dispatched';
    order.dispatchedAt = new Date().toISOString();

    // Local-first: state + localStorage update instantly. Falls back to
    // the normal setDb (which also syncs immediately) if this Dispatch
    // instance was ever rendered without the setDbLocal/syncNow props —
    // keeps this component safe even if App.jsx's prop wiring changes.
    if (setDbLocal) {
      // Pass this order's id so App.jsx records it as unsynced before
      // anything else can happen. Until Supabase confirms it, no
      // refresh is allowed to overwrite it and no reload can drop it.
      setDbLocal({ ...db }, { orders: [order.id] }, { dispatch: true });
      queueSync();
    } else {
      setDb({ ...db }, { orders: [order.id] });
    }

    setResult({ ok: true, msg: `✅ Dispatched! ${order.orderId} | ${order.customer} | ${order.channel} | ${order.company || 'Unknown'}` });
    // Functional update (prev => prev + 1) — safe even if several scans
    // land in the same React batch; each one still adds exactly 1.
    setSessionScanCount((n) => n + 1);
    playSuccessBeep();
    inputRef.current?.focus();
    toast(`Order ${order.orderId} dispatched`, 'success');
  }

  // ── Camera / barcode scan ─────────────────────────────────────
  // Uses BarcodeDetector (Chrome/Android) or falls back to ZXing via CDN
  async function openCamera() {
    setCameraError('');
    setCameraOpen(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      startBarcodeLoop();
    } catch (err) {
      setCameraError('Camera access denied. Please allow camera permission and try again.');
      setCameraOpen(false);
    }
  }

  function stopCamera() {
    if (scanLoopRef.current) { cancelAnimationFrame(scanLoopRef.current); scanLoopRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
    setCameraOpen(false);
  }

  // Cleanup on unmount
  useEffect(() => () => stopCamera(), []);

  function startBarcodeLoop() {
    const hasBarcodeDetector = 'BarcodeDetector' in window;
    if (hasBarcodeDetector) {
      const detector = new window.BarcodeDetector({ formats: ['code_128', 'code_39', 'qr_code', 'data_matrix', 'ean_13', 'ean_8'] });
      const loop = async () => {
        if (!videoRef.current || !streamRef.current) return;
        try {
          const barcodes = await detector.detect(videoRef.current);
          if (barcodes.length > 0) {
            const val = barcodes[0].rawValue;
            stopCamera();
            setScanValue(val);
            setTimeout(() => processDispatch(val), 100);
            return;
          }
        } catch (_) {}
        scanLoopRef.current = requestAnimationFrame(loop);
      };
      scanLoopRef.current = requestAnimationFrame(loop);
    } else {
      // Fallback: ZXing via CDN
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/zxing-js/0.20.0/umd/index.min.js';
      script.onload = () => {
        const codeReader = new window.ZXing.BrowserMultiFormatReader();
        codeReader.decodeFromVideoElement(videoRef.current).then((result) => {
          const val = result.getText();
          codeReader.reset();
          stopCamera();
          setScanValue(val);
          setTimeout(() => processDispatch(val), 100);
        }).catch(() => {});
        // Store cleanup ref
        scanLoopRef.current = { cancel: () => codeReader.reset() };
      };
      document.head.appendChild(script);
    }
  }

  // ── Courier stats ─────────────────────────────────────────────
  const today = todayStr();
  const todayOrders = db.orders.filter(
    (o) => o.status === 'Dispatched' && !o.deleted && o.dispatchedAt && o.dispatchedAt.startsWith(today)
  );
  const todayCourierMap = {};
  for (const o of todayOrders) {
    const courier = o.courier || (
      o.awb
        ? /^SF\d{8,13}FPL$/i.test(o.awb)   ? 'Shadowfax'
        : /^SF\d+$/i.test(o.awb)            ? 'Shadowfax'
        : /^1490\d{12}$/.test(o.awb)        ? 'Delhivery'
        : /^\d{13,18}$/.test(o.awb)         ? 'Delhivery'
        : /^(?:FMPP|FMPC|FM[A-Z])/i.test(o.awb) ? 'Ekart'
        : 'Other'
        : 'Unknown'
    );
    todayCourierMap[courier] = (todayCourierMap[courier] || 0) + 1;
  }
  const dispatched = db.orders.filter((o) => o.status === 'Dispatched' && !o.deleted)
    .filter((o) => !fCompany || (o.company || 'Unknown') === fCompany)
    .slice().reverse();
  const dispatchedCompanyCounts = [...COMPANIES.map((c) => c.name), 'Unknown'].map((name) => ({
    name,
    count: db.orders.filter((o) => o.status === 'Dispatched' && !o.deleted && (o.company || 'Unknown') === name).length,
  }));
  // Rendering every dispatched order unbounded gets slow as this list
  // grows — slice to a page instead.
  const dispatchTotalPages = Math.max(1, Math.ceil(dispatched.length / DISPATCH_PAGE_SIZE));
  const dispatchSafePage   = Math.min(dispatchPage, dispatchTotalPages);
  const dispatchPageRows   = dispatched.slice((dispatchSafePage - 1) * DISPATCH_PAGE_SIZE, dispatchSafePage * DISPATCH_PAGE_SIZE);

  return (
    <div>
      {/* ── Camera overlay ── */}
      {cameraOpen && (
        <div style={{
          position: 'fixed', inset: 0, background: '#000', zIndex: 9999,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        }}>
          <video ref={videoRef} style={{ width: '100%', maxWidth: 500, borderRadius: 8 }} playsInline muted />
          <div style={{
            position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
            border: '3px solid #22c55e', width: 260, height: 120, borderRadius: 8, pointerEvents: 'none',
          }} />
          <button onClick={stopCamera} style={{
            marginTop: 24, padding: '12px 32px', background: '#ef4444', color: '#fff',
            border: 'none', borderRadius: 8, fontSize: 16, fontWeight: 700, cursor: 'pointer',
          }}>❌ Cancel</button>
          <p style={{ color: '#fff', marginTop: 12, fontSize: 13 }}>Hold the barcode straight in front of the frame</p>
        </div>
      )}

      <div className="scanner-box">
        <h3>Scan AWB to Dispatch</h3>
        <p>Barcode scan / type AWB / Order ID / Invoice Ref (IN-xxx) / Tracking URL</p>

        {/* Local-only running count — never derived from db.orders or
            network state, so it can never step backward no matter how
            fast you scan or what's happening with sync in the background.
            This is the number to trust while actively scanning. */}
        <div style={{
          fontSize: 28, fontWeight: 800, color: 'var(--green, #16a34a)',
          margin: '4px 0 10px',
        }}>
          {sessionScanCount} scanned this session
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            ref={inputRef}
            className="scan-input"
            type="text"
            placeholder="Scan or type AWB / Order ID…"
            defaultValue=""
            onKeyDown={(e) => {if(e.key === 'Enter'){e.preventDefault();processDispatch(e.currentTarget.value);}}}
            autoFocus
            style={{ flex: 1, minWidth: 200 }}
          />
          {/* Camera button — shows on mobile and desktop */}
          <button
            onClick={openCamera}
            title="Camera Scan"
            style={{
              padding: '10px 14px', background: 'var(--accent)', color: '#fff', border: 'none',
              borderRadius: 8, fontSize: 20, cursor: 'pointer', lineHeight: 1,
            }}
          >📷</button>
        </div>

        {cameraError && <p style={{ color: 'var(--red)', marginTop: 6, fontSize: 13 }}>{cameraError}</p>}

        <div className="mt-2">
          <button className="btn btn-success" onClick={() => processDispatch()}>Mark as Dispatched</button>
        </div>
        <div className="scan-result">
          {result && (
            <div style={{
              fontWeight: 600, marginTop: 8,
              color: result.ok === true ? 'var(--green)' : result.ok === 'warn' ? 'var(--gold)' : 'var(--red)',
            }}>
              {result.msg}
            </div>
          )}
          {/* Honest, always-visible sync state. `unsyncedCount` comes
              from the outbox in App.jsx and only drops when Supabase has
              actually confirmed the write — so this is a real "safe to
              walk away" signal, not a guess. */}
          {unsyncedCount > 0 ? (
            <div style={{ fontSize: 12, color: 'var(--gold, #b45309)', marginTop: 4, fontWeight: 600 }}>
              💾 {unsyncedCount} scan{unsyncedCount > 1 ? 's' : ''} saved on this device, still syncing…
            </div>
          ) : sessionScanCount > 0 ? (
            <div style={{ fontSize: 12, color: 'var(--green)', marginTop: 4, fontWeight: 600 }}>
              ☁️ All scans saved to Supabase
            </div>
          ) : null}
        </div>
      </div>

      {/* ── Bulk Dispatch via Excel/CSV ─────────────────────────────
          Scan AWBs directly into Excel (or any spreadsheet app) with
          your physical scanner, then upload the sheet here. This is
          immune to any browser/network timing entirely — scanning
          happens in a native desktop app, and this import does one
          single batch update, not one per row. */}
      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-title">Bulk Dispatch via Excel/CSV</div>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: -6, marginBottom: 10 }}>
          Scan AWBs into an Excel sheet (a single column — with or without a header
          like "AWB"/"Order ID"/"Tracking Number") using your scanner as normal, save it,
          then upload it here to mark every matched order Dispatched in one go.
        </p>
        <div className="upload-zone">
          <input type="file" accept=".xlsx,.xls,.csv"
            onChange={(e) => bulkDispatchExcel(e.target.files[0])} />
        </div>
        {bulkStatus && (
          <div style={{ fontSize: 13, marginTop: 8, fontWeight: 600 }}>{bulkStatus}</div>
        )}
      </div>

      <div className="card">
        <div className="flex items-center gap-3 mb-3" style={{ flexWrap: 'wrap' }}>
          <div className="card-title" style={{ margin: 0 }}>Dispatched Orders</div>
          <div style={{ flex: 1 }} />
          <div className="fg" style={{ marginBottom: 0 }}><label>Company</label>
            <select value={fCompany} onChange={(e) => setFCompany(e.target.value)}>
              <option value="">All</option>
              {COMPANIES.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
              <option value="Unknown">Unknown</option>
            </select>
          </div>
        </div>

        <div className="info-banner" style={{ marginBottom: 8, background: '#f0fdf4', borderColor: '#86efac' }}>
          <strong>📦 Today's Courier Count ({today}):</strong>{' '}
          {Object.keys(todayCourierMap).length === 0
            ? <span style={{ color: 'var(--muted)' }}>No dispatches yet today</span>
            : Object.entries(todayCourierMap).map(([courier, count], i) => (
              <span key={courier}>
                {i > 0 && ' | '}
                <strong>{courier}</strong>: {count} parcels
              </span>
            ))
          }
          {todayOrders.length > 0 && (
            <span style={{ marginLeft: 12, color: 'var(--muted)' }}>(Total: {todayOrders.length})</span>
          )}
        </div>

        <div className="info-banner" style={{ marginBottom: 12 }}>
          <strong>🏢 Dispatched by Company:</strong>{' '}
          {dispatchedCompanyCounts.map((c, i) => (
            <span key={c.name}>{i > 0 && ' | '}{c.name}: {c.count}</span>
          ))}
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Order ID</th><th>Customer</th><th>Channel</th><th>Company</th><th>AWB</th>
                <th>SKU</th><th>Payment</th><th>Amount</th><th>Dispatched At</th>
              </tr>
            </thead>
            <tbody>
              {dispatched.length === 0 ? (
                <tr><td colSpan={9}><div className="empty">No dispatched orders yet.</div></td></tr>
              ) : (
                dispatchPageRows.map((o) => (
                  <tr key={o.id}>
                    <td className="truncate" title={o.orderId}>{o.orderId}</td>
                    <td>{o.customer}</td>
                    <td><span className={`chip chip-${(o.channel || '').toLowerCase()}`}>{o.channel}</span></td>
                    <td><span className="chip" style={{ background: 'var(--accent-soft)', color: 'var(--accent-hover)' }}>{o.company || 'Unknown'}</span></td>
                    <td>{o.awb || '—'}</td>
                    <td className="truncate" title={o.sku}>{o.sku || '—'}</td>
                    <td><span className={`status ${o.payment === 'COD' ? 's-cod' : 's-prepaid'}`}>{o.payment}</span></td>
                    <td>₹{(o.amount || 0).toLocaleString('en-IN')}</td>
                    <td>{o.dispatchedAt ? new Date(o.dispatchedAt).toLocaleString('en-IN') : '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {dispatched.length > DISPATCH_PAGE_SIZE && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, justifyContent: 'flex-end' }}>
            <span style={{ fontSize: 12, color: 'var(--muted,#6b7280)' }}>
              Showing {(dispatchSafePage - 1) * DISPATCH_PAGE_SIZE + 1}–{Math.min(dispatchSafePage * DISPATCH_PAGE_SIZE, dispatched.length)} of {dispatched.length}
            </span>
            <button className="btn btn-ghost btn-sm" disabled={dispatchSafePage <= 1} onClick={() => setDispatchPage(dispatchSafePage - 1)}>← Prev</button>
            <span style={{ fontSize: 12 }}>Page {dispatchSafePage} / {dispatchTotalPages}</span>
            <button className="btn btn-ghost btn-sm" disabled={dispatchSafePage >= dispatchTotalPages} onClick={() => setDispatchPage(dispatchSafePage + 1)}>Next →</button>
          </div>
        )}
      </div>
    </div>
  );
}
