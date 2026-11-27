import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CONSUMER_BASELINE_COVERAGE,
  CONSUMER_COMPONENT_CATALOG,
  CONSUMER_CONTRACT_VERSION,
  FACTORY_REPOSITORY,
  FACTORY_REPOSITORY_ID,
  MANDATORY_ONBOARDING_SETTINGS,
  MAX_MANDATORY_USER_SETTINGS,
  ONBOARDING_DISCOVERY_MODES,
  ONBOARDING_STACK_PROFILES,
  OPTIONAL_ONBOARDING_SETTINGS,
  REUSABLE_WORKFLOW_PREFIX,
  buildReadOnlyOnboardingPlan,
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

  // Enumerable getters on nested snapshot fields (candidate OR expected side) must never be invoked
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
  const throwingExpectedPriority = {};
  Object.defineProperty(throwingExpectedPriority, 'bad', {
    enumerable: true,
    get: () => {
      getterInvocations += 1;
      throw new Error('expected-side getter must not run');
    }
  });
  const throwingExpectedArray = [1];
  Object.defineProperty(throwingExpectedArray, 0, {
    enumerable: true,
    get: () => {
      getterInvocations += 1;
      throw new Error('expected-side array getter must not run');
    }
  });
  const proxyExpectedPriority = new Proxy(
    { bad: 1 },
    {
      get() {
        getterInvocations += 1;
        throw new Error('expected-side proxy trap must not run');
      }
    }
  );
  const symbolExpectedPriority = { [Symbol('meta')]: 1 };
  const revokedObjProxy = Proxy.revocable({ bad: 1 }, {});
  revokedObjProxy.revoke();
  const revokedArrProxy = Proxy.revocable([1], {});
  revokedArrProxy.revoke();
  const cyclicPriority = {};
  cyclicPriority.self = cyclicPriority;

  const makeExpectedPrioritySuite = (expectedPriority, candidatePriority) => {
    const baseCand = { ...cand, priority: expectedPriority };
    return {
      eligibleCandidate: baseCand,
      staleReview: { ...baseCand, priority: candidatePriority, reviews: suite.staleReview.reviews },
      dismissedReview: { ...baseCand, priority: candidatePriority, reviews: suite.dismissedReview.reviews },
      commentedBotReview: { ...baseCand, priority: candidatePriority, reviews: suite.commentedBotReview.reviews },
      wrongRepository: { ...baseCand, priority: candidatePriority, repository: 'example/foreign-repository' },
      missingQuota: { ...baseCand, priority: candidatePriority, remainingCredits: 0 },
      killSwitchPolicy: suite.killSwitchPolicy
    };
  };

  for (const badSuite of [
    null,
    unhealthyDerivedSuite,
    makeExpectedPrioritySuite(throwingExpectedPriority, { bad: 1 }),
    makeExpectedPrioritySuite(throwingExpectedArray, [1]),
    makeExpectedPrioritySuite(proxyExpectedPriority, { bad: 1 }),
    makeExpectedPrioritySuite(revokedObjProxy.proxy, { bad: 1 }),
    makeExpectedPrioritySuite(revokedArrProxy.proxy, [1]),
    makeExpectedPrioritySuite({ bad: 1 }, revokedObjProxy.proxy),
    makeExpectedPrioritySuite([1], revokedArrProxy.proxy),
    makeExpectedPrioritySuite(Object.create(null), {}),
    makeExpectedPrioritySuite(symbolExpectedPriority, {}),
    makeExpectedPrioritySuite(cyclicPriority, cyclicPriority),
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

  const nonEnumerableVersionPolicy = structuredClone(spellbookPkg.policy);
  Object.defineProperty(nonEnumerableVersionPolicy, 'version', {
    value: 1,
    enumerable: false,
    writable: true,
    configurable: true
  });

  for (const incomplete of [
    { ...receipt, postPolicy: null },
    { ...receipt, postPolicy: nonEnumerableVersionPolicy },
    { ...receipt, postPolicy: { ...familyTreePkg.policy } },
    { ...receipt, postPolicy: { ...spellbookPkg.policy, mode: 'shadow' } },
    { ...receipt, postPolicy: { ...spellbookPkg.policy, killSwitch: false } },
    { ...receipt, postPolicy: { ...spellbookPkg.policy, coverage: { line: 0, branch: 0 } } },
    { ...receipt, postPolicy: { ...spellbookPkg.policy, maxActive: 8 } },
    { ...receipt, postPolicy: { ...spellbookPkg.policy, checks: [spellbookPkg.policy.checks[0]] } },
    { ...receipt, revokedCredentialId: 'cred-other' },
    { ...receipt, pinRevertedViaReviewedPr: false },
    { ...receipt, queuedLiveMutations: 2 },
    { ...receipt, queuedLiveMutations: -0 }
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

test('buildReadOnlyOnboardingPlan plans greenfield and existing-repository onboarding from <=5 mandatory settings with independent rollback', () => {
  assert.equal(MAX_MANDATORY_USER_SETTINGS, 5);
  assert.equal(Object.isFrozen(ONBOARDING_DISCOVERY_MODES), true);
  assert.equal(Object.isFrozen(MANDATORY_ONBOARDING_SETTINGS), true);
  assert.equal(Object.isFrozen(OPTIONAL_ONBOARDING_SETTINGS), true);
  assert.equal(Object.isFrozen(ONBOARDING_STACK_PROFILES), true);
  assert.deepEqual(ONBOARDING_DISCOVERY_MODES, ['greenfield', 'existing-repository']);
  assert.deepEqual(MANDATORY_ONBOARDING_SETTINGS, [
    'repository',
    'repositoryId',
    'pinnedFactorySha',
    'stackProfile'
  ]);

  // Greenfield onboarding from just 4 mandatory settings (<= 5 ceiling)
  const greenfieldStart = performance.now();
  const greenfieldPlan = buildReadOnlyOnboardingPlan({
    repository: 'example/greenfield-app',
    repositoryId: 900501,
    pinnedFactorySha: reviewedWorkflowSha,
    pinnedCheckoutSha: reviewedCheckoutSha,
    stackProfile: 'baseline-95-90'
  });
  const greenfieldElapsedMs = performance.now() - greenfieldStart;
  assert.ok(greenfieldElapsedMs < 5_000);

  assert.equal(greenfieldPlan.valid, true);
  assert.equal(greenfieldPlan.reason, 'READ_ONLY_ONBOARDING_PLAN_READY');
  assert.equal(greenfieldPlan.mode, 'greenfield');
  assert.equal(greenfieldPlan.shadow, true);
  assert.equal(greenfieldPlan.readOnly, true);
  assert.equal(greenfieldPlan.dryRun, true);
  assert.equal(greenfieldPlan.defaultEnabled, false);
  assert.equal(greenfieldPlan.implicitActivation, false);
  assert.equal(greenfieldPlan.overwriteExistingFiles, false);
  assert.equal(greenfieldPlan.liveActivation, false);
  assert.equal(greenfieldPlan.productionDeployEnabled, false);
  assert.equal(greenfieldPlan.mutatesGitHub, false);
  assert.equal(greenfieldPlan.liveMutations, 0);
  assert.equal(greenfieldPlan.deployments, 0);
  assert.equal(greenfieldPlan.incrementalSpendUsd, 0);
  assert.equal(greenfieldPlan.reviewablePrRequired, true);
  assert.equal(greenfieldPlan.mandatorySettings.maxAllowed, 5);
  assert.equal(greenfieldPlan.mandatorySettings.requiredCount, 4);
  assert.equal(greenfieldPlan.mandatorySettings.suppliedCount, 4);
  assert.deepEqual(greenfieldPlan.mandatorySettings.keys, [
    'repository',
    'repositoryId',
    'pinnedFactorySha',
    'stackProfile'
  ]);
  assert.deepEqual(greenfieldPlan.policy.coverage, { line: 95, branch: 90 });
  assert.equal(greenfieldPlan.policy.mode, 'disabled');
  assert.equal(greenfieldPlan.policy.killSwitch, true);
  assert.equal(greenfieldPlan.executionOptions.copilotCloudAutomationsSupported, true);
  assert.equal(greenfieldPlan.killSwitch.defaultTrippedAtRest, true);
  assert.equal(greenfieldPlan.killSwitch.sharedWithPeers, false);
  assert.equal(greenfieldPlan.rollbackPlan.strategy, 'single-commit-revert');
  assert.equal(greenfieldPlan.rollbackPlan.commitsToRevert, 1);
  assert.equal(greenfieldPlan.rollbackPlan.singleCommitRevert, true);
  assert.equal(greenfieldPlan.plannedFiles.length, 2);
  assert.equal(verifyWorkflowPin(greenfieldPlan.workflowPin).valid, true);

  // Pure repeatability & public repository execution options + explicit 5th stricterCoverageThresholds setting
  const repeatGreenfield = buildReadOnlyOnboardingPlan({
    repository: 'example/greenfield-app',
    repositoryId: 900501,
    pinnedFactorySha: reviewedWorkflowSha,
    pinnedCheckoutSha: reviewedCheckoutSha,
    stackProfile: 'baseline-95-90'
  });
  assert.deepEqual(repeatGreenfield, greenfieldPlan);

  const publicGreenfield = buildReadOnlyOnboardingPlan({
    mode: 'greenfield',
    repository: 'example/public-greenfield',
    repositoryId: 900502,
    pinnedFactorySha: reviewedWorkflowSha,
    stackProfile: 'web-genealogy-95-90',
    stricterCoverageThresholds: { line: 98, branch: 94 },
    mandatorySettings: [
      'repository',
      'repositoryId',
      'pinnedFactorySha',
      'stackProfile',
      'stricterCoverageThresholds'
    ],
    defaultEnabled: false,
    implicitActivation: false,
    overwriteExistingFiles: false,
    visibility: 'public',
    unsupportedResources: [],
    existingFiles: []
  });
  assert.equal(publicGreenfield.valid, true);
  assert.equal(publicGreenfield.mandatorySettings.requiredCount, 5);
  assert.equal(publicGreenfield.mandatorySettings.suppliedCount, 5);
  assert.deepEqual(publicGreenfield.policy.coverage, { line: 98, branch: 94 });
  assert.equal(publicGreenfield.workflowPin.reviewedCheckoutSha, reviewedWorkflowSha);
  assert.equal(publicGreenfield.executionOptions.copilotCloudAgentSupported, true);
  assert.equal(publicGreenfield.executionOptions.copilotCloudAutomationsSupported, false);

  // Existing-repository mode preserves Spellbook 97/90, FamilyHub trunk/100/100, and custom stricter discovered gates
  const mutableChecks = [
    { name: 'fictional-webkit-gate', appId: 34567 },
    { name: 'fictional-ios-gate', appId: 34568 }
  ];
  const mutableOwners = [
    { prefix: 'ios/', owner: 'synthetic-ios-owner' },
    { prefix: 'src/', owner: 'synthetic-spellbook-owner' }
  ];
  const mutableReviewers = ['synthetic-spellbook-reviewer'];

  const existingStart = performance.now();
  const spellbookPlan = buildReadOnlyOnboardingPlan({
    mode: 'existing-repository',
    repository: 'example/spellbook',
    repositoryId: 900202,
    pinnedFactorySha: reviewedWorkflowSha,
    pinnedCheckoutSha: reviewedCheckoutSha,
    stackProfile: 'ios-webkit-97-90',
    discoveredRepository: {
      defaultBranch: 'main',
      mergeMethod: 'squash',
      checks: mutableChecks,
      reviewers: mutableReviewers,
      owners: mutableOwners,
      coverage: { line: 97, branch: 90 },
      maxConcurrency: 1,
      requireExplicitApproval: true,
      requireStrictUpToDate: true,
      allowCommentedBotApproval: false,
      migrationFreezeClear: true,
      visibility: 'internal',
      existingFiles: [
        '.github/workflows/ios-ci.yml',
        { path: 'src/bridge.ts', content: 'export const ok = true;\n' }
      ]
    }
  });
  const existingElapsedMs = performance.now() - existingStart;
  assert.ok(existingElapsedMs < 5_000);

  // Mutating caller arrays after planning cannot alter the frozen plan
  mutableChecks[0].appId = 99999;
  mutableOwners[0].prefix = 'mutated/';
  mutableReviewers.push('attacker');

  assert.equal(spellbookPlan.valid, true);
  assert.equal(spellbookPlan.mode, 'existing-repository');
  assert.deepEqual(spellbookPlan.policy.coverage, { line: 97, branch: 90 });
  assert.equal(spellbookPlan.policy.maxActive, 1);
  assert.equal(spellbookPlan.localGates.maxConcurrency, 1);
  assert.equal(spellbookPlan.policy.checks[0].appId, 34567);
  assert.equal(spellbookPlan.policy.owners[0].prefix, 'ios/');
  assert.equal(spellbookPlan.policy.reviewers.length, 1);
  assert.equal(spellbookPlan.reviewPolicy.formalApprovedReviewRequired, true);
  assert.equal(spellbookPlan.reviewPolicy.allowCommentedBotApproval, false);
  assert.equal(spellbookPlan.executionOptions.copilotCloudAutomationsSupported, true);

  // Inferred existing-repository mode when discoveredRepository is provided and mode omitted
  const hubPlan = buildReadOnlyOnboardingPlan({
    repository: 'example/family-hub',
    repositoryId: 900303,
    pinnedFactorySha: reviewedWorkflowSha,
    pinnedCheckoutSha: reviewedCheckoutSha,
    stackProfile: 'strict-up-to-date-migration-gated',
    discoveredRepository: {
      coverage: { line: 96, branch: 92 }
    }
  });
  assert.equal(hubPlan.valid, true);
  assert.equal(hubPlan.mode, 'existing-repository');
  assert.equal(hubPlan.policy.defaultBranch, 'trunk');
  assert.equal(hubPlan.policy.mergeMethod, 'merge');
  assert.deepEqual(hubPlan.policy.coverage, { line: 100, branch: 100 });

  // End-to-end integration: generated read-only plans satisfy verifyConsumerOnboardingPackage & verifyIndependentRollback
  const toVerifiedPackage = plan => ({
    contractVersion: plan.contractVersion,
    repositoryId: plan.repositoryId,
    stackProfile: plan.stackProfile,
    ownerAuthorized: true,
    migrationFreezeClear: true,
    autoActivate: plan.implicitActivation,
    productionDeployEnabled: plan.productionDeployEnabled,
    workflowPin: plan.workflowPin,
    policy: structuredClone(plan.policy),
    localGates: structuredClone(plan.localGates),
    credentials: {
      credentialId: plan.rollbackPlan.revokeCredentialId,
      scope: 'repo-read-only-shadow',
      allowedRepositories: [plan.repository],
      sharedAdminToken: false,
      persistedInCheckout: false
    },
    replaySuite: makeReplaySuite(plan.policy),
    rollback: {
      disableMode: plan.rollbackPlan.disableMode,
      killSwitch: plan.rollbackPlan.killSwitch,
      revokeCredentialId: plan.rollbackPlan.revokeCredentialId,
      revertWorkflowPinPrRequired: plan.rollbackPlan.revertWorkflowPinPrRequired,
      queuedLiveMutations: plan.rollbackPlan.queuedLiveMutations
    }
  });

  const greenfieldPkg = toVerifiedPackage(greenfieldPlan);
  const spellbookPlannedPkg = toVerifiedPackage(spellbookPlan);
  assert.equal(verifyConsumerOnboardingPackage(greenfieldPkg).valid, true);
  assert.equal(
    verifyConsumerOnboardingPackage(spellbookPlannedPkg, [
      {
        repository: greenfieldPkg.policy.repository,
        repositoryId: greenfieldPkg.repositoryId,
        credentialId: greenfieldPkg.credentials.credentialId
      }
    ]).valid,
    true
  );

  const rollbackOutcome = verifyIndependentRollback(
    'example/spellbook',
    {
      repository: 'example/spellbook',
      postPolicy: structuredClone(spellbookPlan.policy),
      revokedCredentialId: spellbookPlan.rollbackPlan.revokeCredentialId,
      pinRevertedViaReviewedPr: true,
      queuedLiveMutations: 0
    },
    [greenfieldPkg, spellbookPlannedPkg]
  );
  assert.equal(rollbackOutcome.valid, true);
  assert.equal(rollbackOutcome.targetDecision, 'STOPPED');
  assert.deepEqual(rollbackOutcome.unaffectedPeers, ['example/greenfield-app']);
});

test('buildReadOnlyOnboardingPlan fails closed on >5 mandatory settings, unsafe flags, proxy/getter tricks, gate weakening and file collisions', () => {
  const validMinimal = {
    repository: 'example/consumer-one',
    repositoryId: 900601,
    pinnedFactorySha: reviewedWorkflowSha,
    stackProfile: 'web-genealogy-95-90'
  };
  const validPlan = buildReadOnlyOnboardingPlan(validMinimal);
  assert.equal(validPlan.valid, true);

  // > 5 mandatory inputs fails closed
  const tooManyMandatory = buildReadOnlyOnboardingPlan({
    ...validMinimal,
    stricterCoverageThresholds: { line: 96, branch: 91 },
    mandatorySettings: [
      'repository',
      'repositoryId',
      'pinnedFactorySha',
      'stackProfile',
      'stricterCoverageThresholds',
      'customManualDatabaseUrl'
    ]
  });
  assert.equal(tooManyMandatory.valid, false);
  assert.equal(tooManyMandatory.reason, 'MANDATORY_SETTINGS_LIMIT_EXCEEDED');
  assert.equal(tooManyMandatory.defaultEnabled, false);
  assert.equal(tooManyMandatory.implicitActivation, false);
  assert.equal(tooManyMandatory.overwriteExistingFiles, false);
  assert.equal(tooManyMandatory.liveMutations, 0);
  assert.equal(tooManyMandatory.deployments, 0);

  // Unsafe read-only discovery default overrides fail closed
  for (const unsafeFlag of [
    { defaultEnabled: true },
    { implicitActivation: true },
    { overwriteExistingFiles: true }
  ]) {
    assert.equal(
      buildReadOnlyOnboardingPlan({ ...validMinimal, ...unsafeFlag }).reason,
      'UNSAFE_DISCOVERY_DEFAULTS'
    );
  }

  // Rejects ANY collision with existing consumer files (even identical content, case-variant, ancestor, or descendant)
  for (const collidingFiles of [
    [validPlan.plannedFiles[0]],
    [validPlan.plannedFiles[1]],
    ['.github/softwarefactory-policy.json'],
    ['.GITHUB/workflows/softwarefactory-shadow-replay.yml'],
    ['.github/workflows'],
    ['.github/softwarefactory-policy.json/nested.txt']
  ]) {
    const topCollision = buildReadOnlyOnboardingPlan({
      ...validMinimal,
      existingFiles: collidingFiles
    });
    assert.equal(topCollision.valid, false);
    assert.equal(topCollision.reason, 'EXISTING_FILE_CONFLICT');
    assert.ok(topCollision.conflicts.length >= 1);

    const discoveredCollision = buildReadOnlyOnboardingPlan({
      ...validMinimal,
      mode: 'existing-repository',
      discoveredRepository: { existingFiles: collidingFiles }
    });
    assert.equal(discoveredCollision.valid, false);
    assert.equal(discoveredCollision.reason, 'EXISTING_FILE_CONFLICT');
  }

  // Proxy, revoked proxy, own-data-descriptor, and Object.prototype getter traps never execute
  let traps = 0;
  const failTrap = () => {
    traps += 1;
    throw new Error('unexpected trap or getter');
  };
  const trapHandler = {
    get: failTrap,
    has: failTrap,
    ownKeys: failTrap,
    getPrototypeOf: failTrap,
    getOwnPropertyDescriptor: failTrap
  };
  const revokedObj = Proxy.revocable({ ...validMinimal }, {});
  revokedObj.revoke();
  const revokedArr = Proxy.revocable(['src/a.ts'], {});
  revokedArr.revoke();

  const getterInput = { ...validMinimal };
  Object.defineProperty(getterInput, 'repository', { enumerable: true, get: failTrap });
  const nonEnumInput = { ...validMinimal };
  Object.defineProperty(nonEnumInput, 'toJSON', { value: failTrap });
  const symInput = { ...validMinimal, [Symbol('tag')]: 1 };

  for (const badInput of [
    null,
    undefined,
    'string',
    [],
    Object.create(null),
    new Proxy({ ...validMinimal }, trapHandler),
    revokedObj.proxy,
    getterInput,
    nonEnumInput,
    symInput,
    { ...validMinimal, extraUnknownKey: 1 },
    { ...validMinimal, defaultEnabled: 'false' },
    { ...validMinimal, implicitActivation: 0 },
    { ...validMinimal, overwriteExistingFiles: null },
    { ...validMinimal, mandatorySettings: 'bad' },
    { ...validMinimal, mandatorySettings: ['repository', 'repository', 'repositoryId', 'pinnedFactorySha'] },
    { ...validMinimal, mandatorySettings: ['repository', 'repositoryId', 'pinnedFactorySha'] },
    { ...validMinimal, mandatorySettings: ['repository', 'repositoryId', 'pinnedFactorySha', 'stackProfile', 'stricterCoverageThresholds'] },
    { ...validMinimal, mandatorySettings: ['repository', 'repositoryId', 'pinnedFactorySha', 'stackProfile', 'unknownSetting'] },
    { repositoryId: 1, pinnedFactorySha: reviewedWorkflowSha, stackProfile: 'baseline-95-90' },
    { ...validMinimal, repository: 'invalid-slug' },
    { ...validMinimal, repository: '../escape' },
    { ...validMinimal, repository: 'owner/..' },
    { ...validMinimal, repositoryId: 0 },
    { ...validMinimal, pinnedFactorySha: 123 },
    { ...validMinimal, pinnedCheckoutSha: 123 },
    { ...validMinimal, stackProfile: '' },
    { ...validMinimal, mode: 'live' },
    { ...validMinimal, visibility: 'world-writable' },
    { ...validMinimal, unsupportedResources: 'bad' },
    { ...validMinimal, unsupportedResources: [''] },
    { ...validMinimal, unsupportedResources: ['dup', 'dup'] },
    { ...validMinimal, stricterCoverageThresholds: new Proxy({ line: 96, branch: 92 }, trapHandler) },
    { ...validMinimal, stricterCoverageThresholds: { line: 96 } },
    { ...validMinimal, stricterCoverageThresholds: { line: 101, branch: 90 } },
    { ...validMinimal, stricterCoverageThresholds: { line: 96, branch: -1 } },
    {
      ...validMinimal,
      mode: 'existing-repository',
      existingFiles: ['src/a.ts'],
      discoveredRepository: { existingFiles: ['src/b.ts'] }
    },
    {
      ...validMinimal,
      mode: 'existing-repository',
      visibility: 'public',
      discoveredRepository: { visibility: 'private' }
    }
  ]) {
    assert.equal(buildReadOnlyOnboardingPlan(badInput).reason, 'DISCOVERY_INPUT_INVALID');
  }

  try {
    for (const protoProp of [
      'mode',
      'visibility',
      'discoveredRepository',
      'stricterCoverageThresholds',
      'existingFiles',
      'pinnedCheckoutSha',
      'mandatorySettings',
      'unsupportedResources'
    ]) {
      Object.defineProperty(Object.prototype, protoProp, { get: failTrap, configurable: true });
    }
    assert.equal(buildReadOnlyOnboardingPlan(validMinimal).valid, true);
  } finally {
    for (const protoProp of [
      'mode',
      'visibility',
      'discoveredRepository',
      'stricterCoverageThresholds',
      'existingFiles',
      'pinnedCheckoutSha',
      'mandatorySettings',
      'unsupportedResources'
    ]) {
      delete Object.prototype[protoProp];
    }
  }

  // Factory self-enrollment, mutable SHA refs, unknown stack profiles, mode mismatch, and unsupported resources
  assert.equal(
    buildReadOnlyOnboardingPlan({ ...validMinimal, repository: 'jamula/softwarefactory' }).reason,
    'INVALID_CONSUMER_POLICY'
  );
  assert.equal(
    buildReadOnlyOnboardingPlan({ ...validMinimal, repositoryId: FACTORY_REPOSITORY_ID }).reason,
    'INVALID_CONSUMER_POLICY'
  );
  assert.equal(
    buildReadOnlyOnboardingPlan({ ...validMinimal, pinnedFactorySha: 'main' }).reason,
    'PIN_REF_NOT_IMMUTABLE_SHA'
  );
  assert.equal(
    buildReadOnlyOnboardingPlan({ ...validMinimal, pinnedCheckoutSha: 'v1.0.0' }).reason,
    'PIN_REF_NOT_IMMUTABLE_SHA'
  );
  assert.equal(
    buildReadOnlyOnboardingPlan({ ...validMinimal, stackProfile: 'unknown-custom-stack' }).reason,
    'UNSUPPORTED_STACK_PROFILE'
  );
  assert.equal(
    buildReadOnlyOnboardingPlan({
      ...validMinimal,
      mode: 'greenfield',
      discoveredRepository: {}
    }).reason,
    'DISCOVERY_MODE_MISMATCH'
  );
  const resourceBlocked = buildReadOnlyOnboardingPlan({
    ...validMinimal,
    unsupportedResources: ['shared-admin-token', 'external-paid-service']
  });
  assert.equal(resourceBlocked.reason, 'UNSUPPORTED_RESOURCE_BLOCKED');
  assert.deepEqual(resourceBlocked.blockers, ['shared-admin-token', 'external-paid-service']);

  // Coverage floor and stricter gate preservation
  assert.equal(
    buildReadOnlyOnboardingPlan({
      ...validMinimal,
      stricterCoverageThresholds: { line: 94, branch: 90 }
    }).reason,
    'BASELINE_COVERAGE_BELOW_MINIMUM'
  );
  assert.equal(
    buildReadOnlyOnboardingPlan({
      ...validMinimal,
      stricterCoverageThresholds: { line: 95, branch: 89 }
    }).reason,
    'BASELINE_COVERAGE_BELOW_MINIMUM'
  );
  assert.equal(
    buildReadOnlyOnboardingPlan({
      ...validMinimal,
      stackProfile: 'ios-webkit-97-90',
      stricterCoverageThresholds: { line: 96, branch: 90 }
    }).reason,
    'LOCAL_GATE_WEAKENED'
  );
  assert.equal(
    buildReadOnlyOnboardingPlan({
      ...validMinimal,
      mode: 'existing-repository',
      discoveredRepository: { coverage: { line: 97, branch: 93 } },
      stricterCoverageThresholds: { line: 97, branch: 92 }
    }).reason,
    'LOCAL_GATE_WEAKENED'
  );
  assert.equal(
    buildReadOnlyOnboardingPlan({
      ...validMinimal,
      mode: 'existing-repository',
      discoveredRepository: { migrationFreezeClear: false }
    }).reason,
    'ENROLLMENT_NOT_AUTHORIZED'
  );
  for (const weakenedGate of [
    { requireExplicitApproval: false },
    { requireStrictUpToDate: false },
    { allowCommentedBotApproval: true }
  ]) {
    assert.equal(
      buildReadOnlyOnboardingPlan({
        ...validMinimal,
        mode: 'existing-repository',
        discoveredRepository: weakenedGate
      }).reason,
      'LOCAL_GATE_WEAKENED'
    );
  }

  // Discovered repository and existing files structural validation
  const getterDiscovered = {};
  Object.defineProperty(getterDiscovered, 'defaultBranch', { enumerable: true, get: failTrap });
  for (const badDiscovered of [
    null,
    new Proxy({}, trapHandler),
    getterDiscovered,
    { unknownField: true },
    { migrationFreezeClear: 'yes' },
    { requireExplicitApproval: 1 },
    { requireStrictUpToDate: null },
    { allowCommentedBotApproval: 'no' },
    { coverage: { line: 95 } },
    { coverage: { line: -1, branch: 90 } },
    { coverage: { line: 95, branch: 105 } },
    { maxConcurrency: 0 },
    { maxConcurrency: 13 },
    { visibility: 'invalid' },
    { defaultBranch: 'bad..branch' },
    { defaultBranch: 'bad//branch' },
    { defaultBranch: 'bad/' },
    { mergeMethod: 'fast-forward' },
    { checks: [] },
    { reviewers: [] },
    { owners: [{ prefix: 'src//nested', owner: 'synthetic-owner' }] },
    { owners: [{ prefix: '  ', owner: 'synthetic-owner' }] }
  ]) {
    assert.equal(
      buildReadOnlyOnboardingPlan({
        ...validMinimal,
        mode: 'existing-repository',
        discoveredRepository: badDiscovered
      }).reason,
      'DISCOVERED_REPOSITORY_INVALID'
    );
  }

  for (const badFiles of [
    'not-an-array',
    revokedArr.proxy,
    new Proxy(['src/a.ts'], trapHandler),
    [''],
    ['/abs/path.ts'],
    ['../escape.ts'],
    [123],
    [{ path: 'src/a.ts' }],
    [{ path: '../bad.ts', content: 'x' }],
    ['src/dup.ts', 'SRC/DUP.TS']
  ]) {
    assert.equal(
      buildReadOnlyOnboardingPlan({ ...validMinimal, existingFiles: badFiles }).reason,
      'EXISTING_FILES_INVALID'
    );
  }

  assert.equal(traps, 0);
});
