import { useState } from 'react';
import * as XLSX from 'xlsx';
import { buildProfitRows, today } from '../db.js';
import { toast } from './Toast.jsx';

const PAGE_SIZE = 50;

// Profit Analysis — Net Received (Settlement − GST, from Payment Entry)
// minus Purchase Cost (SKU rate × quantity, from Purchase Rate) gives the
// actual Net Profit per order. Only reconciled orders (ones with a
// matching payment) are included, since profit isn't knowable before the
// real settlement is in.
export default function ProfitAnalysis({ db, setDb, user }) {
  const [search,        setSearch]        = useState('');
  const [filterChannel, setFilterChannel] = useState('');
  const [sortCol, setSortCol] = useState('orderDate');
  const [sortDir, setSortDir] = useState(-1);
  const [page,    setPage]    = useState(1);
  // Off by default: an RTO / returned parcel puts the stock back on your
  // shelf, so its purchase cost is not a loss. Turn on only if returned
  // goods usually come back unsellable.
  const [countReturnedStockAsCost, setCountReturnedStockAsCost] = useState(false);

  const rows = buildProfitRows(db.orders, db.payments, db.products, { countReturnedStockAsCost, businessRecords: db.businessRecords || [] });
  const returnedCount = rows.filter((r) => r.stockReturned).length;

  const withRate    = rows.filter((r) => !r.rateMissing);
  const missingRate = rows.filter((r) => r.rateMissing);

  // ── Summary (only over orders whose SKU has a Purchase Rate set —
  //    an order with an unknown cost can't contribute a real profit number) ──
  const totalNetReceived = withRate.reduce((s, r) => s + r.netReceived, 0);
  const totalCost        = withRate.reduce((s, r) => s + (r.purchaseCost || 0), 0);
  const companyExpenses = (db.businessRecords||[]).filter(r=>r.kind==='expense'&&!r.voided&&!r.orderId).reduce((s,r)=>s+Number(r.amount||0),0);
  const totalProfit      = withRate.reduce((s, r) => s + (r.profit || 0), 0) - companyExpenses;
  const overallMargin    = totalNetReceived > 0 ? (totalProfit / totalNetReceived) * 100 : 0;

  // ── Profit aggregated by SKU — which products are actually making
  //    money vs which are eating margin ──────────────────────────────
  const bySku = new Map();
  for (const r of withRate) {
    if (!bySku.has(r.sku)) bySku.set(r.sku, { sku: r.sku, orders: 0, netReceived: 0, cost: 0, profit: 0 });
    const b = bySku.get(r.sku);
    b.orders += 1;
    b.netReceived += r.netReceived;
    b.cost        += r.purchaseCost || 0;
    b.profit      += r.profit || 0;
  }
  const skuRows = [...bySku.values()]
    .map((b) => ({ ...b, marginPct: b.netReceived > 0 ? (b.profit / b.netReceived) * 100 : 0 }))
    .sort((a, b) => b.profit - a.profit);
  const topProfitable = skuRows.slice(0, 5);
  const leastProfitable = [...skuRows].sort((a, b) => a.profit - b.profit).slice(0, 5);

  const channels = [...new Set(rows.map((r) => r.channel))].sort();

  // ── Filter + sort (order-level table) ─────────────────────────
  const q = search.toLowerCase();
  const filtered = withRate
    .filter((r) => {
      if (filterChannel && r.channel !== filterChannel) return false;
      if (q && !`${r.orderId} ${r.customer || ''} ${r.sku}`.toLowerCase().includes(q)) return false;
      return true;
    })
    .sort((a, b) => {
      let av = a[sortCol] ?? '', bv = b[sortCol] ?? '';
      if (typeof av === 'string') { av = av.toLowerCase(); bv = (bv || '').toLowerCase(); }
      if (av < bv) return -1 * sortDir;
      if (av > bv) return  1 * sortDir;
      return 0;
    });

  function handleSort(col) {
    setPage(1);
    if (sortCol === col) setSortDir((d) => d * -1);
    else { setSortCol(col); setSortDir(col === 'orderId' || col === 'sku' || col === 'channel' ? 1 : -1); }
  }
  const arrow = (col) => sortCol === col ? (sortDir === 1 ? ' ↑' : ' ↓') : ' ↕';

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage   = Math.min(page, totalPages);
  const pageRows   = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const fmt = (n) => '₹' + (n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function exportReport() {
    if (!filtered.length) { toast('No rows to export', 'info'); return; }
    const exportRows = filtered.map((r) => ({
      'Order ID': r.orderId, Customer: r.customer, Channel: r.channel, SKU: r.sku, Qty: r.quantity,
      'Settlement (₹)': r.settlement, 'GST (₹)': r.gstAmount, 'Net Received (₹)': r.netReceived, 'Purchase Rate (₹)': r.purchaseRate,
      'Purchase Cost (₹)': r.purchaseCost, 'Manual Loss (₹)': r.manualLoss, 'Order expenses (₹)': r.orderExpense, 'Profit (₹)': r.profit, 'Margin %': r.marginPct?.toFixed(1),
      'Order Date': r.orderDate,
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(exportRows), 'Profit Analysis');
    if (missingRate.length) {
      const missingRows = missingRate.map((r) => ({ 'Order ID': r.orderId, SKU: r.sku, 'Net Received (₹)': r.netReceived }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(missingRows), 'Missing Purchase Rate');
    }
    XLSX.writeFile(wb, `Profit_Analysis_${today()}.xlsx`);
    toast('Exported', 'success');
  }

  return (
    <div>
      <div className="info-banner">Net profit = Settlement − GST − Purchase cost − Manual loss − Recorded expenses. Order-linked expenses reduce that order’s profit; other company expenses reduce the overall total. Returned-item manual loss replaces the optional full purchase-cost write-off. Marketplace deductions already included in settlement are not subtracted again. Claim credits increase settlement.</div>
      <div className="info-banner">Company expenses included in overall profit: {fmt(companyExpenses)}. Expenses on unpaid orders are not yet included in this settled-order view; Business Workspace shows all recorded expenses.</div>
      {/* ── Summary ── */}
      <div className="stats-grid" style={{ marginBottom: 24 }}>
        <div className="stat-card total">
          <div className="stat-label">Net Received</div>
          <div className="stat-value" style={{ fontSize: 20 }}>{fmt(totalNetReceived)}</div>
          <div className="stat-sub">Settlement − GST, reconciled orders</div>
        </div>
        <div className="stat-card transit">
          <div className="stat-label">Purchase Cost</div>
          <div className="stat-value" style={{ fontSize: 20 }}>{fmt(totalCost)}</div>
          <div className="stat-sub">SKU rate × quantity</div>
        </div>
        <div className="stat-card received">
          <div className="stat-label">Net Profit</div>
          <div className="stat-value" style={{ fontSize: 20, color: totalProfit >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmt(totalProfit)}</div>
          <div className="stat-sub">Net Received − Purchase Cost</div>
        </div>
        <div className="stat-card rts">
          <div className="stat-label">Profit Margin</div>
          <div className="stat-value">{overallMargin.toFixed(1)}%</div>
          <div className="stat-sub">Profit / Net Received</div>
        </div>
        {missingRate.length > 0 && (
          <div className="stat-card fraud">
            <div className="stat-label">Missing Purchase Rate</div>
            <div className="stat-value">{missingRate.length}</div>
            <div className="stat-sub">Orders excluded from profit</div>
          </div>
        )}
      </div>

      {missingRate.length > 0 && (
        <div className="info-banner">
          <strong>{missingRate.length} reconciled order(s)</strong> use a SKU with no Purchase Rate set,
          so their profit can't be calculated — they're excluded from the totals above. Add a rate for
          these SKUs on the <strong>Purchase Rates</strong> page to include them.
        </div>
      )}

      {/* ── Top / Least profitable SKUs ── */}
      {skuRows.length > 0 && (
        <div className="card">
          <div className="card-title">Most &amp; Least Profitable Products</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 16 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8, color: 'var(--green)' }}>Top 5 by Profit</div>
              {topProfitable.map((s) => (
                <div key={s.sku} className="truncate" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '4px 0', borderBottom: '1px solid var(--border,#e5e7eb)' }}>
                  <span className="truncate" title={s.sku} style={{ maxWidth: '65%' }}>{s.sku}</span>
                  <span style={{ fontWeight: 700, color: 'var(--green)' }}>{fmt(s.profit)}</span>
                </div>
              ))}
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8, color: 'var(--red)' }}>Bottom 5 by Profit</div>
              {leastProfitable.map((s) => (
                <div key={s.sku} className="truncate" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '4px 0', borderBottom: '1px solid var(--border,#e5e7eb)' }}>
                  <span className="truncate" title={s.sku} style={{ maxWidth: '65%' }}>{s.sku}</span>
                  <span style={{ fontWeight: 700, color: s.profit < 0 ? 'var(--red)' : 'inherit' }}>{fmt(s.profit)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Order-level profit table ── */}
      <div className="card">
        <div className="flex items-center gap-3 mb-3" style={{ flexWrap: 'wrap' }}>
          <div className="card-title" style={{ margin: 0 }}>Order-Level Profit</div>
          <div style={{ flex: 1 }} />
          <label
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}
            title="An RTO or returned parcel comes back to you, so the stock is still yours. By default its purchase cost is NOT treated as a loss. Tick this only if returned goods normally come back damaged / unsellable."
          >
            <input
              type="checkbox"
              checked={countReturnedStockAsCost}
              onChange={(e) => setCountReturnedStockAsCost(e.target.checked)}
            />
            Count returned stock as a loss
          </label>
          <button className="btn btn-outline btn-sm" onClick={exportReport}>⬇ Export</button>
        </div>
        {returnedCount > 0 && (
          <div className="info-banner" style={{ marginBottom: 10 }}>
            ↩ <strong>{returnedCount} order(s)</strong> are in return transit or received (RTO / customer return).{' '}
            {countReturnedStockAsCost
              ? 'Their purchase cost IS being counted as a loss.'
              : 'Purchase cost is excluded for these returns. Deductions and manual damage loss still reduce profit; claim credits in settlement increase it. Stock becomes sellable only after inspection.'}
          </div>
        )}

        <div className="filter-bar" style={{ marginBottom: 12 }}>
          <div className="fg">
            <label>Search</label>
            <input type="text" placeholder="Order ID, Customer, SKU…" value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          </div>
          <div className="fg">
            <label>Channel</label>
            <select value={filterChannel} onChange={(e) => { setFilterChannel(e.target.value); setPage(1); }}>
              <option value="">All</option>
              {channels.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label>&nbsp;</label>
            <button className="btn btn-ghost btn-sm" onClick={() => { setSearch(''); setFilterChannel(''); setPage(1); }}>✕ Clear</button>
          </div>
        </div>

        {rows.length === 0 ? (
          <div className="empty">
            <div className="big">💵</div>
            No reconciled orders yet. Import settlements on the Payment Entry page first.
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th onClick={() => handleSort('orderId')}>Order ID<span className="sort-arrow">{arrow('orderId')}</span></th>
                  <th>Customer</th>
                  <th onClick={() => handleSort('channel')}>Channel<span className="sort-arrow">{arrow('channel')}</span></th>
                  <th onClick={() => handleSort('sku')}>SKU<span className="sort-arrow">{arrow('sku')}</span></th>
                  <th>Qty</th><th>Settlement</th><th>GST</th>
                  <th onClick={() => handleSort('netReceived')}>Net Received<span className="sort-arrow">{arrow('netReceived')}</span></th>
                  <th onClick={() => handleSort('purchaseCost')}>Purchase Cost<span className="sort-arrow">{arrow('purchaseCost')}</span></th>
                  <th>Manual loss ₹</th><th>Order expenses ₹</th><th onClick={() => handleSort('profit')}>Profit<span className="sort-arrow">{arrow('profit')}</span></th>
                  <th onClick={() => handleSort('marginPct')}>Margin %<span className="sort-arrow">{arrow('marginPct')}</span></th>
                  <th onClick={() => handleSort('orderDate')}>Date<span className="sort-arrow">{arrow('orderDate')}</span></th>
                </tr>
              </thead>
              <tbody>
                {pageRows.length === 0 ? (
                  <tr><td colSpan={15}><div className="empty">No orders match the current filters.</div></td></tr>
                ) : (
                  pageRows.map((r) => (
                    <tr key={r.id}>
                      <td className="truncate" title={r.orderId}>{r.orderId}</td>
                      <td>{r.customer}</td>
                      <td><span className={`chip chip-${r.channel.toLowerCase()}`}>{r.channel}</span></td>
                      <td className="truncate" title={r.sku}>{r.sku}</td>
                      <td>{r.quantity}</td>
                      <td>{fmt(r.settlement)}</td><td>{fmt(r.gstAmount)}</td><td>{fmt(r.netReceived)}</td>
                      <td>
                        {fmt(r.purchaseCost)}
                        {r.stockReturned && !countReturnedStockAsCost && (
                          <span
                            className="chip"
                            style={{ marginLeft: 6, background: 'var(--accent-soft)', color: 'var(--accent-hover)', fontSize: 10 }}
                            title="Purchase cost excluded for return accounting. Confirm physical receipt and condition in Inventory before restocking."
                          >
                            ↩ return cost excluded
                          </span>
                        )}
                      </td>
                      <td><input aria-label={`Manual loss ${r.orderId}`} type="number" min="0" step="0.01" defaultValue={r.manualLoss || 0} style={{width:100}} onBlur={e=>{
                        const value=Number(e.target.value);
                        if(!Number.isFinite(value)||value<0){toast('Enter a valid non-negative loss','error');e.target.value=r.manualLoss;return;}
                        const loss=Math.round(value*100)/100;if(loss===r.manualLoss)return;
                        const orders=db.orders.map(o=>o.id!==r.id?o:{...o,manualLoss:loss,manualLossHistory:[...(o.manualLossHistory||[]),{at:new Date().toISOString(),actor:user?.username||'Admin',from:o.manualLoss||0,to:loss}]});
                        setDb({...db,orders},{orders:[r.id]});toast('Loss saved','success');
                      }}/></td>
                      <td>{fmt(r.orderExpense)}</td>
                      <td style={{ fontWeight: 700, color: r.profit >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmt(r.profit)}</td>
                      <td>{r.marginPct?.toFixed(1)}%</td>
                      <td>{r.orderDate || '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {filtered.length > PAGE_SIZE && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, justifyContent: 'flex-end' }}>
            <span style={{ fontSize: 12, color: 'var(--muted,#6b7280)' }}>
              Showing {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length}
            </span>
            <button className="btn btn-ghost btn-sm" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>← Prev</button>
            <span style={{ fontSize: 12 }}>Page {safePage} / {totalPages}</span>
            <button className="btn btn-ghost btn-sm" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)}>Next →</button>
          </div>
        )}
      </div>
    </div>
  );
}
