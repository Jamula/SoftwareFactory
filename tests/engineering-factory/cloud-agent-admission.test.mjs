import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_CREDIT_USD_CENTS,
  AUTOMATION_ALLOWED_VISIBILITIES,
  BILLING_METERS,
  DEFAULT_MAX_QUOTA_AGE_MS,
  MAX_ALLOWED_QUOTA_AGE_MS,
  MAX_LEASE_TTL_MS,
  PINNED_COPILOT_SDK_VERSION,
  REPOSITORY_VISIBILITIES,
  SUPPORTED_HARNESSES,
  SUPPORTED_RUNNERS,
  WORKER_GOAL_MAX,
  WORKER_LADDER,
  aiCreditsToUsdCents,
  evaluateCloudAgentAdmission
} from '../../tools/engineering-factory/cloud-agent-admission.mjs';
import {createExecutionReceipt, telemetrySummary} from '../../tools/engineering-factory/telemetry.mjs';

function makeMeters(overrides = {}) {
  const baseMeter = {verified: true, paidOverageEnabled: false, overageHardStopUsdCents: 0};
  return {
    aiCredits: {...baseMeter, ...(overrides.aiCredits ?? {})},
    copilotPremiumRequests: {...baseMeter, ...(overrides.copilotPremiumRequests ?? {})},
    cloudSandboxesAndActions: {...baseMeter, ...(overrides.cloudSandboxesAndActions ?? {})}
  };
}

function makeFixture(overrides = {}) {
  const nowMs = 1_764_200_000_000;
  return {
    stop: false,
    repositoryId: 1471342715,
    approvedRepositoryId: 1471342715,
    repositoryVisibility: 'public',
    personalPatInActionsSecrets: false,
    nowMs,
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
    billingEntitlement: {
      entitlementVerified: true,
      includedOnly: true,
      incrementalBilledUsdCents: 0,
      hardStopObservedAtMs: nowMs - 5_000,
      meters: makeMeters(),
      accounting: {
        accountingSource: 'verified',
        isEstimated: false,
        observedAtMs: nowMs - 5_000,
        remainingIncludedAiCredits: 2_000,
        remainingIncludedPremiumRequests: 50,
        dailyAiCreditsUsed: 100,
        runAiCreditsRequired: 25,
        premiumRequestsRequired: 2
      },
      ghAwCaps: {
        maxAiCredits: 100,
        maxDailyAiCredits: 500
      }
    },
    runner: {
      kind: 'github-hosted',
      verified: true,
      ephemeral: true,
      isolated: true
    },
    workerPool: {
      requestedWorkers: 4,
      verifiedPriorWorkerTier: 2,
      repoConcurrencyCap: 8,
      verifiedWorkerCeiling: 6,
      remainingIncludedSlots: 10,
      reservations: [
        {
          reservationId: 'res-active-1',
          issue: 101,
          pr: 201,
          lane: 'lane-a',
          paths: ['tools/engineering-coordinator'],
          leaseGeneration: 1,
          expiresAtMs: nowMs + 60_000,
          reservedAiCredits: 25,
          reservedPremiumRequests: 2
        },
        {
          reservationId: 'res-expired-7',
          issue: 7,
          pr: null,
          lane: 'admission',
          paths: ['tools/engineering-factory/cloud-agent-admission.mjs'],
          leaseGeneration: 2,
          expiresAtMs: nowMs
        }
      ]
    },
    candidate: {
      issue: 7,
      pr: 205,
      lane: 'admission',
      paths: ['tools/engineering-factory/cloud-agent-admission.mjs'],
      leaseGeneration: 3,
      leaseExpiresAtMs: nowMs + 300_000
    },
    ...overrides
  };
}

function assertCleanTelemetry(result, expectedOutcome, expectedReason) {
  const summary = telemetrySummary(result);
  assert.notEqual(summary.reason, 'OTHER');
  assert.deepEqual(summary, {outcome: expectedOutcome, reason: expectedReason});
  const receipt = createExecutionReceipt({
    source: 'github-hosted',
    repositoryId: 1471342715,
    receiptId: 'gh-1001-1-dispatch',
    observedMs: 1_764_200_000_000,
    stage: 'dispatch',
    durationMs: 12,
    result
  });
  assert.equal(receipt.valid, true);
  assert.equal(receipt.outcome, expectedOutcome);
  assert.equal(receipt.reason, expectedReason);
}

test('constants and exact integer AI-credit to USD-cent conversion stay frozen and fail-closed', () => {
  assert.equal(AI_CREDIT_USD_CENTS, 1);
  assert.equal(PINNED_COPILOT_SDK_VERSION, '2.0.3');
  assert.equal(DEFAULT_MAX_QUOTA_AGE_MS, 60_000);
  assert.equal(MAX_ALLOWED_QUOTA_AGE_MS, 300_000);
  assert.equal(MAX_LEASE_TTL_MS, 3_600_000);
  assert.equal(WORKER_GOAL_MAX, 12);
  assert.deepEqual(WORKER_LADDER, [1, 2, 4, 8, 10, 12]);
  assert.deepEqual(SUPPORTED_HARNESSES, ['copilot-cloud-agent', 'copilot-cloud-automation', 'copilot-sdk']);
  assert.deepEqual(SUPPORTED_RUNNERS, ['github-hosted', 'cloud-sandbox']);
  assert.deepEqual(REPOSITORY_VISIBILITIES, ['public', 'private', 'internal']);
  assert.deepEqual(AUTOMATION_ALLOWED_VISIBILITIES, ['private', 'internal']);
  assert.deepEqual(BILLING_METERS, ['aiCredits', 'copilotPremiumRequests', 'cloudSandboxesAndActions']);

  assert.equal(aiCreditsToUsdCents(0), 0);
  assert.equal(aiCreditsToUsdCents(1), 1);
  assert.equal(aiCreditsToUsdCents(250), 250);
  for (const bad of [-1, 1.5, NaN, Infinity, null, undefined, '10', 1_000_000_001]) {
    assert.equal(aiCreditsToUsdCents(bad), null);
  }
});

test('admits valid Cloud Agent, Cloud Automation (private/internal), and pinned Copilot SDK v2.0.3 in shadow mode', () => {
  const agentRes = evaluateCloudAgentAdmission(makeFixture());
  assert.deepEqual(agentRes, {
    shadow: true,
    liveDispatch: false,
    admitted: true,
    reason: 'SHADOW_ALLOCATION',
    admissionCode: 'CLOUD_AGENT_SHADOW_ADMITTED',
    repositoryId: 1471342715,
    repositoryVisibility: 'public',
    capabilities: {
      model: 'gpt-5.4',
      harness: 'copilot-cloud-agent',
      sdkVersion: null,
      billingEntitlement: 'verified-included-hard-stop',
      runner: 'github-hosted'
    },
    accounting: {
      aiCreditUsdCents: 1,
      runAiCredits: 25,
      runBudgetUsdCents: 25,
      totalBatchAiCredits: 100,
      totalBatchUsdCents: 100,
      reservedAiCredits: 25,
      reservedPremiumRequests: 2,
      remainingIncludedAiCredits: 2_000,
      remainingIncludedUsdCents: 2_000,
      netRemainingIncludedAiCredits: 1_975,
      netRemainingIncludedUsdCents: 1_975,
      remainingIncludedPremiumRequests: 50,
      netRemainingIncludedPremiumRequests: 48,
      incrementalBilledUsdCents: 0
    },
    workers: {
      requestedWorkers: 4,
      grossWorkerCeiling: 6,
      activeReservations: 1,
      netAvailableWorkers: 5,
      actualWorkerMax: 4,
      workerShortfallFrom12: 8
    },
    actualWorkerMax: 4,
    workerShortfallFrom12: 8
  });
  assert.equal(Object.isFrozen(agentRes), true);
  assert.equal(Object.isFrozen(agentRes.capabilities), true);
  assert.equal(Object.isFrozen(agentRes.accounting), true);
  assert.equal(Object.isFrozen(agentRes.workers), true);
  assertCleanTelemetry(agentRes, 'eligible', 'NONE');

  for (const visibility of ['private', 'internal']) {
    const base = makeFixture({
      repositoryVisibility: visibility,
      harness: {kind: 'copilot-cloud-automation', verified: true},
      runner: {kind: 'cloud-sandbox', verified: true, ephemeral: true, isolated: true},
      workerPool: {
        requestedWorkers: 12,
        verifiedPriorWorkerTier: 10,
        repoConcurrencyCap: 12,
        verifiedWorkerCeiling: 12,
        remainingIncludedSlots: 12,
        reservations: []
      }
    });
    delete base.model.provider;
    delete base.billingEntitlement.hardStopObservedAtMs;
    delete base.candidate.pr;
    const autoRes = evaluateCloudAgentAdmission(base);
    assert.equal(autoRes.admitted, true);
    assert.equal(autoRes.capabilities.harness, 'copilot-cloud-automation');
    assert.equal(autoRes.capabilities.runner, 'cloud-sandbox');
    assert.equal(autoRes.actualWorkerMax, 12);
    assert.equal(autoRes.workerShortfallFrom12, 0);
    assertCleanTelemetry(autoRes, 'eligible', 'NONE');
  }

  for (const sdkVariant of [
    makeFixture({harness: {kind: 'copilot-sdk', verified: true, sdkVersion: '2.0.3'}}),
    makeFixture({sdkVersion: 'v2.0.3', harness: {kind: 'copilot-sdk', verified: true}}),
    makeFixture({sdkVersion: '2.0.3', harness: {kind: 'copilot-sdk', verified: true, sdkVersion: '2.0.3'}})
  ]) {
    const sdkRes = evaluateCloudAgentAdmission(sdkVariant);
    assert.equal(sdkRes.admitted, true);
    assert.equal(sdkRes.capabilities.harness, 'copilot-sdk');
    assert.equal(sdkRes.capabilities.sdkVersion, '2.0.3');
    assertCleanTelemetry(sdkRes, 'eligible', 'NONE');
  }
});

test('enforces visibility, SDK version pinning, personal PAT prohibition, runner, model, and identity gates', () => {
  const stopped = evaluateCloudAgentAdmission(makeFixture({stop: true}));
  assert.equal(stopped.reason, 'STOPPED');
  assert.equal(stopped.admissionCode, 'STOP_SWITCH_ACTIVE');
  assertCleanTelemetry(stopped, 'blocked', 'POLICY');

  for (const pat of [true, null, 'false', 1]) {
    const patDenied = evaluateCloudAgentAdmission(makeFixture({personalPatInActionsSecrets: pat}));
    assert.equal(patDenied.reason, 'PROVIDER_FORBIDDEN');
    assert.equal(patDenied.admissionCode, 'PERSONAL_PAT_FORBIDDEN');
    assertCleanTelemetry(patDenied, 'blocked', 'SECURITY');
  }

  for (const badId of [
    {repositoryId: 0},
    {approvedRepositoryId: -1},
    {repositoryId: '1471342715'}
  ]) {
    const idDenied = evaluateCloudAgentAdmission(makeFixture(badId));
    assert.equal(idDenied.reason, 'INVALID_IDENTITY');
    assert.equal(idDenied.admissionCode, 'REPOSITORY_IDENTITY_INVALID');
    assertCleanTelemetry(idDenied, 'blocked', 'INVALID_EVIDENCE');
  }

  const scopeMismatch = evaluateCloudAgentAdmission(makeFixture({approvedRepositoryId: 999}));
  assert.equal(scopeMismatch.reason, 'PROVENANCE_MISMATCH');
  assert.equal(scopeMismatch.admissionCode, 'REPOSITORY_SCOPE_MISMATCH');
  assertCleanTelemetry(scopeMismatch, 'blocked', 'SECURITY');

  for (const badEnv of [{repositoryVisibility: 'enterprise'}, {nowMs: -1}, {nowMs: 1.5}]) {
    const res = evaluateCloudAgentAdmission(makeFixture(badEnv));
    assert.equal(res.reason, 'EVIDENCE_UNKNOWN');
    assert.equal(res.admissionCode, 'REPOSITORY_OR_CLOCK_INVALID');
    assertCleanTelemetry(res, 'blocked', 'INVALID_EVIDENCE');
  }

  // Cloud Automations require private or internal repositories
  const publicAuto = evaluateCloudAgentAdmission(makeFixture({
    repositoryVisibility: 'public',
    harness: {kind: 'copilot-cloud-automation', verified: true}
  }));
  assert.equal(publicAuto.admitted, false);
  assert.equal(publicAuto.reason, 'CAPACITY_UNVERIFIED');
  assert.equal(publicAuto.admissionCode, 'AUTOMATIONS_REQUIRE_PRIVATE_REPO');
  assert.equal(publicAuto.detail, 'AUTOMATIONS_REQUIRE_PRIVATE_REPO');
  assertCleanTelemetry(publicAuto, 'blocked', 'QUOTA');

  // Copilot SDK requires exact pinned 2.0.3
  for (const badSdk of [
    makeFixture({harness: {kind: 'copilot-sdk', verified: true}}),
    makeFixture({harness: {kind: 'copilot-sdk', verified: true, sdkVersion: '2.0.2'}}),
    makeFixture({harness: {kind: 'copilot-sdk', verified: true, sdkVersion: '2.0.4'}}),
    makeFixture({harness: {kind: 'copilot-sdk', verified: true, sdkVersion: '^2.0.3'}}),
    makeFixture({harness: {kind: 'copilot-sdk', verified: true, sdkVersion: '2.0.3-beta.1'}}),
    makeFixture({harness: {kind: 'copilot-sdk', verified: true, sdkVersion: 203}}),
    makeFixture({sdkVersion: '2.0.2', harness: {kind: 'copilot-sdk', verified: true, sdkVersion: '2.0.3'}})
  ]) {
    const sdkDenied = evaluateCloudAgentAdmission(badSdk);
    assert.equal(sdkDenied.reason, 'CAPACITY_UNVERIFIED');
    assert.equal(sdkDenied.admissionCode, 'SDK_VERSION_MISMATCH');
    assertCleanTelemetry(sdkDenied, 'blocked', 'QUOTA');
  }

  for (const unexpectedSdk of [
    makeFixture({sdkVersion: '2.0.3'}),
    makeFixture({harness: {kind: 'copilot-cloud-agent', verified: true, sdkVersion: '2.0.3'}})
  ]) {
    const res = evaluateCloudAgentAdmission(unexpectedSdk);
    assert.equal(res.reason, 'EVIDENCE_UNKNOWN');
    assert.equal(res.admissionCode, 'UNEXPECTED_SDK_VERSION');
    assertCleanTelemetry(res, 'blocked', 'INVALID_EVIDENCE');
  }

  for (const badHarness of [
    {harness: null},
    {harness: {kind: 123, verified: true}},
    {harness: {kind: 'copilot-cloud-agent', verified: 'yes'}}
  ]) {
    const res = evaluateCloudAgentAdmission(makeFixture(badHarness));
    assert.equal(res.reason, 'EVIDENCE_UNKNOWN');
    assert.equal(res.admissionCode, 'HARNESS_CAPABILITY_INVALID');
  }
  const unsupportedHarness = evaluateCloudAgentAdmission(makeFixture({harness: {kind: 'diy-cli-tarball', verified: true}}));
  assert.equal(unsupportedHarness.reason, 'PROVIDER_FORBIDDEN');
  assert.equal(unsupportedHarness.admissionCode, 'UNSUPPORTED_HARNESS');
  assertCleanTelemetry(unsupportedHarness, 'blocked', 'SECURITY');

  const unverifiedHarness = evaluateCloudAgentAdmission(makeFixture({harness: {kind: 'copilot-cloud-agent', verified: false}}));
  assert.equal(unverifiedHarness.reason, 'CAPACITY_UNVERIFIED');
  assert.equal(unverifiedHarness.admissionCode, 'HARNESS_UNVERIFIED');

  for (const badLogin of [
    {kind: 'copilot-cloud-agent', verified: true, agentLogin: 'personal-user'},
    {kind: 'copilot-cloud-automation', verified: true, agentLogin: 'copilot-swe-agent[bot]'}
  ]) {
    const res = evaluateCloudAgentAdmission(makeFixture({repositoryVisibility: 'private', harness: badLogin}));
    assert.equal(res.reason, 'PROVENANCE_MISMATCH');
    assert.equal(res.admissionCode, 'AGENT_IDENTITY_MISMATCH');
  }

  // Runner gates: reject laptop/self-hosted/open-chat operational runners
  for (const badRunnerKind of ['laptop', 'self-hosted', 'open-chat', 'workstation']) {
    const res = evaluateCloudAgentAdmission(makeFixture({
      runner: {kind: badRunnerKind, verified: true, ephemeral: true, isolated: true}
    }));
    assert.equal(res.reason, 'PROVIDER_FORBIDDEN');
    assert.equal(res.admissionCode, 'UNSUPPORTED_OPERATIONAL_RUNNER');
    assertCleanTelemetry(res, 'blocked', 'SECURITY');
  }
  for (const flag of ['verified', 'ephemeral', 'isolated']) {
    const res = evaluateCloudAgentAdmission(makeFixture({
      runner: {kind: 'github-hosted', verified: true, ephemeral: true, isolated: true, [flag]: false}
    }));
    assert.equal(res.reason, 'CAPACITY_UNVERIFIED');
    assert.equal(res.admissionCode, 'RUNNER_ISOLATION_UNVERIFIED');
  }
  for (const badRunner of [
    null,
    {kind: 'github-hosted'},
    {kind: 123, verified: true, ephemeral: true, isolated: true},
    {kind: 'github-hosted', verified: 'yes', ephemeral: true, isolated: true},
    {kind: 'github-hosted', verified: true, ephemeral: 'yes', isolated: true},
    {kind: 'github-hosted', verified: true, ephemeral: true, isolated: 'yes'}
  ]) {
    const res = evaluateCloudAgentAdmission(makeFixture({runner: badRunner}));
    assert.equal(res.reason, 'EVIDENCE_UNKNOWN');
    assert.equal(res.admissionCode, 'RUNNER_CAPABILITY_INVALID');
  }

  // Model gates: allowlist, verifiedAvailable, retired github-models provider
  const retiredModel = evaluateCloudAgentAdmission(makeFixture({
    model: {id: 'gpt-5.4', allowlist: ['gpt-5.4'], verifiedAvailable: true, provider: 'GitHub-Models'}
  }));
  assert.equal(retiredModel.reason, 'PROVIDER_FORBIDDEN');
  assert.equal(retiredModel.admissionCode, 'RETIRED_PROVIDER_FORBIDDEN');
  assertCleanTelemetry(retiredModel, 'blocked', 'SECURITY');

  const unallowlistedModel = evaluateCloudAgentAdmission(makeFixture({
    model: {id: 'unapproved-model', allowlist: ['gpt-5.4'], verifiedAvailable: true}
  }));
  assert.equal(unallowlistedModel.reason, 'POLICY_UNKNOWN');
  assert.equal(unallowlistedModel.admissionCode, 'MODEL_NOT_ALLOWLISTED');
  assertCleanTelemetry(unallowlistedModel, 'blocked', 'POLICY');

  const unavailableModel = evaluateCloudAgentAdmission(makeFixture({
    model: {id: 'gpt-5.4', allowlist: ['gpt-5.4'], verifiedAvailable: false}
  }));
  assert.equal(unavailableModel.reason, 'CAPACITY_UNVERIFIED');
  assert.equal(unavailableModel.admissionCode, 'MODEL_AVAILABILITY_UNVERIFIED');
  assertCleanTelemetry(unavailableModel, 'blocked', 'QUOTA');

  for (const badModel of [
    null,
    {id: '', allowlist: ['gpt-5.4'], verifiedAvailable: true},
    {id: 'gpt-5.4', allowlist: [], verifiedAvailable: true},
    {id: 'gpt-5.4', allowlist: ['gpt-5.4', 'gpt-5.4'], verifiedAvailable: true},
    {id: 'gpt-5.4', allowlist: ['bad model!'], verifiedAvailable: true},
    {id: 'gpt-5.4', allowlist: ['gpt-5.4'], verifiedAvailable: 'true'},
    {id: 'gpt-5.4', allowlist: ['gpt-5.4'], verifiedAvailable: true, provider: 'bad provider!'}
  ]) {
    const res = evaluateCloudAgentAdmission(makeFixture({model: badModel}));
    assert.equal(res.reason, 'EVIDENCE_UNKNOWN');
    assert.equal(res.admissionCode, 'MODEL_CAPABILITY_INVALID');
  }
});

test('enforces non-estimated AI-credit accounting, $0 hard-stop meters across all 3 meters, and gh-aw caps', () => {
  const base = makeFixture();
  const validBilling = base.billingEntitlement;
  const validAccounting = validBilling.accounting;

  // Missing, stale, negative, non-integer, or estimated accounting -> BUDGET_UNKNOWN / ACCOUNTING_ESTIMATED_OR_MISSING
  for (const badBilling of [
    null,
    undefined,
    {...validBilling, maxQuotaAgeMs: 0},
    {...validBilling, maxQuotaAgeMs: MAX_ALLOWED_QUOTA_AGE_MS + 1},
    {...validBilling, accounting: null},
    {...validBilling, accounting: {...validAccounting, accountingSource: 'gh-aw-fallback'}},
    {...validBilling, accounting: {...validAccounting, isEstimated: true}},
    {...validBilling, accounting: {...validAccounting, observedAtMs: base.nowMs + 1}},
    {...validBilling, accounting: {...validAccounting, observedAtMs: base.nowMs - DEFAULT_MAX_QUOTA_AGE_MS - 1}},
    {...validBilling, maxQuotaAgeMs: 10_000, accounting: {...validAccounting, observedAtMs: base.nowMs - 10_001}},
    {...validBilling, accounting: {...validAccounting, remainingIncludedAiCredits: -1}},
    {...validBilling, accounting: {...validAccounting, remainingIncludedAiCredits: 12.5}},
    {...validBilling, accounting: {...validAccounting, remainingIncludedPremiumRequests: -1}},
    {...validBilling, accounting: {...validAccounting, dailyAiCreditsUsed: -1}},
    {...validBilling, accounting: {...validAccounting, runAiCreditsRequired: 0}},
    {...validBilling, accounting: {...validAccounting, runAiCreditsRequired: 1_000_000_001}},
    {...validBilling, accounting: {...validAccounting, premiumRequestsRequired: -1}},
    {...validBilling, accounting: {...validAccounting, netOfReservationsVerified: 'true'}}
  ]) {
    const res = evaluateCloudAgentAdmission(makeFixture({billingEntitlement: badBilling}));
    assert.equal(res.reason, 'BUDGET_UNKNOWN');
    assert.equal(res.admissionCode, 'ACCOUNTING_ESTIMATED_OR_MISSING');
    assertCleanTelemetry(res, 'blocked', 'QUOTA');
  }

  // Custom valid maxQuotaAgeMs admits fresh accounting within window
  const customAgeOk = evaluateCloudAgentAdmission(makeFixture({
    billingEntitlement: {
      ...validBilling,
      maxQuotaAgeMs: 120_000,
      hardStopObservedAtMs: base.nowMs - 90_000,
      accounting: {...validAccounting, observedAtMs: base.nowMs - 90_000}
    }
  }));
  assert.equal(customAgeOk.admitted, true);

  const malformedBilling = evaluateCloudAgentAdmission(makeFixture({
    billingEntitlement: {...validBilling, unknownField: 1}
  }));
  assert.equal(malformedBilling.reason, 'EVIDENCE_UNKNOWN');
  assert.equal(malformedBilling.admissionCode, 'BILLING_CAPABILITY_INVALID');

  for (const flag of ['entitlementVerified', 'includedOnly']) {
    const res = evaluateCloudAgentAdmission(makeFixture({
      billingEntitlement: {...validBilling, [flag]: false}
    }));
    assert.equal(res.reason, 'BUDGET_UNKNOWN');
    assert.equal(res.admissionCode, 'BILLING_ENTITLEMENT_UNVERIFIED');
  }

  for (const badHardStopTs of [-1, base.nowMs + 1, base.nowMs - DEFAULT_MAX_QUOTA_AGE_MS - 1]) {
    const res = evaluateCloudAgentAdmission(makeFixture({
      billingEntitlement: {...validBilling, hardStopObservedAtMs: badHardStopTs}
    }));
    assert.equal(res.reason, 'STALE_QUOTA');
    assert.equal(res.admissionCode, 'STALE_HARD_STOP_RECEIPT');
    assertCleanTelemetry(res, 'blocked', 'STALE');
  }

  for (const spend of [1, -1, null, 0.5]) {
    const res = evaluateCloudAgentAdmission(makeFixture({
      billingEntitlement: {...validBilling, incrementalBilledUsdCents: spend}
    }));
    assert.equal(res.reason, 'BUDGET_UNKNOWN');
    assert.equal(res.admissionCode, 'INCREMENTAL_SPEND_NONZERO');
  }

  // Every one of the 3 meters must be verified, paidOverageEnabled === false, and overageHardStopUsdCents === 0
  for (const meterName of BILLING_METERS) {
    const overageEnabled = evaluateCloudAgentAdmission(makeFixture({
      billingEntitlement: {...validBilling, meters: makeMeters({[meterName]: {paidOverageEnabled: true}})}
    }));
    assert.equal(overageEnabled.reason, 'BUDGET_UNKNOWN');
    assert.equal(overageEnabled.admissionCode, 'PAID_OVERAGE_NOT_HARD_STOPPED');

    const nonZeroHardStop = evaluateCloudAgentAdmission(makeFixture({
      billingEntitlement: {...validBilling, meters: makeMeters({[meterName]: {overageHardStopUsdCents: 100}})}
    }));
    assert.equal(nonZeroHardStop.reason, 'BUDGET_UNKNOWN');
    assert.equal(nonZeroHardStop.admissionCode, 'PAID_OVERAGE_NOT_HARD_STOPPED');

    for (const unverifiedPatch of [
      {verified: false},
      {paidOverageEnabled: 'false'},
      {overageHardStopUsdCents: '0'}
    ]) {
      const unverified = evaluateCloudAgentAdmission(makeFixture({
        billingEntitlement: {...validBilling, meters: makeMeters({[meterName]: unverifiedPatch})}
      }));
      assert.equal(unverified.reason, 'BUDGET_UNKNOWN');
      assert.equal(unverified.admissionCode, 'HARD_STOP_UNVERIFIED');
    }
  }
  const missingMeter = {...makeMeters()};
  delete missingMeter.cloudSandboxesAndActions;
  const missingMeterRes = evaluateCloudAgentAdmission(makeFixture({
    billingEntitlement: {...validBilling, meters: missingMeter}
  }));
  assert.equal(missingMeterRes.reason, 'BUDGET_UNKNOWN');
  assert.equal(missingMeterRes.admissionCode, 'HARD_STOP_UNVERIFIED');

  // Supplemental gh-aw soft caps + remaining included AI credits / premium requests (single-run and batch)
  for (const badCaps of [
    null,
    {maxAiCredits: 0, maxDailyAiCredits: 100},
    {maxAiCredits: 1_000_000_001, maxDailyAiCredits: 1_000_000_001},
    {maxAiCredits: 100, maxDailyAiCredits: 0},
    {maxAiCredits: 100, maxDailyAiCredits: 1_000_000_001},
    {maxAiCredits: 200, maxDailyAiCredits: 100}
  ]) {
    const res = evaluateCloudAgentAdmission(makeFixture({
      billingEntitlement: {...validBilling, ghAwCaps: badCaps}
    }));
    assert.equal(res.reason, 'INVALID_POLICY');
    assert.equal(res.admissionCode, 'GH_AW_SOFT_CAPS_INVALID');
    assertCleanTelemetry(res, 'blocked', 'POLICY');
  }

  const runCapExceeded = evaluateCloudAgentAdmission(makeFixture({
    billingEntitlement: {...validBilling, accounting: {...validAccounting, runAiCreditsRequired: 101}}
  }));
  assert.equal(runCapExceeded.reason, 'BUDGET_OR_CONCURRENCY');
  assert.equal(runCapExceeded.admissionCode, 'GH_AW_MAX_AI_CREDITS_EXCEEDED');
  assertCleanTelemetry(runCapExceeded, 'blocked', 'QUOTA');

  const singleDailyExceeded = evaluateCloudAgentAdmission(makeFixture({
    billingEntitlement: {...validBilling, accounting: {...validAccounting, dailyAiCreditsUsed: 490, runAiCreditsRequired: 20}}
  }));
  assert.equal(singleDailyExceeded.reason, 'CAPACITY_EXHAUSTED');
  assert.equal(singleDailyExceeded.admissionCode, 'GH_AW_DAILY_AI_CREDITS_EXCEEDED');

  const batchDailyExceeded = evaluateCloudAgentAdmission(makeFixture({
    billingEntitlement: {...validBilling, accounting: {...validAccounting, dailyAiCreditsUsed: 450, runAiCreditsRequired: 20}}
  }));
  assert.equal(batchDailyExceeded.reason, 'CAPACITY_EXHAUSTED');
  assert.equal(batchDailyExceeded.admissionCode, 'GH_AW_DAILY_AI_CREDITS_EXCEEDED');
  assert.equal(batchDailyExceeded.actualWorkerMax, 4);

  const singleCreditsExhausted = evaluateCloudAgentAdmission(makeFixture({
    billingEntitlement: {...validBilling, accounting: {...validAccounting, remainingIncludedAiCredits: 10, runAiCreditsRequired: 25}}
  }));
  assert.equal(singleCreditsExhausted.reason, 'CAPACITY_EXHAUSTED');
  assert.equal(singleCreditsExhausted.admissionCode, 'INCLUDED_AI_CREDITS_EXHAUSTED');

  const batchCreditsExhausted = evaluateCloudAgentAdmission(makeFixture({
    billingEntitlement: {...validBilling, accounting: {...validAccounting, remainingIncludedAiCredits: 60, runAiCreditsRequired: 25}}
  }));
  assert.equal(batchCreditsExhausted.reason, 'CAPACITY_EXHAUSTED');
  assert.equal(batchCreditsExhausted.admissionCode, 'INCLUDED_AI_CREDITS_EXHAUSTED');

  const singlePremiumExhausted = evaluateCloudAgentAdmission(makeFixture({
    billingEntitlement: {...validBilling, accounting: {...validAccounting, remainingIncludedPremiumRequests: 1, premiumRequestsRequired: 2}}
  }));
  assert.equal(singlePremiumExhausted.reason, 'CAPACITY_EXHAUSTED');
  assert.equal(singlePremiumExhausted.admissionCode, 'INCLUDED_PREMIUM_REQUESTS_EXHAUSTED');

  const batchPremiumExhausted = evaluateCloudAgentAdmission(makeFixture({
    billingEntitlement: {...validBilling, accounting: {...validAccounting, remainingIncludedPremiumRequests: 5, premiumRequestsRequired: 2}}
  }));
  assert.equal(batchPremiumExhausted.reason, 'CAPACITY_EXHAUSTED');
  assert.equal(batchPremiumExhausted.admissionCode, 'INCLUDED_PREMIUM_REQUESTS_EXHAUSTED');

  // Active reservations deduct committed AI credits, daily allowance, and premium requests before admission
  const active60Reservation = {
    ...base.workerPool.reservations[0],
    reservedAiCredits: 60,
    reservedPremiumRequests: 1
  };
  const activeDeductDenied = evaluateCloudAgentAdmission(makeFixture({
    billingEntitlement: {
      ...validBilling,
      accounting: {
        ...validAccounting,
        remainingIncludedAiCredits: 100,
        remainingIncludedPremiumRequests: 10,
        dailyAiCreditsUsed: 0,
        runAiCreditsRequired: 60,
        premiumRequestsRequired: 1
      }
    },
    workerPool: {
      ...base.workerPool,
      requestedWorkers: 1,
      verifiedPriorWorkerTier: 0,
      reservations: [active60Reservation]
    }
  }));
  assert.equal(activeDeductDenied.admitted, false);
  assert.equal(activeDeductDenied.reason, 'CAPACITY_EXHAUSTED');
  assert.equal(activeDeductDenied.admissionCode, 'INCLUDED_AI_CREDITS_EXHAUSTED');
  assertCleanTelemetry(activeDeductDenied, 'blocked', 'QUOTA');

  const activeDailyDenied = evaluateCloudAgentAdmission(makeFixture({
    billingEntitlement: {
      ...validBilling,
      accounting: {
        ...validAccounting,
        remainingIncludedAiCredits: 500,
        dailyAiCreditsUsed: 410,
        runAiCreditsRequired: 40,
        premiumRequestsRequired: 1
      }
    },
    workerPool: {
      ...base.workerPool,
      requestedWorkers: 1,
      verifiedPriorWorkerTier: 0,
      reservations: [active60Reservation]
    }
  }));
  assert.equal(activeDailyDenied.reason, 'CAPACITY_EXHAUSTED');
  assert.equal(activeDailyDenied.admissionCode, 'GH_AW_DAILY_AI_CREDITS_EXCEEDED');

  const activePremDenied = evaluateCloudAgentAdmission(makeFixture({
    billingEntitlement: {
      ...validBilling,
      accounting: {
        ...validAccounting,
        remainingIncludedAiCredits: 500,
        remainingIncludedPremiumRequests: 3,
        runAiCreditsRequired: 10,
        premiumRequestsRequired: 2
      }
    },
    workerPool: {
      ...base.workerPool,
      requestedWorkers: 1,
      verifiedPriorWorkerTier: 0,
      reservations: [{...active60Reservation, reservedPremiumRequests: 2}]
    }
  }));
  assert.equal(activePremDenied.reason, 'CAPACITY_EXHAUSTED');
  assert.equal(activePremDenied.admissionCode, 'INCLUDED_PREMIUM_REQUESTS_EXHAUSTED');

  // Explicit netOfReservationsVerified: true accepts pre-deducted balances without double-subtracting
  const preDeductedOk = evaluateCloudAgentAdmission(makeFixture({
    billingEntitlement: {
      ...validBilling,
      accounting: {
        ...validAccounting,
        netOfReservationsVerified: true,
        remainingIncludedAiCredits: 60,
        remainingIncludedPremiumRequests: 2,
        runAiCreditsRequired: 60,
        premiumRequestsRequired: 2
      }
    },
    workerPool: {
      ...base.workerPool,
      requestedWorkers: 1,
      verifiedPriorWorkerTier: 0,
      reservations: [{
        reservationId: 'res-net-1',
        issue: 101,
        lane: 'lane-a',
        paths: ['tools/engineering-coordinator'],
        leaseGeneration: 1,
        expiresAtMs: base.nowMs + 60_000,
        reservedAiCredits: 0,
        reservedPremiumRequests: 0
      }]
    }
  }));
  assert.equal(preDeductedOk.admitted, true);
  assert.equal(preDeductedOk.accounting.reservedAiCredits, 0);

  // Missing, negative, non-integer, or overflowing active commitments fail closed with RESERVATION_COMMITMENTS_UNKNOWN
  const noCommitmentRes = {...base.workerPool.reservations[0]};
  delete noCommitmentRes.reservedAiCredits;
  const noReqRes = {...base.workerPool.reservations[0]};
  delete noReqRes.reservedPremiumRequests;
  for (const [acctOverride, badReservations] of [
    [{}, [noCommitmentRes]],
    [{}, [noReqRes]],
    [{}, [{...base.workerPool.reservations[0], reservedAiCredits: -1}]],
    [{}, [{...base.workerPool.reservations[0], reservedPremiumRequests: 1.5}]],
    [{netOfReservationsVerified: true}, [{...base.workerPool.reservations[0], reservedAiCredits: -1}]],
    [{netOfReservationsVerified: true}, [{...base.workerPool.reservations[0], reservedPremiumRequests: -1}]],
    [{}, [
      {...base.workerPool.reservations[0], reservedAiCredits: Number.MAX_SAFE_INTEGER, reservedPremiumRequests: 1},
      {
        reservationId: 'res-active-2',
        issue: 102,
        pr: 202,
        lane: 'lane-b',
        paths: ['docs'],
        leaseGeneration: 1,
        expiresAtMs: base.nowMs + 60_000,
        reservedAiCredits: Number.MAX_SAFE_INTEGER,
        reservedPremiumRequests: 1
      }
    ]],
    [{}, [
      {...base.workerPool.reservations[0], reservedAiCredits: 1, reservedPremiumRequests: Number.MAX_SAFE_INTEGER},
      {
        reservationId: 'res-active-2',
        issue: 102,
        pr: 202,
        lane: 'lane-b',
        paths: ['docs'],
        leaseGeneration: 1,
        expiresAtMs: base.nowMs + 60_000,
        reservedAiCredits: 1,
        reservedPremiumRequests: Number.MAX_SAFE_INTEGER
      }
    ]]
  ]) {
    const res = evaluateCloudAgentAdmission(makeFixture({
      billingEntitlement: {...validBilling, accounting: {...validAccounting, ...acctOverride}},
      workerPool: {...base.workerPool, reservations: badReservations}
    }));
    assert.equal(res.reason, 'BUDGET_UNKNOWN');
    assert.equal(res.admissionCode, 'RESERVATION_COMMITMENTS_UNKNOWN');
    assertCleanTelemetry(res, 'blocked', 'QUOTA');
  }

  // Expired reservation with malformed commitment values fails closed as invalid reservation
  for (const badExpired of [
    {...base.workerPool.reservations[1], reservedAiCredits: -1},
    {...base.workerPool.reservations[1], reservedPremiumRequests: -1}
  ]) {
    const badExpiredCommitment = evaluateCloudAgentAdmission(makeFixture({
      workerPool: {...base.workerPool, reservations: [badExpired]}
    }));
    assert.equal(badExpiredCommitment.reason, 'WORK_RESERVATION_UNKNOWN');
    assert.equal(badExpiredCommitment.admissionCode, 'WORKER_POOL_OR_RESERVATIONS_INVALID');
  }
});

test('enforces 1->12 worker ladder, fenced reservation deduplication, CAS generation fencing, and shortfall reporting', () => {
  const base = makeFixture();
  const {nowMs} = base;

  // Step through every valid ladder tier 1 -> 2 -> 4 -> 8 -> 10 -> 12
  for (let i = 0; i < WORKER_LADDER.length; i++) {
    const tier = WORKER_LADDER[i];
    const prior = i === 0 ? 0 : WORKER_LADDER[i - 1];
    for (const verifiedPriorWorkerTier of [prior, tier]) {
      const res = evaluateCloudAgentAdmission(makeFixture({
        workerPool: {
          requestedWorkers: tier,
          verifiedPriorWorkerTier,
          repoConcurrencyCap: tier,
          verifiedWorkerCeiling: tier,
          remainingIncludedSlots: tier,
          reservations: []
        }
      }));
      assert.equal(res.admitted, true);
      assert.equal(res.actualWorkerMax, tier);
      assert.equal(res.workerShortfallFrom12, Math.max(0, 12 - tier));
    }
  }

  for (const invalidTier of [0, 3, 5, 6, 7, 9, 11, 16]) {
    const res = evaluateCloudAgentAdmission(makeFixture({
      workerPool: {...base.workerPool, requestedWorkers: invalidTier}
    }));
    assert.equal(res.reason, 'POLICY_UNKNOWN');
    assert.equal(res.admissionCode, 'WORKER_LADDER_INVALID_TIER');
  }

  const skippedStep = evaluateCloudAgentAdmission(makeFixture({
    workerPool: {...base.workerPool, requestedWorkers: 4, verifiedPriorWorkerTier: 1}
  }));
  assert.equal(skippedStep.reason, 'POLICY_UNKNOWN');
  assert.equal(skippedStep.admissionCode, 'WORKER_LADDER_STEP_SKIPPED');

  const slotsExhausted = evaluateCloudAgentAdmission(makeFixture({
    workerPool: {...base.workerPool, remainingIncludedSlots: 1}
  }));
  assert.equal(slotsExhausted.reason, 'CAPACITY_EXHAUSTED');
  assert.equal(slotsExhausted.admissionCode, 'WORKER_SLOTS_EXHAUSTED');
  assert.equal(slotsExhausted.actualWorkerMax, 0);
  assert.equal(slotsExhausted.workerShortfallFrom12, 12);

  const exceedsCeiling = evaluateCloudAgentAdmission(makeFixture({
    workerPool: {
      ...base.workerPool,
      requestedWorkers: 8,
      verifiedPriorWorkerTier: 4,
      repoConcurrencyCap: 6,
      verifiedWorkerCeiling: 6,
      remainingIncludedSlots: 12,
      reservations: []
    }
  }));
  assert.equal(exceedsCeiling.reason, 'CAPACITY_UNVERIFIED');
  assert.equal(exceedsCeiling.admissionCode, 'WORKER_LADDER_EXCEEDS_VERIFIED_CEILING');
  assert.equal(exceedsCeiling.actualWorkerMax, 4);
  assert.equal(exceedsCeiling.workerShortfallFrom12, 8);

  const exceedsNetLadder = evaluateCloudAgentAdmission(makeFixture({
    workerPool: {
      ...base.workerPool,
      requestedWorkers: 4,
      verifiedPriorWorkerTier: 2,
      repoConcurrencyCap: 8,
      verifiedWorkerCeiling: 8,
      remainingIncludedSlots: 3,
      reservations: []
    }
  }));
  assert.equal(exceedsNetLadder.reason, 'CAPACITY_EXHAUSTED');
  assert.equal(exceedsNetLadder.admissionCode, 'WORKER_LADDER_CAPACITY_EXCEEDED');
  assert.equal(exceedsNetLadder.actualWorkerMax, 2);
  assert.equal(exceedsNetLadder.workerShortfallFrom12, 10);

  // Stale CAS leaseGeneration <= expired reservation's generation fails closed
  const staleFence = evaluateCloudAgentAdmission(makeFixture({
    candidate: {...base.candidate, leaseGeneration: 2}
  }));
  assert.equal(staleFence.reason, 'STALE_CHECKPOINT');
  assert.equal(staleFence.admissionCode, 'STALE_FENCED_GENERATION');
  assertCleanTelemetry(staleFence, 'blocked', 'LEASE');

  // Duplicate issue, PR, lane, overlapping paths, and internal active reservation conflicts -> LANE_OR_PATH_RESERVED
  for (const [candidatePatch, expectedCode] of [
    [{issue: 101}, 'DUPLICATE_ISSUE_RESERVATION'],
    [{pr: 201}, 'DUPLICATE_PR_RESERVATION'],
    [{lane: 'lane-a'}, 'DUPLICATE_LANE_RESERVATION'],
    [{paths: ['tools/engineering-coordinator/planner.mjs']}, 'OVERLAPPING_PATH_RESERVATION'],
    [{paths: ['tools']}, 'OVERLAPPING_PATH_RESERVATION']
  ]) {
    const res = evaluateCloudAgentAdmission(makeFixture({
      candidate: {...base.candidate, ...candidatePatch}
    }));
    assert.equal(res.reason, 'LANE_OR_PATH_RESERVED');
    assert.equal(res.admissionCode, expectedCode);
    assert.equal(res.actualWorkerMax, 4);
    assert.equal(res.workerShortfallFrom12, 8);
    assertCleanTelemetry(res, 'blocked', 'LEASE');
  }

  for (const conflictingSecond of [
    {reservationId: 'res-2', issue: 101, lane: 'lane-b', paths: ['docs'], leaseGeneration: 1, expiresAtMs: nowMs + 10_000},
    {reservationId: 'res-2', issue: 102, pr: 201, lane: 'lane-b', paths: ['docs'], leaseGeneration: 1, expiresAtMs: nowMs + 10_000},
    {reservationId: 'res-2', issue: 102, lane: 'lane-a', paths: ['docs'], leaseGeneration: 1, expiresAtMs: nowMs + 10_000},
    {reservationId: 'res-2', issue: 102, lane: 'lane-b', paths: ['tools/engineering-coordinator/retry.mjs'], leaseGeneration: 1, expiresAtMs: nowMs + 10_000}
  ]) {
    const res = evaluateCloudAgentAdmission(makeFixture({
      workerPool: {
        ...base.workerPool,
        reservations: [base.workerPool.reservations[0], conflictingSecond]
      }
    }));
    assert.equal(res.reason, 'LANE_OR_PATH_RESERVED');
    assert.equal(res.admissionCode, 'ACTIVE_RESERVATION_CONFLICT');
  }

  // Candidate lease TTL & malformed candidate/pool/reservation validation
  for (const badLeaseMs of [nowMs, nowMs - 1, nowMs + MAX_LEASE_TTL_MS + 1]) {
    const res = evaluateCloudAgentAdmission(makeFixture({
      candidate: {...base.candidate, leaseExpiresAtMs: badLeaseMs}
    }));
    assert.equal(res.reason, 'LEASE_OR_CLOCK_UNKNOWN');
    assert.equal(res.admissionCode, 'CANDIDATE_LEASE_EXPIRED_OR_UNBOUNDED');
    assertCleanTelemetry(res, 'blocked', 'LEASE');
  }

  for (const badCandidate of [
    null,
    {...base.candidate, issue: 0},
    {...base.candidate, pr: 0},
    {...base.candidate, lane: 'BAD LANE'},
    {...base.candidate, paths: []},
    {...base.candidate, paths: ['../escape']},
    {...base.candidate, paths: ['/abs/path']},
    {...base.candidate, paths: ['a\\b']},
    {...base.candidate, paths: ['a//b']},
    {...base.candidate, paths: ['src/a', 'src/a']},
    {...base.candidate, leaseGeneration: 0},
    {...base.candidate, leaseExpiresAtMs: 0}
  ]) {
    const res = evaluateCloudAgentAdmission(makeFixture({candidate: badCandidate}));
    assert.equal(res.reason, 'INVALID_CANDIDATE');
    assert.equal(res.admissionCode, 'CANDIDATE_INVALID');
    assertCleanTelemetry(res, 'blocked', 'INVALID_EVIDENCE');
  }

  for (const badPool of [
    null,
    {...base.workerPool, requestedWorkers: 1.5},
    {...base.workerPool, verifiedPriorWorkerTier: -1},
    {...base.workerPool, repoConcurrencyCap: 0},
    {...base.workerPool, repoConcurrencyCap: 1001},
    {...base.workerPool, verifiedWorkerCeiling: 0},
    {...base.workerPool, verifiedWorkerCeiling: 1001},
    {...base.workerPool, remainingIncludedSlots: -1},
    {...base.workerPool, remainingIncludedSlots: 1001},
    {...base.workerPool, reservations: 'not-array'},
    {
      ...base.workerPool,
      reservations: [
        base.workerPool.reservations[0],
        {...base.workerPool.reservations[0], issue: 105, lane: 'other', paths: ['docs']}
      ]
    },
    {
      ...base.workerPool,
      reservations: [{...base.workerPool.reservations[0], reservationId: 'bad id!'}]
    },
    {
      ...base.workerPool,
      reservations: [{...base.workerPool.reservations[0], expiresAtMs: -1}]
    }
  ]) {
    const res = evaluateCloudAgentAdmission(makeFixture({workerPool: badPool}));
    assert.equal(res.reason, 'WORK_RESERVATION_UNKNOWN');
    assert.equal(res.admissionCode, 'WORKER_POOL_OR_RESERVATIONS_INVALID');
    assertCleanTelemetry(res, 'blocked', 'LEASE');
  }
});

test('rejects proxies (including revoked proxies), getters, non-enumerable properties, and custom prototypes without executing user code', () => {
  let trapCalls = 0;
  const poison = () => {
    trapCalls++;
    throw new Error('unexpected trap or getter execution');
  };

  const revokedObj = Proxy.revocable(makeFixture(), {get: poison, getPrototypeOf: poison});
  revokedObj.revoke();
  const revokedArr = Proxy.revocable(['gpt-5.4'], {get: poison, getPrototypeOf: poison});
  revokedArr.revoke();

  const getterTop = makeFixture();
  Object.defineProperty(getterTop, 'stop', {enumerable: true, get: poison});

  const nonEnumTop = makeFixture();
  Object.defineProperty(nonEnumTop, 'stop', {enumerable: false, value: false});

  const symbolTop = {...makeFixture(), [Symbol('secret')]: 1};
  const oversizedKeys = Object.fromEntries(Array.from({length: 65}, (_, i) => [`k${i}`, i]));

  const sparseAllowlist = new Array(2);
  sparseAllowlist[0] = 'gpt-5.4';

  const nonEnumArrayItem = ['gpt-5.4'];
  Object.defineProperty(nonEnumArrayItem, 0, {enumerable: false, value: 'gpt-5.4'});

  const extraPropArray = ['gpt-5.4'];
  extraPropArray.extra = 'bad';

  for (const badTop of [
    null,
    undefined,
    [],
    'string',
    Object.create(makeFixture()),
    new Proxy(makeFixture(), {get: poison, getOwnPropertyDescriptor: poison, ownKeys: poison}),
    revokedObj.proxy,
    getterTop,
    nonEnumTop,
    symbolTop,
    oversizedKeys,
    {...makeFixture(), stop: 'false'}
  ]) {
    const res = evaluateCloudAgentAdmission(badTop);
    assert.equal(res.admitted, false);
    assert.equal(res.reason, 'EVIDENCE_UNKNOWN');
    assert.equal(res.admissionCode, 'ADMISSION_INPUT_INVALID');
  }

  for (const badAllowlist of [
    revokedArr.proxy,
    new Proxy(['gpt-5.4'], {get: poison, ownKeys: poison}),
    Object.setPrototypeOf(['gpt-5.4'], Object.create(Array.prototype)),
    sparseAllowlist,
    nonEnumArrayItem,
    extraPropArray,
    Array.from({length: 65}, (_, i) => `model-${i}`)
  ]) {
    const res = evaluateCloudAgentAdmission(makeFixture({
      model: {id: 'gpt-5.4', allowlist: badAllowlist, verifiedAvailable: true}
    }));
    assert.equal(res.admitted, false);
    assert.equal(res.reason, 'EVIDENCE_UNKNOWN');
  }

  assert.equal(trapCalls, 0);
});
