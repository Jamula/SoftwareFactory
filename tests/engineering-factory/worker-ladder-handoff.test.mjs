import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTOMATION_ALLOWED_VISIBILITIES,
  CHECKPOINT_SCHEMA_VERSION,
  CONTROLLER_PROTECTED_CONTROL_PLANE_PATHS,
  DEFAULT_MAX_HANDOFF_ATTEMPTS,
  DEFAULT_MAX_QUOTA_AGE_MS,
  MAX_ALLOWED_HANDOFF_ATTEMPTS,
  MAX_ALLOWED_QUOTA_AGE_MS,
  MAX_LEASE_TTL_MS,
  MAX_SERIALIZED_CHECKPOINT_BYTES,
  PINNED_COPILOT_SDK_VERSION,
  PROVIDER_FAMILY_HARNESSES,
  REPOSITORY_VISIBILITIES,
  SELF_EVALUATOR_PATH,
  SUPPORTED_PROVIDER_FAMILIES,
  SUPPORTED_RUNNERS,
  WORKER_GOAL_MAX,
  WORKER_GOAL_MIN,
  WORKER_LADDER,
  computeCheckpointSha256,
  evaluateWorkerLadderAndQuotaHandoff
} from '../../tools/engineering-factory/worker-ladder-handoff.mjs';
import {createExecutionReceipt, telemetrySummary} from '../../tools/engineering-factory/telemetry.mjs';

const REPO_ID = 1_471_342_715;
const NOW_MS = 1_764_300_000_000;
const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

function makeProvider(overrides = {}) {
  const baseAccounting = {
    accountingSource: 'verified',
    isEstimated: false,
    observedAtMs: NOW_MS - 5_000,
    remainingIncludedUnits: 1_200,
    unitsPerWorkerRun: 50,
    remainingIncludedRequests: 60,
    requestsPerWorkerRun: 2
  };
  const baseBilling = {
    entitlementVerified: true,
    includedOnly: true,
    paidOverageEnabled: false,
    overageHardStopUsdCents: 0,
    hardStopEnforced: true,
    incrementalBilledUsdCents: 0,
    accounting: baseAccounting,
    ghAwCaps: {
      maxRunUnits: 100,
      maxDailyUnits: 1_000,
      dailyUnitsUsed: 100
    }
  };
  return {
    providerFamily: 'github-copilot',
    ownerAuthorized: true,
    approvedRepositoryId: REPO_ID,
    independentAuthorizationVerified: true,
    verifiedProviderWorkerCeiling: 12,
    model: {
      id: 'gpt-5.4',
      allowlist: ['gpt-5.4', 'claude-sonnet-4.6'],
      verifiedAvailable: true,
      provider: 'github-copilot'
    },
    harness: {
      kind: 'copilot-cloud-agent',
      verified: true,
      agentLogin: 'copilot-swe-agent[bot]'
    },
    runner: {
      kind: 'github-hosted',
      verified: true,
      ephemeral: true,
      isolated: true
    },
    billingEntitlement: baseBilling,
    ...overrides
  };
}

function makeLadder(overrides = {}) {
  return {
    currentRung: 2,
    verifiedPriorRung: 1,
    repoConcurrencyCap: 12,
    logicalLaneCount: 12,
    observedSimultaneousWorkers: 2,
    duplicateDispatches: 0,
    unauthorizedWrites: 0,
    unapprovedSpendUsdCents: 0,
    mainHealthy: true,
    qualityGatesClear: true,
    throughput: {
      comparabilityVerified: true,
      baselineAcceptedUnits: 6,
      baselineWindowMs: 3_600_000,
      currentAcceptedUnits: 8,
      currentWindowMs: 3_600_000,
      reworkRegressed: false
    },
    ...overrides
  };
}

function makeLease(overrides = {}) {
  return {
    leaseId: 'lease-issue-7-gen-2',
    issue: 7,
    pr: 210,
    headSha: HEAD_SHA,
    lane: 'worker-ladder-handoff',
    ownedPaths: ['src/feature/worker-task.mjs'],
    workerId: 'copilot-worker-1',
    leaseGeneration: 2,
    leaseExpiresAtMs: NOW_MS + 300_000,
    executionDeadlineMs: NOW_MS + 900_000,
    ...overrides
  };
}

function makeSerializedStateObject(lease = makeLease(), extra = {}) {
  return {
    repositoryId: REPO_ID,
    issue: lease.issue,
    pr: Object.hasOwn(lease, 'pr') ? lease.pr : null,
    headSha: lease.headSha,
    lane: lease.lane,
    ownedPaths: [...lease.ownedPaths],
    leaseGeneration: lease.leaseGeneration,
    checkpointRevision: 1,
    completedSteps: ['analyze', 'implement'],
    remainingSteps: ['test', 'verify-coverage'],
    ...extra
  };
}

function makeCheckpoint(lease = makeLease(), overrides = {}) {
  const serializedState = overrides.serializedState ??
    JSON.stringify(makeSerializedStateObject(lease));
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    checkpointId: 'cp-issue-7-rev-1',
    providerNeutral: true,
    repositoryId: REPO_ID,
    issue: lease.issue,
    pr: lease.pr,
    headSha: lease.headSha,
    lane: lease.lane,
    ownedPaths: [...lease.ownedPaths],
    leaseGeneration: lease.leaseGeneration,
    checkpointRevision: 1,
    createdAtMs: NOW_MS - 10_000,
    serializedState,
    sha256: computeCheckpointSha256(serializedState),
    ...overrides
  };
}

function makeFixture(overrides = {}) {
  return {
    stop: false,
    repositoryId: REPO_ID,
    approvedRepositoryId: REPO_ID,
    repositoryVisibility: 'public',
    personalPatInActionsSecrets: false,
    paidFallbackRequested: false,
    blindRetryRequested: false,
    nowMs: NOW_MS,
    primaryProvider: makeProvider(),
    ladder: makeLadder(),
    ...overrides
  };
}

function makeExhaustedPrimaryProvider(observedAtMs = NOW_MS - 2_000) {
  const base = makeProvider();
  return {
    ...base,
    billingEntitlement: {
      ...base.billingEntitlement,
      accounting: {
        ...base.billingEntitlement.accounting,
        observedAtMs,
        remainingIncludedUnits: 10,
        unitsPerWorkerRun: 50
      }
    }
  };
}

function assertCleanTelemetry(result, expectedOutcome, expectedReason) {
  const summary = telemetrySummary(result);
  assert.notEqual(summary.reason, 'OTHER');
  assert.deepEqual(summary, {outcome: expectedOutcome, reason: expectedReason});
  const receipt = createExecutionReceipt({
    source: 'github-hosted',
    repositoryId: REPO_ID,
    receiptId: 'gh-7-ladder-handoff',
    observedMs: NOW_MS,
    stage: 'dispatch',
    durationMs: 9,
    result
  });
  assert.equal(receipt.valid, true);
  assert.equal(receipt.outcome, expectedOutcome);
  assert.equal(receipt.reason, expectedReason);
}

test('exports frozen ladder/provider constants and deterministic bounded SHA-256 checkpoint hashing', () => {
  assert.deepEqual(WORKER_LADDER, [1, 2, 4, 8, 10, 12]);
  assert.equal(WORKER_GOAL_MIN, 10);
  assert.equal(WORKER_GOAL_MAX, 12);
  assert.equal(CHECKPOINT_SCHEMA_VERSION, 1);
  assert.equal(MAX_SERIALIZED_CHECKPOINT_BYTES, 65_536);
  assert.equal(PINNED_COPILOT_SDK_VERSION, '2.0.3');
  assert.equal(DEFAULT_MAX_QUOTA_AGE_MS, 60_000);
  assert.equal(MAX_ALLOWED_QUOTA_AGE_MS, 300_000);
  assert.equal(MAX_LEASE_TTL_MS, 3_600_000);
  assert.equal(DEFAULT_MAX_HANDOFF_ATTEMPTS, 3);
  assert.equal(MAX_ALLOWED_HANDOFF_ATTEMPTS, 5);
  assert.deepEqual(SUPPORTED_PROVIDER_FAMILIES, ['github-copilot', 'openai-codex', 'anthropic-claude']);
  assert.deepEqual(SUPPORTED_RUNNERS, ['github-hosted', 'cloud-sandbox']);
  assert.deepEqual(REPOSITORY_VISIBILITIES, ['public', 'private', 'internal']);
  assert.deepEqual(AUTOMATION_ALLOWED_VISIBILITIES, ['private', 'internal']);
  assert.equal(Object.isFrozen(PROVIDER_FAMILY_HARNESSES), true);

  const exactLimit = 'x'.repeat(MAX_SERIALIZED_CHECKPOINT_BYTES);
  const digest = computeCheckpointSha256(exactLimit);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(computeCheckpointSha256(''), null);
  assert.equal(computeCheckpointSha256('x'.repeat(MAX_SERIALIZED_CHECKPOINT_BYTES + 1)), null);
  for (const bad of [null, undefined, 123, {}, []]) {
    assert.equal(computeCheckpointSha256(bad), null);
  }
});

test('enforces step-by-step 1->2->4->8->10->12 progression, never treating logical lanes as active workers', () => {
  // Step through every consecutive rung 1->2->4->8->10->12
  for (let i = 0; i < WORKER_LADDER.length; i++) {
    const currentRung = WORKER_LADDER[i];
    const prior = i === 0 ? 0 : WORKER_LADDER[i - 1];
    const next = WORKER_LADDER[i + 1] ?? null;
    const res = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
      ladder: makeLadder({
        currentRung,
        verifiedPriorRung: prior,
        observedSimultaneousWorkers: currentRung,
        logicalLaneCount: 24
      })
    }));
    assert.equal(res.admitted, true);
    assert.equal(res.shadow, true);
    assert.equal(res.liveDispatch, false);
    assert.equal(res.paidFallbackUsed, false);
    assert.equal(res.blindRetryUsed, false);
    assert.equal(
      res.decisionCode,
      next === null ? 'WORKER_LADDER_MAX_RUNG_VERIFIED' : 'WORKER_LADDER_SCALE_RECOMMENDED'
    );
    assert.equal(res.ladderDecision.targetRung, next ?? 12);
    // actualMaxWorkers reflects observed simultaneous execution, while prospective capacity stays in verifiedCapacityCeiling/maxFundedRung
    assert.equal(res.actualMaxWorkers, currentRung);
    assert.equal(res.verifiedCapacityCeiling, 12);
    assert.equal(res.maxFundedRung, 12);
    assert.equal(res.shortfallFrom12, 12 - currentRung);
    assert.equal(res.shortfallFrom10, Math.max(0, 10 - currentRung));
    assert.equal(res.goalMet, currentRung >= 10);
    assert.equal(Object.isFrozen(res), true);
    assert.equal(Object.isFrozen(res.ladderDecision), true);
    assert.equal(Object.isFrozen(res.selectedProvider), true);
    assertCleanTelemetry(res, 'eligible', 'NONE');
  }

  // Holding an intermediate rung explicitly (requestedRung === currentRung)
  const heldRung4 = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    primaryProvider: makeProvider({verifiedProviderWorkerCeiling: 6}),
    ladder: makeLadder({
      currentRung: 4,
      verifiedPriorRung: 4,
      requestedRung: 4,
      observedSimultaneousWorkers: 3,
      logicalLaneCount: 12
    })
  }));
  assert.equal(heldRung4.admitted, true);
  assert.equal(heldRung4.decisionCode, 'WORKER_LADDER_RUNG_VERIFIED');
  assert.equal(heldRung4.actualMaxWorkers, 3);
  assert.equal(heldRung4.verifiedCapacityCeiling, 6);
  assert.equal(heldRung4.maxFundedRung, 4);
  assert.equal(heldRung4.shortfallFrom12, 9);
  assert.equal(heldRung4.shortfallFrom10, 7);
  assert.equal(heldRung4.goalMet, false);
  assertCleanTelemetry(heldRung4, 'eligible', 'NONE');

  // Holding rung 12 with <12 observed workers emits WORKER_LADDER_RUNG_VERIFIED, not WORKER_LADDER_MAX_RUNG_VERIFIED
  const heldRung12Partial = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    ladder: makeLadder({
      currentRung: 12,
      verifiedPriorRung: 10,
      requestedRung: 12,
      observedSimultaneousWorkers: 10,
      logicalLaneCount: 12
    })
  }));
  assert.equal(heldRung12Partial.admitted, true);
  assert.equal(heldRung12Partial.decisionCode, 'WORKER_LADDER_RUNG_VERIFIED');
  assert.equal(heldRung12Partial.actualMaxWorkers, 10);
  assert.equal(heldRung12Partial.shortfallFrom12, 2);
  assert.equal(heldRung12Partial.goalMet, true);

  // Steady-state with active lease defaults requestedRung to currentRung, allows executionDeadlineMs < leaseExpiresAtMs, and preserves active-verified lease
  const lease = makeLease({pr: null, executionDeadlineMs: NOW_MS + 60_000, leaseExpiresAtMs: NOW_MS + 300_000});
  const withActiveLease = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    lease,
    primaryProvider: makeProvider({verifiedProviderWorkerCeiling: 10}),
    ladder: makeLadder({
      currentRung: 8,
      verifiedPriorRung: 4,
      observedSimultaneousWorkers: 8,
      logicalLaneCount: 12
    })
  }));
  assert.equal(withActiveLease.admitted, true);
  assert.equal(withActiveLease.decisionCode, 'WORKER_LADDER_RUNG_VERIFIED');
  assert.equal(withActiveLease.actualMaxWorkers, 8);
  assert.equal(withActiveLease.verifiedCapacityCeiling, 10);
  assert.equal(withActiveLease.maxFundedRung, 10);
  assert.equal(withActiveLease.shortfallFrom12, 4);
  assert.equal(withActiveLease.shortfallFrom10, 2);
  assert.equal(withActiveLease.goalMet, false);
  assert.equal(withActiveLease.preservedLease.status, 'active-verified');
  assert.equal(withActiveLease.preservedLease.nextLeaseGeneration, lease.leaseGeneration);

  // Logical lanes MUST NEVER substitute for simultaneous active workers when advancing rungs!
  const logicalLaneIllusion = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    ladder: makeLadder({
      currentRung: 4,
      verifiedPriorRung: 2,
      requestedRung: 8,
      logicalLaneCount: 12,
      observedSimultaneousWorkers: 2
    })
  }));
  assert.equal(logicalLaneIllusion.admitted, false);
  assert.equal(logicalLaneIllusion.reason, 'CAPACITY_UNVERIFIED');
  assert.equal(logicalLaneIllusion.decisionCode, 'LOGICAL_LANES_NOT_ACTIVE_WORKERS');
  assertCleanTelemetry(logicalLaneIllusion, 'blocked', 'QUOTA');

  // Skipping rungs upward or unverified prior rungs fail closed
  for (const skipped of [
    {currentRung: 1, verifiedPriorRung: 0, requestedRung: 4, observedSimultaneousWorkers: 1},
    {currentRung: 2, verifiedPriorRung: 1, requestedRung: 8, observedSimultaneousWorkers: 2},
    {currentRung: 4, verifiedPriorRung: 1, requestedRung: 8, observedSimultaneousWorkers: 4},
    {currentRung: 8, verifiedPriorRung: 2, requestedRung: 10, observedSimultaneousWorkers: 8}
  ]) {
    const res = evaluateWorkerLadderAndQuotaHandoff(makeFixture({ladder: makeLadder(skipped)}));
    assert.equal(res.admitted, false);
    assert.equal(res.reason, 'POLICY_UNKNOWN');
    assert.equal(res.decisionCode, 'WORKER_LADDER_STEP_SKIPPED');
    assertCleanTelemetry(res, 'blocked', 'POLICY');
  }

  for (const badRung of [
    {currentRung: 0},
    {currentRung: 3},
    {currentRung: 6},
    {currentRung: 16},
    {requestedRung: 0},
    {requestedRung: 5},
    {requestedRung: 1.5}
  ]) {
    const res = evaluateWorkerLadderAndQuotaHandoff(makeFixture({ladder: makeLadder(badRung)}));
    assert.equal(res.admitted, false);
    assert.equal(res.reason, 'POLICY_UNKNOWN');
    assert.equal(res.decisionCode, 'WORKER_LADDER_INVALID_RUNG');
  }
});

test('blocks progression on duplicate dispatch, unauthorized writes, unapproved spend, throughput regression, or insufficient capacity', () => {
  const dupRes = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    ladder: makeLadder({duplicateDispatches: 1})
  }));
  assert.equal(dupRes.reason, 'LANE_OR_PATH_RESERVED');
  assert.equal(dupRes.decisionCode, 'DUPLICATE_DISPATCH_DETECTED');
  assertCleanTelemetry(dupRes, 'blocked', 'LEASE');

  const writeRes = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    ladder: makeLadder({unauthorizedWrites: 1})
  }));
  assert.equal(writeRes.reason, 'PROVENANCE_MISMATCH');
  assert.equal(writeRes.decisionCode, 'UNAUTHORIZED_WRITE_DETECTED');
  assertCleanTelemetry(writeRes, 'blocked', 'SECURITY');

  for (const spend of [1, -1]) {
    const spendRes = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
      ladder: makeLadder({unapprovedSpendUsdCents: spend})
    }));
    assert.equal(spendRes.reason, 'BUDGET_UNKNOWN');
    assert.equal(spendRes.decisionCode, 'UNAPPROVED_SPEND_DETECTED');
    assertCleanTelemetry(spendRes, 'blocked', 'QUOTA');
  }

  for (const unhealthy of [{mainHealthy: false}, {qualityGatesClear: false}]) {
    const res = evaluateWorkerLadderAndQuotaHandoff(makeFixture({ladder: makeLadder(unhealthy)}));
    assert.equal(res.reason, 'BASE_OR_MAIN_UNHEALTHY');
    assert.equal(res.decisionCode, 'MAIN_OR_QUALITY_UNHEALTHY');
    assertCleanTelemetry(res, 'blocked', 'CHECKS');
  }

  for (const badObserved of [
    {currentRung: 4, verifiedPriorRung: 2, observedSimultaneousWorkers: 5, logicalLaneCount: 12},
    {currentRung: 4, verifiedPriorRung: 2, observedSimultaneousWorkers: 4, logicalLaneCount: 3}
  ]) {
    const res = evaluateWorkerLadderAndQuotaHandoff(makeFixture({ladder: makeLadder(badObserved)}));
    assert.equal(res.reason, 'EVIDENCE_UNKNOWN');
    assert.equal(res.decisionCode, 'OBSERVED_WORKERS_INVALID');
  }

  const uncomparable = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    ladder: makeLadder({
      throughput: {...makeLadder().throughput, comparabilityVerified: false}
    })
  }));
  assert.equal(uncomparable.reason, 'EVIDENCE_UNKNOWN');
  assert.equal(uncomparable.decisionCode, 'THROUGHPUT_COMPARABILITY_UNVERIFIED');

  // Exact cross-multiplied throughput regression & rework regression
  for (const regressedThroughput of [
    {...makeLadder().throughput, currentAcceptedUnits: 5},
    {...makeLadder().throughput, currentAcceptedUnits: 0},
    {...makeLadder().throughput, currentAcceptedUnits: 6, currentWindowMs: 3_600_001},
    {...makeLadder().throughput, reworkRegressed: true}
  ]) {
    const res = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
      ladder: makeLadder({throughput: regressedThroughput})
    }));
    assert.equal(res.reason, 'CHECKS_INCOMPLETE');
    assert.equal(res.decisionCode, 'THROUGHPUT_REGRESSED');
    assertCleanTelemetry(res, 'blocked', 'CHECKS');
  }

  // Equal accepted rate with omitted reworkRegressed is non-regressing and admitted
  const equalRateTp = {
    comparabilityVerified: true,
    baselineAcceptedUnits: 3,
    baselineWindowMs: 1_800_000,
    currentAcceptedUnits: 6,
    currentWindowMs: 3_600_000
  };
  const equalRateRes = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    ladder: makeLadder({throughput: equalRateTp})
  }));
  assert.equal(equalRateRes.admitted, true);

  for (const badLadder of [
    null,
    makeLadder({currentRung: '2'}),
    makeLadder({verifiedPriorRung: -1}),
    makeLadder({repoConcurrencyCap: 0}),
    makeLadder({repoConcurrencyCap: 1001}),
    makeLadder({logicalLaneCount: 0}),
    makeLadder({logicalLaneCount: 1001}),
    makeLadder({observedSimultaneousWorkers: -1}),
    makeLadder({duplicateDispatches: -1}),
    makeLadder({unauthorizedWrites: -1}),
    makeLadder({unapprovedSpendUsdCents: '0'}),
    makeLadder({mainHealthy: 'true'}),
    makeLadder({qualityGatesClear: 'true'})
  ]) {
    const res = evaluateWorkerLadderAndQuotaHandoff(makeFixture({ladder: badLadder}));
    assert.equal(res.reason, 'EVIDENCE_UNKNOWN');
    assert.equal(res.decisionCode, 'LADDER_EVIDENCE_INVALID');
  }

  for (const badTp of [
    null,
    {...makeLadder().throughput, comparabilityVerified: 'true'},
    {...makeLadder().throughput, baselineAcceptedUnits: 0},
    {...makeLadder().throughput, baselineAcceptedUnits: 1_000_001},
    {...makeLadder().throughput, baselineWindowMs: 0},
    {...makeLadder().throughput, baselineWindowMs: 86_400_000_001},
    {...makeLadder().throughput, currentAcceptedUnits: -1},
    {...makeLadder().throughput, currentAcceptedUnits: 1_000_001},
    {...makeLadder().throughput, currentWindowMs: 0},
    {...makeLadder().throughput, currentWindowMs: 86_400_000_001},
    {...makeLadder().throughput, reworkRegressed: 'false'}
  ]) {
    const res = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
      ladder: makeLadder({throughput: badTp})
    }));
    assert.equal(res.reason, 'EVIDENCE_UNKNOWN');
    assert.equal(res.decisionCode, 'THROUGHPUT_EVIDENCE_INVALID');
  }

  // Capacity ceilings & shortfall reporting (without checkpoint)
  const exhaustedNoLease = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    primaryProvider: makeExhaustedPrimaryProvider()
  }));
  assert.equal(exhaustedNoLease.reason, 'CAPACITY_EXHAUSTED');
  assert.equal(exhaustedNoLease.decisionCode, 'INCLUDED_QUOTA_EXHAUSTED');
  assert.equal(exhaustedNoLease.actualMaxWorkers, 0);
  assert.equal(exhaustedNoLease.shortfallFrom12, 12);

  const ceilingExceeded = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    primaryProvider: makeProvider({verifiedProviderWorkerCeiling: 4}),
    ladder: makeLadder({currentRung: 4, verifiedPriorRung: 2, observedSimultaneousWorkers: 4})
  }));
  assert.equal(ceilingExceeded.reason, 'CAPACITY_UNVERIFIED');
  assert.equal(ceilingExceeded.decisionCode, 'WORKER_LADDER_EXCEEDS_VERIFIED_CEILING');
  assert.equal(ceilingExceeded.actualMaxWorkers, 4);
  assert.equal(ceilingExceeded.shortfallFrom12, 8);

  // Provider ceiling 8, repo cap 8, but remaining units only fund 3 workers -> actualMaxWorkers = 2, blocks 2->4
  const baseProv = makeProvider({verifiedProviderWorkerCeiling: 8});
  const quotaCapped = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    primaryProvider: {
      ...baseProv,
      billingEntitlement: {
        ...baseProv.billingEntitlement,
        accounting: {
          ...baseProv.billingEntitlement.accounting,
          remainingIncludedUnits: 150,
          unitsPerWorkerRun: 50
        }
      }
    },
    ladder: makeLadder({
      currentRung: 2,
      verifiedPriorRung: 1,
      repoConcurrencyCap: 8,
      observedSimultaneousWorkers: 2
    })
  }));
  assert.equal(quotaCapped.reason, 'CAPACITY_EXHAUSTED');
  assert.equal(quotaCapped.decisionCode, 'WORKER_LADDER_CAPACITY_INSUFFICIENT');
  assert.equal(quotaCapped.actualMaxWorkers, 2);
  assert.equal(quotaCapped.shortfallFrom12, 10);
});

test('exercises QUOTA_EXHAUSTED_CHECKPOINT_PAUSED, SHA-256 verification, lease preservation, quota refresh, and provider handoff', () => {
  const lease = makeLease();
  const checkpoint = makeCheckpoint(lease);

  // 1. Mid-run quota exhaustion WITHOUT checkpoint fails closed
  const missingCp = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    primaryProvider: makeExhaustedPrimaryProvider(),
    lease
  }));
  assert.equal(missingCp.admitted, false);
  assert.equal(missingCp.reason, 'STALE_CHECKPOINT');
  assert.equal(missingCp.decisionCode, 'CHECKPOINT_REQUIRED_ON_QUOTA_EXHAUSTION');
  assertCleanTelemetry(missingCp, 'blocked', 'LEASE');

  // 2. Mid-run quota exhaustion WITH valid SHA-256 provider-neutral checkpoint pauses cleanly
  const paused = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    primaryProvider: makeExhaustedPrimaryProvider(),
    lease,
    checkpoint
  }));
  assert.equal(paused.admitted, false);
  assert.equal(paused.shadow, true);
  assert.equal(paused.liveDispatch, false);
  assert.equal(paused.reason, 'CAPACITY_EXHAUSTED');
  assert.equal(paused.decisionCode, 'QUOTA_EXHAUSTED_CHECKPOINT_PAUSED');
  assert.equal(paused.handoffState, 'QUOTA_EXHAUSTED_CHECKPOINT_PAUSED');
  assert.equal(paused.paidFallbackUsed, false);
  assert.equal(paused.blindRetryUsed, false);
  assert.equal(paused.actualMaxWorkers, 0);
  assert.equal(paused.shortfallFrom12, 12);
  assert.deepEqual(paused.preservedLease, {
    leaseId: lease.leaseId,
    repositoryId: REPO_ID,
    issue: 7,
    pr: 210,
    headSha: HEAD_SHA,
    lane: 'worker-ladder-handoff',
    ownedPaths: ['src/feature/worker-task.mjs'],
    workerId: 'copilot-worker-1',
    leaseGeneration: 2,
    nextLeaseGeneration: 2,
    leaseExpiresAtMs: lease.leaseExpiresAtMs,
    executionDeadlineMs: lease.executionDeadlineMs,
    status: 'checkpoint-paused'
  });
  assert.equal(paused.checkpointReceipt.verifiedSha256, true);
  assert.equal(paused.checkpointReceipt.sha256, checkpoint.sha256);
  assert.equal(Object.isFrozen(paused.preservedLease), true);
  assert.equal(Object.isFrozen(paused.preservedLease.ownedPaths), true);
  assert.equal(Object.isFrozen(paused.checkpointReceipt), true);
  assertCleanTelemetry(paused, 'blocked', 'QUOTA');

  // 3. Checking quota-refresh while quota is STILL exhausted stays paused cleanly (no blind retry)
  const stillPaused = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    primaryProvider: makeExhaustedPrimaryProvider(),
    lease,
    checkpoint,
    handoff: {mode: 'quota-refresh', attempt: 1, maxAttempts: 3}
  }));
  assert.equal(stillPaused.admitted, false);
  assert.equal(stillPaused.decisionCode, 'QUOTA_EXHAUSTED_CHECKPOINT_PAUSED');
  assert.equal(stillPaused.detail, 'QUOTA_NOT_YET_REFRESHED');
  assert.equal(stillPaused.preservedLease.status, 'checkpoint-paused');
  assertCleanTelemetry(stillPaused, 'blocked', 'QUOTA');

  // 4. Stale quota snapshot predating checkpoint creation is rejected on both implicit & explicit refresh
  const staleRefreshProvider = makeProvider();
  staleRefreshProvider.billingEntitlement.accounting.observedAtMs = checkpoint.createdAtMs;
  for (const handoffOpt of [undefined, {mode: 'quota-refresh', attempt: 1}]) {
    const payload = makeFixture({
      primaryProvider: staleRefreshProvider,
      lease,
      checkpoint,
      ...(handoffOpt ? {handoff: handoffOpt} : {})
    });
    const staleRefresh = evaluateWorkerLadderAndQuotaHandoff(payload);
    assert.equal(staleRefresh.admitted, false);
    assert.equal(staleRefresh.reason, 'STALE_QUOTA');
    assert.equal(staleRefresh.decisionCode, 'QUOTA_REFRESH_PRECEDES_CHECKPOINT');
    assert.equal(staleRefresh.preservedLease.status, 'checkpoint-paused');
    assertCleanTelemetry(staleRefresh, 'blocked', 'STALE');
  }

  // 5. Refreshed included quota (observedAtMs > checkpoint.createdAtMs) resumes cleanly (both implicit & explicit)
  for (const handoffOpt of [undefined, {mode: 'quota-refresh', attempt: 2, maxAttempts: 3}]) {
    const resumed = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
      primaryProvider: makeProvider(),
      lease,
      checkpoint,
      ...(handoffOpt ? {handoff: handoffOpt} : {})
    }));
    assert.equal(resumed.admitted, true);
    assert.equal(resumed.reason, 'SHADOW_ALLOCATION');
    assert.equal(resumed.decisionCode, 'CHECKPOINT_RESUMED_ON_QUOTA_REFRESH');
    assert.equal(resumed.handoffState, 'RESUMED_INCLUDED_QUOTA_REFRESH');
    assert.equal(resumed.preservedLease.status, 'resumed-ready');
    assert.equal(resumed.preservedLease.nextLeaseGeneration, 3);
    assert.equal(resumed.actualMaxWorkers, 2);
    assert.equal(resumed.verifiedCapacityCeiling, 12);
    assert.equal(resumed.maxFundedRung, 12);
    assert.equal(resumed.shortfallFrom12, 10);
    assertCleanTelemetry(resumed, 'eligible', 'NONE');
  }

  // Refreshed quota insufficient for requestedRung blocks cleanly while keeping checkpoint receipt
  const smallRefreshProvider = makeProvider({verifiedProviderWorkerCeiling: 2});
  for (const handoffOpt of [undefined, {mode: 'quota-refresh', attempt: 1}]) {
    const blockedRung = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
      primaryProvider: smallRefreshProvider,
      ladder: makeLadder({currentRung: 4, verifiedPriorRung: 2, observedSimultaneousWorkers: 4}),
      lease,
      checkpoint,
      ...(handoffOpt ? {handoff: handoffOpt} : {})
    }));
    assert.equal(blockedRung.admitted, false);
    assert.equal(blockedRung.decisionCode, 'WORKER_LADDER_CAPACITY_INSUFFICIENT');
    assert.equal(blockedRung.actualMaxWorkers, 2);
    assert.equal(blockedRung.shortfallFrom12, 10);
  }

  // 6. Eligible provider-neutral handoff to owner-authorized included alternate providers (Codex & Claude)
  for (const [family, harnessKind, modelId, ceiling, targetRung] of [
    ['openai-codex', 'openai-codex-action', 'gpt-5.4-codex', 4, 2],
    ['anthropic-claude', 'claude-agent-sdk', 'claude-sonnet-4.6', 2, 1]
  ]) {
    const targetProvider = makeProvider({
      providerFamily: family,
      verifiedProviderWorkerCeiling: ceiling,
      model: {
        id: modelId,
        allowlist: [modelId],
        verifiedAvailable: true,
        provider: family
      },
      harness: {
        kind: harnessKind,
        verified: true,
        externalTracingDisabled: true
      },
      runner: {
        kind: 'cloud-sandbox',
        verified: true,
        ephemeral: true,
        isolated: true
      }
    });
    const handedOff = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
      primaryProvider: makeExhaustedPrimaryProvider(),
      ladder: makeLadder({
        currentRung: 4,
        verifiedPriorRung: 2,
        requestedRung: targetRung,
        observedSimultaneousWorkers: 4
      }),
      lease,
      checkpoint,
      handoff: {
        mode: 'provider-handoff',
        attempt: 1,
        maxAttempts: 3,
        targetProvider
      }
    }));
    assert.equal(handedOff.admitted, true);
    assert.equal(handedOff.reason, 'SHADOW_ALLOCATION');
    assert.equal(handedOff.decisionCode, 'CHECKPOINT_HANDOFF_TO_INCLUDED_PROVIDER');
    assert.equal(handedOff.handoffState, 'HANDOFF_ELIGIBLE');
    assert.equal(handedOff.selectedProvider.providerFamily, family);
    assert.equal(handedOff.selectedProvider.harness, harnessKind);
    assert.equal(handedOff.selectedProvider.runner, 'cloud-sandbox');
    assert.equal(handedOff.actualMaxWorkers, targetRung);
    assert.equal(handedOff.verifiedCapacityCeiling, ceiling);
    assert.equal(handedOff.shortfallFrom12, 12 - targetRung);
    assert.equal(handedOff.preservedLease.status, 'handoff-ready');
    assert.equal(handedOff.preservedLease.nextLeaseGeneration, 3);
    assert.deepEqual(handedOff.preservedLease.ownedPaths, lease.ownedPaths);
    assertCleanTelemetry(handedOff, 'eligible', 'NONE');
  }
});

test('enforces checkpoint SHA-256 integrity, secret prohibition, bounded retries, and handoff denials', () => {
  const lease = makeLease();
  const checkpoint = makeCheckpoint(lease);

  // Tampered serializedState or wrong sha256 -> CHECKPOINT_SHA256_MISMATCH
  const tamperedState = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    primaryProvider: makeExhaustedPrimaryProvider(),
    lease,
    checkpoint: {
      ...checkpoint,
      serializedState: JSON.stringify({issue: 7, headSha: HEAD_SHA, tampered: true})
    }
  }));
  assert.equal(tamperedState.admitted, false);
  assert.equal(tamperedState.reason, 'STALE_CHECKPOINT');
  assert.equal(tamperedState.decisionCode, 'CHECKPOINT_SHA256_MISMATCH');
  assertCleanTelemetry(tamperedState, 'blocked', 'LEASE');

  // Embedded secrets in serializedState fail closed with PROVIDER_FORBIDDEN (using dynamic non-live canary prefixes)
  const patClassic = `${'gh' + 'p'}_canaryValue`;
  const patFine = `${'github' + '_pat'}_canaryValue`;
  const antKey = `${'sk' + '-ant'}-canaryValue`;
  const bearerHdr = `${'Bear' + 'er'} syntheticHeaderValue`;
  const pemBlock = ['-----BEGIN', 'TEST', 'PRIVATE', 'KEY-----'].join(' ');
  for (const secretSnippet of [patClassic, patFine, antKey, bearerHdr, pemBlock]) {
    const badJson = JSON.stringify(makeSerializedStateObject(lease, {note: secretSnippet}));
    const secretCp = makeCheckpoint(lease, {
      serializedState: badJson,
      sha256: computeCheckpointSha256(badJson)
    });
    const res = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
      primaryProvider: makeExhaustedPrimaryProvider(),
      lease,
      checkpoint: secretCp
    }));
    assert.equal(res.reason, 'PROVIDER_FORBIDDEN');
    assert.equal(res.decisionCode, 'CHECKPOINT_SECRET_TOKEN_FORBIDDEN');
    assertCleanTelemetry(res, 'blocked', 'SECURITY');
  }

  // Non-provider-neutral checkpoint rejected
  const lockedCp = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    primaryProvider: makeExhaustedPrimaryProvider(),
    lease,
    checkpoint: {...checkpoint, providerNeutral: false}
  }));
  assert.equal(lockedCp.reason, 'POLICY_UNKNOWN');
  assert.equal(lockedCp.decisionCode, 'CHECKPOINT_NOT_PROVIDER_NEUTRAL');

  // Envelope vs lease mismatches
  for (const mismatch of [
    {repositoryId: REPO_ID + 1},
    {issue: 99},
    {pr: 999},
    {headSha: 'f'.repeat(40)},
    {lane: 'other-lane'},
    {leaseGeneration: 1},
    {ownedPaths: ['docs/SHADOW-DISPATCH-LEDGER.md']}
  ]) {
    const res = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
      primaryProvider: makeExhaustedPrimaryProvider(),
      lease,
      checkpoint: {...checkpoint, ...mismatch}
    }));
    assert.equal(res.reason, 'STALE_CHECKPOINT');
    assert.equal(res.decisionCode, 'CHECKPOINT_LEASE_MISMATCH');
  }

  // Oversized or empty serializedState (with syntactically valid 64-hex sha256)
  for (const badRaw of ['', 'x'.repeat(MAX_SERIALIZED_CHECKPOINT_BYTES + 1)]) {
    const res = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
      primaryProvider: makeExhaustedPrimaryProvider(),
      lease,
      checkpoint: {...checkpoint, serializedState: badRaw, sha256: '0'.repeat(64)}
    }));
    assert.equal(res.reason, 'STALE_CHECKPOINT');
    assert.equal(res.decisionCode, 'CHECKPOINT_PAYLOAD_OVERSIZED_OR_EMPTY');
  }

  // Malformed JSON, non-object JSON, __proto__ key, >32 keys, or >5 nesting depth inside serializedState
  const tooManyKeysObj = Object.fromEntries(Array.from({length: 33}, (_, i) => [`k${i}`, i]));
  const tooDeepJson = JSON.stringify({issue: 7, headSha: HEAD_SHA, a: {b: {c: {d: {e: {f: 1}}}}}});
  const protoJson = `{"__proto__":{"x":1},"issue":7,"headSha":"${HEAD_SHA}"}`;
  const issueOnlyLease = makeLease({
    ownedPaths: ['src/feature/worker-task.mjs', 'docs/SHADOW-DISPATCH-LEDGER.md']
  });
  delete issueOnlyLease.pr;
  const arrayNestedJson = JSON.stringify(
    makeSerializedStateObject(issueOnlyLease, {items: [1, true, null, 'ok']})
  );
  const issueOnlyCp = makeCheckpoint(issueOnlyLease, {
    ownedPaths: ['docs/SHADOW-DISPATCH-LEDGER.md', 'src/feature/worker-task.mjs'],
    serializedState: arrayNestedJson,
    sha256: computeCheckpointSha256(arrayNestedJson)
  });
  delete issueOnlyCp.pr;
  const okNested = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    primaryProvider: makeExhaustedPrimaryProvider(),
    lease: issueOnlyLease,
    checkpoint: issueOnlyCp
  }));
  assert.equal(okNested.decisionCode, 'QUOTA_EXHAUSTED_CHECKPOINT_PAUSED');
  assert.equal(okNested.preservedLease.pr, null);

  for (const invalidSerialized of [
    '{not-json',
    'null',
    '[1,2,3]',
    '"string"',
    protoJson,
    JSON.stringify(tooManyKeysObj),
    tooDeepJson
  ]) {
    const res = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
      primaryProvider: makeExhaustedPrimaryProvider(),
      lease,
      checkpoint: {
        ...checkpoint,
        serializedState: invalidSerialized,
        sha256: computeCheckpointSha256(invalidSerialized)
      }
    }));
    assert.equal(res.reason, 'STALE_CHECKPOINT');
    assert.equal(res.decisionCode, 'CHECKPOINT_SERIALIZED_JSON_INVALID');
  }

  // Inner serializedState binding mismatch or omitted binding field against outer lease/checkpoint
  const withoutPr = makeSerializedStateObject(lease);
  delete withoutPr.pr;
  const withoutGen = makeSerializedStateObject(lease);
  delete withoutGen.leaseGeneration;
  for (const mismatchedObj of [
    withoutPr,
    withoutGen,
    makeSerializedStateObject(lease, {issue: 999}),
    makeSerializedStateObject(lease, {headSha: 'b'.repeat(40)}),
    makeSerializedStateObject(lease, {lane: 'wrong-lane'}),
    makeSerializedStateObject(lease, {checkpointRevision: 99})
  ]) {
    const raw = JSON.stringify(mismatchedObj);
    const res = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
      primaryProvider: makeExhaustedPrimaryProvider(),
      lease,
      checkpoint: {...checkpoint, serializedState: raw, sha256: computeCheckpointSha256(raw)}
    }));
    assert.equal(res.reason, 'STALE_CHECKPOINT');
    assert.equal(res.decisionCode, 'CHECKPOINT_STATE_BINDING_MISMATCH');
  }

  // Malformed checkpoint envelopes & missing prerequisites
  const cpWithoutLease = evaluateWorkerLadderAndQuotaHandoff(makeFixture({checkpoint}));
  assert.equal(cpWithoutLease.reason, 'LEASE_OR_CLOCK_UNKNOWN');
  assert.equal(cpWithoutLease.decisionCode, 'CHECKPOINT_WITHOUT_LEASE');

  const handoffWithoutCp = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    lease,
    handoff: {mode: 'quota-refresh', attempt: 1}
  }));
  assert.equal(handoffWithoutCp.reason, 'STALE_CHECKPOINT');
  assert.equal(handoffWithoutCp.decisionCode, 'HANDOFF_REQUIRES_VERIFIED_CHECKPOINT');

  for (const badCp of [
    null,
    {...checkpoint, schemaVersion: 2},
    {...checkpoint, checkpointId: 'bad id!'},
    {...checkpoint, providerNeutral: 'true'},
    {...checkpoint, repositoryId: 0},
    {...checkpoint, issue: 0},
    {...checkpoint, pr: 0},
    {...checkpoint, headSha: 'short'},
    {...checkpoint, lane: 'BAD LANE'},
    {...checkpoint, ownedPaths: []},
    {...checkpoint, leaseGeneration: 0},
    {...checkpoint, checkpointRevision: 0},
    {...checkpoint, createdAtMs: -1},
    {...checkpoint, createdAtMs: NOW_MS + 1},
    {...checkpoint, serializedState: 123},
    {...checkpoint, sha256: 'not-hex'}
  ]) {
    const res = evaluateWorkerLadderAndQuotaHandoff(makeFixture({lease, checkpoint: badCp}));
    assert.equal(res.reason, 'STALE_CHECKPOINT');
    assert.equal(res.decisionCode, 'CHECKPOINT_ENVELOPE_INVALID');
  }

  // Paid fallback, blind retries, bounded attempt caps, and invalid handoff specs
  const paidFallback = evaluateWorkerLadderAndQuotaHandoff(makeFixture({paidFallbackRequested: true}));
  assert.equal(paidFallback.reason, 'PROVIDER_FORBIDDEN');
  assert.equal(paidFallback.decisionCode, 'PAID_FALLBACK_FORBIDDEN');

  const blindRetry = evaluateWorkerLadderAndQuotaHandoff(makeFixture({blindRetryRequested: true}));
  assert.equal(blindRetry.reason, 'POLICY_UNKNOWN');
  assert.equal(blindRetry.decisionCode, 'BLIND_RETRY_FORBIDDEN');

  for (const badHandoff of [
    null,
    {mode: 'blind-retry', attempt: 1},
    {mode: 'quota-refresh', attempt: 0}
  ]) {
    const res = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
      primaryProvider: makeExhaustedPrimaryProvider(),
      lease,
      checkpoint,
      handoff: badHandoff
    }));
    assert.equal(res.reason, 'EVIDENCE_UNKNOWN');
    assert.equal(res.decisionCode, 'HANDOFF_SPEC_INVALID');
  }

  for (const badMax of [0, MAX_ALLOWED_HANDOFF_ATTEMPTS + 1, '3']) {
    const res = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
      primaryProvider: makeExhaustedPrimaryProvider(),
      lease,
      checkpoint,
      handoff: {mode: 'quota-refresh', attempt: 1, maxAttempts: badMax}
    }));
    assert.equal(res.reason, 'INVALID_POLICY');
    assert.equal(res.decisionCode, 'HANDOFF_MAX_ATTEMPTS_INVALID');
  }

  const capExceeded = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    primaryProvider: makeExhaustedPrimaryProvider(),
    lease,
    checkpoint,
    handoff: {mode: 'quota-refresh', attempt: 4}
  }));
  assert.equal(capExceeded.reason, 'POLICY_UNKNOWN');
  assert.equal(capExceeded.decisionCode, 'HANDOFF_ATTEMPT_CAP_EXCEEDED');

  const unexpectedTarget = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    primaryProvider: makeExhaustedPrimaryProvider(),
    lease,
    checkpoint,
    handoff: {mode: 'quota-refresh', attempt: 1, targetProvider: makeProvider()}
  }));
  assert.equal(unexpectedTarget.reason, 'EVIDENCE_UNKNOWN');
  assert.equal(unexpectedTarget.decisionCode, 'UNEXPECTED_TARGET_PROVIDER');

  // Provider-handoff denied if primary quota is NOT exhausted
  const primaryNotExhausted = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    primaryProvider: makeProvider(),
    lease,
    checkpoint,
    handoff: {mode: 'provider-handoff', attempt: 1, targetProvider: makeProvider()}
  }));
  assert.equal(primaryNotExhausted.reason, 'POLICY_UNKNOWN');
  assert.equal(primaryNotExhausted.decisionCode, 'PRIMARY_QUOTA_NOT_EXHAUSTED');

  // Target provider unauthorized, paid overage, unverified commitments, exhausted quota, or insufficient rung ceiling
  const unauthTarget = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    primaryProvider: makeExhaustedPrimaryProvider(),
    lease,
    checkpoint,
    handoff: {
      mode: 'provider-handoff',
      attempt: 1,
      targetProvider: makeProvider({ownerAuthorized: false})
    }
  }));
  assert.equal(unauthTarget.reason, 'STOPPED_OR_UNAUTHORIZED');
  assert.equal(unauthTarget.decisionCode, 'HANDOFF_PROVIDER_UNAUTHORIZED');
  assert.equal(unauthTarget.preservedLease.status, 'checkpoint-paused');

  const exhaustedTarget = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    primaryProvider: makeExhaustedPrimaryProvider(),
    lease,
    checkpoint,
    handoff: {
      mode: 'provider-handoff',
      attempt: 1,
      targetProvider: makeExhaustedPrimaryProvider()
    }
  }));
  assert.equal(exhaustedTarget.reason, 'CAPACITY_EXHAUSTED');
  assert.equal(exhaustedTarget.decisionCode, 'QUOTA_EXHAUSTED_CHECKPOINT_PAUSED');
  assert.equal(exhaustedTarget.detail, 'HANDOFF_TARGET_QUOTA_EXHAUSTED');

  const underRungTarget = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    primaryProvider: makeExhaustedPrimaryProvider(),
    ladder: makeLadder({currentRung: 4, verifiedPriorRung: 2, observedSimultaneousWorkers: 4}),
    lease,
    checkpoint,
    handoff: {
      mode: 'provider-handoff',
      attempt: 1,
      targetProvider: makeProvider({verifiedProviderWorkerCeiling: 2})
    }
  }));
  assert.equal(underRungTarget.reason, 'CAPACITY_EXHAUSTED');
  assert.equal(underRungTarget.decisionCode, 'WORKER_LADDER_CAPACITY_INSUFFICIENT');
  assert.equal(underRungTarget.actualMaxWorkers, 2);

  // Target provider quota observed before checkpoint creation fails closed as stale
  const preCheckpointTarget = makeProvider();
  preCheckpointTarget.billingEntitlement.accounting.observedAtMs = checkpoint.createdAtMs - 1;
  const staleTargetRes = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    primaryProvider: makeExhaustedPrimaryProvider(),
    lease,
    checkpoint,
    handoff: {
      mode: 'provider-handoff',
      attempt: 1,
      targetProvider: preCheckpointTarget
    }
  }));
  assert.equal(staleTargetRes.reason, 'STALE_QUOTA');
  assert.equal(staleTargetRes.decisionCode, 'HANDOFF_TARGET_QUOTA_PRECEDES_CHECKPOINT');

  // Same-length ownedPaths with different file rejected; MAX_SAFE_INTEGER leaseGeneration rejected; oversubscribed peers rejected
  assert.equal(
    evaluateWorkerLadderAndQuotaHandoff(makeFixture({
      primaryProvider: makeExhaustedPrimaryProvider(),
      lease: makeLease({ownedPaths: ['src/a.mjs', 'src/b.mjs']}),
      checkpoint: makeCheckpoint(makeLease({ownedPaths: ['src/a.mjs', 'src/b.mjs']}), {
        ownedPaths: ['src/a.mjs', 'src/c.mjs']
      })
    })).decisionCode,
    'CHECKPOINT_LEASE_MISMATCH'
  );
  assert.equal(
    evaluateWorkerLadderAndQuotaHandoff(makeFixture({
      lease: makeLease({leaseGeneration: Number.MAX_SAFE_INTEGER})
    })).decisionCode,
    'OWNED_LEASE_INVALID'
  );
  assert.equal(
    evaluateWorkerLadderAndQuotaHandoff(makeFixture({
      primaryProvider: makeProvider({verifiedProviderWorkerCeiling: 1}),
      activePeerLeases: [
        {
          leaseId: 'p1',
          issue: 201,
          lane: 'l1',
          ownedPaths: ['src/one.mjs'],
          leaseGeneration: 1,
          expiresAtMs: NOW_MS + 30_000,
          reservedUnits: 50,
          reservedRequests: 2
        },
        {
          leaseId: 'p2',
          issue: 202,
          lane: 'l2',
          ownedPaths: ['src/two.mjs'],
          leaseGeneration: 1,
          expiresAtMs: NOW_MS + 30_000,
          reservedUnits: 50,
          reservedRequests: 2
        }
      ]
    })).decisionCode,
    'ACTIVE_PEERS_EXCEED_VERIFIED_CEILING'
  );
});

test('validates 4-part provider capabilities, peer leases, protected control-plane paths, and CAS fencing', () => {
  // Top-level stop, PAT, identity, scope, visibility/clock
  assert.equal(evaluateWorkerLadderAndQuotaHandoff(makeFixture({stop: true})).reason, 'STOPPED');
  assert.equal(
    evaluateWorkerLadderAndQuotaHandoff(makeFixture({personalPatInActionsSecrets: true})).decisionCode,
    'PERSONAL_PAT_FORBIDDEN'
  );
  assert.equal(
    evaluateWorkerLadderAndQuotaHandoff(makeFixture({repositoryId: 0})).decisionCode,
    'REPOSITORY_IDENTITY_INVALID'
  );
  assert.equal(
    evaluateWorkerLadderAndQuotaHandoff(makeFixture({approvedRepositoryId: 99})).decisionCode,
    'REPOSITORY_SCOPE_MISMATCH'
  );
  for (const badEnv of [{repositoryVisibility: 'org-wide'}, {nowMs: -1}]) {
    assert.equal(
      evaluateWorkerLadderAndQuotaHandoff(makeFixture(badEnv)).decisionCode,
      'REPOSITORY_OR_CLOCK_INVALID'
    );
  }

  // Provider capability variants: Cloud Automation (private/internal vs public) & Copilot SDK 2.0.3
  const privAuto = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    repositoryVisibility: 'private',
    primaryProvider: (() => {
      const p = makeProvider({
        harness: {kind: 'copilot-cloud-automation', verified: true, externalTracingDisabled: true}
      });
      delete p.model.provider;
      delete p.billingEntitlement.ghAwCaps;
      p.billingEntitlement.maxQuotaAgeMs = 120_000;
      p.billingEntitlement.accounting.requestsPerWorkerRun = 0;
      return p;
    })()
  }));
  assert.equal(privAuto.admitted, true);

  const pubAuto = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    repositoryVisibility: 'public',
    primaryProvider: makeProvider({harness: {kind: 'copilot-cloud-automation', verified: true}})
  }));
  assert.equal(pubAuto.decisionCode, 'AUTOMATIONS_REQUIRE_PRIVATE_REPO');

  const sdkOk = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    primaryProvider: makeProvider({harness: {kind: 'copilot-sdk', verified: true, sdkVersion: 'v2.0.3'}})
  }));
  assert.equal(sdkOk.admitted, true);
  assert.equal(sdkOk.selectedProvider.sdkVersion, '2.0.3');

  for (const badSdk of [
    makeProvider({harness: {kind: 'copilot-sdk', verified: true}}),
    makeProvider({harness: {kind: 'copilot-sdk', verified: true, sdkVersion: '2.0.2'}}),
    makeProvider({harness: {kind: 'copilot-sdk', verified: true, sdkVersion: 203}})
  ]) {
    assert.equal(
      evaluateWorkerLadderAndQuotaHandoff(makeFixture({primaryProvider: badSdk})).decisionCode,
      'SDK_VERSION_MISMATCH'
    );
  }

  assert.equal(
    evaluateWorkerLadderAndQuotaHandoff(makeFixture({
      primaryProvider: makeProvider({
        harness: {kind: 'copilot-cloud-agent', verified: true, sdkVersion: '2.0.3'}
      })
    })).decisionCode,
    'UNEXPECTED_SDK_VERSION'
  );

  // Provider family, auth, runner, harness, model, and billing rejections
  for (const [providerPatch, expectedCode] of [
    [null, 'PRIMARY_PROVIDER_CAPABILITY_INVALID'],
    [makeProvider({providerFamily: 123}), 'PRIMARY_PROVIDER_CAPABILITY_INVALID'],
    [makeProvider({ownerAuthorized: 'yes'}), 'PRIMARY_PROVIDER_CAPABILITY_INVALID'],
    [makeProvider({approvedRepositoryId: 0}), 'PRIMARY_PROVIDER_CAPABILITY_INVALID'],
    [makeProvider({independentAuthorizationVerified: 'yes'}), 'PRIMARY_PROVIDER_CAPABILITY_INVALID'],
    [makeProvider({verifiedProviderWorkerCeiling: 0}), 'PRIMARY_PROVIDER_CAPABILITY_INVALID'],
    [makeProvider({verifiedProviderWorkerCeiling: 1001}), 'PRIMARY_PROVIDER_CAPABILITY_INVALID'],
    [makeProvider({providerFamily: 'GitHub-Models'}), 'RETIRED_PROVIDER_FORBIDDEN'],
    [makeProvider({providerFamily: 'unknown-vendor'}), 'UNSUPPORTED_PROVIDER_FAMILY'],
    [makeProvider({ownerAuthorized: false}), 'PRIMARY_PROVIDER_UNAUTHORIZED'],
    [makeProvider({approvedRepositoryId: 999}), 'PRIMARY_REPOSITORY_SCOPE_MISMATCH'],
    [makeProvider({independentAuthorizationVerified: false}), 'PRIMARY_INDEPENDENT_AUTH_UNVERIFIED'],
    [makeProvider({runner: null}), 'RUNNER_CAPABILITY_INVALID'],
    [makeProvider({runner: {kind: 1, verified: true, ephemeral: true, isolated: true}}), 'RUNNER_CAPABILITY_INVALID'],
    [makeProvider({runner: {kind: 'github-hosted', verified: 'y', ephemeral: true, isolated: true}}), 'RUNNER_CAPABILITY_INVALID'],
    [makeProvider({runner: {kind: 'github-hosted', verified: true, ephemeral: 'y', isolated: true}}), 'RUNNER_CAPABILITY_INVALID'],
    [makeProvider({runner: {kind: 'github-hosted', verified: true, ephemeral: true, isolated: 'y'}}), 'RUNNER_CAPABILITY_INVALID'],
    [makeProvider({runner: {kind: 'laptop', verified: true, ephemeral: true, isolated: true}}), 'UNSUPPORTED_OPERATIONAL_RUNNER'],
    [makeProvider({runner: {kind: 'github-hosted', verified: false, ephemeral: true, isolated: true}}), 'RUNNER_ISOLATION_UNVERIFIED'],
    [makeProvider({runner: {kind: 'github-hosted', verified: true, ephemeral: false, isolated: true}}), 'RUNNER_ISOLATION_UNVERIFIED'],
    [makeProvider({runner: {kind: 'github-hosted', verified: true, ephemeral: true, isolated: false}}), 'RUNNER_ISOLATION_UNVERIFIED'],
    [makeProvider({harness: null}), 'HARNESS_CAPABILITY_INVALID'],
    [makeProvider({harness: {kind: 1, verified: true}}), 'HARNESS_CAPABILITY_INVALID'],
    [makeProvider({harness: {kind: 'copilot-cloud-agent', verified: 'yes'}}), 'HARNESS_CAPABILITY_INVALID'],
    [makeProvider({harness: {kind: 'copilot-cloud-agent', verified: true, externalTracingDisabled: 'yes'}}), 'HARNESS_CAPABILITY_INVALID'],
    [makeProvider({harness: {kind: 'claude-code-action', verified: true}}), 'UNSUPPORTED_HARNESS'],
    [makeProvider({harness: {kind: 'copilot-cloud-agent', verified: false}}), 'HARNESS_UNVERIFIED'],
    [makeProvider({harness: {kind: 'copilot-cloud-agent', verified: true, agentLogin: 'impostor'}}), 'AGENT_IDENTITY_MISMATCH'],
    [makeProvider({providerFamily: 'openai-codex', harness: {kind: 'openai-codex-action', verified: true}}), 'EXTERNAL_TRACING_FORBIDDEN'],
    [makeProvider({model: null}), 'MODEL_CAPABILITY_INVALID'],
    [makeProvider({model: {id: '', allowlist: ['gpt-5.4'], verifiedAvailable: true}}), 'MODEL_CAPABILITY_INVALID'],
    [makeProvider({model: {id: 'gpt-5.4', allowlist: [], verifiedAvailable: true}}), 'MODEL_CAPABILITY_INVALID'],
    [makeProvider({model: {id: 'gpt-5.4', allowlist: ['gpt-5.4', 'gpt-5.4'], verifiedAvailable: true}}), 'MODEL_CAPABILITY_INVALID'],
    [makeProvider({model: {id: 'gpt-5.4', allowlist: ['bad id!'], verifiedAvailable: true}}), 'MODEL_CAPABILITY_INVALID'],
    [makeProvider({model: {id: 'gpt-5.4', allowlist: ['gpt-5.4'], verifiedAvailable: 'yes'}}), 'MODEL_CAPABILITY_INVALID'],
    [makeProvider({model: {id: 'gpt-5.4', allowlist: ['gpt-5.4'], verifiedAvailable: true, provider: 'bad!'}}), 'MODEL_CAPABILITY_INVALID'],
    [makeProvider({model: {id: 'gpt-5.4', allowlist: ['gpt-5.4'], verifiedAvailable: true, provider: 'github-models'}}), 'RETIRED_PROVIDER_FORBIDDEN'],
    [makeProvider({model: {id: 'other', allowlist: ['gpt-5.4'], verifiedAvailable: true}}), 'MODEL_NOT_ALLOWLISTED'],
    [makeProvider({model: {id: 'gpt-5.4', allowlist: ['gpt-5.4'], verifiedAvailable: false}}), 'MODEL_AVAILABILITY_UNVERIFIED']
  ]) {
    const res = evaluateWorkerLadderAndQuotaHandoff(makeFixture({primaryProvider: providerPatch}));
    assert.equal(res.admitted, false);
    assert.equal(res.decisionCode, expectedCode);
  }

  // Billing, accounting, staleness, and ghAwCaps gates
  const validBilling = makeProvider().billingEntitlement;
  const validAcct = validBilling.accounting;
  for (const [billingPatch, expectedCode] of [
    [null, 'BILLING_CAPABILITY_INVALID'],
    [{...validBilling, entitlementVerified: 'yes'}, 'BILLING_CAPABILITY_INVALID'],
    [{...validBilling, includedOnly: 'yes'}, 'BILLING_CAPABILITY_INVALID'],
    [{...validBilling, paidOverageEnabled: 'no'}, 'BILLING_CAPABILITY_INVALID'],
    [{...validBilling, overageHardStopUsdCents: '0'}, 'BILLING_CAPABILITY_INVALID'],
    [{...validBilling, hardStopEnforced: 'yes'}, 'BILLING_CAPABILITY_INVALID'],
    [{...validBilling, incrementalBilledUsdCents: '0'}, 'BILLING_CAPABILITY_INVALID'],
    [{...validBilling, paidOverageEnabled: true}, 'PAID_OVERAGE_NOT_HARD_STOPPED'],
    [{...validBilling, overageHardStopUsdCents: 100}, 'PAID_OVERAGE_NOT_HARD_STOPPED'],
    [{...validBilling, hardStopEnforced: false}, 'PAID_OVERAGE_NOT_HARD_STOPPED'],
    [{...validBilling, entitlementVerified: false}, 'BILLING_ENTITLEMENT_UNVERIFIED'],
    [{...validBilling, includedOnly: false}, 'BILLING_ENTITLEMENT_UNVERIFIED'],
    [{...validBilling, incrementalBilledUsdCents: 1}, 'INCREMENTAL_SPEND_NONZERO'],
    [{...validBilling, maxQuotaAgeMs: 0}, 'ACCOUNTING_ESTIMATED_OR_MISSING'],
    [{...validBilling, maxQuotaAgeMs: MAX_ALLOWED_QUOTA_AGE_MS + 1}, 'ACCOUNTING_ESTIMATED_OR_MISSING'],
    [{...validBilling, accounting: null}, 'ACCOUNTING_ESTIMATED_OR_MISSING'],
    [{...validBilling, accounting: {...validAcct, accountingSource: 'estimated'}}, 'ACCOUNTING_ESTIMATED_OR_MISSING'],
    [{...validBilling, accounting: {...validAcct, isEstimated: true}}, 'ACCOUNTING_ESTIMATED_OR_MISSING'],
    [{...validBilling, accounting: {...validAcct, observedAtMs: -1}}, 'ACCOUNTING_ESTIMATED_OR_MISSING'],
    [{...validBilling, accounting: {...validAcct, remainingIncludedUnits: -1}}, 'ACCOUNTING_ESTIMATED_OR_MISSING'],
    [{...validBilling, accounting: {...validAcct, unitsPerWorkerRun: 0}}, 'ACCOUNTING_ESTIMATED_OR_MISSING'],
    [{...validBilling, accounting: {...validAcct, unitsPerWorkerRun: 1_000_000_001}}, 'ACCOUNTING_ESTIMATED_OR_MISSING'],
    [{...validBilling, accounting: {...validAcct, remainingIncludedRequests: -1}}, 'ACCOUNTING_ESTIMATED_OR_MISSING'],
    [{...validBilling, accounting: {...validAcct, requestsPerWorkerRun: -1}}, 'ACCOUNTING_ESTIMATED_OR_MISSING'],
    [{...validBilling, accounting: {...validAcct, netOfReservationsVerified: 'yes'}}, 'ACCOUNTING_ESTIMATED_OR_MISSING'],
    [{...validBilling, accounting: {...validAcct, dailyUsageIncludesReservations: 'yes'}}, 'ACCOUNTING_ESTIMATED_OR_MISSING'],
    [{...validBilling, accounting: {...validAcct, observedAtMs: NOW_MS + 1}}, 'STALE_QUOTA_OBSERVATION'],
    [{...validBilling, accounting: {...validAcct, observedAtMs: NOW_MS - DEFAULT_MAX_QUOTA_AGE_MS - 1}}, 'STALE_QUOTA_OBSERVATION'],
    [{...validBilling, ghAwCaps: null}, 'GH_AW_SOFT_CAPS_INVALID'],
    [{...validBilling, ghAwCaps: {maxRunUnits: 0, maxDailyUnits: 100, dailyUnitsUsed: 0}}, 'GH_AW_SOFT_CAPS_INVALID'],
    [{...validBilling, ghAwCaps: {maxRunUnits: 1_000_000_001, maxDailyUnits: 1_000_000_001, dailyUnitsUsed: 0}}, 'GH_AW_SOFT_CAPS_INVALID'],
    [{...validBilling, ghAwCaps: {maxRunUnits: 100, maxDailyUnits: 0, dailyUnitsUsed: 0}}, 'GH_AW_SOFT_CAPS_INVALID'],
    [{...validBilling, ghAwCaps: {maxRunUnits: 100, maxDailyUnits: 1_000_000_001, dailyUnitsUsed: 0}}, 'GH_AW_SOFT_CAPS_INVALID'],
    [{...validBilling, ghAwCaps: {maxRunUnits: 200, maxDailyUnits: 100, dailyUnitsUsed: 0}}, 'GH_AW_SOFT_CAPS_INVALID'],
    [{...validBilling, ghAwCaps: {maxRunUnits: 100, maxDailyUnits: 200, dailyUnitsUsed: -1}}, 'GH_AW_SOFT_CAPS_INVALID'],
    [{...validBilling, ghAwCaps: {maxRunUnits: 20, maxDailyUnits: 200, dailyUnitsUsed: 0}}, 'GH_AW_MAX_RUN_UNITS_EXCEEDED']
  ]) {
    const res = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
      primaryProvider: makeProvider({billingEntitlement: billingPatch})
    }));
    assert.equal(res.admitted, false);
    assert.equal(res.decisionCode, expectedCode);
  }

  // Peer leases: commitment deduction, pre-deducted accounting flags, conflicts, expired CAS fencing, and protected paths
  const activePeer = {
    leaseId: 'peer-active-1',
    issue: 101,
    pr: 301,
    lane: 'lane-peer-a',
    ownedPaths: ['tools/engineering-coordinator/planner.mjs'],
    leaseGeneration: 1,
    expiresAtMs: NOW_MS + 60_000,
    reservedUnits: 50,
    reservedRequests: 2
  };
  assert.equal(CONTROLLER_PROTECTED_CONTROL_PLANE_PATHS.includes(SELF_EVALUATOR_PATH), true);
  const expiredPeerSameIssue1 = {
    leaseId: 'peer-expired-7-g1',
    issue: 7,
    pr: null,
    lane: 'worker-ladder-handoff',
    ownedPaths: ['src/feature/worker-task.mjs'],
    leaseGeneration: 1,
    expiresAtMs: NOW_MS
  };
  const expiredPeerSameIssue0 = {
    ...expiredPeerSameIssue1,
    leaseId: 'peer-expired-7-older',
    leaseGeneration: 1
  };
  const withPeersOk = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    activePeerLeases: [activePeer, expiredPeerSameIssue1, expiredPeerSameIssue0],
    lease: makeLease({leaseGeneration: 2})
  }));
  assert.equal(withPeersOk.admitted, true);
  assert.equal(withPeersOk.ladderDecision.activePeerWorkers, 1);

  // Pre-deducted netOfReservationsVerified + dailyUsageIncludesReservations accepts peer without commitment fields
  const peerNoCommitments = {...activePeer};
  delete peerNoCommitments.reservedUnits;
  delete peerNoCommitments.reservedRequests;
  delete peerNoCommitments.pr;

  const missingUnitCommitRes = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    activePeerLeases: [peerNoCommitments]
  }));
  assert.equal(missingUnitCommitRes.decisionCode, 'PEER_RESERVATION_COMMITMENTS_UNKNOWN');

  const netOnlyMissingDailyRes = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    primaryProvider: makeProvider({
      billingEntitlement: {
        ...validBilling,
        accounting: {...validAcct, netOfReservationsVerified: true}
      }
    }),
    activePeerLeases: [peerNoCommitments]
  }));
  assert.equal(netOnlyMissingDailyRes.decisionCode, 'PEER_RESERVATION_COMMITMENTS_UNKNOWN');

  // Target provider missing peer commitments during handoff stays paused cleanly
  const targetMissingPeerCommit = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    primaryProvider: makeProvider({
      billingEntitlement: {
        ...validBilling,
        accounting: {
          ...validAcct,
          netOfReservationsVerified: true,
          dailyUsageIncludesReservations: true,
          remainingIncludedUnits: 10
        }
      }
    }),
    activePeerLeases: [peerNoCommitments],
    lease: makeLease(),
    checkpoint: makeCheckpoint(),
    handoff: {
      mode: 'provider-handoff',
      attempt: 1,
      targetProvider: makeProvider()
    }
  }));
  assert.equal(targetMissingPeerCommit.decisionCode, 'PEER_RESERVATION_COMMITMENTS_UNKNOWN');
  assert.equal(targetMissingPeerCommit.preservedLease.status, 'checkpoint-paused');

  const bothPreDeductedOk = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    primaryProvider: makeProvider({
      billingEntitlement: {
        ...validBilling,
        accounting: {
          ...validAcct,
          netOfReservationsVerified: true,
          dailyUsageIncludesReservations: true
        }
      }
    }),
    activePeerLeases: [peerNoCommitments]
  }));
  assert.equal(bothPreDeductedOk.admitted, true);

  // Stale CAS generation <= expired peer generation rejected
  const staleLeaseGen = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    activePeerLeases: [{...expiredPeerSameIssue1, leaseGeneration: 3}],
    lease: makeLease({leaseGeneration: 3})
  }));
  assert.equal(staleLeaseGen.reason, 'STALE_CHECKPOINT');
  assert.equal(staleLeaseGen.decisionCode, 'STALE_FENCED_GENERATION');

  // Duplicate leaseId, issue, PR, lane, or overlapping path between lease and activePeerLeases
  const dupLeaseId = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    activePeerLeases: [activePeer],
    lease: makeLease({leaseId: activePeer.leaseId})
  }));
  assert.equal(dupLeaseId.decisionCode, 'DUPLICATE_LEASE_ID');

  for (const conflictPatch of [
    {issue: 101},
    {pr: 301},
    {lane: 'lane-peer-a'},
    {ownedPaths: ['tools/engineering-coordinator']}
  ]) {
    const res = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
      activePeerLeases: [activePeer],
      lease: makeLease(conflictPatch)
    }));
    assert.equal(res.reason, 'LANE_OR_PATH_RESERVED');
    assert.equal(res.decisionCode, 'LEASE_OWNERSHIP_CONFLICT');
  }

  // Peer-to-peer conflict
  for (const secondPeer of [
    {...activePeer, leaseId: 'peer-2', lane: 'lane-b', ownedPaths: ['docs/README.md']},
    {...activePeer, leaseId: 'peer-2', issue: 102, lane: 'lane-b', ownedPaths: ['docs/README.md']},
    {...activePeer, leaseId: 'peer-2', issue: 102, pr: 302, ownedPaths: ['docs/README.md']},
    {...activePeer, leaseId: 'peer-2', issue: 102, pr: 302, lane: 'lane-b', ownedPaths: ['tools/engineering-coordinator']}
  ]) {
    const res = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
      activePeerLeases: [activePeer, secondPeer]
    }));
    assert.equal(res.decisionCode, 'ACTIVE_PEER_LEASE_CONFLICT');
  }

  // Protected control-plane paths (including this evaluator itself) rejected on both peer leases and owned lease
  for (const forbiddenPath of [
    '.github',
    '.github/workflows',
    '.github/workflows/validate.yml',
    '.github/rulesets/main.json',
    'tools/engineering-factory/core.mjs',
    SELF_EVALUATOR_PATH,
    'tools/engineering-factory'
  ]) {
    assert.equal(
      evaluateWorkerLadderAndQuotaHandoff(makeFixture({
        lease: makeLease({ownedPaths: [forbiddenPath]})
      })).decisionCode,
      'PROTECTED_CONTROL_PLANE_PATH_FORBIDDEN'
    );
    assert.equal(
      evaluateWorkerLadderAndQuotaHandoff(makeFixture({
        activePeerLeases: [{...activePeer, ownedPaths: [forbiddenPath]}]
      })).decisionCode,
      'PROTECTED_CONTROL_PLANE_PATH_FORBIDDEN'
    );
  }

  // Invalid peer leases & invalid owned leases
  for (const badPeers of [
    'not-array',
    [null],
    [{...activePeer, leaseId: 'bad id!'}],
    [activePeer, {...activePeer, issue: 105, pr: 305, lane: 'other', ownedPaths: ['docs/A.md']}],
    [{...activePeer, issue: 0}],
    [{...activePeer, pr: 0}],
    [{...activePeer, lane: 'BAD LANE'}],
    [{...activePeer, ownedPaths: []}],
    [{...activePeer, ownedPaths: ['../escape']}],
    [{...activePeer, ownedPaths: ['a'.repeat(201)]}],
    [{...activePeer, ownedPaths: ['docs/A.md', 'docs/A.md']}],
    [{...activePeer, leaseGeneration: 0}],
    [{...activePeer, expiresAtMs: -1}],
    [{...activePeer, reservedUnits: -1}],
    [{...activePeer, reservedRequests: -1}]
  ]) {
    assert.equal(
      evaluateWorkerLadderAndQuotaHandoff(makeFixture({activePeerLeases: badPeers})).decisionCode,
      'PEER_LEASES_INVALID'
    );
  }

  for (const badLease of [
    null,
    {...makeLease(), leaseId: 'bad id!'},
    {...makeLease(), issue: 0},
    {...makeLease(), pr: 0},
    {...makeLease(), headSha: 'bad'},
    {...makeLease(), lane: 'BAD LANE'},
    {...makeLease(), ownedPaths: []},
    {...makeLease(), workerId: '!bad'},
    {...makeLease(), leaseGeneration: 0},
    {...makeLease(), leaseExpiresAtMs: 0},
    {...makeLease(), executionDeadlineMs: 0}
  ]) {
    assert.equal(
      evaluateWorkerLadderAndQuotaHandoff(makeFixture({lease: badLease})).decisionCode,
      'OWNED_LEASE_INVALID'
    );
  }

  for (const badLeaseTiming of [
    {...makeLease(), leaseExpiresAtMs: NOW_MS},
    {...makeLease(), executionDeadlineMs: NOW_MS},
    {...makeLease(), leaseExpiresAtMs: NOW_MS + MAX_LEASE_TTL_MS + 1},
    {...makeLease(), executionDeadlineMs: NOW_MS + MAX_LEASE_TTL_MS + 1}
  ]) {
    assert.equal(
      evaluateWorkerLadderAndQuotaHandoff(makeFixture({lease: badLeaseTiming})).decisionCode,
      'OWNED_LEASE_EXPIRED_OR_UNBOUNDED'
    );
  }
});

test('rejects active/revoked proxies, getters, non-enumerable properties, symbols, and custom prototypes with zero trap execution', () => {
  let trapCalls = 0;
  const poison = () => {
    trapCalls++;
    throw new Error('unexpected proxy trap or getter execution');
  };

  const revokedObj = Proxy.revocable(makeFixture(), {get: poison, getPrototypeOf: poison});
  revokedObj.revoke();
  const revokedArr = Proxy.revocable(['gpt-5.4'], {get: poison, getPrototypeOf: poison});
  revokedArr.revoke();

  const getterTop = makeFixture();
  Object.defineProperty(getterTop, 'stop', {enumerable: true, get: poison});

  const nonEnumTop = makeFixture();
  Object.defineProperty(nonEnumTop, 'stop', {enumerable: false, value: false});

  const symbolTop = {...makeFixture(), [Symbol('tag')]: 1};
  const oversizedTop = Object.fromEntries(Array.from({length: 65}, (_, i) => [`k${i}`, i]));

  for (const badTop of [
    null,
    undefined,
    [],
    'str',
    Object.create(makeFixture()),
    new Proxy(makeFixture(), {get: poison, getOwnPropertyDescriptor: poison, ownKeys: poison}),
    revokedObj.proxy,
    getterTop,
    nonEnumTop,
    symbolTop,
    oversizedTop,
    {...makeFixture(), stop: 'false'}
  ]) {
    const res = evaluateWorkerLadderAndQuotaHandoff(badTop);
    assert.equal(res.admitted, false);
    assert.equal(res.reason, 'EVIDENCE_UNKNOWN');
    assert.equal(res.decisionCode, 'CONTROLLER_INPUT_INVALID');
  }

  const sparseArr = new Array(2);
  sparseArr[0] = 'gpt-5.4';
  const nonEnumArr = ['gpt-5.4'];
  Object.defineProperty(nonEnumArr, 0, {enumerable: false, value: 'gpt-5.4'});
  const extraPropArr = ['gpt-5.4'];
  extraPropArr.extra = 'bad';

  for (const badArr of [
    null,
    revokedArr.proxy,
    new Proxy(['gpt-5.4'], {get: poison, ownKeys: poison}),
    Object.setPrototypeOf(['gpt-5.4'], Object.create(Array.prototype)),
    sparseArr,
    nonEnumArr,
    extraPropArr,
    Array.from({length: 65}, (_, i) => `m-${i}`)
  ]) {
    const res = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
      primaryProvider: makeProvider({
        model: {id: 'gpt-5.4', allowlist: badArr, verifiedAvailable: true}
      })
    }));
    assert.equal(res.admitted, false);
    assert.equal(res.decisionCode, 'MODEL_CAPABILITY_INVALID');
  }

  // Null, undefined, active proxy, revoked proxy, and length-getter inside ownedPaths never throw or invoke traps
  for (const badPathElem of [
    null,
    undefined,
    revokedObj.proxy,
    new Proxy({}, {get: poison}),
    {get length() { return poison(); }}
  ]) {
    const res = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
      lease: makeLease({ownedPaths: [badPathElem]})
    }));
    assert.equal(res.admitted, false);
    assert.equal(res.decisionCode, 'OWNED_LEASE_INVALID');
  }

  assert.equal(trapCalls, 0);
});

test('enforces active-peer rung bounds, overdrawn/under-reserved peer quotas, unicode-escaped secret blocking, and concurrency vs quota separation', () => {
  const lease = makeLease();
  const checkpoint = makeCheckpoint(lease);

  const makePeers = (count, reservedUnits = 50, reservedRequests = 2) =>
    Array.from({length: count}, (_, i) => ({
      leaseId: `peer-slot-${i}`,
      issue: 500 + i,
      lane: `lane-slot-${i}`,
      ownedPaths: [`src/mod-${i}.mjs`],
      leaseGeneration: 1,
      expiresAtMs: NOW_MS + 60_000,
      reservedUnits,
      reservedRequests
    }));

  // 1. Active peers exceeding currentRung fail closed even when hardCeiling is 12
  const exceedsCurrentRung = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    ladder: makeLadder({currentRung: 1, verifiedPriorRung: 0, requestedRung: 1, observedSimultaneousWorkers: 1}),
    activePeerLeases: makePeers(2)
  }));
  assert.equal(exceedsCurrentRung.admitted, false);
  assert.equal(exceedsCurrentRung.reason, 'BUDGET_OR_CONCURRENCY');
  assert.equal(exceedsCurrentRung.decisionCode, 'ACTIVE_PEERS_EXCEED_CURRENT_RUNG');
  assertCleanTelemetry(exceedsCurrentRung, 'blocked', 'QUOTA');

  // 2. Admitting/resuming/handing-off a lease when activePeerCount + 1 > requestedRung blocks with WORKER_RUNG_CONCURRENCY_FULL
  // (and does NOT enable provider-handoff when primary included quota is still abundant!)
  const steadyFull = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    ladder: makeLadder({currentRung: 1, verifiedPriorRung: 0, requestedRung: 1, observedSimultaneousWorkers: 1}),
    activePeerLeases: makePeers(1),
    lease
  }));
  assert.equal(steadyFull.admitted, false);
  assert.equal(steadyFull.reason, 'BUDGET_OR_CONCURRENCY');
  assert.equal(steadyFull.decisionCode, 'WORKER_RUNG_CONCURRENCY_FULL');
  assert.equal(steadyFull.actualMaxWorkers, 1);
  assert.equal(steadyFull.verifiedCapacityCeiling, 12);

  const resumeRungFull = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    ladder: makeLadder({currentRung: 1, verifiedPriorRung: 0, requestedRung: 1, observedSimultaneousWorkers: 1}),
    activePeerLeases: makePeers(1),
    lease,
    checkpoint
  }));
  assert.equal(resumeRungFull.admitted, false);
  assert.equal(resumeRungFull.decisionCode, 'WORKER_RUNG_CONCURRENCY_FULL');
  assert.equal(resumeRungFull.actualMaxWorkers, 1);
  assert.equal(resumeRungFull.verifiedCapacityCeiling, 12);

  // Concurrency saturation on primary (not quota exhaustion) blocks provider-handoff with PRIMARY_QUOTA_NOT_EXHAUSTED
  const concurrencyNotQuota = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    primaryProvider: makeProvider({verifiedProviderWorkerCeiling: 2}),
    ladder: makeLadder({currentRung: 2, verifiedPriorRung: 1, observedSimultaneousWorkers: 2}),
    activePeerLeases: makePeers(2),
    lease,
    checkpoint,
    handoff: {
      mode: 'provider-handoff',
      attempt: 1,
      targetProvider: makeProvider({
        providerFamily: 'openai-codex',
        verifiedProviderWorkerCeiling: 4,
        model: {id: 'gpt-5.4-codex', allowlist: ['gpt-5.4-codex'], verifiedAvailable: true},
        harness: {kind: 'openai-codex-action', verified: true, externalTracingDisabled: true}
      })
    }
  }));
  assert.equal(concurrencyNotQuota.admitted, false);
  assert.equal(concurrencyNotQuota.decisionCode, 'PRIMARY_QUOTA_NOT_EXHAUSTED');

  // Provider-handoff when primary IS quota-exhausted, but target rung is already full from activePeerLeases
  const handoffRungFull = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    primaryProvider: makeExhaustedPrimaryProvider(),
    ladder: makeLadder({currentRung: 2, verifiedPriorRung: 1, requestedRung: 1, observedSimultaneousWorkers: 2}),
    activePeerLeases: makePeers(1),
    lease,
    checkpoint,
    handoff: {
      mode: 'provider-handoff',
      attempt: 1,
      targetProvider: makeProvider({
        providerFamily: 'openai-codex',
        verifiedProviderWorkerCeiling: 4,
        model: {id: 'gpt-5.4-codex', allowlist: ['gpt-5.4-codex'], verifiedAvailable: true},
        harness: {kind: 'openai-codex-action', verified: true, externalTracingDisabled: true}
      })
    }
  }));
  assert.equal(handoffRungFull.admitted, false);
  assert.equal(handoffRungFull.decisionCode, 'WORKER_RUNG_CONCURRENCY_FULL');

  // 3. Under-reserved active peers and overdrawn gross/daily quotas fail closed without crediting unfunded peers
  for (const [acctPatch, peersPatch, expectedCode] of [
    [{}, makePeers(1, 49, 2), 'PEER_RESERVATION_COMMITMENTS_UNKNOWN'],
    [{}, makePeers(1, 50, 1), 'PEER_RESERVATION_COMMITMENTS_UNKNOWN'],
    [{netOfReservationsVerified: true}, makePeers(1, 10, 2), 'PEER_RESERVATION_COMMITMENTS_UNKNOWN'],
    [{remainingIncludedUnits: 50}, makePeers(2, 50, 2), 'INCLUDED_QUOTA_EXHAUSTED'],
    [{remainingIncludedRequests: 2}, makePeers(2, 50, 2), 'INCLUDED_QUOTA_EXHAUSTED']
  ]) {
    const baseP = makeProvider();
    const res = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
      primaryProvider: {
        ...baseP,
        billingEntitlement: {
          ...baseP.billingEntitlement,
          accounting: {...baseP.billingEntitlement.accounting, ...acctPatch}
        }
      },
      activePeerLeases: peersPatch
    }));
    assert.equal(res.admitted, false);
    assert.equal(res.decisionCode, expectedCode);
    assert.equal(res.actualMaxWorkers, 0);
  }

  const baseP = makeProvider();
  const dailyOverdrawnRes = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    primaryProvider: {
      ...baseP,
      billingEntitlement: {
        ...baseP.billingEntitlement,
        ghAwCaps: {maxRunUnits: 100, maxDailyUnits: 150, dailyUnitsUsed: 100}
      }
    },
    activePeerLeases: makePeers(2, 50, 2)
  }));
  assert.equal(dailyOverdrawnRes.admitted, false);
  assert.equal(dailyOverdrawnRes.decisionCode, 'INCLUDED_QUOTA_EXHAUSTED');
  assert.equal(dailyOverdrawnRes.actualMaxWorkers, 0);

  // 4. Unicode-escaped secrets (including overwritten duplicate keys), duplicate JSON keys, 1e400 Infinity, >64 array items, and full required scope bindings
  const baseStateJson = JSON.stringify(makeSerializedStateObject(lease)).slice(1, -1);
  const formattedCleanRaw = `{\r\n\t ${baseStateJson}, "emptyObj": {}, "emptyArr": [], "ok": false }`;
  const formattedOk = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    primaryProvider: makeExhaustedPrimaryProvider(),
    lease,
    checkpoint: {
      ...checkpoint,
      serializedState: formattedCleanRaw,
      sha256: computeCheckpointSha256(formattedCleanRaw)
    }
  }));
  assert.equal(formattedOk.decisionCode, 'QUOTA_EXHAUSTED_CHECKPOINT_PAUSED');

  const unicodePatPrefix = '\\u0067\\u0068\\u0070_canaryValue';
  const unicodeSkPrefix = '\\u0073\\u006b-\\u0061\\u006e\\u0074-canaryValue';
  for (const escapedSecretRaw of [
    `{${baseStateJson},"tok":"${unicodePatPrefix}"}`,
    `{${baseStateJson},"tok":"${unicodePatPrefix}","tok":"clean"}`,
    `{${baseStateJson},"arr":["${unicodeSkPrefix}"]}`,
    `{${baseStateJson},"${unicodePatPrefix}":1}`
  ]) {
    const res = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
      primaryProvider: makeExhaustedPrimaryProvider(),
      lease,
      checkpoint: {
        ...checkpoint,
        serializedState: escapedSecretRaw,
        sha256: computeCheckpointSha256(escapedSecretRaw)
      }
    }));
    assert.equal(res.reason, 'PROVIDER_FORBIDDEN');
    assert.equal(res.decisionCode, 'CHECKPOINT_SECRET_TOKEN_FORBIDDEN');
  }

  for (const invalidDecodedRaw of [
    `{"issue":999,${baseStateJson}}`,
    `{${baseStateJson},"inf":1e400}`,
    `{${baseStateJson},"inf":1e400,"inf":1}`,
    `{${baseStateJson},"arr":[1e400]}`,
    JSON.stringify(makeSerializedStateObject(lease, {bigArr: Array.from({length: 65}, (_, i) => i)}))
  ]) {
    const res = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
      primaryProvider: makeExhaustedPrimaryProvider(),
      lease,
      checkpoint: {
        ...checkpoint,
        serializedState: invalidDecodedRaw,
        sha256: computeCheckpointSha256(invalidDecodedRaw)
      }
    }));
    assert.equal(res.reason, 'STALE_CHECKPOINT');
    assert.equal(res.decisionCode, 'CHECKPOINT_SERIALIZED_JSON_INVALID');
  }

  for (const badBindingObj of [
    makeSerializedStateObject(lease, {repositoryId: 999}),
    makeSerializedStateObject(lease, {pr: 999}),
    makeSerializedStateObject(lease, {leaseGeneration: 1}),
    makeSerializedStateObject(lease, {ownedPaths: 'not-array'}),
    makeSerializedStateObject(lease, {ownedPaths: []}),
    makeSerializedStateObject(lease, {ownedPaths: [123]}),
    makeSerializedStateObject(lease, {
      ownedPaths: ['src/feature/worker-task.mjs', 'src/feature/worker-task.mjs']
    }),
    makeSerializedStateObject(lease, {ownedPaths: ['.github/workflows/validate.yml']})
  ]) {
    const raw = JSON.stringify(badBindingObj);
    const res = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
      primaryProvider: makeExhaustedPrimaryProvider(),
      lease,
      checkpoint: {...checkpoint, serializedState: raw, sha256: computeCheckpointSha256(raw)}
    }));
    assert.equal(res.reason, 'STALE_CHECKPOINT');
    assert.equal(res.decisionCode, 'CHECKPOINT_STATE_BINDING_MISMATCH');
  }

  // 5. externalTracingDisabled: false on github-copilot rejected; under-reserved peers rejected even with netOfReservationsVerified: true; down-scaling from 12 emits WORKER_LADDER_RUNG_VERIFIED
  const copilotTracingEnabled = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    primaryProvider: makeProvider({
      harness: {kind: 'copilot-cloud-agent', verified: true, externalTracingDisabled: false}
    })
  }));
  assert.equal(copilotTracingEnabled.reason, 'PROVIDER_FORBIDDEN');
  assert.equal(copilotTracingEnabled.decisionCode, 'EXTERNAL_TRACING_FORBIDDEN');

  const preDeductedUnderReserved = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    primaryProvider: {
      ...baseP,
      billingEntitlement: {
        ...baseP.billingEntitlement,
        accounting: {
          ...baseP.billingEntitlement.accounting,
          netOfReservationsVerified: true,
          dailyUsageIncludesReservations: true
        }
      }
    },
    activePeerLeases: makePeers(1, 0, 0)
  }));
  assert.equal(preDeductedUnderReserved.reason, 'BUDGET_UNKNOWN');
  assert.equal(preDeductedUnderReserved.decisionCode, 'PEER_RESERVATION_COMMITMENTS_UNKNOWN');

  const downscaleFrom12 = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    primaryProvider: makeProvider({verifiedProviderWorkerCeiling: 4}),
    ladder: makeLadder({
      currentRung: 12,
      verifiedPriorRung: 10,
      requestedRung: 4,
      observedSimultaneousWorkers: 4
    })
  }));
  assert.equal(downscaleFrom12.admitted, true);
  assert.equal(downscaleFrom12.decisionCode, 'WORKER_LADDER_RUNG_VERIFIED');
  assert.equal(downscaleFrom12.actualMaxWorkers, 4);
  assert.equal(downscaleFrom12.shortfallFrom12, 8);
  assert.equal(downscaleFrom12.goalMet, false);

  // 6. Case-insensitive Bearer scheme blocking (raw and unicode-escaped)
  for (const mixedBearer of [
    'BEARER syntheticHeaderValue',
    'bEaReR syntheticHeaderValue',
    '\\u0062\\u0045\\u0061\\u0052\\u0065\\u0052 syntheticHeaderValue'
  ]) {
    const raw = `{${baseStateJson},"hdr":"${mixedBearer}"}`;
    const res = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
      primaryProvider: makeExhaustedPrimaryProvider(),
      lease,
      checkpoint: {...checkpoint, serializedState: raw, sha256: computeCheckpointSha256(raw)}
    }));
    assert.equal(res.reason, 'PROVIDER_FORBIDDEN');
    assert.equal(res.decisionCode, 'CHECKPOINT_SECRET_TOKEN_FORBIDDEN');
  }

  // 7. Provider/entitlement-scoped peer commitment deduction: 60-unit Copilot peer does NOT exhaust 51-unit Codex handoff target,
  // while still enforcing repository-wide concurrency and ownership!
  const copilot60Peer = {
    leaseId: 'peer-copilot-60',
    providerFamily: 'github-copilot',
    entitlementId: 'copilot-org',
    issue: 601,
    lane: 'lane-copilot-60',
    ownedPaths: ['src/other-task.mjs'],
    leaseGeneration: 1,
    expiresAtMs: NOW_MS + 60_000,
    reservedUnits: 60,
    reservedRequests: 2
  };
  const codex51Target = makeProvider({
    providerFamily: 'openai-codex',
    entitlementId: 'codex-included',
    verifiedProviderWorkerCeiling: 4,
    model: {id: 'gpt-5.4-codex', allowlist: ['gpt-5.4-codex'], verifiedAvailable: true},
    harness: {kind: 'openai-codex-action', verified: true, externalTracingDisabled: true},
    billingEntitlement: {
      ...baseP.billingEntitlement,
      accounting: {
        ...baseP.billingEntitlement.accounting,
        remainingIncludedUnits: 51,
        unitsPerWorkerRun: 1,
        remainingIncludedRequests: 10,
        requestsPerWorkerRun: 1
      }
    }
  });
  const crossProviderHandoff = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    primaryProvider: {...makeExhaustedPrimaryProvider(), entitlementId: 'copilot-org'},
    ladder: makeLadder({currentRung: 2, verifiedPriorRung: 1, requestedRung: 2, observedSimultaneousWorkers: 2}),
    activePeerLeases: [
      copilot60Peer,
      {
        leaseId: 'peer-codex-other-entitlement',
        providerFamily: 'openai-codex',
        issue: 602,
        lane: 'lane-codex-default',
        ownedPaths: ['src/third-task.mjs'],
        leaseGeneration: 1,
        expiresAtMs: NOW_MS + 60_000,
        reservedUnits: 50,
        reservedRequests: 2
      }
    ],
    lease,
    checkpoint,
    handoff: {mode: 'provider-handoff', attempt: 1, targetProvider: codex51Target}
  }));
  // With 2 active peers across the repo and requestedRung: 2, repo concurrency blocks adding a 3rd simultaneous worker
  assert.equal(crossProviderHandoff.decisionCode, 'WORKER_RUNG_CONCURRENCY_FULL');

  const crossProviderHandoffOk = evaluateWorkerLadderAndQuotaHandoff(makeFixture({
    primaryProvider: {...makeExhaustedPrimaryProvider(), entitlementId: 'copilot-org'},
    ladder: makeLadder({currentRung: 2, verifiedPriorRung: 1, requestedRung: 2, observedSimultaneousWorkers: 2}),
    activePeerLeases: [copilot60Peer],
    lease,
    checkpoint,
    handoff: {mode: 'provider-handoff', attempt: 1, targetProvider: codex51Target}
  }));
  assert.equal(crossProviderHandoffOk.admitted, true);
  assert.equal(crossProviderHandoffOk.decisionCode, 'CHECKPOINT_HANDOFF_TO_INCLUDED_PROVIDER');
  assert.equal(crossProviderHandoffOk.selectedProvider.entitlementId, 'codex-included');
  assert.equal(crossProviderHandoffOk.ladderDecision.activePeerWorkers, 1);

  // Invalid entitlementId / providerFamily on provider or peer lease fails closed
  assert.equal(
    evaluateWorkerLadderAndQuotaHandoff(makeFixture({
      primaryProvider: makeProvider({entitlementId: 'bad id!'})
    })).decisionCode,
    'PRIMARY_PROVIDER_CAPABILITY_INVALID'
  );
  for (const badPeerPatch of [{providerFamily: 'unknown'}, {entitlementId: 'bad id!'}]) {
    assert.equal(
      evaluateWorkerLadderAndQuotaHandoff(makeFixture({
        activePeerLeases: [{...copilot60Peer, ...badPeerPatch}]
      })).decisionCode,
      'PEER_LEASES_INVALID'
    );
  }
});
