import { pickupStatus, dispatchedOn, day } from '../businessLogic.js';
// PickupDashboard.jsx — v5: Daily Pickup Reconciliation Dashboard
// Platform → Courier Partner tracking:
//   Flipkart  → E-Kart Logistics
//   Amazon    → Amazon
//   Meesho    → Delhivery / Shadowfax
// Shows: Uploaded vs Scanned (Dispatched) vs Pending + In-Transit + Return Received

import { useState, useMemo, useCallback } from 'react';
import { getClient, isSupabaseConfigured } from '../supabase.js';

// ── Platform → Courier mapping ───────────────────────────────────────────────
const PLATFORM_COURIER = {
  Flipkart: ['E-Kart Logistics'],
  Amazon: ['Amazon'],
  Meesho: ['Delhivery', 'Shadowfax'],
  Shopsy: ['E-Kart Logistics'],
  Other: ['Unknown'],
};

function getPlatform(order) {
  const ch = (order.channel || '').trim();
  if (/flipkart/i.test(ch)) return 'Flipkart';
  if (/amazon/i.test(ch)) return 'Amazon';
  if (/meesho/i.test(ch)) return 'Meesho';
  if (/shopsy/i.test(ch)) return 'Shopsy';
  return 'Other';
}

function getCourier(order) {

  const platform = getPlatform(order);

  // Flipkart
  if (platform === "Flipkart")
    return "E-Kart Logistics";

  // Amazon
  if (platform === "Amazon")
    return "Amazon";

  // Meesho
  if (platform === "Meesho") {

    if (
      order.courier &&
      order.courier !== "Unknown"
    ) {
      return order.courier;
    }

    return "Unknown";
  }

  // Shopsy
  if (platform === "Shopsy")
    return "E-Kart Logistics";

  return "Unknown";
}

const getDispatchStatus = pickupStatus;

function localDateStr(isoString) {
  if (!isoString) return '';
  return day(isoString); // YYYY-MM-DD
}

function isScanDispatched(order) {
  if (!order.dispatchedAt) return false;
  if (order.scanSource === 'scan') return true;
  if (order.scanSource === 'manual') return false;
  // Heuristic: real AWB (not invoice ref) = was scanned
  if (order.awb && /^[A-Za-z0-9]{8,20}$/.test(order.awb.trim()) && !order.awb.startsWith('IN-')) return true;
  return false;
}

const PLATFORMS = ['Flipkart', 'Amazon', 'Meesho', 'Other'];
const PLATFORM_COLORS = {
  Flipkart: '#3b82f6',
  Amazon: '#f59e0b',
  Meesho: '#ec4899',
  Shopsy: '#8b5cf6',
  Other: '#9ca3af',
};

// ── Nightly backup helper (fires once at EOD or when user requests) ──────────
async function saveReconciliationSnapshot(date, summary) {
  try {
    const client = await getClient();
    if (!client) return false;
    const { error } = await client.from('oms_reconciliation_history').upsert({
      snapshot_date: date,
      summary_data: summary,
      saved_at: new Date().toISOString(),
    }, { onConflict: 'snapshot_date' });
    if (error) throw error;
    return true;
  } catch (e) {
    console.error('Reconciliation snapshot save failed:', e);
    return false;
  }
}

export default function PickupDashboard({ db }) {
  const orders = db.orders.filter((o) => !o.deleted);

  const today = day();
  const [date, setDate] = useState(today);
  const [platformFilter, setPlatformFilter] = useState('');
  const [courierFilter, setCourierFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [paymentFilter, setPaymentFilter] = useState('');
  const [companyFilter, setCompanyFilter] = useState('');
  const [savingSnap, setSavingSnap] = useState(false);
  const [snapMsg, setSnapMsg] = useState('');

  // Dates that have ANY order activity (uploaded on OR dispatched on)
  const activeDates = useMemo(() => {
    const s = new Set();
    orders.forEach((o) => {
      if (o.importedAt) s.add(localDateStr(o.importedAt));
      if (o.dispatchedAt) s.add(localDateStr(o.dispatchedAt));
      if (o.createdAt) s.add(localDateStr(o.createdAt));
    });
    return [...s].sort().reverse();
  }, [orders]);

  // All orders "active" on this date = imported on/before this date and not deleted
  const uploadedOnDate = useMemo(() => {
    return orders.filter((o) => {
      const importDate = localDateStr(o.importedAt || o.createdAt || '');
      return importDate === date;
    });
  }, [orders, date]);

  // Dispatched on date
  const dispatchedOnDate = useMemo(() => {
    return orders.filter((o) => {
      return dispatchedOn(o, date);
    });
  }, [orders, date]);

  // Pending = uploaded on date but not yet dispatched
  const pendingOnDate = useMemo(() => {
    return uploadedOnDate.filter((o) => {
      const ds = getDispatchStatus(o);
      return ds === 'Pending' || ds === 'Ready to Ship';
    });
  }, [uploadedOnDate]);

  // In Transit = status is In Transit
  const inTransitAll = useMemo(() => {
    return orders.filter((o) => getDispatchStatus(o) === 'In Transit');
  }, [orders]);

  // Return Received = status is Return Received
  const returnReceivedAll = useMemo(() => {
    return orders.filter((o) => getDispatchStatus(o) === 'Return Received');
  }, [orders]);

  // Per-platform summary for selected date
  const platformSummary = useMemo(() => {

    const rows = [];

    PLATFORMS.forEach(platform => {

      const platformOrders = Array.from(
        new Map(
          [
            ...uploadedOnDate,
            ...dispatchedOnDate,
            ...inTransitAll,
            ...returnReceivedAll,
          ].map(o => [o.id, o])
        ).values()
      );

      const couriers = [
        ...new Set(
          platformOrders
            .filter(o => getPlatform(o) === platform)
            .map(o => getCourier(o))
        )
      ];

      if (couriers.length === 0) {
        couriers.push("Unknown");
      }

      if (couriers.length === 0)
        couriers.push("Unknown");

      couriers.forEach(courier => {

        const uploaded = uploadedOnDate.filter(o =>
          getPlatform(o) === platform &&
          getCourier(o) === courier
        );

        const dispatched = dispatchedOnDate.filter(o =>
          getPlatform(o) === platform &&
          getCourier(o) === courier
        );

        const pending = pendingOnDate.filter(o =>
          getPlatform(o) === platform &&
          getCourier(o) === courier
        );

        const scanned = dispatched.filter(isScanDispatched);

        const manual = dispatched.filter(o => !isScanDispatched(o));

        const cod = dispatched.filter(o => o.payment === 'COD');

        const prepaid = dispatched.filter(o => o.payment === 'Prepaid');

        const inTransit = inTransitAll.filter(o =>
          getPlatform(o) === platform &&
          getCourier(o) === courier
        );

        const returned = returnReceivedAll.filter(o =>
          getPlatform(o) === platform &&
          getCourier(o) === courier
        );

        rows.push({
          p: platform,
          courier,
          uploaded: uploaded.length,
          dispatched: dispatched.length,
          pending: pending.length,
          scanned: scanned.length,
          manual: manual.length,
          cod: cod.length,
          prepaid: prepaid.length,
          inTransit: inTransit.length,
          returned: returned.length
        });

      });

    });

    return rows;

  }, [
    uploadedOnDate,
    dispatchedOnDate,
    pendingOnDate,
    inTransitAll,
    returnReceivedAll,
    orders
  ]);

  const totalUploaded = uploadedOnDate.length;
  const totalDispatched = dispatchedOnDate.length;
  const totalPending = pendingOnDate.length;

  // Filtered detail table
  const detailOrders = useMemo(() => {
    let base = [];
    if (!statusFilter || statusFilter === 'Dispatched') base = [...base, ...dispatchedOnDate];
    if (!statusFilter || statusFilter === 'Pending') base = [...base, ...pendingOnDate];
    if (statusFilter === 'In Transit') base = inTransitAll;
    if (statusFilter === 'Return Received') base = returnReceivedAll;
    if (!statusFilter) base = [...uploadedOnDate];

    return base.filter((o) => {
      if (platformFilter && getPlatform(o) !== platformFilter) return false;
      if (courierFilter && getCourier(o) !== courierFilter) return false;
      if (paymentFilter && o.payment !== paymentFilter) return false;
      if (companyFilter && (o.company || 'Unknown') !== companyFilter) return false;
      return true;
    });
  }, [statusFilter, platformFilter, paymentFilter, companyFilter, uploadedOnDate, dispatchedOnDate, pendingOnDate, inTransitAll, returnReceivedAll]);

  const companies = [...new Set(uploadedOnDate.map((o) => o.company || 'Unknown'))].sort();

  // Build summary payload for snapshot
  const buildSnapshotPayload = useCallback(() => ({
    date,
    totalUploaded,
    totalDispatched,
    totalPending,
    inTransitTotal: inTransitAll.length,
    returnReceivedTotal: returnReceivedAll.length,
    platforms: platformSummary,
    savedAt: new Date().toISOString(),
  }), [date, totalUploaded, totalDispatched, totalPending, platformSummary, inTransitAll, returnReceivedAll]);

  async function handleSaveSnapshot() {
    setSavingSnap(true);
    setSnapMsg('');
    const payload = buildSnapshotPayload();
    const ok = await saveReconciliationSnapshot(date, payload);
    setSavingSnap(false);
    setSnapMsg(ok ? `✅ Snapshot for ${date} saved to history!` : '⚠️ Could not save — check Supabase config.');
    setTimeout(() => setSnapMsg(''), 4000);
  }

  return (
    <div>
      {/* ── Header ── */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div className="card-title" style={{ margin: 0 }}>Daily Pickup Reconciliation Dashboard</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
              Platform → Courier Partner tracking · Uploaded vs Dispatched vs Pending
            </div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div className="fg" style={{ marginBottom: 0 }}>
              <label>Date</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} max={today} />
            </div>
            {activeDates.slice(0, 6).map((d) => (
              <button key={d} className={`btn btn-sm ${d === date ? 'btn-success' : 'btn-outline'}`}
                onClick={() => setDate(d)} style={{ fontSize: 11, padding: '2px 8px' }}>
                {d === today ? 'Today' : d.slice(5)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Top KPI cards ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px,1fr))', gap: 12, marginBottom: 16 }}>
        <div className="stat-card total">
          <div className="stat-label">📤 Uploaded</div>
          <div className="stat-value">{totalUploaded}</div>
          <div className="stat-sub">Imported on {date}</div>
        </div>
        <div className="stat-card" style={{ borderLeft: '4px solid var(--green)' }}>
          <div className="stat-label">✅ Dispatched</div>
          <div className="stat-value">{totalDispatched}</div>
          <div className="stat-sub">Dispatch history</div>
        </div>
        <div className="stat-card" style={{ borderLeft: '4px solid #f59e0b' }}>
          <div className="stat-label">⏳ Pending</div>
          <div className="stat-value">{totalPending}</div>
          <div className="stat-sub">Ready to Ship</div>
        </div>
        <div className="stat-card" style={{ borderLeft: '4px solid #3b82f6' }}>
          <div className="stat-label">🚚 In Transit</div>
          <div className="stat-value">{inTransitAll.length}</div>
          <div className="stat-sub">All time (active)</div>
        </div>
        <div className="stat-card" style={{ borderLeft: '4px solid #ec4899' }}>
          <div className="stat-label">↩️ Return Received</div>
          <div className="stat-value">{returnReceivedAll.length}</div>
          <div className="stat-sub">All time</div>
        </div>
      </div>

      {/* ── Platform → Courier Breakdown Table ── */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
          <div className="card-title" style={{ margin: 0 }}>Platform &amp; Courier Partner Breakdown — {date}</div>
          <div style={{ flex: 1 }} />
          {isSupabaseConfigured() && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button className="btn btn-outline btn-sm" onClick={handleSaveSnapshot} disabled={savingSnap}>
                {savingSnap ? '💾 Saving…' : '💾 Save Snapshot'}
              </button>
              {snapMsg && <span style={{ fontSize: 12, color: snapMsg.startsWith('✅') ? 'var(--green)' : '#b45309' }}>{snapMsg}</span>}
            </div>
          )}
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Platform</th>
                <th>Courier Partner</th>
                <th>📤 Uploaded</th>
                <th>✅ Dispatched</th>
                <th>⏳ Pending</th>
                <th>🔍 Scanned</th>
                <th>✏️ Manual</th>
                <th>COD</th>
                <th>Prepaid</th>
                <th>🚚 In Transit</th>
                <th>↩️ Returned</th>
                <th>Discrepancy</th>
              </tr>
            </thead>
            <tbody>
              {platformSummary.filter((r) => r.uploaded > 0 || r.dispatched > 0 || r.inTransit > 0).length === 0 ? (
                <tr><td colSpan={12}><div className="empty">No data for {date}. Import orders first.</div></td></tr>
              ) : (
                platformSummary.filter((r) => r.uploaded > 0 || r.dispatched > 0 || r.inTransit > 0).map(({ p, courier, uploaded, dispatched, pending, scanned, manual, cod, prepaid, inTransit, returned }) => (
                  <tr
                    key={`${p}-${courier}`}
                    onClick={() => {
                      if (
                        platformFilter === p &&
                        courierFilter === courier
                      ) {
                        setPlatformFilter('');
                        setCourierFilter('');
                      } else {
                        setPlatformFilter(p);
                        setCourierFilter(courier);
                      }
                    }}
                    style={{
                      cursor: 'pointer',
                      ...(manual > 0 ? { background: '#fffbeb' } : {}),
                      outline:
                        platformFilter === p &&
                          courierFilter === courier
                          ? `2px solid ${PLATFORM_COLORS[p]}`
                          : 'none'
                    }}>
                    <td>
                      <span className="chip" style={{ background: PLATFORM_COLORS[p] + '22', color: PLATFORM_COLORS[p], fontWeight: 700 }}>{p}</span>
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--muted)' }}>{courier}</td>
                    <td style={{ fontWeight: 700 }}>{uploaded}</td>
                    <td style={{ color: 'var(--green)', fontWeight: 600 }}>{dispatched}</td>
                    <td style={{ color: pending > 0 ? '#b45309' : 'var(--muted)', fontWeight: pending > 0 ? 700 : 400 }}>
                      {pending > 0 ? `⏳ ${pending}` : pending}
                    </td>
                    <td style={{ color: 'var(--green)' }}>{scanned}</td>
                    <td style={{ color: manual > 0 ? '#b45309' : 'var(--muted)', fontWeight: manual > 0 ? 700 : 400 }}>
                      {manual > 0 ? `⚠️ ${manual}` : manual}
                    </td>
                    <td>{cod}</td>
                    <td>{prepaid}</td>
                    <td style={{ color: '#3b82f6' }}>{inTransit}</td>
                    <td style={{ color: '#ec4899' }}>{returned}</td>
                    <td>
                      {manual > 0
                        ? <span className="status" style={{ background: '#fef3c7', color: '#92400e', fontSize: 11 }}>⚠️ {manual} manual</span>
                        : pending > 0
                          ? <span className="status" style={{ background: '#fef9c3', color: '#854d0e', fontSize: 11 }}>⏳ {pending} pending</span>
                          : <span className="status s-dispatched" style={{ fontSize: 11 }}>✅ Clear</span>
                      }
                    </td>
                  </tr>
                ))
              )}
              {/* Totals row */}
              {platformSummary.some((r) => r.uploaded > 0) && (
                <tr style={{ fontWeight: 700, borderTop: '2px solid var(--border)', background: 'var(--surface)' }}>
                  <td colSpan={2}>TOTAL</td>
                  <td>{platformSummary.reduce((a, r) => a + r.uploaded, 0)}</td>
                  <td style={{ color: 'var(--green)' }}>{platformSummary.reduce((a, r) => a + r.dispatched, 0)}</td>
                  <td style={{ color: '#b45309' }}>{platformSummary.reduce((a, r) => a + r.pending, 0)}</td>
                  <td>{platformSummary.reduce((a, r) => a + r.scanned, 0)}</td>
                  <td>{platformSummary.reduce((a, r) => a + r.manual, 0)}</td>
                  <td>{platformSummary.reduce((a, r) => a + r.cod, 0)}</td>
                  <td>{platformSummary.reduce((a, r) => a + r.prepaid, 0)}</td>
                  <td>{platformSummary.reduce((a, r) => a + r.inTransit, 0)}</td>
                  <td>{platformSummary.reduce((a, r) => a + r.returned, 0)}</td>
                  <td></td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Filter Bar ── */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div
          style={{
            display: "flex",
            gap: 12,
            flexWrap: "wrap",
            alignItems: "flex-end",
          }}
        >

          {/* Platform */}
          <div className="fg" style={{ marginBottom: 0, minWidth: 150 }}>
            <label>Platform</label>
            <select
              value={platformFilter}
              onChange={(e) => setPlatformFilter(e.target.value)}
            >
              <option value="">All Platforms</option>
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>

          {/* Courier */}
          <div className="fg" style={{ marginBottom: 0, minWidth: 180 }}>
            <label>Courier</label>
            <select
              value={courierFilter}
              onChange={(e) => setCourierFilter(e.target.value)}
            >
              <option value="">All Couriers</option>

              {Array.from(
                new Set(orders.map((o) => getCourier(o)))
              ).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          {/* Status */}
          <div className="fg" style={{ marginBottom: 0, minWidth: 170 }}>
            <label>Status</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">All (uploaded today)</option>
              <option value="Dispatched">✅ Dispatched</option>
              <option value="Pending">⏳ Pending (Ready to Ship)</option>
              <option value="In Transit">🚚 In Transit</option>
              <option value="Return Received">↩️ Return Received</option>
            </select>
          </div>

          {/* Payment */}
          <div className="fg" style={{ marginBottom: 0, minWidth: 130 }}>
            <label>Payment</label>
            <select
              value={paymentFilter}
              onChange={(e) => setPaymentFilter(e.target.value)}
            >
              <option value="">All</option>
              <option value="COD">COD</option>
              <option value="Prepaid">Prepaid</option>
            </select>
          </div>

          {/* Company */}
          {companies.length > 1 && (
            <div className="fg" style={{ marginBottom: 0, minWidth: 180 }}>
              <label>Company</label>
              <select
                value={companyFilter}
                onChange={(e) => setCompanyFilter(e.target.value)}
              >
                <option value="">All Companies</option>
                {companies.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Clear */}
          <button
            className="btn btn-outline btn-sm"
            style={{ alignSelf: "flex-end" }}
            onClick={() => {
              setPlatformFilter("");
              setCourierFilter("");
              setStatusFilter("");
              setPaymentFilter("");
              setCompanyFilter("");
            }}
          >
            Clear
          </button>

          <div
            style={{
              marginLeft: "auto",
              alignSelf: "flex-end",
              fontSize: 14,
              color: "var(--muted)",
            }}
          >
            Showing{" "}
            <strong style={{ color: "var(--text)" }}>
              {detailOrders.length}
            </strong>{" "}
            orders
          </div>

        </div>
      </div>

      {/* ── Detail Table ── */}
      <div className="card">
        <div className="card-title">Order Details
          {platformFilter ? ` · ${platformFilter}` : ''}
          {courierFilter ? ` · ${courierFilter}` : ''}
          {statusFilter ? ` · ${statusFilter}` : ''}
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Order ID</th><th>AWB</th><th>Customer</th><th>Platform</th>
                <th>Courier</th><th>Company</th><th>SKU</th><th>Payment</th>
                <th>Amount</th><th>Status</th><th>Entry</th><th>Date/Time</th>
              </tr>
            </thead>
            <tbody>
              {detailOrders.length === 0 ? (
                <tr><td colSpan={12}><div className="empty">No orders match the current filters.</div></td></tr>
              ) : (
                detailOrders.map((o) => {
                  const ds = getDispatchStatus(o);
                  const scnd = isScanDispatched(o);
                  const pform = getPlatform(o);
                  const cour = getCourier(o);
                  const ts = o.dispatchedAt
                    ? new Date(o.dispatchedAt).toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit' })
                    : o.importedAt
                      ? localDateStr(o.importedAt)
                      : '—';
                  return (
                    <tr key={o.id} style={ds === 'Pending' ? { background: '#fefce8' } : {}}>
                      <td className="truncate" title={o.orderId}>{o.orderId}</td>
                      <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{o.awb || '—'}</td>
                      <td>{o.customer}</td>
                      <td>
                        <span className="chip" style={{ background: PLATFORM_COLORS[pform] + '22', color: PLATFORM_COLORS[pform], fontWeight: 700 }}>
                          {pform}
                        </span>
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--muted)' }}>{cour}</td>
                      <td><span className="chip" style={{ background: 'var(--accent-soft)', color: 'var(--accent-hover)' }}>{o.company || 'Unknown'}</span></td>
                      <td className="truncate" title={o.sku}>{o.sku || '—'}</td>
                      <td><span className={`status ${o.payment === 'COD' ? 's-cod' : 's-prepaid'}`}>{o.payment}</span></td>
                      <td>₹{(o.amount || 0).toLocaleString('en-IN')}</td>
                      <td>
                        {ds === 'Dispatched' && <span className="status s-dispatched" style={{ fontSize: 11 }}>✅ Dispatched</span>}
                        {ds === 'Pending' && <span className="status" style={{ background: '#fef9c3', color: '#854d0e', fontSize: 11 }}>⏳ Pending</span>}
                        {ds === 'In Transit' && <span className="status s-transit" style={{ fontSize: 11 }}>🚚 In Transit</span>}
                        {ds === 'Return Received' && <span className="status" style={{ background: '#fce7f3', color: '#9d174d', fontSize: 11 }}>↩️ Returned</span>}
                        {!['Dispatched', 'Pending', 'In Transit', 'Return Received'].includes(ds) && <span className="status" style={{ fontSize: 11 }}>{ds}</span>}
                      </td>
                      <td>
                        {ds === 'Dispatched'
                          ? scnd
                            ? <span className="status s-dispatched" style={{ fontSize: 11 }}>🔍 Scanned</span>
                            : <span className="status" style={{ background: '#fef3c7', color: '#92400e', fontSize: 11 }}>✏️ Manual</span>
                          : <span style={{ fontSize: 11, color: 'var(--muted)' }}>—</span>
                        }
                      </td>
                      <td style={{ fontSize: 12 }}>{ts}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
