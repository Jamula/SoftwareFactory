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
 const result={reason:'SHADOW_PLAN',ready:[1,2],outcome:'eligible',reasonCode:'NONE',private:'must not reach telemetry'};
 const options={observe,write:value=>output.push(value),fail:value=>failures.push(value)};
 assert.equal(await run([], {...options,replay:()=>result}),0);
 assert.equal(await run(['--inventory'], {...options,inventory:async()=>result}),0);
 assert.equal(await run(['--reconcile-pull'], {...options,reconcile:async()=>result}),0);
 assert.equal(await run(['--reconcile-issue'], {...options,reconcileIssue:async()=>result}),0);
 assert.deepEqual(measurements.filter((_,i)=>i%2===0).map(([,attrs])=>attrs.stage),
  ['evaluate','reconcile','reconcile','reconcile']);
 assert.equal(JSON.stringify(measurements).includes('must not reach telemetry'),false);
 assert.equal(JSON.stringify(spans).includes('must not reach telemetry'),false);
 assert.equal(output.length,4);
 assert.deepEqual(failures,[]);
});

test('runner defaults to no-op observation and preserves command results',async()=>{
 const result={shadow:true,evidenceComplete:false,reason:'INVENTORY_ONLY'};
 const output=[];
 assert.equal(await run(['--inventory'],{inventory:async()=>result,write:value=>output.push(value)}),0);
 assert.deepEqual(output,[JSON.stringify(result)]);
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
