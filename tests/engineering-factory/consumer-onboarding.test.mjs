import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CONSUMER_BASELINE_COVERAGE,
  CONSUMER_COMPONENT_CATALOG,
  CONSUMER_CONTRACT_VERSION,
  FACTORY_REPOSITORY,
  FACTORY_REPOSITORY_ID,
  REUSABLE_WORKFLOW_PREFIX,
  planConsumerBootstrap,
  verifyConsumerOnboardingPackage,
  verifyIndependentRollback,
  verifyWorkflowPin
} from '../../tools/engineering-factory/consumer-onboarding.mjs';

const examples = JSON.parse(await readFile(new URL('../../tools/engineering-factory/example-policies.json', import.meta.url)));
const shadowWorkflowSource = await readFile(new URL('../../.github/workflows/shadow-tests.yml', import.meta.url), 'utf8');
const checkoutRefMatch = shadowWorkflowSource.match(/^\s*ref:\s*(\S+)\s*$/m);
assert.ok(checkoutRefMatch, 'shadow-tests.yml must declare an explicit checkout ref');
const reviewedWorkflowSha = 'afc3d223f287b029db32672908097efc67a259c9';
const reviewedCheckoutSha = checkoutRefMatch[1];
assert.match(reviewedCheckoutSha, /^[0-9a-f]{40}$/);
const altSha = '2'.repeat(40);
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);

const byRepo = name => examples.find(entry => entry.repository === name);

function candidateSnapshot(policy) {
  return {
    policySource: 'trusted-default-branch',
    repository: policy.repository,
    issue: 10,
    pr: 20,
    head,
    observedHead: head,
    base,
    observedBase: base,
    baseBranch: policy.defaultBranch,
    rateLimited: false,
    remainingCredits: 25,
    activeCount: 0,
    providerReady: true,
    risk: 'low',
    priority: 1,
    paths: [`${policy.owners[0].prefix}index.ts`],
    dependencies: [],
    acceptanceComplete: true,
    baseCompatible: true,
    mainHealthy: true,
    threadsResolved: true,
    securityClear: true,
    coverage: {
      head,
      line: policy.coverage.line,
      branch: policy.coverage.branch,
      complete: true
    },
    checks: policy.checks.map(c => ({
      name: c.name,
      head,
      appId: c.appId,
      status: 'completed',
      conclusion: 'success'
    })),
    author: 'synthetic-author',
    agent: 'synthetic-agent',
    reviews: [{ reviewer: policy.reviewers[0], head, state: 'APPROVED' }]
  };
}

function makeReplaySuite(policy) {
  const eligibleCandidate = candidateSnapshot(policy);
  return {
    eligibleCandidate,
    staleReview: {
      ...eligibleCandidate,
      reviews: [{ reviewer: policy.reviewers[0], head: base, state: 'APPROVED' }]
    },
    dismissedReview: {
      ...eligibleCandidate,
      reviews: [{ reviewer: policy.reviewers[0], head, state: 'DISMISSED' }]
    },
    commentedBotReview: {
      ...eligibleCandidate,
      reviews: [{
        reviewer: 'copilot-pull-request-reviewer[bot]',
        head,
        state: 'COMMENTED',
        summaryDisposition: 'clear'
      }]
    },
    wrongRepository: {
      ...eligibleCandidate,
      repository: 'example/foreign-repository'
    },
    missingQuota: {
      ...eligibleCandidate,
      remainingCredits: 0
    },
    killSwitchPolicy: {
      ...policy,
      mode: 'shadow',
      killSwitch: true
    }
  };
}

function makeOnboardingPackage(policy, {
  repositoryId,
  stackProfile,
  credentialId,
  minLineCoverage = policy.coverage.line,
  minBranchCoverage = policy.coverage.branch,
  maxConcurrency = policy.maxActive,
  requiredChecks = policy.checks.map(c => ({ ...c }))
}) {
  return {
    contractVersion: CONSUMER_CONTRACT_VERSION,
    repositoryId,
    stackProfile,
    ownerAuthorized: true,
    migrationFreezeClear: true,
    autoActivate: false,
    productionDeployEnabled: false,
    workflowPin: {
      uses: `${REUSABLE_WORKFLOW_PREFIX}${reviewedWorkflowSha}`,
      reviewedWorkflowSha,
      checkoutRef: reviewedCheckoutSha,
      reviewedCheckoutSha,
      permissions: 'contents:read',
      persistCredentials: false
    },
    policy: structuredClone(policy),
    localGates: {
      minLineCoverage,
      minBranchCoverage,
      maxConcurrency,
      requiredChecks,
      requireExplicitApproval: true,
      requireStrictUpToDate: true
    },
    credentials: {
      credentialId,
      scope: 'repo-read-only-shadow',
      allowedRepositories: [policy.repository],
      sharedAdminToken: false,
      persistedInCheckout: false
    },
    replaySuite: makeReplaySuite(policy),
    rollback: {
      disableMode: 'disabled',
      killSwitch: true,
      revokeCredentialId: credentialId,
      revertWorkflowPinPrRequired: true,
      queuedLiveMutations: 0
    }
  };
}

const familyTreePkg = makeOnboardingPackage(byRepo('example/family-tree'), {
  repositoryId: 900101,
  stackProfile: 'web-genealogy-95-90',
  credentialId: 'cred-shadow-family-tree'
});
const spellbookPkg = makeOnboardingPackage(byRepo('example/spellbook'), {
  repositoryId: 900202,
  stackProfile: 'ios-webkit-97-90',
  credentialId: 'cred-shadow-spellbook'
});
const familyHubPkg = makeOnboardingPackage(byRepo('example/family-hub'), {
  repositoryId: 900303,
  stackProfile: 'strict-up-to-date-migration-gated',
  credentialId: 'cred-shadow-family-hub'
});

test('component catalog and baseline constants are frozen and read-only', () => {
  assert.equal(Object.isFrozen(CONSUMER_BASELINE_COVERAGE), true);
  assert.equal(Object.isFrozen(CONSUMER_COMPONENT_CATALOG), true);
  assert.equal(CONSUMER_COMPONENT_CATALOG.length, 3);
  for (const item of CONSUMER_COMPONENT_CATALOG) {
    assert.equal(Object.isFrozen(item), true);
    assert.equal(item.mutatesGitHub, false);
    assert.equal(item.requiresConsumerSecrets, false);
  }
});

test('verifyWorkflowPin requires immutable dual 40-hex SHAs and least-privilege flags', () => {
  const validPin = familyTreePkg.workflowPin;
  assert.notEqual(reviewedWorkflowSha, reviewedCheckoutSha);
  assert.deepEqual(verifyWorkflowPin(validPin), {
    valid: true,
    reason: 'PIN_VERIFIED',
    shadow: true,
    pinnedWorkflowSha: reviewedWorkflowSha,
    pinnedCheckoutSha: reviewedCheckoutSha
  });

  const getterPin = { ...validPin };
  Object.defineProperty(getterPin, 'uses', { get: () => validPin.uses, enumerable: true });
  for (const bad of [
    null,
    'pin',
    [],
    new Proxy({ ...validPin }, {}),
    Object.create(null),
    { ...validPin, extra: true },
    { ...validPin, uses: 1 },
    { ...validPin, permissions: 123 },
    { ...validPin, persistCredentials: 'false' },
    getterPin,
    {
      wrongKey: 1,
      reviewedWorkflowSha,
      checkoutRef: reviewedCheckoutSha,
      reviewedCheckoutSha,
      permissions: 'contents:read',
      persistCredentials: false
    }
  ]) {
    assert.equal(verifyWorkflowPin(bad).reason, 'PIN_SCHEMA_INVALID');
  }

  assert.equal(
    verifyWorkflowPin({ ...validPin, uses: `other/repo/.github/workflows/shadow-tests.yml@${reviewedWorkflowSha}` }).reason,
    'PIN_WORKFLOW_UNTRUSTED'
  );

  for (const badPin of [
    { ...validPin, uses: `${REUSABLE_WORKFLOW_PREFIX}main` },
    { ...validPin, uses: `${REUSABLE_WORKFLOW_PREFIX}v1.0.0` },
    { ...validPin, uses: `${REUSABLE_WORKFLOW_PREFIX}${'A'.repeat(40)}` },
    { ...validPin, reviewedWorkflowSha: 'refs/heads/main' },
    { ...validPin, checkoutRef: '1234567' },
    { ...validPin, reviewedCheckoutSha: 'v1.0.0' }
  ]) {
    assert.equal(verifyWorkflowPin(badPin).reason, 'PIN_REF_NOT_IMMUTABLE_SHA');
  }

  assert.equal(
    verifyWorkflowPin({ ...validPin, uses: `${REUSABLE_WORKFLOW_PREFIX}${altSha}` }).reason,
    'PIN_SHA_MISMATCH'
  );
  assert.equal(
    verifyWorkflowPin({ ...validPin, checkoutRef: altSha }).reason,
    'PIN_SHA_MISMATCH'
  );
  // Assuming workflow SHA automatically updates internal shadow-tests.yml checkoutRef fails closed
  assert.equal(
    verifyWorkflowPin({ ...validPin, reviewedCheckoutSha: reviewedWorkflowSha }).reason,
    'PIN_SHA_MISMATCH'
  );
  assert.equal(
    verifyWorkflowPin({ ...validPin, permissions: 'contents:write' }).reason,
    'PIN_PRIVILEGE_INVALID'
  );
  assert.equal(
    verifyWorkflowPin({ ...validPin, persistCredentials: true }).reason,
    'PIN_PRIVILEGE_INVALID'
  );
});

test('verifies three independent synthetic stack profiles without live activation or credential sharing', () => {
  const registry = [];
  for (const pkg of [familyTreePkg, spellbookPkg, familyHubPkg]) {
    const standalone = verifyConsumerOnboardingPackage(pkg);
    assert.equal(standalone.valid, true);
    assert.equal(standalone.reason, 'ONBOARDING_CONTRACT_VERIFIED');
    assert.equal(standalone.shadow, true);
    assert.equal(standalone.liveActivation, false);
    assert.equal(standalone.pinnedWorkflowSha, reviewedWorkflowSha);
    assert.equal(standalone.pinnedCheckoutSha, reviewedCheckoutSha);

    const registered = verifyConsumerOnboardingPackage(pkg, registry);
    assert.equal(registered.valid, true);
    registry.push({
      repository: pkg.policy.repository,
      repositoryId: pkg.repositoryId,
      credentialId: pkg.credentials.credentialId
    });
  }
});

test('rejects malformed envelopes, array tricks, unauthorized enrollment and migration freezes', () => {
  const sparseWithProp = new Array(1);
  sparseWithProp.extra = 1;
  const getterArray = [{ repository: 'example/other', repositoryId: 5, credentialId: 'cred-other' }];
  Object.defineProperty(getterArray, 0, { get: () => ({ repository: 'example/other', repositoryId: 5, credentialId: 'cred-other' }), enumerable: true });
  const inheritedArray = Object.setPrototypeOf([], Object.create(Array.prototype));

  for (const [pkg, registry] of [
    [null, []],
    [{ ...familyTreePkg, contractVersion: 2 }, []],
    [{ ...familyTreePkg, repositoryId: 0 }, []],
    [{ ...familyTreePkg, stackProfile: '  padded ' }, []],
    [{ ...familyTreePkg, ownerAuthorized: 'yes' }, []],
    [{ ...familyTreePkg, migrationFreezeClear: null }, []],
    [{ ...familyTreePkg, autoActivate: 'no' }, []],
    [{ ...familyTreePkg, productionDeployEnabled: 0 }, []],
    [familyTreePkg, new Proxy([], {})],
    [familyTreePkg, 'not-array'],
    [familyTreePkg, inheritedArray],
    [familyTreePkg, new Array(65).fill({ repository: 'example/r', repositoryId: 1, credentialId: 'c' })],
    [familyTreePkg, new Array(1)],
    [familyTreePkg, sparseWithProp],
    [familyTreePkg, getterArray],
    [familyTreePkg, [{ repository: '', repositoryId: 1, credentialId: 'c' }]],
    [familyTreePkg, [{ repository: 'example/r', repositoryId: -1, credentialId: 'c' }]],
    [familyTreePkg, [{ repository: 'example/r', repositoryId: 1, credentialId: '' }]],
    [familyTreePkg, [{ repository: 'example/r', repositoryId: 1 }]]
  ]) {
    assert.equal(verifyConsumerOnboardingPackage(pkg, registry).reason, 'PACKAGE_INVALID');
  }

  assert.equal(verifyConsumerOnboardingPackage({ ...familyTreePkg, ownerAuthorized: false }).reason, 'ENROLLMENT_NOT_AUTHORIZED');
  assert.equal(verifyConsumerOnboardingPackage({ ...familyHubPkg, migrationFreezeClear: false }).reason, 'ENROLLMENT_NOT_AUTHORIZED');
  assert.equal(verifyConsumerOnboardingPackage({ ...familyTreePkg, autoActivate: true }).reason, 'ENROLLMENT_NOT_AUTHORIZED');
  assert.equal(verifyConsumerOnboardingPackage({ ...familyHubPkg, productionDeployEnabled: true }).reason, 'ENROLLMENT_NOT_AUTHORIZED');
  assert.equal(
    verifyConsumerOnboardingPackage({
      ...familyTreePkg,
      workflowPin: { ...familyTreePkg.workflowPin, uses: `${REUSABLE_WORKFLOW_PREFIX}main` }
    }).reason,
    'PIN_REF_NOT_IMMUTABLE_SHA'
  );
});

test('enforces valid non-factory disabled policy, 95/90 baseline floor and stricter local gates', () => {
  const withNonEnumToJson = target => {
    const copy = Array.isArray(target) ? [...target] : { ...target };
    Object.defineProperty(copy, 'toJSON', { value: () => [] });
    return copy;
  };
  for (const badPolicy of [
    null,
    { ...familyTreePkg.policy, coverage: withNonEnumToJson(familyTreePkg.policy.coverage) },
    { ...familyTreePkg.policy, checks: withNonEnumToJson(familyTreePkg.policy.checks) },
    { ...familyTreePkg.policy, checks: [withNonEnumToJson(familyTreePkg.policy.checks[0])] },
    { ...familyTreePkg.policy, reviewers: withNonEnumToJson(familyTreePkg.policy.reviewers) },
    { ...familyTreePkg.policy, owners: withNonEnumToJson(familyTreePkg.policy.owners) },
    { ...familyTreePkg.policy, owners: [withNonEnumToJson(familyTreePkg.policy.owners[0])] },
    { ...familyTreePkg.policy, riskClasses: withNonEnumToJson(familyTreePkg.policy.riskClasses) },
    { ...familyTreePkg.policy, checks: [] },
    { ...familyTreePkg.policy, repository: FACTORY_REPOSITORY, coverage: { line: 98, branch: 95 } }
  ]) {
    assert.equal(verifyConsumerOnboardingPackage({ ...familyTreePkg, policy: badPolicy }).reason, 'INVALID_CONSUMER_POLICY');
  }
  assert.equal(
    verifyConsumerOnboardingPackage({ ...familyTreePkg, repositoryId: FACTORY_REPOSITORY_ID }).reason,
    'INVALID_CONSUMER_POLICY'
  );

  assert.equal(
    verifyConsumerOnboardingPackage({
      ...familyTreePkg,
      policy: { ...familyTreePkg.policy, mode: 'shadow' }
    }).reason,
    'SHADOW_POSTURE_REQUIRED'
  );
  assert.equal(
    verifyConsumerOnboardingPackage({
      ...familyTreePkg,
      policy: { ...familyTreePkg.policy, killSwitch: false }
    }).reason,
    'SHADOW_POSTURE_REQUIRED'
  );

  assert.equal(
    verifyConsumerOnboardingPackage({
      ...familyTreePkg,
      policy: { ...familyTreePkg.policy, coverage: { line: 94, branch: 90 } }
    }).reason,
    'BASELINE_COVERAGE_BELOW_MINIMUM'
  );
  assert.equal(
    verifyConsumerOnboardingPackage({
      ...familyTreePkg,
      policy: { ...familyTreePkg.policy, coverage: { line: 95, branch: 89 } }
    }).reason,
    'BASELINE_COVERAGE_BELOW_MINIMUM'
  );

  for (const badGates of [
    null,
    { ...spellbookPkg.localGates, minLineCoverage: 101 },
    { ...spellbookPkg.localGates, minBranchCoverage: -1 },
    { ...spellbookPkg.localGates, maxConcurrency: 0 },
    { ...spellbookPkg.localGates, requiredChecks: 'bad' },
    { ...spellbookPkg.localGates, requiredChecks: [] },
    { ...spellbookPkg.localGates, requiredChecks: [{ name: '', appId: 1 }] },
    { ...spellbookPkg.localGates, requiredChecks: [{ name: 'ok', appId: 0 }] },
    { ...spellbookPkg.localGates, requiredChecks: [{ name: 'ok' }] },
    { ...spellbookPkg.localGates, requireExplicitApproval: 'true' },
    { ...spellbookPkg.localGates, requireStrictUpToDate: null }
  ]) {
    assert.equal(verifyConsumerOnboardingPackage({ ...spellbookPkg, localGates: badGates }).reason, 'LOCAL_GATES_INVALID');
  }

  // Stricter local gates cannot be weakened by consumer policy
  assert.equal(
    verifyConsumerOnboardingPackage({
      ...spellbookPkg,
      localGates: { ...spellbookPkg.localGates, requireExplicitApproval: false }
    }).reason,
    'LOCAL_GATE_WEAKENED'
  );
  assert.equal(
    verifyConsumerOnboardingPackage({
      ...spellbookPkg,
      localGates: { ...spellbookPkg.localGates, requireStrictUpToDate: false }
    }).reason,
    'LOCAL_GATE_WEAKENED'
  );
  assert.equal(
    verifyConsumerOnboardingPackage({
      ...spellbookPkg,
      policy: { ...spellbookPkg.policy, coverage: { line: 96, branch: 90 } }
    }).reason,
    'LOCAL_GATE_WEAKENED'
  );
  assert.equal(
    verifyConsumerOnboardingPackage({
      ...spellbookPkg,
      localGates: { ...spellbookPkg.localGates, minBranchCoverage: 95 }
    }).reason,
    'LOCAL_GATE_WEAKENED'
  );
  assert.equal(
    verifyConsumerOnboardingPackage({
      ...spellbookPkg,
      policy: { ...spellbookPkg.policy, maxActive: 3 }
    }).reason,
    'LOCAL_GATE_WEAKENED'
  );
  assert.equal(
    verifyConsumerOnboardingPackage({
      ...spellbookPkg,
      policy: { ...spellbookPkg.policy, checks: [spellbookPkg.policy.checks[0]] }
    }).reason,
    'LOCAL_GATE_WEAKENED'
  );
  assert.equal(
    verifyConsumerOnboardingPackage({
      ...spellbookPkg,
      localGates: {
        ...spellbookPkg.localGates,
        requiredChecks: [{ name: 'fictional-webkit-gate', appId: 99999 }]
      }
    }).reason,
    'LOCAL_GATE_WEAKENED'
  );
});

test('enforces per-repository credential isolation and blocks cross-repo secret reuse or duplicate enrollment', () => {
  for (const badCreds of [
    null,
    { ...familyTreePkg.credentials, credentialId: '' },
    { ...familyTreePkg.credentials, scope: 'shared-admin' },
    { ...familyTreePkg.credentials, sharedAdminToken: true },
    { ...familyTreePkg.credentials, persistedInCheckout: true },
    { ...familyTreePkg.credentials, allowedRepositories: 'example/family-tree' },
    { ...familyTreePkg.credentials, allowedRepositories: ['example/family-tree', 'example/spellbook'] },
    { ...familyTreePkg.credentials, allowedRepositories: [''] },
    { ...familyTreePkg.credentials, allowedRepositories: ['example/spellbook'] }
  ]) {
    assert.equal(
      verifyConsumerOnboardingPackage({ ...familyTreePkg, credentials: badCreds }).reason,
      'CREDENTIAL_ISOLATION_VIOLATION'
    );
  }

  assert.equal(
    verifyConsumerOnboardingPackage(familyTreePkg, [
      { repository: 'EXAMPLE/FAMILY-TREE', repositoryId: 777777, credentialId: 'cred-unique' }
    ]).reason,
    'DUPLICATE_CONSUMER'
  );
  assert.equal(
    verifyConsumerOnboardingPackage(familyTreePkg, [
      { repository: 'example/other', repositoryId: familyTreePkg.repositoryId, credentialId: 'cred-unique' }
    ]).reason,
    'DUPLICATE_CONSUMER'
  );
  assert.equal(
    verifyConsumerOnboardingPackage(spellbookPkg, [
      {
        repository: familyTreePkg.policy.repository,
        repositoryId: familyTreePkg.repositoryId,
        credentialId: spellbookPkg.credentials.credentialId.toUpperCase()
      }
    ]).reason,
    'CREDENTIAL_ISOLATION_VIOLATION'
  );
});

test('requires complete exact-mutation shadow denial replay suite and rollback contract', () => {
  const suite = familyTreePkg.replaySuite;
  const cand = suite.eligibleCandidate;

  // Null remainingCredits and accepted dependencies are valid in candidate/replay scenarios
  const candWithDep = { ...cand, dependencies: [{ issue: 1, accepted: true }] };
  assert.equal(
    verifyConsumerOnboardingPackage({
      ...familyTreePkg,
      replaySuite: {
        eligibleCandidate: candWithDep,
        staleReview: { ...candWithDep, reviews: suite.staleReview.reviews },
        dismissedReview: { ...candWithDep, reviews: suite.dismissedReview.reviews },
        commentedBotReview: { ...candWithDep, reviews: suite.commentedBotReview.reviews },
        wrongRepository: { ...candWithDep, repository: 'example/foreign-repository' },
        missingQuota: { ...candWithDep, remainingCredits: null },
        killSwitchPolicy: suite.killSwitchPolicy
      }
    }).valid,
    true
  );

  // Structurally valid candidate that fails shadow eligibility (mainHealthy: false)
  const unhealthyCand = { ...cand, mainHealthy: false };
  const unhealthyDerivedSuite = {
    eligibleCandidate: unhealthyCand,
    staleReview: { ...unhealthyCand, reviews: suite.staleReview.reviews },
    dismissedReview: { ...unhealthyCand, reviews: suite.dismissedReview.reviews },
    commentedBotReview: { ...unhealthyCand, reviews: suite.commentedBotReview.reviews },
    wrongRepository: { ...unhealthyCand, repository: 'example/foreign-repository' },
    missingQuota: { ...unhealthyCand, remainingCredits: 0 },
    killSwitchPolicy: suite.killSwitchPolicy
  };

  // Enumerable getters on nested snapshot fields must never be invoked during comparison
  let getterInvocations = 0;
  const baselineGetterCoverage = { ...cand.coverage };
  Object.defineProperty(baselineGetterCoverage, 'line', {
    enumerable: true,
    get: () => {
      getterInvocations += 1;
      return cand.coverage.line;
    }
  });
  const throwingGetterCoverage = { ...cand.coverage };
  Object.defineProperty(throwingGetterCoverage, 'line', {
    enumerable: true,
    get: () => {
      getterInvocations += 1;
      throw new Error('getter must not run');
    }
  });

  for (const badSuite of [
    null,
    unhealthyDerivedSuite,
    { ...suite, eligibleCandidate: null },
    { ...suite, eligibleCandidate: { ...cand, coverage: null } },
    { ...suite, eligibleCandidate: { ...cand, paths: 'bad' } },
    { ...suite, eligibleCandidate: { ...cand, dependencies: 'bad' } },
    { ...suite, eligibleCandidate: { ...cand, dependencies: [{}] } },
    { ...suite, eligibleCandidate: { ...cand, checks: 'bad' } },
    { ...suite, eligibleCandidate: { ...cand, checks: [{}] } },
    { ...suite, eligibleCandidate: { ...cand, reviews: 'bad' } },
    { ...suite, eligibleCandidate: { ...cand, reviews: [{}] } },
    { ...suite, killSwitchPolicy: { ...suite.killSwitchPolicy, extra: true } },
    { ...suite, killSwitchPolicy: { ...suite.killSwitchPolicy, killSwitch: false } },
    { ...suite, killSwitchPolicy: { ...familyTreePkg.policy, mode: 'disabled', killSwitch: false } },
    { ...suite, staleReview: cand },
    { ...suite, staleReview: suite.wrongRepository },
    { ...suite, staleReview: { ...cand, coverage: baselineGetterCoverage, reviews: suite.staleReview.reviews } },
    { ...suite, staleReview: { ...cand, coverage: throwingGetterCoverage, reviews: suite.staleReview.reviews } },
    { ...suite, staleReview: { ...cand, paths: 'not-array', reviews: suite.staleReview.reviews } },
    { ...suite, staleReview: { ...cand, paths: [], reviews: suite.staleReview.reviews } },
    { ...suite, staleReview: { ...cand, paths: ['src/other.ts'], reviews: suite.staleReview.reviews } },
    { ...suite, staleReview: { ...cand, issue: 99, reviews: [] } },
    { ...suite, staleReview: { ...cand, reviews: 'bad' } },
    { ...suite, staleReview: { ...cand, reviews: [] } },
    { ...suite, staleReview: { ...cand, reviews: [{}] } },
    { ...suite, staleReview: { ...cand, reviews: [{ reviewer: null, head: base, state: 'APPROVED' }] } },
    { ...suite, staleReview: { ...cand, reviews: [{ reviewer: 'synthetic-reviewer', head: base, state: 'DISMISSED' }] } },
    { ...suite, staleReview: { ...cand, reviews: [{ reviewer: 'synthetic-reviewer', head: 'bad', state: 'APPROVED' }] } },
    { ...suite, staleReview: { ...cand, reviews: [{ reviewer: 'untrusted-reviewer', head, state: 'APPROVED' }] } },
    { ...suite, dismissedReview: cand },
    { ...suite, dismissedReview: { ...cand, issue: 99, reviews: [] } },
    { ...suite, dismissedReview: { ...cand, reviews: 'bad' } },
    { ...suite, dismissedReview: { ...cand, reviews: [] } },
    { ...suite, dismissedReview: { ...cand, reviews: [{}] } },
    { ...suite, dismissedReview: { ...cand, reviews: [{ reviewer: 123, head, state: 'DISMISSED' }] } },
    { ...suite, dismissedReview: { ...cand, reviews: [{ reviewer: 'synthetic-reviewer', head: base, state: 'DISMISSED' }] } },
    { ...suite, dismissedReview: { ...cand, reviews: [{ reviewer: 'untrusted-reviewer', head, state: 'APPROVED' }] } },
    { ...suite, commentedBotReview: cand },
    { ...suite, commentedBotReview: { ...cand, issue: 99, reviews: [] } },
    { ...suite, commentedBotReview: { ...cand, reviews: 'bad' } },
    { ...suite, commentedBotReview: { ...cand, reviews: [] } },
    { ...suite, commentedBotReview: { ...cand, reviews: [{ reviewer: 'copilot-pull-request-reviewer[bot]', head, state: 'COMMENTED' }] } },
    { ...suite, commentedBotReview: { ...cand, reviews: [{ reviewer: null, head, state: 'COMMENTED', summaryDisposition: 'clear' }] } },
    { ...suite, commentedBotReview: { ...cand, reviews: [{ reviewer: 123, head, state: 'COMMENTED', summaryDisposition: 'clear' }] } },
    { ...suite, commentedBotReview: { ...cand, reviews: [{ reviewer: 'human-reviewer', head, state: 'COMMENTED', summaryDisposition: 'clear' }] } },
    { ...suite, commentedBotReview: { ...cand, reviews: [{ reviewer: 'copilot-pull-request-reviewer[bot]', head: base, state: 'COMMENTED', summaryDisposition: 'clear' }] } },
    { ...suite, commentedBotReview: { ...cand, reviews: [{ reviewer: 'copilot-pull-request-reviewer[bot]', head, state: 'DISMISSED', summaryDisposition: 'clear' }] } },
    { ...suite, commentedBotReview: { ...cand, reviews: [{ reviewer: 'copilot-pull-request-reviewer[bot]', head, state: 'COMMENTED', summaryDisposition: 'actionable' }] } },
    { ...suite, wrongRepository: cand },
    { ...suite, wrongRepository: null },
    { ...suite, wrongRepository: { ...cand, repository: '' } },
    { ...suite, wrongRepository: { ...cand, repository: 'invalid-slug' } },
    { ...suite, wrongRepository: { ...cand, repository: 'EXAMPLE/FAMILY-TREE' } },
    { ...suite, missingQuota: cand },
    { ...suite, missingQuota: { ...cand, activeCount: 1 } },
    { ...suite, missingQuota: { ...cand, remainingCredits: 500 } },
    { ...suite, missingQuota: { ...cand, remainingCredits: 'none' } }
  ]) {
    assert.equal(
      verifyConsumerOnboardingPackage({ ...familyTreePkg, replaySuite: badSuite }).reason,
      'SHADOW_REPLAY_INCOMPLETE'
    );
  }
  assert.equal(getterInvocations, 0);

  for (const badRollback of [
    null,
    { ...familyTreePkg.rollback, disableMode: 'shadow' },
    { ...familyTreePkg.rollback, killSwitch: false },
    { ...familyTreePkg.rollback, revokeCredentialId: 'cred-wrong' },
    { ...familyTreePkg.rollback, revertWorkflowPinPrRequired: false },
    { ...familyTreePkg.rollback, queuedLiveMutations: 1 }
  ]) {
    assert.equal(
      verifyConsumerOnboardingPackage({ ...familyTreePkg, rollback: badRollback }).reason,
      'ROLLBACK_INVALID'
    );
  }
});

test('verifyIndependentRollback proves single-repo rollback stops target without affecting peer consumers', () => {
  const cohort = [familyTreePkg, spellbookPkg, familyHubPkg];
  const receipt = {
    repository: 'example/spellbook',
    postPolicy: structuredClone(spellbookPkg.policy),
    revokedCredentialId: spellbookPkg.credentials.credentialId,
    pinRevertedViaReviewedPr: true,
    queuedLiveMutations: 0
  };

  const rolledBack = verifyIndependentRollback('Example/Spellbook', receipt, cohort);
  assert.deepEqual(rolledBack, {
    valid: true,
    reason: 'SINGLE_REPO_ROLLBACK_VERIFIED',
    shadow: true,
    liveActivation: false,
    targetDecision: 'STOPPED',
    stoppedRepository: 'example/spellbook',
    unaffectedPeers: ['example/family-tree', 'example/family-hub']
  });

  for (const [target, badReceipt, badPackages] of [
    ['', receipt, cohort],
    ['example/spellbook', null, cohort],
    ['example/spellbook', { ...receipt, repository: '' }, cohort],
    ['example/spellbook', { ...receipt, repository: 'example/family-tree' }, cohort],
    ['example/spellbook', receipt, 'not-array'],
    ['example/spellbook', receipt, [spellbookPkg]]
  ]) {
    assert.equal(verifyIndependentRollback(target, badReceipt, badPackages).reason, 'ROLLBACK_INPUT_INVALID');
  }

  const sharedCredPeer = {
    ...spellbookPkg,
    credentials: { ...spellbookPkg.credentials, credentialId: familyTreePkg.credentials.credentialId },
    rollback: { ...spellbookPkg.rollback, revokeCredentialId: familyTreePkg.credentials.credentialId }
  };
  assert.equal(verifyIndependentRollback('example/spellbook', receipt, [familyTreePkg, sharedCredPeer]).reason, 'INVALID_PACKAGE_SET');

  const unknownReceipt = { ...receipt, repository: 'example/unknown-repo' };
  assert.equal(verifyIndependentRollback('example/unknown-repo', unknownReceipt, cohort).reason, 'ROLLBACK_TARGET_UNKNOWN');

  for (const incomplete of [
    { ...receipt, postPolicy: null },
    { ...receipt, postPolicy: { ...familyTreePkg.policy } },
    { ...receipt, postPolicy: { ...spellbookPkg.policy, mode: 'shadow' } },
    { ...receipt, postPolicy: { ...spellbookPkg.policy, killSwitch: false } },
    { ...receipt, revokedCredentialId: 'cred-other' },
    { ...receipt, pinRevertedViaReviewedPr: false },
    { ...receipt, queuedLiveMutations: 2 }
  ]) {
    assert.equal(verifyIndependentRollback('example/spellbook', incomplete, cohort).reason, 'TARGET_ROLLBACK_INCOMPLETE');
  }
});

test('planConsumerBootstrap creates dry-run pinned plans, preserves stricter gates, reruns idempotently and refuses overwrites', () => {
  const baseRequest = {
    repository: 'example/new-consumer',
    repositoryId: 900404,
    workflowPin: familyTreePkg.workflowPin,
    checks: [{ name: 'ci-gate', appId: 45678 }],
    owners: [{ prefix: 'src/', owner: 'synthetic-owner' }],
    reviewers: ['synthetic-reviewer'],
    existingState: {
      defaultBranch: 'main',
      mergeMethod: 'squash',
      lineCoverageGate: 0,
      branchCoverageGate: 0,
      maxConcurrency: 1,
      existingFiles: []
    }
  };

  const blankPlan = planConsumerBootstrap(baseRequest);
  assert.equal(blankPlan.valid, true);
  assert.equal(blankPlan.reason, 'DRY_RUN_PLAN_READY');
  assert.equal(blankPlan.dryRun, true);
  assert.equal(blankPlan.mutatesGitHub, false);
  assert.equal(blankPlan.reviewablePrRequired, true);
  assert.equal(blankPlan.idempotentNoOp, false);
  assert.equal(blankPlan.pinnedWorkflowSha, reviewedWorkflowSha);
  assert.equal(blankPlan.pinnedCheckoutSha, reviewedCheckoutSha);
  assert.deepEqual(blankPlan.policy.coverage, { line: 95, branch: 90 });
  assert.equal(blankPlan.policy.mode, 'disabled');
  assert.equal(blankPlan.policy.killSwitch, true);
  assert.equal(blankPlan.filesToWrite.length, 2);

  // Mismatched workflow vs shadow-tests.yml checkout SHA fails closed in bootstrap
  assert.equal(
    planConsumerBootstrap({
      ...baseRequest,
      workflowPin: { ...familyTreePkg.workflowPin, reviewedCheckoutSha: reviewedWorkflowSha }
    }).reason,
    'PIN_SHA_MISMATCH'
  );

  // Partial match writes only missing file; full match is idempotent no-op
  const partialPlan = planConsumerBootstrap({
    ...baseRequest,
    existingState: {
      ...baseRequest.existingState,
      lineCoverageGate: 97,
      branchCoverageGate: 92,
      maxConcurrency: 2,
      existingFiles: [blankPlan.filesToWrite[0]]
    }
  });
  assert.equal(partialPlan.valid, true);
  assert.equal(partialPlan.reason, 'DRY_RUN_PLAN_READY');
  assert.deepEqual(partialPlan.policy.coverage, { line: 97, branch: 92 });
  assert.equal(partialPlan.policy.maxActive, 2);
  assert.equal(partialPlan.filesToWrite.length, 1);

  const rerunPlan = planConsumerBootstrap({
    ...baseRequest,
    existingState: {
      ...baseRequest.existingState,
      existingFiles: [...blankPlan.filesToWrite]
    }
  });
  assert.equal(rerunPlan.valid, true);
  assert.equal(rerunPlan.reason, 'IDEMPOTENT_NOOP');
  assert.equal(rerunPlan.idempotentNoOp, true);
  assert.equal(rerunPlan.filesToWrite.length, 0);

  const conflictPlan = planConsumerBootstrap({
    ...baseRequest,
    existingState: {
      ...baseRequest.existingState,
      existingFiles: [{ path: '.github/softwarefactory-policy.json', content: '{"custom":true}\n' }]
    }
  });
  assert.equal(conflictPlan.valid, false);
  assert.equal(conflictPlan.reason, 'EXISTING_FILE_CONFLICT');
  assert.deepEqual(conflictPlan.conflicts, ['.github/softwarefactory-policy.json']);

  // Case-variant existing path is also flagged as a conflict
  const caseConflictPlan = planConsumerBootstrap({
    ...baseRequest,
    existingState: {
      ...baseRequest.existingState,
      existingFiles: [{ path: '.GITHUB/softwarefactory-policy.json', content: blankPlan.filesToWrite[1].content }]
    }
  });
  assert.equal(caseConflictPlan.valid, false);
  assert.equal(caseConflictPlan.reason, 'EXISTING_FILE_CONFLICT');

  // Descendant collision: planned file path is already a directory in existingFiles
  const descendantConflictPlan = planConsumerBootstrap({
    ...baseRequest,
    existingState: {
      ...baseRequest.existingState,
      existingFiles: [{ path: '.github/softwarefactory-policy.json/README.md', content: '# dir\n' }]
    }
  });
  assert.equal(descendantConflictPlan.valid, false);
  assert.equal(descendantConflictPlan.reason, 'EXISTING_FILE_CONFLICT');
  assert.deepEqual(descendantConflictPlan.conflicts, ['.github/softwarefactory-policy.json']);

  // Multiple sibling descendants under planned file path also collide cleanly
  const multiDescendantPlan = planConsumerBootstrap({
    ...baseRequest,
    existingState: {
      ...baseRequest.existingState,
      existingFiles: [
        { path: '.github/softwarefactory-policy.json/a.md', content: 'a' },
        { path: '.github/softwarefactory-policy.json/b.md', content: 'b' }
      ]
    }
  });
  assert.equal(multiDescendantPlan.valid, false);
  assert.equal(multiDescendantPlan.reason, 'EXISTING_FILE_CONFLICT');

  // Ancestor collision: an existing file blocks creating a parent directory for the workflow
  const ancestorConflictPlan = planConsumerBootstrap({
    ...baseRequest,
    existingState: {
      ...baseRequest.existingState,
      existingFiles: [{ path: '.github/workflows', content: 'regular-file\n' }]
    }
  });
  assert.equal(ancestorConflictPlan.valid, false);
  assert.equal(ancestorConflictPlan.reason, 'EXISTING_FILE_CONFLICT');
  assert.deepEqual(ancestorConflictPlan.conflicts, ['.github/workflows/softwarefactory-shadow-replay.yml']);

  // Matching record followed by divergent duplicate path fails closed instead of IDEMPOTENT_NOOP
  const duplicatePathPlan = planConsumerBootstrap({
    ...baseRequest,
    existingState: {
      ...baseRequest.existingState,
      existingFiles: [
        blankPlan.filesToWrite[0],
        blankPlan.filesToWrite[1],
        { path: '.github/softwarefactory-policy.json', content: '{"divergent":true}\n' }
      ]
    }
  });
  assert.equal(duplicatePathPlan.valid, false);
  assert.equal(duplicatePathPlan.reason, 'EXISTING_STATE_INVALID');

  for (const badReq of [
    null,
    { ...baseRequest, repository: '' },
    { ...baseRequest, repository: 'invalid-slug' },
    { ...baseRequest, repository: 'jamula/softwarefactory' },
    { ...baseRequest, repositoryId: 0 },
    { ...baseRequest, repositoryId: FACTORY_REPOSITORY_ID }
  ]) {
    assert.equal(planConsumerBootstrap(badReq).reason, 'BOOTSTRAP_REQUEST_INVALID');
  }

  for (const badState of [
    null,
    { ...baseRequest.existingState, lineCoverageGate: -1 },
    { ...baseRequest.existingState, branchCoverageGate: 105 },
    { ...baseRequest.existingState, maxConcurrency: 0 },
    { ...baseRequest.existingState, existingFiles: 'bad' },
    { ...baseRequest.existingState, existingFiles: [{ path: '', content: 'x' }] },
    { ...baseRequest.existingState, existingFiles: [{ path: '/abs/file.yml', content: 'x' }] },
    { ...baseRequest.existingState, existingFiles: [{ path: 'dir\\file.yml', content: 'x' }] },
    { ...baseRequest.existingState, existingFiles: [{ path: 'dir/../file.yml', content: 'x' }] },
    { ...baseRequest.existingState, existingFiles: [{ path: 'dir//file.yml', content: 'x' }] },
    { ...baseRequest.existingState, existingFiles: [{ path: 'a.yml', content: 123 }] },
    { ...baseRequest.existingState, existingFiles: [{ path: 'a.yml' }] },
    { ...baseRequest.existingState, existingFiles: [{ path: 'a.yml', content: '1' }, { path: 'A.YML', content: '2' }] }
  ]) {
    assert.equal(planConsumerBootstrap({ ...baseRequest, existingState: badState }).reason, 'EXISTING_STATE_INVALID');
  }

  // Rejects non-enumerable toJSON hooks on checks, owners and reviewers without invoking them
  let hookCalls = 0;
  const hookedChecks = [{ name: 'ci-gate', appId: 45678 }];
  Object.defineProperty(hookedChecks, 'toJSON', { value: () => { hookCalls += 1; return []; } });
  const hookedOwners = [{ prefix: 'src/', owner: 'synthetic-owner' }];
  Object.defineProperty(hookedOwners, 'toJSON', { value: () => { hookCalls += 1; return []; } });
  const hookedReviewers = ['synthetic-reviewer'];
  Object.defineProperty(hookedReviewers, 'toJSON', { value: () => { hookCalls += 1; return []; } });

  for (const badPolicyReq of [
    { ...baseRequest, checks: [] },
    { ...baseRequest, checks: hookedChecks },
    { ...baseRequest, owners: hookedOwners },
    { ...baseRequest, reviewers: hookedReviewers }
  ]) {
    assert.equal(planConsumerBootstrap(badPolicyReq).reason, 'BOOTSTRAP_POLICY_INVALID');
  }
  assert.equal(hookCalls, 0);
});
