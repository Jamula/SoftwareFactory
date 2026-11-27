import test from 'node:test';import assert from 'node:assert/strict';import {pilotReadiness as check,evaluateSelfPilotCycles as evaluate,verifyM01AutonomousExit as verifyExit,M01_STRUCTURAL_PREREQUISITES} from '../../tools/engineering-factory/pilot-readiness.mjs';
const p={repositoryId:1,pin:'a'.repeat(40),lineMin:97,branchMin:90,firstPilot:false};
const e={repositoryId:1,pin:p.pin,enrolled:true,stop:false,upstreamAccepted:true,review:true,coverageLine:97,coverageBranch:90,requiredChecks:true,quotaVerified:true,rollbackVerified:true,securityClear:true};
const m01Prereqs=Object.fromEntries(M01_STRUCTURAL_PREREQUISITES.map(k=>[k,true]));
test('independent synthetic profiles',()=>{assert.equal(check(p,e).ready,true);assert.equal(check({...p,firstPilot:true},{...e,upstreamAccepted:false}).ready,true);assert.equal(check({...p,repositoryId:2},{...e,repositoryId:2}).liveActivation,false);assert.equal(check({...p,requireM01Prerequisites:false},e).ready,true);assert.deepEqual(check({...p,requireM01Prerequisites:true},{...e,...m01Prereqs}),{shadow:true,ready:true,liveActivation:false,reason:'SYNTHETIC_READY_ONLY'});});
test('deny invalid policy and incomplete readiness',()=>{
 let getterCalls=0;
 const badReqGetter={...p};Object.defineProperty(badReqGetter,'requireM01Prerequisites',{get(){getterCalls++;return true;}});
 for(const x of [null,[],Object.create(p),{...p,repositoryId:0},{...p,pin:'bad'},{...p,lineMin:null},{...p,lineMin:94},{...p,lineMin:101},{...p,branchMin:null},{...p,branchMin:89},{...p,branchMin:101},{...p,firstPilot:null},{...p,requireM01Prerequisites:null},{...p,requireM01Prerequisites:'true'},badReqGetter])assert.equal(check(x,e).reason,'POLICY_UNKNOWN');
 for(const x of [null,[],Object.create(e)])assert.equal(check(p,x).reason,'EVIDENCE_UNKNOWN');
 assert.equal(check({...p,requireM01Prerequisites:true},e).reason,'EVIDENCE_UNKNOWN');
 for(const k of M01_STRUCTURAL_PREREQUISITES){
  const missing={...e,...m01Prereqs};delete missing[k];
  assert.equal(check({...p,requireM01Prerequisites:true},missing).reason,'EVIDENCE_UNKNOWN');
  assert.equal(check({...p,requireM01Prerequisites:true},{...e,...m01Prereqs,[k]:false}).reason,'M01_PREREQUISITES_UNVERIFIED');
 }
 for(const x of [{stop:true},{enrolled:false},{repositoryId:2},{pin:'bad'},{upstreamAccepted:false},{review:false},{requiredChecks:false},{quotaVerified:false},{rollbackVerified:false},{securityClear:false},{coverageLine:null},{coverageLine:96},{coverageLine:101},{coverageBranch:null},{coverageBranch:89},{coverageBranch:101}])assert.equal(check(p,{...e,...x}).ready,false);
 assert.equal(getterCalls,0);
});

test('independent pins, local thresholds and stop isolation',()=>{const p2={...p,repositoryId:2,pin:'b'.repeat(40),lineMin:95,branchMin:92};const e2={...e,repositoryId:2,pin:p2.pin,coverageLine:95,coverageBranch:92};assert.equal(check(p,e).ready,true);assert.equal(check(p2,e2).ready,true);assert.equal(check(p,e2).reason,'IDENTITY_OR_PIN');assert.equal(check(p2,e).reason,'IDENTITY_OR_PIN');assert.equal(check(p,{...e,stop:true}).reason,'STOPPED');assert.equal(check(p2,e2).ready,true);assert.equal(check(p2,{...e2,coverageBranch:91}).reason,'COVERAGE');assert.equal(check(p,{...e,coverageLine:96}).reason,'COVERAGE');assert.equal(check(p2,{...e2,stop:true}).reason,'STOPPED');assert.equal(check(p,e).ready,true);});


const inventory=['core','runner'];
const reports=head=>inventory.map(component=>({component,head,lines:98,lineTotal:100,branches:19,branchTotal:20}));
const cycles=(samples,expected=inventory,options)=>evaluate(samples,expected,options);
const cycle=(n,extra={})=>({repositoryId:1471342715,issue:n,pr:n+100,head:String(n).repeat(40),reviewedHead:String(n).repeat(40),reviewIndependent:true,checksPassed:true,securityClear:true,threadsResolved:true,coverageReports:reports(String(n).repeat(40)),mainVerified:true,costVerified:true,extraCost:0,humanInterventions:0,unauthorizedWrites:0,duplicateDispatches:0,startedAt:0,eligibleAt:10,mergedAt:10+n*1000,reviewFix:n===1,parallelCandidate:n===2,...extra});
const batch=(repoId=1471342715)=>[cycle(1,{repositoryId:repoId}),cycle(2,{repositoryId:repoId}),cycle(3,{repositoryId:repoId})];
test('self-pilot repeatability measures three independent synthetic cycles, never authorizes activation',()=>{
 assert.deepEqual(cycles(batch()),{shadow:true,liveActivation:false,accepted:false,reason:'SYNTHETIC_REPEATABILITY_ONLY',sampleCount:3,p50Ms:2000,p95Ms:3000});
 assert.deepEqual(cycles(batch(),inventory,{}),{shadow:true,liveActivation:false,accepted:false,reason:'SYNTHETIC_REPEATABILITY_ONLY',sampleCount:3,p50Ms:2000,p95Ms:3000});
 for(const consumerRepoId of [200036,200011,200012]){
  assert.deepEqual(cycles(batch(consumerRepoId),inventory,{repositoryId:consumerRepoId}),{shadow:true,liveActivation:false,accepted:false,reason:'SYNTHETIC_REPEATABILITY_ONLY',sampleCount:3,p50Ms:2000,p95Ms:3000});
  assert.equal(cycles(batch(),inventory,{repositoryId:consumerRepoId}).reason,'IDENTITY_OR_REVIEW_UNKNOWN');
  assert.equal(cycles(batch(consumerRepoId),inventory).reason,'IDENTITY_OR_REVIEW_UNKNOWN');
 }
 assert.equal(cycles([cycle(1,{reviewFix:false}),cycle(2),cycle(3)]).reason,'SCENARIO_MISSING');
 assert.equal(cycles([cycle(1),cycle(2,{parallelCandidate:false}),cycle(3)]).reason,'SCENARIO_MISSING');
 for(const x of [null,[],new Array(3),Array(51).fill(cycle(1))])assert.equal(cycles(x).reason,'CYCLE_INVENTORY_UNKNOWN');
});
test('repeatability rejects invalid options, stale or wrong identity, duplicate work and unknown safety',()=>{
 let calls=0;const trap=()=>{calls++;throw Error('unexpected options trap');};
 const optGetter={};Object.defineProperty(optGetter,'repositoryId',{get:trap});
 const optProxy=new Proxy({repositoryId:1471342715},{get:trap,getOwnPropertyDescriptor:trap,getPrototypeOf:trap});
 for(const badOpt of [null,'bad',[],Object.create({repositoryId:1471342715}),optProxy,optGetter,{repositoryId:0},{repositoryId:-1},{repositoryId:'1471342715'}])
  assert.equal(evaluate(batch(),inventory,badOpt).reason,'OPTIONS_UNKNOWN');
 assert.equal(calls,0);
 const withFirst=change=>[cycle(1,change),cycle(2),cycle(3)];
 for(const change of [{repositoryId:2},{issue:0},{pr:0},{head:'bad'},{reviewedHead:'b'.repeat(40)}])assert.equal(cycles(withFirst(change)).reason,'IDENTITY_OR_REVIEW_UNKNOWN');
 assert.equal(cycles([null,cycle(2),cycle(3)]).reason,'IDENTITY_OR_REVIEW_UNKNOWN');
 for(const change of [{issue:2},{pr:102},{head:'2'.repeat(40),reviewedHead:'2'.repeat(40),coverageReports:reports('2'.repeat(40))}])assert.equal(cycles(withFirst(change)).reason,'DUPLICATE_CYCLE');
 for(const change of [{reviewIndependent:false},{checksPassed:false},{securityClear:false},{threadsResolved:false},{mainVerified:false},{costVerified:false},{extraCost:null},{extraCost:1},{humanInterventions:1},{unauthorizedWrites:1},{duplicateDispatches:1}])assert.equal(cycles(withFirst(change)).reason,'SAFETY_OR_COST_UNKNOWN');
 const rows=reports('1'.repeat(40));
 for(const coverageReports of [null,[],[rows[0]],[rows[0],rows[0]],[{...rows[0],lines:97},rows[1]],[{...rows[0],branches:18},rows[1]],[{...rows[0],head:'b'.repeat(40)},rows[1]]])assert.equal(cycles(withFirst({coverageReports})).reason,'COVERAGE');
 assert.equal(evaluate(batch()).reason,'COVERAGE');
 assert.equal(cycles(batch(),['core','runner','other']).reason,'COVERAGE');
 for(const change of [{startedAt:-1},{startedAt:11},{mergedAt:9},{reviewFix:null},{parallelCandidate:null}])assert.equal(cycles(withFirst(change)).reason,'TIMING_OR_SCENARIO_UNKNOWN');
});


test('cycle inventory rejects caller-defined iteration, accessors, and proxies without executing them',()=>{
 let calls=0;const trap=()=>{calls++;throw Error('unexpected user code');};
 const custom=[null,null,null];Object.defineProperty(custom,Symbol.iterator,{value:function*(){calls++;yield cycle(1,{parallelCandidate:true});}});
 const accessor=batch();Object.defineProperty(accessor,0,{get:trap});
 const inherited=Object.setPrototypeOf(batch(),Object.create(Array.prototype));
 const proxy=new Proxy(batch(),{get:trap,getPrototypeOf:trap,ownKeys:trap,getOwnPropertyDescriptor:trap});
 for(const x of [custom,accessor,inherited,proxy])assert.equal(cycles(x).reason,'CYCLE_INVENTORY_UNKNOWN');
 const revoked=Proxy.revocable(batch(),{});revoked.revoke();assert.equal(cycles(revoked.proxy).reason,'CYCLE_INVENTORY_UNKNOWN');
 const rowProxy=new Proxy(cycle(1),{getOwnPropertyDescriptor:trap});
 assert.equal(cycles([rowProxy,cycle(2),cycle(3)]).reason,'IDENTITY_OR_REVIEW_UNKNOWN');
 assert.equal(calls,0);
});


test('M01 autonomous exit verifier enforces all structural prerequisites, worker shortfall, and accepted cycles without live activation',()=>{
 const sfPolicy={repositoryId:1471342715,pin:'c'.repeat(40),lineMin:98,branchMin:95,firstPilot:true};
 const sfReadiness={repositoryId:1471342715,pin:sfPolicy.pin,enrolled:true,stop:false,upstreamAccepted:false,review:true,coverageLine:99,coverageBranch:96,requiredChecks:true,quotaVerified:true,rollbackVerified:true,securityClear:true};
 const m01Cycle=(n,extra={})=>cycle(n,{acceptanceVerified:true,gateBypasses:0,...extra});
 const m01Batch=()=>[m01Cycle(1),m01Cycle(2),m01Cycle(3)];
 const exitEvidence=(extra={})=>({
  policy:sfPolicy,
  readiness:sfReadiness,
  ...m01Prereqs,
  cycles:m01Batch(),
  expectedComponents:inventory,
  actualWorkerMax:4,
  workerShortfallFrom12:8,
  ...extra
 });

 assert.deepEqual(verifyExit(exitEvidence()),{
  shadow:true,
  ready:true,
  liveActivation:false,
  accepted:false,
  reason:'M01_EXIT_EVIDENCE_READY_ONLY',
  sampleCount:3,
  p50Ms:2000,
  p95Ms:3000,
  actualWorkerMax:4,
  workerShortfallFrom12:8
 });
 assert.deepEqual(verifyExit(exitEvidence({policy:{...sfPolicy,requireM01Prerequisites:true},actualWorkerMax:12,workerShortfallFrom12:0})),{
  shadow:true,
  ready:true,
  liveActivation:false,
  accepted:false,
  reason:'M01_EXIT_EVIDENCE_READY_ONLY',
  sampleCount:3,
  p50Ms:2000,
  p95Ms:3000,
  actualWorkerMax:12,
  workerShortfallFrom12:0
 });
 assert.equal(verifyExit(exitEvidence({actualWorkerMax:16,workerShortfallFrom12:0})).ready,true);

 const strictReports=head=>inventory.map(component=>({component,head,lines:99,lineTotal:100,branches:24,branchTotal:25}));
 const strictPolicy={...sfPolicy,lineMin:99,branchMin:96};
 assert.equal(verifyExit(exitEvidence({policy:strictPolicy})).reason,'COVERAGE');
 assert.equal(verifyExit(exitEvidence({
  policy:{...sfPolicy,branchMin:96},
  cycles:[1,2,3].map(n=>m01Cycle(n,{coverageReports:inventory.map(component=>({component,head:String(n).repeat(40),lines:99,lineTotal:100,branches:19,branchTotal:20}))}))
 })).reason,'COVERAGE');
 assert.equal(verifyExit(exitEvidence({
  policy:strictPolicy,
  cycles:[1,2,3].map(n=>m01Cycle(n,{coverageReports:strictReports(String(n).repeat(40))}))
 })).ready,true);

 let traps=0;const trap=()=>{traps++;throw Error('unexpected exit trap');};
 const proxyEvidence=new Proxy(exitEvidence(),{get:trap,getOwnPropertyDescriptor:trap});
 const getterPolicy={...sfPolicy};Object.defineProperty(getterPolicy,'requireM01Prerequisites',{get:trap});
 const getterAcceptanceCycle=m01Cycle(1);Object.defineProperty(getterAcceptanceCycle,'acceptanceVerified',{get:trap});
 const getterBypassCycle=m01Cycle(1);Object.defineProperty(getterBypassCycle,'gateBypasses',{get:trap});
 for(const bad of [null,[],Object.create(exitEvidence()),proxyEvidence,exitEvidence({readiness:null})]){
  const res=verifyExit(bad);
  assert.equal(res.ready,false);
  assert.equal(res.liveActivation,false);
  assert.equal(res.shadow,true);
  assert.equal(res.reason,'EVIDENCE_UNKNOWN');
 }
 for(const badPolicy of [null,{...sfPolicy,pin:'bad'},{...sfPolicy,requireM01Prerequisites:false},getterPolicy])
  assert.equal(verifyExit(exitEvidence({policy:badPolicy})).reason,'POLICY_UNKNOWN');

 for(const k of M01_STRUCTURAL_PREREQUISITES){
  const missing=exitEvidence();delete missing[k];
  assert.equal(verifyExit(missing).reason,'EVIDENCE_UNKNOWN');
  assert.equal(verifyExit(exitEvidence({[k]:false})).reason,'M01_PREREQUISITES_UNVERIFIED');
  assert.equal(verifyExit(exitEvidence({[k]:null})).reason,'M01_PREREQUISITES_UNVERIFIED');
 }

 assert.equal(verifyExit(exitEvidence({readiness:{...sfReadiness,stop:true}})).reason,'STOPPED');
 assert.equal(verifyExit(exitEvidence({policy:{...sfPolicy,repositoryId:2},readiness:{...sfReadiness,repositoryId:2}})).reason,'POLICY_BELOW_M01_TARGET');
 assert.equal(verifyExit(exitEvidence({policy:{...sfPolicy,lineMin:97}})).reason,'POLICY_BELOW_M01_TARGET');
 assert.equal(verifyExit(exitEvidence({policy:{...sfPolicy,branchMin:94}})).reason,'POLICY_BELOW_M01_TARGET');

 for(const badWorkers of [
  {actualWorkerMax:0,workerShortfallFrom12:12},
  {actualWorkerMax:-1,workerShortfallFrom12:13},
  {actualWorkerMax:1001,workerShortfallFrom12:0},
  {actualWorkerMax:4,workerShortfallFrom12:7},
  {actualWorkerMax:12,workerShortfallFrom12:1},
  {actualWorkerMax:4,workerShortfallFrom12:null}
 ])assert.equal(verifyExit(exitEvidence(badWorkers)).reason,'WORKER_CAPACITY_UNKNOWN');

 assert.equal(verifyExit(exitEvidence({cycles:[m01Cycle(1),m01Cycle(2)]})).reason,'CYCLE_INVENTORY_UNKNOWN');
 assert.equal(verifyExit(exitEvidence({cycles:batch()})).reason,'SAFETY_OR_COST_UNKNOWN');
 const missingBypass=m01Cycle(1);delete missingBypass.gateBypasses;
 assert.equal(verifyExit(exitEvidence({cycles:[missingBypass,m01Cycle(2),m01Cycle(3)]})).reason,'SAFETY_OR_COST_UNKNOWN');
 assert.equal(verifyExit(exitEvidence({cycles:[getterAcceptanceCycle,m01Cycle(2),m01Cycle(3)]})).reason,'SAFETY_OR_COST_UNKNOWN');
 assert.equal(verifyExit(exitEvidence({cycles:[getterBypassCycle,m01Cycle(2),m01Cycle(3)]})).reason,'SAFETY_OR_COST_UNKNOWN');
 for(const badSafety of [{acceptanceVerified:false},{acceptanceVerified:null},{gateBypasses:1},{gateBypasses:-1},{gateBypasses:null},{humanInterventions:1},{duplicateDispatches:1},{unauthorizedWrites:1},{extraCost:1}]){
  const res=verifyExit(exitEvidence({cycles:[m01Cycle(1,badSafety),m01Cycle(2),m01Cycle(3)]}));
  assert.equal(res.reason,'SAFETY_OR_COST_UNKNOWN');
  assert.equal(res.accepted,false);
 }
 assert.equal(verifyExit(exitEvidence({cycles:[m01Cycle(1,{reviewFix:false}),m01Cycle(2),m01Cycle(3)]})).reason,'SCENARIO_MISSING');
 assert.equal(verifyExit(exitEvidence({cycles:[m01Cycle(1),m01Cycle(2,{parallelCandidate:false}),m01Cycle(3)]})).reason,'SCENARIO_MISSING');
 assert.equal(traps,0);
});
