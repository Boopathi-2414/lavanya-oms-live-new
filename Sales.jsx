import { useState, useRef, useMemo } from 'react';
import { genId, today, statusClass, syncSkusFromOrders, findBadAwbOrders, extractPdfText, parseByChannel, checkFraud, createOcrWorker, detectRepeatReturners, repeatReturnerLabel, detectSameItemReturnRisk, COMPANIES } from '../db.js';
import { upsertCustomerProfile, isSupabaseConfigured } from '../supabase.js';
import { toast } from './Toast.jsx';
import * as XLSX from 'xlsx';

export default function Sales({ db, setDb }) {
  // ── PDF Upload ──────────────────────────────────────────────
  const [pdfChannel,  setPdfChannel]  = useState('Auto-Detect');
  const [pdfStatus,   setPdfStatus]   = useState(null);
  const [pdfProgress, setPdfProgress] = useState(0);
  const [parseLog,    setParseLog]    = useState([]);   // Feature 1: parse log
  const [showLog,     setShowLog]     = useState(false);
  const [ocrActive,   setOcrActive]   = useState(false); // true while Tesseract OCR is recovering an image-only label page
  const [batchCompanyCounts, setBatchCompanyCounts] = useState(null); // Feature 5: per-company counts for the just-uploaded batch
  const pdfInputRef = useRef();

  // ── Filters ─────────────────────────────────────────────────
  const [search,    setSearch]    = useState('');
  const [fChannel,  setFChannel]  = useState('');
  const [fCompany,  setFCompany]  = useState(''); // Feature 5: multi-company filter
  const [fStatus,   setFStatus]   = useState('');
  const [fPayment,  setFPayment]  = useState('');
  const [fType,     setFType]     = useState('');       // Feature 2: Exchange filter
  const [fFrom,     setFFrom]     = useState('');
  const [fTo,       setFTo]       = useState('');
  const [sortCol,   setSortCol]   = useState('orderDate');
  const [sortDir,   setSortDir]   = useState(-1);
  const [page, setPage] = useState(1);
  const [selected,  setSelected]  = useState(new Set());

  // ── Manual order modal ───────────────────────────────────────
  const [showOrderModal, setShowOrderModal] = useState(false);
  const [mForm, setMForm] = useState({
    orderId: '', awb: '', customer: '', sku: '', quantity: 1,
    channel: 'Amazon', payment: 'Prepaid', orderDate: today(), amount: '',
    orderType: 'Regular', company: '',
  });

  // ── Helpers ──────────────────────────────────────────────────
  // ── Validation log: tracks every page that failed AWB extraction
  // so the user can manually inspect the source PDF.
  // Exported as 'failed_labels.json' via the Download button in the parse log.
  function buildFailedLabelsLog(allLogs, fileMap) {
    return allLogs
      .filter((l) => l.status !== 'ok' || l.awbMissing)
      .map((l) => ({
        filename: l.file || 'unknown',
        page: l.page,
        status: l.status,
        reason: l.reason || '',
        orderId: l.orderId || null,
        awb: l.awb || null,
        timestamp: new Date().toISOString(),
      }));
  }

  function downloadFailedLabels(allLogs) {
    const failed = buildFailedLabelsLog(allLogs);
    if (!failed.length) { toast('No failures to export', 'info'); return; }
    const blob = new Blob([JSON.stringify(failed, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `failed_labels_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`${failed.length} failed entry/entries exported`, 'info');
  }

  async function parsePDFs(files) {
    if (!files || !files.length) return;
    setPdfStatus('loading');
    setPdfProgress(0);
    setParseLog([]);
    setBatchCompanyCounts(null);

    let totalParsed = 0;
    let totalSuccess = 0;
    let allLogs = [];
    const companyCounts = {}; // Feature 5: per-company counts for this batch only

    // ── OCR worker: created lazily on first image-only page, reused for
    // the whole batch, torn down once every file is processed. Keeps the
    // (relatively slow, ~1-2s) Tesseract init cost to at most once per
    // upload instead of once per page.
    let ocrWorker = null;
    const getOcrWorker = async () => {
      if (!ocrWorker) {
        setOcrActive(true);
        try {
          ocrWorker = await createOcrWorker();
        } catch (e) {
          console.error('Failed to start OCR worker:', e);
          toast('OCR engine failed to load — image-only labels will fall back to Invoice Ref', 'info');
          return null;
        }
      }
      return ocrWorker;
    };

    for (const file of files) {
      try {
        const text   = await extractPdfText(file, getOcrWorker);
        const ch     = pdfChannel === 'Auto-Detect' ? '' : pdfChannel;
        const result = parseByChannel(text, ch);

        // ── Feature 1: accumulate parse log ───────────────────
        const fileLogs = (result.parseLog || []).map((l) => ({ ...l, file: file.name }));
        allLogs = [...allLogs, ...fileLogs];

        result.orders.forEach((o) => {
          if (!db.orders.find((x) => x.orderId === o.orderId && !x.deleted)) {
            // ── Feature 4: fraud check on import ──────────────
            const fraudMatch = checkFraud(db.fraudList, o);
            db.orders.push({
              ...o,
              id: genId(),
              status: 'Ready to Ship',
              createdAt: new Date().toISOString(),
              fraudAlert: fraudMatch ? `⚠️ Matches blocklist entry: ${fraudMatch.customer || fraudMatch.phone || fraudMatch.address}` : '',
            });
            totalSuccess++;
            // Feature 5: tally this order under its detected company for the batch summary
            const coLabel = o.company || 'Unknown';
            companyCounts[coLabel] = (companyCounts[coLabel] || 0) + 1;
            // Background-only sync: name/address/phone never render in the
            // Sales table (see the table <thead> below — there is no
            // Address column), but they're sent to Supabase here so future
            // imports of the same buyer can be matched for the repeat-
            // returner flag even across browser sessions/devices. Fully
            // fire-and-forget — a slow or unreachable Supabase project
            // never delays or blocks the PDF import loop.
            upsertCustomerProfile({
              customer: o.customer, phone: o.phone, address: o.address,
              companyId: o.companyId, channel: o.channel, orderId: o.orderId,
              orderType: o.orderType,
            });
          }
        });
        totalParsed++;
        setPdfProgress(Math.round((totalParsed / files.length) * 100));
      } catch (e) {
        console.error('PDF error:', e);
        allLogs.push({ page: '?', status: 'error', reason: e.message, file: file.name, orderId: null });
      }
    }

    if (ocrWorker) {
      try { await ocrWorker.terminate(); } catch (_) { /* ignore */ }
      setOcrActive(false);
    }

    // Every SKU that just arrived on a label gets a Purchase Rates row
    // (once, rate 0) so the cost can be filled in from one place instead
    // of hunting for which products are new. Existing rates untouched.
    const newSkus = syncSkusFromOrders(db.orders, db.products);
    if (newSkus.length) db.products.push(...newSkus);

    const next = { ...db };
    setDb(next);
    setParseLog(allLogs);
    setPdfStatus({ success: totalSuccess, parsed: totalParsed, logs: allLogs });
    setBatchCompanyCounts(companyCounts);

    const skipped = allLogs.filter((l) => l.status !== 'ok').length;
    toast(`${totalSuccess} orders imported`, totalSuccess > 0 ? 'success' : 'info');
    if (newSkus.length) {
      toast(`${newSkus.length} new SKU(s) added to Purchase Rates — set their cost there`, 'info');
    }
    if (skipped > 0) toast(`${skipped} page(s) skipped — see Parse Log`, 'info');
    if (pdfInputRef.current) pdfInputRef.current.value = '';
  }

  function getFiltered() {
    const q = search.toLowerCase();
    return db.orders
      .filter((o) => {
        if (o.deleted) return false;
        if (q && !`${o.orderId} ${o.customer} ${o.awb || ''} ${o.sku || ''} ${o.invoice || ''}`.toLowerCase().includes(q)) return false;
        if (fChannel && o.channel   !== fChannel) return false;
        if (fCompany && (o.company || 'Unknown') !== fCompany) return false;
        if (fStatus  && o.status    !== fStatus)  return false;
        if (fPayment && o.payment   !== fPayment) return false;
        if (fType    && (o.orderType || 'Regular') !== fType) return false;
        if (fFrom && o.orderDate < fFrom) return false;
        if (fTo   && o.orderDate > fTo)   return false;
        return true;
      })
      .sort((a, b) => {
        let av = a[sortCol] ?? '', bv = b[sortCol] ?? '';
        if (sortCol === 'amount') { av = +av; bv = +bv; }
        if (av < bv) return -1 * sortDir;
        if (av > bv) return  1 * sortDir;
        return 0;
      });
  }

  function handleSort(col) {
    if (sortCol === col) setSortDir((d) => d * -1);
    else { setSortCol(col); setSortDir(1); }
  }

  function softDelete(id, batch = false) {
    const idx = db.orders.findIndex((o) => o.id === id);
    if (idx === -1) return;
    const o = { ...db.orders[idx], deleted: true, deletedAt: new Date().toISOString() };
    db.trash.push(o);
    db.orders.splice(idx, 1);
    if (!batch) {
      setDb({ ...db });
      toast('Moved to trash', 'success');
    }
  }

  function bulkDelete() {
    if (!selected.size) { toast('Select orders first', 'error'); return; }
    selected.forEach((id) => softDelete(id, true));
    setDb({ ...db });
    toast(`${selected.size} orders moved to trash`, 'success');
    setSelected(new Set());
  }

  function saveManualOrder() {
    if (!mForm.orderId.trim()) { toast('Order ID required', 'error'); return; }
    const fraudMatch = checkFraud(db.fraudList, mForm);
    db.orders.push({
      ...mForm,
      company: mForm.company || 'Unknown',
      companyId: mForm.company ? (COMPANIES.find((c) => c.name === mForm.company)?.id || 'unknown') : 'unknown',
      id: genId(),
      amount: parseFloat(mForm.amount) || 0,
      quantity: parseInt(mForm.quantity, 10) || 1,
      status: 'Ready to Ship',
      createdAt: new Date().toISOString(),
      fraudAlert: fraudMatch ? `⚠️ Matches blocklist entry: ${fraudMatch.customer || fraudMatch.phone || fraudMatch.address}` : '',
    });
    setDb({ ...db });
    setShowOrderModal(false);
    toast('Order added', 'success');
    setMForm({ orderId: '', awb: '', customer: '', sku: '', quantity: 1, channel: 'Amazon', payment: 'Prepaid', orderDate: today(), amount: '', orderType: 'Regular', company: '' });
  }

  function exportOrders() {
    const rows = getFiltered().map((o) => ({
      'Order ID': o.orderId, Customer: o.customer, Company: o.company || 'Unknown', Channel: o.channel,
      'AWB / Ref': o.awb || '', SKU: o.sku || '', Quantity: o.quantity || 1, Payment: o.payment,
      Amount: o.amount || 0, Status: o.status, 'Order Date': o.orderDate,
      'Order Type': o.orderType || 'Regular',
      'Fraud Alert': o.fraudAlert || '',
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Orders');
    XLSX.writeFile(wb, 'Lavanya_Orders.xlsx');
    toast('Exported', 'success');
  }

  function toggleRow(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll(checked) {
    setSelected(checked ? new Set(getFiltered().map((o) => o.id)) : new Set());
  }

  // Memoised: without this the whole list is re-filtered and re-sorted on
  // every render, including renders caused by unrelated state.
  const filtered = useMemo(
    () => getFiltered(),
    [db.orders, search, fChannel, fCompany, fStatus, fPayment, fType, fFrom, fTo, sortCol, sortDir]
  );
  const arrow      = (col) => sortCol === col ? (sortDir === 1 ? ' ↑' : ' ↓') : ' ↕';
  const logOk      = parseLog.filter((l) => l.status === 'ok').length;
  const logSkipped = parseLog.filter((l) => l.status !== 'ok').length;
  const logAwbMissing = parseLog.filter((l) => l.status === 'ok' && !l.awb).length;
  // History-based fraud signal: same customer name / address showing up
  // repeatedly with a high return rate. Separate concept from the manual
  // blocklist (o.fraudAlert) above — both badges can appear on the same row.
  // PERFORMANCE (Aug 2026): this walks every order and groups them by
  // customer/address. It used to run on EVERY render — including on each
  // keystroke in the search box — so at 9,000 orders typing one letter
  // re-scanned all 9,000. Memoised so it only recomputes when the orders
  // themselves change.
  const repeatReturnMap = useMemo(() => detectRepeatReturners(db.orders), [db]);

  const sameItemRisk=useMemo(()=>detectSameItemReturnRisk(db.orders),[db]);
  const reviewOrders=db.orders.filter(o=>!o.deleted && o.status==='Ready to Ship' && (o.fraudAlert || sameItemRisk.has(o.id) || repeatReturnMap.has(o.id)));

  // ── Feature 5: multi-company segregation summary ──────────────────
  // Counts the *currently filtered* view, so combining this with the
  // Company dropdown above gives an always-accurate per-company count —
  // never mixed across companies — for whatever slice the user is
  // looking at (e.g. filtered to "Ready to Ship" before a dispatch run).
  // One pass instead of four full scans of the filtered list per render.
  const companySummary = useMemo(() => {
    const counts = new Map();
    for (const o of filtered) {
      const k = o.company || 'Unknown';
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    return [...COMPANIES.map((c) => c.name), 'Unknown'].map((name) => ({ name, count: counts.get(name) || 0 }));
  }, [filtered]);

  // ── Pagination ────────────────────────────────────────────────
  // PERFORMANCE (Aug 2026): the table rendered EVERY matching order.
  // Measured at 9,000 orders: 9,000 rows in the DOM, 15s to open the
  // page and 30s to change a filter — the "Sales Entry takes two or
  // three minutes" complaint. Every other list view already paged at 50;
  // this one never did. Browsers cannot lay out that many rows quickly,
  // and no amount of paying for a bigger database changes it, because
  // the work is happening in the browser, not on the server.
  const filterKey = `${search}|${fChannel}|${fCompany}|${fStatus}|${fPayment}|${fType}|${fFrom}|${fTo}`;
  const lastFilterKey = useRef(filterKey);
  if (lastFilterKey.current !== filterKey) { lastFilterKey.current = filterKey; if (page !== 1) setPage(1); }

  // Orders whose AWB can never be scanned — see findBadAwbOrders.
  const badAwbOrders = useMemo(() => findBadAwbOrders(db.orders), [db.orders]);
  function exportBadAwbs() {
    const rows = badAwbOrders.map((o) => ({
      'Order ID': o.orderId, 'Stored AWB': o.awb || '', Problem: o.awbIssue,
      Channel: o.channel, Courier: o.courier || '', Company: o.company || '',
      SKU: o.sku || '', Customer: o.customer || '', Status: o.status,
      'Order Date': o.orderDate || '',
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Bad AWBs');
    XLSX.writeFile(wb, `Bad_AWBs_${new Date().toISOString().slice(0, 10)}.xlsx`);
    toast(`${rows.length} order(s) exported`, 'success');
  }

  const SALES_PAGE_SIZE = 50;
  const totalPages = Math.max(1, Math.ceil(filtered.length / SALES_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = useMemo(
    () => filtered.slice((safePage - 1) * SALES_PAGE_SIZE, safePage * SALES_PAGE_SIZE),
    [filtered, safePage]
  );

  return (
    <div>
      {reviewOrders.length>0 && <div role="alert" data-testid="return-risk-alert" className="card" style={{border:'2px solid #dc2626',background:'#fff1f1'}}>
        <h3>Dispatch செய்யும் முன் சரிபார்க்கவும் — {reviewOrders.length} parcels</h3>
        <p>Repeated return history / blocklist match. இன்று அனுப்புவதை நிறுத்தி விவரங்களைச் சரிபார்க்கவும். இது risk warning மட்டுமே; உறுதிப்படுத்தப்பட்ட fraud அல்ல. Name-only match வேறு வாடிக்கையாளராக இருக்கலாம்.</p>
        {reviewOrders.slice(0,50).map(o=><div key={o.id}><strong>{o.orderId}</strong> — AWB {o.awb} — {o.customer} — {o.sku} — {sameItemRisk.has(o.id) ? `Same item returned ${sameItemRisk.get(o.id).returnedOrders} times (${sameItemRisk.get(o.id).matchedOn})` : o.fraudAlert || repeatReturnerLabel(repeatReturnMap.get(o.id))}</div>)}
        {reviewOrders.length>50 && <p>Showing first 50; use the risk badges in Sales / Fraud Analysis for the remaining orders.</p>}
      </div>}
      {/* ── PDF Upload ── */}
      <div className="card">
        <div className="card-title">Upload Marketplace PDFs</div>
        <details className="dev-note">
          <summary>How AWB reading works</summary>
          <div> AWB/Tracking ID is only accepted when it matches a known courier signature (e.g. Shadowfax "SF…FPL"), sits directly next to an "AWB / Tracking / Waybill" label, or — for Delhivery/Ekart-style labels that print a bare barcode number with no keyword at all — sits inside the "Return Code → Product Details" window of a label that names a real courier. Random numbers elsewhere on the page (GST digits, pincodes) are never captured.
          Some Amazon labels are flattened raster images with no text layer at all — for those, the app now
          automatically runs OCR (Tesseract.js) on the label page to read the AWB off the pixels, using these same strict rules. If OCR
          can't recover it either, the order falls back to Invoice Number (IN-xxx); scan the physical AWB in
          <strong> Scan &amp; Dispatch</strong> to correct the record.
          Meesho/Meesho-style labels' Customer Name and Sub-Order ID are parsed the same strict way — fixed in this version to correctly handle the courier block's text sitting on the same line as the "Customer Address" heading.</div>
        </details>
        <div className="info-banner" style={{ marginTop: 8 }}>
          <strong>Background fraud sync:</strong>{' '}
          {isSupabaseConfigured()
            ? 'Connected — customer name/address/phone are being saved to Supabase in the background for repeat-returner detection.'
            : 'Not configured — running on local data only. See supabase_schema.sql and .env.example to enable cross-device fraud history.'}
        </div>
        <div className="form-row">
          <div>
            <label>Select Marketplace</label>
            <select value={pdfChannel} onChange={(e) => setPdfChannel(e.target.value)}>
              <option value="Auto-Detect">Auto-Detect</option>
              <option value="Amazon">Amazon</option>
              <option value="Flipkart">Flipkart</option>
              <option value="Meesho">Meesho</option>
            </select>
          </div>
          <div>
            <label>Upload PDF(s)</label>
            <div
              className="upload-zone"
              onClick={() => pdfInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }}
              onDragLeave={(e) => e.currentTarget.classList.remove('drag-over')}
              onDrop={(e) => {
                e.preventDefault();
                e.currentTarget.classList.remove('drag-over');
                parsePDFs(e.dataTransfer.files);
              }}
            >
              <div className="ico-big">📄</div>
              <p><strong>Click or drag</strong> shipping label PDFs here</p>
              <p>Supports multi-page bulk PDFs (Amazon, Flipkart, Meesho)</p>
              <input
                ref={pdfInputRef}
                type="file"
                multiple
                accept=".pdf"
                style={{ display: 'none' }}
                onChange={(e) => parsePDFs(e.target.files)}
              />
            </div>
          </div>
        </div>

        {pdfStatus === 'loading' && (
          <div>
            <div className="progress"><div className="progress-bar" style={{ width: `${pdfProgress}%` }} /></div>
            <p className="text-sm text-muted mt-2">Parsing… {pdfProgress}%</p>
            {ocrActive && (
              <p className="text-sm" style={{ color: 'var(--gold, #b45309)', fontWeight: 600 }}>
                🔎 Running OCR on image-only label page(s)… this can take a little longer.
              </p>
            )}
          </div>
        )}
        {pdfStatus && pdfStatus !== 'loading' && (
          <div style={{ marginTop: 12 }}>
            <div style={{ color: 'var(--green)', fontWeight: 600 }}>
              ✅ Done! Imported {pdfStatus.success} new order(s) from {pdfStatus.parsed} file(s).
            </div>
            {/* Feature 5: per-company breakdown for this exact upload batch */}
            {batchCompanyCounts && Object.keys(batchCompanyCounts).length > 0 && (
              <div className="info-banner" style={{ marginTop: 8 }}>
                <strong>🏢 Company Breakdown (this batch):</strong>{' '}
                {Object.entries(batchCompanyCounts).map(([name, cnt], i) => (
                  <span key={name}>
                    {i > 0 && ' | '}
                    {name}: {cnt} Order{cnt === 1 ? '' : 's'}
                  </span>
                ))}
              </div>
            )}
            {/* Feature 1: parse log summary */}
            {parseLog.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className="status s-dispatched">✓ {logOk} parsed OK</span>
                  {logSkipped > 0 && (
                    <span className="status s-transit">⚠ {logSkipped} skipped/duplicate</span>
                  )}
                  {logAwbMissing > 0 && (
                    <span className="status s-cod" title="Orders parsed but AWB could not be extracted — scan at dispatch">⚠ {logAwbMissing} AWB missing</span>
                  )}
                  {parseLog.filter((l) => l.status !== 'ok').length > 0 && (
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ color: 'var(--red)' }}
                      onClick={() => downloadFailedLabels(parseLog)}
                      title="Download failed_labels.json for manual review"
                    >
                      ⬇ failed_labels.json
                    </button>
                  )}
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setShowLog((v) => !v)}
                  >
                    {showLog ? '▲ Hide' : '▼ Show'} Parse Log
                  </button>
                </div>
                {showLog && (
                  <div className="parse-log">
                    <table style={{ width: '100%', fontSize: 12 }}>
                      <thead>
                        <tr>
                          <th>File</th><th>Page</th><th>Status</th><th>AWB</th><th>Order ID</th><th>Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {parseLog.map((l, i) => (
                          <tr key={i} style={{ background: l.status === 'ok' ? 'transparent' : '#fff8e1' }}>
                            <td style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={l.file}>{l.file || '—'}</td>
                            <td>{l.page}</td>
                            <td>
                              {l.status === 'ok'        && <span className="status s-dispatched">OK</span>}
                              {l.status === 'duplicate' && <span className="status s-transit">Duplicate</span>}
                              {l.status === 'skipped'   && <span className="status s-cod">Skipped</span>}
                              {l.status === 'error'     && <span className="status" style={{background:'#fef2f2',color:'#b91c1c'}}>Error</span>}
                            </td>
                            <td style={{ fontFamily: 'monospace', fontSize: 11 }}>
                              {l.awb
                                ? <span style={{ color: 'var(--green)' }}>{l.awb}</span>
                                : l.status === 'ok'
                                  ? <span style={{ color: 'var(--red)' }} title="AWB not extracted — check label manually">⚠ missing</span>
                                  : '—'}
                            </td>
                            <td style={{ fontFamily: 'monospace' }}>{l.orderId || '—'}</td>
                            <td style={{ color: 'var(--muted)' }}>{l.reason || ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Orders Table ── */}
      <div className="card">
        <div className="flex items-center gap-3 mb-3" style={{ flexWrap: 'wrap' }}>
          <div className="card-title" style={{ margin: 0 }}>All Sales Orders</div>
          <div style={{ flex: 1 }} />
          <button className="btn btn-ghost btn-sm" onClick={() => setShowOrderModal(true)}>+ Add Manual</button>
          <button className="btn btn-outline btn-sm" onClick={exportOrders}>⬇ Export</button>
        </div>

        {/* Feature 5: live, filter-aware company segregation summary */}
        <div className="info-banner" style={{ marginBottom: 12 }}>
          <strong>🏢 Companies ({fCompany ? 'filtered' : 'all'} view):</strong>{' '}
          {companySummary.map((c, i) => (
            <span key={c.name}>
              {i > 0 && ' | '}
              {c.name}: {c.count} Order{c.count === 1 ? '' : 's'}
            </span>
          ))}
        </div>

        {/* Orders whose AWB can never be matched by a scan. */}
        {badAwbOrders.length > 0 && (
          <div className="info-banner" style={{ marginBottom: 12, background: '#fbecea', color: '#7a2019', borderColor: '#e8a9a1' }}>
            ⚠️ <strong>{badAwbOrders.length} order(s) have an AWB that can never be scanned</strong>{' '}
            — mostly a customer's phone number saved as the AWB by an older version.
            They will sit in "Ready to Ship" forever no matter how carefully you scan.
            Re-import those orders' label PDFs (the parsing is fixed now) or correct the AWB by hand.
            <button className="btn btn-ghost btn-xs" style={{ marginLeft: 8 }} onClick={exportBadAwbs}>
              ⬇ Export the list
            </button>
          </div>
        )}

        {/* Filters */}
        <div className="filter-bar">
          <div className="fg"><label>Search</label>
            <input type="text" placeholder="Order ID, Customer, AWB…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="fg"><label>Channel</label>
            <select value={fChannel} onChange={(e) => setFChannel(e.target.value)}>
              <option value="">All</option><option>Amazon</option><option>Flipkart</option><option>Meesho</option>
            </select>
          </div>
          <div className="fg"><label>Company</label>
            <select value={fCompany} onChange={(e) => setFCompany(e.target.value)}>
              <option value="">All</option>
              {COMPANIES.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
              <option value="Unknown">Unknown</option>
            </select>
          </div>
          <div className="fg"><label>Status</label>
            <select value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
              <option value="">All</option>
              <option>Ready to Ship</option><option>Dispatched</option>
              <option>In Transit (Return)</option><option>Return Received</option>
            </select>
          </div>
          <div className="fg"><label>Payment</label>
            <select value={fPayment} onChange={(e) => setFPayment(e.target.value)}>
              <option value="">All</option><option>Prepaid</option><option>COD</option>
            </select>
          </div>
          {/* Feature 2: Order Type filter */}
          <div className="fg"><label>Order Type</label>
            <select value={fType} onChange={(e) => setFType(e.target.value)}>
              <option value="">All</option>
              <option value="Regular">Regular</option>
              <option value="Exchange">Exchange</option>
            </select>
          </div>
          <div className="fg"><label>From</label>
            <input type="date" value={fFrom} onChange={(e) => setFFrom(e.target.value)} />
          </div>
          <div className="fg"><label>To</label>
            <input type="date" value={fTo} onChange={(e) => setFTo(e.target.value)} />
          </div>
          <div><label>&nbsp;</label>
            <button className="btn btn-ghost btn-sm" onClick={() => {
              setSearch(''); setFChannel(''); setFCompany(''); setFStatus(''); setFPayment(''); setFType(''); setFFrom(''); setFTo('');
            }}>✕ Clear</button>
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th><input type="checkbox" onChange={(e) => toggleAll(e.target.checked)} /></th>
                <th onClick={() => handleSort('orderId')}>Order ID<span className="sort-arrow">{arrow('orderId')}</span></th>
                <th onClick={() => handleSort('customer')}>Customer<span className="sort-arrow">{arrow('customer')}</span></th>
                <th onClick={() => handleSort('channel')}>Channel<span className="sort-arrow">{arrow('channel')}</span></th>
                <th onClick={() => handleSort('company')}>Company<span className="sort-arrow">{arrow('company')}</span></th>
                <th>AWB / Ref</th>
                <th onClick={() => handleSort('sku')}>SKU<span className="sort-arrow">{arrow('sku')}</span></th>
                <th onClick={() => handleSort('quantity')}>Qty<span className="sort-arrow">{arrow('quantity')}</span></th>
                <th onClick={() => handleSort('payment')}>Payment<span className="sort-arrow">{arrow('payment')}</span></th>
                <th onClick={() => handleSort('amount')}>Amount<span className="sort-arrow">{arrow('amount')}</span></th>
                <th>Type</th>
                <th onClick={() => handleSort('status')}>Status<span className="sort-arrow">{arrow('status')}</span></th>
                <th onClick={() => handleSort('orderDate')}>Date<span className="sort-arrow">{arrow('orderDate')}</span></th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={14}><div className="empty"><div className="big">📦</div>No orders match your filters.</div></td></tr>
              ) : (
                pageRows.map((o) => (
                  <tr key={o.id} style={o.fraudAlert ? { background: '#fff1f1' } : {}}>
                    <td><input type="checkbox" checked={selected.has(o.id)} onChange={() => toggleRow(o.id)} /></td>
                    <td className="truncate" title={o.orderId}>
                      {o.orderId}
                      {/* Feature 4: fraud alert badge */}
                      {o.fraudAlert && (
                        <span title={o.fraudAlert} style={{ marginLeft: 4, color: '#ef4444', fontWeight: 700, cursor: 'help' }}>🚨</span>
                      )}
                    </td>
                    <td>
                      {o.customer}
                      {/* History-based repeat-returner warning — amber, distinct from the red 🚨 blocklist badge */}
                      {repeatReturnMap.has(o.id) && (
                        <span
                          title={repeatReturnerLabel(repeatReturnMap.get(o.id))}
                          style={{ marginLeft: 4, color: '#b45309', fontWeight: 700, cursor: 'help' }}
                        >
                          🔁
                        </span>
                      )}
                    </td>
                    <td><span className={`chip chip-${(o.channel || '').toLowerCase()}`}>{o.channel}</span></td>
                    <td>
                      <span
                        className="chip"
                        style={{
                          background: o.company && o.company !== 'Unknown' ? 'var(--accent-soft)' : '#f3f4f6',
                          color: o.company && o.company !== 'Unknown' ? 'var(--accent-hover)' : '#6b7280',
                        }}
                      >
                        {o.company || 'Unknown'}
                      </span>
                    </td>
                    <td>
                      {o.awb && o.channel === 'Amazon' && o.awb.startsWith('IN-')
                        ? <span title="Invoice ref — scan physical label to update AWB">{o.awb} <span className="awb-ref">⚠ref</span></span>
                        : (o.awb || '—')}
                    </td>
                    <td className="truncate" title={o.sku}>{o.sku || '—'}</td>
                    <td>{o.quantity || 1}</td>
                    <td><span className={`status ${o.payment === 'COD' ? 's-cod' : 's-prepaid'}`}>{o.payment}</span></td>
                    <td>₹{(o.amount || 0).toLocaleString('en-IN')}</td>
                    {/* Feature 2: Exchange badge */}
                    <td>
                      {o.orderType === 'Exchange'
                        ? <span className="status s-exchange">🔁 Exchange</span>
                        : <span className="status s-regular">Regular</span>}
                    </td>
                    <td><span className={`status ${statusClass(o.status)}`}>{o.status}</span></td>
                    <td>{o.orderDate || '—'}</td>
                    <td><button className="btn btn-ghost btn-xs" onClick={() => softDelete(o.id)}>🗑</button></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {filtered.length > SALES_PAGE_SIZE && (
          <div className="flex gap-2 mt-2" style={{ alignItems: 'center', justifyContent: 'center' }}>
            <button className="btn btn-ghost btn-sm" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>← Prev</button>
            <span className="text-sm text-muted">
              Page {safePage} of {totalPages} · showing {pageRows.length} of {filtered.length.toLocaleString('en-IN')} orders
            </span>
            <button className="btn btn-ghost btn-sm" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)}>Next →</button>
          </div>
        )}

        <div className="flex gap-2 mt-2">
          <button className="btn btn-danger btn-sm" onClick={bulkDelete}>🗑 Delete Selected</button>
          <span className="text-sm text-muted" style={{ alignSelf: 'center' }}>{selected.size} selected</span>
        </div>
      </div>

      {/* ── Manual Order Modal ── */}
      {showOrderModal && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowOrderModal(false); }}>
          <div className="modal">
            <div className="modal-title">Add Manual Order</div>
            <div className="form-row">
              <div><label>Order ID</label>
                <input type="text" placeholder="405-XXXXXXX-XXXXXXX" value={mForm.orderId}
                  onChange={(e) => setMForm({ ...mForm, orderId: e.target.value })} />
              </div>
              <div><label>AWB / Tracking No.</label>
                <input type="text" placeholder="AWB number" value={mForm.awb}
                  onChange={(e) => setMForm({ ...mForm, awb: e.target.value })} />
              </div>
            </div>
            <div className="form-row">
              <div><label>Customer Name</label>
                <input type="text" placeholder="Customer" value={mForm.customer}
                  onChange={(e) => setMForm({ ...mForm, customer: e.target.value })} />
              </div>
              <div><label>SKU</label>
                <input type="text" placeholder="Product SKU" value={mForm.sku}
                  onChange={(e) => setMForm({ ...mForm, sku: e.target.value })} />
              </div>
            </div>
            <div className="form-row">
              <div><label>Quantity</label>
                <input type="number" min="1" placeholder="1" value={mForm.quantity}
                  onChange={(e) => setMForm({ ...mForm, quantity: e.target.value })} />
              </div>
              <div><label>Marketplace</label>
                <select value={mForm.channel} onChange={(e) => setMForm({ ...mForm, channel: e.target.value })}>
                  <option>Amazon</option><option>Flipkart</option><option>Meesho</option>
                </select>
              </div>
            </div>
            <div className="form-row">
              <div><label>Company</label>
                <select value={mForm.company} onChange={(e) => setMForm({ ...mForm, company: e.target.value })}>
                  <option value="">Unknown</option>
                  {COMPANIES.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
                </select>
              </div>
            </div>
            <div className="form-row">
              <div><label>Payment Mode</label>
                <select value={mForm.payment} onChange={(e) => setMForm({ ...mForm, payment: e.target.value })}>
                  <option>Prepaid</option><option>COD</option>
                </select>
              </div>
              <div><label>Order Type</label>
                <select value={mForm.orderType} onChange={(e) => setMForm({ ...mForm, orderType: e.target.value })}>
                  <option value="Regular">Regular</option>
                  <option value="Exchange">Exchange</option>
                </select>
              </div>
            </div>
            <div className="form-row">
              <div><label>Amount (₹)</label>
                <input type="number" placeholder="0.00" value={mForm.amount}
                  onChange={(e) => setMForm({ ...mForm, amount: e.target.value })} />
              </div>
              <div><label>Order Date</label>
                <input type="date" value={mForm.orderDate} onChange={(e) => setMForm({ ...mForm, orderDate: e.target.value })} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setShowOrderModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={saveManualOrder}>Add Order</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}