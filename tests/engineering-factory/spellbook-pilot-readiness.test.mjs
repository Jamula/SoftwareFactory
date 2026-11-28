import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  FORBIDDEN_NON_SPELLBOOK_REPOSITORIES,
  SPELLBOOK_DEFAULT_MAX_CONCURRENT_AGENTS,
  SPELLBOOK_MIN_BRANCH_COVERAGE,
  SPELLBOOK_MIN_LINE_COVERAGE,
  SPELLBOOK_REQUIRED_CHECK_ROLES,
  SPELLBOOK_SCALING_CEILING,
  evaluateSpellbookShadowReadiness
} from '../../tools/engineering-factory/spellbook-pilot-readiness.mjs';

const evidence = JSON.parse(
  await readFile(
    new URL('../../docs/evidence/m04-01-spellbook-shadow-readiness.json', import.meta.url),
    'utf8'
  )
);
const shadowWorkflowSource = await readFile(
  new URL('../../.github/workflows/shadow-tests.yml', import.meta.url),
  'utf8'
);
const checkoutRefMatch = shadowWorkflowSource.match(/^\s*ref:\s*(\S+)\s*$/m);
assert.ok(checkoutRefMatch, 'shadow-tests.yml must declare an explicit checkout ref');
const actualShadowCheckoutSha = checkoutRefMatch[1];

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const altHead = 'd'.repeat(40);

function readyInput(overrides = {}) {
  const cloned = structuredClone(evidence.fixture);
  cloned.m01AutonomousAccepted = true;
  cloned.familyTreePilotAccepted = true;
  cloned.onboardingContractAccepted = true;
  cloned.spellbookRepoReadinessAccepted = true;
  cloned.authorization.ownerAuthorized = true;
  cloned.authorization.zeroIncrementalSpendVerified = true;
  return { ...cloned, ...overrides };
}

function withPolicyCoverage(input, policyCoverage, localGatesOverrides = {}) {
  const next = structuredClone(input);
  next.onboardingPackage.policy.coverage = { ...policyCoverage };
  next.onboardingPackage.replaySuite.killSwitchPolicy.coverage = { ...policyCoverage };
  next.rollback.receipt.postPolicy.coverage = { ...policyCoverage };
  next.onboardingPackage.localGates = {
    ...next.onboardingPackage.localGates,
    ...localGatesOverrides
  };
  return next;
}

function withConcurrency(input, { maxConcurrentAgents, policyMaxActive, localMaxConcurrency, scalingApproval }) {
  const next = structuredClone(input);
  next.maxConcurrentAgents = maxConcurrentAgents;
  next.onboardingPackage.policy.maxActive = policyMaxActive;
  next.onboardingPackage.replaySuite.killSwitchPolicy.maxActive = policyMaxActive;
  next.rollback.receipt.postPolicy.maxActive = policyMaxActive;
  next.onboardingPackage.localGates.maxConcurrency = localMaxConcurrency;
  next.spellbookShadowDenials.concurrencyCapReached.activeCount = policyMaxActive;
  if (scalingApproval === undefined) {
    delete next.scalingApproval;
  } else {
    next.scalingApproval = scalingApproval;
  }
  return next;
}

test('constants are frozen and evidence JSON matches live shadow replay and pinned checkout SHA', () => {
  assert.equal(SPELLBOOK_MIN_LINE_COVERAGE, 97);
  assert.equal(SPELLBOOK_MIN_BRANCH_COVERAGE, 90);
  assert.equal(SPELLBOOK_DEFAULT_MAX_CONCURRENT_AGENTS, 2);
  assert.equal(SPELLBOOK_SCALING_CEILING, 12);
  assert.equal(Object.isFrozen(SPELLBOOK_REQUIRED_CHECK_ROLES), true);
  assert.deepEqual(SPELLBOOK_REQUIRED_CHECK_ROLES, ['webkit', 'ios', 'releaseReadiness']);
  assert.equal(Object.isFrozen(FORBIDDEN_NON_SPELLBOOK_REPOSITORIES), true);

  assert.equal(evidence.syntheticOnly, true);
  assert.equal(evidence.mutatesConsumerRepository, false);
  assert.equal(evidence.liveActivation, false);
  assert.equal(
    evidence.fixture.onboardingPackage.workflowPin.reviewedCheckoutSha,
    actualShadowCheckoutSha
  );

  const currentActual = evaluateSpellbookShadowReadiness(structuredClone(evidence.fixture));
  assert.equal(Object.isFrozen(currentActual), true);
  assert.equal(Object.isFrozen(currentActual.blockingGates), true);
  assert.equal(Object.isFrozen(currentActual.appCoverage), true);
  assert.deepEqual(currentActual, evidence.currentReadinessResult);

  const grantedActual = evaluateSpellbookShadowReadiness(readyInput());
  assert.equal(Object.isFrozen(grantedActual), true);
  assert.deepEqual(grantedActual, evidence.syntheticAllGatesGrantedResult);

  // Omitting optional scalingApproval and passing explicit peerRegistry both work cleanly
  const withoutOptionalScaling = readyInput();
  delete withoutOptionalScaling.scalingApproval;
  withoutOptionalScaling.peerRegistry = [
    {
      repository: 'example/family-hub',
      repositoryId: 900303,
      credentialId: 'cred-shadow-family-hub'
    }
  ];
  assert.equal(evaluateSpellbookShadowReadiness(withoutOptionalScaling).ready, true);
});

test('enforces all upstream acceptance gates (#10 M01, #36 FamilyTree, #13 contract, #103 Spellbook) and scoped authorization', () => {
  const m01Blocked = evaluateSpellbookShadowReadiness(readyInput({ m01AutonomousAccepted: false }));
  assert.equal(m01Blocked.ready, false);
  assert.equal(m01Blocked.shadowVerified, true);
  assert.equal(m01Blocked.upstreamReady, false);
  assert.equal(m01Blocked.liveActivation, false);
  assert.equal(m01Blocked.reason, 'UPSTREAM_M01_NOT_ACCEPTED');
  assert.deepEqual(m01Blocked.blockingGates, ['M01_AUTONOMOUS_ISSUE_10']);

  const ftBlocked = evaluateSpellbookShadowReadiness(readyInput({ familyTreePilotAccepted: false }));
  assert.equal(ftBlocked.ready, false);
  assert.equal(ftBlocked.shadowVerified, true);
  assert.equal(ftBlocked.reason, 'UPSTREAM_FAMILYTREE_PILOT_NOT_ACCEPTED');
  assert.deepEqual(ftBlocked.blockingGates, ['FAMILYTREE_PILOT_ISSUE_36']);

  const contractBlocked = evaluateSpellbookShadowReadiness(readyInput({ onboardingContractAccepted: false }));
  assert.equal(contractBlocked.ready, false);
  assert.equal(contractBlocked.shadowVerified, true);
  assert.equal(contractBlocked.reason, 'UPSTREAM_ONBOARDING_CONTRACT_NOT_ACCEPTED');
  assert.deepEqual(contractBlocked.blockingGates, ['ONBOARDING_CONTRACT_ISSUE_13']);

  const repoBlocked = evaluateSpellbookShadowReadiness(readyInput({ spellbookRepoReadinessAccepted: false }));
  assert.equal(repoBlocked.ready, false);
  assert.equal(repoBlocked.shadowVerified, true);
  assert.equal(repoBlocked.reason, 'SPELLBOOK_REPO_READINESS_INCOMPLETE');
  assert.deepEqual(repoBlocked.blockingGates, ['SPELLBOOK_READINESS_ISSUE_103']);

  const authBase = readyInput();
  const ownerBlocked = evaluateSpellbookShadowReadiness({
    ...authBase,
    authorization: { ...authBase.authorization, ownerAuthorized: false }
  });
  assert.equal(ownerBlocked.ready, false);
  assert.equal(ownerBlocked.shadowVerified, true);
  assert.equal(ownerBlocked.reason, 'SPELLBOOK_AUTHORIZATION_REQUIRED');
  assert.deepEqual(ownerBlocked.blockingGates, ['SPELLBOOK_SCOPED_OWNER_AUTHORIZATION']);

  const spendBlocked = evaluateSpellbookShadowReadiness({
    ...authBase,
    authorization: { ...authBase.authorization, zeroIncrementalSpendVerified: false }
  });
  assert.equal(spendBlocked.ready, false);
  assert.equal(spendBlocked.shadowVerified, true);
  assert.equal(spendBlocked.reason, 'ZERO_SPEND_UNVERIFIED');
  assert.deepEqual(spendBlocked.blockingGates, ['ZERO_INCREMENTAL_SPEND_VERIFICATION']);

  // Stop switch, forbidden FamilyHub/M02 dependencies, production release, and authorization scope mismatches fail closed
  assert.equal(evaluateSpellbookShadowReadiness(readyInput({ stopSwitchActive: true })).reason, 'STOPPED');
  assert.equal(
    evaluateSpellbookShadowReadiness(readyInput({ dependsOnFamilyHub: true })).reason,
    'FORBIDDEN_CROSS_MILESTONE_DEPENDENCY'
  );
  assert.equal(
    evaluateSpellbookShadowReadiness(readyInput({ dependsOnM02Speed: true })).reason,
    'FORBIDDEN_CROSS_MILESTONE_DEPENDENCY'
  );
  assert.equal(
    evaluateSpellbookShadowReadiness({
      ...authBase,
      authorization: { ...authBase.authorization, productionReleaseEnabled: true }
    }).reason,
    'PRODUCTION_RELEASE_FORBIDDEN'
  );

  for (const badScope of [
    { repository: 'example/family-tree' },
    { repository: 'Example/Spellbook' },
    { repositoryId: 900101 },
    { pinnedWorkflowSha: altHead },
    { pinnedCheckoutSha: altHead }
  ]) {
    const res = evaluateSpellbookShadowReadiness({
      ...authBase,
      authorization: { ...authBase.authorization, ...badScope }
    });
    assert.equal(res.shadowVerified, false);
    assert.equal(res.reason, 'AUTHORIZATION_SCOPE_MISMATCH');
  }
});

test('preserves >=97% app line and >=90% branch coverage and rejects lowering 97% down to generic 95% consumer baseline', () => {
  const baseInput = readyInput();

  // Policy lowered to 95% while localGates remains 97%
  const loweredPolicyOnly = withPolicyCoverage(baseInput, { line: 95, branch: 90 });
  assert.equal(
    evaluateSpellbookShadowReadiness(loweredPolicyOnly).reason,
    'SPELLBOOK_COVERAGE_FLOOR_VIOLATION'
  );

  // Both policy and localGates lowered to generic 95% consumer baseline
  const loweredBothTo95 = withPolicyCoverage(
    baseInput,
    { line: 95, branch: 90 },
    { minLineCoverage: 95, minBranchCoverage: 90 }
  );
  assert.equal(
    evaluateSpellbookShadowReadiness(loweredBothTo95).reason,
    'SPELLBOOK_COVERAGE_FLOOR_VIOLATION'
  );

  // Policy at 97% while localGates attempts to record 95% line or 85% branch
  assert.equal(
    evaluateSpellbookShadowReadiness(
      withPolicyCoverage(baseInput, { line: 97, branch: 90 }, { minLineCoverage: 95 })
    ).reason,
    'SPELLBOOK_COVERAGE_FLOOR_VIOLATION'
  );
  assert.equal(
    evaluateSpellbookShadowReadiness(
      withPolicyCoverage(baseInput, { line: 97, branch: 90 }, { minBranchCoverage: 85 })
    ).reason,
    'SPELLBOOK_COVERAGE_FLOOR_VIOLATION'
  );

  // Below generic baseline (<95 line or <90 branch) also maps to Spellbook coverage floor violation
  assert.equal(
    evaluateSpellbookShadowReadiness(withPolicyCoverage(baseInput, { line: 94, branch: 90 })).reason,
    'SPELLBOOK_COVERAGE_FLOOR_VIOLATION'
  );
  assert.equal(
    evaluateSpellbookShadowReadiness(withPolicyCoverage(baseInput, { line: 97, branch: 89 })).reason,
    'SPELLBOOK_COVERAGE_FLOOR_VIOLATION'
  );

  // Even stricter local gate (98% line) cannot be weakened down to 97% by policy
  assert.equal(
    evaluateSpellbookShadowReadiness(
      withPolicyCoverage(baseInput, { line: 97, branch: 90 }, { minLineCoverage: 98 })
    ).reason,
    'LOCAL_GATE_WEAKENED'
  );
  assert.equal(
    evaluateSpellbookShadowReadiness(
      withPolicyCoverage(baseInput, { line: 98, branch: 92 }, { minLineCoverage: 98, minBranchCoverage: 92 })
    ).ready,
    true
  );

  // Candidate coverage below 97% line (e.g. 95% or 96.9%) or below 90% branch fails closed
  const cand95 = readyInput();
  cand95.candidate.coverage = { ...cand95.candidate.coverage, line: 95 };
  assert.equal(evaluateSpellbookShadowReadiness(cand95).reason, 'COVERAGE_INCOMPLETE');

  const candBranch89 = readyInput();
  candBranch89.candidate.coverage = { ...candBranch89.candidate.coverage, branch: 89.9 };
  assert.equal(evaluateSpellbookShadowReadiness(candBranch89).reason, 'COVERAGE_INCOMPLETE');

  // High aggregate coverage (98.7%) cannot mask an individual component below 97% (96/100)
  const maskedSub97Component = readyInput();
  maskedSub97Component.appCoverage.reports = [
    { component: 'ios.bridge', head, lines: 990, lineTotal: 1000, branches: 48, branchTotal: 50 },
    { component: 'app.ui', head, lines: 96, lineTotal: 100, branches: 46, branchTotal: 50 }
  ];
  assert.equal(
    evaluateSpellbookShadowReadiness(maskedSub97Component).reason,
    'APP_COVERAGE_BELOW_SPELLBOOK_TARGET'
  );

  // Malformed, stale, or mismatched appCoverage fails closed
  assert.equal(evaluateSpellbookShadowReadiness(readyInput({ appCoverage: null })).reason, 'APP_COVERAGE_INVALID');
  assert.equal(
    evaluateSpellbookShadowReadiness(
      readyInput({ appCoverage: { ...baseInput.appCoverage, head: 'bad' } })
    ).reason,
    'APP_COVERAGE_INVALID'
  );
  assert.equal(
    evaluateSpellbookShadowReadiness(
      readyInput({ appCoverage: { ...baseInput.appCoverage, head: altHead } })
    ).reason,
    'STALE_HEAD_OR_BASE'
  );

  const inflatedLine = readyInput();
  inflatedLine.candidate.coverage.line = 99.5;
  assert.equal(evaluateSpellbookShadowReadiness(inflatedLine).reason, 'APP_COVERAGE_MISMATCH');

  const inflatedBranch = readyInput();
  inflatedBranch.candidate.coverage.branch = 99;
  assert.equal(evaluateSpellbookShadowReadiness(inflatedBranch).reason, 'APP_COVERAGE_MISMATCH');

  // Optional branchless justifications allow genuine 0/0 components when independently APPROVED on exact head
  const withBranchless = readyInput();
  withBranchless.appCoverage = {
    head,
    expectedComponents: ['ios.bridge', 'app.ui', 'ios.constants'],
    reports: [
      { component: 'ios.bridge', head, lines: 98, lineTotal: 100, branches: 46, branchTotal: 50 },
      { component: 'app.ui', head, lines: 98, lineTotal: 100, branches: 46, branchTotal: 50 },
      { component: 'ios.constants', head, lines: 50, lineTotal: 50, branches: 0, branchTotal: 0 }
    ],
    branchless: [
      {
        component: 'ios.constants',
        head,
        reviewedBy: 'synthetic-spellbook-reviewer',
        reason: 'Pure Swift/TS constant declarations with zero runtime branches'
      }
    ]
  };
  withBranchless.candidate.coverage.line = 98.4;
  const branchlessOk = evaluateSpellbookShadowReadiness(withBranchless);
  assert.equal(branchlessOk.ready, true);
  assert.deepEqual(branchlessOk.appCoverage, {
    lines: 246,
    lineTotal: 250,
    branches: 92,
    branchTotal: 100
  });

  // Malformed branchless list fails closed with APP_COVERAGE_INVALID
  assert.equal(
    evaluateSpellbookShadowReadiness({
      ...withBranchless,
      appCoverage: { ...withBranchless.appCoverage, branchless: 'not-array' }
    }).reason,
    'APP_COVERAGE_INVALID'
  );

  // Unjustified 0/0 component or all-branchless 0/0 inventory fails closed
  const unjustifiedBranchless = structuredClone(withBranchless);
  delete unjustifiedBranchless.appCoverage.branchless;
  assert.equal(
    evaluateSpellbookShadowReadiness(unjustifiedBranchless).reason,
    'APP_COVERAGE_BELOW_SPELLBOOK_TARGET'
  );

  const allZeroBranches = readyInput();
  allZeroBranches.appCoverage = {
    head,
    expectedComponents: ['ios.constants'],
    reports: [{ component: 'ios.constants', head, lines: 50, lineTotal: 50, branches: 0, branchTotal: 0 }],
    branchless: [
      {
        component: 'ios.constants',
        head,
        reviewedBy: 'synthetic-spellbook-reviewer',
        reason: 'Pure constant declarations only'
      }
    ]
  };
  assert.equal(
    evaluateSpellbookShadowReadiness(allZeroBranches).reason,
    'APP_COVERAGE_BELOW_SPELLBOOK_TARGET'
  );

  // Branchless justification requires an independent exact-head APPROVED reviewer from policy.reviewers
  const unlistedReviewerBranchless = structuredClone(withBranchless);
  unlistedReviewerBranchless.appCoverage.branchless[0].reviewedBy = 'unlisted-reviewer';
  assert.equal(
    evaluateSpellbookShadowReadiness(unlistedReviewerBranchless).reason,
    'BRANCHLESS_REVIEW_UNVERIFIED'
  );

  const addPolicyReviewer = (src, extraReviewer, reviewHead = head) => {
    const copy = structuredClone(src);
    copy.onboardingPackage.policy.reviewers.push(extraReviewer);
    copy.onboardingPackage.replaySuite.killSwitchPolicy.reviewers.push(extraReviewer);
    copy.rollback.receipt.postPolicy.reviewers.push(extraReviewer);
    if (reviewHead !== null) {
      copy.candidate.reviews.push({ reviewer: extraReviewer, head: reviewHead, state: 'APPROVED' });
    }
    copy.appCoverage.branchless[0].reviewedBy = extraReviewer;
    return copy;
  };

  assert.equal(
    evaluateSpellbookShadowReadiness(
      addPolicyReviewer(withBranchless, 'synthetic-spellbook-author', head)
    ).reason,
    'BRANCHLESS_REVIEW_UNVERIFIED'
  );
  assert.equal(
    evaluateSpellbookShadowReadiness(
      addPolicyReviewer(withBranchless, 'copilot-swe-agent[bot]', head)
    ).reason,
    'BRANCHLESS_REVIEW_UNVERIFIED'
  );
  assert.equal(
    evaluateSpellbookShadowReadiness(
      addPolicyReviewer(withBranchless, 'second-spellbook-reviewer', base)
    ).reason,
    'BRANCHLESS_REVIEW_UNVERIFIED'
  );
  assert.equal(
    evaluateSpellbookShadowReadiness(
      addPolicyReviewer(withBranchless, 'second-spellbook-reviewer', null)
    ).reason,
    'BRANCHLESS_REVIEW_UNVERIFIED'
  );
});

test('enforces <=2 concurrent-agent cap and rejects 3+ until separately verified scaling is approved', () => {
  const baseInput = readyInput();

  // 1 or 2 concurrent agents allowed without scalingApproval
  const singleAgent = withConcurrency(baseInput, {
    maxConcurrentAgents: 1,
    policyMaxActive: 1,
    localMaxConcurrency: 1,
    scalingApproval: null
  });
  singleAgent.candidate.activeCount = 0;
  singleAgent.onboardingPackage.replaySuite.eligibleCandidate.activeCount = 0;
  for (const key of ['staleReview', 'dismissedReview', 'commentedBotReview', 'wrongRepository', 'missingQuota']) {
    singleAgent.onboardingPackage.replaySuite[key].activeCount = 0;
  }
  for (const key of [
    'staleHead',
    'lowered95LineCoverage',
    'loweredBranchCoverage',
    'webkitCheckFailed',
    'iosCheckFailed',
    'releaseCheckFailed'
  ]) {
    singleAgent.spellbookShadowDenials[key].activeCount = 0;
  }
  const singleRes = evaluateSpellbookShadowReadiness(singleAgent);
  assert.equal(singleRes.ready, true);
  assert.equal(singleRes.maxConcurrentAgents, 1);
  assert.equal(singleRes.scalingApproved, false);

  // Unapproved scalingApproval object with approved: false still permits <=2
  const unapprovedAt2 = withConcurrency(baseInput, {
    maxConcurrentAgents: 2,
    policyMaxActive: 2,
    localMaxConcurrency: 2,
    scalingApproval: {
      approved: false,
      approvedMaxConcurrentAgents: 4,
      measuredCapacityVerified: false,
      includedQuotaVerified: false,
      zeroIncrementalSpendVerified: false,
      approver: 'synthetic-spellbook-owner'
    }
  });
  assert.equal(evaluateSpellbookShadowReadiness(unapprovedAt2).ready, true);

  // Policy or localGates exceeding maxConcurrentAgents fails closed
  assert.equal(
    evaluateSpellbookShadowReadiness(
      withConcurrency(baseInput, {
        maxConcurrentAgents: 2,
        policyMaxActive: 3,
        localMaxConcurrency: 2,
        scalingApproval: null
      })
    ).reason,
    'SPELLBOOK_CONCURRENCY_CAP_EXCEEDED'
  );
  assert.equal(
    evaluateSpellbookShadowReadiness(
      withConcurrency(baseInput, {
        maxConcurrentAgents: 1,
        policyMaxActive: 2,
        localMaxConcurrency: 2,
        scalingApproval: null
      })
    ).reason,
    'SPELLBOOK_CONCURRENCY_CAP_EXCEEDED'
  );
  assert.equal(
    evaluateSpellbookShadowReadiness(
      withConcurrency(singleAgent, {
        maxConcurrentAgents: 1,
        policyMaxActive: 1,
        localMaxConcurrency: 2,
        scalingApproval: null
      })
    ).reason,
    'SPELLBOOK_CONCURRENCY_CAP_EXCEEDED'
  );

  // 3+ concurrent agents rejected without valid independent repository-owner scalingApproval
  const validScaling = {
    approved: true,
    approvedMaxConcurrentAgents: 4,
    measuredCapacityVerified: true,
    includedQuotaVerified: true,
    zeroIncrementalSpendVerified: true,
    approver: 'synthetic-spellbook-repo-owner'
  };

  // Ensure repository owner has no path-owner entry in policy.owners
  assert.equal(
    baseInput.onboardingPackage.policy.owners.some(
      o => o.owner.toLowerCase() === 'synthetic-spellbook-repo-owner'
    ),
    false
  );

  for (const badScaling of [
    null,
    undefined,
    { ...validScaling, approved: false },
    { ...validScaling, approvedMaxConcurrentAgents: 2 },
    { ...validScaling, approvedMaxConcurrentAgents: 13 },
    { ...validScaling, approvedMaxConcurrentAgents: 3 },
    { ...validScaling, measuredCapacityVerified: false },
    { ...validScaling, includedQuotaVerified: false },
    { ...validScaling, zeroIncrementalSpendVerified: false },
    { ...validScaling, approver: 'SYNTHETIC-SPELLBOOK-AUTHOR' },
    { ...validScaling, approver: 'Copilot-SWE-Agent[bot]' },
    { ...validScaling, approver: 'synthetic-spellbook-repo-owner[bot]' },
    // Path-only owners in policy.owners ('ios/' and 'src/') cannot authorize repository scaling
    { ...validScaling, approver: 'synthetic-ios-owner' },
    { ...validScaling, approver: 'synthetic-spellbook-owner' },
    { ...validScaling, approver: 'untrusted-external-user' }
  ]) {
    const res = evaluateSpellbookShadowReadiness(
      withConcurrency(baseInput, {
        maxConcurrentAgents: 4,
        policyMaxActive: 4,
        localMaxConcurrency: 4,
        scalingApproval: badScaling
      })
    );
    assert.equal(res.ready, false);
    assert.equal(res.reason, 'SPELLBOOK_CONCURRENCY_CAP_EXCEEDED');
  }

  // Missing repository-owner authority evidence (omitted, null, [], or ownerAuthorized: false) retains <=2 agent cap
  for (const mutateAuth of [
    auth => {
      delete auth.repositoryOwners;
    },
    auth => {
      auth.repositoryOwners = null;
    },
    auth => {
      auth.repositoryOwners = [];
    },
    auth => {
      auth.ownerAuthorized = false;
    }
  ]) {
    const atTwo = readyInput();
    mutateAuth(atTwo.authorization);
    if (atTwo.authorization.ownerAuthorized) {
      assert.equal(evaluateSpellbookShadowReadiness(atTwo).ready, true);
    }

    const scaledMissingRepoOwner = withConcurrency(baseInput, {
      maxConcurrentAgents: 4,
      policyMaxActive: 4,
      localMaxConcurrency: 4,
      scalingApproval: validScaling
    });
    mutateAuth(scaledMissingRepoOwner.authorization);
    assert.equal(
      evaluateSpellbookShadowReadiness(scaledMissingRepoOwner).reason,
      'SPELLBOOK_CONCURRENCY_CAP_EXCEEDED'
    );
  }

  // Verified repository owner (with no policy.owners path entry) unlocks approved tier while keeping liveActivation: false
  const scaled = evaluateSpellbookShadowReadiness(
    withConcurrency(baseInput, {
      maxConcurrentAgents: 4,
      policyMaxActive: 4,
      localMaxConcurrency: 4,
      scalingApproval: { ...validScaling, approver: 'SYNTHETIC-SPELLBOOK-REPO-OWNER' }
    })
  );
  assert.equal(scaled.ready, true);
  assert.equal(scaled.maxConcurrentAgents, 4);
  assert.equal(scaled.scalingApproved, true);
  assert.equal(scaled.liveActivation, false);
});

test('enforces mandatory WebKit, iOS, and release-readiness CI check contexts and exact-head candidate gates', () => {
  const baseInput = readyInput();

  for (const badRoles of [
    null,
    { webkit: baseInput.requiredCheckRoles.webkit, ios: baseInput.requiredCheckRoles.ios },
    { ...baseInput.requiredCheckRoles, webkit: null },
    { ...baseInput.requiredCheckRoles, webkit: { name: '', appId: 34567 } },
    { ...baseInput.requiredCheckRoles, webkit: { name: 'fictional-webkit-gate', appId: 0 } },
    { ...baseInput.requiredCheckRoles, webkit: { name: 'generic-browser-gate', appId: 34567 } },
    { ...baseInput.requiredCheckRoles, ios: { name: 'curiosity-gate', appId: 34568 } },
    { ...baseInput.requiredCheckRoles, releaseReadiness: { name: 'fictional-ios-gate', appId: 34568 } },
    { ...baseInput.requiredCheckRoles, releaseReadiness: { name: 'fictional-release-readiness', appId: 99999 } }
  ]) {
    assert.equal(
      evaluateSpellbookShadowReadiness({ ...baseInput, requiredCheckRoles: badRoles }).reason,
      'SPELLBOOK_REQUIRED_CHECKS_MISSING'
    );
  }

  // Collapsing all three role bindings onto one combined check name is rejected
  const collapsed = readyInput();
  const combinedCheck = { name: 'webkit-ios-release-gate', appId: 55555 };
  collapsed.onboardingPackage.policy.checks.push(combinedCheck);
  collapsed.onboardingPackage.replaySuite.killSwitchPolicy.checks.push(combinedCheck);
  collapsed.rollback.receipt.postPolicy.checks.push(combinedCheck);
  collapsed.onboardingPackage.localGates.requiredChecks.push(combinedCheck);
  const completedCombined = {
    name: combinedCheck.name,
    head,
    appId: combinedCheck.appId,
    status: 'completed',
    conclusion: 'success'
  };
  collapsed.candidate.checks.push(completedCombined);
  collapsed.onboardingPackage.replaySuite.eligibleCandidate.checks.push(completedCombined);
  for (const key of ['staleReview', 'dismissedReview', 'commentedBotReview', 'wrongRepository', 'missingQuota']) {
    collapsed.onboardingPackage.replaySuite[key].checks.push(completedCombined);
  }
  collapsed.requiredCheckRoles = {
    webkit: combinedCheck,
    ios: combinedCheck,
    releaseReadiness: combinedCheck
  };
  assert.equal(
    evaluateSpellbookShadowReadiness(collapsed).reason,
    'SPELLBOOK_REQUIRED_CHECKS_MISSING'
  );

  // Each individual required check failing or stale on candidate head blocks eligibility
  for (const checkIndex of [0, 1, 2]) {
    const failedCheck = readyInput();
    failedCheck.candidate.checks[checkIndex].conclusion = 'failure';
    assert.equal(evaluateSpellbookShadowReadiness(failedCheck).reason, 'CHECKS_INCOMPLETE');

    const staleCheck = readyInput();
    staleCheck.candidate.checks[checkIndex].head = base;
    assert.equal(evaluateSpellbookShadowReadiness(staleCheck).reason, 'CHECKS_INCOMPLETE');
  }

  // Candidate stale head, active concurrency at cap (2), and COMMENTED Copilot bot review fail closed
  const staleCandidate = readyInput();
  staleCandidate.candidate.observedHead = altHead;
  assert.equal(evaluateSpellbookShadowReadiness(staleCandidate).reason, 'STALE_HEAD_OR_BASE');

  const capCandidate = readyInput();
  capCandidate.candidate.activeCount = 2;
  assert.equal(evaluateSpellbookShadowReadiness(capCandidate).reason, 'BUDGET_OR_CONCURRENCY');

  const botCommentedCandidate = readyInput();
  botCommentedCandidate.candidate.reviews = [
    {
      reviewer: 'copilot-pull-request-reviewer[bot]',
      head,
      state: 'COMMENTED',
      summaryDisposition: 'clear'
    }
  ];
  assert.equal(evaluateSpellbookShadowReadiness(botCommentedCandidate).reason, 'REVIEW_MISSING');

  const candidateWithAcceptedDep = readyInput();
  candidateWithAcceptedDep.candidate.dependencies = [{ issue: 1, accepted: true }];
  assert.equal(evaluateSpellbookShadowReadiness(candidateWithAcceptedDep).ready, true);
});

test('prevents duplicate existing PRs, enforces Spellbook profile isolation, and verifies shadow-denial + single-PR rollback', () => {
  const baseInput = readyInput();

  // Peer or non-Spellbook profile impersonation fails closed
  const peerRepoSpoof = readyInput();
  peerRepoSpoof.onboardingPackage.policy.repository = 'example/family-tree';
  peerRepoSpoof.onboardingPackage.credentials.allowedRepositories = ['example/family-tree'];
  peerRepoSpoof.onboardingPackage.replaySuite.killSwitchPolicy.repository = 'example/family-tree';
  peerRepoSpoof.rollback.receipt.repository = 'example/family-tree';
  peerRepoSpoof.rollback.receipt.postPolicy.repository = 'example/family-tree';
  peerRepoSpoof.candidate.repository = 'example/family-tree';
  peerRepoSpoof.authorization.repository = 'example/family-tree';
  for (const key of ['eligibleCandidate', 'staleReview', 'dismissedReview', 'commentedBotReview', 'missingQuota']) {
    peerRepoSpoof.onboardingPackage.replaySuite[key].repository = 'example/family-tree';
  }
  assert.equal(evaluateSpellbookShadowReadiness(peerRepoSpoof).reason, 'SPELLBOOK_PROFILE_MISMATCH');

  const wrongStack = readyInput();
  wrongStack.onboardingPackage.stackProfile = 'web-genealogy-97-90';
  assert.equal(evaluateSpellbookShadowReadiness(wrongStack).reason, 'SPELLBOOK_PROFILE_MISMATCH');

  // Onboarding package errors propagate cleanly
  const disabledOwner = readyInput();
  disabledOwner.onboardingPackage.ownerAuthorized = false;
  assert.equal(evaluateSpellbookShadowReadiness(disabledOwner).reason, 'ENROLLMENT_NOT_AUTHORIZED');

  // Open PR inventory validation and duplicate-PR / stale-PR denials
  for (const badPrs of [
    'not-array',
    [],
    [{ pr: 205, issue: 104, head: altHead }],
    [{ pr: 0, issue: 103, head }],
    [{ pr: 204, issue: 0, head }],
    [{ pr: 204, issue: 103, head: 'bad' }],
    [
      { pr: 204, issue: 103, head },
      { pr: 204, issue: 104, head: altHead }
    ]
  ]) {
    assert.equal(
      evaluateSpellbookShadowReadiness(readyInput({ openPullRequests: badPrs })).reason,
      'OPEN_PR_INVENTORY_INVALID'
    );
  }

  assert.equal(
    evaluateSpellbookShadowReadiness(
      readyInput({
        openPullRequests: [
          { pr: 204, issue: 103, head },
          { pr: 999, issue: 103, head: altHead }
        ]
      })
    ).reason,
    'DUPLICATE_EXISTING_PR'
  );
  assert.equal(
    evaluateSpellbookShadowReadiness(
      readyInput({
        openPullRequests: [
          { pr: 204, issue: 103, head },
          { pr: 999, issue: 999, head }
        ]
      })
    ).reason,
    'DUPLICATE_EXISTING_PR'
  );
  assert.equal(
    evaluateSpellbookShadowReadiness(
      readyInput({ openPullRequests: [{ pr: 204, issue: 103, head: altHead }] })
    ).reason,
    'STALE_HEAD_OR_BASE'
  );
  assert.equal(
    evaluateSpellbookShadowReadiness(
      readyInput({ openPullRequests: [{ pr: 204, issue: 999, head }] })
    ).reason,
    'STALE_HEAD_OR_BASE'
  );
  assert.equal(
    evaluateSpellbookShadowReadiness(
      readyInput({
        openPullRequests: [
          { pr: 204, issue: 103, head },
          { pr: 205, issue: 104, head: altHead }
        ]
      })
    ).ready,
    true
  );

  // Spellbook shadow-denial replay suite requires valid single-field / single-check mutations
  const baseSnap = baseInput.onboardingPackage.replaySuite.eligibleCandidate;
  const denials = baseInput.spellbookShadowDenials;
  for (const badDenials of [
    null,
    { ...denials, staleHead: baseSnap },
    { ...denials, staleHead: { ...denials.staleHead, issue: 999 } },
    { ...denials, staleHead: { ...baseSnap, observedHead: 'bad' } },
    { ...denials, lowered95LineCoverage: baseSnap },
    {
      ...denials,
      lowered95LineCoverage: {
        ...baseSnap,
        coverage: { ...baseSnap.coverage, line: 94 }
      }
    },
    {
      ...denials,
      lowered95LineCoverage: {
        ...baseSnap,
        coverage: { ...baseSnap.coverage, line: 97 }
      }
    },
    { ...denials, loweredBranchCoverage: baseSnap },
    {
      ...denials,
      loweredBranchCoverage: {
        ...baseSnap,
        coverage: { ...baseSnap.coverage, branch: 90 }
      }
    },
    { ...denials, concurrencyCapReached: baseSnap },
    { ...denials, concurrencyCapReached: { ...baseSnap, activeCount: 1 } },
    { ...denials, webkitCheckFailed: baseSnap },
    { ...denials, webkitCheckFailed: { ...denials.webkitCheckFailed, issue: 999 } },
    { ...denials, webkitCheckFailed: { ...baseSnap, checks: 'bad' } },
    { ...denials, webkitCheckFailed: { ...baseSnap, checks: [{}] } },
    { ...denials, webkitCheckFailed: { ...baseSnap, checks: [] } },
    {
      ...denials,
      webkitCheckFailed: {
        ...baseSnap,
        checks: [baseSnap.checks[0], ...baseSnap.checks]
      }
    },
    // Mutating check head to something valid-looking that still passes (impossible) vs passing status:'completed',conclusion:'success' with different check array fails evaluate
    { ...denials, iosCheckFailed: denials.webkitCheckFailed },
    { ...denials, releaseCheckFailed: denials.webkitCheckFailed }
  ]) {
    assert.equal(
      evaluateSpellbookShadowReadiness(readyInput({ spellbookShadowDenials: badDenials })).reason,
      'SPELLBOOK_SHADOW_REPLAY_INCOMPLETE'
    );
  }

  // In-progress check with null conclusion is a valid incomplete-check shadow denial, whereas proxy or malformed primitive fields are rejected
  const inProgressWebkitDenials = structuredClone(denials);
  inProgressWebkitDenials.webkitCheckFailed.checks[0] = {
    ...baseSnap.checks[0],
    status: 'in_progress',
    conclusion: null
  };
  assert.equal(
    evaluateSpellbookShadowReadiness(readyInput({ spellbookShadowDenials: inProgressWebkitDenials })).ready,
    true
  );

  const revokedCheckHead = Proxy.revocable({}, {});
  revokedCheckHead.revoke();
  for (const badCheckOverride of [
    { head: revokedCheckHead.proxy },
    { head: 'not-a-sha' },
    { name: '' },
    { appId: 0 },
    { status: 'bogus' },
    { status: 'completed', conclusion: null },
    { status: 'in_progress', conclusion: 'success' }
  ]) {
    const badCheckDenials = structuredClone(denials);
    badCheckDenials.webkitCheckFailed.checks[0] = {
      ...denials.webkitCheckFailed.checks[0],
      ...badCheckOverride
    };
    const badCheckRes = evaluateSpellbookShadowReadiness(
      readyInput({ spellbookShadowDenials: badCheckDenials })
    );
    assert.equal(badCheckRes.valid, false);
    assert.equal(badCheckRes.ready, false);
    assert.equal(badCheckRes.shadowVerified, false);
    assert.equal(badCheckRes.reason, 'SPELLBOOK_SHADOW_REPLAY_INCOMPLETE');
  }
  const mutatedNestedDenials = structuredClone(denials);
  mutatedNestedDenials.staleHead.paths = ['ios/Other.swift', 'src/spellbook-ui.ts'];
  assert.equal(
    evaluateSpellbookShadowReadiness(readyInput({ spellbookShadowDenials: mutatedNestedDenials })).reason,
    'SPELLBOOK_SHADOW_REPLAY_INCOMPLETE'
  );
  const mutatedObjDenials = structuredClone(denials);
  mutatedObjDenials.staleHead.coverage = { ...baseSnap.coverage, line: 97 };
  assert.equal(
    evaluateSpellbookShadowReadiness(readyInput({ spellbookShadowDenials: mutatedObjDenials })).reason,
    'SPELLBOOK_SHADOW_REPLAY_INCOMPLETE'
  );

  // Single-PR independent rollback verification
  const sharedPeerCred = structuredClone(baseInput.rollback.peerPackages[0]);
  sharedPeerCred.credentials.credentialId = 'cred-shadow-spellbook';
  sharedPeerCred.rollback.revokeCredentialId = 'cred-shadow-spellbook';
  const rb = baseInput.rollback;
  for (const badRollback of [
    null,
    { ...rb, peerPackages: 'bad' },
    { ...rb, peerPackages: [] },
    { ...rb, peerPackages: [sharedPeerCred] },
    { ...rb, revertPrCount: 0 },
    { ...rb, revertPrCount: 2 },
    { ...rb, crossRepoMutations: 1 },
    { ...rb, crossRepoMutations: -0 },
    { ...rb, receipt: { ...rb.receipt, pinRevertedViaReviewedPr: false } },
    { ...rb, receipt: { ...rb.receipt, queuedLiveMutations: 1 } }
  ]) {
    assert.equal(
      evaluateSpellbookShadowReadiness(readyInput({ rollback: badRollback })).reason,
      'SINGLE_PR_ROLLBACK_INVALID'
    );
  }

  // Every recorded shadowDenialMatrix scenario in docs/evidence matches deterministic replay
  const matrixByScenario = new Map(
    evidence.shadowDenialMatrix.map(row => [row.scenario, row.expectedReason])
  );
  assert.equal(matrixByScenario.size, 19);
  const missingOwnersScaling = withConcurrency(baseInput, {
    maxConcurrentAgents: 3,
    policyMaxActive: 3,
    localMaxConcurrency: 3,
    scalingApproval: {
      approved: true,
      approvedMaxConcurrentAgents: 3,
      measuredCapacityVerified: true,
      includedQuotaVerified: true,
      zeroIncrementalSpendVerified: true,
      approver: 'synthetic-spellbook-repo-owner'
    }
  });
  delete missingOwnersScaling.authorization.repositoryOwners;
  const replayMatrix = [
    [
      'lower-policy-line-coverage-to-generic-95-baseline',
      withPolicyCoverage(baseInput, { line: 95, branch: 90 }, { minLineCoverage: 95 })
    ],
    [
      'raise-concurrent-agents-to-3-without-scaling-approval',
      withConcurrency(baseInput, {
        maxConcurrentAgents: 3,
        policyMaxActive: 3,
        localMaxConcurrency: 3,
        scalingApproval: null
      })
    ],
    [
      'path-only-owner-cannot-approve-scaling-above-2',
      withConcurrency(baseInput, {
        maxConcurrentAgents: 3,
        policyMaxActive: 3,
        localMaxConcurrency: 3,
        scalingApproval: {
          approved: true,
          approvedMaxConcurrentAgents: 3,
          measuredCapacityVerified: true,
          includedQuotaVerified: true,
          zeroIncrementalSpendVerified: true,
          approver: 'synthetic-ios-owner'
        }
      })
    ],
    ['missing-repository-owner-evidence-retains-2-agent-cap', missingOwnersScaling],
    [
      'omit-webkit-ios-or-release-readiness-check-role',
      { ...baseInput, requiredCheckRoles: { webkit: baseInput.requiredCheckRoles.webkit } }
    ],
    [
      'candidate-stale-head',
      { ...baseInput, candidate: structuredClone(baseInput.spellbookShadowDenials.staleHead) }
    ],
    [
      'candidate-95-percent-line-coverage-below-97-floor',
      {
        ...baseInput,
        candidate: structuredClone(baseInput.spellbookShadowDenials.lowered95LineCoverage)
      }
    ],
    [
      'candidate-89-percent-branch-coverage-below-90-floor',
      {
        ...baseInput,
        candidate: structuredClone(baseInput.spellbookShadowDenials.loweredBranchCoverage)
      }
    ],
    [
      'candidate-webkit-check-failed',
      {
        ...baseInput,
        candidate: structuredClone(baseInput.spellbookShadowDenials.webkitCheckFailed)
      }
    ],
    [
      'candidate-ios-check-failed',
      {
        ...baseInput,
        candidate: structuredClone(baseInput.spellbookShadowDenials.iosCheckFailed)
      }
    ],
    [
      'candidate-release-readiness-check-missing',
      {
        ...baseInput,
        candidate: structuredClone(baseInput.spellbookShadowDenials.releaseCheckFailed)
      }
    ],
    [
      'candidate-concurrency-cap-at-2-active-agents',
      {
        ...baseInput,
        candidate: structuredClone(baseInput.spellbookShadowDenials.concurrencyCapReached)
      }
    ],
    [
      'candidate-stale-or-dismissed-or-commented-bot-review',
      {
        ...baseInput,
        candidate: structuredClone(baseInput.onboardingPackage.replaySuite.commentedBotReview)
      }
    ],
    [
      'candidate-wrong-repository',
      {
        ...baseInput,
        candidate: structuredClone(baseInput.onboardingPackage.replaySuite.wrongRepository)
      }
    ],
    [
      'candidate-missing-quota',
      {
        ...baseInput,
        candidate: structuredClone(baseInput.onboardingPackage.replaySuite.missingQuota)
      }
    ],
    [
      'duplicate-open-pr-for-same-issue-or-head',
      {
        ...baseInput,
        openPullRequests: [
          { pr: 204, issue: 103, head },
          { pr: 205, issue: 103, head: altHead }
        ]
      }
    ],
    ['stop-switch-active-or-kill-switch-tripped', { ...baseInput, stopSwitchActive: true }],
    ['couple-spellbook-to-familyhub-or-m02-speed', { ...baseInput, dependsOnFamilyHub: true }],
    [
      'enable-production-release',
      {
        ...baseInput,
        authorization: { ...baseInput.authorization, productionReleaseEnabled: true }
      }
    ]
  ];
  for (const [scenario, candidateInput] of replayMatrix) {
    assert.equal(
      evaluateSpellbookShadowReadiness(candidateInput).reason,
      matrixByScenario.get(scenario),
      `Mismatch for scenario ${scenario}`
    );
  }
});

test('rejects live and revoked proxies, getters, non-enumerable properties, symbols, and malformed candidate snapshots without invoking traps', () => {
  const baseInput = readyInput();
  let traps = 0;
  const trap = () => {
    traps += 1;
    throw new Error('caller trap or getter must never execute');
  };

  const liveProxyInput = new Proxy(baseInput, {
    get: trap,
    getOwnPropertyDescriptor: trap,
    getPrototypeOf: trap,
    ownKeys: trap
  });
  const revokedInput = Proxy.revocable(baseInput, {});
  revokedInput.revoke();

  const revokedScaling = Proxy.revocable({}, {});
  revokedScaling.revoke();

  const getterInput = { ...baseInput };
  Object.defineProperty(getterInput, 'm01AutonomousAccepted', { enumerable: true, get: trap });

  const nonEnumInput = { ...baseInput };
  Object.defineProperty(nonEnumInput, 'm01AutonomousAccepted', {
    value: true,
    enumerable: false,
    configurable: true
  });

  const symbolKeyInput = { ...baseInput, [Symbol('extra')]: 1 };
  const missingKeyInput = { ...baseInput };
  delete missingKeyInput.maxConcurrentAgents;

  const getterAuth = { ...baseInput.authorization };
  Object.defineProperty(getterAuth, 'ownerAuthorized', { enumerable: true, get: trap });

  const getterScaling = {
    approved: true,
    approvedMaxConcurrentAgents: 4,
    measuredCapacityVerified: true,
    includedQuotaVerified: true,
    zeroIncrementalSpendVerified: true,
    approver: 'owner'
  };
  Object.defineProperty(getterScaling, 'approved', { enumerable: true, get: trap });

  for (const bad of [
    null,
    'not-an-object',
    [],
    Object.create(null),
    liveProxyInput,
    revokedInput.proxy,
    getterInput,
    nonEnumInput,
    symbolKeyInput,
    missingKeyInput,
    { ...baseInput, extraUnknownKey: true },
    { ...baseInput, m01AutonomousAccepted: 'true' },
    { ...baseInput, familyTreePilotAccepted: 1 },
    { ...baseInput, onboardingContractAccepted: null },
    { ...baseInput, spellbookRepoReadinessAccepted: 0 },
    { ...baseInput, dependsOnFamilyHub: 'false' },
    { ...baseInput, dependsOnM02Speed: null },
    { ...baseInput, stopSwitchActive: 0 },
    { ...baseInput, maxConcurrentAgents: 0 },
    { ...baseInput, maxConcurrentAgents: -1 },
    { ...baseInput, maxConcurrentAgents: 1.5 },
    { ...baseInput, scalingApproval: 'invalid' },
    { ...baseInput, scalingApproval: revokedScaling.proxy },
    { ...baseInput, scalingApproval: getterScaling },
    {
      ...baseInput,
      scalingApproval: {
        approved: true,
        approvedMaxConcurrentAgents: 0,
        measuredCapacityVerified: true,
        includedQuotaVerified: true,
        zeroIncrementalSpendVerified: true,
        approver: 'owner'
      }
    },
    {
      ...baseInput,
      scalingApproval: {
        approved: true,
        approvedMaxConcurrentAgents: 4,
        measuredCapacityVerified: true,
        includedQuotaVerified: true,
        zeroIncrementalSpendVerified: true,
        approver: '  padded '
      }
    },
    { ...baseInput, authorization: null },
    { ...baseInput, authorization: getterAuth },
    { ...baseInput, authorization: { ...baseInput.authorization, repository: '' } },
    { ...baseInput, authorization: { ...baseInput.authorization, repositoryId: 0 } },
    { ...baseInput, authorization: { ...baseInput.authorization, repositoryOwners: 'not-array' } },
    { ...baseInput, authorization: { ...baseInput.authorization, repositoryOwners: [''] } },
    {
      ...baseInput,
      authorization: {
        ...baseInput.authorization,
        repositoryOwners: ['copilot-swe-agent[bot]']
      }
    },
    {
      ...baseInput,
      authorization: {
        ...baseInput.authorization,
        repositoryOwners: ['owner-a', 'OWNER-A']
      }
    },
    { ...baseInput, authorization: { ...baseInput.authorization, pinnedWorkflowSha: 'bad' } },
    { ...baseInput, authorization: { ...baseInput.authorization, pinnedCheckoutSha: 'bad' } },
    { ...baseInput, authorization: { ...baseInput.authorization, zeroIncrementalSpendVerified: 'yes' } },
    { ...baseInput, authorization: { ...baseInput.authorization, productionReleaseEnabled: 'no' } }
  ]) {
    const res = evaluateSpellbookShadowReadiness(bad);
    assert.equal(res.valid, false);
    assert.equal(res.ready, false);
    assert.equal(res.reason, 'INPUT_SCHEMA_INVALID');
  }

  const proxyCandidate = new Proxy(baseInput.candidate, { get: trap, getOwnPropertyDescriptor: trap });
  const revokedPaths = Proxy.revocable(baseInput.candidate.paths, {});
  revokedPaths.revoke();
  const sparsePaths = new Array(1);
  const getterPaths = [...baseInput.candidate.paths];
  Object.defineProperty(getterPaths, 0, { enumerable: true, get: trap });

  for (const badCandidate of [
    null,
    proxyCandidate,
    { ...baseInput.candidate, coverage: null },
    { ...baseInput.candidate, paths: revokedPaths.proxy },
    { ...baseInput.candidate, paths: sparsePaths },
    { ...baseInput.candidate, paths: getterPaths },
    { ...baseInput.candidate, dependencies: [{}] },
    { ...baseInput.candidate, checks: [{}] },
    { ...baseInput.candidate, reviews: [{}] },
    {
      ...baseInput.candidate,
      reviews: [{ reviewer: 'r', head, state: 'APPROVED', summaryDisposition: 'clear' }]
    },
    {
      ...baseInput.candidate,
      reviews: [{ reviewer: 'r', head, state: 'COMMENTED', summaryDisposition: 123 }]
    },
    { ...baseInput.candidate, author: '' },
    { ...baseInput.candidate, agent: '   ' },
    { ...baseInput.candidate, issue: 0 },
    { ...baseInput.candidate, head: 'bad' },
    { ...baseInput.candidate, rateLimited: 'false' },
    { ...baseInput.candidate, remainingCredits: '40' },
    { ...baseInput.candidate, activeCount: -1 },
    { ...baseInput.candidate, priority: 1.5 },
    { ...baseInput.candidate, paths: [''] },
    { ...baseInput.candidate, dependencies: [{ issue: 0, accepted: true }] },
    { ...baseInput.candidate, dependencies: [{ issue: 1, accepted: 'yes' }] },
    {
      ...baseInput.candidate,
      coverage: { ...baseInput.candidate.coverage, head: 'bad' }
    },
    {
      ...baseInput.candidate,
      coverage: { ...baseInput.candidate.coverage, line: 101 }
    },
    {
      ...baseInput.candidate,
      coverage: { ...baseInput.candidate.coverage, branch: -1 }
    },
    {
      ...baseInput.candidate,
      coverage: { ...baseInput.candidate.coverage, complete: 'true' }
    },
    {
      ...baseInput.candidate,
      reviews: [{ reviewer: 'r', head, state: 'INVALID_STATE' }]
    }
  ]) {
    assert.equal(
      evaluateSpellbookShadowReadiness({ ...baseInput, candidate: badCandidate }).reason,
      'CANDIDATE_SNAPSHOT_INVALID'
    );
  }

  // Callable Proxy scalars in onboardingPackage.replaySuite and rollback.peerPackages fail closed without invoking traps
  const callableScalarProxy = new Proxy(() => {}, {
    apply: trap,
    get: trap,
    getOwnPropertyDescriptor: trap,
    getPrototypeOf: trap,
    ownKeys: trap
  });
  const injectCallableReplayRepo = targetPkg => {
    const mutated = structuredClone(targetPkg);
    for (const key of [
      'eligibleCandidate',
      'staleReview',
      'dismissedReview',
      'commentedBotReview',
      'missingQuota'
    ]) {
      mutated.replaySuite[key].repository = callableScalarProxy;
    }
    return mutated;
  };

  const callablePrimaryInput = readyInput();
  callablePrimaryInput.onboardingPackage = injectCallableReplayRepo(
    callablePrimaryInput.onboardingPackage
  );
  const primaryCallableRes = evaluateSpellbookShadowReadiness(callablePrimaryInput);
  assert.equal(primaryCallableRes.ready, false);
  assert.equal(primaryCallableRes.reason, 'SHADOW_REPLAY_INCOMPLETE');

  const callablePeerInput = readyInput();
  callablePeerInput.rollback.peerPackages = [
    injectCallableReplayRepo(callablePeerInput.rollback.peerPackages[0])
  ];
  const peerCallableRes = evaluateSpellbookShadowReadiness(callablePeerInput);
  assert.equal(peerCallableRes.ready, false);
  assert.equal(peerCallableRes.reason, 'SINGLE_PR_ROLLBACK_INVALID');

  // Non-plain onboardingPackage / peerPackages pass through sanitizeOnboardingPackage cleanly without traps
  assert.equal(
    evaluateSpellbookShadowReadiness({ ...baseInput, onboardingPackage: null }).reason,
    'PACKAGE_INVALID'
  );
  const getterPkg = { ...baseInput.onboardingPackage };
  Object.defineProperty(getterPkg, 'replaySuite', { enumerable: true, get: trap });
  assert.equal(
    evaluateSpellbookShadowReadiness({ ...baseInput, onboardingPackage: getterPkg }).reason,
    'PACKAGE_INVALID'
  );

  assert.equal(traps, 0);
});
