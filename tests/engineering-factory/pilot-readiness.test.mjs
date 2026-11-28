import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync,readdirSync} from 'node:fs';import {pilotReadiness as check,evaluateSelfPilotCycles as evaluate,verifyM01AutonomousExit as verifyExit,evaluateCustomerOnePilotReadinessDossier as evaluateDossier,evaluateConsolidatedM01ExitGate as evaluateExitGate,M01_STRUCTURAL_PREREQUISITES,M01_CUSTOMER_ONE_PREREQUISITES,M01_CUSTOMER_ONE_SLOS,M01_CONSOLIDATED_EXIT_CONTRACT} from '../../tools/engineering-factory/pilot-readiness.mjs';
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

const allCustomerOnePrereqsTrue=Object.fromEntries(M01_CUSTOMER_ONE_PREREQUISITES.map(k=>[k,true]));
const dossierCycle=(n,extra={})=>{
 const head=n.toString(16).padStart(40,'0');
 const eligibleAt=extra.eligibleAt??(1_000+n*120_000);
 return {
  source:'github-hosted',
  repositoryId:1471342715,
  issue:n,
  pr:200+n,
  head,
  reviewedHead:head,
  batchId:`batch-${n}`,
  batchStartedAt:eligibleAt,
  reviewIndependent:true,
  checksPassed:true,
  securityClear:true,
  threadsResolved:true,
  coverageReports:reports(head),
  mainVerified:true,
  costVerified:true,
  acceptanceVerified:true,
  laptopOfflineVerified:true,
  extraCost:0,
  humanInterventions:0,
  unauthorizedWrites:0,
  duplicateDispatches:0,
  gateBypasses:0,
  issueReadyAt:1_000,
  prCreatedAt:1_000+n*60_000,
  eligibleAt,
  prMergedAt:1_000+n*120_000+n*10_000,
  mainVerifiedAt:1_000+n*120_000+n*10_000+5_000,
  acceptanceVerifiedAt:1_000+n*120_000+n*20_000,
  automatedCiMs:20_000+n*5_000,
  reviewFix:n===1,
  parallelCandidate:n===2,
  ...extra
 };
};
const dossierInput=(extra={})=>({
 repositoryId:1471342715,
 pin:'b0924c3807f797e6090e1dc3e1e65fc9caa07550',
 enrolled:true,
 stop:false,
 lineMin:98,
 branchMin:95,
 actualWorkerMax:4,
 workerShortfallFrom12:8,
 prerequisites:{...allCustomerOnePrereqsTrue},
 expectedComponents:inventory,
 cycles:[dossierCycle(1),dossierCycle(2),dossierCycle(3)],
 ...extra
});

test('Customer One readiness audit JSON matches deterministic dossier and consolidated exit evaluation on ec438f54088f30856c2df6ff626e894dde2a0100',()=>{
 const audit=JSON.parse(readFileSync(new URL('../../docs/evidence/m01-08-readiness-audit.json',import.meta.url),'utf8'));
 assert.equal(audit.evaluatedCommit,'ec438f54088f30856c2df6ff626e894dde2a0100');
 assert.equal(audit.dossierInput.pin,'ec438f54088f30856c2df6ff626e894dde2a0100');
 assert.equal(audit.repositoryId,1471342715);
 assert.equal(audit.issueNumber,10);
 assert.equal(audit.summary.engineeringFoundationsDeliveredCount,9);
 assert.equal(audit.summary.pilotEntryBlockingCount,1);
 assert.equal(audit.summary.pilotEntryReady,false);
 assert.equal(audit.summary.m01ExitEvidenceReady,false);
 assert.equal(audit.summary.liveActivation,false);
 assert.equal(audit.summary.accepted,false);
 assert.equal(audit.summary.deliveredLiveUnattendedCycles,0);
 assert.equal(audit.dossierInput.prerequisites.hardStopBillingVerified,true);
 assert.equal(audit.dossierInput.prerequisites.nativeCloudSmokeVerified,true);
 assert.equal(audit.dossierInput.prerequisites.repoScopedLiveAuthVerified,false);
 assert.deepEqual(
  audit.deliveredEngineeringFoundations.map(f=>f.prerequisite),
  ['noPythonVerified','mainCodeqlHealthy','ghAwLockVerified','workQueueCasVerified','unifiedCliVerified','antiRogueCircuitBreakersVerified','crossOsAspireRuntimeVerified','hardStopBillingVerified','nativeCloudSmokeVerified']
 );
 assert.deepEqual(
  audit.liveOperationalBlockers.filter(b=>b.prerequisite!==null).map(b=>b.prerequisite),
  ['repoScopedLiveAuthVerified']
 );
 const trackedComponents=['engineering-coordinator','engineering-factory'].flatMap(pkg=>
  readdirSync(new URL(`../../tools/${pkg}`,import.meta.url))
   .filter(f=>f.endsWith('.mjs'))
   .map(f=>`${pkg}.${f.slice(0,-4)}`)
 ).sort();
 assert.equal(trackedComponents.length,70);
 assert.deepEqual(audit.dossierInput.expectedComponents,trackedComponents);
 assert.deepEqual(audit.consolidatedExitInput.expectedComponents,trackedComponents);
 const actual=evaluateDossier(audit.dossierInput);
 assert.deepEqual(actual.blockingPrerequisites,['repoScopedLiveAuthVerified']);
 assert.deepEqual(actual,audit.dossierEvaluation);
 const consolidatedActual=evaluateExitGate(audit.consolidatedExitInput);
 assert.equal(consolidatedActual.exitGateReady,false);
 assert.equal(consolidatedActual.reason,'PILOT_ENTRY_BLOCKED');
 assert.deepEqual(consolidatedActual.blockingPrerequisites,['repoScopedLiveAuthVerified']);
 assert.equal(consolidatedActual.verifiedPrerequisites.length,9);
 assert.deepEqual(consolidatedActual,audit.consolidatedExitEvaluation);
});

test('Customer One dossier evaluates 10-prerequisite matrix, batch drain vs eligible-to-merge, verified-main PR completion, and never counts synthetic cycles as delivered work',()=>{
 assert.deepEqual(M01_CUSTOMER_ONE_PREREQUISITES,[
  'noPythonVerified',
  'mainCodeqlHealthy',
  'ghAwLockVerified',
  'workQueueCasVerified',
  'unifiedCliVerified',
  'antiRogueCircuitBreakersVerified',
  'crossOsAspireRuntimeVerified',
  'hardStopBillingVerified',
  'nativeCloudSmokeVerified',
  'repoScopedLiveAuthVerified'
 ]);
 assert.equal(M01_CUSTOMER_ONE_SLOS.batchDrainMaxMs,120_000);
 assert.equal(M01_CUSTOMER_ONE_SLOS.eligibleToMergeInitialMaxMs,120_000);
 assert.equal(M01_CUSTOMER_ONE_SLOS.automatedCiP50InitialExclusiveMaxMs,75_000);
 assert.equal(M01_CUSTOMER_ONE_SLOS.maxHumanInterventions,0);

 const liveReady=evaluateDossier(dossierInput());
 assert.equal(liveReady.shadow,true);
 assert.equal(liveReady.liveActivation,false);
 assert.equal(liveReady.accepted,false);
 assert.equal(liveReady.pilotEntryReady,true);
 assert.equal(liveReady.m01ExitEvidenceReady,true);
 assert.equal(liveReady.reason,'CUSTOMER_ONE_EXIT_EVIDENCE_READY_ONLY');
 assert.deepEqual(liveReady.verifiedPrerequisites,M01_CUSTOMER_ONE_PREREQUISITES);
 assert.deepEqual(liveReady.blockingPrerequisites,[]);
 assert.equal(liveReady.cycleSource,'github-hosted');
 assert.equal(liveReady.sampleCount,3);
 assert.equal(liveReady.deliveredCycleCount,3);
 assert.equal(liveReady.syntheticCycleCount,0);
 assert.equal(liveReady.deliveredCyclesShortfallFrom3,0);
 assert.equal(liveReady.automatedCiP50Ms,30_000);
 assert.equal(liveReady.automatedCiP95Ms,35_000);
 assert.equal(liveReady.batchDrainMs,30_000);
 assert.equal(liveReady.batchDrains.length,3);
 assert.equal(liveReady.humanInterventions,0);
 assert.deepEqual(liveReady.issueReadyToPrMs,{
  p50Ms:120_000,
  p95Ms:180_000,
  initialMaxMs:600_000,
  stretchMaxMs:120_000,
  p50MeetsInitial:true,
  p95MeetsInitial:true,
  p50MeetsStretch:true,
  p95MeetsStretch:false
 });
 assert.deepEqual(liveReady.prToCompleteMs,{
  p50Ms:145_000,
  p95Ms:215_000,
  initialMaxMs:900_000,
  stretchMaxMs:300_000,
  p50MeetsInitial:true,
  p95MeetsInitial:true,
  p50MeetsStretch:true,
  p95MeetsStretch:true
 });
 assert.deepEqual(liveReady.issueReadyToOutcomeMs,{
  p50Ms:280_000,
  p95Ms:420_000,
  initialMaxMs:1_500_000,
  stretchMaxMs:420_000,
  outlierOver25mCount:0,
  p50MeetsInitial:true,
  p95MeetsInitial:true,
  p50MeetsStretch:true,
  p95MeetsStretch:true
 });
 assert.deepEqual(liveReady.eligibleToMergeMs,{
  p50Ms:20_000,
  p95Ms:30_000,
  initialMaxMs:120_000,
  stretchMaxMs:30_000,
  p50MeetsInitial:true,
  p95MeetsInitial:true,
  p50MeetsStretch:true,
  p95MeetsStretch:true
 });
 assert.deepEqual(liveReady.sloChecks,{
  evaluable:true,
  issueReadyToPrP50Met:true,
  issueReadyToPrP95Met:true,
  prToCompleteP50Met:true,
  prToCompleteP95Met:true,
  issueReadyToOutcomeP50Met:true,
  issueReadyToOutcomeP95Met:true,
  eligibleToMergeP50Met:true,
  eligibleToMergeP95Met:true,
  automatedCiP50Met:true,
  automatedCiStretchMet:true,
  batchDrainMet:true,
  batchDrainStretchMet:true,
  humanInterventionsMet:true,
  allInitialSlosMet:true
 });
 assert.equal(liveReady.cycleMetrics.every(m=>m.countedAsDeliveredWork===true),true);

 // 20 concurrent candidates in one batch: 19 merge after 60s, 20th merges after 180s.
 // Per-PR eligibleToMergeMs p95 is 60s, but true elapsed batchDrainMs is 180s (reported as SLO miss without blocking M01 exit evidence).
 const twentyCycles=Array.from({length:20},(_,idx)=>{
  const n=idx+1;
  const mergeOffset=n===20?180_000:60_000;
  return dossierCycle(n,{
   batchId:'shared-batch-1',
   batchStartedAt:100_000,
   issueReadyAt:10_000,
   prCreatedAt:50_000,
   eligibleAt:100_000,
   prMergedAt:100_000+mergeOffset,
   mainVerifiedAt:100_000+mergeOffset+5_000,
   acceptanceVerifiedAt:100_000+mergeOffset+10_000,
   automatedCiMs:30_000,
   reviewFix:n===1,
   parallelCandidate:n>=2
  });
 });
 const slowTailBatch=evaluateDossier(dossierInput({cycles:twentyCycles}));
 assert.equal(slowTailBatch.m01ExitEvidenceReady,true);
 assert.equal(slowTailBatch.reason,'CUSTOMER_ONE_EXIT_EVIDENCE_READY_ONLY');
 assert.equal(slowTailBatch.eligibleToMergeMs.p50Ms,60_000);
 assert.equal(slowTailBatch.eligibleToMergeMs.p95Ms,60_000);
 assert.equal(slowTailBatch.sloChecks.eligibleToMergeP95Met,true);
 assert.equal(slowTailBatch.batchDrainMs,180_000);
 assert.deepEqual(slowTailBatch.batchDrains,[{
  batchId:'shared-batch-1',
  cycleCount:20,
  batchStartedAt:100_000,
  finalMergedAt:280_000,
  drainMs:180_000
 }]);
 assert.equal(slowTailBatch.sloChecks.batchDrainMet,false);
 assert.equal(slowTailBatch.sloChecks.allInitialSlosMet,false);

 // Staggered parallel batch + separate sequential batch
 const multiBatch=evaluateDossier(dossierInput({
  cycles:[
   dossierCycle(1,{batchId:'wave-1',batchStartedAt:121_000,eligibleAt:121_000,prMergedAt:141_000,mainVerifiedAt:146_000,acceptanceVerifiedAt:150_000}),
   dossierCycle(2,{batchId:'wave-2',batchStartedAt:250_000,eligibleAt:255_000,prMergedAt:340_000,mainVerifiedAt:345_000,acceptanceVerifiedAt:350_000,parallelCandidate:true}),
   dossierCycle(3,{batchId:'wave-2',batchStartedAt:250_000,eligibleAt:245_000,prMergedAt:310_000,mainVerifiedAt:315_000,acceptanceVerifiedAt:320_000,parallelCandidate:true})
  ]
 }));
 assert.equal(multiBatch.m01ExitEvidenceReady,true);
 assert.equal(multiBatch.batchDrainMs,90_000);
 assert.equal(multiBatch.batchDrains.length,2);

 const syntheticCohort=evaluateDossier(dossierInput({
  cycles:[1,2,3].map(n=>dossierCycle(n,{source:'synthetic'}))
 }));
 assert.equal(syntheticCohort.pilotEntryReady,true);
 assert.equal(syntheticCohort.m01ExitEvidenceReady,false);
 assert.equal(syntheticCohort.accepted,false);
 assert.equal(syntheticCohort.liveActivation,false);
 assert.equal(syntheticCohort.reason,'SYNTHETIC_CYCLES_NOT_DELIVERED_WORK');
 assert.equal(syntheticCohort.sampleCount,3);
 assert.equal(syntheticCohort.deliveredCycleCount,0);
 assert.equal(syntheticCohort.syntheticCycleCount,3);
 assert.equal(syntheticCohort.deliveredCyclesShortfallFrom3,3);
 assert.equal(syntheticCohort.sloChecks.evaluable,true);
 assert.equal(syntheticCohort.cycleMetrics.every(m=>m.countedAsDeliveredWork===false),true);

 for(const key of M01_CUSTOMER_ONE_PREREQUISITES){
  const singleBlocked=evaluateDossier(dossierInput({
   prerequisites:{...allCustomerOnePrereqsTrue,[key]:false}
  }));
  assert.equal(singleBlocked.pilotEntryReady,false);
  assert.equal(singleBlocked.m01ExitEvidenceReady,false);
  assert.equal(singleBlocked.reason,'PILOT_ENTRY_BLOCKED');
  assert.deepEqual(singleBlocked.blockingPrerequisites,[key]);
  assert.equal(singleBlocked.verifiedPrerequisites.length,M01_CUSTOMER_ONE_PREREQUISITES.length-1);
 }

 assert.equal(evaluateDossier(dossierInput({stop:true})).reason,'STOPPED');
 assert.equal(evaluateDossier(dossierInput({enrolled:false})).reason,'STOPPED');
 assert.equal(evaluateDossier(dossierInput({actualWorkerMax:0,workerShortfallFrom12:12,cycles:[]})).reason,'WORKER_CAPACITY_UNVERIFIED');

 const pendingLive=evaluateDossier(dossierInput({cycles:[dossierCycle(1),dossierCycle(2)]}));
 assert.equal(pendingLive.pilotEntryReady,true);
 assert.equal(pendingLive.m01ExitEvidenceReady,false);
 assert.equal(pendingLive.reason,'LIVE_CYCLES_PENDING');
 assert.equal(pendingLive.deliveredCycleCount,2);
 assert.equal(pendingLive.deliveredCyclesShortfallFrom3,1);
 assert.equal(pendingLive.humanInterventions,0);
 assert.equal(pendingLive.sloChecks.evaluable,false);

 assert.equal(evaluateDossier(dossierInput({
  cycles:[dossierCycle(1,{reviewFix:false}),dossierCycle(2),dossierCycle(3)]
 })).reason,'SCENARIO_MISSING');
 assert.equal(evaluateDossier(dossierInput({
  cycles:[dossierCycle(1),dossierCycle(2,{parallelCandidate:false}),dossierCycle(3)]
 })).reason,'SCENARIO_MISSING');

 const humanTouched=evaluateDossier(dossierInput({
  cycles:[dossierCycle(1,{humanInterventions:1}),dossierCycle(2),dossierCycle(3)]
 }));
 assert.equal(humanTouched.m01ExitEvidenceReady,false);
 assert.equal(humanTouched.reason,'HUMAN_INTERVENTION_NONZERO');
 assert.equal(humanTouched.deliveredCycleCount,2);
 assert.equal(humanTouched.deliveredCyclesShortfallFrom3,1);
 assert.equal(humanTouched.humanInterventions,1);
 assert.equal(humanTouched.sloChecks.humanInterventionsMet,false);
 assert.equal(humanTouched.sloChecks.allInitialSlosMet,false);
 assert.equal(humanTouched.cycleMetrics[0].countedAsDeliveredWork,false);
 assert.equal(humanTouched.cycleMetrics[1].countedAsDeliveredWork,true);

 const exactDrainBoundary=evaluateDossier(dossierInput({
  cycles:[
   dossierCycle(1,{eligibleAt:200_000,prMergedAt:320_000,mainVerifiedAt:325_000,acceptanceVerifiedAt:330_000,automatedCiMs:74_999}),
   dossierCycle(2,{eligibleAt:300_000,prMergedAt:420_000,mainVerifiedAt:425_000,acceptanceVerifiedAt:430_000,automatedCiMs:74_999}),
   dossierCycle(3,{eligibleAt:400_000,prMergedAt:520_000,mainVerifiedAt:525_000,acceptanceVerifiedAt:530_000,automatedCiMs:74_999})
  ]
 }));
 assert.equal(exactDrainBoundary.m01ExitEvidenceReady,true);
 assert.equal(exactDrainBoundary.batchDrainMs,120_000);
 assert.equal(exactDrainBoundary.automatedCiP50Ms,74_999);
 assert.equal(exactDrainBoundary.sloChecks.batchDrainMet,true);
 assert.equal(exactDrainBoundary.sloChecks.batchDrainStretchMet,false);
 assert.equal(exactDrainBoundary.sloChecks.automatedCiP50Met,true);
 assert.equal(exactDrainBoundary.sloChecks.automatedCiStretchMet,false);
 assert.equal(exactDrainBoundary.sloChecks.allInitialSlosMet,true);

 const exceededDrainAndOutlier=evaluateDossier(dossierInput({
  cycles:[
   dossierCycle(1,{issueReadyAt:0,prCreatedAt:600_001,eligibleAt:700_000,prMergedAt:820_001,mainVerifiedAt:1_500_002,acceptanceVerifiedAt:1_500_005,automatedCiMs:75_000}),
   dossierCycle(2,{issueReadyAt:0,prCreatedAt:600_001,eligibleAt:700_000,prMergedAt:750_000,mainVerifiedAt:1_500_002,acceptanceVerifiedAt:1_500_005,automatedCiMs:75_000}),
   dossierCycle(3,{issueReadyAt:0,prCreatedAt:600_001,eligibleAt:700_000,prMergedAt:760_000,mainVerifiedAt:1_500_002,acceptanceVerifiedAt:1_500_005,automatedCiMs:75_000})
  ]
 }));
 assert.equal(exceededDrainAndOutlier.m01ExitEvidenceReady,true);
 assert.equal(exceededDrainAndOutlier.reason,'CUSTOMER_ONE_EXIT_EVIDENCE_READY_ONLY');
 assert.equal(exceededDrainAndOutlier.batchDrainMs,120_001);
 assert.equal(exceededDrainAndOutlier.automatedCiP50Ms,75_000);
 assert.equal(exceededDrainAndOutlier.issueReadyToOutcomeMs.outlierOver25mCount,3);
 assert.equal(exceededDrainAndOutlier.sloChecks.issueReadyToPrP50Met,false);
 assert.equal(exceededDrainAndOutlier.sloChecks.prToCompleteP50Met,false);
 assert.equal(exceededDrainAndOutlier.sloChecks.issueReadyToOutcomeP50Met,false);
 assert.equal(exceededDrainAndOutlier.sloChecks.automatedCiP50Met,false);
 assert.equal(exceededDrainAndOutlier.sloChecks.batchDrainMet,false);
 assert.equal(exceededDrainAndOutlier.sloChecks.allInitialSlosMet,false);

 // PR-to-complete ends at verified main, so slow post-main issue acceptance does not falsely fail prToCompleteMs.
 const acceptanceDelayAfterFastMain=evaluateDossier(dossierInput({
  cycles:[
   dossierCycle(1,{issueReadyAt:0,prCreatedAt:100_000,eligibleAt:200_000,prMergedAt:250_000,mainVerifiedAt:300_000,acceptanceVerifiedAt:1_500_001,automatedCiMs:40_000}),
   dossierCycle(2,{issueReadyAt:0,prCreatedAt:100_000,eligibleAt:200_000,prMergedAt:250_000,mainVerifiedAt:300_000,acceptanceVerifiedAt:1_500_001,automatedCiMs:40_000}),
   dossierCycle(3,{issueReadyAt:0,prCreatedAt:100_000,eligibleAt:200_000,prMergedAt:250_000,mainVerifiedAt:300_000,acceptanceVerifiedAt:1_500_001,automatedCiMs:40_000})
  ]
 }));
 assert.equal(acceptanceDelayAfterFastMain.prToCompleteMs.p50Ms,200_000);
 assert.equal(acceptanceDelayAfterFastMain.sloChecks.issueReadyToPrP50Met,true);
 assert.equal(acceptanceDelayAfterFastMain.sloChecks.prToCompleteP50Met,true);
 assert.equal(acceptanceDelayAfterFastMain.sloChecks.issueReadyToOutcomeP50Met,false);
 assert.equal(acceptanceDelayAfterFastMain.sloChecks.allInitialSlosMet,false);

 const prToCompleteMissOnly=evaluateDossier(dossierInput({
  cycles:[
   dossierCycle(1,{issueReadyAt:0,prCreatedAt:100_000,eligibleAt:900_000,prMergedAt:950_000,mainVerifiedAt:1_000_001,acceptanceVerifiedAt:1_100_000,automatedCiMs:40_000}),
   dossierCycle(2,{issueReadyAt:0,prCreatedAt:100_000,eligibleAt:900_000,prMergedAt:950_000,mainVerifiedAt:1_000_001,acceptanceVerifiedAt:1_100_000,automatedCiMs:40_000}),
   dossierCycle(3,{issueReadyAt:0,prCreatedAt:100_000,eligibleAt:900_000,prMergedAt:950_000,mainVerifiedAt:1_000_001,acceptanceVerifiedAt:1_100_000,automatedCiMs:40_000})
  ]
 }));
 assert.equal(prToCompleteMissOnly.prToCompleteMs.p50Ms,900_001);
 assert.equal(prToCompleteMissOnly.sloChecks.issueReadyToPrP50Met,true);
 assert.equal(prToCompleteMissOnly.sloChecks.prToCompleteP50Met,false);
 assert.equal(prToCompleteMissOnly.sloChecks.issueReadyToOutcomeP50Met,true);
 assert.equal(prToCompleteMissOnly.sloChecks.allInitialSlosMet,false);

 const eligibleToMergeP95MissOnly=evaluateDossier(dossierInput({
  cycles:[
   dossierCycle(1,{issueReadyAt:0,prCreatedAt:50_000,eligibleAt:100_000,prMergedAt:220_001,mainVerifiedAt:230_000,acceptanceVerifiedAt:240_000,automatedCiMs:40_000}),
   dossierCycle(2,{issueReadyAt:0,prCreatedAt:50_000,eligibleAt:300_000,prMergedAt:320_000,mainVerifiedAt:330_000,acceptanceVerifiedAt:340_000,automatedCiMs:40_000}),
   dossierCycle(3,{issueReadyAt:0,prCreatedAt:50_000,eligibleAt:400_000,prMergedAt:420_000,mainVerifiedAt:430_000,acceptanceVerifiedAt:440_000,automatedCiMs:40_000})
  ]
 }));
 assert.equal(eligibleToMergeP95MissOnly.sloChecks.issueReadyToOutcomeP50Met,true);
 assert.equal(eligibleToMergeP95MissOnly.sloChecks.eligibleToMergeP95Met,false);
 assert.equal(eligibleToMergeP95MissOnly.sloChecks.allInitialSlosMet,false);

 const ciMissOnly=evaluateDossier(dossierInput({
  cycles:[
   dossierCycle(1,{automatedCiMs:75_000}),
   dossierCycle(2,{automatedCiMs:75_000}),
   dossierCycle(3,{automatedCiMs:75_000})
  ]
 }));
 assert.equal(ciMissOnly.sloChecks.eligibleToMergeP95Met,true);
 assert.equal(ciMissOnly.sloChecks.automatedCiP50Met,false);
 assert.equal(ciMissOnly.sloChecks.allInitialSlosMet,false);
});

test('Customer One dossier fails closed on proxies, getters, custom prototypes, mixed provenance, and invalid inputs without executing traps',()=>{
 let traps=0;
 const trap=()=>{traps++;throw Error('unexpected dossier trap');};

 const inputProxy=new Proxy(dossierInput(),{get:trap,getOwnPropertyDescriptor:trap,ownKeys:trap,getPrototypeOf:trap});
 const revokedInput=Proxy.revocable(dossierInput(),{});revokedInput.revoke();
 const getterInput=dossierInput();Object.defineProperty(getterInput,'pin',{get:trap,enumerable:true});
 const nonEnumInput=dossierInput();Object.defineProperty(nonEnumInput,'pin',{value:'a'.repeat(40),enumerable:false});
 const extraKeyInput={...dossierInput(),extra:true};
 const missingKeyInput=dossierInput();delete missingKeyInput.pin;
 const symbolKeyInput=dossierInput();symbolKeyInput[Symbol('tag')]=1;

 for(const bad of [null,'bad',123,[],Object.create(dossierInput()),inputProxy,revokedInput.proxy,getterInput,nonEnumInput,extraKeyInput,missingKeyInput,symbolKeyInput]){
  const res=evaluateDossier(bad);
  assert.equal(res.pilotEntryReady,false);
  assert.equal(res.m01ExitEvidenceReady,false);
  assert.equal(res.liveActivation,false);
  assert.equal(res.accepted,false);
  assert.equal(res.reason,'EVIDENCE_UNKNOWN');
  assert.deepEqual(res.verifiedPrerequisites,[]);
  assert.deepEqual(res.blockingPrerequisites,M01_CUSTOMER_ONE_PREREQUISITES);
 }

 for(const badPolicy of [
  {repositoryId:0},
  {repositoryId:-1},
  {pin:'bad'},
  {enrolled:'true'},
  {stop:'false'},
  {lineMin:Number.NaN},
  {lineMin:97},
  {lineMin:101},
  {branchMin:Number.NaN},
  {branchMin:94},
  {branchMin:101}
 ])assert.equal(evaluateDossier(dossierInput(badPolicy)).reason,'POLICY_UNKNOWN');

 assert.equal(evaluateDossier(dossierInput({repositoryId:2})).reason,'IDENTITY_OR_PIN');

 for(const badWorker of [
  {actualWorkerMax:null,workerShortfallFrom12:12},
  {actualWorkerMax:-1,workerShortfallFrom12:13},
  {actualWorkerMax:1001,workerShortfallFrom12:0},
  {actualWorkerMax:4,workerShortfallFrom12:null},
  {actualWorkerMax:4,workerShortfallFrom12:7},
  {actualWorkerMax:16,workerShortfallFrom12:1}
 ])assert.equal(evaluateDossier(dossierInput(badWorker)).reason,'WORKER_CAPACITY_UNKNOWN');
 assert.equal(evaluateDossier(dossierInput({actualWorkerMax:16,workerShortfallFrom12:0})).m01ExitEvidenceReady,true);

 const prereqProxy=new Proxy({...allCustomerOnePrereqsTrue},{get:trap,getOwnPropertyDescriptor:trap});
 const prereqGetter={...allCustomerOnePrereqsTrue};Object.defineProperty(prereqGetter,'noPythonVerified',{get:trap,enumerable:true});
 const prereqMissing={...allCustomerOnePrereqsTrue};delete prereqMissing.noPythonVerified;
 for(const badPrereq of [null,[],prereqProxy,prereqGetter,prereqMissing,{...allCustomerOnePrereqsTrue,extra:true},{...allCustomerOnePrereqsTrue,noPythonVerified:'true'},{...allCustomerOnePrereqsTrue,mainCodeqlHealthy:null}])
  assert.equal(evaluateDossier(dossierInput({prerequisites:badPrereq})).reason,'PREREQUISITES_UNKNOWN');

 const compProxy=new Proxy(inventory,{get:trap,getOwnPropertyDescriptor:trap});
 const compGetter=[...inventory];Object.defineProperty(compGetter,0,{get:trap,enumerable:true});
 for(const badComp of [null,'core',compProxy,compGetter,new Array(2),[],['BAD NAME'],['core','core']])
  assert.equal(evaluateDossier(dossierInput({expectedComponents:badComp})).reason,'INVENTORY_UNKNOWN');

 const cyclesProxy=new Proxy([dossierCycle(1)],{get:trap,getOwnPropertyDescriptor:trap});
 const revokedCycles=Proxy.revocable([dossierCycle(1)],{});revokedCycles.revoke();
 const cyclesGetter=[dossierCycle(1)];Object.defineProperty(cyclesGetter,0,{get:trap,enumerable:true});
 const cyclesSubclass=Object.setPrototypeOf([dossierCycle(1)],Object.create(Array.prototype));
 const rowProxy=new Proxy(dossierCycle(1),{get:trap,getOwnPropertyDescriptor:trap});
 const rowGetter=dossierCycle(1);Object.defineProperty(rowGetter,'head',{get:trap,enumerable:true});
 const rowMissing=dossierCycle(1);delete rowMissing.automatedCiMs;
 for(const badCycles of [
  null,
  {},
  cyclesProxy,
  revokedCycles.proxy,
  cyclesGetter,
  cyclesSubclass,
  new Array(3),
  Array(51).fill(dossierCycle(1)),
  [null],
  [rowProxy],
  [rowGetter],
  [rowMissing],
  [{...dossierCycle(1),extra:1}]
 ])assert.equal(evaluateDossier(dossierInput({cycles:badCycles})).reason,'CYCLE_INVENTORY_UNKNOWN');

 for(const badSource of ['historical-github-proxy','manual',null])
  assert.equal(evaluateDossier(dossierInput({cycles:[dossierCycle(1,{source:badSource})]})).reason,'SOURCE_UNKNOWN');

 assert.equal(evaluateDossier(dossierInput({
  cycles:[dossierCycle(1,{source:'synthetic'}),dossierCycle(2,{source:'github-hosted'}),dossierCycle(3,{source:'github-hosted'})]
 })).reason,'PROVENANCE_ISOLATION_VIOLATION');

 for(const badId of [
  {repositoryId:2},
  {issue:0},
  {pr:0},
  {head:'bad'},
  {reviewedHead:'b'.repeat(40)}
 ])assert.equal(evaluateDossier(dossierInput({cycles:[dossierCycle(1,badId),dossierCycle(2),dossierCycle(3)]})).reason,'IDENTITY_OR_REVIEW_UNKNOWN');

 const dupHead=(2).toString(16).padStart(40,'0');
 for(const dup of [
  {issue:2},
  {pr:202},
  {head:dupHead,reviewedHead:dupHead,coverageReports:reports(dupHead)}
 ])assert.equal(evaluateDossier(dossierInput({cycles:[dossierCycle(1,dup),dossierCycle(2),dossierCycle(3)]})).reason,'DUPLICATE_CYCLE');

 for(const badSafety of [
  {reviewIndependent:false},
  {checksPassed:false},
  {securityClear:false},
  {threadsResolved:false},
  {mainVerified:false},
  {costVerified:false},
  {acceptanceVerified:false},
  {laptopOfflineVerified:false},
  {extraCost:1},
  {unauthorizedWrites:1},
  {duplicateDispatches:1},
  {gateBypasses:1},
  {humanInterventions:-1},
  {humanInterventions:-0},
  {humanInterventions:null}
 ])assert.equal(evaluateDossier(dossierInput({cycles:[dossierCycle(1,badSafety),dossierCycle(2),dossierCycle(3)]})).reason,'SAFETY_OR_COST_UNKNOWN');

 const firstHead=(1).toString(16).padStart(40,'0');
 const badCovReports=inventory.map(component=>({component,head:firstHead,lines:97,lineTotal:100,branches:19,branchTotal:20}));
 assert.equal(evaluateDossier(dossierInput({
  cycles:[dossierCycle(1,{coverageReports:badCovReports}),dossierCycle(2),dossierCycle(3)]
 })).reason,'COVERAGE');
 assert.equal(evaluateDossier(dossierInput({lineMin:99})).reason,'COVERAGE');

 for(const badTiming of [
  {batchId:null},
  {batchId:''},
  {batchId:'bad space'},
  {batchStartedAt:-1},
  {issueReadyAt:-1},
  {automatedCiMs:-1},
  {issueReadyAt:200_000},
  {prCreatedAt:300_000},
  {eligibleAt:400_000},
  {prMergedAt:500_000},
  {mainVerifiedAt:600_000},
  {reviewFix:'true'},
  {parallelCandidate:null}
 ])assert.equal(evaluateDossier(dossierInput({cycles:[dossierCycle(1,badTiming),dossierCycle(2),dossierCycle(3)]})).reason,'TIMING_OR_SCENARIO_UNKNOWN');

 // Mismatched batchStartedAt, batchStartedAt outside [minEligibleAt, minMergedAt], or disjoint waves reusing one batchId fail closed.
 assert.equal(evaluateDossier(dossierInput({
  cycles:[
   dossierCycle(1,{batchId:'shared',batchStartedAt:121_000}),
   dossierCycle(2,{batchId:'shared',batchStartedAt:122_000}),
   dossierCycle(3)
  ]
 })).reason,'BATCH_BOUNDARY_UNKNOWN');
 assert.equal(evaluateDossier(dossierInput({
  cycles:[
   dossierCycle(1,{batchId:'b1',batchStartedAt:120_999,eligibleAt:121_000}),
   dossierCycle(2),
   dossierCycle(3)
  ]
 })).reason,'BATCH_BOUNDARY_UNKNOWN');
 assert.equal(evaluateDossier(dossierInput({
  cycles:[
   dossierCycle(1,{batchId:'b1',batchStartedAt:131_001,eligibleAt:121_000,prMergedAt:131_000}),
   dossierCycle(2),
   dossierCycle(3)
  ]
 })).reason,'BATCH_BOUNDARY_UNKNOWN');
 assert.equal(evaluateDossier(dossierInput({
  cycles:[
   dossierCycle(1,{batchId:'disjoint',batchStartedAt:121_000,eligibleAt:121_000,prMergedAt:131_000}),
   dossierCycle(2,{batchId:'disjoint',batchStartedAt:121_000,eligibleAt:241_000,prMergedAt:261_000}),
   dossierCycle(3)
  ]
 })).reason,'BATCH_BOUNDARY_UNKNOWN');

 assert.equal(traps,0);
});

const consolidatedCycle=(n,extra={})=>{
 const head=(10+n).toString(16).padStart(40,'0');
 const isParallel=n<=2;
 return {
  source:'github-hosted',
  agentLogin:'copilot-swe-agent[bot]',
  repositoryId:1471342715,
  issue:300+n,
  pr:400+n,
  head,
  reviewedHead:head,
  changedFiles:[`tools/engineering-factory/lane-${n}.mjs`,`tests/engineering-factory/lane-${n}.test.mjs`],
  reviewIndependent:true,
  checksPassed:true,
  securityClear:true,
  threadsResolved:true,
  squashQueueMerged:true,
  mainVerified:true,
  costVerified:true,
  acceptanceVerified:true,
  coverageReports:reports(head),
  humanInterventions:0,
  incrementalBilledUsdCents:0,
  unauthorizedWrites:0,
  duplicateDispatches:0,
  gateBypasses:0,
  startedAt:isParallel?10_000+n*1_000:50_000,
  mergedAt:isParallel?30_000+n*1_000:70_000,
  reviewFix:n===3,
  parallelCandidate:isParallel,
  ...extra
 };
};

const consolidatedInput=(extra={})=>({
 repositoryId:1471342715,
 pin:'e'.repeat(40),
 enrolled:true,
 stop:false,
 lineMin:98,
 branchMin:95,
 prerequisites:{...allCustomerOnePrereqsTrue},
 expectedComponents:inventory,
 cycles:[consolidatedCycle(1),consolidatedCycle(2),consolidatedCycle(3)],
 ...extra
});

test('Consolidated M01 exit gate enforces >=3 real @copilot issues, >=2 parallel non-overlapping candidates, >=1 review repair, 0 human touches, $0 spend, and 98/95 coverage',()=>{
 assert.deepEqual(M01_CONSOLIDATED_EXIT_CONTRACT,{
  minAcceptedIssues:3,
  minParallelNonOverlappingCandidates:2,
  minReviewRepairCycles:1,
  maxHumanInterventions:0,
  maxIncrementalBilledUsdCents:0,
  lineMin:98,
  branchMin:95,
  requiredAgentLogin:'copilot-swe-agent[bot]'
 });

 const ready=evaluateExitGate(consolidatedInput());
 assert.deepEqual(ready,{
  shadow:true,
  liveActivation:false,
  accepted:false,
  pilotEntryReady:true,
  exitGateReady:true,
  m01ExitEvidenceReady:true,
  reason:'CONSOLIDATED_M01_EXIT_EVIDENCE_READY_ONLY',
  verifiedPrerequisites:M01_CUSTOMER_ONE_PREREQUISITES,
  blockingPrerequisites:[],
  cycleSource:'github-hosted',
  sampleCount:3,
  deliveredCycleCount:3,
  syntheticCycleCount:0,
  deliveredCyclesShortfallFrom3:0,
  parallelNonOverlappingCount:2,
  reviewRepairCount:1,
  humanInterventions:0,
  incrementalBilledUsdCents:0
 });

 // Sequential post-merge reuse of a file from an earlier wave is valid once the earlier PR merged.
 const postMergeSequentialFileReuse=evaluateExitGate(consolidatedInput({
  cycles:[
   consolidatedCycle(1,{changedFiles:['tools/engineering-factory/lane-1.mjs'],startedAt:10_000,mergedAt:20_000,parallelCandidate:true}),
   consolidatedCycle(2,{changedFiles:['tools/engineering-factory/lane-2.mjs'],startedAt:12_000,mergedAt:22_000,parallelCandidate:true}),
   consolidatedCycle(3,{changedFiles:['tools/engineering-factory/lane-1.mjs'],startedAt:25_000,mergedAt:35_000,parallelCandidate:false,reviewFix:true})
  ]
 }));
 assert.equal(postMergeSequentialFileReuse.exitGateReady,true);

 // Reverse chronological cycle ordering exercises both interval-overlap arms cleanly.
 const reverseOrder=evaluateExitGate(consolidatedInput({
  cycles:[consolidatedCycle(3),consolidatedCycle(2),consolidatedCycle(1)]
 }));
 assert.equal(reverseOrder.exitGateReady,true);
 assert.equal(reverseOrder.parallelNonOverlappingCount,2);

 // Overlapping execution windows with non-parallelCandidate flag still enforce disjoint files, without inflating parallelNonOverlappingCount.
 const overlapWithoutFlag=evaluateExitGate(consolidatedInput({
  cycles:[
   consolidatedCycle(1,{startedAt:10_000,mergedAt:30_000,parallelCandidate:true}),
   consolidatedCycle(2,{startedAt:12_000,mergedAt:32_000,parallelCandidate:false}),
   consolidatedCycle(3,{startedAt:50_000,mergedAt:70_000,parallelCandidate:false,reviewFix:true})
  ]
 }));
 assert.equal(overlapWithoutFlag.exitGateReady,false);
 assert.equal(overlapWithoutFlag.parallelNonOverlappingCount,0);
 assert.equal(overlapWithoutFlag.reason,'SCENARIO_MISSING');

 // Two parallelCandidate cycles that ran sequentially do not count as parallel non-overlapping candidates.
 const sequentialFakeParallel=evaluateExitGate(consolidatedInput({
  cycles:[
   consolidatedCycle(1,{startedAt:10_000,mergedAt:20_000,parallelCandidate:true}),
   consolidatedCycle(2,{startedAt:20_000,mergedAt:30_000,parallelCandidate:true}),
   consolidatedCycle(3,{startedAt:40_000,mergedAt:50_000,parallelCandidate:false,reviewFix:true})
  ]
 }));
 assert.equal(sequentialFakeParallel.exitGateReady,false);
 assert.equal(sequentialFakeParallel.parallelNonOverlappingCount,0);
 assert.equal(sequentialFakeParallel.reason,'SCENARIO_MISSING');

 // Missing review-repair scenario fails closed even when >=2 parallel non-overlapping candidates pass.
 const missingRepair=evaluateExitGate(consolidatedInput({
  cycles:[consolidatedCycle(1),consolidatedCycle(2),consolidatedCycle(3,{reviewFix:false})]
 }));
 assert.equal(missingRepair.exitGateReady,false);
 assert.equal(missingRepair.parallelNonOverlappingCount,2);
 assert.equal(missingRepair.reviewRepairCount,0);
 assert.equal(missingRepair.reason,'SCENARIO_MISSING');

 // Concurrent file overlap (including case-only collisions across cross-OS runners) fails closed immediately.
 const overlappingFiles=evaluateExitGate(consolidatedInput({
  cycles:[
   consolidatedCycle(1,{changedFiles:['tools/engineering-factory/Shared.mjs']}),
   consolidatedCycle(2,{changedFiles:['tools/engineering-factory/shared.mjs']}),
   consolidatedCycle(3)
  ]
 }));
 assert.equal(overlappingFiles.exitGateReady,false);
 assert.equal(overlappingFiles.reason,'PARALLEL_FILE_OVERLAP');

 // Synthetic cycles never count as delivered work.
 const syntheticOnly=evaluateExitGate(consolidatedInput({
  cycles:[1,2,3].map(n=>consolidatedCycle(n,{source:'synthetic'}))
 }));
 assert.equal(syntheticOnly.pilotEntryReady,true);
 assert.equal(syntheticOnly.exitGateReady,false);
 assert.equal(syntheticOnly.reason,'SYNTHETIC_CYCLES_NOT_DELIVERED_WORK');
 assert.equal(syntheticOnly.deliveredCycleCount,0);
 assert.equal(syntheticOnly.syntheticCycleCount,3);
 assert.equal(syntheticOnly.deliveredCyclesShortfallFrom3,3);
 assert.equal(syntheticOnly.parallelNonOverlappingCount,0);
 assert.equal(syntheticOnly.reviewRepairCount,0);

 // Any incremental billed spend > 0 fails closed and excludes the cycle from delivered work.
 const billedSpend=evaluateExitGate(consolidatedInput({
  cycles:[consolidatedCycle(1,{incrementalBilledUsdCents:1}),consolidatedCycle(2),consolidatedCycle(3)]
 }));
 assert.equal(billedSpend.exitGateReady,false);
 assert.equal(billedSpend.reason,'INCREMENTAL_BILLED_SPEND_NONZERO');
 assert.equal(billedSpend.incrementalBilledUsdCents,1);
 assert.equal(billedSpend.deliveredCycleCount,2);
 assert.equal(billedSpend.parallelNonOverlappingCount,0);

 // Any human intervention > 0 fails closed and excludes the cycle from delivered work.
 const humanIntervention=evaluateExitGate(consolidatedInput({
  cycles:[consolidatedCycle(1),consolidatedCycle(2),consolidatedCycle(3,{humanInterventions:1})]
 }));
 assert.equal(humanIntervention.exitGateReady,false);
 assert.equal(humanIntervention.reason,'HUMAN_INTERVENTION_NONZERO');
 assert.equal(humanIntervention.humanInterventions,1);
 assert.equal(humanIntervention.deliveredCycleCount,2);
 assert.equal(humanIntervention.reviewRepairCount,0);

 // Fewer than 3 live cycles remain pending when clean.
 const pendingTwo=evaluateExitGate(consolidatedInput({cycles:[consolidatedCycle(1),consolidatedCycle(2)]}));
 assert.equal(pendingTwo.exitGateReady,false);
 assert.equal(pendingTwo.reason,'LIVE_CYCLES_PENDING');
 assert.equal(pendingTwo.deliveredCycleCount,2);
 assert.equal(pendingTwo.deliveredCyclesShortfallFrom3,1);

 const emptyLive=evaluateExitGate(consolidatedInput({cycles:[]}));
 assert.equal(emptyLive.exitGateReady,false);
 assert.equal(emptyLive.reason,'LIVE_CYCLES_PENDING');
 assert.equal(emptyLive.humanInterventions,null);
 assert.equal(emptyLive.incrementalBilledUsdCents,null);

 assert.equal(evaluateExitGate(consolidatedInput({stop:true})).reason,'STOPPED');
 assert.equal(evaluateExitGate(consolidatedInput({enrolled:false})).reason,'STOPPED');
 for(const key of M01_CUSTOMER_ONE_PREREQUISITES){
  const blocked=evaluateExitGate(consolidatedInput({
   prerequisites:{...allCustomerOnePrereqsTrue,[key]:false}
  }));
  assert.equal(blocked.pilotEntryReady,false);
  assert.equal(blocked.exitGateReady,false);
  assert.equal(blocked.reason,'PILOT_ENTRY_BLOCKED');
  assert.deepEqual(blocked.blockingPrerequisites,[key]);
 }
});

test('Consolidated M01 exit gate fails closed on invalid inputs, non-bot identities, malformed paths, coverage shortfalls, and proxy/getter traps',()=>{
 let traps=0;
 const trap=()=>{traps++;throw Error('unexpected consolidated exit trap');};

 const inputProxy=new Proxy(consolidatedInput(),{get:trap,getOwnPropertyDescriptor:trap,ownKeys:trap,getPrototypeOf:trap});
 const getterInput=consolidatedInput();Object.defineProperty(getterInput,'pin',{get:trap,enumerable:true});
 const missingInput=consolidatedInput();delete missingInput.cycles;
 for(const bad of [null,'bad',[],Object.create(consolidatedInput()),inputProxy,getterInput,missingInput,{...consolidatedInput(),extra:1}]){
  const res=evaluateExitGate(bad);
  assert.equal(res.exitGateReady,false);
  assert.equal(res.liveActivation,false);
  assert.equal(res.accepted,false);
  assert.equal(res.reason,'EVIDENCE_UNKNOWN');
 }

 for(const badPolicy of [
  {repositoryId:0},
  {pin:'bad'},
  {enrolled:null},
  {stop:null},
  {lineMin:97},
  {lineMin:101},
  {lineMin:Number.NaN},
  {branchMin:94},
  {branchMin:101},
  {branchMin:Number.NaN}
 ])assert.equal(evaluateExitGate(consolidatedInput(badPolicy)).reason,'POLICY_UNKNOWN');

 assert.equal(evaluateExitGate(consolidatedInput({repositoryId:2})).reason,'IDENTITY_OR_PIN');

 const badPrereqGetter={...allCustomerOnePrereqsTrue};Object.defineProperty(badPrereqGetter,'hardStopBillingVerified',{get:trap,enumerable:true});
 for(const badPrereq of [null,[],badPrereqGetter,{...allCustomerOnePrereqsTrue,hardStopBillingVerified:'true'}])
  assert.equal(evaluateExitGate(consolidatedInput({prerequisites:badPrereq})).reason,'PREREQUISITES_UNKNOWN');

 for(const badComp of [null,[],['INVALID_UPPER'],['core','core']])
  assert.equal(evaluateExitGate(consolidatedInput({expectedComponents:badComp})).reason,'INVENTORY_UNKNOWN');

 const rowProxy=new Proxy(consolidatedCycle(1),{get:trap,getOwnPropertyDescriptor:trap});
 const rowGetter=consolidatedCycle(1);Object.defineProperty(rowGetter,'agentLogin',{get:trap,enumerable:true});
 for(const badCycles of [null,new Array(3),Array(51).fill(consolidatedCycle(1)),[null],[rowProxy],[rowGetter],[{...consolidatedCycle(1),extra:true}]])
  assert.equal(evaluateExitGate(consolidatedInput({cycles:badCycles})).reason,'CYCLE_INVENTORY_UNKNOWN');

 assert.equal(evaluateExitGate(consolidatedInput({cycles:[consolidatedCycle(1,{source:'manual'})]})).reason,'SOURCE_UNKNOWN');
 assert.equal(evaluateExitGate(consolidatedInput({
  cycles:[consolidatedCycle(1,{source:'synthetic'}),consolidatedCycle(2,{source:'github-hosted'}),consolidatedCycle(3)]
 })).reason,'PROVENANCE_ISOLATION_VIOLATION');

 for(const badAgent of [null,'','@copilot','cyrusjamula','github-actions[bot]'])
  assert.equal(evaluateExitGate(consolidatedInput({cycles:[consolidatedCycle(1,{agentLogin:badAgent})]})).reason,'AGENT_IDENTITY_UNKNOWN');

 for(const badId of [{repositoryId:2},{issue:0},{pr:0},{head:'bad'},{reviewedHead:'f'.repeat(40)}])
  assert.equal(evaluateExitGate(consolidatedInput({cycles:[consolidatedCycle(1,badId),consolidatedCycle(2),consolidatedCycle(3)]})).reason,'IDENTITY_OR_REVIEW_UNKNOWN');

 const c2Head=(12).toString(16).padStart(40,'0');
 for(const dup of [{issue:302},{pr:402},{head:c2Head,reviewedHead:c2Head,coverageReports:reports(c2Head)}])
  assert.equal(evaluateExitGate(consolidatedInput({cycles:[consolidatedCycle(1,dup),consolidatedCycle(2),consolidatedCycle(3)]})).reason,'DUPLICATE_CYCLE');

 const filesGetter=['tools/a.mjs'];Object.defineProperty(filesGetter,0,{get:trap,enumerable:true});
 for(const badFiles of [
  null,
  [],
  filesGetter,
  [123],
  [''],
  ['a'.repeat(241)],
  ['/leading/slash.mjs'],
  ['trailing/slash/'],
  ['back\\slash.mjs'],
  ['double//slash.mjs'],
  ['control\u0000char.mjs'],
  ['./dot.mjs'],
  ['tools/../escape.mjs'],
  [' tools/padded.mjs'],
  ['tools/Dup.mjs','tools/dup.mjs']
 ])assert.equal(evaluateExitGate(consolidatedInput({cycles:[consolidatedCycle(1,{changedFiles:badFiles})]})).reason,'CHANGED_FILES_UNKNOWN');

 for(const badSafety of [
  {reviewIndependent:false},
  {checksPassed:false},
  {securityClear:false},
  {threadsResolved:false},
  {squashQueueMerged:false},
  {mainVerified:false},
  {costVerified:false},
  {acceptanceVerified:false},
  {unauthorizedWrites:1},
  {duplicateDispatches:1},
  {gateBypasses:1},
  {humanInterventions:-1},
  {humanInterventions:-0},
  {incrementalBilledUsdCents:-1},
  {incrementalBilledUsdCents:null}
 ])assert.equal(evaluateExitGate(consolidatedInput({cycles:[consolidatedCycle(1,badSafety),consolidatedCycle(2),consolidatedCycle(3)]})).reason,'SAFETY_OR_COST_UNKNOWN');

 const c1Head=(11).toString(16).padStart(40,'0');
 assert.equal(evaluateExitGate(consolidatedInput({
  cycles:[
   consolidatedCycle(1,{coverageReports:inventory.map(component=>({component,head:c1Head,lines:97,lineTotal:100,branches:19,branchTotal:20}))}),
   consolidatedCycle(2),
   consolidatedCycle(3)
  ]
 })).reason,'COVERAGE');
 assert.equal(evaluateExitGate(consolidatedInput({
  cycles:[
   consolidatedCycle(1,{coverageReports:inventory.map(component=>({component,head:c1Head,lines:98,lineTotal:100,branches:18,branchTotal:20}))}),
   consolidatedCycle(2),
   consolidatedCycle(3)
  ]
 })).reason,'COVERAGE');
 assert.equal(evaluateExitGate(consolidatedInput({lineMin:99})).reason,'COVERAGE');

 for(const badTiming of [
  {startedAt:-1},
  {mergedAt:-1},
  {startedAt:31_000,mergedAt:31_000},
  {startedAt:32_000,mergedAt:31_000},
  {reviewFix:null},
  {parallelCandidate:'true'}
 ])assert.equal(evaluateExitGate(consolidatedInput({cycles:[consolidatedCycle(1,badTiming),consolidatedCycle(2),consolidatedCycle(3)]})).reason,'TIMING_OR_SCENARIO_UNKNOWN');

 assert.equal(traps,0);
});
