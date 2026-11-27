import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  EXECUTION_RECEIPT_SCHEMA_VERSION,
  localEndpoint,
  localOtlpConfiguration,
  createSignals,
  telemetrySummary,
  createExecutionReceipt,
  receiptStageRows
} from '../../tools/engineering-factory/telemetry.mjs';
import {aggregateStage} from '../../tools/engineering-factory/stage-aggregate.mjs';
import {planLanes} from '../../tools/engineering-coordinator/planner.mjs';
import {reconcileJournalOnce} from '../../tools/engineering-coordinator/event-journal.mjs';
import {guardedSquashEvidence} from '../../tools/engineering-factory/protected-squash.mjs';
test('local endpoint allowlist',()=>{
 assert.equal(localEndpoint('http://127.0.0.1:4318'),'http://127.0.0.1:4318');
 assert.equal(localEndpoint('https://[::1]:4318'),'https://[::1]:4318');
 for(const value of [null,'no url','ftp://127.0.0.1:4318','http://localhost:4318','https://external.example:4318','http://127.0.0.1','http://user@127.0.0.1:4318','http://user:pw@127.0.0.1:4318','http://127.0.0.1:4318/?x=1','http://127.0.0.1:4318/#x','http://127.0.0.1:4318/api']) assert.equal(localEndpoint(value),null);
});
test('bounded stage metrics and sanitized span',async()=>{
 const data=[];let tick=0;
 const run=createSignals({clock:()=>tick++,meter:{createCounter:()=>({add:(...x)=>data.push(x)}),createHistogram:()=>({record:(...x)=>data.push(x)})},tracer:{startSpan:n=>({setAttributes:a=>data.push([n,a]),end:()=>data.push('end')})}});
 const r=await run('evaluate',async()=>({outcome:'eligible',reason:'NONE',secret:'never log'}));
 assert.equal(r.secret,'never log');assert.equal(JSON.stringify(data).includes('never log'),false);
 assert.deepEqual(data[0],[1,{stage:'evaluate',outcome:'eligible',reason:'NONE'}]);
 await run('queue',async()=>({outcome:'private string',reason:'private string'}));
 assert.equal(data[4][1].outcome,'unknown');assert.equal(data[4][1].reason,'OTHER');
 await assert.rejects(()=>run('unknown',async()=>{}),/UNKNOWN_STAGE/);
 await assert.rejects(()=>run('review',async()=>{throw Error('private error');}),/private error/);
 assert.equal(data.at(-4)[1].outcome,'failed');assert.equal(JSON.stringify(data).includes('private error'),false);
});
test('telemetry exporter/instrument failures cannot change work outcome',async()=>{
 const fail=()=>{throw Error('diagnostic failure')};
 const run=createSignals({clock:()=>0,meter:{createCounter:()=>({add:fail}),createHistogram:()=>({record:fail})},tracer:{startSpan:fail}});
 assert.equal((await run('reconcile',async()=>({outcome:'blocked',reason:'POLICY'}))).outcome,'blocked');
 const run2=createSignals({clock:(()=>{let i=1;return()=>--i})(),meter:{createCounter:()=>({add:()=>{}}),createHistogram:()=>({record:()=>assert.fail()})},tracer:{startSpan:()=>({setAttributes:fail,end:fail})}});
 assert.equal((await run2('verify-main',async()=>({outcome:'unknown'}))).outcome,'unknown');
});

test('instrument creation failures independently fall back to no-op',async()=>{
 const fail=()=>{throw Error('instrument initialization failed')};
 const events=[];
 for(const meter of [
   {createCounter:fail,createHistogram:()=>({record:(...x)=>events.push(x)})},
   {createCounter:()=>({add:(...x)=>events.push(x)}),createHistogram:fail},
   {createCounter:fail,createHistogram:fail}
 ]){
   const run=createSignals({clock:()=>0,meter,tracer:{startSpan:fail}});
   const value={outcome:'eligible',reason:'NONE'};
   assert.equal(await run('evaluate',async()=>value),value);
   await assert.rejects(()=>run('review',async()=>{throw Error('work failed')}),/work failed/);
 }
 assert.equal(events.length,4);
});

test('active context and provider failure never repeat work',async()=>{
 const meter={createCounter:()=>({add(){}}),createHistogram:()=>({record(){}})};
 const spans=[];let active=null,calls=0;
 const tracer={startActiveSpan(name,fn){
  const parent=active;const span={name,parent,setAttributes(){},setStatus(s){this.status=s;},end(){this.ended=true;}};
  spans.push(span);active=span;
  const result=fn(span);active=parent;return result;
 }};
 const run=createSignals({meter,tracer});
 await run('reconcile',async()=>run('evaluate',async()=>({outcome:'failed'})));
 assert.equal(spans[1].parent,spans[0]);assert.deepEqual(spans[1].status,{code:2});assert.ok(spans.every(s=>s.ended));
 const error=Error('original');
 const failAfter={startActiveSpan(name,fn){fn({end(){}});throw Error('provider');}};
 const observe=createSignals({meter,tracer:failAfter});
 assert.equal(await observe('queue',async()=>{calls++;return 42;}),42);
 await assert.rejects(()=>observe('queue',async()=>{calls++;throw error;}),e=>e===error);
 assert.equal(calls,2);
 const failBefore=createSignals({meter,tracer:{startActiveSpan(){throw Error('provider');}}});
 assert.equal(await failBefore('queue',async()=>{calls++;return 7;}),7);assert.equal(calls,3);
});
test('clock failure cannot mask work result or prevent span cleanup',async()=>{
 const error=Error('work error');let ends=0,records=0,counts=0;
 for(const failAt of [1,2]){
  let i=0;
  const run=createSignals({clock:()=>{if(++i===failAt)throw Error('clock');return i;},
   meter:{createCounter:()=>({add(){counts++;}}),createHistogram:()=>({record(){records++;}})},
   tracer:{startSpan:()=>({end(){ends++;},setStatus(){throw Error('status');}})}});
  await assert.rejects(()=>run('review',async()=>{throw error;}),e=>e===error);
 }
 assert.equal(ends,2);assert.equal(counts,2);assert.equal(records,0);
});


test('explicit authenticated local OTLP configuration only',()=>{
 const origin='https://127.0.0.1:4317',header='x-otlp-api-key=synthetic%2Bkey%3D';
 assert.deepEqual(localOtlpConfiguration(origin,'grpc',header),{endpoint:origin,protocol:'grpc',headers:{'x-otlp-api-key':'synthetic+key='}});
 assert.equal(localOtlpConfiguration('http://[::1]:4318','http/protobuf',header).protocol,'http/protobuf');
 for(const [url,protocol,value] of [
  ['https://external.example:4317','grpc',header],[origin,'http/json',header],[origin,'grpc',null],
  [origin,'grpc','x'.repeat(2049)],[origin,'grpc','authorization=abc'],[origin,'grpc','x-otlp-api-key='],
  [origin,'grpc','x-otlp-api-key=abc,authorization=def'],[origin,'grpc','x-otlp-api-key=%ZZ'],
  [origin,'grpc','x-otlp-api-key=abc%0Adef'],[origin,'grpc','x-otlp-api-key=abc def'],
  [origin,'grpc','x-otlp-api-key='+ 'x'.repeat(1025)]
 ])assert.equal(localOtlpConfiguration(url,protocol,value),null);
});
test('structured diagnostic log is emitted within active span without private data',async()=>{
 let active=false;const records=[];
 const meter={createCounter:()=>({add(){}}),createHistogram:()=>({record(){}})};
 const tracer={async startActiveSpan(name,fn){
  active=true;
  try{return await fn({end(){records.push('ended');}});}finally{active=false;}
 }};
 const logger={emit(entry){assert.equal(active,true);records.push(entry);}};
 const observe=createSignals({meter,tracer,logger});
 const value={outcome:'blocked',reason:'POLICY',private:'do not export'};
 assert.equal(await observe('evaluate',async()=>value),value);
 assert.deepEqual(records,[{body:'factory.stage.completed',attributes:{stage:'evaluate',outcome:'blocked',reason:'POLICY'}},'ended']);
 const broken=createSignals({meter,tracer,logger:{emit(){throw Error('logger failure');}}});
 assert.equal(await broken('queue',async()=>42),42);
 const original=Error('private work failure');
 await assert.rejects(()=>broken('queue',async()=>{throw original;}),e=>e===original);
});


test('unactivated or unavailable stage spans never emit falsely correlated logs',async()=>{
 const records=[];let ended=0;
 const meter={createCounter:()=>({add(){}}),createHistogram:()=>({record(){}})};
 const logger={emit(entry){records.push(entry);}};
 const fallback=createSignals({meter,logger,tracer:{startSpan(){return {end(){ended++;}};}}});
 assert.equal(await fallback('queue',async()=>42),42);assert.equal(ended,1);
 const unavailable=createSignals({meter,logger,tracer:{startActiveSpan(){throw Error('unavailable');}}});
 assert.equal(await unavailable('review',async()=>7),7);
 assert.deepEqual(records,[]);
});

test('telemetrySummary classifies coordinator, event-journal and protected-merge outcomes without collapsing denials',async()=>{
 const expected=[
  // Coordinator outcomes
  [{lane:'core',state:'blocked',reason:'LEASE_HELD'},{outcome:'blocked',reason:'LEASE'}],
  [{lane:'core',taskId:1,state:'blocked',reason:'LEASE_LOST'},{outcome:'blocked',reason:'LEASE'}],
  [{lane:'core',taskId:1,state:'blocked',reason:'LEASE_UNAVAILABLE'},{outcome:'failed',reason:'LEASE'}],
  [{lane:'core',taskId:1,state:'blocked',reason:'CLOCK_UNAVAILABLE'},{outcome:'failed',reason:'RUNTIME'}],
  [{shadow:true,completed:[],reason:'ACTIVE_PATH_CONFLICT'},{outcome:'blocked',reason:'POLICY'}],
  [{shadow:true,completed:[],reason:'DEPENDENCY_UNKNOWN'},{outcome:'blocked',reason:'DEPENDENCY'}],
  [planLanes(null,[]),{outcome:'blocked',reason:'POLICY'}],
  [{lane:'core',state:'blocked',reason:'TASK_READ_FAILED'},{outcome:'failed',reason:'RUNTIME'}],
  [{lane:'core',taskId:1,state:'blocked',reason:'TASK_STATE_CHANGED'},{outcome:'blocked',reason:'STALE'}],
  [{lane:'core',state:'blocked',reason:'AGENT_REVIEW_FAILED'},{outcome:'failed',reason:'REVIEW'}],
  // Event-journal outcomes
  [await reconcileJournalOnce({
    stop:false,clock:()=>100,read:async()=>null,
    journal:{claim:()=>null,complete:()=>false}
  }),{outcome:'unknown',reason:'NONE'}],
  [{shadow:true,liveDispatch:false,liveMerge:false,reason:'SHADOW_RECONCILED'},{outcome:'eligible',reason:'NONE'}],
  [{shadow:true,liveDispatch:false,liveMerge:false,reason:'SHADOW_HEAD_SUPERSEDED'},{outcome:'blocked',reason:'STALE'}],
  [{shadow:true,liveDispatch:false,liveMerge:false,reason:'EVIDENCE_UNKNOWN'},{outcome:'blocked',reason:'INVALID_EVIDENCE'}],
  [{shadow:true,liveDispatch:false,liveMerge:false,reason:'CLAIM_LOST'},{outcome:'blocked',reason:'LEASE'}],
  // Protected-merge outcomes
  [{shadow:true,liveMerge:false,dependentWorkAllowed:false,reason:'SHADOW_SQUASH_ELIGIBLE'},{outcome:'eligible',reason:'NONE'}],
  [{shadow:true,liveMerge:false,dependentWorkAllowed:true,reason:'SHADOW_MAIN_VERIFIED'},{outcome:'eligible',reason:'NONE'}],
  [{shadow:true,liveMerge:false,dependentWorkAllowed:false,reason:'PROTECTIONS_UNVERIFIED'},{outcome:'blocked',reason:'SECURITY'}],
  [{shadow:true,liveMerge:false,dependentWorkAllowed:false,reason:'REVIEW_UNVERIFIED'},{outcome:'blocked',reason:'REVIEW'}],
  [{shadow:true,liveMerge:false,dependentWorkAllowed:false,reason:'COVERAGE_UNVERIFIED'},{outcome:'blocked',reason:'COVERAGE'}],
  [{shadow:true,liveMerge:false,dependentWorkAllowed:false,reason:'CHECKS_INCOMPLETE'},{outcome:'blocked',reason:'CHECKS'}],
  [{state:'blocked',reason:'STALE_HEAD_OR_BASE',shadow:true},{outcome:'blocked',reason:'STALE'}],
  [guardedSquashEvidence(null,null),{outcome:'blocked',reason:'INVALID_EVIDENCE'}]
 ];
 const recorded=[];
 const observe=createSignals({
  clock:()=>5,
  meter:{createCounter:()=>({add:(_v,attrs)=>recorded.push(attrs)}),createHistogram:()=>({record(){}})},
  tracer:{startSpan:()=>({setAttributes(){},end(){}})}
 });
 for(const [sample,summary] of expected){
  const actual=telemetrySummary(sample);
  assert.deepEqual(actual,summary);
  assert.notEqual(actual.reason,'OTHER');
  await observe('evaluate',async()=>actual);
  assert.deepEqual(recorded.at(-1),{stage:'evaluate',...summary});
 }

 // Aggregate coordinator tick & planner scheduled variants
 assert.deepEqual(telemetrySummary(null),{outcome:'unknown',reason:'NONE'});
 assert.deepEqual(telemetrySummary(new Proxy({},{get(){assert.fail('proxy read');}})),{outcome:'unknown',reason:'OTHER'});
 assert.deepEqual(telemetrySummary({lane:'core',taskId:1,state:'shadow-reviewed'}),{outcome:'eligible',reason:'NONE'});
 assert.deepEqual(telemetrySummary({state:'blocked'}),{outcome:'blocked',reason:'NONE'});
 assert.deepEqual(telemetrySummary({shadow:true,scheduled:[{id:1,lane:'core',paths:['src']}],reason:'SHADOW_PLAN'}),
  {outcome:'eligible',reason:'NONE'});
 assert.deepEqual(telemetrySummary({shadow:true,scheduled:[],reason:'SHADOW_PLAN'}),
  {outcome:'unknown',reason:'NONE'});
 assert.deepEqual(telemetrySummary({shadow:true,completed:[],reason:'SHADOW_TICK_COMPLETE'}),
  {outcome:'unknown',reason:'NONE'});
 assert.deepEqual(telemetrySummary({
  shadow:true,completed:[{lane:'core',taskId:1,state:'shadow-reviewed'}],reason:'SHADOW_TICK_COMPLETE'
 }),{outcome:'eligible',reason:'NONE'});
 assert.deepEqual(telemetrySummary({
  shadow:true,
  completed:[{lane:'a',taskId:1,state:'shadow-reviewed'},{lane:'b',state:'blocked',reason:'LEASE_HELD'}],
  reason:'SHADOW_TICK_COMPLETE'
 }),{outcome:'blocked',reason:'LEASE'});
 assert.deepEqual(telemetrySummary({
  shadow:true,
  completed:[{lane:'a',state:'blocked',reason:'LEASE_HELD'},{lane:'b',state:'blocked',reason:'TASK_READ_FAILED'}],
  reason:'SHADOW_TICK_COMPLETE'
 }),{outcome:'failed',reason:'RUNTIME'});
 assert.deepEqual(telemetrySummary({shadow:true,reason:'unmapped private text'}),{outcome:'unknown',reason:'OTHER'});
 assert.deepEqual(telemetrySummary({state:'blocked',reason:'unmapped private text'}),{outcome:'blocked',reason:'OTHER'});
});

test('createExecutionReceipt enforces versioned laptop-free schema, unknown vs verified $0, and zero secret leakage',()=>{
 const base={
  source:'github-hosted',
  repositoryId:1471342715,
  receiptId:'gh-987654-1-reconcile',
  observedMs:1764200000000,
  stage:'reconcile',
  durationMs:42,
  result:{
   shadow:true,reason:'LEASE_HELD',state:'blocked',
   prompt:'raw prompt must never appear',
   token:'ghp_secretTokenValue123',
   actor:'cyrusjamula'
  }
 };
 const defaultUnknown=createExecutionReceipt(base);
 assert.deepEqual(defaultUnknown,{
  schemaVersion:EXECUTION_RECEIPT_SCHEMA_VERSION,
  valid:true,
  shadow:true,
  liveDispatch:false,
  liveMerge:false,
  source:'github-hosted',
  repositoryId:1471342715,
  receiptId:'gh-987654-1-reconcile',
  observedMs:1764200000000,
  stage:'reconcile',
  outcome:'blocked',
  reason:'LEASE',
  durationMs:42,
  stages:{reconcile:42},
  quota:{state:'unknown',verified:false,includedOnly:null},
  cost:{state:'unknown',verified:false,currency:null,amountMicros:null},
  humanTouches:{state:'unknown',verified:false,count:null},
  correlation:{traceId:null,spanId:null}
 });
 const serialized=JSON.stringify(defaultUnknown);
 for(const forbidden of ['raw prompt','ghp_secretTokenValue123','cyrusjamula','LEASE_HELD'])
  assert.equal(serialized.includes(forbidden),false);

 const explicitUnknowns=createExecutionReceipt({
  source:'synthetic',repositoryId:1471342715,receiptId:'syn-1',observedMs:10,
  stage:'merge-shadow',outcome:'eligible',reason:'NONE',
  shadow:true,liveDispatch:false,liveMerge:false,
  quota:{verified:false},cost:{verified:false},humanTouches:{verified:false},
  correlation:{traceId:null,spanId:null}
 });
 assert.equal(explicitUnknowns.valid,true);
 assert.equal(explicitUnknowns.durationMs,null);
 assert.deepEqual(explicitUnknowns.stages,{'merge-shadow':null});
 assert.equal(explicitUnknowns.cost.amountMicros,null);
 assert.equal(explicitUnknowns.humanTouches.count,null);

 const traceId='0123456789abcdef0123456789abcdef';
 const spanId='fedcba9876543210';
 const verifiedZero=createExecutionReceipt({
  source:'github-hosted',repositoryId:1471342715,receiptId:'gh-100-1-merge',observedMs:5000,
  stage:'verify-main',outcome:'eligible',reason:'NONE',durationMs:310,
  stages:{reconcile:25,review:1200,'merge-shadow':180,'verify-main':310,acceptance:null},
  quota:{verified:true,includedOnly:true,available:true},
  cost:{verified:true,currency:'USD',amountMicros:0},
  humanTouches:{verified:true,count:0},
  correlation:{traceId,spanId}
 });
 assert.equal(verifiedZero.valid,true);
 assert.deepEqual(verifiedZero.quota,{state:'verified-included',verified:true,includedOnly:true});
 assert.deepEqual(verifiedZero.cost,{state:'verified-zero',verified:true,currency:'USD',amountMicros:0});
 assert.deepEqual(verifiedZero.humanTouches,{state:'verified',verified:true,count:0});
 assert.deepEqual(verifiedZero.correlation,{traceId,spanId});

 const exhaustedQuota=createExecutionReceipt({
  ...base,stages:{reconcile:null},
  quota:{verified:true,includedOnly:true,available:false},
  correlation:{traceId,spanId:null}
 });
 assert.equal(exhaustedQuota.valid,true);
 assert.equal(exhaustedQuota.quota.state,'exhausted');
 assert.deepEqual(exhaustedQuota.correlation,{traceId,spanId:null});

 const accessor={...base};
 Object.defineProperty(accessor,'durationMs',{enumerable:true,get:()=>1});
 let getterCalls=0;
 const resultGetter={};
 Object.defineProperty(resultGetter,'reason',{enumerable:true,get:()=>{getterCalls++;return 'SHADOW_ELIGIBLE';}});
 const nestedCompletedGetter={reason:'SHADOW_TICK_COMPLETE',completed:[{}]};
 Object.defineProperty(nestedCompletedGetter.completed[0],'state',{
  enumerable:true,
  get:()=>{getterCalls++;throw Error('nested getter executed');}
 });
 const cyclicResult={reason:'SHADOW_ELIGIBLE'};
 cyclicResult.self=cyclicResult;
 const sparseCompleted=[];
 sparseCompleted[1]={state:'shadow-reviewed'};
 const sparseWithExtra=new Array(1);
 sparseWithExtra.extra={state:'shadow-reviewed'};
 const oversizedArrayResult={issues:Array.from({length:501},(_,i)=>i+1)};
 const symbolKeyResult={[Symbol('secret')]:'x',reason:'SHADOW_ELIGIBLE'};
 const tooManyKeysResult=Object.fromEntries(Array.from({length:65},(_,i)=>[`k${i}`,i]));

 // Single-stage dispatch, ci, and acceptance receipts and projections succeed
 for(const singleStage of ['dispatch','ci','acceptance']){
  const single=createExecutionReceipt({
   source:'github-hosted',repositoryId:1471342715,receiptId:`gh-200-1-${singleStage}`,
   observedMs:3000,stage:singleStage,outcome:'eligible',reason:'NONE',durationMs:55
  });
  assert.equal(single.valid,true);
  assert.deepEqual(receiptStageRows(single),{
   valid:true,
   source:'github-hosted',
   rows:[{
    id:`gh-200-1-${singleStage}-${singleStage}`,
    repositoryId:1471342715,
    stage:singleStage,
    at:3000,
    duration:55,
    source:'github-hosted'
   }]
  });
 }

 assert.deepEqual(telemetrySummary(resultGetter),{outcome:'unknown',reason:'OTHER'});
 assert.deepEqual(telemetrySummary(nestedCompletedGetter),{outcome:'unknown',reason:'OTHER'});
 assert.deepEqual(telemetrySummary(cyclicResult),{outcome:'unknown',reason:'OTHER'});
 assert.deepEqual(telemetrySummary({reason:'SHADOW_TICK_COMPLETE',completed:sparseWithExtra}),{outcome:'unknown',reason:'OTHER'});

 for(const bad of [
  null,[],new Proxy(base,{}),accessor,
  {...base,result:undefined},
  {...base,result:()=>'SHADOW_ELIGIBLE'},
  {...base,result:resultGetter},
  {...base,result:nestedCompletedGetter},
  {...base,result:cyclicResult},
  {...base,result:Object.create({reason:'SHADOW_ELIGIBLE'})},
  {...base,result:{reason:'SHADOW_TICK_COMPLETE',completed:sparseCompleted}},
  {...base,result:{reason:'SHADOW_TICK_COMPLETE',completed:sparseWithExtra}},
  {...base,result:oversizedArrayResult},
  {...base,result:symbolKeyResult},
  {...base,result:tooManyKeysResult},
  {...base,prompt:'injected'},
  {...base,token:'github_pat_123'},
  {...base,shadow:false},
  {...base,liveDispatch:true},
  {...base,liveMerge:true},
  {...base,source:'github-proxy'},
  {...base,repositoryId:0},
  {...base,receiptId:'github_pat_12345'},
  {...base,receiptId:'Jamula/SoftwareFactory'},
  {...base,receiptId:'x'.repeat(65)},
  {...base,observedMs:-1},
  {...base,stage:'unknown'},
  {source:'synthetic',repositoryId:1471342715,receiptId:'a',observedMs:1,stage:'evaluate'},
  {...base,outcome:'blocked',reason:'LEASE'},
  {source:'synthetic',repositoryId:1471342715,receiptId:'a',observedMs:1,stage:'evaluate',outcome:'bad',reason:'NONE'},
  {source:'synthetic',repositoryId:1471342715,receiptId:'a',observedMs:1,stage:'evaluate',outcome:'eligible',reason:'BAD'},
  {...base,durationMs:-1},
  {...base,stages:{}},
  {...base,durationMs:42,stages:{reconcile:99}},
  {...base,quota:{verified:true,includedOnly:false,available:true}},
  {...base,cost:{verified:false,currency:'USD',amountMicros:0}},
  {...base,cost:{verified:true,currency:'USD',amountMicros:1}},
  {...base,cost:{verified:true,currency:'EUR',amountMicros:0}},
  {...base,humanTouches:{verified:false,count:0}},
  {...base,humanTouches:{verified:true,count:-1}},
  {...base,humanTouches:{verified:true,count:1001}},
  {...base,correlation:{traceId:null,spanId}},
  {...base,correlation:{traceId:'0'.repeat(32),spanId}},
  {...base,correlation:{traceId,spanId:'0'.repeat(16)}},
  {...base,correlation:{traceId:'bad'}}
 ]){
  const rejected=createExecutionReceipt(bad);
  assert.equal(rejected.valid,false);
  assert.equal(rejected.schemaVersion,1);
  assert.equal(rejected.shadow,true);
  assert.equal(rejected.liveDispatch,false);
  assert.equal(rejected.liveMerge,false);
  assert.equal(rejected.outcome,'unknown');
  assert.equal(rejected.reason,'INVALID_EVIDENCE');
  assert.equal(rejected.cost.amountMicros,null);
  assert.equal(rejected.humanTouches.count,null);
 }
 assert.equal(getterCalls,0);
});

test('receiptStageRows feeds stage-aggregate for #18 and rejects invalid or tampered receipts',()=>{
 const samples=[100,200,300,400,500].map((ms,index)=>createExecutionReceipt({
  source:'synthetic',
  repositoryId:1471342715,
  receiptId:`run-${index+1}`,
  observedMs:1000+index*10,
  stage:'merge-shadow',
  outcome:'eligible',
  reason:'NONE',
  durationMs:ms,
  stages:{evaluate:5,reconcile:20+index,'merge-shadow':ms,'verify-main':null}
 }));
 const extracted=samples.flatMap(receipt=>{
  const out=receiptStageRows(receipt);
  assert.equal(out.valid,true);
  assert.equal(out.source,'synthetic');
  return out.rows;
 });
 const mergeSummary=aggregateStage(extracted,{
  repositoryId:1471342715,stage:'merge',from:1000,to:2000,
  complete:true,source:'synthetic',observedMs:2000,nowMs:2100,maxAgeMs:5000
 });
 assert.deepEqual(mergeSummary,{
  state:'synthetic',reason:'MEASURED_FIXTURE',sampleCount:5,p50:300,p95:500
 });

 const validSample=samples[0];
 const hostedReceipt=createExecutionReceipt({
  source:'github-hosted',repositoryId:1471342715,receiptId:'gh-555-1',observedMs:2000,
  stage:'verify-main',outcome:'eligible',reason:'NONE',durationMs:90,
  quota:{verified:true,includedOnly:true,available:true},
  cost:{verified:true,currency:'USD',amountMicros:0},
  humanTouches:{verified:true,count:1}
 });
 assert.deepEqual(receiptStageRows(hostedReceipt),{
  valid:true,
  source:'github-hosted',
  rows:[{id:'gh-555-1-verify-main',repositoryId:1471342715,stage:'verify-main',at:2000,duration:90,source:'github-hosted'}]
 });

 // Primary-stage durationMs is preserved in projected rows when stages[stage] is null or omitted
 const nullStageReceipt=createExecutionReceipt({
  source:'github-hosted',repositoryId:1471342715,receiptId:'gh-556-1',observedMs:2100,
  stage:'reconcile',outcome:'eligible',reason:'NONE',durationMs:42,stages:{reconcile:null}
 });
 assert.deepEqual(receiptStageRows(nullStageReceipt),{
  valid:true,
  source:'github-hosted',
  rows:[{id:'gh-556-1-reconcile',repositoryId:1471342715,stage:'reconcile',at:2100,duration:42,source:'github-hosted'}]
 });
 const omittedPrimaryReceipt=createExecutionReceipt({
  source:'github-hosted',repositoryId:1471342715,receiptId:'gh-557-1',observedMs:2200,
  stage:'review',outcome:'eligible',reason:'NONE',durationMs:75,stages:{reconcile:12}
 });
 assert.deepEqual(receiptStageRows(omittedPrimaryReceipt),{
  valid:true,
  source:'github-hosted',
  rows:[
   {id:'gh-557-1-reconcile',repositoryId:1471342715,stage:'reconcile',at:2200,duration:12,source:'github-hosted'},
   {id:'gh-557-1-review',repositoryId:1471342715,stage:'review',at:2200,duration:75,source:'github-hosted'}
  ]
 });
 const unmeasuredPrimaryReceipt=createExecutionReceipt({
  source:'synthetic',repositoryId:1471342715,receiptId:'syn-558',observedMs:2300,
  stage:'review',outcome:'unknown',reason:'NONE',durationMs:null,stages:{review:null}
 });
 assert.deepEqual(receiptStageRows(unmeasuredPrimaryReceipt),{
  valid:true,source:'synthetic',rows:[]
 });

 for(const invalid of [
  null,
  createExecutionReceipt(null),
  {...validSample,schemaVersion:2},
  {...validSample,liveMerge:true},
  {...validSample,source:'github-proxy'},
  {...validSample,durationMs:-1},
  {...validSample,durationMs:999},
  {...validSample,stages:{}},
  {...validSample,quota:{state:'unknown',verified:true,includedOnly:null}},
  {...validSample,cost:{state:'verified-zero',verified:true,currency:'USD',amountMicros:5}},
  {...validSample,humanTouches:{state:'verified',verified:true,count:-1}},
  {...validSample,correlation:{traceId:null,spanId:'fedcba9876543210'}}
 ]){
  assert.deepEqual(receiptStageRows(invalid),{valid:false,reason:'INVALID_RECEIPT',rows:[]});
 }
});
