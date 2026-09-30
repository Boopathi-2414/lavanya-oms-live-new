import { stockRows } from '../businessLogic.js';
import { useState, useRef } from 'react';
import * as XLSX from 'xlsx';
import { genId, syncSkusFromOrders, findLookalikeSkus } from '../db.js';
import { stockQuantity, splitStock, applyStockCounts } from '../stockAllocation.js';
import { toast } from './Toast.jsx';

const EMPTY_FORM = { sku: '', category: '', rate: '' };

export default function Products({ db, setDb, getDb, user }) {
  const [stockFilter, setStockFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [selectedStock, setSelectedStock] = useState(new Set());
  const [stockTotal, setStockTotal] = useState('');
  const [allocation, setAllocation] = useState(null);
  const [stockDraft, setStockDraft] = useState({});
  const stockById = new Map(stockRows(db).map(p=>[p.id,p]));
  const resetSelection=()=>{setSelectedStock(new Set());setAllocation(null)};
  function saveCounts(changes) {
    const latest=getDb?getDb():db;
    const derived=new Map(stockRows(latest).map(p=>[p.id,p]));
    const visible=latest.products.map(p=>({...p,stockQuantity:derived.get(p.id)?.stock??p.stockQuantity??0}));
    const products=applyStockCounts(visible,changes,user?.username);
    const at=new Date().toISOString();
    const events=changes.map(c=>({id:crypto.randomUUID(),kind:'stockOpening',productId:c.id,quantity:c.quantity,at,actor:user?.username,reason:'Physical count / SKU allocation'}));
    setDb({...latest,products,businessRecords:[...(latest.businessRecords||[]),...events]},{products:changes.map(c=>c.id),businessRecords:events.map(e=>e.id)});
  }
  function commitStock(p,value) {
    try {const quantity=stockQuantity(value);const current=stockById.get(p.id);if(quantity===current.stock)return;
      saveCounts([{id:p.id,sku:p.sku,oldStock:current.stock,quantity}]);
      setStockDraft(d=>{const n={...d};delete n[p.id];return n});setAllocation(null);
    } catch(e) {toast(e.message,'error');setStockDraft(d=>{const n={...d};delete n[p.id];return n});}
  }
  function saveAllocation(){
    try {saveCounts(allocation);setAllocation(null);setStockDraft({});toast('Stock allocation saved','success');}
    catch(e){toast(e.message,'error');setAllocation(null);}
  }
  const [search,      setSearch]      = useState('');
  const [showModal,   setShowModal]   = useState(false);
  const [editingId,   setEditingId]   = useState(null);
  const [form,        setForm]        = useState(EMPTY_FORM);
  const [onlyUnset,   setOnlyUnset]   = useState(false);
  const [draftRates,  setDraftRates]  = useState({});   // id -> typed value, not saved yet

  // How many SKUs are on orders but not yet on this page.
  const pendingSkus = syncSkusFromOrders(db.orders, db.products);

  // Rows that are different SKUs by the exact-match rule but read the
  // same to a human. Shown, never merged — see findLookalikeSkus.
  const lookalikes = findLookalikeSkus(db.products);

  // Pull every SKU seen on an order into this list, once each, at ₹0.
  // Use this for the orders already in the system; new labels do it
  // automatically from Sales Entry.
  function syncFromOrders() {
    const added = syncSkusFromOrders(db.orders, db.products);
    if (!added.length) { toast('No new SKUs — every product on your orders is already listed.', 'info'); return; }
    db.products.push(...added);
    setDb({ ...db });
    setOnlyUnset(true);
    toast(`${added.length} SKU(s) added — set their purchase rate below`, 'success');
  }

  // Inline rate editing: type in the row, press Enter or click away.
  function commitRate(p, value) {
    const rate = parseFloat(value);
    if (!Number.isFinite(rate) || rate < 0) return;
    const idx = db.products.findIndex((x) => x.id === p.id);
    if (idx === -1) return;
    db.products[idx] = { ...db.products[idx], rate, autoAdded: false };
    setDb({ ...db });
    setDraftRates((d) => { const n = { ...d }; delete n[p.id]; return n; });
  }
  const fileInputRef = useRef();

  function openAdd() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setShowModal(true);
  }

  function openEdit(p) {
    setEditingId(p.id);
    setForm({ sku: p.sku, category: p.category || '', rate: p.rate || '' });
    setShowModal(true);
  }

  function saveProduct() {
    if (!form.sku.trim()) { toast('SKU / Product name required', 'error'); return; }
    const data = { sku: form.sku.trim(), category: form.category.trim(), rate: parseFloat(form.rate) || 0 };
    if (editingId) {
      const idx = db.products.findIndex((p) => p.id === editingId);
      if (idx !== -1) db.products[idx] = { ...db.products[idx], ...data };
      toast('Product updated', 'success');
    } else {
      db.products.push({ ...data, stockQuantity: 0, id: genId(), createdAt: new Date().toISOString() });
      toast('Product added', 'success');
    }
    setDb({ ...db });
    setShowModal(false);
  }

  function deleteProduct(id) {
    if (!window.confirm('Delete this product?')) return;
    db.products = db.products.filter((p) => p.id !== id);
    setDb({ ...db });
    toast('Deleted', 'success');
  }

  function importExcel(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb   = XLSX.read(e.target.result, { type: 'array' });
        const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
        let added = 0;
        data.forEach((row) => {
          // Accept SKU or Product Name column
          const sku = String(
            row['SKU'] || row['Product'] || row['Product Name'] ||
            row['Name'] || row['Item'] || ''
          ).trim();
          if (!sku || db.products.find((p) => p.sku === sku)) return;
          const category = String(row['Category'] || row['Product Category'] || '').trim();
          db.products.push({
            id:   genId(),
            sku,
            category,
            stockQuantity: 0,
            rate: parseFloat(row['Purchase Rate'] || row['Rate'] || row['Cost'] || 0),
            createdAt: new Date().toISOString(),
          });
          added++;
        });
        setDb({ ...db });
        toast(`${added} products imported`, 'success');
      } catch (err) { toast('Error: ' + err.message, 'error'); }
    };
    reader.readAsArrayBuffer(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  const q = search.toLowerCase();
  const products = db.products.map(p=>({...p,stockQuantity:stockById.get(p.id)?.stock??0}))
    .filter((p) => (!q || p.sku.toLowerCase().includes(q)))
    .filter(p=>!categoryFilter || (p.category||'Uncategorized')===categoryFilter)
    .filter(p=>!stockFilter || (stockFilter==='zero' ? !(p.stockQuantity>0) : p.stockQuantity>0))
    .filter((p) => (!onlyUnset || !(p.rate > 0)))
    // Products still waiting for a rate float to the top — that is the
    // list you actually have to work through after an import.
    .sort((a, b) => {
      const au = (a.rate > 0) ? 1 : 0, bu = (b.rate > 0) ? 1 : 0;
      if (au !== bu) return au - bu;
      return (a.sku || '').localeCompare(b.sku || '');
    });
  const unsetCount = db.products.filter((p) => !(p.rate > 0)).length;

  return (
    <div>
      <div className="card">
        <div className="flex items-center gap-3 mb-3" style={{ flexWrap: 'wrap' }}>
          <div className="card-title" style={{ margin: 0 }}>Purchase Rates & Common Stock</div>
          <div style={{ flex: 1 }} />
          <button className="btn btn-outline btn-sm" onClick={() => fileInputRef.current?.click()}>
            📤 Import Excel
          </button>
          <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv"
            style={{ display: 'none' }}
            onChange={(e) => importExcel(e.target.files[0])} />
          <button className="btn btn-outline btn-sm" onClick={syncFromOrders}>
            🔄 Pull SKUs from Orders{pendingSkus.length ? ` (${pendingSkus.length} new)` : ''}
          </button>
          <button className="btn btn-primary btn-sm" onClick={openAdd}>+ Add Product</button>
        </div>

        <div className="info-banner">
          SKUs are added here automatically when you upload labels — one row per SKU, however many orders carry it.
          New SKUs start with stock 0. Physical counts reset the stock baseline; exclude uninspected returns from the count. Enter the physical quantity in Stock and press Enter. Stock is shared across all four companies. Type the rate into the table and press Enter. You can change it any time.
          {' '}You can also import an Excel with columns <strong>SKU</strong> · <strong>Category</strong> · <strong>Purchase Rate</strong>.
          <br />
          <strong>Matching is exact.</strong> One letter or space of difference makes it a new SKU with its own rate —
          <code> PUNCH NEEDLE</code>, <code>Punch Needle</code> and <code>Punch Needle 5</code> are three products.
        </div>
        {lookalikes.length > 0 && (
          <div className="info-banner" style={{ background: '#fdf4e3', color: '#6d4a0c', borderColor: '#e8c88a' }}>
            👀 <strong>{lookalikes.length} group(s) of SKUs look the same but are stored separately.</strong>{' '}
            These are kept apart on purpose. If one of them is a typo, delete that row and fix the SKU on the listing.
            <div style={{ marginTop: 6, fontSize: 12 }}>
              {lookalikes.slice(0, 8).map((g, i) => (
                <div key={i}>
                  {g.map((p) => `"${p.sku}" (₹${p.rate || 0})`).join('  ·  ')}
                </div>
              ))}
              {lookalikes.length > 8 && <div>…and {lookalikes.length - 8} more</div>}
            </div>
          </div>
        )}
        {unsetCount > 0 && (
          <div className="info-banner" style={{ background: '#fdf4e3', color: '#6d4a0c', borderColor: '#e8c88a' }}>
            ⚠️ <strong>{unsetCount} SKU(s) have no purchase rate yet.</strong> Orders using them are left out of Profit Analysis until a rate is set.
            <button className="btn btn-ghost btn-xs" style={{ marginLeft: 8 }} onClick={() => {setOnlyUnset((v) => !v); resetSelection();}}>
              {onlyUnset ? 'Show all' : 'Show only these'}
            </button>
          </div>
        )}

        <div className="filter-bar">
          <div className="fg"><label>Search</label>
            <input type="text" placeholder="SKU or product name…" value={search}
              onChange={(e) => {setSearch(e.target.value);resetSelection();}} />
          </div>
        </div>

        <div className="filter-bar">
          <label>Category <select aria-label="Stock category" value={categoryFilter} onChange={e=>{setCategoryFilter(e.target.value);resetSelection()}}><option value="">All categories</option>{[...new Set(db.products.map(p=>p.category||'Uncategorized'))].sort().map(c=><option key={c}>{c}</option>)}</select></label>
          <label>Stock <select aria-label="Stock filter" value={stockFilter} onChange={e=>{setStockFilter(e.target.value);resetSelection()}}><option value="">All stock</option><option value="zero">Zero stock</option><option value="positive">In stock</option></select></label>
          <button className="btn btn-ghost" onClick={()=>{setSelectedStock(new Set(products.map(p=>p.id)));setAllocation(null)}}>Select filtered SKUs ({products.length})</button>
          <button className="btn btn-ghost" onClick={resetSelection}>Clear selection</button>
        </div>
        <div className="info-banner">
          <strong>{selectedStock.size} SKUs selected</strong>. Enter the TOTAL physical quantity to divide across these SKUs. Saving replaces their current counts; it does not add stock or merge SKU identities.
          <div><input aria-label="Total stock to split" type="number" min="0" step="1" value={stockTotal} onChange={e=>{setStockTotal(e.target.value);setAllocation(null)}}/>
          <button className="btn btn-primary" onClick={()=>{try{setAllocation(splitStock(db.products.filter(p=>selectedStock.has(p.id)).map(p=>({...p,stockQuantity:stockById.get(p.id)?.stock??0})),stockTotal))}catch(e){toast(e.message,'error')}}}>Preview equal split</button></div>
          {allocation && <div data-testid="stock-allocation-preview"><p>Total {allocation.reduce((n,p)=>n+p.quantity,0)} units. When the total is not divisible, the first SKUs in name order get one extra unit.</p>
          {allocation.map(p=><div key={p.id}>{p.sku}: {p.oldStock} → {p.quantity}</div>)}
          <button className="btn btn-success" onClick={saveAllocation}>Save stock allocation</button></div>}
          <p>Physical count / allocation only. Automatic dispatch and return stock movements are not enabled in this version.</p>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Select</th><th>SKU / Product Name</th>
                <th>Category</th>
                <th>Purchase Rate (₹)</th>
                <th>Stock (units)</th><th>Last count</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {products.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <div className="empty">
                      <div className="big">🏷️</div>
                      No products. Add manually or import Excel.
                    </div>
                  </td>
                </tr>
              ) : (
                products.map((p) => (
                  <tr key={p.id}>
                    <td><input type="checkbox" aria-label={`Select stock ${p.sku}`} checked={selectedStock.has(p.id)} onChange={e=>{const n=new Set(selectedStock);e.target.checked?n.add(p.id):n.delete(p.id);setSelectedStock(n);setAllocation(null)}}/></td><td className="font-bold">{p.sku}</td>
                    <td>{p.category || <span style={{ color: 'var(--muted,#9ca3af)' }}>Uncategorized</span>}</td>
                    <td>
                      <span style={{ marginRight: 4 }}>₹</span>
                      <input
                        type="number" step="0.01" min="0"
                        value={draftRates[p.id] !== undefined ? draftRates[p.id] : (p.rate || 0)}
                        onChange={(e) => setDraftRates((d) => ({ ...d, [p.id]: e.target.value }))}
                        onBlur={(e) => commitRate(p, e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                        style={{
                          width: 100, padding: '4px 8px', textAlign: 'right',
                          border: (p.rate > 0) ? '1px solid var(--line,#e5e7eb)' : '2px solid #e8b04b',
                          background: (p.rate > 0) ? 'transparent' : '#fffaf0',
                          borderRadius: 4,
                        }}
                        title={(p.rate > 0) ? 'Change the rate and press Enter' : 'Rate not set — type it and press Enter'}
                      />
                    </td>
                    <td><input aria-label={`Stock ${p.sku}`} type="number" min="0" step="1" style={{width:100}} value={stockDraft[p.id]??stockById.get(p.id)?.stock??0} onChange={e=>setStockDraft(d=>({...d,[p.id]:e.target.value}))} onBlur={e=>commitStock(p,e.target.value)} onKeyDown={e=>{if(e.key==='Enter')e.target.blur()}}/></td>
                    <td>{p.stockCountedAt?new Date(p.stockCountedAt).toLocaleString():'Not counted'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-ghost btn-xs" onClick={() => openEdit(p)}>✏️</button>{' '}
                      <button className="btn btn-danger btn-xs" onClick={() => deleteProduct(p.id)}>🗑</button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowModal(false); }}>
          <div className="modal">
            <div className="modal-title">{editingId ? 'Edit Product' : 'Add Product'}</div>
            <div className="form-row">
              <div>
                <label>SKU / Product Name</label>
                <input type="text" placeholder="e.g. 7 Neck Scales" value={form.sku}
                  onChange={(e) => setForm({ ...form, sku: e.target.value })} />
              </div>
              <div>
                <label>Purchase Rate (₹)</label>
                <input type="number" placeholder="0.00" step="0.01" value={form.rate}
                  onChange={(e) => setForm({ ...form, rate: e.target.value })} />
              </div>
            </div>
            <div className="form-row">
              <div>
                <label>Category (optional)</label>
                <input type="text" placeholder="e.g. Aari Hooks, Fabric Stickers" value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setShowModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={saveProduct}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
