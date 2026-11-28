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
export const SHARED_M02_COHORT_TARGET_OUTCOMES = 5;
export const SHARED_M01_ANCHOR_TARGET_OUTCOMES = 3;
export const SHARED_M02_EXIT_ISSUES = Object.freeze([14, 16, 18, 137]);
export const M01_EXIT_ANCHOR_ISSUE = 10;
export const UNATTENDED_COPILOT_ACTOR = 'copilot-swe-agent[bot]';
export const STREAMLINED_M02_MIN_ACCEPTED_ISSUES = 5;
export const COORDINATOR_DISPATCHED_WAVE_PROVENANCE =
  'coordinator-dispatched-worktree-and-cloud-agent-wave';
export const FUTURE_GH_AW_CRON_PROVENANCE = 'future-gh-aw-cron-unattended-wave';

const DAY_MS = 86400000;
const YEAR_MS = 31536000000;

const PORTFOLIO_INPUT_KEYS = ['stop', 'budget', 'repositories', 'workItems'];
const PORTFOLIO_OPTIONAL_KEYS = ['lastServedConsumerRepositoryId'];
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
const TRAIN_OPTIONAL_KEYS = ['mainRecoveryVerified'];
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
    nextConsumerCursorRepositoryId: null,
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

  if (!train.mainHealthy && train.mainRecoveryVerified !== true) {
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
  const mergedTrainShas = new Set([train.mainSha]);
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
        !mergedTrainShas.has(c.expectedBase) ||
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
    mergedTrainShas.add(c.simulatedSquashSha);
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
    mainHealthyBefore: train.mainHealthy,
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

function consumerRotationDistance(state, orderedStates, cursorRepoId) {
  let startIndex = 0;
  if (cursorRepoId !== null) {
    const afterIndex = orderedStates.findIndex(s => s.repo.repositoryId > cursorRepoId);
    if (afterIndex !== -1) startIndex = afterIndex;
  }
  const len = orderedStates.length;
  return (state.consumerOrder - startIndex + len) % len;
}

export function allocatePortfolioCapacityAndSimulateTrains(input) {
  if (!exactRecord(input, PORTFOLIO_INPUT_KEYS, PORTFOLIO_OPTIONAL_KEYS)) {
    return portfolioDenied('INPUT_UNKNOWN');
  }
  const initialCursor = Object.hasOwn(input, 'lastServedConsumerRepositoryId')
    ? input.lastServedConsumerRepositoryId
    : null;
  if (initialCursor !== null && !positiveInt(initialCursor)) {
    return portfolioDenied('INPUT_UNKNOWN');
  }
  if (input.stop !== false) return portfolioDenied('STOPPED');
  if (!exactRecord(input.budget, BUDGET_REQUIRED_KEYS, BUDGET_OPTIONAL_KEYS)) {
    return portfolioDenied('BUDGET_UNKNOWN');
  }
  if (!Object.hasOwn(input.budget, 'hardStopReceipt') ||
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
    const mainRecoveryVerified = Object.hasOwn(train, 'mainRecoveryVerified')
      ? train.mainRecoveryVerified
      : false;
    if (!exactRecord(train, TRAIN_KEYS, TRAIN_OPTIONAL_KEYS) ||
        !branchName(train.defaultBranch) || !hex40(train.mainSha) ||
        typeof train.mainHealthy !== 'boolean' ||
        typeof mainRecoveryVerified !== 'boolean' ||
        (train.mainHealthy && mainRecoveryVerified) ||
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
    if (isFactoryId && (train.defaultBranch !== 'main' || mq.mode !== 'native-merge-queue')) {
      return portfolioDenied('SOFTWARE_FACTORY_MERGE_QUEUE_REQUIRED');
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
  // priority with fair round-robin tie-breaking across evaluations under strict local caps.
  consumerStates.sort((a, b) => a.repo.repositoryId - b.repo.repositoryId);
  for (let i = 0; i < consumerStates.length; i++) {
    consumerStates[i].consumerOrder = i;
  }
  let consumerCursorRepoId = initialCursor;

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
      (consumerRotationDistance(left.state, consumerStates, consumerCursorRepoId) -
        consumerRotationDistance(right.state, consumerStates, consumerCursorRepoId))
    );
    const winner = readyConsumers[0];
    winner.state.cursor += 1;
    winner.state.activeCount += 1;
    winner.state.allocatedThisCycle += 1;
    winner.state.activePaths.push(...winner.nextItem.ownedPaths);
    consumerCursorRepoId = winner.state.repo.repositoryId;
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
    nextConsumerCursorRepositoryId: consumerCursorRepoId,
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

function summarizeCohortArm(sample) {
  return Object.freeze({
    accepted: sample.accepted,
    censored: sample.censored,
    windowMs: sample.windowMs,
    acceptedPerDay: (sample.accepted * DAY_MS) / sample.windowMs,
    rework: sample.rework,
    humanInterventions: sample.humanInterventions,
    incrementalSpendMicros: sample.incrementalSpendMicros,
    coverage: Object.freeze({
      coveredLines: sample.coveredLines,
      totalLines: sample.totalLines,
      coveredBranches: sample.coveredBranches,
      totalBranches: sample.totalBranches
    })
  });
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
    comparableAcceptedUnits: 0,
    baseline: null,
    candidate: null,
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
      comparableAcceptedUnits: Math.min(baseline.accepted, candidate.accepted),
      baselineAcceptedPerDay: (baseline.accepted * DAY_MS) / baseline.windowMs,
      candidateAcceptedPerDay: (candidate.accepted * DAY_MS) / candidate.windowMs,
      baseline: summarizeCohortArm(baseline),
      candidate: summarizeCohortArm(candidate),
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
  if (LOGICAL_LANE_TIERS.some((_, idx) =>
        nodeParsed.orderedTiers[idx].configuredWorkerCap !==
        candParsed.orderedTiers[idx].configuredWorkerCap
      )) {
    return consolidationDenied('UNMATCHED_WORKER_CAP');
  }
  if (!cand.costVerified || cand.incrementalSpendMicros !== 0) {
    return consolidationDenied('SPEND_UNKNOWN_OR_EXCEEDED');
  }

  const tierComparisons = LOGICAL_LANE_TIERS.map((logicalLanes, idx) => {
    const nodeTier = nodeParsed.orderedTiers[idx];
    const candTier = candParsed.orderedTiers[idx];
    return Object.freeze({
      unitKind: 'logical-lanes',
      logicalLanes,
      configuredWorkerCap: nodeTier.configuredWorkerCap,
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

const SHARED_COHORT_INPUT_KEYS = [
  'stop', 'repositoryId', 'repository', 'headSha', 'policy',
  'billingHardStopVerified', 'incrementalSpendMicros',
  'portfolioInput', 'benchmarkInput', 'engineeringWaves',
  'unattendedOutcomes', 'sharedCohortMeasurements'
];
const ENGINEERING_WAVE_KEYS = [
  'waveId', 'provenanceKind', 'initialMainSha', 'finalMainSha',
  'windowStartMs', 'windowEndMs', 'prNumbers', 'mergeQueueDurationsMs',
  'postMergeMainFailures', 'recoveredBeforeNextWave', 'incrementalSpendMicros'
];
const SHARED_COHORT_MEASUREMENT_KEYS = [
  'repositoryId', 'repository', 'headSha', 'evaluatedIssueNumbers',
  'baselineExplorationStepsP50', 'candidateExplorationStepsP50',
  'baselineContextBytesLoadedP50', 'candidateContextBytesLoadedP50',
  'baselineReworkRateBps', 'candidateReworkRateBps',
  'scorecardReadoutVerified', 'kaizenVerificationPassed',
  'incrementalSpendMicros'
];
const UNATTENDED_OUTCOME_KEYS = [
  'repositoryId', 'repository', 'issue', 'pr', 'provenanceKind', 'agentActor',
  'issueAccepted', 'allRequiredPrsMerged',
  'm01CohortMember', 'parallelBatchGroup', 'reviewRepairVerified',
  'parentMainSha', 'headSha', 'squashMergeSha',
  'assignedAtMs', 'mergedAtMs', 'mergeQueueDurationMs', 'ownedPaths',
  'coveredLines', 'totalLines', 'coveredBranches', 'totalBranches',
  'checksPassed', 'securityClear', 'independentReview', 'unresolvedFindings',
  'mainHealthyAfterMerge', 'rollbackReady', 'reworkIterations',
  'routineHumanInterventions', 'duplicateDispatches', 'unauthorizedWrites',
  'incrementalSpendMicros'
];

function sharedCohortDenied(reason) {
  return Object.freeze({
    valid: false,
    shadow: true,
    liveDispatch: false,
    liveMerge: false,
    multiCohortLadderRetired: true,
    sharedCohortTargetOutcomes: SHARED_M02_COHORT_TARGET_OUTCOMES,
    m01AnchorTargetOutcomes: SHARED_M01_ANCHOR_TARGET_OUTCOMES,
    sharedIssues: SHARED_M02_EXIT_ISSUES,
    m01AnchorIssue: M01_EXIT_ANCHOR_ISSUE,
    provenanceSeparated: false,
    cohortComplete: false,
    m02ExitReady: false,
    keepIssue16Open: true,
    status: 'BLOCKED',
    reason
  });
}

function parseEngineeringWaves(waves) {
  const seenWaveIds = new Set();
  const wavePrNumbers = new Set();
  const waveByPr = new Map();
  const allMqMs = [];
  const summaries = [];
  let earliestStartMs = Infinity;
  let latestEndMs = 0;
  let historicalPostMergeMainFailures = 0;

  for (let i = 0; i < waves.length; i++) {
    const w = waves[i];
    if (!exactRecord(w, ENGINEERING_WAVE_KEYS) ||
        !cohortSlug(w.waveId) || seenWaveIds.has(w.waveId) ||
        typeof w.provenanceKind !== 'string' ||
        !hex40(w.initialMainSha) || !hex40(w.finalMainSha) ||
        w.initialMainSha === w.finalMainSha ||
        !positiveInt(w.windowStartMs) || !positiveInt(w.windowEndMs) ||
        w.windowEndMs <= w.windowStartMs ||
        !denseDataArray(w.prNumbers, 100) || w.prNumbers.length === 0 ||
        !denseDataArray(w.mergeQueueDurationsMs, 100) ||
        w.mergeQueueDurationsMs.length !== w.prNumbers.length ||
        !nonnegInt(w.postMergeMainFailures, 1000) ||
        typeof w.recoveredBeforeNextWave !== 'boolean' ||
        (w.postMergeMainFailures === 0 && w.recoveredBeforeNextWave) ||
        (w.incrementalSpendMicros !== null && !nonnegInt(w.incrementalSpendMicros, 1000000000)) ||
        !w.prNumbers.every(pr => positiveInt(pr, 1000000)) ||
        !w.mergeQueueDurationsMs.every(ms => positiveInt(ms, DAY_MS))) {
      return {ok: false, reason: 'ENGINEERING_WAVE_UNKNOWN'};
    }
    if (w.provenanceKind !== 'session-orchestrated-merge-queue-wave') {
      return {ok: false, reason: 'PROVENANCE_CONFLATION_REJECTED'};
    }
    if (w.incrementalSpendMicros !== 0) {
      return {ok: false, reason: 'SPEND_UNKNOWN_OR_EXCEEDED'};
    }
    if (w.postMergeMainFailures > 0 && (!w.recoveredBeforeNextWave || i === waves.length - 1)) {
      return {ok: false, reason: 'WAVE_MAIN_FAILURE_DETECTED'};
    }
    if (i > 0 &&
        (w.initialMainSha !== waves[i - 1].finalMainSha ||
          w.windowEndMs < waves[i - 1].windowEndMs)) {
      return {ok: false, reason: 'WAVE_CHAIN_DISCONTINUITY'};
    }
    for (let j = 0; j < w.prNumbers.length; j++) {
      const pr = w.prNumbers[j];
      if (wavePrNumbers.has(pr)) return {ok: false, reason: 'ENGINEERING_WAVE_UNKNOWN'};
      wavePrNumbers.add(pr);
      waveByPr.set(pr, w);
    }
    seenWaveIds.add(w.waveId);
    earliestStartMs = Math.min(earliestStartMs, w.windowStartMs);
    latestEndMs = Math.max(latestEndMs, w.windowEndMs);
    historicalPostMergeMainFailures += w.postMergeMainFailures;
    allMqMs.push(...w.mergeQueueDurationsMs);
    const sortedWaveMq = [...w.mergeQueueDurationsMs].sort((a, b) => a - b);
    const waveWindowMs = w.windowEndMs - w.windowStartMs;
    summaries.push(Object.freeze({
      waveId: w.waveId,
      provenanceKind: w.provenanceKind,
      initialMainSha: w.initialMainSha,
      finalMainSha: w.finalMainSha,
      prCount: w.prNumbers.length,
      windowMs: waveWindowMs,
      mergedPerDay: (w.prNumbers.length * DAY_MS) / waveWindowMs,
      p50MergeQueueMs: percentile(sortedWaveMq, 0.5),
      p95MergeQueueMs: percentile(sortedWaveMq, 0.95),
      postMergeMainFailures: w.postMergeMainFailures,
      recoveredBeforeNextWave: w.recoveredBeforeNextWave
    }));
  }

  const sortedAllMq = [...allMqMs].sort((a, b) => a - b);
  const totalWindowMs = latestEndMs - earliestStartMs;
  return {
    ok: true,
    wavePrNumbers,
    waveByPr,
    finalMainSha: waves[waves.length - 1].finalMainSha,
    summary: Object.freeze({
      provenanceKind: 'session-orchestrated-merge-queue-wave',
      waveCount: summaries.length,
      totalMergedPrs: wavePrNumbers.size,
      windowMs: totalWindowMs,
      mergedPerDay: (wavePrNumbers.size * DAY_MS) / totalWindowMs,
      p50MergeQueueMs: percentile(sortedAllMq, 0.5),
      p95MergeQueueMs: percentile(sortedAllMq, 0.95),
      historicalPostMergeMainFailures,
      unresolvedPostMergeMainFailures: 0,
      incrementalSpendMicros: 0,
      waves: Object.freeze(summaries)
    })
  };
}

function validUnattendedOutcomeShape(o) {
  return exactRecord(o, UNATTENDED_OUTCOME_KEYS) &&
    positiveInt(o.repositoryId) && isRepoSlug(o.repository) &&
    positiveInt(o.issue, 1000000) && positiveInt(o.pr, 1000000) &&
    typeof o.provenanceKind === 'string' && typeof o.agentActor === 'string' &&
    typeof o.issueAccepted === 'boolean' && typeof o.allRequiredPrsMerged === 'boolean' &&
    typeof o.m01CohortMember === 'boolean' &&
    (o.parallelBatchGroup === null || cohortSlug(o.parallelBatchGroup)) &&
    typeof o.reviewRepairVerified === 'boolean' &&
    hex40(o.parentMainSha) && hex40(o.headSha) && hex40(o.squashMergeSha) &&
    o.headSha !== o.squashMergeSha && o.parentMainSha !== o.squashMergeSha &&
    positiveInt(o.assignedAtMs) && positiveInt(o.mergedAtMs) && o.mergedAtMs > o.assignedAtMs &&
    positiveInt(o.mergeQueueDurationMs, DAY_MS) &&
    validUniquePathList(o.ownedPaths) && !hasInternalPathOverlap(o.ownedPaths) &&
    validCoverageCounts(o.coveredLines, o.totalLines) &&
    validCoverageCounts(o.coveredBranches, o.totalBranches) &&
    [o.checksPassed, o.securityClear, o.independentReview,
      o.mainHealthyAfterMerge, o.rollbackReady].every(b => typeof b === 'boolean') &&
    nonnegInt(o.unresolvedFindings, 10000) &&
    nonnegInt(o.reworkIterations, 1000) &&
    nonnegInt(o.routineHumanInterventions, 1000) &&
    nonnegInt(o.duplicateDispatches, 1000) &&
    nonnegInt(o.unauthorizedWrites, 1000) &&
    (o.incrementalSpendMicros === null || nonnegInt(o.incrementalSpendMicros, 1000000000));
}

function samePathSet(leftPaths, rightPaths) {
  if (leftPaths.length !== rightPaths.length) return false;
  const rightSet = new Set(rightPaths);
  return leftPaths.every(p => rightSet.has(p));
}

function hasConcurrentExecutionWindowPair(windows) {
  for (let i = 0; i < windows.length; i++) {
    for (let j = i + 1; j < windows.length; j++) {
      if (windows[i].assignedAtMs < windows[j].mergedAtMs &&
          windows[j].assignedAtMs < windows[i].mergedAtMs) {
        return true;
      }
    }
  }
  return false;
}

function parseUnattendedOutcomes(
  outcomes,
  wavePrNumbers,
  policy,
  expectedRepoId,
  expectedRepo,
  mergedTrainCandidateByPr
) {
  const seenIssues = new Set();
  const seenPrs = new Set();
  const seenSquash = new Set();
  const acceptedIssueNumbers = [];
  const parallelGroups = new Map();
  const leadDurations = [];
  const mqDurations = [];
  let acceptedCount = 0;
  let partialOutcomeCount = 0;
  let m01MemberCount = 0;
  let m01ReviewRepairCount = 0;
  let totalReworkIterations = 0;
  let earliestAssignedMs = Infinity;
  let latestMergedMs = 0;
  let coveredLines = 0;
  let totalLines = 0;
  let coveredBranches = 0;
  let totalBranches = 0;

  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    if (!validUnattendedOutcomeShape(o) ||
        seenIssues.has(o.issue) || seenPrs.has(o.pr) || seenSquash.has(o.squashMergeSha) ||
        (o.reviewRepairVerified && o.reworkIterations === 0)) {
      return {ok: false, reason: 'OUTCOME_SCHEMA_INVALID'};
    }
    if (o.repositoryId !== expectedRepoId || o.repository !== expectedRepo) {
      return {ok: false, reason: 'CROSS_REPO_OUTCOME_MISMATCH'};
    }
    if (o.provenanceKind !== 'unattended-copilot-issue-outcome' || wavePrNumbers.has(o.pr)) {
      return {ok: false, reason: 'PROVENANCE_CONFLATION_REJECTED'};
    }
    if (o.agentActor !== UNATTENDED_COPILOT_ACTOR) {
      return {ok: false, reason: 'UNVERIFIED_UNATTENDED_ACTOR'};
    }
    const mergedCand = mergedTrainCandidateByPr.get(o.pr);
    if (!mergedCand ||
        mergedCand.head !== o.headSha ||
        mergedCand.expectedBase !== o.parentMainSha ||
        mergedCand.simulatedSquashSha !== o.squashMergeSha ||
        !samePathSet(o.ownedPaths, mergedCand.ownedPaths)) {
      return {ok: false, reason: 'UNVERIFIED_MAIN_ANCESTRY'};
    }
    if (o.incrementalSpendMicros !== 0) {
      return {ok: false, reason: 'SPEND_UNKNOWN_OR_EXCEEDED'};
    }
    if (o.reworkIterations > 5) {
      return {ok: false, reason: 'REPAIR_BUDGET_EXCEEDED'};
    }
    if (o.routineHumanInterventions !== 0) {
      return {ok: false, reason: 'ROUTINE_HUMAN_INTERVENTION_DETECTED'};
    }
    if (!o.checksPassed || !o.securityClear || !o.independentReview ||
        o.unresolvedFindings !== 0 || !o.mainHealthyAfterMerge || !o.rollbackReady ||
        o.duplicateDispatches !== 0 || o.unauthorizedWrites !== 0) {
      return {ok: false, reason: 'QUALITY_OR_SAFETY_GATE_FAILED'};
    }
    if (!meetsCoverageFloor(
      o.coveredLines, o.totalLines, o.coveredBranches, o.totalBranches,
      policy.minLinePercent, policy.minBranchPercent
    )) {
      return {ok: false, reason: 'COVERAGE_BELOW_POLICY'};
    }

    seenIssues.add(o.issue);
    seenPrs.add(o.pr);
    seenSquash.add(o.squashMergeSha);
    if (!o.issueAccepted || !o.allRequiredPrsMerged) {
      partialOutcomeCount += 1;
      continue;
    }

    acceptedCount += 1;
    acceptedIssueNumbers.push(o.issue);
    if (o.parallelBatchGroup !== null && o.m01CohortMember) {
      let windows = parallelGroups.get(o.parallelBatchGroup);
      if (!windows) {
        windows = [];
        parallelGroups.set(o.parallelBatchGroup, windows);
      }
      windows.push({assignedAtMs: o.assignedAtMs, mergedAtMs: o.mergedAtMs});
    }
    if (o.m01CohortMember) {
      m01MemberCount += 1;
      if (o.reviewRepairVerified) m01ReviewRepairCount += 1;
    }
    totalReworkIterations += o.reworkIterations;
    leadDurations.push(o.mergedAtMs - o.assignedAtMs);
    mqDurations.push(o.mergeQueueDurationMs);
    earliestAssignedMs = Math.min(earliestAssignedMs, o.assignedAtMs);
    latestMergedMs = Math.max(latestMergedMs, o.mergedAtMs);
    coveredLines += o.coveredLines;
    totalLines += o.totalLines;
    coveredBranches += o.coveredBranches;
    totalBranches += o.totalBranches;
  }

  const windowMs = acceptedCount > 0 ? latestMergedMs - earliestAssignedMs : null;
  const sortedLead = [...leadDurations].sort((a, b) => a - b);
  const sortedMq = [...mqDurations].sort((a, b) => a - b);
  const m01AnchorSatisfied = m01MemberCount >= SHARED_M01_ANCHOR_TARGET_OUTCOMES;
  const parallelBatchVerified = [...parallelGroups.values()].some(windows =>
    hasConcurrentExecutionWindowPair(windows)
  );
  const reviewRepairLoopVerified = m01ReviewRepairCount >= 1;
  const reworkRateBps = acceptedCount > 0
    ? Math.round((totalReworkIterations * 10000) / acceptedCount)
    : null;

  return {
    ok: true,
    acceptedCount,
    acceptedIssueNumbers,
    reworkRateBps,
    m01AnchorSatisfied,
    parallelBatchVerified,
    reviewRepairLoopVerified,
    summary: Object.freeze({
      provenanceKind: 'unattended-copilot-issue-outcome',
      agentActor: UNATTENDED_COPILOT_ACTOR,
      acceptedCount,
      partialOutcomeCount,
      remainingRequiredCount: Math.max(0, SHARED_M02_COHORT_TARGET_OUTCOMES - acceptedCount),
      m01MemberCount,
      m01AnchorSatisfied,
      parallelBatchVerified,
      reviewRepairLoopVerified,
      windowMs,
      acceptedPerDay: acceptedCount > 0 ? (acceptedCount * DAY_MS) / windowMs : null,
      p50LeadTimeMs: percentile(sortedLead, 0.5),
      p95LeadTimeMs: percentile(sortedLead, 0.95),
      p50MergeQueueMs: percentile(sortedMq, 0.5),
      p95MergeQueueMs: percentile(sortedMq, 0.95),
      totalReworkIterations,
      reworkRateBps,
      routineHumanInterventions: 0,
      incrementalSpendMicros: 0,
      coverage: acceptedCount > 0
        ? Object.freeze({coveredLines, totalLines, coveredBranches, totalBranches})
        : null
    })
  };
}

function parseSharedCohortMeasurements(m, input, acceptedIssueNumbers, actualReworkRateBps) {
  if (m === null) {
    return {ok: true, verified: false, summary: null};
  }
  if (!exactRecord(m, SHARED_COHORT_MEASUREMENT_KEYS) ||
      !positiveInt(m.repositoryId) || !isRepoSlug(m.repository) || !hex40(m.headSha) ||
      !denseDataArray(m.evaluatedIssueNumbers, 50) || m.evaluatedIssueNumbers.length === 0 ||
      !m.evaluatedIssueNumbers.every(n => positiveInt(n, 1000000)) ||
      new Set(m.evaluatedIssueNumbers).size !== m.evaluatedIssueNumbers.length ||
      !positiveInt(m.baselineExplorationStepsP50, 1000000) ||
      !positiveInt(m.candidateExplorationStepsP50, 1000000) ||
      !positiveInt(m.baselineContextBytesLoadedP50, 1000000000) ||
      !positiveInt(m.candidateContextBytesLoadedP50, 1000000000) ||
      !nonnegInt(m.baselineReworkRateBps, 100000) ||
      !nonnegInt(m.candidateReworkRateBps, 100000) ||
      typeof m.scorecardReadoutVerified !== 'boolean' ||
      typeof m.kaizenVerificationPassed !== 'boolean' ||
      (m.incrementalSpendMicros !== null && !nonnegInt(m.incrementalSpendMicros, 1000000000))) {
    return {ok: false, reason: 'MEASUREMENT_SCHEMA_INVALID'};
  }
  const acceptedSet = new Set(acceptedIssueNumbers);
  const sameIssueSet = m.evaluatedIssueNumbers.length === acceptedIssueNumbers.length &&
    m.evaluatedIssueNumbers.every(n => acceptedSet.has(n));
  if (m.repositoryId !== input.repositoryId ||
      m.repository !== input.repository ||
      m.headSha !== input.headSha ||
      acceptedIssueNumbers.length < SHARED_M02_COHORT_TARGET_OUTCOMES ||
      !sameIssueSet ||
      m.candidateReworkRateBps !== actualReworkRateBps) {
    return {ok: false, reason: 'MEASUREMENT_COHORT_MISMATCH'};
  }
  if (m.incrementalSpendMicros !== 0) {
    return {ok: false, reason: 'SPEND_UNKNOWN_OR_EXCEEDED'};
  }
  const regressed = m.candidateExplorationStepsP50 > m.baselineExplorationStepsP50 ||
    m.candidateContextBytesLoadedP50 > m.baselineContextBytesLoadedP50 ||
    m.candidateReworkRateBps > m.baselineReworkRateBps;
  const improved = m.candidateExplorationStepsP50 < m.baselineExplorationStepsP50 ||
    m.candidateContextBytesLoadedP50 < m.baselineContextBytesLoadedP50 ||
    m.candidateReworkRateBps < m.baselineReworkRateBps;
  if (regressed || !improved) {
    return {ok: false, reason: 'EXPLORATION_OR_REWORK_REGRESSION'};
  }
  if (!m.scorecardReadoutVerified || !m.kaizenVerificationPassed) {
    return {ok: false, reason: 'SHARED_COHORT_GATE_UNVERIFIED'};
  }
  return {
    ok: true,
    verified: true,
    summary: Object.freeze({
      evaluatedIssueNumbers: Object.freeze([...m.evaluatedIssueNumbers].sort((a, b) => a - b)),
      baselineExplorationStepsP50: m.baselineExplorationStepsP50,
      candidateExplorationStepsP50: m.candidateExplorationStepsP50,
      baselineContextBytesLoadedP50: m.baselineContextBytesLoadedP50,
      candidateContextBytesLoadedP50: m.candidateContextBytesLoadedP50,
      baselineReworkRateBps: m.baselineReworkRateBps,
      candidateReworkRateBps: m.candidateReworkRateBps,
      scorecardReadoutVerified: true,
      kaizenVerificationPassed: true,
      incrementalSpendMicros: 0
    })
  };
}

export function evaluateSharedFiveOutcomeM02Cohort(input) {
  if (!exactRecord(input, SHARED_COHORT_INPUT_KEYS) ||
      typeof input.stop !== 'boolean' ||
      !positiveInt(input.repositoryId) || !isRepoSlug(input.repository) ||
      !hex40(input.headSha) ||
      !exactRecord(input.policy, COHORT_POLICY_KEYS) ||
      !nonnegInt(input.policy.minLinePercent, 100) ||
      !nonnegInt(input.policy.minBranchPercent, 100) ||
      typeof input.billingHardStopVerified !== 'boolean' ||
      (input.incrementalSpendMicros !== null && !nonnegInt(input.incrementalSpendMicros, 1000000000)) ||
      !denseDataArray(input.engineeringWaves, 16) || input.engineeringWaves.length === 0 ||
      !denseDataArray(input.unattendedOutcomes, 50)) {
    return sharedCohortDenied('INPUT_UNKNOWN');
  }
  if (input.stop !== false) return sharedCohortDenied('STOPPED');

  const lowerRepo = input.repository.toLowerCase();
  const isFactoryId = input.repositoryId === SOFTWARE_FACTORY_REPOSITORY_ID;
  const isFactorySlug = lowerRepo === SOFTWARE_FACTORY_REPOSITORY.toLowerCase();
  if (isFactoryId !== isFactorySlug || (isFactoryId && input.repository !== SOFTWARE_FACTORY_REPOSITORY)) {
    return sharedCohortDenied('REPOSITORY_IDENTITY_MISMATCH');
  }
  const isSpellbook = isSpellbookSlug(input.repository);
  const lineFloor = isFactoryId ? 98 : (isSpellbook ? 97 : 95);
  const branchFloor = isFactoryId ? 95 : 90;
  if (input.policy.minLinePercent < lineFloor || input.policy.minBranchPercent < branchFloor) {
    return sharedCohortDenied('POLICY_BELOW_MINIMUM');
  }
  if (!input.billingHardStopVerified || input.incrementalSpendMicros !== 0) {
    return sharedCohortDenied('SPEND_UNKNOWN_OR_EXCEEDED');
  }

  const portfolioEval = allocatePortfolioCapacityAndSimulateTrains(input.portfolioInput);
  if (!portfolioEval.valid) return sharedCohortDenied(portfolioEval.reason);
  const targetRepo = portfolioEval.repositoryResults.find(r => r.repositoryId === input.repositoryId);
  if (!targetRepo || targetRepo.killSwitch || !targetRepo.train.mainHealthyAfter ||
      targetRepo.train.isolatedCandidates.length > 0) {
    return sharedCohortDenied('INTEGRATION_TRAIN_UNHEALTHY');
  }
  if (targetRepo.repository !== input.repository) {
    return sharedCohortDenied('REPOSITORY_IDENTITY_MISMATCH');
  }
  if (targetRepo.train.finalMainSha !== input.headSha) {
    return sharedCohortDenied('HEAD_SHA_MISMATCH');
  }
  const enrolledRepo = input.portfolioInput.repositories.find(r => r.repositoryId === input.repositoryId);
  if (input.policy.minLinePercent < enrolledRepo.minLinePercent ||
      input.policy.minBranchPercent < enrolledRepo.minBranchPercent) {
    return sharedCohortDenied('POLICY_BELOW_MINIMUM');
  }

  const benchmarkEval = evaluateDotnetConsolidationBenchmark(input.benchmarkInput);
  if (!benchmarkEval.valid) return sharedCohortDenied(benchmarkEval.reason);
  if (benchmarkEval.workload !== input.headSha) return sharedCohortDenied('HEAD_SHA_MISMATCH');
  if (benchmarkEval.dotnetMafCandidate === null) return sharedCohortDenied('MAF_CANDIDATE_REQUIRED');
  if (benchmarkEval.reason === 'MAF_ARCHITECTURE_OR_SAFETY_UNVERIFIED') {
    return sharedCohortDenied(benchmarkEval.reason);
  }
  if (!meetsCoverageFloor(
    benchmarkEval.dotnetMafCandidate.coveredLines,
    benchmarkEval.dotnetMafCandidate.totalLines,
    benchmarkEval.dotnetMafCandidate.coveredBranches,
    benchmarkEval.dotnetMafCandidate.totalBranches,
    98,
    95
  )) {
    return sharedCohortDenied('MAF_COVERAGE_BELOW_POLICY');
  }
  const rawCand = input.benchmarkInput.dotnetMafCandidate;
  if (!rawCand.securityReviewed || !rawCand.independentReview || !rawCand.rollbackReady) {
    return sharedCohortDenied('REVIEW_OR_ROLLBACK_UNREADY');
  }

  const wavesParsed = parseEngineeringWaves(input.engineeringWaves);
  if (!wavesParsed.ok) return sharedCohortDenied(wavesParsed.reason);
  const expectedWavesEndSha = input.unattendedOutcomes.length === 0
    ? input.headSha
    : targetRepo.train.initialMainSha;
  if (wavesParsed.finalMainSha !== expectedWavesEndSha) {
    return sharedCohortDenied('HEAD_SHA_MISMATCH');
  }

  const mergedTrainCandidateByPr = new Map(
    enrolledRepo.train.candidates.map(c => [c.pr, c])
  );

  const outcomesParsed = parseUnattendedOutcomes(
    input.unattendedOutcomes,
    wavesParsed.wavePrNumbers,
    input.policy,
    input.repositoryId,
    input.repository,
    mergedTrainCandidateByPr
  );
  if (!outcomesParsed.ok) return sharedCohortDenied(outcomesParsed.reason);

  const measurementsParsed = parseSharedCohortMeasurements(
    input.sharedCohortMeasurements,
    input,
    outcomesParsed.acceptedIssueNumbers,
    outcomesParsed.reworkRateBps
  );
  if (!measurementsParsed.ok) return sharedCohortDenied(measurementsParsed.reason);

  let cohortComplete = false;
  let m02ExitReady = false;
  let status = 'PENDING_UNATTENDED_COPILOT_COHORT';
  let reason = 'PENDING_M01_10_AND_SHARED_5_ISSUE_COHORT';
  if (outcomesParsed.acceptedCount >= SHARED_M02_COHORT_TARGET_OUTCOMES) {
    if (outcomesParsed.m01AnchorSatisfied &&
        outcomesParsed.parallelBatchVerified &&
        outcomesParsed.reviewRepairLoopVerified) {
      cohortComplete = true;
      if (measurementsParsed.verified) {
        m02ExitReady = true;
        status = 'SHARED_5_OUTCOME_COHORT_VERIFIED';
        reason = 'SHARED_M02_COHORT_ELIGIBLE';
      } else {
        status = 'PENDING_SHARED_COHORT_MEASUREMENTS';
        reason = 'SHARED_COHORT_MEASUREMENTS_REQUIRED';
      }
    } else {
      status = 'INCOMPLETE_COHORT_COMPOSITION';
      reason = 'COHORT_COMPOSITION_REQUIREMENTS_UNMET';
    }
  }

  return Object.freeze({
    valid: true,
    shadow: true,
    liveDispatch: false,
    liveMerge: false,
    repositoryId: input.repositoryId,
    repository: input.repository,
    headSha: input.headSha,
    multiCohortLadderRetired: true,
    sharedCohortTargetOutcomes: SHARED_M02_COHORT_TARGET_OUTCOMES,
    m01AnchorTargetOutcomes: SHARED_M01_ANCHOR_TARGET_OUTCOMES,
    sharedIssues: SHARED_M02_EXIT_ISSUES,
    m01AnchorIssue: M01_EXIT_ANCHOR_ISSUE,
    provenanceSeparated: true,
    runtimePosture: benchmarkEval.consolidationEligible
      ? 'dotnet-10-single-runtime-consolidation-eligible'
      : 'dual-runtime-retain-node-authoritative',
    consolidationRecommendation: benchmarkEval.recommendation,
    consolidationReason: benchmarkEval.reason,
    cohortComplete,
    measurementsVerified: measurementsParsed.verified,
    m02ExitReady,
    keepIssue16Open: !m02ExitReady,
    status,
    reason,
    engineeringWaveSummary: wavesParsed.summary,
    unattendedCohortSummary: outcomesParsed.summary,
    sharedCohortMeasurements: measurementsParsed.summary
  });
}

const STREAMLINED_READOUT_INPUT_KEYS = [
  'stop', 'repositoryId', 'repository', 'headSha', 'policy',
  'billingHardStopVerified', 'incrementalSpendMicros',
  'futureGhAwCronDisclosure', 'exactHeadCoverage',
  'portfolioTrainInputs', 'benchmarkInput',
  'engineeringWaves', 'acceptedIssueOutcomes'
];
const FUTURE_GHAW_DISCLOSURE_KEYS = [
  'provenanceKind', 'status', 'completedCronOutcomes', 'conflatedWithCoordinatorWaves'
];
const EXACT_HEAD_COVERAGE_KEYS = [
  'headSha', 'coveredLines', 'totalLines', 'coveredBranches', 'totalBranches'
];
const STREAMLINED_ISSUE_OUTCOME_KEYS = [
  'repositoryId', 'repository', 'issue', 'milestone',
  'waveId', 'acceptingPr', 'supportingWavePrs',
  'provenanceKind', 'copilotCoAuthored',
  'issueClosedOnGitHub', 'allAcceptanceCriteriaDelivered',
  'expectedBaseSha', 'parentMainSha', 'headSha', 'squashMergeSha',
  'prCreatedAtMs', 'addedToMergeQueueAtMs', 'mergedAtMs', 'issueClosedAtMs',
  'mergeQueueDurationMs', 'ownedPaths',
  'checksPassed', 'securityClear', 'independentReview',
  'reviewThreadsTotal', 'unresolvedFindings',
  'mainHealthyAfterMerge', 'rollbackReady',
  'reworkCommits', 'branchSyncMergeCommits',
  'duplicateDispatches', 'unauthorizedWrites',
  'incrementalSpendMicros'
];

function streamlinedCohortDenied(reason) {
  return Object.freeze({
    valid: false,
    shadow: true,
    liveDispatch: false,
    liveMerge: false,
    multiCohortLadderRetired: true,
    streamlinedM02MinAcceptedIssues: STREAMLINED_M02_MIN_ACCEPTED_ISSUES,
    streamlinedM02CohortVerified: false,
    provenanceSeparated: false,
    issue16ExitReady: false,
    keepIssue16Open: true,
    status: 'BLOCKED',
    reason
  });
}

function validStreamlinedOutcomeShape(o) {
  if (!exactRecord(o, STREAMLINED_ISSUE_OUTCOME_KEYS) ||
      !positiveInt(o.repositoryId) || !isRepoSlug(o.repository) ||
      !positiveInt(o.issue, 1000000) || !token(o.milestone) || !cohortSlug(o.waveId) ||
      !positiveInt(o.acceptingPr, 1000000) ||
      !denseDataArray(o.supportingWavePrs, 16) ||
      !o.supportingWavePrs.every(pr => positiveInt(pr, 1000000) && pr !== o.acceptingPr) ||
      new Set(o.supportingWavePrs).size !== o.supportingWavePrs.length ||
      typeof o.provenanceKind !== 'string' || typeof o.copilotCoAuthored !== 'boolean' ||
      typeof o.issueClosedOnGitHub !== 'boolean' ||
      typeof o.allAcceptanceCriteriaDelivered !== 'boolean' ||
      !hex40(o.expectedBaseSha) || !hex40(o.parentMainSha) ||
      !hex40(o.headSha) || !hex40(o.squashMergeSha) ||
      o.headSha === o.squashMergeSha || o.parentMainSha === o.squashMergeSha ||
      !positiveInt(o.prCreatedAtMs) || !positiveInt(o.addedToMergeQueueAtMs) ||
      !positiveInt(o.mergedAtMs) ||
      o.prCreatedAtMs >= o.addedToMergeQueueAtMs || o.addedToMergeQueueAtMs >= o.mergedAtMs ||
      !positiveInt(o.mergeQueueDurationMs, DAY_MS) ||
      o.mergeQueueDurationMs !== o.mergedAtMs - o.addedToMergeQueueAtMs ||
      !validUniquePathList(o.ownedPaths) || hasInternalPathOverlap(o.ownedPaths) ||
      ![o.checksPassed, o.securityClear, o.independentReview,
        o.mainHealthyAfterMerge, o.rollbackReady].every(b => typeof b === 'boolean') ||
      !nonnegInt(o.reviewThreadsTotal, 10000) || !nonnegInt(o.unresolvedFindings, 10000) ||
      !nonnegInt(o.reworkCommits, 100) || !nonnegInt(o.branchSyncMergeCommits, 100) ||
      !nonnegInt(o.duplicateDispatches, 1000) || !nonnegInt(o.unauthorizedWrites, 1000) ||
      (o.incrementalSpendMicros !== null && !nonnegInt(o.incrementalSpendMicros, 1000000000))) {
    return false;
  }
  if (o.issueClosedOnGitHub) {
    return positiveInt(o.issueClosedAtMs) && o.mergedAtMs <= o.issueClosedAtMs;
  }
  return o.issueClosedAtMs === null;
}

function parseStreamlinedOutcomes(
  outcomes,
  expectedRepoId,
  expectedRepo,
  waveByPr,
  mergedTrainCandidateByPr
) {
  const seenIssues = new Set();
  const seenAcceptingPrs = new Set();
  const seenSquashShas = new Set();
  const acceptedIssueNumbers = [];
  const acceptedWindows = [];
  const leadDurations = [];
  const mqDurations = [];
  const reworkCounts = [];
  let acceptedIssueCount = 0;
  let partialOutcomeCount = 0;
  let reviewRepairOutcomeCount = 0;
  let totalReworkCommits = 0;
  let totalBranchSyncMergeCommits = 0;
  let totalReviewThreadsResolved = 0;
  let earliestCreatedMs = Infinity;
  let latestMergedMs = 0;

  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    if (!validStreamlinedOutcomeShape(o) ||
        seenIssues.has(o.issue) || seenAcceptingPrs.has(o.acceptingPr) ||
        seenSquashShas.has(o.squashMergeSha)) {
      return {ok: false, reason: 'OUTCOME_SCHEMA_INVALID'};
    }
    if (o.repositoryId !== expectedRepoId || o.repository !== expectedRepo) {
      return {ok: false, reason: 'CROSS_REPO_OUTCOME_MISMATCH'};
    }
    if (o.provenanceKind !== COORDINATOR_DISPATCHED_WAVE_PROVENANCE) {
      return {ok: false, reason: 'PROVENANCE_CONFLATION_REJECTED'};
    }
    if (!o.copilotCoAuthored) {
      return {ok: false, reason: 'COPILOT_CO_AUTHOR_REQUIRED'};
    }
    const wave = waveByPr.get(o.acceptingPr);
    const mergedEntry = mergedTrainCandidateByPr.get(o.acceptingPr);
    if (!wave || wave.waveId !== o.waveId ||
        !o.supportingWavePrs.every(pr => waveByPr.has(pr)) ||
        !mergedEntry ||
        mergedEntry.candidate.head !== o.headSha ||
        mergedEntry.candidate.expectedBase !== o.expectedBaseSha ||
        mergedEntry.parentMainSha !== o.parentMainSha ||
        mergedEntry.candidate.simulatedSquashSha !== o.squashMergeSha ||
        mergedEntry.candidate.eligibleToMergeMs !== o.mergeQueueDurationMs ||
        !samePathSet(o.ownedPaths, mergedEntry.candidate.ownedPaths)) {
      return {ok: false, reason: 'UNVERIFIED_MAIN_ANCESTRY'};
    }
    if (o.incrementalSpendMicros !== 0) {
      return {ok: false, reason: 'SPEND_UNKNOWN_OR_EXCEEDED'};
    }
    if (!o.checksPassed || !o.securityClear || !o.independentReview ||
        o.unresolvedFindings !== 0 || !o.mainHealthyAfterMerge || !o.rollbackReady ||
        o.duplicateDispatches !== 0 || o.unauthorizedWrites !== 0) {
      return {ok: false, reason: 'QUALITY_OR_SAFETY_GATE_FAILED'};
    }

    seenIssues.add(o.issue);
    seenAcceptingPrs.add(o.acceptingPr);
    seenSquashShas.add(o.squashMergeSha);
    if (!o.issueClosedOnGitHub || !o.allAcceptanceCriteriaDelivered) {
      partialOutcomeCount += 1;
      continue;
    }

    acceptedIssueCount += 1;
    acceptedIssueNumbers.push(o.issue);
    acceptedWindows.push({assignedAtMs: o.prCreatedAtMs, mergedAtMs: o.mergedAtMs});
    leadDurations.push(o.mergedAtMs - o.prCreatedAtMs);
    mqDurations.push(o.mergeQueueDurationMs);
    reworkCounts.push(o.reworkCommits);
    if (o.reworkCommits >= 1 && o.reviewThreadsTotal >= 1) {
      reviewRepairOutcomeCount += 1;
    }
    totalReworkCommits += o.reworkCommits;
    totalBranchSyncMergeCommits += o.branchSyncMergeCommits;
    totalReviewThreadsResolved += o.reviewThreadsTotal;
    earliestCreatedMs = Math.min(earliestCreatedMs, o.prCreatedAtMs);
    latestMergedMs = Math.max(latestMergedMs, o.mergedAtMs);
  }

  const windowMs = acceptedIssueCount > 0 ? latestMergedMs - earliestCreatedMs : null;
  const sortedLead = [...leadDurations].sort((a, b) => a - b);
  const sortedMq = [...mqDurations].sort((a, b) => a - b);
  const sortedRework = [...reworkCounts].sort((a, b) => a - b);
  const parallelTrainVerified = hasConcurrentExecutionWindowPair(acceptedWindows);
  const reviewRepairVerified = reviewRepairOutcomeCount >= 1;
  const reworkRateBps = acceptedIssueCount > 0
    ? Math.round((totalReworkCommits * 10000) / acceptedIssueCount)
    : null;

  return {
    ok: true,
    acceptedIssueCount,
    parallelTrainVerified,
    reviewRepairVerified,
    summary: Object.freeze({
      provenanceKind: COORDINATOR_DISPATCHED_WAVE_PROVENANCE,
      acceptedIssueCount,
      partialOutcomeCount,
      remainingRequiredCount: Math.max(0, STREAMLINED_M02_MIN_ACCEPTED_ISSUES - acceptedIssueCount),
      acceptedIssueNumbers: Object.freeze([...acceptedIssueNumbers].sort((a, b) => a - b)),
      parallelTrainVerified,
      reviewRepairVerified,
      reviewRepairOutcomeCount,
      windowMs,
      acceptedPerDay: acceptedIssueCount > 0 ? (acceptedIssueCount * DAY_MS) / windowMs : null,
      p50LeadTimeMs: percentile(sortedLead, 0.5),
      p95LeadTimeMs: percentile(sortedLead, 0.95),
      p50MergeQueueMs: percentile(sortedMq, 0.5),
      p95MergeQueueMs: percentile(sortedMq, 0.95),
      totalReworkCommits,
      p50ReworkCommits: percentile(sortedRework, 0.5),
      p95ReworkCommits: percentile(sortedRework, 0.95),
      reworkRateBps,
      totalBranchSyncMergeCommits,
      totalReviewThreadsResolved,
      unresolvedFindings: 0,
      acceptedTrainMainBreakages: 0,
      incrementalSpendMicros: 0
    })
  };
}

export function evaluateStreamlinedM02CohortReadout(input) {
  if (!exactRecord(input, STREAMLINED_READOUT_INPUT_KEYS) ||
      typeof input.stop !== 'boolean' ||
      !positiveInt(input.repositoryId) || !isRepoSlug(input.repository) ||
      !hex40(input.headSha) ||
      !exactRecord(input.policy, COHORT_POLICY_KEYS) ||
      !nonnegInt(input.policy.minLinePercent, 100) ||
      !nonnegInt(input.policy.minBranchPercent, 100) ||
      typeof input.billingHardStopVerified !== 'boolean' ||
      (input.incrementalSpendMicros !== null && !nonnegInt(input.incrementalSpendMicros, 1000000000)) ||
      !exactRecord(input.futureGhAwCronDisclosure, FUTURE_GHAW_DISCLOSURE_KEYS) ||
      typeof input.futureGhAwCronDisclosure.provenanceKind !== 'string' ||
      typeof input.futureGhAwCronDisclosure.status !== 'string' ||
      !nonnegInt(input.futureGhAwCronDisclosure.completedCronOutcomes, 100000) ||
      typeof input.futureGhAwCronDisclosure.conflatedWithCoordinatorWaves !== 'boolean' ||
      !exactRecord(input.exactHeadCoverage, EXACT_HEAD_COVERAGE_KEYS) ||
      !hex40(input.exactHeadCoverage.headSha) ||
      !validCoverageCounts(input.exactHeadCoverage.coveredLines, input.exactHeadCoverage.totalLines) ||
      !validCoverageCounts(input.exactHeadCoverage.coveredBranches, input.exactHeadCoverage.totalBranches) ||
      !denseDataArray(input.portfolioTrainInputs, 16) || input.portfolioTrainInputs.length === 0 ||
      !denseDataArray(input.engineeringWaves, 16) || input.engineeringWaves.length === 0 ||
      !denseDataArray(input.acceptedIssueOutcomes, 100)) {
    return streamlinedCohortDenied('INPUT_UNKNOWN');
  }
  if (input.stop !== false) return streamlinedCohortDenied('STOPPED');

  const lowerRepo = input.repository.toLowerCase();
  const isFactoryId = input.repositoryId === SOFTWARE_FACTORY_REPOSITORY_ID;
  const isFactorySlug = lowerRepo === SOFTWARE_FACTORY_REPOSITORY.toLowerCase();
  if (isFactoryId !== isFactorySlug || (isFactoryId && input.repository !== SOFTWARE_FACTORY_REPOSITORY)) {
    return streamlinedCohortDenied('REPOSITORY_IDENTITY_MISMATCH');
  }
  const isSpellbook = isSpellbookSlug(input.repository);
  const lineFloor = isFactoryId ? 98 : (isSpellbook ? 97 : 95);
  const branchFloor = isFactoryId ? 95 : 90;
  if (input.policy.minLinePercent < lineFloor || input.policy.minBranchPercent < branchFloor) {
    return streamlinedCohortDenied('POLICY_BELOW_MINIMUM');
  }
  if (!input.billingHardStopVerified || input.incrementalSpendMicros !== 0) {
    return streamlinedCohortDenied('SPEND_UNKNOWN_OR_EXCEEDED');
  }

  const ghAw = input.futureGhAwCronDisclosure;
  if (ghAw.provenanceKind !== FUTURE_GH_AW_CRON_PROVENANCE ||
      ghAw.conflatedWithCoordinatorWaves !== false) {
    return streamlinedCohortDenied('PROVENANCE_CONFLATION_REJECTED');
  }
  if (ghAw.status !== 'DEFERRED_PENDING_GHAW_CRON_ENABLEMENT' || ghAw.completedCronOutcomes !== 0) {
    return streamlinedCohortDenied('GHAW_CRON_DISCLOSURE_INVALID');
  }

  const headCov = input.exactHeadCoverage;
  if (headCov.headSha !== input.headSha) {
    return streamlinedCohortDenied('HEAD_SHA_MISMATCH');
  }
  if (!meetsCoverageFloor(
    headCov.coveredLines, headCov.totalLines,
    headCov.coveredBranches, headCov.totalBranches,
    input.policy.minLinePercent, input.policy.minBranchPercent
  )) {
    return streamlinedCohortDenied('COVERAGE_BELOW_POLICY');
  }

  const mergedTrainCandidateByPr = new Map();
  const orderedMergedTrainCands = [];
  let firstTrainInitialSha = null;
  let prevTrainFinalSha = null;
  for (let i = 0; i < input.portfolioTrainInputs.length; i++) {
    const ptInput = input.portfolioTrainInputs[i];
    const ptEval = allocatePortfolioCapacityAndSimulateTrains(ptInput);
    if (!ptEval.valid) return streamlinedCohortDenied(ptEval.reason);
    const targetRepo = ptEval.repositoryResults.find(r => r.repositoryId === input.repositoryId);
    if (!targetRepo || targetRepo.killSwitch || !targetRepo.train.mainHealthyAfter ||
        targetRepo.train.isolatedCandidates.length > 0 ||
        targetRepo.train.mergedPrs.length === 0) {
      return streamlinedCohortDenied('INTEGRATION_TRAIN_UNHEALTHY');
    }
    if (targetRepo.repository !== input.repository) {
      return streamlinedCohortDenied('REPOSITORY_IDENTITY_MISMATCH');
    }
    const enrolledRepo = ptInput.repositories.find(r => r.repositoryId === input.repositoryId);
    if (input.policy.minLinePercent < enrolledRepo.minLinePercent ||
        input.policy.minBranchPercent < enrolledRepo.minBranchPercent) {
      return streamlinedCohortDenied('POLICY_BELOW_MINIMUM');
    }
    if (i === 0) {
      firstTrainInitialSha = targetRepo.train.initialMainSha;
    } else if (targetRepo.train.initialMainSha !== prevTrainFinalSha) {
      return streamlinedCohortDenied('WAVE_CHAIN_DISCONTINUITY');
    }
    prevTrainFinalSha = targetRepo.train.finalMainSha;

    const cands = enrolledRepo.train.candidates;
    for (let j = 0; j < cands.length; j++) {
      const cand = cands[j];
      if (mergedTrainCandidateByPr.has(cand.pr)) {
        return streamlinedCohortDenied('DUPLICATE_TRAIN_CANDIDATE');
      }
      const parentMainSha = j === 0 ? enrolledRepo.train.mainSha : cands[j - 1].simulatedSquashSha;
      mergedTrainCandidateByPr.set(cand.pr, {candidate: cand, parentMainSha});
      orderedMergedTrainCands.push(cand);
    }
  }
  if (prevTrainFinalSha !== input.headSha) {
    return streamlinedCohortDenied('HEAD_SHA_MISMATCH');
  }

  const benchmarkEval = evaluateDotnetConsolidationBenchmark(input.benchmarkInput);
  if (!benchmarkEval.valid) return streamlinedCohortDenied(benchmarkEval.reason);
  if (benchmarkEval.workload !== input.headSha) return streamlinedCohortDenied('HEAD_SHA_MISMATCH');
  if (benchmarkEval.dotnetMafCandidate === null) return streamlinedCohortDenied('MAF_CANDIDATE_REQUIRED');
  if (benchmarkEval.reason === 'MAF_ARCHITECTURE_OR_SAFETY_UNVERIFIED') {
    return streamlinedCohortDenied(benchmarkEval.reason);
  }
  if (!meetsCoverageFloor(
    benchmarkEval.dotnetMafCandidate.coveredLines,
    benchmarkEval.dotnetMafCandidate.totalLines,
    benchmarkEval.dotnetMafCandidate.coveredBranches,
    benchmarkEval.dotnetMafCandidate.totalBranches,
    98,
    95
  )) {
    return streamlinedCohortDenied('MAF_COVERAGE_BELOW_POLICY');
  }
  const rawCand = input.benchmarkInput.dotnetMafCandidate;
  if (!rawCand.securityReviewed || !rawCand.independentReview || !rawCand.rollbackReady) {
    return streamlinedCohortDenied('REVIEW_OR_ROLLBACK_UNREADY');
  }
  const rawNode = input.benchmarkInput.nodeBaseline;
  if (isFactoryId && (
    headCov.coveredLines !== rawNode.coveredLines ||
    headCov.totalLines !== rawNode.totalLines ||
    headCov.coveredBranches !== rawNode.coveredBranches ||
    headCov.totalBranches !== rawNode.totalBranches
  )) {
    return streamlinedCohortDenied('HEAD_COVERAGE_MISMATCH');
  }

  const wavesParsed = parseEngineeringWaves(input.engineeringWaves);
  if (!wavesParsed.ok) return streamlinedCohortDenied(wavesParsed.reason);
  if (wavesParsed.finalMainSha !== input.headSha) {
    return streamlinedCohortDenied('HEAD_SHA_MISMATCH');
  }
  const startWaveIdx = input.engineeringWaves.findIndex(w => w.initialMainSha === firstTrainInitialSha);
  if (startWaveIdx === -1) {
    return streamlinedCohortDenied('WAVE_CHAIN_DISCONTINUITY');
  }
  let candCursor = 0;
  for (let wIdx = startWaveIdx; wIdx < input.engineeringWaves.length; wIdx++) {
    const wave = input.engineeringWaves[wIdx];
    if (wave.postMergeMainFailures !== 0) {
      return streamlinedCohortDenied('ACCEPTED_WAVE_MAIN_FAILURE_DETECTED');
    }
    for (let pIdx = 0; pIdx < wave.prNumbers.length; pIdx++) {
      const cand = orderedMergedTrainCands[candCursor];
      if (!cand ||
          cand.pr !== wave.prNumbers[pIdx] ||
          cand.eligibleToMergeMs !== wave.mergeQueueDurationsMs[pIdx]) {
        return streamlinedCohortDenied('WAVE_TRAIN_PARITY_MISMATCH');
      }
      candCursor += 1;
    }
    if (orderedMergedTrainCands[candCursor - 1].simulatedSquashSha !== wave.finalMainSha) {
      return streamlinedCohortDenied('WAVE_TRAIN_PARITY_MISMATCH');
    }
  }
  if (candCursor !== orderedMergedTrainCands.length) {
    return streamlinedCohortDenied('WAVE_TRAIN_PARITY_MISMATCH');
  }

  const outcomesParsed = parseStreamlinedOutcomes(
    input.acceptedIssueOutcomes,
    input.repositoryId,
    input.repository,
    wavesParsed.waveByPr,
    mergedTrainCandidateByPr
  );
  if (!outcomesParsed.ok) return streamlinedCohortDenied(outcomesParsed.reason);

  let streamlinedM02CohortVerified = false;
  let status = 'PENDING_STREAMLINED_M02_COHORT';
  let reason = 'INSUFFICIENT_ACCEPTED_OUTCOMES';
  if (outcomesParsed.acceptedIssueCount >= STREAMLINED_M02_MIN_ACCEPTED_ISSUES) {
    if (outcomesParsed.parallelTrainVerified && outcomesParsed.reviewRepairVerified) {
      streamlinedM02CohortVerified = true;
      status = 'STREAMLINED_M02_COHORT_VERIFIED';
      reason = 'STREAMLINED_M02_EXIT_ELIGIBLE';
    } else {
      status = 'INCOMPLETE_COHORT_COMPOSITION';
      reason = 'COHORT_COMPOSITION_REQUIREMENTS_UNMET';
    }
  }

  return Object.freeze({
    valid: true,
    shadow: true,
    liveDispatch: false,
    liveMerge: false,
    repositoryId: input.repositoryId,
    repository: input.repository,
    headSha: input.headSha,
    multiCohortLadderRetired: true,
    streamlinedM02MinAcceptedIssues: STREAMLINED_M02_MIN_ACCEPTED_ISSUES,
    streamlinedM02CohortVerified,
    issue16ExitReady: streamlinedM02CohortVerified,
    keepIssue16Open: !streamlinedM02CohortVerified,
    provenanceSeparated: true,
    coordinatorWaveProvenance: COORDINATOR_DISPATCHED_WAVE_PROVENANCE,
    futureGhAwCronDisclosure: Object.freeze({
      provenanceKind: FUTURE_GH_AW_CRON_PROVENANCE,
      status: ghAw.status,
      completedCronOutcomes: 0,
      conflatedWithCoordinatorWaves: false
    }),
    runtimePosture: benchmarkEval.consolidationEligible
      ? 'dotnet-10-single-runtime-consolidation-eligible'
      : 'dual-runtime-retain-node-authoritative',
    consolidationRecommendation: benchmarkEval.recommendation,
    consolidationReason: benchmarkEval.reason,
    status,
    reason,
    exactHeadCoverage: Object.freeze({
      headSha: headCov.headSha,
      coveredLines: headCov.coveredLines,
      totalLines: headCov.totalLines,
      coveredBranches: headCov.coveredBranches,
      totalBranches: headCov.totalBranches
    }),
    engineeringWaveSummary: wavesParsed.summary,
    acceptedCohortSummary: outcomesParsed.summary
  });
}
