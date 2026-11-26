import test from 'node:test';
import assert from 'node:assert/strict';
import {measureAcceptedCohort,measureIssueOutcome} from '../../tools/engineering-factory/outcome-measurement.mjs';
const h='a'.repeat(40);
const issue=()=>({repositoryId:1,number:9,state:'closed',acceptanceVerified:true,readyAt:100,acceptedAt:500,lastReopenedAt:null,requiredPullNumbers:[81,82]});
const pull=(number,at=300)=>({repositoryId:1,number,issueNumbers:[9,10],merged:true,mergeSha:h,mainVerifiedSha:h,mainVerified:true,mergedAt:200,mainVerifiedAt:at});
const pulls=()=>[pull(81),pull(82,400)];
test('counts one accepted outcome with multiple explicit PR links and exact merge-head main verification',()=>{
  assert.deepEqual(measureIssueOutcome(issue(),pulls()),{known:true,reason:'VERIFIED_OUTCOME',elapsedMs:400,mainVerifiedAt:400,requiredPullCount:2});
  assert.equal(measureIssueOutcome({...issue(),lastReopenedAt:150},pulls()).known,true);
  assert.equal(measureIssueOutcome(issue(),[...pulls(),{...pull(81),repositoryId:2},null]).known,true);
});
test('unknown or contradictory issue evidence is never converted to zero duration',()=>{
  for(const [value,reason] of [
    [null,'INVALID_INPUT'],[{...issue(),repositoryId:0},'INVALID_INPUT'],[{...issue(),number:0},'INVALID_INPUT'],
    [{...issue(),state:'open'},'ACCEPTANCE_UNVERIFIED'],[{...issue(),acceptanceVerified:false},'ACCEPTANCE_UNVERIFIED'],
    [{...issue(),readyAt:null},'TIMESTAMPS_UNKNOWN'],[{...issue(),acceptedAt:null},'TIMESTAMPS_UNKNOWN'],[{...issue(),acceptedAt:99},'TIMESTAMPS_UNKNOWN'],
    [{...issue(),lastReopenedAt:undefined},'REOPENED_OR_UNKNOWN'],[{...issue(),lastReopenedAt:500},'REOPENED_OR_UNKNOWN'],
    ...[null,[],[0],[81,81],Array(1),[81,,82],Array(251).fill(81)].map(requiredPullNumbers=>[{...issue(),requiredPullNumbers},'LINKS_UNKNOWN'])
  ])assert.deepEqual(measureIssueOutcome(value,pulls()),{known:false,reason});
  assert.equal(measureIssueOutcome(issue(),null).reason,'INVALID_INPUT');
});
test('partial, duplicated, unlinked, stale-main or invalid PR evidence fails closed',()=>{
  const cases=[
    [[], 'PULL_UNKNOWN_OR_DUPLICATE'],[[pull(81),pull(81),pull(82)],'PULL_UNKNOWN_OR_DUPLICATE'],
    ...[null,[10],[9,9]].map(issueNumbers=>[[{...pull(81),issueNumbers},pull(82)],'LINK_UNVERIFIED']),
    ...[{merged:false},{mergeSha:null},{mergeSha:'invalid'},{mainVerifiedSha:'b'.repeat(40)},{mainVerified:false}].map(change=>[[{...pull(81),...change},pull(82)],'MAIN_UNVERIFIED']),
    ...[{mergedAt:null},{mainVerifiedAt:null},{mainVerifiedAt:199},{mainVerifiedAt:501}].map(change=>[[{...pull(81),...change},pull(82)],'PULL_TIMESTAMPS_UNKNOWN'])
  ];
  for(const [p,reason] of cases)assert.deepEqual(measureIssueOutcome(issue(),p),{known:false,reason});
});

test('main verification timestamp comes only from PR evidence even when readiness is later',()=>{
  assert.deepEqual(measureIssueOutcome({...issue(),readyAt:450},pulls()),{known:true,reason:'VERIFIED_OUTCOME',elapsedMs:50,mainVerifiedAt:400,requiredPullCount:2});
});

test('rejects proxy and accessor-backed evidence without invoking getters',()=>{
  const poison=()=>{throw Error('unexpected getter');};
  const i=issue();Object.defineProperty(i,'readyAt',{get:poison});
  assert.equal(measureIssueOutcome(i,pulls()).known,false);
  assert.equal(measureIssueOutcome(new Proxy(issue(),{}),pulls()).known,false);
  assert.equal(measureIssueOutcome(issue(),new Proxy(pulls(),{})).known,false);
  const p=pulls();Object.defineProperty(p[0],'mainVerifiedAt',{get:poison});
  assert.equal(measureIssueOutcome(issue(),p).known,false);
  const pp=pulls();Object.defineProperty(pp,0,{get:poison});
  assert.equal(measureIssueOutcome(issue(),pp).known,false);
  const links=[81,82];Object.defineProperty(links,0,{get:poison});
  assert.equal(measureIssueOutcome({...issue(),requiredPullNumbers:links},pulls()).known,false);
  const pl=pulls();pl[0].issueNumbers=new Proxy([9],{});
  assert.equal(measureIssueOutcome(issue(),pl).known,false);
});

test('rejects custom array methods and iterators without executing evidence',()=>{
 let reads=0;const poison=()=>{reads++;throw Error('unexpected evidence method');};
 for(const key of ['some',Symbol.iterator]){
  const links=[81,82];Object.defineProperty(links,key,{get:poison});
  assert.equal(measureIssueOutcome({...issue(),requiredPullNumbers:links},pulls()).reason,'LINKS_UNKNOWN');
 }
 const ps=pulls();Object.defineProperty(ps,Symbol.iterator,{get:poison});
 assert.equal(measureIssueOutcome(issue(),ps).reason,'INVALID_INPUT');
 const ls=pulls();Object.defineProperty(ls[0].issueNumbers,'filter',{get:poison});
 assert.equal(measureIssueOutcome(issue(),ls).reason,'LINK_UNVERIFIED');
 assert.equal(reads,0);
});

const cohortQuery = {
  repositoryId: 1, cohort: 'small-independent', source: 'synthetic', complete: true,
  fromMs: 450, toMs: 86400450, observedMs: 86401000, nowMs: 86401000, maxAgeMs: 1000
};
const cost = (issueNumber, amountMicros = 0) => ({
  repositoryId: 1, issueNumber, receiptId: 'receipt-' + issueNumber,
  verified: true, currency: 'USD', amountMicros, observedMs: 86401000
});
const entry = (number, changes = {}) => ({
  cohort: cohortQuery.cohort, source: cohortQuery.source,
  issue: {...issue(), number, ...changes}, pulls: pulls(), cost: cost(number)
});
const cohort = (entries, changes = {}, allowed = [1]) =>
  measureAcceptedCohort(entries, {...cohortQuery, ...changes}, allowed);

test('counts one accepted issue across multiple pulls, uses acceptance window and exposes censored work', () => {
  const first = {...entry(9), cost: cost(9, 0)};
  const second = {...entry(10, {acceptedAt: 600, readyAt: 200}), cost: cost(10, 200)};
  const earlierAcceptance = entry(11, {acceptedAt: 449});
  earlierAcceptance.pulls = pulls().map(p => ({...p, issueNumbers: [11]}));
  const laterAcceptance = entry(12, {acceptedAt: cohortQuery.toMs});
  laterAcceptance.pulls = pulls().map(p => ({...p, issueNumbers: [12]}));
  const afterWindow = entry(13, {readyAt: cohortQuery.toMs, acceptedAt: cohortQuery.toMs + 1});
  afterWindow.pulls = pulls().map(p => ({...p, issueNumbers: [13]}));
  const open = entry(14, {state: 'open', acceptedAt: null});
  const upcoming = entry(15, {state: 'open', acceptedAt: null, readyAt: cohortQuery.toMs});
  const report = cohort([laterAcceptance, second, upcoming, first, open, earlierAcceptance, afterWindow]);
  assert.deepEqual(report, {
    known: true, reason: 'MEASURED_COHORT', source: 'synthetic',
    repositoryId: 1, cohort: cohortQuery.cohort, fromMs: 450, toMs: 86400450,
    observedMs: 86401000, sourceComplete: true,
    counts: {accepted: 2, censored: 2, unknown: 0, withVerifiedCost: 2},
    p50: 400, p95: 400, acceptedPerDay: 2, costPerAcceptedUsdMicros: 100
  });
  assert.equal(cohort([first]).costPerAcceptedUsdMicros, 0);
  const completeEmpty = cohort([]);
  assert.deepEqual([completeEmpty.acceptedPerDay, completeEmpty.costPerAcceptedUsdMicros, completeEmpty.p50],
    [0, null, null]);
});

test('preserves partial outcomes and keeps acceptance and cost unknown when evidence is incomplete', () => {
  const pending = entry(10, {acceptanceVerified: false});
  const reopened = entry(11, {state: 'open', acceptedAt: 500, lastReopenedAt: 600});
  const outsideEvidence = entry(12, {acceptedAt: cohortQuery.observedMs + 1});
  outsideEvidence.pulls = pulls().map(p => ({...p, issueNumbers: [12]}));
  const badReady = entry(13, {state: 'open', acceptedAt: null, readyAt: null});
  const futureReady = entry(14, {state: 'open', acceptedAt: null, readyAt: cohortQuery.observedMs + 1});
  for (const rows of [[entry(9), pending], [entry(9), reopened], [entry(9), outsideEvidence],
    [entry(9), badReady], [entry(9), futureReady]]) {
    const report = cohort(rows);
    assert.equal(report.reason, 'PARTIAL_EVIDENCE');
    assert.equal(report.counts.unknown, 1);
    assert.deepEqual([report.p95, report.acceptedPerDay, report.costPerAcceptedUsdMicros], [400, null, null]);
  }
  assert.deepEqual([cohort([entry(9)], {complete: false}).acceptedPerDay,
    cohort([entry(9)], {complete: false}).sourceComplete], [null, false]);
  for (const amount of [null, ...[
    {repositoryId: 2}, {issueNumber: 8}, {verified: false}, {currency: 'GBP'}, {receiptId: 'unknown receipt'},
    {amountMicros: -1}, {observedMs: null}, {observedMs: 0}, {observedMs: cohortQuery.observedMs + 1}
  ].map(change => ({...cost(9), ...change}))]) {
    const report = cohort([{...entry(9), cost: amount}]);
    assert.deepEqual([report.acceptedPerDay, report.costPerAcceptedUsdMicros, report.counts.withVerifiedCost], [1, null, 0]);
  }
  const other = entry(10);
  assert.equal(cohort([entry(9), {...other, cost: {...other.cost, receiptId: cost(9).receiptId}}]).reason,
    'CONFLICTING_COST_EVIDENCE');
  assert.equal(cohort([{...entry(9), cost: cost(9, Number.MAX_SAFE_INTEGER)},
    {...other, cost: cost(10, 1)}]).reason, 'CONFLICTING_COST_EVIDENCE');
});

test('checks receipt uniqueness outside the window without adding outside spend', () => {
  const inside = {...entry(9), cost: cost(9, 100)};
  for (const acceptedAt of [cohortQuery.fromMs - 1, cohortQuery.toMs]) {
    const outside = {...entry(10, {acceptedAt}), cost: cost(10, Number.MAX_SAFE_INTEGER)};
    assert.equal(cohort([inside, outside]).costPerAcceptedUsdMicros, 100);
    outside.cost.receiptId = inside.cost.receiptId;
    for (const entries of [[inside, outside], [outside, inside]]) {
      assert.equal(cohort(entries).reason, 'CONFLICTING_COST_EVIDENCE');
    }
  }
});

test('fails closed on stale data, cross-repository and mixed cohort sources, and duplicate issues', () => {
  const sample = entry(9);
  for (const changes of [{repositoryId: 0}, {cohort: 'small independent'}, {cohort: null},
    {source: 'github-proxy'}, {complete: 'true'}, {fromMs: -1}, {toMs: null}, {toMs: 450}]) {
    assert.equal(cohort([sample], changes).reason, 'COHORT_UNKNOWN');
  }
  for (const allowed of [null, [0], [2], new Array(1)]) {
    assert.equal(cohort([sample], {}, allowed).reason, 'COHORT_UNKNOWN');
  }
  for (const changes of [{observedMs: null}, {nowMs: -1}, {maxAgeMs: 0},
    {observedMs: 86400449}, {nowMs: 86400999}]) {
    assert.equal(cohort([sample], changes).reason, 'FRESHNESS_UNKNOWN');
  }
  assert.equal(cohort([sample], {nowMs: 86402001}).reason, 'STALE_EVIDENCE');
  for (const values of [null, new Array(1), Array(501).fill(sample)]) {
    assert.equal(cohort(values).reason, 'INVALID_ENTRIES');
  }
  for (const row of [null, {...sample, cohort: 'different'}, {...sample, source: 'verified'},
    {...sample, issue: null}, {...sample, issue: {...sample.issue, repositoryId: 2}},
    {...sample, issue: {...sample.issue, number: 0}}]) {
    assert.equal(cohort([row]).reason, 'ENTRY_SCOPE_UNKNOWN');
  }
  assert.equal(cohort([sample, sample]).reason, 'DUPLICATE_ISSUE');
  const verified = cohort([{...sample, source: 'verified'}], {source: 'verified'});
  assert.equal(verified.source, 'verified');
  assert.equal(cohort([{...sample, pulls: [null, {}]}]).counts.unknown, 1);
  assert.equal(cohort([{...sample, pulls: Array(251).fill(null)}]).counts.unknown, 1);
  const tooManyPulls = Array.from({length: 41}, (_, index) =>
    ({...entry(index + 1), pulls: Array(250).fill(null)}));
  assert.equal(cohort(tooManyPulls).reason, 'PULL_EVIDENCE_LIMIT');
  const replacedIndex = Object.assign(new Array(1), {nonIndex: sample});
  assert.equal(cohort(replacedIndex).reason, 'INVALID_ENTRIES');
  const {issue: ignored, ...missingIssue} = sample;
  assert.equal(cohort([{...missingIssue, unrelated: ignored}]).reason, 'ENTRY_SCOPE_UNKNOWN');
});
