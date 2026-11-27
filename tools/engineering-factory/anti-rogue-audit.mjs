// Deterministic W3C traceparent 9-link causal provenance verifier and external
// anti-rogue circuit breaker. Metadata-only, read-only, fail-closed, outside agent loops.
import {types} from 'node:util';
import {coverageEvidence} from './coverage-evidence.mjs';

export const SOFTWARE_FACTORY_REPOSITORY_ID = 1471342715;

export const CANONICAL_PROVENANCE_STAGES = Object.freeze([
  'eventDelivery',
  'ghAwLock',
  'casLease',
  'missionControlTask',
  'candidateCommit',
  'exactHeadValidation',
  'independentReview',
  'mergeQueueSquash',
  'verifiedMain'
]);

export const TRACEPARENT_PATTERN =
  /^00-(?!0{32})([0-9a-f]{32})-(?!0{16})([0-9a-f]{16})-([0-9a-f]{2})$/;

export const EXACT_PROTECTED_CONTROL_PLANE_PATHS = Object.freeze([
  'SECURITY.md',
  'docs/POLICY.md',
  'docs/ENGINEERING-STANDARDS.md',
  'tools/engineering-factory/core.mjs',
  'tools/engineering-factory/protected-squash.mjs',
  'tools/engineering-factory/platform-merge-gates.mjs',
  'tools/engineering-factory/coverage-evidence.mjs',
  'tools/engineering-factory/budget.mjs',
  'tools/engineering-factory/anti-rogue-audit.mjs',
  'tools/engineering-factory/cloud-agent-admission.mjs',
  'tools/engineering-factory/gh-aw-lock-verifier.mjs'
]);

const exactProtectedSet = new Set(EXACT_PROTECTED_CONTROL_PLANE_PATHS);
const canonicalStageIndex = new Map(CANONICAL_PROVENANCE_STAGES.map((stage, idx) => [stage, idx]));

const VIOLATION_REASON_MAP = new Map([
  ['SAFE_OUTPUTS_THREAT_FLAGGED', 'SECURITY'],
  ['PROTECTED_CONTROL_PLANE_TOUCH', 'SECURITY'],
  ['OUT_OF_LANE_EDIT', 'POLICY'],
  ['SELF_APPROVAL_FORBIDDEN', 'REVIEW'],
  ['AI_CREDIT_ANOMALY', 'QUOTA'],
  ['RETRY_CAP_EXCEEDED', 'POLICY'],
  ['POST_MERGE_MAIN_FAILED', 'CHECKS']
]);

const CIRCUIT_BREAKER_REQUIRED_KEYS = [
  'repositoryId',
  'ownedPaths',
  'touchedPaths',
  'attempt',
  'maxRetries',
  'runAiCredits',
  'maxRunAiCredits',
  'burnRateBps',
  'maxBurnSpikeBps',
  'incrementalBilledUsdCents',
  'safeOutputsThreatDetected'
];

const CIRCUIT_BREAKER_OPTIONAL_KEYS = [
  'humanOwnerSignOffVerified',
  'selfMerge',
  'authorIdentity',
  'implementationAgentIdentity',
  'reviewerIdentity',
  'mainHealthy',
  'accountingVerified',
  'isEstimated'
];

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
  if (keys.some(key => typeof key !== 'string' || !allowed.has(key) || !hasOwnEnumerableData(value, key))) {
    return false;
  }
  return requiredKeys.every(key => hasOwnEnumerableData(value, key));
}

function denseDataArray(value, maxLen) {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return false;
  }
  if (value.length > maxLen || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let i = 0; i < value.length; i++) {
    if (!hasOwnEnumerableData(value, i)) return false;
  }
  return true;
}

const positiveInt = n => Number.isSafeInteger(n) && n > 0;
const nonnegInt = n => Number.isSafeInteger(n) && n >= 0;
const token = s => typeof s === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(s);
const identityToken = s => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,79}$/.test(s);
const hex40 = s => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
const hex64 = s => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
const uuid = s => typeof s === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
const validCounts = (covered, total) =>
  nonnegInt(covered) && positiveInt(total) && covered <= total && total <= 100000000;

export function isSafeRepoRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(value) || value.startsWith('/') || value.endsWith('/')) return false;
  return value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..');
}

export function isProtectedControlPlanePath(path) {
  if (!isSafeRepoRelativePath(path)) return false;
  if (exactProtectedSet.has(path)) return true;
  if (path.startsWith('.github/workflows/') || path.endsWith('.lock.yml')) return true;
  return /(^|\/)(rulesets?|kill-switch|kill_switch)(\/|\.|$)/i.test(path);
}

export function isWithinOwnedPaths(path, ownedPaths) {
  return ownedPaths.some(owned => path === owned || path.startsWith(`${owned}/`));
}

export function parseTraceparent(value) {
  if (typeof value !== 'string') return Object.freeze({valid: false, reason: 'INVALID_TRACEPARENT'});
  const match = TRACEPARENT_PATTERN.exec(value);
  if (!match) return Object.freeze({valid: false, reason: 'INVALID_TRACEPARENT'});
  return Object.freeze({
    valid: true,
    version: '00',
    traceId: match[1],
    spanId: match[2],
    traceFlags: match[3],
    sampled: (Number.parseInt(match[3], 16) & 1) === 1
  });
}

function validUniquePathList(list, maxLen) {
  if (!denseDataArray(list, maxLen) || list.length === 0 || !list.every(isSafeRepoRelativePath)) return false;
  return new Set(list).size === list.length;
}

const REVIEW_STATES = new Set(['APPROVED', 'COMMENTED', 'CHANGES_REQUESTED', 'DISMISSED']);
const COPILOT_BOT_REVIEWERS = new Set([
  'copilot-pull-request-reviewer',
  'copilot-pull-request-reviewer[bot]'
]);

function resolveCoveragePolicy(policy, repositoryId) {
  const isFactory = repositoryId === SOFTWARE_FACTORY_REPOSITORY_ID;
  if (policy === undefined) return {ok: true, minLinePercent: 98, minBranchPercent: 95};
  if (!exactRecord(policy, ['minLinePercent', 'minBranchPercent'], ['profile'])) return {ok: false};
  const profile = policy.profile === undefined ? 'software-factory' : policy.profile;
  if (profile !== 'software-factory' && profile !== 'consumer') return {ok: false};
  if (isFactory && profile !== 'software-factory') return {ok: false};
  const floorLine = isFactory || profile === 'software-factory' ? 98 : 95;
  const floorBranch = isFactory || profile === 'software-factory' ? 95 : 90;
  if (!Number.isFinite(policy.minLinePercent) || policy.minLinePercent < floorLine || policy.minLinePercent > 100 ||
      !Number.isFinite(policy.minBranchPercent) || policy.minBranchPercent < floorBranch || policy.minBranchPercent > 100) {
    return {ok: false};
  }
  return {ok: true, minLinePercent: policy.minLinePercent, minBranchPercent: policy.minBranchPercent};
}

function provenanceFail(reason, code, failedStage = null, outOfLanePaths = []) {
  return Object.freeze({
    shadow: true,
    liveMutation: false,
    valid: false,
    complete: false,
    inFlight: false,
    outcome: 'blocked',
    reason,
    code,
    failedStage,
    traceId: null,
    verifiedStageCount: 0,
    lastVerifiedStage: null,
    outOfLanePaths: Object.freeze([...outOfLanePaths])
  });
}

export function verifyCausalProvenanceChain(chain) {
  if (!exactRecord(chain, ['stages'], ['allowInFlightUpToStage', 'coveragePolicy']) ||
      !isPlainObject(chain.stages)) {
    return provenanceFail('INVALID_EVIDENCE', 'INVALID_CHAIN_INPUT');
  }

  let targetIndex = CANONICAL_PROVENANCE_STAGES.length - 1;
  if (chain.allowInFlightUpToStage !== undefined) {
    const idx = canonicalStageIndex.get(chain.allowInFlightUpToStage);
    if (idx === undefined) return provenanceFail('INVALID_EVIDENCE', 'INVALID_IN_FLIGHT_STAGE');
    targetIndex = idx;
  }

  const expectedStages = CANONICAL_PROVENANCE_STAGES.slice(0, targetIndex + 1);
  const stageKeys = Reflect.ownKeys(chain.stages);
  if (stageKeys.some(key => typeof key !== 'string' || !canonicalStageIndex.has(key) ||
      !hasOwnEnumerableData(chain.stages, key))) {
    return provenanceFail('INVALID_EVIDENCE', 'INVALID_STAGE_MAP');
  }
  if (expectedStages.some(name => !hasOwnEnumerableData(chain.stages, name)) ||
      stageKeys.length !== expectedStages.length) {
    return provenanceFail(
      'INVALID_EVIDENCE',
      chain.allowInFlightUpToStage === undefined ? 'INCOMPLETE_PROVENANCE_CHAIN' : 'IN_FLIGHT_STAGE_MISMATCH'
    );
  }

  let traceId = null;
  let prevSpanId = null;
  let prevObservedMs = -1;
  const seenSpans = new Set();
  let repositoryId = null;
  let policy = null;
  let deliveryId = null;
  let laneId = null;
  let ownedPaths = null;
  let commitSha = null;
  let pendingBranchless = null;
  let squashCommitSha = null;

  for (let i = 0; i <= targetIndex; i++) {
    const stageName = CANONICAL_PROVENANCE_STAGES[i];
    const stage = chain.stages[stageName];
    if (!isPlainObject(stage) || !hasOwnEnumerableData(stage, 'traceparent') ||
        !hasOwnEnumerableData(stage, 'parentSpanId') || !hasOwnEnumerableData(stage, 'observedMs')) {
      return provenanceFail('INVALID_EVIDENCE', 'INVALID_STAGE_RECORD', stageName);
    }
    const tp = parseTraceparent(stage.traceparent);
    if (!tp.valid) return provenanceFail('SECURITY', 'INVALID_TRACEPARENT', stageName);
    if (i === 0) {
      if (stage.parentSpanId !== null) return provenanceFail('SECURITY', 'ROOT_PARENT_SPAN_MUST_BE_NULL', stageName);
      traceId = tp.traceId;
    } else {
      if (tp.traceId !== traceId) return provenanceFail('SECURITY', 'TRACE_ID_MISMATCH', stageName);
      if (stage.parentSpanId !== prevSpanId) return provenanceFail('SECURITY', 'SPAN_LINKAGE_BROKEN', stageName);
    }
    if (seenSpans.has(tp.spanId)) return provenanceFail('SECURITY', 'DUPLICATE_SPAN_ID', stageName);
    seenSpans.add(tp.spanId);
    prevSpanId = tp.spanId;

    if (!nonnegInt(stage.observedMs)) return provenanceFail('INVALID_EVIDENCE', 'INVALID_OBSERVED_MS', stageName);
    if (stage.observedMs < prevObservedMs) {
      return provenanceFail('STALE', 'NON_MONOTONIC_TIMESTAMPS', stageName);
    }
    prevObservedMs = stage.observedMs;

    if (stageName === 'eventDelivery') {
      if (!exactRecord(stage, ['traceparent', 'parentSpanId', 'deliveryId', 'repositoryId', 'observedMs']) ||
          !token(stage.deliveryId) || !positiveInt(stage.repositoryId)) {
        return provenanceFail('INVALID_EVIDENCE', 'INVALID_EVENT_DELIVERY', stageName);
      }
      repositoryId = stage.repositoryId;
      deliveryId = stage.deliveryId;
      const resolvedPolicy = resolveCoveragePolicy(chain.coveragePolicy, repositoryId);
      if (!resolvedPolicy.ok) return provenanceFail('POLICY', 'INVALID_COVERAGE_POLICY', stageName);
      policy = resolvedPolicy;
    } else if (stageName === 'ghAwLock') {
      if (!exactRecord(stage, ['traceparent', 'parentSpanId', 'lockSha256', 'observedMs']) ||
          !hex64(stage.lockSha256)) {
        return provenanceFail('SECURITY', 'INVALID_GH_AW_LOCK_HASH', stageName);
      }
    } else if (stageName === 'casLease') {
      if (!exactRecord(stage, ['traceparent', 'parentSpanId', 'leaseGeneration', 'laneId', 'ownedPaths', 'observedMs']) ||
          !positiveInt(stage.leaseGeneration) || !token(stage.laneId) ||
          !validUniquePathList(stage.ownedPaths, 250)) {
        return provenanceFail('LEASE', 'INVALID_CAS_LEASE', stageName);
      }
      laneId = stage.laneId;
      ownedPaths = stage.ownedPaths;
    } else if (stageName === 'missionControlTask') {
      if (!exactRecord(stage, ['traceparent', 'parentSpanId', 'taskId', 'sessionId', 'observedMs']) ||
          !uuid(stage.taskId) || !token(stage.sessionId)) {
        return provenanceFail('INVALID_EVIDENCE', 'INVALID_MISSION_CONTROL_TASK', stageName);
      }
    } else if (stageName === 'candidateCommit') {
      if (!exactRecord(stage, ['traceparent', 'parentSpanId', 'commitSha', 'signed', 'touchedPaths', 'observedMs']) ||
          !hex40(stage.commitSha) || typeof stage.signed !== 'boolean' ||
          !validUniquePathList(stage.touchedPaths, 500)) {
        return provenanceFail('INVALID_EVIDENCE', 'INVALID_CANDIDATE_COMMIT', stageName);
      }
      if (stage.signed !== true) return provenanceFail('SECURITY', 'UNSIGNED_CANDIDATE_COMMIT', stageName);
      const outOfLane = stage.touchedPaths.filter(path => !isWithinOwnedPaths(path, ownedPaths));
      if (outOfLane.length > 0) {
        return provenanceFail('POLICY', 'OUT_OF_LANE_TOUCHED_PATHS', stageName, outOfLane);
      }
      commitSha = stage.commitSha;
    } else if (stageName === 'exactHeadValidation') {
      if (!exactRecord(stage, [
        'traceparent', 'parentSpanId', 'headSha', 'ciReceiptId', 'codeqlReceiptId',
        'coverageReceiptId', 'expectedComponents', 'coverageReports',
        'lines', 'lineTotal', 'branches', 'branchTotal', 'observedMs'
      ], ['branchless']) || !hex40(stage.headSha) || !token(stage.ciReceiptId) || !token(stage.codeqlReceiptId) ||
          !token(stage.coverageReceiptId) || !denseDataArray(stage.expectedComponents, 250) ||
          !denseDataArray(stage.coverageReports, 250) ||
          !stage.coverageReports.every(r => exactRecord(r, [
            'component', 'head', 'lines', 'lineTotal', 'branches', 'branchTotal'
          ])) ||
          (stage.branchless !== undefined && (!denseDataArray(stage.branchless, 250) ||
            !stage.branchless.every(entry => exactRecord(entry, [
              'component', 'head', 'reviewedBy', 'reason'
            ])))) ||
          !validCounts(stage.lines, stage.lineTotal) ||
          !((stage.branches === 0 && stage.branchTotal === 0 && stage.branchless !== undefined) ||
            validCounts(stage.branches, stage.branchTotal))) {
        return provenanceFail('INVALID_EVIDENCE', 'INVALID_EXACT_HEAD_VALIDATION', stageName);
      }
      if (stage.headSha !== commitSha) return provenanceFail('STALE', 'EXACT_HEAD_MISMATCH', stageName);
      const covPolicy = {
        repository: repositoryId === SOFTWARE_FACTORY_REPOSITORY_ID
          ? 'Jamula/SoftwareFactory'
          : 'consumer/repository',
        lineMin: policy.minLinePercent,
        branchMin: policy.minBranchPercent,
        ...(stage.branchless !== undefined ? {branchless: stage.branchless} : {})
      };
      const cov = coverageEvidence(commitSha, stage.expectedComponents, stage.coverageReports, covPolicy);
      if (!cov.valid) {
        if (cov.reason === 'COMPONENT_BELOW_TARGET') {
          return provenanceFail('COVERAGE', 'COVERAGE_BELOW_THRESHOLD', stageName);
        }
        if (cov.reason === 'BRANCHLESS_UNJUSTIFIED') {
          return provenanceFail('COVERAGE', 'BRANCHLESS_UNJUSTIFIED', stageName);
        }
        return provenanceFail('INVALID_EVIDENCE', 'INVALID_EXACT_HEAD_VALIDATION', stageName);
      }
      if (stage.lines !== cov.lines || stage.lineTotal !== cov.lineTotal ||
          stage.branches !== cov.branches || stage.branchTotal !== cov.branchTotal) {
        return provenanceFail('COVERAGE', 'COVERAGE_COUNTS_MISMATCH', stageName);
      }
      if (stage.branchless !== undefined && stage.branchless.length > 0) {
        if (targetIndex < 6) {
          return provenanceFail('COVERAGE', 'BRANCHLESS_REVIEWER_UNAUTHORIZED', stageName);
        }
        pendingBranchless = stage.branchless;
      }
    } else if (stageName === 'independentReview') {
      if (!exactRecord(stage, [
        'traceparent', 'parentSpanId', 'reviewId', 'reviewedHeadSha', 'reviewerIdentity',
        'authorIdentity', 'implementationAgentIdentity', 'authorizedReviewers', 'reviewState',
        'reviewHistoryComplete', 'outstandingChangesRequested',
        'unresolvedThreads', 'summaryFindingsResolved', 'observedMs'
      ], ['requireFormalApproval', 'outstandingDismissedReviews', 'normalizedReviews']) ||
          !token(stage.reviewId) || !hex40(stage.reviewedHeadSha) ||
          !identityToken(stage.reviewerIdentity) || !identityToken(stage.authorIdentity) ||
          !identityToken(stage.implementationAgentIdentity) ||
          !denseDataArray(stage.authorizedReviewers, 64) || stage.authorizedReviewers.length === 0 ||
          !stage.authorizedReviewers.every(identityToken) ||
          new Set(stage.authorizedReviewers.map(r => r.toLowerCase())).size !== stage.authorizedReviewers.length ||
          !REVIEW_STATES.has(stage.reviewState) ||
          typeof stage.reviewHistoryComplete !== 'boolean' ||
          !nonnegInt(stage.outstandingChangesRequested) ||
          (stage.outstandingDismissedReviews !== undefined && !nonnegInt(stage.outstandingDismissedReviews)) ||
          (stage.requireFormalApproval !== undefined && typeof stage.requireFormalApproval !== 'boolean') ||
          (stage.normalizedReviews !== undefined && (!denseDataArray(stage.normalizedReviews, 64) ||
            stage.normalizedReviews.length === 0 ||
            !stage.normalizedReviews.every(r => exactRecord(r, ['reviewer', 'head', 'state']) &&
              identityToken(r.reviewer) && hex40(r.head) && REVIEW_STATES.has(r.state)) ||
            new Set(stage.normalizedReviews.map(r => r.reviewer.toLowerCase())).size !==
              stage.normalizedReviews.length)) ||
          !nonnegInt(stage.unresolvedThreads) || typeof stage.summaryFindingsResolved !== 'boolean') {
        return provenanceFail('INVALID_EVIDENCE', 'INVALID_INDEPENDENT_REVIEW', stageName);
      }
      if (stage.reviewedHeadSha !== commitSha) return provenanceFail('STALE', 'REVIEW_HEAD_MISMATCH', stageName);
      if (stage.reviewHistoryComplete !== true) {
        return provenanceFail('REVIEW', 'REVIEW_HISTORY_INCOMPLETE', stageName);
      }
      const reviewerLower = stage.reviewerIdentity.toLowerCase();
      if (stage.outstandingChangesRequested !== 0 ||
          (stage.normalizedReviews !== undefined &&
            stage.normalizedReviews.some(r => r.state === 'CHANGES_REQUESTED'))) {
        return provenanceFail('REVIEW', 'OUTSTANDING_CHANGES_REQUESTED', stageName);
      }
      if ((stage.outstandingDismissedReviews !== undefined && stage.outstandingDismissedReviews !== 0) ||
          (stage.normalizedReviews !== undefined &&
            stage.normalizedReviews.some(r => r.state === 'DISMISSED'))) {
        return provenanceFail('REVIEW', 'OUTSTANDING_DISMISSED_REVIEW', stageName);
      }
      const authorLower = stage.authorIdentity.toLowerCase();
      const agentLower = stage.implementationAgentIdentity.toLowerCase();
      if (reviewerLower === authorLower || reviewerLower === agentLower) {
        return provenanceFail('REVIEW', 'SELF_REVIEW_FORBIDDEN', stageName);
      }
      const allowlist = new Set(stage.authorizedReviewers.map(r => r.toLowerCase()));
      if (!allowlist.has(reviewerLower)) {
        return provenanceFail('REVIEW', 'UNAUTHORIZED_REVIEWER', stageName);
      }
      if (stage.unresolvedThreads !== 0 || stage.summaryFindingsResolved !== true) {
        return provenanceFail('REVIEW', 'REVIEW_FINDINGS_UNRESOLVED', stageName);
      }
      const formalRequired = repositoryId !== SOFTWARE_FACTORY_REPOSITORY_ID || stage.requireFormalApproval === true;
      const acceptableNormalizedEntry = r => r.state === 'APPROVED' ||
        (!formalRequired && r.state === 'COMMENTED' &&
          COPILOT_BOT_REVIEWERS.has(r.reviewer.toLowerCase()) &&
          allowlist.has(r.reviewer.toLowerCase()) &&
          r.head === commitSha);
      const stateAcceptable = stage.reviewState === 'APPROVED' ||
        (!formalRequired && stage.reviewState === 'COMMENTED' && COPILOT_BOT_REVIEWERS.has(reviewerLower));
      if (!stateAcceptable ||
          (stage.normalizedReviews !== undefined && stage.normalizedReviews.some(r => !acceptableNormalizedEntry(r)))) {
        return provenanceFail('REVIEW', 'REVIEW_NOT_ACCEPTABLE', stageName);
      }
      if (stage.normalizedReviews !== undefined) {
        const selectedEntry = stage.normalizedReviews.find(r => r.reviewer.toLowerCase() === reviewerLower);
        if (!selectedEntry || selectedEntry.head !== commitSha || selectedEntry.state !== stage.reviewState) {
          return provenanceFail('REVIEW', 'REVIEW_HISTORY_INCONSISTENT', stageName);
        }
      }
      if (pendingBranchless !== null && pendingBranchless.some(entry => {
        const by = entry.reviewedBy.toLowerCase();
        return !allowlist.has(by) || by === authorLower || by === agentLower;
      })) {
        return provenanceFail('COVERAGE', 'BRANCHLESS_REVIEWER_UNAUTHORIZED', 'exactHeadValidation');
      }
    } else if (stageName === 'mergeQueueSquash') {
      if (!exactRecord(stage, ['traceparent', 'parentSpanId', 'expectedHeadSha', 'squashCommitSha', 'observedMs']) ||
          !hex40(stage.expectedHeadSha) || !hex40(stage.squashCommitSha)) {
        return provenanceFail('INVALID_EVIDENCE', 'INVALID_MERGE_QUEUE_SQUASH', stageName);
      }
      if (stage.expectedHeadSha !== commitSha) {
        return provenanceFail('STALE', 'MERGE_QUEUE_HEAD_MISMATCH', stageName);
      }
      squashCommitSha = stage.squashCommitSha;
    } else {
      if (!exactRecord(stage, ['traceparent', 'parentSpanId', 'mainCommitSha', 'mainHealthy', 'receiptId', 'observedMs']) ||
          !hex40(stage.mainCommitSha) || typeof stage.mainHealthy !== 'boolean' || !token(stage.receiptId)) {
        return provenanceFail('INVALID_EVIDENCE', 'INVALID_VERIFIED_MAIN', stageName);
      }
      if (stage.mainCommitSha !== squashCommitSha) {
        return provenanceFail('STALE', 'MAIN_COMMIT_MISMATCH', stageName);
      }
      if (stage.mainHealthy !== true) return provenanceFail('CHECKS', 'MAIN_UNHEALTHY', stageName);
    }
  }

  const complete = targetIndex === CANONICAL_PROVENANCE_STAGES.length - 1;
  return Object.freeze({
    shadow: true,
    liveMutation: false,
    valid: true,
    complete,
    inFlight: !complete,
    outcome: 'eligible',
    reason: 'NONE',
    code: complete ? 'PROVENANCE_CHAIN_VERIFIED' : 'IN_FLIGHT_CHAIN_VERIFIED',
    failedStage: null,
    traceId,
    repositoryId,
    deliveryId,
    laneId,
    commitSha,
    squashCommitSha,
    verifiedStageCount: targetIndex + 1,
    lastVerifiedStage: CANONICAL_PROVENANCE_STAGES[targetIndex],
    outOfLanePaths: Object.freeze([])
  });
}

function circuitBreakerDeny(reason, violations, protectedTouchedPaths = [], outOfLanePaths = []) {
  return Object.freeze({
    shadow: true,
    liveMutation: false,
    allowed: false,
    tripKillSwitch: true,
    outcome: 'blocked',
    reason,
    primaryViolation: violations[0],
    violations: Object.freeze([...violations]),
    protectedTouchedPaths: Object.freeze([...protectedTouchedPaths]),
    outOfLanePaths: Object.freeze([...outOfLanePaths])
  });
}

export function evaluateAntiRogueCircuitBreaker(input) {
  if (!exactRecord(input, CIRCUIT_BREAKER_REQUIRED_KEYS, CIRCUIT_BREAKER_OPTIONAL_KEYS)) {
    return circuitBreakerDeny('INVALID_EVIDENCE', ['INVALID_CIRCUIT_BREAKER_INPUT']);
  }
  if (!positiveInt(input.repositoryId) ||
      !denseDataArray(input.ownedPaths, 250) || input.ownedPaths.length === 0 ||
      !denseDataArray(input.touchedPaths, 500) ||
      !nonnegInt(input.attempt) || !nonnegInt(input.maxRetries) ||
      !nonnegInt(input.runAiCredits) || !nonnegInt(input.maxRunAiCredits) ||
      !nonnegInt(input.burnRateBps) || !nonnegInt(input.maxBurnSpikeBps) ||
      !nonnegInt(input.incrementalBilledUsdCents) ||
      typeof input.safeOutputsThreatDetected !== 'boolean') {
    return circuitBreakerDeny('INVALID_EVIDENCE', ['INVALID_CIRCUIT_BREAKER_INPUT']);
  }

  const humanSignOff = input.humanOwnerSignOffVerified === undefined ? false : input.humanOwnerSignOffVerified;
  const selfMerge = input.selfMerge === undefined ? false : input.selfMerge;
  const author = input.authorIdentity === undefined ? null : input.authorIdentity;
  const agent = input.implementationAgentIdentity === undefined ? null : input.implementationAgentIdentity;
  const reviewer = input.reviewerIdentity === undefined ? null : input.reviewerIdentity;
  const mainHealthy = input.mainHealthy === undefined ? null : input.mainHealthy;
  const accountingVerified = input.accountingVerified;
  const isEstimated = input.isEstimated === undefined ? false : input.isEstimated;

  if (typeof humanSignOff !== 'boolean' || typeof selfMerge !== 'boolean' ||
      (accountingVerified !== undefined && typeof accountingVerified !== 'boolean') ||
      typeof isEstimated !== 'boolean' ||
      (mainHealthy !== null && typeof mainHealthy !== 'boolean') ||
      (author === null) !== (reviewer === null) ||
      (author !== null && (!identityToken(author) || !identityToken(reviewer))) ||
      (agent !== null && (reviewer === null || !identityToken(agent)))) {
    return circuitBreakerDeny('INVALID_EVIDENCE', ['INVALID_CIRCUIT_BREAKER_INPUT']);
  }

  if (!input.ownedPaths.every(isSafeRepoRelativePath) ||
      !input.touchedPaths.every(isSafeRepoRelativePath)) {
    return circuitBreakerDeny('SECURITY', ['UNSAFE_PATH_TRAVERSAL']);
  }
  if (new Set(input.ownedPaths).size !== input.ownedPaths.length ||
      new Set(input.touchedPaths).size !== input.touchedPaths.length) {
    return circuitBreakerDeny('INVALID_EVIDENCE', ['DUPLICATE_PATHS']);
  }

  const protectedTouchedPaths = input.touchedPaths.filter(isProtectedControlPlanePath);
  const outOfLanePaths = input.touchedPaths.filter(path => !isWithinOwnedPaths(path, input.ownedPaths));
  const violations = [];

  if (input.safeOutputsThreatDetected === true) {
    violations.push('SAFE_OUTPUTS_THREAT_FLAGGED');
  }
  if ((protectedTouchedPaths.length > 0 || selfMerge === true) && humanSignOff !== true) {
    violations.push('PROTECTED_CONTROL_PLANE_TOUCH');
  }
  if (outOfLanePaths.length > 0) {
    violations.push('OUT_OF_LANE_EDIT');
  }
  if (reviewer !== null && (reviewer.toLowerCase() === author.toLowerCase() ||
      (agent !== null && reviewer.toLowerCase() === agent.toLowerCase()))) {
    violations.push('SELF_APPROVAL_FORBIDDEN');
  }
  if (accountingVerified !== true ||
      isEstimated === true ||
      input.incrementalBilledUsdCents > 0 ||
      input.runAiCredits > input.maxRunAiCredits ||
      input.burnRateBps > input.maxBurnSpikeBps) {
    violations.push('AI_CREDIT_ANOMALY');
  }
  if (input.attempt > input.maxRetries) {
    violations.push('RETRY_CAP_EXCEEDED');
  }
  if (mainHealthy === false) {
    violations.push('POST_MERGE_MAIN_FAILED');
  }

  if (violations.length > 0) {
    return circuitBreakerDeny(
      VIOLATION_REASON_MAP.get(violations[0]),
      violations,
      protectedTouchedPaths,
      outOfLanePaths
    );
  }

  return Object.freeze({
    shadow: true,
    liveMutation: false,
    allowed: true,
    tripKillSwitch: false,
    outcome: 'eligible',
    reason: 'NONE',
    primaryViolation: null,
    violations: Object.freeze([]),
    protectedTouchedPaths: Object.freeze(protectedTouchedPaths),
    outOfLanePaths: Object.freeze([])
  });
}
