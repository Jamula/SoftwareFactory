import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  FACTORY_REPOSITORY_ID
} from '../../tools/engineering-factory/consumer-onboarding.mjs';
import {
  FAMILYHUB_ISSUE_NUMBER,
  FAMILYHUB_MILESTONE_ID,
  FAMILYHUB_MIN_COVERAGE,
  FAMILYHUB_READINESS_ISSUE_NUMBER,
  FAMILYHUB_REQUIRED_CHECK_CONTEXTS,
  UPSTREAM_M01_ISSUE_NUMBER,
  UPSTREAM_ONBOARDING_ISSUE_NUMBER,
  UPSTREAM_SPELLBOOK_ISSUE_NUMBER,
  evaluateFamilyHubShadowReadiness
} from '../../tools/engineering-factory/familyhub-pilot-readiness.mjs';

const evidenceRaw = await readFile(
  new URL('../../docs/evidence/m05-01-familyhub-shadow-readiness.json', import.meta.url),
  'utf8'
);
const evidence = JSON.parse(evidenceRaw);
const shadowWorkflowSource = await readFile(
  new URL('../../.github/workflows/shadow-tests.yml', import.meta.url),
  'utf8'
);
const checkoutRefMatch = shadowWorkflowSource.match(/^\s*ref:\s*(\S+)\s*$/m);
assert.ok(checkoutRefMatch, 'shadow-tests.yml must declare an immutable checkout ref');

const HEAD_SHA = 'a'.repeat(40);
const MAIN_SHA = 'b'.repeat(40);
const STALE_SHA = 'c'.repeat(40);
const BEHIND_MAIN_SHA = 'd'.repeat(40);

function makeReadyFixture() {
  const f = structuredClone(evidence.syntheticFixture);
  f.migrationCompleteVerified = true;
  f.ownerFreezeLiftedVerified = true;
  f.authoritativeRepoConfirmed = true;
  f.m01AutonomousAccepted = true;
  f.spellbookPilotAccepted = true;
  f.familyTreePilotAccepted = false;
  f.m02SpeedAccepted = false;
  f.authorization.separateScopedOwnerAuth = true;
  f.authorization.familyHubReadiness81Verified = true;
  f.onboardingPackage.ownerAuthorized = true;
  f.onboardingPackage.migrationFreezeClear = true;
  return f;
}

test('M05.01 FamilyHub constants and outputs are frozen and strictly read-only', () => {
  assert.equal(FAMILYHUB_MILESTONE_ID, 'M05.01');
  assert.equal(FAMILYHUB_ISSUE_NUMBER, 12);
  assert.equal(FAMILYHUB_READINESS_ISSUE_NUMBER, 81);
  assert.equal(UPSTREAM_M01_ISSUE_NUMBER, 10);
  assert.equal(UPSTREAM_ONBOARDING_ISSUE_NUMBER, 13);
  assert.equal(UPSTREAM_SPELLBOOK_ISSUE_NUMBER, 11);
  assert.equal(Object.isFrozen(FAMILYHUB_REQUIRED_CHECK_CONTEXTS), true);
  assert.deepEqual(FAMILYHUB_REQUIRED_CHECK_CONTEXTS, ['copilot-review', 'validate']);
  assert.equal(Object.isFrozen(FAMILYHUB_MIN_COVERAGE), true);
  assert.deepEqual(FAMILYHUB_MIN_COVERAGE, { line: 95, branch: 90 });

  const blocked = evaluateFamilyHubShadowReadiness(structuredClone(evidence.syntheticFixture));
  assert.equal(Object.isFrozen(blocked), true);
  const ready = evaluateFamilyHubShadowReadiness(makeReadyFixture());
  assert.equal(Object.isFrozen(ready), true);
  assert.equal( Object.isFrozen(ready.unaffectedPeers), true);
});

test('recorded M05.01 evidence JSON reproduces CONSUMER_FROZEN and all synthetic shadow scenarios', () => {
  assert.equal(evidence.milestone, 'M05.01');
  assert.equal(evidence.issue, 12);
  assert.equal(evidence.syntheticOnly, true);
  assert.equal(evidence.containsPrivateFamilyData, false);
  assert.equal(evidence.mutatesFrozenConsumer, false);
  assert.equal(evidence.currentPosture.ownerFreezeLiftedVerified, false);
  assert.equal(
    evidence.syntheticFixture.onboardingPackage.workflowPin.reviewedCheckoutSha,
    checkoutRefMatch[1]
  );
  assert.equal(evidenceRaw.toLowerCase().includes('jamula/familyhub'), false);

  const defaultDecision = evaluateFamilyHubShadowReadiness(structuredClone(evidence.syntheticFixture));
  assert.deepEqual(defaultDecision, evidence.currentPosture.expectedDecision);
  assert.equal(defaultDecision.reason, 'CONSUMER_FROZEN');
  assert.equal(defaultDecision.liveActivation, false);
  assert.equal(defaultDecision.liveProductionDeployAllowed, false);

  const scenarioInputs = {
    'freeze-active-default-posture': () => structuredClone(evidence.syntheticFixture),
    'm01-upstream-unaccepted': () => {
      const f = makeReadyFixture();
      f.m01AutonomousAccepted = false;
      return f;
    },
    'spellbook-pilot-unaccepted': () => {
      const f = makeReadyFixture();
      f.spellbookPilotAccepted = false;
      return f;
    },
    'commented-only-review-zero-threads': () => {
      const f = makeReadyFixture();
      f.candidate.snapshot.reviews = [
        {
          reviewer: 'copilot-pull-request-reviewer[bot]',
          head: HEAD_SHA,
          state: 'COMMENTED',
          summaryDisposition: 'clear'
        }
      ];
      return f;
    },
    'stale-or-dismissed-review': () => {
      const f = makeReadyFixture();
      f.candidate.snapshot.reviews = [
        { reviewer: 'synthetic-hub-reviewer', head: STALE_SHA, state: 'APPROVED' }
      ];
      return f;
    },
    'behind-main-stale-base': () => {
      const f = makeReadyFixture();
      f.candidate.candidateBaseSha = BEHIND_MAIN_SHA;
      return f;
    },
    'missing-copilot-review-or-validate-check': () => {
      const f = makeReadyFixture();
      f.candidate.snapshot.checks = f.candidate.snapshot.checks.filter(
        c => c.name !== 'copilot-review'
      );
      return f;
    },
    'production-deploy-not-isolated': () => {
      const f = makeReadyFixture();
      f.liveProductionDeployAllowed = true;
      return f;
    },
    'hypothetical-shadow-ready-independent-of-familytree-and-m02': () => makeReadyFixture()
  };

  for (const item of evidence.verifiedShadowScenarios) {
    const decision = evaluateFamilyHubShadowReadiness(scenarioInputs[item.scenario]());
    assert.equal(decision.reason, item.expectedReason, item.scenario);
    assert.equal(decision.ready, item.ready, item.scenario);
    assert.equal(decision.liveActivation, false, item.scenario);
    assert.equal(decision.liveProductionDeployAllowed, false, item.scenario);
    assert.equal(decision.mutatesGitHub, false, item.scenario);
  }
});

test('strictly rejects proxies, custom prototypes, accessors, non-enumerable keys, sparse arrays, and bad types', () => {
  const valid = makeReadyFixture();
  const getterInput = { ...valid };
  Object.defineProperty(getterInput, 'stop', { get: () => false, enumerable: true });

  const nonEnumInput = { ...valid };
  Object.defineProperty(nonEnumInput, 'stop', { value: false, enumerable: false });

  const sparsePeers = [];
  sparsePeers.length = 1;

  const getterPeerArray = [valid.peerOnboardingPackages[0]];
  Object.defineProperty(getterPeerArray, '0', {
    get: () => valid.peerOnboardingPackages[0],
    enumerable: true
  });

  const protoArray = Object.setPrototypeOf([valid.peerOnboardingPackages[0]], Object.prototype);
  const oversizedPeers = Array.from({ length: 65 }, (_, idx) => ({ idx }));
  const oversizedKeysObj = Object.fromEntries(Array.from({ length: 65 }, (_, idx) => [`k${idx}`, idx]));
  let tooDeep = { leaf: 1 };
  for (let i = 0; i < 14; i += 1) {
    tooDeep = { child: tooDeep };
  }
  const cyclicArray = [];
  cyclicArray.push(cyclicArray);
  let sharedSubtreeDag = ['leaf'];
  for (let i = 0; i < 10; i += 1) {
    sharedSubtreeDag = [sharedSubtreeDag, sharedSubtreeDag];
  }
  const startDagMs = performance.now();
  assert.equal(
    evaluateFamilyHubShadowReadiness({
      ...structuredClone(valid),
      peerOnboardingPackages: sharedSubtreeDag
    }).reason,
    'INPUT_SCHEMA_INVALID'
  );
  assert.equal(performance.now() - startDagMs < 200, true);
  const budgetOverflowTree = Array.from({ length: 60 }, () =>
    Array.from({ length: 60 }, () => ({ a: 1, b: 2 }))
  );

  for (const malformed of [
    null,
    undefined,
    'fixture',
    42,
    [],
    Object.create(null),
    new Proxy(structuredClone(valid), {}),
    { ...valid, extraKey: true },
    getterInput,
    nonEnumInput,
    { ...valid, stop: 'false' },
    { ...valid, authorization: new Proxy(structuredClone(valid.authorization), {}) },
    { ...valid, authorization: { ...valid.authorization, separateScopedOwnerAuth: 'true' } },
    { ...valid, authorization: { ...valid.authorization, authorizedRepository: 123 } },
    { ...valid, authorization: { ...valid.authorization, authorizedRepository: '' } },
    { ...valid, authorization: { ...valid.authorization, authorizedRepository: ' padded/repo ' } },
    { ...valid, authorization: { ...valid.authorization, authorizedRepository: 'bad\u0000/repo' } },
    { ...valid, authorization: { ...valid.authorization, authorizedRepository: 'noslash' } },
    { ...valid, authorization: { ...valid.authorization, authorizedRepository: 'example/..' } },
    { ...valid, authorization: { ...valid.authorization, authorizedRepository: `example/${'x'.repeat(200)}` } },
    { ...valid, authorization: { ...valid.authorization, authorizedRepositoryId: 0 } },
    { ...valid, authorization: { ...valid.authorization, authorizedRepositoryId: '900303' } },
    { ...valid, onboardingPackage: null },
    { ...valid, onboardingPackage: new Proxy(structuredClone(valid.onboardingPackage), {}) },
    { ...valid, onboardingPackage: { ...valid.onboardingPackage, migrationFreezeClear: 'true' } },
    { ...valid, onboardingPackage: { ...valid.onboardingPackage, policy: null } },
    {
      ...valid,
      onboardingPackage: {
        ...valid.onboardingPackage,
        policy: { ...valid.onboardingPackage.policy, repository: 'invalid_slug' }
      }
    },
    { ...valid, peerOnboardingPackages: new Proxy(valid.peerOnboardingPackages, {}) },
    { ...valid, peerOnboardingPackages: [] },
    { ...valid, peerOnboardingPackages: sparsePeers },
    { ...valid, peerOnboardingPackages: getterPeerArray },
    { ...valid, peerOnboardingPackages: protoArray },
    { ...valid, peerOnboardingPackages: oversizedPeers },
    { ...valid, candidate: { ...valid.candidate, candidateHeadSha: 123 } },
    { ...valid, candidate: { ...valid.candidate, candidateHeadSha: 'ABCD' } },
    { ...valid, candidate: { ...valid.candidate, behindByCommits: -1 } },
    { ...valid, candidate: { ...valid.candidate, behindByCommits: '0' } },
    { ...valid, candidate: { ...valid.candidate, triggersProductionDeploy: 'false' } },
    { ...valid, candidate: { ...valid.candidate, componentInventory: [] } },
    { ...valid, candidate: { ...valid.candidate, componentInventory: [''] } },
    { ...valid, candidate: { ...valid.candidate, coverageReports: [] } },
    {
      ...valid,
      candidate: {
        ...valid.candidate,
        reviewSummary: { ...valid.candidate.reviewSummary, summaryDisposition: '' }
      }
    },
    {
      ...valid,
      candidate: {
        ...valid.candidate,
        reviewSummary: { ...valid.candidate.reviewSummary, unresolvedSummaryFindings: -1 }
      }
    },
    {
      ...valid,
      candidate: {
        ...valid.candidate,
        reviewSummary: { ...valid.candidate.reviewSummary, unresolvedInlineThreads: -1 }
      }
    },
    {
      ...valid,
      candidate: {
        ...valid.candidate,
        snapshot: { ...valid.candidate.snapshot, author: '' }
      }
    },
    {
      ...valid,
      candidate: {
        ...valid.candidate,
        snapshot: { ...valid.candidate.snapshot, agent: '' }
      }
    },
    {
      ...valid,
      candidate: {
        ...valid.candidate,
        snapshot: { ...valid.candidate.snapshot, coverage: null }
      }
    },
    {
      ...valid,
      candidate: {
        ...valid.candidate,
        snapshot: { ...valid.candidate.snapshot, paths: [''] }
      }
    },
    {
      ...valid,
      candidate: {
        ...valid.candidate,
        snapshot: { ...valid.candidate.snapshot, dependencies: [{ issue: 1 }] }
      }
    },
    {
      ...valid,
      candidate: {
        ...valid.candidate,
        snapshot: { ...valid.candidate.snapshot, checks: [{ name: 'validate' }] }
      }
    },
    {
      ...valid,
      candidate: {
        ...valid.candidate,
        snapshot: {
          ...valid.candidate.snapshot,
          reviews: [{ reviewer: 'r', head: HEAD_SHA, state: 'APPROVED', summaryDisposition: 'clear' }]
        }
      }
    },
    {
      ...valid,
      candidate: {
        ...valid.candidate,
        snapshot: {
          ...valid.candidate.snapshot,
          reviews: [{ reviewer: 'r', head: 'bad', state: 'APPROVED' }]
        }
      }
    },
    {
      ...valid,
      candidate: {
        ...valid.candidate,
        snapshot: {
          ...valid.candidate.snapshot,
          reviews: [{ reviewer: 'r', head: HEAD_SHA, state: '' }]
        }
      }
    },
    {
      ...valid,
      candidate: {
        ...valid.candidate,
        snapshot: {
          ...valid.candidate.snapshot,
          reviews: [{ reviewer: 'r', head: HEAD_SHA, state: 'COMMENTED', summaryDisposition: '' }]
        }
      }
    },
    { ...valid, shadowDenialSuite: null },
    { ...valid, rollbackReceipt: null },
    { ...valid, rollbackReceipt: new Proxy(structuredClone(valid.rollbackReceipt), {}) },
    { ...valid, rollbackReceipt: { ...valid.rollbackReceipt, repository: 'invalid_slug' } },
    { ...valid, rollbackReceipt: { ...valid.rollbackReceipt, [Symbol('hidden')]: 1 } },
    { ...valid, rollbackReceipt: { ...valid.rollbackReceipt, queuedLiveMutations: Number.NaN } },
    { ...structuredClone(valid), rollbackReceipt: oversizedKeysObj },
    { ...structuredClone(valid), rollbackReceipt: tooDeep },
    { ...structuredClone(valid), peerOnboardingPackages: cyclicArray },
    { ...structuredClone(valid), peerOnboardingPackages: sharedSubtreeDag },
    { ...structuredClone(valid), rollbackReceipt: { tree: budgetOverflowTree } },
    {
      ...structuredClone(valid),
      candidate: {
        ...structuredClone(valid.candidate),
        snapshot: { ...structuredClone(valid.candidate.snapshot), repository: 'invalid_slug' }
      }
    }
  ]) {
    assert.equal(evaluateFamilyHubShadowReadiness(malformed).reason, 'INPUT_SCHEMA_INVALID');
  }
});

test('enforces synthetic-only isolation and forbids live Jamula/FamilyHub or private family data even while frozen', () => {
  const frozen = structuredClone(evidence.syntheticFixture);

  for (const mutate of [
    f => { f.syntheticFixtureOnly = false; },
    f => { f.containsPrivateFamilyData = true; },
    f => { f.candidate.snapshot.author = 'member@family-private.org'; },
    f => { f.authorization.authorizedRepository = 'Jamula/FamilyHub'; },
    f => { f.onboardingPackage.policy.repository = 'jamula/familyhub'; },
    f => { f.onboardingPackage.replaySuite.wrongRepository.repository = 'Jamula/FamilyHub'; },
    f => { f.peerOnboardingPackages[0].policy.repository = 'Jamula/FamilyHub'; },
    f => { f.candidate.snapshot.repository = 'Jamula/FamilyHub'; },
    f => { f.rollbackReceipt.repository = 'Jamula/FamilyHub'; },
    f => { f.authorization.authorizedRepository = 'Jamula/SoftwareFactory'; },
    f => { f.onboardingPackage.policy.repository = 'Jamula/SoftwareFactory'; },
    f => { f.onboardingPackage.repositoryId = FACTORY_REPOSITORY_ID; },
    f => { f.peerOnboardingPackages[0].repositoryId = FACTORY_REPOSITORY_ID; },
    f => { f.peerOnboardingPackages[0].policy.repository = 'Jamula/SoftwareFactory'; },
    f => { f.authorization.authorizedRepositoryId = FACTORY_REPOSITORY_ID; }
  ]) {
    const candidate = structuredClone(frozen);
    mutate(candidate);
    const res = evaluateFamilyHubShadowReadiness(candidate);
    assert.equal(res.reason, 'LIVE_REPO_OR_PRIVATE_DATA_FORBIDDEN');
    assert.equal(res.ready, false);
    assert.equal(res.liveActivation, false);
  }
});

test('enforces emergency stop and Hard Freeze Gate (CONSUMER_FROZEN) across all freeze flags', () => {
  const stopped = makeReadyFixture();
  stopped.stop = true;
  assert.equal(evaluateFamilyHubShadowReadiness(stopped).reason, 'STOPPED');

  for (const mutate of [
    f => { f.migrationCompleteVerified = false; },
    f => { f.ownerFreezeLiftedVerified = false; },
    f => { f.authoritativeRepoConfirmed = false; },
    f => { f.onboardingPackage.migrationFreezeClear = false; }
  ]) {
    const candidate = makeReadyFixture();
    mutate(candidate);
    const res = evaluateFamilyHubShadowReadiness(candidate);
    assert.equal(res.reason, 'CONSUMER_FROZEN');
    assert.equal(res.ready, false);
    assert.equal(res.eligible, false);
    assert.equal(res.liveActivation, false);
    assert.equal(res.liveProductionDeployAllowed, false);
  }
});

test('requires M01 #10 and Spellbook #11 acceptance while remaining independent of FamilyTree #36 and M02', () => {
  const missingM01 = makeReadyFixture();
  missingM01.m01AutonomousAccepted = false;
  assert.equal(evaluateFamilyHubShadowReadiness(missingM01).reason, 'M01_UPSTREAM_NOT_ACCEPTED');

  const missingSpellbook = makeReadyFixture();
  missingSpellbook.spellbookPilotAccepted = false;
  assert.equal(evaluateFamilyHubShadowReadiness(missingSpellbook).reason, 'SPELLBOOK_PILOT_NOT_ACCEPTED');

  const independentFalse = makeReadyFixture();
  independentFalse.familyTreePilotAccepted = false;
  independentFalse.m02SpeedAccepted = false;
  const readyFalse = evaluateFamilyHubShadowReadiness(independentFalse);
  assert.equal(readyFalse.reason, 'FAMILYHUB_SHADOW_READY_ONLY');
  assert.equal(readyFalse.independentOfFamilyTreeAndM02, true);

  const independentTrue = makeReadyFixture();
  independentTrue.familyTreePilotAccepted = true;
  independentTrue.m02SpeedAccepted = true;
  assert.equal(evaluateFamilyHubShadowReadiness(independentTrue).reason, 'FAMILYHUB_SHADOW_READY_ONLY');
});

test('enforces production deployment isolation and separate FamilyHub-scoped owner authorization', () => {
  for (const mutate of [
    f => { f.productionDeploymentIsolated = false; },
    f => { f.liveProductionDeployAllowed = true; },
    f => { f.candidate.triggersProductionDeploy = true; },
    f => { f.onboardingPackage.productionDeployEnabled = true; }
  ]) {
    const candidate = makeReadyFixture();
    mutate(candidate);
    const res = evaluateFamilyHubShadowReadiness(candidate);
    assert.equal(res.reason, 'PRODUCTION_ISOLATION_VIOLATION');
    assert.equal(res.liveProductionDeployAllowed, false);
  }

  for (const mutate of [
    f => { f.authorization.separateScopedOwnerAuth = false; },
    f => { f.authorization.developmentResumptionOnly = true; },
    f => { f.authorization.familyHubReadiness81Verified = false; },
    f => { f.authorization.zeroIncrementalSpendVerified = false; },
    f => { f.authorization.hostedExecutionWithoutLaptopVerified = false; },
    f => { f.onboardingPackage.ownerAuthorized = false; },
    f => { f.onboardingPackage.autoActivate = true; }
  ]) {
    const candidate = makeReadyFixture();
    mutate(candidate);
    assert.equal(evaluateFamilyHubShadowReadiness(candidate).reason, 'SEPARATE_AUTHORIZATION_REQUIRED');
  }

  const wrongAuthRepo = makeReadyFixture();
  wrongAuthRepo.authorization.authorizedRepository = 'example/other-family-hub';
  assert.equal(evaluateFamilyHubShadowReadiness(wrongAuthRepo).reason, 'AUTHORIZATION_REPO_MISMATCH');

  const wrongAuthId = makeReadyFixture();
  wrongAuthId.authorization.authorizedRepositoryId = 900999;
  assert.equal(evaluateFamilyHubShadowReadiness(wrongAuthId).reason, 'AUTHORIZATION_REPO_MISMATCH');
});

test('enforces #13 onboarding contract and mandatory copilot-review and validate check declarations', () => {
  const badPin = makeReadyFixture();
  badPin.onboardingPackage.workflowPin.reviewedWorkflowSha = '2'.repeat(40);
  assert.equal(evaluateFamilyHubShadowReadiness(badPin).reason, 'PIN_SHA_MISMATCH');

  for (const omittedContext of ['copilot-review', 'validate']) {
    const missingCtx = makeReadyFixture();
    missingCtx.onboardingPackage.localGates.requiredChecks =
      missingCtx.onboardingPackage.localGates.requiredChecks.filter(c => c.name !== omittedContext);
    assert.equal(evaluateFamilyHubShadowReadiness(missingCtx).reason, 'REQUIRED_CHECKS_MISSING');
  }
});

test('enforces exact candidate head binding and strict up-to-date base freshness against latestProtectedMainSha', () => {
  for (const mutate of [
    f => { f.candidate.candidateHeadSha = MAIN_SHA; },
    f => { f.candidate.snapshot.head = STALE_SHA; },
    f => { f.candidate.snapshot.observedHead = STALE_SHA; }
  ]) {
    const candidate = makeReadyFixture();
    mutate(candidate);
    assert.equal(evaluateFamilyHubShadowReadiness(candidate).reason, 'CANDIDATE_HEAD_MISMATCH');
  }

  for (const mutate of [
    f => { f.candidate.candidateBaseSha = BEHIND_MAIN_SHA; },
    f => { f.candidate.behindByCommits = 1; },
    f => { f.candidate.snapshot.base = BEHIND_MAIN_SHA; },
    f => { f.candidate.snapshot.observedBase = BEHIND_MAIN_SHA; },
    f => { f.candidate.snapshot.baseBranch = 'main'; },
    f => { f.candidate.snapshot.baseCompatible = false; },
    f => { f.candidate.snapshot.mainHealthy = false; }
  ]) {
    const candidate = makeReadyFixture();
    mutate(candidate);
    assert.equal(evaluateFamilyHubShadowReadiness(candidate).reason, 'BASE_NOT_STRICT_UP_TO_DATE');
  }
});

test('enforces mandatory copilot-review and validate exact-head check runs from trusted producers', () => {
  for (const mutate of [
    f => {
      f.candidate.snapshot.checks = f.candidate.snapshot.checks.filter(c => c.name !== 'copilot-review');
    },
    f => {
      f.candidate.snapshot.checks = f.candidate.snapshot.checks.filter(c => c.name !== 'validate');
    },
    f => {
      f.candidate.snapshot.checks.push({ ...f.candidate.snapshot.checks[0] });
    },
    f => {
      f.candidate.snapshot.checks[0].head = STALE_SHA;
    },
    f => {
      f.candidate.snapshot.checks[1].appId = 99999;
    },
    f => {
      f.candidate.snapshot.checks[0].status = 'in_progress';
    },
    f => {
      f.candidate.snapshot.checks[1].conclusion = 'failure';
    }
  ]) {
    const candidate = makeReadyFixture();
    mutate(candidate);
    assert.equal(evaluateFamilyHubShadowReadiness(candidate).reason, 'REQUIRED_CHECKS_INCOMPLETE');
  }
});

test('enforces formal exact-head APPROVED review and strictly rejects COMMENTED-only reviews even with 0 threads', () => {
  // Even when copilot-pull-request-reviewer[bot] is explicitly allowlisted in policy.reviewers
  // and has 0 inline threads + clear summaryDisposition, COMMENTED is rejected for FamilyHub.
  const commentedAllowlisted = makeReadyFixture();
  commentedAllowlisted.onboardingPackage.policy.reviewers.push('copilot-pull-request-reviewer[bot]');
  commentedAllowlisted.onboardingPackage.replaySuite.killSwitchPolicy.reviewers.push(
    'copilot-pull-request-reviewer[bot]'
  );
  commentedAllowlisted.rollbackReceipt.postPolicy.reviewers.push('copilot-pull-request-reviewer[bot]');
  commentedAllowlisted.candidate.snapshot.threadsResolved = true;
  commentedAllowlisted.candidate.reviewSummary = {
    summaryDisposition: 'clear',
    unresolvedSummaryFindings: 0,
    unresolvedInlineThreads: 0
  };
  commentedAllowlisted.candidate.snapshot.reviews = [
    {
      reviewer: 'copilot-pull-request-reviewer[bot]',
      head: HEAD_SHA,
      state: 'COMMENTED',
      summaryDisposition: 'clear'
    }
  ];
  assert.equal(evaluateFamilyHubShadowReadiness(commentedAllowlisted).reason, 'FORMAL_APPROVAL_REQUIRED');

  for (const mutate of [
    f => { f.candidate.snapshot.reviews = []; },
    f => {
      f.candidate.snapshot.reviews = [
        { reviewer: 'synthetic-hub-reviewer', head: HEAD_SHA, state: 'APPROVED' },
        { reviewer: 'SYNTHETIC-HUB-REVIEWER', head: HEAD_SHA, state: 'APPROVED' }
      ];
    },
    f => {
      f.candidate.snapshot.reviews = [
        { reviewer: 'synthetic-hub-reviewer', head: HEAD_SHA, state: 'APPROVED' },
        {
          reviewer: 'copilot-pull-request-reviewer[bot]',
          head: HEAD_SHA,
          state: 'COMMENTED',
          summaryDisposition: 'clear'
        }
      ];
    },
    f => {
      f.candidate.snapshot.reviews = [
        { reviewer: 'synthetic-hub-reviewer', head: STALE_SHA, state: 'APPROVED' }
      ];
    },
    f => {
      f.candidate.snapshot.reviews = [
        { reviewer: 'synthetic-hub-reviewer', head: HEAD_SHA, state: 'DISMISSED' }
      ];
    },
    f => {
      f.candidate.snapshot.reviews = [
        { reviewer: 'synthetic-hub-reviewer', head: HEAD_SHA, state: 'CHANGES_REQUESTED' }
      ];
    },
    f => {
      f.candidate.snapshot.reviews = [
        { reviewer: 'untrusted-outsider', head: HEAD_SHA, state: 'APPROVED' }
      ];
    },
    f => {
      f.onboardingPackage.policy.reviewers.push('synthetic-author');
      f.onboardingPackage.replaySuite.killSwitchPolicy.reviewers.push('synthetic-author');
      f.rollbackReceipt.postPolicy.reviewers.push('synthetic-author');
      f.candidate.snapshot.reviews = [
        { reviewer: 'synthetic-author', head: HEAD_SHA, state: 'APPROVED' }
      ];
    },
    f => {
      f.onboardingPackage.policy.reviewers.push('copilot-swe-agent[bot]');
      f.onboardingPackage.replaySuite.killSwitchPolicy.reviewers.push('copilot-swe-agent[bot]');
      f.rollbackReceipt.postPolicy.reviewers.push('copilot-swe-agent[bot]');
      f.candidate.snapshot.reviews = [
        { reviewer: 'copilot-swe-agent[bot]', head: HEAD_SHA, state: 'APPROVED' }
      ];
    },
    f => { f.candidate.snapshot.threadsResolved = false; },
    f => { f.candidate.reviewSummary.unresolvedInlineThreads = 1; },
    f => { f.candidate.reviewSummary.unresolvedSummaryFindings = 1; },
    f => { f.candidate.reviewSummary.summaryDisposition = 'findings-open'; }
  ]) {
    const candidate = makeReadyFixture();
    mutate(candidate);
    assert.equal(evaluateFamilyHubShadowReadiness(candidate).reason, 'FORMAL_APPROVAL_REQUIRED');
  }
});

test('enforces stronger consumer component coverage, core shadow gates, denial suite, and independent rollback', () => {
  // 95% line / 90% branch passes consumer floor, but fails FamilyHub fixture's stricter 96% / 92% local gate.
  const belowLocalCoverage = makeReadyFixture();
  belowLocalCoverage.candidate.coverageReports[0].lines = 190; // 95.0% < 96%
  assert.equal(
    evaluateFamilyHubShadowReadiness(belowLocalCoverage).reason,
    'COVERAGE_BELOW_CONSUMER_GATE'
  );

  const securityBlocked = makeReadyFixture();
  securityBlocked.candidate.snapshot.securityClear = false;
  assert.equal(
    evaluateFamilyHubShadowReadiness(securityBlocked).reason,
    'THREADS_OR_SECURITY_UNKNOWN'
  );

  for (const mutateDenial of [
    f => { f.shadowDenialSuite.staleReview = null; },
    f => { f.shadowDenialSuite.staleReview.remainingCredits = null; },
    f => {
      // Object-for-string substitution on scalar field must fail closed without throwing.
      f.shadowDenialSuite.behindMainCandidate.baseBranch = {
        a: {},
        1: 'r',
        2: 'u',
        3: 'n',
        4: 'k'
      };
    },
    f => {
      // Indexed object matching string length must fail singleMutation.
      f.shadowDenialSuite.behindMainCandidate.baseBranch = {
        0: 't',
        1: 'r',
        2: 'u',
        3: 'n',
        4: 'k'
      };
    },
    f => { f.shadowDenialSuite.behindMainCandidate.baseBranch = ['t', 'r', 'u', 'n', 'k']; },
    f => { f.shadowDenialSuite.staleReview.paths = ['app/a.ts', 'app/b.ts']; },
    f => { f.shadowDenialSuite.staleReview.paths = ['app/different.ts']; },
    f => { f.shadowDenialSuite.staleReview.coverage.line = 99; },
    f => {
      f.candidate.snapshot.reviews = [
        { reviewer: 'synthetic-hub-reviewer', head: HEAD_SHA, state: 'APPROVED' }
      ];
      f.shadowDenialSuite.behindMainCandidate.reviews = [
        {
          reviewer: 'copilot-pull-request-reviewer[bot]',
          head: HEAD_SHA,
          state: 'COMMENTED',
          summaryDisposition: 'clear'
        }
      ];
    },
    f => {
      f.shadowDenialSuite.staleReview.reviews = [
        { reviewer: 'synthetic-hub-reviewer', head: HEAD_SHA, state: 'APPROVED' }
      ];
    },
    f => {
      // Exact-head untrusted outsider must not masquerade as a stale-review proof.
      f.shadowDenialSuite.staleReview.reviews = [
        { reviewer: 'untrusted-outsider', head: STALE_SHA, state: 'APPROVED' }
      ];
    },
    f => {
      // Self-review must not masquerade as a COMMENTED bot review proof.
      f.shadowDenialSuite.commentedZeroThreadsReview.reviews = [
        {
          reviewer: 'synthetic-author',
          head: HEAD_SHA,
          state: 'COMMENTED',
          summaryDisposition: 'clear'
        }
      ];
    },
    f => {
      f.shadowDenialSuite.behindMainCandidate.base = MAIN_SHA;
    },
    f => {
      f.shadowDenialSuite.dismissedReview.reviews = [];
    },
    f => {
      f.shadowDenialSuite.dismissedReview.reviews = [
        { reviewer: 'untrusted-outsider', head: HEAD_SHA, state: 'DISMISSED' }
      ];
    },
    f => {
      f.shadowDenialSuite.commentedZeroThreadsReview.reviews = [];
    },
    f => {
      // Empty checks drops all contexts rather than isolating copilot-review alone.
      f.shadowDenialSuite.missingCopilotReviewCheck.checks = [];
    },
    f => {
      // Dropping both copilot-review and validate fails isolated single-check omission.
      f.shadowDenialSuite.missingCopilotReviewCheck.checks = structuredClone(
        f.candidate.snapshot.checks.filter(c => c.name === 'fictional-hub-gate')
      );
    },
    f => {
      // Empty checks drops all contexts rather than isolating validate alone.
      f.shadowDenialSuite.missingValidateCheck.checks = [];
    },
    f => {
      f.shadowDenialSuite.missingCopilotReviewCheck.checks = structuredClone(
        f.candidate.snapshot.checks
      );
    },
    f => {
      f.shadowDenialSuite.missingValidateCheck.checks = structuredClone(
        f.candidate.snapshot.checks
      );
    }
  ]) {
    const candidate = makeReadyFixture();
    mutateDenial(candidate);
    assert.equal(
      evaluateFamilyHubShadowReadiness(candidate).reason,
      'SHADOW_DENIAL_PROOF_INCOMPLETE'
    );
  }

  // Case-variant Copilot reviewer already in policy.reviewers must deduplicate case-insensitively.
  const caseVariantAllowlist = makeReadyFixture();
  caseVariantAllowlist.onboardingPackage.policy.reviewers.push('Copilot-Pull-Request-Reviewer[bot]');
  caseVariantAllowlist.onboardingPackage.replaySuite.killSwitchPolicy.reviewers.push(
    'Copilot-Pull-Request-Reviewer[bot]'
  );
  caseVariantAllowlist.rollbackReceipt.postPolicy.reviewers.push('Copilot-Pull-Request-Reviewer[bot]');
  assert.equal(
    evaluateFamilyHubShadowReadiness(caseVariantAllowlist).reason,
    'FAMILYHUB_SHADOW_READY_ONLY'
  );

  for (const mutateRollback of [
    f => { f.rollbackReceipt.queuedLiveMutations = 1; },
    f => { f.rollbackReceipt.pinRevertedViaReviewedPr = false; },
    f => { f.peerOnboardingPackages[0].credentials.credentialId = 'cred-shadow-family-hub'; }
  ]) {
    const candidate = makeReadyFixture();
    mutateRollback(candidate);
    assert.equal(
      evaluateFamilyHubShadowReadiness(candidate).reason,
      'INDEPENDENT_ROLLBACK_UNVERIFIED'
    );
  }

  const ready = evaluateFamilyHubShadowReadiness(makeReadyFixture());
  assert.deepEqual(ready, {
    milestone: 'M05.01',
    issue: 12,
    shadow: true,
    ready: true,
    eligible: true,
    liveActivation: false,
    liveProductionDeployAllowed: false,
    mutatesGitHub: false,
    independentOfFamilyTreeAndM02: true,
    state: 'shadow-ready',
    reason: 'FAMILYHUB_SHADOW_READY_ONLY',
    repository: 'example/family-hub',
    repositoryId: 900303,
    pinnedWorkflowSha: 'afc3d223f287b029db32672908097efc67a259c9',
    pinnedCheckoutSha: checkoutRefMatch[1],
    candidateHeadSha: HEAD_SHA,
    protectedBaseSha: MAIN_SHA,
    rollbackTargetDecision: 'STOPPED',
    unaffectedPeers: ['example/family-tree']
  });
});
