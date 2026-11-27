import {types} from 'node:util';

export const AI_CREDIT_USD_CENTS = 1;
export const PINNED_COPILOT_SDK_VERSION = '2.0.3';
export const DEFAULT_MAX_QUOTA_AGE_MS = 60_000;
export const MAX_ALLOWED_QUOTA_AGE_MS = 300_000;
export const MAX_LEASE_TTL_MS = 3_600_000;
export const MAX_CREDIT_COUNT = 1_000_000_000;
export const WORKER_GOAL_MAX = 12;

export const WORKER_LADDER = Object.freeze([1, 2, 4, 8, 10, 12]);
export const SUPPORTED_HARNESSES = Object.freeze([
  'copilot-cloud-agent',
  'copilot-cloud-automation',
  'copilot-sdk'
]);
export const SUPPORTED_RUNNERS = Object.freeze(['github-hosted', 'cloud-sandbox']);
export const REPOSITORY_VISIBILITIES = Object.freeze(['public', 'private', 'internal']);
export const AUTOMATION_ALLOWED_VISIBILITIES = Object.freeze(['private', 'internal']);
export const BILLING_METERS = Object.freeze([
  'aiCredits',
  'copilotPremiumRequests',
  'cloudSandboxesAndActions'
]);

const TOP_LEVEL_KEYS = new Set([
  'stop',
  'repositoryId',
  'approvedRepositoryId',
  'repositoryVisibility',
  'personalPatInActionsSecrets',
  'nowMs',
  'sdkVersion',
  'model',
  'harness',
  'billingEntitlement',
  'runner',
  'workerPool',
  'candidate'
]);
const MODEL_KEYS = new Set(['id', 'allowlist', 'verifiedAvailable', 'provider']);
const HARNESS_KEYS = new Set(['kind', 'verified', 'sdkVersion', 'agentLogin']);
const RUNNER_KEYS = new Set(['kind', 'verified', 'ephemeral', 'isolated']);
const BILLING_KEYS = new Set([
  'entitlementVerified',
  'includedOnly',
  'incrementalBilledUsdCents',
  'maxQuotaAgeMs',
  'hardStopObservedAtMs',
  'meters',
  'accounting',
  'ghAwCaps'
]);
const METER_SET = new Set(BILLING_METERS);
const METER_ITEM_KEYS = new Set(['verified', 'paidOverageEnabled', 'overageHardStopUsdCents']);
const ACCOUNTING_KEYS = new Set([
  'accountingSource',
  'isEstimated',
  'observedAtMs',
  'remainingIncludedAiCredits',
  'remainingIncludedPremiumRequests',
  'dailyAiCreditsUsed',
  'runAiCreditsRequired',
  'premiumRequestsRequired'
]);
const GH_AW_CAP_KEYS = new Set(['maxAiCredits', 'maxDailyAiCredits']);
const WORKER_POOL_KEYS = new Set([
  'requestedWorkers',
  'verifiedPriorWorkerTier',
  'repoConcurrencyCap',
  'verifiedWorkerCeiling',
  'remainingIncludedSlots',
  'reservations'
]);
const RESERVATION_KEYS = new Set([
  'reservationId',
  'issue',
  'pr',
  'lane',
  'paths',
  'leaseGeneration',
  'expiresAtMs'
]);
const CANDIDATE_KEYS = new Set([
  'issue',
  'pr',
  'lane',
  'paths',
  'leaseGeneration',
  'leaseExpiresAtMs'
]);

const nonneg = n => Number.isSafeInteger(n) && n >= 0;
const positive = n => nonneg(n) && n > 0;
const boundedCount = n => nonneg(n) && n <= MAX_CREDIT_COUNT;
const validSlug = s => typeof s === 'string' && /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(s);
const validLane = s => typeof s === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(s);
const validReservationId = s => typeof s === 'string' && /^[a-zA-Z0-9._:-]{1,120}$/.test(s);
const validRelativePath = p => typeof p === 'string' && p.length > 0 && p.length <= 200 &&
  !p.startsWith('/') && !p.includes('\\') &&
  !p.split('/').some(part => !part || part === '.' || part === '..');
const pathsOverlap = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

function ownEnumerableData(obj, key) {
  const descriptor = Object.getOwnPropertyDescriptor(obj, key);
  return descriptor !== undefined && descriptor.enumerable === true && Object.hasOwn(descriptor, 'value');
}

function plainObject(v, allowedKeys) {
  if (v === null || typeof v !== 'object' || types.isProxy(v) || Array.isArray(v) ||
      Object.getPrototypeOf(v) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(v);
  if (keys.length > 64) return false;
  return keys.every(key => typeof key === 'string' && allowedKeys.has(key) && ownEnumerableData(v, key));
}

function exactObject(v, allowedKeys) {
  return plainObject(v, allowedKeys) && Reflect.ownKeys(v).length === allowedKeys.size;
}

function denseArray(v, maxLen = 250) {
  if (v === null || typeof v !== 'object' || types.isProxy(v) || !Array.isArray(v) ||
      Object.getPrototypeOf(v) !== Array.prototype || v.length > maxLen ||
      Reflect.ownKeys(v).length !== v.length + 1) return false;
  for (let i = 0; i < v.length; i++) {
    if (!ownEnumerableData(v, i)) return false;
  }
  return true;
}

function validPathList(paths) {
  return denseArray(paths, 64) && paths.length > 0 &&
    paths.every(validRelativePath) && new Set(paths).size === paths.length;
}

function matchesPinnedSdkVersion(rawVersion) {
  if (typeof rawVersion !== 'string') return false;
  const match = /^v?(\d+\.\d+\.\d+)$/.exec(rawVersion);
  return match !== null && match[1] === PINNED_COPILOT_SDK_VERSION;
}

export function aiCreditsToUsdCents(aiCredits) {
  return boundedCount(aiCredits) ? aiCredits * AI_CREDIT_USD_CENTS : null;
}

function deny(reason, admissionCode, actualWorkerMax = 0, detail = admissionCode) {
  return Object.freeze({
    shadow: true,
    liveDispatch: false,
    admitted: false,
    state: 'blocked',
    reason,
    admissionCode,
    detail,
    actualWorkerMax,
    workerShortfallFrom12: Math.max(0, WORKER_GOAL_MAX - actualWorkerMax)
  });
}

function evaluateRunnerCapability(runner) {
  if (!exactObject(runner, RUNNER_KEYS) || typeof runner.kind !== 'string' ||
      typeof runner.verified !== 'boolean' || typeof runner.ephemeral !== 'boolean' ||
      typeof runner.isolated !== 'boolean') {
    return deny('EVIDENCE_UNKNOWN', 'RUNNER_CAPABILITY_INVALID');
  }
  if (!SUPPORTED_RUNNERS.includes(runner.kind)) {
    return deny('PROVIDER_FORBIDDEN', 'UNSUPPORTED_OPERATIONAL_RUNNER');
  }
  if (!runner.verified || !runner.ephemeral || !runner.isolated) {
    return deny('CAPACITY_UNVERIFIED', 'RUNNER_ISOLATION_UNVERIFIED');
  }
  return null;
}

function evaluateHarnessCapability(harness, repositoryVisibility, topLevelSdkVersion) {
  if (!plainObject(harness, HARNESS_KEYS) || typeof harness.kind !== 'string' ||
      typeof harness.verified !== 'boolean') {
    return deny('EVIDENCE_UNKNOWN', 'HARNESS_CAPABILITY_INVALID');
  }
  if (!SUPPORTED_HARNESSES.includes(harness.kind)) {
    return deny('PROVIDER_FORBIDDEN', 'UNSUPPORTED_HARNESS');
  }
  if (!harness.verified) {
    return deny('CAPACITY_UNVERIFIED', 'HARNESS_UNVERIFIED');
  }
  if (Object.hasOwn(harness, 'agentLogin')) {
    if (harness.kind !== 'copilot-cloud-agent' || harness.agentLogin !== 'copilot-swe-agent[bot]') {
      return deny('PROVENANCE_MISMATCH', 'AGENT_IDENTITY_MISMATCH');
    }
  }
  if (harness.kind === 'copilot-cloud-automation' &&
      !AUTOMATION_ALLOWED_VISIBILITIES.includes(repositoryVisibility)) {
    return deny('CAPACITY_UNVERIFIED', 'AUTOMATIONS_REQUIRE_PRIVATE_REPO', 0, 'AUTOMATIONS_REQUIRE_PRIVATE_REPO');
  }
  const hasHarnessVer = Object.hasOwn(harness, 'sdkVersion');
  const hasTopVer = topLevelSdkVersion !== undefined;
  if (harness.kind === 'copilot-sdk') {
    if (hasHarnessVer && hasTopVer && harness.sdkVersion !== topLevelSdkVersion) {
      return deny('CAPACITY_UNVERIFIED', 'SDK_VERSION_MISMATCH');
    }
    const effectiveSdkVersion = hasHarnessVer ? harness.sdkVersion : topLevelSdkVersion;
    if (!matchesPinnedSdkVersion(effectiveSdkVersion)) {
      return deny('CAPACITY_UNVERIFIED', 'SDK_VERSION_MISMATCH', 0, 'COPILOT_SDK_REQUIRES_2_0_3');
    }
  } else if (hasHarnessVer || hasTopVer) {
    return deny('EVIDENCE_UNKNOWN', 'UNEXPECTED_SDK_VERSION');
  }
  return null;
}

function evaluateModelCapability(model) {
  if (!plainObject(model, MODEL_KEYS) || !validSlug(model.id) ||
      !denseArray(model.allowlist, 64) || model.allowlist.length === 0 ||
      !model.allowlist.every(validSlug) || new Set(model.allowlist).size !== model.allowlist.length ||
      typeof model.verifiedAvailable !== 'boolean') {
    return deny('EVIDENCE_UNKNOWN', 'MODEL_CAPABILITY_INVALID');
  }
  if (Object.hasOwn(model, 'provider')) {
    if (!validSlug(model.provider)) return deny('EVIDENCE_UNKNOWN', 'MODEL_CAPABILITY_INVALID');
    if (model.provider.toLowerCase() === 'github-models') {
      return deny('PROVIDER_FORBIDDEN', 'RETIRED_PROVIDER_FORBIDDEN');
    }
  }
  if (!model.allowlist.includes(model.id)) {
    return deny('POLICY_UNKNOWN', 'MODEL_NOT_ALLOWLISTED');
  }
  if (!model.verifiedAvailable) {
    return deny('CAPACITY_UNVERIFIED', 'MODEL_AVAILABILITY_UNVERIFIED');
  }
  return null;
}

function evaluateBillingAndCredits(billing, nowMs) {
  if (billing === undefined || billing === null) {
    return {error: deny('BUDGET_UNKNOWN', 'ACCOUNTING_ESTIMATED_OR_MISSING')};
  }
  if (!plainObject(billing, BILLING_KEYS)) {
    return {error: deny('EVIDENCE_UNKNOWN', 'BILLING_CAPABILITY_INVALID')};
  }
  let maxQuotaAgeMs = DEFAULT_MAX_QUOTA_AGE_MS;
  if (Object.hasOwn(billing, 'maxQuotaAgeMs')) {
    if (!positive(billing.maxQuotaAgeMs) || billing.maxQuotaAgeMs > MAX_ALLOWED_QUOTA_AGE_MS) {
      return {error: deny('BUDGET_UNKNOWN', 'ACCOUNTING_ESTIMATED_OR_MISSING')};
    }
    maxQuotaAgeMs = billing.maxQuotaAgeMs;
  }
  const {accounting} = billing;
  if (!exactObject(accounting, ACCOUNTING_KEYS) ||
      accounting.accountingSource !== 'verified' ||
      accounting.isEstimated !== false ||
      !nonneg(accounting.observedAtMs) ||
      nowMs < accounting.observedAtMs ||
      nowMs - accounting.observedAtMs > maxQuotaAgeMs ||
      !boundedCount(accounting.remainingIncludedAiCredits) ||
      !boundedCount(accounting.remainingIncludedPremiumRequests) ||
      !boundedCount(accounting.dailyAiCreditsUsed) ||
      !positive(accounting.runAiCreditsRequired) ||
      accounting.runAiCreditsRequired > MAX_CREDIT_COUNT ||
      !boundedCount(accounting.premiumRequestsRequired)) {
    return {error: deny('BUDGET_UNKNOWN', 'ACCOUNTING_ESTIMATED_OR_MISSING')};
  }
  if (billing.entitlementVerified !== true || billing.includedOnly !== true) {
    return {error: deny('BUDGET_UNKNOWN', 'BILLING_ENTITLEMENT_UNVERIFIED')};
  }
  if (Object.hasOwn(billing, 'hardStopObservedAtMs')) {
    if (!nonneg(billing.hardStopObservedAtMs) || nowMs < billing.hardStopObservedAtMs ||
        nowMs - billing.hardStopObservedAtMs > maxQuotaAgeMs) {
      return {error: deny('STALE_QUOTA', 'STALE_HARD_STOP_RECEIPT')};
    }
  }
  if (!Number.isSafeInteger(billing.incrementalBilledUsdCents) || billing.incrementalBilledUsdCents !== 0) {
    return {error: deny('BUDGET_UNKNOWN', 'INCREMENTAL_SPEND_NONZERO')};
  }
  if (!exactObject(billing.meters, METER_SET)) {
    return {error: deny('BUDGET_UNKNOWN', 'HARD_STOP_UNVERIFIED')};
  }
  for (const meterName of BILLING_METERS) {
    const meter = billing.meters[meterName];
    if (!exactObject(meter, METER_ITEM_KEYS) || meter.verified !== true ||
        typeof meter.paidOverageEnabled !== 'boolean' ||
        !Number.isSafeInteger(meter.overageHardStopUsdCents)) {
      return {error: deny('BUDGET_UNKNOWN', 'HARD_STOP_UNVERIFIED')};
    }
    if (meter.paidOverageEnabled !== false || meter.overageHardStopUsdCents !== 0) {
      return {error: deny('BUDGET_UNKNOWN', 'PAID_OVERAGE_NOT_HARD_STOPPED')};
    }
  }
  const {ghAwCaps} = billing;
  if (!exactObject(ghAwCaps, GH_AW_CAP_KEYS) ||
      !positive(ghAwCaps.maxAiCredits) || ghAwCaps.maxAiCredits > MAX_CREDIT_COUNT ||
      !positive(ghAwCaps.maxDailyAiCredits) || ghAwCaps.maxDailyAiCredits > MAX_CREDIT_COUNT ||
      ghAwCaps.maxDailyAiCredits < ghAwCaps.maxAiCredits) {
    return {error: deny('INVALID_POLICY', 'GH_AW_SOFT_CAPS_INVALID')};
  }
  if (accounting.runAiCreditsRequired > ghAwCaps.maxAiCredits) {
    return {error: deny('BUDGET_OR_CONCURRENCY', 'GH_AW_MAX_AI_CREDITS_EXCEEDED')};
  }
  if (accounting.dailyAiCreditsUsed + accounting.runAiCreditsRequired > ghAwCaps.maxDailyAiCredits) {
    return {error: deny('CAPACITY_EXHAUSTED', 'GH_AW_DAILY_AI_CREDITS_EXCEEDED')};
  }
  if (accounting.runAiCreditsRequired > accounting.remainingIncludedAiCredits) {
    return {error: deny('CAPACITY_EXHAUSTED', 'INCLUDED_AI_CREDITS_EXHAUSTED')};
  }
  if (accounting.premiumRequestsRequired > accounting.remainingIncludedPremiumRequests) {
    return {error: deny('CAPACITY_EXHAUSTED', 'INCLUDED_PREMIUM_REQUESTS_EXHAUSTED')};
  }
  return {error: null, accounting, ghAwCaps};
}

function validOptionalPr(obj) {
  return !Object.hasOwn(obj, 'pr') || obj.pr === null || positive(obj.pr);
}

function evaluateCandidateAndPool(candidate, workerPool, nowMs, accounting, ghAwCaps) {
  if (!plainObject(candidate, CANDIDATE_KEYS) || !positive(candidate.issue) ||
      !validOptionalPr(candidate) || !validLane(candidate.lane) ||
      !validPathList(candidate.paths) || !positive(candidate.leaseGeneration) ||
      !positive(candidate.leaseExpiresAtMs)) {
    return {error: deny('INVALID_CANDIDATE', 'CANDIDATE_INVALID')};
  }
  if (candidate.leaseExpiresAtMs <= nowMs || candidate.leaseExpiresAtMs - nowMs > MAX_LEASE_TTL_MS) {
    return {error: deny('LEASE_OR_CLOCK_UNKNOWN', 'CANDIDATE_LEASE_EXPIRED_OR_UNBOUNDED')};
  }
  if (!exactObject(workerPool, WORKER_POOL_KEYS) ||
      !Number.isSafeInteger(workerPool.requestedWorkers) ||
      !nonneg(workerPool.verifiedPriorWorkerTier) ||
      !positive(workerPool.repoConcurrencyCap) || workerPool.repoConcurrencyCap > 1000 ||
      !positive(workerPool.verifiedWorkerCeiling) || workerPool.verifiedWorkerCeiling > 1000 ||
      !nonneg(workerPool.remainingIncludedSlots) || workerPool.remainingIncludedSlots > 1000 ||
      !denseArray(workerPool.reservations, 250)) {
    return {error: deny('WORK_RESERVATION_UNKNOWN', 'WORKER_POOL_OR_RESERVATIONS_INVALID')};
  }
  const seenIds = new Set();
  const activeIssues = new Set();
  const activePrs = new Set();
  const activeLanes = new Set();
  const activePaths = [];
  let activeReservationCount = 0;

  for (let i = 0; i < workerPool.reservations.length; i++) {
    const r = workerPool.reservations[i];
    if (!plainObject(r, RESERVATION_KEYS) || !validReservationId(r.reservationId) ||
        seenIds.has(r.reservationId) || !positive(r.issue) || !validOptionalPr(r) ||
        !validLane(r.lane) || !validPathList(r.paths) ||
        !positive(r.leaseGeneration) || !nonneg(r.expiresAtMs)) {
      return {error: deny('WORK_RESERVATION_UNKNOWN', 'WORKER_POOL_OR_RESERVATIONS_INVALID')};
    }
    seenIds.add(r.reservationId);
    if (r.expiresAtMs <= nowMs) {
      if (r.issue === candidate.issue && candidate.leaseGeneration <= r.leaseGeneration) {
        return {error: deny('STALE_CHECKPOINT', 'STALE_FENCED_GENERATION')};
      }
      continue;
    }
    const rPr = Object.hasOwn(r, 'pr') ? r.pr : null;
    if (activeIssues.has(r.issue) || (rPr !== null && activePrs.has(rPr)) ||
        activeLanes.has(r.lane) || r.paths.some(p => activePaths.some(ap => pathsOverlap(p, ap)))) {
      return {error: deny('LANE_OR_PATH_RESERVED', 'ACTIVE_RESERVATION_CONFLICT')};
    }
    activeReservationCount++;
    activeIssues.add(r.issue);
    if (rPr !== null) activePrs.add(rPr);
    activeLanes.add(r.lane);
    activePaths.push(...r.paths);
  }

  const grossCeiling = Math.min(
    workerPool.repoConcurrencyCap,
    workerPool.verifiedWorkerCeiling,
    workerPool.remainingIncludedSlots
  );
  const netAvailableWorkers = Math.max(0, grossCeiling - activeReservationCount);
  const actualWorkerMax = WORKER_LADDER.filter(step => step <= netAvailableWorkers).at(-1) ?? 0;
  const workerShortfallFrom12 = Math.max(0, WORKER_GOAL_MAX - actualWorkerMax);

  const candidatePr = Object.hasOwn(candidate, 'pr') ? candidate.pr : null;
  if (activeIssues.has(candidate.issue)) {
    return {error: deny('LANE_OR_PATH_RESERVED', 'DUPLICATE_ISSUE_RESERVATION', actualWorkerMax)};
  }
  if (candidatePr !== null && activePrs.has(candidatePr)) {
    return {error: deny('LANE_OR_PATH_RESERVED', 'DUPLICATE_PR_RESERVATION', actualWorkerMax)};
  }
  if (activeLanes.has(candidate.lane)) {
    return {error: deny('LANE_OR_PATH_RESERVED', 'DUPLICATE_LANE_RESERVATION', actualWorkerMax)};
  }
  if (candidate.paths.some(p => activePaths.some(ap => pathsOverlap(p, ap)))) {
    return {error: deny('LANE_OR_PATH_RESERVED', 'OVERLAPPING_PATH_RESERVATION', actualWorkerMax)};
  }

  const tierIndex = WORKER_LADDER.indexOf(workerPool.requestedWorkers);
  if (tierIndex === -1) {
    return {error: deny('POLICY_UNKNOWN', 'WORKER_LADDER_INVALID_TIER', actualWorkerMax)};
  }
  const prevTier = tierIndex > 0 ? WORKER_LADDER[tierIndex - 1] : 0;
  if (workerPool.verifiedPriorWorkerTier !== workerPool.requestedWorkers &&
      workerPool.verifiedPriorWorkerTier !== prevTier) {
    return {error: deny('POLICY_UNKNOWN', 'WORKER_LADDER_STEP_SKIPPED', actualWorkerMax)};
  }
  if (actualWorkerMax === 0) {
    return {error: deny('CAPACITY_EXHAUSTED', 'WORKER_SLOTS_EXHAUSTED', 0)};
  }
  if (workerPool.requestedWorkers > Math.min(workerPool.repoConcurrencyCap, workerPool.verifiedWorkerCeiling)) {
    return {error: deny('CAPACITY_UNVERIFIED', 'WORKER_LADDER_EXCEEDS_VERIFIED_CEILING', actualWorkerMax)};
  }
  if (workerPool.requestedWorkers > actualWorkerMax) {
    return {error: deny('CAPACITY_EXHAUSTED', 'WORKER_LADDER_CAPACITY_EXCEEDED', actualWorkerMax)};
  }

  const totalBatchAiCredits = workerPool.requestedWorkers * accounting.runAiCreditsRequired;
  const totalBatchPremiumRequests = workerPool.requestedWorkers * accounting.premiumRequestsRequired;
  if (accounting.dailyAiCreditsUsed + totalBatchAiCredits > ghAwCaps.maxDailyAiCredits) {
    return {error: deny('CAPACITY_EXHAUSTED', 'GH_AW_DAILY_AI_CREDITS_EXCEEDED', actualWorkerMax)};
  }
  if (totalBatchAiCredits > accounting.remainingIncludedAiCredits) {
    return {error: deny('CAPACITY_EXHAUSTED', 'INCLUDED_AI_CREDITS_EXHAUSTED', actualWorkerMax)};
  }
  if (totalBatchPremiumRequests > accounting.remainingIncludedPremiumRequests) {
    return {error: deny('CAPACITY_EXHAUSTED', 'INCLUDED_PREMIUM_REQUESTS_EXHAUSTED', actualWorkerMax)};
  }

  return {
    error: null,
    grossCeiling,
    activeReservationCount,
    netAvailableWorkers,
    actualWorkerMax,
    workerShortfallFrom12,
    totalBatchAiCredits,
    totalBatchPremiumRequests
  };
}

/**
 * Deterministic, read-only, fail-closed admission & capability evaluator for
 * GitHub Copilot Cloud Agent, Cloud Automations, and @microsoft/copilot-sdk v2.0.3.
 */
export function evaluateCloudAgentAdmission(input) {
  if (!plainObject(input, TOP_LEVEL_KEYS) || !Object.hasOwn(input, 'stop') ||
      typeof input.stop !== 'boolean') {
    return deny('EVIDENCE_UNKNOWN', 'ADMISSION_INPUT_INVALID');
  }
  if (input.stop) {
    return deny('STOPPED', 'STOP_SWITCH_ACTIVE');
  }
  if (input.personalPatInActionsSecrets !== false) {
    return deny('PROVIDER_FORBIDDEN', 'PERSONAL_PAT_FORBIDDEN');
  }
  if (!positive(input.repositoryId) || !positive(input.approvedRepositoryId)) {
    return deny('INVALID_IDENTITY', 'REPOSITORY_IDENTITY_INVALID');
  }
  if (input.repositoryId !== input.approvedRepositoryId) {
    return deny('PROVENANCE_MISMATCH', 'REPOSITORY_SCOPE_MISMATCH');
  }
  if (!REPOSITORY_VISIBILITIES.includes(input.repositoryVisibility) || !nonneg(input.nowMs)) {
    return deny('EVIDENCE_UNKNOWN', 'REPOSITORY_OR_CLOCK_INVALID');
  }

  const runnerDenial = evaluateRunnerCapability(input.runner);
  if (runnerDenial) return runnerDenial;

  const topLevelSdkVersion = Object.hasOwn(input, 'sdkVersion') ? input.sdkVersion : undefined;
  const harnessDenial = evaluateHarnessCapability(input.harness, input.repositoryVisibility, topLevelSdkVersion);
  if (harnessDenial) return harnessDenial;

  const modelDenial = evaluateModelCapability(input.model);
  if (modelDenial) return modelDenial;

  const billingCheck = evaluateBillingAndCredits(input.billingEntitlement, input.nowMs);
  if (billingCheck.error) return billingCheck.error;

  const poolCheck = evaluateCandidateAndPool(
    input.candidate,
    input.workerPool,
    input.nowMs,
    billingCheck.accounting,
    billingCheck.ghAwCaps
  );
  if (poolCheck.error) return poolCheck.error;

  const {accounting} = billingCheck;
  const runBudgetUsdCents = aiCreditsToUsdCents(accounting.runAiCreditsRequired);
  const totalBatchUsdCents = aiCreditsToUsdCents(poolCheck.totalBatchAiCredits);
  const remainingIncludedUsdCents = aiCreditsToUsdCents(accounting.remainingIncludedAiCredits);

  return Object.freeze({
    shadow: true,
    liveDispatch: false,
    admitted: true,
    reason: 'SHADOW_ALLOCATION',
    admissionCode: 'CLOUD_AGENT_SHADOW_ADMITTED',
    repositoryId: input.repositoryId,
    repositoryVisibility: input.repositoryVisibility,
    capabilities: Object.freeze({
      model: input.model.id,
      harness: input.harness.kind,
      sdkVersion: input.harness.kind === 'copilot-sdk' ? PINNED_COPILOT_SDK_VERSION : null,
      billingEntitlement: 'verified-included-hard-stop',
      runner: input.runner.kind
    }),
    accounting: Object.freeze({
      aiCreditUsdCents: AI_CREDIT_USD_CENTS,
      runAiCredits: accounting.runAiCreditsRequired,
      runBudgetUsdCents,
      totalBatchAiCredits: poolCheck.totalBatchAiCredits,
      totalBatchUsdCents,
      remainingIncludedAiCredits: accounting.remainingIncludedAiCredits,
      remainingIncludedUsdCents,
      remainingIncludedPremiumRequests: accounting.remainingIncludedPremiumRequests,
      incrementalBilledUsdCents: 0
    }),
    workers: Object.freeze({
      requestedWorkers: input.workerPool.requestedWorkers,
      grossWorkerCeiling: poolCheck.grossCeiling,
      activeReservations: poolCheck.activeReservationCount,
      netAvailableWorkers: poolCheck.netAvailableWorkers,
      actualWorkerMax: poolCheck.actualWorkerMax,
      workerShortfallFrom12: poolCheck.workerShortfallFrom12
    }),
    actualWorkerMax: poolCheck.actualWorkerMax,
    workerShortfallFrom12: poolCheck.workerShortfallFrom12
  });
}
