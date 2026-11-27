import {types} from 'node:util';

const stages=new Set(['reconcile','dispatch','ci','review','merge','verify-main','acceptance']);
const positive=n=>Number.isSafeInteger(n)&&n>0;
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const own=(v,k)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&k.every(x=>Object.hasOwn(v,x));
const dense=a=>Array.isArray(a)&&Object.keys(a).length===a.length&&Array.from({length:a.length},(_,i)=>Object.hasOwn(a,i)).every(Boolean);
const unknown=reason=>({state:'unknown',reason,sampleCount:0,p50:null,p95:null});
export function aggregateStage(rows,q) {
 if(!own(q,['repositoryId','stage','from','to','complete','source','observedMs','nowMs','maxAgeMs'])||!positive(q.repositoryId)||!stages.has(q.stage)||!integer(q.from)||!integer(q.to)||q.from>=q.to||q.complete!==true||q.source!=='synthetic') return unknown('SCOPE_UNKNOWN');
 if(!integer(q.observedMs)||!integer(q.nowMs)||!positive(q.maxAgeMs)||q.observedMs<q.to||q.observedMs>q.nowMs) return unknown('FRESHNESS_UNKNOWN');
 if(q.nowMs-q.observedMs>q.maxAgeMs) return unknown('STALE_EVIDENCE');
 if(!Array.isArray(rows)||rows.length>10000||!dense(rows)) return unknown('INVALID_ROWS');
 const seen=new Set(),durations=[];
 for(const r of rows){
   if(!own(r,['id','repositoryId','stage','at','duration','source'])||typeof r.id!=='string'||! /^[a-zA-Z0-9-]{1,80}$/.test(r.id)||r.repositoryId!==q.repositoryId||!stages.has(r.stage)||!integer(r.at)||!integer(r.duration)||r.source!==q.source) return unknown('INVALID_ROW');
   if(seen.has(r.id)) return unknown('DUPLICATE_EVIDENCE');
   seen.add(r.id);
   if(r.stage===q.stage&&r.at>=q.from&&r.at<q.to) durations.push(r.duration);
 }
 if(!durations.length) return unknown('NO_SAMPLES');
 durations.sort((a,b)=>a-b);
 const percentile=p=>durations[Math.ceil(p*durations.length)-1];
 return {state:'synthetic',reason:'MEASURED_FIXTURE',sampleCount:durations.length,p50:percentile(.5),p95:percentile(.95)};
}

// Advisory retrospective: comparable, complete synthetic samples only.
export function compareStageWindows(beforeRows,before,afterRows,after) {
 const unavailable=reason=>({state:'unknown',reason,before:null,after:null,deltaP50:null,deltaP95:null});
 const a=aggregateStage(beforeRows,before),b=aggregateStage(afterRows,after);
 if(a.state!=='synthetic'||b.state!=='synthetic')return unavailable('EVIDENCE_UNKNOWN');
 if(before.repositoryId!==after.repositoryId||before.stage!==after.stage||
    before.to>after.from||before.to-before.from!==after.to-after.from)return unavailable('WINDOWS_NOT_COMPARABLE');
 if(a.sampleCount<5||b.sampleCount<5)return unavailable('INSUFFICIENT_SAMPLES');
 return {state:'synthetic',reason:'COMPARABLE_FIXTURES',before:a,after:b,deltaP50:b.p50-a.p50,deltaP95:b.p95-a.p95};
}

const githubProxies = new Set(['issue-created-to-close', 'pr-created-to-merge']);
const queryFields = ['repositoryId', 'metric', 'fromMs', 'toMs', 'observedMs', 'nowMs', 'maxAgeMs', 'sourceComplete'];
const rowFields = ['id', 'repositoryId', 'metric', 'openedMs', 'endedMs', 'state'];
const terminalStates = new Set(['completed', 'closed-unmerged']);
const pendingStates = new Set(['open', 'unknown']);

function dataRecord(value, fields) {
  return value !== null && typeof value === 'object' && !types.isProxy(value) &&
    !Array.isArray(value) && Reflect.ownKeys(value).length === fields.length &&
    fields.every(field => Object.hasOwn(Object.getOwnPropertyDescriptor(value, field) ?? {}, 'value'));
}

function dataArray(value, limit) {
  return !types.isProxy(value) && Array.isArray(value) && value.length <= limit &&
    Object.getPrototypeOf(value) === Array.prototype && Reflect.ownKeys(value).length === value.length + 1 &&
    Array.from({length: value.length}, (_, i) => i).every(i =>
      Object.hasOwn(Object.getOwnPropertyDescriptor(value, i) ?? {}, 'value'));
}

function validGithubRow(row, query) {
  if (!dataRecord(row, rowFields) || !positive(row.id) || row.repositoryId !== query.repositoryId ||
      row.metric !== query.metric || !integer(row.openedMs) || row.openedMs > query.observedMs) return false;
  if (pendingStates.has(row.state)) return row.endedMs === null;
  return terminalStates.has(row.state) &&
    (row.state !== 'closed-unmerged' || query.metric === 'pr-created-to-merge') &&
    integer(row.endedMs) && row.endedMs >= row.openedMs && row.endedMs <= query.observedMs;
}

/**
 * Aggregate one repository and one GitHub proxy. The authorization list and
 * source-completeness flag are supplied by the trusted read-only caller.
 */
export function aggregateGithubTiming(rows, query, authorizedRepositoryIds) {
  if (!dataRecord(query, queryFields) || !positive(query.repositoryId) ||
      !dataArray(authorizedRepositoryIds, 32) || !authorizedRepositoryIds.every(positive) ||
      !authorizedRepositoryIds.includes(query.repositoryId) || !githubProxies.has(query.metric) ||
      !integer(query.fromMs) || !integer(query.toMs) || query.fromMs >= query.toMs ||
      typeof query.sourceComplete !== 'boolean') return unknown('SCOPE_UNKNOWN');
  if (!integer(query.observedMs) || !integer(query.nowMs) || !positive(query.maxAgeMs) ||
      query.observedMs < query.toMs || query.observedMs > query.nowMs) return unknown('FRESHNESS_UNKNOWN');
  if (query.nowMs - query.observedMs > query.maxAgeMs) return unknown('STALE_EVIDENCE');
  if (!dataArray(rows, 10000)) return unknown('INVALID_ROWS');

  const seen = new Map();
  const durations = [];
  const counts = {cohort: 0, completed: 0, censored: 0, closedUnmerged: 0, unknown: 0};
  for (const row of rows) {
    if (!validGithubRow(row, query)) return unknown('INVALID_ROW');
    const prior = seen.get(row.id);
    if (prior) {
      if (prior.openedMs !== row.openedMs || prior.endedMs !== row.endedMs || prior.state !== row.state) {
        return unknown('CONFLICTING_EVIDENCE');
      }
      continue;
    }
    seen.set(row.id, row);
    if (row.openedMs < query.fromMs || row.openedMs >= query.toMs) continue;
    counts.cohort++;
    if (row.state === 'unknown') counts.unknown++;
    else if (row.state === 'open' || row.endedMs >= query.toMs) counts.censored++;
    else if (row.state === 'closed-unmerged') counts.closedUnmerged++;
    else {
      counts.completed++;
      durations.push(row.endedMs - row.openedMs);
    }
  }

  durations.sort((a, b) => a - b);
  const percentile = p => durations[Math.ceil(p * durations.length) - 1] ?? null;
  const partial = !query.sourceComplete || counts.unknown > 0;
  const state = counts.completed === 0 ? 'unknown' : partial ? 'partial' : 'historical-proxy';
  const reason = counts.completed === 0 ? 'NO_COMPLETED_SAMPLES' : partial ? 'PARTIAL_EVIDENCE' : 'MEASURED_PROXY';
  return {
    state, reason, source: 'github-proxy', repositoryId: query.repositoryId, metric: query.metric,
    fromMs: query.fromMs, toMs: query.toMs, observedMs: query.observedMs, sourceComplete: query.sourceComplete,
    counts, sampleCount: counts.completed, p50: percentile(0.5), p95: percentile(0.95)
  };
}

export const VELOCITY_STAGE_OBJECTIVES = Object.freeze({
  'ready->firstPr': Object.freeze({initialMs: 600000, stretchMs: 120000, strictLessInitial: false}),
  'draft->publish': Object.freeze({initialMs: 180000, stretchMs: 60000, strictLessInitial: false}),
  'publish->merge': Object.freeze({initialMs: 420000, stretchMs: 180000, strictLessInitial: false}),
  'creation->merge': Object.freeze({initialMs: 600000, stretchMs: 240000, strictLessInitial: false}),
  'merge->verifiedMain': Object.freeze({initialMs: 120000, stretchMs: 60000, strictLessInitial: false}),
  'eligible->merge': Object.freeze({initialMs: 120000, stretchMs: 30000, strictLessInitial: false}),
  'ciEvent->lastRequiredCheck': Object.freeze({initialMs: 75000, stretchMs: 30000, strictLessInitial: true})
});

export const SCORECARD_PROVENANCES = Object.freeze([
  'verified-autonomous-outcome',
  'synthetic-fixture',
  'historical-github-proxy'
]);

const nonProxyProvenances = new Set(SCORECARD_PROVENANCES.filter(p => p !== 'historical-github-proxy'));
export const isNonProxyProvenance = value => nonProxyProvenances.has(value);
const stageQueryFields = [
  'repositoryId', 'cohort', 'provenance', 'fromMs', 'toMs', 'observedMs', 'nowMs', 'maxAgeMs', 'sourceComplete'
];
const stageSampleFields = [
  'id', 'repositoryId', 'cohort', 'provenance', 'stage', 'startedMs', 'endedMs', 'state'
];
const validCohortLabel = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const validSampleToken = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const unknownStages = reason => ({known: false, reason, stages: null});

export function ownDataValue(value, key) {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

export function isHistoricalProxyArtifact(value) {
  return ownDataValue(value, 'provenance') === 'historical-github-proxy' ||
    ownDataValue(value, 'source') === 'github-proxy' ||
    githubProxies.has(ownDataValue(value, 'metric'));
}

function validStageTiming(row, observedMs) {
  if (row.state === 'completed') {
    return integer(row.startedMs) && integer(row.endedMs) &&
      row.endedMs >= row.startedMs && row.endedMs <= observedMs;
  }
  if (row.state === 'open') {
    return integer(row.startedMs) && row.startedMs <= observedMs && row.endedMs === null;
  }
  return row.state === 'unknown' && row.endedMs === null &&
    (row.startedMs === null || (integer(row.startedMs) && row.startedMs <= observedMs));
}

/**
 * Aggregate canonical M02.02 velocity stages for one repository and cohort.
 * Rejects historical GitHub proxy artifacts and cross-provenance blending.
 */
export function aggregateScorecardStages(samples, query, authorizedRepositoryIds) {
  if (isHistoricalProxyArtifact(query)) return unknownStages('PROVENANCE_ISOLATION_VIOLATION');
  if (!dataRecord(query, stageQueryFields) || !positive(query.repositoryId) ||
      !dataArray(authorizedRepositoryIds, 32) || !authorizedRepositoryIds.every(positive) ||
      !authorizedRepositoryIds.includes(query.repositoryId) || !validCohortLabel(query.cohort) ||
      !nonProxyProvenances.has(query.provenance) || !integer(query.fromMs) || !integer(query.toMs) ||
      query.fromMs >= query.toMs || typeof query.sourceComplete !== 'boolean') {
    return unknownStages('SCOPE_UNKNOWN');
  }
  if (!integer(query.observedMs) || !integer(query.nowMs) || !positive(query.maxAgeMs) ||
      query.observedMs < query.toMs || query.observedMs > query.nowMs) {
    return unknownStages('FRESHNESS_UNKNOWN');
  }
  if (query.nowMs - query.observedMs > query.maxAgeMs) return unknownStages('STALE_EVIDENCE');
  if (!dataArray(samples, 10000)) return unknownStages('INVALID_SAMPLES');

  const buckets = {};
  for (const stage of Object.keys(VELOCITY_STAGE_OBJECTIVES)) {
    buckets[stage] = {
      durations: [],
      counts: {cohort: 0, completed: 0, censored: 0, unknown: 0},
      initialMissCount: 0,
      stretchMissCount: 0,
      overdueOpenCount: 0
    };
  }

  const seen = new Map();
  for (const row of samples) {
    if (isHistoricalProxyArtifact(row)) return unknownStages('PROVENANCE_ISOLATION_VIOLATION');
    if (!dataRecord(row, stageSampleFields)) return unknownStages('INVALID_SAMPLE');
    if (row.provenance !== query.provenance) {
      return unknownStages(nonProxyProvenances.has(row.provenance)
        ? 'PROVENANCE_ISOLATION_VIOLATION'
        : 'INVALID_SAMPLE');
    }
    if (row.repositoryId !== query.repositoryId || row.cohort !== query.cohort) {
      return unknownStages('SCOPE_MISMATCH');
    }
    if (!validSampleToken(row.id) || typeof row.stage !== 'string' ||
        !Object.hasOwn(VELOCITY_STAGE_OBJECTIVES, row.stage) || !validStageTiming(row, query.observedMs)) {
      return unknownStages('INVALID_SAMPLE');
    }
    const key = row.stage + ':' + row.id;
    const prior = seen.get(key);
    if (prior) {
      if (prior.startedMs !== row.startedMs || prior.endedMs !== row.endedMs || prior.state !== row.state) {
        return unknownStages('CONFLICTING_STAGE_EVIDENCE');
      }
      continue;
    }
    seen.set(key, row);
    if (row.startedMs !== null && (row.startedMs < query.fromMs || row.startedMs >= query.toMs)) continue;

    const bucket = buckets[row.stage];
    const spec = VELOCITY_STAGE_OBJECTIVES[row.stage];
    const missesInitial = value => spec.strictLessInitial ? value >= spec.initialMs : value > spec.initialMs;
    bucket.counts.cohort++;
    if (row.state === 'unknown') {
      bucket.counts.unknown++;
    } else if (row.state === 'open' || row.endedMs >= query.toMs) {
      bucket.counts.censored++;
      if (row.state === 'open' && missesInitial(query.observedMs - row.startedMs)) {
        bucket.overdueOpenCount++;
      }
    } else {
      const duration = row.endedMs - row.startedMs;
      bucket.counts.completed++;
      bucket.durations.push(duration);
      if (missesInitial(duration)) bucket.initialMissCount++;
      if (duration > spec.stretchMs) bucket.stretchMissCount++;
    }
  }

  const stages = {};
  let totalCompleted = 0;
  let totalCensored = 0;
  let totalUnknown = 0;
  for (const [stage, spec] of Object.entries(VELOCITY_STAGE_OBJECTIVES)) {
    const bucket = buckets[stage];
    bucket.durations.sort((a, b) => a - b);
    const percentile = p => bucket.durations[Math.ceil(p * bucket.durations.length) - 1] ?? null;
    const p50Ms = percentile(0.5);
    const p95Ms = percentile(0.95);
    const partial = !query.sourceComplete || bucket.counts.unknown > 0;
    const status = partial ? 'partial' : bucket.counts.completed > 0 ? 'measured' : 'no-samples';
    const meetsInitial = value => spec.strictLessInitial ? value < spec.initialMs : value <= spec.initialMs;
    const evaluable = !partial && p50Ms !== null;
    totalCompleted += bucket.counts.completed;
    totalCensored += bucket.counts.censored;
    totalUnknown += bucket.counts.unknown;
    stages[stage] = {
      stage,
      status,
      sampleCount: bucket.counts.completed,
      counts: bucket.counts,
      p50Ms,
      p95Ms,
      objectives: {initialMs: spec.initialMs, stretchMs: spec.stretchMs},
      slo: {
        initialMissCount: bucket.initialMissCount,
        stretchMissCount: bucket.stretchMissCount,
        overdueOpenCount: bucket.overdueOpenCount,
        p50MeetsInitial: evaluable ? meetsInitial(p50Ms) : null,
        p95MeetsInitial: evaluable ? meetsInitial(p95Ms) : null,
        p50MeetsStretch: evaluable ? p50Ms <= spec.stretchMs : null,
        p95MeetsStretch: evaluable ? p95Ms <= spec.stretchMs : null
      }
    };
  }

  const complete = query.sourceComplete && totalUnknown === 0;
  return {
    known: complete,
    reason: complete ? 'MEASURED_STAGES' : 'PARTIAL_STAGE_EVIDENCE',
    provenance: query.provenance,
    repositoryId: query.repositoryId,
    cohort: query.cohort,
    fromMs: query.fromMs,
    toMs: query.toMs,
    observedMs: query.observedMs,
    sourceComplete: query.sourceComplete,
    totals: {completed: totalCompleted, censored: totalCensored, unknown: totalUnknown},
    stages
  };
}
