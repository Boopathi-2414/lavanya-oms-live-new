export function stockQuantity(value) {
  if (String(value ?? '').trim() === '') throw new Error('Enter a stock quantity');
  const quantity = Number(value);
  if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error('Stock must be a non-negative whole number');
  return quantity;
}

export function splitStock(products, total) {
  const quantity = stockQuantity(total);
  if (!products.length) throw new Error('Select at least one SKU');
  if (new Set(products.map(p => p.id)).size !== products.length || products.some(p => !p.id)) throw new Error('Product IDs must be unique');
  const ordered = [...products].sort((a,b) => a.sku.localeCompare(b.sku));
  const each = Math.floor(quantity / ordered.length), remainder = quantity % ordered.length;
  return ordered.map((p,i) => ({id:p.id,sku:p.sku,oldStock:p.stockQuantity ?? 0,quantity:each+(i<remainder?1:0)}));
}

export function applyStockCounts(products, changes, actor, at=new Date().toISOString()) {
  for (const c of changes) {
    stockQuantity(c.quantity);
    const p=products.find(p=>p.id===c.id);
    if (!p || p.sku !== c.sku || (p.stockQuantity ?? 0) !== c.oldStock) throw new Error('Stock changed after preview. Refresh the preview before saving.');
  }
  const byId=new Map(changes.map(c=>[c.id,c]));
  return products.map(p=>{
    const c=byId.get(p.id);
    if (!c || c.quantity===(p.stockQuantity ?? 0))return p;
    return {...p,stockQuantity:c.quantity,stockCountedAt:at,
      stockHistory:[...(p.stockHistory||[]),{at,actor:actor||'Admin',from:p.stockQuantity??0,to:c.quantity,reason:changes.length>1?'Equal allocation':'Physical stock count'}]};
  });
}
