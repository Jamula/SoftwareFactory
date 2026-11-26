import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {run,runCliIfDirect} from '../../tools/engineering-factory/run.mjs';
import {createSignals} from '../../tools/engineering-factory/telemetry.mjs';

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
  {outcome:'failed',reason:'OTHER'}
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
  'POLICY','QUOTA','INVALID_EVIDENCE','DEPENDENCY','DEPENDENCY','POLICY','OTHER'
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
