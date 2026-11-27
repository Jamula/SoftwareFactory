import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  ALLOWED_BLOCKED_REASONS,
  MIN_COMPARABLE_ACCEPTED_UNITS,
  SCORECARD_PROVENANCES,
  THROUGHPUT_CHECKPOINTS,
  VELOCITY_STAGE_OBJECTIVES,
  buildVelocityScorecard,
  compareVelocityScorecards,
  measureAcceptedCohort,
  measureIssueOutcome
} from '../../tools/engineering-factory/outcome-measurement.mjs';
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

const dayMs = 86400000;
const scorecardQuery = {
  repositoryId: 1,
  cohort: 'small-independent',
  provenance: 'verified-autonomous-outcome',
  complete: true,
  stageSourceComplete: true,
  fromMs: dayMs,
  toMs: dayMs * 2,
  observedMs: dayMs * 2 + 10000,
  nowMs: dayMs * 2 + 15000,
  maxAgeMs: 60000
};

const makeScorecardUnit = (number, overrides = {}) => {
  const readyAt = scorecardQuery.fromMs + number * 1000;
  const mergedAt = readyAt + 180000;
  const mainVerifiedAt = mergedAt + 30000;
  const acceptedAt = mainVerifiedAt + 30000;
  const baseIssue = {
    repositoryId: 1,
    number,
    state: 'closed',
    acceptanceVerified: true,
    readyAt,
    acceptedAt,
    lastReopenedAt: null,
    requiredPullNumbers: [100 + number]
  };
  const basePull = {
    repositoryId: 1,
    number: 100 + number,
    issueNumbers: [number],
    merged: true,
    mergeSha: h,
    mainVerifiedSha: h,
    mainVerified: true,
    mergedAt,
    mainVerifiedAt
  };
  return {
    cohort: scorecardQuery.cohort,
    provenance: scorecardQuery.provenance,
    issue: baseIssue,
    pulls: [basePull],
    cost: {
      repositoryId: 1,
      issueNumber: number,
      receiptId: 'verified-receipt-' + number,
      verified: true,
      currency: 'USD',
      amountMicros: 0,
      observedMs: acceptedAt + 100
    },
    rework: {
      complete: true,
      candidateRounds: 1,
      reworkRounds: 0,
      reopenedCount: 0,
      infrastructureRetries: 0,
      queueRevalidations: 0
    },
    utilization: {
      complete: true,
      activeMs: 120000,
      blockedMs: 60000,
      idleMs: 20000,
      blockedReasons: {CI: 40000, REVIEW: 20000}
    },
    humanInterventions: {
      complete: true,
      routineCount: 0,
      governanceCount: 0
    },
    ...overrides
  };
};

const makeStageSample = (stage, idSuffix, startedMs, durationMs, provenance = scorecardQuery.provenance) => ({
  id: stage.replace('->', '-') + '-' + idSuffix,
  repositoryId: 1,
  cohort: scorecardQuery.cohort,
  provenance,
  stage,
  startedMs,
  endedMs: durationMs === null ? null : startedMs + durationMs,
  state: durationMs === null ? 'open' : 'completed'
});

const makeQuality = (overrides = {}) => ({
  repositoryId: 1,
  provenance: scorecardQuery.provenance,
  complete: true,
  coveredLines: 990,
  totalLines: 1000,
  coveredBranches: 960,
  totalBranches: 1000,
  minLinePercent: 98,
  minBranchPercent: 95,
  failedMainCount: 0,
  unauthorizedWriteCount: 0,
  duplicateDispatchCount: 0,
  budgetViolationCount: 0,
  ...overrides
});

const makeScorecardInput = (overrides = {}) => ({
  query: scorecardQuery,
  units: [1, 2, 3, 4, 5].map(n => makeScorecardUnit(n)),
  stageSamples: [
    makeStageSample('ready->firstPr', '1', scorecardQuery.fromMs + 1000, 90000),
    makeStageSample('draft->publish', '1', scorecardQuery.fromMs + 2000, 30000),
    makeStageSample('publish->merge', '1', scorecardQuery.fromMs + 3000, 150000),
    makeStageSample('creation->merge', '1', scorecardQuery.fromMs + 2000, 180000),
    makeStageSample('merge->verifiedMain', '1', scorecardQuery.fromMs + 5000, 30000),
    makeStageSample('eligible->merge', '1', scorecardQuery.fromMs + 4000, 25000),
    makeStageSample('ciEvent->lastRequiredCheck', '1', scorecardQuery.fromMs + 2500, 28000)
  ],
  quality: makeQuality(),
  historicalProxies: null,
  baseline: null,
  ...overrides
});

test('builds complete verified velocity scorecard with stage p50/p95, rework, utilization, $0 verified cost, and >=5 sample gate', () => {
  assert.equal(MIN_COMPARABLE_ACCEPTED_UNITS, 5);
  assert.deepEqual(THROUGHPUT_CHECKPOINTS, [2, 5, 10, 15, 20, 25]);
  assert.equal(SCORECARD_PROVENANCES.includes('historical-github-proxy'), true);
  assert.equal(Object.keys(VELOCITY_STAGE_OBJECTIVES).length, 7);
  assert.equal(ALLOWED_BLOCKED_REASONS.includes('REVIEW'), true);

  const fifthReworked = makeScorecardUnit(5, {
    issue: {
      ...makeScorecardUnit(5).issue,
      lastReopenedAt: scorecardQuery.fromMs + 6000,
      acceptedAt: scorecardQuery.fromMs + 1605000
    },
    cost: {
      ...makeScorecardUnit(5).cost,
      observedMs: scorecardQuery.fromMs + 1605100
    },
    rework: {
      complete: true,
      candidateRounds: 2,
      reworkRounds: 1,
      reopenedCount: 1,
      infrastructureRetries: 1,
      queueRevalidations: 2
    },
    humanInterventions: {
      complete: true,
      routineCount: 0,
      governanceCount: 1
    }
  });
  const censoredOpen = makeScorecardUnit(6, {
    issue: {
      ...makeScorecardUnit(6).issue,
      state: 'open',
      acceptanceVerified: false,
      acceptedAt: null
    }
  });
  const upcomingOpen = makeScorecardUnit(7, {
    issue: {
      ...makeScorecardUnit(7).issue,
      state: 'open',
      acceptanceVerified: false,
      readyAt: scorecardQuery.toMs,
      acceptedAt: null
    }
  });
  const beforeWindow = makeScorecardUnit(8, {
    issue: {
      ...makeScorecardUnit(8).issue,
      readyAt: scorecardQuery.fromMs - 5000,
      acceptedAt: scorecardQuery.fromMs - 1
    },
    pulls: [{
      ...makeScorecardUnit(8).pulls[0],
      mergedAt: scorecardQuery.fromMs - 3000,
      mainVerifiedAt: scorecardQuery.fromMs - 2000
    }],
    cost: {
      ...makeScorecardUnit(8).cost,
      observedMs: scorecardQuery.fromMs
    }
  });
  const afterWindowCensored = makeScorecardUnit(9, {
    issue: {
      ...makeScorecardUnit(9).issue,
      acceptedAt: scorecardQuery.toMs
    },
    cost: {
      ...makeScorecardUnit(9).cost,
      observedMs: scorecardQuery.toMs + 100
    }
  });
  const afterWindowReadyAfter = makeScorecardUnit(10, {
    issue: {
      ...makeScorecardUnit(10).issue,
      readyAt: scorecardQuery.toMs,
      acceptedAt: scorecardQuery.toMs + 5000
    },
    pulls: [{
      ...makeScorecardUnit(10).pulls[0],
      mergedAt: scorecardQuery.toMs + 1000,
      mainVerifiedAt: scorecardQuery.toMs + 2000
    }],
    cost: {
      ...makeScorecardUnit(10).cost,
      observedMs: scorecardQuery.toMs + 5000
    }
  });

  const scorecard = buildVelocityScorecard(makeScorecardInput({
    units: [
      ...[1, 2, 3, 4].map(n => makeScorecardUnit(n)),
      fifthReworked,
      censoredOpen,
      upcomingOpen,
      beforeWindow,
      afterWindowCensored,
      afterWindowReadyAfter
    ]
  }), [1]);

  assert.equal(scorecard.known, true);
  assert.equal(scorecard.reason, 'MEASURED_SCORECARD');
  assert.deepEqual(scorecard.counts, {
    accepted: 5,
    censored: 2,
    unknown: 0,
    withVerifiedCost: 5,
    stageCensored: 0,
    stageUnknown: 0
  });
  assert.deepEqual(scorecard.sampleSize, {
    accepted: 5,
    minimumComparableUnits: 5,
    exploratoryComparisonEligible: true
  });
  assert.equal(scorecard.throughput.acceptedOutcomesPerDay, 5);
  assert.equal(scorecard.throughput.readyToAcceptedP50Ms, 240000);
  assert.equal(scorecard.throughput.readyToAcceptedP95Ms, 1600000);
  assert.deepEqual(scorecard.throughput.readyToAcceptedSlo, {
    initialMissCount: 1,
    stretchMissCount: 1
  });
  assert.equal(scorecard.stages['ready->firstPr'].p50Ms, 90000);
  assert.equal(scorecard.stages['ciEvent->lastRequiredCheck'].p95Ms, 28000);
  assert.deepEqual(scorecard.rework, {
    status: 'measured',
    knownUnitCount: 5,
    unknownUnitCount: 0,
    candidateRounds: 6,
    reworkRounds: 1,
    reopenedCount: 1,
    infrastructureRetries: 1,
    queueRevalidations: 2,
    reworkRoundsPerAccepted: 0.4,
    p50ReworkRounds: 0,
    p95ReworkRounds: 2,
    firstPassYield: 0.8
  });
  assert.equal(scorecard.utilization.status, 'measured');
  assert.equal(scorecard.utilization.productiveUtilizationRatio, 0.6);
  assert.equal(scorecard.utilization.blockedTimeRatio, 0.3);
  assert.equal(scorecard.utilization.idleTimeRatio, 0.1);
  assert.equal(scorecard.utilization.blockedByReasonMs.CI, 200000);
  assert.equal(scorecard.utilization.blockedByReasonMs.REVIEW, 100000);
  assert.deepEqual(scorecard.humanInterventions, {
    status: 'measured',
    knownUnitCount: 5,
    unknownUnitCount: 0,
    routineCount: 0,
    governanceCount: 1,
    totalCount: 1,
    routinePerAccepted: 0,
    zeroRoutineVerified: true
  });
  assert.deepEqual(scorecard.cost, {
    status: 'verified-zero',
    acceptedWithVerifiedCost: 5,
    acceptedMissingCost: 0,
    verifiedZeroCostCount: 5,
    totalSpendUsdMicros: 0,
    costPerAcceptedUsdMicros: 0
  });
  assert.equal(scorecard.quality.status, 'passed');
  assert.equal(scorecard.autonomousSpeedClaimEligible, true);

  const fourUnits = buildVelocityScorecard(makeScorecardInput({
    units: [1, 2, 3, 4].map(n => makeScorecardUnit(n))
  }), [1]);
  assert.equal(fourUnits.known, true);
  assert.equal(fourUnits.sampleSize.exploratoryComparisonEligible, false);
  assert.equal(fourUnits.autonomousSpeedClaimEligible, false);
});

test('never treats missing cost, utilization, rework, interventions, or zero denominators as zero', () => {
  const missingEvidenceUnits = [
    makeScorecardUnit(1, {
      cost: null,
      rework: null,
      utilization: null,
      humanInterventions: null
    }),
    makeScorecardUnit(2, {
      cost: {...makeScorecardUnit(2).cost, verified: false},
      rework: {...makeScorecardUnit(2).rework, complete: false},
      utilization: {...makeScorecardUnit(2).utilization, complete: false},
      humanInterventions: {...makeScorecardUnit(2).humanInterventions, complete: false}
    }),
    makeScorecardUnit(3)
  ];
  const partialMetrics = buildVelocityScorecard(makeScorecardInput({
    units: missingEvidenceUnits,
    quality: null
  }), [1]);
  assert.equal(partialMetrics.known, true);
  assert.deepEqual([partialMetrics.cost.status, partialMetrics.cost.totalSpendUsdMicros, partialMetrics.cost.costPerAcceptedUsdMicros],
    ['unknown', null, null]);
  assert.deepEqual([partialMetrics.rework.status, partialMetrics.rework.reworkRoundsPerAccepted, partialMetrics.rework.firstPassYield],
    ['partial', null, null]);
  assert.deepEqual([
    partialMetrics.utilization.status,
    partialMetrics.utilization.productiveUtilizationRatio,
    partialMetrics.utilization.blockedTimeRatio,
    partialMetrics.utilization.activeMs
  ], ['partial', null, null, null]);
  assert.deepEqual([
    partialMetrics.humanInterventions.status,
    partialMetrics.humanInterventions.routineCount,
    partialMetrics.humanInterventions.zeroRoutineVerified
  ], ['partial', null, false]);
  assert.equal(partialMetrics.quality.status, 'unknown');
  assert.equal(partialMetrics.autonomousSpeedClaimEligible, false);

  const zeroCapacity = buildVelocityScorecard(makeScorecardInput({
    units: [makeScorecardUnit(1, {
      cost: {...makeScorecardUnit(1).cost, amountMicros: 250},
      utilization: {complete: true, activeMs: 0, blockedMs: 0, idleMs: 0, blockedReasons: {}},
      humanInterventions: {complete: true, routineCount: 2, governanceCount: 0}
    })],
    quality: makeQuality({complete: false})
  }), [1]);
  assert.equal(zeroCapacity.utilization.status, 'unknown');
  assert.equal(zeroCapacity.utilization.reason, 'ZERO_ALLOCATED_CAPACITY');
  assert.equal(zeroCapacity.utilization.productiveUtilizationRatio, null);
  assert.equal(zeroCapacity.cost.status, 'verified-spend');
  assert.equal(zeroCapacity.cost.costPerAcceptedUsdMicros, 250);
  assert.equal(zeroCapacity.humanInterventions.zeroRoutineVerified, false);
  assert.equal(zeroCapacity.quality.status, 'unknown');

  const zeroActivePositiveAllocated = buildVelocityScorecard(makeScorecardInput({
    units: [makeScorecardUnit(1, {
      utilization: {complete: true, activeMs: 0, blockedMs: 50000, idleMs: 50000, blockedReasons: {QUOTA: 50000}}
    })]
  }), [1]);
  assert.equal(zeroActivePositiveAllocated.utilization.status, 'measured');
  assert.equal(zeroActivePositiveAllocated.utilization.productiveUtilizationRatio, 0);
  assert.equal(zeroActivePositiveAllocated.utilization.blockedTimeRatio, 0.5);
  assert.equal(zeroActivePositiveAllocated.utilization.idleTimeRatio, 0.5);

  const emptyCohort = buildVelocityScorecard(makeScorecardInput({
    units: [],
    quality: makeQuality({coveredLines: 970})
  }), [1]);
  assert.equal(emptyCohort.throughput.acceptedOutcomesPerDay, 0);
  assert.equal(emptyCohort.cost.status, 'unknown');
  assert.equal(emptyCohort.cost.costPerAcceptedUsdMicros, null);
  assert.equal(emptyCohort.rework.status, 'unknown');
  assert.equal(emptyCohort.utilization.status, 'unknown');
  assert.equal(emptyCohort.humanInterventions.status, 'unknown');
  assert.equal(emptyCohort.quality.status, 'failed');
});

test('isolates historical-github-proxy snapshot from verified-autonomous-outcome speed claims', () => {
  const snapshot = JSON.parse(readFileSync(
    new URL('../../docs/evidence/softwarefactory-github-proxies-2026-11-25.json', import.meta.url),
    'utf8'
  ));
  const repoId = snapshot.query.repositoryId;
  const proxyQueryWindow = {
    ...scorecardQuery,
    repositoryId: repoId,
    fromMs: snapshot.query.fromMs,
    toMs: snapshot.query.toMs,
    observedMs: snapshot.query.observedMs,
    nowMs: snapshot.query.nowMs,
    maxAgeMs: snapshot.query.maxAgeMs
  };
  const unitForRepo = n => {
    const u = makeScorecardUnit(n);
    const readyAt = proxyQueryWindow.fromMs + n * 1000;
    const mergedAt = readyAt + 60000;
    const mainVerifiedAt = mergedAt + 10000;
    const acceptedAt = mainVerifiedAt + 10000;
    return {
      ...u,
      issue: {...u.issue, repositoryId: repoId, readyAt, acceptedAt},
      pulls: [{...u.pulls[0], repositoryId: repoId, mergedAt, mainVerifiedAt}],
      cost: {...u.cost, repositoryId: repoId, observedMs: acceptedAt + 10}
    };
  };
  const baseAutonomousInput = {
    query: proxyQueryWindow,
    units: [1, 2, 3, 4, 5].map(unitForRepo),
    stageSamples: [{
      id: 'ci-real-1',
      repositoryId: repoId,
      cohort: proxyQueryWindow.cohort,
      provenance: 'verified-autonomous-outcome',
      stage: 'ciEvent->lastRequiredCheck',
      startedMs: proxyQueryWindow.fromMs + 1000,
      endedMs: proxyQueryWindow.fromMs + 26000,
      state: 'completed'
    }],
    quality: makeQuality({repositoryId: repoId}),
    historicalProxies: null,
    baseline: null
  };

  const withoutProxy = buildVelocityScorecard(baseAutonomousInput, snapshot.authorizedRepositoryIds);
  const withQuarantinedProxy = buildVelocityScorecard({
    ...baseAutonomousInput,
    historicalProxies: {
      provenance: 'historical-github-proxy',
      sourceComplete: snapshot.query.sourceComplete,
      issueCreatedToCloseRows: snapshot.rows['issue-created-to-close'],
      prCreatedToMergeRows: snapshot.rows['pr-created-to-merge']
    }
  }, snapshot.authorizedRepositoryIds);

  assert.equal(withQuarantinedProxy.known, true);
  assert.equal(withQuarantinedProxy.historicalProxyContext.provenance, 'historical-github-proxy');
  assert.equal(withQuarantinedProxy.historicalProxyContext.nonAutonomousProxyOnly, true);
  assert.equal(withQuarantinedProxy.historicalProxyContext.prCreatedToMerge.sampleCount, 61);
  assert.equal(withQuarantinedProxy.historicalProxyContext.issueCreatedToClose.sampleCount, 1);

  // Attaching historical proxy context never changes a single autonomous metric.
  const {historicalProxyContext: ignored, ...autonomousFieldsWithProxy} = withQuarantinedProxy;
  const {historicalProxyContext: alsoIgnored, ...autonomousFieldsWithoutProxy} = withoutProxy;
  assert.deepEqual(autonomousFieldsWithProxy, autonomousFieldsWithoutProxy);

  // Blending proxy rows or proxy provenance into any autonomous input fails closed.
  const proxyPrRow = snapshot.rows['pr-created-to-merge'][4];
  assert.equal(
    buildVelocityScorecard({provenance: 'historical-github-proxy'}, snapshot.authorizedRepositoryIds).reason,
    'PROVENANCE_ISOLATION_VIOLATION'
  );
  assert.equal(
    buildVelocityScorecard({
      ...baseAutonomousInput,
      query: {...proxyQueryWindow, provenance: 'historical-github-proxy'}
    }, snapshot.authorizedRepositoryIds).reason,
    'PROVENANCE_ISOLATION_VIOLATION'
  );
  assert.equal(
    buildVelocityScorecard({...baseAutonomousInput, units: [proxyPrRow]}, snapshot.authorizedRepositoryIds).reason,
    'PROVENANCE_ISOLATION_VIOLATION'
  );
  assert.equal(
    buildVelocityScorecard({
      ...baseAutonomousInput,
      units: [{...unitForRepo(1), provenance: 'synthetic-fixture'}]
    }, snapshot.authorizedRepositoryIds).reason,
    'PROVENANCE_ISOLATION_VIOLATION'
  );
  assert.equal(
    buildVelocityScorecard({
      ...baseAutonomousInput,
      units: [{...unitForRepo(1), cost: {...unitForRepo(1).cost, source: 'github-proxy'}}]
    }, snapshot.authorizedRepositoryIds).reason,
    'PROVENANCE_ISOLATION_VIOLATION'
  );
  assert.equal(
    buildVelocityScorecard({...baseAutonomousInput, stageSamples: [proxyPrRow]}, snapshot.authorizedRepositoryIds).reason,
    'PROVENANCE_ISOLATION_VIOLATION'
  );
  assert.equal(
    buildVelocityScorecard({
      ...baseAutonomousInput,
      quality: {...baseAutonomousInput.quality, provenance: 'historical-github-proxy'}
    }, snapshot.authorizedRepositoryIds).reason,
    'PROVENANCE_ISOLATION_VIOLATION'
  );
  assert.equal(
    buildVelocityScorecard({
      ...baseAutonomousInput,
      quality: {...baseAutonomousInput.quality, provenance: 'synthetic-fixture'}
    }, snapshot.authorizedRepositoryIds).reason,
    'PROVENANCE_ISOLATION_VIOLATION'
  );
  assert.equal(
    buildVelocityScorecard({
      ...baseAutonomousInput,
      historicalProxies: {
        provenance: 'verified-autonomous-outcome',
        sourceComplete: true,
        issueCreatedToCloseRows: [],
        prCreatedToMergeRows: []
      }
    }, snapshot.authorizedRepositoryIds).reason,
    'PROVENANCE_ISOLATION_VIOLATION'
  );
});

test('compares matched >=5 unit baseline and candidate cohorts and enforces quality/cost/provenance guardrails', () => {
  const baselineQuery = {
    ...scorecardQuery,
    fromMs: 0,
    toMs: dayMs,
    observedMs: scorecardQuery.observedMs,
    nowMs: scorecardQuery.nowMs
  };
  const makeWindowScorecard = (queryOverride, count, provenance = 'verified-autonomous-outcome', unitCustom = () => ({})) => {
    const units = Array.from({length: count}, (_, i) => {
      const n = i + 1;
      const readyAt = queryOverride.fromMs + n * 1000;
      const mergedAt = readyAt + 120000;
      const mainVerifiedAt = mergedAt + 20000;
      const acceptedAt = mainVerifiedAt + 20000;
      const base = makeScorecardUnit(n);
      return {
        ...base,
        provenance,
        issue: {...base.issue, readyAt, acceptedAt},
        pulls: [{...base.pulls[0], mergedAt, mainVerifiedAt}],
        cost: {...base.cost, observedMs: acceptedAt + 10},
        ...unitCustom(n, acceptedAt)
      };
    });
    return buildVelocityScorecard({
      query: {...queryOverride, provenance},
      units,
      stageSamples: [],
      quality: makeQuality({provenance}),
      historicalProxies: null,
      baseline: null
    }, [1]);
  };

  const baseline = makeWindowScorecard(baselineQuery, 5);
  const candidate10 = buildVelocityScorecard({
    query: scorecardQuery,
    units: Array.from({length: 10}, (_, i) => makeScorecardUnit(i + 1)),
    stageSamples: [],
    quality: makeQuality(),
    historicalProxies: null,
    baseline
  }, [1]);
  assert.equal(candidate10.baselineComparison.comparable, true);
  assert.equal(candidate10.baselineComparison.reason, 'VERIFIED_COMPARABLE_COHORTS');
  assert.equal(candidate10.baselineComparison.autonomousClaimEligible, true);
  assert.equal(candidate10.baselineComparison.throughputMultiplier, 2);
  assert.deepEqual(candidate10.baselineComparison.achievedCheckpoints, [2]);

  const syntheticBase = makeWindowScorecard(baselineQuery, 5, 'synthetic-fixture');
  const syntheticCand = makeWindowScorecard(scorecardQuery, 25, 'synthetic-fixture');
  const synthComp = compareVelocityScorecards(syntheticBase, syntheticCand);
  assert.equal(synthComp.comparable, true);
  assert.equal(synthComp.reason, 'SYNTHETIC_COMPARABLE_COHORTS');
  assert.equal(synthComp.autonomousClaimEligible, false);
  assert.deepEqual(synthComp.achievedCheckpoints, [2, 5]);

  // Provenance mismatch between synthetic and verified fails closed.
  assert.equal(compareVelocityScorecards(syntheticBase, candidate10).reason, 'PROVENANCE_ISOLATION_VIOLATION');
  assert.equal(
    compareVelocityScorecards({provenance: 'historical-github-proxy'}, candidate10).reason,
    'PROVENANCE_ISOLATION_VIOLATION'
  );
  assert.equal(
    buildVelocityScorecard({...makeScorecardInput(), baseline: syntheticBase}, [1]).reason,
    'PROVENANCE_ISOLATION_VIOLATION'
  );
  assert.equal(
    buildVelocityScorecard({...makeScorecardInput(), baseline: {}}, [1]).reason,
    'INVALID_SCORECARD'
  );

  // Sample size < 5 blocks comparison.
  const underSampledBase = makeWindowScorecard(baselineQuery, 4);
  const withSmallBaseline = buildVelocityScorecard({
    ...makeScorecardInput(),
    baseline: underSampledBase
  }, [1]);
  assert.equal(withSmallBaseline.known, true);
  assert.equal(withSmallBaseline.baselineComparison.comparable, false);
  assert.equal(withSmallBaseline.baselineComparison.reason, 'INSUFFICIENT_SAMPLE_SIZE');

  assert.equal(compareVelocityScorecards(baseline, {...candidate10, baselineComparison: null, cohort: 'other'}).reason,
    'COHORT_MISMATCH');
  assert.equal(compareVelocityScorecards(baseline, {...candidate10, repositoryId: 2}).reason,
    'COHORT_MISMATCH');
  assert.equal(compareVelocityScorecards(
    {...baseline, window: {...baseline.window, toMs: scorecardQuery.fromMs + 1}},
    candidate10
  ).reason, 'WINDOWS_NOT_COMPARABLE');
  assert.equal(compareVelocityScorecards(
    {...baseline, window: {...baseline.window, toMs: dayMs - 1}},
    candidate10
  ).reason, 'WINDOWS_NOT_COMPARABLE');
  assert.equal(compareVelocityScorecards({...baseline, known: false}, candidate10).reason, 'INCOMPLETE_EVIDENCE');
  assert.equal(compareVelocityScorecards(
    {...baseline, throughput: {...baseline.throughput, acceptedOutcomesPerDay: 0}},
    candidate10
  ).reason, 'ZERO_OR_UNKNOWN_BASELINE');
  assert.equal(compareVelocityScorecards(
    baseline,
    {...candidate10, cost: {...candidate10.cost, costPerAcceptedUsdMicros: 10, status: 'verified-spend'}}
  ).reason, 'GUARDRAIL_UNVERIFIED_OR_REGRESSED');
  assert.equal(compareVelocityScorecards(
    baseline,
    {...candidate10, quality: {...candidate10.quality, status: 'failed'}}
  ).reason, 'GUARDRAIL_UNVERIFIED_OR_REGRESSED');
  assert.equal(compareVelocityScorecards(null, candidate10).reason, 'INVALID_SCORECARD');
});

test('fails closed across malformed scorecard inputs, incomplete outcomes, conflicts, and untrusted getters', () => {
  assert.equal(buildVelocityScorecard(null, [1]).reason, 'INVALID_INPUT');
  for (const qChange of [
    {repositoryId: 0}, {cohort: 'Bad Label'}, {provenance: 'bogus'}, {complete: 'true'},
    {stageSourceComplete: null}, {fromMs: -1}, {toMs: scorecardQuery.fromMs}
  ]) {
    assert.equal(
      buildVelocityScorecard(makeScorecardInput({query: {...scorecardQuery, ...qChange}}), [1]).reason,
      'COHORT_UNKNOWN'
    );
  }
  assert.equal(buildVelocityScorecard(makeScorecardInput(), [2]).reason, 'COHORT_UNKNOWN');
  assert.equal(
    buildVelocityScorecard(makeScorecardInput({query: {...scorecardQuery, observedMs: scorecardQuery.toMs - 1}}), [1]).reason,
    'FRESHNESS_UNKNOWN'
  );
  assert.equal(
    buildVelocityScorecard(makeScorecardInput({query: {...scorecardQuery, nowMs: scorecardQuery.observedMs + 60001}}), [1]).reason,
    'STALE_EVIDENCE'
  );
  assert.equal(buildVelocityScorecard(makeScorecardInput({units: null}), [1]).reason, 'INVALID_ENTRIES');
  assert.equal(buildVelocityScorecard(makeScorecardInput({stageSamples: null}), [1]).reason, 'INVALID_SAMPLES');

  for (const badUnit of [
    null,
    makeScorecardUnit(1, {provenance: 'bogus'}),
    makeScorecardUnit(1, {cohort: 'other'}),
    makeScorecardUnit(1, {issue: {...makeScorecardUnit(1).issue, repositoryId: 2}}),
    makeScorecardUnit(1, {issue: {...makeScorecardUnit(1).issue, title: 'raw sensitive title'}}),
    makeScorecardUnit(1, {pulls: [{...makeScorecardUnit(1).pulls[0], author: 'alice'}]})
  ]) {
    assert.equal(buildVelocityScorecard(makeScorecardInput({units: [badUnit]}), [1]).reason, 'ENTRY_SCOPE_UNKNOWN');
  }
  const trap = () => assert.fail('must not invoke untrusted getter or proxy trap');
  const handler = {get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap};
  assert.equal(buildVelocityScorecard(new Proxy(makeScorecardInput(), handler), [1]).reason, 'INVALID_INPUT');
  const getterUnit = makeScorecardUnit(1);
  Object.defineProperty(getterUnit, 'cost', {get: trap});
  assert.equal(buildVelocityScorecard(makeScorecardInput({units: [getterUnit]}), [1]).reason, 'ENTRY_SCOPE_UNKNOWN');
  const validCard = buildVelocityScorecard(makeScorecardInput(), [1]);
  const poisonedWindow = {...validCard.window};
  Object.defineProperty(poisonedWindow, 'fromMs', {get: trap});
  assert.equal(compareVelocityScorecards({...validCard, window: poisonedWindow}, validCard).reason, 'INVALID_SCORECARD');
  assert.equal(
    buildVelocityScorecard(makeScorecardInput({units: [makeScorecardUnit(1), makeScorecardUnit(1)]}), [1]).reason,
    'DUPLICATE_ISSUE'
  );

  // Unknown outcome items mark scorecard partial without crashing.
  const partialUnits = buildVelocityScorecard(makeScorecardInput({
    units: [
      makeScorecardUnit(1, {pulls: Array(251).fill(null)}),
      makeScorecardUnit(2, {issue: {...makeScorecardUnit(2).issue, acceptanceVerified: false}})
    ]
  }), [1]);
  assert.equal(partialUnits.known, false);
  assert.equal(partialUnits.reason, 'PARTIAL_EVIDENCE');
  assert.equal(partialUnits.counts.unknown, 2);
  assert.equal(partialUnits.throughput.acceptedOutcomesPerDay, null);

  const manyPullUnits = Array.from({length: 41}, (_, idx) =>
    makeScorecardUnit(idx + 1, {pulls: Array(250).fill(null)}));
  assert.equal(buildVelocityScorecard(makeScorecardInput({units: manyPullUnits}), [1]).reason, 'PULL_EVIDENCE_LIMIT');

  // Cost conflicts and overflow fail closed.
  const u1 = makeScorecardUnit(1);
  const u2 = makeScorecardUnit(2, {cost: {...makeScorecardUnit(2).cost, receiptId: u1.cost.receiptId}});
  assert.equal(buildVelocityScorecard(makeScorecardInput({units: [u1, u2]}), [1]).reason, 'CONFLICTING_COST_EVIDENCE');
  const overflow1 = makeScorecardUnit(1, {cost: {...u1.cost, amountMicros: Number.MAX_SAFE_INTEGER}});
  const overflow2 = makeScorecardUnit(2, {cost: {...makeScorecardUnit(2).cost, amountMicros: 1}});
  assert.equal(buildVelocityScorecard(makeScorecardInput({units: [overflow1, overflow2]}), [1]).reason,
    'CONFLICTING_COST_EVIDENCE');
  assert.equal(
    buildVelocityScorecard(makeScorecardInput({units: [makeScorecardUnit(1, {cost: {extra: 1}})]}), [1]).reason,
    'INVALID_COST_EVIDENCE'
  );

  // Rework, utilization, intervention, quality, and proxy validation errors.
  for (const badRework of [
    {},
    {...u1.rework, candidateRounds: 2, reworkRounds: 0}
  ]) {
    assert.equal(
      buildVelocityScorecard(makeScorecardInput({units: [makeScorecardUnit(1, {rework: badRework})]}), [1]).reason,
      'INVALID_REWORK_EVIDENCE'
    );
  }
  assert.equal(
    buildVelocityScorecard(makeScorecardInput({
      units: [makeScorecardUnit(1, {
        issue: {...u1.issue, lastReopenedAt: scorecardQuery.fromMs + 1500}
      })]
    }), [1]).reason,
    'INVALID_REWORK_EVIDENCE'
  );

  const symObj = {[Symbol('hidden')]: 1};
  const getterMap = {};
  Object.defineProperty(getterMap, 'CI', {get() { throw new Error('unexpected getter'); }});
  for (const badUtil of [
    {},
    {...u1.utilization, blockedReasons: null},
    {...u1.utilization, blockedReasons: symObj},
    {...u1.utilization, blockedReasons: {UNKNOWN_REASON: 60000}},
    {...u1.utilization, blockedReasons: getterMap},
    {...u1.utilization, blockedReasons: {CI: 10000}}
  ]) {
    assert.equal(
      buildVelocityScorecard(makeScorecardInput({units: [makeScorecardUnit(1, {utilization: badUtil})]}), [1]).reason,
      'INVALID_UTILIZATION_EVIDENCE'
    );
  }

  assert.equal(
    buildVelocityScorecard(makeScorecardInput({
      units: [makeScorecardUnit(1, {humanInterventions: {complete: true, routineCount: -1, governanceCount: 0}})]
    }), [1]).reason,
    'INVALID_INTERVENTION_EVIDENCE'
  );

  assert.equal(
    buildVelocityScorecard(makeScorecardInput({quality: makeQuality({repositoryId: 2})}), [1]).reason,
    'ENTRY_SCOPE_UNKNOWN'
  );
  for (const badQuality of [
    {},
    makeQuality({provenance: 'bogus'}),
    makeQuality({minLinePercent: 94}),
    makeQuality({coveredLines: 1001})
  ]) {
    assert.equal(buildVelocityScorecard(makeScorecardInput({quality: badQuality}), [1]).reason,
      'INVALID_QUALITY_EVIDENCE');
  }
  assert.equal(
    buildVelocityScorecard(makeScorecardInput({
      quality: makeQuality({failedMainCount: 1})
    }), [1]).quality.status,
    'failed'
  );

  for (const badProxy of [
    {},
    {
      provenance: 'historical-github-proxy',
      sourceComplete: true,
      issueCreatedToCloseRows: null,
      prCreatedToMergeRows: []
    },
    {
      provenance: 'historical-github-proxy',
      sourceComplete: true,
      issueCreatedToCloseRows: [],
      prCreatedToMergeRows: null
    }
  ]) {
    assert.equal(buildVelocityScorecard(makeScorecardInput({historicalProxies: badProxy}), [1]).reason,
      'INVALID_PROXY_EVIDENCE');
  }
});
