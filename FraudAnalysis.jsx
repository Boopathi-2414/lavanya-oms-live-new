import { useState } from 'react';
import { genId, today } from '../db.js';
import { toast } from './Toast.jsx';
import * as XLSX from 'xlsx';

const RETURN_REASONS = [
  'Empty box received',
  'Wrong item received',
  'Damaged product',
  'Item not as described',
  'Fake return — no actual delivery issue',
  'Repeated return offender',
  'Address fraud',
  'Other',
];

export default function FraudAnalysis({ db, setDb }) {
  const [showAddModal, setShowAddModal] = useState(false);
  const [flagPage, setFlagPage] = useState(1);
  const [retPage, setRetPage] = useState(1);
  const [fromOrder,    setFromOrder]    = useState(null); // pre-fill from order
  const [search,       setSearch]       = useState('');
  const [form, setForm] = useState({
    customer: '', phone: '', address: '', orderId: '', awb: '',
    reason: RETURN_REASONS[0], notes: '', date: today(),
  });

  const fraudList = db.fraudList || [];
  const orders    = db.orders.filter((o) => !o.deleted);

  // Orders with fraud alert flags (auto-detected on import)
  // PERFORMANCE (Aug 2026): both tables below rendered every matching
  // order. At 9,000 orders that put ~2,800 rows in the DOM and made this
  // the slowest page left. Paged at 50 like the rest.
  const FRAUD_PAGE_SIZE = 50;
  const flaggedOrders = orders.filter((o) => o.fraudAlert);
  const flagTotalPages = Math.max(1, Math.ceil(flaggedOrders.length / FRAUD_PAGE_SIZE));
  const flagSafePage = Math.min(flagPage, flagTotalPages);
  const flagRows = flaggedOrders.slice((flagSafePage - 1) * FRAUD_PAGE_SIZE, flagSafePage * FRAUD_PAGE_SIZE);

  // Orders with return history (In Transit Return or Return Received)
  const returnOrders = orders.filter(
    (o) => o.status === 'In Transit (Return)' || o.status === 'Return Received'
  );
  const retTotalPages = Math.max(1, Math.ceil(returnOrders.length / FRAUD_PAGE_SIZE));
  const retSafePage = Math.min(retPage, retTotalPages);
  const retRows = returnOrders.slice((retSafePage - 1) * FRAUD_PAGE_SIZE, retSafePage * FRAUD_PAGE_SIZE);

  function openAddModal(prefill = null) {
    if (prefill) {
      setForm({
        customer: prefill.customer || '',
        phone:    prefill.phone    || '',
        address:  prefill.address  || '',
        orderId:  prefill.orderId  || '',
        awb:      prefill.awb      || '',
        reason:   RETURN_REASONS[0],
        notes:    '',
        date:     today(),
      });
      setFromOrder(prefill);
    } else {
      setForm({ customer: '', phone: '', address: '', orderId: '', awb: '', reason: RETURN_REASONS[0], notes: '', date: today() });
      setFromOrder(null);
    }
    setShowAddModal(true);
  }

  function saveEntry() {
    if (!form.customer.trim() && !form.phone.trim() && !form.address.trim()) {
      toast('Enter at least one of: Customer Name, Phone, or Address', 'error');
      return;
    }
    const entry = { ...form, id: genId(), addedAt: new Date().toISOString() };
    const next = { ...db, fraudList: [...(db.fraudList || []), entry] };

    // Re-flag any existing orders that match this new entry
    let retagged = 0;
    next.orders.forEach((o) => {
      if (o.deleted) return;
      const nc = (s) => (s || '').toLowerCase().trim();
      const matches =
        (form.customer && nc(o.customer) === nc(form.customer)) ||
        (form.phone    && nc(o.phone)    === nc(form.phone)) ||
        (form.address  && form.address.length > 5 && nc(o.address).includes(nc(form.address)));
      if (matches) {
        o.fraudAlert = `⚠️ Matches blocklist: ${form.customer || form.phone || form.address}`;
        retagged++;
      }
    });

    setDb(next);
    setShowAddModal(false);
    toast(`Blocklist entry added${retagged > 0 ? `. ${retagged} existing order(s) flagged.` : ''}`, 'success');
  }

  function removeEntry(id) {
    if (!window.confirm('Remove this blocklist entry?')) return;
    const next = { ...db, fraudList: (db.fraudList || []).filter((f) => f.id !== id) };
    setDb(next);
    toast('Blocklist entry removed', 'success');
  }

  function exportBlocklist() {
    if (!fraudList.length) { toast('No blocklist entries to export', 'info'); return; }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(fraudList), 'Blocklist');
    XLSX.writeFile(wb, `FraudBlocklist_${today()}.xlsx`);
    toast('Blocklist exported', 'success');
  }

  const q = search.toLowerCase();
  const filteredList = fraudList.filter((f) =>
    !q || `${f.customer} ${f.phone} ${f.address} ${f.orderId} ${f.reason}`.toLowerCase().includes(q)
  );

  return (
    <div>
      {/* Summary cards */}
      <div className="stats-grid" style={{ marginBottom: 24 }}>
        <div className="stat-card fraud">
          <div className="stat-label">Blocklist Entries</div>
          <div className="stat-value">{fraudList.length}</div>
          <div className="stat-sub">Flagged customers / addresses</div>
        </div>
        <div className="stat-card transit">
          <div className="stat-label">Flagged Orders (all statuses)</div>
          <div className="stat-value">{flaggedOrders.length}</div>
          <div className="stat-sub">Risk warnings on orders</div>
        </div>
        <div className="stat-card received">
          <div className="stat-label">Total Returns</div>
          <div className="stat-value">{returnOrders.length}</div>
          <div className="stat-sub">In transit + received</div>
        </div>
      </div>

      {/* ── Blocklist management ── */}
      <div className="card">
        <div className="flex items-center gap-3 mb-3" style={{ flexWrap: 'wrap' }}>
          <div className="card-title" style={{ margin: 0 }}>Fraud Blocklist</div>
          <div style={{ flex: 1 }} />
          <button className="btn btn-outline btn-sm" onClick={exportBlocklist}>⬇ Export</button>
          <button className="btn btn-primary btn-sm" onClick={() => openAddModal()}>+ Add Entry</button>
        </div>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>
          Add customers, phone numbers, or delivery addresses here. Any new order parsed from a PDF that
          matches an entry will be auto-flagged with a 🚨 Fraud Alert.
        </p>

        <div className="filter-bar" style={{ marginBottom: 12 }}>
          <div className="fg"><label>Search blocklist</label>
            <input type="text" placeholder="Name, phone, address…" value={search}
              onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Customer Name</th><th>Phone</th><th>Address</th>
                <th>Order ID</th><th>Reason</th><th>Notes</th><th>Added On</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredList.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <div className="empty">
                      <div className="big">🚫</div>
                      No blocklist entries yet.<br />
                      <span style={{ fontSize: 12 }}>Add customers involved in bad returns below, or click a return order to add.</span>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredList.map((f) => (
                  <tr key={f.id}>
                    <td style={{ fontWeight: 600 }}>{f.customer || '—'}</td>
                    <td>{f.phone || '—'}</td>
                    <td style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.address}>{f.address || '—'}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{f.orderId || '—'}</td>
                    <td>
                      <span className="status" style={{ background: '#fef2f2', color: '#b91c1c' }}>
                        {f.reason}
                      </span>
                    </td>
                    <td style={{ color: 'var(--muted)', fontSize: 12 }}>{f.notes || '—'}</td>
                    <td style={{ fontSize: 12 }}>{f.addedAt ? new Date(f.addedAt).toLocaleDateString('en-IN') : '—'}</td>
                    <td>
                      <button className="btn btn-danger btn-xs" onClick={() => removeEntry(f.id)}>✕ Remove</button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Flagged active orders ── */}
      {flaggedOrders.length > 0 && (
        <div className="card" style={{ borderLeft: '4px solid #ef4444' }}>
          <div className="card-title" style={{ color: '#b91c1c' }}>Currently Flagged Orders ({flaggedOrders.length})</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Order ID</th><th>Customer</th><th>Channel</th><th>Status</th><th>Alert</th>
                </tr>
              </thead>
              <tbody>
                {flagRows.map((o) => (
                  <tr key={o.id} style={{ background: '#fff1f1' }}>
                    <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{o.orderId}</td>
                    <td>{o.customer}</td>
                    <td><span className={`chip chip-${(o.channel || '').toLowerCase()}`}>{o.channel}</span></td>
                    <td><span className={`status s-${o.status === 'Ready to Ship' ? 'ready' : 'transit'}`}>{o.status}</span></td>
                    <td style={{ color: '#b91c1c', fontSize: 12, fontWeight: 600 }}>{o.fraudAlert}</td>
                  </tr>
                ))}
              </tbody>
            </table>
        {flaggedOrders.length > FRAUD_PAGE_SIZE && (
          <div className="flex gap-2 mt-2" style={{ alignItems: 'center', justifyContent: 'center' }}>
            <button className="btn btn-ghost btn-sm" disabled={flagSafePage <= 1} onClick={() => setFlagPage(flagSafePage - 1)}>← Prev</button>
            <span className="text-sm text-muted">Page {flagSafePage} of {flagTotalPages} · showing {flagRows.length} of {flaggedOrders.length.toLocaleString('en-IN')}</span>
            <button className="btn btn-ghost btn-sm" disabled={flagSafePage >= flagTotalPages} onClick={() => setFlagPage(flagSafePage + 1)}>Next →</button>
          </div>
        )}
          </div>
        </div>
      )}

      {/* ── Return history with add-to-blocklist button ── */}
      <div className="card">
        <div className="card-title">Return Order History</div>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>
          Click <strong>"Add to Blocklist"</strong> on any problematic return to flag that customer or address.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Order ID</th><th>Customer</th><th>Channel</th><th>AWB</th><th>Status</th><th>Date</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {returnOrders.length === 0 ? (
                <tr><td colSpan={7}><div className="empty">No return orders yet.</div></td></tr>
              ) : (
                retRows.map((o) => (
                  <tr key={o.id} style={o.fraudAlert ? { background: '#fff1f1' } : {}}>
                    <td style={{ fontFamily: 'monospace', fontSize: 12 }}>
                      {o.orderId}
                      {o.fraudAlert && <span style={{ marginLeft: 4, color: '#ef4444' }}>🚨</span>}
                    </td>
                    <td>{o.customer}</td>
                    <td><span className={`chip chip-${(o.channel || '').toLowerCase()}`}>{o.channel}</span></td>
                    <td>{o.awb || '—'}</td>
                    <td>
                      <span className={`status ${o.status === 'Return Received' ? 's-received' : 's-transit'}`}>
                        {o.status}
                      </span>
                    </td>
                    <td style={{ fontSize: 12 }}>{o.receivedDate ? new Date(o.receivedDate).toLocaleDateString('en-IN') : o.orderDate || '—'}</td>
                    <td>
                      <button
                        className="btn btn-danger btn-xs"
                        onClick={() => openAddModal(o)}
                        title="Flag this customer/address as fraudulent"
                      >
                        🚫 Add to Blocklist
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        {returnOrders.length > FRAUD_PAGE_SIZE && (
          <div className="flex gap-2 mt-2" style={{ alignItems: 'center', justifyContent: 'center' }}>
            <button className="btn btn-ghost btn-sm" disabled={retSafePage <= 1} onClick={() => setRetPage(retSafePage - 1)}>← Prev</button>
            <span className="text-sm text-muted">Page {retSafePage} of {retTotalPages} · showing {retRows.length} of {returnOrders.length.toLocaleString('en-IN')}</span>
            <button className="btn btn-ghost btn-sm" disabled={retSafePage >= retTotalPages} onClick={() => setRetPage(retSafePage + 1)}>Next →</button>
          </div>
        )}
        </div>
      </div>

      {/* ── Add/Edit Modal ── */}
      {showAddModal && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowAddModal(false); }}>
          <div className="modal">
            <div className="modal-title">🚫 Add to Fraud Blocklist</div>
            {fromOrder && (
              <div className="info-banner" style={{ marginBottom: 12 }}>
                Pre-filled from order: <strong>{fromOrder.orderId}</strong>. Confirm or edit the details below.
              </div>
            )}
            <div className="form-row">
              <div><label>Customer Name</label>
                <input type="text" placeholder="Full name" value={form.customer}
                  onChange={(e) => setForm({ ...form, customer: e.target.value })} />
              </div>
              <div><label>Phone Number</label>
                <input type="text" placeholder="10-digit mobile" value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </div>
            </div>
            <div style={{ marginBottom: 14 }}>
              <label>Delivery Address (or partial)</label>
              <textarea rows={2} placeholder="Street, City, Pincode…" value={form.address}
                style={{ width: '100%', padding: '9px 12px', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: 13 }}
                onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </div>
            <div className="form-row">
              <div><label>Order ID (reference)</label>
                <input type="text" placeholder="Optional" value={form.orderId}
                  onChange={(e) => setForm({ ...form, orderId: e.target.value })} />
              </div>
              <div><label>AWB (reference)</label>
                <input type="text" placeholder="Optional" value={form.awb}
                  onChange={(e) => setForm({ ...form, awb: e.target.value })} />
              </div>
            </div>
            <div className="form-row">
              <div><label>Reason</label>
                <select value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}>
                  {RETURN_REASONS.map((r) => <option key={r}>{r}</option>)}
                </select>
              </div>
              <div><label>Date</label>
                <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
              </div>
            </div>
            <div style={{ marginBottom: 14 }}>
              <label>Additional Notes</label>
              <textarea rows={2} placeholder="Any extra details…" value={form.notes}
                style={{ width: '100%', padding: '9px 12px', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: 13 }}
                onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setShowAddModal(false)}>Cancel</button>
              <button className="btn btn-danger" onClick={saveEntry}>🚫 Add to Blocklist</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
