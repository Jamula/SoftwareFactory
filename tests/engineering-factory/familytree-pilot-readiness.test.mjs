import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CONSUMER_CONTRACT_VERSION,
  FACTORY_REPOSITORY,
  FACTORY_REPOSITORY_ID,
  REUSABLE_WORKFLOW_PREFIX
} from '../../tools/engineering-factory/consumer-onboarding.mjs';
import {
  FAMILYTREE_BASELINE_COVERAGE,
  FAMILYTREE_PILOT_VERSION,
  FAMILYTREE_REQUIRED_SHADOW_DENIALS,
  evaluateFamilyTreeShadowCandidate,
  evaluateFamilyTreeShadowReadiness,
  proveFamilyTreeShadowDenials
} from '../../tools/engineering-factory/familytree-pilot-readiness.mjs';

const examples = JSON.parse(
  await readFile(new URL('../../tools/engineering-factory/example-policies.json', import.meta.url), 'utf8')
);
const shadowWorkflowSource = await readFile(
  new URL('../../.github/workflows/shadow-tests.yml', import.meta.url),
  'utf8'
);
const recordedEvidenceText = await readFile(
  new URL('../../docs/evidence/m03-02-familytree-shadow-readiness.json', import.meta.url),
  'utf8'
);
const recordedEvidence = JSON.parse(recordedEvidenceText);

const checkoutRefMatch = shadowWorkflowSource.match(/^\s*ref:\s*(\S+)\s*$/m);
assert.ok(checkoutRefMatch, 'shadow-tests.yml must declare an explicit checkout ref');
const reviewedWorkflowSha = 'afc3d223f287b029db32672908097efc67a259c9';
const reviewedCheckoutSha = checkoutRefMatch[1];
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const sfPin = 'c'.repeat(40);

const byRepo = name => examples.find(entry => entry.repository === name);

function candidateSnapshot(policy) {
  return {
    policySource: 'trusted-default-branch',
    repository: policy.repository,
    issue: 36,
    pr: 136,
    head,
    observedHead: head,
    base,
    observedBase: base,
    baseBranch: policy.defaultBranch,
    rateLimited: false,
    remainingCredits: 40,
    activeCount: 0,
    providerReady: true,
    risk: 'low',
    priority: 1,
    paths: [`${policy.owners[0].prefix}tree.ts`],
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

function makeSoftwareFactoryBaseline() {
  return {
    policy: {
      repositoryId: FACTORY_REPOSITORY_ID,
      pin: sfPin,
      lineMin: 98,
      branchMin: 95,
      firstPilot: true
    },
    readiness: {
      repositoryId: FACTORY_REPOSITORY_ID,
      pin: sfPin,
      enrolled: true,
      stop: false,
      upstreamAccepted: false,
      review: true,
      coverageLine: 99,
      coverageBranch: 96,
      requiredChecks: true,
      quotaVerified: true,
      rollbackVerified: true,
      securityClear: true
    }
  };
}

function makeEligibleCandidate(pkg) {
  return {
    deliveryId: 'evt-ft-shadow-0001',
    repositoryId: pkg.repositoryId,
    stop: false,
    aiCreditQuota: {
      accountingSource: 'verified',
      isEstimated: false,
      remainingAiCredits: 40,
      runAiCreditsRequired: 10,
      paidOverageEnabled: false,
      overageHardStopUsdCents: 0
    },
    snapshot: candidateSnapshot(pkg.policy)
  };
}

function makeDenialsFromCandidate(baseCand, minLine = 95, minBranch = 90) {
  const snap = baseCand.snapshot;
  return {
    staleReview: {
      ...baseCand,
      snapshot: {
        ...snap,
        reviews: [{ reviewer: snap.reviews[0].reviewer, head: base, state: 'APPROVED' }]
      }
    },
    dismissedReview: {
      ...baseCand,
      snapshot: {
        ...snap,
        reviews: [{ reviewer: snap.reviews[0].reviewer, head, state: 'DISMISSED' }]
      }
    },
    commentedBotReview: {
      ...baseCand,
      snapshot: {
        ...snap,
        reviews: [{
          reviewer: 'copilot-pull-request-reviewer[bot]',
          head,
          state: 'COMMENTED',
          summaryDisposition: 'clear'
        }]
      }
    },
    wrongRepositoryId: {
      ...baseCand,
      repositoryId: 999999
    },
    wrongRepositorySlug: {
      ...baseCand,
      snapshot: {
        ...snap,
        repository: 'example/foreign-repository'
      }
    },
    missingAiCreditQuota: {
      ...baseCand,
      aiCreditQuota: {
        ...baseCand.aiCreditQuota,
        remainingAiCredits: null
      }
    },
    estimatedAiCreditQuota: {
      ...baseCand,
      aiCreditQuota: {
        ...baseCand.aiCreditQuota,
        accountingSource: 'estimated',
        isEstimated: true
      }
    },
    belowFloorLineCoverage: {
      ...baseCand,
      snapshot: {
        ...snap,
        coverage: {
          ...snap.coverage,
          line: minLine - 0.1
        }
      }
    },
    belowFloorBranchCoverage: {
      ...baseCand,
      snapshot: {
        ...snap,
        coverage: {
          ...snap.coverage,
          branch: minBranch - 0.1
        }
      }
    },
    emergencyStop: {
      ...baseCand,
      stop: true
    },
    duplicateEvent: { ...baseCand }
  };
}

function makeShadowSuite(pkg = familyTreePkg) {
  const eligibleCandidate = makeEligibleCandidate(pkg);
  const minLine = Math.max(95, pkg.policy.coverage.line, pkg.localGates.minLineCoverage);
  const minBranch = Math.max(90, pkg.policy.coverage.branch, pkg.localGates.minBranchCoverage);
  return {
    onboardingPackage: structuredClone(pkg),
    peerPackages: [structuredClone(spellbookPkg), structuredClone(familyHubPkg)],
    softwareFactoryBaseline: makeSoftwareFactoryBaseline(),
    rollbackReceipt: {
      repository: pkg.policy.repository,
      postPolicy: structuredClone(pkg.policy),
      revokedCredentialId: pkg.credentials.credentialId,
      pinRevertedViaReviewedPr: true,
      queuedLiveMutations: 0
    },
    eligibleCandidate,
    denials: makeDenialsFromCandidate(eligibleCandidate, minLine, minBranch)
  };
}

function makeReadinessInput(overrides = {}) {
  const pkg = overrides.onboardingPackage ?? structuredClone(familyTreePkg);
  return {
    stop: false,
    version: FAMILYTREE_PILOT_VERSION,
    productReleaseEnabled: false,
    m01AutonomousAccepted: true,
    familyTreeScopedAuthVerified: true,
    sharedAdminTokenUsed: false,
    productionDeploymentEnabled: false,
    containsPrivateGenealogyData: false,
    onboardingPackage: pkg,
    shadowDenialSuite: makeShadowSuite(pkg),
    ...overrides
  };
}

test('constants are frozen and declare synthetic baseline and required denial catalog', () => {
  assert.equal(FAMILYTREE_PILOT_VERSION, '0.1.0');
  assert.equal(Object.isFrozen(FAMILYTREE_BASELINE_COVERAGE), true);
  assert.deepEqual(FAMILYTREE_BASELINE_COVERAGE, { line: 95, branch: 90 });
  assert.equal(Object.isFrozen(FAMILYTREE_REQUIRED_SHADOW_DENIALS), true);
  assert.equal(FAMILYTREE_REQUIRED_SHADOW_DENIALS.length, 11);
});

test('evaluateFamilyTreeShadowCandidate enforces config, schema, stop, repoId, duplicate event, AI-credit quota, and coverage floors', () => {
  const baseConfig = {
    repositoryId: familyTreePkg.repositoryId,
    policy: structuredClone(familyTreePkg.policy),
    localGates: structuredClone(familyTreePkg.localGates),
    stop: false,
    seenDeliveryIds: ['evt-prior-1']
  };
  const baseCand = makeEligibleCandidate(familyTreePkg);

  assert.deepEqual(evaluateFamilyTreeShadowCandidate(baseConfig, baseCand), {
    shadow: true,
    eligible: true,
    liveActivation: false,
    liveMutations: 0,
    reason: 'SHADOW_ELIGIBLE'
  });

  const withDep = {
    ...baseCand,
    snapshot: {
      ...baseCand.snapshot,
      dependencies: [{ issue: 1, accepted: true }]
    }
  };
  assert.equal(evaluateFamilyTreeShadowCandidate(baseConfig, withDep).eligible, true);

  let traps = 0;
  const trap = () => {
    traps += 1;
    throw new Error('proxy or accessor trap must not execute');
  };
  const proxyCfg = new Proxy(baseConfig, { get: trap, getOwnPropertyDescriptor: trap });
  const revokedCfg = Proxy.revocable(baseConfig, {});
  revokedCfg.revoke();
  const getterCfg = { ...baseConfig };
  Object.defineProperty(getterCfg, 'stop', { enumerable: true, get: trap });
  const nonEnumCfg = { ...baseConfig };
  Object.defineProperty(nonEnumCfg, 'stop', { enumerable: false, value: false });

  const withHiddenProp = target => {
    const copy = Array.isArray(target) ? [...target] : { ...target };
    Object.defineProperty(copy, 'hidden', { value: 1 });
    return copy;
  };

  for (const badConfig of [
    null,
    'bad',
    [],
    Object.create(null),
    proxyCfg,
    revokedCfg.proxy,
    getterCfg,
    nonEnumCfg,
    { ...baseConfig, extra: true },
    { ...baseConfig, repositoryId: 0 },
    { ...baseConfig, repositoryId: FACTORY_REPOSITORY_ID },
    { ...baseConfig, policy: null },
    { ...baseConfig, policy: { ...baseConfig.policy, coverage: withHiddenProp(baseConfig.policy.coverage) } },
    { ...baseConfig, policy: { ...baseConfig.policy, checks: withHiddenProp(baseConfig.policy.checks) } },
    { ...baseConfig, policy: { ...baseConfig.policy, checks: [withHiddenProp(baseConfig.policy.checks[0])] } },
    { ...baseConfig, policy: { ...baseConfig.policy, reviewers: withHiddenProp(baseConfig.policy.reviewers) } },
    { ...baseConfig, policy: { ...baseConfig.policy, owners: withHiddenProp(baseConfig.policy.owners) } },
    { ...baseConfig, policy: { ...baseConfig.policy, owners: [withHiddenProp(baseConfig.policy.owners[0])] } },
    { ...baseConfig, policy: { ...baseConfig.policy, riskClasses: withHiddenProp(baseConfig.policy.riskClasses) } },
    { ...baseConfig, policy: { ...baseConfig.policy, checks: [] } },
    {
      ...baseConfig,
      policy: { ...baseConfig.policy, repository: FACTORY_REPOSITORY, coverage: { line: 98, branch: 95 } }
    },
    { ...baseConfig, localGates: null },
    { ...baseConfig, localGates: { ...baseConfig.localGates, minLineCoverage: -1 } },
    { ...baseConfig, localGates: { ...baseConfig.localGates, minBranchCoverage: 101 } },
    { ...baseConfig, localGates: { ...baseConfig.localGates, maxConcurrency: 0 } },
    { ...baseConfig, policy: { ...baseConfig.policy, maxActive: 2 } },
    { ...baseConfig, localGates: { ...baseConfig.localGates, requireExplicitApproval: false } },
    { ...baseConfig, localGates: { ...baseConfig.localGates, requireStrictUpToDate: false } },
    { ...baseConfig, localGates: { ...baseConfig.localGates, requiredChecks: 'bad' } },
    { ...baseConfig, localGates: { ...baseConfig.localGates, requiredChecks: [] } },
    { ...baseConfig, localGates: { ...baseConfig.localGates, requiredChecks: [{}] } },
    { ...baseConfig, localGates: { ...baseConfig.localGates, requiredChecks: [{ name: '', appId: 1 }] } },
    { ...baseConfig, localGates: { ...baseConfig.localGates, requiredChecks: [{ name: 'x', appId: 0 }] } },
    { ...baseConfig, localGates: { ...baseConfig.localGates, requiredChecks: [{ name: 'missing', appId: 12345 }] } },
    { ...baseConfig, policy: { ...baseConfig.policy, repository: 'acme/non-synthetic' } },
    { ...baseConfig, stop: 'false' },
    { ...baseConfig, seenDeliveryIds: 'not-array' },
    { ...baseConfig, seenDeliveryIds: new Proxy([], {}) },
    { ...baseConfig, seenDeliveryIds: new Array(65).fill('evt') },
    { ...baseConfig, seenDeliveryIds: new Array(1) },
    { ...baseConfig, seenDeliveryIds: [''] },
    { ...baseConfig, seenDeliveryIds: [' padded '] }
  ]) {
    assert.equal(evaluateFamilyTreeShadowCandidate(badConfig, baseCand).reason, 'CANDIDATE_CONFIG_INVALID');
  }

  const proxyCand = new Proxy(baseCand, { get: trap, getOwnPropertyDescriptor: trap });
  const revokedCand = Proxy.revocable(baseCand, {});
  revokedCand.revoke();
  const getterCand = { ...baseCand };
  Object.defineProperty(getterCand, 'deliveryId', { enumerable: true, get: trap });

  for (const badCand of [
    null,
    proxyCand,
    revokedCand.proxy,
    getterCand,
    { ...baseCand, deliveryId: '' },
    { ...baseCand, deliveryId: 'x'.repeat(201) },
    { ...baseCand, repositoryId: 0 },
    { ...baseCand, stop: null },
    { ...baseCand, aiCreditQuota: null },
    { ...baseCand, snapshot: null },
    { ...baseCand, snapshot: { ...baseCand.snapshot, coverage: null } },
    { ...baseCand, snapshot: { ...baseCand.snapshot, paths: 'bad' } },
    { ...baseCand, snapshot: { ...baseCand.snapshot, dependencies: 'bad' } },
    { ...baseCand, snapshot: { ...baseCand.snapshot, dependencies: [{}] } },
    { ...baseCand, snapshot: { ...baseCand.snapshot, checks: 'bad' } },
    { ...baseCand, snapshot: { ...baseCand.snapshot, checks: [{}] } },
    { ...baseCand, snapshot: { ...baseCand.snapshot, reviews: 'bad' } },
    { ...baseCand, snapshot: { ...baseCand.snapshot, reviews: [{}] } }
  ]) {
    assert.equal(evaluateFamilyTreeShadowCandidate(baseConfig, badCand).reason, 'CANDIDATE_SCHEMA_INVALID');
  }
  assert.equal(traps, 0);

  assert.equal(evaluateFamilyTreeShadowCandidate({ ...baseConfig, stop: true }, baseCand).reason, 'STOPPED');
  assert.equal(evaluateFamilyTreeShadowCandidate(baseConfig, { ...baseCand, stop: true }).reason, 'STOPPED');
  assert.equal(
    evaluateFamilyTreeShadowCandidate(baseConfig, { ...baseCand, repositoryId: 900202 }).reason,
    'WRONG_REPOSITORY_ID'
  );
  assert.equal(
    evaluateFamilyTreeShadowCandidate(
      { ...baseConfig, seenDeliveryIds: [baseCand.deliveryId] },
      baseCand
    ).reason,
    'DUPLICATE_EVENT'
  );

  for (const quotaOverride of [
    { accountingSource: 'estimated' },
    { isEstimated: true },
    { runAiCreditsRequired: 0 },
    { remainingAiCredits: null },
    { remainingAiCredits: 0 },
    { remainingAiCredits: 5, runAiCreditsRequired: 10 },
    { remainingAiCredits: 80 },
    { paidOverageEnabled: true },
    { overageHardStopUsdCents: 1 },
    { overageHardStopUsdCents: -0 }
  ]) {
    assert.equal(
      evaluateFamilyTreeShadowCandidate(baseConfig, {
        ...baseCand,
        aiCreditQuota: { ...baseCand.aiCreditQuota, ...quotaOverride }
      }).reason,
      'AI_CREDIT_QUOTA_MISSING_OR_ESTIMATED'
    );
  }

  for (const covOverride of [
    { complete: false },
    { head: base },
    { line: Number.NaN },
    { line: 101 },
    { branch: -1 },
    { line: 94.9 },
    { branch: 89.9 }
  ]) {
    assert.equal(
      evaluateFamilyTreeShadowCandidate(baseConfig, {
        ...baseCand,
        snapshot: {
          ...baseCand.snapshot,
          coverage: { ...baseCand.snapshot.coverage, ...covOverride }
        }
      }).reason,
      'COVERAGE_BELOW_FLOOR'
    );
  }

  // Stricter local coverage gates override 95/90 baseline floor
  const stricterConfig = {
    ...baseConfig,
    localGates: { ...baseConfig.localGates, minLineCoverage: 97, minBranchCoverage: 93 }
  };
  assert.equal(evaluateFamilyTreeShadowCandidate(stricterConfig, baseCand).reason, 'COVERAGE_BELOW_FLOOR');
  assert.equal(
    evaluateFamilyTreeShadowCandidate(stricterConfig, {
      ...baseCand,
      snapshot: {
        ...baseCand.snapshot,
        coverage: { ...baseCand.snapshot.coverage, line: 97, branch: 92.5 }
      }
    }).reason,
    'COVERAGE_BELOW_FLOOR'
  );
  assert.equal(
    evaluateFamilyTreeShadowCandidate(stricterConfig, {
      ...baseCand,
      snapshot: {
        ...baseCand.snapshot,
        coverage: { ...baseCand.snapshot.coverage, line: 97, branch: 93 }
      }
    }).eligible,
    true
  );
});

test('proveFamilyTreeShadowDenials verifies all 11 negative shadow scenarios, stricter local gates, and isolated rollback', () => {
  const suite = makeShadowSuite();
  const res = proveFamilyTreeShadowDenials(suite);
  assert.deepEqual(res, {
    shadow: true,
    valid: true,
    liveActivation: false,
    zeroLiveMutations: true,
    reason: 'FAMILYTREE_SHADOW_DENIALS_PROVEN',
    repository: 'example/family-tree',
    repositoryId: 900101,
    verifiedDenials: FAMILYTREE_REQUIRED_SHADOW_DENIALS,
    rollback: {
      stoppedRepository: 'example/family-tree',
      targetDecision: 'STOPPED',
      unaffectedPeers: ['example/spellbook', 'example/family-hub'],
      softwareFactoryUnaffected: true
    }
  });

  // Zero remainingAiCredits and bare copilot-pull-request-reviewer are also valid denial proofs
  const zeroQuotaAndBareBotSuite = {
    ...suite,
    denials: {
      ...suite.denials,
      commentedBotReview: {
        ...suite.eligibleCandidate,
        snapshot: {
          ...suite.eligibleCandidate.snapshot,
          reviews: [{
            reviewer: 'copilot-pull-request-reviewer',
            head,
            state: 'COMMENTED',
            summaryDisposition: 'clear'
          }]
        }
      },
      missingAiCreditQuota: {
        ...suite.eligibleCandidate,
        aiCreditQuota: {
          ...suite.eligibleCandidate.aiCreditQuota,
          remainingAiCredits: 0
        }
      }
    }
  };
  assert.equal(proveFamilyTreeShadowDenials(zeroQuotaAndBareBotSuite).valid, true);

  // Stricter local gate FamilyTree suite (97% line / 93% branch)
  const stricterPolicy = {
    ...byRepo('example/family-tree'),
    coverage: { line: 97, branch: 93 }
  };
  const stricterPkg = makeOnboardingPackage(stricterPolicy, {
    repositoryId: 900101,
    stackProfile: 'web-genealogy-strict-97-93',
    credentialId: 'cred-shadow-family-tree',
    minLineCoverage: 97,
    minBranchCoverage: 93
  });
  const stricterSuite = makeShadowSuite(stricterPkg);
  assert.equal(stricterSuite.denials.belowFloorLineCoverage.snapshot.coverage.line, 96.9);
  assert.equal(stricterSuite.denials.belowFloorBranchCoverage.snapshot.coverage.branch, 92.9);
  assert.equal(proveFamilyTreeShadowDenials(stricterSuite).valid, true);
});

test('proveFamilyTreeShadowDenials rejects invalid suite shapes, broken scenarios, proxy/getter traps, and incomplete rollbacks', () => {
  const suite = makeShadowSuite();

  for (const badSuite of [
    null,
    new Proxy(suite, {}),
    { ...suite, peerPackages: 'not-array' },
    { ...suite, peerPackages: [] },
    { ...suite, softwareFactoryBaseline: null },
    { ...suite, denials: null }
  ]) {
    assert.equal(proveFamilyTreeShadowDenials(badSuite).reason, 'SHADOW_SUITE_INVALID');
  }

  assert.equal(
    proveFamilyTreeShadowDenials({
      ...suite,
      onboardingPackage: { ...suite.onboardingPackage, ownerAuthorized: false }
    }).reason,
    'ENROLLMENT_NOT_AUTHORIZED'
  );

  const nonSyntheticPolicy = { ...byRepo('example/family-tree'), repository: 'acme/non-synthetic' };
  const nonSyntheticPkg = makeOnboardingPackage(nonSyntheticPolicy, {
    repositoryId: 900150,
    stackProfile: 'web-genealogy-95-90',
    credentialId: 'cred-non-synthetic'
  });
  const multiLanePkg = makeOnboardingPackage(
    { ...byRepo('example/family-tree'), maxActive: 2 },
    {
      repositoryId: 900151,
      stackProfile: 'web-genealogy-95-90',
      credentialId: 'cred-multi-lane',
      maxConcurrency: 2
    }
  );
  const higherCapPkg = makeOnboardingPackage(byRepo('example/family-tree'), {
    repositoryId: 900152,
    stackProfile: 'web-genealogy-95-90',
    credentialId: 'cred-higher-cap',
    maxConcurrency: 2
  });
  for (const invalidProfilePkg of [nonSyntheticPkg, multiLanePkg, higherCapPkg]) {
    assert.equal(
      proveFamilyTreeShadowDenials({ ...suite, onboardingPackage: invalidProfilePkg }).reason,
      'FAMILYTREE_PROFILE_CONSTRAINTS_INVALID'
    );
  }

  const sf = suite.softwareFactoryBaseline;
  for (const badSf of [
    { ...sf, policy: { ...sf.policy, extra: true } },
    { ...sf, readiness: { ...sf.readiness, extra: true } },
    { ...sf, readiness: { ...sf.readiness, stop: true } },
    { policy: { ...sf.policy, repositoryId: 2 }, readiness: { ...sf.readiness, repositoryId: 2 } },
    { policy: { ...sf.policy, lineMin: 97 }, readiness: sf.readiness },
    { policy: { ...sf.policy, branchMin: 94 }, readiness: sf.readiness },
    { policy: { ...sf.policy, firstPilot: false }, readiness: { ...sf.readiness, upstreamAccepted: true } }
  ]) {
    assert.equal(
      proveFamilyTreeShadowDenials({ ...suite, softwareFactoryBaseline: badSf }).reason,
      'SOFTWARE_FACTORY_BASELINE_INVALID'
    );
  }

  let getterInvocations = 0;
  const trap = () => {
    getterInvocations += 1;
    throw new Error('trap must not run');
  };
  const throwingExpectedPriority = {};
  Object.defineProperty(throwingExpectedPriority, 'bad', { enumerable: true, get: trap });
  const throwingExpectedArray = [1];
  Object.defineProperty(throwingExpectedArray, 0, { enumerable: true, get: trap });
  const proxyExpectedPriority = new Proxy({ bad: 1 }, { get: trap, getOwnPropertyDescriptor: trap });
  const revokedObj = Proxy.revocable({ bad: 1 }, {});
  revokedObj.revoke();
  const revokedArr = Proxy.revocable([1], {});
  revokedArr.revoke();
  const symbolPriority = { [Symbol('s')]: 1 };
  const cyclicPriority = {};
  cyclicPriority.self = cyclicPriority;

  const makePrioritySuite = (expectedPriority, candidatePriority) => {
    const candWithPriority = {
      ...suite.eligibleCandidate,
      snapshot: { ...suite.eligibleCandidate.snapshot, priority: expectedPriority }
    };
    const mutatedDenials = makeDenialsFromCandidate(candWithPriority);
    return {
      ...suite,
      eligibleCandidate: candWithPriority,
      denials: {
        ...mutatedDenials,
        staleReview: {
          ...mutatedDenials.staleReview,
          snapshot: { ...mutatedDenials.staleReview.snapshot, priority: candidatePriority }
        }
      }
    };
  };

  const cand = suite.eligibleCandidate;
  const snap = cand.snapshot;
  const d = suite.denials;

  for (const badScenarioSuite of [
    { ...suite, eligibleCandidate: null },
    { ...suite, eligibleCandidate: { ...cand, snapshot: null } },
    makePrioritySuite(throwingExpectedPriority, { bad: 1 }),
    makePrioritySuite(throwingExpectedArray, [1]),
    makePrioritySuite(proxyExpectedPriority, { bad: 1 }),
    makePrioritySuite(revokedObj.proxy, { bad: 1 }),
    makePrioritySuite(revokedArr.proxy, [1]),
    makePrioritySuite({ bad: 1 }, revokedObj.proxy),
    makePrioritySuite([1], revokedArr.proxy),
    makePrioritySuite([1, 2], [1]),
    makePrioritySuite({ a: 1 }, { a: 2 }),
    makePrioritySuite(Object.create(null), {}),
    makePrioritySuite(symbolPriority, {}),
    makePrioritySuite(cyclicPriority, cyclicPriority),
    { ...suite, denials: { ...d, staleReview: cand } },
    { ...suite, denials: { ...d, staleReview: { ...cand, snapshot: { ...snap, reviews: [] } } } },
    {
      ...suite,
      denials: {
        ...d,
        staleReview: { ...cand, snapshot: { ...snap, reviews: [{ reviewer: '', head: base, state: 'APPROVED' }] } }
      }
    },
    {
      ...suite,
      denials: {
        ...d,
        staleReview: {
          ...cand,
          snapshot: { ...snap, reviews: [{ reviewer: 'synthetic-reviewer', head: base, state: 'DISMISSED' }] }
        }
      }
    },
    {
      ...suite,
      denials: {
        ...d,
        staleReview: {
          ...cand,
          snapshot: { ...snap, reviews: [{ reviewer: 'synthetic-reviewer', head: 'bad', state: 'APPROVED' }] }
        }
      }
    },
    { ...suite, denials: { ...d, dismissedReview: cand } },
    { ...suite, denials: { ...d, dismissedReview: { ...cand, snapshot: { ...snap, reviews: [] } } } },
    {
      ...suite,
      denials: {
        ...d,
        dismissedReview: {
          ...cand,
          snapshot: { ...snap, reviews: [{ reviewer: '', head, state: 'DISMISSED' }] }
        }
      }
    },
    {
      ...suite,
      denials: {
        ...d,
        dismissedReview: {
          ...cand,
          snapshot: { ...snap, reviews: [{ reviewer: 'synthetic-reviewer', head: base, state: 'DISMISSED' }] }
        }
      }
    },
    { ...suite, denials: { ...d, commentedBotReview: cand } },
    { ...suite, denials: { ...d, commentedBotReview: { ...cand, snapshot: { ...snap, reviews: [] } } } },
    {
      ...suite,
      denials: {
        ...d,
        commentedBotReview: {
          ...cand,
          snapshot: { ...snap, reviews: [{ reviewer: 'copilot-pull-request-reviewer[bot]', head, state: 'COMMENTED' }] }
        }
      }
    },
    {
      ...suite,
      denials: {
        ...d,
        commentedBotReview: {
          ...cand,
          snapshot: {
            ...snap,
            reviews: [{ reviewer: '', head, state: 'COMMENTED', summaryDisposition: 'clear' }]
          }
        }
      }
    },
    {
      ...suite,
      denials: {
        ...d,
        commentedBotReview: {
          ...cand,
          snapshot: {
            ...snap,
            reviews: [{ reviewer: 'human-reviewer', head, state: 'COMMENTED', summaryDisposition: 'clear' }]
          }
        }
      }
    },
    {
      ...suite,
      denials: {
        ...d,
        commentedBotReview: {
          ...cand,
          snapshot: {
            ...snap,
            reviews: [{ reviewer: 'copilot-pull-request-reviewer[bot]', head: base, state: 'COMMENTED', summaryDisposition: 'clear' }]
          }
        }
      }
    },
    {
      ...suite,
      denials: {
        ...d,
        commentedBotReview: {
          ...cand,
          snapshot: {
            ...snap,
            reviews: [{ reviewer: 'copilot-pull-request-reviewer[bot]', head, state: 'APPROVED', summaryDisposition: 'clear' }]
          }
        }
      }
    },
    {
      ...suite,
      denials: {
        ...d,
        commentedBotReview: {
          ...cand,
          snapshot: {
            ...snap,
            reviews: [{ reviewer: 'copilot-pull-request-reviewer[bot]', head, state: 'COMMENTED', summaryDisposition: 'actionable' }]
          }
        }
      }
    },
    { ...suite, denials: { ...d, wrongRepositoryId: cand } },
    { ...suite, denials: { ...d, wrongRepositoryId: { ...cand, repositoryId: 0 } } },
    { ...suite, denials: { ...d, wrongRepositorySlug: cand } },
    { ...suite, denials: { ...d, wrongRepositorySlug: { ...cand, snapshot: { ...snap, repository: 'invalid' } } } },
    { ...suite, denials: { ...d, wrongRepositorySlug: { ...cand, snapshot: { ...snap, repository: 'EXAMPLE/FAMILY-TREE' } } } },
    { ...suite, denials: { ...d, missingAiCreditQuota: cand } },
    {
      ...suite,
      denials: {
        ...d,
        missingAiCreditQuota: {
          ...cand,
          aiCreditQuota: { ...cand.aiCreditQuota, remainingAiCredits: 50 }
        }
      }
    },
    {
      ...suite,
      denials: {
        ...d,
        missingAiCreditQuota: {
          ...cand,
          aiCreditQuota: { ...cand.aiCreditQuota, remainingAiCredits: 'none' }
        }
      }
    },
    { ...suite, denials: { ...d, estimatedAiCreditQuota: cand } },
    { ...suite, denials: { ...d, estimatedAiCreditQuota: { ...cand, aiCreditQuota: null } } },
    {
      ...suite,
      denials: {
        ...d,
        estimatedAiCreditQuota: {
          ...cand,
          aiCreditQuota: { ...cand.aiCreditQuota, accountingSource: '', isEstimated: true }
        }
      }
    },
    {
      ...suite,
      denials: {
        ...d,
        estimatedAiCreditQuota: {
          ...cand,
          aiCreditQuota: { ...cand.aiCreditQuota, isEstimated: true, remainingAiCredits: 999 }
        }
      }
    },
    { ...suite, denials: { ...d, belowFloorLineCoverage: cand } },
    {
      ...suite,
      denials: {
        ...d,
        belowFloorLineCoverage: {
          ...cand,
          snapshot: { ...snap, coverage: { ...snap.coverage, line: -1 } }
        }
      }
    },
    { ...suite, denials: { ...d, belowFloorBranchCoverage: cand } },
    { ...suite, denials: { ...d, emergencyStop: cand } },
    { ...suite, denials: { ...d, duplicateEvent: { ...cand, deliveryId: 'evt-different' } } }
  ]) {
    assert.equal(proveFamilyTreeShadowDenials(badScenarioSuite).reason, 'SHADOW_DENIAL_SCENARIO_INVALID');
  }
  assert.equal(getterInvocations, 0);

  // Structurally valid candidate + derived denials that fails shadow eligibility (mainHealthy: false)
  const unhealthyCand = {
    ...cand,
    snapshot: { ...snap, mainHealthy: false }
  };
  assert.equal(
    proveFamilyTreeShadowDenials({
      ...suite,
      eligibleCandidate: unhealthyCand,
      denials: makeDenialsFromCandidate(unhealthyCand)
    }).reason,
    'SHADOW_DENIAL_NOT_PROVEN'
  );

  // Rollback failure propagates fail-closed reason
  assert.equal(
    proveFamilyTreeShadowDenials({
      ...suite,
      rollbackReceipt: { ...suite.rollbackReceipt, queuedLiveMutations: 1 }
    }).reason,
    'TARGET_ROLLBACK_INCOMPLETE'
  );
});

test('evaluateFamilyTreeShadowReadiness enforces M01 acceptance, scoped auth, privacy, token, deploy, onboarding, and shadow denials', () => {
  const readyRes = evaluateFamilyTreeShadowReadiness(makeReadinessInput());
  assert.deepEqual(readyRes, {
    shadow: true,
    ready: true,
    liveActivation: false,
    upstreamM01Accepted: true,
    familyTreeScopedAuthVerified: true,
    onboardingContractVerified: true,
    shadowDenialsVerified: true,
    zeroLiveMutations: true,
    reason: 'FAMILYTREE_SHADOW_READY_ONLY',
    repository: 'example/family-tree',
    repositoryId: 900101,
    pinnedWorkflowSha: reviewedWorkflowSha,
    pinnedCheckoutSha: reviewedCheckoutSha,
    verifiedDenials: FAMILYTREE_REQUIRED_SHADOW_DENIALS,
    rollback: {
      stoppedRepository: 'example/family-tree',
      targetDecision: 'STOPPED',
      unaffectedPeers: ['example/spellbook', 'example/family-hub'],
      softwareFactoryUnaffected: true
    }
  });

  let traps = 0;
  const trap = () => {
    traps += 1;
    throw new Error('readiness input trap must not run');
  };
  const validInput = makeReadinessInput();
  const proxyInput = new Proxy(validInput, { get: trap, getOwnPropertyDescriptor: trap });
  const revokedInput = Proxy.revocable(validInput, {});
  revokedInput.revoke();
  const getterInput = { ...validInput };
  Object.defineProperty(getterInput, 'm01AutonomousAccepted', { enumerable: true, get: trap });

  for (const badInput of [
    null,
    [],
    Object.create(null),
    proxyInput,
    revokedInput.proxy,
    getterInput,
    { ...validInput, stop: 'false' },
    { ...validInput, version: 1 },
    { ...validInput, productReleaseEnabled: 'false' },
    { ...validInput, m01AutonomousAccepted: 'true' },
    { ...validInput, familyTreeScopedAuthVerified: null },
    { ...validInput, sharedAdminTokenUsed: 0 },
    { ...validInput, productionDeploymentEnabled: null },
    { ...validInput, containsPrivateGenealogyData: 'false' }
  ]) {
    const denied = evaluateFamilyTreeShadowReadiness(badInput);
    assert.equal(denied.ready, false);
    assert.equal(denied.liveActivation, false);
    assert.equal(denied.reason, 'INPUT_SCHEMA_INVALID');
  }
  assert.equal(traps, 0);

  assert.equal(evaluateFamilyTreeShadowReadiness(makeReadinessInput({ stop: true })).reason, 'STOPPED');
  assert.equal(
    evaluateFamilyTreeShadowReadiness(makeReadinessInput({ containsPrivateGenealogyData: true })).reason,
    'PRIVATE_GENEALOGY_DATA_FORBIDDEN'
  );
  assert.equal(
    evaluateFamilyTreeShadowReadiness(makeReadinessInput({ productionDeploymentEnabled: true })).reason,
    'PRODUCTION_DEPLOYMENT_FORBIDDEN'
  );
  assert.equal(
    evaluateFamilyTreeShadowReadiness(makeReadinessInput({ sharedAdminTokenUsed: true })).reason,
    'SHARED_ADMIN_TOKEN_FORBIDDEN'
  );
  assert.equal(
    evaluateFamilyTreeShadowReadiness(makeReadinessInput({ version: '1.0.0' })).reason,
    'VERSION_OR_RELEASE_FORBIDDEN'
  );
  assert.equal(
    evaluateFamilyTreeShadowReadiness(makeReadinessInput({ productReleaseEnabled: true })).reason,
    'VERSION_OR_RELEASE_FORBIDDEN'
  );

  assert.equal(
    evaluateFamilyTreeShadowReadiness(
      makeReadinessInput({
        onboardingPackage: { ...familyTreePkg, autoActivate: true }
      })
    ).reason,
    'ENROLLMENT_NOT_AUTHORIZED'
  );

  assert.equal(
    evaluateFamilyTreeShadowReadiness(
      makeReadinessInput({
        shadowDenialSuite: { ...makeShadowSuite(), peerPackages: [] }
      })
    ).reason,
    'SHADOW_SUITE_INVALID'
  );

  // Valid onboardingPackage and valid shadowDenialSuite for a different package fail mismatch check
  const altFamilyTreePkg = makeOnboardingPackage(byRepo('example/family-tree'), {
    repositoryId: 900199,
    stackProfile: 'web-genealogy-95-90',
    credentialId: 'cred-shadow-family-tree-alt'
  });
  assert.equal(
    evaluateFamilyTreeShadowReadiness({
      ...validInput,
      onboardingPackage: altFamilyTreePkg,
      shadowDenialSuite: makeShadowSuite(familyTreePkg)
    }).reason,
    'ONBOARDING_SUITE_MISMATCH'
  );

  const m01Blocked = evaluateFamilyTreeShadowReadiness(
    makeReadinessInput({ m01AutonomousAccepted: false, familyTreeScopedAuthVerified: false })
  );
  assert.deepEqual(m01Blocked, {
    shadow: true,
    ready: false,
    liveActivation: false,
    upstreamM01Accepted: false,
    familyTreeScopedAuthVerified: false,
    onboardingContractVerified: true,
    shadowDenialsVerified: true,
    zeroLiveMutations: true,
    reason: 'UPSTREAM_M01_NOT_ACCEPTED'
  });

  const authBlocked = evaluateFamilyTreeShadowReadiness(
    makeReadinessInput({ m01AutonomousAccepted: true, familyTreeScopedAuthVerified: false })
  );
  assert.deepEqual(authBlocked, {
    shadow: true,
    ready: false,
    liveActivation: false,
    upstreamM01Accepted: true,
    familyTreeScopedAuthVerified: false,
    onboardingContractVerified: true,
    shadowDenialsVerified: true,
    zeroLiveMutations: true,
    reason: 'FAMILYTREE_SCOPED_AUTH_REQUIRED'
  });
});

test('recorded M03.02 evidence artifact matches deterministic shadow-denial proof and upstream M01 blocker state', () => {
  assert.equal(recordedEvidence.milestone, 'M03.02');
  assert.equal(recordedEvidence.issue, 36);
  assert.equal(recordedEvidence.syntheticOnly, true);
  assert.equal(recordedEvidence.containsPrivateGenealogyData, false);
  assert.equal(recordedEvidence.productionDeploymentEnabled, false);
  assert.equal(recordedEvidence.sharedAdminTokenUsed, false);
  assert.equal(recordedEvidence.liveActivation, false);
  assert.equal(recordedEvidence.upstreamM01Accepted, false);
  assert.equal(recordedEvidence.familyTreeScopedAuthVerified, false);
  assert.equal(/jamula\/familytree/i.test(recordedEvidenceText), false);

  const liveProof = proveFamilyTreeShadowDenials(makeShadowSuite());
  assert.deepEqual(recordedEvidence.shadowDenialProof, liveProof);

  const liveBlockedReadiness = evaluateFamilyTreeShadowReadiness(
    makeReadinessInput({ m01AutonomousAccepted: false, familyTreeScopedAuthVerified: false })
  );
  assert.deepEqual(recordedEvidence.readinessEvaluation, liveBlockedReadiness);
});
