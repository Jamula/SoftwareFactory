import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {planChangeGraphFastFeedback} from './contract-routing.mjs';
import {deriveCiCacheKeys, verifyCiCacheEntry} from './locked-build-cache.mjs';
import {classifyValidationFailure} from './validation-diagnosis.mjs';

export const STANDARD_CI_P50_TARGET_MS = 75_000;
export const FAST_FEEDBACK_STRETCH_MS = 30_000;
export const LANE_TARGET_MS = 65_000;
export const WINDOWS_ASPIRE_RUNTIME_PROVISIONAL_TARGET_MS = 120_000;
export const MAX_AUTO_REPAIR_ATTEMPTS = 2;

export const MANDATORY_CI_CHECK_CONTEXTS = Object.freeze([
  'build-test',
  'upload-coverage-javascript',
  'windows-aspire-runtime',
  'CodeQL'
]);

export const ASPIRE_STAGE_KEYS = Object.freeze([
  'setupMs',
  'restoreBuildMs',
  'certificateExportMs',
  'appHostStartupMs',
  'syntheticWorkloadMs',
  'exportVerifyMs',
  'stopCleanupMs',
  'queueWaitMs'
]);

export const ASPIRE_FAILURE_CATEGORIES = Object.freeze([
  'tls-or-certificate',
  'authentication',
  'arguments',
  'file-access',
  'startup-timeout',
  'restore-build',
  'export-receipt',
  'unclassified'
]);

export const PINNED_CI_TOOLCHAIN = Object.freeze({
  node: '26.13.1',
  dotnet: '10.0.404',
  aspireCli: '17.0.0'
});

const ACTIVE_ASPIRE_STAGE_KEYS = ASPIRE_STAGE_KEYS.filter(key => key !== 'queueWaitMs');
const ACTIVE_ASPIRE_STAGE_SET = new Set(ACTIVE_ASPIRE_STAGE_KEYS);
const MANDATORY_CONTEXT_LANES = new Map([
  ['build-test', 'linux'],
  ['upload-coverage-javascript', 'linux'],
  ['windows-aspire-runtime', 'windows'],
  ['CodeQL', 'security']
]);
const CI_LANES = Object.freeze(['linux', 'windows', 'security']);
const ALLOWED_LANES = new Set(CI_LANES);
const FAILURE_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'action_required']);
const ALLOWED_CONCLUSIONS = new Set(['success', 'skipped', ...FAILURE_CONCLUSIONS]);
const CACHE_COHORTS = new Set(['cold', 'warm']);
const ASPIRE_PLATFORMS = new Set(['linux', 'windows']);
const ASPIRE_OUTCOMES = new Set(['succeeded', 'failed', 'cancelled', 'timed-out']);
const MAX_STAGE_DURATION_MS = 3_600_000;
const PINNED_NPM_CI_FLAGS = '--ignore-scripts';
const PINNED_APPHOST_CONFIGURATION = 'Release';

const ASPIRE_FAILURE_CODE_MAP = new Map([
  ['tls-or-certificate', 'tls-or-certificate'],
  ['cert-export-failed', 'tls-or-certificate'],
  ['untrusted-loopback-tls', 'tls-or-certificate'],
  ['authentication', 'authentication'],
  ['login-challenge-missing', 'authentication'],
  ['dashboard-401', 'authentication'],
  ['dashboard-403', 'authentication'],
  ['arguments', 'arguments'],
  ['invalid-cli-option', 'arguments'],
  ['file-access', 'file-access'],
  ['sharing-violation', 'file-access'],
  ['permission-denied', 'file-access'],
  ['startup-timeout', 'startup-timeout'],
  ['apphost-start-timeout', 'startup-timeout'],
  ['restore-build', 'restore-build'],
  ['nuget-restore-failed', 'restore-build'],
  ['apphost-build-failed', 'restore-build'],
  ['aspire-tool-install-failed', 'restore-build'],
  ['export-receipt', 'export-receipt'],
  ['dashboard-export-failed', 'export-receipt'],
  ['metric-receipt-missing', 'export-receipt'],
  ['trace-readback-failed', 'export-receipt'],
  ['unclassified', 'unclassified']
]);

const isSha40 = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const isSha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isRunId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const isContextName = value => typeof value === 'string' && value.length >= 1 && value.length <= 120;
const isNonNegInt = value => Number.isSafeInteger(value) && value >= 0;
const isBoundedStageMs = value => isNonNegInt(value) && value <= MAX_STAGE_DURATION_MS;
const isFailureCodeToken = value =>
  typeof value === 'string' && value.length <= 48 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
const sha256Hex = parts => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

function isPlainDataObject(value, requiredKeys, optionalKeys = []) {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || descriptor.value === undefined) {
      return false;
    }
  }
  return requiredKeys.every(key => Object.hasOwn(value, key));
}

function isExactArray(value, maxLength = 500) {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return false;
  }
  const length = value.length;
  if (length > maxLength || Reflect.ownKeys(value).length !== length + 1) return false;
  for (let i = 0; i < length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
  }
  return true;
}

function nearestRankPercentiles(values) {
  if (values.length === 0) return {p50Ms: null, p95Ms: null};
  const sorted = [...values].sort((a, b) => a - b);
  const pick = p => sorted[Math.ceil(p * sorted.length) - 1];
  return {p50Ms: pick(0.5), p95Ms: pick(0.95)};
}

function summarizeLane(durations) {
  const {p50Ms, p95Ms} = nearestRankPercentiles(durations);
  return {
    targetMs: LANE_TARGET_MS,
    sampleCount: durations.length,
    p50Ms,
    p95Ms,
    targetMissCount: durations.filter(ms => ms > LANE_TARGET_MS).length,
    p50MeetsTarget: p50Ms === null ? null : p50Ms <= LANE_TARGET_MS
  };
}

function createCohortAccumulator(cohort) {
  return {
    cohort,
    criticalPathMs: [],
    firstJobStartToLastCheckMs: [],
    runnerQueueWaitMs: [],
    independentReviewMs: [],
    lanes: {linux: [], windows: [], security: []},
    sloMissCount: 0,
    stretchMissCount: 0,
    failedOrCancelledCount: 0,
    incompleteOrMismatchedCount: 0,
    sameHeadRetryCount: 0
  };
}

function finalizeCohort(acc) {
  const {p50Ms, p95Ms} = nearestRankPercentiles(acc.criticalPathMs);
  const firstStartStats = nearestRankPercentiles(acc.firstJobStartToLastCheckMs);
  const queueStats = nearestRankPercentiles(acc.runnerQueueWaitMs);
  const reviewStats = nearestRankPercentiles(acc.independentReviewMs);
  return {
    cohort: acc.cohort,
    sampleCount: acc.criticalPathMs.length,
    p50Ms,
    p95Ms,
    p50MeetsStandardTarget: p50Ms === null ? null : p50Ms < STANDARD_CI_P50_TARGET_MS,
    p50MeetsStretchTarget: p50Ms === null ? null : p50Ms <= FAST_FEEDBACK_STRETCH_MS,
    sloMissCount: acc.sloMissCount,
    stretchMissCount: acc.stretchMissCount,
    failedOrCancelledCount: acc.failedOrCancelledCount,
    incompleteOrMismatchedCount: acc.incompleteOrMismatchedCount,
    sameHeadRetryCount: acc.sameHeadRetryCount,
    firstJobStartToLastCheckMs: firstStartStats,
    runnerQueueWaitMs: queueStats,
    independentReviewMs: {
      sampleCount: acc.independentReviewMs.length,
      ...reviewStats
    },
    lanes: {
      linux: summarizeLane(acc.lanes.linux),
      windows: summarizeLane(acc.lanes.windows),
      security: summarizeLane(acc.lanes.security)
    }
  };
}

function ciCriticalPathBlocked(reason) {
  const cold = finalizeCohort(createCohortAccumulator('cold'));
  const warm = finalizeCohort(createCohortAccumulator('warm'));
  return {
    valid: false,
    shadow: true,
    reason,
    targets: {
      standardCiP50TargetMs: STANDARD_CI_P50_TARGET_MS,
      fastFeedbackStretchMs: FAST_FEEDBACK_STRETCH_MS,
      laneTargetMs: LANE_TARGET_MS
    },
    mandatoryCheckContexts: [...MANDATORY_CI_CHECK_CONTEXTS],
    sloIsTimeoutOrGateWaiver: false,
    fullVerificationRequired: true,
    skipRequiredChecks: false,
    sampleCount: 0,
    p50Ms: null,
    p95Ms: null,
    p50MeetsStandardTarget: null,
    p50MeetsStretchTarget: null,
    sloMissCount: 0,
    failedOrCancelledCount: 0,
    incompleteOrMismatchedCount: 0,
    sameHeadRetryCount: 0,
    firstJobStartToLastCheckMs: {p50Ms: null, p95Ms: null},
    runnerQueueWaitMs: {p50Ms: null, p95Ms: null},
    independentReviewMs: {sampleCount: 0, p50Ms: null, p95Ms: null},
    cohorts: {cold, warm},
    runs: []
  };
}

const RUN_REQUIRED_KEYS = ['runId', 'headSha', 'cacheCohort', 'eventAtMs', 'checks'];
const RUN_OPTIONAL_KEYS = ['attempt', 'independentReviewAtMs', 'independentReviewHeadSha'];
const CHECK_REQUIRED_KEYS = [
  'context', 'lane', 'headSha', 'conclusion', 'queuedAtMs', 'startedAtMs', 'completedAtMs'
];

function validateCheck(check, eventAtMs) {
  if (!isPlainDataObject(check, CHECK_REQUIRED_KEYS) || !isContextName(check.context) ||
      !ALLOWED_LANES.has(check.lane) || !isSha40(check.headSha) ||
      !ALLOWED_CONCLUSIONS.has(check.conclusion) || !isNonNegInt(check.queuedAtMs) ||
      check.queuedAtMs < eventAtMs) {
    return 'INVALID_RUN';
  }
  const mandatoryLane = MANDATORY_CONTEXT_LANES.get(check.context);
  if (mandatoryLane !== undefined && check.lane !== mandatoryLane) {
    return 'INVALID_CHECK_LANE';
  }
  if (check.conclusion === 'success') {
    if (!isNonNegInt(check.startedAtMs) || !isNonNegInt(check.completedAtMs) ||
        check.startedAtMs < check.queuedAtMs || check.completedAtMs < check.startedAtMs) {
      return 'INVALID_RUN';
    }
    return null;
  }
  if (check.startedAtMs === null && check.completedAtMs === null) return null;
  if (!isNonNegInt(check.startedAtMs) || !isNonNegInt(check.completedAtMs) ||
      check.startedAtMs < check.queuedAtMs || check.completedAtMs < check.startedAtMs) {
    return 'INVALID_RUN';
  }
  return null;
}

export function evaluateCiCriticalPath(runs) {
  if (!isExactArray(runs, 2000) || runs.length === 0) {
    return ciCriticalPathBlocked('RUNS_INVALID');
  }
  const seenRunIds = new Set();
  const seenHeads = new Set();
  const overall = createCohortAccumulator('all');
  const cohortBuckets = {
    cold: createCohortAccumulator('cold'),
    warm: createCohortAccumulator('warm')
  };
  const evaluatedRuns = [];

  for (const run of runs) {
    if (!isPlainDataObject(run, RUN_REQUIRED_KEYS, RUN_OPTIONAL_KEYS) ||
        !isRunId(run.runId) || !isSha40(run.headSha) || !CACHE_COHORTS.has(run.cacheCohort) ||
        !isNonNegInt(run.eventAtMs) || !isExactArray(run.checks, 32) || run.checks.length === 0) {
      return ciCriticalPathBlocked('INVALID_RUN');
    }
    if (seenRunIds.has(run.runId)) return ciCriticalPathBlocked('DUPLICATE_RUN_ID');
    seenRunIds.add(run.runId);

    const attempt = Object.hasOwn(run, 'attempt') ? run.attempt : 1;
    if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 20) {
      return ciCriticalPathBlocked('INVALID_RUN');
    }

    const hasReviewTime = Object.hasOwn(run, 'independentReviewAtMs') && run.independentReviewAtMs !== null;
    if (Object.hasOwn(run, 'independentReviewAtMs') && run.independentReviewAtMs !== null &&
        (!isNonNegInt(run.independentReviewAtMs) || run.independentReviewAtMs < run.eventAtMs)) {
      return ciCriticalPathBlocked('INVALID_RUN');
    }
    const hasReviewHead = Object.hasOwn(run, 'independentReviewHeadSha') && run.independentReviewHeadSha !== null;
    if (hasReviewHead && (!hasReviewTime || !isSha40(run.independentReviewHeadSha))) {
      return ciCriticalPathBlocked('INVALID_RUN');
    }

    const byContext = new Map();
    for (const check of run.checks) {
      const checkError = validateCheck(check, run.eventAtMs);
      if (checkError !== null) return ciCriticalPathBlocked(checkError);
      if (byContext.has(check.context)) return ciCriticalPathBlocked('DUPLICATE_CHECK_CONTEXT');
      byContext.set(check.context, check);
    }

    const retryDelta = seenHeads.has(run.headSha) ? 1 : attempt - 1;
    seenHeads.add(run.headSha);

    const bucket = cohortBuckets[run.cacheCohort];
    overall.sameHeadRetryCount += retryDelta;
    bucket.sameHeadRetryCount += retryDelta;

    const hasFailedOrCancelled = run.checks.some(
      check => check.headSha === run.headSha && FAILURE_CONCLUSIONS.has(check.conclusion)
    );
    const allHeadAligned = run.checks.every(check => check.headSha === run.headSha);
    const mandatoryPassed = allHeadAligned && MANDATORY_CI_CHECK_CONTEXTS.every(ctx => {
      const item = byContext.get(ctx);
      return item !== undefined && item.conclusion === 'success';
    });

    const reviewHeadMatches = !hasReviewHead || run.independentReviewHeadSha === run.headSha;
    const independentReviewMs = hasReviewTime && reviewHeadMatches
      ? run.independentReviewAtMs - run.eventAtMs
      : null;

    if (hasFailedOrCancelled) {
      overall.failedOrCancelledCount++;
      bucket.failedOrCancelledCount++;
      evaluatedRuns.push({
        runId: run.runId,
        headSha: run.headSha,
        cacheCohort: run.cacheCohort,
        status: 'failed-or-cancelled',
        eligibleSample: false,
        sameHeadRetryCount: retryDelta,
        gateWaived: false,
        cancelledBySlo: false,
        eventToLastRequiredCheckMs: null,
        firstJobStartToLastCheckMs: null,
        runnerQueueWaitMs: null,
        independentReviewMs,
        mergeReadinessCriticalPathMs: null,
        meetsStandardSlo: null,
        meetsFastFeedbackStretch: null,
        lanes: null
      });
      continue;
    }

    if (!mandatoryPassed) {
      overall.incompleteOrMismatchedCount++;
      bucket.incompleteOrMismatchedCount++;
      evaluatedRuns.push({
        runId: run.runId,
        headSha: run.headSha,
        cacheCohort: run.cacheCohort,
        status: 'incomplete-or-head-mismatch',
        eligibleSample: false,
        sameHeadRetryCount: retryDelta,
        gateWaived: false,
        cancelledBySlo: false,
        eventToLastRequiredCheckMs: null,
        firstJobStartToLastCheckMs: null,
        runnerQueueWaitMs: null,
        independentReviewMs,
        mergeReadinessCriticalPathMs: null,
        meetsStandardSlo: null,
        meetsFastFeedbackStretch: null,
        lanes: null
      });
      continue;
    }

    const activeChecks = run.checks.filter(check => check.conclusion === 'success');
    const firstJobStartMs = Math.min(...activeChecks.map(check => check.startedAtMs));
    const lastCheckEndMs = Math.max(...activeChecks.map(check => check.completedAtMs));
    const eventToLastRequiredCheckMs = lastCheckEndMs - run.eventAtMs;
    const firstJobStartToLastCheckMs = lastCheckEndMs - firstJobStartMs;
    const runnerQueueWaitMs = Math.max(...activeChecks.map(check => check.startedAtMs - check.queuedAtMs));

    const lanes = {};
    for (const lane of CI_LANES) {
      const laneChecks = activeChecks.filter(check => check.lane === lane);
      const laneEndMs = Math.max(...laneChecks.map(check => check.completedAtMs));
      const durationMs = laneEndMs - run.eventAtMs;
      lanes[lane] = {
        durationMs,
        targetMs: LANE_TARGET_MS,
        meetsTarget: durationMs <= LANE_TARGET_MS
      };
      overall.lanes[lane].push(durationMs);
      bucket.lanes[lane].push(durationMs);
    }

    const meetsStandardSlo = eventToLastRequiredCheckMs < STANDARD_CI_P50_TARGET_MS;
    const meetsFastFeedbackStretch = eventToLastRequiredCheckMs <= FAST_FEEDBACK_STRETCH_MS;
    if (!meetsStandardSlo) {
      overall.sloMissCount++;
      bucket.sloMissCount++;
    }
    if (!meetsFastFeedbackStretch) {
      overall.stretchMissCount++;
      bucket.stretchMissCount++;
    }

    overall.criticalPathMs.push(eventToLastRequiredCheckMs);
    bucket.criticalPathMs.push(eventToLastRequiredCheckMs);
    overall.firstJobStartToLastCheckMs.push(firstJobStartToLastCheckMs);
    bucket.firstJobStartToLastCheckMs.push(firstJobStartToLastCheckMs);
    overall.runnerQueueWaitMs.push(runnerQueueWaitMs);
    bucket.runnerQueueWaitMs.push(runnerQueueWaitMs);
    if (independentReviewMs !== null) {
      overall.independentReviewMs.push(independentReviewMs);
      bucket.independentReviewMs.push(independentReviewMs);
    }

    const mergeReadinessCriticalPathMs = independentReviewMs === null
      ? null
      : Math.max(eventToLastRequiredCheckMs, independentReviewMs);

    evaluatedRuns.push({
      runId: run.runId,
      headSha: run.headSha,
      cacheCohort: run.cacheCohort,
      status: 'eligible',
      eligibleSample: true,
      sameHeadRetryCount: retryDelta,
      gateWaived: false,
      cancelledBySlo: false,
      eventToLastRequiredCheckMs,
      firstJobStartToLastCheckMs,
      runnerQueueWaitMs,
      independentReviewMs,
      mergeReadinessCriticalPathMs,
      meetsStandardSlo,
      meetsFastFeedbackStretch,
      lanes
    });
  }

  const summary = finalizeCohort(overall);
  return {
    valid: true,
    shadow: true,
    reason: 'CI_CRITICAL_PATH_EVALUATED',
    targets: {
      standardCiP50TargetMs: STANDARD_CI_P50_TARGET_MS,
      fastFeedbackStretchMs: FAST_FEEDBACK_STRETCH_MS,
      laneTargetMs: LANE_TARGET_MS
    },
    mandatoryCheckContexts: [...MANDATORY_CI_CHECK_CONTEXTS],
    sloIsTimeoutOrGateWaiver: false,
    fullVerificationRequired: true,
    skipRequiredChecks: false,
    sampleCount: summary.sampleCount,
    p50Ms: summary.p50Ms,
    p95Ms: summary.p95Ms,
    p50MeetsStandardTarget: summary.p50MeetsStandardTarget,
    p50MeetsStretchTarget: summary.p50MeetsStretchTarget,
    sloMissCount: summary.sloMissCount,
    failedOrCancelledCount: summary.failedOrCancelledCount,
    incompleteOrMismatchedCount: summary.incompleteOrMismatchedCount,
    sameHeadRetryCount: summary.sameHeadRetryCount,
    firstJobStartToLastCheckMs: summary.firstJobStartToLastCheckMs,
    runnerQueueWaitMs: summary.runnerQueueWaitMs,
    independentReviewMs: summary.independentReviewMs,
    cohorts: {
      cold: finalizeCohort(cohortBuckets.cold),
      warm: finalizeCohort(cohortBuckets.warm)
    },
    runs: evaluatedRuns
  };
}

const STAGE_SAMPLE_REQUIRED_KEYS = [
  'platform', 'headSha', 'runnerEnvironment', 'outcome', ...ASPIRE_STAGE_KEYS
];
const STAGE_SAMPLE_OPTIONAL_KEYS = ['failureCode', 'failedStage'];

function aspireStagesBlocked(reason) {
  return {
    valid: false,
    shadow: true,
    reason,
    platform: null,
    headSha: null,
    outcome: null,
    queueWaitMs: null,
    runtimeExecutionMs: null,
    totalWallMs: null,
    stages: null,
    dominantStage: null,
    dominantStageMs: null,
    provisionalWindowsTargetMs: WINDOWS_ASPIRE_RUNTIME_PROVISIONAL_TARGET_MS,
    meetsWindowsProvisionalTarget: null,
    laneTargetMs: LANE_TARGET_MS,
    meetsLaneTarget: null,
    failureCategory: null,
    tlsVerificationRequired: true,
    skipRequiredChecks: false
  };
}

function classifyAspireFailureCategory(outcome, failureCode, failedStage) {
  if (failureCode !== null) {
    return ASPIRE_FAILURE_CODE_MAP.get(failureCode);
  }
  if (failedStage === 'certificateExportMs') return 'tls-or-certificate';
  if (failedStage === 'appHostStartupMs' && outcome === 'timed-out') return 'startup-timeout';
  if (failedStage === 'restoreBuildMs') return 'restore-build';
  if (failedStage === 'exportVerifyMs') return 'export-receipt';
  return 'unclassified';
}

export function analyzeAspireRuntimeStages(stageSample) {
  if (!isPlainDataObject(stageSample, STAGE_SAMPLE_REQUIRED_KEYS, STAGE_SAMPLE_OPTIONAL_KEYS) ||
      !ASPIRE_PLATFORMS.has(stageSample.platform) || !isSha40(stageSample.headSha) ||
      !ASPIRE_OUTCOMES.has(stageSample.outcome) || !isBoundedStageMs(stageSample.queueWaitMs)) {
    return aspireStagesBlocked('STAGE_SAMPLE_INVALID');
  }
  if (stageSample.runnerEnvironment !== 'github-hosted') {
    return aspireStagesBlocked('UNSUPPORTED_RUNNER_ENVIRONMENT');
  }

  const failureCode = Object.hasOwn(stageSample, 'failureCode') ? stageSample.failureCode : null;
  const failedStage = Object.hasOwn(stageSample, 'failedStage') ? stageSample.failedStage : null;

  if (failureCode !== null && (!isFailureCodeToken(failureCode) || !ASPIRE_FAILURE_CODE_MAP.has(failureCode))) {
    return aspireStagesBlocked('UNSAFE_DIAGNOSTIC_REJECTED');
  }
  if (failedStage !== null && !ACTIVE_ASPIRE_STAGE_SET.has(failedStage)) {
    return aspireStagesBlocked('STAGE_SAMPLE_INVALID');
  }

  const succeeded = stageSample.outcome === 'succeeded';
  if (succeeded && (failureCode !== null || failedStage !== null)) {
    return aspireStagesBlocked('CONTRADICTORY_OUTCOME');
  }

  const stages = {queueWaitMs: stageSample.queueWaitMs};
  let runtimeExecutionMs = 0;
  let dominantStage = null;
  let dominantStageMs = null;

  for (const key of ACTIVE_ASPIRE_STAGE_KEYS) {
    const value = stageSample[key];
    if (succeeded) {
      if (!isBoundedStageMs(value)) return aspireStagesBlocked('STAGE_SAMPLE_INVALID');
    } else if (value !== null && !isBoundedStageMs(value)) {
      return aspireStagesBlocked('STAGE_SAMPLE_INVALID');
    }
    stages[key] = value;
    if (value !== null) {
      runtimeExecutionMs += value;
      if (dominantStageMs === null || value > dominantStageMs) {
        dominantStage = key;
        dominantStageMs = value;
      }
    }
  }

  const totalWallMs = stageSample.queueWaitMs + runtimeExecutionMs;
  const failureCategory = succeeded
    ? null
    : classifyAspireFailureCategory(stageSample.outcome, failureCode, failedStage);
  const meetsWindowsProvisionalTarget = stageSample.platform === 'windows'
    ? succeeded && runtimeExecutionMs < WINDOWS_ASPIRE_RUNTIME_PROVISIONAL_TARGET_MS
    : null;

  return {
    valid: true,
    shadow: true,
    reason: 'ASPIRE_RUNTIME_STAGES_ANALYZED',
    platform: stageSample.platform,
    headSha: stageSample.headSha,
    outcome: stageSample.outcome,
    queueWaitMs: stageSample.queueWaitMs,
    runtimeExecutionMs,
    totalWallMs,
    stages,
    dominantStage,
    dominantStageMs,
    provisionalWindowsTargetMs: WINDOWS_ASPIRE_RUNTIME_PROVISIONAL_TARGET_MS,
    meetsWindowsProvisionalTarget,
    laneTargetMs: LANE_TARGET_MS,
    meetsLaneTarget: succeeded && totalWallMs <= LANE_TARGET_MS,
    failureCategory,
    tlsVerificationRequired: true,
    skipRequiredChecks: false
  };
}

const MANIFEST_REQUIRED_KEYS = [
  'repositoryId', 'repository', 'trustedSource', 'isFork',
  'os', 'arch', 'toolchain',
  'packageLockSha256', 'globalJsonSha256', 'appHostSha256'
];
const MANIFEST_OPTIONAL_KEYS = [
  'branchProtected', 'packageJsonSha256', 'nugetLockSha256', 'observedCache'
];
const OBSERVED_CACHE_TARGETS = ['npm', 'nuget', 'aspire-cli'];
const OBSERVED_ENTRY_KEYS = [
  'key', 'inputSha256', 'expectedArtifactSha256', 'observedArtifactSha256',
  'writerRepositoryId', 'writerRepository', 'writerTrusted', 'writerIsFork',
  'writerBranchProtected', 'cleanLayout'
];

function manifestBlocked(reason) {
  return {
    valid: false,
    shadow: true,
    reason,
    rid: null,
    os: null,
    arch: null,
    toolchain: null,
    allowProtectedCacheWrite: false,
    reuseEligible: false,
    fullVerificationRequired: true,
    skipRequiredChecks: false,
    keys: null,
    entries: null
  };
}

function resolveRunnerRid(os, arch) {
  if (arch !== 'x64') return {rid: 'unsupported', normalizedOs: null};
  if (os === 'linux') return {rid: 'linux-x64', normalizedOs: 'linux'};
  if (os === 'windows' || os === 'win32') return {rid: 'win-x64', normalizedOs: 'windows'};
  return {rid: 'unsupported', normalizedOs: null};
}

export function buildExactInputCacheManifest(input) {
  if (!isPlainDataObject(input, MANIFEST_REQUIRED_KEYS, MANIFEST_OPTIONAL_KEYS) ||
      !isPlainDataObject(input.toolchain, ['node', 'dotnet', 'aspireCli'])) {
    return manifestBlocked('MANIFEST_INPUT_INVALID');
  }

  const branchProtected = Object.hasOwn(input, 'branchProtected') ? input.branchProtected : false;
  if (typeof branchProtected !== 'boolean') {
    return manifestBlocked('MANIFEST_INPUT_INVALID');
  }

  const nugetLockSha256 = Object.hasOwn(input, 'nugetLockSha256') ? input.nugetLockSha256 : null;
  if (nugetLockSha256 !== null && !isSha256(nugetLockSha256)) {
    return manifestBlocked('INVALID_DIGEST');
  }

  const packageJsonDigest = Object.hasOwn(input, 'packageJsonSha256')
    ? input.packageJsonSha256
    : (isSha256(input.packageLockSha256)
      ? sha256Hex(['package-lock-bound-manifest', input.packageLockSha256])
      : input.packageLockSha256);

  const {rid, normalizedOs} = resolveRunnerRid(input.os, input.arch);
  const ciExpected = {
    repositoryId: input.repositoryId,
    repository: input.repository,
    trustedSource: input.trustedSource,
    isFork: input.isFork,
    complete: true,
    rid,
    node: input.toolchain.node,
    npmCiFlags: PINNED_NPM_CI_FLAGS,
    dotnet: input.toolchain.dotnet,
    apphostConfiguration: PINNED_APPHOST_CONFIGURATION,
    aspire: input.toolchain.aspireCli,
    packageJsonDigest,
    packageLockDigest: input.packageLockSha256,
    apphostDigest: input.appHostSha256,
    globalJsonDigest: input.globalJsonSha256
  };

  const derived = deriveCiCacheKeys(ciExpected);
  if (derived.reason !== 'EXACT_CACHE_KEYS_DERIVED') {
    return manifestBlocked(derived.reason);
  }

  const npmInputSha256 = sha256Hex([
    'npm', normalizedOs, input.arch, PINNED_CI_TOOLCHAIN.node, derived.inputDigests.npmCi
  ]);
  const nugetInputSha256 = sha256Hex([
    'nuget', normalizedOs, input.arch, PINNED_CI_TOOLCHAIN.dotnet,
    derived.inputDigests.nugetApphost, nugetLockSha256 ?? 'no-nuget-lock'
  ]);
  const aspireInputSha256 = sha256Hex([
    'aspire-cli', normalizedOs, input.arch, PINNED_CI_TOOLCHAIN.dotnet,
    PINNED_CI_TOOLCHAIN.aspireCli, input.globalJsonSha256, derived.inputDigests.aspireCli
  ]);

  const npmSha256 = sha256Hex([derived.keys.npmCi, npmInputSha256]);
  const nugetSha256 = sha256Hex([derived.keys.nugetApphost, nugetInputSha256]);
  const aspireSha256 = sha256Hex([derived.keys.aspireCli, aspireInputSha256]);

  const entries = {
    npm: {
      target: 'npm',
      lockedTarget: 'npmCi',
      key: `sf-npm-v1-${rid}-node-${PINNED_CI_TOOLCHAIN.node}-${npmSha256}`,
      lockedKey: derived.keys.npmCi,
      sha256: npmSha256,
      inputSha256: npmInputSha256,
      verifiedHit: false
    },
    nuget: {
      target: 'nuget',
      lockedTarget: 'nugetApphost',
      key: `sf-nuget-v1-${rid}-dotnet-${PINNED_CI_TOOLCHAIN.dotnet}-release-${nugetSha256}`,
      lockedKey: derived.keys.nugetApphost,
      sha256: nugetSha256,
      inputSha256: nugetInputSha256,
      nugetLockBound: nugetLockSha256 !== null,
      verifiedHit: false
    },
    'aspire-cli': {
      target: 'aspire-cli',
      lockedTarget: 'aspireCli',
      key: `sf-aspire-cli-v1-${rid}-aspire-${PINNED_CI_TOOLCHAIN.aspireCli}-${aspireSha256}`,
      lockedKey: derived.keys.aspireCli,
      sha256: aspireSha256,
      inputSha256: aspireInputSha256,
      verifiedHit: false
    }
  };

  let reuseEligible = false;
  let reason = 'EXACT_CACHE_MANIFEST_BUILT';

  if (Object.hasOwn(input, 'observedCache') && input.observedCache !== null) {
    if (!isPlainDataObject(input.observedCache, [], OBSERVED_CACHE_TARGETS) ||
        Reflect.ownKeys(input.observedCache).length === 0) {
      return manifestBlocked('CACHE_ENTRY_UNKNOWN');
    }
    for (const target of OBSERVED_CACHE_TARGETS) {
      if (!Object.hasOwn(input.observedCache, target)) continue;
      const obs = input.observedCache[target];
      if (!isPlainDataObject(obs, OBSERVED_ENTRY_KEYS) ||
          typeof obs.key !== 'string' || obs.key.length === 0 || obs.key.length > 200) {
        return manifestBlocked('CACHE_ENTRY_UNKNOWN');
      }
      const spec = entries[target];
      const lockedEntry = {
        target: spec.lockedTarget,
        key: spec.lockedKey,
        writerRepositoryId: obs.writerRepositoryId,
        writerRepository: obs.writerRepository,
        writerTrusted: obs.writerTrusted,
        writerIsFork: obs.writerIsFork,
        writerBranchProtected: obs.writerBranchProtected,
        rid,
        node: PINNED_CI_TOOLCHAIN.node,
        npmCiFlags: PINNED_NPM_CI_FLAGS,
        dotnet: PINNED_CI_TOOLCHAIN.dotnet,
        apphostConfiguration: PINNED_APPHOST_CONFIGURATION,
        aspire: PINNED_CI_TOOLCHAIN.aspireCli,
        inputDigest: derived.inputDigests[spec.lockedTarget],
        expectedArtifactDigest: obs.expectedArtifactSha256,
        observedArtifactDigest: obs.observedArtifactSha256,
        cleanLayout: obs.cleanLayout
      };
      const verified = verifyCiCacheEntry(ciExpected, lockedEntry);
      if (!verified.verified) return manifestBlocked(verified.reason);
      if (!isSha256(obs.inputSha256) || obs.inputSha256 !== spec.inputSha256) {
        return manifestBlocked('DIGEST_MISMATCH');
      }
      if (obs.key !== spec.key) {
        return manifestBlocked('CACHE_POISONING_DETECTED');
      }
      spec.verifiedHit = true;
    }
    reuseEligible = true;
    reason = 'EXACT_CACHE_MANIFEST_VERIFIED';
  }

  return {
    valid: true,
    shadow: true,
    reason,
    rid,
    os: normalizedOs,
    arch: input.arch,
    toolchain: {...PINNED_CI_TOOLCHAIN},
    allowProtectedCacheWrite: branchProtected,
    reuseEligible,
    fullVerificationRequired: true,
    skipRequiredChecks: false,
    keys: {
      npm: entries.npm.key,
      nuget: entries.nuget.key,
      'aspire-cli': entries['aspire-cli'].key
    },
    entries
  };
}

const HANDOFF_REQUIRED_KEYS = ['repository', 'baseSha', 'headSha', 'changeEvidence', 'failureEvidence'];
const HANDOFF_OPTIONAL_KEYS = ['requestedMaxAttempts'];
const CHANGE_EVIDENCE_REQUIRED_KEYS = [
  'repository', 'producer', 'verified', 'complete', 'base', 'head', 'paths', 'testInventory'
];
const FAILURE_EVIDENCE_REQUIRED_KEYS = [
  'head', 'complete', 'producer', 'verified', 'signal',
  'transient', 'attempt', 'retryLimit', 'repairAttempt', 'maxRepairAttempts'
];

function handoffBlocked(reason, requiredGates = {
  lineCoveragePct: 98,
  branchCoveragePct: 95,
  security: true,
  linuxRuntime: true,
  windowsRuntime: true
}) {
  return {
    valid: false,
    shadow: true,
    reason,
    failureCategory: 'unknown',
    failureSignal: 'unknown',
    repairAction: 'investigate-unknown-failure',
    eligibleForAutoRepair: false,
    eligibleForTransientRetry: false,
    blindRetryRejected: true,
    maxAttempts: 0,
    remainingAttempts: 0,
    fastFeedbackChecks: [],
    affectedComponents: [],
    mandatoryFullGatesPreserved: true,
    requiredGates,
    fullValidationRequired: true,
    skipRequiredChecks: false,
    escalateToHuman: true,
    mafCheckpointRequired: true
  };
}

export function buildMafBoundedRepairHandoff(input) {
  if (!isPlainDataObject(input, HANDOFF_REQUIRED_KEYS, HANDOFF_OPTIONAL_KEYS) ||
      !isPlainDataObject(input.changeEvidence, CHANGE_EVIDENCE_REQUIRED_KEYS, ['deletedPaths']) ||
      !isPlainDataObject(input.failureEvidence, FAILURE_EVIDENCE_REQUIRED_KEYS)) {
    return handoffBlocked('HANDOFF_INPUT_INVALID');
  }

  const hasRequestedMax = Object.hasOwn(input, 'requestedMaxAttempts');
  if (hasRequestedMax && (!isNonNegInt(input.requestedMaxAttempts) || input.requestedMaxAttempts > 100)) {
    return handoffBlocked('HANDOFF_INPUT_INVALID');
  }

  const fastFeedback = planChangeGraphFastFeedback(input.changeEvidence, {
    repository: input.repository,
    revision: input.baseSha,
    head: input.headSha
  });
  if (fastFeedback.state !== 'shadow-mapped') {
    return handoffBlocked(fastFeedback.reason, fastFeedback.requiredGates);
  }

  const diagnosis = classifyValidationFailure(input.failureEvidence, input.headSha);
  if (diagnosis.category === 'unknown') {
    return handoffBlocked(diagnosis.reason, fastFeedback.requiredGates);
  }

  const failureCategory = diagnosis.category === 'dependency-lock' ? 'dependency' : diagnosis.category;
  const baseResponse = {
    valid: true,
    shadow: true,
    failureCategory,
    failureSignal: diagnosis.signal,
    fastFeedbackChecks: [...fastFeedback.tests],
    affectedComponents: [...fastFeedback.components],
    mandatoryFullGatesPreserved: true,
    requiredGates: {...fastFeedback.requiredGates},
    fullValidationRequired: true,
    skipRequiredChecks: false,
    mafCheckpointRequired: true
  };

  if (failureCategory === 'permission' || failureCategory === 'security') {
    return {
      ...baseResponse,
      reason: diagnosis.reason,
      repairAction: diagnosis.action,
      eligibleForAutoRepair: false,
      eligibleForTransientRetry: false,
      blindRetryRejected: true,
      maxAttempts: 0,
      remainingAttempts: 0,
      escalateToHuman: true
    };
  }

  if (failureCategory === 'infra' && !diagnosis.deterministic) {
    const budgetCap = hasRequestedMax
      ? Math.min(input.requestedMaxAttempts, input.failureEvidence.retryLimit, MAX_AUTO_REPAIR_ATTEMPTS)
      : Math.min(input.failureEvidence.retryLimit, MAX_AUTO_REPAIR_ATTEMPTS);
    const remainingAttempts = Math.max(0, budgetCap - input.failureEvidence.attempt);
    const retryEligible = remainingAttempts > 0;
    return {
      ...baseResponse,
      reason: retryEligible ? 'TRANSIENT_INFRA_RETRY_HANDOFF' : 'INFRA_RETRY_BUDGET_EXHAUSTED',
      repairAction: retryEligible ? 'bounded-infra-retry' : 'escalate-infra-exhausted',
      eligibleForAutoRepair: false,
      eligibleForTransientRetry: retryEligible,
      blindRetryRejected: !retryEligible,
      maxAttempts: budgetCap,
      remainingAttempts,
      escalateToHuman: !retryEligible
    };
  }

  const budgetCap = hasRequestedMax
    ? Math.min(input.requestedMaxAttempts, input.failureEvidence.maxRepairAttempts, MAX_AUTO_REPAIR_ATTEMPTS)
    : Math.min(input.failureEvidence.maxRepairAttempts, MAX_AUTO_REPAIR_ATTEMPTS);
  const remainingAttempts = Math.max(0, budgetCap - input.failureEvidence.repairAttempt);
  const repairEligible = remainingAttempts > 0;

  return {
    ...baseResponse,
    reason: repairEligible ? 'BOUNDED_REPAIR_HANDOFF_READY' : 'REPAIR_BUDGET_EXHAUSTED',
    repairAction: repairEligible ? diagnosis.action : 'escalate-repair-budget-exhausted',
    eligibleForAutoRepair: repairEligible,
    eligibleForTransientRetry: false,
    blindRetryRejected: true,
    maxAttempts: budgetCap,
    remainingAttempts,
    escalateToHuman: !repairEligible
  };
}
