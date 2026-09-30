import { useRef, useState, useMemo } from 'react';
import * as XLSX from 'xlsx';
import { downloadTemplate, normalizeScan, normalizeReturnType, normalizeReturnReason, returnTypeClass, returnTypeLabel, RETURN_TYPES } from '../db.js';
import { toast } from './Toast.jsx';

export default function Returns({ db, setDb }) {
  const [importStatus, setImportStatus] = useState('');
  const [alreadyRows, setAlreadyRows] = useState({ transit: [], received: [] });
  // Per-row pending type before "Mark Received" — keyed by order id
 
  // ── Filter state ─────────────────────────────────────────────
  const [filterType,    setFilterType]    = useState('');   // '' | 'Customer Return' | 'RTO' | 'unknown'
  const [filterChannel, setFilterChannel] = useState('');   // '' | 'Amazon' | 'Flipkart' | 'Meesho'
  const [filterSearch,  setFilterSearch]  = useState('');   // free-text search
  const [deleteConfirm, setDeleteConfirm] = useState(null); // order id pending delete confirm

  const fileInputRef = useRef();
  // PERFORMANCE (Aug 2026): this table used to render every matching row.
  // Sales Entry had the same problem and froze for ~15s at 9,000 orders;
  // returns grow just as fast, so it pages at 50 like the other lists.
  const [page, setPage] = useState(1);
  const RET_PAGE_SIZE = 50;

  // ── Excel / CSV import ──────────────────────────────────────
  // Column detection is PATTERN-based and the header row is found
  // automatically.
  //
  // BUG THIS FIXES (Aug 2026): this used to read literal column names
  // (`row['Order ID']`, `row['AWB']`, `row['Return Type']`) off the very
  // first row of the sheet. Meesho's real "in transit" export matches
  // none of that:
  //   * seven preamble lines come first ("Meesho Supplier Panel",
  //     Supplier ID, Email, timestamp…), so row 1 is not the header at
  //     all and EVERY column came back wrong — the whole file imported
  //     nothing;
  //   * the id column is "Suborder Number", never "Order ID";
  //   * the waybill column is "AWB Number";
  //   * the type column is "Type of Return", with the value
  //     "Courier Return (RTO)" rather than "RTO".
  // Matching on Suborder Number matters most for CUSTOMER returns,
  // because those come back on a brand-new courier AWB that appears
  // nowhere in the dispatch record — the sub-order id is the only thing
  // linking the two.
  const RET_OID_RE   = [/^suborder(number|id|no)$/, /^suborderno$/, /^(sub)?order(id|no|number)$/, /suborder/, /^orderid$/];
  const RET_AWB_RE   = [/^awb(number|no)?$/, /awbnumber/, /^awb$/, /^tracking(id|no|number)?$/, /waybill/];
  const RET_TYPE_RE  = [/^typeofreturn$/, /typeofreturn/, /^returntype$/, /^type$/];
  // Meesho gives TWO reason columns: "Return Reason" is its own fixed
  // six-value taxonomy, "Detailed Return Reason" is the buyer's free-er
  // sub-choice. This list used to try the DETAILED one first.
  //
  // BUG THIS FIXES (Sep 2026, measured on a real 263-row export): the
  // detailed wording ("Product was broken or torn", "Did not like the
  // product", "Completely different product from shown") matches none of
  // normalizeReturnReason's patterns, so 58 of 97 real return reasons —
  // 60% — landed in "Others", and the "Wrong Item Sent" and "Customer
  // Changed Mind" columns of Return Analytics stayed at ZERO even though
  // the file held 9 wrong-product and 18 don't-need-it returns. The
  // categorical column maps cleanly, so it is now read first and the
  // detailed one is kept only as the fallback.
  const RET_REASON_RE= [/^returnreason$/, /^detailedreturnreason$/, /returnreason/, /^reason$/];
  function normHdr(v) { return String(v || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function pickCol(row, pats) {
    for (const re of pats) {
      for (const k of Object.keys(row)) if (re.test(normHdr(k))) return row[k];
    }
    return '';
  }
  // Find the row that actually carries the column headings, so the
  // supplier-panel preamble above it is skipped.
  function findHeaderRow(sheet) {
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      const cells = rows[i].map(normHdr);
      const hasId  = cells.some((c) => RET_OID_RE.some((re) => re.test(c)));
      const hasAwb = cells.some((c) => RET_AWB_RE.some((re) => re.test(c)));
      if (hasId || hasAwb) return i;
    }
    return 0;
  }

  function importReturnExcel(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb    = XLSX.read(e.target.result, { type: 'array' });
        const sheetName = wb.SheetNames.find(n => /^returns$/i.test(n)) || wb.SheetNames[0];
        const sheet = wb.Sheets[sheetName];
        const data  = XLSX.utils.sheet_to_json(sheet, { defval: '', range: findHeaderRow(sheet) });
        let updated = 0;
        const already = { transit: [], received: [] };
        let skipped = 0;
        // Rows whose order is ALREADY somewhere in the return lifecycle.
        // They are counted and reported, never rewound — see the status
        // guard below.
        let heldInTransit = 0;
        let heldReceived  = 0;
        let typeFilled    = 0;
        const misses = [];
        // Helper: convert Excel scientific notation (1.49083E+15) to full number string
        function fixAwb(val) {
          const s = String(val || '').trim();
          // If scientific notation like 1.49083E+15 — convert to integer string
          if (/^\d+\.?\d*[Ee][+\-]?\d+$/.test(s)) {
            return BigInt(Math.round(Number(s))).toString();
          }
          return s;
        }

        data.forEach((row) => {
          const oid = String(pickCol(row, RET_OID_RE) || '').trim();
          const awb = fixAwb(pickCol(row, RET_AWB_RE));
          const rawType = String(pickCol(row, RET_TYPE_RE) || '').trim();
          const returnReason = String(pickCol(row, RET_REASON_RE) || '').trim();
          if (!oid && !awb) return; // blank/footer line
          // Order ID links outbound and inbound waybills, which may differ.
          // Prefer it over any barcode; otherwise accept a unique exact AWB match.
          const active = db.orders.filter(o => !o.deleted);
          const byId = oid ? active.find(o => normalizeScan(o.orderId) === normalizeScan(oid)) : null;
          const awbMatches = awb ? active.filter(o =>
            [o.awb, o.returnAwb, o.invoice, ...(o.altAwbs || [])]
              .some(value => value && normalizeScan(value) === normalizeScan(awb))) : [];
          const order = byId || (awbMatches.length === 1 ? awbMatches[0] : null);
       if (!order) {
  skipped++;
  return;
}

// ── STATUS GUARD ─────────────────────────────────────────────
// BUG THIS FIXES (Sep 2026, reported by the user): this used to set
// the status unconditionally on every matched row. The Meesho /
// Flipkart / Amazon return exports are downloaded in BULK — the whole
// current in-transit list, not just today's new rows — so every
// re-import walked back over parcels that had already physically
// arrived and been scanned, flipping them from "Return Received" to
// "In Transit (Return)" and stamping a fresh transitDate. The parcel
// was on the shelf; the OMS said it was still with the courier. There
// is no date column to filter on either, so the person doing the
// import has no way to avoid it by hand.
//
// An order already in the return lifecycle is therefore LEFT ALONE:
//   • Return Received      — arrived and scanned. Never rewound.
//   • In Transit (Return)  — already known. Keeps its ORIGINAL
//                            transitDate, so "how long has this been
//                            in transit" stays truthful.
// Only an order that is not yet in the return flow gets moved.
const alreadyReceived  = order.status === 'Return Received';
const alreadyInTransit = order.status === 'In Transit (Return)';
if (alreadyReceived) { heldReceived++; already.received.push({ orderId: order.orderId, awb: awb || order.returnAwb || order.awb || '' }); }
else if (alreadyInTransit) { heldInTransit++; already.transit.push({ orderId: order.orderId, awb: awb || order.returnAwb || order.awb || '' }); }
else {
  order.status = 'In Transit (Return)';
  order.transitDate = new Date().toISOString();
  updated++;
}

// Return AWB = the CSV's AWB column value — stored ALWAYS when present,
// regardless of whether it happens to match the original Dispatch AWB
// (order.awb). Same courier/route returns often reuse the same AWB —
// that's a legitimate, common case, not something to discard.
// FIX (bug report Aug 2026, round 2): this previously only stored the
// value when it DIFFERED from order.awb (`awb !== order.awb`) — so any
// return using the same AWB as dispatch left returnAwb completely
// empty, which is exactly the "no number at all shows up" symptom at
// Return Received. Hyphens are stripped too, since some export formats
// print the AWB with them (e.g. "1490-838-585677663") and Received.jsx's
// matching needs the bare digit/alphanumeric form to line up with what
// gets scanned off the physical package.
//
// Skipping the STATUS change (above) does not mean skipping the row.
// The fields below are still filled in, because a re-import is the
// only way to repair a record that imported with a blank return_type
// under the pre-v6.8.0 parser — and a blank return_type is exactly
// what stops Received.jsx auto-marking a scan. Filling a blank is
// safe; overwriting an arrived parcel's data is not.
const cleanAwb = awb.replace(/-/g, '');
if (cleanAwb) {
  // A parcel that has already arrived keeps the AWB it was scanned
  // with. One still in transit may legitimately change courier
  // mid-route (Shadowfax handing off to XpressBees), so the newest
  // file value wins there.
  if (!alreadyReceived || !order.returnAwb) order.returnAwb = cleanAwb;
}

// Set return type — only ever FILLS A BLANK, never overwrites.
const normalised = normalizeReturnType(rawType);
const existingType = normalizeReturnType(order.return_type || order.returnType);
if (normalised && existingType && normalised !== existingType && !alreadyReceived) {
  order.returnTypeConflict = {existing:existingType,incoming:normalised,file:file.name};
}
if (normalised && !existingType) {
  order.return_type = normalised;
  if (alreadyReceived || alreadyInTransit) typeFilled++;
}

// FIX (Aug 2026): the raw Excel text used to be stored as-is. Return
// Analytics only renders the five fixed RETURN_REASONS columns plus
// "Not Tagged", so any other wording — which is every real Meesho
// return CSV, e.g. "Size/quality issue" or "Undelivered - address
// issue" — was counted under a key nothing displays and vanished from
// the report entirely. It wasn't even reaching the "Not Tagged"
// bucket, so the reason breakdown read all-zeros while returns were
// clearly present. normalizeReturnReason() already existed in db.js
// for exactly this and was simply never wired up to any caller.
const normReason = normalizeReturnReason(returnReason);
if (normReason && !order.returnReason) order.returnReason = normReason;
        });
        setDb({
  ...db,
  orders: [...db.orders]
});
        // Every row is accounted for, so a bulk re-import reads as
        // "nothing new today" instead of looking like it did nothing.
        const parts = [`✅ ${updated} new orders marked "In Transit (Return)"`];
        if (heldInTransit > 0) parts.push(`${heldInTransit} already in transit — left as they were`);
        if (heldReceived  > 0) parts.push(`${heldReceived} already Return Received — NOT reset`);
        if (typeFilled    > 0) parts.push(`${typeFilled} had a missing Return Type filled in`);
        if (skipped       > 0) parts.push(`${skipped} skipped — not in Sales Entry`);
        setImportStatus(parts.join(' · '));
        setAlreadyRows(already);
        toast(
          updated > 0
            ? `${updated} orders marked In Transit`
            : `Nothing new — ${heldInTransit + heldReceived} rows were already in the return flow`,
          updated > 0 ? 'success' : 'info'
        );
      } catch (err) { toast('Error: ' + err.message, 'error'); }
    };
    reader.readAsArrayBuffer(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  // ── Back-fill audit: orders affected by the pre-fix Shadowfax-only
  // returnAwb bug (see importReturnExcel above). Flags any Meesho
  // return whose returnAwb is still empty on a non-Shadowfax courier —
  // exactly the shape the old gate used to wipe. Re-importing the
  // original Meesho Return CSV(s) for these rows will correctly
  // populate returnAwb now that the fix is live.
  function exportBackfillCandidates() {
    const candidates = db.orders.filter((o) =>
      !o.deleted &&
      o.channel === 'Meesho' &&
      (o.status === 'In Transit (Return)' || o.status === 'Return Received') &&
      !o.returnAwb &&
      !(o.courier || '').toLowerCase().includes('shadowfax')
    );
    if (!candidates.length) {
      toast('No affected orders found — nothing needs back-filling.', 'info');
      return;
    }
    const rows = candidates.map((o) => ({
      'Order ID': o.orderId, Customer: o.customer, Channel: o.channel,
      Courier: o.courier || 'Unknown', Status: o.status,
      'Dispatch AWB': o.awb || '', 'Return AWB (missing)': o.returnAwb || '',
      'Return Type': o.return_type || '', 'Return Reason': o.returnReason || '',
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Needs Return AWB');
    XLSX.writeFile(wb, `Lavanya_ReturnAWB_Backfill_${new Date().toISOString().slice(0, 10)}.xlsx`);
    toast(`${candidates.length} orders exported — re-import their original Meesho Return CSV to fill returnAwb.`, 'success');
  }

  // ── Mark received with type confirmation ────────────────────
  function markReceived(id) {
    const o = db.orders.find((x) => x.id === id);
    if (!o) return;
    // Use the inline dropdown selection if set; fall back to existing return_type
    if (o.status === 'Return Received') {toast('Already received','info');return;}
    const chosen = normalizeReturnType(o.return_type || o.returnType);
    if (!chosen || o.returnTypeConflict) {toast('Use Return Received scan to select the missing/conflicting type','info');return;}
    o.status       = 'Return Received';
    o.receivedDate = new Date().toISOString();
    if (chosen) o.return_type = chosen;
    setDb({ ...db });
    // Clear the pending selection for this row
    toast(
      chosen
        ? `Return Received — ${returnTypeLabel(chosen)}`
        : 'Return Received (type not set)',
      'success'
    );
  }

  // Inline type change without saving yet (shows badge immediately)
  function deleteReturn(id) {
    const o = db.orders.find((x) => x.id === id);
    if (!o) return;
    o.status      = o.dispatchedAt ? 'Dispatched' : 'Ready to Ship';
    o.return_type = '';
    delete o.transitDate;
    delete o.receivedDate;
    setDb({
  ...db,
  orders: [...db.orders]
});
    setDeleteConfirm(null);
    toast('Return entry deleted — order reverted', 'info');
  }

 

  // ── Also show "Return Received" tab ─────────────────────────
  const [activeTab, setActiveTab] = useState('transit'); // 'transit' | 'received'

  const allTransit  = db.orders.filter((o) => o.status === 'In Transit (Return)'  && !o.deleted);
  const allReceived = db.orders.filter((o) => o.status === 'Return Received'       && !o.deleted);

  // ── Counts for summary strip (based on full transit list, before filters) ──
  const custCount = allTransit.filter((o) => o.return_type === 'Customer Return').length;
  const rtoCount  = allTransit.filter((o) => o.return_type === 'RTO').length;
  const unknCount = allTransit.filter((o) => !o.return_type).length;

  // ── Apply filters to whichever tab is active ─────────────────
  function applyFilters(list) {
    const q = filterSearch.toLowerCase();
    return list.filter((o) => {
      if (filterChannel && o.channel !== filterChannel) return false;
      if (filterType === 'unknown' && o.return_type) return false;
      if (filterType && filterType !== 'unknown' && o.return_type !== filterType) return false;
      if (q && !`${o.orderId} ${o.customer} ${o.awb || ''} ${o.returnAwb || ''} ${o.sku || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  const displayList = applyFilters(activeTab === 'transit' ? allTransit : allReceived);
  const retTotalPages = Math.max(1, Math.ceil(displayList.length / RET_PAGE_SIZE));
  const retSafePage = Math.min(page, retTotalPages);
  const pageRows = displayList.slice((retSafePage - 1) * RET_PAGE_SIZE, retSafePage * RET_PAGE_SIZE);
  // Back to page 1 whenever the tab or filters change.
  const retKey = `${activeTab}|${filterType}|${filterChannel}|${filterSearch}`;
  const retKeyRef = useRef(retKey);
  if (retKeyRef.current !== retKey) { retKeyRef.current = retKey; if (page !== 1) setPage(1); }

  function clearFilters() {
    setFilterType('');
    setFilterChannel('');
    setFilterSearch('');
  }

  // ── Return type badge inline component ──────────────────────
  function ReturnBadge({ rt }) {
    const cls = returnTypeClass(rt);
    const lbl = returnTypeLabel(rt);
    // Map class → inline color style as a fallback for apps not loading styles.css
    const styleMap = {
      'rt-customer': { background: '#dbeafe', color: '#1d4ed8', border: '1px solid #93c5fd' },
      'rt-rto':      { background: '#fef9c3', color: '#854d0e', border: '1px solid #fcd34d' },
      'rt-unknown':  { background: '#f3f4f6', color: '#6b7280', border: '1px solid #d1d5db' },
    };
    return (
      <span
        className={`return-type-badge ${cls}`}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '2px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600,
          whiteSpace: 'nowrap',
          ...(styleMap[cls] || styleMap['rt-unknown']),
        }}
      >
        {lbl}
      </span>
    );
  }

  return (
    <div>
      {/* ── Upload card ── */}
      <div className="card">
        <div className="card-title">Import Return Transit Excel</div>
        <div className="info-banner">
          Add a <strong>"Return Type"</strong> column to your Excel with values
          <strong> Customer Return</strong> or <strong>RTO</strong> and they will be
          auto-tagged on import. You can also set or change the type inline in the table below.
        </div>
        <div
          className="upload-zone"
          onClick={() => fileInputRef.current?.click()}
        >
          <div className="ico-big">📊</div>
          <p><strong>Click to upload</strong> Excel / CSV file</p>
          <p>Columns: Order ID, AWB, Status, Return Type</p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv,.tsv"
            style={{ display: 'none' }}
            onChange={(e) => importReturnExcel(e.target.files[0])}
          />
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {['transit', 'received'].map(key => alreadyRows[key].length > 0 && (
            <details key={key} style={{ width: '100%' }}>
              <summary>{key === 'transit' ? 'Already in transit' : 'Already received'} ({alreadyRows[key].length})</summary>
              <div style={{ maxHeight: 240, overflow: 'auto' }}>
                <table><thead><tr><th>Order ID</th><th>AWB</th></tr></thead>
                  <tbody>{alreadyRows[key].map((row, index) => <tr key={index}><td>{row.orderId}</td><td>{row.awb}</td></tr>)}</tbody>
                </table>
              </div>
            </details>
          ))}
          {importStatus && (
            <div style={{ color: 'var(--green)', fontWeight: 600 }}>{importStatus}</div>
          )}
          <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }}
            onClick={exportBackfillCandidates}
            title="Orders whose Return AWB is still missing because of the pre-fix Shadowfax-only bug">
            🩹 Export Return-AWB Backfill List
          </button>
          <button className="btn btn-ghost btn-sm"
            onClick={() => downloadTemplate('returns')}>
            ⬇ Download Template
          </button>
        </div>
      </div>

      {/* ── Returns Table Card ── */}
      <div className="card">

        {/* ── Tab bar ──────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 14, borderBottom: '2px solid var(--border,#e5e7eb)' }}>
          {[
            { key: 'transit',  label: `🔄 In Transit (${allTransit.length})` },
            { key: 'received', label: `✅ Received (${allReceived.length})` },
          ].map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              style={{
                padding: '6px 16px', border: 'none', cursor: 'pointer',
                fontWeight: activeTab === key ? 700 : 400,
                fontSize: 14,
                background: 'transparent',
                borderBottom: activeTab === key ? '2px solid var(--accent)' : '2px solid transparent',
                color: activeTab === key ? 'var(--accent)' : 'var(--muted)',
                marginBottom: -2,
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* ── Summary strip (transit tab only) ─────────────── */}
        {activeTab === 'transit' && allTransit.length > 0 && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--muted)' }}>Summary:</span>
            <span
              className="return-type-badge rt-customer"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 12px',
                borderRadius: 999, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                background: '#dbeafe', color: '#1d4ed8', border: '1px solid #93c5fd',
              }}
              onClick={() => setFilterType(filterType === 'Customer Return' ? '' : 'Customer Return')}
              title="Click to filter by Customer Return"
            >
              ↩ Customer Return: {custCount}
            </span>
            <span
              className="return-type-badge rt-rto"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 12px',
                borderRadius: 999, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                background: '#fef9c3', color: '#854d0e', border: '1px solid #fcd34d',
              }}
              onClick={() => setFilterType(filterType === 'RTO' ? '' : 'RTO')}
              title="Click to filter by RTO"
            >
              🚚 RTO: {rtoCount}
            </span>
            {unknCount > 0 && (
              <span
                className="return-type-badge rt-unknown"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 12px',
                  borderRadius: 999, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                  background: '#f3f4f6', color: '#6b7280', border: '1px solid #d1d5db',
                }}
                onClick={() => setFilterType(filterType === 'unknown' ? '' : 'unknown')}
                title="Click to filter by Unknown type"
              >
                — Unknown: {unknCount}
              </span>
            )}
          </div>
        )}

        {/* ── Filter bar ───────────────────────────────────── */}
        <div className="filter-bar" style={{ marginBottom: 12 }}>
          {/* Search */}
          <div className="fg">
            <label>Search</label>
            <input
              type="text"
              placeholder="Order ID, Customer, AWB…"
              value={filterSearch}
              onChange={(e) => setFilterSearch(e.target.value)}
            />
          </div>

          {/* Return Type filter — only relevant on transit tab */}
          {activeTab === 'transit' && (
            <div className="fg">
              <label>Return Type</label>
              <select value={filterType} onChange={(e) => setFilterType(e.target.value)}>
                <option value="">All Types</option>
                <option value="Customer Return">↩ Customer Return</option>
                <option value="RTO">🚚 RTO</option>
                <option value="unknown">— Unknown</option>
              </select>
            </div>
          )}

          {/* Channel filter */}
          <div className="fg">
            <label>Channel</label>
            <select value={filterChannel} onChange={(e) => setFilterChannel(e.target.value)}>
              <option value="">All</option>
              <option>Amazon</option>
              <option>Flipkart</option>
              <option>Meesho</option>
            </select>
          </div>

          {/* Clear */}
          <div>
            <label>&nbsp;</label>
            <button className="btn btn-ghost btn-sm" onClick={clearFilters}>✕ Clear</button>
          </div>
        </div>

        {/* ── Active filter chips ──────────────────────────── */}
        {(filterType || filterChannel || filterSearch) && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)', alignSelf: 'center' }}>Filtering:</span>
            {filterSearch && (
              <span style={{ background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: 999, padding: '2px 10px', fontSize: 12, fontWeight: 600 }}>
                "{filterSearch}" <span style={{ cursor: 'pointer' }} onClick={() => setFilterSearch('')}>×</span>
              </span>
            )}
            {filterType && (
              <span style={{ background: '#dbeafe', color: '#1d4ed8', borderRadius: 999, padding: '2px 10px', fontSize: 12, fontWeight: 600 }}>
                {filterType === 'unknown' ? '— Unknown' : filterType} <span style={{ cursor: 'pointer' }} onClick={() => setFilterType('')}>×</span>
              </span>
            )}
            {filterChannel && (
              <span style={{ background: '#d1fae5', color: '#065f46', borderRadius: 999, padding: '2px 10px', fontSize: 12, fontWeight: 600 }}>
                {filterChannel} <span style={{ cursor: 'pointer' }} onClick={() => setFilterChannel('')}>×</span>
              </span>
            )}
            <span style={{ fontSize: 12, color: 'var(--muted)', alignSelf: 'center' }}>
              — {displayList.length} result{displayList.length !== 1 ? 's' : ''}
            </span>
          </div>
        )}

        {/* ── Table ────────────────────────────────────────── */}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Order ID</th>
                <th>Customer</th>
                <th>Channel</th>
                <th>Dispatch AWB</th>
<th>Return AWB</th>
                <th>SKU</th>
                <th>Return Type</th>
               <th>Return Reason</th>
<th>{activeTab === 'transit' ? 'Transit Date' : 'Received Date'}</th>
                {activeTab === 'transit' && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {displayList.length === 0 ? (
                <tr>
                  <td colSpan={activeTab === 'transit' ? 8 : 7}>
                    <div className="empty">
                      {allTransit.length === 0 && activeTab === 'transit'
                        ? 'No return transit orders. Import an Excel or mark orders from Sales.'
                        : allReceived.length === 0 && activeTab === 'received'
                          ? 'No received returns yet.'
                          : 'No orders match the current filters.'}
                    </div>
                  </td>
                </tr>
              ) : (
                pageRows.map((o) => (
                  <tr key={o.id}>
                    <td className="truncate" title={o.orderId}>{o.orderId}</td>
                    <td>{o.customer}</td>
                    <td>
                      <span className={`chip chip-${(o.channel || '').toLowerCase()}`}>{o.channel}</span>
                    </td>
                    <td>{o.awb || '—'}</td>
<td>
  {o.returnAwb && o.returnAwb !== o.awb
    ? o.returnAwb
    : '—'}
</td>
                    <td className="truncate" title={o.sku}>{o.sku || '—'}</td>

                    {/* ── Return Type cell — color badge + inline selector (transit only) ── */}
                   <td>
  <ReturnBadge rt={o.return_type} />
</td>

<td>
  {o.returnReason || '—'}
</td>

<td>
  {activeTab === 'transit'
                        ? (o.transitDate  ? new Date(o.transitDate).toLocaleDateString('en-IN')  : '—')
                        : (o.receivedDate ? new Date(o.receivedDate).toLocaleDateString('en-IN') : '—')}
                    </td>

                    {activeTab === 'transit' && (
                      <td>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <button
                            className="btn btn-ghost btn-xs"
                            onClick={() => markReceived(o.id)}
                            title={o.return_type ? `Mark Received as ${o.return_type}` : 'Select missing Return Type in Return Received'}
                          >
                            ✅ Mark Received
                          </button>
                          {deleteConfirm === o.id ? (
                            <>
                              <button
                                className="btn btn-xs"
                                style={{ background: '#fef2f2', color: '#dc2626', border: '1px solid #fca5a5' }}
                                onClick={() => deleteReturn(o.id)}
                              >
                                ⚠ Confirm Delete
                              </button>
                              <button className="btn btn-ghost btn-xs" onClick={() => setDeleteConfirm(null)}>Cancel</button>
                            </>
                          ) : (
                            <button
                              className="btn btn-ghost btn-xs"
                              style={{ color: '#dc2626' }}
                              onClick={() => setDeleteConfirm(o.id)}
                              title="Delete this return entry"
                            >
                              🗑 Delete
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {displayList.length > RET_PAGE_SIZE && (
          <div className="flex gap-2 mt-2" style={{ alignItems: 'center', justifyContent: 'center' }}>
            <button className="btn btn-ghost btn-sm" disabled={retSafePage <= 1} onClick={() => setPage(retSafePage - 1)}>← Prev</button>
            <span className="text-sm text-muted">
              Page {retSafePage} of {retTotalPages} · showing {pageRows.length} of {displayList.length.toLocaleString('en-IN')}
            </span>
            <button className="btn btn-ghost btn-sm" disabled={retSafePage >= retTotalPages} onClick={() => setPage(retSafePage + 1)}>Next →</button>
          </div>
        )}

      </div>
    </div>
  );
}
