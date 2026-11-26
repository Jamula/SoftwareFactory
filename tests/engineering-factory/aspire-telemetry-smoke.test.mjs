import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {runAspireTelemetry} from '../../tools/engineering-factory/aspire-telemetry-smoke.mjs';
const env={OTEL_EXPORTER_OTLP_ENDPOINT:'https://127.0.0.1:18890',OTEL_EXPORTER_OTLP_PROTOCOL:'http/protobuf',OTEL_EXPORTER_OTLP_HEADERS:'x-otlp-api-key=synthetic'};
test('explicit resource runs only after authenticated configuration and flushes the SDK',async()=>{
 const events=[];
 await runAspireTelemetry(env,async config=>{
  assert.deepEqual(config,{endpoint:env.OTEL_EXPORTER_OTLP_ENDPOINT,protocol:env.OTEL_EXPORTER_OTLP_PROTOCOL,headers:env.OTEL_EXPORTER_OTLP_HEADERS});
  return {observe:async(stage,fn)=>{assert.equal(stage,'evaluate');const result=await fn();assert.deepEqual(result,{outcome:'blocked',reason:'POLICY'});events.push('observed');},shutdown:async()=>events.push('shutdown')};
 },async()=>events.push('work'));
 assert.deepEqual(events,['work','observed','shutdown']);
 await assert.rejects(()=>runAspireTelemetry({},async()=>null,async()=>assert.fail('unexpected work')),/LOCAL_OTLP_CONFIGURATION_REQUIRED/);
 const original=Error('fixture failure');
 await assert.rejects(()=>runAspireTelemetry(env,async()=>({observe:async(stage,fn)=>fn(),shutdown:async()=>events.push('cleanup')}),async()=>{throw original;}),e=>e===original);
 assert.equal(events.at(-1),'cleanup');
});
test('default disabled configuration fails without imports',async()=>{
 await assert.rejects(()=>runAspireTelemetry({}),/LOCAL_OTLP_CONFIGURATION_REQUIRED/);
});

test('default synthetic work runs through the observer and shuts down',async()=>{
 let observed=false,closed=false;
 await runAspireTelemetry(env,async()=>({observe:async(stage,work)=>{assert.equal(stage,'evaluate');assert.deepEqual(await work(),{outcome:'blocked',reason:'POLICY'});observed=true;},shutdown:async()=>{closed=true;}}));
 assert.equal(observed,true);assert.equal(closed,true);
});

test('direct entrypoint refuses missing OTLP configuration',()=>{
 const clean={...process.env};
 delete clean.OTEL_EXPORTER_OTLP_ENDPOINT;delete clean.OTEL_EXPORTER_OTLP_PROTOCOL;delete clean.OTEL_EXPORTER_OTLP_HEADERS;
 const child=spawnSync(process.execPath,['tools/engineering-factory/aspire-telemetry-smoke.mjs'],{env:clean,encoding:'utf8',timeout:5000});
 assert.equal(child.status,1);assert.match(child.stderr,/LOCAL_OTLP_CONFIGURATION_REQUIRED/);
});
