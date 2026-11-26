// Offline measurement only. Inputs must come from a separately trusted evidence
// adapter; this function neither grants authority nor infers issue acceptance.
import {types} from 'node:util';
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
