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

const proposalScopeSet = new Set(PROPOSAL_SCOPES);
const governedDomainSet = new Set(GOVERNED_CONTRACT_DOMAINS);
const contractDomainSet = new Set(['standard', ...GOVERNED_CONTRACT_DOMAINS]);
const governedFailureClasses = new Set(['security-contract', 'policy-drift', 'budget-cap', 'workflow-lock']);
const knownViolationSet = new Set(KNOWN_VIOLATION_CODES);
const knownRollbackReasonSet = new Set(KNOWN_ROLLBACK_REASONS);

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

function validCohortRecord(cohort) {
  return exactRecord(cohort, COHORT_KEYS) &&
    positiveInt(cohort.repositoryId) &&
    validCohortId(cohort.cohortId) &&
    cohort.sourceKind === 'verified-autonomous' &&
    cohort.complete === true &&
    nonnegInt(cohort.windowStartMs) && nonnegInt(cohort.windowEndMs) &&
    cohort.windowEndMs > cohort.windowStartMs &&
    nonnegInt(cohort.acceptedOutcomes) &&
    nonnegInt(cohort.coveredLines) && positiveInt(cohort.totalLines) &&
    cohort.coveredLines <= cohort.totalLines && cohort.totalLines <= 100000000 &&
    nonnegInt(cohort.coveredBranches) && positiveInt(cohort.totalBranches) &&
    cohort.coveredBranches <= cohort.totalBranches && cohort.totalBranches <= 100000000 &&
    nonnegInt(cohort.securityFindings) &&
    nonnegInt(cohort.mainFailures) &&
    nonnegInt(cohort.routineHumanInterventions) &&
    nonnegInt(cohort.reworkRateBps) &&
    nonnegInt(cohort.aiCreditsTotal) &&
    nonnegInt(cohort.incrementalBilledUsdCents) &&
    positiveInt(cohort.medianCycleTimeMs);
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
  if (!exactRecord(input, ['beforeCohort', 'afterCohort'], ['policy'])) {
    return invalidCohortResponse('INVALID_INPUT');
  }
  if (!validCohortRecord(input.beforeCohort) || !validCohortRecord(input.afterCohort)) {
    return invalidCohortResponse('INVALID_COHORT_RECORD');
  }
  const {beforeCohort, afterCohort} = input;
  if (beforeCohort.repositoryId !== afterCohort.repositoryId ||
      beforeCohort.cohortId !== afterCohort.cohortId) {
    return invalidCohortResponse('COHORT_MISMATCH');
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
      rollbackReasons: Object.freeze([])
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
      BigInt(afterCohort.aiCreditsTotal) * BigInt(beforeCohort.acceptedOutcomes) * 10000n >
      BigInt(beforeCohort.aiCreditsTotal) * BigInt(afterCohort.acceptedOutcomes) *
      BigInt(10000 + policy.maxAiCreditIncreaseBps)) {
    rollbackReasons.push('AI_CREDIT_COST_REGRESSION');
  }

  const beforeCreditsPerOutcome = beforeCohort.aiCreditsTotal / beforeCohort.acceptedOutcomes;
  const afterCreditsPerOutcome = afterCohort.aiCreditsTotal / afterCohort.acceptedOutcomes;
  const metricsDelta = Object.freeze({
    medianCycleTimeDeltaMs: afterCohort.medianCycleTimeMs - beforeCohort.medianCycleTimeMs,
    reworkRateDeltaBps: afterCohort.reworkRateBps - beforeCohort.reworkRateBps,
    aiCreditsPerOutcomeDelta: afterCreditsPerOutcome - beforeCreditsPerOutcome
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
      metricsDelta
    });
  }

  const improved =
    afterCohort.medianCycleTimeMs < beforeCohort.medianCycleTimeMs ||
    afterCohort.reworkRateBps < beforeCohort.reworkRateBps ||
    BigInt(afterCohort.aiCreditsTotal) * BigInt(beforeCohort.acceptedOutcomes) <
      BigInt(beforeCohort.aiCreditsTotal) * BigInt(afterCohort.acceptedOutcomes);

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
    metricsDelta
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
  'circuitBreaker'
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
  'metricsDelta'
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
  'cohortId'
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

    let resolvedViolations = declaredViolations;
    if (hasOwnEnumerableData(entry, 'circuitBreaker')) {
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

function validMetricsDelta(delta) {
  return exactRecord(delta, [
    'medianCycleTimeDeltaMs',
    'reworkRateDeltaBps',
    'aiCreditsPerOutcomeDelta'
  ]) && Number.isFinite(delta.medianCycleTimeDeltaMs) &&
    Number.isFinite(delta.reworkRateDeltaBps) &&
    Number.isFinite(delta.aiCreditsPerOutcomeDelta);
}

function validateCohortVerdictEnvelope(verdict) {
  if (!isPlainObject(verdict) || !hasOwnEnumerableData(verdict, 'valid') ||
      verdict.valid !== true || !hasOwnEnumerableData(verdict, 'status')) {
    return {ok: false};
  }
  const hasRepo = hasOwnEnumerableData(verdict, 'repositoryId');
  const hasCohort = hasOwnEnumerableData(verdict, 'cohortId');
  const hasShadow = hasOwnEnumerableData(verdict, 'shadow');
  if ((hasRepo && !positiveInt(verdict.repositoryId)) ||
      (hasCohort && !validCohortId(verdict.cohortId)) ||
      (hasShadow && verdict.shadow !== true)) {
    return {ok: false};
  }

  const repositoryId = hasRepo ? verdict.repositoryId : null;
  const cohortId = hasCohort ? verdict.cohortId : null;

  if (verdict.status === 'INSUFFICIENT_COHORT') {
    if (!exactRecord(verdict, INSUFFICIENT_VERDICT_REQUIRED_KEYS, INSUFFICIENT_VERDICT_OPTIONAL_KEYS) ||
        verdict.cohortComplete !== false ||
        verdict.verifiedImprovement !== false ||
        verdict.rollbackRequired !== false ||
        verdict.minimumRequiredOutcomes !== MIN_COHORT_ACCEPTED_OUTCOMES ||
        !nonnegInt(verdict.beforeAcceptedOutcomes) ||
        !nonnegInt(verdict.afterAcceptedOutcomes) ||
        (verdict.beforeAcceptedOutcomes >= MIN_COHORT_ACCEPTED_OUTCOMES &&
          verdict.afterAcceptedOutcomes >= MIN_COHORT_ACCEPTED_OUTCOMES) ||
        !denseDataArray(verdict.rollbackReasons, 0)) {
      return {ok: false};
    }
    return {ok: true, rollbackRequired: false, repositoryId, cohortId};
  }

  if (!exactRecord(verdict, COMPLETED_VERDICT_REQUIRED_KEYS, COMPLETED_VERDICT_OPTIONAL_KEYS) ||
      verdict.cohortComplete !== true ||
      typeof verdict.verifiedImprovement !== 'boolean' ||
      typeof verdict.rollbackRequired !== 'boolean' ||
      (hasOwnEnumerableData(verdict, 'metricsDelta') && !validMetricsDelta(verdict.metricsDelta))) {
    return {ok: false};
  }

  if (verdict.status === 'VERIFIED_IMPROVEMENT' || verdict.status === 'NO_MATERIAL_GAIN') {
    if (verdict.rollbackRequired !== false ||
        verdict.verifiedImprovement !== (verdict.status === 'VERIFIED_IMPROVEMENT') ||
        !denseDataArray(verdict.rollbackReasons, 0)) {
      return {ok: false};
    }
    return {ok: true, rollbackRequired: false, repositoryId, cohortId};
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
  return {ok: true, rollbackRequired: true, repositoryId, cohortId};
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
  const hasPullNumber = hasOwnEnumerableData(candidateMeta, 'pullNumber');
  const hasIssueNumber = hasOwnEnumerableData(candidateMeta, 'issueNumber');

  if (!proposalScopeSet.has(scope) ||
      !contractDomainSet.has(domain) ||
      (hasTouchesContract && typeof candidateMeta.touchesContract !== 'boolean') ||
      (hasExplicitApproval && typeof candidateMeta.requiresHumanApproval !== 'boolean') ||
      (hasCohortId && !validCohortId(candidateMeta.cohortId)) ||
      (hasPullNumber && !positiveInt(candidateMeta.pullNumber)) ||
      (hasIssueNumber && !positiveInt(candidateMeta.issueNumber))) {
    return invalidRevertSpec('INVALID_CANDIDATE_META');
  }

  if (verdictCheck.cohortId !== null && hasCohortId &&
      verdictCheck.cohortId !== candidateMeta.cohortId) {
    return invalidRevertSpec('COHORT_ID_MISMATCH');
  }

  if (!verdictCheck.rollbackRequired) {
    return invalidRevertSpec('ROLLBACK_NOT_REQUIRED');
  }

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
