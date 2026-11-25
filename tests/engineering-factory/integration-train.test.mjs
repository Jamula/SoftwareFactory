import test from 'node:test';
import assert from 'node:assert/strict';
import {nextIntegration as next} from '../../tools/engineering-factory/integration-train.mjs';
const main='a'.repeat(40),head='b'.repeat(40);
const c={pr:1,head,observedHead:head,base:main,checks:true,approval:true,threads:true,authority:true};
const s={stop:false,main,mainHealthy:true,active:false,candidates:[c]};
test('only next eligible exact candidate, never live merge',()=>{
 assert.deepEqual(next(s),{shadow:true,liveMerge:false,reason:'SHADOW_NEXT',pr:1,expectedHead:head,expectedBase:main,method:'squash'});
 assert.equal(next({...s,candidates:[{...c,checks:false},{...c,pr:2}]}).pr,2);
 for(const change of [{observedHead:main},{base:head},{checks:false},{approval:false},{threads:false},{authority:false}]) assert.equal(next({...s,candidates:[{...c,...change}]}).reason,'NO_ELIGIBLE_CANDIDATE');
 assert.equal(next({...s,candidates:[]}).reason,'NO_ELIGIBLE_CANDIDATE');
});
test('stop, unhealthy main, active train and malformed candidates',()=>{
 for(const x of [null,Object.create(s),{...s,stop:true}]) assert.equal(next(x).reason,'STOPPED');
 for(const x of [{main:'bad'},{mainHealthy:false},{active:true}]) assert.equal(next({...s,...x}).reason,'MAIN_OR_TRAIN_UNREADY');
 for(const candidates of [null,new Array(1),[null],[Object.create(c)],[{...c,pr:0}],[{...c,head:'bad'}],[{...c,observedHead:'bad'}],[{...c,base:'bad'}],[c,c]]) assert.equal(next({...s,candidates}).reason,'INVALID_CANDIDATES');
});

import {queueAdapter} from '../../tools/engineering-factory/integration-train.mjs';
test('protected queue adapter exact-head, no bypass, no merge claim',async()=>{
 const intent=next(s),e={pr:1,id:'PR_demo',repository:'Jamula/SoftwareFactory',head,base:main,branch:'main',queueRequired:true,authority:true,checks:true,review:true,threads:true,security:true,coverage:true,mainHealthy:true,stop:false,queued:false};
 let calls=0;const send=async q=>{calls++;assert.deepEqual(q.variables,{id:e.id,head});assert.match(q.query,/expectedHeadOid: \$head, jump: false/);assert.match(q.query,/enqueuePullRequest/);return {data:{enqueuePullRequest:{mergeQueueEntry:{id:'entry-1'}}}};};
 assert.deepEqual(await queueAdapter(intent,e,send),{shadow:true,liveMerge:false,reason:'QUEUE_RECEIPT_MOCK',queueEntry:'entry-1'});
 for(const x of [null,{...intent,pr:0},{...intent,expectedHead:'bad'},{...intent,expectedBase:'bad'}])assert.equal((await queueAdapter(x,e,send)).reason,'INTENT_UNKNOWN');
 assert.equal((await queueAdapter(intent,null,send)).reason,'EVIDENCE_UNKNOWN');
 for(const patch of [{stop:true},{repository:'other/repo'},{branch:'dev'},{pr:2},{head:main},{base:head}])assert.equal((await queueAdapter(intent,{...e,...patch},send)).reason,'SCOPE_OR_HEAD_CHANGED');
 assert.equal((await queueAdapter(intent,{...e,queued:true},send)).reason,'ALREADY_QUEUED');
 for(const patch of [{queued:null},{queueRequired:false},{authority:false},{checks:false},{review:false},{threads:false},{security:false},{coverage:false},{mainHealthy:false},{id:null},{id:'bad'}])assert.equal((await queueAdapter(intent,{...e,...patch},send)).reason,'GATES_UNKNOWN');
 assert.equal((await queueAdapter(intent,e,null)).reason,'GATES_UNKNOWN');
 assert.equal(calls,1);
 for(const result of [null,{}, {data:{}},{data:{enqueuePullRequest:{}}},{data:{enqueuePullRequest:{mergeQueueEntry:{id:''}}}},{errors:[{}]}])assert.equal((await queueAdapter(intent,e,async()=>result)).reason,'QUEUE_RECEIPT_UNKNOWN');
 assert.equal((await queueAdapter(intent,e,async()=>{throw Error('network');})).reason,'QUEUE_RECEIPT_UNKNOWN');
 let traps=0;const fail=()=>{traps++;throw Error('trap');};assert.equal((await queueAdapter(new Proxy(intent,{get:fail}),e,send)).reason,'INTENT_UNKNOWN');assert.equal((await queueAdapter(intent,[],send)).reason,'EVIDENCE_UNKNOWN');assert.equal(traps,0);
});
