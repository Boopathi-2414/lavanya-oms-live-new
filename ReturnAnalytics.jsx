import { useState } from 'react';
import * as XLSX from 'xlsx';
import { flattenReturnAnalytics, RETURN_REASONS, today } from '../db.js';
import { toast } from './Toast.jsx';

// Return Analytics Dashboard — identifies which products/categories have
// high return rates so inventory and listing decisions can be data-driven.
//
// Built the same way as the Courier Analytics Dashboard (see
// flattenCourierBreakdown in db.js): the grouping tree comes straight from
// whatever channel/category/SKU/reason values actually appear on the
// orders, so a brand-new SKU or category needs zero code changes here —
// it just shows up as its own row once it has a dispatched order.
export default function ReturnAnalytics({ db }) {
  const [sortCol, setSortCol] = useState('returnRate');
  const [sortDir, setSortDir] = useState(-1); // -1 = highest first (default: worst offenders on top)
  const [filterChannel,  setFilterChannel]  = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [search,         setSearch]         = useState('');

  const rows = flattenReturnAnalytics(db.orders, db.products);

  // ── Overall summary (unfiltered) ─────────────────────────────
  const totalDispatched = rows.reduce((s, r) => s + r.dispatched, 0);
  const totalReturned   = rows.reduce((s, r) => s + r.returned, 0);
  const overallRate      = totalDispatched > 0 ? (totalReturned / totalDispatched) * 100 : 0;
  const reasonTotals = RETURN_REASONS.reduce((acc, r) => {
    acc[r] = rows.reduce((s, row) => s + (row.byReason[r] || 0), 0);
    return acc;
  }, {});
  const notTaggedTotal = rows.reduce((s, row) => s + (row.byReason['Not Tagged'] || 0), 0);

  const channels   = [...new Set(rows.map((r) => r.channel))].sort();
  const categories = [...new Set(rows.map((r) => r.category))].sort();

  // ── Filter + sort ─────────────────────────────────────────────
  const q = search.toLowerCase();
  const filtered = rows
    .filter((r) => {
      if (filterChannel  && r.channel  !== filterChannel)  return false;
      if (filterCategory && r.category !== filterCategory) return false;
      if (q && !`${r.sku} ${r.category} ${r.channel}`.toLowerCase().includes(q)) return false;
      return true;
    })
    .sort((a, b) => {
      let av = a[sortCol], bv = b[sortCol];
      if (typeof av === 'string') { av = av.toLowerCase(); bv = (bv || '').toLowerCase(); }
      if (av < bv) return -1 * sortDir;
      if (av > bv) return  1 * sortDir;
      return 0;
    });

  function handleSort(col) {
    if (sortCol === col) setSortDir((d) => d * -1);
    else { setSortCol(col); setSortDir(col === 'sku' || col === 'category' || col === 'channel' ? 1 : -1); }
  }
  const arrow = (col) => sortCol === col ? (sortDir === 1 ? ' ↑' : ' ↓') : ' ↕';

  function exportReport() {
    if (!filtered.length) { toast('No rows to export', 'info'); return; }
    const exportRows = filtered.map((r) => ({
      Platform: r.channel, Category: r.category, SKU: r.sku,
      Dispatched: r.dispatched, Returned: r.returned, 'Return %': r.returnRate.toFixed(1),
      ...RETURN_REASONS.reduce((acc, reason) => { acc[reason] = r.byReason[reason] || 0; return acc; }, {}),
      'Not Tagged': r.byReason['Not Tagged'] || 0,
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(exportRows), 'Return Analytics');
    XLSX.writeFile(wb, `Return_Analytics_${today()}.xlsx`);
    toast('Exported', 'success');
  }

  function rateColor(rate) {
    if (rate >= 25) return '#dc2626';
    if (rate >= 10) return '#d97706';
    return '#059669';
  }

  return (
    <div>
      <div className="info-banner">RTO: {db.orders.filter(o=>!o.deleted&&o.return_type==='RTO').length} · Customer Return: {db.orders.filter(o=>!o.deleted&&o.return_type==='Customer Return').length}. Existing Quality Issue records are preserved; new damage imports use the separate Damage category.</div>
      {/* ── Summary stats ── */}
      <div className="stats-grid" style={{ marginBottom: 24 }}>
        <div className="stat-card total">
          <div className="stat-label">Total Dispatched</div>
          <div className="stat-value">{totalDispatched}</div>
          <div className="stat-sub">Across all SKUs</div>
        </div>
        <div className="stat-card transit">
          <div className="stat-label">Total Returned</div>
          <div className="stat-value">{totalReturned}</div>
          <div className="stat-sub">In Transit + Received</div>
        </div>
        <div className="stat-card rts">
          <div className="stat-label">Overall Return Rate</div>
          <div className="stat-value">{overallRate.toFixed(1)}%</div>
          <div className="stat-sub">Returned / Dispatched</div>
        </div>
        {notTaggedTotal > 0 && (
          <div className="stat-card fraud">
            <div className="stat-label">Reason Not Tagged</div>
            <div className="stat-value">{notTaggedTotal}</div>
            <div className="stat-sub">Missing Return Reason</div>
          </div>
        )}
      </div>

      {/* ── Return Reason breakdown ── */}
      <div className="card">
        <div className="card-title">Returns by Reason (all SKUs)</div>
        {totalReturned === 0 ? (
          <div className="empty"><div className="big">🏷️</div>No returns recorded yet</div>
        ) : (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {RETURN_REASONS.map((r) => (
              <span
                key={r}
                style={{
                  background: '#fce7f3', color: '#9d174d', border: '1px solid #f9a8d4',
                  borderRadius: 999, padding: '4px 14px', fontSize: 12, fontWeight: 700,
                }}
              >
                {r}: {reasonTotals[r]}
              </span>
            ))}
            {notTaggedTotal > 0 && (
              <span
                style={{
                  background: '#f3f4f6', color: '#6b7280', border: '1px solid #d1d5db',
                  borderRadius: 999, padding: '4px 14px', fontSize: 12, fontWeight: 700,
                }}
              >
                Not Tagged: {notTaggedTotal}
              </span>
            )}
          </div>
        )}
      </div>

      {/* ── SKU-level return rate table — Platform → Category → SKU → Reason ── */}
      <div className="card">
        <div className="flex items-center gap-3 mb-3" style={{ flexWrap: 'wrap' }}>
          <div className="card-title" style={{ margin: 0 }}>SKU-Level Return Rate</div>
          <div style={{ flex: 1 }} />
          <button className="btn btn-outline btn-sm" onClick={exportReport}>⬇ Export</button>
        </div>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>
          Return count / total dispatched count, per SKU. Sorted highest return rate first by default —
          click any column header to re-sort.
        </p>

        {/* ── Filters ── */}
        <div className="filter-bar" style={{ marginBottom: 12 }}>
          <div className="fg">
            <label>Search</label>
            <input type="text" placeholder="SKU, category…" value={search}
              onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="fg">
            <label>Platform</label>
            <select value={filterChannel} onChange={(e) => setFilterChannel(e.target.value)}>
              <option value="">All</option>
              {channels.map((c, i) => <option key={c || `ch-${i}`} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="fg">
            <label>Category</label>
            <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
              <option value="">All</option>
              {categories.map((c, i) => <option key={c || `cat-${i}`} value={c}>{c || '(uncategorised)'}</option>)}
            </select>
          </div>
          <div>
            <label>&nbsp;</label>
            <button className="btn btn-ghost btn-sm" onClick={() => { setFilterChannel(''); setFilterCategory(''); setSearch(''); }}>
              ✕ Clear
            </button>
          </div>
        </div>

        {rows.length === 0 ? (
          <div className="empty">
            <div className="big">📉</div>
            No dispatched orders yet. This table fills in once orders move past "Ready to Ship".
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th onClick={() => handleSort('channel')}>Platform<span className="sort-arrow">{arrow('channel')}</span></th>
                  <th onClick={() => handleSort('category')}>Category<span className="sort-arrow">{arrow('category')}</span></th>
                  <th onClick={() => handleSort('sku')}>SKU<span className="sort-arrow">{arrow('sku')}</span></th>
                  {RETURN_REASONS.map((r) => <th key={r} style={{ fontSize: 11 }}>{r}</th>)}
                  <th style={{ fontSize: 11 }}>Not Tagged</th>
                  <th onClick={() => handleSort('dispatched')}>Dispatched<span className="sort-arrow">{arrow('dispatched')}</span></th>
                  <th onClick={() => handleSort('returned')}>Returned<span className="sort-arrow">{arrow('returned')}</span></th>
                  <th onClick={() => handleSort('returnRate')}>Return %<span className="sort-arrow">{arrow('returnRate')}</span></th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr><td colSpan={9 + RETURN_REASONS.length}><div className="empty">No SKUs match the current filters.</div></td></tr>
                ) : (
                  filtered.map((r) => (
                    <tr key={`${r.channel}-${r.category}-${r.sku}`}>
                      <td><span className={`chip chip-${r.channel.toLowerCase()}`}>{r.channel}</span></td>
                      <td>{r.category}</td>
                      <td className="truncate" title={r.sku}>{r.sku}</td>
                      {RETURN_REASONS.map((reason) => (
                        <td key={reason} style={{ textAlign: 'center' }}>{r.byReason[reason] || 0}</td>
                      ))}
                      <td style={{ textAlign: 'center', color: 'var(--muted,#9ca3af)' }}>{r.byReason['Not Tagged'] || 0}</td>
                      <td>{r.dispatched}</td>
                      <td>{r.returned}</td>
                      <td style={{ fontWeight: 700, color: rateColor(r.returnRate) }}>
                        {r.returnRate.toFixed(1)}%
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
