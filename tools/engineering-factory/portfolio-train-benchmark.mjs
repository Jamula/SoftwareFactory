// Deterministic, metadata-only multi-repository portfolio worker allocator,
// per-repository isolated integration-train simulator, and single-runtime
// .NET 10 Microsoft Agent Framework (1.28.0 GA) vs. Node 26.13.1 consolidation
// benchmark evaluator for M02.04 (#16). No live dispatch, merge, credentials or I/O.
import {types} from 'node:util';
import {SOFTWARE_FACTORY_REPOSITORY_ID, isSafeRepoRelativePath} from './anti-rogue-audit.mjs';
import {budgetDecision} from './budget.mjs';

export {SOFTWARE_FACTORY_REPOSITORY_ID};
export const SOFTWARE_FACTORY_REPOSITORY = 'Jamula/SoftwareFactory';
export const SPELLBOOK_MAX_CONCURRENCY = 2;
export const MAX_HOSTED_WORKER_CAP = 12;
export const TWO_MINUTE_DRAIN_STRETCH_MS = 120000;
export const LOGICAL_LANE_TIERS = Object.freeze([12, 50, 100]);
export const THROUGHPUT_COHORT_MULTIPLIERS = Object.freeze([2, 5, 10, 15, 20, 25]);
export const PINNED_NODE_RUNTIME = 'node-26.13.1';
export const PINNED_DOTNET_MAF_RUNTIME = 'dotnet-10-maf-1.28.0';
export const LOGICAL_LANE_CLASSIFICATION = 'logical-lanes-not-concurrent-agent-authorization';

const DAY_MS = 86400000;
const YEAR_MS = 31536000000;

const PORTFOLIO_INPUT_KEYS = ['stop', 'budget', 'repositories', 'workItems'];
const BUDGET_REQUIRED_KEYS = [
  'stop', 'includedOnly', 'overageDisabled', 'authorityVerified',
  'nowMs', 'observedMs', 'remaining', 'reserved', 'active', 'maxActive', 'unitsPerRun'
];
const BUDGET_OPTIONAL_KEYS = ['environmentVerified', 'hardStopReceipt'];
const HARD_STOP_KEYS = [
  'receiptId', 'provider', 'includedOnly', 'overageDisabled',
  'hardStopEnforced', 'paidUsageMicros', 'observedMs'
];
const REPO_KEYS = [
  'repositoryId', 'repository', 'enrolled', 'ownerAuthorized', 'killSwitch',
  'localConcurrencyCap', 'maxConcurrency', 'minLinePercent', 'minBranchPercent',
  'credential', 'inFlightLeases', 'train'
];
const CREDENTIAL_KEYS = [
  'credentialId', 'scope', 'allowedRepositories', 'sharedAdminToken', 'persistedInCheckout'
];
const LEASE_KEYS = ['leaseId', 'issue', 'laneId', 'head', 'ownedPaths'];
const WORK_ITEM_KEYS = ['repositoryId', 'issue', 'laneId', 'head', 'criticalPathRank', 'ownedPaths'];
const TRAIN_KEYS = ['defaultBranch', 'mainSha', 'mainHealthy', 'mergeQueue', 'candidates'];
const MERGE_QUEUE_KEYS = ['mode', 'supported', 'ownerApproved', 'costVerified', 'incrementalSpendMicros'];
const TRAIN_CANDIDATE_KEYS = [
  'pr', 'head', 'observedHead', 'expectedBase', 'compatibleBase',
  'checksPassed', 'reviewState', 'independentReview', 'unresolvedFindings',
  'securityClear', 'threadsResolved', 'authorityVerified',
  'coveredLines', 'totalLines', 'coveredBranches', 'totalBranches',
  'ownedPaths', 'simulatedSquashSha', 'postMergeMainHealthy',
  'eligibleToMergeMs', 'postMergeVerifyMs', 'blockedMs'
];

const BENCHMARK_INPUT_KEYS = [
  'stop', 'hostedRunner', 'linuxAndWindowsVerified', 'workload',
  'minNetGainPercent', 'nodeBaseline', 'dotnetMafCandidate', 'cohorts'
];
const COMMON_ENGINE_KEYS = [
  'runtime', 'workload', 'contractPreserved', 'deterministic',
  'ciRestoreMs', 'ciCompileMs', 'ciCoverageMs',
  'coveredLines', 'totalLines', 'coveredBranches', 'totalBranches',
  'securityReviewed', 'independentReview', 'rollbackReady',
  'costVerified', 'incrementalSpendMicros', 'logicalLaneTiers'
];
const DOTNET_EXTRA_KEYS = [
  'dotnetSdkVersion', 'mafWorkflowsVersion', 'pregelSuperstepsVerified',
  'checkpointResumeVerified', 'priorSuperstepsRepeatedOnResume',
  'aspireOtelActivitySourceVerified', 'forbiddenLegacyDependencies', 'shadowOnlyClientEnforced'
];
const DOTNET_ENGINE_KEYS = [...COMMON_ENGINE_KEYS, ...DOTNET_EXTRA_KEYS];
const LANE_TIER_KEYS = [
  'logicalLanes', 'configuredWorkerCap', 'observedPeakConcurrency',
  'concurrentAgentAuthorization', 'wallClockMs', 'cpuTimeMs', 'peakMemoryMb',
  'p95LatencyMs', 'contentionWaitMs', 'cancellationPropagated', 'cancellationMs',
  'duplicatePathLeases', 'crossRepoLeaks'
];
const COHORT_ENVELOPE_KEYS = ['source', 'repository', 'policy', 'baseline', 'candidate'];
const COHORT_POLICY_KEYS = ['minLinePercent', 'minBranchPercent'];
const COHORT_SAMPLE_KEYS = [
  'cohort', 'workload', 'gateSet', 'complete', 'windowMs', 'accepted', 'censored',
  'gatesPassed', 'independentReview', 'mainHealthy', 'compatibleTrain', 'rollbackReady',
  'duplicateDispatches', 'unauthorizedWrites',
  'coveredLines', 'totalLines', 'coveredBranches', 'totalBranches',
  'rework', 'humanInterventions', 'costVerified', 'incrementalSpendMicros'
];
const REVIEW_STATES = new Set(['APPROVED', 'COMMENTED_CLEAR', 'CHANGES_REQUESTED', 'NONE']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !types.isProxy(value) &&
    !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasOwnEnumerableData(target, key) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor !== undefined && descriptor.enumerable === true && Object.hasOwn(descriptor, 'value');
}

function exactRecord(value, requiredKeys, optionalKeys = []) {
  if (!isPlainObject(value)) return false;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Reflect.ownKeys(value);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (typeof key !== 'string' || !allowed.has(key) || !hasOwnEnumerableData(value, key)) {
      return false;
    }
  }
  return requiredKeys.every(key => Object.hasOwn(value, key));
}

function denseDataArray(value, maxLen) {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return false;
  }
  if (value.length > maxLen || Reflect.ownKeys(value).length !== value.length + 1) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    if (!hasOwnEnumerableData(value, String(i))) return false;
  }
  return true;
}

const nonnegInt = (n, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(n) && n >= 0 && n <= max;
const positiveInt = (n, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(n) && n > 0 && n <= max;
const hex40 = s => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
const token = s => typeof s === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(s);
const laneSlug = s => typeof s === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(s);
const cohortSlug = s => typeof s === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(s);
const branchName = s => isSafeRepoRelativePath(s) && s.length <= 80;
const isRepoSlug = s => typeof s === 'string' && s.length <= 200 &&
  /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(s) && !s.includes('..');
const isSpellbookSlug = s => /(^|\/)spellbook$/i.test(s);

function validUniquePathList(paths, maxLen = 32) {
  return denseDataArray(paths, maxLen) && paths.length > 0 &&
    paths.every(isSafeRepoRelativePath) && new Set(paths).size === paths.length;
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function hasAnyPathOverlap(candidatePaths, existingPaths) {
  return candidatePaths.some(cp => existingPaths.some(ep => pathsOverlap(cp, ep)));
}

function hasInternalPathOverlap(paths) {
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      if (pathsOverlap(paths[i], paths[j])) return true;
    }
  }
  return false;
}

function validCoverageCounts(covered, total) {
  return nonnegInt(covered, 100000000) && positiveInt(total, 100000000) && covered <= total;
}

function meetsCoverageFloor(coveredLines, totalLines, coveredBranches, totalBranches, minLine, minBranch) {
  return BigInt(coveredLines) * 100n >= BigInt(minLine) * BigInt(totalLines) &&
    BigInt(coveredBranches) * 100n >= BigInt(minBranch) * BigInt(totalBranches);
}

function coverageRegressed(baseline, candidate) {
  return BigInt(candidate.coveredLines) * BigInt(baseline.totalLines) <
      BigInt(baseline.coveredLines) * BigInt(candidate.totalLines) ||
    BigInt(candidate.coveredBranches) * BigInt(baseline.totalBranches) <
      BigInt(baseline.coveredBranches) * BigInt(candidate.totalBranches);
}

function percentile(sortedSamples, p) {
  if (sortedSamples.length === 0) return null;
  return sortedSamples[Math.ceil(sortedSamples.length * p) - 1];
}

function portfolioDenied(reason) {
  return Object.freeze({
    valid: false,
    shadow: true,
    liveDispatch: false,
    liveMerge: false,
    reason,
    logicalLaneClassification: LOGICAL_LANE_CLASSIFICATION,
    logicalLanesAreConcurrentAgentAuthorization: false,
    authorizedConcurrentWorkers: 0,
    cancelledInFlightLeases: 0,
    preservedInFlightLeases: Object.freeze([]),
    allocatedWorkItems: Object.freeze([]),
    deferredWorkItems: Object.freeze([]),
    repositoryResults: Object.freeze([])
  });
}

function validateTrainCandidate(candidate, mainSha, seenPrs, seenSquashShas) {
  if (!exactRecord(candidate, TRAIN_CANDIDATE_KEYS) ||
      !positiveInt(candidate.pr, 1000000) || seenPrs.has(candidate.pr) ||
      !hex40(candidate.head) || !hex40(candidate.observedHead) ||
      !hex40(candidate.expectedBase) || !hex40(candidate.simulatedSquashSha) ||
      candidate.simulatedSquashSha === candidate.head ||
      candidate.simulatedSquashSha === mainSha ||
      seenSquashShas.has(candidate.simulatedSquashSha) ||
      ![candidate.compatibleBase, candidate.checksPassed, candidate.independentReview,
        candidate.securityClear, candidate.threadsResolved, candidate.authorityVerified,
        candidate.postMergeMainHealthy].every(flag => typeof flag === 'boolean') ||
      !REVIEW_STATES.has(candidate.reviewState) ||
      !nonnegInt(candidate.unresolvedFindings, 10000) ||
      !validCoverageCounts(candidate.coveredLines, candidate.totalLines) ||
      !validCoverageCounts(candidate.coveredBranches, candidate.totalBranches) ||
      !validUniquePathList(candidate.ownedPaths) || hasInternalPathOverlap(candidate.ownedPaths) ||
      !positiveInt(candidate.eligibleToMergeMs, DAY_MS) ||
      !positiveInt(candidate.postMergeVerifyMs, DAY_MS) ||
      !nonnegInt(candidate.blockedMs, DAY_MS)) {
    return false;
  }
  seenPrs.add(candidate.pr);
  seenSquashShas.add(candidate.simulatedSquashSha);
  return true;
}

function simulateRepositoryTrain(repo, isFactory) {
  const {train} = repo;
  const candidates = train.candidates;
  const totalBlockedMs = candidates.reduce((sum, c) => sum + c.blockedMs, 0);

  if (repo.killSwitch) {
    const isolated = candidates.map(c => Object.freeze({pr: c.pr, reason: 'STOPPED_BY_KILL_SWITCH'}));
    return Object.freeze({
      serialized: true,
      mergeQueueMode: train.mergeQueue.mode,
      rebasesPerformed: 0,
      trainStatus: 'STOPPED_BY_KILL_SWITCH',
      initialMainSha: train.mainSha,
      finalMainSha: train.mainSha,
      mainHealthyBefore: train.mainHealthy,
      mainHealthyAfter: train.mainHealthy,
      tripRepoKillSwitch: true,
      queueSize: candidates.length,
      mergedPrs: Object.freeze([]),
      isolatedCandidates: Object.freeze(isolated),
      blockedAfterMainFailurePrs: Object.freeze([]),
      lastMergeReceiptMs: 0,
      verifiedMainMs: 0,
      p50MergeMs: null,
      p95MergeMs: null,
      totalBlockedMs,
      stretchTargetMs: TWO_MINUTE_DRAIN_STRETCH_MS,
      stretchTargetOnly: true,
      withinTwoMinuteStretchTarget: false
    });
  }

  if (!train.mainHealthy) {
    return Object.freeze({
      serialized: true,
      mergeQueueMode: train.mergeQueue.mode,
      rebasesPerformed: 0,
      trainStatus: 'BLOCKED_MAIN_UNHEALTHY',
      initialMainSha: train.mainSha,
      finalMainSha: train.mainSha,
      mainHealthyBefore: false,
      mainHealthyAfter: false,
      tripRepoKillSwitch: true,
      queueSize: candidates.length,
      mergedPrs: Object.freeze([]),
      isolatedCandidates: Object.freeze([]),
      blockedAfterMainFailurePrs: Object.freeze(candidates.map(c => c.pr)),
      lastMergeReceiptMs: 0,
      verifiedMainMs: 0,
      p50MergeMs: null,
      p95MergeMs: null,
      totalBlockedMs,
      stretchTargetMs: TWO_MINUTE_DRAIN_STRETCH_MS,
      stretchTargetOnly: true,
      withinTwoMinuteStretchTarget: false
    });
  }

  const mergedPrs = [];
  const isolatedCandidates = [];
  const blockedAfterMainFailurePrs = [];
  const claimedPaths = [];
  const mergeDurations = [];
  let currentMainSha = train.mainSha;
  let mainHealthyAfter = true;
  let elapsedMs = 0;
  let lastMergeReceiptMs = 0;
  let verifiedMainMs = 0;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!mainHealthyAfter) {
      blockedAfterMainFailurePrs.push(c.pr);
      continue;
    }
    if (c.head !== c.observedHead ||
        (c.expectedBase !== currentMainSha && c.expectedBase !== train.mainSha) ||
        !c.compatibleBase) {
      isolatedCandidates.push(Object.freeze({pr: c.pr, reason: 'HEAD_OR_BASE_MISMATCH'}));
      continue;
    }
    if (!c.checksPassed || !c.securityClear || !c.threadsResolved || !c.authorityVerified) {
      isolatedCandidates.push(Object.freeze({pr: c.pr, reason: 'CHECKS_OR_SECURITY_INCOMPLETE'}));
      continue;
    }
    const reviewApproved = c.reviewState === 'APPROVED' ||
      (isFactory && c.reviewState === 'COMMENTED_CLEAR');
    if (!c.independentReview || c.unresolvedFindings !== 0 || !reviewApproved) {
      isolatedCandidates.push(Object.freeze({pr: c.pr, reason: 'INDEPENDENT_REVIEW_INCOMPLETE'}));
      continue;
    }
    if (!meetsCoverageFloor(
      c.coveredLines, c.totalLines, c.coveredBranches, c.totalBranches,
      repo.minLinePercent, repo.minBranchPercent
    )) {
      isolatedCandidates.push(Object.freeze({pr: c.pr, reason: 'COVERAGE_BELOW_POLICY'}));
      continue;
    }
    if (hasAnyPathOverlap(c.ownedPaths, claimedPaths)) {
      isolatedCandidates.push(Object.freeze({pr: c.pr, reason: 'PATH_CONFLICT_REBASE_REQUIRED'}));
      continue;
    }

    claimedPaths.push(...c.ownedPaths);
    currentMainSha = c.simulatedSquashSha;
    elapsedMs += c.eligibleToMergeMs;
    lastMergeReceiptMs = elapsedMs;
    elapsedMs += c.postMergeVerifyMs;
    verifiedMainMs = elapsedMs;
    mergeDurations.push(c.eligibleToMergeMs);
    mergedPrs.push(c.pr);

    if (!c.postMergeMainHealthy) {
      mainHealthyAfter = false;
    }
  }

  const sortedMergeMs = [...mergeDurations].sort((a, b) => a - b);
  const trainStatus = !mainHealthyAfter
    ? 'HALTED_ON_POST_MERGE_MAIN_FAILURE'
    : (mergedPrs.length > 0 ? 'TRAIN_DRAINED' : 'IDLE_NO_ELIGIBLE');

  return Object.freeze({
    serialized: true,
    mergeQueueMode: train.mergeQueue.mode,
    rebasesPerformed: 0,
    trainStatus,
    initialMainSha: train.mainSha,
    finalMainSha: currentMainSha,
    mainHealthyBefore: true,
    mainHealthyAfter,
    tripRepoKillSwitch: !mainHealthyAfter,
    queueSize: candidates.length,
    mergedPrs: Object.freeze(mergedPrs),
    isolatedCandidates: Object.freeze(isolatedCandidates),
    blockedAfterMainFailurePrs: Object.freeze(blockedAfterMainFailurePrs),
    lastMergeReceiptMs,
    verifiedMainMs,
    p50MergeMs: percentile(sortedMergeMs, 0.5),
    p95MergeMs: percentile(sortedMergeMs, 0.95),
    totalBlockedMs,
    stretchTargetMs: TWO_MINUTE_DRAIN_STRETCH_MS,
    stretchTargetOnly: true,
    withinTwoMinuteStretchTarget: mergedPrs.length > 0 && mainHealthyAfter &&
      verifiedMainMs <= TWO_MINUTE_DRAIN_STRETCH_MS
  });
}

function advanceViableItem(state, deferredOut) {
  while (state.cursor < state.items.length) {
    const item = state.items[state.cursor];
    if (hasAnyPathOverlap(item.ownedPaths, state.activePaths)) {
      deferredOut.push(Object.freeze({
        repositoryId: item.repositoryId,
        repository: state.repo.repository,
        issue: item.issue,
        laneId: item.laneId,
        head: item.head,
        reason: 'PATH_OVERLAP_DEFERRED'
      }));
      state.cursor += 1;
      continue;
    }
    if (state.activeCount >= state.repo.maxConcurrency) {
      deferredOut.push(Object.freeze({
        repositoryId: item.repositoryId,
        repository: state.repo.repository,
        issue: item.issue,
        laneId: item.laneId,
        head: item.head,
        reason: 'REPO_CONCURRENCY_CAP_REACHED'
      }));
      state.cursor += 1;
      continue;
    }
    return item;
  }
  return null;
}

function drainRemainingStateItems(state, deferredOut) {
  while (advanceViableItem(state, deferredOut) !== null) {
    const item = state.items[state.cursor];
    deferredOut.push(Object.freeze({
      repositoryId: item.repositoryId,
      repository: state.repo.repository,
      issue: item.issue,
      laneId: item.laneId,
      head: item.head,
      reason: 'PORTFOLIO_CAPACITY_EXHAUSTED'
    }));
    state.cursor += 1;
  }
}

export function allocatePortfolioCapacityAndSimulateTrains(input) {
  if (!exactRecord(input, PORTFOLIO_INPUT_KEYS)) return portfolioDenied('INPUT_UNKNOWN');
  if (input.stop !== false) return portfolioDenied('STOPPED');
  if (!exactRecord(input.budget, BUDGET_REQUIRED_KEYS, BUDGET_OPTIONAL_KEYS)) {
    return portfolioDenied('BUDGET_UNKNOWN');
  }
  if (Object.hasOwn(input.budget, 'hardStopReceipt') &&
      !exactRecord(input.budget.hardStopReceipt, HARD_STOP_KEYS)) {
    return portfolioDenied('HARD_STOP_UNVERIFIED');
  }
  const budget = budgetDecision(input.budget);
  if (budget.reason !== 'SHADOW_CAPACITY' && budget.reason !== 'CAPACITY_EXHAUSTED') {
    return portfolioDenied(budget.reason);
  }
  if (!denseDataArray(input.repositories, 32) || input.repositories.length === 0 ||
      !denseDataArray(input.workItems, 250)) {
    return portfolioDenied('INPUT_UNKNOWN');
  }

  const repoById = new Map();
  const seenSlugs = new Set();
  const seenCredentials = new Set();
  const seenLeaseIds = new Set();
  const preservedInFlightLeases = [];
  let unaccountedActive = input.budget.active;

  for (let i = 0; i < input.repositories.length; i++) {
    const repo = input.repositories[i];
    if (!exactRecord(repo, REPO_KEYS) ||
        !positiveInt(repo.repositoryId) || !isRepoSlug(repo.repository) ||
        typeof repo.enrolled !== 'boolean' || typeof repo.ownerAuthorized !== 'boolean' ||
        typeof repo.killSwitch !== 'boolean' ||
        !positiveInt(repo.localConcurrencyCap, MAX_HOSTED_WORKER_CAP) ||
        !positiveInt(repo.maxConcurrency, MAX_HOSTED_WORKER_CAP) ||
        !nonnegInt(repo.minLinePercent, 100) || !nonnegInt(repo.minBranchPercent, 100) ||
        !denseDataArray(repo.inFlightLeases, MAX_HOSTED_WORKER_CAP)) {
      return portfolioDenied('REPOSITORY_SCHEMA_INVALID');
    }

    const lowerSlug = repo.repository.toLowerCase();
    if (repoById.has(repo.repositoryId) || seenSlugs.has(lowerSlug)) {
      return portfolioDenied('DUPLICATE_REPOSITORY');
    }
    const isFactoryId = repo.repositoryId === SOFTWARE_FACTORY_REPOSITORY_ID;
    const isFactorySlug = lowerSlug === SOFTWARE_FACTORY_REPOSITORY.toLowerCase();
    if (isFactoryId !== isFactorySlug || (isFactoryId && repo.repository !== SOFTWARE_FACTORY_REPOSITORY)) {
      return portfolioDenied('REPOSITORY_IDENTITY_MISMATCH');
    }
    if (!repo.enrolled) return portfolioDenied('UNENROLLED_REPOSITORY');
    if (!repo.ownerAuthorized) return portfolioDenied('ENROLLMENT_NOT_AUTHORIZED');

    const cred = repo.credential;
    if (!exactRecord(cred, CREDENTIAL_KEYS) || !token(cred.credentialId) ||
        typeof cred.scope !== 'string' || typeof cred.sharedAdminToken !== 'boolean' ||
        typeof cred.persistedInCheckout !== 'boolean' ||
        !denseDataArray(cred.allowedRepositories, 8) ||
        !cred.allowedRepositories.every(isRepoSlug)) {
      return portfolioDenied('CREDENTIAL_ISOLATION_VIOLATION');
    }
    if (cred.sharedAdminToken !== false) return portfolioDenied('SHARED_ADMIN_TOKEN_FORBIDDEN');
    const lowerCredId = cred.credentialId.toLowerCase();
    if (cred.scope !== 'repo-read-only-shadow' || cred.persistedInCheckout !== false ||
        cred.allowedRepositories.length !== 1 ||
        cred.allowedRepositories[0].toLowerCase() !== lowerSlug ||
        seenCredentials.has(lowerCredId)) {
      return portfolioDenied('CREDENTIAL_ISOLATION_VIOLATION');
    }

    const isSpellbook = isSpellbookSlug(repo.repository);
    if (repo.maxConcurrency > repo.localConcurrencyCap ||
        (isSpellbook && repo.localConcurrencyCap > SPELLBOOK_MAX_CONCURRENCY)) {
      return portfolioDenied('REPO_CONCURRENCY_CAP_EXCEEDED');
    }
    const minLineFloor = isFactoryId ? 98 : (isSpellbook ? 97 : 95);
    const minBranchFloor = isFactoryId ? 95 : 90;
    if (repo.minLinePercent < minLineFloor || repo.minBranchPercent < minBranchFloor) {
      return portfolioDenied('REPO_POLICY_BELOW_MINIMUM');
    }
    if (repo.inFlightLeases.length > repo.maxConcurrency) {
      return portfolioDenied('REPO_CONCURRENCY_CAP_EXCEEDED');
    }
    if (repo.inFlightLeases.length > unaccountedActive) {
      return portfolioDenied('ACTIVE_LEASE_ACCOUNTING_MISMATCH');
    }
    unaccountedActive -= repo.inFlightLeases.length;

    const repoIssues = new Set();
    const repoLanes = new Set();
    const activePaths = [];
    for (let j = 0; j < repo.inFlightLeases.length; j++) {
      const lease = repo.inFlightLeases[j];
      if (!exactRecord(lease, LEASE_KEYS) || !token(lease.leaseId) ||
          !positiveInt(lease.issue, 1000000) || !laneSlug(lease.laneId) ||
          !hex40(lease.head) || !validUniquePathList(lease.ownedPaths) ||
          hasInternalPathOverlap(lease.ownedPaths)) {
        return portfolioDenied('INVALID_IN_FLIGHT_LEASE');
      }
      const lowerLeaseId = lease.leaseId.toLowerCase();
      if (seenLeaseIds.has(lowerLeaseId) || repoIssues.has(lease.issue) ||
          repoLanes.has(lease.laneId) || hasAnyPathOverlap(lease.ownedPaths, activePaths)) {
        return portfolioDenied('INVALID_IN_FLIGHT_LEASE');
      }
      seenLeaseIds.add(lowerLeaseId);
      repoIssues.add(lease.issue);
      repoLanes.add(lease.laneId);
      activePaths.push(...lease.ownedPaths);
      preservedInFlightLeases.push(Object.freeze({
        repositoryId: repo.repositoryId,
        repository: repo.repository,
        leaseId: lease.leaseId,
        issue: lease.issue,
        laneId: lease.laneId,
        head: lease.head,
        ownedPaths: Object.freeze([...lease.ownedPaths])
      }));
    }

    const {train} = repo;
    if (!exactRecord(train, TRAIN_KEYS) || !branchName(train.defaultBranch) ||
        !hex40(train.mainSha) || typeof train.mainHealthy !== 'boolean' ||
        !exactRecord(train.mergeQueue, MERGE_QUEUE_KEYS) ||
        !denseDataArray(train.candidates, 100)) {
      return portfolioDenied('INVALID_TRAIN_STATE');
    }
    const mq = train.mergeQueue;
    if ((mq.mode !== 'native-merge-queue' && mq.mode !== 'serialized-protected-squash') ||
        ![mq.supported, mq.ownerApproved, mq.costVerified].every(b => typeof b === 'boolean') ||
        (mq.incrementalSpendMicros !== null && !nonnegInt(mq.incrementalSpendMicros, 1000000000))) {
      return portfolioDenied('INVALID_TRAIN_STATE');
    }
    if (!mq.costVerified || mq.incrementalSpendMicros !== 0) {
      return portfolioDenied('SPEND_UNKNOWN_OR_EXCEEDED');
    }
    if (!mq.supported || !mq.ownerApproved) {
      return portfolioDenied('UNVERIFIED_MERGE_QUEUE');
    }

    const seenPrs = new Set();
    const seenSquashShas = new Set();
    for (let k = 0; k < train.candidates.length; k++) {
      if (!validateTrainCandidate(train.candidates[k], train.mainSha, seenPrs, seenSquashShas)) {
        return portfolioDenied('INVALID_TRAIN_CANDIDATE');
      }
    }

    seenSlugs.add(lowerSlug);
    seenCredentials.add(lowerCredId);
    repoById.set(repo.repositoryId, {
      repo,
      isFactory: isFactoryId,
      repoIssues,
      repoLanes,
      activePaths,
      activeCount: repo.inFlightLeases.length,
      allocatedThisCycle: 0,
      items: [],
      cursor: 0,
      trainReport: simulateRepositoryTrain(repo, isFactoryId)
    });
  }

  for (let i = 0; i < input.workItems.length; i++) {
    const item = input.workItems[i];
    if (!exactRecord(item, WORK_ITEM_KEYS) ||
        !positiveInt(item.repositoryId) || !positiveInt(item.issue, 1000000) ||
        !laneSlug(item.laneId) || !hex40(item.head) ||
        !positiveInt(item.criticalPathRank, 10000) ||
        !validUniquePathList(item.ownedPaths) || hasInternalPathOverlap(item.ownedPaths)) {
      return portfolioDenied('WORK_ITEM_UNKNOWN');
    }
    const state = repoById.get(item.repositoryId);
    if (!state) return portfolioDenied('UNENROLLED_REPOSITORY');
    if (state.repoIssues.has(item.issue) || state.repoLanes.has(item.laneId)) {
      return portfolioDenied('DUPLICATE_WORK_ITEM');
    }
    state.repoIssues.add(item.issue);
    state.repoLanes.add(item.laneId);
    state.items.push(item);
  }

  const allocatedWorkItems = [];
  const deferredWorkItems = [];
  let remainingSlots = budget.available;
  const consumerStates = [];

  for (const state of repoById.values()) {
    state.items.sort((a, b) => (a.criticalPathRank - b.criticalPathRank) || (a.issue - b.issue));
    if (state.repo.killSwitch) {
      for (const item of state.items) {
        deferredWorkItems.push(Object.freeze({
          repositoryId: item.repositoryId,
          repository: state.repo.repository,
          issue: item.issue,
          laneId: item.laneId,
          head: item.head,
          reason: 'REPO_KILL_SWITCH_ACTIVE'
        }));
      }
      continue;
    }
    if (!state.trainReport.mainHealthyAfter) {
      for (const item of state.items) {
        deferredWorkItems.push(Object.freeze({
          repositoryId: item.repositoryId,
          repository: state.repo.repository,
          issue: item.issue,
          laneId: item.laneId,
          head: item.head,
          reason: 'REPO_MAIN_UNHEALTHY'
        }));
      }
      continue;
    }
    if (!state.isFactory) {
      consumerStates.push(state);
    }
  }

  // Tier 1: SoftwareFactory (1471342715) receives strict first-claim priority on available
  // capacity without cancelling or preempting active in-flight consumer leases.
  const factoryState = repoById.get(SOFTWARE_FACTORY_REPOSITORY_ID);
  if (factoryState && !factoryState.repo.killSwitch && factoryState.trainReport.mainHealthyAfter) {
    while (remainingSlots > 0) {
      const nextItem = advanceViableItem(factoryState, deferredWorkItems);
      if (nextItem === null) break;
      factoryState.cursor += 1;
      factoryState.activeCount += 1;
      factoryState.allocatedThisCycle += 1;
      factoryState.activePaths.push(...nextItem.ownedPaths);
      remainingSlots -= 1;
      allocatedWorkItems.push(Object.freeze({
        repositoryId: nextItem.repositoryId,
        repository: factoryState.repo.repository,
        issue: nextItem.issue,
        laneId: nextItem.laneId,
        head: nextItem.head,
        criticalPathRank: nextItem.criticalPathRank,
        priorityTier: 'softwarefactory-first-claim',
        ownedPaths: Object.freeze([...nextItem.ownedPaths])
      }));
    }
    drainRemainingStateItems(factoryState, deferredWorkItems);
  }

  // Tier 2: Enrolled consumer repositories share remaining slots via critical-path
  // priority with fair round-robin tie-breaking under strict per-repo local caps.
  while (remainingSlots > 0) {
    const readyConsumers = [];
    for (let i = 0; i < consumerStates.length; i++) {
      const state = consumerStates[i];
      const nextItem = advanceViableItem(state, deferredWorkItems);
      if (nextItem !== null) readyConsumers.push({state, nextItem});
    }
    if (readyConsumers.length === 0) break;
    readyConsumers.sort((left, right) =>
      (left.nextItem.criticalPathRank - right.nextItem.criticalPathRank) ||
      (left.state.allocatedThisCycle - right.state.allocatedThisCycle) ||
      (left.state.repo.repositoryId - right.state.repo.repositoryId)
    );
    const winner = readyConsumers[0];
    winner.state.cursor += 1;
    winner.state.activeCount += 1;
    winner.state.allocatedThisCycle += 1;
    winner.state.activePaths.push(...winner.nextItem.ownedPaths);
    remainingSlots -= 1;
    allocatedWorkItems.push(Object.freeze({
      repositoryId: winner.nextItem.repositoryId,
      repository: winner.state.repo.repository,
      issue: winner.nextItem.issue,
      laneId: winner.nextItem.laneId,
      head: winner.nextItem.head,
      criticalPathRank: winner.nextItem.criticalPathRank,
      priorityTier: 'consumer-fair-critical-path',
      ownedPaths: Object.freeze([...winner.nextItem.ownedPaths])
    }));
  }

  for (let i = 0; i < consumerStates.length; i++) {
    drainRemainingStateItems(consumerStates[i], deferredWorkItems);
  }

  const repositoryResults = [];
  const redMainRepos = [];
  const healthyTrainRepos = [];
  for (const state of repoById.values()) {
    if (!state.trainReport.mainHealthyAfter) {
      redMainRepos.push(state.repo.repository);
    } else if (!state.repo.killSwitch) {
      healthyTrainRepos.push(state.repo.repository);
    }
    repositoryResults.push(Object.freeze({
      repositoryId: state.repo.repositoryId,
      repository: state.repo.repository,
      priorityClass: state.isFactory ? 'softwarefactory-first-claim' : 'enrolled-consumer',
      killSwitch: state.repo.killSwitch,
      localConcurrencyCap: state.repo.localConcurrencyCap,
      maxConcurrency: state.repo.maxConcurrency,
      inFlightLeaseCount: state.repo.inFlightLeases.length,
      allocatedCount: state.allocatedThisCycle,
      effectiveActiveCount: state.activeCount,
      train: state.trainReport
    }));
  }

  const logicalLanesTotal = preservedInFlightLeases.length + input.workItems.length;
  const reason = allocatedWorkItems.length > 0 ? 'PORTFOLIO_SHADOW_ALLOCATED' : 'PORTFOLIO_EVALUATED_NO_NEW_ALLOCATION';

  return Object.freeze({
    valid: true,
    shadow: true,
    liveDispatch: false,
    liveMerge: false,
    reason,
    budgetAvailable: budget.available,
    remainingAvailableCapacity: remainingSlots,
    logicalLaneClassification: LOGICAL_LANE_CLASSIFICATION,
    logicalLanesTotal,
    withinArchitecturalStretchBand20To50: logicalLanesTotal >= 20 && logicalLanesTotal <= 50,
    logicalLanesAreConcurrentAgentAuthorization: false,
    authorizedConcurrentWorkers: 0,
    cancelledInFlightLeases: 0,
    crossRepoMainFailureSpillover: false,
    isolatedUnhealthyMainRepositories: Object.freeze(redMainRepos),
    unaffectedHealthyRepositories: Object.freeze(healthyTrainRepos),
    preservedInFlightLeases: Object.freeze(preservedInFlightLeases),
    allocatedWorkItems: Object.freeze(allocatedWorkItems),
    deferredWorkItems: Object.freeze(deferredWorkItems),
    repositoryResults: Object.freeze(repositoryResults)
  });
}

function isSupportedDotnet10Sdk(version) {
  return /^10\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version);
}

function isSupportedMafGaVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 1 || (major === 1 && minor >= 28);
}

function parseLogicalLaneProfile(profile, expectedKeys) {
  if (!exactRecord(profile, expectedKeys) ||
      typeof profile.runtime !== 'string' || !hex40(profile.workload) ||
      ![profile.contractPreserved, profile.deterministic, profile.securityReviewed,
        profile.independentReview, profile.rollbackReady, profile.costVerified].every(b => typeof b === 'boolean') ||
      !nonnegInt(profile.ciRestoreMs, 3600000) ||
      !nonnegInt(profile.ciCompileMs, 3600000) ||
      !nonnegInt(profile.ciCoverageMs, 3600000) ||
      !validCoverageCounts(profile.coveredLines, profile.totalLines) ||
      !validCoverageCounts(profile.coveredBranches, profile.totalBranches) ||
      (profile.incrementalSpendMicros !== null && !nonnegInt(profile.incrementalSpendMicros, 1000000000)) ||
      !denseDataArray(profile.logicalLaneTiers, 3) || profile.logicalLaneTiers.length !== 3) {
    return {ok: false, reason: 'EVIDENCE_UNKNOWN'};
  }

  const tierMap = new Map();
  for (let i = 0; i < 3; i++) {
    const tier = profile.logicalLaneTiers[i];
    if (!exactRecord(tier, LANE_TIER_KEYS) ||
        !LOGICAL_LANE_TIERS.includes(tier.logicalLanes) || tierMap.has(tier.logicalLanes) ||
        !positiveInt(tier.configuredWorkerCap, MAX_HOSTED_WORKER_CAP) ||
        !positiveInt(tier.observedPeakConcurrency, tier.configuredWorkerCap) ||
        typeof tier.concurrentAgentAuthorization !== 'boolean' ||
        !positiveInt(tier.wallClockMs, DAY_MS) ||
        !positiveInt(tier.cpuTimeMs, DAY_MS) ||
        !positiveInt(tier.peakMemoryMb, 1048576) ||
        !positiveInt(tier.p95LatencyMs, DAY_MS) ||
        !nonnegInt(tier.contentionWaitMs, DAY_MS) ||
        typeof tier.cancellationPropagated !== 'boolean' ||
        !nonnegInt(tier.cancellationMs, DAY_MS) ||
        !nonnegInt(tier.duplicatePathLeases, 100000) ||
        !nonnegInt(tier.crossRepoLeaks, 100000)) {
      return {ok: false, reason: 'EVIDENCE_UNKNOWN'};
    }
    if (tier.concurrentAgentAuthorization !== false) {
      return {ok: false, reason: 'UNAUTHORIZED_CONCURRENT_AGENT_CLAIM'};
    }
    tierMap.set(tier.logicalLanes, tier);
  }

  const ciOverheadMs = profile.ciRestoreMs + profile.ciCompileMs + profile.ciCoverageMs;
  const orderedTiers = LOGICAL_LANE_TIERS.map(lanes => {
    const t = tierMap.get(lanes);
    return Object.freeze({
      unitKind: 'logical-lanes',
      logicalLanes: t.logicalLanes,
      configuredWorkerCap: t.configuredWorkerCap,
      observedPeakConcurrency: t.observedPeakConcurrency,
      concurrentAgentAuthorization: false,
      wallClockMs: t.wallClockMs,
      cpuTimeMs: t.cpuTimeMs,
      peakMemoryMb: t.peakMemoryMb,
      p95LatencyMs: t.p95LatencyMs,
      contentionWaitMs: t.contentionWaitMs,
      cancellationPropagated: t.cancellationPropagated,
      cancellationMs: t.cancellationMs,
      duplicatePathLeases: t.duplicatePathLeases,
      crossRepoLeaks: t.crossRepoLeaks,
      endToEndMs: t.wallClockMs + ciOverheadMs
    });
  });

  const totalWallClockMs = orderedTiers.reduce((sum, t) => sum + t.wallClockMs, 0);
  const totalCpuTimeMs = orderedTiers.reduce((sum, t) => sum + t.cpuTimeMs, 0);
  const peakMemoryMb = Math.max(...orderedTiers.map(t => t.peakMemoryMb));
  const maxP95LatencyMs = Math.max(...orderedTiers.map(t => t.p95LatencyMs));

  return {
    ok: true,
    orderedTiers,
    summary: Object.freeze({
      runtime: profile.runtime,
      logicalLaneClassification: LOGICAL_LANE_CLASSIFICATION,
      totalWallClockMs,
      totalCpuTimeMs,
      peakMemoryMb,
      maxP95LatencyMs,
      ciRestoreMs: profile.ciRestoreMs,
      ciCompileMs: profile.ciCompileMs,
      ciCoverageMs: profile.ciCoverageMs,
      ciOverheadMs,
      netEndToEndMs: totalWallClockMs + ciOverheadMs,
      coveredLines: profile.coveredLines,
      totalLines: profile.totalLines,
      coveredBranches: profile.coveredBranches,
      totalBranches: profile.totalBranches,
      logicalLaneTiers: Object.freeze(orderedTiers)
    })
  };
}

function validCohortSample(sample) {
  return exactRecord(sample, COHORT_SAMPLE_KEYS) &&
    cohortSlug(sample.cohort) && hex40(sample.workload) && hex40(sample.gateSet) &&
    typeof sample.complete === 'boolean' && positiveInt(sample.windowMs, YEAR_MS) &&
    nonnegInt(sample.accepted, 100000) && nonnegInt(sample.censored, 100000) &&
    [sample.gatesPassed, sample.independentReview, sample.mainHealthy, sample.compatibleTrain,
      sample.rollbackReady, sample.costVerified].every(b => typeof b === 'boolean') &&
    nonnegInt(sample.duplicateDispatches, 100000) && nonnegInt(sample.unauthorizedWrites, 100000) &&
    validCoverageCounts(sample.coveredLines, sample.totalLines) &&
    validCoverageCounts(sample.coveredBranches, sample.totalBranches) &&
    nonnegInt(sample.rework, 100000) && nonnegInt(sample.humanInterventions, 100000) &&
    (sample.incrementalSpendMicros === null || nonnegInt(sample.incrementalSpendMicros, 1000000000));
}

function cohortGatesClear(sample) {
  return sample.gatesPassed && sample.independentReview && sample.mainHealthy &&
    sample.compatibleTrain && sample.rollbackReady &&
    sample.duplicateDispatches === 0 && sample.unauthorizedWrites === 0;
}

function createUnmeasuredCohortSummary() {
  const checkpoints = THROUGHPUT_COHORT_MULTIPLIERS.map(multiplier => Object.freeze({
    checkpoint: `${multiplier}x`,
    multiplier,
    met: false,
    status: 'UNMEASURED_BASELINE_REQUIRED'
  }));
  return Object.freeze({
    measured: false,
    source: 'unmeasured',
    status: 'UNMEASURED_BASELINE_REQUIRED',
    throughputRatio: null,
    highestCheckpoint: null,
    keepStretchOpen: true,
    checkpoints: Object.freeze(checkpoints)
  });
}

function evaluateMatchedCohorts(cohorts, expectedWorkload) {
  if (cohorts === null) {
    return {ok: true, summary: createUnmeasuredCohortSummary()};
  }
  if (!exactRecord(cohorts, COHORT_ENVELOPE_KEYS) ||
      (cohorts.source !== 'synthetic' && cohorts.source !== 'verified') ||
      !isRepoSlug(cohorts.repository) ||
      !exactRecord(cohorts.policy, COHORT_POLICY_KEYS) ||
      !nonnegInt(cohorts.policy.minLinePercent, 100) ||
      !nonnegInt(cohorts.policy.minBranchPercent, 100) ||
      !validCohortSample(cohorts.baseline) || !validCohortSample(cohorts.candidate)) {
    return {ok: false, reason: 'EVIDENCE_UNKNOWN'};
  }

  const lowerRepo = cohorts.repository.toLowerCase();
  const isFactory = lowerRepo === SOFTWARE_FACTORY_REPOSITORY.toLowerCase();
  const isSpellbook = isSpellbookSlug(cohorts.repository);
  const lineFloor = isFactory ? 98 : (isSpellbook ? 97 : 95);
  const branchFloor = isFactory ? 95 : 90;
  if (cohorts.policy.minLinePercent < lineFloor || cohorts.policy.minBranchPercent < branchFloor) {
    return {ok: false, reason: 'POLICY_BELOW_MINIMUM'};
  }

  const {baseline, candidate} = cohorts;
  if (baseline.cohort !== candidate.cohort ||
      baseline.workload !== expectedWorkload || candidate.workload !== expectedWorkload ||
      baseline.gateSet !== candidate.gateSet || !baseline.complete || !candidate.complete ||
      baseline.accepted < 5 || candidate.accepted < 5) {
    return {ok: false, reason: 'UNMATCHED_OR_INCOMPLETE_COHORT'};
  }
  if (!cohortGatesClear(baseline) || !cohortGatesClear(candidate)) {
    return {ok: false, reason: 'QUALITY_OR_SAFETY_GATE_FAILED'};
  }
  if (!meetsCoverageFloor(
        baseline.coveredLines, baseline.totalLines, baseline.coveredBranches, baseline.totalBranches,
        cohorts.policy.minLinePercent, cohorts.policy.minBranchPercent
      ) ||
      !meetsCoverageFloor(
        candidate.coveredLines, candidate.totalLines, candidate.coveredBranches, candidate.totalBranches,
        cohorts.policy.minLinePercent, cohorts.policy.minBranchPercent
      ) ||
      coverageRegressed(baseline, candidate)) {
    return {ok: false, reason: 'COVERAGE_REGRESSION'};
  }
  const rateIncreased = (candCount, baseCount) =>
    candCount > baseCount ||
    BigInt(candCount) * BigInt(baseline.accepted) > BigInt(baseCount) * BigInt(candidate.accepted);
  if (rateIncreased(candidate.rework, baseline.rework) ||
      rateIncreased(candidate.humanInterventions, baseline.humanInterventions)) {
    return {ok: false, reason: 'REWORK_OR_INTERVENTION_REGRESSION'};
  }
  if (!baseline.costVerified || baseline.incrementalSpendMicros !== 0 ||
      !candidate.costVerified || candidate.incrementalSpendMicros !== 0) {
    return {ok: false, reason: 'SPEND_UNKNOWN_OR_EXCEEDED'};
  }

  const candScaled = BigInt(candidate.accepted) * BigInt(baseline.windowMs);
  const baseScaled = BigInt(baseline.accepted) * BigInt(candidate.windowMs);
  if (candScaled < baseScaled) {
    return {ok: false, reason: 'THROUGHPUT_REGRESSION'};
  }

  let highestCheckpoint = null;
  const checkpoints = THROUGHPUT_COHORT_MULTIPLIERS.map(multiplier => {
    const met = candScaled >= BigInt(multiplier) * baseScaled;
    if (met) highestCheckpoint = `${multiplier}x`;
    return Object.freeze({
      checkpoint: `${multiplier}x`,
      multiplier,
      met,
      status: met ? `${cohorts.source}-met` : `${cohorts.source}-not-yet-met`
    });
  });

  return {
    ok: true,
    summary: Object.freeze({
      measured: true,
      source: cohorts.source,
      repository: cohorts.repository,
      cohort: baseline.cohort,
      status: highestCheckpoint ? 'CHECKPOINTS_EVALUATED' : 'BELOW_FIRST_CHECKPOINT',
      throughputRatio: (candidate.accepted * baseline.windowMs) / (baseline.accepted * candidate.windowMs),
      highestCheckpoint,
      keepStretchOpen: !(cohorts.source === 'verified' && highestCheckpoint === '25x'),
      baselineAcceptedPerDay: (baseline.accepted * DAY_MS) / baseline.windowMs,
      candidateAcceptedPerDay: (candidate.accepted * DAY_MS) / candidate.windowMs,
      checkpoints: Object.freeze(checkpoints)
    })
  };
}

function consolidationDenied(reason) {
  return Object.freeze({
    valid: false,
    shadow: true,
    liveDispatch: false,
    liveMerge: false,
    comparable: false,
    baselineReady: false,
    consolidationEligible: false,
    recommendation: 'retain-node-authoritative',
    logicalLaneClassification: LOGICAL_LANE_CLASSIFICATION,
    logicalLanesAreConcurrentAgentAuthorization: false,
    reason
  });
}

export function evaluateDotnetConsolidationBenchmark(input) {
  if (!exactRecord(input, BENCHMARK_INPUT_KEYS)) return consolidationDenied('EVIDENCE_UNKNOWN');
  if (input.stop !== false) return consolidationDenied('STOPPED');
  if (input.hostedRunner !== true) return consolidationDenied('HOSTED_EVIDENCE_REQUIRED');
  if (input.linuxAndWindowsVerified !== true) return consolidationDenied('CROSS_PLATFORM_EVIDENCE_REQUIRED');
  if (!hex40(input.workload) || !nonnegInt(input.minNetGainPercent, 90) || input.minNetGainPercent < 15) {
    return consolidationDenied('EVIDENCE_UNKNOWN');
  }

  const nodeParsed = parseLogicalLaneProfile(input.nodeBaseline, COMMON_ENGINE_KEYS);
  if (!nodeParsed.ok) return consolidationDenied(nodeParsed.reason);
  if (input.nodeBaseline.runtime !== PINNED_NODE_RUNTIME) return consolidationDenied('EVIDENCE_UNKNOWN');
  if (input.nodeBaseline.workload !== input.workload) return consolidationDenied('UNMATCHED_WORKLOAD');
  if (!input.nodeBaseline.costVerified || input.nodeBaseline.incrementalSpendMicros !== 0) {
    return consolidationDenied('SPEND_UNKNOWN_OR_EXCEEDED');
  }
  if (!input.nodeBaseline.contractPreserved || !input.nodeBaseline.deterministic ||
      !meetsCoverageFloor(
        input.nodeBaseline.coveredLines, input.nodeBaseline.totalLines,
        input.nodeBaseline.coveredBranches, input.nodeBaseline.totalBranches, 98, 95
      ) ||
      !nodeParsed.orderedTiers.every(t =>
        t.cancellationPropagated && t.duplicatePathLeases === 0 && t.crossRepoLeaks === 0
      ) ||
      !input.nodeBaseline.securityReviewed || !input.nodeBaseline.independentReview ||
      !input.nodeBaseline.rollbackReady) {
    return consolidationDenied('NODE_BASELINE_UNVERIFIED');
  }

  const cohortEval = evaluateMatchedCohorts(input.cohorts, input.workload);
  if (!cohortEval.ok) return consolidationDenied(cohortEval.reason);

  if (input.dotnetMafCandidate === null) {
    return Object.freeze({
      valid: true,
      shadow: true,
      liveDispatch: false,
      liveMerge: false,
      comparable: false,
      baselineReady: true,
      consolidationEligible: false,
      recommendation: 'retain-node-authoritative',
      logicalLaneClassification: LOGICAL_LANE_CLASSIFICATION,
      logicalLanesAreConcurrentAgentAuthorization: false,
      reason: 'NODE_BASELINE_RECORDED',
      workload: input.workload,
      nodeBaseline: nodeParsed.summary,
      dotnetMafCandidate: null,
      tierComparisons: null,
      netGainPercent: null,
      cohorts: cohortEval.summary
    });
  }

  const cand = input.dotnetMafCandidate;
  const candParsed = parseLogicalLaneProfile(cand, DOTNET_ENGINE_KEYS);
  if (!candParsed.ok) return consolidationDenied(candParsed.reason);
  if (cand.runtime !== PINNED_DOTNET_MAF_RUNTIME ||
      typeof cand.dotnetSdkVersion !== 'string' || typeof cand.mafWorkflowsVersion !== 'string' ||
      ![cand.pregelSuperstepsVerified, cand.checkpointResumeVerified,
        cand.aspireOtelActivitySourceVerified, cand.shadowOnlyClientEnforced].every(b => typeof b === 'boolean') ||
      !nonnegInt(cand.priorSuperstepsRepeatedOnResume, 100000) ||
      !denseDataArray(cand.forbiddenLegacyDependencies, 16) ||
      !cand.forbiddenLegacyDependencies.every(dep => typeof dep === 'string' && dep.length > 0 && dep.length <= 80)) {
    return consolidationDenied('EVIDENCE_UNKNOWN');
  }
  if (!isSupportedDotnet10Sdk(cand.dotnetSdkVersion) || !isSupportedMafGaVersion(cand.mafWorkflowsVersion)) {
    return consolidationDenied('MAF_RUNTIME_VERSION_UNSUPPORTED');
  }
  if (cand.forbiddenLegacyDependencies.length > 0) {
    return consolidationDenied('LEGACY_OR_EXCLUDED_DEPENDENCY_DETECTED');
  }
  if (cand.workload !== input.workload) return consolidationDenied('UNMATCHED_WORKLOAD');
  if (!cand.costVerified || cand.incrementalSpendMicros !== 0) {
    return consolidationDenied('SPEND_UNKNOWN_OR_EXCEEDED');
  }

  const tierComparisons = LOGICAL_LANE_TIERS.map((logicalLanes, idx) => {
    const nodeTier = nodeParsed.orderedTiers[idx];
    const candTier = candParsed.orderedTiers[idx];
    return Object.freeze({
      unitKind: 'logical-lanes',
      logicalLanes,
      concurrentAgentAuthorization: false,
      wallClockDeltaMs: candTier.wallClockMs - nodeTier.wallClockMs,
      endToEndDeltaMs: candTier.endToEndMs - nodeTier.endToEndMs,
      netGainPercent: ((nodeTier.endToEndMs - candTier.endToEndMs) * 100) / nodeTier.endToEndMs,
      cpuTimeDeltaMs: candTier.cpuTimeMs - nodeTier.cpuTimeMs,
      peakMemoryDeltaMb: candTier.peakMemoryMb - nodeTier.peakMemoryMb,
      p95LatencyDeltaMs: candTier.p95LatencyMs - nodeTier.p95LatencyMs,
      contentionDeltaMs: candTier.contentionWaitMs - nodeTier.contentionWaitMs,
      cancellationDeltaMs: candTier.cancellationMs - nodeTier.cancellationMs,
      cancellationPropagated: candTier.cancellationPropagated,
      nodeEndToEndMs: nodeTier.endToEndMs,
      dotnetEndToEndMs: candTier.endToEndMs
    });
  });

  const nodeNetMs = nodeParsed.summary.netEndToEndMs;
  const dotnetNetMs = candParsed.summary.netEndToEndMs;
  const netGainPercent = ((nodeNetMs - dotnetNetMs) * 100) / nodeNetMs;
  const dotnetSummary = Object.freeze({
    ...candParsed.summary,
    dotnetSdkVersion: cand.dotnetSdkVersion,
    mafWorkflowsVersion: cand.mafWorkflowsVersion,
    pregelSuperstepsVerified: cand.pregelSuperstepsVerified,
    checkpointResumeVerified: cand.checkpointResumeVerified,
    priorSuperstepsRepeatedOnResume: cand.priorSuperstepsRepeatedOnResume,
    aspireOtelActivitySourceVerified: cand.aspireOtelActivitySourceVerified,
    shadowOnlyClientEnforced: cand.shadowOnlyClientEnforced
  });

  const buildOutcome = (consolidationEligible, recommendation, reason) => Object.freeze({
    valid: true,
    shadow: true,
    liveDispatch: false,
    liveMerge: false,
    comparable: true,
    baselineReady: true,
    consolidationEligible,
    recommendation,
    logicalLaneClassification: LOGICAL_LANE_CLASSIFICATION,
    logicalLanesAreConcurrentAgentAuthorization: false,
    reason,
    workload: input.workload,
    minNetGainPercent: input.minNetGainPercent,
    netGainPercent,
    nodeBaseline: nodeParsed.summary,
    dotnetMafCandidate: dotnetSummary,
    tierComparisons: Object.freeze(tierComparisons),
    cohorts: cohortEval.summary
  });

  if (!cand.contractPreserved || !cand.deterministic || !cand.shadowOnlyClientEnforced ||
      !cand.pregelSuperstepsVerified || !cand.checkpointResumeVerified ||
      cand.priorSuperstepsRepeatedOnResume !== 0 || !cand.aspireOtelActivitySourceVerified ||
      !candParsed.orderedTiers.every(t =>
        t.cancellationPropagated && t.duplicatePathLeases === 0 && t.crossRepoLeaks === 0
      )) {
    return buildOutcome(false, 'retain-node-authoritative', 'MAF_ARCHITECTURE_OR_SAFETY_UNVERIFIED');
  }
  if (!meetsCoverageFloor(
        cand.coveredLines, cand.totalLines, cand.coveredBranches, cand.totalBranches, 98, 95
      ) || coverageRegressed(input.nodeBaseline, cand)) {
    return buildOutcome(false, 'retain-node-authoritative', 'CANDIDATE_COVERAGE_REGRESSION');
  }
  if (!cand.securityReviewed || !cand.independentReview || !cand.rollbackReady) {
    return buildOutcome(false, 'retain-node-authoritative', 'REVIEW_OR_ROLLBACK_UNREADY');
  }
  if (tierComparisons.some(t =>
        t.wallClockDeltaMs > 0 || t.cpuTimeDeltaMs > 0 || t.peakMemoryDeltaMb > 0 ||
        t.p95LatencyDeltaMs > 0 || t.contentionDeltaMs > 0 || t.cancellationDeltaMs > 0
      )) {
    return buildOutcome(false, 'retain-node-authoritative', 'TIER_METRIC_REGRESSION');
  }
  if (tierComparisons.some(t => t.endToEndDeltaMs >= 0)) {
    return buildOutcome(false, 'retain-node-authoritative', 'CI_OVERHEAD_EXCEEDS_RUNTIME_GAIN');
  }
  if (tierComparisons.some(t =>
        BigInt(t.nodeEndToEndMs - t.dotnetEndToEndMs) * 100n <
        BigInt(input.minNetGainPercent) * BigInt(t.nodeEndToEndMs)
      ) ||
      BigInt(nodeNetMs - dotnetNetMs) * 100n < BigInt(input.minNetGainPercent) * BigInt(nodeNetMs)) {
    return buildOutcome(false, 'retain-node-authoritative', 'INSUFFICIENT_NET_END_TO_END_GAIN');
  }
  if (!cohortEval.summary.measured) {
    return buildOutcome(false, 'retain-node-authoritative', 'MEASURED_COHORTS_REQUIRED');
  }
  if (cohortEval.summary.highestCheckpoint === null) {
    return buildOutcome(false, 'retain-node-authoritative', 'COHORT_BELOW_FIRST_CHECKPOINT');
  }
  if (cohortEval.summary.source !== 'verified') {
    return buildOutcome(false, 'retain-node-authoritative', 'VERIFIED_HOSTED_COHORTS_REQUIRED');
  }

  return buildOutcome(true, 'dotnet-10-consolidation-eligible', 'DOTNET_10_CONSOLIDATION_ELIGIBLE');
}
