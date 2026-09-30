import { useState, useRef } from 'react';
import { returnTypeClass, returnTypeLabel, RETURN_TYPES, normalizeScan, normalizeReturnType } from '../db.js';
import { toast } from './Toast.jsx';

// Short success beep — same style as Dispatch.jsx's, for consistent
// audible confirmation when a scan auto-marks Return Received.
function playSuccessBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
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
      setTimeout(() => ctx.close(), 250);
    });
  } catch (_) {}
}

function playErrorBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume().then(() => {
      const osc = ctx.createOscillator();
      osc.connect(ctx.destination);
      osc.frequency.setValueAtTime(180, ctx.currentTime);
      osc.start(); osc.stop(ctx.currentTime + 0.2);
      setTimeout(() => ctx.close(), 300);
    });
  } catch (_) {}
}

export default function Received({ db, setDb, getDb }) {
  const [scanValue, setScanValue] = useState('');
  const [recvPage, setRecvPage] = useState(1);
  const [result,    setResult]    = useState(null);   // { ok, order } | { ok: false, msg }
  const [scanType,  setScanType]  = useState('');
  const [scanReason, setScanReason] = useState('');     // type chosen after scan, before save
  const inputRef = useRef();

  // ── Scan / lookup ────────────────────────────────────────────
  function processReturnReceived(rawOverride) {
    const currentDb = getDb ? getDb() : db;
    // Same normalisation Dispatch.jsx uses — case, spaces, an "AWB#"
    // prefix and a tracking URL are all stripped, on BOTH sides of every
    // comparison below. See normalizeScan() in db.js for why.
    const q = normalizeScan(typeof rawOverride === 'string' ? rawOverride : (inputRef.current?.value || scanValue));
    if (!q) return;
    // Same fix as Dispatch.jsx: clear the raw DOM value immediately,
    // not just React state, so a fast next scan can never get appended
    // onto this scan's still-present text before React's re-render clears it.
    if (inputRef.current) inputRef.current.value = '';
    setScanValue('');
    // FIX (bug report Aug 2026): this only matched o.awb (the ORIGINAL
    // DISPATCH AWB) — never o.returnAwb. But the physical package
    // arriving back is labeled with the RETURN AWB (Shadowfax/ExpressBees/
    // whichever courier actually carried it back — often a completely
    // different number from the outbound Delhivery/Shadowfax AWB, and
    // sometimes changes again if the original courier can't service that
    // return leg and it gets handed off to ExpressBees instead). Scanning
    // that real return AWB matched nothing at all, which is exactly the
    // "no number comes up" symptom. o.returnAwb is checked FIRST since
    // that's what's actually printed on the incoming package; hyphens are
    // stripped from both sides so formatting differences never matter.
    const order = currentDb.orders.find(
      (o) => !o.deleted && (
        (o.returnAwb && normalizeScan(o.returnAwb) === q) ||
        (o.awb && normalizeScan(o.awb) === q) ||
        // Alternate barcodes printed on the same outbound label — see
        // extractAltAwbs in db.js. An RTO parcel comes back wearing the
        // original label, so whichever of its barcodes gets scanned here
        // has to resolve to the same order.
        (Array.isArray(o.altAwbs) && o.altAwbs.some((a) => normalizeScan(a) === q)) ||
        normalizeScan(o.orderId) === q || normalizeScan(o.invoice) === q
      )
    );
    if (!order) {
      setResult({ ok: false, msg: `❌ "${q}" not found.` });
      setScanType('');
      return;
    }
    if (order.status === 'Return Received') {
      setResult({ ok: false, warning: true, msg: `⚠️ Already received: ${order.orderId} (received ${order.receivedDate || 'date unavailable'})` });
      setScanType('');
      playErrorBeep();
      inputRef.current?.focus();
      return;
    }
    // FIX (bug report Aug 2026): Return Transit import already stores the
    // correct return_type per order (from the CSV's Return Type column —
    // see Returns.jsx importReturnExcel). Requiring a manual RTO/Customer
    // Return re-selection here, on every single scan, was pure friction —
    // Dispatch.jsx's scan flow doesn't ask for confirmation either. If a
    // type is already known, mark Received immediately on scan, matching
    // Dispatch's instant-mark behaviour. Only fall back to showing the
    // confirmation card when the type is genuinely unknown (blank), so
    // there's still a way to set it for orders that need it.
    const knownType = normalizeReturnType(order.return_type || order.returnType);
    if (knownType && !order.returnTypeConflict) {
      order.return_type = knownType;
      order.status       = 'Return Received';
      order.receivedDate = new Date().toISOString();
      setDb({ ...currentDb }, { orders: [order.id] });
      setScanValue('');
      setResult({ ok: true, order, auto: true, msg: `✅ Received — ${returnTypeLabel(order.return_type)}: ${order.orderId}` });
      playSuccessBeep();
      setTimeout(() => setResult(current => current?.order?.id === order.id && current?.auto ? null : current), 1500);
      inputRef.current?.focus();
      toast(`Return Received — ${returnTypeLabel(order.return_type)}: ${order.orderId}`, 'success');
      return;
    }
    // Show the confirmation card — don't commit yet
setScanType(order.returnTypeConflict ? '' : knownType || '');
setScanReason(order.returnReason || order.return_reason || '');
setResult({ ok: true, order });
  }

  // ── Confirm & save ───────────────────────────────────────────
  function confirmReceived() {
    if (!result?.ok || !result.order) return;
    if (!RETURN_TYPES.includes(scanType)) {toast('Select RTO or Customer Return', 'error');return;}
    const latest = getDb ? getDb() : db;
    const current = latest.orders.find(o => o.id === result.order.id);
    if (current?.status === 'Return Received') {
      setResult({ ok: false, warning: true, msg: `⚠️ Already received: ${current.orderId} (received ${current.receivedDate || 'date unavailable'})` });
      playErrorBeep();
      return;
    }
    if (!current || current.deleted) {
      setResult({ ok: false, msg: 'Order is no longer available. Scan again.' });
      return;
    }
    setDb({
      ...latest,
      orders: latest.orders.map(o => o.id === current.id ? {
        ...o, status: 'Return Received', receivedDate: new Date().toISOString(),
        return_type: scanType, returnTypeConflict: null, returnTypeResolvedAt: new Date().toISOString(), returnReason: scanReason, return_reason: scanReason,
      } : o),
    }, { orders: [current.id] });
    // Reset scan box for the next barcode
setResult(null);
setScanValue('');
setScanType('');
setScanReason('');
inputRef.current?.focus();
  }

function cancelScan() {
  setResult(null);
  setScanValue('');
  setScanType('');
  setScanReason('');
  inputRef.current?.focus();
}

  const received = db.orders.filter((o) => o.status === 'Return Received' && !o.deleted);
  // PERFORMANCE (Aug 2026): rendered every received return. Same problem
  // Sales Entry had — 50 per page keeps it instant however many pile up.
  const RECV_PAGE_SIZE = 50;
  const recvTotalPages = Math.max(1, Math.ceil(received.length / RECV_PAGE_SIZE));
  const recvSafePage = Math.min(recvPage, recvTotalPages);
  const recvRows = received.slice((recvSafePage - 1) * RECV_PAGE_SIZE, recvSafePage * RECV_PAGE_SIZE);

  // Summary counts for the received list
  const custCount = received.filter((o) => o.return_type === 'Customer Return').length;
  const rtoCount  = received.filter((o) => o.return_type === 'RTO').length;
  const unknCount = received.filter((o) => !o.return_type).length;

  return (
    <div>
      {/* ── Scanner box ── */}
      <div className="scanner-box">
        <h3>Scan AWB to Mark Return Received</h3>
        <p>Scan AWB / Order ID. Known file type is received automatically; select only when missing or conflicting.</p>

        <input
          ref={inputRef}
          className="scan-input"
          type="text"
          placeholder="Scan or type AWB / Order ID…"
          value={scanValue}
          onChange={(e) => setScanValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !(result?.ok && !result?.auto) && processReturnReceived(e.currentTarget.value)}
          autoFocus
          disabled={result?.ok && !result?.auto}   // freeze input only for the manual confirm card — never during a fast auto-mark, so rapid scanning is never blocked
        />

        {!result?.ok && (
          <div className="mt-2">
            <button className="btn btn-primary" onClick={processReturnReceived}>
              Search
            </button>
          </div>
        )}

        <div className="scan-result">
          {/* ── Error state ── */}
          {result && !result.ok && (
            <div style={{ fontWeight: 600, marginTop: 8, color: result.warning ? '#b7791f' : 'var(--red)' }}>
              {result.msg}
            </div>
          )}

          {result?.ok && result?.auto && <div role="status" style={{color:'var(--green)',fontWeight:700}}>{result.msg}</div>}
          {result?.order?.returnTypeConflict && !result?.auto && <div role="alert">Return Type conflict: saved {result.order.returnTypeConflict.existing}; file {result.order.returnTypeConflict.incoming}. Select the correct type.</div>}
          {/* ── CONFIRMATION CARD — shown immediately after scan ── */}
          {result?.ok && !result?.auto && (
            <div className="return-confirm-card">
              {/* Order summary row */}
              <div className="rcc-header">
                <span className="rcc-orderid">#{result.order.orderId}</span>
                <span className="rcc-customer">{result.order.customer}</span>
                <span className={`chip chip-${(result.order.channel || '').toLowerCase()}`}>
                  {result.order.channel}
                </span>
                {result.order.awb && (
                  <span className="rcc-awb">AWB: {result.order.awb}</span>
                )}
              </div>

              {/* ── RETURN TYPE — the hero element ── */}
              <div className="rcc-type-row">
  <span className="rcc-type-label">Return Type</span>

  {/* Live badge */}
  <span
    className={`return-type-badge return-type-badge--lg ${returnTypeClass(scanType)}`}
  >
    {returnTypeLabel(scanType || result.order.return_type)}
  </span>

  <select
    className="rt-select rt-select--scan"
    value={scanType}
    onChange={(e) => setScanType(e.target.value)}
  >
    <option value="">— Select Type —</option>
    {RETURN_TYPES.map((t) => (
      <option key={t} value={t}>
        {t}
      </option>
    ))}
  </select>
</div>

{/* Return Reason */}
<div style={{ marginTop: 12 }}>
  <span className="rcc-type-label">Return Reason</span>

  <select
    className="rt-select rt-select--scan"
    value={scanReason}
    onChange={(e) => setScanReason(e.target.value)}
  >
    <option value="">— Select Reason —</option>
    <option value="Damaged">Damaged</option>
    <option value="Wrong Product">Wrong Product</option>
    <option value="Size Issue">Size Issue</option>
    <option value="Quality Issue">Quality Issue</option>
    <option value="Customer Changed Mind">
      Customer Changed Mind
    </option>
    <option value="Other">Other</option>
  </select>
</div>
              {/* Action buttons */}
              <div className="rcc-actions">
                <button className="btn btn-ghost btn-sm" onClick={cancelScan}>✕ Cancel</button>
                <button className="btn btn-success" onClick={confirmReceived}>
                  ✅ Confirm Received
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Received list ── */}
      <div className="card">
        <div className="flex items-center gap-3 mb-3" style={{ flexWrap: 'wrap' }}>
          <div className="card-title" style={{ margin: 0 }}>Return Received Orders</div>
          {received.length > 0 && (
            <div style={{ display: 'flex', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
              <span className="return-type-badge rt-customer">↩ Customer: {custCount}</span>
              <span className="return-type-badge rt-rto">🚚 RTO: {rtoCount}</span>
              {unknCount > 0 && <span className="return-type-badge rt-unknown">— Unknown: {unknCount}</span>}
            </div>
          )}
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Order ID</th><th>Customer</th><th>Channel</th>
                <th>Dispatch AWB</th>
<th>Return AWB</th>
<th>SKU</th>
               <th>Return Type</th>
<th>Return Reason</th>
<th>Received Date</th>
              </tr>
            </thead>
            <tbody>
              {received.length === 0 ? (
                <tr><td colSpan={8}><div className="empty">No return received orders yet.</div></td></tr>
              ) : (
                recvRows.map((o) => (
                  <tr key={o.id}>
                    <td className="truncate" title={o.orderId}>{o.orderId}</td>
                    <td>{o.customer}</td>
                    <td><span className={`chip chip-${(o.channel || '').toLowerCase()}`}>{o.channel}</span></td>
                    <td>{o.awb || '—'}</td>

<td>
  {o.returnAwb && o.returnAwb !== o.awb
    ? o.returnAwb
    : '—'}
</td>

<td className="truncate" title={o.sku}>
  {o.sku || '—'}
</td>
                    {/* ── Return Type badge ── */}
                    <td>
  <span className={`return-type-badge ${returnTypeClass(o.return_type)}`}>
    {returnTypeLabel(o.return_type)}
  </span>
</td>

<td>
  {o.returnReason || '—'}
</td>

<td>
  {o.receivedDate ? new Date(o.receivedDate).toLocaleDateString('en-IN') : '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {received.length > RECV_PAGE_SIZE && (
          <div className="flex gap-2 mt-2" style={{ alignItems: 'center', justifyContent: 'center' }}>
            <button className="btn btn-ghost btn-sm" disabled={recvSafePage <= 1} onClick={() => setRecvPage(recvSafePage - 1)}>← Prev</button>
            <span className="text-sm text-muted">Page {recvSafePage} of {recvTotalPages} · showing {recvRows.length} of {received.length.toLocaleString('en-IN')}</span>
            <button className="btn btn-ghost btn-sm" disabled={recvSafePage >= recvTotalPages} onClick={() => setRecvPage(recvSafePage + 1)}>Next →</button>
          </div>
        )}

      </div>
    </div>
  );
}
