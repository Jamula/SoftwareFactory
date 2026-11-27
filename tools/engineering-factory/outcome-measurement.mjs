// Offline measurement only. Inputs must come from a separately trusted evidence
// adapter; this function neither grants authority nor infers issue acceptance.
import {types} from 'node:util';
import {
  SCORECARD_PROVENANCES,
  VELOCITY_STAGE_OBJECTIVES,
  aggregateGithubTiming,
  aggregateScorecardStages,
  isHistoricalProxyArtifact,
  isNonProxyProvenance,
  ownDataValue
} from './stage-aggregate.mjs';
export {SCORECARD_PROVENANCES, VELOCITY_STAGE_OBJECTIVES};
const ownData=(v,keys)=>v!==null&&typeof v==='object'&&!types.isProxy(v)&&!Array.isArray(v)&&keys.every(k=>Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)??{},'value'));
const dense=(v,max)=>!types.isProxy(v)&&Array.isArray(v)&&Object.getPrototypeOf(v)===Array.prototype&&v.length<=max&&Reflect.ownKeys(v).length===v.length+1&&Array.from({length:v.length},(_,i)=>Object.hasOwn(Object.getOwnPropertyDescriptor(v,i)??{},'value')).every(Boolean);
const id=n=>Number.isSafeInteger(n)&&n>0;
const time=n=>Number.isSafeInteger(n)&&n>=0;
const sha=s=>typeof s==='string'&&/^[a-f0-9]{40}$/.test(s);
const unknown=reason=>({known:false,reason});
export function measureIssueOutcome(issue,pulls){
  if(!ownData(issue,['repositoryId','number','state','acceptanceVerified','readyAt','acceptedAt','lastReopenedAt','requiredPullNumbers'])||!id(issue.repositoryId)||!id(issue.number)||!dense(pulls,10000))
    return unknown('INVALID_INPUT');
  if(issue.state!=='closed'||issue.acceptanceVerified!==true)
    return unknown('ACCEPTANCE_UNVERIFIED');
  if(!time(issue.readyAt)||!time(issue.acceptedAt)||issue.acceptedAt<issue.readyAt)
    return unknown('TIMESTAMPS_UNKNOWN');
  if(issue.lastReopenedAt!==null&&(!time(issue.lastReopenedAt)||issue.lastReopenedAt>=issue.acceptedAt))
    return unknown('REOPENED_OR_UNKNOWN');
  const required=issue.requiredPullNumbers;
  if(!dense(required,250)||required.length===0||required.some(n=>!id(n))||new Set(required).size!==required.length)
    return unknown('LINKS_UNKNOWN');
  let latestMain=0;
  for(const number of required){
    const matches=[];
    for(const p of pulls){
      if(p===null)continue;
      if(!ownData(p,['repositoryId','number']))return unknown('INVALID_INPUT');
      if(p.repositoryId===issue.repositoryId&&p.number===number)matches.push(p);
    }
    if(matches.length!==1)return unknown('PULL_UNKNOWN_OR_DUPLICATE');
    const p=matches[0];
    if(!ownData(p,['issueNumbers','merged','mergeSha','mainVerifiedSha','mainVerified','mergedAt','mainVerifiedAt']))return unknown('INVALID_INPUT');
    if(!dense(p.issueNumbers,250)||p.issueNumbers.filter(n=>n===issue.number).length!==1)
      return unknown('LINK_UNVERIFIED');
    if(p.merged!==true||!sha(p.mergeSha)||p.mainVerifiedSha!==p.mergeSha||p.mainVerified!==true)
      return unknown('MAIN_UNVERIFIED');
    if(!time(p.mergedAt)||!time(p.mainVerifiedAt)||p.mainVerifiedAt<p.mergedAt||p.mainVerifiedAt>issue.acceptedAt)
      return unknown('PULL_TIMESTAMPS_UNKNOWN');
    latestMain=Math.max(latestMain,p.mainVerifiedAt);
  }
  return {known:true,reason:'VERIFIED_OUTCOME',elapsedMs:issue.acceptedAt-issue.readyAt,
    mainVerifiedAt:latestMain,requiredPullCount:required.length};
}

const dayMs = 86400000;
const cohortFields = [
  'repositoryId', 'cohort', 'source', 'complete', 'fromMs', 'toMs', 'observedMs', 'nowMs', 'maxAgeMs'
];
const entryFields = ['cohort', 'source', 'issue', 'pulls', 'cost'];
const identityFields = ['repositoryId', 'number', 'state', 'readyAt', 'acceptedAt'];
const receiptFields = ['repositoryId', 'issueNumber', 'receiptId', 'verified', 'currency', 'amountMicros', 'observedMs'];
const label = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);

function validCohort(query, authorizedRepositoryIds) {
  return ownData(query, cohortFields) && id(query.repositoryId) &&
    dense(authorizedRepositoryIds, 32) && authorizedRepositoryIds.every(id) &&
    authorizedRepositoryIds.includes(query.repositoryId) && label(query.cohort) &&
    ['verified', 'synthetic'].includes(query.source) && typeof query.complete === 'boolean' &&
    time(query.fromMs) && time(query.toMs) && query.fromMs < query.toMs;
}

function acceptedCost(cost, issue, observedMs) {
  if (!ownData(cost, receiptFields) || cost.repositoryId !== issue.repositoryId ||
      cost.issueNumber !== issue.number || cost.verified !== true || cost.currency !== 'USD' ||
      !label(cost.receiptId) || !time(cost.amountMicros) || !time(cost.observedMs) ||
      cost.observedMs < issue.acceptedAt || cost.observedMs > observedMs) return null;
  return cost;
}

/**
 * Summarize one trusted comparable cohort in a half-open acceptance window.
 * Callers establish inventory completeness and normalize receipts independently.
 * The report is read-only, with synthetic and verified sources kept separate.
 */
export function measureAcceptedCohort(entries, query, authorizedRepositoryIds) {
  if (!validCohort(query, authorizedRepositoryIds)) return unknown('COHORT_UNKNOWN');
  if (!time(query.observedMs) || !time(query.nowMs) || !id(query.maxAgeMs) ||
      query.observedMs < query.toMs || query.observedMs > query.nowMs) return unknown('FRESHNESS_UNKNOWN');
  if (query.nowMs - query.observedMs > query.maxAgeMs) return unknown('STALE_EVIDENCE');
  if (!dense(entries, 500)) return unknown('INVALID_ENTRIES');

  const issues = new Set();
  const receipts = new Set();
  const durations = [];
  const counts = {accepted: 0, censored: 0, unknown: 0, withVerifiedCost: 0};
  let spendMicros = 0;
  let pullRows = 0;
  for (const row of entries) {
    if (!ownData(row, entryFields) || row.cohort !== query.cohort || row.source !== query.source ||
        !ownData(row.issue, identityFields) || row.issue.repositoryId !== query.repositoryId ||
        !id(row.issue.number)) return unknown('ENTRY_SCOPE_UNKNOWN');
    const issue = row.issue;
    if (issues.has(issue.number)) return unknown('DUPLICATE_ISSUE');
    issues.add(issue.number);
    if (issue.state === 'open' && issue.acceptedAt === null &&
        time(issue.readyAt) && issue.readyAt <= query.observedMs) {
      if (issue.readyAt < query.toMs) counts.censored++;
      continue;
    }
    if (!dense(row.pulls, 250)) {
      counts.unknown++;
      continue;
    }
    pullRows += row.pulls.length;
    if (pullRows > 10000) return unknown('PULL_EVIDENCE_LIMIT');
    const outcome = measureIssueOutcome(issue, row.pulls);
    if (!outcome.known || issue.acceptedAt > query.observedMs) {
      counts.unknown++;
      continue;
    }
    const cost = acceptedCost(row.cost, issue, query.observedMs);
    if (cost) {
      if (receipts.has(cost.receiptId)) return unknown('CONFLICTING_COST_EVIDENCE');
      receipts.add(cost.receiptId);
    }
    if (issue.acceptedAt >= query.toMs) {
      if (issue.readyAt < query.toMs) counts.censored++;
      continue;
    }
    if (issue.acceptedAt < query.fromMs) continue;
    counts.accepted++;
    durations.push(outcome.elapsedMs);

    if (!cost) continue;
    if (!Number.isSafeInteger(spendMicros + cost.amountMicros)) {
      return unknown('CONFLICTING_COST_EVIDENCE');
    }
    spendMicros += cost.amountMicros;
    counts.withVerifiedCost++;
  }

  durations.sort((a, b) => a - b);
  const percentile = p => durations[Math.ceil(p * durations.length) - 1] ?? null;
  const complete = query.complete && counts.unknown === 0;
  const costComplete = complete && counts.accepted > 0 && counts.withVerifiedCost === counts.accepted;
  return {
    known: complete, reason: complete ? 'MEASURED_COHORT' : 'PARTIAL_EVIDENCE', source: query.source,
    repositoryId: query.repositoryId, cohort: query.cohort, fromMs: query.fromMs, toMs: query.toMs,
    observedMs: query.observedMs, sourceComplete: query.complete, counts,
    p50: percentile(0.5), p95: percentile(0.95),
    acceptedPerDay: complete ? counts.accepted * dayMs / (query.toMs - query.fromMs) : null,
    costPerAcceptedUsdMicros: costComplete ? spendMicros / counts.accepted : null
  };
}

export const MIN_COMPARABLE_ACCEPTED_UNITS = 5;
export const THROUGHPUT_CHECKPOINTS = Object.freeze([2, 5, 10, 15, 20, 25]);
export const READY_TO_ACCEPTED_OBJECTIVES = Object.freeze({initialMs: 1500000, stretchMs: 420000});
export const ALLOWED_BLOCKED_REASONS = Object.freeze([
  'DEPENDENCY', 'REVIEW', 'CI', 'QUOTA', 'MERGE_QUEUE', 'POLICY', 'SECURITY', 'OTHER'
]);

const blockedReasonSet = new Set(ALLOWED_BLOCKED_REASONS);
const maxUnitCount = 1000000;
const maxUnitDurationMs = 315360000000;
const maxSourceElements = 100000000;
const scorecardInputFields = ['query', 'units', 'stageSamples', 'quality', 'historicalProxies', 'baseline'];
const scorecardQueryFields = [
  'repositoryId', 'cohort', 'provenance', 'complete', 'stageSourceComplete',
  'fromMs', 'toMs', 'observedMs', 'nowMs', 'maxAgeMs'
];
const unitFields = [
  'cohort', 'provenance', 'issue', 'pulls', 'cost', 'rework', 'utilization', 'humanInterventions'
];
const scorecardIssueFields = [
  'repositoryId', 'number', 'state', 'acceptanceVerified', 'readyAt',
  'acceptedAt', 'lastReopenedAt', 'requiredPullNumbers'
];
const scorecardPullFields = [
  'repositoryId', 'number', 'issueNumbers', 'merged', 'mergeSha',
  'mainVerifiedSha', 'mainVerified', 'mergedAt', 'mainVerifiedAt'
];
const reworkFields = [
  'complete', 'candidateRounds', 'reworkRounds', 'reopenedCount', 'infrastructureRetries', 'queueRevalidations'
];
const utilizationFields = ['complete', 'activeMs', 'blockedMs', 'idleMs', 'blockedReasons'];
const interventionFields = ['complete', 'routineCount', 'governanceCount'];
const qualityFields = [
  'repositoryId', 'provenance', 'complete', 'coveredLines', 'totalLines', 'coveredBranches', 'totalBranches',
  'minLinePercent', 'minBranchPercent', 'failedMainCount', 'unauthorizedWriteCount',
  'duplicateDispatchCount', 'budgetViolationCount'
];
const proxySectionFields = ['provenance', 'sourceComplete', 'issueCreatedToCloseRows', 'prCreatedToMergeRows'];
const scorecardSnapshotFields = [
  'known', 'reason', 'schemaVersion', 'provenance', 'repositoryId', 'cohort', 'window', 'completeness',
  'counts', 'sampleSize', 'throughput', 'stages', 'rework', 'utilization', 'humanInterventions',
  'cost', 'quality', 'autonomousSpeedClaimEligible', 'historicalProxyContext', 'baselineComparison'
];

const exactData = (v, keys) =>
  ownData(v, keys) && Object.getPrototypeOf(v) === Object.prototype && Reflect.ownKeys(v).length === keys.length;
const boundedCount = n => time(n) && n <= maxUnitCount;
const boundedPositiveCount = n => id(n) && n <= maxUnitCount;
const boundedMs = n => time(n) && n <= maxUnitDurationMs;
const nearestRank = (sorted, p) => sorted[Math.ceil(p * sorted.length) - 1] ?? null;

function validBlockedReasons(map, expectedBlockedMs) {
  if (map === null || typeof map !== 'object' || types.isProxy(map) ||
      Array.isArray(map) || Object.getPrototypeOf(map) !== Object.prototype) return false;
  let sum = 0;
  for (const key of Reflect.ownKeys(map)) {
    if (typeof key !== 'string' || !blockedReasonSet.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(map, key);
    if (!Object.hasOwn(descriptor, 'value') || !boundedMs(descriptor.value)) return false;
    sum += descriptor.value;
  }
  return sum === expectedBlockedMs;
}

function parseUnitTelemetry(unit) {
  if (unit.cost !== null) {
    if (isHistoricalProxyArtifact(unit.cost)) return {ok: false, reason: 'PROVENANCE_ISOLATION_VIOLATION'};
    if (!exactData(unit.cost, receiptFields)) return {ok: false, reason: 'INVALID_COST_EVIDENCE'};
  }
  let rework = null;
  if (unit.rework !== null) {
    if (!exactData(unit.rework, reworkFields) || typeof unit.rework.complete !== 'boolean' ||
        !boundedPositiveCount(unit.rework.candidateRounds) || !boundedCount(unit.rework.reworkRounds) ||
        !boundedCount(unit.rework.reopenedCount) || !boundedCount(unit.rework.infrastructureRetries) ||
        !boundedCount(unit.rework.queueRevalidations)) {
      return {ok: false, reason: 'INVALID_REWORK_EVIDENCE'};
    }
    if (unit.rework.complete) {
      if (unit.rework.reworkRounds !== unit.rework.candidateRounds - 1) {
        return {ok: false, reason: 'INVALID_REWORK_EVIDENCE'};
      }
      rework = unit.rework;
    }
  }
  let utilization = null;
  if (unit.utilization !== null) {
    if (!exactData(unit.utilization, utilizationFields) || typeof unit.utilization.complete !== 'boolean' ||
        !boundedMs(unit.utilization.activeMs) || !boundedMs(unit.utilization.blockedMs) ||
        !boundedMs(unit.utilization.idleMs) ||
        !validBlockedReasons(unit.utilization.blockedReasons, unit.utilization.blockedMs)) {
      return {ok: false, reason: 'INVALID_UTILIZATION_EVIDENCE'};
    }
    if (unit.utilization.complete) utilization = unit.utilization;
  }
  let interventions = null;
  if (unit.humanInterventions !== null) {
    if (!exactData(unit.humanInterventions, interventionFields) ||
        typeof unit.humanInterventions.complete !== 'boolean' ||
        !boundedCount(unit.humanInterventions.routineCount) ||
        !boundedCount(unit.humanInterventions.governanceCount)) {
      return {ok: false, reason: 'INVALID_INTERVENTION_EVIDENCE'};
    }
    if (unit.humanInterventions.complete) interventions = unit.humanInterventions;
  }
  return {ok: true, rework, utilization, interventions};
}

function evaluateQualityReceipt(quality, query) {
  const unknownQuality = {
    status: 'unknown', coveredLines: null, totalLines: null, lineCoverageRatio: null,
    coveredBranches: null, totalBranches: null, branchCoverageRatio: null,
    minLinePercent: null, minBranchPercent: null, violations: null
  };
  if (quality === null) return {ok: true, summary: unknownQuality};
  if (isHistoricalProxyArtifact(quality)) return {ok: false, reason: 'PROVENANCE_ISOLATION_VIOLATION'};
  if (!exactData(quality, qualityFields)) return {ok: false, reason: 'INVALID_QUALITY_EVIDENCE'};
  if (quality.provenance !== query.provenance) {
    return {
      ok: false,
      reason: isNonProxyProvenance(quality.provenance)
        ? 'PROVENANCE_ISOLATION_VIOLATION'
        : 'INVALID_QUALITY_EVIDENCE'
    };
  }
  if (quality.repositoryId !== query.repositoryId) return {ok: false, reason: 'ENTRY_SCOPE_UNKNOWN'};
  if (typeof quality.complete !== 'boolean' ||
      !id(quality.totalLines) || quality.totalLines > maxSourceElements ||
      !time(quality.coveredLines) || quality.coveredLines > quality.totalLines ||
      !id(quality.totalBranches) || quality.totalBranches > maxSourceElements ||
      !time(quality.coveredBranches) || quality.coveredBranches > quality.totalBranches ||
      !id(quality.minLinePercent) || quality.minLinePercent < 95 || quality.minLinePercent > 100 ||
      !id(quality.minBranchPercent) || quality.minBranchPercent < 90 || quality.minBranchPercent > 100 ||
      !boundedCount(quality.failedMainCount) || !boundedCount(quality.unauthorizedWriteCount) ||
      !boundedCount(quality.duplicateDispatchCount) || !boundedCount(quality.budgetViolationCount)) {
    return {ok: false, reason: 'INVALID_QUALITY_EVIDENCE'};
  }
  if (!quality.complete) return {ok: true, summary: unknownQuality};
  const linesPass = quality.coveredLines * 100 >= quality.minLinePercent * quality.totalLines;
  const branchesPass = quality.coveredBranches * 100 >= quality.minBranchPercent * quality.totalBranches;
  const violations = {
    failedMainCount: quality.failedMainCount,
    unauthorizedWriteCount: quality.unauthorizedWriteCount,
    duplicateDispatchCount: quality.duplicateDispatchCount,
    budgetViolationCount: quality.budgetViolationCount
  };
  const safetyPass = quality.failedMainCount === 0 && quality.unauthorizedWriteCount === 0 &&
    quality.duplicateDispatchCount === 0 && quality.budgetViolationCount === 0;
  return {
    ok: true,
    summary: {
      status: linesPass && branchesPass && safetyPass ? 'passed' : 'failed',
      coveredLines: quality.coveredLines,
      totalLines: quality.totalLines,
      lineCoverageRatio: quality.coveredLines / quality.totalLines,
      coveredBranches: quality.coveredBranches,
      totalBranches: quality.totalBranches,
      branchCoverageRatio: quality.coveredBranches / quality.totalBranches,
      minLinePercent: quality.minLinePercent,
      minBranchPercent: quality.minBranchPercent,
      violations
    }
  };
}

function evaluateHistoricalProxySection(section, query, authorizedRepositoryIds) {
  if (section === null) return {ok: true, context: null};
  if (isNonProxyProvenance(ownDataValue(section, 'provenance'))) {
    return {ok: false, reason: 'PROVENANCE_ISOLATION_VIOLATION'};
  }
  if (!exactData(section, proxySectionFields) ||
      section.provenance !== 'historical-github-proxy' ||
      typeof section.sourceComplete !== 'boolean') {
    return {ok: false, reason: 'INVALID_PROXY_EVIDENCE'};
  }
  const baseQuery = {
    repositoryId: query.repositoryId,
    fromMs: query.fromMs,
    toMs: query.toMs,
    observedMs: query.observedMs,
    nowMs: query.nowMs,
    maxAgeMs: query.maxAgeMs,
    sourceComplete: section.sourceComplete
  };
  const issueCreatedToClose = aggregateGithubTiming(
    section.issueCreatedToCloseRows,
    {...baseQuery, metric: 'issue-created-to-close'},
    authorizedRepositoryIds
  );
  const prCreatedToMerge = aggregateGithubTiming(
    section.prCreatedToMergeRows,
    {...baseQuery, metric: 'pr-created-to-merge'},
    authorizedRepositoryIds
  );
  if ((issueCreatedToClose.state === 'unknown' && issueCreatedToClose.reason !== 'NO_COMPLETED_SAMPLES') ||
      (prCreatedToMerge.state === 'unknown' && prCreatedToMerge.reason !== 'NO_COMPLETED_SAMPLES')) {
    return {ok: false, reason: 'INVALID_PROXY_EVIDENCE'};
  }
  return {
    ok: true,
    context: {
      provenance: 'historical-github-proxy',
      nonAutonomousProxyOnly: true,
      issueCreatedToClose,
      prCreatedToMerge
    }
  };
}

function validScorecardSnapshot(s) {
  return exactData(s, scorecardSnapshotFields) && typeof s.known === 'boolean' &&
    isNonProxyProvenance(s.provenance) && id(s.repositoryId) && label(s.cohort) &&
    typeof s.autonomousSpeedClaimEligible === 'boolean' &&
    ownData(s.window, ['fromMs', 'toMs']) && time(s.window.fromMs) && time(s.window.toMs) &&
    s.window.fromMs < s.window.toMs &&
    ownData(s.counts, ['accepted']) && time(s.counts.accepted) &&
    ownData(s.throughput, ['acceptedOutcomesPerDay', 'readyToAcceptedP50Ms', 'readyToAcceptedP95Ms']) &&
    ownData(s.cost, ['status', 'costPerAcceptedUsdMicros']) &&
    ownData(s.quality, ['status']) &&
    ownData(s.humanInterventions, ['status']);
}

export function compareVelocityScorecards(baseline, candidate) {
  const unavailable = reason => ({
    comparable: false, reason, provenance: null, autonomousClaimEligible: false,
    throughputMultiplier: null, achievedCheckpoints: [],
    readyToAcceptedDeltaP50Ms: null, readyToAcceptedDeltaP95Ms: null, costPerAcceptedDeltaUsdMicros: null
  });
  if (isHistoricalProxyArtifact(baseline) || isHistoricalProxyArtifact(candidate)) {
    return unavailable('PROVENANCE_ISOLATION_VIOLATION');
  }
  if (!validScorecardSnapshot(baseline) || !validScorecardSnapshot(candidate)) {
    return unavailable('INVALID_SCORECARD');
  }
  if (baseline.provenance !== candidate.provenance) {
    return unavailable('PROVENANCE_ISOLATION_VIOLATION');
  }
  if (baseline.repositoryId !== candidate.repositoryId || baseline.cohort !== candidate.cohort) {
    return unavailable('COHORT_MISMATCH');
  }
  if (baseline.window.toMs > candidate.window.fromMs ||
      baseline.window.toMs - baseline.window.fromMs !== candidate.window.toMs - candidate.window.fromMs) {
    return unavailable('WINDOWS_NOT_COMPARABLE');
  }
  if (!baseline.known || !candidate.known) return unavailable('INCOMPLETE_EVIDENCE');
  if (baseline.counts.accepted < MIN_COMPARABLE_ACCEPTED_UNITS ||
      candidate.counts.accepted < MIN_COMPARABLE_ACCEPTED_UNITS) {
    return unavailable('INSUFFICIENT_SAMPLE_SIZE');
  }
  if (!Number.isFinite(baseline.throughput.acceptedOutcomesPerDay) ||
      baseline.throughput.acceptedOutcomesPerDay <= 0 ||
      !Number.isFinite(candidate.throughput.acceptedOutcomesPerDay) ||
      candidate.throughput.acceptedOutcomesPerDay <= 0) {
    return unavailable('ZERO_OR_UNKNOWN_BASELINE');
  }
  const verifiedCost = s => ['verified-zero', 'verified-spend'].includes(s.cost.status) &&
    Number.isFinite(s.cost.costPerAcceptedUsdMicros) && s.cost.costPerAcceptedUsdMicros >= 0;
  const validLatencies = s => time(s.throughput.readyToAcceptedP50Ms) && time(s.throughput.readyToAcceptedP95Ms);
  if (!verifiedCost(baseline) || !verifiedCost(candidate) ||
      candidate.cost.costPerAcceptedUsdMicros > baseline.cost.costPerAcceptedUsdMicros ||
      !validLatencies(baseline) || !validLatencies(candidate) ||
      candidate.quality.status !== 'passed' || baseline.quality.status === 'failed') {
    return unavailable('GUARDRAIL_UNVERIFIED_OR_REGRESSED');
  }
  const throughputMultiplier = candidate.throughput.acceptedOutcomesPerDay / baseline.throughput.acceptedOutcomesPerDay;
  return {
    comparable: true,
    reason: candidate.provenance === 'verified-autonomous-outcome'
      ? 'VERIFIED_COMPARABLE_COHORTS'
      : 'SYNTHETIC_COMPARABLE_COHORTS',
    provenance: candidate.provenance,
    autonomousClaimEligible: candidate.autonomousSpeedClaimEligible &&
      baseline.humanInterventions.status === 'measured' &&
      baseline.quality.status === 'passed',
    throughputMultiplier,
    achievedCheckpoints: THROUGHPUT_CHECKPOINTS.filter(m => throughputMultiplier >= m),
    readyToAcceptedDeltaP50Ms: candidate.throughput.readyToAcceptedP50Ms - baseline.throughput.readyToAcceptedP50Ms,
    readyToAcceptedDeltaP95Ms: candidate.throughput.readyToAcceptedP95Ms - baseline.throughput.readyToAcceptedP95Ms,
    costPerAcceptedDeltaUsdMicros: candidate.cost.costPerAcceptedUsdMicros - baseline.cost.costPerAcceptedUsdMicros
  };
}

/**
 * Build a reproducible read-only M02.02 velocity and efficiency scorecard for
 * one authorized repository and comparable cohort, isolating historical GitHub
 * proxies from verified autonomous execution receipts.
 */
export function buildVelocityScorecard(input, authorizedRepositoryIds) {
  if (isHistoricalProxyArtifact(input)) return unknown('PROVENANCE_ISOLATION_VIOLATION');
  if (!exactData(input, scorecardInputFields)) return unknown('INVALID_INPUT');
  const query = input.query;
  if (isHistoricalProxyArtifact(query)) return unknown('PROVENANCE_ISOLATION_VIOLATION');
  if (!exactData(query, scorecardQueryFields) || !id(query.repositoryId) ||
      !dense(authorizedRepositoryIds, 32) || !authorizedRepositoryIds.every(id) ||
      !authorizedRepositoryIds.includes(query.repositoryId) || !label(query.cohort) ||
      !isNonProxyProvenance(query.provenance) || typeof query.complete !== 'boolean' ||
      typeof query.stageSourceComplete !== 'boolean' ||
      !time(query.fromMs) || !time(query.toMs) || query.fromMs >= query.toMs) {
    return unknown('COHORT_UNKNOWN');
  }
  if (!time(query.observedMs) || !time(query.nowMs) || !id(query.maxAgeMs) ||
      query.observedMs < query.toMs || query.observedMs > query.nowMs) {
    return unknown('FRESHNESS_UNKNOWN');
  }
  if (query.nowMs - query.observedMs > query.maxAgeMs) return unknown('STALE_EVIDENCE');
  if (!dense(input.units, 500)) return unknown('INVALID_ENTRIES');

  const stageReport = aggregateScorecardStages(input.stageSamples, {
    repositoryId: query.repositoryId,
    cohort: query.cohort,
    provenance: query.provenance,
    fromMs: query.fromMs,
    toMs: query.toMs,
    observedMs: query.observedMs,
    nowMs: query.nowMs,
    maxAgeMs: query.maxAgeMs,
    sourceComplete: query.stageSourceComplete
  }, authorizedRepositoryIds);
  if (!stageReport.known && stageReport.reason !== 'PARTIAL_STAGE_EVIDENCE') {
    return unknown(stageReport.reason);
  }

  const qualityResult = evaluateQualityReceipt(input.quality, query);
  if (!qualityResult.ok) return unknown(qualityResult.reason);

  const proxyResult = evaluateHistoricalProxySection(input.historicalProxies, query, authorizedRepositoryIds);
  if (!proxyResult.ok) return unknown(proxyResult.reason);

  const issues = new Set();
  const receipts = new Set();
  const readyToAcceptedDurations = [];
  const reworkSamples = [];
  const counts = {accepted: 0, censored: 0, unknown: 0, withVerifiedCost: 0};
  let readyToAcceptedInitialMisses = 0;
  let readyToAcceptedStretchMisses = 0;
  let spendMicros = 0;
  let verifiedZeroCostCount = 0;
  let pullRows = 0;

  let reworkKnownUnits = 0;
  let totalCandidateRounds = 0;
  let totalReworkRounds = 0;
  let totalReopenedCount = 0;
  let totalInfraRetries = 0;
  let totalQueueRevalidations = 0;
  let firstPassUnits = 0;

  let utilizationKnownUnits = 0;
  let totalActiveMs = 0;
  let totalBlockedMs = 0;
  let totalIdleMs = 0;
  const blockedByReasonMs = Object.fromEntries(ALLOWED_BLOCKED_REASONS.map(r => [r, 0]));

  let interventionsKnownUnits = 0;
  let routineInterventions = 0;
  let governanceInterventions = 0;

  for (const unit of input.units) {
    if (isHistoricalProxyArtifact(unit)) return unknown('PROVENANCE_ISOLATION_VIOLATION');
    if (!exactData(unit, unitFields)) return unknown('ENTRY_SCOPE_UNKNOWN');
    if (unit.provenance !== query.provenance) {
      return unknown(isNonProxyProvenance(unit.provenance)
        ? 'PROVENANCE_ISOLATION_VIOLATION'
        : 'ENTRY_SCOPE_UNKNOWN');
    }
    if (unit.cohort !== query.cohort || !exactData(unit.issue, scorecardIssueFields) ||
        unit.issue.repositoryId !== query.repositoryId || !id(unit.issue.number)) {
      return unknown('ENTRY_SCOPE_UNKNOWN');
    }
    if (dense(unit.pulls, 250) && unit.pulls.some(p => p !== null && !exactData(p, scorecardPullFields))) {
      return unknown('ENTRY_SCOPE_UNKNOWN');
    }
    const telemetry = parseUnitTelemetry(unit);
    if (!telemetry.ok) return unknown(telemetry.reason);

    const issue = unit.issue;
    if (issues.has(issue.number)) return unknown('DUPLICATE_ISSUE');
    issues.add(issue.number);

    if (issue.state === 'open' && issue.acceptedAt === null &&
        time(issue.readyAt) && issue.readyAt <= query.observedMs) {
      if (issue.readyAt < query.toMs) counts.censored++;
      continue;
    }
    if (!dense(unit.pulls, 250)) {
      counts.unknown++;
      continue;
    }
    pullRows += unit.pulls.length;
    if (pullRows > 10000) return unknown('PULL_EVIDENCE_LIMIT');
    const outcome = measureIssueOutcome(issue, unit.pulls);
    if (!outcome.known || issue.acceptedAt > query.observedMs) {
      counts.unknown++;
      continue;
    }
    if (telemetry.rework && (issue.lastReopenedAt !== null) !== (telemetry.rework.reopenedCount > 0)) {
      return unknown('INVALID_REWORK_EVIDENCE');
    }
    const cost = unit.cost !== null ? acceptedCost(unit.cost, issue, query.observedMs) : null;
    if (cost) {
      if (receipts.has(cost.receiptId)) return unknown('CONFLICTING_COST_EVIDENCE');
      receipts.add(cost.receiptId);
    }
    if (issue.acceptedAt >= query.toMs) {
      if (issue.readyAt < query.toMs) counts.censored++;
      continue;
    }
    if (issue.acceptedAt < query.fromMs) continue;

    counts.accepted++;
    readyToAcceptedDurations.push(outcome.elapsedMs);
    if (outcome.elapsedMs > READY_TO_ACCEPTED_OBJECTIVES.initialMs) readyToAcceptedInitialMisses++;
    if (outcome.elapsedMs > READY_TO_ACCEPTED_OBJECTIVES.stretchMs) readyToAcceptedStretchMisses++;

    if (cost) {
      if (!Number.isSafeInteger(spendMicros + cost.amountMicros)) {
        return unknown('CONFLICTING_COST_EVIDENCE');
      }
      spendMicros += cost.amountMicros;
      counts.withVerifiedCost++;
      if (cost.amountMicros === 0) verifiedZeroCostCount++;
    }
    if (telemetry.rework) {
      reworkKnownUnits++;
      totalCandidateRounds += telemetry.rework.candidateRounds;
      totalReworkRounds += telemetry.rework.reworkRounds;
      totalReopenedCount += telemetry.rework.reopenedCount;
      totalInfraRetries += telemetry.rework.infrastructureRetries;
      totalQueueRevalidations += telemetry.rework.queueRevalidations;
      reworkSamples.push(telemetry.rework.reworkRounds + telemetry.rework.reopenedCount);
      if (telemetry.rework.candidateRounds === 1 && telemetry.rework.reopenedCount === 0) firstPassUnits++;
    }
    if (telemetry.utilization) {
      utilizationKnownUnits++;
      totalActiveMs += telemetry.utilization.activeMs;
      totalBlockedMs += telemetry.utilization.blockedMs;
      totalIdleMs += telemetry.utilization.idleMs;
      for (const [reasonKey, msValue] of Object.entries(telemetry.utilization.blockedReasons)) {
        blockedByReasonMs[reasonKey] += msValue;
      }
    }
    if (telemetry.interventions) {
      interventionsKnownUnits++;
      routineInterventions += telemetry.interventions.routineCount;
      governanceInterventions += telemetry.interventions.governanceCount;
    }
  }

  readyToAcceptedDurations.sort((a, b) => a - b);
  reworkSamples.sort((a, b) => a - b);

  const outcomeComplete = query.complete && counts.unknown === 0;
  const complete = outcomeComplete && stageReport.known;
  const allAcceptedPositive = outcomeComplete && counts.accepted > 0;

  const reworkComplete = allAcceptedPositive && reworkKnownUnits === counts.accepted;
  const rework = {
    status: reworkComplete ? 'measured' : reworkKnownUnits > 0 ? 'partial' : 'unknown',
    knownUnitCount: reworkKnownUnits,
    unknownUnitCount: counts.accepted - reworkKnownUnits,
    candidateRounds: reworkComplete ? totalCandidateRounds : null,
    reworkRounds: reworkComplete ? totalReworkRounds : null,
    reopenedCount: reworkComplete ? totalReopenedCount : null,
    infrastructureRetries: reworkComplete ? totalInfraRetries : null,
    queueRevalidations: reworkComplete ? totalQueueRevalidations : null,
    reworkRoundsPerAccepted: reworkComplete ? (totalReworkRounds + totalReopenedCount) / counts.accepted : null,
    p50ReworkRounds: nearestRank(reworkSamples, 0.5),
    p95ReworkRounds: nearestRank(reworkSamples, 0.95),
    firstPassYield: reworkComplete ? firstPassUnits / counts.accepted : null
  };

  const totalAllocatedMs = totalActiveMs + totalBlockedMs + totalIdleMs;
  const utilizationComplete = allAcceptedPositive && utilizationKnownUnits === counts.accepted;
  const utilizationMeasurable = utilizationComplete && totalAllocatedMs > 0;
  const utilization = {
    status: utilizationMeasurable
      ? 'measured'
      : utilizationKnownUnits > 0 && !utilizationComplete
        ? 'partial'
        : 'unknown',
    reason: utilizationComplete && totalAllocatedMs === 0 ? 'ZERO_ALLOCATED_CAPACITY' : 'OK',
    knownUnitCount: utilizationKnownUnits,
    unknownUnitCount: counts.accepted - utilizationKnownUnits,
    activeMs: utilizationComplete ? totalActiveMs : null,
    blockedMs: utilizationComplete ? totalBlockedMs : null,
    idleMs: utilizationComplete ? totalIdleMs : null,
    allocatedMs: utilizationComplete ? totalAllocatedMs : null,
    productiveUtilizationRatio: utilizationMeasurable ? totalActiveMs / totalAllocatedMs : null,
    blockedTimeRatio: utilizationMeasurable ? totalBlockedMs / totalAllocatedMs : null,
    idleTimeRatio: utilizationMeasurable ? totalIdleMs / totalAllocatedMs : null,
    blockedByReasonMs: utilizationComplete ? blockedByReasonMs : null
  };

  const interventionsComplete = allAcceptedPositive && interventionsKnownUnits === counts.accepted;
  const humanInterventions = {
    status: interventionsComplete ? 'measured' : interventionsKnownUnits > 0 ? 'partial' : 'unknown',
    knownUnitCount: interventionsKnownUnits,
    unknownUnitCount: counts.accepted - interventionsKnownUnits,
    routineCount: interventionsComplete ? routineInterventions : null,
    governanceCount: interventionsComplete ? governanceInterventions : null,
    totalCount: interventionsComplete ? routineInterventions + governanceInterventions : null,
    routinePerAccepted: interventionsComplete ? routineInterventions / counts.accepted : null,
    zeroRoutineVerified: interventionsComplete && routineInterventions === 0
  };

  const costComplete = allAcceptedPositive && counts.withVerifiedCost === counts.accepted;
  const cost = {
    status: !costComplete ? 'unknown' : spendMicros === 0 ? 'verified-zero' : 'verified-spend',
    acceptedWithVerifiedCost: counts.withVerifiedCost,
    acceptedMissingCost: counts.accepted - counts.withVerifiedCost,
    verifiedZeroCostCount,
    totalSpendUsdMicros: costComplete ? spendMicros : null,
    costPerAcceptedUsdMicros: costComplete ? spendMicros / counts.accepted : null
  };

  const autonomousSpeedClaimEligible = query.provenance === 'verified-autonomous-outcome' &&
    complete && counts.accepted >= MIN_COMPARABLE_ACCEPTED_UNITS &&
    rework.status === 'measured' && utilization.status === 'measured' &&
    humanInterventions.zeroRoutineVerified && cost.status === 'verified-zero' &&
    qualityResult.summary.status === 'passed';

  const scorecard = {
    known: complete,
    reason: complete ? 'MEASURED_SCORECARD' : 'PARTIAL_EVIDENCE',
    schemaVersion: 1,
    provenance: query.provenance,
    repositoryId: query.repositoryId,
    cohort: query.cohort,
    window: {
      fromMs: query.fromMs,
      toMs: query.toMs,
      elapsedDays: (query.toMs - query.fromMs) / dayMs,
      observedMs: query.observedMs
    },
    completeness: {
      unitInventoryComplete: query.complete,
      stageInventoryComplete: query.stageSourceComplete,
      outcomesComplete: outcomeComplete,
      stagesComplete: stageReport.known
    },
    counts: {
      accepted: counts.accepted,
      censored: counts.censored,
      unknown: counts.unknown,
      withVerifiedCost: counts.withVerifiedCost,
      stageCensored: stageReport.totals.censored,
      stageUnknown: stageReport.totals.unknown
    },
    sampleSize: {
      accepted: counts.accepted,
      minimumComparableUnits: MIN_COMPARABLE_ACCEPTED_UNITS,
      exploratoryComparisonEligible: outcomeComplete && counts.accepted >= MIN_COMPARABLE_ACCEPTED_UNITS
    },
    throughput: {
      acceptedOutcomesPerDay: outcomeComplete ? counts.accepted * dayMs / (query.toMs - query.fromMs) : null,
      readyToAcceptedP50Ms: nearestRank(readyToAcceptedDurations, 0.5),
      readyToAcceptedP95Ms: nearestRank(readyToAcceptedDurations, 0.95),
      readyToAcceptedObjectives: READY_TO_ACCEPTED_OBJECTIVES,
      readyToAcceptedSlo: {
        initialMissCount: readyToAcceptedInitialMisses,
        stretchMissCount: readyToAcceptedStretchMisses
      }
    },
    stages: stageReport.stages,
    rework,
    utilization,
    humanInterventions,
    cost,
    quality: qualityResult.summary,
    autonomousSpeedClaimEligible,
    historicalProxyContext: proxyResult.context,
    baselineComparison: null
  };

  if (input.baseline !== null) {
    const comparison = compareVelocityScorecards(input.baseline, scorecard);
    if (comparison.reason === 'PROVENANCE_ISOLATION_VIOLATION' || comparison.reason === 'INVALID_SCORECARD') {
      return unknown(comparison.reason);
    }
    scorecard.baselineComparison = comparison;
  }
  return scorecard;
}
