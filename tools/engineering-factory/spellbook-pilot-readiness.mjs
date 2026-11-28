// Deterministic, metadata-only M04 Spellbook pre-activation gate and stricter-policy shadow verifier.
import { types } from 'node:util';
import { evaluate } from './core.mjs';
import { coverageEvidence } from './coverage-evidence.mjs';
import {
  verifyConsumerOnboardingPackage,
  verifyIndependentRollback
} from './consumer-onboarding.mjs';

export const SPELLBOOK_MIN_LINE_COVERAGE = 97;
export const SPELLBOOK_MIN_BRANCH_COVERAGE = 90;
export const SPELLBOOK_DEFAULT_MAX_CONCURRENT_AGENTS = 2;
export const SPELLBOOK_SCALING_CEILING = 12;
export const SPELLBOOK_REQUIRED_CHECK_ROLES = Object.freeze([
  'webkit',
  'ios',
  'releaseReadiness'
]);
export const FORBIDDEN_NON_SPELLBOOK_REPOSITORIES = Object.freeze([
  'jamula/softwarefactory',
  'jamula/familytree',
  'example/family-tree',
  'jamula/familyhub',
  'example/family-hub'
]);

const REQUIRED_INPUT_KEYS = Object.freeze([
  'm01AutonomousAccepted',
  'familyTreePilotAccepted',
  'onboardingContractAccepted',
  'spellbookRepoReadinessAccepted',
  'dependsOnFamilyHub',
  'dependsOnM02Speed',
  'stopSwitchActive',
  'maxConcurrentAgents',
  'authorization',
  'onboardingPackage',
  'requiredCheckRoles',
  'candidate',
  'appCoverage',
  'openPullRequests',
  'spellbookShadowDenials',
  'rollback'
]);
const OPTIONAL_INPUT_KEYS = Object.freeze(['scalingApproval', 'peerRegistry']);
const REQUIRED_AUTH_KEYS = Object.freeze([
  'ownerAuthorized',
  'repository',
  'repositoryId',
  'pinnedWorkflowSha',
  'pinnedCheckoutSha',
  'zeroIncrementalSpendVerified',
  'productionReleaseEnabled'
]);
const OPTIONAL_AUTH_KEYS = Object.freeze(['repositoryOwners']);

const ROLE_PATTERNS = Object.freeze({
  webkit: /webkit/i,
  ios: /(?:^|[^a-z0-9])ios(?:$|[^a-z0-9])/i,
  releaseReadiness: /(?:^|[^a-z0-9])release(?:$|[^a-z0-9])/i
});

const UPSTREAM_REASON_BY_GATE = Object.freeze({
  M01_AUTONOMOUS_ISSUE_10: 'UPSTREAM_M01_NOT_ACCEPTED',
  FAMILYTREE_PILOT_ISSUE_36: 'UPSTREAM_FAMILYTREE_PILOT_NOT_ACCEPTED',
  ONBOARDING_CONTRACT_ISSUE_13: 'UPSTREAM_ONBOARDING_CONTRACT_NOT_ACCEPTED',
  SPELLBOOK_READINESS_ISSUE_103: 'SPELLBOOK_REPO_READINESS_INCOMPLETE',
  SPELLBOOK_SCOPED_OWNER_AUTHORIZATION: 'SPELLBOOK_AUTHORIZATION_REQUIRED',
  ZERO_INCREMENTAL_SPEND_VERIFICATION: 'ZERO_SPEND_UNVERIFIED'
});

const ownData = (obj, key) => {
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  return Boolean(desc && desc.enumerable && Object.hasOwn(desc, 'value'));
};

const isPlainObject = value =>
  value !== null &&
  typeof value === 'object' &&
  !types.isProxy(value) &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const exact = (value, keys) =>
  isPlainObject(value) &&
  Reflect.ownKeys(value).length === keys.length &&
  keys.every(key => ownData(value, key));

const plainWithOptional = (value, requiredKeys, optionalKeys) => {
  if (!isPlainObject(value)) return false;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.every(key => typeof key === 'string' && allowed.has(key) && ownData(value, key)) &&
    requiredKeys.every(key => ownData(value, key))
  );
};

const dense = (value, max = 64) =>
  value !== null &&
  typeof value === 'object' &&
  !types.isProxy(value) &&
  Array.isArray(value) &&
  Object.getPrototypeOf(value) === Array.prototype &&
  value.length <= max &&
  Reflect.ownKeys(value).length === value.length + 1 &&
  Array.from({ length: value.length }, (_, i) => ownData(value, i)).every(Boolean);

const text = (value, max = 200) =>
  typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value;

const posInt = value => Number.isSafeInteger(value) && value > 0;
const nonNegInt = value => Number.isSafeInteger(value) && value >= 0;
const pct = value => Number.isFinite(value) && value >= 0 && value <= 100;
const sha40 = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);

const VALID_CHECK_STATUSES = new Set(['queued', 'in_progress', 'completed']);
const VALID_COMPLETED_CONCLUSIONS = new Set([
  'success',
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'neutral',
  'skipped',
  'stale'
]);
const VALID_REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED']);
const REPLAY_SUITE_SNAPSHOT_KEYS = Object.freeze([
  'eligibleCandidate',
  'staleReview',
  'dismissedReview',
  'commentedBotReview',
  'wrongRepository',
  'missingQuota'
]);
const REPLAY_SUITE_KEYS = Object.freeze([...REPLAY_SUITE_SNAPSHOT_KEYS, 'killSwitchPolicy']);

const validCheckItem = c =>
  exact(c, ['name', 'head', 'appId', 'status', 'conclusion']) &&
  text(c.name, 120) &&
  sha40(c.head) &&
  posInt(c.appId) &&
  VALID_CHECK_STATUSES.has(c.status) &&
  (c.status === 'completed'
    ? VALID_COMPLETED_CONCLUSIONS.has(c.conclusion)
    : c.conclusion === null);

const validSnapshotReview = r =>
  (exact(r, ['reviewer', 'head', 'state']) ||
    (exact(r, ['reviewer', 'head', 'state', 'summaryDisposition']) &&
      r.state === 'COMMENTED' &&
      text(r.summaryDisposition, 80))) &&
  text(r.reviewer, 120) &&
  sha40(r.head) &&
  VALID_REVIEW_STATES.has(r.state);

const strictSnapshotShape = s =>
  exact(s, [
    'policySource', 'repository', 'issue', 'pr', 'head', 'observedHead',
    'base', 'observedBase', 'baseBranch', 'rateLimited', 'remainingCredits',
    'activeCount', 'providerReady', 'risk', 'priority', 'paths',
    'dependencies', 'acceptanceComplete', 'baseCompatible', 'mainHealthy',
    'threadsResolved', 'securityClear', 'coverage', 'checks', 'author',
    'agent', 'reviews'
  ]) &&
  [s.policySource, s.repository, s.baseBranch, s.risk, s.author, s.agent].every(v => text(v, 120)) &&
  [s.issue, s.pr].every(posInt) &&
  [s.head, s.observedHead, s.base, s.observedBase].every(sha40) &&
  [
    s.rateLimited,
    s.providerReady,
    s.acceptanceComplete,
    s.baseCompatible,
    s.mainHealthy,
    s.threadsResolved,
    s.securityClear
  ].every(v => typeof v === 'boolean') &&
  (s.remainingCredits === null || Number.isFinite(s.remainingCredits)) &&
  nonNegInt(s.activeCount) &&
  Number.isSafeInteger(s.priority) &&
  dense(s.paths) &&
  s.paths.every(p => text(p, 240)) &&
  dense(s.dependencies) &&
  s.dependencies.every(
    d => exact(d, ['issue', 'accepted']) && posInt(d.issue) && typeof d.accepted === 'boolean'
  ) &&
  exact(s.coverage, ['head', 'line', 'branch', 'complete']) &&
  sha40(s.coverage.head) &&
  pct(s.coverage.line) &&
  pct(s.coverage.branch) &&
  typeof s.coverage.complete === 'boolean' &&
  dense(s.checks) &&
  s.checks.every(validCheckItem) &&
  dense(s.reviews) &&
  s.reviews.every(validSnapshotReview);

const validReplaySuiteScalars = replaySuite =>
  exact(replaySuite, REPLAY_SUITE_KEYS) &&
  isPlainObject(replaySuite.killSwitchPolicy) &&
  REPLAY_SUITE_SNAPSHOT_KEYS.every(key => strictSnapshotShape(replaySuite[key]));

function sanitizeOnboardingPackage(pkg) {
  if (
    !isPlainObject(pkg) ||
    Reflect.ownKeys(pkg).length > 64 ||
    !Reflect.ownKeys(pkg).every(key => typeof key === 'string' && ownData(pkg, key)) ||
    !Object.hasOwn(pkg, 'replaySuite')
  ) {
    return pkg;
  }
  return validReplaySuiteScalars(pkg.replaySuite) ? pkg : { ...pkg, replaySuite: null };
}

function sameData(candidateVal, expectedVal) {
  if (!expectedVal || typeof expectedVal !== 'object') {
    return Object.is(candidateVal, expectedVal);
  }
  if (Array.isArray(expectedVal)) {
    return (
      dense(candidateVal) &&
      candidateVal.length === expectedVal.length &&
      expectedVal.every((item, i) => sameData(candidateVal[i], item))
    );
  }
  const keys = Object.keys(expectedVal);
  return (
    exact(candidateVal, keys) &&
    keys.every(key => sameData(candidateVal[key], expectedVal[key]))
  );
}

const singleMutation = (baseSnap, candidate, field) => {
  const keys = Object.keys(baseSnap);
  return (
    exact(candidate, keys) &&
    keys.every(key => key === field || sameData(candidate[key], baseSnap[key]))
  );
};

function singleCheckMutation(baseSnap, scenario, targetCheckName) {
  if (!singleMutation(baseSnap, scenario, 'checks')) {
    return false;
  }
  const expectedOthers = baseSnap.checks.filter(c => c.name !== targetCheckName);
  const candidateOthers = scenario.checks.filter(c => c.name !== targetCheckName);
  if (!sameData(candidateOthers, expectedOthers)) return false;

  const expectedTarget = baseSnap.checks.find(c => c.name === targetCheckName);
  const candidateTargets = scenario.checks.filter(c => c.name === targetCheckName);
  if (candidateTargets.length === 0) return true;
  return candidateTargets.length === 1 && !sameData(candidateTargets[0], expectedTarget);
}

function validScalingApprovalShape(rawScaling) {
  return (
    rawScaling === null ||
    (exact(rawScaling, [
      'approved',
      'approvedMaxConcurrentAgents',
      'measuredCapacityVerified',
      'includedQuotaVerified',
      'zeroIncrementalSpendVerified',
      'approver'
    ]) &&
      typeof rawScaling.approved === 'boolean' &&
      posInt(rawScaling.approvedMaxConcurrentAgents) &&
      typeof rawScaling.measuredCapacityVerified === 'boolean' &&
      typeof rawScaling.includedQuotaVerified === 'boolean' &&
      typeof rawScaling.zeroIncrementalSpendVerified === 'boolean' &&
      text(rawScaling.approver, 80))
  );
}

function validRepositoryOwners(owners) {
  if (owners === null) return true;
  if (
    !dense(owners) ||
    !owners.every(o => text(o, 80) && !o.toLowerCase().endsWith('[bot]'))
  ) {
    return false;
  }
  return new Set(owners.map(o => o.toLowerCase())).size === owners.length;
}

function validAuthorizationShape(auth) {
  if (!plainWithOptional(auth, REQUIRED_AUTH_KEYS, OPTIONAL_AUTH_KEYS)) {
    return false;
  }
  const rawOwners = Object.hasOwn(auth, 'repositoryOwners') ? auth.repositoryOwners : null;
  return (
    typeof auth.ownerAuthorized === 'boolean' &&
    text(auth.repository) &&
    posInt(auth.repositoryId) &&
    sha40(auth.pinnedWorkflowSha) &&
    sha40(auth.pinnedCheckoutSha) &&
    typeof auth.zeroIncrementalSpendVerified === 'boolean' &&
    typeof auth.productionReleaseEnabled === 'boolean' &&
    validRepositoryOwners(rawOwners)
  );
}

function verifyRequiredCheckRoles(roles, localGates) {
  if (!exact(roles, SPELLBOOK_REQUIRED_CHECK_ROLES)) return false;
  const seenNames = new Set();
  for (const roleKey of SPELLBOOK_REQUIRED_CHECK_ROLES) {
    const role = roles[roleKey];
    if (
      !exact(role, ['name', 'appId']) ||
      !text(role.name, 120) ||
      !posInt(role.appId) ||
      !ROLE_PATTERNS[roleKey].test(role.name)
    ) {
      return false;
    }
    const lowerName = role.name.toLowerCase();
    if (seenNames.has(lowerName)) return false;
    seenNames.add(lowerName);
    if (!localGates.requiredChecks.some(c => c.name === role.name && c.appId === role.appId)) {
      return false;
    }
  }
  return true;
}

const SPELLBOOK_DENIAL_KEYS = Object.freeze([
  'staleHead',
  'lowered95LineCoverage',
  'loweredBranchCoverage',
  'webkitCheckFailed',
  'iosCheckFailed',
  'releaseCheckFailed',
  'concurrencyCapReached'
]);

function verifySpellbookShadowDenials(denials, baseSnap, shadowPolicy, roles) {
  if (
    !exact(denials, SPELLBOOK_DENIAL_KEYS) ||
    !SPELLBOOK_DENIAL_KEYS.every(key => strictSnapshotShape(denials[key]))
  ) {
    return false;
  }

  const validStaleHead =
    singleMutation(baseSnap, denials.staleHead, 'observedHead') &&
    denials.staleHead.observedHead !== baseSnap.head;

  const validLowered95 =
    singleMutation(baseSnap, denials.lowered95LineCoverage, 'coverage') &&
    denials.lowered95LineCoverage.coverage.head === baseSnap.head &&
    denials.lowered95LineCoverage.coverage.complete === true &&
    denials.lowered95LineCoverage.coverage.branch === baseSnap.coverage.branch &&
    denials.lowered95LineCoverage.coverage.line >= 95 &&
    denials.lowered95LineCoverage.coverage.line < SPELLBOOK_MIN_LINE_COVERAGE;

  const validLoweredBranch =
    singleMutation(baseSnap, denials.loweredBranchCoverage, 'coverage') &&
    denials.loweredBranchCoverage.coverage.head === baseSnap.head &&
    denials.loweredBranchCoverage.coverage.complete === true &&
    denials.loweredBranchCoverage.coverage.line === baseSnap.coverage.line &&
    denials.loweredBranchCoverage.coverage.branch < SPELLBOOK_MIN_BRANCH_COVERAGE;

  const validConcurrencyCap =
    singleMutation(baseSnap, denials.concurrencyCapReached, 'activeCount') &&
    denials.concurrencyCapReached.activeCount === shadowPolicy.maxActive;

  if (
    !validStaleHead ||
    !validLowered95 ||
    !validLoweredBranch ||
    !validConcurrencyCap ||
    !singleCheckMutation(baseSnap, denials.webkitCheckFailed, roles.webkit.name) ||
    !singleCheckMutation(baseSnap, denials.iosCheckFailed, roles.ios.name) ||
    !singleCheckMutation(baseSnap, denials.releaseCheckFailed, roles.releaseReadiness.name)
  ) {
    return false;
  }

  const expectedReasons = [
    [denials.staleHead, 'STALE_HEAD_OR_BASE'],
    [denials.lowered95LineCoverage, 'COVERAGE_INCOMPLETE'],
    [denials.loweredBranchCoverage, 'COVERAGE_INCOMPLETE'],
    [denials.webkitCheckFailed, 'CHECKS_INCOMPLETE'],
    [denials.iosCheckFailed, 'CHECKS_INCOMPLETE'],
    [denials.releaseCheckFailed, 'CHECKS_INCOMPLETE'],
    [denials.concurrencyCapReached, 'BUDGET_OR_CONCURRENCY']
  ];
  return expectedReasons.every(([snap, reason]) => evaluate(shadowPolicy, snap).reason === reason);
}

const shadowDeny = reason =>
  Object.freeze({
    shadow: true,
    valid: false,
    ready: false,
    shadowVerified: false,
    upstreamReady: false,
    liveActivation: false,
    reason,
    blockingGates: Object.freeze([reason])
  });

export function evaluateSpellbookShadowReadiness(input) {
  if (!plainWithOptional(input, REQUIRED_INPUT_KEYS, OPTIONAL_INPUT_KEYS)) {
    return shadowDeny('INPUT_SCHEMA_INVALID');
  }

  const rawScaling = Object.hasOwn(input, 'scalingApproval') ? input.scalingApproval : null;
  if (
    typeof input.m01AutonomousAccepted !== 'boolean' ||
    typeof input.familyTreePilotAccepted !== 'boolean' ||
    typeof input.onboardingContractAccepted !== 'boolean' ||
    typeof input.spellbookRepoReadinessAccepted !== 'boolean' ||
    typeof input.dependsOnFamilyHub !== 'boolean' ||
    typeof input.dependsOnM02Speed !== 'boolean' ||
    typeof input.stopSwitchActive !== 'boolean' ||
    !posInt(input.maxConcurrentAgents) ||
    !validScalingApprovalShape(rawScaling) ||
    !validAuthorizationShape(input.authorization)
  ) {
    return shadowDeny('INPUT_SCHEMA_INVALID');
  }

  if (input.stopSwitchActive) {
    return shadowDeny('STOPPED');
  }
  if (input.dependsOnFamilyHub || input.dependsOnM02Speed) {
    return shadowDeny('FORBIDDEN_CROSS_MILESTONE_DEPENDENCY');
  }
  if (input.authorization.productionReleaseEnabled) {
    return shadowDeny('PRODUCTION_RELEASE_FORBIDDEN');
  }

  if (!strictSnapshotShape(input.candidate)) {
    return shadowDeny('CANDIDATE_SNAPSHOT_INVALID');
  }

  const peerRegistry = Object.hasOwn(input, 'peerRegistry') ? input.peerRegistry : [];
  const pkg = input.onboardingPackage;
  const sanitizedPkg = sanitizeOnboardingPackage(pkg);
  const onboarding = verifyConsumerOnboardingPackage(sanitizedPkg, peerRegistry);
  if (!onboarding.valid) {
    if (onboarding.reason === 'BASELINE_COVERAGE_BELOW_MINIMUM') {
      return shadowDeny('SPELLBOOK_COVERAGE_FLOOR_VIOLATION');
    }
    if (onboarding.reason === 'LOCAL_GATE_WEAKENED') {
      if (pkg.policy.coverage.line < SPELLBOOK_MIN_LINE_COVERAGE) {
        return shadowDeny('SPELLBOOK_COVERAGE_FLOOR_VIOLATION');
      }
      if (pkg.policy.maxActive > input.maxConcurrentAgents) {
        return shadowDeny('SPELLBOOK_CONCURRENCY_CAP_EXCEEDED');
      }
    }
    return shadowDeny(onboarding.reason);
  }

  const repoLower = pkg.policy.repository.toLowerCase();
  if (
    FORBIDDEN_NON_SPELLBOOK_REPOSITORIES.includes(repoLower) ||
    !pkg.stackProfile.startsWith('ios-webkit-')
  ) {
    return shadowDeny('SPELLBOOK_PROFILE_MISMATCH');
  }

  if (
    pkg.policy.coverage.line < SPELLBOOK_MIN_LINE_COVERAGE ||
    pkg.localGates.minLineCoverage < SPELLBOOK_MIN_LINE_COVERAGE ||
    pkg.localGates.minBranchCoverage < SPELLBOOK_MIN_BRANCH_COVERAGE
  ) {
    return shadowDeny('SPELLBOOK_COVERAGE_FLOOR_VIOLATION');
  }

  if (
    input.authorization.repository !== pkg.policy.repository ||
    input.authorization.repositoryId !== pkg.repositoryId ||
    input.authorization.pinnedWorkflowSha !== onboarding.pinnedWorkflowSha ||
    input.authorization.pinnedCheckoutSha !== onboarding.pinnedCheckoutSha
  ) {
    return shadowDeny('AUTHORIZATION_SCOPE_MISMATCH');
  }

  const rawRepoOwners = Object.hasOwn(input.authorization, 'repositoryOwners')
    ? input.authorization.repositoryOwners
    : null;
  const verifiedRepoOwners =
    input.authorization.ownerAuthorized && rawRepoOwners !== null ? rawRepoOwners : [];

  const scalingApproved = Boolean(
    rawScaling !== null &&
      rawScaling.approved &&
      rawScaling.approvedMaxConcurrentAgents >= 3 &&
      rawScaling.approvedMaxConcurrentAgents <= SPELLBOOK_SCALING_CEILING &&
      rawScaling.measuredCapacityVerified &&
      rawScaling.includedQuotaVerified &&
      rawScaling.zeroIncrementalSpendVerified &&
      !rawScaling.approver.toLowerCase().endsWith('[bot]') &&
      rawScaling.approver.toLowerCase() !== input.candidate.author.toLowerCase() &&
      rawScaling.approver.toLowerCase() !== input.candidate.agent.toLowerCase() &&
      verifiedRepoOwners.some(owner => owner.toLowerCase() === rawScaling.approver.toLowerCase())
  );
  const allowedConcurrencyCap = scalingApproved
    ? rawScaling.approvedMaxConcurrentAgents
    : SPELLBOOK_DEFAULT_MAX_CONCURRENT_AGENTS;

  if (
    input.maxConcurrentAgents > allowedConcurrencyCap ||
    pkg.policy.maxActive > input.maxConcurrentAgents ||
    pkg.localGates.maxConcurrency > input.maxConcurrentAgents
  ) {
    return shadowDeny('SPELLBOOK_CONCURRENCY_CAP_EXCEEDED');
  }

  if (!verifyRequiredCheckRoles(input.requiredCheckRoles, pkg.localGates)) {
    return shadowDeny('SPELLBOOK_REQUIRED_CHECKS_MISSING');
  }

  if (
    !dense(input.openPullRequests) ||
    !input.openPullRequests.every(
      p => exact(p, ['pr', 'issue', 'head']) && posInt(p.pr) && posInt(p.issue) && sha40(p.head)
    ) ||
    new Set(input.openPullRequests.map(p => p.pr)).size !== input.openPullRequests.length ||
    !input.openPullRequests.some(p => p.pr === input.candidate.pr)
  ) {
    return shadowDeny('OPEN_PR_INVENTORY_INVALID');
  }

  for (const openPr of input.openPullRequests) {
    if (openPr.pr === input.candidate.pr) {
      if (openPr.issue !== input.candidate.issue || openPr.head !== input.candidate.head) {
        return shadowDeny('STALE_HEAD_OR_BASE');
      }
    } else if (openPr.issue === input.candidate.issue || openPr.head === input.candidate.head) {
      return shadowDeny('DUPLICATE_EXISTING_PR');
    }
  }

  const shadowPolicy = { ...pkg.policy, mode: 'shadow', killSwitch: false };
  const candidateDecision = evaluate(shadowPolicy, input.candidate);
  if (candidateDecision.reason !== 'SHADOW_ELIGIBLE') {
    return shadowDeny(candidateDecision.reason);
  }

  if (
    !plainWithOptional(
      input.appCoverage,
      ['head', 'expectedComponents', 'reports'],
      ['branchless']
    ) ||
    !sha40(input.appCoverage.head) ||
    (Object.hasOwn(input.appCoverage, 'branchless') && !dense(input.appCoverage.branchless))
  ) {
    return shadowDeny('APP_COVERAGE_INVALID');
  }
  if (input.appCoverage.head !== input.candidate.head) {
    return shadowDeny('STALE_HEAD_OR_BASE');
  }

  const branchless = Object.hasOwn(input.appCoverage, 'branchless')
    ? input.appCoverage.branchless
    : undefined;
  const covPolicy = {
    repository: pkg.policy.repository,
    existingLineMin: SPELLBOOK_MIN_LINE_COVERAGE,
    existingBranchMin: SPELLBOOK_MIN_BRANCH_COVERAGE,
    lineMin: pkg.policy.coverage.line,
    branchMin: pkg.policy.coverage.branch,
    ...(branchless === undefined ? {} : { branchless })
  };

  const cov = coverageEvidence(
    input.candidate.head,
    input.appCoverage.expectedComponents,
    input.appCoverage.reports,
    covPolicy
  );
  if (!cov.valid || cov.branchTotal === 0) {
    return shadowDeny('APP_COVERAGE_BELOW_SPELLBOOK_TARGET');
  }

  if (branchless !== undefined) {
    const reviewerAllowlist = new Set(pkg.policy.reviewers.map(r => r.toLowerCase()));
    const authorLower = input.candidate.author.toLowerCase();
    const agentLower = input.candidate.agent.toLowerCase();
    const approvedOnHead = new Set(
      input.candidate.reviews
        .filter(r => r.state === 'APPROVED' && r.head === input.candidate.head)
        .map(r => r.reviewer.toLowerCase())
    );
    if (
      branchless.some(entry => {
        const by = entry.reviewedBy.toLowerCase();
        return (
          !reviewerAllowlist.has(by) ||
          by === authorLower ||
          by === agentLower ||
          !approvedOnHead.has(by)
        );
      })
    ) {
      return shadowDeny('BRANCHLESS_REVIEW_UNVERIFIED');
    }
  }

  const measuredLinePct = (cov.lines * 100) / cov.lineTotal;
  const measuredBranchPct = (cov.branches * 100) / cov.branchTotal;
  if (
    Math.abs(input.candidate.coverage.line - measuredLinePct) > 0.01 ||
    Math.abs(input.candidate.coverage.branch - measuredBranchPct) > 0.01
  ) {
    return shadowDeny('APP_COVERAGE_MISMATCH');
  }

  if (
    !verifySpellbookShadowDenials(
      input.spellbookShadowDenials,
      pkg.replaySuite.eligibleCandidate,
      shadowPolicy,
      input.requiredCheckRoles
    )
  ) {
    return shadowDeny('SPELLBOOK_SHADOW_REPLAY_INCOMPLETE');
  }

  if (
    !exact(input.rollback, ['receipt', 'peerPackages', 'revertPrCount', 'crossRepoMutations']) ||
    !dense(input.rollback.peerPackages) ||
    input.rollback.peerPackages.length === 0 ||
    input.rollback.revertPrCount !== 1 ||
    !Object.is(input.rollback.crossRepoMutations, 0)
  ) {
    return shadowDeny('SINGLE_PR_ROLLBACK_INVALID');
  }

  const sanitizedPeers = input.rollback.peerPackages.map(sanitizeOnboardingPackage);
  const rbResult = verifyIndependentRollback(
    pkg.policy.repository,
    input.rollback.receipt,
    [sanitizedPkg, ...sanitizedPeers]
  );
  if (!rbResult.valid) {
    return shadowDeny('SINGLE_PR_ROLLBACK_INVALID');
  }

  const blockingGates = [];
  if (!input.m01AutonomousAccepted) blockingGates.push('M01_AUTONOMOUS_ISSUE_10');
  if (!input.familyTreePilotAccepted) blockingGates.push('FAMILYTREE_PILOT_ISSUE_36');
  if (!input.onboardingContractAccepted) blockingGates.push('ONBOARDING_CONTRACT_ISSUE_13');
  if (!input.spellbookRepoReadinessAccepted) blockingGates.push('SPELLBOOK_READINESS_ISSUE_103');
  if (!input.authorization.ownerAuthorized) blockingGates.push('SPELLBOOK_SCOPED_OWNER_AUTHORIZATION');
  if (!input.authorization.zeroIncrementalSpendVerified) {
    blockingGates.push('ZERO_INCREMENTAL_SPEND_VERIFICATION');
  }

  const appCoverageSummary = Object.freeze({
    lines: cov.lines,
    lineTotal: cov.lineTotal,
    branches: cov.branches,
    branchTotal: cov.branchTotal
  });

  if (blockingGates.length > 0) {
    return Object.freeze({
      shadow: true,
      valid: false,
      ready: false,
      shadowVerified: true,
      upstreamReady: false,
      liveActivation: false,
      reason: UPSTREAM_REASON_BY_GATE[blockingGates[0]],
      blockingGates: Object.freeze(blockingGates),
      repository: pkg.policy.repository,
      repositoryId: pkg.repositoryId,
      pinnedWorkflowSha: onboarding.pinnedWorkflowSha,
      pinnedCheckoutSha: onboarding.pinnedCheckoutSha,
      maxConcurrentAgents: input.maxConcurrentAgents,
      scalingApproved,
      unaffectedRollbackPeers: rbResult.unaffectedPeers,
      appCoverage: appCoverageSummary
    });
  }

  return Object.freeze({
    shadow: true,
    valid: true,
    ready: true,
    shadowVerified: true,
    upstreamReady: true,
    liveActivation: false,
    reason: 'SPELLBOOK_SHADOW_READY_ONLY',
    blockingGates: Object.freeze([]),
    repository: pkg.policy.repository,
    repositoryId: pkg.repositoryId,
    pinnedWorkflowSha: onboarding.pinnedWorkflowSha,
    pinnedCheckoutSha: onboarding.pinnedCheckoutSha,
    maxConcurrentAgents: input.maxConcurrentAgents,
    scalingApproved,
    unaffectedRollbackPeers: rbResult.unaffectedPeers,
    appCoverage: appCoverageSummary
  });
}
