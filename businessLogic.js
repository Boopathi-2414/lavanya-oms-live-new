export const COLLECTIONS = ['orders','payments','products','trash','fraudList','businessRecords'];
export const RETURN_TRANSIT = ['In Transit','In-Transit','In Transit (Return)','Return In-Transit'];
export const RETURN_RECEIVED = ['Return Received','RTO Received'];
export const money = n => Math.round((Number(n)||0)*100)/100;
export const day = (v=new Date()) => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(v));
export function pickupStatus(o) {
 if(RETURN_TRANSIT.includes(o.status))return 'In Transit';
 if(RETURN_RECEIVED.includes(o.status))return 'Return Received';
 if(['Ready to Ship','Pending',''].includes(o.status||''))return 'Pending';
 return o.status;
}
export function dispatchedOn(o,date) { return !o.deleted && !!o.dispatchedAt && day(o.dispatchedAt)===date; }
export function records(db,kind){return (db.businessRecords||[]).filter(r=>r.kind===kind&&!r.voided);}
export function number(value,label,{integer=false,min=0}={}){
 if(value===''||value==null||!Number.isFinite(Number(value))||Number(value)<min||(integer&&!Number.isSafeInteger(Number(value))))throw Error(`${label}: enter a valid ${integer?'whole ':''}number, minimum ${min}`);
 return Number(value);
}
export function stockRows(db,now=new Date()) {
 const events=(db.businessRecords||[]).filter(r=>!r.voided), orders=(db.orders||[]).filter(o=>!o.deleted);
 return (db.products||[]).map(p=>{
  const opening=events.filter(r=>r.kind==='stockOpening'&&r.productId===p.id).sort((a,b)=>b.at.localeCompare(a.at))[0];
  const settings=events.find(r=>r.id===`stock-settings:${p.id}`)||{};
  const since=opening?.at;
  const after=t=>since&&t&&new Date(t)>new Date(since);
  const matching=orders.filter(o=>(o.sku||'').trim()===(p.sku||'').trim());
  const purchases=events.filter(r=>r.kind==='purchase'&&r.productId===p.id&&after(r.at));
  const inspections=events.filter(r=>r.kind==='returnQC'&&r.productId===p.id&&after(r.at));
  const shipped=matching.filter(o=>after(o.dispatchedAt)).reduce((a,o)=>a+(Number(o.quantity)||1),0);
  const good=inspections.reduce((a,r)=>a+r.good,0), damaged=inspections.reduce((a,r)=>a+r.damaged,0);
  const recent=matching.filter(o=>o.dispatchedAt&&(now-new Date(o.dispatchedAt))/86400000<=30&&(now-new Date(o.dispatchedAt))>=0).reduce((a,o)=>a+(Number(o.quantity)||1),0);
  const reserved=matching.filter(o=>pickupStatus(o)==='Pending'&&!o.dispatchedAt).reduce((a,o)=>a+(Number(o.quantity)||1),0);
  const stock=opening?opening.quantity+purchases.reduce((a,r)=>a+r.quantity,0)-shipped+good:Number(p.stockQuantity)||0;
  const reorder=Math.ceil(recent/30*(Number(settings.leadDays)||7))+(Number(settings.safety)||0);
  const last=matching.map(o=>o.dispatchedAt).filter(Boolean).sort().at(-1);
  return {...p,tracked:!!opening,openingAt:since,stock,damaged,reserved,available:stock-reserved,recent,reorder,buy:Math.max(0,reorder-(stock-reserved)),lastDispatch:last,slow:stock>0&&(!last||(now-new Date(last))/86400000>=60),...{supplier:settings.supplier||'',leadDays:settings.leadDays||7,safety:settings.safety||0}};
 });
}
export function claimBalance(r){return money(Math.max(0,Number(r.requested)-Number(r.received||0)));}
export function validateBackup(raw){
 if(raw?.format!=='LavanyaOMS'||raw.version!==1||!raw.data)throw Error('Choose a Lavanya OMS JSON backup');
 const result={};
 for(const key of COLLECTIONS){
  const arr=raw.data[key]||[];if(!Array.isArray(arr))throw Error(`Invalid ${key}`);
  const ids=new Set();for(const r of arr){if(!r||typeof r.id!=='string'||!r.id||ids.has(r.id))throw Error(`Missing / duplicate ID in ${key}`);ids.add(r.id);}
  result[key]=arr;
 }
 return result;
}
export function mergeBackup(current,incoming){
 // Recovery adds missing records only. Existing cloud records are never overwritten.
 return Object.fromEntries(COLLECTIONS.map(k=>{const ids=new Set((current[k]||[]).map(r=>r.id));return [k,[...(current[k]||[]),...(incoming[k]||[]).filter(r=>!ids.has(r.id))]];}));
}
export function backupDocument(db){return {format:'LavanyaOMS',version:1,createdAt:new Date().toISOString(),data:Object.fromEntries(COLLECTIONS.map(k=>[k,db[k]||[]]))};}
export function exportRows(rows){return rows.map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,v&&typeof v==='object'?(JSON.stringify(v).length>32000?'[Too large for Excel; use full JSON backup]':JSON.stringify(v)):v])));}

export function claimSchedule(db,{company='',date='',asOf=day()}={}) {
 const orders=new Map((db.orders||[]).filter(o=>!o.deleted).map(o=>[o.orderId,o]));
 const claims=records(db,'claim').map(c=>({...c,company:orders.get(c.orderId)?.company||c.company||'Unknown company',remaining:claimBalance(c),actionDate:c.status==='To submit'?c.deadline:(c.followUpDate||c.deadline),needsFollowUpDate:c.status!=='To submit'&&!c.followUpDate}));
 const filtered=claims.filter(c=>(!company||c.company===company)&&(!date||c.actionDate===date));
 const groups=new Map();
 for(const c of filtered){
  if(['Paid','Rejected','Closed'].includes(c.status)||c.remaining<=0)continue;
  const key=JSON.stringify([c.company,c.actionDate]);
  if(!groups.has(key))groups.set(key,{company:c.company,date:c.actionDate||'',count:0,toSubmit:0,followUp:0,requested:0,remaining:0,overdue:!!c.actionDate&&c.actionDate<asOf});
  const g=groups.get(key);g.count++;g[c.status==='To submit'?'toSubmit':'followUp']++;g.requested=money(g.requested+Number(c.requested||0));g.remaining=money(g.remaining+c.remaining);
 }
 return {claims:filtered,groups:[...groups.values()].sort((a,b)=>a.date.localeCompare(b.date)||a.company.localeCompare(b.company))};
}

export function claimReminders(db,asOf=day()) {
 const pending=claimSchedule(db,{asOf}).claims.filter(c=>!['Paid','Rejected','Closed'].includes(c.status)&&c.remaining>0);
 const end=new Date(asOf+'T00:00:00Z');end.setUTCDate(end.getUTCDate()+3);const upcomingEnd=end.toISOString().slice(0,10);
 return {pending, due:pending.filter(c=>c.actionDate&&c.actionDate<=asOf), upcoming:pending.filter(c=>c.actionDate>asOf&&c.actionDate<=upcomingEnd), unscheduled:pending.filter(c=>!c.actionDate||c.needsFollowUpDate)};
}
