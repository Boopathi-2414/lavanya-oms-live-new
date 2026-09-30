import { CACHE_PREFIX } from './environment.js';
const PREFIX=CACHE_PREFIX + 'dispatch_pending:';
export function journalDispatch(order) {
  localStorage.setItem(PREFIX+order.id,JSON.stringify(order));
}
export function recoverDispatches(db) {
  const orders=new Map((db.orders || []).map(o=>[o.id,o]));
  for(let i=0;i<localStorage.length;i++) {
    const key=localStorage.key(i);
    if(!key?.startsWith(PREFIX))continue;
    try {const o=JSON.parse(localStorage.getItem(key));if(o?.id)orders.set(o.id,o);}catch (_) {}
  }
  return {...db,orders:[...orders.values()]};
}
export function clearPersistedDispatches(db) {
  for(const order of db.orders || []) {
    const key=PREFIX+order.id, pending=localStorage.getItem(key);
    if(pending && pending===JSON.stringify(order))localStorage.removeItem(key);
  }
}
