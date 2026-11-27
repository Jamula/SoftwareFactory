// Deterministic, metadata-only, read-only, fail-closed verifier for Issue #105
// (M01.07.01): native GitHub Cloud Copilot $0 overage hard-stop budgets across
// AI Credits (1 AI credit = $0.01), Copilot Premium Requests, and Cloud
// Sandboxes / GitHub Actions, retired DIY workflow + zero personal PAT hygiene,
// and minimal Mission Control / Cloud Agent smoke receipt verification.
// Never fabricates live owner billing settings or grants live activation.
import {types} from 'node:util';
import {
  AI_CREDIT_USD_CENTS,
  AUTOMATION_ALLOWED_VISIBILITIES,
  BILLING_METERS,
  MAX_CREDIT_COUNT,
  REPOSITORY_VISIBILITIES,
  SUPPORTED_RUNNERS,
  aiCreditsToUsdCents
} from './cloud-agent-admission.mjs';

export {
  AI_CREDIT_USD_CENTS,
  AUTOMATION_ALLOWED_VISIBILITIES,
  BILLING_METERS,
  REPOSITORY_VISIBILITIES,
  SUPPORTED_RUNNERS,
  aiCreditsToUsdCents
};

export const BILLING_SMOKE_RECEIPT_SCHEMA_VERSION = 1;
export const SOFTWARE_FACTORY_REPOSITORY = 'Jamula/SoftwareFactory';
export const SOFTWARE_FACTORY_REPOSITORY_ID = 1471342715;
export const NATIVE_CLOUD_AGENT_ACTOR = 'copilot-swe-agent[bot]';
export const DEFAULT_MAX_RECEIPT_AGE_MS = 86_400_000;
export const MAX_ALLOWED_RECEIPT_AGE_MS = 2_592_000_000;

export const SUPPORTED_SMOKE_HARNESSES = Object.freeze([
  'copilot-cloud-agent',
  'copilot-cloud-automation'
]);

const OPTION_KEYS = new Set(['expectedRepository', 'expectedRepositoryId', 'nowMs']);

const REQUIRED_TOP_LEVEL_KEYS = Object.freeze([
  'stop',
  'repository',
  'repositoryId',
  'repositoryVisibility',
  'retiredDiyWorkflowAbsent',
  'zeroPersonalPatSecretsVerified',
  'billingHardStop',
  'smokeReceipt'
]);
const TOP_LEVEL_KEYS = new Set([
  ...REQUIRED_TOP_LEVEL_KEYS,
  'nowMs',
  'schemaVersion',
  'maxReceiptAgeMs',
  'customPilotEnvironmentAbsent'
]);

const REQUIRED_BILLING_KEYS = Object.freeze([
  'authenticatedBillingCheck',
  'observedAtMs',
  'meters'
]);
const BILLING_KEYS = new Set([
  ...REQUIRED_BILLING_KEYS,
  'aiCreditUnitUsdCents',
  'ghAwCapsSoftOnlyAcknowledged'
]);

const METER_SET = new Set(BILLING_METERS);
const REQUIRED_METER_ITEM_KEYS = Object.freeze([
  'verified',
  'overageLimitUsdCents',
  'overageAllowed'
]);
const METER_ITEM_KEYS = new Set(REQUIRED_METER_ITEM_KEYS);

const REQUIRED_SMOKE_BASE_KEYS = Object.freeze([
  'harness',
  'taskId',
  'sessionId',
  'actor',
  'observedAtMs',
  'includedQuotaAttributed',
  'incrementalBilledUsdCents'
]);
const SMOKE_KEYS = new Set([
  ...REQUIRED_SMOKE_BASE_KEYS,
  'accountingSource',
  'isEstimated',
  'runner',
  'laptopOrChatDependency',
  'aiCreditsUsed',
  'premiumRequestsUsed',
  'linkedPullRequest',
  'linkedRunId'
]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const nonneg = n => Number.isSafeInteger(n) && n >= 0;
const positive = n => nonneg(n) && n > 0;
const boundedCount = n => nonneg(n) && n <= MAX_CREDIT_COUNT;
const validUuid = s => typeof s === 'string' && UUID_PATTERN.test(s);
const validSessionId = s => typeof s === 'string' && SESSION_ID_PATTERN.test(s);

function validRepositorySlug(value) {
  if (typeof value !== 'string' || value.length > 201) return false;
  const parts = value.split('/');
  return parts.length === 2 && parts.every(
    part => /^[A-Za-z0-9_.-]{1,100}$/.test(part) && part !== '.' && part !== '..'
  );
}

function ownEnumerableData(obj, key) {
  const descriptor = Object.getOwnPropertyDescriptor(obj, key);
  return descriptor.enumerable === true && Object.hasOwn(descriptor, 'value');
}

function plainObject(value, allowedKeys) {
  if (value === null || typeof value !== 'object' || types.isProxy(value) ||
      Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > allowedKeys.size) return false;
  return keys.every(
    key => typeof key === 'string' && allowedKeys.has(key) && ownEnumerableData(value, key)
  );
}

function hasRequiredKeys(obj, requiredKeys) {
  return requiredKeys.every(key => Object.hasOwn(obj, key));
}

function deny(reason, verificationCode, detail = verificationCode) {
  return Object.freeze({
    shadow: true,
    liveActivation: false,
    autonomousExitAccepted: false,
    verified: false,
    hardStopBillingVerified: false,
    state: 'blocked',
    reason,
    verificationCode,
    detail
  });
}

function resolveOptions(options) {
  if (options === undefined) {
    return {
      ok: true,
      expectedRepository: SOFTWARE_FACTORY_REPOSITORY,
      expectedRepositoryId: SOFTWARE_FACTORY_REPOSITORY_ID,
      nowMs: null
    };
  }
  if (!plainObject(options, OPTION_KEYS)) return {ok: false};
  const expectedRepository = Object.hasOwn(options, 'expectedRepository')
    ? options.expectedRepository
    : SOFTWARE_FACTORY_REPOSITORY;
  const expectedRepositoryId = Object.hasOwn(options, 'expectedRepositoryId')
    ? options.expectedRepositoryId
    : SOFTWARE_FACTORY_REPOSITORY_ID;
  const hasOptionNow = Object.hasOwn(options, 'nowMs');
  if (!validRepositorySlug(expectedRepository) || !positive(expectedRepositoryId) ||
      (hasOptionNow && !nonneg(options.nowMs))) {
    return {ok: false};
  }
  const isFactorySlug =
    expectedRepository.toLowerCase() === SOFTWARE_FACTORY_REPOSITORY.toLowerCase();
  const isFactoryId = expectedRepositoryId === SOFTWARE_FACTORY_REPOSITORY_ID;
  if (isFactorySlug !== isFactoryId ||
      (isFactoryId && expectedRepository !== SOFTWARE_FACTORY_REPOSITORY)) {
    return {ok: false};
  }
  return {
    ok: true,
    expectedRepository,
    expectedRepositoryId,
    nowMs: hasOptionNow ? options.nowMs : null
  };
}

function evaluateBillingHardStop(billingHardStop, nowMs, maxReceiptAgeMs) {
  if (!plainObject(billingHardStop, BILLING_KEYS) ||
      !hasRequiredKeys(billingHardStop, REQUIRED_BILLING_KEYS) ||
      typeof billingHardStop.authenticatedBillingCheck !== 'boolean' ||
      !nonneg(billingHardStop.observedAtMs)) {
    return {error: deny('EVIDENCE_UNKNOWN', 'BILLING_HARD_STOP_INVALID')};
  }
  if (Object.hasOwn(billingHardStop, 'aiCreditUnitUsdCents') &&
      billingHardStop.aiCreditUnitUsdCents !== AI_CREDIT_USD_CENTS) {
    return {error: deny('INVALID_POLICY', 'AI_CREDIT_UNIT_MISMATCH')};
  }
  let ghAwCapsSoftOnlyAcknowledged = null;
  if (Object.hasOwn(billingHardStop, 'ghAwCapsSoftOnlyAcknowledged')) {
    if (typeof billingHardStop.ghAwCapsSoftOnlyAcknowledged !== 'boolean') {
      return {error: deny('EVIDENCE_UNKNOWN', 'BILLING_HARD_STOP_INVALID')};
    }
    if (!billingHardStop.ghAwCapsSoftOnlyAcknowledged) {
      return {error: deny('INVALID_POLICY', 'GH_AW_SOFT_CAPS_NOT_HARD_STOP')};
    }
    ghAwCapsSoftOnlyAcknowledged = true;
  }
  if (!billingHardStop.authenticatedBillingCheck) {
    return {error: deny('BUDGET_UNKNOWN', 'BILLING_CHECK_UNAUTHENTICATED')};
  }
  if (billingHardStop.observedAtMs > nowMs) {
    return {error: deny('STALE_EVIDENCE', 'BILLING_TIMESTAMP_IN_FUTURE')};
  }
  if (nowMs - billingHardStop.observedAtMs > maxReceiptAgeMs) {
    return {error: deny('STALE_QUOTA', 'STALE_BILLING_HARD_STOP_RECEIPT')};
  }
  if (!plainObject(billingHardStop.meters, METER_SET) ||
      !hasRequiredKeys(billingHardStop.meters, BILLING_METERS)) {
    return {error: deny('BUDGET_UNKNOWN', 'HARD_STOP_METERS_INCOMPLETE')};
  }
  for (const meterName of BILLING_METERS) {
    const meter = billingHardStop.meters[meterName];
    if (!plainObject(meter, METER_ITEM_KEYS) ||
        !hasRequiredKeys(meter, REQUIRED_METER_ITEM_KEYS) ||
        typeof meter.verified !== 'boolean' ||
        !Number.isSafeInteger(meter.overageLimitUsdCents) ||
        typeof meter.overageAllowed !== 'boolean') {
      return {
        error: deny(
          'BUDGET_UNKNOWN',
          'HARD_STOP_METER_INVALID',
          `${meterName}:HARD_STOP_METER_INVALID`
        )
      };
    }
    if (!meter.verified) {
      return {
        error: deny(
          'BUDGET_UNKNOWN',
          'HARD_STOP_METER_UNVERIFIED',
          `${meterName}:HARD_STOP_METER_UNVERIFIED`
        )
      };
    }
    if (meter.overageAllowed) {
      return {
        error: deny(
          'BUDGET_UNKNOWN',
          'PAID_OVERAGE_ALLOWED',
          `${meterName}:PAID_OVERAGE_ALLOWED`
        )
      };
    }
    if (meter.overageLimitUsdCents !== 0) {
      return {
        error: deny(
          'BUDGET_UNKNOWN',
          'OVERAGE_LIMIT_NONZERO',
          `${meterName}:OVERAGE_LIMIT_NONZERO`
        )
      };
    }
  }
  return {
    error: null,
    billingSummary: Object.freeze({
      authenticatedBillingCheck: true,
      observedAtMs: billingHardStop.observedAtMs,
      aiCreditUsdCents: AI_CREDIT_USD_CENTS,
      ghAwCapsSoftOnlyAcknowledged,
      metersVerified: BILLING_METERS,
      overageLimitUsdCents: 0,
      overageAllowed: false
    })
  };
}

function evaluateSmokeReceipt(smokeReceipt, repositoryVisibility, nowMs, maxReceiptAgeMs) {
  if (!plainObject(smokeReceipt, SMOKE_KEYS) ||
      !hasRequiredKeys(smokeReceipt, REQUIRED_SMOKE_BASE_KEYS) ||
      typeof smokeReceipt.harness !== 'string' ||
      typeof smokeReceipt.actor !== 'string' ||
      smokeReceipt.actor.length === 0 ||
      !nonneg(smokeReceipt.observedAtMs) ||
      typeof smokeReceipt.includedQuotaAttributed !== 'boolean') {
    return {error: deny('EVIDENCE_UNKNOWN', 'SMOKE_RECEIPT_INVALID')};
  }
  if (!SUPPORTED_SMOKE_HARNESSES.includes(smokeReceipt.harness)) {
    return {error: deny('PROVIDER_FORBIDDEN', 'UNSUPPORTED_SMOKE_HARNESS')};
  }
  if (smokeReceipt.harness === 'copilot-cloud-automation' &&
      !AUTOMATION_ALLOWED_VISIBILITIES.includes(repositoryVisibility)) {
    return {error: deny('CAPACITY_UNVERIFIED', 'AUTOMATIONS_REQUIRE_PRIVATE_REPO')};
  }
  let runner = null;
  if (Object.hasOwn(smokeReceipt, 'runner')) {
    if (typeof smokeReceipt.runner !== 'string') {
      return {error: deny('EVIDENCE_UNKNOWN', 'SMOKE_RECEIPT_INVALID')};
    }
    if (!SUPPORTED_RUNNERS.includes(smokeReceipt.runner)) {
      return {error: deny('PROVIDER_FORBIDDEN', 'UNSUPPORTED_SMOKE_RUNNER')};
    }
    runner = smokeReceipt.runner;
  }
  let laptopOrChatDependency = null;
  if (Object.hasOwn(smokeReceipt, 'laptopOrChatDependency')) {
    if (typeof smokeReceipt.laptopOrChatDependency !== 'boolean') {
      return {error: deny('EVIDENCE_UNKNOWN', 'SMOKE_RECEIPT_INVALID')};
    }
    if (smokeReceipt.laptopOrChatDependency) {
      return {error: deny('PROVIDER_FORBIDDEN', 'LAPTOP_OR_CHAT_DEPENDENCY_FORBIDDEN')};
    }
    laptopOrChatDependency = false;
  }
  if (!validUuid(smokeReceipt.taskId)) {
    return {error: deny('EVIDENCE_UNKNOWN', 'SMOKE_TASK_ID_INVALID')};
  }
  if (!validSessionId(smokeReceipt.sessionId)) {
    return {error: deny('EVIDENCE_UNKNOWN', 'SMOKE_SESSION_ID_INVALID')};
  }
  if (smokeReceipt.actor !== NATIVE_CLOUD_AGENT_ACTOR) {
    return {error: deny('PROVENANCE_MISMATCH', 'SMOKE_ACTOR_MISMATCH')};
  }
  if (smokeReceipt.observedAtMs > nowMs) {
    return {error: deny('STALE_EVIDENCE', 'SMOKE_TIMESTAMP_IN_FUTURE')};
  }
  if (nowMs - smokeReceipt.observedAtMs > maxReceiptAgeMs) {
    return {error: deny('STALE_QUOTA', 'STALE_SMOKE_RECEIPT')};
  }
  const linkedPullRequest = Object.hasOwn(smokeReceipt, 'linkedPullRequest')
    ? smokeReceipt.linkedPullRequest
    : null;
  const linkedRunId = Object.hasOwn(smokeReceipt, 'linkedRunId')
    ? smokeReceipt.linkedRunId
    : null;
  if ((linkedPullRequest !== null && !positive(linkedPullRequest)) ||
      (linkedRunId !== null && !positive(linkedRunId))) {
    return {error: deny('EVIDENCE_UNKNOWN', 'SMOKE_LINKED_REFERENCE_INVALID')};
  }
  if (!Object.hasOwn(smokeReceipt, 'accountingSource') ||
      smokeReceipt.accountingSource !== 'verified') {
    return {error: deny('BUDGET_UNKNOWN', 'ACCOUNTING_ESTIMATED_OR_MISSING')};
  }
  if (Object.hasOwn(smokeReceipt, 'isEstimated') && smokeReceipt.isEstimated !== false) {
    return {error: deny('BUDGET_UNKNOWN', 'ACCOUNTING_ESTIMATED_OR_MISSING')};
  }
  let aiCreditsUsed = null;
  let includedAiCreditsUsdCents = null;
  if (Object.hasOwn(smokeReceipt, 'aiCreditsUsed')) {
    includedAiCreditsUsdCents = aiCreditsToUsdCents(smokeReceipt.aiCreditsUsed);
    if (includedAiCreditsUsdCents === null) {
      return {error: deny('BUDGET_UNKNOWN', 'ACCOUNTING_ESTIMATED_OR_MISSING')};
    }
    aiCreditsUsed = smokeReceipt.aiCreditsUsed;
  }
  let premiumRequestsUsed = null;
  if (Object.hasOwn(smokeReceipt, 'premiumRequestsUsed')) {
    if (!boundedCount(smokeReceipt.premiumRequestsUsed)) {
      return {error: deny('BUDGET_UNKNOWN', 'ACCOUNTING_ESTIMATED_OR_MISSING')};
    }
    premiumRequestsUsed = smokeReceipt.premiumRequestsUsed;
  }
  if (!Number.isSafeInteger(smokeReceipt.incrementalBilledUsdCents)) {
    return {error: deny('BUDGET_UNKNOWN', 'ACCOUNTING_ESTIMATED_OR_MISSING')};
  }
  if (!smokeReceipt.includedQuotaAttributed) {
    return {error: deny('BUDGET_UNKNOWN', 'INCLUDED_QUOTA_NOT_ATTRIBUTED')};
  }
  if (smokeReceipt.incrementalBilledUsdCents !== 0) {
    return {error: deny('BUDGET_UNKNOWN', 'INCREMENTAL_SPEND_NONZERO')};
  }
  return {
    error: null,
    smokeSummary: Object.freeze({
      harness: smokeReceipt.harness,
      runner,
      laptopOrChatDependency,
      taskId: smokeReceipt.taskId.toLowerCase(),
      sessionId: smokeReceipt.sessionId,
      actor: NATIVE_CLOUD_AGENT_ACTOR,
      observedAtMs: smokeReceipt.observedAtMs,
      includedQuotaAttributed: true,
      incrementalBilledUsdCents: 0,
      accountingSource: 'verified',
      aiCreditsUsed,
      includedAiCreditsUsdCents,
      premiumRequestsUsed,
      linkedPullRequest,
      linkedRunId
    })
  };
}

/**
 * Deterministically validates Issue #105's slimmed 2-step exit contract in
 * read-only shadow mode (`shadow: true`, `liveActivation: false`).
 */
export function verifyBillingHardStopAndSmokeReceipt(input, options) {
  const resolvedOptions = resolveOptions(options);
  if (!resolvedOptions.ok) {
    return deny('INVALID_POLICY', 'VERIFIER_OPTIONS_INVALID');
  }
  if (!plainObject(input, TOP_LEVEL_KEYS) || !Object.hasOwn(input, 'stop') ||
      typeof input.stop !== 'boolean') {
    return deny('EVIDENCE_UNKNOWN', 'RECEIPT_INPUT_INVALID');
  }
  if (input.stop) {
    return deny('STOPPED', 'STOP_SWITCH_ACTIVE');
  }
  if (Object.hasOwn(input, 'schemaVersion') &&
      input.schemaVersion !== BILLING_SMOKE_RECEIPT_SCHEMA_VERSION) {
    return deny('EVIDENCE_UNKNOWN', 'UNSUPPORTED_RECEIPT_SCHEMA_VERSION');
  }
  if (!hasRequiredKeys(input, REQUIRED_TOP_LEVEL_KEYS)) {
    return deny('EVIDENCE_UNKNOWN', 'RECEIPT_INPUT_INVALID');
  }
  if (typeof input.retiredDiyWorkflowAbsent !== 'boolean' ||
      typeof input.zeroPersonalPatSecretsVerified !== 'boolean') {
    return deny('EVIDENCE_UNKNOWN', 'HYGIENE_EVIDENCE_INVALID');
  }
  let customPilotEnvironmentAbsent = null;
  if (Object.hasOwn(input, 'customPilotEnvironmentAbsent')) {
    if (typeof input.customPilotEnvironmentAbsent !== 'boolean') {
      return deny('EVIDENCE_UNKNOWN', 'HYGIENE_EVIDENCE_INVALID');
    }
    if (!input.customPilotEnvironmentAbsent) {
      return deny('PROVIDER_FORBIDDEN', 'CUSTOM_PILOT_ENVIRONMENT_FORBIDDEN');
    }
    customPilotEnvironmentAbsent = true;
  }
  if (!input.retiredDiyWorkflowAbsent) {
    return deny('PROVIDER_FORBIDDEN', 'RETIRED_DIY_WORKFLOW_PRESENT');
  }
  if (!input.zeroPersonalPatSecretsVerified) {
    return deny('PROVIDER_FORBIDDEN', 'PERSONAL_PAT_SECRETS_FORBIDDEN');
  }
  if (!validRepositorySlug(input.repository) || !positive(input.repositoryId)) {
    return deny('INVALID_IDENTITY', 'REPOSITORY_IDENTITY_INVALID');
  }
  if (input.repository !== resolvedOptions.expectedRepository ||
      input.repositoryId !== resolvedOptions.expectedRepositoryId) {
    return deny('PROVENANCE_MISMATCH', 'REPOSITORY_SCOPE_MISMATCH');
  }
  const hasInputNow = Object.hasOwn(input, 'nowMs');
  if (!REPOSITORY_VISIBILITIES.includes(input.repositoryVisibility) ||
      (hasInputNow && !nonneg(input.nowMs)) ||
      (!hasInputNow && resolvedOptions.nowMs === null)) {
    return deny('EVIDENCE_UNKNOWN', 'REPOSITORY_OR_CLOCK_INVALID');
  }
  if (resolvedOptions.nowMs !== null && hasInputNow && input.nowMs > resolvedOptions.nowMs) {
    return deny('STALE_EVIDENCE', 'RECEIPT_TIMESTAMP_IN_FUTURE');
  }
  const effectiveNowMs = resolvedOptions.nowMs !== null ? resolvedOptions.nowMs : input.nowMs;
  let maxReceiptAgeMs = DEFAULT_MAX_RECEIPT_AGE_MS;
  if (Object.hasOwn(input, 'maxReceiptAgeMs')) {
    if (!positive(input.maxReceiptAgeMs) || input.maxReceiptAgeMs > MAX_ALLOWED_RECEIPT_AGE_MS) {
      return deny('INVALID_POLICY', 'MAX_RECEIPT_AGE_INVALID');
    }
    maxReceiptAgeMs = input.maxReceiptAgeMs;
  }

  const billingCheck = evaluateBillingHardStop(
    input.billingHardStop,
    effectiveNowMs,
    maxReceiptAgeMs
  );
  if (billingCheck.error) return billingCheck.error;

  const smokeCheck = evaluateSmokeReceipt(
    input.smokeReceipt,
    input.repositoryVisibility,
    effectiveNowMs,
    maxReceiptAgeMs
  );
  if (smokeCheck.error) return smokeCheck.error;

  return Object.freeze({
    schemaVersion: BILLING_SMOKE_RECEIPT_SCHEMA_VERSION,
    shadow: true,
    liveActivation: false,
    autonomousExitAccepted: false,
    verified: true,
    hardStopBillingVerified: true,
    reason: 'SHADOW_ELIGIBLE',
    verificationCode: 'BILLING_HARD_STOP_AND_SMOKE_VERIFIED',
    repository: input.repository,
    repositoryId: input.repositoryId,
    repositoryVisibility: input.repositoryVisibility,
    guardrails: Object.freeze({
      retiredDiyWorkflowAbsent: true,
      zeroPersonalPatSecretsVerified: true,
      customPilotEnvironmentAbsent
    }),
    billingHardStop: billingCheck.billingSummary,
    smokeReceipt: smokeCheck.smokeSummary
  });
}
