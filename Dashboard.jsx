import { useState } from 'react';
import { detectRepeatReturners, repeatReturnerLabel, COMPANIES, flattenCourierBreakdown, ORDER_STATUSES } from '../db.js';

export default function Dashboard({ db, onRefresh, syncState, lastSynced, supabaseConfigured }) {
  const orders = db.orders.filter((o) => !o.deleted);
  const [showExchangeList, setShowExchangeList] = useState(false);

  const total      = orders.length;
  const dispatched = orders.filter((o) => o.status === 'Dispatched').length;
  const transit    = orders.filter((o) => o.status === 'In Transit (Return)').length;
  const received   = orders.filter((o) => o.status === 'Return Received').length;
  const ready      = orders.filter((o) => o.status === 'Ready to Ship').length;

  // Feature 2: Exchange orders
  const exchangeOrders = orders.filter((o) => o.orderType === 'Exchange');
  const exchangeCount  = exchangeOrders.length;

  // Feature 4: Fraud alerts (manual blocklist matches)
  const fraudOrders = orders.filter((o) => o.fraudAlert);

  // History-based repeat-returner risk: same customer name / address showing
  // up repeatedly with a high proportion of returns — independent of the
  // manual blocklist above.
  const repeatReturnMap = detectRepeatReturners(db.orders);
  const repeatReturnOrders = orders.filter((o) => repeatReturnMap.has(o.id));

  const revenue = orders.reduce((s, o) => s + (o.amount || 0), 0);
  const prepaid = orders.filter((o) => o.payment === 'Prepaid').length;
  const cod     = orders.filter((o) => o.payment === 'COD').length;

  const recent = [...orders]
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 10);

  const channels = ['Amazon', 'Flipkart', 'Meesho'];
  const channelColors = { Amazon: '#f59e0b', Flipkart: '#3b82f6', Meesho: '#ec4899' };

  // Feature 5: multi-company breakdown — every order carries a `company`
  // field set during parsing (strict known-company lookup, see db.js),
  // so this never mixes orders between businesses.
  const companyCounts = [...COMPANIES.map((c) => c.name), 'Unknown'].map((name) => ({
    name,
    count: orders.filter((o) => (o.company || 'Unknown') === name).length,
  }));
  const companyColors = { [COMPANIES[0]?.name]: '#10b981', [COMPANIES[1]?.name]: '#B45309', [COMPANIES[2]?.name]: '#0ea5e9', Unknown: '#9ca3af' };

  // Courier performance — built from whatever channel/courier values
  // actually appear on the orders (see buildCourierBreakdown/
  // flattenCourierBreakdown in db.js). Adding a brand-new courier never
  // needs a code change here: it just shows up as its own row the next
  // time orders carrying it are parsed.
  const courierRows = flattenCourierBreakdown(orders);

  return (
    <div>
      {/* Sync status + manual refresh — fetches straight from Supabase,
          bypassing whatever's cached locally, so this device's numbers
          match every other device's. */}
      <div
        className="card"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}
      >
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>
          {!supabaseConfigured
            ? '⚪ Running on local data only — Supabase is not configured on this device.'
            : syncState === 'syncing'
            ? '⏳ Refreshing from Supabase…'
            : syncState === 'error'
            ? '⚠️ Could not reach Supabase — showing the last data saved on this device.'
            : lastSynced
            ? `✅ Synced from Supabase · ${lastSynced.toLocaleTimeString('en-IN')}`
            : 'Not yet synced'}
        </div>
        <button
          className="btn btn-outline btn-sm"
          onClick={onRefresh}
          disabled={syncState === 'syncing'}
        >
          {syncState === 'syncing' ? '⏳ Refreshing…' : '🔄 Refresh Data'}
        </button>
      </div>

      {/* KPI stats */}
      <div className="stats-grid">
        <StatCard cls="total"      label="Total Orders"    value={total}      sub="All time" />
        <StatCard cls="dispatched" label="Dispatched"      value={dispatched} sub="Shipped out" />
        <StatCard cls="transit"    label="Return Transit"  value={transit}    sub="Coming back" />
        <StatCard cls="received"   label="Return Received" value={received}   sub="Back in stock" />
        <StatCard cls="rts"        label="Ready to Ship"   value={ready}      sub="Pending dispatch" />
        {/* Feature 2: Exchange card */}
        <StatCard
          cls="exchange"
          label="Exchange Orders"
          value={exchangeCount}
          sub="Click to view"
          onClick={() => setShowExchangeList((v) => !v)}
          clickable
        />
        {/* Feature 4: Fraud alert card */}
        {fraudOrders.length > 0 && (
          <StatCard cls="fraud" label="Fraud Alerts" value={fraudOrders.length} sub="Risk orders" />
        )}
        {/* Repeat-returner risk card (history-based, separate from the blocklist) */}
        {repeatReturnOrders.length > 0 && (
          <StatCard cls="fraud" label="Repeat Return Risk" value={repeatReturnOrders.length} sub="High-return customers/addresses" />
        )}
      </div>

      {/* Feature 5: multi-company summary — at the top, per requirement */}
      <div className="card">
        <div className="card-title">Company Breakdown</div>
        {total === 0 ? (
          <div className="empty"><div className="big">🏢</div>No data yet</div>
        ) : (
          <>
            <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>
              {companyCounts.map((c, i) => (
                <span key={c.name}>
                  {i > 0 && ' | '}
                  <strong>{c.name}</strong>: {c.count} Order{c.count === 1 ? '' : 's'}
                </span>
              ))}
            </p>
            {companyCounts.map((c) => {
              const pct = total ? Math.round((c.count / total) * 100) : 0;
              return (
                <div key={c.name} style={{ marginBottom: 12 }}>
                  <div className="flex items-center gap-2" style={{ marginBottom: 4 }}>
                    <span
                      className="chip"
                      style={{ fontWeight: 600 }}
                    >
                      {c.name}
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 600, marginLeft: 'auto' }}>
                      {c.count} ({pct}%)
                    </span>
                  </div>
                  <div className="progress">
                    <div className="progress-bar" style={{ width: `${pct}%`, background: companyColors[c.name] || '#9ca3af' }} />
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>

      {/* Feature 2: Exchange orders expandable list */}
      {showExchangeList && (
        <div className="card" style={{ borderLeft: '4px solid #f59e0b' }}>
          <div className="card-title">Exchange Orders ({exchangeCount})</div>
          {exchangeCount === 0 ? (
            <div className="empty">No exchange orders found.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Order ID</th><th>Customer</th><th>Channel</th>
                    <th>AWB</th><th>Amount</th><th>Status</th><th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {exchangeOrders.map((o) => (
                    <tr key={o.id}>
                      <td className="truncate" title={o.orderId}>{o.orderId}</td>
                      <td>{o.customer}</td>
                      <td><span className={`chip chip-${(o.channel || '').toLowerCase()}`}>{o.channel}</span></td>
                      <td>{o.awb || '—'}</td>
                      <td>₹{(o.amount || 0).toLocaleString('en-IN')}</td>
                      <td><StatusBadge status={o.status} /></td>
                      <td>{o.orderDate || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Feature 4: Fraud alert banner */}
      {fraudOrders.length > 0 && (
        <div className="card" style={{ borderLeft: '4px solid #ef4444', background: '#fff5f5' }}>
          <div className="card-title" style={{ color: '#b91c1c' }}>Fraud / Risk Alerts ({fraudOrders.length})</div>
          <p style={{ fontSize: 13, color: '#b91c1c', marginBottom: 12 }}>
            These orders were matched against your Fraud Blocklist. Exercise caution before dispatching.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Order ID</th><th>Customer</th><th>Channel</th><th>AWB</th><th>Alert Reason</th>
                </tr>
              </thead>
              <tbody>
                {fraudOrders.map((o) => (
                  <tr key={o.id} style={{ background: '#fff1f1' }}>
                    <td className="truncate" title={o.orderId}>{o.orderId}</td>
                    <td>{o.customer}</td>
                    <td><span className={`chip chip-${(o.channel || '').toLowerCase()}`}>{o.channel}</span></td>
                    <td>{o.awb || '—'}</td>
                    <td style={{ color: '#b91c1c', fontWeight: 600 }}>{o.fraudAlert}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Repeat-returner risk banner — history-based, separate from the manual blocklist above */}
      {repeatReturnOrders.length > 0 && (
        <div className="card" style={{ borderLeft: '4px solid #f59e0b', background: '#fffbeb' }}>
          <div className="card-title" style={{ color: '#b45309' }}>Repeat Return Risk ({repeatReturnOrders.length})</div>
          <p style={{ fontSize: 13, color: '#b45309', marginBottom: 12 }}>
            These orders share a customer name or delivery address that appears across several orders with a
            high proportion of returns — no manual blocklist entry required to trigger this.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Order ID</th><th>Customer</th><th>Channel</th><th>AWB</th><th>Risk Detail</th>
                </tr>
              </thead>
              <tbody>
                {repeatReturnOrders.map((o) => (
                  <tr key={o.id} style={{ background: '#fffbeb' }}>
                    <td className="truncate" title={o.orderId}>{o.orderId}</td>
                    <td>{o.customer}</td>
                    <td><span className={`chip chip-${(o.channel || '').toLowerCase()}`}>{o.channel}</span></td>
                    <td>{o.awb || '—'}</td>
                    <td style={{ color: '#b45309', fontWeight: 600, fontSize: 12 }}>{repeatReturnerLabel(repeatReturnMap.get(o.id))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="grid2">
        {/* Channel breakdown */}
        <div className="card">
          <div className="card-title">Channel Breakdown</div>
          {orders.length === 0 ? (
            <div className="empty"><div className="big">📡</div>No data yet</div>
          ) : (
            channels.map((ch) => {
              const cnt = orders.filter((o) => o.channel === ch).length;
              const pct = total ? Math.round((cnt / total) * 100) : 0;
              return (
                <div key={ch} style={{ marginBottom: 12 }}>
                  <div className="flex items-center gap-2" style={{ marginBottom: 4 }}>
                    <span className={`chip chip-${ch.toLowerCase()}`}>{ch}</span>
                    <span style={{ fontSize: 13, fontWeight: 600, marginLeft: 'auto' }}>
                      {cnt} ({pct}%)
                    </span>
                  </div>
                  <div className="progress">
                    <div className="progress-bar" style={{ width: `${pct}%`, background: channelColors[ch] }} />
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Payment summary */}
        <div className="card">
          <div className="card-title">Payment Summary</div>
          {orders.length === 0 ? (
            <div className="empty"><div className="big">💳</div>No data yet</div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, textAlign: 'center', marginBottom: 16 }}>
                <div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--green)' }}>{prepaid}</div>
                  <div className="stat-label">Prepaid</div>
                </div>
                <div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--gold)' }}>{cod}</div>
                  <div className="stat-label">COD</div>
                </div>
              </div>
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                Total Revenue:{' '}
                <strong>₹{revenue.toLocaleString('en-IN')}</strong>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Courier-wise performance — Platform → Courier → Status counts,
          built dynamically from whatever courier values are present on
          the orders (see flattenCourierBreakdown in db.js). */}
      <div className="card">
        <div className="card-title">Courier Performance (Platform → Courier)</div>
        {courierRows.length === 0 ? (
          <div className="empty"><div className="big">🚚</div>No data yet</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Platform</th>
                  <th>Courier Partner</th>
                  {ORDER_STATUSES.map((s) => <th key={s}>{s}</th>)}
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {courierRows.map((r) => (
                  <tr key={`${r.channel}-${r.courier}`}>
                    <td><span className={`chip chip-${r.channel.toLowerCase()}`}>{r.channel}</span></td>
                    <td>{r.courier}</td>
                    {ORDER_STATUSES.map((s) => <td key={s}>{r.byStatus[s]}</td>)}
                    <td style={{ fontWeight: 700 }}>{r.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Recent orders */}
      <div className="card">
        <div className="card-title">Recent Orders (Last 10)</div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Order ID</th><th>Customer</th><th>Channel</th><th>Company</th>
                <th>AWB</th><th>Type</th><th>Amount</th><th>Status</th><th>Date</th>
              </tr>
            </thead>
            <tbody>
              {recent.length === 0 ? (
                <tr><td colSpan={9}><div className="empty">No orders yet. Upload PDFs to get started.</div></td></tr>
              ) : (
                recent.map((o) => (
                  <tr key={o.id} style={o.fraudAlert ? { background: '#fff1f1' } : (repeatReturnMap.has(o.id) ? { background: '#fffbeb' } : {})}>
                    <td className="truncate" title={o.orderId}>
                      {o.orderId}
                      {o.fraudAlert && <span title={o.fraudAlert} style={{ marginLeft: 4, color: '#ef4444' }}>🚨</span>}
                      {repeatReturnMap.has(o.id) && (
                        <span title={repeatReturnerLabel(repeatReturnMap.get(o.id))} style={{ marginLeft: 4, color: '#b45309' }}>🔁</span>
                      )}
                    </td>
                    <td>{o.customer}</td>
                    <td><span className={`chip chip-${(o.channel || '').toLowerCase()}`}>{o.channel}</span></td>
                    <td>
                      <span className="chip" style={{ background: 'var(--accent-soft)', color: 'var(--accent-hover)' }}>
                        {o.company || 'Unknown'}
                      </span>
                    </td>
                    <td>{o.awb || '—'}</td>
                    <td>
                      {o.orderType === 'Exchange'
                        ? <span className="status s-exchange">🔁 Exchange</span>
                        : <span style={{ color: 'var(--muted)', fontSize: 12 }}>Regular</span>}
                    </td>
                    <td>₹{(o.amount || 0).toLocaleString('en-IN')}</td>
                    <td><StatusBadge status={o.status} /></td>
                    <td>{o.orderDate || '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatCard({ cls, label, value, sub, onClick, clickable }) {
  return (
    <div
      className={`stat-card ${cls}`}
      onClick={onClick}
      style={clickable ? { cursor: 'pointer' } : {}}
      title={clickable ? 'Click to toggle list' : ''}
    >
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-sub">{sub}{clickable ? ' 👆' : ''}</div>
    </div>
  );
}

function StatusBadge({ status }) {
  const cls = {
    'Ready to Ship': 's-ready', Dispatched: 's-dispatched',
    'In Transit (Return)': 's-transit', 'Return Received': 's-received',
  }[status] || 's-ready';
  return <span className={`status ${cls}`}>{status}</span>;
}