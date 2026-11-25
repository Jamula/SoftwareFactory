import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {plan,readInventory,smoke} from '../../tools/engineering-factory/shadow-runtime.mjs';
const task=(id,over={})=>({id,priority:0,state:'approved',dependencies:[],paths:['src/'+id],...over});
const input=(tasks,over={})=>({enabled:true,stop:false,capacity:2,quotaVerified:true,tasks,...over});
test('shadow smoke and dependency ranking',()=>{
  assert.deepEqual(smoke().ready,[1,2]);
  assert.deepEqual(plan(input([task(3),task(2),task(1),task(4,{dependencies:[2]})])).ready,[2,1]);
  assert.deepEqual(plan(input([task(1,{state:'accepted'}),task(2,{dependencies:[1]}),task(3)])).ready,[2,3]);
  assert.deepEqual(plan(input([task(1,{priority:5}),task(2,{priority:0})])).ready,[2,1]);
});
test('stop and capacity fail closed',()=>{
  for(const x of [null,input([],{stop:true}),input([],{enabled:false})]) assert.equal(plan(x).reason,'STOPPED');
  for(const x of [input([],{quotaVerified:false}),input([],{capacity:0}),input([],{capacity:51}),input([],{capacity:null})]) assert.equal(plan(x).reason,'CAPACITY_UNKNOWN');
});
test('invalid inputs',()=>{
  for(const tasks of [null,Array.from({length:251},(_,i)=>task(i+1)),[null],[task(0)],[task(1,{priority:'x'})],[task(1,{priority:-1})],[task(1,{priority:101})],[task(1,{state:'bad'})],[task(1,{dependencies:null})],[task(1,{dependencies:[0]})],[task(1,{dependencies:[2,2]})],[task(1,{paths:null})],[task(1,{paths:[]})],[task(1,{paths:['../a']})],[task(1,{paths:['/a']})],[task(1,{paths:['a//b']})],[task(1,{paths:['a\\b']})],[task(1,{paths:[4]})]]) assert.equal(plan(input(tasks)).reason,'INVALID_TASKS');
  for(const tasks of [[task(1),task(1)],[task(1,{dependencies:[2]})]]) assert.equal(plan(input(tasks)).reason,'UNKNOWN_DEPENDENCY');
  assert.equal(plan(input([task(1,{dependencies:[2]}),task(2,{dependencies:[1]})])).reason,'DEPENDENCY_CYCLE');
});
test('ownership, active capacity, pending and no ready work',()=>{
  const a=task(1,{state:'active',paths:['src/a']});
  assert.equal(plan(input([a,task(2,{state:'active',paths:['src/a/b']})])).reason,'ACTIVE_OWNERSHIP_CONFLICT');
  assert.deepEqual(plan(input([a,task(2,{paths:['src/a/b']}),task(3)])).ready,[3]);
  assert.deepEqual(plan(input([task(1,{paths:['src/a/b']}),task(2,{paths:['src/a']}),task(3)])).ready,[1,3]);
  assert.deepEqual(plan(input([task(1,{paths:['src/a']}),task(2,{paths:['src/a']}),task(3)])).ready,[1,3]);
  assert.equal(plan(input([a,task(2)],{capacity:1})).reason,'NO_READY_WORK');
  assert.equal(plan(input([task(1,{state:'pending'}),task(2,{dependencies:[1]})])).reason,'NO_READY_WORK');
  assert.equal(plan(input([])).reason,'NO_READY_WORK');
});
const json=x=>new Response(JSON.stringify(x));
test('public inventory only reads approved repository, filters PRs, sorts and paginates',async()=>{
  const calls=[];
  const first=Array.from({length:100},(_,i)=>({number:200-i,...(i===0?{pull_request:{}}:{})}));
  const actual=await readInventory(async (url,options)=>{
    calls.push(url);
    assert.ok(url.startsWith('https://api.github.com/repos/Jamula/SoftwareFactory/'));
    assert.equal(options.method,'GET'); assert.equal(options.redirect,'error');
    assert.equal(options.headers.authorization,undefined);
    if(url.includes('/pulls?')) return json([{number:3},{number:1}]);
    return json(url.endsWith('page=1')?first:[{number:2}]);
  });
  assert.equal(calls.length,3);assert.equal(actual.issues.length,100);
  assert.equal(actual.issues[0],2);assert.deepEqual(actual.pulls,[1,3]);
  assert.equal(actual.evidenceComplete,false);assert.equal(actual.liveDispatch,false);assert.equal(actual.liveMerge,false);
});
test('inventory rejects errors, malformed data, duplicate records and bounded pagination',async()=>{
  for(const [make,pattern] of [
    [()=>new Response('failure',{status:403}),/GITHUB_READ_FAILED/],
    [()=>new Response(null),/GITHUB_READ_FAILED/],
    [()=>json({}),/GITHUB_INVALID_METADATA/],
    [()=>json([null]),/GITHUB_INVALID_METADATA/],
    [()=>json([{number:0}]),/GITHUB_INVALID_METADATA/],
    [()=>json(Array.from({length:101},(_,i)=>({number:i+1}))),/GITHUB_INVALID_METADATA/],
    [()=>json([{number:1},{number:1}]),/GITHUB_DUPLICATE_METADATA/],
    [()=>new Response('x'.repeat(2*1024*1024+1)),/GITHUB_RESPONSE_LIMIT/],
    [()=>new Response('not-json'),/JSON/],
  ]) await assert.rejects(()=>readInventory(async()=>make()),pattern);
  await assert.rejects(()=>readInventory(async url=>{
    const page=Number(new URL(url).searchParams.get('page'));
    return json(Array.from({length:100},(_,i)=>({number:(page-1)*100+i+1})));
  }),/GITHUB_INVENTORY_LIMIT/);
});
test('CLI smoke and invalid invocation',()=>{
  const file=fileURLToPath(new URL('../../tools/engineering-factory/run.mjs',import.meta.url));
  const ok=spawnSync(process.execPath,[file,'--smoke'],{encoding:'utf8'});
  assert.equal(ok.status,0);assert.deepEqual(JSON.parse(ok.stdout).ready,[1,2]);
  const bad=spawnSync(process.execPath,[file,'--invalid'],{encoding:'utf8'});
  assert.equal(bad.status,2);
});


test('scheduler rejects sparse task lists, path ownership and dependency evidence',()=>{
  for(const tasks of [new Array(1),[task(1,{paths:new Array(1)})],[task(1,{dependencies:new Array(1)})]]) {
    assert.equal(plan(input(tasks)).reason,'INVALID_TASKS');
  }
  const hidden=new Array(1);hidden.extra=task(1);
  assert.equal(plan(input(hidden)).reason,'INVALID_TASKS');
});

test('CLI injected inventory, smoke and error paths are deterministic',async()=>{
 const {run}=await import('../../tools/engineering-factory/run.mjs');
 const output=[],errors=[];
 const io={write:x=>output.push(x),fail:x=>errors.push(x)};
 assert.equal(await run([],io),0);
 assert.equal(await run(['--smoke'],io),0);
 assert.equal(await run(['--inventory'],{...io,inventory:async()=>({issues:[1],pulls:[],liveDispatch:false,liveMerge:false})}),0);
 assert.deepEqual(JSON.parse(output.at(-1)).issues,[1]);
 assert.equal(await run(['--inventory'],{...io,inventory:async()=>{throw Error('offline');}}),1);
 assert.equal(errors.at(-1),'FACTORY_RUN_FAILED');
 assert.equal(await run(['--smoke'],{...io,replay:()=>({reason:'FAILED',ready:[]})}),1);
 assert.equal(await run(['--smoke'],{...io,replay:()=>({reason:'SHADOW_PLAN',ready:[2]})}),1);
 assert.equal(await run(['--smoke','--inventory'],io),2);
});
