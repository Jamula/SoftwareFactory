// Deterministic, metadata-only pre-activation gate and shadow-denial verifier for M03 (FamilyTree).
// Evaluates synthetic fixtures only; never touches consumer repositories or grants live activation.
import { types } from 'node:util';
import { evaluate, validPolicy } from './core.mjs';
import {
  CONSUMER_BASELINE_COVERAGE,
  FACTORY_REPOSITORY_ID,
  verifyConsumerOnboardingPackage,
  verifyIndependentRollback
} from './consumer-onboarding.mjs';
import { pilotReadiness } from './pilot-readiness.mjs';

export const FAMILYTREE_PILOT_VERSION = '0.1.0';
export const FAMILYTREE_BASELINE_COVERAGE = CONSUMER_BASELINE_COVERAGE;
export const FAMILYTREE_REQUIRED_SHADOW_DENIALS = Object.freeze([
  'staleReview',
  'dismissedReview',
  'commentedBotReview',
  'wrongRepositoryId',
  'wrongRepositorySlug',
  'missingAiCreditQuota',
  'estimatedAiCreditQuota',
  'belowFloorLineCoverage',
  'belowFloorBranchCoverage',
  'emergencyStop',
  'duplicateEvent'
]);

const MAX_ARRAY_LEN = 64;
const MAX_EQUAL_DEPTH = 8;
const MAX_EQUAL_VISITS = 2048;

const CONFIG_KEYS = Object.freeze([
  'repositoryId',
  'policy',
  'localGates',
  'stop',
  'seenDeliveryIds'
]);

const LOCAL_GATES_KEYS = Object.freeze([
  'minLineCoverage',
  'minBranchCoverage',
  'maxConcurrency',
  'requiredChecks',
  'requireExplicitApproval',
  'requireStrictUpToDate'
]);

const CANDIDATE_KEYS = Object.freeze([
  'deliveryId',
  'repositoryId',
  'stop',
  'aiCreditQuota',
  'snapshot'
]);

const AI_QUOTA_KEYS = Object.freeze([
  'accountingSource',
  'isEstimated',
  'remainingAiCredits',
  'runAiCreditsRequired',
  'paidOverageEnabled',
  'overageHardStopUsdCents'
]);

const SNAPSHOT_KEYS = Object.freeze([
  'policySource',
  'repository',
  'issue',
  'pr',
  'head',
  'observedHead',
  'base',
  'observedBase',
  'baseBranch',
  'rateLimited',
  'remainingCredits',
  'activeCount',
  'providerReady',
  'risk',
  'priority',
  'paths',
  'dependencies',
  'acceptanceComplete',
  'baseCompatible',
  'mainHealthy',
  'threadsResolved',
  'securityClear',
  'coverage',
  'checks',
  'author',
  'agent',
  'reviews'
]);

const SF_POLICY_KEYS = Object.freeze([
  'repositoryId',
  'pin',
  'lineMin',
  'branchMin',
  'firstPilot'
]);

const SF_READINESS_KEYS = Object.freeze([
  'repositoryId',
  'pin',
  'enrolled',
  'stop',
  'upstreamAccepted',
  'review',
  'coverageLine',
  'coverageBranch',
  'requiredChecks',
  'quotaVerified',
  'rollbackVerified',
  'securityClear'
]);

const SUITE_KEYS = Object.freeze([
  'onboardingPackage',
  'peerPackages',
  'softwareFactoryBaseline',
  'rollbackReceipt',
  'eligibleCandidate',
  'denials'
]);

const READINESS_INPUT_KEYS = Object.freeze([
  'stop',
  'version',
  'productReleaseEnabled',
  'm01AutonomousAccepted',
  'familyTreeScopedAuthVerified',
  'sharedAdminTokenUsed',
  'productionDeploymentEnabled',
  'containsPrivateGenealogyData',
  'onboardingPackage',
  'shadowDenialSuite'
]);

const BOT_REVIEWERS = Object.freeze([
  'copilot-pull-request-reviewer',
  'copilot-pull-request-reviewer[bot]'
]);

const ownData = (obj, key) => {
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  return Boolean(desc && desc.enumerable && Object.hasOwn(desc, 'value'));
};

const exact = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  !types.isProxy(value) &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Reflect.ownKeys(value).length === keys.length &&
  keys.every(key => ownData(value, key));

const dense = value =>
  !types.isProxy(value) &&
  Array.isArray(value) &&
  Object.getPrototypeOf(value) === Array.prototype &&
  value.length <= MAX_ARRAY_LEN &&
  Reflect.ownKeys(value).length === value.length + 1 &&
  Array.from({ length: value.length }, (_, i) => ownData(value, i)).every(Boolean);

const text = value =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value;
const repoSlug = value => text(value) && /^[^/]+\/[^/]+$/.test(value);
const isSyntheticExampleRepo = value => identity(value).startsWith('example/');
const posInt = value => Number.isSafeInteger(value) && value > 0;
const pct = value => Number.isFinite(value) && value >= 0 && value <= 100;
const sha40 = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const identity = value => value.toLowerCase();

const validReviewShape = r =>
  exact(r, ['reviewer', 'head', 'state']) ||
  exact(r, ['reviewer', 'head', 'state', 'summaryDisposition']);

const validCheckShape = c =>
  exact(c, ['name', 'head', 'appId', 'status', 'conclusion']) &&
  text(c.name) &&
  sha40(c.head) &&
  posInt(c.appId) &&
  text(c.status) &&
  (c.conclusion === null || text(c.conclusion));

const strictPolicyEnvelope = p =>
  exact(p, [
    'version', 'repository', 'defaultBranch', 'mergeMethod', 'mode',
    'killSwitch', 'checks', 'reviewers', 'coverage', 'owners', 'maxActive',
    'creditLimit', 'riskClasses'
  ]) &&
  exact(p.coverage, ['line', 'branch']) &&
  dense(p.checks) &&
  p.checks.every(c => exact(c, ['name', 'appId'])) &&
  dense(p.reviewers) &&
  dense(p.owners) &&
  p.owners.every(o => exact(o, ['prefix', 'owner'])) &&
  dense(p.riskClasses) &&
  validPolicy(p);

const strictSnapshotShape = s =>
  exact(s, SNAPSHOT_KEYS) &&
  exact(s.coverage, ['head', 'line', 'branch', 'complete']) &&
  dense(s.paths) &&
  dense(s.dependencies) &&
  s.dependencies.every(d => exact(d, ['issue', 'accepted'])) &&
  dense(s.checks) &&
  s.checks.every(validCheckShape) &&
  dense(s.reviews) &&
  s.reviews.every(validReviewShape);

function sameDataBounded(candidateVal, expectedVal, depth, budget) {
  budget.remaining -= 1;
  if (depth > MAX_EQUAL_DEPTH ||
      budget.remaining < 0 ||
      types.isProxy(expectedVal) ||
      types.isProxy(candidateVal)) {
    return false;
  }
  if (!expectedVal || typeof expectedVal !== 'object') {
    return Object.is(candidateVal, expectedVal);
  }
  if (Array.isArray(expectedVal)) {
    return dense(expectedVal) &&
      dense(candidateVal) &&
      candidateVal.length === expectedVal.length &&
      expectedVal.every((item, i) => sameDataBounded(candidateVal[i], item, depth + 1, budget));
  }
  if (Object.getPrototypeOf(expectedVal) !== Object.prototype) {
    return false;
  }
  const keys = Reflect.ownKeys(expectedVal);
  if (!keys.every(key => typeof key === 'string' && ownData(expectedVal, key))) {
    return false;
  }
  return exact(candidateVal, keys) &&
    keys.every(key => sameDataBounded(candidateVal[key], expectedVal[key], depth + 1, budget));
}

const equalData = (candidateVal, expectedVal) =>
  sameDataBounded(candidateVal, expectedVal, 0, { remaining: MAX_EQUAL_VISITS });

const singleMutation = (baseObj, candidateObj, mutatedField) => {
  const keys = Object.keys(baseObj);
  return exact(candidateObj, keys) &&
    keys.every(key => key === mutatedField || equalData(candidateObj[key], baseObj[key]));
};

const denyCandidate = reason =>
  Object.freeze({
    shadow: true,
    eligible: false,
    liveActivation: false,
    liveMutations: 0,
    reason
  });

const validLocalGates = (policy, gates) =>
  exact(gates, LOCAL_GATES_KEYS) &&
  pct(gates.minLineCoverage) &&
  pct(gates.minBranchCoverage) &&
  gates.maxConcurrency === 1 &&
  policy.maxActive === 1 &&
  gates.requireExplicitApproval === true &&
  gates.requireStrictUpToDate === true &&
  dense(gates.requiredChecks) &&
  gates.requiredChecks.length > 0 &&
  gates.requiredChecks.every(req =>
    exact(req, ['name', 'appId']) &&
    text(req.name) &&
    posInt(req.appId) &&
    policy.checks.some(c => c.name === req.name && c.appId === req.appId));

export function evaluateFamilyTreeShadowCandidate(config, candidate) {
  if (!exact(config, CONFIG_KEYS) ||
      !posInt(config.repositoryId) ||
      config.repositoryId === FACTORY_REPOSITORY_ID ||
      !strictPolicyEnvelope(config.policy) ||
      !isSyntheticExampleRepo(config.policy.repository) ||
      !validLocalGates(config.policy, config.localGates) ||
      typeof config.stop !== 'boolean' ||
      !dense(config.seenDeliveryIds) ||
      !config.seenDeliveryIds.every(text)) {
    return denyCandidate('CANDIDATE_CONFIG_INVALID');
  }

  if (!exact(candidate, CANDIDATE_KEYS) ||
      !text(candidate.deliveryId) ||
      !posInt(candidate.repositoryId) ||
      typeof candidate.stop !== 'boolean' ||
      !exact(candidate.aiCreditQuota, AI_QUOTA_KEYS) ||
      !strictSnapshotShape(candidate.snapshot)) {
    return denyCandidate('CANDIDATE_SCHEMA_INVALID');
  }

  if (config.stop || candidate.stop) {
    return denyCandidate('STOPPED');
  }

  if (candidate.repositoryId !== config.repositoryId) {
    return denyCandidate('WRONG_REPOSITORY_ID');
  }

  if (config.seenDeliveryIds.includes(candidate.deliveryId)) {
    return denyCandidate('DUPLICATE_EVENT');
  }

  const quota = candidate.aiCreditQuota;
  if (quota.accountingSource !== 'verified' ||
      quota.isEstimated !== false ||
      !posInt(quota.runAiCreditsRequired) ||
      !posInt(quota.remainingAiCredits) ||
      quota.remainingAiCredits < quota.runAiCreditsRequired ||
      candidate.snapshot.remainingCredits !== quota.remainingAiCredits ||
      quota.paidOverageEnabled !== false ||
      !Object.is(quota.overageHardStopUsdCents, 0)) {
    return denyCandidate('AI_CREDIT_QUOTA_MISSING_OR_ESTIMATED');
  }

  const minLine = Math.max(
    FAMILYTREE_BASELINE_COVERAGE.line,
    config.policy.coverage.line,
    config.localGates.minLineCoverage
  );
  const minBranch = Math.max(
    FAMILYTREE_BASELINE_COVERAGE.branch,
    config.policy.coverage.branch,
    config.localGates.minBranchCoverage
  );
  const cov = candidate.snapshot.coverage;
  if (cov.complete !== true ||
      cov.head !== candidate.snapshot.head ||
      !pct(cov.line) ||
      !pct(cov.branch) ||
      cov.line < minLine ||
      cov.branch < minBranch) {
    return denyCandidate('COVERAGE_BELOW_FLOOR');
  }

  const shadowPolicy = {
    ...config.policy,
    mode: 'shadow',
    killSwitch: false,
    coverage: { line: minLine, branch: minBranch }
  };
  const decision = evaluate(shadowPolicy, candidate.snapshot);
  if (decision.reason !== 'SHADOW_ELIGIBLE') {
    return denyCandidate(decision.reason);
  }

  return Object.freeze({
    shadow: true,
    eligible: true,
    liveActivation: false,
    liveMutations: 0,
    reason: 'SHADOW_ELIGIBLE'
  });
}

const isStaleReviewCandidate = (baseCand, cand) =>
  singleMutation(baseCand, cand, 'snapshot') &&
  singleMutation(baseCand.snapshot, cand.snapshot, 'reviews') &&
  dense(cand.snapshot.reviews) &&
  cand.snapshot.reviews.length === baseCand.snapshot.reviews.length &&
  cand.snapshot.reviews.every((r, i) =>
    exact(r, ['reviewer', 'head', 'state']) &&
    r.reviewer === baseCand.snapshot.reviews[i].reviewer &&
    r.state === 'APPROVED' &&
    sha40(r.head) &&
    r.head !== baseCand.snapshot.head);

const isDismissedReviewCandidate = (baseCand, cand) =>
  singleMutation(baseCand, cand, 'snapshot') &&
  singleMutation(baseCand.snapshot, cand.snapshot, 'reviews') &&
  dense(cand.snapshot.reviews) &&
  cand.snapshot.reviews.length === baseCand.snapshot.reviews.length &&
  cand.snapshot.reviews.every((r, i) =>
    exact(r, ['reviewer', 'head', 'state']) &&
    r.reviewer === baseCand.snapshot.reviews[i].reviewer &&
    r.head === baseCand.snapshot.head &&
    r.state === 'DISMISSED');

const isCommentedBotCandidate = (baseCand, cand) =>
  singleMutation(baseCand, cand, 'snapshot') &&
  singleMutation(baseCand.snapshot, cand.snapshot, 'reviews') &&
  dense(cand.snapshot.reviews) &&
  cand.snapshot.reviews.length === 1 &&
  exact(cand.snapshot.reviews[0], ['reviewer', 'head', 'state', 'summaryDisposition']) &&
  text(cand.snapshot.reviews[0].reviewer) &&
  BOT_REVIEWERS.includes(identity(cand.snapshot.reviews[0].reviewer)) &&
  cand.snapshot.reviews[0].head === baseCand.snapshot.head &&
  cand.snapshot.reviews[0].state === 'COMMENTED' &&
  cand.snapshot.reviews[0].summaryDisposition === 'clear';

const isWrongRepositoryIdCandidate = (baseCand, cand) =>
  singleMutation(baseCand, cand, 'repositoryId') &&
  posInt(cand.repositoryId) &&
  cand.repositoryId !== baseCand.repositoryId;

const isWrongRepositorySlugCandidate = (baseCand, cand) =>
  singleMutation(baseCand, cand, 'snapshot') &&
  singleMutation(baseCand.snapshot, cand.snapshot, 'repository') &&
  repoSlug(cand.snapshot.repository) &&
  isSyntheticExampleRepo(cand.snapshot.repository) &&
  identity(cand.snapshot.repository) !== identity(baseCand.snapshot.repository);

const isMissingAiCreditCandidate = (baseCand, cand) =>
  singleMutation(baseCand, cand, 'aiCreditQuota') &&
  singleMutation(baseCand.aiCreditQuota, cand.aiCreditQuota, 'remainingAiCredits') &&
  (cand.aiCreditQuota.remainingAiCredits === null ||
    (Number.isSafeInteger(cand.aiCreditQuota.remainingAiCredits) &&
      cand.aiCreditQuota.remainingAiCredits <= 0));

const isEstimatedAiCreditCandidate = (baseCand, cand) =>
  singleMutation(baseCand, cand, 'aiCreditQuota') &&
  exact(cand.aiCreditQuota, AI_QUOTA_KEYS) &&
  text(cand.aiCreditQuota.accountingSource) &&
  cand.aiCreditQuota.isEstimated === true &&
  AI_QUOTA_KEYS.every(key =>
    key === 'isEstimated' ||
    key === 'accountingSource' ||
    equalData(cand.aiCreditQuota[key], baseCand.aiCreditQuota[key]));

const isBelowFloorCoverageCandidate = (baseCand, cand, field, floor) =>
  singleMutation(baseCand, cand, 'snapshot') &&
  singleMutation(baseCand.snapshot, cand.snapshot, 'coverage') &&
  singleMutation(baseCand.snapshot.coverage, cand.snapshot.coverage, field) &&
  pct(cand.snapshot.coverage[field]) &&
  cand.snapshot.coverage[field] < floor;

const isEmergencyStopCandidate = (baseCand, cand) =>
  singleMutation(baseCand, cand, 'stop') && cand.stop === true;

const denySuite = reason =>
  Object.freeze({
    shadow: true,
    valid: false,
    liveActivation: false,
    zeroLiveMutations: false,
    reason
  });

export function proveFamilyTreeShadowDenials(suite) {
  if (!exact(suite, SUITE_KEYS) ||
      !dense(suite.peerPackages) ||
      suite.peerPackages.length === 0 ||
      !exact(suite.softwareFactoryBaseline, ['policy', 'readiness']) ||
      !exact(suite.denials, FAMILYTREE_REQUIRED_SHADOW_DENIALS)) {
    return denySuite('SHADOW_SUITE_INVALID');
  }

  const onboarding = verifyConsumerOnboardingPackage(suite.onboardingPackage);
  if (!onboarding.valid) {
    return denySuite(onboarding.reason);
  }

  if (!isSyntheticExampleRepo(suite.onboardingPackage.policy.repository) ||
      suite.onboardingPackage.policy.maxActive !== 1 ||
      suite.onboardingPackage.localGates.maxConcurrency !== 1) {
    return denySuite('FAMILYTREE_PROFILE_CONSTRAINTS_INVALID');
  }

  const sfBaseline = suite.softwareFactoryBaseline;
  if (!exact(sfBaseline.policy, SF_POLICY_KEYS) ||
      !exact(sfBaseline.readiness, SF_READINESS_KEYS)) {
    return denySuite('SOFTWARE_FACTORY_BASELINE_INVALID');
  }
  const sfBefore = pilotReadiness(sfBaseline.policy, sfBaseline.readiness);
  if (!sfBefore.ready ||
      sfBaseline.policy.repositoryId !== FACTORY_REPOSITORY_ID ||
      sfBaseline.policy.lineMin < 98 ||
      sfBaseline.policy.branchMin < 95 ||
      sfBaseline.policy.firstPilot !== true) {
    return denySuite('SOFTWARE_FACTORY_BASELINE_INVALID');
  }

  const baseCand = suite.eligibleCandidate;
  if (!exact(baseCand, CANDIDATE_KEYS) ||
      !exact(baseCand.aiCreditQuota, AI_QUOTA_KEYS) ||
      !strictSnapshotShape(baseCand.snapshot)) {
    return denySuite('SHADOW_DENIAL_SCENARIO_INVALID');
  }

  const minLine = Math.max(
    FAMILYTREE_BASELINE_COVERAGE.line,
    suite.onboardingPackage.policy.coverage.line,
    suite.onboardingPackage.localGates.minLineCoverage
  );
  const minBranch = Math.max(
    FAMILYTREE_BASELINE_COVERAGE.branch,
    suite.onboardingPackage.policy.coverage.branch,
    suite.onboardingPackage.localGates.minBranchCoverage
  );

  const d = suite.denials;
  if (!isStaleReviewCandidate(baseCand, d.staleReview) ||
      !isDismissedReviewCandidate(baseCand, d.dismissedReview) ||
      !isCommentedBotCandidate(baseCand, d.commentedBotReview) ||
      !isWrongRepositoryIdCandidate(baseCand, d.wrongRepositoryId) ||
      !isWrongRepositorySlugCandidate(baseCand, d.wrongRepositorySlug) ||
      !isMissingAiCreditCandidate(baseCand, d.missingAiCreditQuota) ||
      !isEstimatedAiCreditCandidate(baseCand, d.estimatedAiCreditQuota) ||
      !isBelowFloorCoverageCandidate(baseCand, d.belowFloorLineCoverage, 'line', minLine) ||
      !isBelowFloorCoverageCandidate(baseCand, d.belowFloorBranchCoverage, 'branch', minBranch) ||
      !isEmergencyStopCandidate(baseCand, d.emergencyStop) ||
      !equalData(d.duplicateEvent, baseCand)) {
    return denySuite('SHADOW_DENIAL_SCENARIO_INVALID');
  }

  const baseConfig = {
    repositoryId: suite.onboardingPackage.repositoryId,
    policy: suite.onboardingPackage.policy,
    localGates: suite.onboardingPackage.localGates,
    stop: false,
    seenDeliveryIds: []
  };

  const botReviewer = d.commentedBotReview.snapshot.reviews[0].reviewer;
  const hasAllowlistedBot = baseConfig.policy.reviewers.some(
    r => identity(r) === identity(botReviewer)
  );
  const botConfig = {
    ...baseConfig,
    policy: hasAllowlistedBot
      ? baseConfig.policy
      : { ...baseConfig.policy, reviewers: [...baseConfig.policy.reviewers, botReviewer] }
  };
  const botApprovedControl = {
    ...baseCand,
    snapshot: {
      ...baseCand.snapshot,
      reviews: [{ reviewer: botReviewer, head: baseCand.snapshot.head, state: 'APPROVED' }]
    }
  };

  const shadowChecks = [
    [baseConfig, baseCand, 'SHADOW_ELIGIBLE'],
    [botConfig, botApprovedControl, 'SHADOW_ELIGIBLE'],
    [baseConfig, d.staleReview, 'REVIEW_MISSING'],
    [baseConfig, d.dismissedReview, 'REVIEW_MISSING'],
    [botConfig, d.commentedBotReview, 'REVIEW_MISSING'],
    [baseConfig, d.wrongRepositoryId, 'WRONG_REPOSITORY_ID'],
    [baseConfig, d.wrongRepositorySlug, 'UNTRUSTED_POLICY'],
    [baseConfig, d.missingAiCreditQuota, 'AI_CREDIT_QUOTA_MISSING_OR_ESTIMATED'],
    [baseConfig, d.estimatedAiCreditQuota, 'AI_CREDIT_QUOTA_MISSING_OR_ESTIMATED'],
    [baseConfig, d.belowFloorLineCoverage, 'COVERAGE_BELOW_FLOOR'],
    [baseConfig, d.belowFloorBranchCoverage, 'COVERAGE_BELOW_FLOOR'],
    [baseConfig, d.emergencyStop, 'STOPPED'],
    [{ ...baseConfig, stop: true }, baseCand, 'STOPPED'],
    [{ ...baseConfig, seenDeliveryIds: [baseCand.deliveryId] }, d.duplicateEvent, 'DUPLICATE_EVENT']
  ];

  if (!shadowChecks.every(([cfg, cand, expected]) =>
    evaluateFamilyTreeShadowCandidate(cfg, cand).reason === expected)) {
    return denySuite('SHADOW_DENIAL_NOT_PROVEN');
  }

  const rollbackCheck = verifyIndependentRollback(
    suite.onboardingPackage.policy.repository,
    suite.rollbackReceipt,
    [suite.onboardingPackage, ...suite.peerPackages]
  );
  if (!rollbackCheck.valid) {
    return denySuite(rollbackCheck.reason);
  }

  if (!suite.peerPackages.every(peer => isSyntheticExampleRepo(peer.policy.repository))) {
    return denySuite('FAMILYTREE_PROFILE_CONSTRAINTS_INVALID');
  }

  return Object.freeze({
    shadow: true,
    valid: true,
    liveActivation: false,
    zeroLiveMutations: true,
    reason: 'FAMILYTREE_SHADOW_DENIALS_PROVEN',
    repository: onboarding.repository,
    repositoryId: onboarding.repositoryId,
    verifiedDenials: FAMILYTREE_REQUIRED_SHADOW_DENIALS,
    rollback: Object.freeze({
      stoppedRepository: rollbackCheck.stoppedRepository,
      targetDecision: rollbackCheck.targetDecision,
      unaffectedPeers: rollbackCheck.unaffectedPeers,
      softwareFactoryUnaffected: true
    })
  });
}

const denyReadinessEarly = reason =>
  Object.freeze({
    shadow: true,
    ready: false,
    liveActivation: false,
    upstreamM01Accepted: false,
    familyTreeScopedAuthVerified: false,
    onboardingContractVerified: false,
    shadowDenialsVerified: false,
    zeroLiveMutations: false,
    reason
  });

const denyReadinessGated = (reason, upstreamM01Accepted, familyTreeScopedAuthVerified) =>
  Object.freeze({
    shadow: true,
    ready: false,
    liveActivation: false,
    upstreamM01Accepted,
    familyTreeScopedAuthVerified,
    onboardingContractVerified: true,
    shadowDenialsVerified: true,
    zeroLiveMutations: true,
    reason
  });

export function evaluateFamilyTreeShadowReadiness(input) {
  if (!exact(input, READINESS_INPUT_KEYS) ||
      typeof input.stop !== 'boolean' ||
      typeof input.version !== 'string' ||
      typeof input.productReleaseEnabled !== 'boolean' ||
      typeof input.m01AutonomousAccepted !== 'boolean' ||
      typeof input.familyTreeScopedAuthVerified !== 'boolean' ||
      typeof input.sharedAdminTokenUsed !== 'boolean' ||
      typeof input.productionDeploymentEnabled !== 'boolean' ||
      typeof input.containsPrivateGenealogyData !== 'boolean') {
    return denyReadinessEarly('INPUT_SCHEMA_INVALID');
  }

  if (input.stop) {
    return denyReadinessEarly('STOPPED');
  }

  if (input.containsPrivateGenealogyData) {
    return denyReadinessEarly('PRIVATE_GENEALOGY_DATA_FORBIDDEN');
  }

  if (input.productionDeploymentEnabled) {
    return denyReadinessEarly('PRODUCTION_DEPLOYMENT_FORBIDDEN');
  }

  if (input.sharedAdminTokenUsed) {
    return denyReadinessEarly('SHARED_ADMIN_TOKEN_FORBIDDEN');
  }

  if (input.version !== FAMILYTREE_PILOT_VERSION || input.productReleaseEnabled) {
    return denyReadinessEarly('VERSION_OR_RELEASE_FORBIDDEN');
  }

  const onboarding = verifyConsumerOnboardingPackage(input.onboardingPackage);
  if (!onboarding.valid) {
    return denyReadinessEarly(onboarding.reason);
  }

  const denialProof = proveFamilyTreeShadowDenials(input.shadowDenialSuite);
  if (!denialProof.valid) {
    return denyReadinessEarly(denialProof.reason);
  }

  if (!equalData(input.shadowDenialSuite.onboardingPackage, input.onboardingPackage)) {
    return denyReadinessEarly('ONBOARDING_SUITE_MISMATCH');
  }

  const eligibleSnap = input.shadowDenialSuite.eligibleCandidate.snapshot;
  const minLine = Math.max(
    FAMILYTREE_BASELINE_COVERAGE.line,
    input.onboardingPackage.policy.coverage.line,
    input.onboardingPackage.localGates.minLineCoverage
  );
  const minBranch = Math.max(
    FAMILYTREE_BASELINE_COVERAGE.branch,
    input.onboardingPackage.policy.coverage.branch,
    input.onboardingPackage.localGates.minBranchCoverage
  );

  const preflight = pilotReadiness(
    {
      repositoryId: onboarding.repositoryId,
      pin: onboarding.pinnedWorkflowSha,
      lineMin: minLine,
      branchMin: minBranch,
      firstPilot: false
    },
    {
      repositoryId: onboarding.repositoryId,
      pin: onboarding.pinnedWorkflowSha,
      enrolled: true,
      stop: false,
      upstreamAccepted: input.m01AutonomousAccepted,
       review: true,
      coverageLine: eligibleSnap.coverage.line,
      coverageBranch: eligibleSnap.coverage.branch,
      requiredChecks: true,
      quotaVerified: true,
      rollbackVerified: true,
      securityClear: true
    }
  );

  if (!preflight.ready) {
    return denyReadinessGated('UPSTREAM_M01_NOT_ACCEPTED', false, input.familyTreeScopedAuthVerified);
  }

  if (!input.familyTreeScopedAuthVerified) {
    return denyReadinessGated('FAMILYTREE_SCOPED_AUTH_REQUIRED', true, false);
  }

  return Object.freeze({
    shadow: true,
    ready: true,
    liveActivation: false,
    upstreamM01Accepted: true,
    familyTreeScopedAuthVerified: true,
    onboardingContractVerified: true,
    shadowDenialsVerified: true,
    zeroLiveMutations: true,
    reason: 'FAMILYTREE_SHADOW_READY_ONLY',
    repository: onboarding.repository,
    repositoryId: onboarding.repositoryId,
    pinnedWorkflowSha: onboarding.pinnedWorkflowSha,
    pinnedCheckoutSha: onboarding.pinnedCheckoutSha,
    verifiedDenials: denialProof.verifiedDenials,
    rollback: denialProof.rollback
  });
}
