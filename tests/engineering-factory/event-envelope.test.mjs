import test from 'node:test';
import assert from 'node:assert/strict';
import {eventEnvelope as normalize,readPullIdentity,reconcilePullTrigger} from '../../tools/engineering-factory/event-envelope.mjs';
const trust={repositoryId:1,workflowSha:'a'.repeat(40)};
const e={...trust,deliveryId:'delivery-1',kind:'review',head:'b'.repeat(40),receivedMs:100};
test('valid synthetic event drops untrusted payload',()=>{
 assert.deepEqual(normalize({...e,body:'not an instruction'},trust,101),{shadow:true,accepted:true,reason:'NORMALIZED_ONLY',repositoryId:1,kind:'review',head:e.head,deliveryId:'delivery-1',receivedMs:100});
});
test('reject incomplete and malformed evidence',()=>{
 for(const t of [null,[],Object.create(trust),{...trust,repositoryId:0},{...trust,workflowSha:'bad'}]) assert.equal(normalize(e,t,100).reason,'TRUST_UNKNOWN');
 for(const x of [null,[],Object.create(e),{...e,repositoryId:0},{...e,workflowSha:null},{...e,head:'x'},{...e,deliveryId:1},{...e,deliveryId:'bad id'},{...e,kind:'unknown'},{...e,receivedMs:1.5},{...e,receivedMs:-1}]) assert.equal(normalize(x,trust,100).reason,'INVALID_EVENT');
 for(const x of [{...e,repositoryId:2},{...e,workflowSha:'c'.repeat(40)}]) assert.equal(normalize(x,trust,100).reason,'PROVENANCE_MISMATCH');
 for(const now of [null,99,120101]) assert.equal(normalize(e,trust,now).reason,'STALE_EVENT');
});

test('reject accessor metadata without invoking getters',()=>{
 const bad=()=>{throw Error('getter must not run');};
 assert.equal(normalize({...e,get head(){return bad();}},trust,100).reason,'INVALID_EVENT');
 assert.equal(normalize(e,{...trust,get workflowSha(){return bad();}},100).reason,'TRUST_UNKNOWN');
 let reads=0; const x={...e,get head(){return ++reads===1?e.head:'bad';}};
 assert.equal(normalize(x,trust,100).reason,'INVALID_EVENT');assert.equal(reads,0);
});

test('read-only bounded pull metadata without user content or mutation',async()=>{
 const repo={id:1,full_name:'Jamula/SoftwareFactory'},p={number:2,base:{repo,ref:'main',sha:trust.workflowSha},head:{repo,sha:e.head},state:'open',draft:false,body:'do not trust'};
 let calls=0;const read=async(url,opts)=>{calls++;assert.equal(url,'https://api.github.com/repos/Jamula/SoftwareFactory/pulls/2');assert.equal(opts.method,'GET');assert.equal(opts.redirect,'error');return new Response(JSON.stringify(p));};
 assert.deepEqual(await readPullIdentity(2,read),{shadow:true,evidenceComplete:false,reason:'IDENTITY_ONLY',repositoryId:1,number:2,head:e.head,base:trust.workflowSha,state:'open',draft:false});assert.equal((await readPullIdentity(0,read)).reason,'INVALID_PULL');assert.equal(calls,1);
 for(const status of [403,429])assert.equal((await readPullIdentity(2,async()=>new Response(null,{status}))).reason,'RATE_OR_PERMISSION_UNKNOWN');
 for(const status of [404,204])assert.equal((await readPullIdentity(2,async()=>new Response(null,{status}))).reason,'READ_FAILED');
 assert.equal((await readPullIdentity(2,async()=>new Response('x'.repeat(524289)))).reason,'RESPONSE_LIMIT');
 for(const change of [null,{...p,number:3},{...p,base:null},{...p,head:null},{...p,base:{...p.base,ref:'dev'}},{...p,base:{...p.base,sha:'bad'}},{...p,head:{...p.head,sha:'bad'}},{...p,base:{...p.base,repo:{...repo,id:0}}},{...p,head:{...p.head,repo:{...repo,id:2}}},{...p,state:'unknown'},{...p,draft:null}])assert.equal((await readPullIdentity(2,async()=>new Response(JSON.stringify(change)))).reason,'IDENTITY_UNKNOWN');
 assert.equal((await readPullIdentity(2,async()=>new Response('invalid'))).reason,'READ_FAILED');
 assert.equal((await readPullIdentity(2,async()=>{throw Error('offline');})).reason,'READ_FAILED');
});

const actions = {
 GITHUB_EVENT_NAME:'pull_request_target', GITHUB_REPOSITORY_ID:'1471342715',
 GITHUB_WORKFLOW_REF:'Jamula/SoftwareFactory/.github/workflows/shadow-reconcile.yml@refs/heads/main',
 GITHUB_REF_PROTECTED:'true', GITHUB_WORKFLOW_SHA:trust.workflowSha, GITHUB_SHA:trust.workflowSha,
 FACTORY_CHECKOUT_SHA:trust.workflowSha, FACTORY_PULL_NUMBER:'2', FACTORY_PULL_HEAD:e.head, GITHUB_RUN_ID:'123'
};
const identity = {
 repositoryId:1471342715, number:2, head:e.head, base:trust.workflowSha,
 state:'open', draft:false, reason:'IDENTITY_ONLY'
};
const assertBlocked = (result, reason) => assert.deepEqual(result, {
 shadow:true, evidenceComplete:false, reconciled:false, reason
});

test('reconciles the workflow trigger against a public GET, without replaying PR text', async () => {
 const repo = {id:identity.repositoryId, full_name:'Jamula/SoftwareFactory'};
 const number = identity.number;
 const samples = [100, 120];
 const readIdentity = id => readPullIdentity(id, async (url, options) => {
  assert.equal(url, 'https://api.github.com/repos/Jamula/SoftwareFactory/pulls/2');
  assert.equal(options.method, 'GET');
  assert.equal(options.headers.authorization, undefined);
  return new Response(JSON.stringify({
   number, head:{repo,sha:e.head}, base:{repo,sha:trust.workflowSha,ref:'main'},
   state:'open', draft:false, body:'ignored'
  }));
 });
 const result = await reconcilePullTrigger(actions, {clock:() => samples.shift(),readIdentity});
 assert.deepEqual(result, {
  ...identity, reason:'PULL_IDENTITY_MATCHED', shadow:true, evidenceComplete:false, reconciled:true,
  workflowSha:trust.workflowSha, runId:'123', observedMs:20
 });
});

test('rejects untrusted workflows and invalid event metadata before reading the network', async () => {
 let reads = 0;
 const deps = {clock:() => 100, readIdentity:async () => { reads++; }};
 for (const change of [
  {GITHUB_EVENT_NAME:'pull_request'}, {GITHUB_REPOSITORY_ID:'1'}, {GITHUB_WORKFLOW_REF:'untrusted'},
  {GITHUB_REF_PROTECTED:'false'}, {GITHUB_WORKFLOW_SHA:'bad'}, {GITHUB_SHA:e.head}, {FACTORY_CHECKOUT_SHA:e.head}
 ]) assertBlocked(await reconcilePullTrigger({...actions,...change},deps),'TRUST_UNKNOWN');
 for (const value of [undefined,2,'0','2\n','9007199254740992'])
  assertBlocked(await reconcilePullTrigger({...actions,FACTORY_PULL_NUMBER:value},deps),'INVALID_PULL');
 assertBlocked(await reconcilePullTrigger({...actions,FACTORY_PULL_HEAD:'bad'},deps),'INVALID_EVENT');
 assertBlocked(await reconcilePullTrigger({...actions,GITHUB_RUN_ID:'invalid id'},deps),'INVALID_EVENT');
 assert.equal(reads,0);
});

test('rejects stale reads, shifted heads, rate limits and mismatched PR identities', async () => {
 const reconcile = (value, clock = () => 100) => reconcilePullTrigger(actions,{clock,readIdentity:async () => value});
 for (const value of [
  {...identity, repositoryId:2}, {...identity, number:3}, {...identity, head:'unknown'},
  {...identity, base:'unknown'}, {...identity, state:'unknown'}, {...identity, draft:null},
  {reason:'IDENTITY_ONLY'}, {...identity,get head(){ throw Error('untrusted getter'); }}
 ]) assertBlocked(await reconcile(value),'IDENTITY_UNKNOWN');
 const proxy = new Proxy(identity,{getOwnPropertyDescriptor(){throw Error('untrusted trap');}});
 assertBlocked(await reconcile(proxy),'READ_FAILED');
 assertBlocked(await reconcile({...identity,head:'c'.repeat(40)}),'HEAD_CHANGED');
 assertBlocked(await reconcile({reason:'RATE_OR_PERMISSION_UNKNOWN'}),'RATE_OR_PERMISSION_UNKNOWN');
 assertBlocked(await reconcile({reason:'RESPONSE_LIMIT'}),'READ_FAILED');
 assertBlocked(await reconcilePullTrigger(actions,{clock:() => 100,readIdentity:async () => {
  throw Error('offline');
 }}),'READ_FAILED');
 for (const finishedAt of [99,120101]) {
  const samples = [100,finishedAt];
  assertBlocked(await reconcile(identity,() => samples.shift()),'STALE_EVENT');
 }
});
