// Bounded M02.07 metrics- and feedback-driven optimistic improvement generator
// and matched >=5-outcome cohort verification / automatic rollback evaluator.
// Never mutates main or policy directly; deterministic gates stay outside agent loops.
import {types} from 'node:util';
import {
  EXACT_PROTECTED_CONTROL_PLANE_PATHS,
  SOFTWARE_FACTORY_REPOSITORY_ID,
  isProtectedControlPlanePath,
  isSafeRepoRelativePath,
  isWithinOwnedPaths
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

const proposalScopeSet = new Set(PROPOSAL_SCOPES);
const governedDomainSet = new Set(GOVERNED_CONTRACT_DOMAINS);
const contractDomainSet = new Set(['standard', ...GOVERNED_CONTRACT_DOMAINS]);
const governedFailureClasses = new Set(['security-contract', 'policy-drift', 'budget-cap', 'workflow-lock']);

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
  '.github/workflows',
  '.github/rulesets'
];

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function touchesGovernedContractPath(path) {
  if (isProtectedControlPlanePath(path)) return true;
  if (GOVERNED_PREFIX_ANCHORS.some(anchor => pathsOverlap(path, anchor))) return true;
  return /(^|\/)(governance|policy|security|budget|workflows?)(\/|\.|-|_|$)/i.test(path);
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
    cohortComplete: true,
    verifiedImprovement: improved,
    rollbackRequired: false,
    rollbackReasons: Object.freeze([]),
    metricsDelta
  });
}
