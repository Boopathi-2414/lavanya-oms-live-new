import { useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { genId } from '../db.js';
import { parsePaymentWorkbook } from '../paymentFormats.js';
import { mergePaymentTransactions, paymentMonthlySummary } from '../paymentLedger.js';
import { toast } from './Toast.jsx';

export default function Payments({ db, setDb }) {
  const [importStatus, setImportStatus] = useState('');
  const [search,       setSearch]       = useState('');
  const [fRecon,       setFRecon]       = useState('');
  const [activeTab,    setActiveTab]    = useState('reconcile');
  const [overwrite,    setOverwrite]    = useState(false); // overwrite existing payments
  // Flipkart's settlement report carries no product GST rate, so the
  // rate has to be supplied here for those files. Meesho and Amazon
  // state their own and ignore this.
  const [fallbackGst,  setFallbackGst]  = useState('');
  const [page, setPage] = useState(1);
  const [detailsId, setDetailsId] = useState('');
  const PAGE_SIZE = 50;
  const fileInputRef = useRef();

  // ── Payment import ───────────────────────────────────────────
  // Columns: Order ID, Settlement Amount, GST %, Date
  // Only matches orders already in Sales Entry (db.orders)
  // FIX (bug report Aug 2026, round 3): headers keep arriving in yet
  // another variant we hadn't listed literally — "Sub Order No" →
  // "SUB ORDER ID" was the latest ("SUB ORDER ID" matched neither
  // "Sub Order No" nor "Suborder Number" in the old exact-name list).
  // Rather than keep whack-a-moling literal strings, column detection
  // is now PATTERN-based: normHeader() strips everything except
  // letters/digits and lowercases, then each column type is matched
  // against a small regex list (most-specific pattern first). This
  // covers "Order ID", "Sub Order No", "SUB ORDER ID", "Suborder
  // Number", "order_id", etc. with one rule instead of an ever-growing
  // literal list, and should hold up against future header wording
  // Meesho/Amazon/Flipkart or a manually-typed sheet might use.
  const ORDERID_RE = [/^(sub)?order(id|no|number)$/];
  const SETTLE_RE  = [/settlement/, /^amount$/];
  const GST_RE     = [/gst/, /^tax/];
  // Date: prefer an explicit Payment/Settlement date over a generic
  // "date" column, since files like Meesho's official export also
  // have an "Order Date" column (that's the order date, not payment).
  const DATE_RE    = [/paymentdate/, /settlementdate/, /^date$/, /date/];
  // The GST-taxable value of the order. Meesho's export calls these
  // "Total Sale Amount (Incl. Shipping & GST)" and "Total Sale Return
  // Amount (Incl. Shipping & GST)" — its own column legend names them B
  // and C, and the taxable value is B + C.
  const SALE_RE    = [/^totalsaleamount/, /totalsaleamount/];
  const SALERET_RE = [/^totalsalereturnamount/, /totalsalereturnamount/];

  function normHeader(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  function pickSheet(wb) {
    const byName = wb.SheetNames.find((n) => /order.*payment/i.test(n));
    if (byName) return byName;
    for (const n of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '' }).slice(0, 5);
      if (rows.some((r) => r.some((c) => ORDERID_RE.some((re) => re.test(normHeader(c)))))) return n;
    }
    return wb.SheetNames[0];
  }
  function findHeaderRow(sheet) {
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      if (rows[i].some((c) => ORDERID_RE.some((re) => re.test(normHeader(c))))) return i;
    }
    return 0;
  }
  function getCol(row, patterns) {
    for (const re of patterns) {
      for (const key of Object.keys(row)) {
        if (re.test(normHeader(key))) return row[key];
      }
    }
    return '';
  }

  // Guard against a second file being picked while the first is still
  // parsing. A 7,000-row Meesho payment file takes ~11s to process, and
  // because the import mutates the `db` captured in this closure, an
  // overlapping second import starts from a stale payments array and
  // wipes the first file's rows on save. Observed with the three real
  // supplier files: 7,753 rows in, only 190 stored.
  const [importing, setImporting] = useState(false);
  function importPaymentExcel(file) {
    if (!file) return;
    if (importing) { toast('Still importing the previous file — please wait for it to finish.', 'info'); return; }
    setImporting(true);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array', raw: true });
        // One parser for Meesho / Flipkart / Amazon / plain sheets —
        // see src/paymentFormats.js for each format's quirks.
        const { format, rows, usedFallback, missingGstCount, rawLines } =
          parsePaymentWorkbook(wb, { fallbackGstPct: parseFloat(fallbackGst) || 0 });

        let added = 0, skipped = 0, notInSales = 0, legacyBlocked = 0;
        const normalise = (id) => (id || '').trim().toLowerCase();

        rows.forEach((r) => {
          const nOid = normalise(r.orderId);
          // Supports all 3 platforms:
          //   Meesho   "302865490123306432_1" (or without the _1)
          //   Amazon   "403-1234567-8901234"
          //   Flipkart "OD123456789012345678"
          const salesMatches = db.orders.filter((o) => {
            if (o.deleted) return false;
            const nOrder = normalise(o.orderId);
            if (nOrder === nOid) return true;
            if (nOid.includes('_') && nOrder === nOid.split('_')[0]) return true;
            if (nOrder.includes('_') && nOrder.split('_')[0] === nOid) return true;
            if (nOrder.replace(/-/g, '') === nOid.replace(/-/g, '')) return true;
            return false;
          });
          if (salesMatches.length !== 1) { notInSales++; return; }
          const salesOrder=salesMatches[0];

          const existingIdx = db.payments.findIndex((p) => p.orderId === salesOrder.orderId || p.orderId === r.orderId);
          const existing = existingIdx < 0 ? null : db.payments[existingIdx];
          const incoming = {...r, transactions:r.transactions.map(t=>({...t,sourceFile:file.name,company:salesOrder.company||'',orderId:salesOrder.orderId}))};
          const isLegacy=existing && !Array.isArray(existing.transactions);
          if (isLegacy && !overwrite) {legacyBlocked++;return;}
          const merged=mergePaymentTransactions(isLegacy ? null : existing,incoming);
          if (!merged.added) {skipped++;return;}
          const payment={...merged.payment,id:existing?.id || genId(),orderId:salesOrder.orderId,
            channel:r.source,status:'Received',reconciled:true,
            ...(isLegacy ? {legacySnapshot:existing} : {})};
          if (existingIdx < 0) db.payments.push(payment); else db.payments[existingIdx]=payment;
          salesOrder.reconciled = true;
          salesOrder.netReceived = payment.netAmount;
          added++;
        });

        setDb({ ...db });
        setImporting(false);

        const label = { meesho: 'Meesho', flipkart: 'Flipkart', amazon: 'Amazon', generic: 'plain sheet' }[format];
        const msgs = [`✅ ${label} file — ${added} payments imported`];
        msgs.push(`${rawLines} line(s) → ${rows.length} order(s)`);
        if (skipped    > 0) msgs.push(`${skipped} already recorded`);
        if (legacyBlocked > 0) msgs.push(`⚠️ ${legacyBlocked} old aggregate-only payments need a complete-history import; retained unchanged`);
        if (notInSales > 0) msgs.push(`${notInSales} missing or ambiguous in Sales Entry`);
        if (usedFallback > 0) msgs.push(`⚠️ ${usedFallback} order(s) had no GST rate in the file — used your fallback of ${fallbackGst}%`);
        if (format === 'flipkart' && missingGstCount > 0 && !(parseFloat(fallbackGst) > 0)) {
          msgs.push('⚠️ Flipkart settlement reports do not include a product GST rate — set the fallback GST % above and re-import for correct profit figures');
        }
        setImportStatus(msgs.join(' | '));
        toast(`${added} payment records imported`, added > 0 ? 'success' : 'info');
      } catch (err) {
        setImporting(false);
        toast('Error: ' + err.message, 'error');
      }
    };
    reader.onerror = () => { setImporting(false); toast('Could not read that file.', 'error'); };
    reader.readAsArrayBuffer(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  // Safe date: handles string, Excel serial number, undefined
  function safeDate(val) {
    if (!val) return '';
    if (typeof val === 'number') {
      try {
        const d = new Date(Math.round((val - 25569) * 86400 * 1000));
        return d.toISOString().slice(0, 10);
      } catch (_) { return ''; }
    }
    return String(val).trim();
  }

  // ── Derived: monthly summary ─────────────────────────────────
  const monthlySummary = paymentMonthlySummary(db.payments);
  const detailPayment = (db.payments || []).find(p=>p.orderId===detailsId);
  function exportDetails() {
    if (!detailPayment) return;
    const rows=(detailPayment.transactions || []).flatMap(t=>{
      const base={'Order ID':detailPayment.orderId,Company:t.company||'',Channel:detailPayment.channel,Date:t.date,Reference:t.transactionRef||'',Settlement:t.settlement,GST:t.gstAmount,'Net Received':t.netAmount,Reason:t.reason||'Not provided',File:t.sourceFile,Sheet:t.sourceSheet,Row:t.sourceRow};
      return t.deductions?.length ? t.deductions.map(d=>({...base,'Deduction field':d.label,'Reported amount':d.amount})) : [base];
    });
    const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(rows),'Transactions');
    XLSX.writeFile(wb,'Payment_Transaction_Details.xlsx');
  }

  // ── Reconciliation rows ──────────────────────────────────────
  // Previously this did a `.find()` per order against the *entire*
  // payments list — O(orders × payments). With thousands of orders and
  // payments that becomes genuinely slow (this is one of the main causes
  // of the app feeling sluggish). A Map lookup is O(1) per order instead.
  const q = search.toLowerCase();
  const paymentByOrderId = new Map((db.payments || []).map((p) => [p.orderId, p]));
  const rows = (db.orders || [])
    .filter((o) => !o.deleted)
    .map((o) => ({
      ...o,
      pd: paymentByOrderId.get(o.orderId),
    }))
    .filter((o) => {
      if (q && !`${o.orderId} ${o.customer || ''}`.toLowerCase().includes(q)) return false;
      if (fRecon === 'yes' && !o.pd) return false;
      if (fRecon === 'no'  &&  o.pd) return false;
      return true;
    });

  // Rendering every matching order unbounded gets slow once orders run
  // into the thousands — slice to a page instead.
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage   = Math.min(page, totalPages);
  const pageRows   = rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const fmt = (n) =>
    (n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const grandSettlement = monthlySummary.reduce((a, [, s]) => a + s.settlement, 0);
  const grandGst        = monthlySummary.reduce((a, [, s]) => a + s.gstAmount,  0);
  const grandNet        = monthlySummary.reduce((a, [, s]) => a + s.netAmount,  0);

  // ── Render ───────────────────────────────────────────────────
  return (
    <div>

      {detailPayment && <div className="card" data-testid="payment-details">
        <h3>Transactions — {detailsId}</h3>
        <button className="btn btn-ghost" onClick={()=>setDetailsId('')}>Close</button>
        <button className="btn btn-primary" onClick={exportDetails}>Export details</button>
        <p>Reported deduction fields are shown for reference. They are already included in settlement where applicable; do not subtract them again. Aggregate fields may overlap. Bank transfers are not expenses.</p>
        {!detailPayment.transactions && <p>Old aggregate-only payment. Transaction details are unavailable until a complete-history import.</p>}
        <div className="table-wrap"><table><thead><tr><th>Date / Reference</th><th>Settlement</th><th>GST</th><th>Reason / Deduction fields</th><th>Source</th></tr></thead><tbody>
        {(detailPayment.transactions || []).map(t=><tr key={t.key}><td>{String(t.date || 'Unknown')}<br/>{t.transactionRef || 'No reference'}</td><td>₹{fmt(t.settlement)}</td><td>₹{fmt(t.gstAmount)}</td><td>{t.reason || 'Reason not provided'}{(t.deductions || []).map((d,i)=><div key={i}>{d.label}: ₹{fmt(d.amount)}</div>)}</td><td>{t.sourceFile}<br/>{t.sourceSheet} — row {t.sourceRow}</td></tr>)}
        </tbody></table></div>
      </div>}

      {/* ── Tab bar ── */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <button
          className={`btn ${activeTab === 'reconcile' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setActiveTab('reconcile')}
        >
          💰 Reconciliation
        </button>
        <button
          className={`btn ${activeTab === 'monthly' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setActiveTab('monthly')}
        >
          📅 Monthly Report
        </button>
      </div>

      {/* ── RECONCILIATION TAB ── */}
      {activeTab === 'reconcile' && (
        <div>
          {/* Upload card */}
          <div className="card">
            <div className="card-title">Import Settlement Excel</div>
            <div className="info-banner">
              Columns: <strong>Order ID</strong> · <strong>Settlement Amount</strong> · <strong>GST %</strong> · Date<br />
              Order IDs not found in Sales Entry will be automatically skipped.
            </div>
            <div style={{ marginBottom: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={{ fontSize: 13 }}>
                Fallback GST % <span className="text-muted">(used only when the file does not state a rate)</span>
              </label>
              <input
                type="number" min="0" max="28" step="0.01" value={fallbackGst}
                onChange={(e) => setFallbackGst(e.target.value)}
                placeholder="e.g. 5"
                style={{ width: 90 }}
              />
            </div>
            <div
              className="upload-zone"
              onClick={() => fileInputRef.current && fileInputRef.current.click()}
            >
              <div className="ico-big">💳</div>
              <p><strong>Click to upload</strong> Settlement file — Meesho, Flipkart or Amazon</p>
              <p className="text-sm text-muted">Format is detected automatically. Upload one file at a time.</p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                style={{ display: 'none' }}
                onChange={(e) => importPaymentExcel(e.target.files[0])}
              />
            </div>
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                id="overwrite-chk"
                checked={overwrite}
                onChange={(e) => setOverwrite(e.target.checked)}
              />
              <label htmlFor="overwrite-chk" style={{ fontSize: 13, cursor: 'pointer', color: overwrite ? 'var(--red,#dc2626)' : 'var(--muted,#6b7280)' }}>
                {overwrite ? '⚠️ Complete-history migration ON — replaces old aggregate-only totals; old snapshot retained' : 'This file contains COMPLETE history for old aggregate-only payments'}
              </label>
            </div>
            <p className="text-muted">New transactions are added; matching source rows are skipped. Keep the original report format when importing overlapping periods. Changed report rows require review. The checkbox only migrates old totals without transaction history.</p>
            {importStatus && (
              <div style={{ color: 'var(--green)', fontWeight: 600, marginTop: 8 }}>
                {importStatus}
              </div>
            )}
          </div>

          {/* Table card */}
          <div className="card">
            <div className="card-title">Payment Reconciliation</div>
            <div className="filter-bar">
              <div className="fg">
                <label>Search</label>
                <input
                  type="text"
                  placeholder="Order ID or Customer…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="fg">
                <label>Status</label>
                <select value={fRecon} onChange={(e) => setFRecon(e.target.value)}>
                  <option value="">All</option>
                  <option value="yes">Reconciled</option>
                  <option value="no">Pending</option>
                </select>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Order ID</th>
                    <th>Customer</th>
                    <th>Channel</th>
                    <th>Order Amt</th>
                    <th>Settlement</th>
                    <th title="Sale value GST is charged on (sale minus returns)">Taxable Value</th>
                    <th>GST %</th>
                    <th>GST Amt</th>
                    <th>Net Received</th>
                    <th>Status</th>
                    <th>Date</th><th>Transactions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={12}>
                        <div className="empty">
                          No payment data. Import settlement Excel above.
                        </div>
                      </td>
                    </tr>
                  ) : pageRows.map((o) => (
                    <tr key={o.id}>
                      <td className="truncate" title={o.orderId}>{o.orderId}</td>
                      <td>{o.customer}</td>
                      <td>
                        <span className={`chip chip-${(o.channel || '').toLowerCase()}`}>
                          {o.channel}
                        </span>
                      </td>
                      <td style={{ color: (o.amount || 0) < 0 ? 'var(--red)' : '' }}>
                        ₹{(o.amount || 0).toLocaleString('en-IN')}
                      </td>
                      <td>
                        {o.pd
                          ? `₹${fmt(o.pd.settlement)}`
                          : <span className="text-muted">—</span>}
                      </td>
                      <td>{o.pd && typeof o.pd.taxableValue === 'number' ? `₹${fmt(o.pd.taxableValue)}` : '—'}</td>
                      <td>{o.pd ? (o.pd.gstPct == null ? 'Mixed' : `${o.pd.gstPct}%`) : '—'}</td>
                      <td style={{ color: 'var(--red)' }}>
                        {o.pd ? `₹${fmt(o.pd.gstAmount)}` : '—'}
                      </td>
                      <td style={{ color: 'var(--green)', fontWeight: 600 }}>
                        {o.pd
                          ? `₹${fmt(o.pd.netAmount)}`
                          : <span className="text-muted">—</span>}
                      </td>
                      <td>
                        {o.pd
                          ? <span className="status s-dispatched">✓ Reconciled</span>
                          : <span className="status s-ready">Pending</span>}
                      </td>
                      <td>{o.pd ? safeDate(o.pd.date) || '—' : '—'}</td><td>{o.pd && <button className="btn btn-ghost" onClick={()=>setDetailsId(o.orderId)}>Details ({o.pd.transactions?.length || 0})</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {rows.length > PAGE_SIZE && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, justifyContent: 'flex-end' }}>
                <span style={{ fontSize: 12, color: 'var(--muted,#6b7280)' }}>
                  Showing {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, rows.length)} of {rows.length}
                </span>
                <button className="btn btn-ghost btn-sm" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>← Prev</button>
                <span style={{ fontSize: 12 }}>Page {safePage} / {totalPages}</span>
                <button className="btn btn-ghost btn-sm" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)}>Next →</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── MONTHLY REPORT TAB ── */}
      {activeTab === 'monthly' && (
        <div className="card">
          <div className="card-title">Monthly Payment Report</div>
          <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>
            Settlement → GST deducted → Net Received (month-wise)
          </p>
          {monthlySummary.length === 0 ? (
            <div className="empty">
              <div className="big">📅</div>
              No payment data. Import in the Reconciliation tab.
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Month</th>
                    <th>Transactions</th>
                    <th>Total Settlement</th>
                    <th>GST Deducted</th>
                    <th>Net Received</th>
                  </tr>
                </thead>
                <tbody>
                  {monthlySummary.map(([month, s]) => (
                    <tr key={month}>
                      <td style={{ fontWeight: 600 }}>{month}</td>
                      <td>{s.count}</td>
                      <td>₹{fmt(s.settlement)}</td>
                      <td style={{ color: 'var(--red)' }}>₹{fmt(s.gstAmount)}</td>
                      <td style={{ color: 'var(--green)', fontWeight: 700, fontSize: 15 }}>
                        ₹{fmt(s.netAmount)}
                      </td>
                    </tr>
                  ))}
                  <tr style={{ background: 'var(--bg-alt,#f9fafb)', fontWeight: 700, borderTop: '2px solid var(--border,#e5e7eb)' }}>
                    <td>Grand Total</td>
                    <td>{monthlySummary.reduce((a, [, s]) => a + s.count, 0)}</td>
                    <td>₹{fmt(grandSettlement)}</td>
                    <td style={{ color: 'var(--red)' }}>₹{fmt(grandGst)}</td>
                    <td style={{ color: 'var(--green)', fontSize: 16 }}>₹{fmt(grandNet)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

    </div>
  );
}
