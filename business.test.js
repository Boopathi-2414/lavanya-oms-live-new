import test from 'node:test';
import assert from 'node:assert/strict';
import {stockRows,dispatchedOn,pickupStatus,backupDocument,validateBackup,mergeBackup,exportRows,claimBalance,number,day} from '../src/businessLogic.js';
import {buildProfitRows,normalizeReturnReason} from '../src/db.js';
const seed=()=>({orders:[],payments:[],products:[{id:'p',sku:'SKU',stockQuantity:0,rate:100}],businessRecords:[],trash:[],fraudList:[]});
test('dispatch history survives returns, with India date boundary',()=>{for(const status of ['Dispatched','Return Received','In Transit (Return)'])assert.equal(dispatchedOn({status,dispatchedAt:'2026-09-26T20:00:00Z'},'2026-09-27'),true);assert.equal(dispatchedOn({deleted:true,dispatchedAt:'2026-09-26T20:00:00Z'},'2026-09-27'),false);assert.equal(pickupStatus({status:'In Transit (Return)'}),'In Transit');assert.equal(day('2026-09-26T20:00:00Z'),'2026-09-27');});
test('shared stock counts once across companies; history before opening excluded; QC controls restock',()=>{const d=seed();d.businessRecords=[{id:'start',kind:'stockOpening',productId:'p',quantity:10,at:'2026-09-27T00:00:00Z'},{id:'buy',kind:'purchase',productId:'p',quantity:4,at:'2026-09-27T01:00:00Z'},{id:'qc',kind:'returnQC',productId:'p',good:1,damaged:1,at:'2026-09-27T03:00:00Z'}];d.orders=[{id:'old',sku:'SKU',quantity:90,dispatchedAt:'2026-09-26T00:00:00Z'},{id:'a',company:'A',sku:'SKU',quantity:2,status:'Return Received',dispatchedAt:'2026-09-27T02:00:00Z'},{id:'b',company:'B',sku:'SKU',quantity:3,status:'Dispatched',dispatchedAt:'2026-09-27T02:00:00Z'},{id:'c',sku:'SKU',quantity:2,status:'Ready to Ship'}];const r=stockRows(d,new Date('2026-09-28'))[0];assert.equal(r.stock,10);assert.equal(r.damaged,1);assert.equal(r.available,8);assert.equal(stockRows(d)[0].stock,10);});
test('recount replaces prior baseline without replaying old purchases',()=>{const d=seed();d.businessRecords=[{id:'old',kind:'stockOpening',productId:'p',quantity:10,at:'2026-09-26T00:00:00Z'},{id:'buy',kind:'purchase',productId:'p',quantity:50,at:'2026-09-26T01:00:00Z'},{id:'new',kind:'stockOpening',productId:'p',quantity:7,at:'2026-09-27T00:00:00Z'}];assert.equal(stockRows(d)[0].stock,7);});
test('untracked new SKU starts at zero; pending reserve shows deficit',()=>{const d=seed();d.orders=[{sku:'SKU',quantity:2,status:'Ready to Ship'}];const r=stockRows(d)[0];assert.equal(r.stock,0);assert.equal(r.tracked,false);assert.equal(r.available,-2);});
test('full JSON backup preserves nested transactions; recovery keeps existing records',()=>{const d=seed();d.payments=[{id:'pay',transactions:[{amount:400}],orderId:'00000001234567890123'}];const doc=JSON.parse(JSON.stringify(backupDocument(d)));const restored=validateBackup(doc);assert.deepEqual(restored.payments,d.payments);const current=seed();current.payments=[{id:'pay',settlement:12}];assert.equal(mergeBackup(current,restored).payments[0].settlement,12);assert.throws(()=>validateBackup({format:'bad'}));doc.data.products.push(doc.data.products[0]);assert.throws(()=>validateBackup(doc));});
test('Excel reporting serialises nested audit arrays instead of blank cells',()=>{assert.equal(exportRows([{id:'x',altAwbs:['0012'],manualLossHistory:[{to:100}]}])[0].altAwbs,'["0012"]');});
test('claim accounting and loss avoid double purchase loss',()=>{for(const [settlement,loss,expected] of [[-165,100,-265],[-115,0,-115],[235,100,135]]){const d=seed();d.orders=[{id:'o',orderId:'O',sku:'SKU',status:'Return Received',manualLoss:loss}];d.payments=[{orderId:'O',settlement,netAmount:settlement}];assert.equal(buildProfitRows(d.orders,d.payments,d.products)[0].profit,expected);}assert.equal(claimBalance({requested:400,received:50}),350);});
test('negative fractional stock and invalid amounts rejected',()=>{assert.throws(()=>number(-1,'Stock',{integer:true}));assert.throws(()=>number(1.5,'Stock',{integer:true}));assert.throws(()=>number('','Amount'));assert.throws(()=>number('NaN','Amount'));});
test('damage distinct from quality for new imports',()=>{assert.equal(normalizeReturnReason('Damaged Product'),'Damage');assert.equal(normalizeReturnReason('Quality problem'),'Quality Issue');});

test('order-linked expense is deducted once; general company expense stays separate',()=>{const d=seed();d.orders=[{id:'o',orderId:'O',sku:'SKU',quantity:1,status:'Dispatched'}];d.payments=[{orderId:'O',settlement:250,gstAmount:20,netAmount:230}];const businessRecords=[{kind:'expense',orderId:'O',amount:10},{kind:'expense',company:'Company-wide',amount:30}];const row=buildProfitRows(d.orders,d.payments,d.products,{businessRecords})[0];assert.equal(row.orderExpense,10);assert.equal(row.profit,120);assert.equal(row.profit-30,90);});

test('claim calendar splits four companies and dates; closed claims excluded',async()=>{
 const {claimSchedule}=await import('../src/businessLogic.js');const d=seed();
 d.orders=['A','B','C','D'].map((company,i)=>({id:String(i),orderId:'O'+i,company}));
 d.businessRecords=d.orders.map((o,i)=>({id:'c'+i,kind:'claim',orderId:o.orderId,deadline:i===0?'2026-09-26':'2026-09-28',status:i===1?'Submitted':'To submit',requested:400,received:50}));
 d.businessRecords.push({id:'done',kind:'claim',orderId:'O0',deadline:'2026-09-26',status:'Closed',requested:400,received:0});
 const all=claimSchedule(d,{asOf:'2026-09-27'});assert.equal(all.groups.length,4);assert.equal(all.groups[0].overdue,true);assert.equal(all.groups.reduce((a,g)=>a+g.toSubmit,0),3);assert.equal(all.groups.reduce((a,g)=>a+g.followUp,0),1);
 const filtered=claimSchedule(d,{company:'B',date:'2026-09-28'});assert.equal(filtered.groups.length,1);assert.equal(filtered.groups[0].remaining,350);assert.equal(filtered.groups[0].followUp,1);
});

test('claim reminders use separate follow-up date, preserve submission deadline and ignore resolved claims',async()=>{
 const {claimReminders,claimSchedule}=await import('../src/businessLogic.js');const d=seed();
 d.orders=[{orderId:'O',company:'A'}];
 d.businessRecords=[
 {id:'a',kind:'claim',orderId:'O',status:'Submitted',deadline:'2026-09-20',followUpDate:'2026-10-01',requested:400,received:50},
 {id:'b',kind:'claim',orderId:'O',status:'To submit',deadline:'2026-09-28',requested:100,received:0},
 {id:'c',kind:'claim',orderId:'O',status:'Paid',deadline:'2026-09-27',requested:100,received:100},
 {id:'d',kind:'claim',orderId:'O',status:'Under review',deadline:'2026-09-26',requested:200,received:0}];
 const r=claimReminders(d,'2026-09-28');assert.equal(r.due.length,2);assert.equal(r.upcoming.length,1);assert.equal(r.unscheduled.length,1);
 const s=claimSchedule(d,{date:'2026-10-01'});assert.equal(s.claims.length,1);assert.equal(s.claims[0].deadline,'2026-09-20');assert.equal(s.groups[0].remaining,350);
});
