import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICAL_PROVENANCE_STAGES,
  EXACT_PROTECTED_CONTROL_PLANE_PATHS,
  evaluateAntiRogueCircuitBreaker,
  isProtectedControlPlanePath,
  isSafeRepoRelativePath,
  isWithinOwnedPaths,
  parseTraceparent,
  verifyCausalProvenanceChain
} from '../../tools/engineering-factory/anti-rogue-audit.mjs';
import {createExecutionReceipt} from '../../tools/engineering-factory/telemetry.mjs';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const LOCK_SHA256 = 'a'.repeat(64);
const COMMIT_SHA = '1'.repeat(40);
const SQUASH_SHA = '2'.repeat(40);
const OTHER_SHA = '3'.repeat(40);
const CONSUMER_REPO_ID = 2222222222;

function spanHex(index) {
  return index.toString(16).padStart(16, '0');
}

function buildValidChain() {
  return {
    stages: {
      eventDelivery: {
        traceparent: `00-${TRACE_ID}-${spanHex(1)}-01`,
        parentSpanId: null,
        deliveryId: 'delivery-001',
        repositoryId: 1471342715,
        observedMs: 1000
      },
      ghAwLock: {
        traceparent: `00-${TRACE_ID}-${spanHex(2)}-01`,
        parentSpanId: spanHex(1),
        lockSha256: LOCK_SHA256,
        observedMs: 1010
      },
      casLease: {
        traceparent: `00-${TRACE_ID}-${spanHex(3)}-01`,
        parentSpanId: spanHex(2),
        leaseGeneration: 1,
        laneId: 'lane-telemetry',
        ownedPaths: ['tools/engineering-factory', 'tests/engineering-factory/anti-rogue-audit.test.mjs'],
        observedMs: 1010
      },
      missionControlTask: {
        traceparent: `00-${TRACE_ID}-${spanHex(4)}-01`,
        parentSpanId: spanHex(3),
        taskId: '550e8400-e29b-41d4-a716-446655440000',
        sessionId: 'mc-session-01',
        observedMs: 1050
      },
      candidateCommit: {
        traceparent: `00-${TRACE_ID}-${spanHex(5)}-01`,
        parentSpanId: spanHex(4),
        commitSha: COMMIT_SHA,
        signed: true,
        touchedPaths: [
          'tools/engineering-factory/stage-latency.mjs',
          'tests/engineering-factory/anti-rogue-audit.test.mjs'
        ],
        observedMs: 1200
      },
      exactHeadValidation: {
        traceparent: `00-${TRACE_ID}-${spanHex(6)}-01`,
        parentSpanId: spanHex(5),
        headSha: COMMIT_SHA,
        ciReceiptId: 'ci-rcpt-1',
        codeqlReceiptId: 'codeql-rcpt-1',
        coverageReceiptId: 'cov-rcpt-1',
        expectedComponents: ['engineering-factory.stage-latency', 'engineering-factory.telemetry'],
        coverageReports: [
          {
            component: 'engineering-factory.stage-latency',
            head: COMMIT_SHA,
            lines: 99,
            lineTotal: 100,
            branches: 48,
            branchTotal: 50
          },
          {
            component: 'engineering-factory.telemetry',
            head: COMMIT_SHA,
            lines: 99,
            lineTotal: 100,
            branches: 48,
            branchTotal: 50
          }
        ],
        lines: 198,
        lineTotal: 200,
        branches: 96,
        branchTotal: 100,
        observedMs: 1300
      },
      independentReview: {
        traceparent: `00-${TRACE_ID}-${spanHex(7)}-01`,
        parentSpanId: spanHex(6),
        reviewId: 'review-9001',
        reviewedHeadSha: COMMIT_SHA,
        reviewerIdentity: 'copilot-pull-request-reviewer[bot]',
        authorIdentity: 'cyrusjamula',
        implementationAgentIdentity: 'copilot-swe-agent[bot]',
        authorizedReviewers: ['copilot-pull-request-reviewer[bot]', 'senior-maintainer'],
        reviewState: 'COMMENTED',
        reviewHistoryComplete: true,
        outstandingChangesRequested: 0,
        unresolvedThreads: 0,
        summaryFindingsResolved: true,
        observedMs: 1400
      },
      mergeQueueSquash: {
        traceparent: `00-${TRACE_ID}-${spanHex(8)}-01`,
        parentSpanId: spanHex(7),
        expectedHeadSha: COMMIT_SHA,
        squashCommitSha: SQUASH_SHA,
        observedMs: 1500
      },
      verifiedMain: {
        traceparent: `00-${TRACE_ID}-${spanHex(9)}-00`,
        parentSpanId: spanHex(8),
        mainCommitSha: SQUASH_SHA,
        mainHealthy: true,
        receiptId: 'main-rcpt-1',
        observedMs: 1600
      }
    }
  };
}

function buildValidCircuitBreakerInput() {
  return {
    repositoryId: 1471342715,
    ownedPaths: ['tools/engineering-factory/stage-latency.mjs', 'docs/guides'],
    touchedPaths: ['tools/engineering-factory/stage-latency.mjs', 'docs/guides/setup.md'],
    attempt: 1,
    maxRetries: 2,
    runAiCredits: 12,
    maxRunAiCredits: 50,
    burnRateBps: 800,
    maxBurnSpikeBps: 2500,
    incrementalBilledUsdCents: 0,
    safeOutputsThreatDetected: false,
    accountingVerified: true,
    isEstimated: false,
    authorIdentity: 'cyrusjamula',
    implementationAgentIdentity: 'copilot-swe-agent[bot]',
    reviewerIdentity: 'copilot-pull-request-reviewer[bot]',
    mainHealthy: true
  };
}

test('W3C traceparent parser enforces version 00, non-zero trace/span IDs, and sampled bit', () => {
  const sampled = parseTraceparent(`00-${TRACE_ID}-${spanHex(5)}-01`);
  assert.deepEqual(sampled, {
    valid: true,
    version: '00',
    traceId: TRACE_ID,
    spanId: spanHex(5),
    traceFlags: '01',
    sampled: true
  });
  const unsampled = parseTraceparent(`00-${TRACE_ID}-${spanHex(6)}-00`);
  assert.equal(unsampled.valid, true);
  assert.equal(unsampled.sampled, false);

  for (const invalid of [
    null,
    123,
    `01-${TRACE_ID}-${spanHex(1)}-01`,
    `00-${'0'.repeat(32)}-${spanHex(1)}-01`,
    `00-${TRACE_ID}-${'0'.repeat(16)}-01`,
    `00-${TRACE_ID.toUpperCase()}-${spanHex(1)}-01`,
    `00-${TRACE_ID}-${spanHex(1)}-zz`
  ]) {
    assert.deepEqual(parseTraceparent(invalid), {valid: false, reason: 'INVALID_TRACEPARENT'});
  }
});

test('path validation rejects traversal, NUL, backslashes, leading/trailing slashes and classifies protected paths', () => {
  for (const bad of [
    null,
    '',
    'a'.repeat(513),
    '/etc/passwd',
    'docs/',
    'docs\\POLICY.md',
    'docs/\u0000secret.md',
    'docs//POLICY.md',
    './SECURITY.md',
    'docs/../SECURITY.md'
  ]) {
    assert.equal(isSafeRepoRelativePath(bad), false);
    assert.equal(isProtectedControlPlanePath(bad), false);
  }

  for (const p of [
    ...EXACT_PROTECTED_CONTROL_PLANE_PATHS,
    '.github/workflows/ci.yml',
    '.github/workflows/orchestrator.lock.yml',
    'workflows/agent.lock.yml',
    '.github/rulesets/main.json',
    'config/kill-switch.json',
    'ops/kill_switch/repo.yml'
  ]) {
    assert.equal(isProtectedControlPlanePath(p), true, p);
  }
  assert.equal(isProtectedControlPlanePath('tools/engineering-factory/stage-latency.mjs'), false);
  assert.equal(isWithinOwnedPaths('docs/guides/a.md', ['docs/guides']), true);
  assert.equal(isWithinOwnedPaths('docs/guides', ['docs/guides']), true);
  assert.equal(isWithinOwnedPaths('docs/guides-other/a.md', ['docs/guides']), false);
});

test('verifyCausalProvenanceChain validates completed 9-link chain and supports partial in-flight prefix inspection', () => {
  assert.equal(CANONICAL_PROVENANCE_STAGES.length, 9);
  const full = verifyCausalProvenanceChain(buildValidChain());
  assert.equal(full.valid, true);
  assert.equal(full.complete, true);
  assert.equal(full.inFlight, false);
  assert.equal(full.shadow, true);
  assert.equal(full.liveMutation, false);
  assert.equal(full.code, 'PROVENANCE_CHAIN_VERIFIED');
  assert.equal(full.verifiedStageCount, 9);
  assert.equal(full.lastVerifiedStage, 'verifiedMain');
  assert.equal(full.traceId, TRACE_ID);

  // Supports consumer coverage policy >=95/90 ONLY for non-SoftwareFactory repositories with formal APPROVED review
  const consumerChain = buildValidChain();
  consumerChain.stages.eventDelivery.repositoryId = CONSUMER_REPO_ID;
  consumerChain.coveragePolicy = {profile: 'consumer', minLinePercent: 97, minBranchPercent: 92};
  consumerChain.stages.exactHeadValidation.expectedComponents = ['consumer.app'];
  consumerChain.stages.exactHeadValidation.coverageReports = [
    {component: 'consumer.app', head: COMMIT_SHA, lines: 97, lineTotal: 100, branches: 92, branchTotal: 100}
  ];
  consumerChain.stages.exactHeadValidation.lines = 97;
  consumerChain.stages.exactHeadValidation.lineTotal = 100;
  consumerChain.stages.exactHeadValidation.branches = 92;
  consumerChain.stages.exactHeadValidation.branchTotal = 100;
  consumerChain.stages.independentReview.reviewerIdentity = 'senior-maintainer';
  consumerChain.stages.independentReview.reviewState = 'APPROVED';
  assert.equal(verifyCausalProvenanceChain(consumerChain).valid, true);

  // SoftwareFactory repository ID 1471342715 rejects profile: 'consumer' even when coverage is 97/92
  const weakenedSfChain = buildValidChain();
  weakenedSfChain.coveragePolicy = {profile: 'consumer', minLinePercent: 97, minBranchPercent: 92};
  assert.equal(verifyCausalProvenanceChain(weakenedSfChain).code, 'INVALID_COVERAGE_POLICY');

  const strictSfChain = buildValidChain();
  strictSfChain.coveragePolicy = {minLinePercent: 99, minBranchPercent: 96};
  assert.equal(verifyCausalProvenanceChain(strictSfChain).valid, true);

  // Supports head-bound branchless component justifications with authorized independent reviewer
  const branchlessChain = buildValidChain();
  branchlessChain.stages.exactHeadValidation.expectedComponents = [
    'engineering-factory.constants',
    'engineering-factory.telemetry'
  ];
  branchlessChain.stages.exactHeadValidation.coverageReports = [
    {component: 'engineering-factory.constants', head: COMMIT_SHA, lines: 50, lineTotal: 50, branches: 0, branchTotal: 0},
    {component: 'engineering-factory.telemetry', head: COMMIT_SHA, lines: 99, lineTotal: 100, branches: 48, branchTotal: 50}
  ];
  branchlessChain.stages.exactHeadValidation.branchless = [
    {
      component: 'engineering-factory.constants',
      head: COMMIT_SHA,
      reviewedBy: 'senior-maintainer',
      reason: 'Pure frozen constants inventory with zero conditional branches'
    }
  ];
  branchlessChain.stages.exactHeadValidation.lines = 149;
  branchlessChain.stages.exactHeadValidation.lineTotal = 150;
  branchlessChain.stages.exactHeadValidation.branches = 48;
  branchlessChain.stages.exactHeadValidation.branchTotal = 50;
  assert.equal(verifyCausalProvenanceChain(branchlessChain).valid, true);

  // Also supports all-branchless inventory (0/0 aggregate branches) when justified
  const allBranchless = buildValidChain();
  allBranchless.stages.exactHeadValidation.expectedComponents = ['engineering-factory.constants'];
  allBranchless.stages.exactHeadValidation.coverageReports = [
    {component: 'engineering-factory.constants', head: COMMIT_SHA, lines: 50, lineTotal: 50, branches: 0, branchTotal: 0}
  ];
  allBranchless.stages.exactHeadValidation.branchless = [
    {
      component: 'engineering-factory.constants',
      head: COMMIT_SHA,
      reviewedBy: 'senior-maintainer',
      reason: 'Pure frozen constants inventory with zero conditional branches'
    }
  ];
  allBranchless.stages.exactHeadValidation.lines = 50;
  allBranchless.stages.exactHeadValidation.lineTotal = 50;
  allBranchless.stages.exactHeadValidation.branches = 0;
  allBranchless.stages.exactHeadValidation.branchTotal = 0;
  assert.equal(verifyCausalProvenanceChain(allBranchless).valid, true);

  // Rejects branchless justification on wrong head, non-allowlisted reviewer, author/agent reviewer, or in-flight without review stage
  const staleBranchless = structuredClone(branchlessChain);
  staleBranchless.stages.exactHeadValidation.branchless[0].head = OTHER_SHA;
  assert.equal(verifyCausalProvenanceChain(staleBranchless).code, 'BRANCHLESS_UNJUSTIFIED');

  for (const badReviewer of ['unlisted-reviewer', 'cyrusjamula', 'copilot-swe-agent[bot]']) {
    const unauthorizedBl = structuredClone(branchlessChain);
    unauthorizedBl.stages.exactHeadValidation.branchless[0].reviewedBy = badReviewer;
    assert.equal(verifyCausalProvenanceChain(unauthorizedBl).code, 'BRANCHLESS_REVIEWER_UNAUTHORIZED');
  }

  const inFlightUnverifiedBranchless = {
    allowInFlightUpToStage: 'exactHeadValidation',
    stages: {
      eventDelivery: branchlessChain.stages.eventDelivery,
      ghAwLock: branchlessChain.stages.ghAwLock,
      casLease: branchlessChain.stages.casLease,
      missionControlTask: branchlessChain.stages.missionControlTask,
      candidateCommit: branchlessChain.stages.candidateCommit,
      exactHeadValidation: branchlessChain.stages.exactHeadValidation
    }
  };
  assert.equal(verifyCausalProvenanceChain(inFlightUnverifiedBranchless).code, 'BRANCHLESS_REVIEWER_UNAUTHORIZED');

  const badBranchlessEntry = structuredClone(branchlessChain);
  badBranchlessEntry.stages.exactHeadValidation.branchless = [{}];
  assert.equal(verifyCausalProvenanceChain(badBranchlessEntry).code, 'INVALID_EXACT_HEAD_VALIDATION');

  // Partial in-flight chain up to candidateCommit
  const base = buildValidChain();
  const inFlight = verifyCausalProvenanceChain({
    allowInFlightUpToStage: 'candidateCommit',
    stages: {
      eventDelivery: base.stages.eventDelivery,
      ghAwLock: base.stages.ghAwLock,
      casLease: base.stages.casLease,
      missionControlTask: base.stages.missionControlTask,
      candidateCommit: base.stages.candidateCommit
    }
  });
  assert.equal(inFlight.valid, true);
  assert.equal(inFlight.complete, false);
  assert.equal(inFlight.inFlight, true);
  assert.equal(inFlight.code, 'IN_FLIGHT_CHAIN_VERIFIED');
  assert.equal(inFlight.verifiedStageCount, 5);
  assert.equal(inFlight.lastVerifiedStage, 'candidateCommit');

  // Missing final stages without allowInFlightUpToStage fails closed
  const incomplete = verifyCausalProvenanceChain({
    stages: {
      eventDelivery: base.stages.eventDelivery,
      ghAwLock: base.stages.ghAwLock
    }
  });
  assert.equal(incomplete.valid, false);
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.code, 'INCOMPLETE_PROVENANCE_CHAIN');

  // Extra stage beyond allowInFlightUpToStage fails closed
  const mismatch = verifyCausalProvenanceChain({
    allowInFlightUpToStage: 'eventDelivery',
    stages: {
      eventDelivery: base.stages.eventDelivery,
      ghAwLock: base.stages.ghAwLock
    }
  });
  assert.equal(mismatch.valid, false);
  assert.equal(mismatch.code, 'IN_FLIGHT_STAGE_MISMATCH');
});

test('verifyCausalProvenanceChain fails closed across broken spans, timestamps, signatures, out-of-lane paths, coverage, review, and main health', () => {
  // Invalid top-level, proxy, coverage policy, stage map, and unknown in-flight stage
  assert.equal(verifyCausalProvenanceChain(null).code, 'INVALID_CHAIN_INPUT');
  assert.equal(verifyCausalProvenanceChain(new Proxy(buildValidChain(), {})).code, 'INVALID_CHAIN_INPUT');
  assert.equal(verifyCausalProvenanceChain({stages: null}).code, 'INVALID_CHAIN_INPUT');

  const badPolicyList = [
    null,
    {profile: 'unknown', minLinePercent: 98, minBranchPercent: 95},
    {minLinePercent: 97, minBranchPercent: 95},
    {minLinePercent: 98, minBranchPercent: 94}
  ];
  for (const coveragePolicy of badPolicyList) {
    assert.equal(verifyCausalProvenanceChain({...buildValidChain(), coveragePolicy}).code, 'INVALID_COVERAGE_POLICY');
  }
  const badConsumerPolicy = buildValidChain();
  badConsumerPolicy.stages.eventDelivery.repositoryId = CONSUMER_REPO_ID;
  badConsumerPolicy.coveragePolicy = {profile: 'consumer', minLinePercent: 94, minBranchPercent: 90};
  assert.equal(verifyCausalProvenanceChain(badConsumerPolicy).code, 'INVALID_COVERAGE_POLICY');

  assert.equal(
    verifyCausalProvenanceChain({...buildValidChain(), allowInFlightUpToStage: 'notAStage'}).code,
    'INVALID_IN_FLIGHT_STAGE'
  );
  assert.equal(
    verifyCausalProvenanceChain({stages: {...buildValidChain().stages, bogusStage: {}}}).code,
    'INVALID_STAGE_MAP'
  );

  const missingEnvelope = buildValidChain();
  missingEnvelope.stages.eventDelivery = {deliveryId: 'd1'};
  assert.equal(verifyCausalProvenanceChain(missingEnvelope).code, 'INVALID_STAGE_RECORD');

  const badTp = buildValidChain();
  badTp.stages.ghAwLock.traceparent = 'bad-traceparent';
  assert.equal(verifyCausalProvenanceChain(badTp).code, 'INVALID_TRACEPARENT');

  const nonNullRootParent = buildValidChain();
  nonNullRootParent.stages.eventDelivery.parentSpanId = spanHex(99);
  assert.equal(verifyCausalProvenanceChain(nonNullRootParent).code, 'ROOT_PARENT_SPAN_MUST_BE_NULL');

  const mismatchedTrace = buildValidChain();
  mismatchedTrace.stages.ghAwLock.traceparent = `00-${'f'.repeat(32)}-${spanHex(2)}-01`;
  assert.equal(verifyCausalProvenanceChain(mismatchedTrace).code, 'TRACE_ID_MISMATCH');

  const brokenParentLink = buildValidChain();
  brokenParentLink.stages.casLease.parentSpanId = spanHex(99);
  assert.equal(verifyCausalProvenanceChain(brokenParentLink).code, 'SPAN_LINKAGE_BROKEN');

  const duplicateSpan = buildValidChain();
  duplicateSpan.stages.casLease.traceparent = `00-${TRACE_ID}-${spanHex(1)}-01`;
  assert.equal(verifyCausalProvenanceChain(duplicateSpan).code, 'DUPLICATE_SPAN_ID');

  const badMs = buildValidChain();
  badMs.stages.ghAwLock.observedMs = -1;
  assert.equal(verifyCausalProvenanceChain(badMs).code, 'INVALID_OBSERVED_MS');

  const nonMonotonic = buildValidChain();
  nonMonotonic.stages.missionControlTask.observedMs = 999;
  assert.equal(verifyCausalProvenanceChain(nonMonotonic).code, 'NON_MONOTONIC_TIMESTAMPS');

  // Stage-specific invalid schemas and invariant breaches
  const badDelivery = buildValidChain();
  badDelivery.stages.eventDelivery.repositoryId = 0;
  assert.equal(verifyCausalProvenanceChain(badDelivery).code, 'INVALID_EVENT_DELIVERY');

  const badLock = buildValidChain();
  badLock.stages.ghAwLock.lockSha256 = 'xyz';
  assert.equal(verifyCausalProvenanceChain(badLock).code, 'INVALID_GH_AW_LOCK_HASH');

  const badLease = buildValidChain();
  badLease.stages.casLease.leaseGeneration = 0;
  assert.equal(verifyCausalProvenanceChain(badLease).code, 'INVALID_CAS_LEASE');

  const dupOwnedLease = buildValidChain();
  dupOwnedLease.stages.casLease.ownedPaths = ['docs/a.md', 'docs/a.md'];
  assert.equal(verifyCausalProvenanceChain(dupOwnedLease).code, 'INVALID_CAS_LEASE');

  const proxyOwnedLease = buildValidChain();
  proxyOwnedLease.stages.casLease.ownedPaths = new Proxy(['docs/a.md'], {});
  assert.equal(verifyCausalProvenanceChain(proxyOwnedLease).code, 'INVALID_CAS_LEASE');

  const badTask = buildValidChain();
  badTask.stages.missionControlTask.taskId = 'not-a-uuid';
  assert.equal(verifyCausalProvenanceChain(badTask).code, 'INVALID_MISSION_CONTROL_TASK');

  const badCommitRecord = buildValidChain();
  badCommitRecord.stages.candidateCommit.commitSha = 'short';
  assert.equal(verifyCausalProvenanceChain(badCommitRecord).code, 'INVALID_CANDIDATE_COMMIT');

  const unsignedCommit = buildValidChain();
  unsignedCommit.stages.candidateCommit.signed = false;
  assert.equal(verifyCausalProvenanceChain(unsignedCommit).code, 'UNSIGNED_CANDIDATE_COMMIT');

  const outOfLaneCommit = buildValidChain();
  outOfLaneCommit.stages.candidateCommit.touchedPaths = ['src/unowned.mjs'];
  const outRes = verifyCausalProvenanceChain(outOfLaneCommit);
  assert.equal(outRes.code, 'OUT_OF_LANE_TOUCHED_PATHS');
  assert.deepEqual(outRes.outOfLanePaths, ['src/unowned.mjs']);

  const badExactValidation = buildValidChain();
  badExactValidation.stages.exactHeadValidation.lineTotal = 0;
  assert.equal(verifyCausalProvenanceChain(badExactValidation).code, 'INVALID_EXACT_HEAD_VALIDATION');

  const headMismatch = buildValidChain();
  headMismatch.stages.exactHeadValidation.headSha = OTHER_SHA;
  assert.equal(verifyCausalProvenanceChain(headMismatch).code, 'EXACT_HEAD_MISMATCH');

  // Large component at 100% cannot mask an under-covered component (per-component coverageEvidence check)
  const hiddenComponentDrop = buildValidChain();
  hiddenComponentDrop.stages.exactHeadValidation.coverageReports = [
    {component: 'engineering-factory.stage-latency', head: COMMIT_SHA, lines: 1000, lineTotal: 1000, branches: 500, branchTotal: 500},
    {component: 'engineering-factory.telemetry', head: COMMIT_SHA, lines: 90, lineTotal: 100, branches: 48, branchTotal: 50}
  ];
  hiddenComponentDrop.stages.exactHeadValidation.lines = 1090;
  hiddenComponentDrop.stages.exactHeadValidation.lineTotal = 1100;
  hiddenComponentDrop.stages.exactHeadValidation.branches = 548;
  hiddenComponentDrop.stages.exactHeadValidation.branchTotal = 550;
  assert.equal(verifyCausalProvenanceChain(hiddenComponentDrop).code, 'COVERAGE_BELOW_THRESHOLD');

  const mismatchedComponentInventory = buildValidChain();
  mismatchedComponentInventory.stages.exactHeadValidation.expectedComponents = ['engineering-factory.stage-latency'];
  assert.equal(verifyCausalProvenanceChain(mismatchedComponentInventory).code, 'INVALID_EXACT_HEAD_VALIDATION');

  const summaryCountsMismatch = buildValidChain();
  summaryCountsMismatch.stages.exactHeadValidation.lines = 199;
  assert.equal(verifyCausalProvenanceChain(summaryCountsMismatch).code, 'COVERAGE_COUNTS_MISMATCH');

  const badReviewRecord = buildValidChain();
  badReviewRecord.stages.independentReview.unresolvedThreads = -1;
  assert.equal(verifyCausalProvenanceChain(badReviewRecord).code, 'INVALID_INDEPENDENT_REVIEW');

  const badRequireFormal = buildValidChain();
  badRequireFormal.stages.independentReview.requireFormalApproval = 'yes';
  assert.equal(verifyCausalProvenanceChain(badRequireFormal).code, 'INVALID_INDEPENDENT_REVIEW');

  const reviewHeadMismatch = buildValidChain();
  reviewHeadMismatch.stages.independentReview.reviewedHeadSha = OTHER_SHA;
  assert.equal(verifyCausalProvenanceChain(reviewHeadMismatch).code, 'REVIEW_HEAD_MISMATCH');

  // Complete review history and zero outstanding CHANGES_REQUESTED across all reviewers
  const withCleanNormalizedHistory = buildValidChain();
  withCleanNormalizedHistory.stages.independentReview.normalizedReviews = [
    {reviewer: 'copilot-pull-request-reviewer[bot]', head: COMMIT_SHA, state: 'COMMENTED'},
    {reviewer: 'senior-maintainer', head: COMMIT_SHA, state: 'APPROVED'}
  ];
  assert.equal(verifyCausalProvenanceChain(withCleanNormalizedHistory).valid, true);

  const incompleteReviewHistory = buildValidChain();
  incompleteReviewHistory.stages.independentReview.reviewHistoryComplete = false;
  assert.equal(verifyCausalProvenanceChain(incompleteReviewHistory).code, 'REVIEW_HISTORY_INCOMPLETE');

  const blockingCountNonZero = buildValidChain();
  blockingCountNonZero.stages.independentReview.outstandingChangesRequested = 1;
  assert.equal(verifyCausalProvenanceChain(blockingCountNonZero).code, 'OUTSTANDING_CHANGES_REQUESTED');

  const blockingInNormalized = buildValidChain();
  blockingInNormalized.stages.independentReview.normalizedReviews = [
    {reviewer: 'copilot-pull-request-reviewer[bot]', head: COMMIT_SHA, state: 'COMMENTED'},
    {reviewer: 'security-reviewer', head: OTHER_SHA, state: 'CHANGES_REQUESTED'}
  ];
  assert.equal(verifyCausalProvenanceChain(blockingInNormalized).code, 'OUTSTANDING_CHANGES_REQUESTED');

  const inconsistentNormalized = buildValidChain();
  inconsistentNormalized.stages.independentReview.normalizedReviews = [
    {reviewer: 'senior-maintainer', head: COMMIT_SHA, state: 'APPROVED'}
  ];
  assert.equal(verifyCausalProvenanceChain(inconsistentNormalized).code, 'REVIEW_HISTORY_INCONSISTENT');

  const malformedNormalized = buildValidChain();
  malformedNormalized.stages.independentReview.normalizedReviews = [];
  assert.equal(verifyCausalProvenanceChain(malformedNormalized).code, 'INVALID_INDEPENDENT_REVIEW');

  // Self-review forbidden for both commit author AND implementation agent
  const selfAuthorReview = buildValidChain();
  selfAuthorReview.stages.independentReview.reviewerIdentity = 'CyrusJamula';
  assert.equal(verifyCausalProvenanceChain(selfAuthorReview).code, 'SELF_REVIEW_FORBIDDEN');

  const selfAgentReview = buildValidChain();
  selfAgentReview.stages.independentReview.reviewerIdentity = 'Copilot-SWE-Agent[bot]';
  assert.equal(verifyCausalProvenanceChain(selfAgentReview).code, 'SELF_REVIEW_FORBIDDEN');

  const unauthorizedReviewer = buildValidChain();
  unauthorizedReviewer.stages.independentReview.reviewerIdentity = 'unlisted-user';
  assert.equal(verifyCausalProvenanceChain(unauthorizedReviewer).code, 'UNAUTHORIZED_REVIEWER');

  const dismissedReview = buildValidChain();
  dismissedReview.stages.independentReview.reviewState = 'DISMISSED';
  assert.equal(verifyCausalProvenanceChain(dismissedReview).code, 'REVIEW_NOT_ACCEPTABLE');

  const changesRequestedReview = buildValidChain();
  changesRequestedReview.stages.independentReview.reviewState = 'CHANGES_REQUESTED';
  assert.equal(verifyCausalProvenanceChain(changesRequestedReview).code, 'REVIEW_NOT_ACCEPTABLE');

  const humanCommentOnly = buildValidChain();
  humanCommentOnly.stages.independentReview.reviewerIdentity = 'senior-maintainer';
  humanCommentOnly.stages.independentReview.reviewState = 'COMMENTED';
  assert.equal(verifyCausalProvenanceChain(humanCommentOnly).code, 'REVIEW_NOT_ACCEPTABLE');

  const formalRequiredComment = buildValidChain();
  formalRequiredComment.stages.independentReview.requireFormalApproval = true;
  assert.equal(verifyCausalProvenanceChain(formalRequiredComment).code, 'REVIEW_NOT_ACCEPTABLE');

  const unresolvedSummary = buildValidChain();
  unresolvedSummary.stages.independentReview.summaryFindingsResolved = false;
  assert.equal(verifyCausalProvenanceChain(unresolvedSummary).code, 'REVIEW_FINDINGS_UNRESOLVED');

  const unresolvedInline = buildValidChain();
  unresolvedInline.stages.independentReview.unresolvedThreads = 1;
  assert.equal(verifyCausalProvenanceChain(unresolvedInline).code, 'REVIEW_FINDINGS_UNRESOLVED');

  const badSquash = buildValidChain();
  badSquash.stages.mergeQueueSquash.squashCommitSha = 'bad';
  assert.equal(verifyCausalProvenanceChain(badSquash).code, 'INVALID_MERGE_QUEUE_SQUASH');

  const squashHeadMismatch = buildValidChain();
  squashHeadMismatch.stages.mergeQueueSquash.expectedHeadSha = OTHER_SHA;
  assert.equal(verifyCausalProvenanceChain(squashHeadMismatch).code, 'MERGE_QUEUE_HEAD_MISMATCH');

  const badVerifiedMain = buildValidChain();
  badVerifiedMain.stages.verifiedMain.receiptId = '';
  assert.equal(verifyCausalProvenanceChain(badVerifiedMain).code, 'INVALID_VERIFIED_MAIN');

  const mainShaMismatch = buildValidChain();
  mainShaMismatch.stages.verifiedMain.mainCommitSha = OTHER_SHA;
  assert.equal(verifyCausalProvenanceChain(mainShaMismatch).code, 'MAIN_COMMIT_MISMATCH');

  const unhealthyMain = buildValidChain();
  unhealthyMain.stages.verifiedMain.mainHealthy = false;
  assert.equal(verifyCausalProvenanceChain(unhealthyMain).code, 'MAIN_UNHEALTHY');
});

test('evaluateAntiRogueCircuitBreaker passes clean bounded runs and integrates with telemetry.mjs receipts', () => {
  const clean = evaluateAntiRogueCircuitBreaker(buildValidCircuitBreakerInput());
  assert.deepEqual(clean, {
    shadow: true,
    liveMutation: false,
    allowed: true,
    tripKillSwitch: false,
    outcome: 'eligible',
    reason: 'NONE',
    primaryViolation: null,
    violations: [],
    protectedTouchedPaths: [],
    outOfLanePaths: []
  });

  // Optional non-accounting fields omitted work when accountingVerified: true is explicit, and humanOwnerSignOffVerified permits explicitly approved control-plane edit
  const minimal = evaluateAntiRogueCircuitBreaker({
    repositoryId: 1471342715,
    ownedPaths: ['SECURITY.md'],
    touchedPaths: ['SECURITY.md'],
    attempt: 0,
    maxRetries: 1,
    runAiCredits: 5,
    maxRunAiCredits: 25,
    burnRateBps: 500,
    maxBurnSpikeBps: 2000,
    incrementalBilledUsdCents: 0,
    safeOutputsThreatDetected: false,
    accountingVerified: true,
    humanOwnerSignOffVerified: true
  });
  assert.equal(minimal.allowed, true);
  assert.equal(minimal.tripKillSwitch, false);
  assert.deepEqual(minimal.protectedTouchedPaths, ['SECURITY.md']);

  const receipt = createExecutionReceipt({
    source: 'github-hosted',
    repositoryId: 1471342715,
    receiptId: 'cb-receipt-1',
    observedMs: 2000,
    stage: 'evaluate',
    outcome: clean.outcome,
    reason: clean.reason
  });
  assert.equal(receipt.valid, true);
});

test('evaluateAntiRogueCircuitBreaker trips kill switch on all 7 anti-rogue violations with telemetry-compatible reasons', () => {
  const cases = [
    {
      mutate: v => {
        v.ownedPaths = ['tools/engineering-factory/platform-merge-gates.mjs'];
        v.touchedPaths = ['tools/engineering-factory/platform-merge-gates.mjs'];
      },
      expectedViolation: 'PROTECTED_CONTROL_PLANE_TOUCH',
      expectedReason: 'SECURITY'
    },
    {
      mutate: v => {
        v.ownedPaths = ['tools/engineering-factory/coverage-evidence.mjs'];
        v.touchedPaths = ['tools/engineering-factory/coverage-evidence.mjs'];
      },
      expectedViolation: 'PROTECTED_CONTROL_PLANE_TOUCH',
      expectedReason: 'SECURITY'
    },
    {
      mutate: v => {
        v.ownedPaths = ['tools/engineering-factory/budget.mjs'];
        v.touchedPaths = ['tools/engineering-factory/budget.mjs'];
      },
      expectedViolation: 'PROTECTED_CONTROL_PLANE_TOUCH',
      expectedReason: 'SECURITY'
    },
    {
      mutate: v => {
        delete v.accountingVerified;
      },
      expectedViolation: 'AI_CREDIT_ANOMALY',
      expectedReason: 'QUOTA'
    },
    {
      mutate: v => {
        v.isEstimated = true;
      },
      expectedViolation: 'AI_CREDIT_ANOMALY',
      expectedReason: 'QUOTA'
    },
    {
      mutate: v => {
        v.reviewerIdentity = 'cyrusjamula';
      },
      expectedViolation: 'SELF_APPROVAL_FORBIDDEN',
      expectedReason: 'REVIEW'
    },
    {
      mutate: v => {
        v.selfMerge = true;
      },
      expectedViolation: 'PROTECTED_CONTROL_PLANE_TOUCH',
      expectedReason: 'SECURITY'
    },
    {
      mutate: v => {
        v.touchedPaths = ['tools/engineering-factory/other-file.mjs'];
      },
      expectedViolation: 'OUT_OF_LANE_EDIT',
      expectedReason: 'POLICY'
    },
    {
      mutate: v => {
        v.attempt = 3;
        v.maxRetries = 2;
      },
      expectedViolation: 'RETRY_CAP_EXCEEDED',
      expectedReason: 'POLICY'
    },
    {
      mutate: v => {
        v.incrementalBilledUsdCents = 1;
      },
      expectedViolation: 'AI_CREDIT_ANOMALY',
      expectedReason: 'QUOTA'
    },
    {
      mutate: v => {
        v.runAiCredits = 51;
      },
      expectedViolation: 'AI_CREDIT_ANOMALY',
      expectedReason: 'QUOTA'
    },
    {
      mutate: v => {
        v.burnRateBps = 3000;
      },
      expectedViolation: 'AI_CREDIT_ANOMALY',
      expectedReason: 'QUOTA'
    },
    {
      mutate: v => {
        v.accountingVerified = false;
      },
      expectedViolation: 'AI_CREDIT_ANOMALY',
      expectedReason: 'QUOTA'
    },
    {
      mutate: v => {
        v.safeOutputsThreatDetected = true;
      },
      expectedViolation: 'SAFE_OUTPUTS_THREAT_FLAGGED',
      expectedReason: 'SECURITY'
    },
    {
      mutate: v => {
        v.reviewerIdentity = 'copilot-swe-agent[bot]';
      },
      expectedViolation: 'SELF_APPROVAL_FORBIDDEN',
      expectedReason: 'REVIEW'
    },
    {
      mutate: v => {
        v.mainHealthy = false;
      },
      expectedViolation: 'POST_MERGE_MAIN_FAILED',
      expectedReason: 'CHECKS'
    }
  ];

  for (const c of cases) {
    const input = buildValidCircuitBreakerInput();
    c.mutate(input);
    const result = evaluateAntiRogueCircuitBreaker(input);
    assert.equal(result.shadow, true);
    assert.equal(result.liveMutation, false);
    assert.equal(result.allowed, false);
    assert.equal(result.tripKillSwitch, true);
    assert.equal(result.primaryViolation, c.expectedViolation);
    assert.equal(result.reason, c.expectedReason);

    const receipt = createExecutionReceipt({
      source: 'github-hosted',
      repositoryId: 1471342715,
      receiptId: 'cb-deny-receipt',
      observedMs: 2500,
      stage: 'evaluate',
      outcome: result.outcome,
      reason: result.reason
    });
    assert.equal(receipt.valid, true);
  }
});

test('evaluateAntiRogueCircuitBreaker rejects proxies, non-enumerable/getter properties, sparse arrays, and unsafe paths', () => {
  const valid = buildValidCircuitBreakerInput();
  assert.equal(evaluateAntiRogueCircuitBreaker(new Proxy(valid, {})).primaryViolation, 'INVALID_CIRCUIT_BREAKER_INPUT');
  assert.equal(evaluateAntiRogueCircuitBreaker(Object.create(null)).primaryViolation, 'INVALID_CIRCUIT_BREAKER_INPUT');

  const withGetter = {...valid};
  Object.defineProperty(withGetter, 'attempt', {get: () => 1, enumerable: true});
  assert.equal(evaluateAntiRogueCircuitBreaker(withGetter).primaryViolation, 'INVALID_CIRCUIT_BREAKER_INPUT');

  const nonEnum = {...valid};
  Object.defineProperty(nonEnum, 'attempt', {value: 1, enumerable: false});
  assert.equal(evaluateAntiRogueCircuitBreaker(nonEnum).primaryViolation, 'INVALID_CIRCUIT_BREAKER_INPUT');

  const symKey = {...valid, [Symbol('extra')]: 1};
  assert.equal(evaluateAntiRogueCircuitBreaker(symKey).primaryViolation, 'INVALID_CIRCUIT_BREAKER_INPUT');

  const sparse = {...valid, touchedPaths: new Array(1)};
  assert.equal(evaluateAntiRogueCircuitBreaker(sparse).primaryViolation, 'INVALID_CIRCUIT_BREAKER_INPUT');

  const oversizedArray = {...valid, touchedPaths: Array.from({length: 501}, (_, i) => `docs/f${i}.md`)};
  assert.equal(evaluateAntiRogueCircuitBreaker(oversizedArray).primaryViolation, 'INVALID_CIRCUIT_BREAKER_INPUT');

  const emptyOwned = {...valid, ownedPaths: []};
  assert.equal(evaluateAntiRogueCircuitBreaker(emptyOwned).primaryViolation, 'INVALID_CIRCUIT_BREAKER_INPUT');

  const halfReviewer = {...valid, reviewerIdentity: null};
  assert.equal(evaluateAntiRogueCircuitBreaker(halfReviewer).primaryViolation, 'INVALID_CIRCUIT_BREAKER_INPUT');

  const badIdentity = {...valid, reviewerIdentity: 'bad identity!'};
  assert.equal(evaluateAntiRogueCircuitBreaker(badIdentity).primaryViolation, 'INVALID_CIRCUIT_BREAKER_INPUT');

  const badAgentOnly = {...valid, authorIdentity: null, reviewerIdentity: null, implementationAgentIdentity: 'copilot-swe-agent[bot]'};
  assert.equal(evaluateAntiRogueCircuitBreaker(badAgentOnly).primaryViolation, 'INVALID_CIRCUIT_BREAKER_INPUT');

  const badAccountingType = {...valid, accountingVerified: 'yes'};
  assert.equal(evaluateAntiRogueCircuitBreaker(badAccountingType).primaryViolation, 'INVALID_CIRCUIT_BREAKER_INPUT');

  const badEstimatedType = {...valid, isEstimated: 'no'};
  assert.equal(evaluateAntiRogueCircuitBreaker(badEstimatedType).primaryViolation, 'INVALID_CIRCUIT_BREAKER_INPUT');

  const traversalTouched = {...valid, touchedPaths: ['docs/../SECURITY.md']};
  const travRes = evaluateAntiRogueCircuitBreaker(traversalTouched);
  assert.equal(travRes.tripKillSwitch, true);
  assert.equal(travRes.reason, 'SECURITY');
  assert.equal(travRes.primaryViolation, 'UNSAFE_PATH_TRAVERSAL');

  const traversalOwned = {...valid, ownedPaths: ['/abs/path']};
  assert.equal(evaluateAntiRogueCircuitBreaker(traversalOwned).primaryViolation, 'UNSAFE_PATH_TRAVERSAL');

  const dupPaths = {...valid, touchedPaths: ['docs/guides/a.md', 'docs/guides/a.md']};
  assert.equal(evaluateAntiRogueCircuitBreaker(dupPaths).primaryViolation, 'DUPLICATE_PATHS');
});
