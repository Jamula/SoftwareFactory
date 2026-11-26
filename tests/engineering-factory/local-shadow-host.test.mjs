import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openEventJournal} from '../../tools/engineering-coordinator/event-journal.mjs';
import {localReconcileTick,runLocalShadowHost} from '../../tools/engineering-factory/local-shadow-host.mjs';
const repo={full_name:'Jamula/SoftwareFactory',id:1471342715};
const head='a'.repeat(40),base='b'.repeat(40);
const pull=(number=1)=>({number,head:{sha:head,repo},base:{sha:base,ref:'main',repo},state:'open',draft:false});
const json=x=>new Response(JSON.stringify(x));
const request=async(url,opts)=>{
 assert.equal(opts.method,'GET');assert.equal(opts.redirect,'error');
 if(url.includes('/issues?'))return json([]);
 if(url.includes('/pulls?'))return json([{number:1}]);
 return json(pull());
};
test('real SQLite journal persists a read-only receipt across process restarts',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'factory-host-')),path=join(dir,'state.db');
 let journal=openEventJournal(path);
 try{
  const tick=()=>localReconcileTick({journal,owner:'local-owner',clock:()=>600000,request});
  assert.equal((await tick()).reason,'SHADOW_RECONCILED');
  journal.close();journal=openEventJournal(path);
  const duplicate=await tick();assert.equal(duplicate.reason,'DUPLICATE_DELIVERY');assert.equal(duplicate.liveDispatch,false);assert.equal(duplicate.liveMerge,false);
 }finally{journal.close();rmSync(dir,{recursive:true,force:true});}
});
test('read failures, missing identity, empty inventory and bad clock are not success',async()=>{
 const journal=openEventJournal(':memory:');
 try{
  const run=(request,clock=()=>600000)=>localReconcileTick({journal,owner:'local-owner',clock,request});
  assert.equal((await run(async()=>{throw Error('offline');})).reason,'LOCAL_POLL_UNAVAILABLE');
  assert.equal((await run(async()=>json([]))).reason,'NO_OPEN_PULLS');
  assert.equal((await run(async(url,opts)=>url.includes('/pulls/')?json({}):request(url,opts))).reason,'IDENTITY_UNKNOWN');
  // First clock read is for recovery; second is for the poll.
  let clocks=0;assert.equal((await run(request,()=>++clocks===1?600000:-1)).reason,'CLOCK_UNKNOWN');
  const many=async()=>json([{number:1},{number:2}]);
  assert.equal((await run(many)).reason,'LOCAL_POLL_UNAVAILABLE');
 }finally{journal.close();}
});
test('recover a durable pending pull claim before polling more work',async()=>{
 const journal=openEventJournal(':memory:');
 try{
  journal.enqueue({repositoryId:repo.id,deliveryId:'prior',kind:'pull',subject:1,head});
  assert.equal((await localReconcileTick({journal,owner:'local-owner',clock:()=>600000,request})).reason,'SHADOW_RECONCILED');
  journal.enqueue({repositoryId:repo.id,deliveryId:'wrong-kind',kind:'manual',subject:0,head});
  assert.equal((await localReconcileTick({journal,owner:'local-owner',clock:()=>600000,request})).reason,'SHADOW_RECONCILED');
  assert.equal(journal.claim(repo.id,'other',600000,30000).kind,'manual');
 }finally{journal.close();}
});
test('host is default-off; opt-in runs serialized ticks with ten-minute delay and stops',async()=>{
 const ctl=new AbortController(),output=[];let waits=0,closed=0;
 const journal=openEventJournal(':memory:');
 const options={enabled:true,path:':memory:',owner:'local-owner',signal:ctl.signal,clock:()=>600000,request,write:x=>output.push(JSON.parse(x)),open:()=>({enqueue:journal.enqueue,claim:journal.claim,complete:journal.complete,close(){closed++;journal.close();}}),wait:async ms=>{assert.equal(ms,600000);waits++;ctl.abort();}};
 assert.equal((await runLocalShadowHost({...options,enabled:false})).reason,'STOPPED');
 assert.equal((await runLocalShadowHost(options)).reason,'STOPPED');assert.equal(waits,1);assert.equal(closed,1);assert.equal(output[0].reason,'SHADOW_RECONCILED');
 const ctl2=new AbortController();const j2=openEventJournal(':memory:');
 assert.equal((await runLocalShadowHost({...options,signal:ctl2.signal,open:()=>j2,write:()=>ctl2.abort()})).reason,'STOPPED');
 assert.equal((await runLocalShadowHost({...options,signal:new AbortController().signal,open:()=>{throw Error('open');}})).reason,'LOCAL_HOST_UNAVAILABLE');
 const ctl3=new AbortController();const j3=openEventJournal(':memory:');
 assert.equal((await runLocalShadowHost({...options,signal:ctl3.signal,open:()=>j3,wait:async()=>{ctl3.abort();throw Error('abort');}})).reason,'STOPPED');
});

test('PR-only cursor advances across pages and reserves identity requests',async()=>{
 const journal=openEventJournal(':memory:'),cursor={page:1};let reads=0;
 const req=async(url)=>{reads++;assert.ok(!url.includes('/issues'));const u=new URL(url);if(u.searchParams.has('page')){assert.equal(u.searchParams.get('per_page'),'1');const n=Number(u.searchParams.get('page'));return json(n<=3?[{number:n}]:[]);}return json(pull(Number(u.pathname.split('/').pop())));};
 try{
  for(let i=1;i<=3;i++){reads=0;assert.equal((await localReconcileTick({journal,owner:'local-owner',clock:()=>600000,request:req,cursor})).reason,'SHADOW_RECONCILED');assert.equal(reads,3);assert.equal(cursor.page,i+1);}
  assert.equal((await localReconcileTick({journal,owner:'local-owner',clock:()=>600000,request:req,cursor})).reason,'SWEEP_COMPLETE');assert.equal(cursor.page,1);
  for(const payload of [{},[{number:0}],[{number:'1'}]])assert.equal((await localReconcileTick({journal,owner:'local-owner',clock:()=>600000,request:async()=>json(payload)})).reason,'LOCAL_POLL_UNAVAILABLE');
  for(const response of [new Response(null,{status:503}),new Response(null),new Response(' '.repeat(524289))])assert.equal((await localReconcileTick({journal,owner:'local-owner',clock:()=>600000,request:async()=>response})).reason,'LOCAL_POLL_UNAVAILABLE');
 }finally{journal.close();}
});
test('abort during inventory or identity prevents subsequent GETs and journal writes',async()=>{
 for(const at of [1,2,3]){
  const ctl=new AbortController(),journal=openEventJournal(':memory:');let reads=0,writes=0,completes=0;
  const wrapped={claim:journal.claim,enqueue(e){writes++;return journal.enqueue(e);},complete(...args){completes++;return journal.complete(...args);}};
  try{
   const result=await localReconcileTick({journal:wrapped,owner:'local-owner',clock:()=>600000,signal:ctl.signal,request:async(url,opts)=>{reads++;if(reads===at){ctl.abort();assert.equal(opts.signal.aborted,true);}return request(url,opts);}});
   assert.equal(result.reason,'STOPPED');assert.equal(reads,at);assert.equal(writes,at===3?1:0);assert.equal(completes,0);
  }finally{journal.close();}
 }
 const ctl=new AbortController();ctl.abort();assert.equal((await localReconcileTick({journal:{},owner:'local-owner',signal:ctl.signal,request:()=>{throw Error('unexpected');}})).reason,'STOPPED');
});

test('unsupported pending events remain unacknowledged without blocking supported recovery',async()=>{
 const j=openEventJournal(':memory:');try{
  j.enqueue({repositoryId:repo.id,deliveryId:'unsupported',kind:'review',subject:1,head});
  j.enqueue({repositoryId:repo.id,deliveryId:'valid',kind:'pull',subject:1,head});
  const opts={journal:j,owner:'worker',clock:()=>600000,request};
  assert.equal((await localReconcileTick(opts)).reason,'SHADOW_RECONCILED');
  assert.equal((await localReconcileTick(opts)).reason,'SHADOW_RECONCILED');
  assert.equal(j.claim(repo.id,'other',600000,30000).deliveryId,'unsupported');
 }finally{j.close();}
});
test('rejected identity advances cursor; pre-aborted host never opens storage',async()=>{
 const j=openEventJournal(':memory:'),cursor={page:1};try{
  const req=async(url)=>{const u=new URL(url);if(u.searchParams.has('page'))return json([{number:Number(u.searchParams.get('page'))}]);return json(u.pathname.endsWith('/1')?{}:pull(2));};
  const opts={journal:j,owner:'worker',clock:()=>600000,request:req,cursor};
  assert.equal((await localReconcileTick(opts)).reason,'IDENTITY_UNKNOWN');assert.equal(cursor.page,2);
  assert.equal((await localReconcileTick(opts)).reason,'SHADOW_RECONCILED');
 }finally{j.close();}
 const ctl=new AbortController();ctl.abort();let opened=0;
 assert.equal((await runLocalShadowHost({enabled:true,signal:ctl.signal,open:()=>{opened++;throw Error('unexpected');}})).reason,'STOPPED');assert.equal(opened,0);
});

test('rejected pending pull is deferred durably while later pulls and inventory progress',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'factory-retry-')),path=join(dir,'retry.db');let j=openEventJournal(path),now=600000;
 try{
  j.enqueue({repositoryId:repo.id,deliveryId:'rejected',kind:'pull',subject:1,head});
  j.enqueue({repositoryId:repo.id,deliveryId:'valid',kind:'pull',subject:2,head});
  const req=async url=>url.includes('/pulls?')?json([{number:2}]):json(url.endsWith('/1')?{}:pull(2));
  const tick=()=>localReconcileTick({journal:j,owner:'worker',clock:()=>now,request:req});
  assert.equal((await tick()).reason,'EVIDENCE_UNKNOWN');
  j.close();j=openEventJournal(path);now+=600000;
  assert.equal((await tick()).reason,'SHADOW_RECONCILED');now+=600000;
  assert.equal((await tick()).reason,'SHADOW_RECONCILED');
  assert.equal(j.claim(repo.id,'other',now,30000),null);
  now=4200000;assert.equal(j.claim(repo.id,'other',now,30000).deliveryId,'rejected');
 }finally{j.close();rmSync(dir,{recursive:true,force:true});}
});
test('invalid owners never open storage or poll',async()=>{
 for(const owner of [undefined,null,'','worker_1','x'.repeat(81),1]){
  const unexpected=()=>{throw Error('unexpected access');};
  assert.equal((await localReconcileTick({owner,journal:{},request:unexpected})).reason,'INVALID_OWNER');
  assert.equal((await runLocalShadowHost({enabled:true,owner,signal:new AbortController().signal,open:unexpected})).reason,'INVALID_OWNER');
 }
});
test('failed deferral is not acknowledgement',async()=>{
 const j=openEventJournal(':memory:');try{
  j.enqueue({repositoryId:repo.id,deliveryId:'bad',kind:'pull',subject:1,head});
  const wrapper={claim:j.claim,complete:j.complete,defer:()=>false};
  assert.equal((await localReconcileTick({journal:wrapper,owner:'worker',clock:()=>600000,request:async()=>json({})})).reason,'RECONCILIATION_UNAVAILABLE');
  assert.equal(j.claim(repo.id,'other',630000,30000).deliveryId,'bad');
 }finally{j.close();}
});

test('six permanent rejections cannot starve a valid queued pull or inventory across restarts',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'factory-fair-')),path=join(dir,'state.db');let j=openEventJournal(path),now=600000,validReads=0,inventoryReads=0,inventoryIdentity=0;
 try{
  for(let n=1;n<=7;n++)assert.equal(j.enqueue({repositoryId:repo.id,deliveryId:'pending-'+n,kind:'pull',subject:n,head}).queued,true);
  const req=async url=>{const u=new URL(url);if(u.searchParams.has('page')){inventoryReads++;return json([{number:8}]);}const n=Number(u.pathname.split('/').pop());if(n===7)validReads++;if(n===8)inventoryIdentity++;return json(n>=7?pull(n):{});};
  for(let i=0;i<24;i++){
   let calls=0;const result=await localReconcileTick({journal:j,owner:'worker',clock:()=>now,request:async(...args)=>{calls++;return req(...args);}});
   assert.ok(calls<=3);assert.equal(result.liveMerge,false);assert.equal(result.liveDispatch,false);
   if(i===0)assert.equal(result.inventoryReason,'QUEUED');
   j.close();j=openEventJournal(path);now+=600000;
  }
  assert.equal(validReads,1);assert.equal(inventoryReads,24);assert.ok(inventoryIdentity>=25);
 }finally{j.close();rmSync(dir,{recursive:true,force:true});}
});
