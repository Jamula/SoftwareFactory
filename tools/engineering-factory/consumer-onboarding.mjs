// Deterministic, metadata-only consumer onboarding, isolation and rollback contract verifier.
import { types } from 'node:util';
import { evaluate, validPolicy } from './core.mjs';

export const CONSUMER_CONTRACT_VERSION = 1;
export const FACTORY_REPOSITORY = 'Jamula/SoftwareFactory';
export const FACTORY_REPOSITORY_ID = 1471342715;
export const REUSABLE_WORKFLOW_PREFIX = 'Jamula/SoftwareFactory/.github/workflows/shadow-tests.yml@';
export const CONSUMER_BASELINE_COVERAGE = Object.freeze({ line: 95, branch: 90 });
export const MAX_MANDATORY_USER_SETTINGS = 5;
export const ONBOARDING_DISCOVERY_MODES = Object.freeze(['greenfield', 'existing-repository']);
export const MANDATORY_ONBOARDING_SETTINGS = Object.freeze([
  'repository',
  'repositoryId',
  'pinnedFactorySha',
  'stackProfile'
]);
export const OPTIONAL_ONBOARDING_SETTINGS = Object.freeze(['stricterCoverageThresholds']);
export const TRUSTED_WORKFLOW_CHECKOUT_PINS = Object.freeze(
  Object.assign(Object.create(null), {
    afc3d223f287b029db32672908097efc67a259c9: '1208481843e73d1d2506085c654e84255303541d'
  })
);

export const ONBOARDING_STACK_PROFILES = Object.freeze({
  'baseline-95-90': Object.freeze({
    defaultBranch: 'main',
    mergeMethod: 'squash',
    coverage: Object.freeze({ line: 95, branch: 90 }),
    maxActive: 1,
    checks: Object.freeze([Object.freeze({ name: 'build-test', appId: 12345 })]),
    reviewers: Object.freeze(['synthetic-reviewer']),
    owners: Object.freeze([Object.freeze({ prefix: 'src/', owner: 'synthetic-owner' })])
  }),
  'web-genealogy-95-90': Object.freeze({
    defaultBranch: 'main',
    mergeMethod: 'squash',
    coverage: Object.freeze({ line: 95, branch: 90 }),
    maxActive: 1,
    checks: Object.freeze([Object.freeze({ name: 'build-test', appId: 12345 })]),
    reviewers: Object.freeze(['synthetic-reviewer']),
    owners: Object.freeze([Object.freeze({ prefix: 'src/', owner: 'synthetic-owner' })])
  }),
  'ios-webkit-97-90': Object.freeze({
    defaultBranch: 'main',
    mergeMethod: 'squash',
    coverage: Object.freeze({ line: 97, branch: 90 }),
    maxActive: 2,
    checks: Object.freeze([
      Object.freeze({ name: 'fictional-webkit-gate', appId: 34567 }),
      Object.freeze({ name: 'fictional-ios-gate', appId: 34568 })
    ]),
    reviewers: Object.freeze(['synthetic-spellbook-reviewer']),
    owners: Object.freeze([
      Object.freeze({ prefix: 'ios/', owner: 'synthetic-ios-owner' }),
      Object.freeze({ prefix: 'src/', owner: 'synthetic-spellbook-owner' })
    ])
  }),
  'strict-up-to-date-migration-gated': Object.freeze({
    defaultBranch: 'trunk',
    mergeMethod: 'merge',
    coverage: Object.freeze({ line: 100, branch: 100 }),
    maxActive: 1,
    checks: Object.freeze([Object.freeze({ name: 'fictional-hub-gate', appId: 23456 })]),
    reviewers: Object.freeze(['synthetic-reviewer', 'synthetic-hub-reviewer']),
    owners: Object.freeze([Object.freeze({ prefix: 'app/', owner: 'synthetic-hub-owner' })])
  })
});

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
  return Boolean(
    desc &&
    Object.hasOwn(desc, 'enumerable') &&
    desc.enumerable === true &&
    Object.hasOwn(desc, 'value')
  );
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

const WORKFLOW_FILE_PATH = '.github/workflows/softwarefactory-shadow-replay.yml';
const POLICY_FILE_PATH = '.github/softwarefactory-policy.json';
const VISIBILITY_VALUES = ['public', 'private', 'internal'];
const ALL_USER_SETTINGS_SET = new Set([
  ...MANDATORY_ONBOARDING_SETTINGS,
  ...OPTIONAL_ONBOARDING_SETTINGS
]);
const DISCOVERY_INPUT_KEYS = new Set([
  'mode',
  'repository',
  'repositoryId',
  'pinnedFactorySha',
  'pinnedCheckoutSha',
  'observedCheckoutRef',
  'stackProfile',
  'stricterCoverageThresholds',
  'mandatorySettings',
  'defaultEnabled',
  'implicitActivation',
  'overwriteExistingFiles',
  'visibility',
  'unsupportedResources',
  'existingFiles',
  'discoveredRepository'
]);
const REQUIRED_DISCOVERED_REPO_FIELDS = Object.freeze([
  'defaultBranch',
  'mergeMethod',
  'checks',
  'reviewers',
  'owners',
  'coverage',
  'maxConcurrency',
  'existingFiles'
]);
const DISCOVERED_REPO_KEYS = new Set([
  ...REQUIRED_DISCOVERED_REPO_FIELDS,
  'requireExplicitApproval',
  'requireStrictUpToDate',
  'allowCommentedBotApproval',
  'migrationFreezeClear',
  'visibility'
]);

const JSON_CHAR_ESCAPES = Object.freeze(
  Object.assign(Object.create(null), {
    8: '\\b',
    9: '\\t',
    10: '\\n',
    12: '\\f',
    13: '\\r',
    34: '\\"',
    92: '\\\\'
  })
);

const quoteJsonString = value => {
  let out = '"';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const mapped = JSON_CHAR_ESCAPES[code];
    if (mapped !== undefined) {
      out += mapped;
    } else if (code < 0x20) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    } else {
      out += value[i];
    }
  }
  return `${out}"`;
};

const serializeHookFreeJson = (value, depth = 0) => {
  if (typeof value === 'string') return quoteJsonString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const pad = '  '.repeat(depth);
  const childPad = '  '.repeat(depth + 1);
  if (Array.isArray(value)) {
    const items = value.map(item => `${childPad}${serializeHookFreeJson(item, depth + 1)}`);
    return `[\n${items.join(',\n')}\n${pad}]`;
  }
  const entries = Object.keys(value).map(
    key => `${childPad}${quoteJsonString(key)}: ${serializeHookFreeJson(value[key], depth + 1)}`
  );
  return `{\n${entries.join(',\n')}\n${pad}}`;
};

const plainAllowed = (value, allowedKeys) =>
  value !== null &&
  typeof value === 'object' &&
  !types.isProxy(value) &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Reflect.ownKeys(value).every(key => typeof key === 'string' && allowedKeys.has(key) && ownData(value, key));

const repoSlug = value => {
  if (!text(value, 200) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) return false;
  const [owner, repo] = value.split('/');
  return owner !== '.' && owner !== '..' && repo !== '.' && repo !== '..';
};

const branchName = value =>
  text(value, 120) &&
  /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
  !value.includes('..') &&
  !value.includes('//') &&
  !value.endsWith('/');

const renderShadowReplayWorkflow = pinnedWorkflowSha => [
  'name: SoftwareFactory synthetic replay',
  'on:',
  '  pull_request:',
  '  workflow_dispatch:',
  'permissions:',
  '  contents: read',
  'jobs:',
  '  replay:',
  `    uses: ${REUSABLE_WORKFLOW_PREFIX}${pinnedWorkflowSha}`,
  ''
].join('\n');

const renderPolicyJson = policy => `${serializeHookFreeJson(policy)}\n`;

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

  const plannedFiles = [
    Object.freeze({ path: WORKFLOW_FILE_PATH, content: renderShadowReplayWorkflow(pinCheck.pinnedWorkflowSha) }),
    Object.freeze({ path: POLICY_FILE_PATH, content: renderPolicyJson(policy) })
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

export function buildReadOnlyOnboardingPlan(discoveryInput) {
  const denyDiscovery = (reason, extra = {}) =>
    Object.freeze({
      valid: false,
      reason,
      shadow: true,
      readOnly: true,
      dryRun: true,
      defaultEnabled: false,
      implicitActivation: false,
      overwriteExistingFiles: false,
      liveActivation: false,
      mutatesGitHub: false,
      liveMutations: 0,
      deployments: 0,
      ...extra
    });

  if (!plainAllowed(discoveryInput, DISCOVERY_INPUT_KEYS)) {
    return denyDiscovery('DISCOVERY_INPUT_INVALID');
  }

  for (const flag of ['defaultEnabled', 'implicitActivation', 'overwriteExistingFiles']) {
    if (!Object.hasOwn(discoveryInput, flag)) continue;
    if (typeof discoveryInput[flag] !== 'boolean') {
      return denyDiscovery('DISCOVERY_INPUT_INVALID');
    }
    if (discoveryInput[flag] !== false) {
      return denyDiscovery('UNSAFE_DISCOVERY_DEFAULTS');
    }
  }

  let requiredKeys = MANDATORY_ONBOARDING_SETTINGS;
  if (Object.hasOwn(discoveryInput, 'mandatorySettings')) {
    const ms = discoveryInput.mandatorySettings;
    if (!dense(ms, 32) || !ms.every(s => text(s, 80)) || !unique(ms)) {
      return denyDiscovery('DISCOVERY_INPUT_INVALID');
    }
    if (ms.length > MAX_MANDATORY_USER_SETTINGS) {
      return denyDiscovery('MANDATORY_SETTINGS_LIMIT_EXCEEDED');
    }
    if (!MANDATORY_ONBOARDING_SETTINGS.every(k => ms.includes(k)) ||
        !ms.every(k => ALL_USER_SETTINGS_SET.has(k) && Object.hasOwn(discoveryInput, k))) {
      return denyDiscovery('DISCOVERY_INPUT_INVALID');
    }
    requiredKeys = Object.freeze([...ms]);
  }

  const hasPinnedCheckout = Object.hasOwn(discoveryInput, 'pinnedCheckoutSha');
  const hasObservedCheckout = Object.hasOwn(discoveryInput, 'observedCheckoutRef');
  if (!Object.hasOwn(discoveryInput, 'repository') ||
      !repoSlug(discoveryInput.repository) ||
      !Object.hasOwn(discoveryInput, 'repositoryId') ||
      !posInt(discoveryInput.repositoryId) ||
      !Object.hasOwn(discoveryInput, 'pinnedFactorySha') ||
      typeof discoveryInput.pinnedFactorySha !== 'string' ||
      (hasPinnedCheckout && typeof discoveryInput.pinnedCheckoutSha !== 'string') ||
      (hasObservedCheckout && typeof discoveryInput.observedCheckoutRef !== 'string') ||
      !Object.hasOwn(discoveryInput, 'stackProfile') ||
      !text(discoveryInput.stackProfile, 80)) {
    return denyDiscovery('DISCOVERY_INPUT_INVALID');
  }

  if (identity(discoveryInput.repository) === identity(FACTORY_REPOSITORY) ||
      discoveryInput.repositoryId === FACTORY_REPOSITORY_ID) {
    return denyDiscovery('INVALID_CONSUMER_POLICY');
  }

  const pinnedFactorySha = discoveryInput.pinnedFactorySha;
  if (!sha40(pinnedFactorySha) ||
      (hasPinnedCheckout && !sha40(discoveryInput.pinnedCheckoutSha)) ||
      (hasObservedCheckout && !sha40(discoveryInput.observedCheckoutRef))) {
    return denyDiscovery('PIN_REF_NOT_IMMUTABLE_SHA');
  }

  const catalogedCheckoutSha = TRUSTED_WORKFLOW_CHECKOUT_PINS[pinnedFactorySha];
  let checkoutRef;
  let reviewedCheckoutSha;
  if (catalogedCheckoutSha !== undefined) {
    if ((hasPinnedCheckout && discoveryInput.pinnedCheckoutSha !== catalogedCheckoutSha) ||
        (hasObservedCheckout && discoveryInput.observedCheckoutRef !== catalogedCheckoutSha)) {
      return denyDiscovery('PIN_SHA_MISMATCH');
    }
    checkoutRef = catalogedCheckoutSha;
    reviewedCheckoutSha = catalogedCheckoutSha;
  } else {
    const missingPinEvidence = [];
    if (!hasObservedCheckout) missingPinEvidence.push('workflow-checkout-ref-discovery-required');
    if (!hasPinnedCheckout) missingPinEvidence.push('reviewed-checkout-sha-required');
    if (missingPinEvidence.length > 0) {
      return denyDiscovery('CHECKOUT_PIN_UNVERIFIED', {
        blockers: Object.freeze(missingPinEvidence)
      });
    }
    if (discoveryInput.observedCheckoutRef !== discoveryInput.pinnedCheckoutSha) {
      return denyDiscovery('PIN_SHA_MISMATCH');
    }
    checkoutRef = discoveryInput.observedCheckoutRef;
    reviewedCheckoutSha = discoveryInput.pinnedCheckoutSha;
  }

  if (!Object.hasOwn(ONBOARDING_STACK_PROFILES, discoveryInput.stackProfile)) {
    return denyDiscovery('UNSUPPORTED_STACK_PROFILE');
  }
  const profile = ONBOARDING_STACK_PROFILES[discoveryInput.stackProfile];

  const hasDiscovered = Object.hasOwn(discoveryInput, 'discoveredRepository');
  let mode = hasDiscovered ? 'existing-repository' : 'greenfield';
  if (Object.hasOwn(discoveryInput, 'mode')) {
    if (!ONBOARDING_DISCOVERY_MODES.includes(discoveryInput.mode)) {
      return denyDiscovery('DISCOVERY_INPUT_INVALID');
    }
    mode = discoveryInput.mode;
  }
  if (mode === 'greenfield' && hasDiscovered) {
    return denyDiscovery('DISCOVERY_MODE_MISMATCH');
  }

  if (Object.hasOwn(discoveryInput, 'visibility') &&
      !VISIBILITY_VALUES.includes(discoveryInput.visibility)) {
    return denyDiscovery('DISCOVERY_INPUT_INVALID');
  }

  if (Object.hasOwn(discoveryInput, 'unsupportedResources')) {
    const resources = discoveryInput.unsupportedResources;
    if (!dense(resources, 32) || !resources.every(r => text(r, 120)) || !unique(resources)) {
      return denyDiscovery('DISCOVERY_INPUT_INVALID');
    }
    if (resources.length > 0) {
      return denyDiscovery('UNSUPPORTED_RESOURCE_BLOCKED', {
        blockers: Object.freeze([...resources])
      });
    }
  }

  if (mode === 'existing-repository' && !hasDiscovered) {
    return denyDiscovery('DISCOVERY_INVENTORY_INCOMPLETE', {
      blockers: Object.freeze(REQUIRED_DISCOVERED_REPO_FIELDS.map(f => `missing-discovered-${f}`))
    });
  }

  const discovered = hasDiscovered ? discoveryInput.discoveredRepository : null;
  if (hasDiscovered) {
    if (!plainAllowed(discovered, DISCOVERED_REPO_KEYS)) {
      return denyDiscovery('DISCOVERED_REPOSITORY_INVALID');
    }
    if (Object.hasOwn(discoveryInput, 'existingFiles') ||
        (Object.hasOwn(discoveryInput, 'visibility') &&
          Object.hasOwn(discovered, 'visibility') &&
          discoveryInput.visibility !== discovered.visibility)) {
      return denyDiscovery('DISCOVERY_INPUT_INVALID');
    }
    const missingFields = REQUIRED_DISCOVERED_REPO_FIELDS.filter(
      field => !Object.hasOwn(discovered, field)
    );
    if (missingFields.length > 0) {
      return denyDiscovery('DISCOVERY_INVENTORY_INCOMPLETE', {
        blockers: Object.freeze(missingFields.map(f => `missing-discovered-${f}`))
      });
    }
    for (const boolKey of [
      'migrationFreezeClear',
      'requireExplicitApproval',
      'requireStrictUpToDate',
      'allowCommentedBotApproval'
    ]) {
      if (Object.hasOwn(discovered, boolKey) && typeof discovered[boolKey] !== 'boolean') {
        return denyDiscovery('DISCOVERED_REPOSITORY_INVALID');
      }
    }
    if (!exact(discovered.coverage, ['line', 'branch']) ||
        !pct(discovered.coverage.line) ||
        !pct(discovered.coverage.branch) ||
        !posInt(discovered.maxConcurrency) ||
        discovered.maxConcurrency > 12 ||
        (Object.hasOwn(discovered, 'visibility') &&
          !VISIBILITY_VALUES.includes(discovered.visibility))) {
      return denyDiscovery('DISCOVERED_REPOSITORY_INVALID');
    }
    if (Object.hasOwn(discovered, 'migrationFreezeClear') && !discovered.migrationFreezeClear) {
      return denyDiscovery('ENROLLMENT_NOT_AUTHORIZED');
    }
    if ((Object.hasOwn(discovered, 'requireExplicitApproval') && !discovered.requireExplicitApproval) ||
        (Object.hasOwn(discovered, 'requireStrictUpToDate') && !discovered.requireStrictUpToDate) ||
        (Object.hasOwn(discovered, 'allowCommentedBotApproval') && discovered.allowCommentedBotApproval)) {
      return denyDiscovery('LOCAL_GATE_WEAKENED');
    }
  }

  const discoveredCoverage = hasDiscovered ? discovered.coverage : null;
  const requiredLine = Math.max(
    CONSUMER_BASELINE_COVERAGE.line,
    profile.coverage.line,
    discoveredCoverage ? discoveredCoverage.line : 0
  );
  const requiredBranch = Math.max(
    CONSUMER_BASELINE_COVERAGE.branch,
    profile.coverage.branch,
    discoveredCoverage ? discoveredCoverage.branch : 0
  );

  let effectiveLine = requiredLine;
  let effectiveBranch = requiredBranch;
  const hasStricter = Object.hasOwn(discoveryInput, 'stricterCoverageThresholds');
  if (hasStricter) {
    const thresh = discoveryInput.stricterCoverageThresholds;
    if (!exact(thresh, ['line', 'branch']) || !pct(thresh.line) || !pct(thresh.branch)) {
      return denyDiscovery('DISCOVERY_INPUT_INVALID');
    }
    if (thresh.line < CONSUMER_BASELINE_COVERAGE.line ||
        thresh.branch < CONSUMER_BASELINE_COVERAGE.branch) {
      return denyDiscovery('BASELINE_COVERAGE_BELOW_MINIMUM');
    }
    if (thresh.line < requiredLine || thresh.branch < requiredBranch) {
      return denyDiscovery('LOCAL_GATE_WEAKENED');
    }
    effectiveLine = thresh.line;
    effectiveBranch = thresh.branch;
  }

  const defaultBranch = hasDiscovered ? discovered.defaultBranch : profile.defaultBranch;
  const mergeMethod = hasDiscovered ? discovered.mergeMethod : profile.mergeMethod;
  const rawChecks = hasDiscovered ? discovered.checks : profile.checks;
  const rawReviewers = hasDiscovered ? discovered.reviewers : profile.reviewers;
  const rawOwners = hasDiscovered ? discovered.owners : profile.owners;
  const maxConcurrency = hasDiscovered ? discovered.maxConcurrency : profile.maxActive;
  const effectiveMaxActive = Math.min(profile.maxActive, maxConcurrency);

  const candidatePolicy = {
    version: 1,
    repository: discoveryInput.repository,
    defaultBranch,
    mergeMethod,
    mode: 'disabled',
    killSwitch: true,
    checks: rawChecks,
    reviewers: rawReviewers,
    coverage: { line: effectiveLine, branch: effectiveBranch },
    owners: rawOwners,
    maxActive: effectiveMaxActive,
    creditLimit: 100,
    riskClasses: ['low', 'high']
  };

  if (!branchName(defaultBranch) ||
      !strictPolicyShape(candidatePolicy) ||
      candidatePolicy.owners.some(o => !text(o.prefix, 200) || o.prefix.includes('//'))) {
    return denyDiscovery('DISCOVERED_REPOSITORY_INVALID');
  }

  const rawExistingFiles = hasDiscovered
    ? discovered.existingFiles
    : (Object.hasOwn(discoveryInput, 'existingFiles') ? discoveryInput.existingFiles : []);
  if (!dense(rawExistingFiles, 256)) {
    return denyDiscovery('EXISTING_FILES_INVALID');
  }
  const existingPaths = [];
  for (const entry of rawExistingFiles) {
    if (typeof entry === 'string') {
      if (!repoPath(entry)) return denyDiscovery('EXISTING_FILES_INVALID');
      existingPaths.push(entry);
    } else if (exact(entry, ['path', 'content']) && repoPath(entry.path) && typeof entry.content === 'string') {
      existingPaths.push(entry.path);
    } else {
      return denyDiscovery('EXISTING_FILES_INVALID');
    }
  }
  if (!unique(existingPaths.map(identity))) {
    return denyDiscovery('EXISTING_FILES_INVALID');
  }

  const frozenChecks = Object.freeze(
    candidatePolicy.checks.map(c => Object.freeze({ name: c.name, appId: c.appId }))
  );
  const frozenPolicy = Object.freeze({
    version: 1,
    repository: candidatePolicy.repository,
    defaultBranch: candidatePolicy.defaultBranch,
    mergeMethod: candidatePolicy.mergeMethod,
    mode: 'disabled',
    killSwitch: true,
    checks: frozenChecks,
    reviewers: Object.freeze([...candidatePolicy.reviewers]),
    coverage: Object.freeze({ line: effectiveLine, branch: effectiveBranch }),
    owners: Object.freeze(
      candidatePolicy.owners.map(o => Object.freeze({ prefix: o.prefix, owner: o.owner }))
    ),
    maxActive: effectiveMaxActive,
    creditLimit: 100,
    riskClasses: Object.freeze(['low', 'high'])
  });

  const plannedFiles = Object.freeze([
    Object.freeze({
      path: WORKFLOW_FILE_PATH,
      content: renderShadowReplayWorkflow(pinnedFactorySha)
    }),
    Object.freeze({
      path: POLICY_FILE_PATH,
      content: renderPolicyJson(frozenPolicy)
    })
  ]);

  const normalizedExisting = existingPaths.map(identity);
  const conflicts = [];
  for (const planned of plannedFiles) {
    const pp = identity(planned.path);
    if (normalizedExisting.some(ep => ep === pp || pp.startsWith(`${ep}/`) || ep.startsWith(`${pp}/`))) {
      conflicts.push(planned.path);
    }
  }
  if (conflicts.length > 0) {
    return denyDiscovery('EXISTING_FILE_CONFLICT', {
      conflicts: Object.freeze(conflicts)
    });
  }

  const visibility = Object.hasOwn(discoveryInput, 'visibility')
    ? discoveryInput.visibility
    : (hasDiscovered && Object.hasOwn(discovered, 'visibility') ? discovered.visibility : 'private');
  const suppliedKeys = Object.freeze([
    ...MANDATORY_ONBOARDING_SETTINGS,
    ...(hasStricter ? OPTIONAL_ONBOARDING_SETTINGS : [])
  ]);
  const credentialId = `cred-shadow-${discoveryInput.repositoryId}`;

  return Object.freeze({
    valid: true,
    reason: 'READ_ONLY_ONBOARDING_PLAN_READY',
    contractVersion: CONSUMER_CONTRACT_VERSION,
    mode,
    shadow: true,
    readOnly: true,
    dryRun: true,
    defaultEnabled: false,
    implicitActivation: false,
    overwriteExistingFiles: false,
    liveActivation: false,
    productionDeployEnabled: false,
    mutatesGitHub: false,
    liveMutations: 0,
    deployments: 0,
    incrementalSpendUsd: 0,
    reviewablePrRequired: true,
    repository: discoveryInput.repository,
    repositoryId: discoveryInput.repositoryId,
    stackProfile: discoveryInput.stackProfile,
    visibility,
    mandatorySettings: Object.freeze({
      maxAllowed: MAX_MANDATORY_USER_SETTINGS,
      requiredCount: requiredKeys.length,
      suppliedCount: suppliedKeys.length,
      keys: suppliedKeys
    }),
    discoveryDefaults: Object.freeze({
      defaultEnabled: false,
      implicitActivation: false,
      overwriteExistingFiles: false,
      separateBacklogCreated: false,
      mandatoryExternalServices: 0,
      authoritativeWorkTracker: 'github-issues'
    }),
    workflowPin: Object.freeze({
      uses: `${REUSABLE_WORKFLOW_PREFIX}${pinnedFactorySha}`,
      reviewedWorkflowSha: pinnedFactorySha,
      checkoutRef,
      reviewedCheckoutSha,
      permissions: 'contents:read',
      persistCredentials: false
    }),
    policy: frozenPolicy,
    localGates: Object.freeze({
      minLineCoverage: requiredLine,
      minBranchCoverage: requiredBranch,
      maxConcurrency,
      requiredChecks: Object.freeze(
        candidatePolicy.checks.map(c => Object.freeze({ name: c.name, appId: c.appId }))
      ),
      requireExplicitApproval: true,
      requireStrictUpToDate: true
    }),
    reviewPolicy: Object.freeze({
      formalApprovedReviewRequired: true,
      allowCommentedBotApproval: false,
      independentReviewerRequired: true
    }),
    executionOptions: Object.freeze({
      githubHostedOrchestrator: true,
      copilotCloudAgentSupported: true,
      copilotSdkPinnedVersion: '2.0.3',
      copilotCloudAutomationsSupported: visibility === 'private' || visibility === 'internal',
      perRepoAiCreditHardStopRequired: true,
      paidOverageAllowed: false
    }),
    killSwitch: Object.freeze({
      id: `kill-switch:${identity(discoveryInput.repository)}:${discoveryInput.repositoryId}`,
      repository: discoveryInput.repository,
      repositoryId: discoveryInput.repositoryId,
      policyPath: POLICY_FILE_PATH,
      field: 'killSwitch',
      defaultTrippedAtRest: true,
      modeAtRest: 'disabled',
      sharedWithPeers: false,
      affectsPeerRepositories: false
    }),
    rollbackPlan: Object.freeze({
      strategy: 'single-commit-revert',
      commitsToRevert: 1,
      singleCommitRevert: true,
      revertPaths: Object.freeze([WORKFLOW_FILE_PATH, POLICY_FILE_PATH]),
      disableMode: 'disabled',
      killSwitch: true,
      revokeCredentialId: credentialId,
      revertWorkflowPinPrRequired: true,
      queuedLiveMutations: 0,
      affectsPeerConsumers: false
    }),
    plannedFiles,
    prerequisites: Object.freeze([
      'm01-autonomous-pilot-accepted',
      'explicit-owner-authorization',
      'verified-zero-dollar-overage-hard-stop',
      'scoped-repo-read-only-shadow-credential'
    ]),
    blockers: Object.freeze([])
  });
}
