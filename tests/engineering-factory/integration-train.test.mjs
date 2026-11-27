import test from 'node:test';
import assert from 'node:assert/strict';
import {
 compareTrainExperiment as compare,
 evaluateEngineExperiment,
 evaluateThroughputCheckpoints,
 nextIntegration as next,
 queueAdapter
} from '../../tools/engineering-factory/integration-train.mjs';
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

const baseCohort = {
 cohort: 'm02-train-v1',
 workload: main,
 gateSet: head,
 complete: true,
 windowMs: 86400000,
 accepted: 5,
 censored: 1,
 gatesPassed: true,
 independentReview: true,
 mainHealthy: true,
 compatibleTrain: true,
 rollbackReady: true,
 duplicateDispatches: 0,
 unauthorizedWrites: 0,
 coveredLines: 990,
 totalLines: 1000,
 coveredBranches: 960,
 totalBranches: 1000,
 rework: 2,
 humanInterventions: 1,
 costVerified: true,
 incrementalSpendMicros: 0
};
const checkpointEvidence = {
 stop: false,
 repository: 'Jamula/SoftwareFactory',
 source: 'synthetic',
 policy: {minLinePercent: 98, minBranchPercent: 95},
 baseline: baseCohort,
 candidate: {...baseCohort, accepted: 50, censored: 0, rework: 1, humanInterventions: 0}
};
const checkpointDenied = reason => ({shadow: true, liveMerge: false, comparable: false, reason});

test('evaluates 2x through 25x throughput checkpoints and keeps stretch open until verified 25x', () => {
 const tenX = evaluateThroughputCheckpoints(checkpointEvidence);
 assert.equal(tenX.shadow, true);
 assert.equal(tenX.liveMerge, false);
 assert.equal(tenX.comparable, true);
 assert.equal(tenX.reason, 'CHECKPOINTS_EVALUATED');
 assert.equal(tenX.throughputRatio, 10);
 assert.equal(tenX.highestCheckpoint, '10x');
 assert.equal(tenX.keepStretchOpen, true);
 assert.deepEqual(tenX.checkpoints, [
  {checkpoint: '2x', multiplier: 2, met: true},
  {checkpoint: '5x', multiplier: 5, met: true},
  {checkpoint: '10x', multiplier: 10, met: true},
  {checkpoint: '15x', multiplier: 15, met: false},
  {checkpoint: '20x', multiplier: 20, met: false},
  {checkpoint: '25x', multiplier: 25, met: false}
 ]);
 assert.equal(tenX.baseline.acceptedPerDay, 5);
 assert.equal(tenX.candidate.acceptedPerDay, 50);

 const below2x = evaluateThroughputCheckpoints({
  ...checkpointEvidence,
  source: 'verified',
  candidate: {...baseCohort, accepted: 8, rework: 2, humanInterventions: 1}
 });
 assert.equal(below2x.comparable, true);
 assert.equal(below2x.reason, 'BELOW_FIRST_CHECKPOINT');
 assert.equal(below2x.highestCheckpoint, null);
 assert.equal(below2x.keepStretchOpen, true);

 const synthetic25x = evaluateThroughputCheckpoints({
  ...checkpointEvidence,
  source: 'synthetic',
  candidate: {...baseCohort, accepted: 125, rework: 0, humanInterventions: 0}
 });
 assert.equal(synthetic25x.highestCheckpoint, '25x');
 assert.equal(synthetic25x.keepStretchOpen, true);

 const verified25x = evaluateThroughputCheckpoints({
  ...checkpointEvidence,
  source: 'verified',
  candidate: {...baseCohort, accepted: 125, rework: 0, humanInterventions: 0}
 });
 assert.equal(verified25x.highestCheckpoint, '25x');
 assert.equal(verified25x.keepStretchOpen, false);

 for (const multiplier of [2, 5, 10, 15, 20, 25]) {
  const res = evaluateThroughputCheckpoints({
   ...checkpointEvidence,
   candidate: {...baseCohort, accepted: 5 * multiplier, rework: 0, humanInterventions: 0}
  });
  assert.equal(res.highestCheckpoint, `${multiplier}x`);
 }

 const spellbook = evaluateThroughputCheckpoints({
  ...checkpointEvidence,
  repository: 'Jamula/Spellbook',
  policy: {minLinePercent: 97, minBranchPercent: 90},
  baseline: {...baseCohort, coveredLines: 975, coveredBranches: 910},
  candidate: {...baseCohort, accepted: 25, coveredLines: 980, coveredBranches: 920}
 });
 assert.equal(spellbook.comparable, true);
 assert.equal(spellbook.highestCheckpoint, '5x');
});

test('throughput checkpoints fail closed on stop, policy, quality, coverage, rework, spend and regressions', () => {
 assert.deepEqual(evaluateThroughputCheckpoints({...checkpointEvidence, stop: true}),
  checkpointDenied('STOPPED'));

 for (const badPolicy of [
  {repository: 'Jamula/SoftwareFactory', policy: {minLinePercent: 97, minBranchPercent: 95}},
  {repository: 'Jamula/SoftwareFactory', policy: {minLinePercent: 98, minBranchPercent: 94}},
  {repository: 'jamula/softwarefactory', policy: {minLinePercent: 95, minBranchPercent: 90}},
  {repository: 'JAMULA/SoftwareFactory', policy: {minLinePercent: 98, minBranchPercent: 94}},
  {repository: 'Jamula/Spellbook', policy: {minLinePercent: 94, minBranchPercent: 90}},
  {repository: 'Jamula/Spellbook', policy: {minLinePercent: 95, minBranchPercent: 89}}
 ]) {
  assert.deepEqual(evaluateThroughputCheckpoints({...checkpointEvidence, ...badPolicy}),
   checkpointDenied('POLICY_BELOW_MINIMUM'));
 }

 for (const patch of [
  {cohort: 'other-cohort'},
  {workload: head},
  {gateSet: main},
  {complete: false},
  {accepted: 4}
 ]) {
  assert.deepEqual(evaluateThroughputCheckpoints({
   ...checkpointEvidence,
   candidate: {...checkpointEvidence.candidate, ...patch}
  }), checkpointDenied('UNMATCHED_OR_INCOMPLETE_COHORT'));
 }
 assert.deepEqual(evaluateThroughputCheckpoints({
  ...checkpointEvidence,
  baseline: {...baseCohort, complete: false}
 }), checkpointDenied('UNMATCHED_OR_INCOMPLETE_COHORT'));
 assert.deepEqual(evaluateThroughputCheckpoints({
  ...checkpointEvidence,
  baseline: {...baseCohort, accepted: 4}
 }), checkpointDenied('UNMATCHED_OR_INCOMPLETE_COHORT'));

 for (const gatePatch of [
  {gatesPassed: false},
  {independentReview: false},
  {mainHealthy: false},
  {compatibleTrain: false},
  {rollbackReady: false},
  {duplicateDispatches: 1},
  {unauthorizedWrites: 1}
 ]) {
  assert.deepEqual(evaluateThroughputCheckpoints({
   ...checkpointEvidence,
   candidate: {...checkpointEvidence.candidate, ...gatePatch}
  }), checkpointDenied('QUALITY_OR_SAFETY_GATE_FAILED'));
  assert.deepEqual(evaluateThroughputCheckpoints({
   ...checkpointEvidence,
   baseline: {...baseCohort, ...gatePatch}
  }), checkpointDenied('QUALITY_OR_SAFETY_GATE_FAILED'));
 }

 for (const [baseCov, candCov] of [
  [{coveredLines: 979}, {}],
  [{coveredBranches: 949}, {}],
  [{}, {coveredLines: 979}],
  [{}, {coveredBranches: 949}],
  [{coveredLines: 995}, {coveredLines: 990}],
  [{coveredBranches: 970}, {coveredBranches: 960}]
 ]) {
  assert.deepEqual(evaluateThroughputCheckpoints({
   ...checkpointEvidence,
   baseline: {...baseCohort, ...baseCov},
   candidate: {...checkpointEvidence.candidate, ...candCov}
  }), checkpointDenied('COVERAGE_REGRESSION'));
 }

 for (const [basePatch, candPatch] of [
  [{}, {rework: 3}],
  [{}, {humanInterventions: 2}],
  [{accepted: 10, windowMs: 172800000, rework: 2}, {accepted: 5, windowMs: 43200000, rework: 2, humanInterventions: 0}],
  [{accepted: 10, windowMs: 172800000, humanInterventions: 2}, {accepted: 5, windowMs: 43200000, rework: 0, humanInterventions: 2}]
 ]) {
  assert.deepEqual(evaluateThroughputCheckpoints({
   ...checkpointEvidence,
   baseline: {...baseCohort, ...basePatch},
   candidate: {...checkpointEvidence.candidate, ...candPatch}
  }), checkpointDenied('REWORK_OR_INTERVENTION_REGRESSION'));
 }

 for (const spendPatch of [
  {costVerified: false},
  {incrementalSpendMicros: null},
  {incrementalSpendMicros: 1}
 ]) {
  assert.deepEqual(evaluateThroughputCheckpoints({
   ...checkpointEvidence,
   candidate: {...checkpointEvidence.candidate, ...spendPatch}
  }), checkpointDenied('SPEND_UNKNOWN_OR_EXCEEDED'));
  assert.deepEqual(evaluateThroughputCheckpoints({
   ...checkpointEvidence,
   baseline: {...baseCohort, ...spendPatch}
  }), checkpointDenied('SPEND_UNKNOWN_OR_EXCEEDED'));
 }

 assert.deepEqual(evaluateThroughputCheckpoints({
  ...checkpointEvidence,
  candidate: {...baseCohort, accepted: 5, windowMs: 172800000, rework: 0, humanInterventions: 0}
 }), checkpointDenied('THROUGHPUT_REGRESSION'));
});

test('throughput checkpoints reject malformed objects, proxies and accessors without invoking getters', () => {
 const trapEvidence = Object.defineProperties({}, {
  ...Object.getOwnPropertyDescriptors(checkpointEvidence),
  stop: {enumerable: true, get() {throw Error('must not run');}}
 });
 const trapCohort = Object.defineProperties({}, {
  ...Object.getOwnPropertyDescriptors(baseCohort),
  accepted: {enumerable: true, get() {throw Error('must not run');}}
 });
 for (const invalid of [
  null,
  trapEvidence,
  new Proxy(checkpointEvidence, {get() {throw Error('must not run');}}),
  {...checkpointEvidence, repository: 'bad-repo'},
  {...checkpointEvidence, source: 'live'},
  {...checkpointEvidence, policy: null},
  {...checkpointEvidence, policy: {minLinePercent: 101, minBranchPercent: 95}},
  {...checkpointEvidence, policy: {minLinePercent: 98, minBranchPercent: -1}},
  {...checkpointEvidence, baseline: null},
  {...checkpointEvidence, candidate: trapCohort},
  {...checkpointEvidence, candidate: {...baseCohort, cohort: 'BAD CAPS'}},
  {...checkpointEvidence, candidate: {...baseCohort, workload: 'bad'}},
  {...checkpointEvidence, candidate: {...baseCohort, gateSet: 'bad'}},
  {...checkpointEvidence, candidate: {...baseCohort, complete: 'yes'}},
  {...checkpointEvidence, candidate: {...baseCohort, windowMs: 0}},
  {...checkpointEvidence, candidate: {...baseCohort, windowMs: 31536000001}},
  {...checkpointEvidence, candidate: {...baseCohort, accepted: -1}},
  {...checkpointEvidence, candidate: {...baseCohort, censored: -1}},
  {...checkpointEvidence, candidate: {...baseCohort, gatesPassed: 'true'}},
  {...checkpointEvidence, candidate: {...baseCohort, duplicateDispatches: -1}},
  {...checkpointEvidence, candidate: {...baseCohort, unauthorizedWrites: -1}},
  {...checkpointEvidence, candidate: {...baseCohort, coveredLines: -1}},
  {...checkpointEvidence, candidate: {...baseCohort, coveredLines: 0, totalLines: 0}},
  {...checkpointEvidence, candidate: {...baseCohort, totalLines: 100000001}},
  {...checkpointEvidence, candidate: {...baseCohort, coveredLines: 1001, totalLines: 1000}},
  {...checkpointEvidence, candidate: {...baseCohort, coveredBranches: 1001, totalBranches: 1000}},
  {...checkpointEvidence, candidate: {...baseCohort, rework: -1}},
  {...checkpointEvidence, candidate: {...baseCohort, humanInterventions: -1}},
  {...checkpointEvidence, candidate: {...baseCohort, incrementalSpendMicros: -1}}
 ]) {
  assert.deepEqual(evaluateThroughputCheckpoints(invalid), checkpointDenied('EVIDENCE_UNKNOWN'));
 }
});

const nodeTiers = [
 {workers: 100, wallClockMs: 28000, cpuTimeMs: 24000, peakMemoryMb: 320, p95LatencyMs: 900,
  contentionWaitMs: 180, cancellationPropagated: true, cancellationMs: 45},
 {workers: 12, wallClockMs: 6000, cpuTimeMs: 3200, peakMemoryMb: 140, p95LatencyMs: 160,
  contentionWaitMs: 20, cancellationPropagated: true, cancellationMs: 12},
 {workers: 50, wallClockMs: 14000, cpuTimeMs: 11000, peakMemoryMb: 220, p95LatencyMs: 420,
  contentionWaitMs: 75, cancellationPropagated: true, cancellationMs: 25}
];
const nodeProfile = {
 engine: 'node-26.13.1',
 workload: main,
 contractPreserved: true,
 deterministic: true,
 ciCompileMs: 0,
 ciCoverageMs: 2000,
 coveredLines: 990,
 totalLines: 1000,
 coveredBranches: 970,
 totalBranches: 1000,
 securityReviewed: true,
 independentReview: true,
 rollbackReady: true,
 costVerified: true,
 incrementalSpendMicros: 0,
 tiers: nodeTiers
};
const fastCandidateTiers = [
 {workers: 12, wallClockMs: 1000, cpuTimeMs: 900, peakMemoryMb: 60, p95LatencyMs: 50,
  contentionWaitMs: 5, cancellationPropagated: true, cancellationMs: 5},
 {workers: 50, wallClockMs: 3500, cpuTimeMs: 3000, peakMemoryMb: 90, p95LatencyMs: 120,
  contentionWaitMs: 20, cancellationPropagated: true, cancellationMs: 10},
 {workers: 100, wallClockMs: 7500, cpuTimeMs: 6500, peakMemoryMb: 130, p95LatencyMs: 260,
  contentionWaitMs: 40, cancellationPropagated: true, cancellationMs: 15}
];
const rustCandidateProfile = {
 ...nodeProfile,
 engine: 'rust-prototype',
 ciCompileMs: 3000,
 ciCoverageMs: 2000,
 coveredLines: 995,
 coveredBranches: 980,
 tiers: fastCandidateTiers
};
const engineSpec = {
 stop: false,
 hostedRunner: true,
 workload: main,
 minNetGainPercent: 20,
 node: nodeProfile,
 candidate: rustCandidateProfile
};
const engineDenied = reason => ({
 shadow: true,
 liveMerge: false,
 comparable: false,
 baselineReady: false,
 recommendation: 'retain-node',
 reason
});

test('records Node-first baseline across 12, 50 and 100 simulated workers and retains Node', () => {
 const baselineOnly = evaluateEngineExperiment({...engineSpec, candidate: null});
 assert.equal(baselineOnly.shadow, true);
 assert.equal(baselineOnly.liveMerge, false);
 assert.equal(baselineOnly.comparable, false);
 assert.equal(baselineOnly.baselineReady, true);
 assert.equal(baselineOnly.recommendation, 'retain-node');
 assert.equal(baselineOnly.reason, 'NODE_BASELINE_RECORDED');
 assert.equal(baselineOnly.candidate, null);
 assert.equal(baselineOnly.netGainPercent, null);
 assert.deepEqual(baselineOnly.node.tiers.map(t => t.workers), [12, 50, 100]);
 assert.deepEqual(baselineOnly.node.tiers.map(t => t.endToEndMs), [8000, 16000, 30000]);
 assert.equal(baselineOnly.node.totalWallClockMs, 48000);
 assert.equal(baselineOnly.node.ciOverheadMs, 2000);
 assert.equal(baselineOnly.node.netEndToEndMs, 50000);
});

test('recommends retain-node unless material CI-inclusive gain is proven across every worker tier and overall', () => {
 const tier12OverheadRegression = evaluateEngineExperiment({
  ...engineSpec,
  candidate: {...rustCandidateProfile, ciCompileMs: 12000, ciCoverageMs: 3000}
 });
 assert.equal(tier12OverheadRegression.comparable, true);
 assert.equal(tier12OverheadRegression.netGainPercent, 46);
 assert.equal(tier12OverheadRegression.tierComparisons[0].endToEndDeltaMs, 8000);
 assert.equal(tier12OverheadRegression.recommendation, 'retain-node');
 assert.equal(tier12OverheadRegression.reason, 'CI_OVERHEAD_EXCEEDS_RUNTIME_GAIN');

 const tier12MarginalGain = evaluateEngineExperiment({
  ...engineSpec,
  candidate: {...rustCandidateProfile, ciCompileMs: 4000, ciCoverageMs: 2000}
 });
 assert.equal(tier12MarginalGain.comparable, true);
 assert.equal(tier12MarginalGain.netGainPercent, 64);
 assert.equal(tier12MarginalGain.tierComparisons[0].netGainPercent, 12.5);
 assert.equal(tier12MarginalGain.recommendation, 'retain-node');
 assert.equal(tier12MarginalGain.reason, 'INSUFFICIENT_NET_END_TO_END_GAIN');

 const suiteMarginalGain = evaluateEngineExperiment({
  ...engineSpec,
  minNetGainPercent: 30,
  node: {
   ...nodeProfile,
   ciCompileMs: 0,
   ciCoverageMs: 10000,
   tiers: [
    {...nodeTiers[0], wallClockMs: 10000},
    {...nodeTiers[1], wallClockMs: 10000},
    {...nodeTiers[2], wallClockMs: 10000}
   ]
  },
  candidate: {
   ...rustCandidateProfile,
   ciCompileMs: 0,
   ciCoverageMs: 0,
   tiers: [
    {...fastCandidateTiers[0], wallClockMs: 10000},
    {...fastCandidateTiers[1], wallClockMs: 10000},
    {...fastCandidateTiers[2], wallClockMs: 10000}
   ]
  }
 });
 assert.equal(suiteMarginalGain.comparable, true);
 assert.equal(suiteMarginalGain.tierComparisons.every(t => t.netGainPercent === 50), true);
 assert.equal(suiteMarginalGain.netGainPercent, 25);
 assert.equal(suiteMarginalGain.recommendation, 'retain-node');
 assert.equal(suiteMarginalGain.reason, 'INSUFFICIENT_NET_END_TO_END_GAIN');

 const withExtraGetter = tier => Object.defineProperties({}, {
  ...Object.getOwnPropertyDescriptors(tier),
  unvalidated: {value: 'drop-me', enumerable: true},
  evil: {enumerable: true, get() {throw Error('must not run');}}
 });
 const proven = evaluateEngineExperiment({
  ...engineSpec,
  node: {...nodeProfile, tiers: nodeTiers.map(withExtraGetter)},
  candidate: {...rustCandidateProfile, tiers: fastCandidateTiers.map(withExtraGetter)}
 });
 assert.equal(proven.shadow, true);
 assert.equal(proven.liveMerge, false);
 assert.equal(proven.comparable, true);
 assert.equal(proven.baselineReady, true);
 assert.equal(proven.recommendation, 'candidate-eligible');
 assert.equal(proven.reason, 'MATERIAL_NET_GAIN_PROVEN');
 assert.equal(proven.netGainPercent, 66);
 assert.equal(proven.tierComparisons[0].netGainPercent, 25);
 assert.deepEqual(proven.tierComparisons.map(t => t.workers), [12, 50, 100]);
 for (const tier of [...proven.node.tiers, ...proven.candidate.tiers]) {
  assert.equal(Object.hasOwn(tier, 'unvalidated'), false);
  assert.equal(Object.hasOwn(tier, 'evil'), false);
 }
});

test('engine experiments retain Node on safety, coverage, review, rollback or per-tier metric regressions', () => {
 for (const safetyPatch of [{contractPreserved: false}, {deterministic: false}]) {
  const res = evaluateEngineExperiment({
   ...engineSpec,
   candidate: {...rustCandidateProfile, ...safetyPatch}
  });
  assert.equal(res.recommendation, 'retain-node');
  assert.equal(res.reason, 'CANDIDATE_SAFETY_UNVERIFIED');
 }
 const uncanceled = evaluateEngineExperiment({
  ...engineSpec,
  candidate: {
   ...rustCandidateProfile,
   tiers: [
    fastCandidateTiers[0],
    fastCandidateTiers[1],
    {...fastCandidateTiers[2], cancellationPropagated: false}
   ]
  }
 });
 assert.equal(uncanceled.recommendation, 'retain-node');
 assert.equal(uncanceled.reason, 'CANDIDATE_SAFETY_UNVERIFIED');

 for (const covPatch of [
  {coveredLines: 979},
  {coveredBranches: 949},
  {coveredLines: 985},
  {coveredBranches: 960}
 ]) {
  const res = evaluateEngineExperiment({
   ...engineSpec,
   candidate: {...rustCandidateProfile, ...covPatch}
  });
  assert.equal(res.recommendation, 'retain-node');
  assert.equal(res.reason, 'CANDIDATE_COVERAGE_REGRESSION');
 }

 for (const readinessPatch of [
  {securityReviewed: false},
  {independentReview: false},
  {rollbackReady: false}
 ]) {
  const res = evaluateEngineExperiment({
   ...engineSpec,
   candidate: {...rustCandidateProfile, ...readinessPatch}
  });
  assert.equal(res.recommendation, 'retain-node');
  assert.equal(res.reason, 'REVIEW_OR_ROLLBACK_UNREADY');
 }

 for (const tierRegression of [
  {wallClockMs: 7000},
  {cpuTimeMs: 4000},
  {peakMemoryMb: 200},
  {p95LatencyMs: 200},
  {contentionWaitMs: 30},
  {cancellationMs: 20}
 ]) {
  const res = evaluateEngineExperiment({
   ...engineSpec,
   candidate: {
    ...rustCandidateProfile,
    tiers: [
     {...fastCandidateTiers[0], ...tierRegression},
     fastCandidateTiers[1],
     fastCandidateTiers[2]
    ]
   }
  });
  assert.equal(res.recommendation, 'retain-node');
  assert.equal(res.reason, 'TIER_METRIC_REGRESSION');
 }
});

test('engine experiments fail closed on stop, unhosted runs, unmatched workloads, spend and invalid profiles', () => {
 assert.deepEqual(evaluateEngineExperiment({...engineSpec, stop: true}), engineDenied('STOPPED'));
 assert.deepEqual(evaluateEngineExperiment({...engineSpec, hostedRunner: false}),
  engineDenied('HOSTED_EVIDENCE_REQUIRED'));
 assert.deepEqual(evaluateEngineExperiment({
  ...engineSpec,
  node: {...nodeProfile, workload: head}
 }), engineDenied('UNMATCHED_WORKLOAD'));
 assert.deepEqual(evaluateEngineExperiment({
  ...engineSpec,
  candidate: {...rustCandidateProfile, workload: head}
 }), engineDenied('UNMATCHED_WORKLOAD'));

 for (const spendPatch of [{costVerified: false}, {incrementalSpendMicros: null}, {incrementalSpendMicros: 1}]) {
  assert.deepEqual(evaluateEngineExperiment({
   ...engineSpec,
   node: {...nodeProfile, ...spendPatch}
  }), engineDenied('SPEND_UNKNOWN_OR_EXCEEDED'));
  assert.deepEqual(evaluateEngineExperiment({
   ...engineSpec,
   candidate: {...rustCandidateProfile, ...spendPatch}
  }), engineDenied('SPEND_UNKNOWN_OR_EXCEEDED'));
 }

 for (const nodeGatePatch of [
  {contractPreserved: false},
  {deterministic: false},
  {coveredLines: 970},
  {coveredBranches: 940},
  {securityReviewed: false},
  {independentReview: false},
  {rollbackReady: false},
  {tiers: [nodeTiers[0], nodeTiers[1], {...nodeTiers[2], cancellationPropagated: false}]}
 ]) {
  assert.deepEqual(evaluateEngineExperiment({
   ...engineSpec,
   node: {...nodeProfile, ...nodeGatePatch}
  }), engineDenied('NODE_BASELINE_UNVERIFIED'));
 }

 const getterSpec = Object.defineProperties({}, {
  ...Object.getOwnPropertyDescriptors(engineSpec),
  hostedRunner: {enumerable: true, get() {throw Error('must not run');}}
 });
 const proxyTiers = new Proxy(fastCandidateTiers, {get() {throw Error('must not run');}});
 for (const invalid of [
  null,
  getterSpec,
  {...engineSpec, workload: 'bad'},
  {...engineSpec, minNetGainPercent: 14},
  {...engineSpec, minNetGainPercent: 91},
  {...engineSpec, node: null},
  {...engineSpec, node: {...nodeProfile, engine: 'node'}},
  {...engineSpec, node: {...nodeProfile, engine: 'node-18.0.0'}},
  {...engineSpec, node: {...nodeProfile, engine: 'python'}},
  {...engineSpec, candidate: {...rustCandidateProfile, engine: 'node'}},
  {...engineSpec, candidate: {...rustCandidateProfile, engine: 'node-26.13.1'}},
  {...engineSpec, candidate: {...rustCandidateProfile, engine: 'node-28.0.0'}},
  {...engineSpec, candidate: {...rustCandidateProfile, engine: 'node_esm'}},
  {...engineSpec, candidate: {...rustCandidateProfile, engine: 'BAD NAME'}},
  {...engineSpec, candidate: {...rustCandidateProfile, workload: 'bad'}},
  {...engineSpec, candidate: {...rustCandidateProfile, deterministic: 'yes'}},
  {...engineSpec, candidate: {...rustCandidateProfile, ciCompileMs: -1}},
  {...engineSpec, candidate: {...rustCandidateProfile, ciCoverageMs: 3600001}},
  {...engineSpec, candidate: {...rustCandidateProfile, coveredLines: -1}},
  {...engineSpec, candidate: {...rustCandidateProfile, coveredBranches: 1001}},
  {...engineSpec, candidate: {...rustCandidateProfile, incrementalSpendMicros: -1}},
  {...engineSpec, candidate: {...rustCandidateProfile, tiers: proxyTiers}},
  {...engineSpec, candidate: {...rustCandidateProfile, tiers: [fastCandidateTiers[0], fastCandidateTiers[1]]}},
  {...engineSpec, candidate: {...rustCandidateProfile, tiers: [...fastCandidateTiers, fastCandidateTiers[0]]}},
  {...engineSpec, candidate: {...rustCandidateProfile, tiers: [fastCandidateTiers[0], fastCandidateTiers[0], fastCandidateTiers[2]]}},
  {...engineSpec, candidate: {...rustCandidateProfile, tiers: [{...fastCandidateTiers[0], workers: 24}, fastCandidateTiers[1], fastCandidateTiers[2]]}},
  {...engineSpec, candidate: {...rustCandidateProfile, tiers: [null, fastCandidateTiers[1], fastCandidateTiers[2]]}},
  {...engineSpec, candidate: {...rustCandidateProfile, tiers: [{...fastCandidateTiers[0], wallClockMs: 0}, fastCandidateTiers[1], fastCandidateTiers[2]]}},
  {...engineSpec, candidate: {...rustCandidateProfile, tiers: [{...fastCandidateTiers[0], wallClockMs: 86400001}, fastCandidateTiers[1], fastCandidateTiers[2]]}},
  {...engineSpec, candidate: {...rustCandidateProfile, tiers: [{...fastCandidateTiers[0], cpuTimeMs: 0}, fastCandidateTiers[1], fastCandidateTiers[2]]}},
  {...engineSpec, candidate: {...rustCandidateProfile, tiers: [{...fastCandidateTiers[0], cpuTimeMs: 86400001}, fastCandidateTiers[1], fastCandidateTiers[2]]}},
  {...engineSpec, candidate: {...rustCandidateProfile, tiers: [{...fastCandidateTiers[0], peakMemoryMb: 0}, fastCandidateTiers[1], fastCandidateTiers[2]]}},
  {...engineSpec, candidate: {...rustCandidateProfile, tiers: [{...fastCandidateTiers[0], peakMemoryMb: 1048577}, fastCandidateTiers[1], fastCandidateTiers[2]]}},
  {...engineSpec, candidate: {...rustCandidateProfile, tiers: [{...fastCandidateTiers[0], p95LatencyMs: 0}, fastCandidateTiers[1], fastCandidateTiers[2]]}},
  {...engineSpec, candidate: {...rustCandidateProfile, tiers: [{...fastCandidateTiers[0], p95LatencyMs: 86400001}, fastCandidateTiers[1], fastCandidateTiers[2]]}},
  {...engineSpec, candidate: {...rustCandidateProfile, tiers: [{...fastCandidateTiers[0], contentionWaitMs: -1}, fastCandidateTiers[1], fastCandidateTiers[2]]}},
  {...engineSpec, candidate: {...rustCandidateProfile, tiers: [{...fastCandidateTiers[0], cancellationPropagated: 'yes'}, fastCandidateTiers[1], fastCandidateTiers[2]]}},
  {...engineSpec, candidate: {...rustCandidateProfile, tiers: [{...fastCandidateTiers[0], cancellationMs: -1}, fastCandidateTiers[1], fastCandidateTiers[2]]}}
 ]) {
  assert.deepEqual(evaluateEngineExperiment(invalid), engineDenied('EVIDENCE_UNKNOWN'));
 }
});

