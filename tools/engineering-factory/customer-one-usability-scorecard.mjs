// Reproducible read-only M02.02 (#18) Customer One usability, onboarding overhead,
// and authorized portfolio scorecard evaluator. Strictly isolates synthetic,
// historical-proxy, and verified-live evidence classes and never substitutes 0
// for missing, stale, or unobserved data.
import {types} from 'node:util';

export const CUSTOMER_ONE_SCHEMA_VERSION = 1;

export const CUSTOMER_ONE_EVIDENCE_CLASSES = Object.freeze([
  'synthetic',
  'historical-proxy',
  'verified-live'
]);

export const PORTFOLIO_MILESTONES = Object.freeze([
  'M01',
  'M02',
  'M03',
  'M04',
  'M05'
]);

export const ONBOARDING_SCENARIO_KINDS = Object.freeze([
  'blank-repository',
  'existing-repository',
  'customer-one-adoption'
]);

export const CUSTOMER_ONE_USABILITY_SLOS = Object.freeze({
  initialPlanMaxMs: 300_000,
  basicIntegrationMaxMs: 900_000,
  maxMandatoryUserSettingsCount: 5,
  maxManualInterventionsCount: 0,
  maxAdditionalMandatoryServicesCount: 0,
  maxLocalSoftwareRequiredCount: 0,
  maxAttributableSpendUsdCents: 0
});

export const CUSTOMER_ONE_METRIC_KEYS = Object.freeze([
  'initialPlanMs',
  'basicIntegrationMs',
  'mandatoryUserSettingsCount',
  'generatedFilesCount',
  'manualInterventionsCount',
  'additionalMandatoryServicesCount',
  'localSoftwareRequiredCount',
  'providerCapacityBlocksCount',
  'attributableSpendUsdCents'
]);

const METRIC_SPECS = Object.freeze([
  Object.freeze({
    key: 'initialPlanMs',
    targetMax: CUSTOMER_ONE_USABILITY_SLOS.initialPlanMaxMs,
    includeTotal: false
  }),
  Object.freeze({
    key: 'basicIntegrationMs',
    targetMax: CUSTOMER_ONE_USABILITY_SLOS.basicIntegrationMaxMs,
    includeTotal: false
  }),
  Object.freeze({
    key: 'mandatoryUserSettingsCount',
    targetMax: CUSTOMER_ONE_USABILITY_SLOS.maxMandatoryUserSettingsCount,
    includeTotal: false
  }),
  Object.freeze({
    key: 'generatedFilesCount',
    targetMax: null,
    includeTotal: true
  }),
  Object.freeze({
    key: 'manualInterventionsCount',
    targetMax: CUSTOMER_ONE_USABILITY_SLOS.maxManualInterventionsCount,
    includeTotal: true
  }),
  Object.freeze({
    key: 'additionalMandatoryServicesCount',
    targetMax: CUSTOMER_ONE_USABILITY_SLOS.maxAdditionalMandatoryServicesCount,
    includeTotal: true
  }),
  Object.freeze({
    key: 'localSoftwareRequiredCount',
    targetMax: CUSTOMER_ONE_USABILITY_SLOS.maxLocalSoftwareRequiredCount,
    includeTotal: true
  }),
  Object.freeze({
    key: 'providerCapacityBlocksCount',
    targetMax: null,
    includeTotal: true
  }),
  Object.freeze({
    key: 'attributableSpendUsdCents',
    targetMax: CUSTOMER_ONE_USABILITY_SLOS.maxAttributableSpendUsdCents,
    includeTotal: true
  })
]);

const PROXY_METRIC_KEYS = Object.freeze([
  'issueCreatedToCloseMs',
  'prCreatedToMergeMs'
]);

const INPUT_REQUIRED_KEYS = [
  'authorizedRepositoryIds',
  'evidenceClass',
  'fromMs',
  'toMs',
  'nowMs',
  'maxAgeMs',
  'sourceComplete',
  'observations'
];

const INPUT_OPTIONAL_KEYS = ['filters', 'baseline'];

const USABILITY_OBS_REQUIRED_KEYS = [
  'id',
  'repositoryId',
  'evidenceClass',
  'observedAtMs',
  'milestone',
  'lane',
  'metrics'
];

const PROXY_OBS_REQUIRED_KEYS = [
  'id',
  'repositoryId',
  'evidenceClass',
  'observedAtMs',
  'milestone',
  'lane',
  'proxyMetrics'
];

const SNAPSHOT_KEYS = [
  'valid',
  'shadow',
  'readOnly',
  'schemaVersion',
  'reason',
  'evidenceClass',
  'historicalProxyOnly',
  'provisionalTargetsOnly',
  'liveClaimEligible',
  'window',
  'filters',
  'sourceComplete',
  'observationCount',
  'outOfWindowCount',
  'filteredOutCount',
  'lastObservedAtMs',
  'freshnessStatus',
  'stale',
  'dataCompletenessPct',
  'usability',
  'historicalProxySummary',
  'portfolio',
  'perRepository',
  'baselineComparison'
];

const evidenceClassSet = new Set(CUSTOMER_ONE_EVIDENCE_CLASSES);
const milestoneSet = new Set(PORTFOLIO_MILESTONES);
const scenarioKindSet = new Set(ONBOARDING_SCENARIO_KINDS);
const freshnessSet = new Set(['fresh', 'stale', 'unknown']);

const positiveInt = n => Number.isSafeInteger(n) && n > 0;
const nonnegInt = n => Number.isSafeInteger(n) && n >= 0;
const validObservationId = s => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(s);
const validLane = s => typeof s === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(s);
const hasDuplicates = arr => new Set(arr).size !== arr.length;

function isPlainObject(value) {
  return value !== null &&
    typeof value === 'object' &&
    !types.isProxy(value) &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function hasOwnEnumerableData(target, key) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor !== undefined &&
    descriptor.enumerable === true &&
    Object.hasOwn(descriptor, 'value');
}

function exactRecord(value, requiredKeys, optionalKeys = []) {
  if (!isPlainObject(value)) return false;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !allowed.has(key) || !hasOwnEnumerableData(value, key))) {
    return false;
  }
  return requiredKeys.every(key => hasOwnEnumerableData(value, key));
}

function denseDataArray(value, maxLen) {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return false;
  }
  if (value.length > maxLen || Reflect.ownKeys(value).length !== value.length + 1) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    if (!hasOwnEnumerableData(value, i)) return false;
  }
  return true;
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else {
    for (const val of Object.values(value)) deepFreeze(val);
  }
  return Object.freeze(value);
}

function nearestRank(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.ceil(p * sorted.length) - 1];
}

function invalidResult(reason) {
  return Object.freeze({
    valid: false,
    shadow: true,
    readOnly: true,
    liveClaimEligible: false,
    reason
  });
}

function resolveFilters(rawFilters, authorizedSet, sortedAuthorizedIds) {
  if (rawFilters === undefined) {
    return {
      ok: true,
      repositoryIds: sortedAuthorizedIds,
      milestones: [...PORTFOLIO_MILESTONES],
      lanes: null
    };
  }
  if (!exactRecord(rawFilters, [], ['repositoryIds', 'milestones', 'lanes'])) {
    return {ok: false, reason: 'INVALID_FILTERS'};
  }

  let repositoryIds = sortedAuthorizedIds;
  if (hasOwnEnumerableData(rawFilters, 'repositoryIds') && rawFilters.repositoryIds !== undefined) {
    const rawRepos = rawFilters.repositoryIds;
    if (!denseDataArray(rawRepos, 32) || rawRepos.length === 0 ||
        !rawRepos.every(positiveInt) || hasDuplicates(rawRepos)) {
      return {ok: false, reason: 'INVALID_FILTERS'};
    }
    if (rawRepos.some(id => !authorizedSet.has(id))) {
      return {ok: false, reason: 'UNAUTHORIZED_REPOSITORY'};
    }
    repositoryIds = [...rawRepos].sort((a, b) => a - b);
  }

  let milestones = [...PORTFOLIO_MILESTONES];
  if (hasOwnEnumerableData(rawFilters, 'milestones') && rawFilters.milestones !== undefined) {
    const rawMs = rawFilters.milestones;
    if (!denseDataArray(rawMs, 5) || rawMs.length === 0 ||
        !rawMs.every(m => milestoneSet.has(m)) || hasDuplicates(rawMs)) {
      return {ok: false, reason: 'INVALID_FILTERS'};
    }
    milestones = PORTFOLIO_MILESTONES.filter(m => rawMs.includes(m));
  }

  let lanes = null;
  if (hasOwnEnumerableData(rawFilters, 'lanes') && rawFilters.lanes !== undefined) {
    const rawLanes = rawFilters.lanes;
    if (!denseDataArray(rawLanes, 64) || rawLanes.length === 0 ||
        !rawLanes.every(validLane) || hasDuplicates(rawLanes)) {
      return {ok: false, reason: 'INVALID_FILTERS'};
    }
    lanes = [...rawLanes].sort();
  }

  return {ok: true, repositoryIds, milestones, lanes};
}

function validUsabilityMetrics(metrics) {
  if (!exactRecord(metrics, CUSTOMER_ONE_METRIC_KEYS, ['explicitCredentialEntryCount'])) {
    return false;
  }
  for (const key of CUSTOMER_ONE_METRIC_KEYS) {
    if (metrics[key] !== null && !nonnegInt(metrics[key])) return false;
  }
  if (hasOwnEnumerableData(metrics, 'explicitCredentialEntryCount') &&
      metrics.explicitCredentialEntryCount !== undefined &&
      metrics.explicitCredentialEntryCount !== null &&
      !nonnegInt(metrics.explicitCredentialEntryCount)) {
    return false;
  }
  return true;
}

function validProxyMetrics(proxyMetrics) {
  return exactRecord(proxyMetrics, PROXY_METRIC_KEYS) &&
    PROXY_METRIC_KEYS.every(key => proxyMetrics[key] === null || nonnegInt(proxyMetrics[key]));
}

function validateObservation(row, input, authorizedSet) {
  if (!isPlainObject(row) || !hasOwnEnumerableData(row, 'evidenceClass')) {
    return {ok: false, reason: 'INVALID_OBSERVATION'};
  }
  if (row.evidenceClass !== input.evidenceClass) {
    return {
      ok: false,
      reason: evidenceClassSet.has(row.evidenceClass)
        ? 'EVIDENCE_CLASS_MIXING_FORBIDDEN'
        : 'INVALID_OBSERVATION'
    };
  }
  if (input.evidenceClass === 'historical-proxy') {
    if (hasOwnEnumerableData(row, 'metrics')) {
      return {ok: false, reason: 'EVIDENCE_CLASS_MIXING_FORBIDDEN'};
    }
    if (!exactRecord(row, PROXY_OBS_REQUIRED_KEYS) || !validProxyMetrics(row.proxyMetrics)) {
      return {ok: false, reason: 'INVALID_OBSERVATION'};
    }
  } else {
    if (hasOwnEnumerableData(row, 'proxyMetrics')) {
      return {ok: false, reason: 'EVIDENCE_CLASS_MIXING_FORBIDDEN'};
    }
    if (!exactRecord(row, USABILITY_OBS_REQUIRED_KEYS, ['scenarioKind']) ||
        (hasOwnEnumerableData(row, 'scenarioKind') &&
          row.scenarioKind !== undefined &&
          !scenarioKindSet.has(row.scenarioKind)) ||
        !validUsabilityMetrics(row.metrics)) {
      return {ok: false, reason: 'INVALID_OBSERVATION'};
    }
  }

  if (!validObservationId(row.id) ||
      !positiveInt(row.repositoryId) ||
      !nonnegInt(row.observedAtMs) ||
      !milestoneSet.has(row.milestone) ||
      !validLane(row.lane)) {
    return {ok: false, reason: 'INVALID_OBSERVATION'};
  }
  if (!authorizedSet.has(row.repositoryId)) {
    return {ok: false, reason: 'UNAUTHORIZED_REPOSITORY'};
  }
  if (row.observedAtMs > input.nowMs) {
    return {ok: false, reason: 'FUTURE_OBSERVATION_TIMESTAMP'};
  }
  return {ok: true};
}

function verifySafeTotals(rows, evidenceClass) {
  if (evidenceClass === 'historical-proxy') return true;
  for (const spec of METRIC_SPECS) {
    if (!spec.includeTotal) continue;
    let sum = 0;
    for (const row of rows) {
      const val = row.metrics[spec.key];
      if (val !== null) {
        if (sum > Number.MAX_SAFE_INTEGER - val) return false;
        sum += val;
      }
    }
  }
  let credSum = 0;
  for (const row of rows) {
    const val = row.metrics.explicitCredentialEntryCount;
    if (val !== undefined && val !== null) {
      if (credSum > Number.MAX_SAFE_INTEGER - val) return false;
      credSum += val;
    }
  }
  return true;
}

function summarizeUsabilityMetric(rows, spec, sourceComplete) {
  const knownValues = [];
  let missingCount = 0;
  let sum = 0;
  let violations = 0;

  for (const row of rows) {
    const val = row.metrics[spec.key];
    if (val === null) {
      missingCount++;
      continue;
    }
    knownValues.push(val);
    if (spec.includeTotal) {
      sum += val;
    }
    if (spec.targetMax !== null && val > spec.targetMax) {
      violations++;
    }
  }

  knownValues.sort((a, b) => a - b);
  const knownCount = knownValues.length;
  const complete = rows.length > 0 && missingCount === 0 && sourceComplete;
  const status = complete ? 'measured' : knownCount > 0 ? 'partial' : 'unknown';

  let sloStatus = 'informational';
  let sloMet = null;
  let violationCount = null;
  if (spec.targetMax !== null) {
    if (violations > 0) {
      sloStatus = 'failed';
      sloMet = false;
      violationCount = violations;
    } else if (complete) {
      sloStatus = 'passed';
      sloMet = true;
      violationCount = 0;
    } else {
      sloStatus = 'unknown';
    }
  }

  return {
    status,
    knownCount,
    missingCount,
    min: knownCount > 0 ? knownValues[0] : null,
    p50: nearestRank(knownValues, 0.5),
    p95: nearestRank(knownValues, 0.95),
    max: knownCount > 0 ? knownValues[knownCount - 1] : null,
    total: spec.includeTotal && complete ? sum : null,
    confirmedTotal: spec.includeTotal && knownCount > 0 ? sum : null,
    targetMax: spec.targetMax,
    violationCount,
    sloStatus,
    sloMet
  };
}

function summarizeCredentialExclusions(rows, sourceComplete) {
  const knownValues = [];
  let missingCount = 0;
  let sum = 0;
  for (const row of rows) {
    const val = row.metrics.explicitCredentialEntryCount;
    if (val === undefined || val === null) {
      missingCount++;
      continue;
    }
    knownValues.push(val);
    sum += val;
  }
  knownValues.sort((a, b) => a - b);
  const knownCount = knownValues.length;
  const complete = rows.length > 0 && missingCount === 0 && sourceComplete;
  return {
    excludedFromMandatorySettings: true,
    knownCount,
    missingCount,
    total: complete ? sum : null,
    max: knownCount > 0 ? knownValues[knownCount - 1] : null
  };
}

function summarizeUsabilityBlock(rows, sourceComplete, stale) {
  const metrics = {};
  const sloStatuses = [];
  for (const spec of METRIC_SPECS) {
    const summary = summarizeUsabilityMetric(rows, spec, sourceComplete);
    metrics[spec.key] = summary;
    if (spec.targetMax !== null) {
      sloStatuses.push(summary.sloStatus);
    }
  }

  let overallSloStatus;
  let allSlosMet = null;
  if (sloStatuses.includes('failed')) {
    overallSloStatus = 'failed';
    allSlosMet = false;
  } else if (stale === true) {
    overallSloStatus = 'stale';
  } else if (sloStatuses.every(status => status === 'passed')) {
    overallSloStatus = 'passed';
    allSlosMet = true;
  } else {
    overallSloStatus = 'unknown';
  }

  const byScenario = {
    'blank-repository': 0,
    'existing-repository': 0,
    'customer-one-adoption': 0,
    unspecified: 0
  };
  for (const row of rows) {
    const kind = row.scenarioKind;
    if (kind === undefined) byScenario.unspecified++;
    else byScenario[kind]++;
  }

  return {
    provisionalTargets: CUSTOMER_ONE_USABILITY_SLOS,
    overallSloStatus,
    allSlosMet,
    explicitCredentialEntries: summarizeCredentialExclusions(rows, sourceComplete),
    byScenario,
    metrics
  };
}

function summarizeProxyBlock(rows, sourceComplete) {
  const result = {nonAutonomousProxyOnly: true};
  for (const key of PROXY_METRIC_KEYS) {
    const knownValues = [];
    let missingCount = 0;
    for (const row of rows) {
      const val = row.proxyMetrics[key];
      if (val === null) missingCount++;
      else knownValues.push(val);
    }
    knownValues.sort((a, b) => a - b);
    const knownCount = knownValues.length;
    const complete = rows.length > 0 && missingCount === 0 && sourceComplete;
    result[key] = {
      status: complete ? 'measured' : knownCount > 0 ? 'partial' : 'unknown',
      knownCount,
      missingCount,
      p50: nearestRank(knownValues, 0.5),
      p95: nearestRank(knownValues, 0.95)
    };
  }
  return result;
}

function evaluateScopeSlice(rows, {evidenceClass, nowMs, maxAgeMs, sourceComplete, includeDetail}) {
  const observationCount = rows.length;
  let lastObservedAtMs = null;
  let populatedCells = 0;
  const cellsPerRow = evidenceClass === 'historical-proxy'
    ? PROXY_METRIC_KEYS.length
    : CUSTOMER_ONE_METRIC_KEYS.length;

  for (const row of rows) {
    if (lastObservedAtMs === null || row.observedAtMs > lastObservedAtMs) {
      lastObservedAtMs = row.observedAtMs;
    }
    if (evidenceClass === 'historical-proxy') {
      for (const key of PROXY_METRIC_KEYS) {
        if (row.proxyMetrics[key] !== null) populatedCells++;
      }
    } else {
      for (const key of CUSTOMER_ONE_METRIC_KEYS) {
        if (row.metrics[key] !== null) populatedCells++;
      }
    }
  }

  const stale = lastObservedAtMs === null ? null : nowMs - lastObservedAtMs > maxAgeMs;
  const freshnessStatus = stale === null ? 'unknown' : stale ? 'stale' : 'fresh';
  const dataCompletenessPct = observationCount === 0 || !sourceComplete
    ? null
    : (populatedCells * 100) / (observationCount * cellsPerRow);

  if (!includeDetail) {
    return {
      observationCount,
      lastObservedAtMs,
      freshnessStatus,
      stale,
      dataCompletenessPct
    };
  }

  const usability = evidenceClass === 'historical-proxy'
    ? null
    : summarizeUsabilityBlock(rows, sourceComplete, stale);
  const historicalProxySummary = evidenceClass === 'historical-proxy'
    ? summarizeProxyBlock(rows, sourceComplete)
    : null;

  return {
    observationCount,
    lastObservedAtMs,
    freshnessStatus,
    stale,
    dataCompletenessPct,
    usability,
    historicalProxySummary
  };
}

function sameArray(a, b) {
  return a.length === b.length && a.every((v, idx) => v === b[idx]);
}

function sameNullableArray(a, b) {
  if (a === null || b === null) return a === b;
  return sameArray(a, b);
}

const DELTA_METRIC_FIELDS = Object.freeze([
  Object.freeze(['initialPlanMs', 'p50']),
  Object.freeze(['basicIntegrationMs', 'p50']),
  Object.freeze(['mandatoryUserSettingsCount', 'max']),
  Object.freeze(['generatedFilesCount', 'p50']),
  Object.freeze(['manualInterventionsCount', 'total']),
  Object.freeze(['additionalMandatoryServicesCount', 'total']),
  Object.freeze(['localSoftwareRequiredCount', 'total']),
  Object.freeze(['providerCapacityBlocksCount', 'total']),
  Object.freeze(['attributableSpendUsdCents', 'total'])
]);

function validCompleteUsabilitySnapshot(usability) {
  if (!isPlainObject(usability) ||
      !hasOwnEnumerableData(usability, 'overallSloStatus') ||
      !['passed', 'failed', 'stale', 'unknown'].includes(usability.overallSloStatus) ||
      !hasOwnEnumerableData(usability, 'metrics') ||
      !exactRecord(usability.metrics, CUSTOMER_ONE_METRIC_KEYS)) {
    return false;
  }
  return DELTA_METRIC_FIELDS.every(([key, field]) => {
    const entry = usability.metrics[key];
    return isPlainObject(entry) &&
      hasOwnEnumerableData(entry, field) &&
      nonnegInt(entry[field]) &&
      hasOwnEnumerableData(entry, 'sloStatus') &&
      ['passed', 'failed', 'informational', 'unknown'].includes(entry.sloStatus);
  });
}

function validBaselineSnapshot(s) {
  if (!exactRecord(s, SNAPSHOT_KEYS) || s.valid !== true ||
      typeof s.sourceComplete !== 'boolean' ||
      !nonnegInt(s.observationCount) ||
      !freshnessSet.has(s.freshnessStatus) ||
      (s.dataCompletenessPct !== null &&
        (!Number.isFinite(s.dataCompletenessPct) || s.dataCompletenessPct < 0 || s.dataCompletenessPct > 100)) ||
      !exactRecord(s.window, ['fromMs', 'toMs', 'nowMs', 'maxAgeMs']) ||
      !nonnegInt(s.window.fromMs) || !nonnegInt(s.window.toMs) || s.window.fromMs >= s.window.toMs ||
      !nonnegInt(s.window.nowMs) || s.window.nowMs < s.window.toMs || !positiveInt(s.window.maxAgeMs) ||
      !exactRecord(s.filters, ['repositoryIds', 'milestones', 'lanes']) ||
      !denseDataArray(s.filters.repositoryIds, 32) ||
      !denseDataArray(s.filters.milestones, 5) ||
      (s.filters.lanes !== null && !denseDataArray(s.filters.lanes, 64))) {
    return false;
  }
  if (s.evidenceClass === 'historical-proxy') {
    return s.usability === null;
  }
  if (s.sourceComplete && s.observationCount > 0 && s.freshnessStatus === 'fresh' && s.dataCompletenessPct === 100) {
    return validCompleteUsabilitySnapshot(s.usability);
  }
  return isPlainObject(s.usability);
}

function evaluateBaselineComparison(baseline, candidate) {
  if (baseline === undefined || baseline === null) {
    return {ok: true, comparison: null};
  }
  if (!isPlainObject(baseline) || !hasOwnEnumerableData(baseline, 'evidenceClass')) {
    return {ok: false, reason: 'INVALID_BASELINE'};
  }
  if (baseline.evidenceClass !== candidate.evidenceClass) {
    return {
      ok: false,
      reason: evidenceClassSet.has(baseline.evidenceClass)
        ? 'EVIDENCE_CLASS_MIXING_FORBIDDEN'
        : 'INVALID_BASELINE'
    };
  }
  if (!validBaselineSnapshot(baseline)) {
    return {ok: false, reason: 'INVALID_BASELINE'};
  }

  const unavailable = reason => ({
    ok: true,
    comparison: {
      comparable: false,
      reason,
      evidenceClass: candidate.evidenceClass,
      sloRegressed: null,
      deltas: null
    }
  });

  if (!sameArray(baseline.filters.repositoryIds, candidate.filters.repositoryIds) ||
      !sameArray(baseline.filters.milestones, candidate.filters.milestones) ||
      !sameNullableArray(baseline.filters.lanes, candidate.filters.lanes)) {
    return unavailable('SCOPE_MISMATCH');
  }

  const baseDuration = baseline.window.toMs - baseline.window.fromMs;
  const candDuration = candidate.window.toMs - candidate.window.fromMs;
  if (baseline.window.toMs > candidate.window.fromMs || baseDuration !== candDuration) {
    return unavailable('WINDOWS_NOT_COMPARABLE');
  }

  if (candidate.evidenceClass === 'historical-proxy') {
    return unavailable('HISTORICAL_PROXY_NOT_COMPARABLE');
  }

  const bothReady = baseline.sourceComplete && candidate.sourceComplete &&
    baseline.observationCount > 0 && candidate.observationCount > 0 &&
    baseline.freshnessStatus === 'fresh' && candidate.freshnessStatus === 'fresh' &&
    baseline.dataCompletenessPct === 100 && candidate.dataCompletenessPct === 100;
  if (!bothReady) {
    return unavailable('INCOMPLETE_OR_STALE_EVIDENCE');
  }

  const bm = baseline.usability.metrics;
  const cm = candidate.usability.metrics;
  const deltas = {
    initialPlanP50DeltaMs: cm.initialPlanMs.p50 - bm.initialPlanMs.p50,
    basicIntegrationP50DeltaMs: cm.basicIntegrationMs.p50 - bm.basicIntegrationMs.p50,
    mandatoryUserSettingsMaxDelta: cm.mandatoryUserSettingsCount.max - bm.mandatoryUserSettingsCount.max,
    generatedFilesP50Delta: cm.generatedFilesCount.p50 - bm.generatedFilesCount.p50,
    manualInterventionsTotalDelta: cm.manualInterventionsCount.total - bm.manualInterventionsCount.total,
    additionalMandatoryServicesTotalDelta:
      cm.additionalMandatoryServicesCount.total - bm.additionalMandatoryServicesCount.total,
    localSoftwareRequiredTotalDelta:
      cm.localSoftwareRequiredCount.total - bm.localSoftwareRequiredCount.total,
    providerCapacityBlocksTotalDelta: cm.providerCapacityBlocksCount.total - bm.providerCapacityBlocksCount.total,
    attributableSpendTotalDeltaUsdCents: cm.attributableSpendUsdCents.total - bm.attributableSpendUsdCents.total
  };
  const anyMetricNewlyFailed = METRIC_SPECS.some(
    spec => spec.targetMax !== null &&
      bm[spec.key].sloStatus === 'passed' &&
      cm[spec.key].sloStatus !== 'passed'
  );
  const sloRegressed =
    anyMetricNewlyFailed ||
    deltas.manualInterventionsTotalDelta > 0 ||
    deltas.additionalMandatoryServicesTotalDelta > 0 ||
    deltas.localSoftwareRequiredTotalDelta > 0 ||
    deltas.attributableSpendTotalDeltaUsdCents > 0;

  return {
    ok: true,
    comparison: {
      comparable: true,
      reason: 'COMPARABLE_WINDOWS',
      evidenceClass: candidate.evidenceClass,
      sloRegressed,
      deltas
    }
  };
}

/**
 * Evaluate Customer One provisional usability SLOs, onboarding overhead, and
 * isolated per-repository + portfolio rollups within a single evidenceClass.
 */
export function evaluateCustomerOneUsabilityAndPortfolio(input) {
  if (!exactRecord(input, INPUT_REQUIRED_KEYS, INPUT_OPTIONAL_KEYS)) {
    return invalidResult('INVALID_INPUT');
  }
  if (!denseDataArray(input.authorizedRepositoryIds, 32) ||
      input.authorizedRepositoryIds.length === 0 ||
      !input.authorizedRepositoryIds.every(positiveInt) ||
      hasDuplicates(input.authorizedRepositoryIds)) {
    return invalidResult('INVALID_AUTHORIZED_REPOSITORIES');
  }
  if (!evidenceClassSet.has(input.evidenceClass)) {
    return invalidResult('INVALID_EVIDENCE_CLASS');
  }
  if (!nonnegInt(input.fromMs) || !nonnegInt(input.toMs) || input.fromMs >= input.toMs ||
      !nonnegInt(input.nowMs) || input.nowMs < input.toMs ||
      !positiveInt(input.maxAgeMs) || typeof input.sourceComplete !== 'boolean') {
    return invalidResult('INVALID_WINDOW');
  }
  if (!denseDataArray(input.observations, 5000)) {
    return invalidResult('INVALID_OBSERVATIONS');
  }

  const authorizedSet = new Set(input.authorizedRepositoryIds);
  const sortedAuthorizedIds = [...input.authorizedRepositoryIds].sort((a, b) => a - b);
  const filtersResult = resolveFilters(input.filters, authorizedSet, sortedAuthorizedIds);
  if (!filtersResult.ok) {
    return invalidResult(filtersResult.reason);
  }

  const repoFilterSet = new Set(filtersResult.repositoryIds);
  const milestoneFilterSet = new Set(filtersResult.milestones);
  const laneFilterSet = filtersResult.lanes === null ? null : new Set(filtersResult.lanes);

  const seenIds = new Set();
  const matchingRows = [];
  let outOfWindowCount = 0;
  let filteredOutCount = 0;

  for (const row of input.observations) {
    const check = validateObservation(row, input, authorizedSet);
    if (!check.ok) return invalidResult(check.reason);
    if (seenIds.has(row.id)) return invalidResult('DUPLICATE_OBSERVATION_ID');
    seenIds.add(row.id);

    if (row.observedAtMs < input.fromMs || row.observedAtMs >= input.toMs) {
      outOfWindowCount++;
      continue;
    }
    if (!repoFilterSet.has(row.repositoryId) ||
        !milestoneFilterSet.has(row.milestone) ||
        (laneFilterSet !== null && !laneFilterSet.has(row.lane))) {
      filteredOutCount++;
      continue;
    }
    matchingRows.push(row);
  }

  if (!verifySafeTotals(matchingRows, input.evidenceClass)) {
    return invalidResult('UNSAFE_AGGREGATE_TOTAL');
  }

  const sliceOptions = {
    evidenceClass: input.evidenceClass,
    nowMs: input.nowMs,
    maxAgeMs: input.maxAgeMs,
    sourceComplete: input.sourceComplete
  };

  const overallSlice = evaluateScopeSlice(matchingRows, {...sliceOptions, includeDetail: true});

  const rowsByRepo = new Map(filtersResult.repositoryIds.map(id => [id, []]));
  const rowsByMilestone = new Map(filtersResult.milestones.map(ms => [ms, []]));
  const rowsByLane = new Map(
    filtersResult.lanes === null ? [] : filtersResult.lanes.map(lane => [lane, []])
  );

  for (const row of matchingRows) {
    rowsByRepo.get(row.repositoryId).push(row);
    rowsByMilestone.get(row.milestone).push(row);
    const laneBucket = rowsByLane.get(row.lane);
    if (laneBucket !== undefined) {
      laneBucket.push(row);
    } else {
      rowsByLane.set(row.lane, [row]);
    }
  }

  let observedRepositoryCount = 0;
  const perRepository = filtersResult.repositoryIds.map(repositoryId => {
    const repoRows = rowsByRepo.get(repositoryId);
    if (repoRows.length > 0) observedRepositoryCount++;
    return {
      repositoryId,
      ...evaluateScopeSlice(repoRows, {...sliceOptions, includeDetail: true})
    };
  });

  const byMilestone = filtersResult.milestones.map(milestone => ({
    milestone,
    ...evaluateScopeSlice(rowsByMilestone.get(milestone), {...sliceOptions, includeDetail: false})
  }));

  const sortedLaneKeys = [...rowsByLane.keys()].sort();
  const byLane = sortedLaneKeys.map(lane => ({
    lane,
    ...evaluateScopeSlice(rowsByLane.get(lane), {...sliceOptions, includeDetail: false})
  }));

  const completeAndFresh = input.sourceComplete &&
    overallSlice.observationCount > 0 &&
    overallSlice.freshnessStatus === 'fresh' &&
    overallSlice.dataCompletenessPct === 100;

  let reason;
  if (input.evidenceClass === 'historical-proxy') {
    reason = 'HISTORICAL_PROXY_QUARANTINED';
  } else if (overallSlice.stale === true) {
    reason = 'STALE_OBSERVATIONS';
  } else if (completeAndFresh) {
    reason = input.evidenceClass === 'verified-live'
      ? 'MEASURED_VERIFIED_LIVE'
      : 'MEASURED_SYNTHETIC';
  } else {
    reason = 'PARTIAL_OR_EMPTY_EVIDENCE';
  }

  const liveClaimEligible = input.evidenceClass === 'verified-live' &&
    completeAndFresh &&
    overallSlice.usability.overallSloStatus === 'passed';

  const scorecard = {
    valid: true,
    shadow: true,
    readOnly: true,
    schemaVersion: CUSTOMER_ONE_SCHEMA_VERSION,
    reason,
    evidenceClass: input.evidenceClass,
    historicalProxyOnly: input.evidenceClass === 'historical-proxy',
    provisionalTargetsOnly: input.evidenceClass !== 'verified-live',
    liveClaimEligible,
    window: {
      fromMs: input.fromMs,
      toMs: input.toMs,
      nowMs: input.nowMs,
      maxAgeMs: input.maxAgeMs
    },
    filters: {
      repositoryIds: filtersResult.repositoryIds,
      milestones: filtersResult.milestones,
      lanes: filtersResult.lanes
    },
    sourceComplete: input.sourceComplete,
    observationCount: overallSlice.observationCount,
    outOfWindowCount,
    filteredOutCount,
    lastObservedAtMs: overallSlice.lastObservedAtMs,
    freshnessStatus: overallSlice.freshnessStatus,
    stale: overallSlice.stale,
    dataCompletenessPct: overallSlice.dataCompletenessPct,
    usability: overallSlice.usability,
    historicalProxySummary: overallSlice.historicalProxySummary,
    portfolio: {
      authorizedRepositoryCount: filtersResult.repositoryIds.length,
      observedRepositoryCount,
      observationCount: overallSlice.observationCount,
      lastObservedAtMs: overallSlice.lastObservedAtMs,
      freshnessStatus: overallSlice.freshnessStatus,
      stale: overallSlice.stale,
      dataCompletenessPct: overallSlice.dataCompletenessPct,
      byMilestone,
      byLane
    },
    perRepository,
    baselineComparison: null
  };

  const baselineResult = evaluateBaselineComparison(input.baseline, scorecard);
  if (!baselineResult.ok) {
    return invalidResult(baselineResult.reason);
  }
  scorecard.baselineComparison = baselineResult.comparison;

  return deepFreeze(scorecard);
}
