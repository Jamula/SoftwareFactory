import test from 'node:test';
import assert from 'node:assert/strict';
import {compareTrainExperiment as compare, nextIntegration as next} from '../../tools/engineering-factory/integration-train.mjs';
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
test('candidate arrays reject custom prototypes and extra own keys before array methods',()=>{
 const hiddenMethod=[c];
 Object.defineProperty(hiddenMethod,'some',{get(){throw Error('must not run');}});
 const symbolCandidate=[c];
 Object.defineProperty(symbolCandidate,Symbol.iterator,{get(){throw Error('must not run');}});
 const customPrototype=Object.setPrototypeOf([c],{});
 for(const candidates of [hiddenMethod,symbolCandidate,customPrototype])
  assert.equal(next({...s,candidates}).reason,'INVALID_CANDIDATES');
});

import {queueAdapter} from '../../tools/engineering-factory/integration-train.mjs';
test('protected queue adapter emits only a mock intent for the exact head; never submits a request',()=>{
 const intent=next(s),e={pr:1,id:'PR_demo',repository:'Jamula/SoftwareFactory',head,base:main,branch:'main',open:true,draft:false,queueRequired:true,authority:true,checks:true,review:true,threads:true,security:true,coverage:true,mainHealthy:true,stop:false,queued:false};
 const result=queueAdapter(intent,e);
 assert.deepEqual(result,{shadow:true,liveMerge:false,reason:'SHADOW_QUEUE_INTENT',request:{
  query:'mutation Enqueue($id: ID!, $head: GitObjectID!) { enqueuePullRequest(input: {pullRequestId: $id, expectedHeadOid: $head, jump: false}) { mergeQueueEntry { id } } }',
  variables:{id:e.id,head}
 }});
 for(const x of [null,{...intent,pr:0},{...intent,expectedHead:'bad'},{...intent,expectedBase:'bad'}])assert.equal(queueAdapter(x,e).reason,'INTENT_UNKNOWN');
 assert.equal(queueAdapter(intent,null).reason,'EVIDENCE_UNKNOWN');
 for(const patch of [{stop:true},{repository:'other/repo'},{branch:'dev'},{pr:2},{head:main},{base:head}])assert.equal(queueAdapter(intent,{...e,...patch}).reason,'SCOPE_OR_HEAD_CHANGED');
 for(const patch of [{open:false},{draft:true}])assert.equal(queueAdapter(intent,{...e,...patch}).reason,'CANDIDATE_NOT_READY');
 assert.equal(queueAdapter(intent,{...e,queued:true}).reason,'ALREADY_QUEUED');
 for(const patch of [{queued:null},{queueRequired:false},{authority:false},{checks:false},{review:false},{threads:false},{security:false},{coverage:false},{mainHealthy:false},{id:null},{id:'bad'}])assert.equal(queueAdapter(intent,{...e,...patch}).reason,'GATES_UNKNOWN');
 const {open,...missingOpen}=e;
 assert.equal(queueAdapter(intent,missingOpen).reason,'EVIDENCE_UNKNOWN');
});

const baseline = {workload: main, gateSet: head, gatesPassed: true, accepted: 3, durationMs: 1000,
 rework: 1, costMicros: 0};
const candidate = {...baseline, durationMs: 500};
const sample = {id: 1, baseline, candidate};
const second = {id: 2, baseline: {...baseline, durationMs: 1400}, candidate: {...candidate, durationMs: 700}};
const refused = reason => ({shadow: true, synthetic: true, comparable: false, reason});

test('summarizes matched synthetic integration train trials without asserting real gains', () => {
 assert.deepEqual(compare([second, sample]), {
  shadow: true, synthetic: true, comparable: true, reason: 'MATCHED_SYNTHETIC_TRIALS',
  pairs: 2, acceptedPerArm: 6,
  baseline: {totalMs: 2400, p50Ms: 1000, p95Ms: 1400},
  candidate: {totalMs: 1200, p50Ms: 500, p95Ms: 700},
  throughputRatio: 2
 });
});

test('refuses comparisons when accepted work, workloads, gates, spend or rework differ', () => {
 for (const changed of [{workload:head}, {gateSet:main}, {accepted:4}]) {
  assert.deepEqual(compare([sample, {...second, candidate: {...candidate, ...changed}}]),
   refused('UNMATCHED_WORK'));
 }
 for (const changed of [{rework:2}, {costMicros:1}]) {
  assert.deepEqual(compare([sample, {...second, candidate: {...candidate, ...changed}}]),
   refused('REWORK_OR_COST_REGRESSION'));
 }
});

test('refuses missing, ambiguous and invalid experiment evidence without invoking accessors', () => {
 const accessor = [sample];
 Object.defineProperty(accessor, '1', {enumerable: true, get() {throw Error('must not run');}});
 const sparse = Object.assign([sample], {length: 2, notIndex: second});
 for (const list of [null, [], [sample], new Array(101), new Array(2), [sample, sample],
  accessor, sparse, [sample, null], [sample, {...second, id: 0}], [sample, {...second, baseline: null}],
  new Proxy([sample, second], {get() {throw Error('must not run');}})]) {
  assert.deepEqual(compare(list), refused('SAMPLE_UNKNOWN'));
 }
 for (const changed of [
  {workload:'bad'}, {gateSet:null}, {gatesPassed:false}, {accepted:0}, {accepted:100001},
  {durationMs:0}, {durationMs:86400001}, {rework:0.5}, {rework:-1}, {rework:100001},
  {costMicros:-1}, {costMicros:1000000001}, {get costMicros() {throw Error('must not run');}}
 ]) {
  const proof = Object.defineProperties({}, {...Object.getOwnPropertyDescriptors(candidate),
   ...Object.getOwnPropertyDescriptors(changed)});
  assert.deepEqual(compare([sample, {...second, candidate:proof}]), refused('SAMPLE_UNKNOWN'));
 }
 const symbolPair = [sample, second];
 Object.defineProperty(symbolPair, Symbol.iterator, {get() {throw Error('must not run');}});
 const hiddenPair = [sample, second];
 Object.defineProperty(hiddenPair, 'map', {get() {throw Error('must not run');}});
 const customPrototype = Object.setPrototypeOf([sample, second], {});
 for (const pairs of [symbolPair, hiddenPair, customPrototype])
  assert.deepEqual(compare(pairs), refused('SAMPLE_UNKNOWN'));
});

