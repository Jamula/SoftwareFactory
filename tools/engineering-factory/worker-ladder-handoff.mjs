// Deterministic, metadata-only, read-only, fail-closed evaluator for Issue #7's
// 1->2->4->8->10->12 worker scaling ladder and Customer One provider-neutral
// SHA-256 checkpoint pause/resumption/handoff on included-quota exhaustion.
import {createHash, timingSafeEqual} from 'node:crypto';
import {types} from 'node:util';
import {
  EXACT_PROTECTED_CONTROL_PLANE_PATHS,
  isProtectedControlPlanePath,
  isSafeRepoRelativePath
} from './anti-rogue-audit.mjs';

export const WORKER_LADDER = Object.freeze([1, 2, 4, 8, 10, 12]);
export const WORKER_GOAL_MIN = 10;
export const WORKER_GOAL_MAX = 12;
export const CHECKPOINT_SCHEMA_VERSION = 1;
export const MAX_SERIALIZED_CHECKPOINT_BYTES = 65_536;
export const PINNED_COPILOT_SDK_VERSION = '2.0.3';
export const DEFAULT_MAX_QUOTA_AGE_MS = 60_000;
export const MAX_ALLOWED_QUOTA_AGE_MS = 300_000;
export const MAX_LEASE_TTL_MS = 3_600_000;
export const MAX_UNIT_COUNT = 1_000_000_000;
export const DEFAULT_MAX_HANDOFF_ATTEMPTS = 3;
export const MAX_ALLOWED_HANDOFF_ATTEMPTS = 5;
export const SELF_EVALUATOR_PATH = 'tools/engineering-factory/worker-ladder-handoff.mjs';
export const CONTROLLER_PROTECTED_CONTROL_PLANE_PATHS = Object.freeze([
  ...EXACT_PROTECTED_CONTROL_PLANE_PATHS,
  SELF_EVALUATOR_PATH
]);

export const SUPPORTED_PROVIDER_FAMILIES = Object.freeze([
  'github-copilot',
  'openai-codex',
  'anthropic-claude'
]);

export const PROVIDER_FAMILY_HARNESSES = Object.freeze({
  'github-copilot': Object.freeze([
    'copilot-cloud-agent',
    'copilot-cloud-automation',
    'copilot-sdk',
    'microsoft-agents-ai-ichatclient'
  ]),
  'openai-codex': Object.freeze([
    'openai-codex-action',
    'openai-agents-sdk',
    'microsoft-extensions-ai-ichatclient'
  ]),
  'anthropic-claude': Object.freeze([
    'claude-code-action',
    'claude-agent-sdk',
    'microsoft-extensions-ai-ichatclient'
  ])
});

export const SUPPORTED_RUNNERS = Object.freeze(['github-hosted', 'cloud-sandbox']);
export const REPOSITORY_VISIBILITIES = Object.freeze(['public', 'private', 'internal']);
export const AUTOMATION_ALLOWED_VISIBILITIES = Object.freeze(['private', 'internal']);

const TOP_LEVEL_KEYS = new Set([
  'stop',
  'repositoryId',
  'approvedRepositoryId',
  'repositoryVisibility',
  'personalPatInActionsSecrets',
  'paidFallbackRequested',
  'blindRetryRequested',
  'nowMs',
  'primaryProvider',
  'ladder',
  'activePeerLeases',
  'lease',
  'checkpoint',
  'handoff'
]);

const PROVIDER_KEYS = new Set([
  'providerFamily',
  'ownerAuthorized',
  'approvedRepositoryId',
  'independentAuthorizationVerified',
  'verifiedProviderWorkerCeiling',
  'model',
  'harness',
  'runner',
  'billingEntitlement'
]);
const MODEL_KEYS = new Set(['id', 'allowlist', 'verifiedAvailable', 'provider']);
const HARNESS_KEYS = new Set([
  'kind',
  'verified',
  'sdkVersion',
  'agentLogin',
  'externalTracingDisabled'
]);
const RUNNER_KEYS = new Set(['kind', 'verified', 'ephemeral', 'isolated']);
const BILLING_KEYS = new Set([
  'entitlementVerified',
  'includedOnly',
  'paidOverageEnabled',
  'overageHardStopUsdCents',
  'hardStopEnforced',
  'incrementalBilledUsdCents',
  'maxQuotaAgeMs',
  'accounting',
  'ghAwCaps'
]);
const REQUIRED_ACCOUNTING_KEYS = Object.freeze([
  'accountingSource',
  'isEstimated',
  'observedAtMs',
  'remainingIncludedUnits',
  'unitsPerWorkerRun',
  'remainingIncludedRequests',
  'requestsPerWorkerRun'
]);
const ACCOUNTING_KEYS = new Set([
  ...REQUIRED_ACCOUNTING_KEYS,
  'netOfReservationsVerified',
  'dailyUsageIncludesReservations'
]);
const GH_AW_CAP_KEYS = new Set(['maxRunUnits', 'maxDailyUnits', 'dailyUnitsUsed']);

const LADDER_KEYS = new Set([
  'currentRung',
  'verifiedPriorRung',
  'requestedRung',
  'repoConcurrencyCap',
  'logicalLaneCount',
  'observedSimultaneousWorkers',
  'duplicateDispatches',
  'unauthorizedWrites',
  'unapprovedSpendUsdCents',
  'mainHealthy',
  'qualityGatesClear',
  'throughput'
]);
const THROUGHPUT_KEYS = new Set([
  'comparabilityVerified',
  'baselineAcceptedUnits',
  'baselineWindowMs',
  'currentAcceptedUnits',
  'currentWindowMs',
  'reworkRegressed'
]);

const PEER_LEASE_KEYS = new Set([
  'leaseId',
  'issue',
  'pr',
  'lane',
  'ownedPaths',
  'leaseGeneration',
  'expiresAtMs',
  'reservedUnits',
  'reservedRequests'
]);
const LEASE_KEYS = new Set([
  'leaseId',
  'issue',
  'pr',
  'headSha',
  'lane',
  'ownedPaths',
  'workerId',
  'leaseGeneration',
  'leaseExpiresAtMs',
  'executionDeadlineMs'
]);
const CHECKPOINT_KEYS = new Set([
  'schemaVersion',
  'checkpointId',
  'providerNeutral',
  'repositoryId',
  'issue',
  'pr',
  'headSha',
  'lane',
  'ownedPaths',
  'leaseGeneration',
  'checkpointRevision',
  'createdAtMs',
  'serializedState',
  'sha256'
]);
const HANDOFF_KEYS = new Set(['mode', 'attempt', 'maxAttempts', 'targetProvider']);

const SECRET_TOKEN_RE =
  /(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-(?:ant-)?[A-Za-z0-9_-]+|AKIA[0-9A-Z]+|[Bb]earer[ \t]+\S+)|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const FORBIDDEN_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const nonneg = n => Number.isSafeInteger(n) && n >= 0;
const positive = n => nonneg(n) && n > 0;
const boundedUnits = n => nonneg(n) && n <= MAX_UNIT_COUNT;
const hex40 = s => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
const hex64 = s => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
const validSlug = s => typeof s === 'string' && /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(s);
const validLane = s => typeof s === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(s);
const validIdToken = s => typeof s === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(s);
const validWorkerId = s => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(s);
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

function touchesProtectedControlPlane(path) {
  return isProtectedControlPlanePath(path) ||
    path === SELF_EVALUATOR_PATH ||
    path === '.github' ||
    path === '.github/workflows' ||
    CONTROLLER_PROTECTED_CONTROL_PLANE_PATHS.some(prot => prot.startsWith(`${path}/`));
}

function validPathList(paths) {
  return denseArray(paths, 64) && paths.length > 0 &&
    paths.every(p => isSafeRepoRelativePath(p) && p.length <= 200) &&
    new Set(paths).size === paths.length;
}

function samePathSet(a, b) {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every(item => setA.has(item));
}

function matchesPinnedSdkVersion(rawVersion) {
  if (typeof rawVersion !== 'string') return false;
  const match = /^v?(\d+\.\d+\.\d+)$/.exec(rawVersion);
  return match !== null && match[1] === PINNED_COPILOT_SDK_VERSION;
}

function scanValidatedJsonStructure(raw) {
  let idx = 0;
  let sawSecret = false;
  const skipWs = () => {
    while (idx < raw.length &&
        (raw[idx] === ' ' || raw[idx] === '\t' || raw[idx] === '\n' || raw[idx] === '\r')) {
      idx++;
    }
  };
  const readString = () => {
    const start = idx;
    idx++;
    while (raw[idx] !== '"') {
      idx += raw[idx] === '\\' ? 2 : 1;
    }
    idx++;
    const decoded = JSON.parse(raw.slice(start, idx));
    if (SECRET_TOKEN_RE.test(decoded)) sawSecret = true;
    return decoded;
  };
  const scanValue = depth => {
    if (depth > 5) return false;
    skipWs();
    const ch = raw[idx];
    if (ch === '"') {
      readString();
      return true;
    }
    if (ch === '{') {
      idx++;
      skipWs();
      if (raw[idx] === '}') {
        idx++;
        return true;
      }
      const seenKeys = new Set();
      while (true) {
        skipWs();
        const key = readString();
        if (FORBIDDEN_JSON_KEYS.has(key) || seenKeys.has(key)) return false;
        seenKeys.add(key);
        if (seenKeys.size > 32) return false;
        skipWs();
        idx++;
        if (!scanValue(depth + 1)) return false;
        skipWs();
        if (raw[idx] === '}') {
          idx++;
          return true;
        }
        idx++;
      }
    }
    if (ch === '[') {
      idx++;
      skipWs();
      if (raw[idx] === ']') {
        idx++;
        return true;
      }
      let count = 0;
      while (true) {
        count++;
        if (count > 64 || !scanValue(depth + 1)) return false;
        skipWs();
        if (raw[idx] === ']') {
          idx++;
          return true;
        }
        idx++;
      }
    }
    const start = idx;
    while (idx < raw.length && !' \t\r\n,]}'.includes(raw[idx])) idx++;
    const lit = raw.slice(start, idx);
    if (lit === 'true' || lit === 'false' || lit === 'null') return true;
    return Number.isFinite(JSON.parse(lit));
  };
  const valid = scanValue(0);
  if (sawSecret) return 'SECRET';
  return valid ? 'OK' : 'INVALID';
}

export function computeCheckpointSha256(serializedState) {
  if (typeof serializedState !== 'string') return null;
  const byteLength = Buffer.byteLength(serializedState, 'utf8');
  if (byteLength === 0 || byteLength > MAX_SERIALIZED_CHECKPOINT_BYTES) return null;
  return createHash('sha256').update(serializedState, 'utf8').digest('hex');
}

function highestLadderRung(ceiling) {
  return WORKER_LADDER.filter(step => step <= ceiling).at(-1) ?? 0;
}

function blockedResult(reason, decisionCode, actualMaxWorkers = 0, extras = {}) {
  return Object.freeze({
    shadow: true,
    liveDispatch: false,
    admitted: false,
    state: 'blocked',
    reason,
    decisionCode,
    detail: extras.detail ?? decisionCode,
    handoffState: extras.handoffState ?? 'BLOCKED',
    paidFallbackUsed: false,
    blindRetryUsed: false,
    actualMaxWorkers,
    verifiedCapacityCeiling: extras.verifiedCapacityCeiling ?? 0,
    maxFundedRung: extras.maxFundedRung ?? 0,
    shortfallFrom12: Math.max(0, WORKER_GOAL_MAX - actualMaxWorkers),
    shortfallFrom10: Math.max(0, WORKER_GOAL_MIN - actualMaxWorkers),
    goalMet: actualMaxWorkers >= WORKER_GOAL_MIN,
    preservedLease: extras.preservedLease ?? null,
    checkpointReceipt: extras.checkpointReceipt ?? null
  });
}

function evaluateProviderContract(provider, repositoryId, repositoryVisibility, nowMs, roleLabel) {
  if (!plainObject(provider, PROVIDER_KEYS) ||
      typeof provider.providerFamily !== 'string' ||
      typeof provider.ownerAuthorized !== 'boolean' ||
      !positive(provider.approvedRepositoryId) ||
      typeof provider.independentAuthorizationVerified !== 'boolean' ||
      !positive(provider.verifiedProviderWorkerCeiling) ||
      provider.verifiedProviderWorkerCeiling > 1000) {
    return {error: blockedResult('EVIDENCE_UNKNOWN', `${roleLabel}_PROVIDER_CAPABILITY_INVALID`)};
  }
  if (provider.providerFamily.toLowerCase() === 'github-models') {
    return {error: blockedResult('PROVIDER_FORBIDDEN', 'RETIRED_PROVIDER_FORBIDDEN')};
  }
  if (!SUPPORTED_PROVIDER_FAMILIES.includes(provider.providerFamily)) {
    return {error: blockedResult('PROVIDER_FORBIDDEN', 'UNSUPPORTED_PROVIDER_FAMILY')};
  }
  if (!provider.ownerAuthorized) {
    return {error: blockedResult('STOPPED_OR_UNAUTHORIZED', `${roleLabel}_PROVIDER_UNAUTHORIZED`)};
  }
  if (provider.approvedRepositoryId !== repositoryId) {
    return {error: blockedResult('PROVENANCE_MISMATCH', `${roleLabel}_REPOSITORY_SCOPE_MISMATCH`)};
  }
  if (!provider.independentAuthorizationVerified) {
    return {error: blockedResult('TRUST_UNKNOWN', `${roleLabel}_INDEPENDENT_AUTH_UNVERIFIED`)};
  }

  const {runner, harness, model, billingEntitlement} = provider;
  if (!exactObject(runner, RUNNER_KEYS) || typeof runner.kind !== 'string' ||
      typeof runner.verified !== 'boolean' || typeof runner.ephemeral !== 'boolean' ||
      typeof runner.isolated !== 'boolean') {
    return {error: blockedResult('EVIDENCE_UNKNOWN', 'RUNNER_CAPABILITY_INVALID')};
  }
  if (!SUPPORTED_RUNNERS.includes(runner.kind)) {
    return {error: blockedResult('PROVIDER_FORBIDDEN', 'UNSUPPORTED_OPERATIONAL_RUNNER')};
  }
  if (!runner.verified || !runner.ephemeral || !runner.isolated) {
    return {error: blockedResult('CAPACITY_UNVERIFIED', 'RUNNER_ISOLATION_UNVERIFIED')};
  }

  if (!plainObject(harness, HARNESS_KEYS) || typeof harness.kind !== 'string' ||
      typeof harness.verified !== 'boolean') {
    return {error: blockedResult('EVIDENCE_UNKNOWN', 'HARNESS_CAPABILITY_INVALID')};
  }
  if (!PROVIDER_FAMILY_HARNESSES[provider.providerFamily].includes(harness.kind)) {
    return {error: blockedResult('PROVIDER_FORBIDDEN', 'UNSUPPORTED_HARNESS')};
  }
  if (!harness.verified) {
    return {error: blockedResult('CAPACITY_UNVERIFIED', 'HARNESS_UNVERIFIED')};
  }
  if (Object.hasOwn(harness, 'agentLogin') &&
      (harness.kind !== 'copilot-cloud-agent' || harness.agentLogin !== 'copilot-swe-agent[bot]')) {
    return {error: blockedResult('PROVENANCE_MISMATCH', 'AGENT_IDENTITY_MISMATCH')};
  }
  if (harness.kind === 'copilot-cloud-automation' &&
      !AUTOMATION_ALLOWED_VISIBILITIES.includes(repositoryVisibility)) {
    return {error: blockedResult('CAPACITY_UNVERIFIED', 'AUTOMATIONS_REQUIRE_PRIVATE_REPO')};
  }
  if (harness.kind === 'copilot-sdk') {
    if (!matchesPinnedSdkVersion(harness.sdkVersion)) {
      return {error: blockedResult('CAPACITY_UNVERIFIED', 'SDK_VERSION_MISMATCH')};
    }
  } else if (Object.hasOwn(harness, 'sdkVersion')) {
    return {error: blockedResult('EVIDENCE_UNKNOWN', 'UNEXPECTED_SDK_VERSION')};
  }
  if (Object.hasOwn(harness, 'externalTracingDisabled')) {
    if (typeof harness.externalTracingDisabled !== 'boolean') {
      return {error: blockedResult('EVIDENCE_UNKNOWN', 'HARNESS_CAPABILITY_INVALID')};
    }
    if (!harness.externalTracingDisabled) {
      return {error: blockedResult('PROVIDER_FORBIDDEN', 'EXTERNAL_TRACING_FORBIDDEN')};
    }
  } else if (provider.providerFamily !== 'github-copilot') {
    return {error: blockedResult('PROVIDER_FORBIDDEN', 'EXTERNAL_TRACING_FORBIDDEN')};
  }

  if (!plainObject(model, MODEL_KEYS) || !validSlug(model.id) ||
      !denseArray(model.allowlist, 64) || model.allowlist.length === 0 ||
      !model.allowlist.every(validSlug) || new Set(model.allowlist).size !== model.allowlist.length ||
      typeof model.verifiedAvailable !== 'boolean') {
    return {error: blockedResult('EVIDENCE_UNKNOWN', 'MODEL_CAPABILITY_INVALID')};
  }
  if (Object.hasOwn(model, 'provider')) {
    if (!validSlug(model.provider)) {
      return {error: blockedResult('EVIDENCE_UNKNOWN', 'MODEL_CAPABILITY_INVALID')};
    }
    if (model.provider.toLowerCase() === 'github-models') {
      return {error: blockedResult('PROVIDER_FORBIDDEN', 'RETIRED_PROVIDER_FORBIDDEN')};
    }
  }
  if (!model.allowlist.includes(model.id)) {
    return {error: blockedResult('POLICY_UNKNOWN', 'MODEL_NOT_ALLOWLISTED')};
  }
  if (!model.verifiedAvailable) {
    return {error: blockedResult('CAPACITY_UNVERIFIED', 'MODEL_AVAILABILITY_UNVERIFIED')};
  }

  if (!plainObject(billingEntitlement, BILLING_KEYS) ||
      typeof billingEntitlement.entitlementVerified !== 'boolean' ||
      typeof billingEntitlement.includedOnly !== 'boolean' ||
      typeof billingEntitlement.paidOverageEnabled !== 'boolean' ||
      !Number.isSafeInteger(billingEntitlement.overageHardStopUsdCents) ||
      typeof billingEntitlement.hardStopEnforced !== 'boolean' ||
      !Number.isSafeInteger(billingEntitlement.incrementalBilledUsdCents)) {
    return {error: blockedResult('EVIDENCE_UNKNOWN', 'BILLING_CAPABILITY_INVALID')};
  }
  if (billingEntitlement.paidOverageEnabled || billingEntitlement.overageHardStopUsdCents !== 0 ||
      !billingEntitlement.hardStopEnforced) {
    return {error: blockedResult('BUDGET_UNKNOWN', 'PAID_OVERAGE_NOT_HARD_STOPPED')};
  }
  if (!billingEntitlement.entitlementVerified || !billingEntitlement.includedOnly) {
    return {error: blockedResult('BUDGET_UNKNOWN', 'BILLING_ENTITLEMENT_UNVERIFIED')};
  }
  if (billingEntitlement.incrementalBilledUsdCents !== 0) {
    return {error: blockedResult('BUDGET_UNKNOWN', 'INCREMENTAL_SPEND_NONZERO')};
  }

  let maxQuotaAgeMs = DEFAULT_MAX_QUOTA_AGE_MS;
  if (Object.hasOwn(billingEntitlement, 'maxQuotaAgeMs')) {
    if (!positive(billingEntitlement.maxQuotaAgeMs) ||
        billingEntitlement.maxQuotaAgeMs > MAX_ALLOWED_QUOTA_AGE_MS) {
      return {error: blockedResult('BUDGET_UNKNOWN', 'ACCOUNTING_ESTIMATED_OR_MISSING')};
    }
    maxQuotaAgeMs = billingEntitlement.maxQuotaAgeMs;
  }

  const {accounting} = billingEntitlement;
  if (!plainObject(accounting, ACCOUNTING_KEYS) ||
      !REQUIRED_ACCOUNTING_KEYS.every(k => Object.hasOwn(accounting, k)) ||
      (Object.hasOwn(accounting, 'netOfReservationsVerified') &&
        typeof accounting.netOfReservationsVerified !== 'boolean') ||
      (Object.hasOwn(accounting, 'dailyUsageIncludesReservations') &&
        typeof accounting.dailyUsageIncludesReservations !== 'boolean') ||
      accounting.accountingSource !== 'verified' ||
      accounting.isEstimated !== false ||
      !nonneg(accounting.observedAtMs) ||
      !boundedUnits(accounting.remainingIncludedUnits) ||
      !positive(accounting.unitsPerWorkerRun) ||
      accounting.unitsPerWorkerRun > MAX_UNIT_COUNT ||
      !boundedUnits(accounting.remainingIncludedRequests) ||
      !boundedUnits(accounting.requestsPerWorkerRun)) {
    return {error: blockedResult('BUDGET_UNKNOWN', 'ACCOUNTING_ESTIMATED_OR_MISSING')};
  }
  if (nowMs < accounting.observedAtMs || nowMs - accounting.observedAtMs > maxQuotaAgeMs) {
    return {error: blockedResult('STALE_QUOTA', 'STALE_QUOTA_OBSERVATION')};
  }

  let ghAwCaps = null;
  if (Object.hasOwn(billingEntitlement, 'ghAwCaps')) {
    ghAwCaps = billingEntitlement.ghAwCaps;
    if (!exactObject(ghAwCaps, GH_AW_CAP_KEYS) ||
        !positive(ghAwCaps.maxRunUnits) || ghAwCaps.maxRunUnits > MAX_UNIT_COUNT ||
        !positive(ghAwCaps.maxDailyUnits) || ghAwCaps.maxDailyUnits > MAX_UNIT_COUNT ||
        ghAwCaps.maxDailyUnits < ghAwCaps.maxRunUnits ||
        !boundedUnits(ghAwCaps.dailyUnitsUsed)) {
      return {error: blockedResult('INVALID_POLICY', 'GH_AW_SOFT_CAPS_INVALID')};
    }
    if (accounting.unitsPerWorkerRun > ghAwCaps.maxRunUnits) {
      return {error: blockedResult('BUDGET_OR_CONCURRENCY', 'GH_AW_MAX_RUN_UNITS_EXCEEDED')};
    }
  }

  return {
    error: null,
    summary: Object.freeze({
      providerFamily: provider.providerFamily,
      model: model.id,
      harness: harness.kind,
      sdkVersion: harness.kind === 'copilot-sdk' ? PINNED_COPILOT_SDK_VERSION : null,
      runner: runner.kind,
      billingEntitlement: 'verified-included-hard-stop',
      verifiedProviderWorkerCeiling: provider.verifiedProviderWorkerCeiling
    }),
    verifiedProviderWorkerCeiling: provider.verifiedProviderWorkerCeiling,
    accounting,
    ghAwCaps
  };
}

function computeProviderCapacity(providerEval, repoConcurrencyCap, peerStats) {
  const {accounting, ghAwCaps, verifiedProviderWorkerCeiling} = providerEval;
  const netDeducted = accounting.netOfReservationsVerified === true;
  const dailyIncludes = accounting.dailyUsageIncludesReservations === true;
  const hasPeers = peerStats.activeCount > 0;

  if ((hasPeers && (peerStats.minReservedUnits < accounting.unitsPerWorkerRun ||
        peerStats.minReservedRequests < accounting.requestsPerWorkerRun)) ||
      (!netDeducted && peerStats.missingUnitCommitments) ||
      (ghAwCaps !== null && !dailyIncludes && peerStats.missingDailyCommitments)) {
    return {error: blockedResult('BUDGET_UNKNOWN', 'PEER_RESERVATION_COMMITMENTS_UNKNOWN')};
  }

  const hardCeiling = Math.min(verifiedProviderWorkerCeiling, repoConcurrencyCap);
  if (peerStats.activeCount > hardCeiling) {
    return {error: blockedResult('BUDGET_OR_CONCURRENCY', 'ACTIVE_PEERS_EXCEED_VERIFIED_CEILING')};
  }

  const reservedUnits = netDeducted ? 0 : peerStats.committedUnits;
  const reservedRequests = netDeducted ? 0 : peerStats.committedRequests;
  const dailyUsed = ghAwCaps !== null
    ? ghAwCaps.dailyUnitsUsed + (dailyIncludes ? 0 : peerStats.dailyCommittedUnits)
    : 0;
  const overdrawn = (!netDeducted && (reservedUnits > accounting.remainingIncludedUnits ||
      reservedRequests > accounting.remainingIncludedRequests)) ||
    (ghAwCaps !== null && dailyUsed > ghAwCaps.maxDailyUnits);

  if (overdrawn) {
    return {
      error: null,
      hardCeiling,
      fundedAdditionalSlots: 0,
      verifiedCapacityCeiling: 0,
      maxFundedRung: 0
    };
  }

  const effectiveUnits = accounting.remainingIncludedUnits - reservedUnits;
  const effectiveRequests = accounting.remainingIncludedRequests - reservedRequests;
  let unitSlots = Math.floor(effectiveUnits / accounting.unitsPerWorkerRun);
  if (ghAwCaps !== null) {
    const remainingDaily = ghAwCaps.maxDailyUnits - dailyUsed;
    unitSlots = Math.min(unitSlots, Math.floor(remainingDaily / accounting.unitsPerWorkerRun));
  }
  const requestSlots = accounting.requestsPerWorkerRun === 0
    ? hardCeiling
    : Math.floor(effectiveRequests / accounting.requestsPerWorkerRun);
  const fundedAdditionalSlots = Math.min(unitSlots, requestSlots);
  const verifiedCapacityCeiling = Math.min(hardCeiling, peerStats.activeCount + fundedAdditionalSlots);
  const maxFundedRung = highestLadderRung(verifiedCapacityCeiling);

  return {
    error: null,
    hardCeiling,
    fundedAdditionalSlots,
    verifiedCapacityCeiling,
    maxFundedRung
  };
}

function validOptionalPr(obj) {
  return !Object.hasOwn(obj, 'pr') || obj.pr === null || positive(obj.pr);
}

function evaluatePeerLeases(rawPeers, nowMs) {
  if (rawPeers === undefined) {
    return {
      error: null,
      activeCount: 0,
      committedUnits: 0,
      dailyCommittedUnits: 0,
      committedRequests: 0,
      minReservedUnits: Infinity,
      minReservedRequests: Infinity,
      missingUnitCommitments: false,
      missingDailyCommitments: false,
      activeIssues: new Set(),
      activePrs: new Set(),
      activeLanes: new Set(),
      activePaths: [],
      expiredMaxGenByIssue: new Map(),
      seenIds: new Set()
    };
  }
  if (!denseArray(rawPeers, 250)) {
    return {error: blockedResult('LEASE_OR_CLOCK_UNKNOWN', 'PEER_LEASES_INVALID')};
  }
  const seenIds = new Set();
  const activeIssues = new Set();
  const activePrs = new Set();
  const activeLanes = new Set();
  const activePaths = [];
  const expiredMaxGenByIssue = new Map();
  let activeCount = 0;
  let committedUnits = 0;
  let dailyCommittedUnits = 0;
  let committedRequests = 0;
  let minReservedUnits = Infinity;
  let minReservedRequests = Infinity;
  let missingUnitCommitments = false;
  let missingDailyCommitments = false;

  for (let i = 0; i < rawPeers.length; i++) {
    const p = rawPeers[i];
    if (!plainObject(p, PEER_LEASE_KEYS) || !validIdToken(p.leaseId) || seenIds.has(p.leaseId) ||
        !positive(p.issue) || !validOptionalPr(p) || !validLane(p.lane) ||
        !validPathList(p.ownedPaths) || !positive(p.leaseGeneration) || !nonneg(p.expiresAtMs)) {
      return {error: blockedResult('LEASE_OR_CLOCK_UNKNOWN', 'PEER_LEASES_INVALID')};
    }
    if (p.ownedPaths.some(touchesProtectedControlPlane)) {
      return {error: blockedResult('PROVIDER_FORBIDDEN', 'PROTECTED_CONTROL_PLANE_PATH_FORBIDDEN')};
    }
    const hasUnits = Object.hasOwn(p, 'reservedUnits');
    const hasReqs = Object.hasOwn(p, 'reservedRequests');
    if ((hasUnits && !boundedUnits(p.reservedUnits)) || (hasReqs && !boundedUnits(p.reservedRequests))) {
      return {error: blockedResult('LEASE_OR_CLOCK_UNKNOWN', 'PEER_LEASES_INVALID')};
    }
    seenIds.add(p.leaseId);

    if (p.expiresAtMs <= nowMs) {
      const prevMax = expiredMaxGenByIssue.get(p.issue) ?? 0;
      if (p.leaseGeneration > prevMax) expiredMaxGenByIssue.set(p.issue, p.leaseGeneration);
      continue;
    }

    const pr = Object.hasOwn(p, 'pr') ? p.pr : null;
    if (activeIssues.has(p.issue) || (pr !== null && activePrs.has(pr)) ||
        activeLanes.has(p.lane) || p.ownedPaths.some(op => activePaths.some(ap => pathsOverlap(op, ap)))) {
      return {error: blockedResult('LANE_OR_PATH_RESERVED', 'ACTIVE_PEER_LEASE_CONFLICT')};
    }
    if (hasUnits && p.reservedUnits < minReservedUnits) minReservedUnits = p.reservedUnits;
    if (hasReqs && p.reservedRequests < minReservedRequests) minReservedRequests = p.reservedRequests;
    if (!hasUnits || !hasReqs) {
      missingUnitCommitments = true;
    } else {
      committedUnits += p.reservedUnits;
      committedRequests += p.reservedRequests;
    }
    if (!hasUnits) {
      missingDailyCommitments = true;
    } else {
      dailyCommittedUnits += p.reservedUnits;
    }
    activeCount++;
    activeIssues.add(p.issue);
    if (pr !== null) activePrs.add(pr);
    activeLanes.add(p.lane);
    activePaths.push(...p.ownedPaths);
  }

  return {
    error: null,
    activeCount,
    committedUnits,
    dailyCommittedUnits,
    committedRequests,
    minReservedUnits,
    minReservedRequests,
    missingUnitCommitments,
    missingDailyCommitments,
    activeIssues,
    activePrs,
    activeLanes,
    activePaths,
    expiredMaxGenByIssue,
    seenIds
  };
}

function evaluateOwnedLease(lease, repositoryId, nowMs, peerStats) {
  if (!plainObject(lease, LEASE_KEYS) || !validIdToken(lease.leaseId) ||
      !positive(lease.issue) || !validOptionalPr(lease) || !hex40(lease.headSha) ||
      !validLane(lease.lane) || !validPathList(lease.ownedPaths) ||
      !validWorkerId(lease.workerId) || !positive(lease.leaseGeneration) ||
      lease.leaseGeneration >= Number.MAX_SAFE_INTEGER ||
      !positive(lease.leaseExpiresAtMs) || !positive(lease.executionDeadlineMs)) {
    return {error: blockedResult('LEASE_OR_CLOCK_UNKNOWN', 'OWNED_LEASE_INVALID')};
  }
  if (lease.ownedPaths.some(touchesProtectedControlPlane)) {
    return {error: blockedResult('PROVIDER_FORBIDDEN', 'PROTECTED_CONTROL_PLANE_PATH_FORBIDDEN')};
  }
  if (lease.leaseExpiresAtMs <= nowMs || lease.leaseExpiresAtMs - nowMs > MAX_LEASE_TTL_MS ||
      lease.executionDeadlineMs <= nowMs || lease.executionDeadlineMs - nowMs > MAX_LEASE_TTL_MS) {
    return {error: blockedResult('LEASE_OR_CLOCK_UNKNOWN', 'OWNED_LEASE_EXPIRED_OR_UNBOUNDED')};
  }
  if (peerStats.seenIds.has(lease.leaseId)) {
    return {error: blockedResult('LANE_OR_PATH_RESERVED', 'DUPLICATE_LEASE_ID')};
  }
  const fencedGen = peerStats.expiredMaxGenByIssue.get(lease.issue) ?? 0;
  if (lease.leaseGeneration <= fencedGen) {
    return {error: blockedResult('STALE_CHECKPOINT', 'STALE_FENCED_GENERATION')};
  }
  const pr = Object.hasOwn(lease, 'pr') ? lease.pr : null;
  if (peerStats.activeIssues.has(lease.issue) ||
      (pr !== null && peerStats.activePrs.has(pr)) ||
      peerStats.activeLanes.has(lease.lane) ||
      lease.ownedPaths.some(op => peerStats.activePaths.some(ap => pathsOverlap(op, ap)))) {
    return {error: blockedResult('LANE_OR_PATH_RESERVED', 'LEASE_OWNERSHIP_CONFLICT')};
  }

  const buildPreserved = (status, bumpGeneration) => Object.freeze({
    leaseId: lease.leaseId,
    repositoryId,
    issue: lease.issue,
    pr,
    headSha: lease.headSha,
    lane: lease.lane,
    ownedPaths: Object.freeze([...lease.ownedPaths]),
    workerId: lease.workerId,
    leaseGeneration: lease.leaseGeneration,
    nextLeaseGeneration: bumpGeneration ? lease.leaseGeneration + 1 : lease.leaseGeneration,
    leaseExpiresAtMs: lease.leaseExpiresAtMs,
    executionDeadlineMs: lease.executionDeadlineMs,
    status
  });

  return {error: null, pr, buildPreserved};
}

function evaluateProviderNeutralCheckpoint(checkpoint, lease, leasePr, repositoryId, nowMs) {
  if (!plainObject(checkpoint, CHECKPOINT_KEYS) ||
      checkpoint.schemaVersion !== CHECKPOINT_SCHEMA_VERSION ||
      !validIdToken(checkpoint.checkpointId) ||
      typeof checkpoint.providerNeutral !== 'boolean' ||
      !positive(checkpoint.repositoryId) ||
      !positive(checkpoint.issue) ||
      !validOptionalPr(checkpoint) ||
      !hex40(checkpoint.headSha) ||
      !validLane(checkpoint.lane) ||
      !validPathList(checkpoint.ownedPaths) ||
      !positive(checkpoint.leaseGeneration) ||
      !positive(checkpoint.checkpointRevision) ||
      !nonneg(checkpoint.createdAtMs) ||
      checkpoint.createdAtMs > nowMs ||
      typeof checkpoint.serializedState !== 'string' ||
      !hex64(checkpoint.sha256)) {
    return {error: blockedResult('STALE_CHECKPOINT', 'CHECKPOINT_ENVELOPE_INVALID')};
  }
  if (!checkpoint.providerNeutral) {
    return {error: blockedResult('POLICY_UNKNOWN', 'CHECKPOINT_NOT_PROVIDER_NEUTRAL')};
  }
  const cpPr = Object.hasOwn(checkpoint, 'pr') ? checkpoint.pr : null;
  if (checkpoint.repositoryId !== repositoryId ||
      checkpoint.issue !== lease.issue ||
      cpPr !== leasePr ||
      checkpoint.headSha !== lease.headSha ||
      checkpoint.lane !== lease.lane ||
      checkpoint.leaseGeneration !== lease.leaseGeneration ||
      !samePathSet(checkpoint.ownedPaths, lease.ownedPaths)) {
    return {error: blockedResult('STALE_CHECKPOINT', 'CHECKPOINT_LEASE_MISMATCH')};
  }
  const expectedSha256 = computeCheckpointSha256(checkpoint.serializedState);
  if (expectedSha256 === null) {
    return {error: blockedResult('STALE_CHECKPOINT', 'CHECKPOINT_PAYLOAD_OVERSIZED_OR_EMPTY')};
  }
  if (SECRET_TOKEN_RE.test(checkpoint.serializedState)) {
    return {error: blockedResult('PROVIDER_FORBIDDEN', 'CHECKPOINT_SECRET_TOKEN_FORBIDDEN')};
  }
  const actualBuf = Buffer.from(checkpoint.sha256, 'hex');
  const expectedBuf = Buffer.from(expectedSha256, 'hex');
  if (!timingSafeEqual(actualBuf, expectedBuf)) {
    return {error: blockedResult('STALE_CHECKPOINT', 'CHECKPOINT_SHA256_MISMATCH')};
  }
  let parsed;
  try {
    parsed = JSON.parse(checkpoint.serializedState);
  } catch {
    return {error: blockedResult('STALE_CHECKPOINT', 'CHECKPOINT_SERIALIZED_JSON_INVALID')};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {error: blockedResult('STALE_CHECKPOINT', 'CHECKPOINT_SERIALIZED_JSON_INVALID')};
  }
  const decodedCheck = scanValidatedJsonStructure(checkpoint.serializedState);
  if (decodedCheck === 'SECRET') {
    return {error: blockedResult('PROVIDER_FORBIDDEN', 'CHECKPOINT_SECRET_TOKEN_FORBIDDEN')};
  }
  if (decodedCheck !== 'OK') {
    return {error: blockedResult('STALE_CHECKPOINT', 'CHECKPOINT_SERIALIZED_JSON_INVALID')};
  }
  const parsedPathsValid = Array.isArray(parsed.ownedPaths) &&
    parsed.ownedPaths.length > 0 &&
    parsed.ownedPaths.every(p => typeof p === 'string') &&
    new Set(parsed.ownedPaths).size === parsed.ownedPaths.length &&
    samePathSet(parsed.ownedPaths, lease.ownedPaths);
  if (parsed.repositoryId !== repositoryId ||
      parsed.issue !== lease.issue ||
      !Object.hasOwn(parsed, 'pr') || parsed.pr !== leasePr ||
      parsed.headSha !== lease.headSha ||
      parsed.lane !== lease.lane ||
      parsed.leaseGeneration !== lease.leaseGeneration ||
      parsed.checkpointRevision !== checkpoint.checkpointRevision ||
      !parsedPathsValid) {
    return {error: blockedResult('STALE_CHECKPOINT', 'CHECKPOINT_STATE_BINDING_MISMATCH')};
  }

  return {
    error: null,
    receipt: Object.freeze({
      checkpointId: checkpoint.checkpointId,
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      sha256: checkpoint.sha256,
      verifiedSha256: true,
      providerNeutral: true,
      checkpointRevision: checkpoint.checkpointRevision,
      createdAtMs: checkpoint.createdAtMs,
      headSha: checkpoint.headSha,
      leaseGeneration: checkpoint.leaseGeneration,
      byteLength: Buffer.byteLength(checkpoint.serializedState, 'utf8')
    })
  };
}

function evaluateLadderEvidence(ladder, hasActiveLease) {
  if (!plainObject(ladder, LADDER_KEYS) ||
      !Number.isSafeInteger(ladder.currentRung) ||
      !nonneg(ladder.verifiedPriorRung) ||
      !positive(ladder.repoConcurrencyCap) || ladder.repoConcurrencyCap > 1000 ||
      !positive(ladder.logicalLaneCount) || ladder.logicalLaneCount > 1000 ||
      !nonneg(ladder.observedSimultaneousWorkers) ||
      !nonneg(ladder.duplicateDispatches) ||
      !nonneg(ladder.unauthorizedWrites) ||
      !Number.isSafeInteger(ladder.unapprovedSpendUsdCents) ||
      typeof ladder.mainHealthy !== 'boolean' ||
      typeof ladder.qualityGatesClear !== 'boolean') {
    return {error: blockedResult('EVIDENCE_UNKNOWN', 'LADDER_EVIDENCE_INVALID')};
  }
  const currentIdx = WORKER_LADDER.indexOf(ladder.currentRung);
  if (currentIdx === -1) {
    return {error: blockedResult('POLICY_UNKNOWN', 'WORKER_LADDER_INVALID_RUNG')};
  }
  const expectedPrev = currentIdx === 0 ? 0 : WORKER_LADDER[currentIdx - 1];
  if (ladder.verifiedPriorRung !== expectedPrev && ladder.verifiedPriorRung !== ladder.currentRung) {
    return {error: blockedResult('POLICY_UNKNOWN', 'WORKER_LADDER_STEP_SKIPPED')};
  }
  const nextRung = WORKER_LADDER[currentIdx + 1] ?? null;
  let requestedRung;
  if (Object.hasOwn(ladder, 'requestedRung')) {
    if (!Number.isSafeInteger(ladder.requestedRung) || !WORKER_LADDER.includes(ladder.requestedRung)) {
      return {error: blockedResult('POLICY_UNKNOWN', 'WORKER_LADDER_INVALID_RUNG')};
    }
    requestedRung = ladder.requestedRung;
  } else {
    requestedRung = hasActiveLease ? ladder.currentRung : (nextRung ?? ladder.currentRung);
  }
  if (requestedRung > ladder.currentRung && requestedRung !== nextRung) {
    return {error: blockedResult('POLICY_UNKNOWN', 'WORKER_LADDER_STEP_SKIPPED')};
  }

  if (ladder.duplicateDispatches !== 0) {
    return {error: blockedResult('LANE_OR_PATH_RESERVED', 'DUPLICATE_DISPATCH_DETECTED')};
  }
  if (ladder.unauthorizedWrites !== 0) {
    return {error: blockedResult('PROVENANCE_MISMATCH', 'UNAUTHORIZED_WRITE_DETECTED')};
  }
  if (ladder.unapprovedSpendUsdCents !== 0) {
    return {error: blockedResult('BUDGET_UNKNOWN', 'UNAPPROVED_SPEND_DETECTED')};
  }
  if (!ladder.mainHealthy || !ladder.qualityGatesClear) {
    return {error: blockedResult('BASE_OR_MAIN_UNHEALTHY', 'MAIN_OR_QUALITY_UNHEALTHY')};
  }

  if (ladder.observedSimultaneousWorkers > ladder.currentRung ||
      ladder.observedSimultaneousWorkers > ladder.logicalLaneCount) {
    return {error: blockedResult('EVIDENCE_UNKNOWN', 'OBSERVED_WORKERS_INVALID')};
  }
  // Never treat logical lanes as active simultaneous workers when advancing rungs.
  if (requestedRung > ladder.currentRung && ladder.observedSimultaneousWorkers < ladder.currentRung) {
    return {error: blockedResult('CAPACITY_UNVERIFIED', 'LOGICAL_LANES_NOT_ACTIVE_WORKERS')};
  }

  const {throughput} = ladder;
  if (!plainObject(throughput, THROUGHPUT_KEYS) ||
      typeof throughput.comparabilityVerified !== 'boolean' ||
      !positive(throughput.baselineAcceptedUnits) || throughput.baselineAcceptedUnits > 1_000_000 ||
      !positive(throughput.baselineWindowMs) || throughput.baselineWindowMs > 86_400_000_000 ||
      !nonneg(throughput.currentAcceptedUnits) || throughput.currentAcceptedUnits > 1_000_000 ||
      !positive(throughput.currentWindowMs) || throughput.currentWindowMs > 86_400_000_000 ||
      (Object.hasOwn(throughput, 'reworkRegressed') && typeof throughput.reworkRegressed !== 'boolean')) {
    return {error: blockedResult('EVIDENCE_UNKNOWN', 'THROUGHPUT_EVIDENCE_INVALID')};
  }
  if (!throughput.comparabilityVerified) {
    return {error: blockedResult('EVIDENCE_UNKNOWN', 'THROUGHPUT_COMPARABILITY_UNVERIFIED')};
  }
  const rateMaintained = BigInt(throughput.currentAcceptedUnits) * BigInt(throughput.baselineWindowMs) >=
    BigInt(throughput.baselineAcceptedUnits) * BigInt(throughput.currentWindowMs);
  if (!rateMaintained || throughput.reworkRegressed === true) {
    return {error: blockedResult('CHECKS_INCOMPLETE', 'THROUGHPUT_REGRESSED')};
  }

  return {
    error: null,
    currentRung: ladder.currentRung,
    nextRung,
    requestedRung,
    repoConcurrencyCap: ladder.repoConcurrencyCap,
    logicalLaneCount: ladder.logicalLaneCount,
    observedSimultaneousWorkers: ladder.observedSimultaneousWorkers
  };
}

function buildEligibleResult({
  reason,
  decisionCode,
  handoffState,
  actualMaxWorkers,
  ladderEval,
  capacity,
  peerCount,
  selectedProvider,
  preservedLease = null,
  checkpointReceipt = null
}) {
  return Object.freeze({
    shadow: true,
    liveDispatch: false,
    admitted: true,
    state: 'eligible',
    reason,
    decisionCode,
    handoffState,
    paidFallbackUsed: false,
    blindRetryUsed: false,
    actualMaxWorkers,
    verifiedCapacityCeiling: capacity.verifiedCapacityCeiling,
    maxFundedRung: capacity.maxFundedRung,
    shortfallFrom12: Math.max(0, WORKER_GOAL_MAX - actualMaxWorkers),
    shortfallFrom10: Math.max(0, WORKER_GOAL_MIN - actualMaxWorkers),
    goalMet: actualMaxWorkers >= WORKER_GOAL_MIN,
    ladderDecision: Object.freeze({
      currentRung: ladderEval.currentRung,
      targetRung: ladderEval.requestedRung,
      nextRung: ladderEval.nextRung,
      observedSimultaneousWorkers: ladderEval.observedSimultaneousWorkers,
      logicalLaneCount: ladderEval.logicalLaneCount,
      verifiedCapacityCeiling: capacity.verifiedCapacityCeiling,
      maxFundedRung: capacity.maxFundedRung,
      activePeerWorkers: peerCount
    }),
    selectedProvider,
    preservedLease,
    checkpointReceipt
  });
}

/**
 * Evaluates Issue #7's 1->2->4->8->10->12 worker scaling ladder and Customer One
 * provider-neutral SHA-256 checkpoint pause, quota-refresh resumption, and
 * owner-authorized included-provider handoff.
 */
export function evaluateWorkerLadderAndQuotaHandoff(input) {
  if (!plainObject(input, TOP_LEVEL_KEYS) || !Object.hasOwn(input, 'stop') ||
      typeof input.stop !== 'boolean') {
    return blockedResult('EVIDENCE_UNKNOWN', 'CONTROLLER_INPUT_INVALID');
  }
  if (input.stop) {
    return blockedResult('STOPPED', 'STOP_SWITCH_ACTIVE');
  }
  if (input.personalPatInActionsSecrets !== false) {
    return blockedResult('PROVIDER_FORBIDDEN', 'PERSONAL_PAT_FORBIDDEN');
  }
  if (Object.hasOwn(input, 'paidFallbackRequested') && input.paidFallbackRequested !== false) {
    return blockedResult('PROVIDER_FORBIDDEN', 'PAID_FALLBACK_FORBIDDEN');
  }
  if (Object.hasOwn(input, 'blindRetryRequested') && input.blindRetryRequested !== false) {
    return blockedResult('POLICY_UNKNOWN', 'BLIND_RETRY_FORBIDDEN');
  }
  if (!positive(input.repositoryId) || !positive(input.approvedRepositoryId)) {
    return blockedResult('INVALID_IDENTITY', 'REPOSITORY_IDENTITY_INVALID');
  }
  if (input.repositoryId !== input.approvedRepositoryId) {
    return blockedResult('PROVENANCE_MISMATCH', 'REPOSITORY_SCOPE_MISMATCH');
  }
  if (!REPOSITORY_VISIBILITIES.includes(input.repositoryVisibility) || !nonneg(input.nowMs)) {
    return blockedResult('EVIDENCE_UNKNOWN', 'REPOSITORY_OR_CLOCK_INVALID');
  }

  const hasLease = Object.hasOwn(input, 'lease');
  const hasCheckpoint = Object.hasOwn(input, 'checkpoint');
  const hasHandoff = Object.hasOwn(input, 'handoff');

  if (hasCheckpoint && !hasLease) {
    return blockedResult('LEASE_OR_CLOCK_UNKNOWN', 'CHECKPOINT_WITHOUT_LEASE');
  }
  if (hasHandoff && !hasCheckpoint) {
    return blockedResult('STALE_CHECKPOINT', 'HANDOFF_REQUIRES_VERIFIED_CHECKPOINT');
  }

  const primaryEval = evaluateProviderContract(
    input.primaryProvider,
    input.repositoryId,
    input.repositoryVisibility,
    input.nowMs,
    'PRIMARY'
  );
  if (primaryEval.error) return primaryEval.error;

  const ladderEval = evaluateLadderEvidence(input.ladder, hasLease);
  if (ladderEval.error) return ladderEval.error;

  const peerStats = evaluatePeerLeases(input.activePeerLeases, input.nowMs);
  if (peerStats.error) return peerStats.error;

  let leaseEval = null;
  if (hasLease) {
    leaseEval = evaluateOwnedLease(input.lease, input.repositoryId, input.nowMs, peerStats);
    if (leaseEval.error) return leaseEval.error;
  }

  let checkpointEval = null;
  if (hasCheckpoint) {
    checkpointEval = evaluateProviderNeutralCheckpoint(
      input.checkpoint,
      input.lease,
      leaseEval.pr,
      input.repositoryId,
      input.nowMs
    );
    if (checkpointEval.error) return checkpointEval.error;
  }

  const primaryCap = computeProviderCapacity(primaryEval, ladderEval.repoConcurrencyCap, peerStats);
  if (primaryCap.error) return primaryCap.error;

  const observedForCap = cap =>
    Math.min(ladderEval.observedSimultaneousWorkers, cap.verifiedCapacityCeiling);
  const eligibleObservedForCap = cap =>
    Math.min(ladderEval.observedSimultaneousWorkers, ladderEval.requestedRung, cap.verifiedCapacityCeiling);
  const capExtras = (cap, extras = {}) => ({
    verifiedCapacityCeiling: cap.verifiedCapacityCeiling,
    maxFundedRung: cap.maxFundedRung,
    ...extras
  });

  if (peerStats.activeCount > ladderEval.currentRung) {
    return blockedResult(
      'BUDGET_OR_CONCURRENCY',
      'ACTIVE_PEERS_EXCEED_CURRENT_RUNG',
      observedForCap(primaryCap),
      capExtras(primaryCap)
    );
  }

  const canFitLease = (cap, targetRung) =>
    peerStats.activeCount < cap.hardCeiling && peerStats.activeCount + 1 <= targetRung;

  // Checkpoint pause, quota-refresh resumption, and alternate-provider handoff workflow.
  if (hasCheckpoint) {
    const pausedLease = leaseEval.buildPreserved('checkpoint-paused', false);
    const cpReceipt = checkpointEval.receipt;
    const primaryQuotaExhausted = primaryCap.fundedAdditionalSlots < 1;

    const evaluateQuotaRefresh = isExplicitRefresh => {
      if (primaryQuotaExhausted) {
        return blockedResult('CAPACITY_EXHAUSTED', 'QUOTA_EXHAUSTED_CHECKPOINT_PAUSED', 0, {
          detail: isExplicitRefresh ? 'QUOTA_NOT_YET_REFRESHED' : 'QUOTA_EXHAUSTED_CHECKPOINT_PAUSED',
          handoffState: 'QUOTA_EXHAUSTED_CHECKPOINT_PAUSED',
          preservedLease: pausedLease,
          checkpointReceipt: cpReceipt
        });
      }
      if (primaryEval.accounting.observedAtMs <= cpReceipt.createdAtMs) {
        return blockedResult('STALE_QUOTA', 'QUOTA_REFRESH_PRECEDES_CHECKPOINT', 0, {
          handoffState: 'QUOTA_EXHAUSTED_CHECKPOINT_PAUSED',
          preservedLease: pausedLease,
          checkpointReceipt: cpReceipt
        });
      }
      if (ladderEval.requestedRung > primaryCap.maxFundedRung) {
        return blockedResult(
          'CAPACITY_EXHAUSTED',
          'WORKER_LADDER_CAPACITY_INSUFFICIENT',
          observedForCap(primaryCap),
          capExtras(primaryCap, {
            handoffState: 'QUOTA_EXHAUSTED_CHECKPOINT_PAUSED',
            preservedLease: pausedLease,
            checkpointReceipt: cpReceipt
          })
        );
      }
      if (!canFitLease(primaryCap, ladderEval.requestedRung)) {
        return blockedResult(
          'BUDGET_OR_CONCURRENCY',
          'WORKER_RUNG_CONCURRENCY_FULL',
          observedForCap(primaryCap),
          capExtras(primaryCap, {
            handoffState: 'QUOTA_EXHAUSTED_CHECKPOINT_PAUSED',
            preservedLease: pausedLease,
            checkpointReceipt: cpReceipt
          })
        );
      }
      return buildEligibleResult({
        reason: 'SHADOW_ALLOCATION',
        decisionCode: 'CHECKPOINT_RESUMED_ON_QUOTA_REFRESH',
        handoffState: 'RESUMED_INCLUDED_QUOTA_REFRESH',
        actualMaxWorkers: eligibleObservedForCap(primaryCap),
        ladderEval,
        capacity: primaryCap,
        peerCount: peerStats.activeCount,
        selectedProvider: primaryEval.summary,
        preservedLease: leaseEval.buildPreserved('resumed-ready', true),
        checkpointReceipt: cpReceipt
      });
    };

    if (!hasHandoff) {
      return evaluateQuotaRefresh(false);
    }

    // Explicit bounded handoff spec present.
    const {handoff} = input;
    if (!plainObject(handoff, HANDOFF_KEYS) ||
        (handoff.mode !== 'quota-refresh' && handoff.mode !== 'provider-handoff') ||
        !positive(handoff.attempt)) {
      return blockedResult('EVIDENCE_UNKNOWN', 'HANDOFF_SPEC_INVALID', 0, {
        preservedLease: pausedLease,
        checkpointReceipt: cpReceipt
      });
    }
    let maxAttempts = DEFAULT_MAX_HANDOFF_ATTEMPTS;
    if (Object.hasOwn(handoff, 'maxAttempts')) {
      if (!positive(handoff.maxAttempts) || handoff.maxAttempts > MAX_ALLOWED_HANDOFF_ATTEMPTS) {
        return blockedResult('INVALID_POLICY', 'HANDOFF_MAX_ATTEMPTS_INVALID', 0, {
          preservedLease: pausedLease,
          checkpointReceipt: cpReceipt
        });
      }
      maxAttempts = handoff.maxAttempts;
    }
    if (handoff.attempt > maxAttempts) {
      return blockedResult('POLICY_UNKNOWN', 'HANDOFF_ATTEMPT_CAP_EXCEEDED', 0, {
        preservedLease: pausedLease,
        checkpointReceipt: cpReceipt
      });
    }

    if (handoff.mode === 'quota-refresh') {
      if (Object.hasOwn(handoff, 'targetProvider')) {
        return blockedResult('EVIDENCE_UNKNOWN', 'UNEXPECTED_TARGET_PROVIDER', 0, {
          preservedLease: pausedLease,
          checkpointReceipt: cpReceipt
        });
      }
      return evaluateQuotaRefresh(true);
    }

    // handoff.mode === 'provider-handoff'
    if (!primaryQuotaExhausted) {
      return blockedResult(
        'POLICY_UNKNOWN',
        'PRIMARY_QUOTA_NOT_EXHAUSTED',
        observedForCap(primaryCap),
        capExtras(primaryCap, {
          preservedLease: pausedLease,
          checkpointReceipt: cpReceipt
        })
      );
    }
    const targetEval = evaluateProviderContract(
      handoff.targetProvider,
      input.repositoryId,
      input.repositoryVisibility,
      input.nowMs,
      'HANDOFF'
    );
    if (targetEval.error) {
      return blockedResult(targetEval.error.reason, targetEval.error.decisionCode, 0, {
        handoffState: 'QUOTA_EXHAUSTED_CHECKPOINT_PAUSED',
        preservedLease: pausedLease,
        checkpointReceipt: cpReceipt
      });
    }
    if (targetEval.accounting.observedAtMs < cpReceipt.createdAtMs) {
      return blockedResult('STALE_QUOTA', 'HANDOFF_TARGET_QUOTA_PRECEDES_CHECKPOINT', 0, {
        handoffState: 'QUOTA_EXHAUSTED_CHECKPOINT_PAUSED',
        preservedLease: pausedLease,
        checkpointReceipt: cpReceipt
      });
    }
    const targetCap = computeProviderCapacity(targetEval, ladderEval.repoConcurrencyCap, peerStats);
    if (targetCap.error) {
      return blockedResult(targetCap.error.reason, targetCap.error.decisionCode, 0, {
        handoffState: 'QUOTA_EXHAUSTED_CHECKPOINT_PAUSED',
        preservedLease: pausedLease,
        checkpointReceipt: cpReceipt
      });
    }
    if (targetCap.fundedAdditionalSlots < 1) {
      return blockedResult('CAPACITY_EXHAUSTED', 'QUOTA_EXHAUSTED_CHECKPOINT_PAUSED', 0, {
        detail: 'HANDOFF_TARGET_QUOTA_EXHAUSTED',
        handoffState: 'QUOTA_EXHAUSTED_CHECKPOINT_PAUSED',
        preservedLease: pausedLease,
        checkpointReceipt: cpReceipt
      });
    }
    if (ladderEval.requestedRung > targetCap.maxFundedRung) {
      return blockedResult(
        'CAPACITY_EXHAUSTED',
        'WORKER_LADDER_CAPACITY_INSUFFICIENT',
        observedForCap(targetCap),
        capExtras(targetCap, {
          handoffState: 'QUOTA_EXHAUSTED_CHECKPOINT_PAUSED',
          preservedLease: pausedLease,
          checkpointReceipt: cpReceipt
        })
      );
    }
    if (!canFitLease(targetCap, ladderEval.requestedRung)) {
      return blockedResult(
        'BUDGET_OR_CONCURRENCY',
        'WORKER_RUNG_CONCURRENCY_FULL',
        observedForCap(targetCap),
        capExtras(targetCap, {
          handoffState: 'QUOTA_EXHAUSTED_CHECKPOINT_PAUSED',
          preservedLease: pausedLease,
          checkpointReceipt: cpReceipt
        })
      );
    }
    return buildEligibleResult({
      reason: 'SHADOW_ALLOCATION',
      decisionCode: 'CHECKPOINT_HANDOFF_TO_INCLUDED_PROVIDER',
      handoffState: 'HANDOFF_ELIGIBLE',
      actualMaxWorkers: eligibleObservedForCap(targetCap),
      ladderEval,
      capacity: targetCap,
      peerCount: peerStats.activeCount,
      selectedProvider: targetEval.summary,
      preservedLease: leaseEval.buildPreserved('handoff-ready', true),
      checkpointReceipt: cpReceipt
    });
  }

  // Non-checkpoint steady-state rung evaluation (with or without an active lease).
  if (hasLease) {
    if (primaryCap.fundedAdditionalSlots < 1) {
      return blockedResult('STALE_CHECKPOINT', 'CHECKPOINT_REQUIRED_ON_QUOTA_EXHAUSTION', 0);
    }
    if (!canFitLease(primaryCap, ladderEval.requestedRung)) {
      return blockedResult(
        'BUDGET_OR_CONCURRENCY',
        'WORKER_RUNG_CONCURRENCY_FULL',
        observedForCap(primaryCap),
        capExtras(primaryCap)
      );
    }
  }
  if (primaryCap.maxFundedRung === 0) {
    return blockedResult('CAPACITY_EXHAUSTED', 'INCLUDED_QUOTA_EXHAUSTED', 0);
  }
  if (ladderEval.requestedRung > primaryCap.hardCeiling) {
    return blockedResult(
      'CAPACITY_UNVERIFIED',
      'WORKER_LADDER_EXCEEDS_VERIFIED_CEILING',
      observedForCap(primaryCap),
      capExtras(primaryCap)
    );
  }
  if (ladderEval.requestedRung > primaryCap.maxFundedRung) {
    return blockedResult(
      'CAPACITY_EXHAUSTED',
      'WORKER_LADDER_CAPACITY_INSUFFICIENT',
      observedForCap(primaryCap),
      capExtras(primaryCap)
    );
  }

  const eligibleActual = eligibleObservedForCap(primaryCap);
  let decisionCode = 'WORKER_LADDER_RUNG_VERIFIED';
  if (ladderEval.requestedRung > ladderEval.currentRung) {
    decisionCode = 'WORKER_LADDER_SCALE_RECOMMENDED';
  } else if (ladderEval.requestedRung === WORKER_GOAL_MAX && eligibleActual === WORKER_GOAL_MAX) {
    decisionCode = 'WORKER_LADDER_MAX_RUNG_VERIFIED';
  }

  return buildEligibleResult({
    reason: 'SHADOW_CAPACITY',
    decisionCode,
    handoffState: 'PRIMARY_ACTIVE',
    actualMaxWorkers: eligibleActual,
    ladderEval,
    capacity: primaryCap,
    peerCount: peerStats.activeCount,
    selectedProvider: primaryEval.summary,
    preservedLease: hasLease ? leaseEval.buildPreserved('active-verified', false) : null
  });
}
