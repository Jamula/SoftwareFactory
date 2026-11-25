import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localEndpoint,createSignals} from '../../tools/engineering-factory/telemetry.mjs';
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
