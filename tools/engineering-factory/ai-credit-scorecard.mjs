// Reproducible read-only M02.02 AI-credit, gh-aw queue, MAF superstep, and
// anti-rogue audit scorecard aggregator. Isolates per-repository cohorts and
// strictly separates historical proxies from verified autonomous outcomes.
import {types} from 'node:util';

export const AI_CREDIT_USD_CENTS = 1;

export const SCORECARD_SOURCE_KINDS = Object.freeze([
  'verified-autonomous',
  'historical-proxy'
]);

export const KNOWN_VIOLATION_CODES = Object.freeze([
  'SAFE_OUTPUTS_THREAT_FLAGGED',
  'PROTECTED_CONTROL_PLANE_TOUCH',
  'OUT_OF_LANE_EDIT',
  'SELF_APPROVAL_FORBIDDEN',
  'AI_CREDIT_ANOMALY',
  'RETRY_CAP_EXCEEDED',
  'POST_MERGE_MAIN_FAILED'
]);

export const DEFAULT_BOTTLENECK_THRESHOLDS = Object.freeze({
  maxAiCreditsPerOutcome: 50,
  maxQueueP95Ms: 120000,
  maxReworkRateBps: 1500,
  maxSandboxMinutesPerOutcome: 15,
  maxActionsMinutesPerOutcome: 10
});

const knownViolationSet = new Set(KNOWN_VIOLATION_CODES);
const proxyMetricsSet = new Set(['issue-created-to-close', 'pr-created-to-merge']);

const INPUT_REQUIRED_KEYS = [
  'repositoryId',
  'authorizedRepositoryIds',
  'cohort',
  'sourceKind',
  'fromMs',
  'toMs',
  'observedMs',
  'nowMs',
  'maxAgeMs',
  'records'
];

const THRESHOLD_KEYS = [
  'maxAiCreditsPerOutcome',
  'maxQueueP95Ms',
  'maxReworkRateBps',
  'maxSandboxMinutesPerOutcome',
  'maxActionsMinutesPerOutcome'
];

const AUTONOMOUS_RECORD_KEYS = [
  'id',
  'repositoryId',
  'cohort',
  'sourceKind',
  'observedMs',
  'accepted',
  'accounting',
  'ghAwQueueLatencyMs',
  'maf',
  'audit'
];

const PROXY_RECORD_KEYS = [
  'id',
  'repositoryId',
  'cohort',
  'sourceKind',
  'observedMs',
  'metric',
  'durationMs'
];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !types.isProxy(value) &&
    !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasOwnEnumerableData(target, key) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor !== undefined && descriptor.enumerable === true && Object.hasOwn(descriptor, 'value');
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
  if (value.length > maxLen || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let i = 0; i < value.length; i++) {
    if (!hasOwnEnumerableData(value, i)) return false;
  }
  return true;
}

const positiveInt = n => Number.isSafeInteger(n) && n > 0;
const nonnegInt = n => Number.isSafeInteger(n) && n >= 0;
const validCohort = s => typeof s === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(s);
const validId = s => typeof s === 'string' && /^[A-Za-z0-9._:-]{1,96}$/.test(s);

function nearestRank(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.ceil(p * sorted.length) - 1];
}

function invalidScorecard(reason) {
  return Object.freeze({
    valid: false,
    shadow: true,
    readOnly: true,
    autonomousClaimEligible: false,
    reason
  });
}

function addSafeInt(sums, key, delta) {
  if (sums[key] > Number.MAX_SAFE_INTEGER - delta) return false;
  sums[key] += delta;
  return true;
}

function resolveThresholds(raw) {
  if (raw === undefined) return {ok: true, thresholds: DEFAULT_BOTTLENECK_THRESHOLDS};
  if (!exactRecord(raw, [], THRESHOLD_KEYS)) return {ok: false};
  const merged = {...DEFAULT_BOTTLENECK_THRESHOLDS};
  for (const key of THRESHOLD_KEYS) {
    if (hasOwnEnumerableData(raw, key)) {
      if (!positiveInt(raw[key])) return {ok: false};
      merged[key] = raw[key];
    }
  }
  return {ok: true, thresholds: Object.freeze(merged)};
}

function validAccounting(accounting) {
  if (accounting === null) return true;
  if (!isPlainObject(accounting) || !hasOwnEnumerableData(accounting, 'status')) return false;
  if (accounting.status === 'missing' || accounting.status === 'estimated') {
    return exactRecord(accounting, ['status']);
  }
  if (accounting.status !== 'verified') return false;
  return exactRecord(accounting, [
    'status',
    'aiCredits',
    'incrementalBilledUsdCents',
    'cloudSandboxMinutes',
    'actionsRunnerMinutes'
  ]) && nonnegInt(accounting.aiCredits) &&
    nonnegInt(accounting.incrementalBilledUsdCents) &&
    (accounting.cloudSandboxMinutes === null || nonnegInt(accounting.cloudSandboxMinutes)) &&
    (accounting.actionsRunnerMinutes === null || nonnegInt(accounting.actionsRunnerMinutes));
}

function validMaf(maf) {
  if (maf === null) return true;
  return exactRecord(maf, ['supersteps', 'checkpointResumes', 'innerRepairIterations']) &&
    positiveInt(maf.supersteps) &&
    nonnegInt(maf.checkpointResumes) &&
    nonnegInt(maf.innerRepairIterations);
}

function validAuditShape(audit) {
  if (audit === null) return true;
  return exactRecord(audit, ['fullProvenance', 'killSwitchTripped', 'violations']) &&
    typeof audit.fullProvenance === 'boolean' &&
    typeof audit.killSwitchTripped === 'boolean' &&
    denseDataArray(audit.violations, 16) &&
    audit.violations.every(code => knownViolationSet.has(code)) &&
    new Set(audit.violations).size === audit.violations.length;
}

function resolveWorkUnitKey(row) {
  const hasIssue = hasOwnEnumerableData(row, 'issueNumber');
  const hasUnit = hasOwnEnumerableData(row, 'workUnitId');
  if (hasIssue && hasUnit) return {ok: false, reason: 'INVALID_RECORD'};
  if (hasIssue) {
    if (!positiveInt(row.issueNumber)) return {ok: false, reason: 'INVALID_RECORD'};
    return {ok: true, key: `issue:${row.repositoryId}:${row.issueNumber}`};
  }
  if (hasUnit) {
    if (!validId(row.workUnitId)) return {ok: false, reason: 'INVALID_RECORD'};
    return {ok: true, key: `unit:${row.repositoryId}:${row.workUnitId}`};
  }
  if (row.accepted === true) return {ok: false, reason: 'MISSING_ACCEPTED_WORK_UNIT'};
  return {ok: true, key: null};
}

function aggregateProxyScorecard(input) {
  const seenIds = new Set();
  const issueDurations = [];
  const prDurations = [];
  let issueUnknown = 0;
  let prUnknown = 0;

  for (const row of input.records) {
    if (!isPlainObject(row) || !hasOwnEnumerableData(row, 'sourceKind')) {
      return invalidScorecard('INVALID_RECORD');
    }
    if (row.sourceKind !== 'historical-proxy') {
      return invalidScorecard(
        row.sourceKind === 'verified-autonomous' ? 'SOURCE_KIND_MIXING_FORBIDDEN' : 'INVALID_RECORD'
      );
    }
    if (!exactRecord(row, PROXY_RECORD_KEYS) || !validId(row.id) ||
        !nonnegInt(row.observedMs) || row.observedMs > input.observedMs ||
        !proxyMetricsSet.has(row.metric) ||
        (row.durationMs !== null && !nonnegInt(row.durationMs))) {
      return invalidScorecard('INVALID_RECORD');
    }
    if (row.repositoryId !== input.repositoryId || row.cohort !== input.cohort) {
      return invalidScorecard('REPOSITORY_OR_COHORT_MISMATCH');
    }
    if (seenIds.has(row.id)) return invalidScorecard('DUPLICATE_RECORD');
    seenIds.add(row.id);
    if (row.observedMs < input.fromMs || row.observedMs >= input.toMs) continue;

    if (row.metric === 'issue-created-to-close') {
      if (row.durationMs === null) issueUnknown++;
      else issueDurations.push(row.durationMs);
    } else if (row.durationMs === null) {
      prUnknown++;
    } else {
      prDurations.push(row.durationMs);
    }
  }

  issueDurations.sort((a, b) => a - b);
  prDurations.sort((a, b) => a - b);

  return Object.freeze({
    valid: true,
    shadow: true,
    readOnly: true,
    reason: 'HISTORICAL_PROXY_ISOLATED',
    repositoryId: input.repositoryId,
    cohort: input.cohort,
    sourceKind: 'historical-proxy',
    autonomousClaimEligible: false,
    window: Object.freeze({
      fromMs: input.fromMs,
      toMs: input.toMs,
      observedMs: input.observedMs
    }),
    acceptedOutcomes: null,
    acceptedActionRows: null,
    aiCreditsTotal: null,
    aiCreditsUsdCents: null,
    aiCreditsPerAcceptedOutcome: null,
    incrementalBilledUsdCents: null,
    confirmedIncrementalBilledUsdCents: null,
    estimatedOrMissingCount: null,
    cloudSandboxMinutes: null,
    actionsRunnerMinutes: null,
    ghAwQueueLatencyMs: Object.freeze({
      p50: null,
      p95: null,
      sampleCount: 0,
      unknownCount: null
    }),
    mafTelemetry: Object.freeze({
      superstepsTotal: null,
      checkpointResumes: null,
      innerRepairIterations: null,
      reworkRateBps: null,
      missingCount: null
    }),
    auditTraceability: Object.freeze({
      totalActions: 0,
      observedAuditActions: 0,
      auditComplete: false,
      fullProvenanceActions: 0,
      provenanceCompletenessPct: null,
      killSwitchTrips: null,
      violationCounts: null
    }),
    historicalProxySummary: Object.freeze({
      issueCreatedToClose: Object.freeze({
        p50: nearestRank(issueDurations, 0.5),
        p95: nearestRank(issueDurations, 0.95),
        sampleCount: issueDurations.length,
        unknownCount: issueUnknown
      }),
      prCreatedToMerge: Object.freeze({
        p50: nearestRank(prDurations, 0.5),
        p95: nearestRank(prDurations, 0.95),
        sampleCount: prDurations.length,
        unknownCount: prUnknown
      })
    }),
    bottlenecks: Object.freeze([])
  });
}

function buildRankedBottlenecks(metrics, thresholds) {
  const candidates = [];
  if (metrics.auditTraceability.killSwitchTrips !== null && metrics.auditTraceability.killSwitchTrips > 0) {
    candidates.push({
      id: 'anti-rogue-kill-switch-trips',
      category: 'anti-rogue-audit',
      suggestedScope: 'factory-velocity',
      metric: 'killSwitchTrips',
      observedValue: metrics.auditTraceability.killSwitchTrips,
      thresholdValue: 0,
      severityScore: 980
    });
  }
  if (metrics.auditTraceability.provenanceCompletenessPct !== null &&
      metrics.auditTraceability.provenanceCompletenessPct < 100) {
    candidates.push({
      id: 'causal-provenance-gap',
      category: 'anti-rogue-audit',
      suggestedScope: 'factory-velocity',
      metric: 'provenanceCompletenessPct',
      observedValue: metrics.auditTraceability.provenanceCompletenessPct,
      thresholdValue: 100,
      severityScore: 950
    });
  }
  if (metrics.estimatedOrMissingCount > 0) {
    candidates.push({
      id: 'ai-credit-accounting-gap',
      category: 'ai-credit-efficiency',
      suggestedScope: 'factory-velocity',
      metric: 'estimatedOrMissingCount',
      observedValue: metrics.estimatedOrMissingCount,
      thresholdValue: 0,
      severityScore: 920
    });
  }
  if (metrics.confirmedIncrementalBilledUsdCents !== null &&
      metrics.confirmedIncrementalBilledUsdCents > 0) {
    candidates.push({
      id: 'incremental-billed-spend',
      category: 'ai-credit-efficiency',
      suggestedScope: 'factory-velocity',
      metric: 'incrementalBilledUsdCents',
      observedValue: metrics.confirmedIncrementalBilledUsdCents,
      thresholdValue: 0,
      severityScore: 900
    });
  }
  if (metrics.aiCreditsPerAcceptedOutcome !== null &&
      metrics.aiCreditsPerAcceptedOutcome > thresholds.maxAiCreditsPerOutcome) {
    candidates.push({
      id: 'high-ai-credits-per-outcome',
      category: 'ai-credit-efficiency',
      suggestedScope: 'knowledge-map',
      metric: 'aiCreditsPerAcceptedOutcome',
      observedValue: metrics.aiCreditsPerAcceptedOutcome,
      thresholdValue: thresholds.maxAiCreditsPerOutcome,
      severityScore: 760
    });
  }
  if (metrics.mafTelemetry.reworkRateBps !== null &&
      metrics.mafTelemetry.reworkRateBps > thresholds.maxReworkRateBps) {
    candidates.push({
      id: 'maf-superstep-rework-high',
      category: 'maf-rework',
      suggestedScope: 'knowledge-map',
      metric: 'reworkRateBps',
      observedValue: metrics.mafTelemetry.reworkRateBps,
      thresholdValue: thresholds.maxReworkRateBps,
      severityScore: 640
    });
  }
  if (metrics.ghAwQueueLatencyMs.p95 !== null &&
      metrics.ghAwQueueLatencyMs.p95 > thresholds.maxQueueP95Ms) {
    candidates.push({
      id: 'gh-aw-queue-latency-p95',
      category: 'gh-aw-queue-latency',
      suggestedScope: 'factory-velocity',
      metric: 'ghAwQueueLatencyP95Ms',
      observedValue: metrics.ghAwQueueLatencyMs.p95,
      thresholdValue: thresholds.maxQueueP95Ms,
      severityScore: 520
    });
  }
  if (metrics.acceptedOutcomes > 0 && metrics.cloudSandboxMinutes !== null &&
      metrics.cloudSandboxMinutes / metrics.acceptedOutcomes > thresholds.maxSandboxMinutesPerOutcome) {
    candidates.push({
      id: 'cloud-sandbox-minutes-high',
      category: 'compute-overhead',
      suggestedScope: 'factory-velocity',
      metric: 'cloudSandboxMinutesPerOutcome',
      observedValue: metrics.cloudSandboxMinutes / metrics.acceptedOutcomes,
      thresholdValue: thresholds.maxSandboxMinutesPerOutcome,
      severityScore: 380
    });
  }
  if (metrics.acceptedOutcomes > 0 && metrics.actionsRunnerMinutes !== null &&
      metrics.actionsRunnerMinutes / metrics.acceptedOutcomes > thresholds.maxActionsMinutesPerOutcome) {
    candidates.push({
      id: 'actions-runner-minutes-high',
      category: 'compute-overhead',
      suggestedScope: 'factory-velocity',
      metric: 'actionsRunnerMinutesPerOutcome',
      observedValue: metrics.actionsRunnerMinutes / metrics.acceptedOutcomes,
      thresholdValue: thresholds.maxActionsMinutesPerOutcome,
      severityScore: 340
    });
  }

  candidates.sort((a, b) => b.severityScore - a.severityScore || a.id.localeCompare(b.id));
  return Object.freeze(candidates.map((item, idx) => Object.freeze({rank: idx + 1, ...item})));
}

export function buildAiCreditAndAutonomyScorecard(input) {
  if (!exactRecord(input, INPUT_REQUIRED_KEYS, ['thresholds'])) {
    return invalidScorecard('INVALID_INPUT');
  }
  if (!positiveInt(input.repositoryId) ||
      !denseDataArray(input.authorizedRepositoryIds, 32) ||
      input.authorizedRepositoryIds.length === 0 ||
      !input.authorizedRepositoryIds.every(positiveInt) ||
      new Set(input.authorizedRepositoryIds).size !== input.authorizedRepositoryIds.length ||
      !validCohort(input.cohort) ||
      !SCORECARD_SOURCE_KINDS.includes(input.sourceKind)) {
    return invalidScorecard('INVALID_SCOPE');
  }
  if (!input.authorizedRepositoryIds.includes(input.repositoryId)) {
    return invalidScorecard('UNAUTHORIZED_REPOSITORY');
  }
  if (!nonnegInt(input.fromMs) || !nonnegInt(input.toMs) || input.fromMs >= input.toMs ||
      !nonnegInt(input.observedMs) || !nonnegInt(input.nowMs) || !positiveInt(input.maxAgeMs) ||
      input.observedMs < input.toMs || input.observedMs > input.nowMs) {
    return invalidScorecard('INVALID_WINDOW');
  }
  if (input.nowMs - input.observedMs > input.maxAgeMs) {
    return invalidScorecard('STALE_EVIDENCE');
  }
  if (!denseDataArray(input.records, 5000)) {
    return invalidScorecard('INVALID_RECORDS');
  }
  const thresholdResult = resolveThresholds(input.thresholds);
  if (!thresholdResult.ok) return invalidScorecard('INVALID_THRESHOLDS');

  if (input.sourceKind === 'historical-proxy') {
    return aggregateProxyScorecard(input);
  }

  const seenIds = new Set();
  const acceptedWorkUnits = new Set();
  const queueDurations = [];
  let queueUnknownCount = 0;
  let totalActions = 0;
  let acceptedActionRows = 0;
  let estimatedOrMissingCount = 0;
  let missingSandboxCount = 0;
  let missingRunnerCount = 0;
  let missingMafCount = 0;
  let fullProvenanceActions = 0;
  let killSwitchTrips = 0;
  let missingAuditCount = 0;
  const sums = {
    aiCredits: 0,
    incrementalCents: 0,
    sandboxMinutes: 0,
    runnerMinutes: 0,
    supersteps: 0,
    checkpointResumes: 0,
    innerRepairs: 0
  };
  const violationCounts = Object.fromEntries(KNOWN_VIOLATION_CODES.map(code => [code, 0]));

  for (const row of input.records) {
    if (!isPlainObject(row) || !hasOwnEnumerableData(row, 'sourceKind')) {
      return invalidScorecard('INVALID_RECORD');
    }
    if (row.sourceKind !== 'verified-autonomous') {
      return invalidScorecard(
        row.sourceKind === 'historical-proxy' ? 'SOURCE_KIND_MIXING_FORBIDDEN' : 'INVALID_RECORD'
      );
    }
    if (!exactRecord(row, AUTONOMOUS_RECORD_KEYS, ['issueNumber', 'workUnitId']) ||
        !validId(row.id) ||
        !nonnegInt(row.observedMs) || row.observedMs > input.observedMs ||
        typeof row.accepted !== 'boolean' ||
        (row.ghAwQueueLatencyMs !== null && !nonnegInt(row.ghAwQueueLatencyMs)) ||
        !validAccounting(row.accounting) ||
        !validMaf(row.maf) ||
        !validAuditShape(row.audit)) {
      return invalidScorecard('INVALID_RECORD');
    }
    if (row.audit !== null && row.audit.violations.length > 0 && row.audit.killSwitchTripped !== true) {
      return invalidScorecard('INCONSISTENT_AUDIT_RECORD');
    }
    if (row.repositoryId !== input.repositoryId || row.cohort !== input.cohort) {
      return invalidScorecard('REPOSITORY_OR_COHORT_MISMATCH');
    }
    const workUnit = resolveWorkUnitKey(row);
    if (!workUnit.ok) return invalidScorecard(workUnit.reason);
    if (seenIds.has(row.id)) return invalidScorecard('DUPLICATE_RECORD');
    seenIds.add(row.id);
    if (row.observedMs < input.fromMs || row.observedMs >= input.toMs) continue;

    totalActions++;
    if (row.accepted) {
      acceptedActionRows++;
      acceptedWorkUnits.add(workUnit.key);
    }

    if (row.accounting === null || row.accounting.status !== 'verified') {
      estimatedOrMissingCount++;
    } else {
      if (!addSafeInt(sums, 'aiCredits', row.accounting.aiCredits) ||
          !addSafeInt(sums, 'incrementalCents', row.accounting.incrementalBilledUsdCents)) {
        return invalidScorecard('UNSAFE_AGGREGATE_TOTAL');
      }
      if (row.accounting.cloudSandboxMinutes === null) {
        missingSandboxCount++;
      } else if (!addSafeInt(sums, 'sandboxMinutes', row.accounting.cloudSandboxMinutes)) {
        return invalidScorecard('UNSAFE_AGGREGATE_TOTAL');
      }
      if (row.accounting.actionsRunnerMinutes === null) {
        missingRunnerCount++;
      } else if (!addSafeInt(sums, 'runnerMinutes', row.accounting.actionsRunnerMinutes)) {
        return invalidScorecard('UNSAFE_AGGREGATE_TOTAL');
      }
    }

    if (row.ghAwQueueLatencyMs === null) queueUnknownCount++;
    else queueDurations.push(row.ghAwQueueLatencyMs);

    if (row.maf === null) {
      missingMafCount++;
    } else if (!addSafeInt(sums, 'supersteps', row.maf.supersteps) ||
        !addSafeInt(sums, 'checkpointResumes', row.maf.checkpointResumes) ||
        !addSafeInt(sums, 'innerRepairs', row.maf.innerRepairIterations)) {
      return invalidScorecard('UNSAFE_AGGREGATE_TOTAL');
    }

    if (row.audit === null) {
      missingAuditCount++;
    } else {
      if (row.audit.fullProvenance) fullProvenanceActions++;
      if (row.audit.killSwitchTripped) killSwitchTrips++;
      for (const code of row.audit.violations) {
        violationCounts[code]++;
      }
    }
  }

  queueDurations.sort((a, b) => a - b);

  const acceptedOutcomes = acceptedWorkUnits.size;
  const verifiedAccountingCount = totalActions - estimatedOrMissingCount;
  const accountingComplete = totalActions > 0 && estimatedOrMissingCount === 0;
  const aiCreditsTotal = accountingComplete ? sums.aiCredits : null;
  const aiCreditsUsdCents = aiCreditsTotal === null ? null : aiCreditsTotal * AI_CREDIT_USD_CENTS;
  const incrementalBilledUsdCents = accountingComplete ? sums.incrementalCents : null;
  const confirmedIncrementalBilledUsdCents =
    verifiedAccountingCount > 0 ? sums.incrementalCents : null;
  const aiCreditsPerAcceptedOutcome =
    accountingComplete && acceptedOutcomes > 0 ? aiCreditsTotal / acceptedOutcomes : null;
  const cloudSandboxMinutes =
    accountingComplete && missingSandboxCount === 0 ? sums.sandboxMinutes : null;
  const actionsRunnerMinutes =
    accountingComplete && missingRunnerCount === 0 ? sums.runnerMinutes : null;

  const ghAwQueueLatencyMs = Object.freeze({
    p50: nearestRank(queueDurations, 0.5),
    p95: nearestRank(queueDurations, 0.95),
    sampleCount: queueDurations.length,
    unknownCount: queueUnknownCount
  });

  const mafComplete = totalActions > 0 && missingMafCount === 0;
  let reworkRateBps = null;
  if (mafComplete) {
    const reworkBig = (BigInt(sums.innerRepairs) * 20000n + BigInt(sums.supersteps)) /
      (2n * BigInt(sums.supersteps));
    if (reworkBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      return invalidScorecard('UNSAFE_AGGREGATE_TOTAL');
    }
    reworkRateBps = Number(reworkBig);
  }
  const mafTelemetry = Object.freeze({
    superstepsTotal: mafComplete ? sums.supersteps : null,
    checkpointResumes: mafComplete ? sums.checkpointResumes : null,
    innerRepairIterations: mafComplete ? sums.innerRepairs : null,
    reworkRateBps,
    missingCount: missingMafCount
  });

  const observedAuditCount = totalActions - missingAuditCount;
  const auditComplete = observedAuditCount === totalActions;
  const provenanceCompletenessPct =
    totalActions === 0 || !auditComplete ? null : (fullProvenanceActions * 100) / totalActions;
  const auditTraceability = Object.freeze({
    totalActions,
    observedAuditActions: observedAuditCount,
    auditComplete,
    fullProvenanceActions,
    provenanceCompletenessPct,
    killSwitchTrips: observedAuditCount > 0 ? killSwitchTrips : null,
    violationCounts: observedAuditCount > 0 ? Object.freeze(violationCounts) : null
  });

  const assembled = {
    acceptedOutcomes,
    acceptedActionRows,
    aiCreditsTotal,
    aiCreditsUsdCents,
    aiCreditsPerAcceptedOutcome,
    incrementalBilledUsdCents,
    confirmedIncrementalBilledUsdCents,
    estimatedOrMissingCount,
    cloudSandboxMinutes,
    actionsRunnerMinutes,
    ghAwQueueLatencyMs,
    mafTelemetry,
    auditTraceability
  };

  const bottlenecks = buildRankedBottlenecks(assembled, thresholdResult.thresholds);
  const complete = totalActions > 0 && estimatedOrMissingCount === 0 &&
    missingSandboxCount === 0 && missingRunnerCount === 0 &&
    queueUnknownCount === 0 && missingMafCount === 0 && missingAuditCount === 0;

  return Object.freeze({
    valid: true,
    shadow: true,
    readOnly: true,
    reason: complete ? 'MEASURED_AUTONOMOUS_SCORECARD' : 'PARTIAL_OR_EMPTY_AUTONOMOUS_EVIDENCE',
    repositoryId: input.repositoryId,
    cohort: input.cohort,
    sourceKind: 'verified-autonomous',
    autonomousClaimEligible: complete && acceptedOutcomes >= 5 &&
      incrementalBilledUsdCents === 0 && provenanceCompletenessPct === 100 && killSwitchTrips === 0,
    window: Object.freeze({
      fromMs: input.fromMs,
      toMs: input.toMs,
      observedMs: input.observedMs
    }),
    ...assembled,
    historicalProxySummary: null,
    bottlenecks
  });
}
