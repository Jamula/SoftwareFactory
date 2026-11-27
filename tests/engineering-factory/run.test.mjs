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
  clock,env:{GITHUB_ACTIONS:'true',GITHUB_REPOSITORY_ID:'1471342715',GITHUB_RUN_ID:'101'},
  inventory:async()=>({shadow:true,issues:[9],pulls:[],evidenceComplete:false,liveDispatch:false,liveMerge:false}),
  write:v=>inventoryOut.push(JSON.parse(v)),
  writeReceipt:r=>{sideReceipts.push(r);throw Error('sink failure ignored');}
 }),0);
 assert.deepEqual(inventoryOut[0].issues,[9]);
 assert.equal(sideReceipts.length,1);
 assert.equal(sideReceipts[0].receiptId,'gh-101-1-inventory');
 assert.equal(sideReceipts[0].source,'github-hosted');

 // Untrusted hosted env, clock failure, and command throws fail closed without leaking details
 for(const badEnv of [
  {GITHUB_ACTIONS:'true',GITHUB_REPOSITORY_ID:'999',GITHUB_RUN_ID:'101'},
  {GITHUB_ACTIONS:'true',GITHUB_REPOSITORY_ID:'1471342715',GITHUB_RUN_ID:'bad_id'},
  {GITHUB_ACTIONS:'true',GITHUB_REPOSITORY_ID:'1471342715',GITHUB_RUN_ID:'101',GITHUB_RUN_ATTEMPT:'0'}
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

 for(const invalidArgs of [['--receipt','--receipt'],['--smoke','--inventory','--receipt'],['--receipt','--unknown']]){
  const errs=[];
  assert.equal(await run(invalidArgs,{fail:v=>errs.push(v),write:assert.fail}),2);
  assert.match(errs[0],/^Usage:/);
 }
});
