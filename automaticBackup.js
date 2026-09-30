import { backupDocument } from './businessLogic.js';
const database = () => new Promise((resolve,reject)=>{const r=indexedDB.open('lavanya-oms-recovery-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('snapshots',{keyPath:'id'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
export async function backupLocal(db,scope,reason='checkpoint'){
 const snapshot=JSON.parse(JSON.stringify(backupDocument(db)));const conn=await database();
 try{await new Promise((resolve,reject)=>{const tx=conn.transaction('snapshots','readwrite');const store=tx.objectStore('snapshots');store.put({id:scope+':'+reason,reason,scope,at:snapshot.createdAt,snapshot});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}finally{conn.close();}
}
export async function listBackups(scope){const conn=await database();try{return await new Promise((resolve,reject)=>{const r=conn.transaction('snapshots').objectStore('snapshots').getAll();r.onsuccess=()=>resolve(r.result.filter(s=>s.scope===scope).sort((a,b)=>b.at.localeCompare(a.at)));r.onerror=()=>reject(r.error);});}finally{conn.close();}}
