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
  const many=async(url)=>json(Array.from({length:100},(_,i)=>({number:(Number(new URL(url).searchParams.get('page'))-1)*100+i+1})));
  assert.equal((await run(many)).reason,'LOCAL_POLL_UNAVAILABLE');
 }finally{journal.close();}
});
test('recover a durable pending pull claim before polling more work',async()=>{
 const journal=openEventJournal(':memory:');
 try{
  journal.enqueue({repositoryId:repo.id,deliveryId:'prior',kind:'pull',subject:1,head});
  assert.equal((await localReconcileTick({journal,owner:'local-owner',clock:()=>600000,request})).reason,'SHADOW_RECONCILED');
  journal.enqueue({repositoryId:repo.id,deliveryId:'wrong-kind',kind:'manual',subject:0,head});
  assert.equal((await localReconcileTick({journal,owner:'local-owner',clock:()=>600000,request})).reason,'EVIDENCE_UNKNOWN');
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
