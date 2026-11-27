import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {
  AI_CREDIT_USD_CENTS,
  AUTOMATION_ALLOWED_VISIBILITIES,
  BILLING_METERS,
  BILLING_SMOKE_RECEIPT_SCHEMA_VERSION,
  DEFAULT_MAX_RECEIPT_AGE_MS,
  MAX_ALLOWED_RECEIPT_AGE_MS,
  NATIVE_CLOUD_AGENT_ACTOR,
  REPOSITORY_VISIBILITIES,
  SOFTWARE_FACTORY_REPOSITORY,
  SOFTWARE_FACTORY_REPOSITORY_ID,
  SUPPORTED_RUNNERS,
  SUPPORTED_SMOKE_HARNESSES,
  aiCreditsToUsdCents,
  verifyBillingHardStopAndSmokeReceipt
} from '../../tools/engineering-factory/billing-hardstop-smoke.mjs';
import {
  createExecutionReceipt,
  telemetrySummary
} from '../../tools/engineering-factory/telemetry.mjs';

function makeMeters(overrides = {}) {
  const baseMeter = {
    verified: true,
    overageLimitUsdCents: 0,
    overageAllowed: false
  };
  return {
    aiCredits: {...baseMeter, ...(overrides.aiCredits ?? {})},
    copilotPremiumRequests: {...baseMeter, ...(overrides.copilotPremiumRequests ?? {})},
    cloudSandboxesAndActions: {...baseMeter, ...(overrides.cloudSandboxesAndActions ?? {})}
  };
}

function makeReceipt(overrides = {}) {
  const nowMs = 1_764_273_600_000;
  return {
    schemaVersion: 1,
    stop: false,
    repository: 'Jamula/SoftwareFactory',
    repositoryId: 1471342715,
    repositoryVisibility: 'public',
    nowMs,
    retiredDiyWorkflowAbsent: true,
    zeroPersonalPatSecretsVerified: true,
    customPilotEnvironmentAbsent: true,
    billingHardStop: {
      authenticatedBillingCheck: true,
      observedAtMs: nowMs - 120_000,
      aiCreditUnitUsdCents: 1,
      ghAwCapsSoftOnlyAcknowledged: true,
      meters: makeMeters()
    },
    smokeReceipt: {
      harness: 'copilot-cloud-agent',
      runner: 'github-hosted',
      laptopOrChatDependency: false,
      taskId: '01936D8E-7F2A-7B00-8A11-3C4D5E6F7081',
      sessionId: 'mc-sess-20261127-01',
      actor: 'copilot-swe-agent[bot]',
      observedAtMs: nowMs - 60_000,
      includedQuotaAttributed: true,
      incrementalBilledUsdCents: 0,
      accountingSource: 'verified',
      isEstimated: false,
      aiCreditsUsed: 4,
      premiumRequestsUsed: 1,
      linkedPullRequest: 145,
      linkedRunId: 9001
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
    receiptId: 'gh-105-smoke-verify',
    observedMs: 1_764_273_600_000,
    stage: 'acceptance',
    durationMs: 5,
    result
  });
  assert.equal(receipt.valid, true);
  assert.equal(receipt.outcome, expectedOutcome);
  assert.equal(receipt.reason, expectedReason);
}

test('exports frozen #105 constants and exact integer AI-credit conversion without fabricating live activation', () => {
  assert.equal(BILLING_SMOKE_RECEIPT_SCHEMA_VERSION, 1);
  assert.equal(AI_CREDIT_USD_CENTS, 1);
  assert.equal(SOFTWARE_FACTORY_REPOSITORY, 'Jamula/SoftwareFactory');
  assert.equal(SOFTWARE_FACTORY_REPOSITORY_ID, 1471342715);
  assert.equal(NATIVE_CLOUD_AGENT_ACTOR, 'copilot-swe-agent[bot]');
  assert.equal(DEFAULT_MAX_RECEIPT_AGE_MS, 86_400_000);
  assert.equal(MAX_ALLOWED_RECEIPT_AGE_MS, 2_592_000_000);
  assert.deepEqual(BILLING_METERS, [
    'aiCredits',
    'copilotPremiumRequests',
    'cloudSandboxesAndActions'
  ]);
  assert.deepEqual(SUPPORTED_SMOKE_HARNESSES, [
    'copilot-cloud-agent',
    'copilot-cloud-automation'
  ]);
  assert.deepEqual(SUPPORTED_RUNNERS, ['github-hosted', 'cloud-sandbox']);
  assert.deepEqual(REPOSITORY_VISIBILITIES, ['public', 'private', 'internal']);
  assert.deepEqual(AUTOMATION_ALLOWED_VISIBILITIES, ['private', 'internal']);
  assert.equal(Object.isFrozen(SUPPORTED_SMOKE_HARNESSES), true);

  assert.equal(aiCreditsToUsdCents(0), 0);
  assert.equal(aiCreditsToUsdCents(1), 1);
  assert.equal(aiCreditsToUsdCents(42), 42);
  assert.equal(aiCreditsToUsdCents(-1), null);
  assert.equal(aiCreditsToUsdCents(1.25), null);
});

test('verifies full Cloud Agent public receipt and minimal private/internal Cloud Automation receipts in shadow mode', () => {
  const full = verifyBillingHardStopAndSmokeReceipt(makeReceipt());
  assert.deepEqual(full, {
    schemaVersion: 1,
    shadow: true,
    liveActivation: false,
    autonomousExitAccepted: false,
    verified: true,
    hardStopBillingVerified: true,
    reason: 'SHADOW_ELIGIBLE',
    verificationCode: 'BILLING_HARD_STOP_AND_SMOKE_VERIFIED',
    repository: 'Jamula/SoftwareFactory',
    repositoryId: 1471342715,
    repositoryVisibility: 'public',
    guardrails: {
      retiredDiyWorkflowAbsent: true,
      zeroPersonalPatSecretsVerified: true,
      customPilotEnvironmentAbsent: true
    },
    billingHardStop: {
      authenticatedBillingCheck: true,
      observedAtMs: 1_764_273_480_000,
      aiCreditUsdCents: 1,
      ghAwCapsSoftOnlyAcknowledged: true,
      metersVerified: [
        'aiCredits',
        'copilotPremiumRequests',
        'cloudSandboxesAndActions'
      ],
      overageLimitUsdCents: 0,
      overageAllowed: false
    },
    smokeReceipt: {
      harness: 'copilot-cloud-agent',
      runner: 'github-hosted',
      laptopOrChatDependency: false,
      taskId: '01936d8e-7f2a-7b00-8a11-3c4d5e6f7081',
      sessionId: 'mc-sess-20261127-01',
      actor: 'copilot-swe-agent[bot]',
      observedAtMs: 1_764_273_540_000,
      includedQuotaAttributed: true,
      incrementalBilledUsdCents: 0,
      accountingSource: 'verified',
      aiCreditsUsed: 4,
      includedAiCreditsUsdCents: 4,
      premiumRequestsUsed: 1,
      linkedPullRequest: 145,
      linkedRunId: 9001
    }
  });
  assert.equal(Object.isFrozen(full), true);
  assert.equal(Object.isFrozen(full.guardrails), true);
  assert.equal(Object.isFrozen(full.billingHardStop), true);
  assert.equal(Object.isFrozen(full.smokeReceipt), true);
  assertCleanTelemetry(full, 'eligible', 'NONE');

  for (const visibility of ['private', 'internal']) {
    const minimal = {
      stop: false,
      repository: 'Jamula/FamilyTree',
      repositoryId: 2_222_222,
      repositoryVisibility: visibility,
      nowMs: 1_764_273_600_000,
      maxReceiptAgeMs: 172_800_000,
      retiredDiyWorkflowAbsent: true,
      zeroPersonalPatSecretsVerified: true,
      billingHardStop: {
        authenticatedBillingCheck: true,
        observedAtMs: 1_764_173_600_000,
        meters: makeMeters()
      },
      smokeReceipt: {
        harness: 'copilot-cloud-automation',
        taskId: '550e8400-e29b-41d4-a716-446655440000',
        sessionId: 'auto_session:01',
        actor: 'copilot-swe-agent[bot]',
        observedAtMs: 1_764_173_600_000,
        includedQuotaAttributed: true,
        incrementalBilledUsdCents: 0,
        accountingSource: 'verified'
      }
    };
    const res = verifyBillingHardStopAndSmokeReceipt(minimal, {
      expectedRepository: 'Jamula/FamilyTree',
      expectedRepositoryId: 2_222_222
    });
    assert.equal(res.verified, true);
    assert.equal(res.shadow, true);
    assert.equal(res.liveActivation, false);
    assert.equal(res.autonomousExitAccepted, false);
    assert.equal(res.guardrails.customPilotEnvironmentAbsent, null);
    assert.equal(res.billingHardStop.ghAwCapsSoftOnlyAcknowledged, null);
    assert.equal(res.smokeReceipt.runner, null);
    assert.equal(res.smokeReceipt.laptopOrChatDependency, null);
    assert.equal(res.smokeReceipt.aiCreditsUsed, null);
    assert.equal(res.smokeReceipt.includedAiCreditsUsdCents, null);
    assert.equal(res.smokeReceipt.premiumRequestsUsed, null);
    assert.equal(res.smokeReceipt.linkedPullRequest, null);
    assert.equal(res.smokeReceipt.linkedRunId, null);
    assertCleanTelemetry(res, 'eligible', 'NONE');
  }

  const defaultOptsObj = verifyBillingHardStopAndSmokeReceipt(makeReceipt({
    smokeReceipt: {
      ...makeReceipt().smokeReceipt,
      runner: 'cloud-sandbox',
      linkedPullRequest: null,
      linkedRunId: null
    }
  }), {});
  assert.equal(defaultOptsObj.verified, true);
  assert.equal(defaultOptsObj.smokeReceipt.runner, 'cloud-sandbox');
  assert.equal(defaultOptsObj.smokeReceipt.linkedPullRequest, null);

  const explicitFactoryOpts = verifyBillingHardStopAndSmokeReceipt(makeReceipt(), {
    expectedRepository: 'Jamula/SoftwareFactory',
    expectedRepositoryId: 1471342715
  });
  assert.equal(explicitFactoryOpts.verified, true);

  const docUrl = new URL('../../docs/GITHUB-HOSTED-COPILOT-PILOT.md', import.meta.url);
  const docMarkdown = readFileSync(fileURLToPath(docUrl), 'utf8');
  const jsonBlockMatch = /```json\n([\s\S]*?)\n```/.exec(docMarkdown);
  assert.notEqual(jsonBlockMatch, null);
  const docExampleReceipt = JSON.parse(jsonBlockMatch[1]);
  const docVerified = verifyBillingHardStopAndSmokeReceipt(docExampleReceipt, {
    nowMs: 1_795_773_600_000
  });
  assert.equal(docVerified.verified, true);
  assert.equal(docVerified.shadow, true);
  assert.equal(docVerified.liveActivation, false);
  assertCleanTelemetry(docVerified, 'eligible', 'NONE');

  // Re-running verification against an expired saved receipt with a later options.nowMs fails closed
  const docExpired = verifyBillingHardStopAndSmokeReceipt(docExampleReceipt, {
    nowMs: 1_795_773_480_000 + DEFAULT_MAX_RECEIPT_AGE_MS + 1
  });
  assert.equal(docExpired.verified, false);
  assert.equal(docExpired.reason, 'STALE_QUOTA');
  assert.equal(docExpired.verificationCode, 'STALE_BILLING_HARD_STOP_RECEIPT');
  assertCleanTelemetry(docExpired, 'blocked', 'STALE');

  // Saved receipt without embedded nowMs validates cleanly when options.nowMs is supplied
  const withoutInputNow = {...makeReceipt()};
  delete withoutInputNow.nowMs;
  const optClockVerified = verifyBillingHardStopAndSmokeReceipt(withoutInputNow, {
    nowMs: makeReceipt().nowMs
  });
  assert.equal(optClockVerified.verified, true);
});

test('enforces step 1 $0 overage hard-stops across AI Credits, Copilot Premium Requests, and Cloud Sandboxes/Actions plus retired DIY hygiene', () => {
  const minimalStopped = verifyBillingHardStopAndSmokeReceipt({stop: true});
  assert.equal(minimalStopped.verified, false);
  assert.equal(minimalStopped.reason, 'STOPPED');
  assert.equal(minimalStopped.verificationCode, 'STOP_SWITCH_ACTIVE');
  assertCleanTelemetry(minimalStopped, 'blocked', 'POLICY');

  const diyPresent = verifyBillingHardStopAndSmokeReceipt(
    makeReceipt({retiredDiyWorkflowAbsent: false})
  );
  assert.equal(diyPresent.reason, 'PROVIDER_FORBIDDEN');
  assert.equal(diyPresent.verificationCode, 'RETIRED_DIY_WORKFLOW_PRESENT');
  assertCleanTelemetry(diyPresent, 'blocked', 'SECURITY');

  const patPresent = verifyBillingHardStopAndSmokeReceipt(
    makeReceipt({zeroPersonalPatSecretsVerified: false})
  );
  assert.equal(patPresent.reason, 'PROVIDER_FORBIDDEN');
  assert.equal(patPresent.verificationCode, 'PERSONAL_PAT_SECRETS_FORBIDDEN');
  assertCleanTelemetry(patPresent, 'blocked', 'SECURITY');

  const customEnvPresent = verifyBillingHardStopAndSmokeReceipt(
    makeReceipt({customPilotEnvironmentAbsent: false})
  );
  assert.equal(customEnvPresent.reason, 'PROVIDER_FORBIDDEN');
  assert.equal(customEnvPresent.verificationCode, 'CUSTOM_PILOT_ENVIRONMENT_FORBIDDEN');
  assertCleanTelemetry(customEnvPresent, 'blocked', 'SECURITY');

  for (const badHygiene of [
    {retiredDiyWorkflowAbsent: 'true'},
    {zeroPersonalPatSecretsVerified: 1},
    {customPilotEnvironmentAbsent: 'true'}
  ]) {
    const res = verifyBillingHardStopAndSmokeReceipt(makeReceipt(badHygiene));
    assert.equal(res.reason, 'EVIDENCE_UNKNOWN');
    assert.equal(res.verificationCode, 'HYGIENE_EVIDENCE_INVALID');
    assertCleanTelemetry(res, 'blocked', 'INVALID_EVIDENCE');
  }

  const baseBilling = makeReceipt().billingHardStop;
  const unauthBilling = verifyBillingHardStopAndSmokeReceipt(makeReceipt({
    billingHardStop: {...baseBilling, authenticatedBillingCheck: false}
  }));
  assert.equal(unauthBilling.reason, 'BUDGET_UNKNOWN');
  assert.equal(unauthBilling.verificationCode, 'BILLING_CHECK_UNAUTHENTICATED');
  assertCleanTelemetry(unauthBilling, 'blocked', 'QUOTA');

  for (const badUnit of [0, 2, -1, '1', null]) {
    const res = verifyBillingHardStopAndSmokeReceipt(makeReceipt({
      billingHardStop: {...baseBilling, aiCreditUnitUsdCents: badUnit}
    }));
    assert.equal(res.reason, 'INVALID_POLICY');
    assert.equal(res.verificationCode, 'AI_CREDIT_UNIT_MISMATCH');
    assertCleanTelemetry(res, 'blocked', 'POLICY');
  }

  const softCapUnack = verifyBillingHardStopAndSmokeReceipt(makeReceipt({
    billingHardStop: {...baseBilling, ghAwCapsSoftOnlyAcknowledged: false}
  }));
  assert.equal(softCapUnack.reason, 'INVALID_POLICY');
  assert.equal(softCapUnack.verificationCode, 'GH_AW_SOFT_CAPS_NOT_HARD_STOP');
  assertCleanTelemetry(softCapUnack, 'blocked', 'POLICY');

  for (const badBillingShape of [
    null,
    {observedAtMs: baseBilling.observedAtMs, meters: makeMeters()},
    {...baseBilling, authenticatedBillingCheck: 'true'},
    {...baseBilling, observedAtMs: -1},
    {...baseBilling, ghAwCapsSoftOnlyAcknowledged: 'true'},
    {...baseBilling, extraField: true}
  ]) {
    const res = verifyBillingHardStopAndSmokeReceipt(makeReceipt({
      billingHardStop: badBillingShape
    }));
    assert.equal(res.reason, 'EVIDENCE_UNKNOWN');
    assert.equal(res.verificationCode, 'BILLING_HARD_STOP_INVALID');
  }

  const futureBilling = verifyBillingHardStopAndSmokeReceipt(makeReceipt({
    billingHardStop: {...baseBilling, observedAtMs: makeReceipt().nowMs + 1}
  }));
  assert.equal(futureBilling.reason, 'STALE_EVIDENCE');
  assert.equal(futureBilling.verificationCode, 'BILLING_TIMESTAMP_IN_FUTURE');
  assertCleanTelemetry(futureBilling, 'blocked', 'STALE');

  const staleBilling = verifyBillingHardStopAndSmokeReceipt(makeReceipt({
    billingHardStop: {
      ...baseBilling,
      observedAtMs: makeReceipt().nowMs - DEFAULT_MAX_RECEIPT_AGE_MS - 1
    }
  }));
  assert.equal(staleBilling.reason, 'STALE_QUOTA');
  assert.equal(staleBilling.verificationCode, 'STALE_BILLING_HARD_STOP_RECEIPT');
  assertCleanTelemetry(staleBilling, 'blocked', 'STALE');

  const missingMeterMap = makeMeters();
  delete missingMeterMap.aiCredits;
  for (const badMeters of [null, missingMeterMap, {...makeMeters(), extraMeter: {}}]) {
    const res = verifyBillingHardStopAndSmokeReceipt(makeReceipt({
      billingHardStop: {...baseBilling, meters: badMeters}
    }));
    assert.equal(res.reason, 'BUDGET_UNKNOWN');
    assert.equal(res.verificationCode, 'HARD_STOP_METERS_INCOMPLETE');
  }

  for (const meterName of BILLING_METERS) {
    const unverified = verifyBillingHardStopAndSmokeReceipt(makeReceipt({
      billingHardStop: {
        ...baseBilling,
        meters: makeMeters({[meterName]: {verified: false}})
      }
    }));
    assert.equal(unverified.reason, 'BUDGET_UNKNOWN');
    assert.equal(unverified.verificationCode, 'HARD_STOP_METER_UNVERIFIED');
    assert.equal(unverified.detail, `${meterName}:HARD_STOP_METER_UNVERIFIED`);

    const overageAllowed = verifyBillingHardStopAndSmokeReceipt(makeReceipt({
      billingHardStop: {
        ...baseBilling,
        meters: makeMeters({[meterName]: {overageAllowed: true}})
      }
    }));
    assert.equal(overageAllowed.reason, 'BUDGET_UNKNOWN');
    assert.equal(overageAllowed.verificationCode, 'PAID_OVERAGE_ALLOWED');
    assert.equal(overageAllowed.detail, `${meterName}:PAID_OVERAGE_ALLOWED`);

    for (const nonZeroLimit of [1, 100, -1]) {
      const nonZero = verifyBillingHardStopAndSmokeReceipt(makeReceipt({
        billingHardStop: {
          ...baseBilling,
          meters: makeMeters({[meterName]: {overageLimitUsdCents: nonZeroLimit}})
        }
      }));
      assert.equal(nonZero.reason, 'BUDGET_UNKNOWN');
      assert.equal(nonZero.verificationCode, 'OVERAGE_LIMIT_NONZERO');
      assert.equal(nonZero.detail, `${meterName}:OVERAGE_LIMIT_NONZERO`);
    }

    for (const invalidMeter of [
      null,
      {verified: true, overageLimitUsdCents: 0},
      {verified: 'true', overageLimitUsdCents: 0, overageAllowed: false},
      {verified: true, overageLimitUsdCents: '0', overageAllowed: false},
      {verified: true, overageLimitUsdCents: 0, overageAllowed: 'false'},
      {verified: true, overageLimitUsdCents: 0, overageAllowed: false, extra: 1}
    ]) {
      const bad = verifyBillingHardStopAndSmokeReceipt(makeReceipt({
        billingHardStop: {
          ...baseBilling,
          meters: {...makeMeters(), [meterName]: invalidMeter}
        }
      }));
      assert.equal(bad.reason, 'BUDGET_UNKNOWN');
      assert.equal(bad.verificationCode, 'HARD_STOP_METER_INVALID');
      assert.equal(bad.detail, `${meterName}:HARD_STOP_METER_INVALID`);
    }
  }
});

test('enforces step 2 Cloud Agent/Mission Control smoke receipt provenance, visibility rules, and fail-closed verified accounting', () => {
  const baseSmoke = makeReceipt().smokeReceipt;

  // Cloud Automations require private or internal repositories
  const publicAutomation = verifyBillingHardStopAndSmokeReceipt(makeReceipt({
    repositoryVisibility: 'public',
    smokeReceipt: {...baseSmoke, harness: 'copilot-cloud-automation'}
  }));
  assert.equal(publicAutomation.verified, false);
  assert.equal(publicAutomation.reason, 'CAPACITY_UNVERIFIED');
  assert.equal(publicAutomation.verificationCode, 'AUTOMATIONS_REQUIRE_PRIVATE_REPO');
  assertCleanTelemetry(publicAutomation, 'blocked', 'QUOTA');

  for (const badHarness of ['copilot-cli-tarball', 'copilot-sdk', 'actions-pat-cli']) {
    const res = verifyBillingHardStopAndSmokeReceipt(makeReceipt({
      smokeReceipt: {...baseSmoke, harness: badHarness}
    }));
    assert.equal(res.reason, 'PROVIDER_FORBIDDEN');
    assert.equal(res.verificationCode, 'UNSUPPORTED_SMOKE_HARNESS');
    assertCleanTelemetry(res, 'blocked', 'SECURITY');
  }

  for (const badRunner of ['laptop', 'self-hosted', 'open-chat', 'workstation']) {
    const res = verifyBillingHardStopAndSmokeReceipt(makeReceipt({
      smokeReceipt: {...baseSmoke, runner: badRunner}
    }));
    assert.equal(res.reason, 'PROVIDER_FORBIDDEN');
    assert.equal(res.verificationCode, 'UNSUPPORTED_SMOKE_RUNNER');
    assertCleanTelemetry(res, 'blocked', 'SECURITY');
  }

  const laptopDependent = verifyBillingHardStopAndSmokeReceipt(makeReceipt({
    smokeReceipt: {...baseSmoke, laptopOrChatDependency: true}
  }));
  assert.equal(laptopDependent.reason, 'PROVIDER_FORBIDDEN');
  assert.equal(laptopDependent.verificationCode, 'LAPTOP_OR_CHAT_DEPENDENCY_FORBIDDEN');
  assertCleanTelemetry(laptopDependent, 'blocked', 'SECURITY');

  for (const badUuid of [
    '',
    'not-a-uuid',
    '00000000-0000-0000-0000-000000000000',
    '01936d8e-7f2a-9b00-8a11-3c4d5e6f7081',
    '01936d8e-7f2a-7b00-0a11-3c4d5e6f7081',
    12345
  ]) {
    const res = verifyBillingHardStopAndSmokeReceipt(makeReceipt({
      smokeReceipt: {...baseSmoke, taskId: badUuid}
    }));
    assert.equal(res.reason, 'EVIDENCE_UNKNOWN');
    assert.equal(res.verificationCode, 'SMOKE_TASK_ID_INVALID');
  }

  for (const badSessionId of ['', '-leading-dash', 'has space', 'x'.repeat(129), 99]) {
    const res = verifyBillingHardStopAndSmokeReceipt(makeReceipt({
      smokeReceipt: {...baseSmoke, sessionId: badSessionId}
    }));
    assert.equal(res.reason, 'EVIDENCE_UNKNOWN');
    assert.equal(res.verificationCode, 'SMOKE_SESSION_ID_INVALID');
  }

  for (const badActor of ['cyrusjamula', 'github-actions[bot]', 'copilot']) {
    const res = verifyBillingHardStopAndSmokeReceipt(makeReceipt({
      smokeReceipt: {...baseSmoke, actor: badActor}
    }));
    assert.equal(res.reason, 'PROVENANCE_MISMATCH');
    assert.equal(res.verificationCode, 'SMOKE_ACTOR_MISMATCH');
    assertCleanTelemetry(res, 'blocked', 'SECURITY');
  }

  const futureSmoke = verifyBillingHardStopAndSmokeReceipt(makeReceipt({
    smokeReceipt: {...baseSmoke, observedAtMs: makeReceipt().nowMs + 1}
  }));
  assert.equal(futureSmoke.reason, 'STALE_EVIDENCE');
  assert.equal(futureSmoke.verificationCode, 'SMOKE_TIMESTAMP_IN_FUTURE');

  const staleSmoke = verifyBillingHardStopAndSmokeReceipt(makeReceipt({
    smokeReceipt: {
      ...baseSmoke,
      observedAtMs: makeReceipt().nowMs - DEFAULT_MAX_RECEIPT_AGE_MS - 1
    }
  }));
  assert.equal(staleSmoke.reason, 'STALE_QUOTA');
  assert.equal(staleSmoke.verificationCode, 'STALE_SMOKE_RECEIPT');

  for (const badLink of [
    {linkedPullRequest: 0},
    {linkedPullRequest: -1},
    {linkedPullRequest: '145'},
    {linkedRunId: 0},
    {linkedRunId: 1.5}
  ]) {
    const res = verifyBillingHardStopAndSmokeReceipt(makeReceipt({
      smokeReceipt: {...baseSmoke, ...badLink}
    }));
    assert.equal(res.reason, 'EVIDENCE_UNKNOWN');
    assert.equal(res.verificationCode, 'SMOKE_LINKED_REFERENCE_INVALID');
  }

  // Missing or estimated accounting MUST fail closed with ACCOUNTING_ESTIMATED_OR_MISSING
  const omittedAccounting = {...baseSmoke};
  delete omittedAccounting.accountingSource;
  for (const badAccounting of [
    omittedAccounting,
    {...baseSmoke, accountingSource: 'estimated'},
    {...baseSmoke, accountingSource: 'missing'},
    {...baseSmoke, accountingSource: 'gh-aw-fallback'},
    {...baseSmoke, accountingSource: null},
    {...baseSmoke, isEstimated: true},
    {...baseSmoke, isEstimated: 'false'},
    {...baseSmoke, aiCreditsUsed: -1},
    {...baseSmoke, aiCreditsUsed: 1_000_000_001},
    {...baseSmoke, premiumRequestsUsed: -1},
    {...baseSmoke, premiumRequestsUsed: 1.5},
    {...baseSmoke, incrementalBilledUsdCents: null},
    {...baseSmoke, incrementalBilledUsdCents: 0.5}
  ]) {
    const res = verifyBillingHardStopAndSmokeReceipt(makeReceipt({
      smokeReceipt: badAccounting
    }));
    assert.equal(res.verified, false);
    assert.equal(res.reason, 'BUDGET_UNKNOWN');
    assert.equal(res.verificationCode, 'ACCOUNTING_ESTIMATED_OR_MISSING');
    assertCleanTelemetry(res, 'blocked', 'QUOTA');
  }

  const unattributed = verifyBillingHardStopAndSmokeReceipt(makeReceipt({
    smokeReceipt: {...baseSmoke, includedQuotaAttributed: false}
  }));
  assert.equal(unattributed.reason, 'BUDGET_UNKNOWN');
  assert.equal(unattributed.verificationCode, 'INCLUDED_QUOTA_NOT_ATTRIBUTED');

  for (const spend of [1, 25, -1]) {
    const nonZeroSpend = verifyBillingHardStopAndSmokeReceipt(makeReceipt({
      smokeReceipt: {...baseSmoke, incrementalBilledUsdCents: spend}
    }));
    assert.equal(nonZeroSpend.reason, 'BUDGET_UNKNOWN');
    assert.equal(nonZeroSpend.verificationCode, 'INCREMENTAL_SPEND_NONZERO');
  }

  for (const badSmokeShape of [
    null,
    {...baseSmoke, harness: 123},
    {...baseSmoke, actor: ''},
    {...baseSmoke, actor: null},
    {...baseSmoke, observedAtMs: -1},
    {...baseSmoke, includedQuotaAttributed: 'true'},
    {...baseSmoke, runner: 123},
    {...baseSmoke, laptopOrChatDependency: 'false'},
    {type: 'missing-required-keys'}
  ]) {
    const res = verifyBillingHardStopAndSmokeReceipt(makeReceipt({
      smokeReceipt: badSmokeShape
    }));
    assert.equal(res.reason, 'EVIDENCE_UNKNOWN');
    assert.equal(res.verificationCode, 'SMOKE_RECEIPT_INVALID');
  }
});

test('rejects proxies (active and revoked), accessors, non-enumerable/symbol properties, scope mismatches, and bad options', () => {
  const activeProxy = new Proxy(makeReceipt(), {});
  const revoked = Proxy.revocable(makeReceipt(), {});
  revoked.revoke();

  const getterTrap = makeReceipt();
  Object.defineProperty(getterTrap, 'stop', {
    enumerable: true,
    get() {
      throw new Error('getter must never execute');
    }
  });

  const nonEnum = makeReceipt();
  Object.defineProperty(nonEnum, 'stop', {
    value: false,
    enumerable: false
  });

  const withSymbol = makeReceipt();
  withSymbol[Symbol('rogue')] = true;

  const missingField = makeReceipt();
  delete missingField.smokeReceipt;

  const nullProto = Object.assign(Object.create(null), makeReceipt());

  for (const hostileInput of [
    null,
    undefined,
    'receipt',
    [],
    activeProxy,
    revoked.proxy,
    getterTrap,
    nonEnum,
    withSymbol,
    missingField,
    nullProto,
    {...makeReceipt(), stop: 'false'},
    {...makeReceipt(), extraTopKey: 1}
  ]) {
    const res = verifyBillingHardStopAndSmokeReceipt(hostileInput);
    assert.equal(res.verified, false);
    assert.equal(res.reason, 'EVIDENCE_UNKNOWN');
    assert.equal(res.verificationCode, 'RECEIPT_INPUT_INVALID');
    assertCleanTelemetry(res, 'blocked', 'INVALID_EVIDENCE');
  }

  // Nested revoked proxies also fail closed without throwing
  const nestedRevokedMeters = Proxy.revocable(makeMeters(), {});
  nestedRevokedMeters.revoke();
  const nestedRes = verifyBillingHardStopAndSmokeReceipt(makeReceipt({
    billingHardStop: {...makeReceipt().billingHardStop, meters: nestedRevokedMeters.proxy}
  }));
  assert.equal(nestedRes.verified, false);
  assert.equal(nestedRes.verificationCode, 'HARD_STOP_METERS_INCOMPLETE');

  for (const badVersion of [0, 2, '1', null]) {
    const res = verifyBillingHardStopAndSmokeReceipt(
      makeReceipt({schemaVersion: badVersion})
    );
    assert.equal(res.reason, 'EVIDENCE_UNKNOWN');
    assert.equal(res.verificationCode, 'UNSUPPORTED_RECEIPT_SCHEMA_VERSION');
  }

  for (const badIdentity of [
    {repository: ''},
    {repository: 'no-slash'},
    {repository: 'a/b/c'},
    {repository: 'owner/.'},
    {repository: 'owner/..'},
    {repository: 'owner/bad repo!'},
    {repository: `${'a'.repeat(101)}/${'b'.repeat(101)}`},
    {repository: 123},
    {repositoryId: 0},
    {repositoryId: -5},
    {repositoryId: '1471342715'}
  ]) {
    const res = verifyBillingHardStopAndSmokeReceipt(makeReceipt(badIdentity));
    assert.equal(res.reason, 'INVALID_IDENTITY');
    assert.equal(res.verificationCode, 'REPOSITORY_IDENTITY_INVALID');
    assertCleanTelemetry(res, 'blocked', 'INVALID_EVIDENCE');
  }

  for (const mismatch of [
    {repository: 'Jamula/OtherRepo'},
    {repositoryId: 999_999}
  ]) {
    const res = verifyBillingHardStopAndSmokeReceipt(makeReceipt(mismatch));
    assert.equal(res.reason, 'PROVENANCE_MISMATCH');
    assert.equal(res.verificationCode, 'REPOSITORY_SCOPE_MISMATCH');
    assertCleanTelemetry(res, 'blocked', 'SECURITY');
  }

  const missingClockReceipt = {...makeReceipt()};
  delete missingClockReceipt.nowMs;
  for (const badEnv of [
    makeReceipt({repositoryVisibility: 'enterprise'}),
    makeReceipt({nowMs: -1}),
    makeReceipt({nowMs: 1.5}),
    missingClockReceipt
  ]) {
    const res = verifyBillingHardStopAndSmokeReceipt(badEnv);
    assert.equal(res.reason, 'EVIDENCE_UNKNOWN');
    assert.equal(res.verificationCode, 'REPOSITORY_OR_CLOCK_INVALID');
  }

  const futureReceiptNow = verifyBillingHardStopAndSmokeReceipt(makeReceipt(), {
    nowMs: makeReceipt().nowMs - 1
  });
  assert.equal(futureReceiptNow.reason, 'STALE_EVIDENCE');
  assert.equal(futureReceiptNow.verificationCode, 'RECEIPT_TIMESTAMP_IN_FUTURE');
  assertCleanTelemetry(futureReceiptNow, 'blocked', 'STALE');

  for (const badMaxAge of [0, -1, MAX_ALLOWED_RECEIPT_AGE_MS + 1, '86400000']) {
    const res = verifyBillingHardStopAndSmokeReceipt(
      makeReceipt({maxReceiptAgeMs: badMaxAge})
    );
    assert.equal(res.reason, 'INVALID_POLICY');
    assert.equal(res.verificationCode, 'MAX_RECEIPT_AGE_INVALID');
  }

  const revokedOpts = Proxy.revocable({}, {});
  revokedOpts.revoke();
  for (const badOptions of [
    null,
    'opts',
    revokedOpts.proxy,
    {unknownOption: true},
    {expectedRepository: 'bad slug', expectedRepositoryId: 222},
    {expectedRepository: 'Jamula/FamilyTree', expectedRepositoryId: 0},
    {expectedRepository: 'Jamula/FamilyTree'},
    {expectedRepositoryId: 222},
    {expectedRepository: 'jamula/softwarefactory', expectedRepositoryId: 222},
    {expectedRepository: 'jamula/softwarefactory', expectedRepositoryId: 1471342715},
    {nowMs: -1},
    {nowMs: 1.5},
    {nowMs: '1795773600000'}
  ]) {
    const res = verifyBillingHardStopAndSmokeReceipt(makeReceipt(), badOptions);
    assert.equal(res.verified, false);
    assert.equal(res.reason, 'INVALID_POLICY');
    assert.equal(res.verificationCode, 'VERIFIER_OPTIONS_INVALID');
    assertCleanTelemetry(res, 'blocked', 'POLICY');
  }
});
