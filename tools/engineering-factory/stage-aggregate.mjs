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
