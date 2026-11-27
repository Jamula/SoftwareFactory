// Deterministic, metadata-only consumer onboarding, isolation and rollback contract verifier.
import { types } from 'node:util';
import { evaluate, validPolicy } from './core.mjs';

export const CONSUMER_CONTRACT_VERSION = 1;
export const FACTORY_REPOSITORY = 'Jamula/SoftwareFactory';
export const FACTORY_REPOSITORY_ID = 1471342715;
export const REUSABLE_WORKFLOW_PREFIX = 'Jamula/SoftwareFactory/.github/workflows/shadow-tests.yml@';
export const CONSUMER_BASELINE_COVERAGE = Object.freeze({ line: 95, branch: 90 });

export const CONSUMER_COMPONENT_CATALOG = Object.freeze([
  Object.freeze({
    id: 'evaluator-core',
    path: 'tools/engineering-factory/core.mjs',
    version: 1,
    mode: 'pure-read-only',
    mutatesGitHub: false,
    requiresConsumerSecrets: false
  }),
  Object.freeze({
    id: 'shadow-replay-workflow',
    path: '.github/workflows/shadow-tests.yml',
    version: 1,
    mode: 'reusable-workflow-sha-pinned',
    mutatesGitHub: false,
    requiresConsumerSecrets: false
  }),
  Object.freeze({
    id: 'consumer-onboarding-verifier',
    path: 'tools/engineering-factory/consumer-onboarding.mjs',
    version: 1,
    mode: 'offline-contract-verifier',
    mutatesGitHub: false,
    requiresConsumerSecrets: false
  })
]);

const ownData = (obj, key) => {
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  return Boolean(desc && desc.enumerable && 'value' in desc);
};

const exact = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  !types.isProxy(value) &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Reflect.ownKeys(value).length === keys.length &&
  keys.every(key => ownData(value, key));

const dense = (value, max = 64) =>
  !types.isProxy(value) &&
  Array.isArray(value) &&
  Object.getPrototypeOf(value) === Array.prototype &&
  value.length <= max &&
  Reflect.ownKeys(value).length === value.length + 1 &&
  Array.from({ length: value.length }, (_, i) => ownData(value, i)).every(Boolean);

const text = (value, max = 200) =>
  typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value;
const repoPath = value =>
  text(value, 240) &&
  !value.startsWith('/') &&
  !value.includes('\\') &&
  !value.split('/').some(part => !part || part === '.' || part === '..');
const posInt = value => Number.isSafeInteger(value) && value > 0;
const pct = value => Number.isFinite(value) && value >= 0 && value <= 100;
const sha40 = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const identity = value => value.toLowerCase();
const unique = values => new Set(values).size === values.length;

const strictPolicyShape = p =>
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
  exact(s, [
    'policySource', 'repository', 'issue', 'pr', 'head', 'observedHead',
    'base', 'observedBase', 'baseBranch', 'rateLimited', 'remainingCredits',
    'activeCount', 'providerReady', 'risk', 'priority', 'paths',
    'dependencies', 'acceptanceComplete', 'baseCompatible', 'mainHealthy',
    'threadsResolved', 'securityClear', 'coverage', 'checks', 'author',
    'agent', 'reviews'
  ]) &&
  exact(s.coverage, ['head', 'line', 'branch', 'complete']) &&
  dense(s.paths) &&
  dense(s.dependencies) &&
  s.dependencies.every(d => exact(d, ['issue', 'accepted'])) &&
  dense(s.checks) &&
  s.checks.every(c => exact(c, ['name', 'head', 'appId', 'status', 'conclusion'])) &&
  dense(s.reviews) &&
  s.reviews.every(r => exact(r, ['reviewer', 'head', 'state']));

function sameData(candidateVal, expectedVal, depth = 0) {
  if (depth > 8) return false;
  if (!expectedVal || typeof expectedVal !== 'object') {
    return Object.is(candidateVal, expectedVal);
  }
  if (types.isProxy(expectedVal)) return false;
  if (Array.isArray(expectedVal)) {
    return dense(expectedVal) &&
      dense(candidateVal) &&
      candidateVal.length === expectedVal.length &&
      expectedVal.every((item, i) => sameData(candidateVal[i], item, depth + 1));
  }
  if (Object.getPrototypeOf(expectedVal) !== Object.prototype) {
    return false;
  }
  const keys = Reflect.ownKeys(expectedVal);
  if (!keys.every(key => typeof key === 'string' && ownData(expectedVal, key))) {
    return false;
  }
  return exact(candidateVal, keys) &&
    keys.every(key => sameData(candidateVal[key], expectedVal[key], depth + 1));
}

const singleMutation = (baseSnap, candidate, field) => {
  const keys = Object.keys(baseSnap);
  return exact(candidate, keys) &&
    keys.every(key => key === field || sameData(candidate[key], baseSnap[key]));
};

const isStaleReviewScenario = (baseSnap, candidate) =>
  singleMutation(baseSnap, candidate, 'reviews') &&
  dense(candidate.reviews) &&
  candidate.reviews.length > 0 &&
  candidate.reviews.every(r =>
    exact(r, ['reviewer', 'head', 'state']) &&
    text(r.reviewer) &&
    r.state === 'APPROVED' &&
    sha40(r.head) &&
    r.head !== baseSnap.head);

const isDismissedReviewScenario = (baseSnap, candidate) =>
  singleMutation(baseSnap, candidate, 'reviews') &&
  dense(candidate.reviews) &&
  candidate.reviews.length > 0 &&
  candidate.reviews.every(r =>
    exact(r, ['reviewer', 'head', 'state']) &&
    text(r.reviewer) &&
    r.head === baseSnap.head &&
    r.state === 'DISMISSED');

const isCommentedBotScenario = (baseSnap, candidate) =>
  singleMutation(baseSnap, candidate, 'reviews') &&
  dense(candidate.reviews) &&
  candidate.reviews.length === 1 &&
  exact(candidate.reviews[0], ['reviewer', 'head', 'state', 'summaryDisposition']) &&
  text(candidate.reviews[0].reviewer) &&
  ['copilot-pull-request-reviewer', 'copilot-pull-request-reviewer[bot]'].includes(
    identity(candidate.reviews[0].reviewer)
  ) &&
  candidate.reviews[0].head === baseSnap.head &&
  candidate.reviews[0].state === 'COMMENTED' &&
  candidate.reviews[0].summaryDisposition === 'clear';

const isWrongRepoScenario = (baseSnap, candidate) =>
  singleMutation(baseSnap, candidate, 'repository') &&
  text(candidate.repository) &&
  /^[^/]+\/[^/]+$/.test(candidate.repository) &&
  identity(candidate.repository) !== identity(baseSnap.repository);

const isMissingQuotaScenario = (baseSnap, candidate) =>
  singleMutation(baseSnap, candidate, 'remainingCredits') &&
  (candidate.remainingCredits === null ||
    (Number.isFinite(candidate.remainingCredits) && candidate.remainingCredits <= 0));

export function verifyWorkflowPin(pin) {
  if (!exact(pin, [
    'uses', 'reviewedWorkflowSha', 'checkoutRef',
    'reviewedCheckoutSha', 'permissions', 'persistCredentials'
  ]) ||
      typeof pin.uses !== 'string' ||
      typeof pin.permissions !== 'string' ||
      typeof pin.persistCredentials !== 'boolean') {
    return Object.freeze({ valid: false, reason: 'PIN_SCHEMA_INVALID', shadow: true });
  }
  if (!pin.uses.startsWith(REUSABLE_WORKFLOW_PREFIX)) {
    return Object.freeze({ valid: false, reason: 'PIN_WORKFLOW_UNTRUSTED', shadow: true });
  }
  const workflowRef = pin.uses.slice(REUSABLE_WORKFLOW_PREFIX.length);
  if (!sha40(workflowRef) || !sha40(pin.reviewedWorkflowSha) ||
      !sha40(pin.checkoutRef) || !sha40(pin.reviewedCheckoutSha)) {
    return Object.freeze({ valid: false, reason: 'PIN_REF_NOT_IMMUTABLE_SHA', shadow: true });
  }
  if (workflowRef !== pin.reviewedWorkflowSha || pin.checkoutRef !== pin.reviewedCheckoutSha) {
    return Object.freeze({ valid: false, reason: 'PIN_SHA_MISMATCH', shadow: true });
  }
  if (pin.permissions !== 'contents:read' || pin.persistCredentials !== false) {
    return Object.freeze({ valid: false, reason: 'PIN_PRIVILEGE_INVALID', shadow: true });
  }
  return Object.freeze({
    valid: true,
    reason: 'PIN_VERIFIED',
    shadow: true,
    pinnedWorkflowSha: pin.reviewedWorkflowSha,
    pinnedCheckoutSha: pin.reviewedCheckoutSha
  });
}

const denyOnboarding = reason =>
  Object.freeze({ valid: false, reason, shadow: true, liveActivation: false });

const validRegistryEntry = entry =>
  exact(entry, ['repository', 'repositoryId', 'credentialId']) &&
  text(entry.repository) &&
  posInt(entry.repositoryId) &&
  text(entry.credentialId);

export function verifyConsumerOnboardingPackage(pkg, registry = []) {
  if (!exact(pkg, [
    'contractVersion', 'repositoryId', 'stackProfile', 'ownerAuthorized',
    'migrationFreezeClear', 'autoActivate', 'productionDeployEnabled',
    'workflowPin', 'policy', 'localGates', 'credentials', 'replaySuite', 'rollback'
  ]) ||
      pkg.contractVersion !== CONSUMER_CONTRACT_VERSION ||
      !posInt(pkg.repositoryId) ||
      !text(pkg.stackProfile, 80) ||
      typeof pkg.ownerAuthorized !== 'boolean' ||
      typeof pkg.migrationFreezeClear !== 'boolean' ||
      typeof pkg.autoActivate !== 'boolean' ||
      typeof pkg.productionDeployEnabled !== 'boolean' ||
      !dense(registry) ||
      !registry.every(validRegistryEntry)) {
    return denyOnboarding('PACKAGE_INVALID');
  }

  if (!pkg.ownerAuthorized || !pkg.migrationFreezeClear || pkg.autoActivate || pkg.productionDeployEnabled) {
    return denyOnboarding('ENROLLMENT_NOT_AUTHORIZED');
  }

  const pinCheck = verifyWorkflowPin(pkg.workflowPin);
  if (!pinCheck.valid) return denyOnboarding(pinCheck.reason);

  if (!strictPolicyShape(pkg.policy) ||
      identity(pkg.policy.repository) === identity(FACTORY_REPOSITORY) ||
      pkg.repositoryId === FACTORY_REPOSITORY_ID) {
    return denyOnboarding('INVALID_CONSUMER_POLICY');
  }

  if (pkg.policy.mode !== 'disabled' || pkg.policy.killSwitch !== true) {
    return denyOnboarding('SHADOW_POSTURE_REQUIRED');
  }

  if (pkg.policy.coverage.line < CONSUMER_BASELINE_COVERAGE.line ||
      pkg.policy.coverage.branch < CONSUMER_BASELINE_COVERAGE.branch) {
    return denyOnboarding('BASELINE_COVERAGE_BELOW_MINIMUM');
  }

  const gates = pkg.localGates;
  if (!exact(gates, [
    'minLineCoverage', 'minBranchCoverage', 'maxConcurrency',
    'requiredChecks', 'requireExplicitApproval', 'requireStrictUpToDate'
  ]) ||
      !pct(gates.minLineCoverage) ||
      !pct(gates.minBranchCoverage) ||
      !posInt(gates.maxConcurrency) ||
      !dense(gates.requiredChecks) ||
      gates.requiredChecks.length === 0 ||
      !gates.requiredChecks.every(c => exact(c, ['name', 'appId']) && text(c.name) && posInt(c.appId)) ||
      typeof gates.requireExplicitApproval !== 'boolean' ||
      typeof gates.requireStrictUpToDate !== 'boolean') {
    return denyOnboarding('LOCAL_GATES_INVALID');
  }

  if (!gates.requireExplicitApproval ||
      !gates.requireStrictUpToDate ||
      pkg.policy.coverage.line < gates.minLineCoverage ||
      pkg.policy.coverage.branch < gates.minBranchCoverage ||
      pkg.policy.maxActive > gates.maxConcurrency ||
      gates.requiredChecks.some(req =>
        !pkg.policy.checks.some(c => c.name === req.name && c.appId === req.appId))) {
    return denyOnboarding('LOCAL_GATE_WEAKENED');
  }

  const creds = pkg.credentials;
  if (!exact(creds, ['credentialId', 'scope', 'allowedRepositories', 'sharedAdminToken', 'persistedInCheckout']) ||
      !text(creds.credentialId, 120) ||
      creds.scope !== 'repo-read-only-shadow' ||
      creds.sharedAdminToken !== false ||
      creds.persistedInCheckout !== false ||
      !dense(creds.allowedRepositories) ||
      creds.allowedRepositories.length !== 1 ||
      !text(creds.allowedRepositories[0]) ||
      identity(creds.allowedRepositories[0]) !== identity(pkg.policy.repository)) {
    return denyOnboarding('CREDENTIAL_ISOLATION_VIOLATION');
  }

  for (const peer of registry) {
    if (identity(peer.repository) === identity(pkg.policy.repository) ||
        peer.repositoryId === pkg.repositoryId) {
      return denyOnboarding('DUPLICATE_CONSUMER');
    }
    if (identity(peer.credentialId) === identity(creds.credentialId)) {
      return denyOnboarding('CREDENTIAL_ISOLATION_VIOLATION');
    }
  }

  const suite = pkg.replaySuite;
  if (!exact(suite, [
    'eligibleCandidate', 'staleReview', 'dismissedReview',
    'commentedBotReview', 'wrongRepository', 'missingQuota', 'killSwitchPolicy'
  ])) {
    return denyOnboarding('SHADOW_REPLAY_INCOMPLETE');
  }

  const shadowPolicy = { ...pkg.policy, mode: 'shadow', killSwitch: false };
  if (!strictSnapshotShape(suite.eligibleCandidate) ||
      !strictPolicyShape(suite.killSwitchPolicy) ||
      !sameData(suite.killSwitchPolicy, { ...shadowPolicy, killSwitch: true }) ||
      !isStaleReviewScenario(suite.eligibleCandidate, suite.staleReview) ||
      !isDismissedReviewScenario(suite.eligibleCandidate, suite.dismissedReview) ||
      !isCommentedBotScenario(suite.eligibleCandidate, suite.commentedBotReview) ||
      !isWrongRepoScenario(suite.eligibleCandidate, suite.wrongRepository) ||
      !isMissingQuotaScenario(suite.eligibleCandidate, suite.missingQuota)) {
    return denyOnboarding('SHADOW_REPLAY_INCOMPLETE');
  }

  const replayChecks = [
    [shadowPolicy, suite.eligibleCandidate, 'SHADOW_ELIGIBLE'],
    [suite.killSwitchPolicy, suite.eligibleCandidate, 'STOPPED'],
    [shadowPolicy, suite.staleReview, 'REVIEW_MISSING'],
    [shadowPolicy, suite.dismissedReview, 'REVIEW_MISSING'],
    [shadowPolicy, suite.commentedBotReview, 'REVIEW_MISSING'],
    [shadowPolicy, suite.wrongRepository, 'UNTRUSTED_POLICY'],
    [shadowPolicy, suite.missingQuota, 'BUDGET_OR_CONCURRENCY']
   ];
  if (!replayChecks.every(([pol, snap, expected]) => evaluate(pol, snap).reason === expected)) {
    return denyOnboarding('SHADOW_REPLAY_INCOMPLETE');
  }

  const rb = pkg.rollback;
  if (!exact(rb, [
    'disableMode', 'killSwitch', 'revokeCredentialId',
    'revertWorkflowPinPrRequired', 'queuedLiveMutations'
  ]) ||
      rb.disableMode !== 'disabled' ||
      rb.killSwitch !== true ||
      rb.revokeCredentialId !== creds.credentialId ||
      rb.revertWorkflowPinPrRequired !== true ||
      !Object.is(rb.queuedLiveMutations, 0)) {
    return denyOnboarding('ROLLBACK_INVALID');
  }

  return Object.freeze({
    valid: true,
    reason: 'ONBOARDING_CONTRACT_VERIFIED',
    shadow: true,
    liveActivation: false,
    repository: pkg.policy.repository,
    repositoryId: pkg.repositoryId,
    pinnedWorkflowSha: pinCheck.pinnedWorkflowSha,
    pinnedCheckoutSha: pinCheck.pinnedCheckoutSha
  });
}

const denyRollback = reason =>
  Object.freeze({ valid: false, reason, shadow: true, liveActivation: false });

export function verifyIndependentRollback(targetRepository, rollbackReceipt, packages) {
  if (!text(targetRepository) ||
      !exact(rollbackReceipt, [
        'repository', 'postPolicy', 'revokedCredentialId',
        'pinRevertedViaReviewedPr', 'queuedLiveMutations'
      ]) ||
      !text(rollbackReceipt.repository) ||
      identity(rollbackReceipt.repository) !== identity(targetRepository) ||
      !dense(packages) ||
      packages.length < 2) {
    return denyRollback('ROLLBACK_INPUT_INVALID');
  }

  const registry = [];
  for (const pkg of packages) {
    if (!verifyConsumerOnboardingPackage(pkg, registry).valid) {
      return denyRollback('INVALID_PACKAGE_SET');
    }
    registry.push({
      repository: pkg.policy.repository,
      repositoryId: pkg.repositoryId,
      credentialId: pkg.credentials.credentialId
    });
  }

  const targetPkg = packages.find(pkg => identity(pkg.policy.repository) === identity(targetRepository));
  if (!targetPkg) {
    return denyRollback('ROLLBACK_TARGET_UNKNOWN');
  }

  const expectedPostPolicy = { ...targetPkg.policy, mode: 'disabled', killSwitch: true };
  if (!strictPolicyShape(rollbackReceipt.postPolicy) ||
      !sameData(rollbackReceipt.postPolicy, expectedPostPolicy) ||
      rollbackReceipt.revokedCredentialId !== targetPkg.credentials.credentialId ||
      rollbackReceipt.pinRevertedViaReviewedPr !== true ||
      !Object.is(rollbackReceipt.queuedLiveMutations, 0)) {
    return denyRollback('TARGET_ROLLBACK_INCOMPLETE');
  }

  const targetDecision = evaluate(rollbackReceipt.postPolicy, targetPkg.replaySuite.eligibleCandidate).reason;
  const unaffectedPeers = [];
  for (const peer of packages) {
    if (identity(peer.policy.repository) === identity(targetRepository)) continue;
    evaluate({ ...peer.policy, mode: 'shadow', killSwitch: false }, peer.replaySuite.eligibleCandidate);
    unaffectedPeers.push(peer.policy.repository);
  }

  return Object.freeze({
    valid: true,
    reason: 'SINGLE_REPO_ROLLBACK_VERIFIED',
    shadow: true,
    liveActivation: false,
    targetDecision,
    stoppedRepository: targetPkg.policy.repository,
    unaffectedPeers: Object.freeze(unaffectedPeers)
  });
}

export function planConsumerBootstrap(request) {
  const denyPlan = reason =>
    Object.freeze({ valid: false, reason, dryRun: true, mutatesGitHub: false });

  if (!exact(request, [
    'repository', 'repositoryId', 'workflowPin',
    'checks', 'owners', 'reviewers', 'existingState'
  ]) ||
      !text(request.repository) ||
      !/^[^/]+\/[^/]+$/.test(request.repository) ||
      identity(request.repository) === identity(FACTORY_REPOSITORY) ||
      !posInt(request.repositoryId) ||
      request.repositoryId === FACTORY_REPOSITORY_ID) {
    return denyPlan('BOOTSTRAP_REQUEST_INVALID');
  }

  const pinCheck = verifyWorkflowPin(request.workflowPin);
  if (!pinCheck.valid) {
    return denyPlan(pinCheck.reason);
  }

  const state = request.existingState;
  if (!exact(state, [
    'defaultBranch', 'mergeMethod', 'lineCoverageGate',
    'branchCoverageGate', 'maxConcurrency', 'existingFiles'
  ]) ||
      !pct(state.lineCoverageGate) ||
      !pct(state.branchCoverageGate) ||
      !posInt(state.maxConcurrency) ||
      !dense(state.existingFiles) ||
      !state.existingFiles.every(f => exact(f, ['path', 'content']) && repoPath(f.path) && typeof f.content === 'string') ||
      !unique(state.existingFiles.map(f => identity(f.path)))) {
    return denyPlan('EXISTING_STATE_INVALID');
  }

  const policy = {
    version: 1,
    repository: request.repository,
    defaultBranch: state.defaultBranch,
    mergeMethod: state.mergeMethod,
    mode: 'disabled',
    killSwitch: true,
    checks: request.checks,
    reviewers: request.reviewers,
    coverage: {
      line: Math.max(CONSUMER_BASELINE_COVERAGE.line, state.lineCoverageGate),
      branch: Math.max(CONSUMER_BASELINE_COVERAGE.branch, state.branchCoverageGate)
    },
    owners: request.owners,
    maxActive: state.maxConcurrency,
    creditLimit: 100,
    riskClasses: ['low', 'high']
  };

  if (!strictPolicyShape(policy)) {
    return denyPlan('BOOTSTRAP_POLICY_INVALID');
  }

  const workflowPath = '.github/workflows/softwarefactory-shadow-replay.yml';
  const policyPath = '.github/softwarefactory-policy.json';
  const workflowContent = [
    'name: SoftwareFactory synthetic replay',
    'on:',
    '  pull_request:',
    '  workflow_dispatch:',
    'permissions:',
    '  contents: read',
    'jobs:',
    '  replay:',
    `    uses: ${REUSABLE_WORKFLOW_PREFIX}${pinCheck.pinnedWorkflowSha}`,
    ''
  ].join('\n');
  const policyContent = `${JSON.stringify(policy, null, 2)}\n`;

  const plannedFiles = [
    Object.freeze({ path: workflowPath, content: workflowContent }),
    Object.freeze({ path: policyPath, content: policyContent })
  ];

  const conflicts = [];
  let matchedCount = 0;
  for (const planned of plannedFiles) {
    const pp = identity(planned.path);
    const colliding = state.existingFiles.filter(f => {
      const ep = identity(f.path);
      return ep === pp || pp.startsWith(`${ep}/`) || ep.startsWith(`${pp}/`);
    });
    if (colliding.length === 0) continue;
    if (colliding.length === 1 &&
        colliding[0].path === planned.path &&
        colliding[0].content === planned.content) {
      matchedCount += 1;
    } else {
      conflicts.push(planned.path);
    }
  }

  if (conflicts.length > 0) {
    return Object.freeze({
      valid: false,
      reason: 'EXISTING_FILE_CONFLICT',
      dryRun: true,
      mutatesGitHub: false,
      conflicts: Object.freeze(conflicts)
    });
  }

  const idempotentNoOp = matchedCount === plannedFiles.length;
  return Object.freeze({
    valid: true,
    reason: idempotentNoOp ? 'IDEMPOTENT_NOOP' : 'DRY_RUN_PLAN_READY',
    dryRun: true,
    mutatesGitHub: false,
    reviewablePrRequired: true,
    idempotentNoOp,
    pinnedWorkflowSha: pinCheck.pinnedWorkflowSha,
    pinnedCheckoutSha: pinCheck.pinnedCheckoutSha,
    policy,
    filesToWrite: Object.freeze(plannedFiles.filter(p => !state.existingFiles.some(f => f.path === p.path)))
  });
}
