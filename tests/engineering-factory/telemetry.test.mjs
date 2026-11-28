import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  EXECUTION_RECEIPT_SCHEMA_VERSION,
  AUTONOMOUS_RECEIPT_SCHEMA_VERSION,
  AI_CREDIT_USD_CENTS,
  MAX_AI_CREDITS,
  ALLOWED_MISSION_CONTROL_TASK_STATES,
  localEndpoint,
  localOtlpConfiguration,
  createSignals,
  telemetrySummary,
  createExecutionReceipt,
  receiptStageRows,
  correlateAutonomousExecutionReceipt
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

 // Policy-aware planLanes NO_READY_WORK preserves known blockedTasks denials while empty blockers stay unknown
 const validConfig={
  schemaVersion:1,
  project:{key:'sf',repository:'Jamula/SoftwareFactory',defaultBranch:'main'},
  execution:{mode:'shadow',enabled:true,stop:false},
  limits:{maxConcurrentLanes:2,leaseMs:30000,maxAttempts:3,baseDelayMs:100,maxDelayMs:1000},
  adapters:{workTracker:'mock',engineeringAgent:'mock',state:'sqlite'},
  lanes:[{id:'core',owners:['src'],prompt:'prompts/core.md'}]
 };
 const blockedPolicyPlan=planLanes(
  validConfig,
  [{id:1,lane:'core',state:'approved',priority:1,dependencies:[],paths:['src/a.mjs']}],
  [],
  {now:1000,agingMs:60000,riskCeiling:'low',ready:[{id:1,readySince:500,risk:'high'}]}
 );
 assert.equal(blockedPolicyPlan.reason,'NO_READY_WORK');
 assert.deepEqual(telemetrySummary(blockedPolicyPlan),{outcome:'blocked',reason:'POLICY'});
 const blockedReceipt=createExecutionReceipt({
  source:'github-hosted',repositoryId:1471342715,receiptId:'gh-900-1',
  observedMs:1000,stage:'evaluate',result:blockedPolicyPlan
 });
 assert.equal(blockedReceipt.valid,true);
 assert.equal(blockedReceipt.outcome,'blocked');
 assert.equal(blockedReceipt.reason,'POLICY');

 const emptyPolicyPlan=planLanes(validConfig,[],[],{now:1000,agingMs:60000,riskCeiling:'low',ready:[]});
 assert.equal(emptyPolicyPlan.reason,'NO_READY_WORK');
 assert.deepEqual(telemetrySummary(emptyPolicyPlan),{outcome:'unknown',reason:'NONE'});
 assert.deepEqual(telemetrySummary({
  shadow:true,scheduled:[],reason:'NO_READY_WORK',
  blockedTasks:[{id:1,reason:'CAPACITY_FULL'},{id:2,reason:'TASK_READ_FAILED'}]
 }),{outcome:'failed',reason:'RUNTIME'});
 assert.deepEqual(telemetrySummary({
  shadow:true,scheduled:[],reason:'NO_READY_WORK',
  blockedTasks:[{id:1,reason:'custom unmapped blocker'}]
 }),{outcome:'blocked',reason:'OTHER'});
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

test('telemetrySummary maps Wave 2/3 deterministic denials cleanly to canonical OTel categories without collapsing to OTHER',()=>{
 const wave2And3Denials=[
  // QUOTA
  ['AI_CREDIT_ACCOUNTING_UNVERIFIED','QUOTA'],
  ['AI_CREDIT_CAP_EXCEEDED','QUOTA'],
  ['AI_CREDIT_ANOMALY','QUOTA'],
  ['ACCOUNTING_ESTIMATED_OR_MISSING','QUOTA'],
  ['INCLUDED_QUOTA_NOT_ATTRIBUTED','QUOTA'],
  ['INCREMENTAL_SPEND_NONZERO','QUOTA'],
  ['PAID_OVERAGE_ALLOWED','QUOTA'],
  ['OVERAGE_LIMIT_NONZERO','QUOTA'],
  ['OVERAGE_ENABLED','QUOTA'],
  ['WORKER_CAPACITY_UNVERIFIED','QUOTA'],
  ['WORKER_LADDER_VIOLATION','QUOTA'],
  ['PORTFOLIO_CAPACITY_EXHAUSTED','QUOTA'],
  ['QUOTA','QUOTA'],
  // SECURITY
  ['UNSAFE_TELEMETRY_PAYLOAD','SECURITY'],
  ['INVALID_TRACEPARENT','SECURITY'],
  ['TRACE_ID_MISMATCH','SECURITY'],
  ['SPAN_LINKAGE_BROKEN','SECURITY'],
  ['INVALID_GH_AW_LOCK_HASH','SECURITY'],
  ['SAFE_OUTPUTS_THREAT_FLAGGED','SECURITY'],
  ['PROTECTED_CONTROL_PLANE_TOUCH','SECURITY'],
  ['FORCE_UPDATE_FORBIDDEN','SECURITY'],
  ['UNPROTECTED_WORK_QUEUE_REF','SECURITY'],
  ['CROSS_REPO_CANDIDATE_REJECTED','SECURITY'],
  ['PROVENANCE_ISOLATION_VIOLATION','SECURITY'],
  ['SEPARATE_AUTHORIZATION_REQUIRED','SECURITY'],
  ['AGENT_JOB_WRITE_PERMISSION','SECURITY'],
  ['FRONTMATTER_HASH_MISMATCH','SECURITY'],
  ['MISSING_THREAT_SCAN_GATE','SECURITY'],
  ['UNTRUSTED_CODEQL_PRODUCER','SECURITY'],
  ['OS_ROOT_TRUST_MODIFIED','SECURITY'],
  ['SECURITY','SECURITY'],
  // LEASE
  ['CAS_CONFLICT','LEASE'],
  ['LEASE_NOT_HELD','LEASE'],
  ['STALE_GENERATION','LEASE'],
  ['INVALID_CAS_LEASE','LEASE'],
  ['EXECUTION_TTL_INVALID','LEASE'],
  ['MISSING_CONCURRENCY_GUARD','LEASE'],
  ['WORK_QUEUE_PROTOCOL_UNSUPPORTED','LEASE'],
  ['UNAUTHORIZED_CONCURRENT_AGENT_CLAIM','LEASE'],
  ['LEASE','LEASE'],
  // POLICY
  ['PILOT_ENTRY_BLOCKED','POLICY'],
  ['M01_PREREQUISITES_UNVERIFIED','POLICY'],
  ['POLICY_BELOW_M01_TARGET','POLICY'],
  ['OUT_OF_LANE_EDIT','POLICY'],
  ['LANE_OWNERSHIP_VIOLATION','POLICY'],
  ['RETRY_CAP_EXCEEDED','POLICY'],
  ['RETRY_CEILING_EXCEEDED','POLICY'],
  ['LAPTOP_DEPENDENCY_FORBIDDEN','POLICY'],
  ['PYTHON_INVOCATION_FORBIDDEN','POLICY'],
  ['LIVE_DISPATCH_DISABLED','POLICY'],
  ['SYNTHETIC_CYCLES_NOT_DELIVERED_WORK','POLICY'],
  ['HUMAN_INTERVENTION_NONZERO','POLICY'],
  ['POLICY','POLICY'],
  // REVIEW
  ['SELF_APPROVAL_FORBIDDEN','REVIEW'],
  ['SELF_REVIEW_FORBIDDEN','REVIEW'],
  ['UNAUTHORIZED_REVIEWER','REVIEW'],
  ['FORMAL_APPROVAL_REQUIRED','REVIEW'],
  ['INDEPENDENT_REVIEW_REQUIRED','REVIEW'],
  ['REVIEW_FINDINGS_UNRESOLVED','REVIEW'],
  ['REVIEW','REVIEW'],
  // COVERAGE
  ['COVERAGE_BELOW_THRESHOLD','COVERAGE'],
  ['COMPONENT_BELOW_TARGET','COVERAGE'],
  ['BRANCHLESS_UNJUSTIFIED','COVERAGE'],
  ['COVERAGE_BELOW_CONSUMER_GATE','COVERAGE'],
  ['DOTNET_COVERAGE_BELOW_TARGET','COVERAGE'],
  ['JS_COVERAGE_BELOW_TARGET','COVERAGE'],
  // CHECKS
  ['CODEQL_PYTHON_RESIDUAL','CHECKS'],
  ['CODEQL_CHECKS_INCOMPLETE','CHECKS'],
  ['MISSING_CODEQL_CHECKS','CHECKS'],
  ['POST_MERGE_MAIN_FAILED','CHECKS'],
  ['MAIN_UNHEALTHY','CHECKS'],
  ['REQUIRED_CHECKS_INCOMPLETE','CHECKS'],
  ['LIVE_CYCLES_PENDING','CHECKS'],
  ['SCENARIO_MISSING','CHECKS'],
  ['CHECKS','CHECKS'],
  // STALE / DEPENDENCY / INVALID_EVIDENCE
  ['STALE_HARD_STOP_RECEIPT','STALE'],
  ['STALE_HEAD_SUPERSEDED','STALE'],
  ['REVIEW_HEAD_MISMATCH','STALE'],
  ['STALE','STALE'],
  ['UPSTREAM_BLOCKED','DEPENDENCY'],
  ['M01_UPSTREAM_NOT_ACCEPTED','DEPENDENCY'],
  ['FAMILYTREE_PILOT_NOT_ACCEPTED','DEPENDENCY'],
  ['DEPENDENCY','DEPENDENCY'],
  ['INVALID_MISSION_CONTROL_TASK','INVALID_EVIDENCE'],
  ['PREREQUISITES_UNKNOWN','INVALID_EVIDENCE'],
  ['BATCH_BOUNDARY_UNKNOWN','INVALID_EVIDENCE'],
  ['INVALID_EVIDENCE','INVALID_EVIDENCE']
 ];
 for(const [code,expectedReason] of wave2And3Denials){
  const summary=telemetrySummary({shadow:true,reason:code});
  assert.deepEqual(summary,{outcome:'blocked',reason:expectedReason});
 }
 for(const runtimeCode of ['REF_STORE_UNAVAILABLE','STORE_UNAVAILABLE','EXECUTION_TIMEOUT','RUNTIME']){
  assert.deepEqual(telemetrySummary({shadow:true,reason:runtimeCode}),{outcome:'failed',reason:'RUNTIME'});
 }
 // Canonical outcome+reason passthrough (e.g. anti-rogue provenance / circuit-breaker / correlated receipt)
 assert.deepEqual(
  telemetrySummary({shadow:true,valid:true,outcome:'eligible',reason:'NONE'}),
  {outcome:'eligible',reason:'NONE'}
 );
 assert.deepEqual(
  telemetrySummary({shadow:true,valid:true,state:'failed',outcome:'failed',reason:'LEASE'}),
  {outcome:'failed',reason:'LEASE'}
 );
 assert.deepEqual(
  telemetrySummary({shadow:true,reason:'NONE'}),
  {outcome:'blocked',reason:'NONE'}
 );
});

test('correlateAutonomousExecutionReceipt correlates OTel traceparent, authoritative gh-aw AI credits, and Mission Control metadata fail-closed',()=>{
 assert.equal(AUTONOMOUS_RECEIPT_SCHEMA_VERSION,1);
 assert.equal(AI_CREDIT_USD_CENTS,1);
 assert.equal(MAX_AI_CREDITS,1_000_000);
 assert.deepEqual(ALLOWED_MISSION_CONTROL_TASK_STATES,[
  'queued','in_progress','completed','failed','cancelled','timed_out'
 ]);

 const traceId='0123456789abcdef0123456789abcdef';
 const spanId='fedcba9876543210';
 const parentSpanId='1122334455667788';
 const traceparent=`00-${traceId}-${spanId}-01`;
 const lockSha256='ab'.repeat(32);
 const taskIdUpper='01936D8E-7F2A-7B00-8A11-3C4D5E6F7081';
 const runtimeToken=['gh','p_','x'.repeat(24)].join('');
 const runtimeFinePat=['github','_pat_','y'.repeat(24)].join('');
 const runtimeSkKey=['s','k-','z'.repeat(24)].join('');
 const runtimeJwt=['ey','JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0'].join('');

 // 1. Raw receipt input with untrusted result payload stripped + sampled W3C traceparent + authoritative AI credits
 const baseInput={
  traceparent,
  parentSpanId,
  laptopCollectorRequired:false,
  shadow:true,
  liveDispatch:false,
  liveMerge:false,
  receipt:{
   source:'github-hosted',
   repositoryId:1471342715,
   receiptId:'gh-aw-run-4001-dispatch',
   observedMs:1764300000000,
   stage:'dispatch',
   durationMs:140,
   stages:{reconcile:20,dispatch:140},
   humanTouches:{verified:true,count:0},
   result:{
    shadow:true,
    reason:'SHADOW_ALLOCATION',
    prompt:'raw user prompt text must be stripped',
    token:runtimeToken,
    actor:'untrusted-caller'
   }
  },
  aiCreditAccounting:{
   accountingSource:'authoritative',
   aiCreditUnitUsdCents:1,
   isEstimated:false,
   includedQuotaAttributed:true,
   aiCreditsUsed:4,
   maxAiCredits:25,
   incrementalBilledUsdCents:0
  },
  missionControl:{
   taskId:taskIdUpper,
   sessionId:'mc-sess-hosted-01',
   taskState:'completed',
   lockSha256,
   casLeaseGeneration:7,
   actor:'copilot-swe-agent[bot]'
  }
 };

 const correlated=correlateAutonomousExecutionReceipt(baseInput);
 assert.equal(correlated.valid,true);
 assert.equal(correlated.schemaVersion,1);
 assert.equal(correlated.shadow,true);
 assert.equal(correlated.liveDispatch,false);
 assert.equal(correlated.liveMerge,false);
 assert.equal(correlated.laptopCollectorRequired,false);
 assert.equal(correlated.state,'correlated');
 assert.equal(correlated.outcome,'eligible');
 assert.equal(correlated.reason,'NONE');
 assert.equal(correlated.otelReason,'NONE');
 assert.deepEqual(correlated.telemetry,{
  traceparent,
  version:'00',
  traceId,
  spanId,
  parentSpanId,
  traceFlags:'01',
  sampled:true,
  aspireOtlpCompatible:true,
  laptopCollectorRequired:false
 });
 assert.deepEqual(correlated.aiCreditAccounting,{
  accountingSource:'authoritative',
  isEstimated:false,
  aiCreditUnitUsdCents:1,
  aiCreditsUsed:4,
  maxAiCredits:25,
  remainingAiCredits:21,
  includedAiCreditsUsdCents:4,
  includedAiCreditsUsdMicros:40_000,
  incrementalBilledUsdCents:0,
  includedQuotaAttributed:true
 });
 assert.deepEqual(correlated.missionControl,{
  taskId:taskIdUpper.toLowerCase(),
  sessionId:'mc-sess-hosted-01',
  taskState:'completed',
  lockSha256,
  casLeaseGeneration:7,
  actor:'copilot-swe-agent[bot]'
 });
 assert.deepEqual(correlated.otelAttributes,{
  stage:'dispatch',
  outcome:'eligible',
  reason:'NONE',
  taskState:'completed',
  accountingState:'authoritative-zero-incremental'
 });
 assert.deepEqual(telemetrySummary(correlated),{outcome:'eligible',reason:'NONE'});

 // Ensure zero secret/prompt leakage and zero unbounded IDs in OTel attributes
 const serializedCorrelated=JSON.stringify(correlated);
 for(const forbidden of ['raw user prompt text',runtimeToken,'untrusted-caller','SHADOW_ALLOCATION'])
  assert.equal(serializedCorrelated.includes(forbidden),false);
 const serializedAttrs=JSON.stringify(correlated.otelAttributes);
 for(const unbounded of [taskIdUpper.toLowerCase(),'mc-sess-hosted-01',traceId,spanId,lockSha256,'gh-aw-run-4001-dispatch','1471342715'])
  assert.equal(serializedAttrs.includes(unbounded),false);

 // Correlated receipt feeds receiptStageRows (#18 scorecard interface) directly
 assert.deepEqual(receiptStageRows(correlated.receipt),{
  valid:true,
  source:'github-hosted',
  rows:[
   {id:'gh-aw-run-4001-dispatch-reconcile',repositoryId:1471342715,stage:'reconcile',at:1764300000000,duration:20,source:'github-hosted'},
   {id:'gh-aw-run-4001-dispatch-dispatch',repositoryId:1471342715,stage:'dispatch',at:1764300000000,duration:140,source:'github-hosted'}
  ]
 });

 // 2. Pre-created createExecutionReceipt with exhausted quota (aiCreditsUsed === maxAiCredits), unsampled traceparent, omitted optional defaults, blocked stage
 const storedBlockedReceipt=createExecutionReceipt({
  source:'github-hosted',
  repositoryId:1471342715,
  receiptId:'gh-aw-run-4002-review',
  observedMs:1764300010000,
  stage:'review',
  outcome:'blocked',
  reason:'REVIEW',
  durationMs:50,
  quota:{verified:true,includedOnly:true,available:false},
  correlation:{traceId,spanId}
 });
 for(const taskState of ALLOWED_MISSION_CONTROL_TASK_STATES){
  const res=correlateAutonomousExecutionReceipt({
   traceparent:`00-${traceId}-${spanId}-00`,
   receipt:storedBlockedReceipt,
   aiCreditAccounting:{
    accountingSource:'authoritative',
    aiCreditsUsed:25,
    maxAiCredits:25,
    incrementalBilledUsdCents:0
   },
   missionControl:{
    taskId:taskIdUpper.toLowerCase(),
    sessionId:'mc-sess-hosted-02',
    taskState,
    lockSha256,
    casLeaseGeneration:1
   }
  });
  assert.equal(res.valid,true);
  assert.equal(res.state,'blocked');
  assert.equal(res.outcome,'blocked');
  assert.equal(res.reason,'REVIEW');
  assert.equal(res.telemetry.sampled,false);
  assert.equal(res.telemetry.parentSpanId,null);
  assert.equal(res.receipt.quota.state,'exhausted');
  assert.equal(res.aiCreditAccounting.remainingAiCredits,0);
  assert.equal(res.missionControl.actor,'copilot-swe-agent[bot]');
  assert.deepEqual(telemetrySummary(res),{outcome:'blocked',reason:'REVIEW'});
 }

 // 3. Estimated / unknown / unverified accounting fails closed with AI_CREDIT_ACCOUNTING_UNVERIFIED -> QUOTA
 for(const badAccounting of [
  {...baseInput.aiCreditAccounting,accountingSource:'estimated'},
  {...baseInput.aiCreditAccounting,accountingSource:'unknown'},
  {...baseInput.aiCreditAccounting,accountingSource:'verified'},
  {...baseInput.aiCreditAccounting,accountingSource:''},
  {...baseInput.aiCreditAccounting,accountingSource:null},
  {...baseInput.aiCreditAccounting,isEstimated:true},
  {...baseInput.aiCreditAccounting,isEstimated:'false'},
  {...baseInput.aiCreditAccounting,aiCreditsUsed:-1},
  {...baseInput.aiCreditAccounting,aiCreditsUsed:-0},
  {...baseInput.aiCreditAccounting,aiCreditsUsed:MAX_AI_CREDITS+1},
  {...baseInput.aiCreditAccounting,maxAiCredits:-1},
  {...baseInput.aiCreditAccounting,maxAiCredits:1.5},
  {...baseInput.aiCreditAccounting,incrementalBilledUsdCents:-0},
  {...baseInput.aiCreditAccounting,incrementalBilledUsdCents:Number.NaN}
 ]){
  const denied=correlateAutonomousExecutionReceipt({...baseInput,aiCreditAccounting:badAccounting});
  assert.equal(denied.valid,false);
  assert.equal(denied.reason,'AI_CREDIT_ACCOUNTING_UNVERIFIED');
  assert.equal(denied.otelReason,'QUOTA');
  assert.equal(denied.receipt,null);
  assert.deepEqual(telemetrySummary(denied),{outcome:'blocked',reason:'QUOTA'});
 }

 // 4. Cap breaches, nonzero incremental spend, unattributed quota, wrong AI credit unit
 const overCap=correlateAutonomousExecutionReceipt({
  ...baseInput,
  aiCreditAccounting:{...baseInput.aiCreditAccounting,aiCreditsUsed:26,maxAiCredits:25}
 });
 assert.equal(overCap.valid,false);
 assert.equal(overCap.reason,'AI_CREDIT_CAP_EXCEEDED');
 assert.equal(overCap.otelReason,'QUOTA');

 const nonZeroSpend=correlateAutonomousExecutionReceipt({
  ...baseInput,
  aiCreditAccounting:{...baseInput.aiCreditAccounting,incrementalBilledUsdCents:1}
 });
 assert.equal(nonZeroSpend.valid,false);
 assert.equal(nonZeroSpend.reason,'INCREMENTAL_SPEND_NONZERO');
 assert.equal(nonZeroSpend.otelReason,'QUOTA');

 const unattributed=correlateAutonomousExecutionReceipt({
  ...baseInput,
  aiCreditAccounting:{...baseInput.aiCreditAccounting,includedQuotaAttributed:false}
 });
 assert.equal(unattributed.valid,false);
 assert.equal(unattributed.reason,'INCLUDED_QUOTA_NOT_ATTRIBUTED');
 assert.equal(unattributed.otelReason,'QUOTA');

 const badUnit=correlateAutonomousExecutionReceipt({
  ...baseInput,
  aiCreditAccounting:{...baseInput.aiCreditAccounting,aiCreditUnitUsdCents:2}
 });
 assert.equal(badUnit.valid,false);
 assert.equal(badUnit.reason,'INVALID_POLICY');
 assert.equal(badUnit.otelReason,'POLICY');

 // 5. Prompt, secret, token, and unbounded-dimension rejection without executing getters/proxies
 let traps=0;
 const trap=()=>{traps++;throw Error('unexpected getter or proxy trap');};
 const proxyInput=new Proxy(baseInput,{get:trap,ownKeys:trap,getOwnPropertyDescriptor:trap});
 const getterInput={...baseInput};
 Object.defineProperty(getterInput,'traceparent',{enumerable:true,get:trap});
 const nonEnumMc={...baseInput.missionControl};
 Object.defineProperty(nonEnumMc,'sessionId',{value:'mc-sess-hosted-01',enumerable:false});
 const symbolAccounting={...baseInput.aiCreditAccounting,[Symbol('tag')]:1};
 const getterReceipt={...baseInput.receipt};
 Object.defineProperty(getterReceipt,'receiptId',{enumerable:true,get:trap});
 const symbolReceipt={...baseInput.receipt,[Symbol('r')]:1};
 const nonEnumReceipt={...baseInput.receipt};
 Object.defineProperty(nonEnumReceipt,'stage',{value:'dispatch',enumerable:false});

 for(const unsafePayload of [
  {...baseInput,prompt:'raw prompt'},
  {...baseInput,token:runtimeToken},
  {...baseInput,otelLabels:{taskId:taskIdUpper}},
  {...baseInput,otelAttributes:{sessionId:'mc-1'}},
  {...baseInput,traceparent:`00-${traceId}-${spanId}-01-${runtimeToken}`},
  {...baseInput,aiCreditAccounting:{...baseInput.aiCreditAccounting,apiKey:runtimeSkKey}},
  {...baseInput,missionControl:{...baseInput.missionControl,rawPrompt:'system instructions'}},
  {...baseInput,missionControl:{...baseInput.missionControl,dimensions:{unbounded:'x'}}},
  {...baseInput,missionControl:{...baseInput.missionControl,sessionId:runtimeToken}},
  {...baseInput,missionControl:{...baseInput.missionControl,sessionId:runtimeFinePat}},
  {...baseInput,missionControl:{...baseInput.missionControl,sessionId:runtimeSkKey}},
  {...baseInput,missionControl:{...baseInput.missionControl,taskState:`Bearer ${runtimeJwt}`}},
  {...baseInput,missionControl:{...baseInput.missionControl,sessionId:'s'.repeat(513)}},
  {...baseInput,receipt:{...baseInput.receipt,secret:'top-secret'}},
  {...baseInput,receipt:{...baseInput.receipt,receiptId:runtimeSkKey}}
 ]){
  const denied=correlateAutonomousExecutionReceipt(unsafePayload);
  assert.equal(denied.valid,false);
  assert.equal(denied.reason,'UNSAFE_TELEMETRY_PAYLOAD');
  assert.equal(denied.otelReason,'SECURITY');
  assert.equal(JSON.stringify(denied).includes(runtimeToken),false);
 }

 // 6. Traceparent, Mission Control, lockSha256, CAS lease, policy, and receipt mismatches
 const expectedDenials=[
  [null,'INVALID_EVIDENCE','INVALID_EVIDENCE'],
  [[],'INVALID_EVIDENCE','INVALID_EVIDENCE'],
  [proxyInput,'INVALID_EVIDENCE','INVALID_EVIDENCE'],
  [getterInput,'INVALID_EVIDENCE','INVALID_EVIDENCE'],
  [{...baseInput,extraField:1},'INVALID_EVIDENCE','INVALID_EVIDENCE'],
  [{traceparent,receipt:baseInput.receipt,aiCreditAccounting:baseInput.aiCreditAccounting},'INVALID_EVIDENCE','INVALID_EVIDENCE'],
  [{...baseInput,laptopCollectorRequired:true},'LAPTOP_DEPENDENCY_FORBIDDEN','POLICY'],
  [{...baseInput,shadow:false},'LIVE_DISPATCH_DISABLED','POLICY'],
  [{...baseInput,liveDispatch:true},'LIVE_DISPATCH_DISABLED','POLICY'],
  [{...baseInput,liveMerge:true},'LIVE_DISPATCH_DISABLED','POLICY'],
  [{...baseInput,traceparent:123},'INVALID_TRACEPARENT','SECURITY'],
  [{...baseInput,traceparent:'01-0123456789abcdef0123456789abcdef-fedcba9876543210-01'},'INVALID_TRACEPARENT','SECURITY'],
  [{...baseInput,traceparent:`00-${'0'.repeat(32)}-${spanId}-01`},'INVALID_TRACEPARENT','SECURITY'],
  [{...baseInput,traceparent:`00-${traceId}-${'0'.repeat(16)}-01`},'INVALID_TRACEPARENT','SECURITY'],
  [{...baseInput,parentSpanId:'0'.repeat(16)},'INVALID_TRACEPARENT','SECURITY'],
  [{...baseInput,parentSpanId:spanId},'INVALID_TRACEPARENT','SECURITY'],
  [{...baseInput,aiCreditAccounting:null},'INVALID_EVIDENCE','INVALID_EVIDENCE'],
  [{...baseInput,aiCreditAccounting:symbolAccounting},'INVALID_EVIDENCE','INVALID_EVIDENCE'],
  [{...baseInput,aiCreditAccounting:{...baseInput.aiCreditAccounting,unknownKey:1}},'INVALID_EVIDENCE','INVALID_EVIDENCE'],
  [{...baseInput,aiCreditAccounting:{accountingSource:'authoritative',aiCreditsUsed:1,maxAiCredits:2}},'INVALID_EVIDENCE','INVALID_EVIDENCE'],
  [{...baseInput,missionControl:nonEnumMc},'INVALID_EVIDENCE','INVALID_EVIDENCE'],
  [{...baseInput,missionControl:{...baseInput.missionControl,extraMc:1}},'INVALID_EVIDENCE','INVALID_EVIDENCE'],
  [{...baseInput,missionControl:{...baseInput.missionControl,taskId:123}},'INVALID_MISSION_CONTROL_TASK','INVALID_EVIDENCE'],
  [{...baseInput,missionControl:{...baseInput.missionControl,taskId:'00000000-0000-0000-0000-000000000000'}},'INVALID_MISSION_CONTROL_TASK','INVALID_EVIDENCE'],
  [{...baseInput,missionControl:{...baseInput.missionControl,taskId:'01936d8e7f2a7b008a113c4d5e6f7081'}},'INVALID_MISSION_CONTROL_TASK','INVALID_EVIDENCE'],
  [{...baseInput,missionControl:{...baseInput.missionControl,sessionId:123}},'INVALID_MISSION_CONTROL_TASK','INVALID_EVIDENCE'],
  [{...baseInput,missionControl:{...baseInput.missionControl,sessionId:'bad session spaces'}},'INVALID_MISSION_CONTROL_TASK','INVALID_EVIDENCE'],
  [{...baseInput,missionControl:{...baseInput.missionControl,taskState:'arbitrary_unbounded_state'}},'INVALID_MISSION_CONTROL_TASK','INVALID_EVIDENCE'],
  [{...baseInput,missionControl:{...baseInput.missionControl,lockSha256:123}},'INVALID_GH_AW_LOCK_HASH','SECURITY'],
  [{...baseInput,missionControl:{...baseInput.missionControl,lockSha256:'0'.repeat(64)}},'INVALID_GH_AW_LOCK_HASH','SECURITY'],
  [{...baseInput,missionControl:{...baseInput.missionControl,lockSha256:'abc'}},'INVALID_GH_AW_LOCK_HASH','SECURITY'],
  [{...baseInput,missionControl:{...baseInput.missionControl,casLeaseGeneration:0}},'INVALID_CAS_LEASE','LEASE'],
  [{...baseInput,missionControl:{...baseInput.missionControl,casLeaseGeneration:1_000_000_001}},'INVALID_CAS_LEASE','LEASE'],
  [{...baseInput,missionControl:{...baseInput.missionControl,actor:'human-pat-user'}},'PROVENANCE_MISMATCH','SECURITY'],
  [{...baseInput,receipt:null},'INVALID_RECEIPT','INVALID_EVIDENCE'],
  [{...baseInput,receipt:getterReceipt},'INVALID_RECEIPT','INVALID_EVIDENCE'],
  [{...baseInput,receipt:symbolReceipt},'INVALID_RECEIPT','INVALID_EVIDENCE'],
  [{...baseInput,receipt:nonEnumReceipt},'INVALID_RECEIPT','INVALID_EVIDENCE'],
  [{...baseInput,receipt:{...baseInput.receipt,stage:'invalid-stage'}},'INVALID_RECEIPT','INVALID_EVIDENCE'],
  [{...baseInput,receipt:{...storedBlockedReceipt,valid:false}},'INVALID_RECEIPT','INVALID_EVIDENCE'],
  [{...baseInput,receipt:{...storedBlockedReceipt,correlation:{traceId:'f'.repeat(32),spanId}}},'TRACE_ID_MISMATCH','SECURITY'],
  [{...baseInput,receipt:{...storedBlockedReceipt,correlation:{traceId,spanId:'a'.repeat(16)}}},'SPAN_LINKAGE_BROKEN','SECURITY'],
  [{...baseInput,receipt:storedBlockedReceipt},'INVALID_RECEIPT','INVALID_EVIDENCE']
 ];
 for(const [candidate,reason,otelReason] of expectedDenials){
  const denied=correlateAutonomousExecutionReceipt(candidate);
  assert.equal(denied.valid,false);
  assert.equal(denied.reason,reason);
  assert.equal(denied.otelReason,otelReason);
 }
 assert.equal(traps,0);
});
