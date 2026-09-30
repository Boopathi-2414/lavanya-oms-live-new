import { useState } from 'react';
import * as XLSX from 'xlsx';
import { today } from '../db.js';
import { toast } from './Toast.jsx';

export default function Reports({ db }) {
  const [rFrom,    setRFrom]    = useState('');
  const [rTo,      setRTo]      = useState('');
  const [rChannel, setRChannel] = useState('');
  const [rStatus,  setRStatus]  = useState('');
  const [preview,  setPreview]  = useState(null);

  function getReportData() {
    return db.orders
      .filter((o) => {
        if (o.deleted) return false;
        if (rFrom && o.orderDate < rFrom) return false;
        if (rTo   && o.orderDate > rTo)   return false;
        if (rChannel && o.channel !== rChannel) return false;
        if (rStatus  && o.status  !== rStatus)  return false;
        return true;
      })
      .map((o) => {
        const p = db.payments.find(
          (p) => (p.orderId && p.orderId === o.orderId) ||
            (p.awb && ((o.awb && p.awb === o.awb) || (o.invoice && p.awb === o.invoice)))
        );
        return { ...o, settlement: p?.settlement || 0, gst: p?.gstAmount ?? p?.gst ?? 0, reconciled: !!p };
      });
  }

  function generateReport() {
    setPreview(getReportData());
  }

  function downloadReport() {
    const data = getReportData();
    const rows = data.map((o) => ({
      'Order ID': o.orderId, Customer: o.customer, Channel: o.channel,
      'AWB / Ref': o.awb || '', 'Invoice Ref': o.invoice || '', SKU: o.sku || '', Quantity: o.quantity || 1,
      'Payment Mode': o.payment, 'Order Amount': o.amount || 0, Status: o.status,
      Settlement: o.settlement || 0, 'GST Paid': o.gst || 0,
      Reconciled: o.reconciled ? 'Yes' : 'No', 'Order Date': o.orderDate || '',
      'Dispatched At': o.dispatchedAt ? new Date(o.dispatchedAt).toLocaleDateString('en-IN') : '',
      'Return Date': o.receivedDate ? new Date(o.receivedDate).toLocaleDateString('en-IN') : '',
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Orders');
    const summary = [
      ['Lavanya Aari Materials - Report'],
      ['Generated:', new Date().toLocaleDateString('en-IN')],
      [],
      ['Metric', 'Value'],
      ['Total Orders',      data.length],
      ['Dispatched',        data.filter((o) => o.status === 'Dispatched').length],
      ['Return Transit',    data.filter((o) => o.status === 'In Transit (Return)').length],
      ['Return Received',   data.filter((o) => o.status === 'Return Received').length],
      ['Total Revenue (₹)', data.reduce((s, o) => s + (o.amount || 0), 0)],
      ['Total Settlement (₹)', data.reduce((s, o) => s + (o.settlement || 0), 0)],
      ['Reconciled',        data.filter((o) => o.reconciled).length],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), 'Summary');
    XLSX.writeFile(wb, `Lavanya_Report_${today()}.xlsx`);
    toast('Report downloaded!', 'success');
  }

  const statClass = (s) => ({
    'Ready to Ship': 's-ready', Dispatched: 's-dispatched',
    'In Transit (Return)': 's-transit', 'Return Received': 's-received',
  }[s] || 's-ready');

  return (
    <div>
      <div className="card">
        <div className="card-title">Generate Monthly Report</div>
        <div className="form-row">
          <div><label>From Date</label><input type="date" value={rFrom} onChange={(e) => setRFrom(e.target.value)} /></div>
          <div><label>To Date</label><input type="date" value={rTo} onChange={(e) => setRTo(e.target.value)} /></div>
        </div>
        <div className="form-row">
          <div><label>Marketplace</label>
            <select value={rChannel} onChange={(e) => setRChannel(e.target.value)}>
              <option value="">All</option><option>Amazon</option><option>Flipkart</option><option>Meesho</option>
            </select>
          </div>
          <div><label>Status</label>
            <select value={rStatus} onChange={(e) => setRStatus(e.target.value)}>
              <option value="">All</option>
              <option>Ready to Ship</option><option>Dispatched</option>
              <option>In Transit (Return)</option><option>Return Received</option>
            </select>
          </div>
        </div>
        <button className="btn btn-primary" onClick={generateReport}>📊 Generate &amp; Preview</button>
        <button className="btn btn-success" style={{ marginLeft: 8 }} onClick={downloadReport}>⬇ Download Excel</button>
      </div>

      {preview && (
        <div className="card">
          <div className="card-title">Report Preview ({preview.length} records)</div>
          <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', marginBottom: 16 }}>
            {[
              ['Total', preview.length, 'var(--accent)'],
              ['Dispatched', preview.filter((o) => o.status === 'Dispatched').length, 'var(--green)'],
              ['In Transit', preview.filter((o) => o.status === 'In Transit (Return)').length, 'var(--gold)'],
              ['Received', preview.filter((o) => o.status === 'Return Received').length, 'var(--sky)'],
              ['Revenue', '₹' + preview.reduce((s, o) => s + (o.amount || 0), 0).toLocaleString('en-IN'), 'var(--accent2)'],
              ['Settlement', '₹' + preview.reduce((s, o) => s + (o.settlement || 0), 0).toLocaleString('en-IN'), 'var(--green)'],
              ['Reconciled', preview.filter((o) => o.reconciled).length, 'var(--green)'],
              ['Pending', preview.filter((o) => !o.reconciled && o.status === 'Dispatched').length, 'var(--red)'],
            ].map(([label, value, color]) => (
              <div key={label} className="stat-card">
                <div style={{ height: 3, background: color, borderRadius: '4px 4px 0 0', margin: '-20px -20px 12px' }} />
                <div className="stat-label">{label}</div>
                <div className="stat-value" style={{ fontSize: 22, color }}>{value}</div>
              </div>
            ))}
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Order ID</th><th>Customer</th><th>Channel</th><th>AWB</th>
                  <th>SKU</th><th>Qty</th><th>Payment</th><th>Amount</th><th>Status</th><th>Settlement</th><th>Date</th>
                </tr>
              </thead>
              <tbody>
                {preview.length === 0 ? (
                  <tr><td colSpan={11}><div className="empty">No data.</div></td></tr>
                ) : (
                  preview.map((o) => (
                    <tr key={o.id}>
                      <td className="truncate" title={o.orderId}>{o.orderId}</td>
                      <td>{o.customer}</td>
                      <td><span className={`chip chip-${(o.channel || '').toLowerCase()}`}>{o.channel}</span></td>
                      <td>{o.awb || '—'}</td>
                      <td className="truncate" title={o.sku}>{o.sku || '—'}</td>
                      <td>{o.quantity || 1}</td>
                      <td><span className={`status ${o.payment === 'COD' ? 's-cod' : 's-prepaid'}`}>{o.payment}</span></td>
                      <td>₹{(o.amount || 0).toLocaleString('en-IN')}</td>
                      <td><span className={`status ${statClass(o.status)}`}>{o.status}</span></td>
                      <td>{o.settlement ? `₹${o.settlement.toLocaleString('en-IN')}` : '—'}</td>
                      <td>{o.orderDate || '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
