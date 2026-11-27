// Repeatable read-only T01-T04 historical GitHub timestamp proxy and verified
// autonomous OpenTelemetry evidence report generator (#9 / M01.06).
// Deterministic, metadata-only, read-only, fail-closed, with strict provenance
// quarantine and per-repository cohort authorization.
import {types} from 'node:util';
import {
  EXECUTION_RECEIPT_SCHEMA_VERSION,
  receiptStageRows
} from './telemetry.mjs';
import {
  SOFTWARE_FACTORY_REPOSITORY_ID,
  parseTraceparent
} from './anti-rogue-audit.mjs';
import {
  MIN_COMPARABLE_ACCEPTED_UNITS,
  THROUGHPUT_CHECKPOINTS
} from './outcome-measurement.mjs';

export {
  EXECUTION_RECEIPT_SCHEMA_VERSION,
  MIN_COMPARABLE_ACCEPTED_UNITS,
  SOFTWARE_FACTORY_REPOSITORY_ID,
  THROUGHPUT_CHECKPOINTS
};

export const HISTORICAL_OTEL_REPORT_SCHEMA_VERSION = 1;

export const SUPPORTED_COHORT_REPOSITORIES = Object.freeze([
  'SoftwareFactory',
  'FamilyTree',
  'Spellbook',
  'FamilyHub'
]);

export const ALLOWED_EXPLICIT_LINK_KINDS = Object.freeze([
  'closing-keyword',
  'timeline-cross-reference',
  'verified-receipt-binding'
]);

export const REJECTED_HEURISTIC_LINK_KINDS = Object.freeze([
  'title-similarity'
]);

export const HISTORICAL_PROXY_METRICS = Object.freeze([
  'issueCreatedToFirstPrMs',
  'issueCreatedToCloseMs',
  'prCreatedToMergeMs'
]);

export const AUTONOMOUS_OTEL_PROVENANCES = Object.freeze([
  'verified-autonomous-otel',
  'synthetic-otel-fixture'
]);

export const AUTONOMOUS_OTEL_OBJECTIVES = Object.freeze({
  issueReadyToFirstPrMs: Object.freeze({
    initialMs: 600000,
    stretchMs: 120000,
    strictLessInitial: false
  }),
  prToVerifiedMainMs: Object.freeze({
    initialMs: 900000,
    stretchMs: 300000,
    strictLessInitial: false
  }),
  issueReadyToOutcomeMs: Object.freeze({
    initialMs: 1500000,
    stretchMs: 420000,
    strictLessInitial: false
  }),
  standardAutomatedCiMs: Object.freeze({
    initialMs: 75000,
    stretchMs: 30000,
    strictLessInitial: true
  }),
  routineHumanInterventions: Object.freeze({
    initialMax: 0,
    stretchMax: 0
  })
});

const DAY_MS = 86400000;
const supportedRepoSet = new Set(SUPPORTED_COHORT_REPOSITORIES);
const explicitLinkKindSet = new Set(ALLOWED_EXPLICIT_LINK_KINDS);
const heuristicLinkKindSet = new Set(REJECTED_HEURISTIC_LINK_KINDS);
const otelProvenanceSet = new Set(AUTONOMOUS_OTEL_PROVENANCES);
const issueStateSet = new Set(['open', 'closed', 'unknown']);
const pullStateSet = new Set(['open', 'merged', 'closed-unmerged', 'unknown']);
const ciStateSet = new Set(['open', 'completed', 'unknown']);

const INPUT_REQUIRED_KEYS = [
  'query',
  'authorizedRepositories',
  'issues',
  'pulls',
  'links'
];
const INPUT_OPTIONAL_KEYS = ['otel', 'baseline'];

const QUERY_KEYS = [
  'repositoryKey',
  'repositoryId',
  'cohort',
  'fromMs',
  'toMs',
  'observedMs',
  'nowMs',
  'maxAgeMs',
  'historicalSourceComplete'
];

const AUTH_REPO_KEYS = [
  'repositoryKey',
  'repositoryId',
  'readAuthorized'
];

const ISSUE_REQUIRED_KEYS = [
  'repositoryId',
  'cohort',
  'number',
  'state',
  'createdAt',
  'closedAt',
  'reopenedCount',
  'lastReopenedAt'
];
const ISSUE_OPTIONAL_KEYS = [
  'readyAt',
  'acceptedAt',
  'acceptanceVerified',
  'requiredPullNumbers',
  'otelVerified'
];

const PULL_REQUIRED_KEYS = [
  'repositoryId',
  'cohort',
  'number',
  'state',
  'isDraft',
  'partial',
  'createdAt',
  'mergedAt',
  'closedAt'
];
const PULL_OPTIONAL_KEYS = [
  'mergeSha',
  'mainVerifiedSha',
  'mainVerified',
  'mainVerifiedAt',
  'otelVerified'
];

const LINK_REQUIRED_KEYS = [
  'repositoryId',
  'issueNumber',
  'pullNumber',
  'evidenceKind'
];
const LINK_OPTIONAL_KEYS = ['partial'];

const OTEL_REQUIRED_KEYS = [
  'provenance',
  'complete',
  'receipts',
  'ciRuns',
  'interventions'
];
const OTEL_OPTIONAL_KEYS = ['traceparents'];

const CI_RUN_KEYS = [
  'id',
  'repositoryId',
  'cohort',
  'pullNumber',
  'headSha',
  'state',
  'candidateEventAt',
  'startedAt',
  'completedAt',
  'traceparent'
];

const INTERVENTION_KEYS = [
  'repositoryId',
  'cohort',
  'issueNumber',
  'verified',
  'routineCount',
  'governanceCount'
];

const TRACEPARENT_BINDING_KEYS = ['receiptId', 'traceparent'];

const REPORT_SNAPSHOT_KEYS = [
  'schemaVersion',
  'reportKind',
  'valid',
  'shadow',
  'readOnly',
  'liveDispatch',
  'liveMerge',
  'createsSchedule',
  'reportingCadence',
  'reason',
  'repositoryKey',
  'repositoryId',
  'cohort',
  'window',
  'historicalProxies',
  'correlation',
  'throughput',
  'autonomousOtel',
  'baselineComparison'
];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !types.isProxy(value) &&
    !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasOwnEnumerableData(target, key) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor !== undefined && descriptor.enumerable === true && Object.hasOwn(descriptor, 'value');
}

function ownOption(target, key, fallback) {
  return hasOwnEnumerableData(target, key) ? target[key] : fallback;
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

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze(value[key]);
    }
  }
  return value;
}

const positiveInt = n => Number.isSafeInteger(n) && n > 0;
const nonnegInt = n => Number.isSafeInteger(n) && n >= 0;
const boundedCount = (n, max = 1000) => nonnegInt(n) && n <= max;
const validCohort = s => typeof s === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(s);
const validIdToken = s => typeof s === 'string' && /^[A-Za-z0-9._:-]{1,96}$/.test(s);
const sha40 = s => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
const validOptTimestamp = (ts, observedMs) =>
  ts === null || (nonnegInt(ts) && ts <= observedMs);

function validRepositoryBinding(repositoryKey, repositoryId) {
  if (!supportedRepoSet.has(repositoryKey) || !positiveInt(repositoryId)) return false;
  return (repositoryKey === 'SoftwareFactory') === (repositoryId === SOFTWARE_FACTORY_REPOSITORY_ID);
}

function isHistoricalProxyObject(value) {
  if (!isPlainObject(value)) return false;
  return ownOption(value, 'provenance', null) === 'historical-github-proxy' ||
    ownOption(value, 'nonAutonomousProxyOnly', false) === true;
}

function nearestRank(sorted, percentile) {
  if (sorted.length === 0) return null;
  return sorted[Math.ceil(percentile * sorted.length) - 1];
}

function summarizeDurations(durations) {
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    sampleCount: sorted.length,
    p50Ms: nearestRank(sorted, 0.5),
    p95Ms: nearestRank(sorted, 0.95),
    minMs: sorted.length > 0 ? sorted[0] : null,
    maxMs: sorted.length > 0 ? sorted[sorted.length - 1] : null
  };
}

function invalidReport(reason) {
  return deepFreeze({
    schemaVersion: HISTORICAL_OTEL_REPORT_SCHEMA_VERSION,
    reportKind: 'historical-and-otel-throughput-report',
    valid: false,
    shadow: true,
    readOnly: true,
    liveDispatch: false,
    liveMerge: false,
    createsSchedule: false,
    reportingCadence: 'existing-scorecard-cadence',
    reason
  });
}

function validateAuthorization(authorizedRepositories, query) {
  if (!denseDataArray(authorizedRepositories, 4) || authorizedRepositories.length === 0) {
    return {ok: false, reason: 'INVALID_AUTHORIZATION'};
  }
  const seenKeys = new Set();
  const seenIds = new Set();
  let matched = null;
  for (const entry of authorizedRepositories) {
    if (!exactRecord(entry, AUTH_REPO_KEYS) ||
        !validRepositoryBinding(entry.repositoryKey, entry.repositoryId) ||
        typeof entry.readAuthorized !== 'boolean' ||
        seenKeys.has(entry.repositoryKey) ||
        seenIds.has(entry.repositoryId)) {
      return {ok: false, reason: 'INVALID_AUTHORIZATION'};
    }
    seenKeys.add(entry.repositoryKey);
    seenIds.add(entry.repositoryId);
    if (entry.repositoryKey === query.repositoryKey && entry.repositoryId === query.repositoryId) {
      matched = entry;
    }
  }
  if (matched === null || matched.readAuthorized !== true) {
    return {ok: false, reason: 'REPOSITORY_NOT_AUTHORIZED'};
  }
  return {ok: true};
}

function parseIssues(rawIssues, query) {
  if (!denseDataArray(rawIssues, 2000)) return {ok: false, reason: 'INVALID_ISSUES'};
  const byNumber = new Map();
  const list = [];
  for (const raw of rawIssues) {
    if (!exactRecord(raw, ISSUE_REQUIRED_KEYS, ISSUE_OPTIONAL_KEYS)) {
      return {ok: false, reason: 'INVALID_ISSUE'};
    }
    if (raw.repositoryId !== query.repositoryId) {
      return {ok: false, reason: 'CROSS_REPOSITORY_CONTAMINATION'};
    }
    if (raw.cohort !== query.cohort) {
      return {ok: false, reason: 'COHORT_MISMATCH'};
    }
    const readyAt = ownOption(raw, 'readyAt', null);
    const acceptedAt = ownOption(raw, 'acceptedAt', null);
    const acceptanceVerified = ownOption(raw, 'acceptanceVerified', false);
    const requiredPullNumbers = ownOption(raw, 'requiredPullNumbers', null);
    const otelVerified = ownOption(raw, 'otelVerified', false);

    if (!positiveInt(raw.number) ||
        !issueStateSet.has(raw.state) ||
        !validOptTimestamp(raw.createdAt, query.observedMs) ||
        !validOptTimestamp(raw.closedAt, query.observedMs) ||
        !boundedCount(raw.reopenedCount, 1000) ||
        !validOptTimestamp(raw.lastReopenedAt, query.observedMs) ||
        !validOptTimestamp(readyAt, query.observedMs) ||
        !validOptTimestamp(acceptedAt, query.observedMs) ||
        typeof acceptanceVerified !== 'boolean' ||
        typeof otelVerified !== 'boolean') {
      return {ok: false, reason: 'INVALID_ISSUE'};
    }
    if (requiredPullNumbers !== null &&
        (!denseDataArray(requiredPullNumbers, 250) ||
         requiredPullNumbers.length === 0 ||
         !requiredPullNumbers.every(positiveInt) ||
         new Set(requiredPullNumbers).size !== requiredPullNumbers.length)) {
      return {ok: false, reason: 'INVALID_ISSUE'};
    }
    if (byNumber.has(raw.number)) {
      return {ok: false, reason: 'DUPLICATE_ISSUE'};
    }
    const normalized = {
      number: raw.number,
      state: raw.state,
      createdAt: raw.createdAt,
      closedAt: raw.closedAt,
      reopenedCount: raw.reopenedCount,
      lastReopenedAt: raw.lastReopenedAt,
      readyAt,
      acceptedAt,
      acceptanceVerified,
      requiredPullNumbers,
      otelVerified
    };
    byNumber.set(raw.number, normalized);
    list.push(normalized);
  }
  list.sort((a, b) => a.number - b.number);
  return {ok: true, byNumber, list};
}

function parsePulls(rawPulls, query) {
  if (!denseDataArray(rawPulls, 5000)) return {ok: false, reason: 'INVALID_PULLS'};
  const byNumber = new Map();
  const list = [];
  for (const raw of rawPulls) {
    if (!exactRecord(raw, PULL_REQUIRED_KEYS, PULL_OPTIONAL_KEYS)) {
      return {ok: false, reason: 'INVALID_PULL'};
    }
    if (raw.repositoryId !== query.repositoryId) {
      return {ok: false, reason: 'CROSS_REPOSITORY_CONTAMINATION'};
    }
    if (raw.cohort !== query.cohort) {
      return {ok: false, reason: 'COHORT_MISMATCH'};
    }
    const mergeSha = ownOption(raw, 'mergeSha', null);
    const mainVerifiedSha = ownOption(raw, 'mainVerifiedSha', null);
    const mainVerified = ownOption(raw, 'mainVerified', false);
    const mainVerifiedAt = ownOption(raw, 'mainVerifiedAt', null);
    const otelVerified = ownOption(raw, 'otelVerified', false);

    if (!positiveInt(raw.number) ||
        !pullStateSet.has(raw.state) ||
        typeof raw.isDraft !== 'boolean' ||
        typeof raw.partial !== 'boolean' ||
        !validOptTimestamp(raw.createdAt, query.observedMs) ||
        !validOptTimestamp(raw.mergedAt, query.observedMs) ||
        !validOptTimestamp(raw.closedAt, query.observedMs) ||
        (mergeSha !== null && !sha40(mergeSha)) ||
        (mainVerifiedSha !== null && !sha40(mainVerifiedSha)) ||
        typeof mainVerified !== 'boolean' ||
        !validOptTimestamp(mainVerifiedAt, query.observedMs) ||
        typeof otelVerified !== 'boolean') {
      return {ok: false, reason: 'INVALID_PULL'};
    }
    if (byNumber.has(raw.number)) {
      return {ok: false, reason: 'DUPLICATE_PULL'};
    }
    const normalized = {
      number: raw.number,
      state: raw.state,
      isDraft: raw.isDraft,
      partial: raw.partial,
      createdAt: raw.createdAt,
      mergedAt: raw.mergedAt,
      closedAt: raw.closedAt,
      mergeSha,
      mainVerifiedSha,
      mainVerified,
      mainVerifiedAt,
      otelVerified
    };
    byNumber.set(raw.number, normalized);
    list.push(normalized);
  }
  list.sort((a, b) => a.number - b.number);
  return {ok: true, byNumber, list};
}

function parseLinks(rawLinks, query, issuesByNumber, pullsByNumber) {
  if (!denseDataArray(rawLinks, 10000)) return {ok: false, reason: 'INVALID_LINKS'};
  const explicitByKey = new Map();
  const rejectedTitleSimilarityLinks = [];
  let deduplicatedExplicitLinks = 0;

  for (const raw of rawLinks) {
    if (!exactRecord(raw, LINK_REQUIRED_KEYS, LINK_OPTIONAL_KEYS)) {
      return {ok: false, reason: 'INVALID_LINK_EVIDENCE'};
    }
    if (raw.repositoryId !== query.repositoryId) {
      return {ok: false, reason: 'CROSS_REPOSITORY_CONTAMINATION'};
    }
    const linkPartial = ownOption(raw, 'partial', undefined);
    if (!positiveInt(raw.issueNumber) ||
        !positiveInt(raw.pullNumber) ||
        (linkPartial !== undefined && typeof linkPartial !== 'boolean')) {
      return {ok: false, reason: 'INVALID_LINK_EVIDENCE'};
    }
    if (heuristicLinkKindSet.has(raw.evidenceKind)) {
      rejectedTitleSimilarityLinks.push({
        issueNumber: raw.issueNumber,
        pullNumber: raw.pullNumber
      });
      continue;
    }
    if (!explicitLinkKindSet.has(raw.evidenceKind)) {
      return {ok: false, reason: 'INVALID_LINK_EVIDENCE'};
    }
    const pull = pullsByNumber.get(raw.pullNumber);
    if (pull !== undefined && linkPartial !== undefined && linkPartial !== pull.partial) {
      return {ok: false, reason: 'CONFLICTING_LINK_EVIDENCE'};
    }
    const effectivePartial = linkPartial !== undefined ? linkPartial : (pull !== undefined ? pull.partial : false);
    const key = `${raw.issueNumber}:${raw.pullNumber}`;
    const existing = explicitByKey.get(key);
    if (existing !== undefined) {
      if (existing.partial !== effectivePartial) {
        return {ok: false, reason: 'CONFLICTING_LINK_EVIDENCE'};
      }
      deduplicatedExplicitLinks++;
      continue;
    }
    explicitByKey.set(key, {
      issueNumber: raw.issueNumber,
      pullNumber: raw.pullNumber,
      evidenceKind: raw.evidenceKind,
      partial: effectivePartial
    });
  }

  const pullsByIssue = new Map();
  const issuesByPull = new Map();
  const danglingIssues = new Set();
  let danglingExplicitLinks = 0;

  for (const link of explicitByKey.values()) {
    const issue = issuesByNumber.get(link.issueNumber);
    const pull = pullsByNumber.get(link.pullNumber);
    if (issue === undefined || pull === undefined) {
      danglingExplicitLinks++;
      if (issue !== undefined) danglingIssues.add(issue.number);
      continue;
    }
    let issuePulls = pullsByIssue.get(issue.number);
    if (issuePulls === undefined) {
      issuePulls = [];
      pullsByIssue.set(issue.number, issuePulls);
    }
    issuePulls.push(pull);

    let pullIssues = issuesByPull.get(pull.number);
    if (pullIssues === undefined) {
      pullIssues = [];
      issuesByPull.set(pull.number, pullIssues);
    }
    pullIssues.push(issue.number);
  }

  for (const arr of pullsByIssue.values()) arr.sort((a, b) => a.number - b.number);
  for (const arr of issuesByPull.values()) arr.sort((a, b) => a - b);

  return {
    ok: true,
    explicitLinkCount: explicitByKey.size,
    deduplicatedExplicitLinks,
    danglingExplicitLinks,
    danglingIssues,
    rejectedTitleSimilarityLinks,
    pullsByIssue,
    issuesByPull
  };
}

function buildHistoricalProxySummaries(issues, pulls, linkGraph, query) {
  const firstPrDurations = [];
  const firstPrCounts = {cohort: 0, completed: 0, censored: 0, unknown: 0};

  const closeDurations = [];
  const closeCounts = {cohort: 0, completed: 0, censored: 0, reopenedInCohort: 0, unknown: 0};

  for (const issue of issues) {
    const reopenConsistent = (issue.lastReopenedAt !== null) === (issue.reopenedCount > 0);
    const linkedPulls = linkGraph.pullsByIssue.get(issue.number) ?? [];
    const hasDangling = linkGraph.danglingIssues.has(issue.number);

    if (issue.createdAt === null) {
      firstPrCounts.unknown++;
      closeCounts.unknown++;
      continue;
    }
    if (issue.createdAt < query.fromMs || issue.createdAt >= query.toMs) continue;

    // 1. Historical proxy: issueCreatedToFirstPrMs
    firstPrCounts.cohort++;
    if (issue.state === 'unknown' || hasDangling ||
        linkedPulls.some(p => p.createdAt === null || p.createdAt < issue.createdAt)) {
      firstPrCounts.unknown++;
    } else if (linkedPulls.length === 0) {
      if (issue.state === 'open' && issue.closedAt === null) firstPrCounts.censored++;
      else firstPrCounts.unknown++;
    } else {
      const earliestPrMs = Math.min(...linkedPulls.map(p => p.createdAt));
      if (earliestPrMs >= query.toMs) firstPrCounts.censored++;
      else {
        firstPrCounts.completed++;
        firstPrDurations.push(earliestPrMs - issue.createdAt);
      }
    }

    // 2. Historical proxy: issueCreatedToCloseMs
    closeCounts.cohort++;
    if (issue.reopenedCount > 0 || issue.lastReopenedAt !== null) {
      closeCounts.reopenedInCohort++;
    }
    if (!reopenConsistent || issue.state === 'unknown' ||
        (issue.lastReopenedAt !== null && issue.lastReopenedAt < issue.createdAt)) {
      closeCounts.unknown++;
    } else if (issue.state === 'open') {
      if (issue.closedAt !== null) closeCounts.unknown++;
      else closeCounts.censored++;
    } else if (issue.closedAt === null || issue.closedAt < issue.createdAt ||
               (issue.lastReopenedAt !== null && issue.closedAt < issue.lastReopenedAt)) {
      closeCounts.unknown++;
    } else if (issue.closedAt >= query.toMs) {
      closeCounts.censored++;
    } else {
      closeCounts.completed++;
      closeDurations.push(issue.closedAt - issue.createdAt);
    }
  }

  // 3. Historical proxy: prCreatedToMergeMs
  const mergeDurations = [];
  const mergeCounts = {cohort: 0, completed: 0, censored: 0, closedUnmerged: 0, unknown: 0};
  for (const pull of pulls) {
    if (pull.createdAt === null) {
      mergeCounts.unknown++;
      continue;
    }
    if (pull.createdAt < query.fromMs || pull.createdAt >= query.toMs) continue;
    mergeCounts.cohort++;
    if (pull.state === 'unknown') {
      mergeCounts.unknown++;
    } else if (pull.state === 'open') {
      if (pull.mergedAt !== null || pull.closedAt !== null) mergeCounts.unknown++;
      else mergeCounts.censored++;
    } else if (pull.state === 'closed-unmerged') {
      if (pull.mergedAt !== null || pull.closedAt === null || pull.closedAt < pull.createdAt) {
        mergeCounts.unknown++;
      } else if (pull.closedAt >= query.toMs) {
        mergeCounts.censored++;
      } else {
        mergeCounts.closedUnmerged++;
      }
    } else if (pull.mergedAt === null || pull.mergedAt < pull.createdAt ||
               (pull.closedAt !== null && pull.closedAt < pull.createdAt)) {
      mergeCounts.unknown++;
    } else if (pull.mergedAt >= query.toMs) {
      mergeCounts.censored++;
    } else {
      mergeCounts.completed++;
      mergeDurations.push(pull.mergedAt - pull.createdAt);
    }
  }

  const proxyStatus = (completedCount, unknownCount) => {
    if (completedCount === 0) return 'unknown';
    return !query.historicalSourceComplete || unknownCount > 0 ? 'partial' : 'measured-proxy';
  };

  return {
    provenance: 'historical-github-proxy',
    nonAutonomousProxyOnly: true,
    sloEligible: false,
    sourceComplete: query.historicalSourceComplete,
    issueCreatedToFirstPrMs: {
      metric: 'issueCreatedToFirstPrMs',
      status: proxyStatus(firstPrCounts.completed, firstPrCounts.unknown),
      counts: firstPrCounts,
      ...summarizeDurations(firstPrDurations)
    },
    issueCreatedToCloseMs: {
      metric: 'issueCreatedToCloseMs',
      establishesAcceptance: false,
      status: proxyStatus(closeCounts.completed, closeCounts.unknown),
      counts: closeCounts,
      ...summarizeDurations(closeDurations)
    },
    prCreatedToMergeMs: {
      metric: 'prCreatedToMergeMs',
      activityOnly: true,
      status: proxyStatus(mergeCounts.completed, mergeCounts.unknown),
      counts: mergeCounts,
      ...summarizeDurations(mergeDurations)
    }
  };
}

function isPullVerifiedOnMain(pull, acceptedAtCap) {
  return pull.state === 'merged' &&
    pull.createdAt !== null &&
    pull.mergedAt !== null &&
    pull.mergedAt >= pull.createdAt &&
    pull.mainVerified === true &&
    pull.mergeSha !== null &&
    pull.mainVerifiedSha === pull.mergeSha &&
    pull.mainVerifiedAt !== null &&
    pull.mainVerifiedAt >= pull.mergedAt &&
    pull.mainVerifiedAt <= acceptedAtCap;
}

function evaluateIssueCorrelation(issue, linkedPulls, hasDanglingLink) {
  const reopenConsistent = (issue.lastReopenedAt !== null) === (issue.reopenedCount > 0);
  const reopened = issue.reopenedCount > 0 || issue.lastReopenedAt !== null;
  const linkedMap = new Map(linkedPulls.map(p => [p.number, p]));

  const historicalFirstPrMs = issue.createdAt !== null && !hasDanglingLink && linkedPulls.length > 0 &&
    linkedPulls.every(p => p.createdAt !== null && p.createdAt >= issue.createdAt)
    ? Math.min(...linkedPulls.map(p => p.createdAt)) - issue.createdAt
    : null;

  const historicalCloseMs = issue.state === 'closed' && reopenConsistent &&
    issue.createdAt !== null && issue.closedAt !== null && issue.closedAt >= issue.createdAt &&
    (issue.lastReopenedAt === null ||
     (issue.lastReopenedAt >= issue.createdAt && issue.closedAt >= issue.lastReopenedAt))
    ? issue.closedAt - issue.createdAt
    : null;

  const autonomousFirstPrMs = issue.otelVerified && issue.readyAt !== null &&
    (issue.createdAt === null || issue.readyAt >= issue.createdAt) &&
    !hasDanglingLink && linkedPulls.length > 0 &&
    linkedPulls.every(p => p.otelVerified && p.createdAt !== null && p.createdAt >= issue.readyAt)
    ? Math.min(...linkedPulls.map(p => p.createdAt)) - issue.readyAt
    : null;

  if (!reopenConsistent || issue.state === 'unknown' || hasDanglingLink ||
      (issue.createdAt !== null && issue.readyAt !== null && issue.readyAt < issue.createdAt) ||
      (issue.createdAt !== null && issue.lastReopenedAt !== null && issue.lastReopenedAt < issue.createdAt)) {
    return {
      classification: 'unknown',
      reopened,
      historicalFirstPrMs,
      historicalCloseMs: null,
      autonomousFirstPrMs,
      readyToOutcomeMs: null,
      otelOutcomeVerified: false
    };
  }

  if (issue.state === 'open') {
    if (issue.closedAt !== null || issue.acceptedAt !== null || issue.acceptanceVerified) {
      return {
        classification: 'unknown',
        reopened,
        historicalFirstPrMs,
        historicalCloseMs: null,
        autonomousFirstPrMs,
        readyToOutcomeMs: null,
        otelOutcomeVerified: false
      };
    }
    return {
      classification: 'censored-open',
      reopened,
      historicalFirstPrMs,
      historicalCloseMs: null,
      autonomousFirstPrMs,
      readyToOutcomeMs: null,
      otelOutcomeVerified: false
    };
  }

  // issue.state === 'closed'
  const requiredPulls = issue.requiredPullNumbers !== null
    ? issue.requiredPullNumbers.map(num => linkedMap.get(num))
    : linkedPulls;
  const allRequiredExplicitlyLinked = requiredPulls.length > 0 && requiredPulls.every(p => p !== undefined);

  if (allRequiredExplicitlyLinked && requiredPulls.every(p => p.partial)) {
    return {
      classification: 'partial-only',
      reopened,
      historicalFirstPrMs,
      historicalCloseMs,
      autonomousFirstPrMs,
      readyToOutcomeMs: null,
      otelOutcomeVerified: false
    };
  }

  if (!issue.acceptanceVerified) {
    if (issue.acceptedAt !== null) {
      return {
        classification: 'unknown',
        reopened,
        historicalFirstPrMs,
        historicalCloseMs,
        autonomousFirstPrMs,
        readyToOutcomeMs: null,
        otelOutcomeVerified: false
      };
    }
    return {
      classification: reopened ? 'reopened-unaccepted' : 'unaccepted-closed',
      reopened,
      historicalFirstPrMs,
      historicalCloseMs,
      autonomousFirstPrMs,
      readyToOutcomeMs: null,
      otelOutcomeVerified: false
    };
  }

  // issue.acceptanceVerified === true
  if (issue.readyAt === null || issue.acceptedAt === null || issue.acceptedAt < issue.readyAt) {
    return {
      classification: 'unknown',
      reopened,
      historicalFirstPrMs,
      historicalCloseMs,
      autonomousFirstPrMs,
      readyToOutcomeMs: null,
      otelOutcomeVerified: false
    };
  }

  if (issue.lastReopenedAt !== null) {
    if (issue.lastReopenedAt < issue.readyAt) {
      return {
        classification: 'unknown',
        reopened,
        historicalFirstPrMs,
        historicalCloseMs,
        autonomousFirstPrMs,
        readyToOutcomeMs: null,
        otelOutcomeVerified: false
      };
    }
    if (issue.lastReopenedAt >= issue.acceptedAt) {
      return {
        classification: 'reopened-unaccepted',
        reopened,
        historicalFirstPrMs,
        historicalCloseMs,
        autonomousFirstPrMs,
        readyToOutcomeMs: null,
        otelOutcomeVerified: false
      };
    }
  }

  if (!allRequiredExplicitlyLinked || !requiredPulls.every(p => isPullVerifiedOnMain(p, issue.acceptedAt))) {
    return {
      classification: 'unknown',
      reopened,
      historicalFirstPrMs,
      historicalCloseMs,
      autonomousFirstPrMs,
      readyToOutcomeMs: null,
      otelOutcomeVerified: false
    };
  }

  const readyToOutcomeMs = issue.acceptedAt - issue.readyAt;
  const otelOutcomeVerified = issue.otelVerified && requiredPulls.every(p => p.otelVerified);
  return {
    classification: 'accepted',
    reopened,
    historicalFirstPrMs,
    historicalCloseMs,
    autonomousFirstPrMs,
    readyToOutcomeMs,
    otelOutcomeVerified
  };
}

function buildCorrelationAndThroughput(issues, pulls, linkGraph, query, hasOtel) {
  const multiPrIssueNumbers = [];
  const multiIssuePullNumbers = [];
  const unlinkedPullNumbers = [];
  const partialPullNumbers = [];
  const reopenedIssueNumbers = [];
  const issueOutcomes = [];

  for (const pull of pulls) {
    const linkedIssues = linkGraph.issuesByPull.get(pull.number) ?? [];
    if (linkedIssues.length === 0) unlinkedPullNumbers.push(pull.number);
    if (linkedIssues.length >= 2) multiIssuePullNumbers.push(pull.number);
    if (pull.partial) partialPullNumbers.push(pull.number);
  }

  const counts = {
    totalIssues: issues.length,
    acceptedIssues: 0,
    censoredOpenIssues: 0,
    partialOnlyIssues: 0,
    reopenedUnacceptedIssues: 0,
    unacceptedClosedIssues: 0,
    unknownIssues: 0,
    reopenedIssues: 0,
    multiPrIssues: 0,
    multiIssuePulls: multiIssuePullNumbers.length,
    unlinkedPulls: unlinkedPullNumbers.length,
    partialPulls: partialPullNumbers.length,
    explicitLinks: linkGraph.explicitLinkCount,
    deduplicatedExplicitLinks: linkGraph.deduplicatedExplicitLinks,
    danglingExplicitLinks: linkGraph.danglingExplicitLinks,
    rejectedTitleSimilarityLinks: linkGraph.rejectedTitleSimilarityLinks.length
  };

  let acceptedOutcomesInWindow = 0;
  let otelVerifiedAcceptedOutcomesInWindow = 0;
  let censoredOutcomesInWindow = 0;
  const acceptedInWindowIssues = [];
  const evaluatedByIssue = new Map();

  for (const issue of issues) {
    const linkedPulls = linkGraph.pullsByIssue.get(issue.number) ?? [];
    if (linkedPulls.length >= 2) {
      multiPrIssueNumbers.push(issue.number);
      counts.multiPrIssues++;
    }
    const evaluated = evaluateIssueCorrelation(
      issue,
      linkedPulls,
      linkGraph.danglingIssues.has(issue.number)
    );
    if (evaluated.reopened) {
      reopenedIssueNumbers.push(issue.number);
      counts.reopenedIssues++;
    }

    if (evaluated.classification === 'accepted') {
      counts.acceptedIssues++;
      if (issue.acceptedAt >= query.toMs) {
        if (issue.readyAt < query.toMs) censoredOutcomesInWindow++;
      } else if (issue.acceptedAt >= query.fromMs) {
        acceptedOutcomesInWindow++;
        if (hasOtel && evaluated.otelOutcomeVerified) {
          otelVerifiedAcceptedOutcomesInWindow++;
        }
        acceptedInWindowIssues.push({issue, evaluated});
      }
    } else if (evaluated.classification === 'censored-open') {
      counts.censoredOpenIssues++;
      if ((issue.readyAt !== null && issue.readyAt < query.toMs) ||
          (issue.readyAt === null && issue.createdAt !== null && issue.createdAt < query.toMs)) {
        censoredOutcomesInWindow++;
      }
    } else if (evaluated.classification === 'partial-only') {
      counts.partialOnlyIssues++;
    } else if (evaluated.classification === 'reopened-unaccepted') {
      counts.reopenedUnacceptedIssues++;
    } else if (evaluated.classification === 'unaccepted-closed') {
      counts.unacceptedClosedIssues++;
    } else {
      counts.unknownIssues++;
    }

    issueOutcomes.push({
      issueNumber: issue.number,
      state: issue.state,
      classification: evaluated.classification,
      reopened: evaluated.reopened,
      linkedPullNumbers: linkedPulls.map(p => p.number),
      partialPullNumbers: linkedPulls.filter(p => p.partial).map(p => p.number),
      historicalIssueCreatedToFirstPrMs: evaluated.historicalFirstPrMs,
      historicalIssueCreatedToCloseMs: evaluated.historicalCloseMs,
      autonomousIssueReadyToFirstPrMs: null,
      autonomousIssueReadyToOutcomeMs: null
    });
    evaluatedByIssue.set(issue.number, evaluated);
  }

  let mergedPullsInWindow = 0;
  for (const pull of pulls) {
    if (pull.state === 'merged' && pull.mergedAt !== null &&
        pull.mergedAt >= query.fromMs && pull.mergedAt < query.toMs) {
      mergedPullsInWindow++;
    }
  }

  const throughputComplete = query.historicalSourceComplete &&
    counts.unknownIssues === 0 &&
    counts.danglingExplicitLinks === 0;
  const elapsedDays = (query.toMs - query.fromMs) / DAY_MS;

  return {
    correlation: {
      manyToManyPresent: multiPrIssueNumbers.length > 0 || multiIssuePullNumbers.length > 0,
      multiPrIssueNumbers,
      multiIssuePullNumbers,
      unlinkedPullNumbers,
      partialPullNumbers,
      reopenedIssueNumbers,
      rejectedTitleSimilarityLinks: linkGraph.rejectedTitleSimilarityLinks,
      counts,
      issueOutcomes
    },
    throughput: {
      complete: throughputComplete,
      acceptedOutcomesInWindow,
      otelVerifiedAcceptedOutcomesInWindow,
      censoredOutcomesInWindow,
      unknownOutcomeCount: counts.unknownIssues,
      acceptedOutcomesPerDay: throughputComplete ? acceptedOutcomesInWindow / elapsedDays : null,
      otelVerifiedAcceptedOutcomesPerDay: throughputComplete && hasOtel
        ? otelVerifiedAcceptedOutcomesInWindow / elapsedDays
        : null,
      mergedPullsInWindow,
      mergedPullsActivityOnly: true,
      minimumComparableUnits: MIN_COMPARABLE_ACCEPTED_UNITS
    },
    acceptedInWindowIssues,
    evaluatedByIssue
  };
}

function emptyOtelTimingMetric(metric, spec, status) {
  return {
    metric,
    status,
    counts: {cohort: 0, completed: 0, censored: 0, unknown: 0},
    sampleCount: 0,
    p50Ms: null,
    p95Ms: null,
    minMs: null,
    maxMs: null,
    objectives: {
      initialMs: spec.initialMs,
      stretchMs: spec.stretchMs,
      strictLessInitial: spec.strictLessInitial
    },
    slo: {
      initialMissCount: 0,
      stretchMissCount: 0,
      overdueOpenCount: 0,
      p50MeetsInitial: null,
      p95MeetsInitial: null,
      p50MeetsStretch: null,
      p95MeetsStretch: null
    }
  };
}

function finalizeOtelTimingMetric(metric, spec, durations, counts, overdueOpenCount, otelComplete) {
  const stats = summarizeDurations(durations);
  const missesInitial = d => spec.strictLessInitial ? d >= spec.initialMs : d > spec.initialMs;
  const meetsInitial = d => spec.strictLessInitial ? d < spec.initialMs : d <= spec.initialMs;

  let initialMissCount = 0;
  let stretchMissCount = 0;
  for (const d of durations) {
    if (missesInitial(d)) initialMissCount++;
    if (d > spec.stretchMs) stretchMissCount++;
  }

  const partial = !otelComplete || counts.unknown > 0;
  const status = partial ? 'partial' : stats.sampleCount > 0 ? 'measured' : 'no-samples';
  const evaluable = !partial && stats.p50Ms !== null;

  return {
    metric,
    status,
    counts,
    ...stats,
    objectives: {
      initialMs: spec.initialMs,
      stretchMs: spec.stretchMs,
      strictLessInitial: spec.strictLessInitial
    },
    slo: {
      initialMissCount,
      stretchMissCount,
      overdueOpenCount,
      p50MeetsInitial: evaluable ? meetsInitial(stats.p50Ms) : null,
      p95MeetsInitial: evaluable ? meetsInitial(stats.p95Ms) : null,
      p50MeetsStretch: evaluable ? stats.p50Ms <= spec.stretchMs : null,
      p95MeetsStretch: evaluable ? stats.p95Ms <= spec.stretchMs : null
    }
  };
}

function buildNotProvidedOtel() {
  return {
    status: 'not-provided',
    provenance: null,
    complete: false,
    autonomousClaimEligible: false,
    issueReadyToFirstPrMs: emptyOtelTimingMetric(
      'issueReadyToFirstPrMs',
      AUTONOMOUS_OTEL_OBJECTIVES.issueReadyToFirstPrMs,
      'not-provided'
    ),
    prToVerifiedMainMs: emptyOtelTimingMetric(
      'prToVerifiedMainMs',
      AUTONOMOUS_OTEL_OBJECTIVES.prToVerifiedMainMs,
      'not-provided'
    ),
    issueReadyToOutcomeMs: emptyOtelTimingMetric(
      'issueReadyToOutcomeMs',
      AUTONOMOUS_OTEL_OBJECTIVES.issueReadyToOutcomeMs,
      'not-provided'
    ),
    standardAutomatedCiMs: {
      ...emptyOtelTimingMetric(
        'standardAutomatedCiMs',
        AUTONOMOUS_OTEL_OBJECTIVES.standardAutomatedCiMs,
        'not-provided'
      ),
      breakdown: {
        queueWaitMs: summarizeDurations([]),
        firstJobExecutionMs: summarizeDurations([])
      }
    },
    routineHumanInterventions: {
      status: 'not-provided',
      objective: AUTONOMOUS_OTEL_OBJECTIVES.routineHumanInterventions.initialMax,
      stretch: AUTONOMOUS_OTEL_OBJECTIVES.routineHumanInterventions.stretchMax,
      acceptedIssueCount: 0,
      knownIssueCount: 0,
      missingIssueCount: 0,
      totalRoutineCount: null,
      totalGovernanceCount: null,
      maxRoutinePerIssue: null,
      routinePerAcceptedIssue: null,
      zeroRoutineVerified: false,
      sloMet: null
    },
    receiptEvidence: null
  };
}

const receiptStageKeyMap = new Map([
  ['reconcile', 'reconcile'],
  ['dispatch', 'dispatch'],
  ['ci', 'ci'],
  ['review', 'review'],
  ['merge-shadow', 'mergeShadow'],
  ['verify-main', 'verifyMain'],
  ['acceptance', 'acceptance']
]);

function parseOtelReceipts(rawReceipts, rawTraceparents, expectedSource, query) {
  if (!denseDataArray(rawReceipts, 5000)) return {ok: false, reason: 'INVALID_OTEL_RECEIPTS'};
  if (rawTraceparents !== null && !denseDataArray(rawTraceparents, 5000)) {
    return {ok: false, reason: 'INVALID_OTEL_TRACEPARENT'};
  }

  const receiptsById = new Map();
  const stageRows = [];
  const outcomeCounts = {eligible: 0, blocked: 0, failed: 0, unknown: 0};
  const blockedByReason = {};
  const stageEventCounts = {
    reconcile: 0,
    dispatch: 0,
    ci: 0,
    review: 0,
    mergeShadow: 0,
    verifyMain: 0,
    acceptance: 0
  };
  let correlatedReceiptCount = 0;
  let uncorrelatedReceiptCount = 0;
  let verifiedIncludedQuotaCount = 0;
  let exhaustedQuotaCount = 0;
  let unknownQuotaCount = 0;
  let verifiedZeroCostCount = 0;
  let unknownCostCount = 0;

  for (const receipt of rawReceipts) {
    if (isHistoricalProxyObject(receipt)) {
      return {ok: false, reason: 'PROVENANCE_ISOLATION_VIOLATION'};
    }
    const projected = receiptStageRows(receipt);
    if (!projected.valid) return {ok: false, reason: 'INVALID_OTEL_RECEIPT'};
    if (receipt.repositoryId !== query.repositoryId) {
      return {ok: false, reason: 'CROSS_REPOSITORY_CONTAMINATION'};
    }
    if (receipt.source !== expectedSource) {
      return {ok: false, reason: 'PROVENANCE_ISOLATION_VIOLATION'};
    }
    if (receipt.observedMs > query.observedMs) {
      return {ok: false, reason: 'INVALID_OTEL_RECEIPT'};
    }
    if (receiptsById.has(receipt.receiptId)) {
      return {ok: false, reason: 'DUPLICATE_OTEL_RECEIPT'};
    }
    receiptsById.set(receipt.receiptId, receipt);

    if (receipt.observedMs < query.fromMs || receipt.observedMs >= query.toMs) continue;

    stageRows.push(...projected.rows);
    outcomeCounts[receipt.outcome]++;
    if (receipt.outcome === 'blocked') {
      blockedByReason[receipt.reason] = (blockedByReason[receipt.reason] ?? 0) + 1;
    }
    const stageCounterKey = receiptStageKeyMap.get(receipt.stage);
    if (stageCounterKey !== undefined) stageEventCounts[stageCounterKey]++;

    if (receipt.correlation.traceId !== null) correlatedReceiptCount++;
    else uncorrelatedReceiptCount++;

    if (receipt.quota.state === 'verified-included') verifiedIncludedQuotaCount++;
    else if (receipt.quota.state === 'exhausted') exhaustedQuotaCount++;
    else unknownQuotaCount++;

    if (receipt.cost.state === 'verified-zero') verifiedZeroCostCount++;
    else unknownCostCount++;
  }

  let verifiedTraceparentCount = 0;
  if (rawTraceparents !== null) {
    const seenBindings = new Set();
    for (const binding of rawTraceparents) {
      if (!exactRecord(binding, TRACEPARENT_BINDING_KEYS)) {
        return {ok: false, reason: 'INVALID_OTEL_TRACEPARENT'};
      }
      const parsed = parseTraceparent(binding.traceparent);
      const targetReceipt = receiptsById.get(binding.receiptId);
      if (!parsed.valid ||
          targetReceipt === undefined ||
          seenBindings.has(binding.receiptId) ||
          targetReceipt.correlation.traceId !== parsed.traceId ||
          targetReceipt.correlation.spanId !== parsed.spanId) {
        return {ok: false, reason: 'INVALID_OTEL_TRACEPARENT'};
      }
      seenBindings.add(binding.receiptId);
      verifiedTraceparentCount++;
    }
  }

  return {
    ok: true,
    receiptEvidence: {
      schemaVersion: EXECUTION_RECEIPT_SCHEMA_VERSION,
      source: expectedSource,
      inWindowReceiptCount: correlatedReceiptCount + uncorrelatedReceiptCount,
      correlatedReceiptCount,
      uncorrelatedReceiptCount,
      verifiedTraceparentCount,
      stageEventCounts,
      outcomeCounts,
      blockedByReason,
      quota: {
        verifiedIncludedCount: verifiedIncludedQuotaCount,
        exhaustedCount: exhaustedQuotaCount,
        unknownCount: unknownQuotaCount
      },
      cost: {
        verifiedZeroCount: verifiedZeroCostCount,
        unknownCount: unknownCostCount
      },
      stageRows
    }
  };
}

function parseCiRuns(rawCiRuns, query) {
  if (!denseDataArray(rawCiRuns, 5000)) return {ok: false, reason: 'INVALID_CI_RUNS'};
  const seen = new Map();
  const durations = [];
  const queueDurations = [];
  const executionDurations = [];
  const completedPullHeads = new Set();
  const counts = {cohort: 0, completed: 0, censored: 0, unknown: 0};
  const spec = AUTONOMOUS_OTEL_OBJECTIVES.standardAutomatedCiMs;
  let overdueOpenCount = 0;

  for (const run of rawCiRuns) {
    if (isHistoricalProxyObject(run)) {
      return {ok: false, reason: 'PROVENANCE_ISOLATION_VIOLATION'};
    }
    if (!exactRecord(run, CI_RUN_KEYS)) return {ok: false, reason: 'INVALID_CI_RUN'};
    if (run.repositoryId !== query.repositoryId) {
      return {ok: false, reason: 'CROSS_REPOSITORY_CONTAMINATION'};
    }
    if (run.cohort !== query.cohort) {
      return {ok: false, reason: 'COHORT_MISMATCH'};
    }
    if (!validIdToken(run.id) ||
        !positiveInt(run.pullNumber) ||
        !sha40(run.headSha) ||
        !ciStateSet.has(run.state) ||
        !validOptTimestamp(run.candidateEventAt, query.observedMs) ||
        !validOptTimestamp(run.startedAt, query.observedMs) ||
        !validOptTimestamp(run.completedAt, query.observedMs)) {
      return {ok: false, reason: 'INVALID_CI_RUN'};
    }
    if (run.traceparent !== null && !parseTraceparent(run.traceparent).valid) {
      return {ok: false, reason: 'INVALID_OTEL_TRACEPARENT'};
    }

    const prior = seen.get(run.id);
    if (prior !== undefined) {
      if (prior.pullNumber !== run.pullNumber ||
          prior.headSha !== run.headSha ||
          prior.state !== run.state ||
          prior.candidateEventAt !== run.candidateEventAt ||
          prior.startedAt !== run.startedAt ||
          prior.completedAt !== run.completedAt ||
          prior.traceparent !== run.traceparent) {
        return {ok: false, reason: 'CONFLICTING_CI_EVIDENCE'};
      }
      continue;
    }
    seen.set(run.id, run);

    if (run.candidateEventAt === null) {
      counts.unknown++;
      continue;
    }
    if (run.candidateEventAt < query.fromMs || run.candidateEventAt >= query.toMs) continue;

    counts.cohort++;
    if (run.state === 'unknown' ||
        (run.startedAt !== null && run.startedAt < run.candidateEventAt)) {
      counts.unknown++;
    } else if (run.state === 'open') {
      if (run.completedAt !== null) counts.unknown++;
      else {
        counts.censored++;
        if (query.observedMs - run.candidateEventAt >= spec.initialMs) overdueOpenCount++;
      }
    } else if (run.startedAt === null || run.completedAt === null || run.completedAt < run.startedAt) {
      counts.unknown++;
    } else if (run.completedAt >= query.toMs) {
      counts.censored++;
    } else {
      counts.completed++;
      durations.push(run.completedAt - run.candidateEventAt);
      queueDurations.push(run.startedAt - run.candidateEventAt);
      executionDurations.push(run.completedAt - run.startedAt);
      completedPullHeads.add(`${run.pullNumber}:${run.headSha}`);
    }
  }

  return {
    ok: true,
    durations,
    queueDurations,
    executionDurations,
    completedPullHeads,
    counts,
    overdueOpenCount
  };
}

function parseInterventions(rawInterventions, acceptedInWindowIssues, otelComplete, query) {
  if (!denseDataArray(rawInterventions, 2000)) {
    return {ok: false, reason: 'INVALID_INTERVENTIONS'};
  }
  const byIssue = new Map();
  for (const row of rawInterventions) {
    if (isHistoricalProxyObject(row)) {
      return {ok: false, reason: 'PROVENANCE_ISOLATION_VIOLATION'};
    }
    if (!exactRecord(row, INTERVENTION_KEYS)) {
      return {ok: false, reason: 'INVALID_INTERVENTION_EVIDENCE'};
    }
    if (row.repositoryId !== query.repositoryId) {
      return {ok: false, reason: 'CROSS_REPOSITORY_CONTAMINATION'};
    }
    if (row.cohort !== query.cohort) {
      return {ok: false, reason: 'COHORT_MISMATCH'};
    }
    if (!positiveInt(row.issueNumber) || typeof row.verified !== 'boolean') {
      return {ok: false, reason: 'INVALID_INTERVENTION_EVIDENCE'};
    }
    if (row.verified) {
      if (!boundedCount(row.routineCount, 1000) || !boundedCount(row.governanceCount, 1000)) {
        return {ok: false, reason: 'INVALID_INTERVENTION_EVIDENCE'};
      }
    } else if (row.routineCount !== null || row.governanceCount !== null) {
      return {ok: false, reason: 'INVALID_INTERVENTION_EVIDENCE'};
    }
    if (byIssue.has(row.issueNumber)) {
      return {ok: false, reason: 'DUPLICATE_INTERVENTION_EVIDENCE'};
    }
    byIssue.set(row.issueNumber, row);
  }

  const acceptedCount = acceptedInWindowIssues.length;
  if (acceptedCount === 0) {
    return {
      ok: true,
      summary: {
        status: 'no-accepted-units',
        objective: AUTONOMOUS_OTEL_OBJECTIVES.routineHumanInterventions.initialMax,
        stretch: AUTONOMOUS_OTEL_OBJECTIVES.routineHumanInterventions.stretchMax,
        acceptedIssueCount: 0,
        knownIssueCount: 0,
        missingIssueCount: 0,
        totalRoutineCount: null,
        totalGovernanceCount: null,
        maxRoutinePerIssue: null,
        routinePerAcceptedIssue: null,
        zeroRoutineVerified: false,
        sloMet: null
      }
    };
  }

  let knownIssueCount = 0;
  let totalRoutine = 0;
  let totalGovernance = 0;
  let maxRoutine = 0;

  for (const {issue, evaluated} of acceptedInWindowIssues) {
    const rec = byIssue.get(issue.number);
    if (evaluated.otelOutcomeVerified && rec !== undefined && rec.verified) {
      knownIssueCount++;
      totalRoutine += rec.routineCount;
      totalGovernance += rec.governanceCount;
      if (rec.routineCount > maxRoutine) maxRoutine = rec.routineCount;
    }
  }

  const missingIssueCount = acceptedCount - knownIssueCount;
  const allMeasured = otelComplete && missingIssueCount === 0;
  return {
    ok: true,
    summary: {
      status: allMeasured ? 'measured' : knownIssueCount > 0 ? 'partial' : 'unknown',
      objective: AUTONOMOUS_OTEL_OBJECTIVES.routineHumanInterventions.initialMax,
      stretch: AUTONOMOUS_OTEL_OBJECTIVES.routineHumanInterventions.stretchMax,
      acceptedIssueCount: acceptedCount,
      knownIssueCount,
      missingIssueCount,
      totalRoutineCount: allMeasured ? totalRoutine : null,
      totalGovernanceCount: allMeasured ? totalGovernance : null,
      maxRoutinePerIssue: allMeasured ? maxRoutine : null,
      routinePerAcceptedIssue: allMeasured ? totalRoutine / acceptedCount : null,
      zeroRoutineVerified: allMeasured && totalRoutine === 0,
      sloMet: allMeasured ? totalRoutine === 0 : null
    }
  };
}

function buildAutonomousOtelSection(rawOtel, issues, pulls, linkGraph, correlationResult, query) {
  if (rawOtel === null) {
    return {ok: true, section: buildNotProvidedOtel()};
  }

  if (isHistoricalProxyObject(rawOtel)) {
    return {ok: false, reason: 'PROVENANCE_ISOLATION_VIOLATION'};
  }
  if (!exactRecord(rawOtel, OTEL_REQUIRED_KEYS, OTEL_OPTIONAL_KEYS) ||
      typeof rawOtel.complete !== 'boolean') {
    return {ok: false, reason: 'INVALID_OTEL_EVIDENCE'};
  }
  if (!otelProvenanceSet.has(rawOtel.provenance)) {
    return {ok: false, reason: 'INVALID_OTEL_EVIDENCE'};
  }

  const expectedReceiptSource = rawOtel.provenance === 'verified-autonomous-otel'
    ? 'github-hosted'
    : 'synthetic';
  const rawTraceparents = ownOption(rawOtel, 'traceparents', null);
  const receiptResult = parseOtelReceipts(
    rawOtel.receipts,
    rawTraceparents,
    expectedReceiptSource,
    query
  );
  if (!receiptResult.ok) return receiptResult;

  const ciResult = parseCiRuns(rawOtel.ciRuns, query);
  if (!ciResult.ok) return ciResult;

  // Populate per-issue autonomous fields when OTel section is active
  for (const item of correlationResult.correlation.issueOutcomes) {
    const evaluated = correlationResult.evaluatedByIssue.get(item.issueNumber);
    item.autonomousIssueReadyToFirstPrMs = evaluated.autonomousFirstPrMs;
    item.autonomousIssueReadyToOutcomeMs = evaluated.otelOutcomeVerified
      ? evaluated.readyToOutcomeMs
      : null;
  }

  // 1. issueReadyToFirstPrMs (<=10m / 2m stretch)
  const readyFirstPrSpec = AUTONOMOUS_OTEL_OBJECTIVES.issueReadyToFirstPrMs;
  const readyFirstPrDurations = [];
  const readyFirstPrCounts = {cohort: 0, completed: 0, censored: 0, unknown: 0};
  let readyFirstPrOverdue = 0;

  // 2. issueReadyToOutcomeMs (<=25m / 7m stretch)
  const outcomeSpec = AUTONOMOUS_OTEL_OBJECTIVES.issueReadyToOutcomeMs;
  const outcomeDurations = [];
  const outcomeCounts = {cohort: 0, completed: 0, censored: 0, partialOnly: 0, unknown: 0};
  let outcomeOverdue = 0;
  const otelAcceptedInWindow = [];

  for (const issue of issues) {
    if (!issue.otelVerified) continue;
    const linkedPulls = linkGraph.pullsByIssue.get(issue.number) ?? [];
    const hasDangling = linkGraph.danglingIssues.has(issue.number);
    const evaluated = correlationResult.evaluatedByIssue.get(issue.number);

    // issueReadyToFirstPrMs cohort: readyAt in [fromMs, toMs) (or missing/invalid readyAt -> unknown)
    if (issue.readyAt === null || (issue.createdAt !== null && issue.readyAt < issue.createdAt)) {
      readyFirstPrCounts.unknown++;
    } else if (issue.readyAt >= query.fromMs && issue.readyAt < query.toMs) {
      readyFirstPrCounts.cohort++;
      if (issue.state === 'unknown' || hasDangling ||
          linkedPulls.some(p => !p.otelVerified || p.createdAt === null || p.createdAt < issue.readyAt)) {
        readyFirstPrCounts.unknown++;
      } else if (linkedPulls.length === 0) {
        if (evaluated.classification === 'censored-open') {
          readyFirstPrCounts.censored++;
          if (query.observedMs - issue.readyAt > readyFirstPrSpec.initialMs) readyFirstPrOverdue++;
        } else {
          readyFirstPrCounts.unknown++;
        }
      } else {
        const firstPrAt = Math.min(...linkedPulls.map(p => p.createdAt));
        if (firstPrAt >= query.toMs) readyFirstPrCounts.censored++;
        else {
          readyFirstPrCounts.completed++;
          readyFirstPrDurations.push(firstPrAt - issue.readyAt);
        }
      }
    }

    // issueReadyToOutcomeMs
    if (issue.readyAt === null || (issue.createdAt !== null && issue.readyAt < issue.createdAt)) {
      outcomeCounts.unknown++;
    } else if (evaluated.classification === 'censored-open') {
      if (issue.readyAt < query.toMs) {
        outcomeCounts.cohort++;
        outcomeCounts.censored++;
        if (query.observedMs - issue.readyAt > outcomeSpec.initialMs) outcomeOverdue++;
      }
    } else if (evaluated.classification === 'partial-only') {
      if (issue.readyAt < query.toMs) {
        outcomeCounts.cohort++;
        outcomeCounts.partialOnly++;
      }
    } else if (evaluated.classification === 'accepted' && evaluated.otelOutcomeVerified) {
      if (issue.acceptedAt >= query.toMs) {
        if (issue.readyAt < query.toMs) {
          outcomeCounts.cohort++;
          outcomeCounts.censored++;
        }
      } else if (issue.acceptedAt >= query.fromMs) {
        outcomeCounts.cohort++;
        outcomeCounts.completed++;
        outcomeDurations.push(evaluated.readyToOutcomeMs);
        otelAcceptedInWindow.push({issue});
      }
    } else {
      outcomeCounts.cohort++;
      outcomeCounts.unknown++;
    }
  }

  // 3. prToVerifiedMainMs (<=15m / 5m stretch)
  const prMainSpec = AUTONOMOUS_OTEL_OBJECTIVES.prToVerifiedMainMs;
  const prMainDurations = [];
  const prMainCounts = {cohort: 0, completed: 0, censored: 0, closedUnmerged: 0, unknown: 0};
  let prMainOverdue = 0;

  for (const pull of pulls) {
    if (!pull.otelVerified) continue;
    if (pull.createdAt === null) {
      prMainCounts.unknown++;
      continue;
    }
    if (pull.createdAt < query.fromMs || pull.createdAt >= query.toMs) continue;
    prMainCounts.cohort++;
    if (pull.state === 'unknown') {
      prMainCounts.unknown++;
    } else if (pull.state === 'open') {
      if (pull.mergedAt !== null || pull.closedAt !== null || pull.mainVerifiedAt !== null) {
        prMainCounts.unknown++;
      } else {
        prMainCounts.censored++;
        if (query.observedMs - pull.createdAt > prMainSpec.initialMs) prMainOverdue++;
      }
    } else if (pull.state === 'closed-unmerged') {
      if (pull.mergedAt !== null || pull.closedAt === null || pull.closedAt < pull.createdAt) {
        prMainCounts.unknown++;
      } else if (pull.closedAt >= query.toMs) {
        prMainCounts.censored++;
      } else {
        prMainCounts.closedUnmerged++;
      }
    } else if (!isPullVerifiedOnMain(pull, query.observedMs)) {
      prMainCounts.unknown++;
    } else if (pull.mainVerifiedAt >= query.toMs) {
      prMainCounts.censored++;
    } else {
      prMainCounts.completed++;
      prMainDurations.push(pull.mainVerifiedAt - pull.createdAt);
    }
  }

  const pullsByNumber = new Map(pulls.map(p => [p.number, p]));
  const interventionsResult = parseInterventions(
    rawOtel.interventions,
    correlationResult.acceptedInWindowIssues,
    rawOtel.complete,
    query
  );
  if (!interventionsResult.ok) return interventionsResult;

  const issueReadyToFirstPrMs = finalizeOtelTimingMetric(
    'issueReadyToFirstPrMs',
    readyFirstPrSpec,
    readyFirstPrDurations,
    readyFirstPrCounts,
    readyFirstPrOverdue,
    rawOtel.complete
  );
  const prToVerifiedMainMs = finalizeOtelTimingMetric(
    'prToVerifiedMainMs',
    prMainSpec,
    prMainDurations,
    prMainCounts,
    prMainOverdue,
    rawOtel.complete
  );
  const issueReadyToOutcomeMs = finalizeOtelTimingMetric(
    'issueReadyToOutcomeMs',
    outcomeSpec,
    outcomeDurations,
    outcomeCounts,
    outcomeOverdue,
    rawOtel.complete
  );
  const standardAutomatedCiMs = {
    ...finalizeOtelTimingMetric(
      'standardAutomatedCiMs',
      AUTONOMOUS_OTEL_OBJECTIVES.standardAutomatedCiMs,
      ciResult.durations,
      ciResult.counts,
      ciResult.overdueOpenCount,
      rawOtel.complete
    ),
    breakdown: {
      queueWaitMs: summarizeDurations(ciResult.queueDurations),
      firstJobExecutionMs: summarizeDurations(ciResult.executionDurations)
    }
  };

  const zeroUnknownTimings = readyFirstPrCounts.unknown === 0 &&
    prMainCounts.unknown === 0 &&
    outcomeCounts.unknown === 0 &&
    ciResult.counts.unknown === 0;
  const otelStatus = rawOtel.complete && zeroUnknownTimings ? 'measured' : 'partial';

  const allRequiredPullsCiVerified = otelAcceptedInWindow.every(({issue}) => {
    const reqPulls = issue.requiredPullNumbers !== null
      ? issue.requiredPullNumbers.map(num => pullsByNumber.get(num))
      : linkGraph.pullsByIssue.get(issue.number);
    return reqPulls.every(p => ciResult.completedPullHeads.has(`${p.number}:${p.mergeSha}`));
  });
  const ev = receiptResult.receiptEvidence;
  const affirmativeReceipts = ev.inWindowReceiptCount >= otelAcceptedInWindow.length &&
    ev.stageEventCounts.dispatch > 0 &&
    ev.stageEventCounts.ci > 0 &&
    ev.stageEventCounts.verifyMain > 0 &&
    ev.stageEventCounts.acceptance >= otelAcceptedInWindow.length &&
    ev.uncorrelatedReceiptCount === 0 &&
    ev.outcomeCounts.failed === 0 &&
    ev.outcomeCounts.unknown === 0 &&
    ev.quota.verifiedIncludedCount === ev.inWindowReceiptCount &&
    ev.cost.verifiedZeroCount === ev.inWindowReceiptCount;
  const pureOtelPopulation = correlationResult.throughput.otelVerifiedAcceptedOutcomesInWindow ===
    correlationResult.throughput.acceptedOutcomesInWindow;

  const autonomousClaimEligible = rawOtel.provenance === 'verified-autonomous-otel' &&
    otelStatus === 'measured' &&
    correlationResult.throughput.complete &&
    pureOtelPopulation &&
    otelAcceptedInWindow.length >= MIN_COMPARABLE_ACCEPTED_UNITS &&
    allRequiredPullsCiVerified &&
    affirmativeReceipts &&
    interventionsResult.summary.zeroRoutineVerified;

  return {
    ok: true,
    section: {
      status: otelStatus,
      provenance: rawOtel.provenance,
      complete: rawOtel.complete,
      autonomousClaimEligible,
      issueReadyToFirstPrMs,
      prToVerifiedMainMs,
      issueReadyToOutcomeMs,
      standardAutomatedCiMs,
      routineHumanInterventions: interventionsResult.summary,
      receiptEvidence: receiptResult.receiptEvidence
    }
  };
}

const SNAPSHOT_WINDOW_KEYS = ['fromMs', 'toMs', 'observedMs', 'elapsedDays'];
const SNAPSHOT_THROUGHPUT_KEYS = [
  'complete',
  'acceptedOutcomesInWindow',
  'otelVerifiedAcceptedOutcomesInWindow',
  'censoredOutcomesInWindow',
  'unknownOutcomeCount',
  'acceptedOutcomesPerDay',
  'otelVerifiedAcceptedOutcomesPerDay',
  'mergedPullsInWindow',
  'mergedPullsActivityOnly',
  'minimumComparableUnits'
];
const SNAPSHOT_OTEL_KEYS = [
  'status',
  'provenance',
  'complete',
  'autonomousClaimEligible',
  'issueReadyToFirstPrMs',
  'prToVerifiedMainMs',
  'issueReadyToOutcomeMs',
  'standardAutomatedCiMs',
  'routineHumanInterventions',
  'receiptEvidence'
];
const SNAPSHOT_INTERVENTION_KEYS = [
  'status',
  'objective',
  'stretch',
  'acceptedIssueCount',
  'knownIssueCount',
  'missingIssueCount',
  'totalRoutineCount',
  'totalGovernanceCount',
  'maxRoutinePerIssue',
  'routinePerAcceptedIssue',
  'zeroRoutineVerified',
  'sloMet'
];

function validBaselineSnapshot(baseline) {
  if (!exactRecord(baseline, REPORT_SNAPSHOT_KEYS) ||
      baseline.schemaVersion !== HISTORICAL_OTEL_REPORT_SCHEMA_VERSION ||
      baseline.valid !== true ||
      !validRepositoryBinding(baseline.repositoryKey, baseline.repositoryId) ||
      !validCohort(baseline.cohort) ||
      !exactRecord(baseline.window, SNAPSHOT_WINDOW_KEYS) ||
      !nonnegInt(baseline.window.fromMs) ||
      !nonnegInt(baseline.window.toMs) ||
      baseline.window.fromMs >= baseline.window.toMs ||
      !exactRecord(baseline.throughput, SNAPSHOT_THROUGHPUT_KEYS) ||
      typeof baseline.throughput.complete !== 'boolean' ||
      !nonnegInt(baseline.throughput.acceptedOutcomesInWindow) ||
      !nonnegInt(baseline.throughput.otelVerifiedAcceptedOutcomesInWindow) ||
      baseline.throughput.otelVerifiedAcceptedOutcomesInWindow > baseline.throughput.acceptedOutcomesInWindow ||
      !exactRecord(baseline.autonomousOtel, SNAPSHOT_OTEL_KEYS) ||
      (baseline.autonomousOtel.provenance !== null &&
       !otelProvenanceSet.has(baseline.autonomousOtel.provenance)) ||
      typeof baseline.autonomousOtel.autonomousClaimEligible !== 'boolean' ||
      !exactRecord(baseline.autonomousOtel.routineHumanInterventions, SNAPSHOT_INTERVENTION_KEYS) ||
      typeof baseline.autonomousOtel.routineHumanInterventions.zeroRoutineVerified !== 'boolean') {
    return false;
  }
  const expectedElapsedDays = (baseline.window.toMs - baseline.window.fromMs) / DAY_MS;
  if (baseline.window.elapsedDays !== expectedElapsedDays) return false;
  if (!baseline.throughput.complete) {
    return baseline.throughput.acceptedOutcomesPerDay === null &&
      baseline.throughput.otelVerifiedAcceptedOutcomesPerDay === null;
  }
  const expectedRate = baseline.throughput.acceptedOutcomesInWindow / expectedElapsedDays;
  const expectedOtelRate = baseline.autonomousOtel.provenance !== null
    ? baseline.throughput.otelVerifiedAcceptedOutcomesInWindow / expectedElapsedDays
    : null;
  return baseline.throughput.acceptedOutcomesPerDay === expectedRate &&
    baseline.throughput.otelVerifiedAcceptedOutcomesPerDay === expectedOtelRate;
}

function evaluateBaselineComparison(baseline, currentReport) {
  if (baseline === null) return {ok: true, comparison: null};
  if (isHistoricalProxyObject(baseline)) {
    return {ok: false, reason: 'PROVENANCE_ISOLATION_VIOLATION'};
  }
  if (!validBaselineSnapshot(baseline)) {
    return {ok: false, reason: 'INVALID_BASELINE_REPORT'};
  }

  const baseProv = baseline.autonomousOtel.provenance;
  const currProv = currentReport.autonomousOtel.provenance;
  if (baseProv !== null && currProv !== null && baseProv !== currProv) {
    return {ok: false, reason: 'PROVENANCE_ISOLATION_VIOLATION'};
  }

  const baseOtelOutcomes = baseline.throughput.otelVerifiedAcceptedOutcomesInWindow;
  const currOtelOutcomes = currentReport.throughput.otelVerifiedAcceptedOutcomesInWindow;

  const unavailable = reason => ({
    comparable: false,
    reason,
    autonomousSpeedClaimEligible: false,
    baselineAcceptedOutcomes: baseOtelOutcomes,
    currentAcceptedOutcomes: currOtelOutcomes,
    throughputMultiplier: null,
    reachedCheckpoints: [],
    highestCheckpointReached: null
  });

  if (baseline.repositoryKey !== currentReport.repositoryKey ||
      baseline.repositoryId !== currentReport.repositoryId ||
      baseline.cohort !== currentReport.cohort) {
    return {ok: true, comparison: unavailable('SCOPE_MISMATCH')};
  }

  if (baseProv === null || currProv === null) {
    return {ok: true, comparison: unavailable('AUTONOMOUS_OTEL_REQUIRED')};
  }

  const baseDuration = baseline.window.toMs - baseline.window.fromMs;
  const currDuration = currentReport.window.toMs - currentReport.window.fromMs;
  if (baseline.window.toMs > currentReport.window.fromMs || baseDuration !== currDuration) {
    return {ok: true, comparison: unavailable('WINDOWS_NOT_COMPARABLE')};
  }

  const basePureOtel = baseOtelOutcomes === baseline.throughput.acceptedOutcomesInWindow;
  const currPureOtel = currOtelOutcomes === currentReport.throughput.acceptedOutcomesInWindow;
  if (!baseline.throughput.complete ||
      !currentReport.throughput.complete ||
      !basePureOtel ||
      !currPureOtel ||
      baseOtelOutcomes < MIN_COMPARABLE_ACCEPTED_UNITS ||
      currOtelOutcomes < MIN_COMPARABLE_ACCEPTED_UNITS ||
      !baseline.autonomousOtel.routineHumanInterventions.zeroRoutineVerified ||
      !currentReport.autonomousOtel.routineHumanInterventions.zeroRoutineVerified) {
    return {ok: true, comparison: unavailable('INSUFFICIENT_COMPARABLE_EVIDENCE')};
  }

  const multiplier = currOtelOutcomes / baseOtelOutcomes;
  const reachedCheckpoints = THROUGHPUT_CHECKPOINTS.filter(cp => multiplier >= cp);
  const highestCheckpointReached = reachedCheckpoints.length > 0
    ? reachedCheckpoints[reachedCheckpoints.length - 1]
    : null;

  return {
    ok: true,
    comparison: {
      comparable: true,
      reason: 'COMPARABLE_COHORTS',
      autonomousSpeedClaimEligible: currProv === 'verified-autonomous-otel' &&
        baseline.autonomousOtel.autonomousClaimEligible === true &&
        currentReport.autonomousOtel.autonomousClaimEligible === true,
      baselineAcceptedOutcomes: baseOtelOutcomes,
      currentAcceptedOutcomes: currOtelOutcomes,
      throughputMultiplier: multiplier,
      reachedCheckpoints,
      highestCheckpointReached
    }
  };
}

/**
 * Build a deterministic, read-only T01-T04 historical GitHub timestamp proxy and
 * verified autonomous OpenTelemetry outcome report for a single authorized repository cohort.
 */
export function buildHistoricalAndOtelEvidenceReport(input) {
  if (!exactRecord(input, INPUT_REQUIRED_KEYS, INPUT_OPTIONAL_KEYS)) {
    return invalidReport('INVALID_INPUT');
  }
  const {query} = input;
  if (!exactRecord(query, QUERY_KEYS) ||
      !validRepositoryBinding(query.repositoryKey, query.repositoryId) ||
      !validCohort(query.cohort) ||
      typeof query.historicalSourceComplete !== 'boolean' ||
      !nonnegInt(query.fromMs) ||
      !nonnegInt(query.toMs) ||
      query.fromMs >= query.toMs) {
    return invalidReport('INVALID_QUERY');
  }
  if (!nonnegInt(query.observedMs) ||
      !nonnegInt(query.nowMs) ||
      !positiveInt(query.maxAgeMs) ||
      query.observedMs < query.toMs ||
      query.observedMs > query.nowMs) {
    return invalidReport('FRESHNESS_UNKNOWN');
  }
  if (query.nowMs - query.observedMs > query.maxAgeMs) {
    return invalidReport('STALE_EVIDENCE');
  }

  const authCheck = validateAuthorization(input.authorizedRepositories, query);
  if (!authCheck.ok) return invalidReport(authCheck.reason);

  const parsedIssues = parseIssues(input.issues, query);
  if (!parsedIssues.ok) return invalidReport(parsedIssues.reason);

  const parsedPulls = parsePulls(input.pulls, query);
  if (!parsedPulls.ok) return invalidReport(parsedPulls.reason);

  const linkGraph = parseLinks(
    input.links,
    query,
    parsedIssues.byNumber,
    parsedPulls.byNumber
  );
  if (!linkGraph.ok) return invalidReport(linkGraph.reason);

  const historicalProxies = buildHistoricalProxySummaries(
    parsedIssues.list,
    parsedPulls.list,
    linkGraph,
    query
  );
  const rawOtel = ownOption(input, 'otel', null);
  const correlationResult = buildCorrelationAndThroughput(
    parsedIssues.list,
    parsedPulls.list,
    linkGraph,
    query,
    rawOtel !== null
  );
  const otelResult = buildAutonomousOtelSection(
    rawOtel,
    parsedIssues.list,
    parsedPulls.list,
    linkGraph,
    correlationResult,
    query
  );
  if (!otelResult.ok) return invalidReport(otelResult.reason);

  const report = {
    schemaVersion: HISTORICAL_OTEL_REPORT_SCHEMA_VERSION,
    reportKind: 'historical-and-otel-throughput-report',
    valid: true,
    shadow: true,
    readOnly: true,
    liveDispatch: false,
    liveMerge: false,
    createsSchedule: false,
    reportingCadence: 'existing-scorecard-cadence',
    reason: correlationResult.throughput.complete &&
      (rawOtel === null || otelResult.section.status === 'measured')
      ? 'MEASURED_REPORT'
      : 'PARTIAL_EVIDENCE',
    repositoryKey: query.repositoryKey,
    repositoryId: query.repositoryId,
    cohort: query.cohort,
    window: {
      fromMs: query.fromMs,
      toMs: query.toMs,
      observedMs: query.observedMs,
      elapsedDays: (query.toMs - query.fromMs) / DAY_MS
    },
    historicalProxies,
    correlation: correlationResult.correlation,
    throughput: correlationResult.throughput,
    autonomousOtel: otelResult.section,
    baselineComparison: null
  };

  const rawBaseline = ownOption(input, 'baseline', null);
  const baselineResult = evaluateBaselineComparison(rawBaseline, report);
  if (!baselineResult.ok) return invalidReport(baselineResult.reason);
  report.baselineComparison = baselineResult.comparison;

  return deepFreeze(report);
}
