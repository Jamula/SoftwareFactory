// Bounded M02.07 metrics- and feedback-driven optimistic improvement generator
// and matched >=5-outcome cohort verification / automatic rollback evaluator.
// Never mutates main or policy directly; deterministic gates stay outside agent loops.
import {types} from 'node:util';
import {KNOWN_VIOLATION_CODES} from './ai-credit-scorecard.mjs';
import {
  CANONICAL_PROVENANCE_STAGES,
  EXACT_PROTECTED_CONTROL_PLANE_PATHS,
  SOFTWARE_FACTORY_REPOSITORY_ID,
  evaluateAntiRogueCircuitBreaker,
  isProtectedControlPlanePath,
  isSafeRepoRelativePath,
  isWithinOwnedPaths,
  verifyCausalProvenanceChain
} from './anti-rogue-audit.mjs';

export const REQUIRED_GATE_PIPELINE = Object.freeze([
  'ci-98-95',
  'codeql',
  'independent-review',
  'squash-merge-queue'
]);

export const MIN_COHORT_ACCEPTED_OUTCOMES = 5;

export const PROPOSAL_SCOPES = Object.freeze([
  'factory-velocity',
  'knowledge-map',
  'enrolled-product'
]);

export const GOVERNED_CONTRACT_DOMAINS = Object.freeze([
  'governance',
  'workflow',
  'policy',
  'security',
  'budget'
]);

export const KNOWN_ROLLBACK_REASONS = Object.freeze([
  'COVERAGE_BELOW_THRESHOLD',
  'COVERAGE_REGRESSED',
  'SECURITY_FINDINGS_DETECTED',
  'MAIN_HEALTH_FAILURE',
  'HUMAN_INTERVENTION_REGRESSED',
  'REWORK_RATE_REGRESSED',
  'AI_CREDIT_COST_REGRESSION'
]);

export const KAIZEN_EVIDENCE_MODES = Object.freeze([
  'pre-cohort-synthetic',
  'github-verified-cohort',
  'live-autonomous-cohort'
]);

export const KAIZEN_COHORT_SOURCES = Object.freeze([
  'synthetic-precohort-replay',
  'github-verified-wave5-outcomes',
  'live-unattended-ghaw-copilot'
]);

const proposalScopeSet = new Set(PROPOSAL_SCOPES);
const governedDomainSet = new Set(GOVERNED_CONTRACT_DOMAINS);
const contractDomainSet = new Set(['standard', ...GOVERNED_CONTRACT_DOMAINS]);
const governedFailureClasses = new Set(['security-contract', 'policy-drift', 'budget-cap', 'workflow-lock']);
const knownViolationSet = new Set(KNOWN_VIOLATION_CODES);
const knownRollbackReasonSet = new Set(KNOWN_ROLLBACK_REASONS);
const kaizenCohortSourceSet = new Set(KAIZEN_COHORT_SOURCES);

const PROPOSAL_INPUT_KEYS = ['scorecard', 'failureTaxonomy', 'feedbackItems', 'knowledgeLanes'];
const LANE_KEYS = ['laneId', 'repositoryId', 'scope', 'ownedPaths'];
const FAILURE_KEYS = [
  'id',
  'repositoryId',
  'laneId',
  'failureClass',
  'occurrences',
  'baselineRateBps',
  'targetRateBps',
  'targetPaths'
];
const FEEDBACK_KEYS = [
  'id',
  'repositoryId',
  'laneId',
  'source',
  'metricName',
  'baselineValue',
  'targetValue',
  'targetPaths'
];
const COHORT_KEYS = [
  'repositoryId',
  'cohortId',
  'sourceKind',
  'complete',
  'windowStartMs',
  'windowEndMs',
  'acceptedOutcomes',
  'coveredLines',
  'totalLines',
  'coveredBranches',
  'totalBranches',
  'securityFindings',
  'mainFailures',
  'routineHumanInterventions',
  'reworkRateBps',
  'aiCreditsTotal',
  'incrementalBilledUsdCents',
  'medianCycleTimeMs'
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
const finiteNonNeg = n => Number.isFinite(n) && n >= 0;
const token = s => typeof s === 'string' && /^[A-Za-z0-9._:-]{1,96}$/.test(s);

const GOVERNED_PREFIX_ANCHORS = [
  ...EXACT_PROTECTED_CONTROL_PLANE_PATHS,
  'CODEOWNERS',
  '.github/CODEOWNERS',
  'docs/CODEOWNERS',
  '.github/github-app.yml',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'NOTICE',
  'VERSION',
  'package.json',
  'package-lock.json',
  'config',
  'agents',
  'tests/engineering-factory/coverage-reporter.mjs',
  'tools/engineering-factory/example-policies.json',
  'tools/engineering-factory/no-python-guard.mjs',
  'tools/engineering-factory/optimistic-improver.mjs',
  'tools/engineering-factory/ai-credit-scorecard.mjs',
  'tools/engineering-factory/review-history.mjs',
  'tools/engineering-factory/review-batch.mjs',
  'tools/engineering-factory/consumer-onboarding.mjs',
  'tools/engineering-factory/pilot-readiness.mjs',
  'tools/engineering-factory/mcp-agent-connector.mjs',
  'tools/engineering-factory/capacity-scale.mjs',
  'tools/engineering-factory/lease-transition.mjs',
  'tools/engineering-factory/dispatch-intent.mjs',
  'tools/engineering-factory/event-envelope.mjs',
  'tools/engineering-coordinator/project-config.mjs',
  'tools/engineering-coordinator/coordinator.mjs',
  'tools/engineering-coordinator/planner.mjs',
  'tools/engineering-coordinator/work-queue-cas.mjs',
  'tools/engineering-coordinator/review-intent-store.mjs',
  'tools/engineering-coordinator/review-provider.mjs',
  '.github/workflows',
  '.github/rulesets'
];

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function touchesGovernedContractPath(path) {
  if (isProtectedControlPlanePath(path)) return true;
  if (GOVERNED_PREFIX_ANCHORS.some(anchor => pathsOverlap(path, anchor))) return true;
  return /(^|\/)(codeowners|governance|policy|security|budget|workflows?)(\/|\.|-|_|$)/i.test(path);
}

function validPathList(paths, maxLen) {
  return denseDataArray(paths, maxLen) && paths.length > 0 &&
    paths.every(isSafeRepoRelativePath) && new Set(paths).size === paths.length;
}

function invalidProposalResult(reason) {
  return Object.freeze({
    valid: false,
    shadow: true,
    directMainMutation: false,
    autoPolicyMutation: false,
    gatePipelineRequired: REQUIRED_GATE_PIPELINE,
    reason,
    proposals: Object.freeze([]),
    deferredByOverlap: Object.freeze([])
  });
}

function validScorecardEnvelope(scorecard) {
  if (!isPlainObject(scorecard) || !hasOwnEnumerableData(scorecard, 'valid') ||
      !hasOwnEnumerableData(scorecard, 'sourceKind') ||
      !hasOwnEnumerableData(scorecard, 'repositoryId') ||
      !hasOwnEnumerableData(scorecard, 'bottlenecks')) {
    return {ok: false, reason: 'INVALID_SCORECARD'};
  }
  if (scorecard.valid !== true || scorecard.sourceKind !== 'verified-autonomous') {
    return {ok: false, reason: 'UNVERIFIED_SCORECARD_SOURCE'};
  }
  if (!positiveInt(scorecard.repositoryId) || !denseDataArray(scorecard.bottlenecks, 64)) {
    return {ok: false, reason: 'INVALID_SCORECARD'};
  }
  for (const item of scorecard.bottlenecks) {
    if (!isPlainObject(item) || !hasOwnEnumerableData(item, 'id') || !token(item.id) ||
        !hasOwnEnumerableData(item, 'suggestedScope') || !proposalScopeSet.has(item.suggestedScope) ||
        !hasOwnEnumerableData(item, 'metric') || !token(item.metric) ||
        !hasOwnEnumerableData(item, 'observedValue') || !finiteNonNeg(item.observedValue) ||
        !hasOwnEnumerableData(item, 'thresholdValue') || !finiteNonNeg(item.thresholdValue) ||
        !hasOwnEnumerableData(item, 'severityScore') || !positiveInt(item.severityScore)) {
      return {ok: false, reason: 'INVALID_SCORECARD_BOTTLENECK'};
    }
  }
  return {ok: true};
}

export function proposeOptimisticImprovements(input) {
  if (!exactRecord(input, PROPOSAL_INPUT_KEYS, ['maxProposals'])) {
    return invalidProposalResult('INVALID_IMPROVEMENT_INPUT');
  }
  const maxProposals = input.maxProposals === undefined ? 10 : input.maxProposals;
  if (!positiveInt(maxProposals) || maxProposals > 50 ||
      !denseDataArray(input.knowledgeLanes, 128) || input.knowledgeLanes.length === 0 ||
      !denseDataArray(input.failureTaxonomy, 128) ||
      !denseDataArray(input.feedbackItems, 128)) {
    return invalidProposalResult('INVALID_IMPROVEMENT_INPUT');
  }

  const scCheck = validScorecardEnvelope(input.scorecard);
  if (!scCheck.ok) return invalidProposalResult(scCheck.reason);

  const laneMap = new Map();
  for (const lane of input.knowledgeLanes) {
    if (!exactRecord(lane, LANE_KEYS, ['contractDomain']) ||
        !token(lane.laneId) || !positiveInt(lane.repositoryId) ||
        !proposalScopeSet.has(lane.scope) || !validPathList(lane.ownedPaths, 64)) {
      return invalidProposalResult('INVALID_KNOWLEDGE_LANE');
    }
    const domain = lane.contractDomain === undefined ? 'standard' : lane.contractDomain;
    if (!contractDomainSet.has(domain)) return invalidProposalResult('INVALID_KNOWLEDGE_LANE');
    const laneKey = `${lane.repositoryId}:${lane.laneId}`;
    if (laneMap.has(laneKey)) return invalidProposalResult('DUPLICATE_KNOWLEDGE_LANE');
    laneMap.set(laneKey, {...lane, contractDomain: domain});
  }

  const candidates = [];

  for (const bottleneck of input.scorecard.bottlenecks) {
    const matchingLane = input.knowledgeLanes.find(
      lane => lane.repositoryId === input.scorecard.repositoryId && lane.scope === bottleneck.suggestedScope
    );
    if (!matchingLane) continue;
    const resolvedLane = laneMap.get(`${matchingLane.repositoryId}:${matchingLane.laneId}`);
    const targetPaths = [...resolvedLane.ownedPaths];
    const requiresHumanApproval = governedDomainSet.has(resolvedLane.contractDomain) ||
      targetPaths.some(touchesGovernedContractPath);
    const direction = bottleneck.observedValue > bottleneck.thresholdValue ? 'decrease' : 'increase';
    candidates.push({
      proposalId: `bottleneck:${input.scorecard.repositoryId}:${bottleneck.id}`,
      repositoryId: input.scorecard.repositoryId,
      scope: resolvedLane.scope,
      laneId: resolvedLane.laneId,
      targetPaths,
      sourceSignal: 'scorecard-bottleneck',
      baselineMetric: Object.freeze({
        metric: bottleneck.metric,
        value: bottleneck.observedValue,
        threshold: bottleneck.thresholdValue
      }),
      targetHypothesis: Object.freeze({
        metric: bottleneck.metric,
        baselineValue: bottleneck.observedValue,
        targetValue: bottleneck.thresholdValue,
        expectedDirection: direction,
        minComparableOutcomes: MIN_COHORT_ACCEPTED_OUTCOMES
      }),
      requiresHumanApproval,
      priorityScore: bottleneck.severityScore
    });
  }

  const seenFailureIds = new Set();
  for (const item of input.failureTaxonomy) {
    if (!exactRecord(item, FAILURE_KEYS, ['touchesContract']) ||
        !token(item.id) || !positiveInt(item.repositoryId) || !token(item.laneId) ||
        !token(item.failureClass) || !positiveInt(item.occurrences) ||
        !nonnegInt(item.baselineRateBps) || item.baselineRateBps > 10000 ||
        !nonnegInt(item.targetRateBps) || item.targetRateBps >= item.baselineRateBps ||
        !validPathList(item.targetPaths, 32) ||
        (item.touchesContract !== undefined && typeof item.touchesContract !== 'boolean')) {
      return invalidProposalResult('INVALID_FAILURE_TAXONOMY_ITEM');
    }
    if (seenFailureIds.has(item.id)) return invalidProposalResult('DUPLICATE_FAILURE_ITEM');
    seenFailureIds.add(item.id);
    const lane = laneMap.get(`${item.repositoryId}:${item.laneId}`);
    if (!lane) return invalidProposalResult('UNKNOWN_PROPOSAL_LANE');
    if (item.targetPaths.some(path => !isWithinOwnedPaths(path, lane.ownedPaths))) {
      return invalidProposalResult('OUT_OF_LANE_PROPOSAL_TARGET');
    }
    if (item.occurrences < 2) continue;

    const requiresHumanApproval = item.touchesContract === true ||
      governedFailureClasses.has(item.failureClass) ||
      governedDomainSet.has(lane.contractDomain) ||
      item.targetPaths.some(touchesGovernedContractPath);
    candidates.push({
      proposalId: `failure:${item.repositoryId}:${item.id}`,
      repositoryId: item.repositoryId,
      scope: lane.scope,
      laneId: lane.laneId,
      targetPaths: [...item.targetPaths],
      sourceSignal: 'failure-taxonomy',
      baselineMetric: Object.freeze({
        metric: `${item.failureClass}:rateBps`,
        value: item.baselineRateBps,
        threshold: item.targetRateBps
      }),
      targetHypothesis: Object.freeze({
        metric: `${item.failureClass}:rateBps`,
        baselineValue: item.baselineRateBps,
        targetValue: item.targetRateBps,
        expectedDirection: 'decrease',
        minComparableOutcomes: MIN_COHORT_ACCEPTED_OUTCOMES
      }),
      requiresHumanApproval,
      priorityScore: Math.min(999, 400 + item.occurrences * 25)
    });
  }

  const seenFeedbackIds = new Set();
  for (const item of input.feedbackItems) {
    if (!exactRecord(item, FEEDBACK_KEYS, ['touchesContract']) ||
        !token(item.id) || !positiveInt(item.repositoryId) || !token(item.laneId) ||
        (item.source !== 'operator' && item.source !== 'product') ||
        !token(item.metricName) || !finiteNonNeg(item.baselineValue) ||
        !finiteNonNeg(item.targetValue) || item.baselineValue === item.targetValue ||
        !validPathList(item.targetPaths, 32) ||
        (item.touchesContract !== undefined && typeof item.touchesContract !== 'boolean')) {
      return invalidProposalResult('INVALID_FEEDBACK_ITEM');
    }
    if (seenFeedbackIds.has(item.id)) return invalidProposalResult('DUPLICATE_FEEDBACK_ITEM');
    seenFeedbackIds.add(item.id);
    const lane = laneMap.get(`${item.repositoryId}:${item.laneId}`);
    if (!lane) return invalidProposalResult('UNKNOWN_PROPOSAL_LANE');
    if (item.targetPaths.some(path => !isWithinOwnedPaths(path, lane.ownedPaths))) {
      return invalidProposalResult('OUT_OF_LANE_PROPOSAL_TARGET');
    }

    const requiresHumanApproval = item.touchesContract === true ||
      governedDomainSet.has(lane.contractDomain) ||
      item.targetPaths.some(touchesGovernedContractPath);
    const direction = item.targetValue < item.baselineValue ? 'decrease' : 'increase';
    candidates.push({
      proposalId: `feedback:${item.repositoryId}:${item.id}`,
      repositoryId: item.repositoryId,
      scope: lane.scope,
      laneId: lane.laneId,
      targetPaths: [...item.targetPaths],
      sourceSignal: `${item.source}-feedback`,
      baselineMetric: Object.freeze({
        metric: item.metricName,
        value: item.baselineValue,
        threshold: item.targetValue
      }),
      targetHypothesis: Object.freeze({
        metric: item.metricName,
        baselineValue: item.baselineValue,
        targetValue: item.targetValue,
        expectedDirection: direction,
        minComparableOutcomes: MIN_COHORT_ACCEPTED_OUTCOMES
      }),
      requiresHumanApproval,
      priorityScore: item.source === 'operator' ? 550 : 480
    });
  }

  candidates.sort((a, b) =>
    b.priorityScore - a.priorityScore ||
    a.repositoryId - b.repositoryId ||
    a.proposalId.localeCompare(b.proposalId)
  );

  const reservedLanes = new Map();
  const reservedPaths = new Map();
  const proposals = [];
  const deferredByOverlap = [];

  for (const candidate of candidates) {
    const repoLanes = reservedLanes.get(candidate.repositoryId) ?? new Set();
    const repoPaths = reservedPaths.get(candidate.repositoryId) ?? [];
    const overlapsExisting = repoLanes.has(candidate.laneId) ||
      candidate.targetPaths.some(path => repoPaths.some(existing => pathsOverlap(path, existing)));

    if (overlapsExisting) {
      deferredByOverlap.push(Object.freeze({
        proposalId: candidate.proposalId,
        repositoryId: candidate.repositoryId,
        laneId: candidate.laneId,
        reason: 'NON_OVERLAPPING_LANE_CONFLICT'
      }));
      continue;
    }

    if (proposals.length >= maxProposals) {
      deferredByOverlap.push(Object.freeze({
        proposalId: candidate.proposalId,
        repositoryId: candidate.repositoryId,
        laneId: candidate.laneId,
        reason: 'PROPOSAL_BUDGET_REACHED'
      }));
      continue;
    }

    repoLanes.add(candidate.laneId);
    reservedLanes.set(candidate.repositoryId, repoLanes);
    repoPaths.push(...candidate.targetPaths);
    reservedPaths.set(candidate.repositoryId, repoPaths);

    proposals.push(Object.freeze({
      proposalId: candidate.proposalId,
      deliveryKind: candidate.requiresHumanApproval ? 'human-approved-pr-proposal' : 'candidate-pr-proposal',
      repositoryId: candidate.repositoryId,
      scope: candidate.scope,
      laneId: candidate.laneId,
      targetPaths: Object.freeze(candidate.targetPaths),
      sourceSignal: candidate.sourceSignal,
      baselineMetric: candidate.baselineMetric,
      targetHypothesis: candidate.targetHypothesis,
      requiresHumanApproval: candidate.requiresHumanApproval,
      directMainMutation: false,
      autoPolicyMutation: false,
      gatePipelineRequired: REQUIRED_GATE_PIPELINE,
      priorityScore: candidate.priorityScore
    }));
  }

  return Object.freeze({
    valid: true,
    shadow: true,
    directMainMutation: false,
    autoPolicyMutation: false,
    gatePipelineRequired: REQUIRED_GATE_PIPELINE,
    reason: 'PROPOSALS_GENERATED',
    proposals: Object.freeze(proposals),
    deferredByOverlap: Object.freeze(deferredByOverlap)
  });
}

const validCohortId = s => typeof s === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(s);

function validUniquePositiveIntList(values, maxLen) {
  return denseDataArray(values, maxLen) &&
    values.every(positiveInt) &&
    new Set(values).size === values.length;
}

function validCohortRecord(cohort, requireNullAiCredits = false) {
  if (!exactRecord(cohort, COHORT_KEYS, ['distinctIssueNumbers', 'mergedPullNumbers']) ||
      !positiveInt(cohort.repositoryId) ||
      !validCohortId(cohort.cohortId) ||
      cohort.sourceKind !== 'verified-autonomous' ||
      cohort.complete !== true ||
      !nonnegInt(cohort.windowStartMs) || !nonnegInt(cohort.windowEndMs) ||
      cohort.windowEndMs <= cohort.windowStartMs ||
      !nonnegInt(cohort.acceptedOutcomes) ||
      !nonnegInt(cohort.coveredLines) || !positiveInt(cohort.totalLines) ||
      cohort.coveredLines > cohort.totalLines || cohort.totalLines > 100000000 ||
      !nonnegInt(cohort.coveredBranches) || !positiveInt(cohort.totalBranches) ||
      cohort.coveredBranches > cohort.totalBranches || cohort.totalBranches > 100000000 ||
      !nonnegInt(cohort.securityFindings) ||
      !nonnegInt(cohort.mainFailures) ||
      !nonnegInt(cohort.routineHumanInterventions) ||
      !nonnegInt(cohort.reworkRateBps) ||
      (requireNullAiCredits ? cohort.aiCreditsTotal !== null : !nonnegInt(cohort.aiCreditsTotal)) ||
      !nonnegInt(cohort.incrementalBilledUsdCents) ||
      !positiveInt(cohort.medianCycleTimeMs)) {
    return false;
  }
  if (hasOwnEnumerableData(cohort, 'distinctIssueNumbers') &&
      (!validUniquePositiveIntList(cohort.distinctIssueNumbers, 500) ||
        cohort.distinctIssueNumbers.length !== cohort.acceptedOutcomes)) {
    return false;
  }
  if (hasOwnEnumerableData(cohort, 'mergedPullNumbers') &&
      (!validUniquePositiveIntList(cohort.mergedPullNumbers, 500) ||
        (cohort.acceptedOutcomes === 0
          ? cohort.mergedPullNumbers.length !== 0
          : cohort.mergedPullNumbers.length < cohort.acceptedOutcomes))) {
    return false;
  }
  return true;
}

function resolveRollbackPolicy(raw, repositoryId) {
  const isFactory = repositoryId === SOFTWARE_FACTORY_REPOSITORY_ID;
  if (raw === undefined) {
    return {
      ok: true,
      profile: 'software-factory',
      minLinePercent: 98,
      minBranchPercent: 95,
      maxReworkRegressionBps: 0,
      maxAiCreditIncreaseBps: 0
    };
  }
  if (!exactRecord(raw, [], [
    'profile',
    'minLinePercent',
    'minBranchPercent',
    'maxReworkRegressionBps',
    'maxAiCreditIncreaseBps'
  ])) {
    return {ok: false};
  }
  const profile = raw.profile === undefined ? 'software-factory' : raw.profile;
  if (profile !== 'software-factory' && profile !== 'consumer') return {ok: false};
  if (isFactory && profile !== 'software-factory') return {ok: false};
  const floorLine = isFactory || profile === 'software-factory' ? 98 : 95;
  const floorBranch = isFactory || profile === 'software-factory' ? 95 : 90;
  const minLinePercent = raw.minLinePercent === undefined ? floorLine : raw.minLinePercent;
  const minBranchPercent = raw.minBranchPercent === undefined ? floorBranch : raw.minBranchPercent;
  const maxReworkRegressionBps = raw.maxReworkRegressionBps === undefined ? 0 : raw.maxReworkRegressionBps;
  const maxAiCreditIncreaseBps = raw.maxAiCreditIncreaseBps === undefined ? 0 : raw.maxAiCreditIncreaseBps;

  if (!Number.isFinite(minLinePercent) || minLinePercent < floorLine || minLinePercent > 100 ||
      !Number.isFinite(minBranchPercent) || minBranchPercent < floorBranch || minBranchPercent > 100 ||
      !nonnegInt(maxReworkRegressionBps) || maxReworkRegressionBps > 10000 ||
      !nonnegInt(maxAiCreditIncreaseBps) || maxAiCreditIncreaseBps > 10000) {
    return {ok: false};
  }
  return {
    ok: true,
    profile,
    minLinePercent,
    minBranchPercent,
    maxReworkRegressionBps,
    maxAiCreditIncreaseBps
  };
}

function invalidCohortResponse(reason) {
  return Object.freeze({
    valid: false,
    shadow: true,
    status: 'INVALID_COHORT_EVIDENCE',
    reason,
    cohortComplete: false,
    verifiedImprovement: false,
    rollbackRequired: false,
    rollbackReasons: Object.freeze([])
  });
}

export function verifyCohortImprovementOrRollback(input) {
  if (!exactRecord(input, ['beforeCohort', 'afterCohort'], ['policy', 'cohortSource'])) {
    return invalidCohortResponse('INVALID_INPUT');
  }
  const hasCohortSource = hasOwnEnumerableData(input, 'cohortSource');
  if (hasCohortSource && !kaizenCohortSourceSet.has(input.cohortSource)) {
    return invalidCohortResponse('INVALID_COHORT_SOURCE');
  }
  const requireNullAiCredits = hasCohortSource && input.cohortSource === 'github-verified-wave5-outcomes';
  if (requireNullAiCredits &&
      isPlainObject(input.beforeCohort) && isPlainObject(input.afterCohort) &&
      ((hasOwnEnumerableData(input.beforeCohort, 'aiCreditsTotal') &&
          nonnegInt(input.beforeCohort.aiCreditsTotal)) ||
        (hasOwnEnumerableData(input.afterCohort, 'aiCreditsTotal') &&
          nonnegInt(input.afterCohort.aiCreditsTotal)))) {
    return invalidCohortResponse('UNMEASURED_AI_CREDITS_MUST_BE_NULL');
  }
  if (!validCohortRecord(input.beforeCohort, requireNullAiCredits) ||
      !validCohortRecord(input.afterCohort, requireNullAiCredits)) {
    return invalidCohortResponse('INVALID_COHORT_RECORD');
  }
  const {beforeCohort, afterCohort} = input;
  const hasBeforeIssues = hasOwnEnumerableData(beforeCohort, 'distinctIssueNumbers');
  const hasBeforePulls = hasOwnEnumerableData(beforeCohort, 'mergedPullNumbers');
  if (hasBeforeIssues !== hasOwnEnumerableData(afterCohort, 'distinctIssueNumbers') ||
      hasBeforePulls !== hasOwnEnumerableData(afterCohort, 'mergedPullNumbers')) {
    return invalidCohortResponse('COHORT_METADATA_MISMATCH');
  }
  if (beforeCohort.repositoryId !== afterCohort.repositoryId ||
      beforeCohort.cohortId !== afterCohort.cohortId) {
    return invalidCohortResponse('COHORT_MISMATCH');
  }
  if (hasBeforePulls &&
      beforeCohort.mergedPullNumbers.some(pr => afterCohort.mergedPullNumbers.includes(pr))) {
    return invalidCohortResponse('OVERLAPPING_COHORT_PULL_NUMBERS');
  }
  if (beforeCohort.windowEndMs > afterCohort.windowStartMs ||
      beforeCohort.windowEndMs - beforeCohort.windowStartMs !==
      afterCohort.windowEndMs - afterCohort.windowStartMs) {
    return invalidCohortResponse('WINDOWS_NOT_COMPARABLE');
  }
  const policy = resolveRollbackPolicy(input.policy, beforeCohort.repositoryId);
  if (!policy.ok) {
    return invalidCohortResponse('INVALID_POLICY');
  }
  if (beforeCohort.coveredLines * 100 < policy.minLinePercent * beforeCohort.totalLines ||
      beforeCohort.coveredBranches * 100 < policy.minBranchPercent * beforeCohort.totalBranches) {
    return invalidCohortResponse('BASELINE_COVERAGE_BELOW_THRESHOLD');
  }

  const provenanceMeta = {
    ...(hasCohortSource ? {cohortSource: input.cohortSource} : {}),
    ...(hasBeforeIssues
      ? {
          beforeDistinctIssues: beforeCohort.distinctIssueNumbers.length,
          afterDistinctIssues: afterCohort.distinctIssueNumbers.length
        }
      : {})
  };

  if (beforeCohort.acceptedOutcomes < MIN_COHORT_ACCEPTED_OUTCOMES ||
      afterCohort.acceptedOutcomes < MIN_COHORT_ACCEPTED_OUTCOMES) {
    return Object.freeze({
      valid: true,
      shadow: true,
      status: 'INSUFFICIENT_COHORT',
      repositoryId: beforeCohort.repositoryId,
      cohortId: beforeCohort.cohortId,
      cohortComplete: false,
      verifiedImprovement: false,
      rollbackRequired: false,
      minimumRequiredOutcomes: MIN_COHORT_ACCEPTED_OUTCOMES,
      beforeAcceptedOutcomes: beforeCohort.acceptedOutcomes,
      afterAcceptedOutcomes: afterCohort.acceptedOutcomes,
      rollbackReasons: Object.freeze([]),
      ...provenanceMeta
    });
  }

  const rollbackReasons = [];

  if (afterCohort.coveredLines * 100 < policy.minLinePercent * afterCohort.totalLines ||
      afterCohort.coveredBranches * 100 < policy.minBranchPercent * afterCohort.totalBranches) {
    rollbackReasons.push('COVERAGE_BELOW_THRESHOLD');
  }
  if (BigInt(afterCohort.coveredLines) * BigInt(beforeCohort.totalLines) <
      BigInt(beforeCohort.coveredLines) * BigInt(afterCohort.totalLines) ||
      BigInt(afterCohort.coveredBranches) * BigInt(beforeCohort.totalBranches) <
      BigInt(beforeCohort.coveredBranches) * BigInt(afterCohort.totalBranches)) {
    rollbackReasons.push('COVERAGE_REGRESSED');
  }
  if (afterCohort.securityFindings > 0) {
    rollbackReasons.push('SECURITY_FINDINGS_DETECTED');
  }
  if (afterCohort.mainFailures > 0) {
    rollbackReasons.push('MAIN_HEALTH_FAILURE');
  }
  if (afterCohort.routineHumanInterventions > beforeCohort.routineHumanInterventions ||
      BigInt(afterCohort.routineHumanInterventions) * BigInt(beforeCohort.acceptedOutcomes) >
      BigInt(beforeCohort.routineHumanInterventions) * BigInt(afterCohort.acceptedOutcomes)) {
    rollbackReasons.push('HUMAN_INTERVENTION_REGRESSED');
  }
  if (BigInt(afterCohort.reworkRateBps) >
      BigInt(beforeCohort.reworkRateBps) + BigInt(policy.maxReworkRegressionBps)) {
    rollbackReasons.push('REWORK_RATE_REGRESSED');
  }
  if (afterCohort.incrementalBilledUsdCents > 0 ||
      (!requireNullAiCredits &&
        BigInt(afterCohort.aiCreditsTotal) * BigInt(beforeCohort.acceptedOutcomes) * 10000n >
          BigInt(beforeCohort.aiCreditsTotal) * BigInt(afterCohort.acceptedOutcomes) *
          BigInt(10000 + policy.maxAiCreditIncreaseBps))) {
    rollbackReasons.push('AI_CREDIT_COST_REGRESSION');
  }

  const aiCreditsPerOutcomeDelta = requireNullAiCredits
    ? null
    : afterCohort.aiCreditsTotal / afterCohort.acceptedOutcomes -
      beforeCohort.aiCreditsTotal / beforeCohort.acceptedOutcomes;
  const metricsDelta = Object.freeze({
    medianCycleTimeDeltaMs: afterCohort.medianCycleTimeMs - beforeCohort.medianCycleTimeMs,
    reworkRateDeltaBps: afterCohort.reworkRateBps - beforeCohort.reworkRateBps,
    aiCreditsPerOutcomeDelta
  });

  if (rollbackReasons.length > 0) {
    return Object.freeze({
      valid: true,
      shadow: true,
      status: 'ROLLBACK_REQUIRED',
      repositoryId: beforeCohort.repositoryId,
      cohortId: beforeCohort.cohortId,
      cohortComplete: true,
      verifiedImprovement: false,
      rollbackRequired: true,
      rollbackReasons: Object.freeze(rollbackReasons),
      metricsDelta,
      ...provenanceMeta
    });
  }

  const improved =
    afterCohort.medianCycleTimeMs < beforeCohort.medianCycleTimeMs ||
    afterCohort.reworkRateBps < beforeCohort.reworkRateBps ||
    (!requireNullAiCredits &&
      BigInt(afterCohort.aiCreditsTotal) * BigInt(beforeCohort.acceptedOutcomes) <
        BigInt(beforeCohort.aiCreditsTotal) * BigInt(afterCohort.acceptedOutcomes));

  return Object.freeze({
    valid: true,
    shadow: true,
    status: improved ? 'VERIFIED_IMPROVEMENT' : 'NO_MATERIAL_GAIN',
    repositoryId: beforeCohort.repositoryId,
    cohortId: beforeCohort.cohortId,
    cohortComplete: true,
    verifiedImprovement: improved,
    rollbackRequired: false,
    rollbackReasons: Object.freeze([]),
    metricsDelta,
    ...provenanceMeta
  });
}

const MAX_AUDIT_CHAINS = 5000;
const AUDIT_FILTER_OPTIONAL_KEYS = [
  'traceId',
  'deliveryId',
  'issueNumber',
  'pullNumber',
  'commitSha',
  'squashCommitSha',
  'violationCode'
];
const AUDIT_CHAIN_OPTIONAL_KEYS = [
  'allowInFlightUpToStage',
  'coveragePolicy',
  'issueNumber',
  'pullNumber',
  'violations',
  'circuitBreaker',
  'governanceAttestation'
];
const GOVERNANCE_ATTESTATION_KEYS = [
  'repositoryId',
  'ownedPaths',
  'touchedPaths',
  'attempt',
  'maxRetries',
  'incrementalBilledUsdCents',
  'safeOutputsThreatDetected',
  'humanOwnerSignOffVerified',
  'authorIdentity',
  'implementationAgentIdentity',
  'reviewerIdentity',
  'mainHealthy',
  'accountingVerified'
];
const COMPLETED_VERDICT_REQUIRED_KEYS = [
  'valid',
  'status',
  'cohortComplete',
  'verifiedImprovement',
  'rollbackRequired',
  'rollbackReasons'
];
const COMPLETED_VERDICT_OPTIONAL_KEYS = [
  'shadow',
  'repositoryId',
  'cohortId',
  'metricsDelta',
  'cohortSource',
  'beforeDistinctIssues',
  'afterDistinctIssues'
];
const INSUFFICIENT_VERDICT_REQUIRED_KEYS = [
  'valid',
  'status',
  'cohortComplete',
  'verifiedImprovement',
  'rollbackRequired',
  'minimumRequiredOutcomes',
  'beforeAcceptedOutcomes',
  'afterAcceptedOutcomes',
  'rollbackReasons'
];
const INSUFFICIENT_VERDICT_OPTIONAL_KEYS = [
  'shadow',
  'repositoryId',
  'cohortId',
  'cohortSource',
  'beforeDistinctIssues',
  'afterDistinctIssues'
];
const CANDIDATE_META_REQUIRED_KEYS = ['proposalId', 'repositoryId', 'laneId', 'targetPaths'];
const CANDIDATE_META_OPTIONAL_KEYS = [
  'targetRevertCommitSha',
  'squashCommitSha',
  'ownedPaths',
  'touchedPaths',
  'provenanceChain',
  'scope',
  'contractDomain',
  'touchesContract',
  'requiresHumanApproval',
  'cohortId',
  'cohortSource',
  'pullNumber',
  'issueNumber'
];

const hex32NonZero = s => typeof s === 'string' && /^(?!0{32})[0-9a-f]{32}$/.test(s);
const hex40 = s => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
const auditToken = s => typeof s === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(s);

function samePathSet(left, right) {
  return left.length === right.length && left.every(item => right.includes(item));
}

function isDeepPlainData(value, depth = 0, budget = {remaining: 5000}) {
  if (types.isProxy(value)) return false;
  budget.remaining -= 1;
  if (budget.remaining < 0 || depth > 12) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    if (!denseDataArray(value, 1000)) return false;
    return value.every(item => isDeepPlainData(item, depth + 1, budget));
  }
  if (!isPlainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length > 128) return false;
  return keys.every(
    key => typeof key === 'string' &&
      hasOwnEnumerableData(value, key) &&
      isDeepPlainData(value[key], depth + 1, budget)
  );
}

function invalidAuditQueryResult(reason, repositoryId = null) {
  return Object.freeze({
    valid: false,
    shadow: true,
    liveMutation: false,
    readOnly: true,
    reason,
    repositoryId,
    totalRepositoryChains: 0,
    isolatedOutCount: 0,
    matchCount: 0,
    records: Object.freeze([])
  });
}

function parseAuditFilter(filter) {
  if (!isPlainObject(filter)) {
    return {ok: false, reason: 'INVALID_AUDIT_FILTER', repositoryId: null};
  }
  if (!hasOwnEnumerableData(filter, 'repositoryId')) {
    return {ok: false, reason: 'MISSING_REPOSITORY_ID', repositoryId: null};
  }
  if (!exactRecord(filter, ['repositoryId'], AUDIT_FILTER_OPTIONAL_KEYS) ||
      !positiveInt(filter.repositoryId)) {
    return {ok: false, reason: 'INVALID_AUDIT_FILTER', repositoryId: null};
  }
  const repositoryId = filter.repositoryId;
  const hasTraceId = hasOwnEnumerableData(filter, 'traceId');
  const hasDeliveryId = hasOwnEnumerableData(filter, 'deliveryId');
  const hasIssueNumber = hasOwnEnumerableData(filter, 'issueNumber');
  const hasPullNumber = hasOwnEnumerableData(filter, 'pullNumber');
  const hasCommitSha = hasOwnEnumerableData(filter, 'commitSha');
  const hasSquashCommitSha = hasOwnEnumerableData(filter, 'squashCommitSha');
  const hasViolationCode = hasOwnEnumerableData(filter, 'violationCode');

  if ((hasTraceId && !hex32NonZero(filter.traceId)) ||
      (hasDeliveryId && !auditToken(filter.deliveryId)) ||
      (hasIssueNumber && !positiveInt(filter.issueNumber)) ||
      (hasPullNumber && !positiveInt(filter.pullNumber)) ||
      (hasCommitSha && !hex40(filter.commitSha)) ||
      (hasSquashCommitSha && !hex40(filter.squashCommitSha)) ||
      (hasViolationCode && !knownViolationSet.has(filter.violationCode))) {
    return {ok: false, reason: 'INVALID_AUDIT_FILTER', repositoryId};
  }

  return {
    ok: true,
    repositoryId,
    traceId: hasTraceId ? filter.traceId : null,
    deliveryId: hasDeliveryId ? filter.deliveryId : null,
    issueNumber: hasIssueNumber ? filter.issueNumber : null,
    pullNumber: hasPullNumber ? filter.pullNumber : null,
    commitSha: hasCommitSha ? filter.commitSha : null,
    squashCommitSha: hasSquashCommitSha ? filter.squashCommitSha : null,
    violationCode: hasViolationCode ? filter.violationCode : null
  };
}

function circuitBreakerMatchesLineage(cbInput, stages, repositoryId) {
  if (cbInput.repositoryId !== repositoryId ||
      !samePathSet(cbInput.ownedPaths, stages.casLease.ownedPaths) ||
      !samePathSet(cbInput.touchedPaths, stages.candidateCommit.touchedPaths)) {
    return false;
  }
  const review = stages.independentReview;
  if (hasOwnEnumerableData(cbInput, 'authorIdentity') &&
      (typeof cbInput.authorIdentity !== 'string' ||
        cbInput.authorIdentity.toLowerCase() !== review.authorIdentity.toLowerCase())) {
    return false;
  }
  if (hasOwnEnumerableData(cbInput, 'implementationAgentIdentity') &&
      (typeof cbInput.implementationAgentIdentity !== 'string' ||
        cbInput.implementationAgentIdentity.toLowerCase() !==
        review.implementationAgentIdentity.toLowerCase())) {
    return false;
  }
  if (hasOwnEnumerableData(cbInput, 'reviewerIdentity') &&
      (typeof cbInput.reviewerIdentity !== 'string' ||
        cbInput.reviewerIdentity.toLowerCase() !== review.reviewerIdentity.toLowerCase())) {
    return false;
  }
  if (hasOwnEnumerableData(cbInput, 'mainHealthy') &&
      (typeof cbInput.mainHealthy !== 'boolean' ||
        cbInput.mainHealthy !== stages.verifiedMain.mainHealthy)) {
    return false;
  }
  return true;
}

export function queryCausalAuditTrail(chains, filter) {
  const parsedFilter = parseAuditFilter(filter);
  if (!parsedFilter.ok) {
    return invalidAuditQueryResult(parsedFilter.reason, parsedFilter.repositoryId);
  }
  if (!denseDataArray(chains, MAX_AUDIT_CHAINS)) {
    return invalidAuditQueryResult('INVALID_AUDIT_CHAINS', parsedFilter.repositoryId);
  }

  const seenTraceIds = new Set();
  const seenCommitShas = new Set();
  const seenSquashShas = new Set();
  const seenPullNumbers = new Set();
  const matchedRecords = [];
  let totalRepositoryChains = 0;
  let isolatedOutCount = 0;

  for (const entry of chains) {
    if (!exactRecord(entry, ['stages'], AUDIT_CHAIN_OPTIONAL_KEYS) ||
        !isPlainObject(entry.stages) ||
        !hasOwnEnumerableData(entry.stages, 'eventDelivery') ||
        !isPlainObject(entry.stages.eventDelivery) ||
        !hasOwnEnumerableData(entry.stages.eventDelivery, 'repositoryId') ||
        !positiveInt(entry.stages.eventDelivery.repositoryId)) {
      return invalidAuditQueryResult('INVALID_AUDIT_CHAIN_ENTRY', parsedFilter.repositoryId);
    }

    if (entry.stages.eventDelivery.repositoryId !== parsedFilter.repositoryId) {
      if (!isDeepPlainData(entry)) {
        return invalidAuditQueryResult('INVALID_AUDIT_CHAIN_ENTRY', parsedFilter.repositoryId);
      }
      isolatedOutCount++;
      continue;
    }

    const hasIssueNumber = hasOwnEnumerableData(entry, 'issueNumber');
    const hasPullNumber = hasOwnEnumerableData(entry, 'pullNumber');
    const hasViolations = hasOwnEnumerableData(entry, 'violations');

    if ((hasIssueNumber && !positiveInt(entry.issueNumber)) ||
        (hasPullNumber && !positiveInt(entry.pullNumber)) ||
        (hasViolations && (!denseDataArray(entry.violations, 16) ||
          !entry.violations.every(code => knownViolationSet.has(code)) ||
          new Set(entry.violations).size !== entry.violations.length))) {
      return invalidAuditQueryResult('INVALID_AUDIT_CHAIN_ENTRY', parsedFilter.repositoryId);
    }

    const issueNumber = hasIssueNumber ? entry.issueNumber : null;
    const pullNumber = hasPullNumber ? entry.pullNumber : null;
    const declaredViolations = hasViolations ? entry.violations : null;

    const chainPayload = {
      stages: entry.stages,
      ...(hasOwnEnumerableData(entry, 'allowInFlightUpToStage')
        ? {allowInFlightUpToStage: entry.allowInFlightUpToStage}
        : {}),
      ...(hasOwnEnumerableData(entry, 'coveragePolicy')
        ? {coveragePolicy: entry.coveragePolicy}
        : {})
    };
    const provenance = verifyCausalProvenanceChain(chainPayload);
    if (!provenance.valid) {
      return invalidAuditQueryResult('UNVERIFIED_PROVENANCE_CHAIN', parsedFilter.repositoryId);
    }
    if (!provenance.complete) {
      return invalidAuditQueryResult('INCOMPLETE_PROVENANCE_CHAIN', parsedFilter.repositoryId);
    }

    if (seenTraceIds.has(provenance.traceId)) {
      return invalidAuditQueryResult('DUPLICATE_TRACE_ID', parsedFilter.repositoryId);
    }
    seenTraceIds.add(provenance.traceId);

    if (seenCommitShas.has(provenance.commitSha)) {
      return invalidAuditQueryResult('DUPLICATE_COMMIT_SHA', parsedFilter.repositoryId);
    }
    seenCommitShas.add(provenance.commitSha);

    if (seenSquashShas.has(provenance.squashCommitSha)) {
      return invalidAuditQueryResult('DUPLICATE_SQUASH_COMMIT_SHA', parsedFilter.repositoryId);
    }
    seenSquashShas.add(provenance.squashCommitSha);

    if (pullNumber !== null) {
      if (seenPullNumbers.has(pullNumber)) {
        return invalidAuditQueryResult('DUPLICATE_PULL_NUMBER', parsedFilter.repositoryId);
      }
      seenPullNumbers.add(pullNumber);
    }

    const hasCircuitBreaker = hasOwnEnumerableData(entry, 'circuitBreaker');
    const hasGovAttestation = hasOwnEnumerableData(entry, 'governanceAttestation');
    if (hasCircuitBreaker && hasGovAttestation) {
      return invalidAuditQueryResult('INVALID_AUDIT_CHAIN_ENTRY', parsedFilter.repositoryId);
    }

    let resolvedViolations = declaredViolations;
    if (hasCircuitBreaker) {
      const cb = evaluateAntiRogueCircuitBreaker(entry.circuitBreaker);
      if (cb.reason === 'INVALID_EVIDENCE' || cb.primaryViolation === 'UNSAFE_PATH_TRAVERSAL') {
        return invalidAuditQueryResult('INVALID_AUDIT_CHAIN_ENTRY', parsedFilter.repositoryId);
      }
      if (!circuitBreakerMatchesLineage(entry.circuitBreaker, entry.stages, provenance.repositoryId)) {
        return invalidAuditQueryResult('INCONSISTENT_CIRCUIT_BREAKER_LINEAGE', parsedFilter.repositoryId);
      }
      if (resolvedViolations !== null &&
          (resolvedViolations.length !== cb.violations.length ||
            cb.violations.some(code => !resolvedViolations.includes(code)))) {
        return invalidAuditQueryResult('INCONSISTENT_AUDIT_VIOLATIONS', parsedFilter.repositoryId);
      }
      resolvedViolations = cb.violations;
    } else if (hasGovAttestation) {
      const att = entry.governanceAttestation;
      if (!exactRecord(att, GOVERNANCE_ATTESTATION_KEYS) ||
          att.accountingVerified !== false ||
          !nonnegInt(att.incrementalBilledUsdCents)) {
        return invalidAuditQueryResult('INVALID_AUDIT_CHAIN_ENTRY', parsedFilter.repositoryId);
      }
      const syntheticGuardCheck = evaluateAntiRogueCircuitBreaker({
        ...att,
        runAiCredits: 0,
        maxRunAiCredits: 1,
        burnRateBps: 0,
        maxBurnSpikeBps: 1,
        accountingVerified: true,
        isEstimated: false
      });
      if (syntheticGuardCheck.reason === 'INVALID_EVIDENCE' ||
          syntheticGuardCheck.primaryViolation === 'UNSAFE_PATH_TRAVERSAL') {
        return invalidAuditQueryResult('INVALID_AUDIT_CHAIN_ENTRY', parsedFilter.repositoryId);
      }
      if (!circuitBreakerMatchesLineage(att, entry.stages, provenance.repositoryId)) {
        return invalidAuditQueryResult('INCONSISTENT_CIRCUIT_BREAKER_LINEAGE', parsedFilter.repositoryId);
      }
      if (resolvedViolations !== null &&
          (resolvedViolations.length !== syntheticGuardCheck.violations.length ||
            syntheticGuardCheck.violations.some(code => !resolvedViolations.includes(code)))) {
        return invalidAuditQueryResult('INCONSISTENT_AUDIT_VIOLATIONS', parsedFilter.repositoryId);
      }
      resolvedViolations = syntheticGuardCheck.violations;
    }
    const violations = resolvedViolations === null ? null : Object.freeze([...resolvedViolations]);
    const killSwitchTripped = violations === null ? null : violations.length > 0;

    totalRepositoryChains++;

    if (parsedFilter.traceId !== null && provenance.traceId !== parsedFilter.traceId) continue;
    if (parsedFilter.deliveryId !== null && provenance.deliveryId !== parsedFilter.deliveryId) continue;
    if (parsedFilter.issueNumber !== null && issueNumber !== parsedFilter.issueNumber) continue;
    if (parsedFilter.pullNumber !== null && pullNumber !== parsedFilter.pullNumber) continue;
    if (parsedFilter.commitSha !== null && provenance.commitSha !== parsedFilter.commitSha) continue;
    if (parsedFilter.squashCommitSha !== null &&
        provenance.squashCommitSha !== parsedFilter.squashCommitSha) {
      continue;
    }
    if (parsedFilter.violationCode !== null &&
        (violations === null || !violations.includes(parsedFilter.violationCode))) {
      continue;
    }

    const stages = entry.stages;
    matchedRecords.push(Object.freeze({
      repositoryId: provenance.repositoryId,
      traceId: provenance.traceId,
      deliveryId: provenance.deliveryId,
      lockSha256: stages.ghAwLock.lockSha256,
      leaseGeneration: stages.casLease.leaseGeneration,
      laneId: provenance.laneId,
      ownedPaths: Object.freeze([...stages.casLease.ownedPaths]),
      taskId: stages.missionControlTask.taskId,
      sessionId: stages.missionControlTask.sessionId,
      commitSha: provenance.commitSha,
      touchedPaths: Object.freeze([...stages.candidateCommit.touchedPaths]),
      ciReceiptId: stages.exactHeadValidation.ciReceiptId,
      codeqlReceiptId: stages.exactHeadValidation.codeqlReceiptId,
      coverageReceiptId: stages.exactHeadValidation.coverageReceiptId,
      reviewId: stages.independentReview.reviewId,
      reviewerIdentity: stages.independentReview.reviewerIdentity,
      squashCommitSha: provenance.squashCommitSha,
      mainReceiptId: stages.verifiedMain.receiptId,
      issueNumber,
      pullNumber,
      violations,
      killSwitchTripped,
      startedAtMs: stages.eventDelivery.observedMs,
      completedAtMs: stages.verifiedMain.observedMs,
      verifiedStageCount: CANONICAL_PROVENANCE_STAGES.length,
      provenanceCode: provenance.code,
      lineageVerified: true
    }));
  }

  matchedRecords.sort((a, b) =>
    a.completedAtMs - b.completedAtMs ||
    a.startedAtMs - b.startedAtMs ||
    a.traceId.localeCompare(b.traceId)
  );

  return Object.freeze({
    valid: true,
    shadow: true,
    liveMutation: false,
    readOnly: true,
    reason: 'AUDIT_TRAIL_QUERIED',
    repositoryId: parsedFilter.repositoryId,
    totalRepositoryChains,
    isolatedOutCount,
    matchCount: matchedRecords.length,
    records: Object.freeze(matchedRecords)
  });
}

function invalidRevertSpec(reason) {
  return Object.freeze({
    valid: false,
    shadow: true,
    liveMutation: false,
    revertRequired: false,
    directMainMutation: false,
    autoPolicyMutation: false,
    requiresHumanApproval: false,
    gatePipelineRequired: REQUIRED_GATE_PIPELINE,
    reason,
    rollbackReasons: Object.freeze([]),
    targetRevertCommitSha: null
  });
}

function validMetricsDelta(delta, requireNullCreditsDelta = false) {
  return exactRecord(delta, [
    'medianCycleTimeDeltaMs',
    'reworkRateDeltaBps',
    'aiCreditsPerOutcomeDelta'
  ]) && Number.isFinite(delta.medianCycleTimeDeltaMs) &&
    Number.isFinite(delta.reworkRateDeltaBps) &&
    (requireNullCreditsDelta
      ? delta.aiCreditsPerOutcomeDelta === null
      : Number.isFinite(delta.aiCreditsPerOutcomeDelta));
}

function validateCohortVerdictEnvelope(verdict) {
  if (!isPlainObject(verdict) || !hasOwnEnumerableData(verdict, 'valid') ||
      verdict.valid !== true || !hasOwnEnumerableData(verdict, 'status')) {
    return {ok: false};
  }
  const hasRepo = hasOwnEnumerableData(verdict, 'repositoryId');
  const hasCohort = hasOwnEnumerableData(verdict, 'cohortId');
  const hasShadow = hasOwnEnumerableData(verdict, 'shadow');
  const hasVerdictSource = hasOwnEnumerableData(verdict, 'cohortSource');
  const hasBeforeIssues = hasOwnEnumerableData(verdict, 'beforeDistinctIssues');
  const hasAfterIssues = hasOwnEnumerableData(verdict, 'afterDistinctIssues');
  if ((hasRepo && !positiveInt(verdict.repositoryId)) ||
      (hasCohort && !validCohortId(verdict.cohortId)) ||
      (hasShadow && verdict.shadow !== true) ||
      (hasVerdictSource && !kaizenCohortSourceSet.has(verdict.cohortSource)) ||
      hasBeforeIssues !== hasAfterIssues ||
      (hasBeforeIssues &&
        (!nonnegInt(verdict.beforeDistinctIssues) || !nonnegInt(verdict.afterDistinctIssues)))) {
    return {ok: false};
  }

  const repositoryId = hasRepo ? verdict.repositoryId : null;
  const cohortId = hasCohort ? verdict.cohortId : null;
  const cohortSource = hasVerdictSource ? verdict.cohortSource : null;

  if (verdict.status === 'INSUFFICIENT_COHORT') {
    if (!exactRecord(verdict, INSUFFICIENT_VERDICT_REQUIRED_KEYS, INSUFFICIENT_VERDICT_OPTIONAL_KEYS) ||
        verdict.cohortComplete !== false ||
        verdict.verifiedImprovement !== false ||
        verdict.rollbackRequired !== false ||
        verdict.minimumRequiredOutcomes !== MIN_COHORT_ACCEPTED_OUTCOMES ||
        !nonnegInt(verdict.beforeAcceptedOutcomes) ||
        !nonnegInt(verdict.afterAcceptedOutcomes) ||
        (hasBeforeIssues &&
          (verdict.beforeDistinctIssues !== verdict.beforeAcceptedOutcomes ||
            verdict.afterDistinctIssues !== verdict.afterAcceptedOutcomes)) ||
        (verdict.beforeAcceptedOutcomes >= MIN_COHORT_ACCEPTED_OUTCOMES &&
          verdict.afterAcceptedOutcomes >= MIN_COHORT_ACCEPTED_OUTCOMES) ||
        !denseDataArray(verdict.rollbackReasons, 0)) {
      return {ok: false};
    }
    return {ok: true, rollbackRequired: false, repositoryId, cohortId, cohortSource};
  }

  if (!exactRecord(verdict, COMPLETED_VERDICT_REQUIRED_KEYS, COMPLETED_VERDICT_OPTIONAL_KEYS) ||
      verdict.cohortComplete !== true ||
      typeof verdict.verifiedImprovement !== 'boolean' ||
      typeof verdict.rollbackRequired !== 'boolean' ||
      (hasOwnEnumerableData(verdict, 'metricsDelta') &&
        !validMetricsDelta(
          verdict.metricsDelta,
          cohortSource === 'github-verified-wave5-outcomes'
        ))) {
    return {ok: false};
  }

  if (verdict.status === 'VERIFIED_IMPROVEMENT' || verdict.status === 'NO_MATERIAL_GAIN') {
    if (verdict.rollbackRequired !== false ||
        verdict.verifiedImprovement !== (verdict.status === 'VERIFIED_IMPROVEMENT') ||
        !denseDataArray(verdict.rollbackReasons, 0)) {
      return {ok: false};
    }
    return {ok: true, rollbackRequired: false, repositoryId, cohortId, cohortSource};
  }

  if (verdict.status !== 'ROLLBACK_REQUIRED' ||
      verdict.rollbackRequired !== true ||
      verdict.verifiedImprovement !== false ||
      !denseDataArray(verdict.rollbackReasons, 16) ||
      verdict.rollbackReasons.length === 0 ||
      !verdict.rollbackReasons.every(reason => knownRollbackReasonSet.has(reason)) ||
      new Set(verdict.rollbackReasons).size !== verdict.rollbackReasons.length) {
    return {ok: false};
  }
  return {ok: true, rollbackRequired: true, repositoryId, cohortId, cohortSource};
}

export function buildAutomaticRevertCandidateSpec(cohortVerdict, candidateMeta) {
  const verdictCheck = validateCohortVerdictEnvelope(cohortVerdict);
  if (!verdictCheck.ok) {
    return invalidRevertSpec('INVALID_COHORT_VERDICT');
  }
  if (!exactRecord(candidateMeta, CANDIDATE_META_REQUIRED_KEYS, CANDIDATE_META_OPTIONAL_KEYS) ||
      !auditToken(candidateMeta.proposalId) ||
      !positiveInt(candidateMeta.repositoryId) ||
      !token(candidateMeta.laneId) ||
      !validPathList(candidateMeta.targetPaths, 64)) {
    return invalidRevertSpec('INVALID_CANDIDATE_META');
  }

  if (verdictCheck.repositoryId !== null &&
      verdictCheck.repositoryId !== candidateMeta.repositoryId) {
    return invalidRevertSpec('COHORT_REPOSITORY_MISMATCH');
  }

  const hasTargetSha = hasOwnEnumerableData(candidateMeta, 'targetRevertCommitSha');
  const hasSquashSha = hasOwnEnumerableData(candidateMeta, 'squashCommitSha');
  if (!hasTargetSha && !hasSquashSha) {
    return invalidRevertSpec('INVALID_CANDIDATE_META');
  }
  if ((hasTargetSha && !hex40(candidateMeta.targetRevertCommitSha)) ||
      (hasSquashSha && !hex40(candidateMeta.squashCommitSha))) {
    return invalidRevertSpec('INVALID_REVERT_COMMIT_SHA');
  }
  if (hasTargetSha && hasSquashSha &&
      candidateMeta.targetRevertCommitSha !== candidateMeta.squashCommitSha) {
    return invalidRevertSpec('REVERT_COMMIT_SHA_MISMATCH');
  }
  const targetRevertCommitSha = hasTargetSha
    ? candidateMeta.targetRevertCommitSha
    : candidateMeta.squashCommitSha;

  const hasOwnedPaths = hasOwnEnumerableData(candidateMeta, 'ownedPaths');
  if (hasOwnedPaths) {
    if (!validPathList(candidateMeta.ownedPaths, 64)) {
      return invalidRevertSpec('INVALID_CANDIDATE_META');
    }
    if (candidateMeta.targetPaths.some(path => !isWithinOwnedPaths(path, candidateMeta.ownedPaths))) {
      return invalidRevertSpec('OUT_OF_LANE_REVERT_TARGET');
    }
  }
  const ownedPaths = hasOwnedPaths ? candidateMeta.ownedPaths : candidateMeta.targetPaths;

  const hasTouchedPaths = hasOwnEnumerableData(candidateMeta, 'touchedPaths');
  if (hasTouchedPaths) {
    if (!validPathList(candidateMeta.touchedPaths, 64)) {
      return invalidRevertSpec('INVALID_CANDIDATE_META');
    }
    if (!samePathSet(candidateMeta.targetPaths, candidateMeta.touchedPaths)) {
      return invalidRevertSpec('INCOMPLETE_REVERT_TARGET_PATHS');
    }
  }

  const hasProvenanceChain = hasOwnEnumerableData(candidateMeta, 'provenanceChain');
  if (hasProvenanceChain) {
    const provenance = verifyCausalProvenanceChain(candidateMeta.provenanceChain);
    if (!provenance.valid || !provenance.complete) {
      return invalidRevertSpec('UNVERIFIED_CANDIDATE_PROVENANCE');
    }
    const chainStages = candidateMeta.provenanceChain.stages;
    if (provenance.repositoryId !== candidateMeta.repositoryId ||
        provenance.laneId !== candidateMeta.laneId ||
        provenance.squashCommitSha !== targetRevertCommitSha ||
        (hasOwnedPaths && !samePathSet(ownedPaths, chainStages.casLease.ownedPaths)) ||
        !samePathSet(candidateMeta.targetPaths, chainStages.candidateCommit.touchedPaths)) {
      return invalidRevertSpec('CANDIDATE_PROVENANCE_MISMATCH');
    }
  }

  const defaultScope = candidateMeta.repositoryId === SOFTWARE_FACTORY_REPOSITORY_ID
    ? 'factory-velocity'
    : 'enrolled-product';
  const scope = hasOwnEnumerableData(candidateMeta, 'scope') ? candidateMeta.scope : defaultScope;
  const domain = hasOwnEnumerableData(candidateMeta, 'contractDomain')
    ? candidateMeta.contractDomain
    : 'standard';
  const hasTouchesContract = hasOwnEnumerableData(candidateMeta, 'touchesContract');
  const hasExplicitApproval = hasOwnEnumerableData(candidateMeta, 'requiresHumanApproval');
  const hasCohortId = hasOwnEnumerableData(candidateMeta, 'cohortId');
  const hasMetaSource = hasOwnEnumerableData(candidateMeta, 'cohortSource');
  const hasPullNumber = hasOwnEnumerableData(candidateMeta, 'pullNumber');
  const hasIssueNumber = hasOwnEnumerableData(candidateMeta, 'issueNumber');

  if (!proposalScopeSet.has(scope) ||
      !contractDomainSet.has(domain) ||
      (hasTouchesContract && typeof candidateMeta.touchesContract !== 'boolean') ||
      (hasExplicitApproval && typeof candidateMeta.requiresHumanApproval !== 'boolean') ||
      (hasCohortId && !validCohortId(candidateMeta.cohortId)) ||
      (hasMetaSource && !kaizenCohortSourceSet.has(candidateMeta.cohortSource)) ||
      (hasPullNumber && !positiveInt(candidateMeta.pullNumber)) ||
      (hasIssueNumber && !positiveInt(candidateMeta.issueNumber))) {
    return invalidRevertSpec('INVALID_CANDIDATE_META');
  }

  if (verdictCheck.cohortId !== null && hasCohortId &&
      verdictCheck.cohortId !== candidateMeta.cohortId) {
    return invalidRevertSpec('COHORT_ID_MISMATCH');
  }
  if (verdictCheck.cohortSource !== null && hasMetaSource &&
      verdictCheck.cohortSource !== candidateMeta.cohortSource) {
    return invalidRevertSpec('COHORT_SOURCE_MISMATCH');
  }

  if (!verdictCheck.rollbackRequired) {
    return invalidRevertSpec('ROLLBACK_NOT_REQUIRED');
  }

  const resolvedCohortSource = hasMetaSource ? candidateMeta.cohortSource : verdictCheck.cohortSource;
  const effectiveOwnedPaths = hasProvenanceChain
    ? candidateMeta.provenanceChain.stages.casLease.ownedPaths
    : ownedPaths;
  const requiresHumanApproval =
    (hasExplicitApproval && candidateMeta.requiresHumanApproval === true) ||
    (hasTouchesContract && candidateMeta.touchesContract === true) ||
    governedDomainSet.has(domain) ||
    candidateMeta.targetPaths.some(touchesGovernedContractPath) ||
    effectiveOwnedPaths.some(touchesGovernedContractPath);

  return Object.freeze({
    valid: true,
    shadow: true,
    liveMutation: false,
    revertRequired: true,
    provenanceVerified: hasProvenanceChain,
    reason: 'REVERT_CANDIDATE_GENERATED',
    revertProposalId: `revert:${candidateMeta.repositoryId}:${candidateMeta.proposalId}`,
    sourceProposalId: candidateMeta.proposalId,
    deliveryKind: requiresHumanApproval ? 'human-approved-revert-pr' : 'candidate-revert-pr',
    repositoryId: candidateMeta.repositoryId,
    cohortId: hasCohortId ? candidateMeta.cohortId : verdictCheck.cohortId,
    ...(resolvedCohortSource !== null ? {cohortSource: resolvedCohortSource} : {}),
    scope,
    laneId: candidateMeta.laneId,
    ownedPaths: Object.freeze([...effectiveOwnedPaths]),
    targetPaths: Object.freeze([...candidateMeta.targetPaths]),
    targetRevertCommitSha,
    sourcePullNumber: hasPullNumber ? candidateMeta.pullNumber : null,
    sourceIssueNumber: hasIssueNumber ? candidateMeta.issueNumber : null,
    rollbackReasons: Object.freeze([...cohortVerdict.rollbackReasons]),
    metricsDelta: hasOwnEnumerableData(cohortVerdict, 'metricsDelta')
      ? Object.freeze({...cohortVerdict.metricsDelta})
      : null,
    requiresHumanApproval,
    directMainMutation: false,
    autoPolicyMutation: false,
    gatePipelineRequired: REQUIRED_GATE_PIPELINE
  });
}

const kaizenEvidenceModeSet = new Set(KAIZEN_EVIDENCE_MODES);
const KAIZEN_READOUT_REQUIRED_KEYS = [
  'repositoryId',
  'evaluatedHeadSha',
  'evidenceMode',
  'liveAutonomousOutcomesCount',
  'auditChains',
  'proposalInput',
  'cohortInput'
];
const KAIZEN_READOUT_OPTIONAL_KEYS = ['shippedCandidate', 'cohortSource', 'revisedExitContract'];
const REVISED_EXIT_CONTRACT_KEYS = ['ownerApprovedStreamlinedCohort', 'issueNumber'];
const CIRCUIT_BREAKER_LINEAGE_BINDING_KEYS = [
  'authorIdentity',
  'implementationAgentIdentity',
  'reviewerIdentity',
  'mainHealthy'
];
const hex40NonZero = s => hex40(s) && !/^0{40}$/.test(s);

function invalidKaizenReadout(reason, repositoryId = null) {
  return Object.freeze({
    valid: false,
    shadow: true,
    readOnly: true,
    liveMutation: false,
    directMainMutation: false,
    autoPolicyMutation: false,
    reason,
    repositoryId,
    evaluatedHeadSha: null,
    evidenceMode: null,
    cohortSource: null,
    syntheticReplayOnly: true,
    verifiedCohortOutcomesCount: 0,
    liveAutonomousOutcomesCount: 0,
    kaizenCohortVerified: false,
    liveCohortVerified: false,
    issue137ReadyToClose: false,
    readoutStatus: 'BLOCKED',
    gatePipelineRequired: REQUIRED_GATE_PIPELINE,
    provenanceSummary: null,
    proposalSummary: null,
    cohortVerdict: null,
    revertCandidateSpec: null
  });
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function evaluateKaizenCohortReadout(input) {
  if (!exactRecord(input, KAIZEN_READOUT_REQUIRED_KEYS, KAIZEN_READOUT_OPTIONAL_KEYS) ||
      !positiveInt(input.repositoryId) ||
      !nonnegInt(input.liveAutonomousOutcomesCount)) {
    return invalidKaizenReadout('INVALID_KAIZEN_READOUT_INPUT');
  }
  const {repositoryId, evaluatedHeadSha, evidenceMode, liveAutonomousOutcomesCount} = input;

  if (!hex40NonZero(evaluatedHeadSha)) {
    return invalidKaizenReadout('INVALID_EVALUATED_HEAD_SHA', repositoryId);
  }
  if (!kaizenEvidenceModeSet.has(evidenceMode)) {
    return invalidKaizenReadout('INVALID_EVIDENCE_MODE', repositoryId);
  }
  const hasRevisedExitContract = hasOwnEnumerableData(input, 'revisedExitContract');
  if (hasRevisedExitContract &&
      (!exactRecord(input.revisedExitContract, REVISED_EXIT_CONTRACT_KEYS) ||
        input.revisedExitContract.ownerApprovedStreamlinedCohort !== true ||
        input.revisedExitContract.issueNumber !== 137)) {
    return invalidKaizenReadout('INVALID_REVISED_EXIT_CONTRACT', repositoryId);
  }
  const hasInputCohortSource = hasOwnEnumerableData(input, 'cohortSource');
  if (hasInputCohortSource && !kaizenCohortSourceSet.has(input.cohortSource)) {
    return invalidKaizenReadout('INVALID_COHORT_SOURCE', repositoryId);
  }
  if (evidenceMode === 'github-verified-cohort' && !hasInputCohortSource) {
    return invalidKaizenReadout('MISSING_COHORT_SOURCE', repositoryId);
  }
  const expectedCohortSource =
    evidenceMode === 'pre-cohort-synthetic'
      ? 'synthetic-precohort-replay'
      : evidenceMode === 'github-verified-cohort'
        ? 'github-verified-wave5-outcomes'
        : 'live-unattended-ghaw-copilot';
  const resolvedCohortSource = hasInputCohortSource ? input.cohortSource : expectedCohortSource;
  if (resolvedCohortSource !== expectedCohortSource) {
    return invalidKaizenReadout('INCONSISTENT_COHORT_SOURCE', repositoryId);
  }
  if ((evidenceMode === 'pre-cohort-synthetic' &&
        liveAutonomousOutcomesCount >= MIN_COHORT_ACCEPTED_OUTCOMES) ||
      (evidenceMode === 'github-verified-cohort' &&
        liveAutonomousOutcomesCount !== 0)) {
    return invalidKaizenReadout('INCONSISTENT_EVIDENCE_MODE', repositoryId);
  }
  if (evidenceMode === 'live-autonomous-cohort' &&
      liveAutonomousOutcomesCount < MIN_COHORT_ACCEPTED_OUTCOMES) {
    return invalidKaizenReadout('UNVERIFIED_LIVE_COHORT_CLAIM', repositoryId);
  }

  const auditTrail = queryCausalAuditTrail(input.auditChains, {repositoryId});
  if (!auditTrail.valid) {
    return invalidKaizenReadout(auditTrail.reason, repositoryId);
  }
  if (auditTrail.totalRepositoryChains === 0) {
    return invalidKaizenReadout('EMPTY_PROVENANCE_AUDIT_TRAIL', repositoryId);
  }

  let totalRunAiCredits = evidenceMode === 'github-verified-cohort' ? null : 0;
  let humanApprovedProtectedChains = 0;
  let copilotAgentChainsCount = 0;
  let latestSquashMergedAtMs = -1;
  const copilotAgentIssueIds = new Set();
  const rawChainBySquashSha = new Map();

  for (const entry of input.auditChains) {
    if (entry.stages.eventDelivery.repositoryId !== repositoryId) continue;
    if (evidenceMode === 'github-verified-cohort') {
      if (hasOwnEnumerableData(entry, 'circuitBreaker')) {
        return invalidKaizenReadout('UNVERIFIED_CREDIT_ACCOUNTING_CLAIM', repositoryId);
      }
      if (!hasOwnEnumerableData(entry, 'governanceAttestation')) {
        return invalidKaizenReadout('MISSING_CIRCUIT_BREAKER_EVIDENCE', repositoryId);
      }
      if (entry.stages.verifiedMain.observedMs <= entry.stages.mergeQueueSquash.observedMs) {
        return invalidKaizenReadout('PRE_MERGE_MAIN_RECEIPT_REJECTED', repositoryId);
      }
      const att = entry.governanceAttestation;
      const cb = evaluateAntiRogueCircuitBreaker({
        ...att,
        runAiCredits: 0,
        maxRunAiCredits: 1,
        burnRateBps: 0,
        maxBurnSpikeBps: 1,
        accountingVerified: true,
        isEstimated: false
      });
      if (cb.violations.includes('PROTECTED_CONTROL_PLANE_TOUCH')) {
        return invalidKaizenReadout('PROTECTED_FILE_SELF_MODIFICATION_DETECTED', repositoryId);
      }
      if (cb.violations.includes('AI_CREDIT_ANOMALY')) {
        return invalidKaizenReadout('UNAPPROVED_SPEND_OR_CREDIT_ANOMALY', repositoryId);
      }
      if (cb.violations.length > 0) {
        return invalidKaizenReadout('ANTI_ROGUE_VIOLATION_DETECTED', repositoryId);
      }
      if (cb.protectedTouchedPaths.length > 0) {
        humanApprovedProtectedChains++;
      }
    } else {
      if (hasOwnEnumerableData(entry, 'governanceAttestation') ||
          !hasOwnEnumerableData(entry, 'circuitBreaker')) {
        return invalidKaizenReadout('MISSING_CIRCUIT_BREAKER_EVIDENCE', repositoryId);
      }
      const cbInput = entry.circuitBreaker;
      if (CIRCUIT_BREAKER_LINEAGE_BINDING_KEYS.some(key => !hasOwnEnumerableData(cbInput, key))) {
        return invalidKaizenReadout('INCOMPLETE_CIRCUIT_BREAKER_BINDING', repositoryId);
      }
      const cb = evaluateAntiRogueCircuitBreaker(cbInput);
      if (cb.violations.includes('PROTECTED_CONTROL_PLANE_TOUCH')) {
        return invalidKaizenReadout('PROTECTED_FILE_SELF_MODIFICATION_DETECTED', repositoryId);
      }
      if (cb.violations.includes('AI_CREDIT_ANOMALY')) {
        return invalidKaizenReadout('UNAPPROVED_SPEND_OR_CREDIT_ANOMALY', repositoryId);
      }
      if (cb.violations.length > 0) {
        return invalidKaizenReadout('ANTI_ROGUE_VIOLATION_DETECTED', repositoryId);
      }
      totalRunAiCredits += cbInput.runAiCredits;
      if (cb.protectedTouchedPaths.length > 0) {
        humanApprovedProtectedChains++;
      }
    }
    if (entry.stages.independentReview.implementationAgentIdentity.toLowerCase() ===
        'copilot-swe-agent[bot]') {
      copilotAgentChainsCount++;
      if (hasOwnEnumerableData(entry, 'issueNumber')) {
        copilotAgentIssueIds.add(entry.issueNumber);
      }
    }
    const squashMergedAtMs = entry.stages.mergeQueueSquash.observedMs;
    if (squashMergedAtMs > latestSquashMergedAtMs) {
      latestSquashMergedAtMs = squashMergedAtMs;
    }
    rawChainBySquashSha.set(entry.stages.mergeQueueSquash.squashCommitSha, entry);
  }

  const headRawEntry = rawChainBySquashSha.get(evaluatedHeadSha);
  if (!headRawEntry) {
    return invalidKaizenReadout('UNVERIFIED_EVALUATED_HEAD_SHA', repositoryId);
  }
  if (headRawEntry.stages.mergeQueueSquash.observedMs < latestSquashMergedAtMs) {
    return invalidKaizenReadout('STALE_EVALUATED_HEAD_SHA', repositoryId);
  }
  if (copilotAgentIssueIds.size < liveAutonomousOutcomesCount) {
    return invalidKaizenReadout('INSUFFICIENT_VERIFIED_AGENT_PROVENANCE', repositoryId);
  }

  const proposalResult = proposeOptimisticImprovements(input.proposalInput);
  if (!proposalResult.valid) {
    return invalidKaizenReadout(proposalResult.reason, repositoryId);
  }
  if (input.proposalInput.scorecard.repositoryId !== repositoryId) {
    return invalidKaizenReadout('SCORECARD_REPOSITORY_MISMATCH', repositoryId);
  }
  const repositoryProposals = proposalResult.proposals.filter(
    proposal => proposal.repositoryId === repositoryId
  );
  if (repositoryProposals.length === 0) {
    return invalidKaizenReadout('NO_CANDIDATE_PROPOSALS', repositoryId);
  }
  const humanApprovalRequiredCount = proposalResult.proposals.filter(
    proposal => proposal.requiresHumanApproval
  ).length;

  const cohortVerdict = verifyCohortImprovementOrRollback(input.cohortInput);
  if (!cohortVerdict.valid) {
    return invalidKaizenReadout(cohortVerdict.reason, repositoryId);
  }
  if (hasOwnEnumerableData(input.cohortInput, 'cohortSource') &&
      input.cohortInput.cohortSource !== resolvedCohortSource) {
    return invalidKaizenReadout('INCONSISTENT_COHORT_SOURCE', repositoryId);
  }
  const {beforeCohort, afterCohort} = input.cohortInput;
  if (beforeCohort.repositoryId !== repositoryId) {
    return invalidKaizenReadout('COHORT_REPOSITORY_MISMATCH', repositoryId);
  }
  if (beforeCohort.incrementalBilledUsdCents > 0) {
    return invalidKaizenReadout('UNAPPROVED_SPEND_OR_CREDIT_ANOMALY', repositoryId);
  }

  const hasShippedCandidate = hasOwnEnumerableData(input, 'shippedCandidate');
  let revertCandidateSpec = null;
  let shippedTargetSha = null;
  let matchingAuditRecord = null;
  let matchedRawEntry = null;

  if (!hasShippedCandidate) {
    if (cohortVerdict.rollbackRequired) {
      return invalidKaizenReadout('MISSING_REVERT_CANDIDATE_META', repositoryId);
    }
    if (evidenceMode === 'live-autonomous-cohort' ||
        evidenceMode === 'github-verified-cohort') {
      return invalidKaizenReadout('MISSING_SHIPPED_CANDIDATE_META', repositoryId);
    }
  } else {
    const initialCheck = buildAutomaticRevertCandidateSpec(cohortVerdict, input.shippedCandidate);
    if (cohortVerdict.rollbackRequired
      ? !initialCheck.valid
      : initialCheck.reason !== 'ROLLBACK_NOT_REQUIRED') {
      return invalidKaizenReadout(initialCheck.reason, repositoryId);
    }

    const candidateMeta = input.shippedCandidate;
    if (hasOwnEnumerableData(candidateMeta, 'cohortSource') &&
        candidateMeta.cohortSource !== resolvedCohortSource) {
      return invalidKaizenReadout('INCONSISTENT_COHORT_SOURCE', repositoryId);
    }
    shippedTargetSha = hasOwnEnumerableData(candidateMeta, 'targetRevertCommitSha')
      ? candidateMeta.targetRevertCommitSha
      : candidateMeta.squashCommitSha;
    matchingAuditRecord = auditTrail.records.find(rec => rec.squashCommitSha === shippedTargetSha);
    if (!matchingAuditRecord) {
      return invalidKaizenReadout('UNVERIFIED_CANDIDATE_PROVENANCE', repositoryId);
    }

    const hasInlineProvenance = hasOwnEnumerableData(candidateMeta, 'provenanceChain');
    matchedRawEntry = rawChainBySquashSha.get(shippedTargetSha);
    const expectedProvenancePayload = {
      stages: matchedRawEntry.stages,
      ...(hasOwnEnumerableData(matchedRawEntry, 'coveragePolicy')
        ? {coveragePolicy: matchedRawEntry.coveragePolicy}
        : {})
    };
    if (matchingAuditRecord.laneId !== candidateMeta.laneId ||
        !samePathSet(candidateMeta.targetPaths, matchingAuditRecord.touchedPaths) ||
        (hasOwnEnumerableData(candidateMeta, 'ownedPaths') &&
          !samePathSet(candidateMeta.ownedPaths, matchingAuditRecord.ownedPaths)) ||
        (hasOwnEnumerableData(candidateMeta, 'pullNumber') &&
          candidateMeta.pullNumber !== matchingAuditRecord.pullNumber) ||
        (hasOwnEnumerableData(candidateMeta, 'issueNumber') &&
          candidateMeta.issueNumber !== matchingAuditRecord.issueNumber) ||
        (hasInlineProvenance &&
          canonicalJson(candidateMeta.provenanceChain) !==
            canonicalJson(expectedProvenancePayload))) {
      return invalidKaizenReadout('CANDIDATE_PROVENANCE_MISMATCH', repositoryId);
    }

    const matchingProposal = repositoryProposals.find(
      proposal => proposal.proposalId === candidateMeta.proposalId
    );
    if (!matchingProposal) {
      return invalidKaizenReadout('UNKNOWN_CANDIDATE_PROPOSAL', repositoryId);
    }
    if (matchingProposal.laneId !== candidateMeta.laneId ||
        !samePathSet(matchingProposal.targetPaths, candidateMeta.targetPaths) ||
        (hasOwnEnumerableData(candidateMeta, 'scope') &&
          matchingProposal.scope !== candidateMeta.scope) ||
        (matchingProposal.requiresHumanApproval &&
          hasOwnEnumerableData(candidateMeta, 'requiresHumanApproval') &&
          candidateMeta.requiresHumanApproval === false)) {
      return invalidKaizenReadout('CANDIDATE_PROPOSAL_MISMATCH', repositoryId);
    }
    const matchedGuardRecord = evidenceMode === 'github-verified-cohort'
      ? matchedRawEntry.governanceAttestation
      : matchedRawEntry.circuitBreaker;
    if (matchingProposal.requiresHumanApproval &&
        matchedGuardRecord.humanOwnerSignOffVerified !== true) {
      return invalidKaizenReadout('MISSING_HUMAN_APPROVAL_SIGN_OFF', repositoryId);
    }

    if (cohortVerdict.rollbackRequired) {
      const enrichedMeta = {
        ...candidateMeta,
        scope: matchingProposal.scope,
        ...(hasInputCohortSource ? {cohortSource: resolvedCohortSource} : {}),
        ...(hasInlineProvenance ? {} : {provenanceChain: expectedProvenancePayload}),
        ...(matchingProposal.requiresHumanApproval ? {requiresHumanApproval: true} : {})
      };
      revertCandidateSpec = buildAutomaticRevertCandidateSpec(cohortVerdict, enrichedMeta);
    }
  }

  if (evidenceMode === 'github-verified-cohort') {
    if (cohortVerdict.status === 'INSUFFICIENT_COHORT') {
      return invalidKaizenReadout('INSUFFICIENT_VERIFIED_COHORT_OUTCOMES', repositoryId);
    }
    if (!hasOwnEnumerableData(beforeCohort, 'distinctIssueNumbers') ||
        !hasOwnEnumerableData(beforeCohort, 'mergedPullNumbers')) {
      return invalidKaizenReadout('MISSING_COHORT_ISSUE_PROVENANCE', repositoryId);
    }
    if (matchedRawEntry.stages.mergeQueueSquash.observedMs < beforeCohort.windowEndMs ||
        (matchingAuditRecord.pullNumber !== null &&
          beforeCohort.mergedPullNumbers.includes(matchingAuditRecord.pullNumber))) {
      return invalidKaizenReadout('CANDIDATE_MERGED_BEFORE_BASELINE_END', repositoryId);
    }
    if (matchingAuditRecord.completedAtMs > afterCohort.windowStartMs) {
      return invalidKaizenReadout('CANDIDATE_NOT_SHIPPED_BEFORE_COHORT', repositoryId);
    }

    const recordByPull = new Map();
    for (const rec of auditTrail.records) {
      const raw = rawChainBySquashSha.get(rec.squashCommitSha);
      if (rec.squashCommitSha !== shippedTargetSha &&
          rec.pullNumber !== null &&
          rec.issueNumber !== null &&
          raw.stages.independentReview.implementationAgentIdentity.toLowerCase() ===
            'copilot-swe-agent[bot]') {
        recordByPull.set(rec.pullNumber, {rec, raw});
      }
    }

    for (const [cohort, requireStartInWindow] of [
      [beforeCohort, false],
      [afterCohort, true]
    ]) {
      const verifiedIssues = new Set();
      let sumLines = 0;
      let sumLineTotal = 0;
      let sumBranches = 0;
      let sumBranchTotal = 0;
      for (const pullNum of cohort.mergedPullNumbers) {
        const bound = recordByPull.get(pullNum);
        if (!bound) {
          return invalidKaizenReadout('UNVERIFIED_COHORT_ISSUE_PROVENANCE', repositoryId);
        }
        const {rec, raw} = bound;
        const squashMs = raw.stages.mergeQueueSquash.observedMs;
        const inWindow = requireStartInWindow
          ? rec.startedAtMs >= cohort.windowStartMs && rec.completedAtMs <= cohort.windowEndMs
          : rec.startedAtMs < cohort.windowEndMs &&
            squashMs >= cohort.windowStartMs &&
            rec.completedAtMs <= cohort.windowEndMs;
        if (!inWindow) {
          return invalidKaizenReadout('UNVERIFIED_COHORT_ISSUE_PROVENANCE', repositoryId);
        }
        verifiedIssues.add(rec.issueNumber);
        sumLines += raw.stages.exactHeadValidation.lines;
        sumLineTotal += raw.stages.exactHeadValidation.lineTotal;
        sumBranches += raw.stages.exactHeadValidation.branches;
        sumBranchTotal += raw.stages.exactHeadValidation.branchTotal;
      }
      if (verifiedIssues.size !== cohort.distinctIssueNumbers.length ||
          cohort.distinctIssueNumbers.some(iss => !verifiedIssues.has(iss))) {
        return invalidKaizenReadout('UNVERIFIED_COHORT_ISSUE_PROVENANCE', repositoryId);
      }
      if (sumLines !== cohort.coveredLines ||
          sumLineTotal !== cohort.totalLines ||
          sumBranches !== cohort.coveredBranches ||
          sumBranchTotal !== cohort.totalBranches) {
        return invalidKaizenReadout('COHORT_COVERAGE_PROVENANCE_MISMATCH', repositoryId);
      }
    }
  }

  if (evidenceMode === 'live-autonomous-cohort') {
    if (cohortVerdict.status === 'INSUFFICIENT_COHORT') {
      return invalidKaizenReadout('INSUFFICIENT_LIVE_COHORT_OUTCOMES', repositoryId);
    }
    if (liveAutonomousOutcomesCount !== afterCohort.acceptedOutcomes) {
      return invalidKaizenReadout('LIVE_OUTCOME_COUNT_MISMATCH', repositoryId);
    }
    if (matchedRawEntry.stages.mergeQueueSquash.observedMs < beforeCohort.windowEndMs) {
      return invalidKaizenReadout('CANDIDATE_MERGED_BEFORE_BASELINE_END', repositoryId);
    }
    if (matchingAuditRecord.completedAtMs > afterCohort.windowStartMs) {
      return invalidKaizenReadout('CANDIDATE_NOT_SHIPPED_BEFORE_COHORT', repositoryId);
    }
    const afterWindowIssueIds = new Set();
    for (const rec of auditTrail.records) {
      const raw = rawChainBySquashSha.get(rec.squashCommitSha);
      if (rec.squashCommitSha !== shippedTargetSha &&
          rec.issueNumber !== null &&
          rec.startedAtMs >= afterCohort.windowStartMs &&
          rec.completedAtMs <= afterCohort.windowEndMs &&
          raw.stages.independentReview.implementationAgentIdentity.toLowerCase() ===
            'copilot-swe-agent[bot]') {
        afterWindowIssueIds.add(rec.issueNumber);
      }
    }
    if (afterWindowIssueIds.size < liveAutonomousOutcomesCount) {
      return invalidKaizenReadout('INSUFFICIENT_VERIFIED_AGENT_PROVENANCE', repositoryId);
    }
  }

  const syntheticReplayOnly = evidenceMode === 'pre-cohort-synthetic';
  const verifiedCohortOutcomesCount = syntheticReplayOnly ? 0 : afterCohort.acceptedOutcomes;
  const unapprovedSpendUsdCents = afterCohort.incrementalBilledUsdCents;
  const zeroUnapprovedSpend = unapprovedSpendUsdCents === 0;
  const kaizenCohortVerified =
    !syntheticReplayOnly &&
    cohortVerdict.status === 'VERIFIED_IMPROVEMENT' &&
    afterCohort.routineHumanInterventions === 0;
  const liveCohortVerified =
    evidenceMode === 'live-autonomous-cohort' && kaizenCohortVerified;
  const issue137ReadyToClose =
    liveCohortVerified || (kaizenCohortVerified && hasRevisedExitContract);

  return Object.freeze({
    valid: true,
    shadow: true,
    readOnly: true,
    liveMutation: false,
    directMainMutation: false,
    autoPolicyMutation: false,
    reason: 'KAIZEN_COHORT_EVALUATED',
    repositoryId,
    evaluatedHeadSha,
    evidenceMode,
    cohortSource: resolvedCohortSource,
    syntheticReplayOnly,
    verifiedCohortOutcomesCount,
    liveAutonomousOutcomesCount,
    kaizenCohortVerified,
    liveCohortVerified,
    issue137ReadyToClose,
    readoutStatus: cohortVerdict.status,
    gatePipelineRequired: REQUIRED_GATE_PIPELINE,
    provenanceSummary: Object.freeze({
      totalRepositoryChains: auditTrail.totalRepositoryChains,
      verifiedNineLinkChains: auditTrail.totalRepositoryChains,
      isolatedOutCount: auditTrail.isolatedOutCount,
      provenanceCompletenessPct: 100,
      protectedSelfModifications: 0,
      humanApprovedProtectedChains,
      killSwitchTrips: 0,
      unapprovedSpendUsdCents,
      zeroUnapprovedSpend,
      totalRunAiCredits,
      copilotAgentChainsCount,
      records: auditTrail.records
    }),
    proposalSummary: Object.freeze({
      totalProposals: proposalResult.proposals.length,
      repositoryProposalsCount: repositoryProposals.length,
      humanApprovalRequiredCount,
      standardCandidateCount: proposalResult.proposals.length - humanApprovalRequiredCount,
      deferredCount: proposalResult.deferredByOverlap.length,
      proposals: proposalResult.proposals,
      deferredByOverlap: proposalResult.deferredByOverlap
    }),
    cohortVerdict,
    revertCandidateSpec
  });
}
