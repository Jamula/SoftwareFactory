import {types} from 'node:util';

const sha=s=>typeof s==='string'&&/^[a-f0-9]{40}$/.test(s);
const positive=n=>Number.isSafeInteger(n)&&n>0;
const own=(v,keys)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&keys.every(k=>Object.hasOwn(v,k));
const exactArray = (value, max = 500) => {
 if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
  return false;
 const length = value.length;
 if (length > max) return false;
 const keys = Reflect.ownKeys(value);
 if (keys.length !== length + 1) return false;
 const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
 if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') || lengthDescriptor.value !== length)
  return false;
 for (let i = 0; i < length; i++) {
  const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false;
 }
 return true;
};
const dense=a=>exactArray(a);
const blocked=reason=>({shadow:true,liveMerge:false,reason});
export function nextIntegration(state) {
 if(!own(state,['stop','main','mainHealthy','active','candidates'])||state.stop!==false) return blocked('STOPPED');
 if(!sha(state.main)||state.mainHealthy!==true||state.active!==false) return blocked('MAIN_OR_TRAIN_UNREADY');
 if(!dense(state.candidates)||state.candidates.some(c=>!own(c,['pr','head','observedHead','base','checks','approval','threads','authority'])||!positive(c.pr)||!sha(c.head)||!sha(c.observedHead)||!sha(c.base))||new Set(state.candidates.map(c=>c.pr)).size!==state.candidates.length) return blocked('INVALID_CANDIDATES');
 const c=state.candidates.find(c=>c.head===c.observedHead&&c.base===state.main&&c.checks===true&&c.approval===true&&c.threads===true&&c.authority===true);
 if(!c) return blocked('NO_ELIGIBLE_CANDIDATE');
 return {...blocked('SHADOW_NEXT'),pr:c.pr,expectedHead:c.head,expectedBase:c.base,method:'squash'};
}

const data=(o,keys)=>o!==null&&typeof o==='object'&&!types.isProxy(o)&&!Array.isArray(o)&&keys.every(k=>Object.hasOwn(Object.getOwnPropertyDescriptor(o,k)??{},'value'));
const queueBlocked=reason=>({shadow:true,liveMerge:false,reason});
// An explicit GraphQL enqueue operation, never a direct merge or queue jump.
// Returns inert request data only; no transport or live mutation is possible.
export function queueAdapter(intent,fresh){
 if(!data(intent,['pr','expectedHead','expectedBase'])||!positive(intent.pr)||!sha(intent.expectedHead)||!sha(intent.expectedBase))return queueBlocked('INTENT_UNKNOWN');
 if(!data(fresh,['pr','id','repository','head','base','branch','open','draft','queueRequired','authority','checks','review','threads','security','coverage','mainHealthy','stop','queued']))return queueBlocked('EVIDENCE_UNKNOWN');
 if(fresh.stop!==false||fresh.repository!=='Jamula/SoftwareFactory'||fresh.branch!=='main'||fresh.pr!==intent.pr||fresh.head!==intent.expectedHead||fresh.base!==intent.expectedBase)return queueBlocked('SCOPE_OR_HEAD_CHANGED');
 if(fresh.open!==true||fresh.draft!==false)return queueBlocked('CANDIDATE_NOT_READY');
 if(fresh.queued===true)return queueBlocked('ALREADY_QUEUED');
 if(fresh.queued!==false||[fresh.queueRequired,fresh.authority,fresh.checks,fresh.review,fresh.threads,fresh.security,fresh.coverage,fresh.mainHealthy].some(x=>x!==true)||typeof fresh.id!=='string'||!/^PR_[A-Za-z0-9_-]{1,100}$/.test(fresh.id))return queueBlocked('GATES_UNKNOWN');
 return {...queueBlocked('SHADOW_QUEUE_INTENT'),request:{
  query:'mutation Enqueue($id: ID!, $head: GitObjectID!) { enqueuePullRequest(input: {pullRequestId: $id, expectedHeadOid: $head, jump: false}) { mergeQueueEntry { id } } }',
  variables:{id:fresh.id,head:intent.expectedHead}
 }};
}

const nonnegative = (value, limit) => Number.isSafeInteger(value) && value >= 0 && value <= limit;
const outcomeFields = ['workload', 'gateSet', 'gatesPassed', 'accepted', 'durationMs', 'rework', 'costMicros'];

function validOutcome(outcome) {
 return data(outcome, outcomeFields) && sha(outcome.workload) && sha(outcome.gateSet) &&
  outcome.gatesPassed === true && positive(outcome.accepted) && nonnegative(outcome.accepted, 100000) &&
  positive(outcome.durationMs) && nonnegative(outcome.durationMs, 86400000) &&
  nonnegative(outcome.rework, 100000) && nonnegative(outcome.costMicros, 1000000000);
}

const experiment = reason => ({shadow: true, synthetic: true, comparable: false, reason});

export function compareTrainExperiment(pairs) {
 if (!exactArray(pairs, 100) || pairs.length < 2) return experiment('SAMPLE_UNKNOWN');
 const ids = new Set();
 const baselineMs = [];
 const candidateMs = [];
 let acceptedPerArm = 0;
 for (let i = 0; i < pairs.length; i++) {
  const item = Object.getOwnPropertyDescriptor(pairs, String(i));
  if (!item || !Object.hasOwn(item, 'value')) return experiment('SAMPLE_UNKNOWN');
  const pair = item.value;
  if (!data(pair, ['id', 'baseline', 'candidate']) || !positive(pair.id) || ids.has(pair.id) ||
      !validOutcome(pair.baseline) || !validOutcome(pair.candidate))
   return experiment('SAMPLE_UNKNOWN');
  ids.add(pair.id);
  const {baseline, candidate} = pair;
  if (baseline.workload !== candidate.workload || baseline.gateSet !== candidate.gateSet ||
      baseline.accepted !== candidate.accepted) return experiment('UNMATCHED_WORK');
  if (candidate.rework > baseline.rework || candidate.costMicros > baseline.costMicros)
   return experiment('REWORK_OR_COST_REGRESSION');
  acceptedPerArm += baseline.accepted;
  baselineMs.push(baseline.durationMs);
  candidateMs.push(candidate.durationMs);
 }
 function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
   totalMs: sorted.reduce((sum, elapsed) => sum + elapsed, 0),
   p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
   p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]
  };
 }
 const baseline = summarize(baselineMs);
 const candidate = summarize(candidateMs);
 return {shadow: true, synthetic: true, comparable: true, reason: 'MATCHED_SYNTHETIC_TRIALS',
  pairs: pairs.length, acceptedPerArm, baseline, candidate, throughputRatio: baseline.totalMs / candidate.totalMs};
}

const THROUGHPUT_CHECKPOINTS = Object.freeze([2, 5, 10, 15, 20, 25]);
const ENGINE_WORKER_TIERS = Object.freeze([12, 50, 100]);
const DAY_MS = 86400000;
const NODE_ENGINE_PATTERN = /^node(?:-[0-9]+\.[0-9]+\.[0-9]+)?$/;

const slug = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
const repoSlug = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(value);
const validCoverageCounts = (covered, total) =>
 nonnegative(covered, 100000000) && positive(total) && total <= 100000000 && covered <= total;
const meetsCoverageFloor = (coveredLines, totalLines, coveredBranches, totalBranches, minLine, minBranch) =>
 BigInt(coveredLines) * 100n >= BigInt(minLine) * BigInt(totalLines) &&
 BigInt(coveredBranches) * 100n >= BigInt(minBranch) * BigInt(totalBranches);
const coverageRegressed = (baseline, candidate) =>
 BigInt(candidate.coveredLines) * BigInt(baseline.totalLines) < BigInt(baseline.coveredLines) * BigInt(candidate.totalLines) ||
 BigInt(candidate.coveredBranches) * BigInt(baseline.totalBranches) < BigInt(baseline.coveredBranches) * BigInt(candidate.totalBranches);

const checkpointEvidenceFields = ['stop', 'repository', 'source', 'policy', 'baseline', 'candidate'];
const cohortFields = [
 'cohort', 'workload', 'gateSet', 'complete', 'windowMs', 'accepted', 'censored',
 'gatesPassed', 'independentReview', 'mainHealthy', 'compatibleTrain', 'rollbackReady',
 'duplicateDispatches', 'unauthorizedWrites',
 'coveredLines', 'totalLines', 'coveredBranches', 'totalBranches',
 'rework', 'humanInterventions', 'costVerified', 'incrementalSpendMicros'
];

function validCheckpointCohort(cohort) {
 return data(cohort, cohortFields) && slug(cohort.cohort) && sha(cohort.workload) && sha(cohort.gateSet) &&
  typeof cohort.complete === 'boolean' && positive(cohort.windowMs) && cohort.windowMs <= 31536000000 &&
  nonnegative(cohort.accepted, 100000) && nonnegative(cohort.censored, 100000) &&
  [cohort.gatesPassed, cohort.independentReview, cohort.mainHealthy, cohort.compatibleTrain,
   cohort.rollbackReady, cohort.costVerified].every(flag => typeof flag === 'boolean') &&
  nonnegative(cohort.duplicateDispatches, 100000) && nonnegative(cohort.unauthorizedWrites, 100000) &&
  validCoverageCounts(cohort.coveredLines, cohort.totalLines) &&
  validCoverageCounts(cohort.coveredBranches, cohort.totalBranches) &&
  nonnegative(cohort.rework, 100000) && nonnegative(cohort.humanInterventions, 100000) &&
  (cohort.incrementalSpendMicros === null || nonnegative(cohort.incrementalSpendMicros, 1000000000));
}

const cohortGatesClear = cohort =>
 cohort.gatesPassed && cohort.independentReview && cohort.mainHealthy && cohort.compatibleTrain &&
 cohort.rollbackReady && cohort.duplicateDispatches === 0 && cohort.unauthorizedWrites === 0;

const summarizeCheckpointCohort = cohort => ({
 accepted: cohort.accepted,
 censored: cohort.censored,
 windowMs: cohort.windowMs,
 acceptedPerDay: (cohort.accepted * DAY_MS) / cohort.windowMs,
 rework: cohort.rework,
 humanInterventions: cohort.humanInterventions,
 incrementalSpendMicros: cohort.incrementalSpendMicros,
 coverage: {
  coveredLines: cohort.coveredLines,
  totalLines: cohort.totalLines,
  coveredBranches: cohort.coveredBranches,
  totalBranches: cohort.totalBranches
 }
});

const checkpointBlocked = reason => ({shadow: true, liveMerge: false, comparable: false, reason});

export function evaluateThroughputCheckpoints(evidence) {
 if (!data(evidence, checkpointEvidenceFields)) return checkpointBlocked('EVIDENCE_UNKNOWN');
 if (evidence.stop !== false) return checkpointBlocked('STOPPED');
 if (!repoSlug(evidence.repository) || (evidence.source !== 'synthetic' && evidence.source !== 'verified') ||
     !data(evidence.policy, ['minLinePercent', 'minBranchPercent']))
  return checkpointBlocked('EVIDENCE_UNKNOWN');
 const {minLinePercent, minBranchPercent} = evidence.policy;
 if (!nonnegative(minLinePercent, 100) || !nonnegative(minBranchPercent, 100))
  return checkpointBlocked('EVIDENCE_UNKNOWN');
 const isFactory = evidence.repository === 'Jamula/SoftwareFactory';
 const lineFloor = isFactory ? 98 : 95;
 const branchFloor = isFactory ? 95 : 90;
 if (minLinePercent < lineFloor || minBranchPercent < branchFloor)
  return checkpointBlocked('POLICY_BELOW_MINIMUM');
 const {baseline, candidate} = evidence;
 if (!validCheckpointCohort(baseline) || !validCheckpointCohort(candidate))
  return checkpointBlocked('EVIDENCE_UNKNOWN');
 if (baseline.cohort !== candidate.cohort || baseline.workload !== candidate.workload ||
     baseline.gateSet !== candidate.gateSet || !baseline.complete || !candidate.complete ||
     baseline.accepted < 5 || candidate.accepted < 5)
  return checkpointBlocked('UNMATCHED_OR_INCOMPLETE_COHORT');
 if (!cohortGatesClear(baseline) || !cohortGatesClear(candidate))
  return checkpointBlocked('QUALITY_OR_SAFETY_GATE_FAILED');
 if (!meetsCoverageFloor(baseline.coveredLines, baseline.totalLines, baseline.coveredBranches, baseline.totalBranches, minLinePercent, minBranchPercent) ||
     !meetsCoverageFloor(candidate.coveredLines, candidate.totalLines, candidate.coveredBranches, candidate.totalBranches, minLinePercent, minBranchPercent) ||
     coverageRegressed(baseline, candidate))
  return checkpointBlocked('COVERAGE_REGRESSION');
 const rateIncreased = (candCount, baseCount) =>
  candCount > baseCount ||
  BigInt(candCount) * BigInt(baseline.accepted) > BigInt(baseCount) * BigInt(candidate.accepted);
 if (rateIncreased(candidate.rework, baseline.rework) ||
     rateIncreased(candidate.humanInterventions, baseline.humanInterventions))
  return checkpointBlocked('REWORK_OR_INTERVENTION_REGRESSION');
 if (!baseline.costVerified || baseline.incrementalSpendMicros !== 0 ||
     !candidate.costVerified || candidate.incrementalSpendMicros !== 0)
  return checkpointBlocked('SPEND_UNKNOWN_OR_EXCEEDED');

 const candScaled = BigInt(candidate.accepted) * BigInt(baseline.windowMs);
 const baseScaled = BigInt(baseline.accepted) * BigInt(candidate.windowMs);
 if (candScaled < baseScaled) return checkpointBlocked('THROUGHPUT_REGRESSION');

 const checkpoints = THROUGHPUT_CHECKPOINTS.map(multiplier => ({
  checkpoint: `${multiplier}x`,
  multiplier,
  met: candScaled >= BigInt(multiplier) * baseScaled
 }));
 let highestCheckpoint = null;
 for (const item of checkpoints) {
  if (item.met) highestCheckpoint = item.checkpoint;
 }
 return {
  shadow: true,
  liveMerge: false,
  comparable: true,
  reason: highestCheckpoint ? 'CHECKPOINTS_EVALUATED' : 'BELOW_FIRST_CHECKPOINT',
  repository: evidence.repository,
  source: evidence.source,
  cohort: baseline.cohort,
  throughputRatio: (candidate.accepted * baseline.windowMs) / (baseline.accepted * candidate.windowMs),
  highestCheckpoint,
  keepStretchOpen: !(evidence.source === 'verified' && highestCheckpoint === '25x'),
  checkpoints,
  baseline: summarizeCheckpointCohort(baseline),
  candidate: summarizeCheckpointCohort(candidate)
 };
}

const engineSpecFields = ['stop', 'hostedRunner', 'workload', 'minNetGainPercent', 'node', 'candidate'];
const engineProfileFields = [
 'engine', 'workload', 'contractPreserved', 'deterministic',
 'ciCompileMs', 'ciCoverageMs',
 'coveredLines', 'totalLines', 'coveredBranches', 'totalBranches',
 'securityReviewed', 'independentReview', 'rollbackReady',
 'costVerified', 'incrementalSpendMicros', 'tiers'
];
const engineTierFields = [
 'workers', 'wallClockMs', 'cpuTimeMs', 'peakMemoryMb',
 'p95LatencyMs', 'contentionWaitMs', 'cancellationPropagated', 'cancellationMs'
];

function parseEngineProfile(profile) {
 if (!data(profile, engineProfileFields) || !slug(profile.engine) || !sha(profile.workload) ||
     ![profile.contractPreserved, profile.deterministic, profile.securityReviewed,
      profile.independentReview, profile.rollbackReady, profile.costVerified].every(flag => typeof flag === 'boolean') ||
     !nonnegative(profile.ciCompileMs, 3600000) || !nonnegative(profile.ciCoverageMs, 3600000) ||
     !validCoverageCounts(profile.coveredLines, profile.totalLines) ||
     !validCoverageCounts(profile.coveredBranches, profile.totalBranches) ||
     (profile.incrementalSpendMicros !== null && !nonnegative(profile.incrementalSpendMicros, 1000000000)) ||
     !exactArray(profile.tiers, 3) || profile.tiers.length !== 3)
  return null;

 const tierMap = new Map();
 for (let i = 0; i < 3; i++) {
  const tier = profile.tiers[i];
  if (!data(tier, engineTierFields) || !ENGINE_WORKER_TIERS.includes(tier.workers) || tierMap.has(tier.workers) ||
      !positive(tier.wallClockMs) || tier.wallClockMs > 86400000 ||
      !positive(tier.cpuTimeMs) || tier.cpuTimeMs > 86400000 ||
      !positive(tier.peakMemoryMb) || tier.peakMemoryMb > 1048576 ||
      !positive(tier.p95LatencyMs) || tier.p95LatencyMs > 86400000 ||
      !nonnegative(tier.contentionWaitMs, 86400000) ||
      typeof tier.cancellationPropagated !== 'boolean' ||
      !nonnegative(tier.cancellationMs, 86400000))
   return null;
  tierMap.set(tier.workers, tier);
 }
 const orderedTiers = ENGINE_WORKER_TIERS.map(workers => tierMap.get(workers));
 const totalWallClockMs = orderedTiers.reduce((sum, tier) => sum + tier.wallClockMs, 0);
 const totalCpuTimeMs = orderedTiers.reduce((sum, tier) => sum + tier.cpuTimeMs, 0);
 const peakMemoryMb = Math.max(...orderedTiers.map(tier => tier.peakMemoryMb));
 const maxP95LatencyMs = Math.max(...orderedTiers.map(tier => tier.p95LatencyMs));
 const ciOverheadMs = profile.ciCompileMs + profile.ciCoverageMs;
 return {
  orderedTiers,
  summary: {
   engine: profile.engine,
   totalWallClockMs,
   totalCpuTimeMs,
   peakMemoryMb,
   maxP95LatencyMs,
   ciCompileMs: profile.ciCompileMs,
   ciCoverageMs: profile.ciCoverageMs,
   ciOverheadMs,
   netEndToEndMs: totalWallClockMs + ciOverheadMs,
   tiers: orderedTiers.map(tier => ({...tier}))
  }
 };
}

const engineBlocked = reason => ({
 shadow: true,
 liveMerge: false,
 comparable: false,
 baselineReady: false,
 recommendation: 'retain-node',
 reason
});

export function evaluateEngineExperiment(spec) {
 if (!data(spec, engineSpecFields)) return engineBlocked('EVIDENCE_UNKNOWN');
 if (spec.stop !== false) return engineBlocked('STOPPED');
 if (spec.hostedRunner !== true) return engineBlocked('HOSTED_EVIDENCE_REQUIRED');
 if (!sha(spec.workload) || !nonnegative(spec.minNetGainPercent, 90) || spec.minNetGainPercent < 15)
  return engineBlocked('EVIDENCE_UNKNOWN');

 const nodeParsed = parseEngineProfile(spec.node);
 if (!nodeParsed || !NODE_ENGINE_PATTERN.test(spec.node.engine))
  return engineBlocked('EVIDENCE_UNKNOWN');
 if (spec.node.workload !== spec.workload) return engineBlocked('UNMATCHED_WORKLOAD');
 if (!spec.node.costVerified || spec.node.incrementalSpendMicros !== 0)
  return engineBlocked('SPEND_UNKNOWN_OR_EXCEEDED');
 if (!spec.node.contractPreserved || !spec.node.deterministic ||
     !meetsCoverageFloor(spec.node.coveredLines, spec.node.totalLines, spec.node.coveredBranches, spec.node.totalBranches, 98, 95) ||
     !nodeParsed.orderedTiers.every(tier => tier.cancellationPropagated) ||
     !spec.node.securityReviewed || !spec.node.independentReview || !spec.node.rollbackReady)
  return engineBlocked('NODE_BASELINE_UNVERIFIED');

 if (spec.candidate === null) {
  return {
   shadow: true,
   liveMerge: false,
   comparable: false,
   baselineReady: true,
   recommendation: 'retain-node',
   reason: 'NODE_BASELINE_RECORDED',
   workload: spec.workload,
   node: nodeParsed.summary,
   candidate: null,
   tierComparisons: null,
   netGainPercent: null
  };
 }

 const candParsed = parseEngineProfile(spec.candidate);
 if (!candParsed || NODE_ENGINE_PATTERN.test(spec.candidate.engine))
  return engineBlocked('EVIDENCE_UNKNOWN');
 if (spec.candidate.workload !== spec.workload) return engineBlocked('UNMATCHED_WORKLOAD');
 if (!spec.candidate.costVerified || spec.candidate.incrementalSpendMicros !== 0)
  return engineBlocked('SPEND_UNKNOWN_OR_EXCEEDED');

 const tierComparisons = ENGINE_WORKER_TIERS.map((workers, index) => {
  const nodeTier = nodeParsed.orderedTiers[index];
  const candTier = candParsed.orderedTiers[index];
  return {
   workers,
   wallClockDeltaMs: candTier.wallClockMs - nodeTier.wallClockMs,
   cpuTimeDeltaMs: candTier.cpuTimeMs - nodeTier.cpuTimeMs,
   peakMemoryDeltaMb: candTier.peakMemoryMb - nodeTier.peakMemoryMb,
   p95LatencyDeltaMs: candTier.p95LatencyMs - nodeTier.p95LatencyMs,
   contentionDeltaMs: candTier.contentionWaitMs - nodeTier.contentionWaitMs,
   cancellationDeltaMs: candTier.cancellationMs - nodeTier.cancellationMs,
   cancellationPropagated: candTier.cancellationPropagated
  };
 });
 const nodeNetMs = nodeParsed.summary.netEndToEndMs;
 const candNetMs = candParsed.summary.netEndToEndMs;
 const netGainPercent = ((nodeNetMs - candNetMs) * 100) / nodeNetMs;
 const comparisonResult = (recommendation, reason) => ({
  shadow: true,
  liveMerge: false,
  comparable: true,
  baselineReady: true,
  recommendation,
  reason,
  workload: spec.workload,
  minNetGainPercent: spec.minNetGainPercent,
  netGainPercent,
  node: nodeParsed.summary,
  candidate: candParsed.summary,
  tierComparisons
 });

 if (!spec.candidate.contractPreserved || !spec.candidate.deterministic ||
     !candParsed.orderedTiers.every(tier => tier.cancellationPropagated))
  return comparisonResult('retain-node', 'CANDIDATE_SAFETY_UNVERIFIED');
 if (!meetsCoverageFloor(spec.candidate.coveredLines, spec.candidate.totalLines, spec.candidate.coveredBranches, spec.candidate.totalBranches, 98, 95) ||
     coverageRegressed(spec.node, spec.candidate))
  return comparisonResult('retain-node', 'CANDIDATE_COVERAGE_REGRESSION');
 if (!spec.candidate.securityReviewed || !spec.candidate.independentReview || !spec.candidate.rollbackReady)
  return comparisonResult('retain-node', 'REVIEW_OR_ROLLBACK_UNREADY');
 if (tierComparisons.some(tier =>
      tier.wallClockDeltaMs > 0 || tier.cpuTimeDeltaMs > 0 || tier.peakMemoryDeltaMb > 0 ||
      tier.p95LatencyDeltaMs > 0 || tier.contentionDeltaMs > 0 || tier.cancellationDeltaMs > 0))
  return comparisonResult('retain-node', 'TIER_METRIC_REGRESSION');
 if (candNetMs >= nodeNetMs)
  return comparisonResult('retain-node', 'CI_OVERHEAD_EXCEEDS_RUNTIME_GAIN');
 if (BigInt(nodeNetMs - candNetMs) * 100n < BigInt(spec.minNetGainPercent) * BigInt(nodeNetMs))
  return comparisonResult('retain-node', 'INSUFFICIENT_NET_END_TO_END_GAIN');
 return comparisonResult('candidate-eligible', 'MATERIAL_NET_GAIN_PROVEN');
}

