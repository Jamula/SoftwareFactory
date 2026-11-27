// Deterministic, metadata-only pre-activation gate and freeze-isolation verifier for M05.01 (#12) FamilyHub adoption.
// Pure offline shadow evaluator: never reads from, touches, or mutates Jamula/FamilyHub or live GitHub state.
import { types } from 'node:util';
import { evaluate } from './core.mjs';
import {
  CONSUMER_BASELINE_COVERAGE,
  FACTORY_REPOSITORY,
  FACTORY_REPOSITORY_ID,
  verifyConsumerOnboardingPackage,
  verifyIndependentRollback
} from './consumer-onboarding.mjs';
import { coverageEvidence } from './coverage-evidence.mjs';

export const FAMILYHUB_MILESTONE_ID = 'M05.01';
export const FAMILYHUB_ISSUE_NUMBER = 12;
export const FAMILYHUB_READINESS_ISSUE_NUMBER = 81;
export const UPSTREAM_M01_ISSUE_NUMBER = 10;
export const UPSTREAM_ONBOARDING_ISSUE_NUMBER = 13;
export const UPSTREAM_FAMILYTREE_ISSUE_NUMBER = 36;
export const FAMILYHUB_REQUIRED_CHECK_CONTEXTS = Object.freeze(['copilot-review', 'validate']);
export const FAMILYHUB_MIN_COVERAGE = Object.freeze({
  line: CONSUMER_BASELINE_COVERAGE.line,
  branch: CONSUMER_BASELINE_COVERAGE.branch
});

const LIVE_FAMILYHUB_REPOSITORY = 'jamula/familyhub';
const EMAIL_PII_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

const INPUT_KEYS = Object.freeze([
  'stop',
  'syntheticFixtureOnly',
  'containsPrivateFamilyData',
  'migrationCompleteVerified',
  'ownerFreezeLiftedVerified',
  'authoritativeRepoConfirmed',
  'm01AutonomousAccepted',
  'familyTreePilotAccepted',
  'spellbookPilotAccepted',
  'm02SpeedAccepted',
  'productionDeploymentIsolated',
  'liveProductionDeployAllowed',
  'authorization',
  'onboardingPackage',
  'peerOnboardingPackages',
  'candidate',
  'shadowDenialSuite',
  'rollbackReceipt'
]);

const BOOLEAN_INPUT_KEYS = Object.freeze([
  'stop',
  'syntheticFixtureOnly',
  'containsPrivateFamilyData',
  'migrationCompleteVerified',
  'ownerFreezeLiftedVerified',
  'authoritativeRepoConfirmed',
  'm01AutonomousAccepted',
  'familyTreePilotAccepted',
  'spellbookPilotAccepted',
  'm02SpeedAccepted',
  'productionDeploymentIsolated',
  'liveProductionDeployAllowed'
]);

const AUTH_KEYS = Object.freeze([
  'separateScopedOwnerAuth',
  'developmentResumptionOnly',
  'familyHubReadiness81Verified',
  'authorizedRepository',
  'authorizedRepositoryId',
  'zeroIncrementalSpendVerified',
  'hostedExecutionWithoutLaptopVerified'
]);

const BOOLEAN_AUTH_KEYS = Object.freeze([
  'separateScopedOwnerAuth',
  'developmentResumptionOnly',
  'familyHubReadiness81Verified',
  'zeroIncrementalSpendVerified',
  'hostedExecutionWithoutLaptopVerified'
]);

const ONBOARDING_ENVELOPE_BOOL_KEYS = Object.freeze([
  'ownerAuthorized',
  'migrationFreezeClear',
  'autoActivate',
  'productionDeployEnabled'
]);

const CANDIDATE_KEYS = Object.freeze([
  'candidateHeadSha',
  'candidateBaseSha',
  'latestProtectedMainSha',
  'behindByCommits',
  'triggersProductionDeploy',
  'componentInventory',
  'coverageReports',
  'reviewSummary',
  'snapshot'
]);

const REVIEW_SUMMARY_KEYS = Object.freeze([
  'summaryDisposition',
  'unresolvedSummaryFindings',
  'unresolvedInlineThreads'
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

const DENIAL_SUITE_KEYS = Object.freeze([
  'staleReview',
  'dismissedReview',
  'commentedZeroThreadsReview',
  'behindMainCandidate',
  'missingCopilotReviewCheck',
  'missingValidateCheck'
]);

const ownData = (obj, key) => {
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  return Boolean(desc && desc.enumerable && Object.hasOwn(desc, 'value'));
};

function plainJson(value, depth) {
  if (depth > 12 || types.isProxy(value)) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    return proto === Array.prototype &&
      value.length <= 64 &&
      Reflect.ownKeys(value).length === value.length + 1 &&
      Array.from({ length: value.length }, (_, i) =>
        ownData(value, i) && plainJson(value[i], depth + 1)
      ).every(Boolean);
  }
  if (proto !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length <= 64 &&
    keys.every(k => typeof k === 'string' && ownData(value, k) && plainJson(value[k], depth + 1));
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const exact = (value, keys) =>
  isRecord(value) &&
  Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));

const bool = value => typeof value === 'boolean';
const posInt = value => Number.isSafeInteger(value) && value > 0;
const nonNegInt = value => Number.isSafeInteger(value) && value >= 0;
const sha40 = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const text = value =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 200 &&
  value.trim() === value &&
  !/[\u0000-\u001f\u007f]/.test(value);
const repoSlug = value =>
  text(value) &&
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) &&
  !value.includes('..');
const identity = value => value.toLowerCase();

function validReviewEntry(review) {
  if (exact(review, ['reviewer', 'head', 'state'])) {
    return text(review.reviewer) && sha40(review.head) && text(review.state);
  }
  return exact(review, ['reviewer', 'head', 'state', 'summaryDisposition']) &&
    text(review.reviewer) &&
    sha40(review.head) &&
    review.state === 'COMMENTED' &&
    text(review.summaryDisposition);
}

function validSnapshotShape(snapshot) {
  return exact(snapshot, SNAPSHOT_KEYS) &&
    repoSlug(snapshot.repository) &&
    text(snapshot.author) &&
    text(snapshot.agent) &&
    exact(snapshot.coverage, ['head', 'line', 'branch', 'complete']) &&
    Array.isArray(snapshot.paths) &&
    snapshot.paths.every(text) &&
    Array.isArray(snapshot.dependencies) &&
    snapshot.dependencies.every(d => exact(d, ['issue', 'accepted'])) &&
    Array.isArray(snapshot.checks) &&
    snapshot.checks.every(c => exact(c, ['name', 'head', 'appId', 'status', 'conclusion'])) &&
    Array.isArray(snapshot.reviews) &&
    snapshot.reviews.every(validReviewEntry);
}

const validAuthorizationShape = auth =>
  exact(auth, AUTH_KEYS) &&
  BOOLEAN_AUTH_KEYS.every(k => bool(auth[k])) &&
  repoSlug(auth.authorizedRepository) &&
  posInt(auth.authorizedRepositoryId);

const validOnboardingEnvelope = pkg =>
  isRecord(pkg) &&
  ONBOARDING_ENVELOPE_BOOL_KEYS.every(k => Object.hasOwn(pkg, k) && bool(pkg[k])) &&
  isRecord(pkg.policy) &&
  repoSlug(pkg.policy.repository);

const validCandidateShape = candidate =>
  exact(candidate, CANDIDATE_KEYS) &&
  [candidate.candidateHeadSha, candidate.candidateBaseSha, candidate.latestProtectedMainSha].every(sha40) &&
  nonNegInt(candidate.behindByCommits) &&
  bool(candidate.triggersProductionDeploy) &&
  Array.isArray(candidate.componentInventory) &&
  candidate.componentInventory.length > 0 &&
  candidate.componentInventory.every(text) &&
  Array.isArray(candidate.coverageReports) &&
  candidate.coverageReports.length > 0 &&
  exact(candidate.reviewSummary, REVIEW_SUMMARY_KEYS) &&
  text(candidate.reviewSummary.summaryDisposition) &&
  nonNegInt(candidate.reviewSummary.unresolvedSummaryFindings) &&
  nonNegInt(candidate.reviewSummary.unresolvedInlineThreads) &&
  validSnapshotShape(candidate.snapshot);

const validInputShape = input =>
  plainJson(input, 0) &&
  exact(input, INPUT_KEYS) &&
  BOOLEAN_INPUT_KEYS.every(k => bool(input[k])) &&
  validAuthorizationShape(input.authorization) &&
  validOnboardingEnvelope(input.onboardingPackage) &&
  Array.isArray(input.peerOnboardingPackages) &&
  input.peerOnboardingPackages.length > 0 &&
  validCandidateShape(input.candidate) &&
  exact(input.shadowDenialSuite, DENIAL_SUITE_KEYS) &&
  isRecord(input.rollbackReceipt) &&
  repoSlug(input.rollbackReceipt.repository);

const nonNullObj = value => typeof value === 'object' && value !== null;

function equalValidatedValue(a, b) {
  if (Object.is(a, b)) return true;
  if (!nonNullObj(a) || !nonNullObj(b) || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((item, idx) => equalValidatedValue(item, b[idx]));
  }
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length &&
    keys.every(k => Object.hasOwn(b, k) && equalValidatedValue(a[k], b[k]));
}

const singleMutation = (baseSnap, candidateSnap, field) =>
  validSnapshotShape(candidateSnap) &&
  SNAPSHOT_KEYS.every(key => key === field || equalValidatedValue(candidateSnap[key], baseSnap[key]));

const deny = reason =>
  Object.freeze({
    milestone: FAMILYHUB_MILESTONE_ID,
    issue: FAMILYHUB_ISSUE_NUMBER,
    shadow: true,
    ready: false,
    eligible: false,
    liveActivation: false,
    liveProductionDeployAllowed: false,
    mutatesGitHub: false,
    state: 'blocked',
    reason
  });

export function evaluateFamilyHubShadowReadiness(input) {
  if (!validInputShape(input)) {
    return deny('INPUT_SCHEMA_INVALID');
  }

  const auth = input.authorization;
  const pkg = input.onboardingPackage;
  const candidate = input.candidate;
  const snap = candidate.snapshot;
  const serializedInput = JSON.stringify(input);
  const factorySlug = identity(FACTORY_REPOSITORY);
  const peerUsesFactory = input.peerOnboardingPackages.some(peer =>
    isRecord(peer) && (
      peer.repositoryId === FACTORY_REPOSITORY_ID ||
      (isRecord(peer.policy) &&
        typeof peer.policy.repository === 'string' &&
        identity(peer.policy.repository) === factorySlug)
    )
  );

  if (
    !input.syntheticFixtureOnly ||
    input.containsPrivateFamilyData ||
    serializedInput.toLowerCase().includes(LIVE_FAMILYHUB_REPOSITORY) ||
    EMAIL_PII_PATTERN.test(serializedInput) ||
    [
      auth.authorizedRepository,
      pkg.policy.repository,
      snap.repository,
      input.rollbackReceipt.repository
    ].some(slug => identity(slug) === factorySlug) ||
    auth.authorizedRepositoryId === FACTORY_REPOSITORY_ID ||
    pkg.repositoryId === FACTORY_REPOSITORY_ID ||
    peerUsesFactory
  ) {
    return deny('LIVE_REPO_OR_PRIVATE_DATA_FORBIDDEN');
  }

  if (input.stop) {
    return deny('STOPPED');
  }

  // Hard Freeze Gate: FamilyHub remains strictly frozen unless migration completion,
  // explicit owner freeze lift, and authoritative repository confirmation are all verified.
  if (
    !input.migrationCompleteVerified ||
    !input.ownerFreezeLiftedVerified ||
    !input.authoritativeRepoConfirmed ||
    !pkg.migrationFreezeClear
  ) {
    return deny('CONSUMER_FROZEN');
  }

  if (!input.m01AutonomousAccepted) {
    return deny('M01_UPSTREAM_NOT_ACCEPTED');
  }

  if (!input.familyTreePilotAccepted) {
    return deny('FAMILYTREE_PILOT_NOT_ACCEPTED');
  }

  if (
    !input.productionDeploymentIsolated ||
    input.liveProductionDeployAllowed ||
    candidate.triggersProductionDeploy ||
    pkg.productionDeployEnabled
  ) {
    return deny('PRODUCTION_ISOLATION_VIOLATION');
  }

  if (
    !auth.separateScopedOwnerAuth ||
    auth.developmentResumptionOnly ||
    !auth.familyHubReadiness81Verified ||
    !auth.zeroIncrementalSpendVerified ||
    !auth.hostedExecutionWithoutLaptopVerified ||
    !pkg.ownerAuthorized ||
    pkg.autoActivate
  ) {
    return deny('SEPARATE_AUTHORIZATION_REQUIRED');
  }

  const pkgCheck = verifyConsumerOnboardingPackage(pkg);
  if (!pkgCheck.valid) {
    return deny(pkgCheck.reason);
  }

  const policy = pkg.policy;
  const localGates = pkg.localGates;

  if (
    auth.authorizedRepository !== policy.repository ||
    auth.authorizedRepositoryId !== pkg.repositoryId
  ) {
    return deny('AUTHORIZATION_REPO_MISMATCH');
  }

  const declaredRequiredContexts = new Set(localGates.requiredChecks.map(c => c.name));
  if (!FAMILYHUB_REQUIRED_CHECK_CONTEXTS.every(ctx => declaredRequiredContexts.has(ctx))) {
    return deny('REQUIRED_CHECKS_MISSING');
  }

  if (
    candidate.candidateHeadSha === candidate.latestProtectedMainSha ||
    snap.head !== candidate.candidateHeadSha ||
    snap.observedHead !== candidate.candidateHeadSha
  ) {
    return deny('CANDIDATE_HEAD_MISMATCH');
  }

  // Strict up-to-date base freshness: behind-main candidates are rejected even if git-mergeable.
  if (
    candidate.candidateBaseSha !== candidate.latestProtectedMainSha ||
    candidate.behindByCommits !== 0 ||
    snap.base !== candidate.latestProtectedMainSha ||
    snap.observedBase !== candidate.latestProtectedMainSha ||
    snap.baseBranch !== policy.defaultBranch ||
    !snap.baseCompatible ||
    !snap.mainHealthy
  ) {
    return deny('BASE_NOT_STRICT_UP_TO_DATE');
  }

  const hasExactHeadRequiredChecks = policy.checks.every(req => {
    const matches = snap.checks.filter(c => c.name === req.name);
    return matches.length === 1 &&
      matches[0].head === candidate.candidateHeadSha &&
      matches[0].appId === req.appId &&
      matches[0].status === 'completed' &&
      matches[0].conclusion === 'success';
  });
  if (!hasExactHeadRequiredChecks) {
    return deny('REQUIRED_CHECKS_INCOMPLETE');
  }

  // Formal exact-head APPROVED review gate: COMMENTED-only reviews are strictly rejected even with 0 threads.
  const reviewSummary = candidate.reviewSummary;
  const reviewerIds = snap.reviews.map(r => identity(r.reviewer));
  const allowlistedReviewers = new Set(policy.reviewers.map(identity));
  const authorId = identity(snap.author);
  const agentId = identity(snap.agent);
  const hasFormalIndependentApproval =
    snap.reviews.length > 0 &&
    new Set(reviewerIds).size === reviewerIds.length &&
    snap.reviews.every(r => r.state === 'APPROVED' && r.head === candidate.candidateHeadSha) &&
    snap.reviews.some(r => {
      const reviewerId = identity(r.reviewer);
      return allowlistedReviewers.has(reviewerId) &&
        reviewerId !== authorId &&
        reviewerId !== agentId;
    });

  if (
    !snap.threadsResolved ||
    reviewSummary.unresolvedInlineThreads !== 0 ||
    reviewSummary.unresolvedSummaryFindings !== 0 ||
    reviewSummary.summaryDisposition !== 'clear' ||
    !hasFormalIndependentApproval
  ) {
    return deny('FORMAL_APPROVAL_REQUIRED');
  }

  const covCheck = coverageEvidence(
    candidate.candidateHeadSha,
    candidate.componentInventory,
    candidate.coverageReports,
    {
      repository: policy.repository,
      existingLineMin: localGates.minLineCoverage,
      existingBranchMin: localGates.minBranchCoverage,
      lineMin: policy.coverage.line,
      branchMin: policy.coverage.branch
    }
  );
  if (!covCheck.valid) {
    return deny('COVERAGE_BELOW_CONSUMER_GATE');
  }

  const shadowPolicy = { ...policy, mode: 'shadow', killSwitch: false };
  const coreDecision = evaluate(shadowPolicy, snap);
  if (coreDecision.reason !== 'SHADOW_ELIGIBLE') {
    return deny(coreDecision.reason);
  }

  const isIndependentReviewer = reviewer => {
    const reviewerId = identity(reviewer);
    return reviewerId !== authorId && reviewerId !== agentId;
  };
  const isIndependentAllowlistedReviewer = reviewer =>
    allowlistedReviewers.has(identity(reviewer)) && isIndependentReviewer(reviewer);

  const suite = input.shadowDenialSuite;
  const denialMutationsValid =
    singleMutation(snap, suite.staleReview, 'reviews') &&
    suite.staleReview.reviews.length > 0 &&
    suite.staleReview.reviews.every(r =>
      r.state === 'APPROVED' &&
      r.head !== candidate.candidateHeadSha &&
      isIndependentAllowlistedReviewer(r.reviewer)
    ) &&
    singleMutation(snap, suite.dismissedReview, 'reviews') &&
    suite.dismissedReview.reviews.length > 0 &&
    suite.dismissedReview.reviews.every(r =>
      r.state === 'DISMISSED' &&
      r.head === candidate.candidateHeadSha &&
      isIndependentAllowlistedReviewer(r.reviewer)
    ) &&
    singleMutation(snap, suite.commentedZeroThreadsReview, 'reviews') &&
    suite.commentedZeroThreadsReview.reviews.length > 0 &&
    suite.commentedZeroThreadsReview.reviews.every(r =>
      r.state === 'COMMENTED' &&
      r.head === candidate.candidateHeadSha &&
      r.summaryDisposition === 'clear' &&
      isIndependentReviewer(r.reviewer)
    ) &&
    singleMutation(snap, suite.behindMainCandidate, 'base') &&
    sha40(suite.behindMainCandidate.base) &&
    suite.behindMainCandidate.base !== candidate.latestProtectedMainSha &&
    singleMutation(snap, suite.missingCopilotReviewCheck, 'checks') &&
    !suite.missingCopilotReviewCheck.checks.some(c => c.name === 'copilot-review') &&
    singleMutation(snap, suite.missingValidateCheck, 'checks') &&
    !suite.missingValidateCheck.checks.some(c => c.name === 'validate');

  if (!denialMutationsValid) {
    return deny('SHADOW_DENIAL_PROOF_INCOMPLETE');
  }

  const mergedReviewers = [...shadowPolicy.reviewers];
  const seenReviewerIds = new Set(mergedReviewers.map(identity));
  for (const r of suite.commentedZeroThreadsReview.reviews) {
    const reviewerId = identity(r.reviewer);
    if (!seenReviewerIds.has(reviewerId)) {
      seenReviewerIds.add(reviewerId);
      mergedReviewers.push(r.reviewer);
    }
  }
  const botAllowlistedShadowPolicy = {
    ...shadowPolicy,
    reviewers: mergedReviewers
  };
  const replayChecks = [
    [shadowPolicy, suite.staleReview, 'REVIEW_MISSING'],
    [shadowPolicy, suite.dismissedReview, 'REVIEW_MISSING'],
    [botAllowlistedShadowPolicy, suite.commentedZeroThreadsReview, 'REVIEW_MISSING'],
    [shadowPolicy, suite.behindMainCandidate, 'STALE_HEAD_OR_BASE'],
    [shadowPolicy, suite.missingCopilotReviewCheck, 'CHECKS_INCOMPLETE'],
    [shadowPolicy, suite.missingValidateCheck, 'CHECKS_INCOMPLETE'],
    [{ ...shadowPolicy, killSwitch: true }, snap, 'STOPPED']
  ];

  if (!replayChecks.every(([pol, s, expectedReason]) => evaluate(pol, s).reason === expectedReason)) {
    return deny('SHADOW_DENIAL_PROOF_INCOMPLETE');
  }

  const rollbackCheck = verifyIndependentRollback(
    policy.repository,
    input.rollbackReceipt,
    [pkg, ...input.peerOnboardingPackages]
  );
  if (!rollbackCheck.valid) {
    return deny('INDEPENDENT_ROLLBACK_UNVERIFIED');
  }

  return Object.freeze({
    milestone: FAMILYHUB_MILESTONE_ID,
    issue: FAMILYHUB_ISSUE_NUMBER,
    shadow: true,
    ready: true,
    eligible: true,
    liveActivation: false,
    liveProductionDeployAllowed: false,
    mutatesGitHub: false,
    independentOfSpellbookAndM02: true,
    state: 'shadow-ready',
    reason: 'FAMILYHUB_SHADOW_READY_ONLY',
    repository: pkgCheck.repository,
    repositoryId: pkgCheck.repositoryId,
    pinnedWorkflowSha: pkgCheck.pinnedWorkflowSha,
    pinnedCheckoutSha: pkgCheck.pinnedCheckoutSha,
    candidateHeadSha: candidate.candidateHeadSha,
    protectedBaseSha: candidate.latestProtectedMainSha,
    rollbackTargetDecision: rollbackCheck.targetDecision,
    unaffectedPeers: rollbackCheck.unaffectedPeers
  });
}
