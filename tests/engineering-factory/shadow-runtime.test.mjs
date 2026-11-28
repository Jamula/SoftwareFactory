import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
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
  assert.equal(actual.repository,'Jamula/SoftwareFactory');
  assert.equal(actual.repositoryId,1471342715);
  assert.equal(actual.issues[0],2);assert.deepEqual(actual.pulls,[1,3]);
  assert.equal(actual.evidenceComplete,false);assert.equal(actual.liveDispatch,false);assert.equal(actual.liveMerge,false);
});
test('scoped inventory resolves trusted consumer repository and fails closed on untrusted options or mismatched repo metadata',async()=>{
  const consumerOpts={repository:'Synthetic/FamilyTree',repositoryId:200036};
  const consumerCalls=[];
  const scoped=await readInventory(async url=>{
    consumerCalls.push(url);
    assert.ok(url.startsWith('https://api.github.com/repos/Synthetic/FamilyTree/'));
    if(url.includes('/pulls?')) {
      return json([{number:7,base:{repo:{id:200036,full_name:'Synthetic/FamilyTree'}}}]);
    }
    return json([{number:4,repository_url:'https://api.github.com/repos/Synthetic/FamilyTree'}]);
  },consumerOpts);
  assert.equal(consumerCalls.length,2);
  assert.deepEqual(scoped,{
    shadow:true,
    repository:'Synthetic/FamilyTree',
    repositoryId:200036,
    issues:[4],
    pulls:[7],
    evidenceComplete:false,
    liveDispatch:false,
    liveMerge:false
  });

  const nullProtoOpts=Object.assign(Object.create(null),{
    scope:{
      repository:'Synthetic/Spellbook',
      repositoryId:300042,
      branch:'release/v1',
      workflowPath:'.github/workflows/ci.yml'
    },
    repository:'Synthetic/Spellbook'
  });
  const nestedScoped=await readInventory(async url=>json(url.includes('/pulls?')?[{number:9}]:[{number:5}]),nullProtoOpts);
  assert.equal(nestedScoped.repository,'Synthetic/Spellbook');
  assert.equal(nestedScoped.repositoryId,300042);

  for(const crossRepoRow of [
    url=>json(url.includes('/pulls?')?[]:[{number:1,repository_url:'https://api.github.com/repos/Other/Repo'}]),
    url=>json(url.includes('/pulls?')?[{number:1,base:{repo:{id:999,full_name:'Synthetic/FamilyTree'}}}]:[]),
    url=>json(url.includes('/pulls?')?[{number:1,base:{repo:{id:200036,full_name:'Other/Repo'}}}]:[])
  ]) {
    await assert.rejects(()=>readInventory(async url=>crossRepoRow(url),consumerOpts),/GITHUB_INVALID_METADATA/);
  }

  let trapCount=0;
  const trap=()=>{trapCount++;throw new Error('trap must not run');};
  const handler={get:trap,ownKeys:trap,getOwnPropertyDescriptor:trap,getPrototypeOf:trap};
  const revoked=Proxy.revocable({repository:'Synthetic/FamilyTree',repositoryId:200036},handler);
  revoked.revoke();
  const getterOpts={repositoryId:200036};
  Object.defineProperty(getterOpts,'repository',{enumerable:true,get:trap});
  const nonEnumOpts={repository:'Synthetic/FamilyTree',repositoryId:200036};
  Object.defineProperty(nonEnumOpts,'branch',{enumerable:false,value:'main'});
  const symbolOpts={repository:'Synthetic/FamilyTree',repositoryId:200036,[Symbol('s')]:1};

  let unexpectedNetworkCalls=0;
  const neverFetch=async()=>{unexpectedNetworkCalls++;return json([]);};
  for(const badReq of [null,'not-a-fn',{}]) {
    assert.deepEqual(await readInventory(badReq,consumerOpts),{
      shadow:true,evidenceComplete:false,liveDispatch:false,liveMerge:false,reason:'TRUST_UNKNOWN'
    });
  }
  for(const badOpts of [
    null,
    42,
    [],
    process.env,
    Object.create(consumerOpts),
    new Proxy(consumerOpts,handler),
    revoked.proxy,
    getterOpts,
    nonEnumOpts,
    symbolOpts,
    {unknownKey:true},
    {scope:null},
    {scope:[]},
    {scope:{unknownKey:true}},
    {scope:consumerOpts,repository:'Other/Repo'},
    {repository:'Synthetic/FamilyTree'},
    {repositoryId:200036},
    {repository:'Jamula/SoftwareFactory',repositoryId:200036},
    {repository:'jamula/softwarefactory',repositoryId:1471342715},
    {repository:'Synthetic/FamilyTree',repositoryId:1471342715},
    {repository:'Synthetic/FamilyTree',repositoryId:200036,branch:'../bad'},
    {repository:'Synthetic/FamilyTree',repositoryId:200036,workflowPath:'bad.txt'}
  ]) {
    assert.deepEqual(await readInventory(neverFetch,badOpts),{
      shadow:true,evidenceComplete:false,liveDispatch:false,liveMerge:false,reason:'TRUST_UNKNOWN'
    });
  }
  assert.equal(trapCount,0);
  assert.equal(unexpectedNetworkCalls,0);
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
 assert.equal(await run(['--reconcile-issue'],{...io,env:{},reconcileIssue:async env => {
  assert.deepEqual(env,{});
  return {shadow:true,reconciled:false,reason:'TRUST_UNKNOWN'};
 }}),0);
 assert.equal(JSON.parse(output.at(-1)).reason,'TRUST_UNKNOWN');
 assert.equal(await run(['--reconcile-issue'],{...io,env:{}}),0);
 assert.equal(await run(['--reconcile-pull'],{...io,env:{},reconcile:async env => {
  assert.deepEqual(env,{});
  return {shadow:true,reconciled:false,reason:'TRUST_UNKNOWN'};
 }}),0);
 assert.equal(JSON.parse(output.at(-1)).reason,'TRUST_UNKNOWN');
 assert.equal(await run(['--reconcile-pull'],{...io,env:{}}),0);
 assert.equal(await run(['--inventory'],{...io,inventory:async()=>{throw Error('offline');}}),1);
 assert.equal(errors.at(-1),'FACTORY_RUN_FAILED');
 assert.equal(await run(['--smoke'],{...io,replay:()=>({reason:'FAILED',ready:[]})}),1);
 assert.equal(await run(['--smoke'],{...io,replay:()=>({reason:'SHADOW_PLAN',ready:[2]})}),1);
 assert.equal(await run(['--smoke','--inventory'],io),2);
});
