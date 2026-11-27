import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {run,runCliIfDirect} from '../../tools/engineering-factory/run.mjs';
import {createSignals,receiptStageRows} from '../../tools/engineering-factory/telemetry.mjs';
import {aggregateStage} from '../../tools/engineering-factory/stage-aggregate.mjs';
import {plan} from '../../tools/engineering-factory/shadow-runtime.mjs';

test('runner exposes sanitized optional telemetry for available command stages',async()=>{
 const measurements=[],spans=[];
 const observe=createSignals({
  clock:()=>10,
  meter:{createCounter:()=>({add:(...args)=>measurements.push(args)}),
   createHistogram:()=>({record:(...args)=>measurements.push(args)})},
  tracer:{startSpan:name=>({setAttributes:attrs=>spans.push({name,attrs}),end(){}})}
 });
 const output=[],failures=[];
 const result={shadow:true,ready:[1,2],reason:'SHADOW_PLAN',private:'must not reach telemetry'};
 const inventory={shadow:true,evidenceComplete:false,private:'inventory detail'};
 const pull={shadow:true,evidenceComplete:false,reconciled:false,reason:'TRUST_UNKNOWN',private:'pull detail'};
 const issue={shadow:true,evidenceComplete:false,reconciled:false,reason:'READ_FAILED',private:'issue detail'};
 const options={observe,write:value=>output.push(value),fail:value=>failures.push(value)};
 assert.equal(await run([], {...options,replay:()=>result}),0);
 assert.equal(await run(['--inventory'], {...options,inventory:async()=>inventory}),0);
 assert.equal(await run(['--reconcile-pull'], {...options,reconcile:async()=>pull}),0);
 assert.equal(await run(['--reconcile-issue'], {...options,reconcileIssue:async()=>issue}),0);
 const attributes=measurements.filter((_,i)=>i%2===0).map(([,attrs])=>attrs);
 assert.deepEqual(attributes.map(({stage})=>stage),
  ['evaluate','reconcile','reconcile','reconcile']);
 assert.deepEqual(attributes.map(({outcome,reason})=>({outcome,reason})),[
  {outcome:'eligible',reason:'NONE'},
  {outcome:'unknown',reason:'NONE'},
  {outcome:'blocked',reason:'SECURITY'},
  {outcome:'failed',reason:'RUNTIME'}
 ]);
 const telemetry=JSON.stringify({measurements,spans});
 for(const privateValue of ['must not reach telemetry','inventory detail','pull detail','issue detail','TRUST_UNKNOWN','READ_FAILED'])
  assert.equal(telemetry.includes(privateValue),false);
 assert.equal(output.length,4);
 assert.equal(output[1],JSON.stringify(inventory));
 assert.equal(output[2],JSON.stringify(pull));
 assert.equal(output[3],JSON.stringify(issue));
 assert.deepEqual(failures,[]);
});

test('runner defaults to no-op observation and preserves command results',async()=>{
 const result={shadow:true,evidenceComplete:false,reason:'INVENTORY_ONLY'};
 const output=[];
 assert.equal(await run(['--inventory'],{inventory:async()=>result,write:value=>output.push(value)}),0);
 assert.deepEqual(output,[JSON.stringify(result)]);
});

test('identity-only reconciliation stays unknown and unrecognized reasons stay bounded',async()=>{
 const measurements=[],output=[];
 const observe=createSignals({
  meter:{createCounter:()=>({add:(...args)=>measurements.push(args)}),
   createHistogram:()=>({record:(...args)=>measurements.push(args)})},
  tracer:{startSpan:()=>({setAttributes(){},end(){}})}
 });
 const matched={shadow:true,evidenceComplete:false,reconciled:true,reason:'PULL_IDENTITY_MATCHED',private:'pull metadata'};
 const unrecognized={shadow:true,evidenceComplete:false,reconciled:true,reason:'sensitive failure detail',private:'issue metadata'};
 const options={observe,write:value=>output.push(value),fail:assert.fail};
 assert.equal(await run(['--reconcile-pull'],{...options,reconcile:async()=>matched}),0);
 assert.equal(await run(['--reconcile-issue'],{...options,reconcileIssue:async()=>unrecognized}),0);
 const attributes=measurements.filter((_,i)=>i%2===0).map(([,attrs])=>attrs);
 assert.deepEqual(attributes.map(({outcome,reason})=>({outcome,reason})),[
  {outcome:'unknown',reason:'NONE'},
  {outcome:'unknown',reason:'OTHER'}
 ]);
 assert.deepEqual(output,[JSON.stringify(matched),JSON.stringify(unrecognized)]);
 assert.equal(JSON.stringify({measurements,attributes}).includes('sensitive failure detail'),false);
 assert.equal(JSON.stringify({measurements,attributes}).includes('pull metadata'),false);
 assert.equal(JSON.stringify({measurements,attributes}).includes('issue metadata'),false);
});

test('explicit planner denials are blocked while no-ready-work stays unknown',async()=>{
 const measurements=[];
 const observe=createSignals({
  meter:{createCounter:()=>({add:(...args)=>measurements.push(args)}),
   createHistogram:()=>({record:(...args)=>measurements.push(args)})},
  tracer:{startSpan:()=>({setAttributes(){},end(){}})}
 });
 const reasons=['STOPPED','CAPACITY_UNKNOWN','INVALID_TASKS','UNKNOWN_DEPENDENCY',
  'DEPENDENCY_CYCLE','ACTIVE_OWNERSHIP_CONFLICT','NO_READY_WORK'];
 for(const reason of reasons)
  assert.equal(await run(['--smoke'],{observe,replay:()=>({shadow:true,ready:[],reason}),write:()=>{}}),1);
 const attributes=measurements.filter((_,i)=>i%2===0).map(([,attrs])=>attrs);
 assert.deepEqual(attributes.map(({outcome})=>outcome),[
  'blocked','blocked','blocked','blocked','blocked','blocked','unknown'
 ]);
 assert.deepEqual(attributes.map(({reason})=>reason),[
  'POLICY','QUOTA','INVALID_EVIDENCE','DEPENDENCY','DEPENDENCY','POLICY','NONE'
 ]);
});

test('runner rejects unsupported commands without invoking telemetry',async()=>{
 const writes=[],failures=[];
 assert.equal(await run(['--unknown'],{observe:()=>assert.fail('telemetry must not run'),
  write:value=>writes.push(value),fail:value=>failures.push(value)}),2);
 assert.deepEqual(writes,[]);
 assert.match(failures[0],/^Usage:/);
});

test('runner sanitizes command failures through its fixed error channel',async()=>{
 const writes=[],failures=[];
 assert.equal(await run(['--inventory'],{inventory:async()=>{throw Error('private detail');},
  write:value=>writes.push(value),fail:value=>failures.push(value)}),1);
 assert.deepEqual(writes,[]);
 assert.deepEqual(failures,['FACTORY_RUN_FAILED']);
});

test('standalone synthetic smoke remains runnable without telemetry configuration',async()=>{
 const script='C:/synthetic/engineering-factory/run.mjs';let exitCode;
 const invoked=await runCliIfDirect(script,pathToFileURL(script).href,['--smoke'],value=>{exitCode=value;});
 assert.equal(invoked,true);
 assert.equal(exitCode,0);
 let calls=0;
 assert.equal(await runCliIfDirect(script,pathToFileURL('C:/other/run.mjs').href,['--smoke'],()=>{calls++;}),false);
 assert.equal(calls,0);
});

test('native planner capacity denials report blocked quota without changing CLI results',async()=>{
 const measured=[],output=[];
 const observe=createSignals({
  meter:{createCounter:()=>({add:(_value,attrs)=>measured.push(attrs)}),
   createHistogram:()=>({record(){}})},
  tracer:{startSpan:()=>({setAttributes(){},end(){}})}
 });
 const base={enabled:true,stop:false,capacity:2,quotaVerified:true,
  tasks:[{id:1,priority:0,state:'approved',dependencies:[],paths:['src/api']}]};
 for(const overrides of [{quotaVerified:false},{quotaVerified:undefined},{capacity:0},{capacity:51},{capacity:undefined}]){
  const actual=plan({...base,...overrides});
  assert.equal(actual.reason,'CAPACITY_UNKNOWN');
  assert.equal(await run(['--smoke'],{replay:()=>plan({...base,...overrides}),observe,
   write:value=>output.push(JSON.parse(value)),fail:assert.fail}),1);
  assert.deepEqual(output.at(-1),{mode:'synthetic',...actual,liveDispatch:false,liveMerge:false});
  assert.deepEqual(measured.at(-1),{stage:'evaluate',outcome:'blocked',reason:'QUOTA'});
 }
 assert.equal(measured.length,5);
 assert.equal(JSON.stringify(measured).includes('CAPACITY_UNKNOWN'),false);
});

test('runner emits sanitized laptop-free receipts across commands without requiring an OTLP collector',async()=>{
 let now=5000;
 const clock=()=>{now+=15;return now;};
 const hostedEnv={
  GITHUB_ACTIONS:'true',
  RUNNER_ENVIRONMENT:'github-hosted',
  GITHUB_REPOSITORY_ID:'1471342715',
  GITHUB_RUN_ID:'778899',
  GITHUB_RUN_ATTEMPT:'2',
  GITHUB_ACTOR:'private-actor-name',
  COPILOT_GITHUB_TOKEN:'github_pat_secret123'
 };
 const smokeOut=[],hostedPullOut=[],localIssueOut=[],inventoryOut=[];
 assert.equal(await run(['--receipt'],{clock,env:hostedEnv,write:v=>smokeOut.push(JSON.parse(v))}),0);
 assert.equal(smokeOut[0].schemaVersion,1);
 assert.equal(smokeOut[0].valid,true);
 assert.equal(smokeOut[0].source,'synthetic');
 assert.equal(smokeOut[0].receiptId,'gh-778899-2-smoke');
 assert.equal(smokeOut[0].stage,'evaluate');
 assert.equal(smokeOut[0].outcome,'eligible');
 assert.equal(smokeOut[0].reason,'NONE');
 assert.equal(smokeOut[0].durationMs,15);
 assert.deepEqual(smokeOut[0].cost,{state:'unknown',verified:false,currency:null,amountMicros:null});

 const pullResult={
  shadow:true,evidenceComplete:false,reconciled:false,reason:'PROTECTIONS_UNVERIFIED',
  head:'a'.repeat(40),privateBody:'raw pr body'
 };
 assert.equal(await run(['--reconcile-pull','--receipt'],{
  clock,env:hostedEnv,reconcile:async()=>pullResult,
  cost:{verified:true,currency:'USD',amountMicros:0},
  humanTouches:{verified:true,count:0},
  write:v=>hostedPullOut.push(JSON.parse(v))
 }),0);
 assert.equal(hostedPullOut[0].valid,true);
 assert.equal(hostedPullOut[0].source,'github-hosted');
 assert.equal(hostedPullOut[0].receiptId,'gh-778899-2-reconcile-pull');
 assert.equal(hostedPullOut[0].outcome,'blocked');
 assert.equal(hostedPullOut[0].reason,'SECURITY');
 assert.deepEqual(hostedPullOut[0].cost,{state:'verified-zero',verified:true,currency:'USD',amountMicros:0});
 assert.deepEqual(hostedPullOut[0].humanTouches,{state:'verified',verified:true,count:0});
 const pullJson=JSON.stringify(hostedPullOut[0]);
 for(const leak of ['private-actor-name','github_pat_secret123','raw pr body','a'.repeat(40),'PROTECTIONS_UNVERIFIED'])
  assert.equal(pullJson.includes(leak),false);

 assert.equal(await run(['--receipt','--reconcile-issue'],{
  clock,env:{},receiptId:'local-reconcile-issue-fixed',
  reconcileIssue:async()=>({shadow:true,reconciled:false,reason:'LEASE_HELD'}),
  write:v=>localIssueOut.push(JSON.parse(v))
 }),0);
 assert.equal(localIssueOut[0].source,'synthetic');
 assert.equal(localIssueOut[0].receiptId,'local-reconcile-issue-fixed');
 assert.equal(localIssueOut[0].outcome,'blocked');
 assert.equal(localIssueOut[0].reason,'LEASE');
 assert.deepEqual(receiptStageRows(localIssueOut[0]),receiptStageRows(localIssueOut[0]));

 // Repeated local runs receive distinct IDs even at identical timestamps and aggregate without DUPLICATE_EVIDENCE
 const localSamples=[];
 for(let i=0;i<5;i++){
  let sampleTick=0;
  assert.equal(await run(['--inventory','--receipt'],{
   clock:()=>(sampleTick++===0?1000:1010+i),
   env:{},
   inventory:async()=>({shadow:true,issues:[9],pulls:[],evidenceComplete:false,liveDispatch:false,liveMerge:false}),
   write:v=>localSamples.push(JSON.parse(v))
  }),0);
 }
 assert.equal(new Set(localSamples.map(r=>r.receiptId)).size,5);
 const localRows=localSamples.flatMap(r=>receiptStageRows(r).rows);
 assert.deepEqual(aggregateStage(localRows,{
  repositoryId:1471342715,stage:'reconcile',from:1000,to:2000,
  complete:true,source:'synthetic',observedMs:2000,nowMs:2100,maxAgeMs:5000
 }),{state:'synthetic',reason:'MEASURED_FIXTURE',sampleCount:5,p50:12,p95:14});

 const sideReceipts=[];
 assert.equal(await run(['--inventory'],{
  clock,
  env:{GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY_ID:'1471342715',GITHUB_RUN_ID:'101'},
  inventory:async()=>({shadow:true,issues:[9],pulls:[],evidenceComplete:false,liveDispatch:false,liveMerge:false}),
  write:v=>inventoryOut.push(JSON.parse(v)),
  writeReceipt:r=>{sideReceipts.push(r);throw Error('sink failure ignored');}
 }),0);
 assert.deepEqual(inventoryOut[0].issues,[9]);
 assert.equal(sideReceipts.length,1);
 assert.equal(sideReceipts[0].receiptId,'gh-101-1-inventory');
 assert.equal(sideReceipts[0].source,'github-hosted');

 // Maximum supported readInventory capacity (499 issues + 499 pulls) produces a valid receipt
 const maxInventoryReceipts=[];
 assert.equal(await run(['--inventory','--receipt'],{
  clock,env:hostedEnv,
  inventory:async()=>({
   shadow:true,
   repository:'Jamula/SoftwareFactory',
   issues:Array.from({length:499},(_,i)=>i+1),
   pulls:Array.from({length:499},(_,i)=>i+1001),
   evidenceComplete:false,
   liveDispatch:false,
   liveMerge:false
  }),
  write:v=>maxInventoryReceipts.push(JSON.parse(v))
 }),0);
 assert.equal(maxInventoryReceipts[0].valid,true);

 // Self-hosted or untrusted hosted env, clock failure, and command throws fail closed without leaking details
 for(const badEnv of [
  {GITHUB_ACTIONS:'true',GITHUB_REPOSITORY_ID:'1471342715',GITHUB_RUN_ID:'101'},
  {GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'self-hosted',GITHUB_REPOSITORY_ID:'1471342715',GITHUB_RUN_ID:'101'},
  {GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY_ID:'999',GITHUB_RUN_ID:'101'},
  {GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY_ID:'1471342715',GITHUB_RUN_ID:'bad_id'},
  {GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY_ID:'1471342715',GITHUB_RUN_ID:'101',GITHUB_RUN_ATTEMPT:'0'}
 ]){
  const badHosted=[];
  assert.equal(await run(['--reconcile-pull','--receipt'],{
   clock,env:badEnv,
   reconcile:async()=>({shadow:true,reconciled:true,reason:'PULL_IDENTITY_MATCHED'}),
   write:v=>badHosted.push(JSON.parse(v))
  }),1);
  assert.equal(badHosted[0].valid,false);
 }

 let calls=0;
 const reversedReceipts=[];
 assert.equal(await run(['--smoke','--receipt'],{
  clock:()=>(++calls===1?100:50),env:{},
  replay:()=>({shadow:true,ready:[1],reason:'SHADOW_PLAN'}),
  write:v=>reversedReceipts.push(JSON.parse(v)),
  writeReceipt:()=>{}
 }),1);
 assert.equal(reversedReceipts[0].valid,true);
 assert.equal(reversedReceipts[0].durationMs,null);

 const brokenClockReceipts=[];
 assert.equal(await run(['--smoke','--receipt'],{
  clock:()=>{throw Error('clock broken');},env:{},
  write:v=>brokenClockReceipts.push(JSON.parse(v))
 }),1);
 assert.equal(brokenClockReceipts[0].valid,false);

 const failedWrites=[],failedStderr=[],failedSide=[];
 assert.equal(await run(['--inventory','--receipt'],{
  clock,env:hostedEnv,
  inventory:async()=>{throw Error('secret stack trace');},
  write:v=>failedWrites.push(JSON.parse(v)),
  fail:v=>failedStderr.push(v),
  writeReceipt:r=>{failedSide.push(r);throw Error('sink failure');}
 }),1);
 assert.equal(failedWrites[0].outcome,'failed');
 assert.equal(failedWrites[0].reason,'RUNTIME');
 assert.equal(JSON.stringify(failedWrites[0]).includes('secret stack trace'),false);
 assert.deepEqual(failedStderr,['FACTORY_RUN_FAILED']);
 assert.equal(failedSide.length,1);

 const sideOnlyFailed=[],sideOnlyStderr=[];
 assert.equal(await run(['--inventory'],{
  clock,env:null,
  inventory:async()=>{throw Error('secret stack trace');},
  write:assert.fail,
  fail:v=>sideOnlyStderr.push(v),
  writeReceipt:r=>sideOnlyFailed.push(r)
 }),1);
 assert.equal(sideOnlyFailed[0].outcome,'failed');
 assert.deepEqual(sideOnlyStderr,['FACTORY_RUN_FAILED']);

 // Output-sink failure during --receipt is guarded, notifies writeReceipt, and exits 1 via fail channel
 const sinkThrowSide=[],sinkThrowStderr=[];
 assert.equal(await run(['--inventory','--receipt'],{
  clock,env:hostedEnv,
  inventory:async()=>({shadow:true,issues:[1],pulls:[],evidenceComplete:false,liveDispatch:false,liveMerge:false}),
  write:()=>{throw Error('stdout pipe closed');},
  fail:v=>sinkThrowStderr.push(v),
  writeReceipt:r=>sinkThrowSide.push(r)
 }),1);
 assert.equal(sinkThrowSide.length,1);
 assert.equal(sinkThrowSide[0].outcome,'failed');
 assert.equal(sinkThrowSide[0].reason,'RUNTIME');
 assert.equal(JSON.stringify(sinkThrowSide).includes('stdout pipe closed'),false);
 assert.deepEqual(sinkThrowStderr,['FACTORY_RUN_FAILED']);

 for(const invalidArgs of [['--receipt','--receipt'],['--smoke','--inventory','--receipt'],['--receipt','--unknown']]){
  const errs=[];
  assert.equal(await run(invalidArgs,{fail:v=>errs.push(v),write:assert.fail}),2);
  assert.match(errs[0],/^Usage:/);
 }
});

test('unified subcommands, parameterized repositoryId, and bounded JSON input enforce fail-closed contracts and receipts',async()=>{
 const {
  DEFAULT_REPOSITORY_ID,
  MAX_INPUT_UTF8_BYTES,
  evaluateProtectedSquash
 }=await import('../../tools/engineering-factory/run.mjs');
 const {M01_STRUCTURAL_PREREQUISITES}=await import('../../tools/engineering-factory/pilot-readiness.mjs');

 assert.equal(DEFAULT_REPOSITORY_ID,1471342715);
 assert.equal(MAX_INPUT_UTF8_BYTES,262_144);

 let now=10_000;
 const clock=()=>{now+=10;return now;};
 const nowMs=1_764_200_000_000;
 const workflowSha='a'.repeat(40);
 const baseSha='b'.repeat(40);

 // 1. --reconcile-event strips internal snapshot on stdout and maps receipts cleanly
 const eventEnv={
  GITHUB_ACTIONS:'true',
  RUNNER_ENVIRONMENT:'github-hosted',
  GITHUB_EVENT_NAME:'push',
  GITHUB_REPOSITORY_ID:'1471342715',
  GITHUB_REF:'refs/heads/main',
  GITHUB_WORKFLOW_REF:'Jamula/SoftwareFactory/.github/workflows/shadow-reconcile.yml@refs/heads/main',
  GITHUB_REF_PROTECTED:'true',
  GITHUB_WORKFLOW_SHA:workflowSha,
  GITHUB_SHA:workflowSha,
  FACTORY_CHECKOUT_SHA:workflowSha,
  FACTORY_MAIN_HEAD:workflowSha,
  GITHUB_RUN_ID:'556677'
 };
 const eventRequest=async url=>{
  if(url.endsWith('/repos/Jamula/SoftwareFactory')) {
   return new Response(JSON.stringify({id:1471342715,full_name:'Jamula/SoftwareFactory',fork:false}));
  }
  return new Response(JSON.stringify({name:'main',protected:true,commit:{sha:workflowSha}}));
 };
 const eventOut=[],eventReceiptOut=[];
 assert.equal(await run(['--reconcile-event'],{
  clock:()=>nowMs,
  env:eventEnv,
  reconcileEvent:(env,opts)=>import('../../tools/engineering-factory/event-envelope.mjs')
   .then(m=>m.reconcileEventTrigger(env,{...opts,clock:()=>nowMs,request:eventRequest})),
  write:v=>eventOut.push(JSON.parse(v))
 }),0);
 assert.equal(eventOut[0].reconciled,true);
 assert.equal(eventOut[0].reason,'SHADOW_RECONCILED');
 assert.equal('snapshot' in eventOut[0],false);

 assert.equal(await run(['--reconcile-event','--receipt'],{
  clock,
  env:eventEnv,
  input:{owner:'gh-aw-worker',leaseMs:15000},
  reconcileEvent:async(_env,opts)=>{
   assert.equal(opts.owner,'gh-aw-worker');
   return {shadow:true,evidenceComplete:false,reconciled:false,reason:'CLAIM_PENDING',snapshot:{nonPlain:()=>1}};
  },
  write:v=>eventReceiptOut.push(JSON.parse(v))
 }),0);
 assert.equal(eventReceiptOut[0].valid,true);
 assert.equal(eventReceiptOut[0].stage,'reconcile');
 assert.equal(eventReceiptOut[0].outcome,'blocked');
 assert.equal(eventReceiptOut[0].reason,'LEASE');

 // Non-plain or non-JSON fields outside snapshot fail closed in --reconcile-event
 for(const badEventReturn of [null,[],Object.create({}),{reason:'SHADOW_RECONCILED',bad:()=>1}]){
  const sanitized=[];
  assert.equal(await run(['--reconcile-event'],{
   env:{},
   reconcileEvent:async()=>badEventReturn,
   write:v=>sanitized.push(JSON.parse(v))
  }),0);
  assert.equal(sanitized[0].reason,'READ_FAILED');
 }
 const badEventInput=[];
 assert.equal(await run(['--reconcile-event'],{
  env:{},
  input:{disallowedKey:true},
  write:v=>badEventInput.push(JSON.parse(v))
 }),0);
 assert.equal(badEventInput[0].reason,'EVIDENCE_UNKNOWN');

 // 2. --plan-lanes invokes planner.mjs and normalizes output + receipts
 const validConfig={
  schemaVersion:1,
  project:{key:'sf',repository:'Jamula/SoftwareFactory',defaultBranch:'main'},
  execution:{mode:'shadow',enabled:true,stop:false},
  limits:{maxConcurrentLanes:2,leaseMs:30000,maxAttempts:3,baseDelayMs:100,maxDelayMs:1000},
  adapters:{workTracker:'mock',engineeringAgent:'mock',state:'sqlite'},
  lanes:[
   {id:'admission',owners:['tools/engineering-factory'],prompt:'prompts/factory.md'},
   {id:'docs',owners:['docs'],prompt:'prompts/docs.md'}
  ]
 };
 const planInput={
  config:validConfig,
  tasks:[
   {id:7,lane:'admission',state:'approved',priority:0,dependencies:[],paths:['tools/engineering-factory/cloud-agent-admission.mjs']},
   {id:8,lane:'docs',state:'approved',priority:1,dependencies:[],paths:['docs/CLOUD-AGENT-ADMISSION.md']}
  ]
 };
 const planOut=[],planReceiptOut=[],badPlanOut=[];
 assert.equal(await run(['--plan-lanes'],{
  env:{FACTORY_INPUT_JSON:JSON.stringify(planInput)},
  write:v=>planOut.push(JSON.parse(v))
 }),0);
 assert.equal(planOut[0].reason,'SHADOW_PLAN');
 assert.equal(planOut[0].liveDispatch,false);
 assert.equal(planOut[0].scheduled.length,2);

 assert.equal(await run(['--plan-lanes','--receipt'],{
  clock,
  env:eventEnv,
  input:planInput,
  write:v=>planReceiptOut.push(JSON.parse(v))
 }),0);
 assert.equal(planReceiptOut[0].valid,true);
 assert.equal(planReceiptOut[0].stage,'evaluate');
 assert.equal(planReceiptOut[0].outcome,'eligible');
 assert.equal(planReceiptOut[0].reason,'NONE');

 for(const invalidPlanInput of [undefined,{config:validConfig},{config:validConfig,tasks:[],extra:1}]){
  assert.equal(await run(['--plan-lanes'],{
   env:{},
   ...(invalidPlanInput===undefined?{}:{input:invalidPlanInput}),
   write:v=>badPlanOut.push(JSON.parse(v))
  }),0);
  assert.equal(badPlanOut.at(-1).reason,'INVALID_TASKS');
 }
 const invalidCfgOut=[];
 assert.equal(await run(['--plan-lanes'],{
  env:{},input:{config:null,tasks:[]},
  plan:()=>assert.fail('must not call plan on invalid config'),
  write:v=>invalidCfgOut.push(JSON.parse(v))
 }),0);
 assert.equal(invalidCfgOut[0].reason,'INVALID_PROJECT_CONFIG');
 assert.deepEqual(invalidCfgOut[0].ready,[]);

 // --plan-lanes enforces repository match and execution.enabled/stop gates BEFORE calling planLanes
 for(const [badExec,expectedReason] of [
  [{...validConfig,project:{...validConfig.project,repository:'Synthetic/FamilyTree'}},'PROVENANCE_MISMATCH'],
  [{...validConfig,execution:{...validConfig.execution,stop:true}},'STOPPED'],
  [{...validConfig,execution:{...validConfig.execution,enabled:false}},'STOPPED']
 ]){
  const out=[],rcpt=[];
  assert.equal(await run(['--plan-lanes'],{
   env:{},input:{config:badExec,tasks:planInput.tasks},
   plan:()=>assert.fail('must not invoke plan when repository mismatches or execution is stopped'),
   write:v=>out.push(JSON.parse(v))
  }),0);
  assert.equal(out[0].reason,expectedReason);
  assert.deepEqual(out[0].ready,[]);
  assert.deepEqual(out[0].scheduled,[]);

  assert.equal(await run(['--plan-lanes','--receipt'],{
   clock,env:eventEnv,input:{config:badExec,tasks:planInput.tasks},
   plan:()=>assert.fail('must not invoke plan when repository mismatches or execution is stopped'),
   write:v=>rcpt.push(JSON.parse(v))
  }),0);
  assert.equal(rcpt[0].valid,true);
  assert.equal(rcpt[0].outcome,'blocked');
  assert.equal(rcpt[0].reason,expectedReason==='STOPPED'?'POLICY':'SECURITY');
 }

 const customPlanNorm=[];
 assert.equal(await run(['--plan-lanes'],{
  env:{},input:{config:validConfig,tasks:[]},
  plan:async()=>({shadow:true,scheduled:[{id:1,lane:'docs',paths:['docs']}]}),
  write:v=>customPlanNorm.push(JSON.parse(v))
 }),0);
 assert.equal(customPlanNorm[0].reason,'SHADOW_PLAN');
 assert.equal(await run(['--plan-lanes'],{
  env:{},input:{config:validConfig,tasks:[]},
  plan:async()=>({shadow:true}),
  write:v=>customPlanNorm.push(JSON.parse(v))
 }),0);
 assert.equal(customPlanNorm[1].reason,'NO_READY_WORK');
 assert.equal(await run(['--plan-lanes'],{
  env:{},input:{config:validConfig,tasks:[]},
  plan:async()=>null,
  write:v=>customPlanNorm.push(JSON.parse(v))
 }),0);
 assert.equal(customPlanNorm[2].reason,'INVALID_TASKS');

 // 3. --evaluate-squash invokes protected-squash.mjs guardedSquashEvidence
 const reviewer='copilot-pull-request-reviewer[bot]';
 const checks=['build-test','upload-coverage-javascript','windows-aspire-runtime','CodeQL']
  .map((name,i)=>({name,appId:i+1}));
 const squashIntent={
  repository:'Jamula/SoftwareFactory',repositoryId:1471342715,branch:'main',
  number:42,expectedHead:workflowSha,expectedBase:baseSha
 };
 const squashEvidence={
  repository:'Jamula/SoftwareFactory',repositoryId:1471342715,branch:'main',
  number:42,head:workflowSha,base:baseSha,
  open:true,draft:false,stop:false,scopeVerified:true,nativeQueue:false,
  protection:{
   repository:'Jamula/SoftwareFactory',repositoryId:1471342715,branch:'main',
   base:baseSha,verified:true,protected:true,bypass:false,method:'squash',
   upToDate:true,review:true,threads:true,security:true,requiredChecks:checks
  },
  policy:{
   version:1,repository:'Jamula/SoftwareFactory',defaultBranch:'main',mergeMethod:'squash',
   mode:'shadow',killSwitch:false,checks,reviewers:[reviewer],coverage:{line:98,branch:95},
   owners:[{prefix:'src',owner:'synthetic-owner'}],maxActive:1,creditLimit:5,riskClasses:['low']
  },
  snapshot:{
   repository:'Jamula/SoftwareFactory',policySource:'trusted-default-branch',pr:42,issue:7,
   head:workflowSha,base:baseSha,observedHead:workflowSha,observedBase:baseSha,baseBranch:'main',
   rateLimited:false,remainingCredits:1,activeCount:0,providerReady:true,risk:'low',priority:1,
   paths:['src/a.mjs'],dependencies:[],acceptanceComplete:true,baseCompatible:true,mainHealthy:true,
   author:'author',agent:'copilot-swe-agent[bot]',
   checks:checks.map(c=>({...c,head:workflowSha,status:'completed',conclusion:'success'}))
  },
  reviewHistory:[{sequence:1,reviewer,head:workflowSha,state:'COMMENTED',summaryDisposition:'clear'}],
  coverageReports:[{component:'core',head:workflowSha,lines:98,lineTotal:100,branches:95,branchTotal:100}],
  expectedComponents:['core'],
  threads:{head:workflowSha,resolved:true},
  security:{head:workflowSha,clear:true},
  platformReview:{head:workflowSha,complete:true,independent:true,summaryDisposition:'clear',findings:[]}
 };
 const squashOut=[],squashReceiptOut=[];
 assert.equal(await run(['--evaluate-squash'],{
  env:{},input:{intent:squashIntent,evidence:squashEvidence},
  write:v=>squashOut.push(JSON.parse(v))
 }),0);
 assert.equal(squashOut[0].reason,'SHADOW_SQUASH_ELIGIBLE');
 assert.equal(squashOut[0].liveMerge,false);

 assert.equal(await run(['--evaluate-squash','--receipt'],{
  clock,env:eventEnv,input:{intent:squashIntent,evidence:squashEvidence},
  write:v=>squashReceiptOut.push(JSON.parse(v))
 }),0);
 assert.equal(squashReceiptOut[0].valid,true);
 assert.equal(squashReceiptOut[0].stage,'merge-shadow');
 assert.equal(squashReceiptOut[0].outcome,'eligible');
 assert.equal(squashReceiptOut[0].reason,'NONE');
 assert.equal(evaluateProtectedSquash(null).reason,'INTENT_UNKNOWN');

 // 4. --verify-admission invokes cloud-agent-admission.mjs
 const meter={verified:true,paidOverageEnabled:false,overageHardStopUsdCents:0};
 const admissionInput={
  stop:false,
  repositoryId:1471342715,
  approvedRepositoryId:1471342715,
  repositoryVisibility:'private',
  personalPatInActionsSecrets:false,
  nowMs,
  model:{id:'gpt-5.4',allowlist:['gpt-5.4'],verifiedAvailable:true},
  harness:{kind:'copilot-cloud-automation',verified:true},
  billingEntitlement:{
   entitlementVerified:true,
   includedOnly:true,
   incrementalBilledUsdCents:0,
   meters:{aiCredits:meter,copilotPremiumRequests:meter,cloudSandboxesAndActions:meter},
   accounting:{
    accountingSource:'verified',
    isEstimated:false,
    observedAtMs:nowMs-1000,
    remainingIncludedAiCredits:500,
    remainingIncludedPremiumRequests:20,
    dailyAiCreditsUsed:10,
    runAiCreditsRequired:20,
    premiumRequestsRequired:1
   },
   ghAwCaps:{maxAiCredits:50,maxDailyAiCredits:200}
  },
  runner:{kind:'cloud-sandbox',verified:true,ephemeral:true,isolated:true},
  workerPool:{
   requestedWorkers:2,
   verifiedPriorWorkerTier:1,
   repoConcurrencyCap:4,
   verifiedWorkerCeiling:4,
   remainingIncludedSlots:4,
   reservations:[]
  },
  candidate:{
   issue:7,pr:null,lane:'admission',paths:['tools/engineering-factory/cloud-agent-admission.mjs'],
   leaseGeneration:1,leaseExpiresAtMs:nowMs+60000
  }
 };
 const admOut=[],admReceiptOut=[],admDeniedReceipt=[];
 assert.equal(await run(['--verify-admission'],{
  env:{},input:JSON.stringify(admissionInput),
  write:v=>admOut.push(JSON.parse(v))
 }),0);
 assert.equal(admOut[0].admitted,true);
 assert.equal(admOut[0].reason,'SHADOW_ALLOCATION');

 assert.equal(await run(['--verify-admission','--receipt'],{
  clock,env:eventEnv,input:admissionInput,
  write:v=>admReceiptOut.push(JSON.parse(v))
 }),0);
 assert.equal(admReceiptOut[0].valid,true);
 assert.equal(admReceiptOut[0].stage,'dispatch');
 assert.equal(admReceiptOut[0].outcome,'eligible');
 assert.equal(admReceiptOut[0].reason,'NONE');

 assert.equal(await run(['--verify-admission','--receipt'],{
  clock,env:eventEnv,
  input:{...admissionInput,repositoryVisibility:'public'},
  write:v=>admDeniedReceipt.push(JSON.parse(v))
 }),0);
 assert.equal(admDeniedReceipt[0].valid,true);
 assert.equal(admDeniedReceipt[0].outcome,'blocked');
 assert.equal(admDeniedReceipt[0].reason,'QUOTA');

 // 5. --verify-m01-readiness maps M01_EXIT_EVIDENCE_READY_ONLY and denial reasons cleanly for receipts
 const m01Prereqs=Object.fromEntries(M01_STRUCTURAL_PREREQUISITES.map(k=>[k,true]));
 const makeCycle=(n,extra={})=>({
  repositoryId:1471342715,issue:n,pr:100+n,head:String(n).repeat(40),reviewedHead:String(n).repeat(40),
  reviewIndependent:true,checksPassed:true,securityClear:true,threadsResolved:true,
  coverageReports:[{component:'core',head:String(n).repeat(40),lines:98,lineTotal:100,branches:19,branchTotal:20}],
  mainVerified:true,costVerified:true,extraCost:0,humanInterventions:0,unauthorizedWrites:0,
  duplicateDispatches:0,startedAt:0,eligibleAt:10,mergedAt:10+n*1000,
  reviewFix:n===1,parallelCandidate:n===2,acceptanceVerified:true,gateBypasses:0,...extra
 });
 const m01Input={
  policy:{repositoryId:1471342715,pin:'c'.repeat(40),lineMin:98,branchMin:95,firstPilot:true},
  readiness:{
   repositoryId:1471342715,pin:'c'.repeat(40),enrolled:true,stop:false,upstreamAccepted:false,
   review:true,coverageLine:99,coverageBranch:96,requiredChecks:true,quotaVerified:true,
   rollbackVerified:true,securityClear:true
  },
  ...m01Prereqs,
  cycles:[makeCycle(1),makeCycle(2),makeCycle(3)],
  expectedComponents:['core'],
  actualWorkerMax:4,
  workerShortfallFrom12:8
 };
 const m01Out=[],m01ReceiptOut=[],m01BlockedReceipt=[];
 assert.equal(await run(['--verify-m01-readiness'],{
  env:{},input:m01Input,
  write:v=>m01Out.push(JSON.parse(v))
 }),0);
 assert.equal(m01Out[0].ready,true);
 assert.equal(m01Out[0].reason,'M01_EXIT_EVIDENCE_READY_ONLY');

 assert.equal(await run(['--verify-m01-readiness','--receipt'],{
  clock,env:eventEnv,input:m01Input,
  write:v=>m01ReceiptOut.push(JSON.parse(v))
 }),0);
 assert.equal(m01ReceiptOut[0].valid,true);
 assert.equal(m01ReceiptOut[0].stage,'acceptance');
 assert.equal(m01ReceiptOut[0].outcome,'eligible');
 assert.equal(m01ReceiptOut[0].reason,'NONE');

 assert.equal(await run(['--verify-m01-readiness','--receipt'],{
  clock,env:eventEnv,input:{...m01Input,hardStopBillingVerified:false},
  write:v=>m01BlockedReceipt.push(JSON.parse(v))
 }),0);
 assert.equal(m01BlockedReceipt[0].valid,true);
 assert.equal(m01BlockedReceipt[0].outcome,'blocked');
 assert.equal(m01BlockedReceipt[0].reason,'INVALID_EVIDENCE');

 assert.equal(await run(['--verify-m01-readiness','--receipt'],{
  clock,env:eventEnv,input:{...m01Input,readiness:{...m01Input.readiness,stop:true}},
  write:v=>m01BlockedReceipt.push(JSON.parse(v))
 }),0);
 assert.equal(m01BlockedReceipt[1].outcome,'blocked');
 assert.equal(m01BlockedReceipt[1].reason,'POLICY');

 // 6. Parameterized repositoryId, --inventory guard, consumer --plan-lanes, and end-to-end consumer reconcile
 const consumerRepoId=200036;
 const consumerRepoName='Synthetic/FamilyTree';
 const consumerScope={
  repository:consumerRepoName,
  repositoryId:consumerRepoId,
  branch:'main',
  workflowPath:'.github/workflows/shadow-reconcile.yml'
 };
 const consumerHostedEnv={
  GITHUB_ACTIONS:'true',
  RUNNER_ENVIRONMENT:'github-hosted',
  FACTORY_EXPECTED_REPO_ID:String(consumerRepoId),
  GITHUB_REPOSITORY_ID:String(consumerRepoId),
  GITHUB_RUN_ID:'889900',
  GITHUB_RUN_ATTEMPT:'1'
 };
 const consumerReceipts=[];
 assert.equal(await run(['--verify-admission','--receipt'],{
  clock,
  env:consumerHostedEnv,
  input:{...admissionInput,repositoryId:consumerRepoId,approvedRepositoryId:consumerRepoId},
  write:v=>consumerReceipts.push(JSON.parse(v))
 }),0);
 assert.equal(consumerReceipts[0].valid,true);
 assert.equal(consumerReceipts[0].source,'github-hosted');
 assert.equal(consumerReceipts[0].repositoryId,consumerRepoId);

 // --inventory fails closed for non-SoftwareFactory repository bindings unless a scoped reader returns matching repositoryId
 const invBlockedOut=[],invBlockedReceipt=[];
 assert.equal(await run(['--inventory'],{
  repositoryId:consumerRepoId,env:{},write:v=>invBlockedOut.push(JSON.parse(v))
 }),1);
 assert.equal(invBlockedOut[0].reason,'PROVENANCE_MISMATCH');

 assert.equal(await run(['--inventory','--receipt'],{
  clock,env:consumerHostedEnv,write:v=>invBlockedReceipt.push(JSON.parse(v))
 }),1);
 assert.equal(invBlockedReceipt[0].valid,true);
 assert.equal(invBlockedReceipt[0].outcome,'blocked');
 assert.equal(invBlockedReceipt[0].reason,'SECURITY');

 for(const badConsumerInv of [
  null,
  {shadow:true,repository:'Jamula/SoftwareFactory',issues:[1],pulls:[]},
  {shadow:true,repositoryId:1471342715,issues:[1],pulls:[]},
  {shadow:true,repositoryId:consumerRepoId,repository:'Jamula/SoftwareFactory',issues:[1],pulls:[]},
  {shadow:true,repositoryId:consumerRepoId,repository:'Other/Repo',issues:[1],pulls:[]}
 ]){
  assert.equal(await run(['--inventory'],{
   repositoryId:consumerRepoId,repository:consumerRepoName,env:{},
   inventory:async()=>badConsumerInv,write:()=>{}
  }),1);
 }
 const validConsumerInv=[];
 assert.equal(await run(['--inventory'],{
  repositoryId:consumerRepoId,repository:consumerRepoName,env:{},
  inventory:async sc=>({
   shadow:true,repository:sc.repository,repositoryId:sc.repositoryId,
   issues:[10],pulls:[11],evidenceComplete:false,liveDispatch:false,liveMerge:false
  }),
  write:v=>validConsumerInv.push(JSON.parse(v))
 }),0);
 assert.equal(validConsumerInv[0].repositoryId,consumerRepoId);
 assert.equal(await run(['--inventory'],{
  env:{},inventory:async()=>({shadow:true,repository:'Other/Repo',issues:[],pulls:[]}),write:()=>{}
 }),1);
 assert.equal(await run(['--inventory'],{
  env:{},inventory:async()=>({shadow:true,repositoryId:consumerRepoId,issues:[],pulls:[]}),write:()=>{}
 }),1);

 // Consumer --plan-lanes requires explicit trusted repository slug matching GITHUB_REPOSITORY and config.project.repository
 const consumerPlanConfig={...validConfig,project:{...validConfig.project,repository:consumerRepoName}};
 const consumerPlanMissingRepo=[];
 assert.equal(await run(['--plan-lanes'],{
  repositoryId:consumerRepoId,env:{},input:{config:consumerPlanConfig,tasks:planInput.tasks},
  write:v=>consumerPlanMissingRepo.push(JSON.parse(v))
 }),0);
 assert.equal(consumerPlanMissingRepo[0].reason,'PROVENANCE_MISMATCH');

 const consumerPlanGhMismatch=[];
 assert.equal(await run(['--plan-lanes'],{
  repositoryId:consumerRepoId,repository:consumerRepoName,
  env:{GITHUB_ACTIONS:'true'},
  input:{config:consumerPlanConfig,tasks:planInput.tasks},
  write:v=>consumerPlanGhMismatch.push(JSON.parse(v))
 }),0);
 assert.equal(consumerPlanGhMismatch[0].reason,'PROVENANCE_MISMATCH');

 const consumerPlanOk=[];
 assert.equal(await run(['--plan-lanes','--receipt'],{
  clock,
  env:{
   ...consumerHostedEnv,
   FACTORY_EXPECTED_REPOSITORY:consumerRepoName,
   GITHUB_REPOSITORY:consumerRepoName
  },
  input:{config:consumerPlanConfig,tasks:planInput.tasks},
  write:v=>consumerPlanOk.push(JSON.parse(v))
 }),0);
 assert.equal(consumerPlanOk[0].valid,true);
 assert.equal(consumerPlanOk[0].repositoryId,consumerRepoId);
 assert.equal(consumerPlanOk[0].outcome,'eligible');

 // Incomplete consumer scope fails closed with TRUST_UNKNOWN across reconcile commands
 for(const cmd of ['--reconcile-pull','--reconcile-issue','--reconcile-event']){
  const incomplete=[];
  assert.equal(await run([cmd],{
   repositoryId:consumerRepoId,env:{},
   write:v=>incomplete.push(JSON.parse(v))
  }),0);
  assert.equal(incomplete[0].reason,'TRUST_UNKNOWN');
 }
 for(const badScopeInput of [
  {scope:'not-object'},
  {branch:'bad..branch'},
  {repository:'Conflicting/Repo'}
 ]){
  const badEvt=[];
  assert.equal(await run(['--reconcile-event'],{
   scope:consumerScope,env:{},input:badScopeInput,
   write:v=>badEvt.push(JSON.parse(v))
  }),0);
  assert.equal(['TRUST_UNKNOWN','PROVENANCE_MISMATCH'].includes(badEvt[0].reason),true);
 }
 const unconfiguredGhRepoMismatch=[];
 assert.equal(await run(['--reconcile-event'],{
  repositoryId:consumerRepoId,
  env:{GITHUB_REPOSITORY:'Other/Repo'},
  input:{scope:consumerScope},
  write:v=>unconfiguredGhRepoMismatch.push(JSON.parse(v))
 }),0);
 assert.equal(unconfiguredGhRepoMismatch[0].reason,'PROVENANCE_MISMATCH');

 // End-to-end REAL reconcilePullTrigger, reconcileIssueTrigger, and reconcileEventTrigger for consumer 200036
 const consumerWorkflowRef=`${consumerRepoName}/.github/workflows/shadow-reconcile.yml@refs/heads/main`;
 const consumerBaseEnv={
  GITHUB_ACTIONS:'true',
  RUNNER_ENVIRONMENT:'github-hosted',
  GITHUB_REPOSITORY:consumerRepoName,
  GITHUB_REPOSITORY_ID:String(consumerRepoId),
  FACTORY_EXPECTED_REPOSITORY:consumerRepoName,
  FACTORY_EXPECTED_REPO_ID:String(consumerRepoId),
  FACTORY_EXPECTED_BRANCH:'main',
  FACTORY_EXPECTED_WORKFLOW_PATH:'.github/workflows/shadow-reconcile.yml',
  GITHUB_WORKFLOW_REF:consumerWorkflowRef,
  GITHUB_REF_PROTECTED:'true',
  GITHUB_WORKFLOW_SHA:workflowSha,
  GITHUB_SHA:workflowSha,
  FACTORY_CHECKOUT_SHA:workflowSha,
  GITHUB_RUN_ID:'770011'
 };
 const consumerMockFetch=async url=>{
  if(url===`https://api.github.com/repos/${consumerRepoName}/pulls/19`) {
   return new Response(JSON.stringify({
    number:19,state:'open',draft:false,
    head:{sha:baseSha,repo:{id:consumerRepoId,full_name:consumerRepoName}},
    base:{ref:'main',sha:workflowSha,repo:{id:consumerRepoId,full_name:consumerRepoName}}
   }));
  }
  if(url===`https://api.github.com/repos/${consumerRepoName}/issues/23`) {
   return new Response(JSON.stringify({
    number:23,state:'open',
    repository_url:`https://api.github.com/repos/${consumerRepoName}`
   }));
  }
  if(url===`https://api.github.com/repos/${consumerRepoName}`) {
   return new Response(JSON.stringify({id:consumerRepoId,full_name:consumerRepoName,fork:false}));
  }
  if(url===`https://api.github.com/repos/${consumerRepoName}/branches/main`) {
   return new Response(JSON.stringify({name:'main',protected:true,commit:{sha:workflowSha}}));
  }
  throw new Error(`unexpected URL ${url}`);
 };

 const realPullOut=[],realIssueOut=[],realEventOut=[],realEventReceipt=[];
 assert.equal(await run(['--reconcile-pull'],{
  clock,
  request:consumerMockFetch,
  env:{
   ...consumerBaseEnv,
   GITHUB_EVENT_NAME:'pull_request_target',
   FACTORY_PULL_NUMBER:'19',
   FACTORY_PULL_HEAD:baseSha
  },
  write:v=>realPullOut.push(JSON.parse(v))
 }),0);
 assert.equal(realPullOut[0].reconciled,true);
 assert.equal(realPullOut[0].reason,'PULL_IDENTITY_MATCHED');
 assert.equal(realPullOut[0].repositoryId,consumerRepoId);

 assert.equal(await run(['--reconcile-issue'],{
  clock,
  request:consumerMockFetch,
  env:{
   ...consumerBaseEnv,
   GITHUB_EVENT_NAME:'issues',
   GITHUB_REF:'refs/heads/main',
   FACTORY_ISSUE_NUMBER:'23'
  },
  write:v=>realIssueOut.push(JSON.parse(v))
 }),0);
 assert.equal(realIssueOut[0].reconciled,true);
 assert.equal(realIssueOut[0].reason,'ISSUE_IDENTITY_MATCHED');
 assert.equal(realIssueOut[0].repositoryId,consumerRepoId);

 assert.equal(await run(['--reconcile-event'],{
  clock,
  scope:consumerScope,
  request:consumerMockFetch,
  input:{owner:'consumer-worker',leaseMs:20000},
  env:{
   ...consumerBaseEnv,
   GITHUB_EVENT_NAME:'issues',
   GITHUB_REF:'refs/heads/main',
   FACTORY_ISSUE_NUMBER:'23'
  },
  write:v=>realEventOut.push(JSON.parse(v))
 }),0);
 assert.equal(realEventOut[0].reconciled,true);
 assert.equal(realEventOut[0].reason,'SHADOW_RECONCILED');
 assert.equal(realEventOut[0].repositoryId,consumerRepoId);
 assert.equal('snapshot' in realEventOut[0],false);

 assert.equal(await run(['--reconcile-event','--receipt'],{
  clock,
  scope:consumerScope,
  request:consumerMockFetch,
  env:{
   ...consumerBaseEnv,
   GITHUB_EVENT_NAME:'push',
   GITHUB_REF:'refs/heads/main',
   FACTORY_MAIN_HEAD:workflowSha
  },
  write:v=>realEventReceipt.push(JSON.parse(v))
 }),0);
 assert.equal(realEventReceipt[0].valid,true);
 assert.equal(realEventReceipt[0].source,'github-hosted');
 assert.equal(realEventReceipt[0].repositoryId,consumerRepoId);

 const consumerSquashScope=[];
 assert.equal(await run(['--evaluate-squash'],{
  repositoryId:consumerRepoId,env:{},
  input:{
   intent:{repository:'Jamula/FamilyTree',repositoryId:consumerRepoId,branch:'main',number:1,expectedHead:workflowSha,expectedBase:baseSha},
   evidence:{}
  },
  evaluateSquash:(_i,_ev,sc)=>{consumerSquashScope.push(sc);return {shadow:true,liveMerge:false,dependentWorkAllowed:false,reason:'EVIDENCE_UNKNOWN'};},
  write:()=>{}
 }),0);
 assert.equal(consumerSquashScope[0].repositoryId,consumerRepoId);
 assert.equal(consumerSquashScope[0].branch,'main');

 assert.equal(await run(['--evaluate-squash'],{
  repositoryId:consumerRepoId,env:{},
  input:{
   intent:{repository:'Jamula/FamilyTree',repositoryId:consumerRepoId,number:1,expectedHead:workflowSha,expectedBase:baseSha},
   evidence:{}
  },
  evaluateSquash:(_i,_ev,sc)=>{consumerSquashScope.push(sc);return {shadow:true,liveMerge:false,dependentWorkAllowed:false,reason:'EVIDENCE_UNKNOWN'};},
  write:()=>{}
 }),0);
 assert.equal(consumerSquashScope[1].branch,undefined);

 // Explicit repositoryId mismatch against payload repositoryId fails closed
 const mismatchEvent=[],mismatchSquash=[],mismatchAdm=[],mismatchM01=[];
 assert.equal(await run(['--reconcile-event'],{
  repositoryId:consumerRepoId,env:{},input:{scope:{repositoryId:999}},
  write:v=>mismatchEvent.push(JSON.parse(v))
 }),0);
 assert.equal(mismatchEvent[0].reason,'PROVENANCE_MISMATCH');
 assert.equal(await run(['--reconcile-event'],{
  repositoryId:consumerRepoId,env:{},input:{repositoryId:999},
  write:v=>mismatchEvent.push(JSON.parse(v))
 }),0);
 assert.equal(mismatchEvent[1].reason,'PROVENANCE_MISMATCH');
 assert.equal(await run(['--evaluate-squash'],{
  repositoryId:consumerRepoId,env:{},
  input:{intent:squashIntent,evidence:squashEvidence,scope:{repository:'Jamula/SoftwareFactory',repositoryId:1471342715}},
  write:v=>mismatchSquash.push(JSON.parse(v))
 }),0);
 assert.equal(mismatchSquash[0].reason,'PROVENANCE_MISMATCH');
 assert.equal(await run(['--evaluate-squash'],{
  repositoryId:consumerRepoId,env:{},
  input:{intent:squashIntent,evidence:squashEvidence},
  write:v=>mismatchSquash.push(JSON.parse(v))
 }),0);
 assert.equal(mismatchSquash[1].reason,'PROVENANCE_MISMATCH');
 assert.equal(await run(['--verify-admission'],{
  repositoryId:consumerRepoId,env:{},input:admissionInput,
  write:v=>mismatchAdm.push(JSON.parse(v))
 }),0);
 assert.equal(mismatchAdm[0].reason,'PROVENANCE_MISMATCH');
 assert.equal(await run(['--verify-m01-readiness'],{
  repositoryId:consumerRepoId,env:{},input:m01Input,
  write:v=>mismatchM01.push(JSON.parse(v))
 }),0);
 assert.equal(mismatchM01[0].reason,'IDENTITY_OR_PIN');

 // Default repository binding (no options.repositoryId or FACTORY_EXPECTED_REPO_ID) also rejects
 // cross-repository 200036 payloads fail-closed across all subcommands with and without --receipt
 const defaultHostedEnv={
  GITHUB_ACTIONS:'true',
  RUNNER_ENVIRONMENT:'github-hosted',
  GITHUB_REPOSITORY_ID:'1471342715',
  GITHUB_RUN_ID:'991122',
  GITHUB_RUN_ATTEMPT:'1'
 };
 assert.equal(evaluateProtectedSquash({intent:squashIntent,evidence:squashEvidence},0).reason,'PROVENANCE_MISMATCH');

 const consumerSquashPayload={
  scope:{repository:'Jamula/FamilyTree',repositoryId:consumerRepoId,branch:'main'},
  intent:{...squashIntent,repository:'Jamula/FamilyTree',repositoryId:consumerRepoId},
  evidence:{
   ...squashEvidence,
   repository:'Jamula/FamilyTree',
   repositoryId:consumerRepoId,
   protection:{...squashEvidence.protection,repository:'Jamula/FamilyTree',repositoryId:consumerRepoId},
   policy:{...squashEvidence.policy,repository:'Jamula/FamilyTree',coverage:{line:95,branch:90}},
   snapshot:{...squashEvidence.snapshot,repository:'Jamula/FamilyTree'}
  }
 };
 for(const squashMismatchInput of [
  consumerSquashPayload,
  {intent:squashIntent,evidence:squashEvidence,scope:null},
  {intent:{...squashIntent,repositoryId:consumerRepoId},evidence:squashEvidence},
  {intent:squashIntent,evidence:{...squashEvidence,repositoryId:consumerRepoId}},
  {intent:squashIntent,evidence:{...squashEvidence,protection:{...squashEvidence.protection,repositoryId:consumerRepoId}}},
  {intent:squashIntent,evidence:{...squashEvidence,policy:{...squashEvidence.policy,repositoryId:consumerRepoId}}}
 ]){
  const rawOut=[],rcptOut=[];
  assert.equal(await run(['--evaluate-squash'],{
   env:defaultHostedEnv,input:squashMismatchInput,write:v=>rawOut.push(JSON.parse(v))
  }),0);
  assert.equal(rawOut[0].reason,'PROVENANCE_MISMATCH');
  assert.equal(rawOut[0].liveMerge,false);

  assert.equal(await run(['--evaluate-squash','--receipt'],{
   clock,env:defaultHostedEnv,input:squashMismatchInput,write:v=>rcptOut.push(JSON.parse(v))
  }),0);
  assert.equal(rcptOut[0].valid,true);
  assert.equal(rcptOut[0].repositoryId,1471342715);
  assert.equal(rcptOut[0].outcome,'blocked');
  assert.equal(rcptOut[0].reason,'SECURITY');
 }

 for(const admMismatchInput of [
  {...admissionInput,repositoryId:consumerRepoId,approvedRepositoryId:consumerRepoId},
  {...admissionInput,repositoryId:1471342715,approvedRepositoryId:consumerRepoId}
 ]){
  const rawOut=[],rcptOut=[];
  assert.equal(await run(['--verify-admission'],{
   env:defaultHostedEnv,input:admMismatchInput,write:v=>rawOut.push(JSON.parse(v))
  }),0);
  assert.equal(rawOut[0].admitted,false);
  assert.equal(rawOut[0].reason,'PROVENANCE_MISMATCH');
  assert.equal(rawOut[0].admissionCode,'REPOSITORY_SCOPE_MISMATCH');

  assert.equal(await run(['--verify-admission','--receipt'],{
   clock,env:defaultHostedEnv,input:admMismatchInput,write:v=>rcptOut.push(JSON.parse(v))
  }),0);
  assert.equal(rcptOut[0].valid,true);
  assert.equal(rcptOut[0].repositoryId,1471342715);
  assert.equal(rcptOut[0].outcome,'blocked');
  assert.equal(rcptOut[0].reason,'SECURITY');
 }

 for(const m01MismatchInput of [
  {
   ...m01Input,
   policy:{...m01Input.policy,repositoryId:consumerRepoId},
   readiness:{...m01Input.readiness,repositoryId:consumerRepoId},
   cycles:[makeCycle(1,{repositoryId:consumerRepoId}),makeCycle(2,{repositoryId:consumerRepoId}),makeCycle(3,{repositoryId:consumerRepoId})]
  },
  {...m01Input,repositoryId:consumerRepoId},
  {...m01Input,readiness:{...m01Input.readiness,repositoryId:consumerRepoId}},
  {...m01Input,cycles:[makeCycle(1),makeCycle(2,{repositoryId:consumerRepoId}),makeCycle(3)]}
 ]){
  const rawOut=[],rcptOut=[];
  assert.equal(await run(['--verify-m01-readiness'],{
   env:defaultHostedEnv,input:m01MismatchInput,
   verifyM01Readiness:()=>assert.fail('must not reach M01 evaluator on cross-repo payload'),
   write:v=>rawOut.push(JSON.parse(v))
  }),0);
  assert.equal(rawOut[0].ready,false);
  assert.equal(rawOut[0].reason,'IDENTITY_OR_PIN');

  assert.equal(await run(['--verify-m01-readiness','--receipt'],{
   clock,env:defaultHostedEnv,input:m01MismatchInput,
   verifyM01Readiness:()=>assert.fail('must not reach M01 evaluator on cross-repo payload'),
   write:v=>rcptOut.push(JSON.parse(v))
  }),0);
  assert.equal(rcptOut[0].valid,true);
  assert.equal(rcptOut[0].repositoryId,1471342715);
  assert.equal(rcptOut[0].outcome,'blocked');
  assert.equal(rcptOut[0].reason,'SECURITY');
 }

 for(const evtMismatchInput of [{repositoryId:consumerRepoId},{scope:{repositoryId:consumerRepoId}}]){
  const rawOut=[],rcptOut=[];
  assert.equal(await run(['--reconcile-event'],{
   env:defaultHostedEnv,input:evtMismatchInput,
   reconcileEvent:()=>assert.fail('must not reach reconcileEvent on cross-repo payload'),
   write:v=>rawOut.push(JSON.parse(v))
  }),0);
  assert.equal(rawOut[0].reconciled,false);
  assert.equal(rawOut[0].reason,'PROVENANCE_MISMATCH');

  assert.equal(await run(['--reconcile-event','--receipt'],{
   clock,env:defaultHostedEnv,input:evtMismatchInput,
   reconcileEvent:()=>assert.fail('must not reach reconcileEvent on cross-repo payload'),
   write:v=>rcptOut.push(JSON.parse(v))
  }),0);
  assert.equal(rcptOut[0].valid,true);
  assert.equal(rcptOut[0].outcome,'blocked');
  assert.equal(rcptOut[0].reason,'SECURITY');
 }

 // Invalid/mismatched repositoryId, scope, request, & GITHUB_REPOSITORY_ID fail closed with exit code 1
 for(const badRepoOpts of [
  {repositoryId:0,env:{}},
  {repositoryId:-5,env:{}},
  {repositoryId:'200036',env:{}},
  {scope:'not-object',env:{}},
  {scope:{unknownKey:1},env:{}},
  {scope:{repositoryId:0},env:{}},
  {repository:'',env:{}},
  {repository:'Synthetic/FamilyTree',env:{}},
  {repositoryId:200036,repository:'Jamula/SoftwareFactory',env:{}},
  {repositoryId:200036,repository:'Repo/A',scope:{repository:'Repo/B'},env:{}},
  {branch:123,env:{}},
  {workflowPath:'',env:{}},
  {env:'bad-env'},
  {env:[]},
  {env:{FACTORY_EXPECTED_REPO_ID:'0'}},
  {env:{FACTORY_EXPECTED_REPO_ID:'bad'}},
  {repositoryId:200036,env:{FACTORY_EXPECTED_REPO_ID:'1471342715'}},
  {env:{GITHUB_REPOSITORY_ID:'999'}},
  {env:{GITHUB_REPOSITORY:'Other/Repo'}},
  {repositoryId:200036,env:{GITHUB_REPOSITORY_ID:'1471342715'}},
  {repositoryId:200036,repository:'Synthetic/FamilyTree',env:{GITHUB_REPOSITORY:'Other/Repo'}}
 ]){
  const out=[];
  assert.equal(await run(['--verify-admission'],{...badRepoOpts,write:v=>out.push(JSON.parse(v))}),1);
  assert.equal(out[0].reason,'PROVENANCE_MISMATCH');
 }
 const badReqOut=[];
 assert.equal(await run(['--reconcile-pull'],{request:'not-fn',env:{},write:v=>badReqOut.push(JSON.parse(v))}),1);
 assert.equal(badReqOut[0].reason,'EVIDENCE_UNKNOWN');

 const defaultBadBranchOut=[];
 assert.equal(await run(['--reconcile-pull'],{branch:'bad..branch',env:{},write:v=>defaultBadBranchOut.push(JSON.parse(v))}),0);
 assert.equal(defaultBadBranchOut[0].reason,'TRUST_UNKNOWN');

 // 7. Bounded JSON input (<= 262,144 UTF-8 bytes), malformed JSON, proxies, and getters fail closed
 const exactBoundJson=JSON.stringify({pad:'x'.repeat(MAX_INPUT_UTF8_BYTES-20)});
 assert.ok(Buffer.byteLength(exactBoundJson,'utf8')<=MAX_INPUT_UTF8_BYTES);
 assert.equal(await run(['--verify-admission'],{env:{FACTORY_INPUT_JSON:exactBoundJson},write:()=>{}}),0);

 const oversizedStr='{"pad":"'+'x'.repeat(MAX_INPUT_UTF8_BYTES)+'"}';
 const oversizedObj={pad:'x'.repeat(MAX_INPUT_UTF8_BYTES)};
 const sparseArr=new Array(2);sparseArr[0]=1;
 let deepObj={leaf:1};
 for(let i=0;i<14;i++) deepObj={child:deepObj};
 const wideObj=Object.fromEntries(Array.from({length:130},(_,i)=>[`k${i}`,i]));
 for(const [badInputOpts,expectedReason] of [
  [{env:{FACTORY_INPUT_JSON:oversizedStr}},'RESPONSE_LIMIT'],
  [{env:{},input:oversizedObj},'RESPONSE_LIMIT'],
  [{env:{FACTORY_INPUT_JSON:'{bad-json'}},'EVIDENCE_UNKNOWN'],
  [{env:{FACTORY_INPUT_JSON:'[]'}},'EVIDENCE_UNKNOWN'],
  [{env:{FACTORY_INPUT_JSON:'"str"'}},'EVIDENCE_UNKNOWN'],
  [{env:{},input:null},'EVIDENCE_UNKNOWN'],
  [{env:{},input:42},'EVIDENCE_UNKNOWN'],
  [{env:{},input:[1,2,3]},'EVIDENCE_UNKNOWN'],
  [{env:{},input:{badNum:Infinity}},'EVIDENCE_UNKNOWN'],
  [{env:{},input:{badFn:()=>1}},'EVIDENCE_UNKNOWN'],
  [{env:{},input:{sparse:sparseArr}},'EVIDENCE_UNKNOWN'],
  [{env:{},input:{arrFn:[()=>1]}},'EVIDENCE_UNKNOWN'],
  [{env:{},input:deepObj},'EVIDENCE_UNKNOWN'],
  [{env:{},input:wideObj},'EVIDENCE_UNKNOWN'],
  [{env:{},input:{nested:Object.setPrototypeOf([1],Object.create(Array.prototype))}},'EVIDENCE_UNKNOWN']
 ]){
  const out=[],side=[];
  assert.equal(await run(['--verify-admission'],{
   ...badInputOpts,clock,write:v=>out.push(JSON.parse(v)),writeReceipt:r=>side.push(r)
  }),1);
  assert.equal(out[0].reason,expectedReason);
  assert.equal(side[0].valid,true);
  assert.equal(side[0].outcome,'blocked');
  assert.equal(side[0].reason,'INVALID_EVIDENCE');
 }

 let traps=0;
 const trap=()=>{traps++;throw Error('unexpected trap');};
 const getterOpts={write:()=>{},clock,env:{}};
 Object.defineProperty(getterOpts,'input',{enumerable:true,get:trap});
 assert.equal(await run(['--verify-admission','--receipt'],getterOpts),1);

 const getterEnv={};
 Object.defineProperty(getterEnv,'FACTORY_INPUT_JSON',{get:trap});
 assert.equal(await run(['--verify-admission'],{env:getterEnv,write:()=>{}}),1);

 const getterRepoEnv={};
 Object.defineProperty(getterRepoEnv,'FACTORY_EXPECTED_REPO_ID',{get:trap});
 assert.equal(await run(['--verify-admission'],{env:getterRepoEnv,write:()=>{}}),1);

 const getterGhRepoEnv={};
 Object.defineProperty(getterGhRepoEnv,'GITHUB_REPOSITORY_ID',{get:trap});
 assert.equal(await run(['--verify-admission'],{env:getterGhRepoEnv,write:()=>{}}),1);

 assert.equal(await run(['--verify-admission'],{env:new Proxy({},{get:trap}),write:()=>{}}),1);
 assert.equal(await run(new Proxy(['--smoke'],{get:trap}),{write:assert.fail,fail:()=>{}}),2);
 assert.equal(await run('not-an-array',{write:assert.fail,fail:()=>{}}),2);
 assert.equal(await run(['--smoke'],null),1);
 assert.equal(await run(['--smoke'],new Proxy({},{get:trap})),1);
 assert.equal(traps,0);
});
