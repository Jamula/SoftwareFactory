import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCORECARD_PROVENANCES,
  VELOCITY_STAGE_OBJECTIVES,
  aggregateStage as aggregate,
  compareStageWindows,
  aggregateGithubTiming,
  aggregateScorecardStages,
  isHistoricalProxyArtifact,
  ownDataValue
} from '../../tools/engineering-factory/stage-aggregate.mjs';
const q={repositoryId:1,stage:'review',from:10,to:20,complete:true,source:'synthetic',observedMs:20,nowMs:22,maxAgeMs:10};
const r={id:'sample-1',repositoryId:1,stage:'review',at:10,duration:5,source:'synthetic'};
test('bounded window and nearest-rank percentiles',()=>{
 const rows=[r,{...r,id:'sample-2',at:19,duration:20},{...r,id:'sample-3',at:20},{...r,id:'sample-4',at:9},{...r,id:'sample-5',stage:'ci'}];
 assert.deepEqual(aggregate(rows,q),{state:'synthetic',reason:'MEASURED_FIXTURE',sampleCount:2,p50:5,p95:20});
 assert.equal(aggregate([],q).reason,'NO_SAMPLES');
 assert.equal(aggregate([{...r,duration:0}],q).p50,0);
});
test('invalid, incomplete and cross-scope evidence fails closed',()=>{
 for(const x of [null,[],Object.create(q),{...q,repositoryId:0},{...q,stage:'bad'},{...q,from:-1},{...q,to:1.5},{...q,to:10},{...q,complete:false},{...q,source:'live'}]) assert.equal(aggregate([r],x).reason,'SCOPE_UNKNOWN');
 for(const x of [null,new Array(1),Array(10001).fill(r)]) assert.equal(aggregate(x,q).reason,'INVALID_ROWS');
 for(const x of [null,Object.create(r),{...r,id:1},{...r,id:'bad id'},{...r,repositoryId:2},{...r,stage:'bad'},{...r,at:-1},{...r,duration:-1},{...r,source:'live'}]) assert.equal(aggregate([x],q).reason,'INVALID_ROW');
 assert.equal(aggregate([r,r],q).reason,'DUPLICATE_EVIDENCE');
});

test('freshness is about snapshot acquisition, not historical sample age',()=>{
 assert.equal(aggregate([r],{...q,nowMs:31}).reason,'STALE_EVIDENCE');
 for(const x of [{observedMs:19},{observedMs:23},{nowMs:null},{maxAgeMs:0},{observedMs:undefined}]) assert.equal(aggregate([r],{...q,...x}).reason,'FRESHNESS_UNKNOWN');
 assert.equal(aggregate([r],{...q,nowMs:30}).sampleCount,1);
 const oversized=new Array(10001);Object.defineProperty(oversized,0,{get(){throw Error('must not read oversized array');}});
 assert.equal(aggregate(oversized,q).reason,'INVALID_ROWS');
});

test('compare only equally sized nonoverlapping complete windows with enough samples',()=>{
 const before={...q,from:10,to:20,observedMs:40,nowMs:40};
 const after={...before,from:30,to:40};
 const rows=(query,offset)=>Array.from({length:5},(_,i)=>({...r,id:'row-'+i,at:query.from+i,duration:i+offset}));
 const a=rows(before,10),b=rows(after,5);
 const result=compareStageWindows(a,before,b,after);
 assert.equal(result.state,'synthetic');assert.equal(result.before.sampleCount,5);
 assert.equal(result.deltaP50,-5);assert.equal(result.deltaP95,-5);
 assert.equal(compareStageWindows([],before,b,after).reason,'EVIDENCE_UNKNOWN');
 assert.equal(compareStageWindows(a,before,[],after).reason,'EVIDENCE_UNKNOWN');
 assert.equal(compareStageWindows(a.slice(0,4),before,b,after).reason,'INSUFFICIENT_SAMPLES');
 assert.equal(compareStageWindows(a,before,b.slice(0,4),after).reason,'INSUFFICIENT_SAMPLES');
 for(const change of [{repositoryId:2},{stage:'ci'},{from:15,to:25},{to:41,observedMs:41,nowMs:41}]){
  const alt={...after,...change};const sample=rows(alt,5).map(row=>({...row,repositoryId:alt.repositoryId,stage:alt.stage}));
  assert.equal(compareStageWindows(a,before,sample,alt).reason,'WINDOWS_NOT_COMPARABLE');
 }
});

const proxyQuery = {
  repositoryId: 1, metric: 'pr-created-to-merge', fromMs: 10, toMs: 40,
  observedMs: 50, nowMs: 55, maxAgeMs: 10, sourceComplete: true
};
const proxyRow = {
  id: 1, repositoryId: 1, metric: proxyQuery.metric, openedMs: 10, endedMs: 15, state: 'completed'
};
const proxy = (rows, change = {}, allowed = [1]) => aggregateGithubTiming(rows, {...proxyQuery, ...change}, allowed);

test('isolates GitHub proxy cohorts, deduplicates rows, and excludes censored or unmerged items', () => {
  const report = proxy([
    {...proxyRow, id: 9, openedMs: 18, endedMs: 30},
    proxyRow, {...proxyRow}, {...proxyRow, id: 2, endedMs: 10},
    {...proxyRow, id: 3, openedMs: 9}, {...proxyRow, id: 4, openedMs: 40, endedMs: 45},
    {...proxyRow, id: 5, endedMs: 40}, {...proxyRow, id: 6, endedMs: null, state: 'open'},
    {...proxyRow, id: 7, state: 'closed-unmerged'}
  ]);
  assert.deepEqual(report, {
    state: 'historical-proxy', reason: 'MEASURED_PROXY', source: 'github-proxy',
    repositoryId: 1, metric: proxyQuery.metric, fromMs: 10, toMs: 40, observedMs: 50, sourceComplete: true,
    counts: {cohort: 6, completed: 3, censored: 2, closedUnmerged: 1, unknown: 0}, sampleCount: 3, p50: 5, p95: 12
  });
  const issueMetric = 'issue-created-to-close';
  assert.equal(proxy([{...proxyRow, metric: issueMetric}], {metric: issueMetric}).p50, 5);
  assert.equal(proxy([{...proxyRow, metric: issueMetric, state: 'closed-unmerged'}],
    {metric: issueMetric}).reason, 'INVALID_ROW');
});

test('reports incomplete and unknown evidence without fabricating zero durations', () => {
  assert.equal(proxy([proxyRow], {sourceComplete: false}).state, 'partial');
  const unknownRow = {...proxyRow, id: 2, endedMs: null, state: 'unknown'};
  const partial = proxy([proxyRow, unknownRow]);
  assert.equal(partial.reason, 'PARTIAL_EVIDENCE');
  assert.equal(partial.counts.unknown, 1);
  assert.deepEqual([partial.sampleCount, partial.p50, partial.p95], [1, 5, 5]);
  const absent = proxy([unknownRow]);
  assert.equal(absent.state, 'unknown');
  assert.equal(absent.reason, 'NO_COMPLETED_SAMPLES');
  assert.deepEqual([absent.sampleCount, absent.p50, absent.p95], [0, null, null]);
  assert.equal(proxy([], {sourceComplete: false}).counts.cohort, 0);
});

test('rejects unauthorized, stale, and malformed provenance', () => {
  for (const change of [
    {repositoryId: 0}, {metric: 'verified-acceptance'}, {fromMs: -1}, {toMs: null},
    {fromMs: 40}, {sourceComplete: 'true'}
  ]) assert.equal(proxy([proxyRow], change).reason, 'SCOPE_UNKNOWN');
  for (const allowed of [null, [0], [2], new Array(1), Array(33).fill(1)]) {
    assert.equal(proxy([proxyRow], {}, allowed).reason, 'SCOPE_UNKNOWN');
  }
  for (const change of [
    {observedMs: null}, {nowMs: -1}, {maxAgeMs: 0}, {observedMs: 39}, {observedMs: 56}
  ]) assert.equal(proxy([proxyRow], change).reason, 'FRESHNESS_UNKNOWN');
  assert.equal(proxy([proxyRow], {nowMs: 61}).reason, 'STALE_EVIDENCE');
  for (const rows of [null, new Array(1), Array(10001).fill(proxyRow)]) {
    assert.equal(proxy(rows).reason, 'INVALID_ROWS');
  }
  for (const row of [
    null, 1, [], {...proxyRow, id: 0}, {...proxyRow, repositoryId: 2},
    {...proxyRow, metric: 'issue-created-to-close'}, {...proxyRow, openedMs: null}, {...proxyRow, openedMs: 51},
    {...proxyRow, state: 'open'}, {...proxyRow, state: 'synthetic'}, {...proxyRow, endedMs: null},
    {...proxyRow, endedMs: 9}, {...proxyRow, endedMs: 51}, {...proxyRow, title: 'sensitive'}
  ]) assert.equal(proxy([row]).reason, 'INVALID_ROW');
  for (const change of [{openedMs: 11}, {endedMs: 16}, {state: 'closed-unmerged'}]) {
    assert.equal(proxy([proxyRow, {...proxyRow, ...change}]).reason, 'CONFLICTING_EVIDENCE');
  }
});

test('rejects accessors and proxies without invoking them', () => {
  const trap = () => assert.fail('unexpected access to untrusted data');
  const handler = {ownKeys: trap, getOwnPropertyDescriptor: trap, get: trap};
  assert.equal(aggregateGithubTiming([proxyRow], new Proxy(proxyQuery, handler), [1]).reason, 'SCOPE_UNKNOWN');
  assert.equal(proxy([new Proxy(proxyRow, handler)]).reason, 'INVALID_ROW');
  assert.equal(proxy(new Proxy([proxyRow], handler)).reason, 'INVALID_ROWS');
  const accessorRow = {...proxyRow, get id() { return trap(); }};
  const accessorRows = [proxyRow];
  Object.defineProperty(accessorRows, 0, {get: trap});
  assert.equal(proxy([accessorRow]).reason, 'INVALID_ROW');
  assert.equal(proxy(accessorRows).reason, 'INVALID_ROWS');
  const customRows = Object.setPrototypeOf([proxyRow], {[Symbol.iterator]: trap});
  const extraKey = Object.defineProperty([proxyRow], Symbol.iterator, {get: trap});
  assert.equal(proxy(customRows).reason, 'INVALID_ROWS');
  assert.equal(proxy(extraKey).reason, 'INVALID_ROWS');
  const {id, ...withoutId} = proxyRow;
  assert.equal(proxy([{...withoutId, evidenceId: id}]).reason, 'INVALID_ROW');
  const spareKey = Object.assign(new Array(1), {other: proxyRow});
  assert.equal(proxy(spareKey).reason, 'INVALID_ROWS');
});

const stageQuery = {
  repositoryId: 1,
  cohort: 'small-independent',
  provenance: 'verified-autonomous-outcome',
  fromMs: 1000,
  toMs: 900000,
  observedMs: 1000000,
  nowMs: 1000500,
  maxAgeMs: 5000,
  sourceComplete: true
};

const stageSample = (stage, id, startedMs, endedMs, state = 'completed', overrides = {}) => ({
  id,
  repositoryId: 1,
  cohort: 'small-independent',
  provenance: 'verified-autonomous-outcome',
  stage,
  startedMs,
  endedMs,
  state,
  ...overrides
});

test('aggregates all seven M02.02 velocity stages, SLO misses, censored items, and overdue open items', () => {
  assert.deepEqual(SCORECARD_PROVENANCES, [
    'verified-autonomous-outcome', 'synthetic-fixture', 'historical-github-proxy'
  ]);
  assert.equal(Object.keys(VELOCITY_STAGE_OBJECTIVES).length, 7);

  const samples = [
    stageSample('ready->firstPr', 'rfp-1', 2000, 122000),
    stageSample('ready->firstPr', 'rfp-1', 2000, 122000),
    stageSample('ready->firstPr', 'rfp-2', 3000, 653000),
    stageSample('ready->firstPr', 'rfp-open-overdue', 10000, null, 'open'),
    stageSample('ready->firstPr', 'rfp-after-window', 900000, null, 'open'),
    stageSample('ready->firstPr', 'rfp-before', 999, 2000),
    stageSample('draft->publish', 'dp-ready-at-create', 5000, 5000),
    stageSample('draft->publish', 'dp-slow', 6000, 126000),
    stageSample('draft->publish', 'dp-censored-cutoff', 800000, 900000),
    stageSample('publish->merge', 'pm-1', 10000, 190000),
    stageSample('creation->merge', 'cm-1', 5000, 245000),
    stageSample('merge->verifiedMain', 'mv-1', 245000, 295000),
    stageSample('eligible->merge', 'em-1', 200000, 225000),
    stageSample('eligible->merge', 'em-2', 210000, 340000),
    stageSample('ciEvent->lastRequiredCheck', 'ci-fast', 10000, 40000),
    stageSample('ciEvent->lastRequiredCheck', 'ci-75s-boundary', 20000, 95000),
    stageSample('ciEvent->lastRequiredCheck', 'ci-open-fresh', 890000, null, 'open'),
    stageSample('ciEvent->lastRequiredCheck', 'ci-open-75s-overdue', 850000, null, 'open',
      {startedMs: 890000}),
    stageSample('ciEvent->lastRequiredCheck', 'ci-open-exact-75s', 825000, null, 'open')
  ];
  // Adjust ci-open-exact-75s so observedMs - startedMs === 75000 falls inside [fromMs, toMs) only when startedMs < toMs:
  const adjusted = samples.filter(s => s.id !== 'ci-open-75s-overdue' && s.id !== 'ci-open-exact-75s');
  adjusted.push(stageSample('ciEvent->lastRequiredCheck', 'ci-open-exact', 899000, null, 'open')); // age 101000 >= 75000
  const freshOpenQuery = {...stageQuery, observedMs: 900000, nowMs: 900500};
  // At observedMs = 900000:
  // ci-open-fresh started at 890000 -> age 10000 (< 75000, not overdue)
  // ci-open-exact started at 825000 -> age 75000 (>= 75000, strict <75s overdue!)
  adjusted.pop();
  adjusted.push(stageSample('ciEvent->lastRequiredCheck', 'ci-open-exact-75s', 825000, null, 'open'));

  const report = aggregateScorecardStages(adjusted, freshOpenQuery, [1]);
  assert.equal(report.known, true);
  assert.equal(report.reason, 'MEASURED_STAGES');
  assert.equal(report.provenance, 'verified-autonomous-outcome');

  const rfp = report.stages['ready->firstPr'];
  assert.equal(rfp.status, 'measured');
  assert.deepEqual(rfp.counts, {cohort: 3, completed: 2, censored: 1, unknown: 0});
  assert.deepEqual([rfp.p50Ms, rfp.p95Ms], [120000, 650000]);
  assert.deepEqual(rfp.slo, {
    initialMissCount: 1,
    stretchMissCount: 1,
    overdueOpenCount: 1,
    p50MeetsInitial: true,
    p95MeetsInitial: false,
    p50MeetsStretch: true,
    p95MeetsStretch: false
  });

  const dp = report.stages['draft->publish'];
  assert.deepEqual(dp.counts, {cohort: 3, completed: 2, censored: 1, unknown: 0});
  assert.deepEqual([dp.p50Ms, dp.p95Ms], [0, 120000]);
  assert.equal(dp.slo.p95MeetsInitial, true);
  assert.equal(dp.slo.p95MeetsStretch, false);

  const ci = report.stages['ciEvent->lastRequiredCheck'];
  assert.deepEqual(ci.counts, {cohort: 4, completed: 2, censored: 2, unknown: 0});
  assert.deepEqual([ci.p50Ms, ci.p95Ms], [30000, 75000]);
  assert.deepEqual(ci.slo, {
    initialMissCount: 1,
    stretchMissCount: 1,
    overdueOpenCount: 1,
    p50MeetsInitial: true,
    p95MeetsInitial: false,
    p50MeetsStretch: true,
    p95MeetsStretch: false
  });

  const emptyReport = aggregateScorecardStages([], freshOpenQuery, [1]);
  assert.equal(emptyReport.known, true);
  for (const stage of Object.keys(VELOCITY_STAGE_OBJECTIVES)) {
    assert.equal(emptyReport.stages[stage].status, 'no-samples');
    assert.equal(emptyReport.stages[stage].p50Ms, null);
    assert.equal(emptyReport.stages[stage].p95Ms, null);
    assert.equal(emptyReport.stages[stage].slo.p50MeetsInitial, null);
  }
});

test('marks stages partial when sourceComplete is false or unknown stage timestamps exist', () => {
  const withUnknown = aggregateScorecardStages([
    stageSample('publish->merge', 'pm-ok', 10000, 50000),
    stageSample('publish->merge', 'pm-missing-start', null, null, 'unknown'),
    stageSample('eligible->merge', 'em-missing-end', 20000, null, 'unknown')
  ], stageQuery, [1]);
  assert.equal(withUnknown.known, false);
  assert.equal(withUnknown.reason, 'PARTIAL_STAGE_EVIDENCE');
  assert.equal(withUnknown.totals.unknown, 2);
  assert.equal(withUnknown.stages['publish->merge'].status, 'partial');
  assert.equal(withUnknown.stages['publish->merge'].p50Ms, 40000);
  assert.equal(withUnknown.stages['publish->merge'].slo.p50MeetsInitial, null);
  assert.equal(withUnknown.stages['eligible->merge'].status, 'partial');
  assert.equal(withUnknown.stages['eligible->merge'].p50Ms, null);

  const incompleteSource = aggregateScorecardStages(
    [stageSample('publish->merge', 'pm-ok', 10000, 50000)],
    {...stageQuery, sourceComplete: false},
    [1]
  );
  assert.equal(incompleteSource.known, false);
  assert.equal(incompleteSource.stages['publish->merge'].status, 'partial');
});

test('enforces strict provenance isolation and fails closed on invalid, stale, conflicting, or proxy stage evidence', () => {
  assert.equal(ownDataValue(null, 'provenance'), undefined);
  assert.equal(ownDataValue(42, 'provenance'), undefined);
  const trap = () => assert.fail('must not invoke untrusted getter');
  assert.equal(ownDataValue(new Proxy({}, {getOwnPropertyDescriptor: trap}), 'provenance'), undefined);
  const accessorObj = {};
  Object.defineProperty(accessorObj, 'provenance', {get: trap});
  assert.equal(ownDataValue(accessorObj, 'provenance'), undefined);
  assert.equal(isHistoricalProxyArtifact({provenance: 'historical-github-proxy'}), true);
  assert.equal(isHistoricalProxyArtifact({source: 'github-proxy'}), true);
  assert.equal(isHistoricalProxyArtifact(proxyRow), true);
  assert.equal(isHistoricalProxyArtifact({provenance: 'verified-autonomous-outcome'}), false);

  assert.equal(
    aggregateScorecardStages([], {...stageQuery, provenance: 'historical-github-proxy'}, [1]).reason,
    'PROVENANCE_ISOLATION_VIOLATION'
  );
  for (const badRow of [
    proxyRow,
    stageSample('ready->firstPr', 'p1', 2000, 3000, 'completed', {provenance: 'historical-github-proxy'}),
    stageSample('ready->firstPr', 'p2', 2000, 3000, 'completed', {source: 'github-proxy'}),
    stageSample('ready->firstPr', 'p3', 2000, 3000, 'completed', {provenance: 'synthetic-fixture'})
  ]) {
    assert.equal(
      aggregateScorecardStages([badRow], stageQuery, [1]).reason,
      'PROVENANCE_ISOLATION_VIOLATION'
    );
  }

  for (const change of [
    {repositoryId: 0}, {cohort: null}, {cohort: 'Bad Cohort'}, {provenance: 'unknown-source'},
    {fromMs: -1}, {toMs: null}, {fromMs: 900000}, {sourceComplete: 'yes'}
  ]) {
    assert.equal(aggregateScorecardStages([], {...stageQuery, ...change}, [1]).reason, 'SCOPE_UNKNOWN');
  }
  for (const allowed of [null, [0], [2], new Array(1)]) {
    assert.equal(aggregateScorecardStages([], stageQuery, allowed).reason, 'SCOPE_UNKNOWN');
  }
  for (const change of [
    {observedMs: 899999}, {observedMs: 1000501}, {nowMs: -1}, {maxAgeMs: 0}
  ]) {
    assert.equal(aggregateScorecardStages([], {...stageQuery, ...change}, [1]).reason, 'FRESHNESS_UNKNOWN');
  }
  assert.equal(aggregateScorecardStages([], {...stageQuery, nowMs: 1005001}, [1]).reason, 'STALE_EVIDENCE');
  for (const badSamples of [null, new Array(1), Array(10001).fill(null)]) {
    assert.equal(aggregateScorecardStages(badSamples, stageQuery, [1]).reason, 'INVALID_SAMPLES');
  }

  assert.equal(
    aggregateScorecardStages([stageSample('ready->firstPr', 's1', 2000, 3000, 'completed', {repositoryId: 2})], stageQuery, [1]).reason,
    'SCOPE_MISMATCH'
  );
  assert.equal(
    aggregateScorecardStages([stageSample('ready->firstPr', 's1', 2000, 3000, 'completed', {cohort: 'other-cohort'})], stageQuery, [1]).reason,
    'SCOPE_MISMATCH'
  );

  for (const invalidSample of [
    null,
    stageSample('ready->firstPr', 'bad id', 2000, 3000),
    stageSample({[Symbol.toPrimitive]: trap}, 's1', 2000, 3000),
    stageSample('unknown->stage', 's1', 2000, 3000),
    stageSample('ready->firstPr', 's1', 2000, 3000, 'completed', {provenance: 'bogus'}),
    stageSample('ready->firstPr', 's1', 3000, 2000, 'completed'),
    stageSample('ready->firstPr', 's1', 2000, 1000001, 'completed'),
    stageSample('ready->firstPr', 's1', 2000, 3000, 'open'),
    stageSample('ready->firstPr', 's1', 1000001, null, 'open'),
    stageSample('ready->firstPr', 's1', 2000, 3000, 'unknown'),
    stageSample('ready->firstPr', 's1', 1000001, null, 'unknown'),
    stageSample('ready->firstPr', 's1', 2000, null, 'bogus'),
    stageSample('ready->firstPr', 's1', 2000, 3000, 'completed', {prompt: 'sensitive'})
  ]) {
    assert.equal(aggregateScorecardStages([invalidSample], stageQuery, [1]).reason, 'INVALID_SAMPLE');
  }

  const baseSample = stageSample('ready->firstPr', 'dup-1', 2000, 3000);
  for (const conflict of [
    {...baseSample, startedMs: 2001},
    {...baseSample, endedMs: 3001},
    {...baseSample, endedMs: null, state: 'open'}
  ]) {
    assert.equal(
      aggregateScorecardStages([baseSample, conflict], stageQuery, [1]).reason,
      'CONFLICTING_STAGE_EVIDENCE'
    );
  }
});
