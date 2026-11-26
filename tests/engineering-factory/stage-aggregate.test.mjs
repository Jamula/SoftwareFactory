import test from 'node:test';
import assert from 'node:assert/strict';
import {aggregateStage as aggregate,compareStageWindows,aggregateGithubTiming} from '../../tools/engineering-factory/stage-aggregate.mjs';
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
