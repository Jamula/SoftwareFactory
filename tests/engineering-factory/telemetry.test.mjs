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
