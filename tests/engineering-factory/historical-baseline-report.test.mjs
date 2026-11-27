import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  ALLOWED_EXPLICIT_LINK_KINDS,
  AUTONOMOUS_OTEL_OBJECTIVES,
  HISTORICAL_OTEL_REPORT_SCHEMA_VERSION,
  SOFTWARE_FACTORY_REPOSITORY_ID,
  SUPPORTED_COHORT_REPOSITORIES,
  THROUGHPUT_CHECKPOINTS,
  buildHistoricalAndOtelEvidenceReport
} from '../../tools/engineering-factory/historical-baseline-report.mjs';
import {createExecutionReceipt} from '../../tools/engineering-factory/telemetry.mjs';
import {aggregateGithubTiming} from '../../tools/engineering-factory/stage-aggregate.mjs';

const SF_ID = SOFTWARE_FACTORY_REPOSITORY_ID;
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const TRACE_1 = '1'.repeat(32);
const SPAN_1 = '2'.repeat(16);
const TRACEPARENT_1 = `00-${TRACE_1}-${SPAN_1}-01`;

function baseAuth(overrides = []) {
  return overrides.length > 0
    ? overrides
    : [
        {repositoryKey: 'SoftwareFactory', repositoryId: SF_ID, readAuthorized: true},
        {repositoryKey: 'FamilyTree', repositoryId: 2001, readAuthorized: false},
        {repositoryKey: 'Spellbook', repositoryId: 2002, readAuthorized: false},
        {repositoryKey: 'FamilyHub', repositoryId: 2003, readAuthorized: false}
      ];
}

function baseQuery(patch = {}) {
  return {
    repositoryKey: 'SoftwareFactory',
    repositoryId: SF_ID,
    cohort: 'small-comparable',
    fromMs: 1_000_000,
    toMs: 87_400_000,
    observedMs: 88_000_000,
    nowMs: 88_100_000,
    maxAgeMs: 600_000,
    historicalSourceComplete: true,
    ...patch
  };
}

function makeIssue(number, patch = {}) {
  return {
    repositoryId: SF_ID,
    cohort: 'small-comparable',
    number,
    state: 'closed',
    createdAt: 1_000_000 + number * 1000,
    closedAt: 1_600_000 + number * 1000,
    reopenedCount: 0,
    lastReopenedAt: null,
    readyAt: 1_100_000 + number * 1000,
    acceptedAt: 1_600_000 + number * 1000,
    acceptanceVerified: true,
    requiredPullNumbers: [100 + number],
    otelVerified: true,
    ...patch
  };
}

function makePull(number, patch = {}) {
  return {
    repositoryId: SF_ID,
    cohort: 'small-comparable',
    number,
    state: 'merged',
    isDraft: false,
    partial: false,
    createdAt: 1_200_000 + number * 100,
    mergedAt: 1_450_000 + number * 100,
    closedAt: 1_450_000 + number * 100,
    mergeSha: SHA_A,
    mainVerifiedSha: SHA_A,
    mainVerified: true,
    mainVerifiedAt: 1_500_000 + number * 100,
    otelVerified: true,
    ...patch
  };
}

function makeLink(issueNumber, pullNumber, patch = {}) {
  return {
    repositoryId: SF_ID,
    issueNumber,
    pullNumber,
    evidenceKind: 'closing-keyword',
    ...patch
  };
}

function makeCiRun(id, pullNumber, patch = {}) {
  return {
    id,
    repositoryId: SF_ID,
    cohort: 'small-comparable',
    pullNumber,
    headSha: SHA_A,
    state: 'completed',
    startedAt: 1_250_000,
    completedAt: 1_278_000,
    traceparent: TRACEPARENT_1,
    ...patch
  };
}

function makeIntervention(issueNumber, patch = {}) {
  return {
    repositoryId: SF_ID,
    cohort: 'small-comparable',
    issueNumber,
    verified: true,
    routineCount: 0,
    governanceCount: 0,
    ...patch
  };
}

function makeHostedReceipt(receiptId, stage, patch = {}) {
  return createExecutionReceipt({
    source: 'github-hosted',
    repositoryId: SF_ID,
    receiptId,
    observedMs: 1_300_000,
    stage,
    durationMs: 250,
    outcome: 'eligible',
    reason: 'NONE',
    quota: {verified: true, includedOnly: true, available: true},
    cost: {verified: true, currency: 'USD', amountMicros: 0},
    humanTouches: {verified: true, count: 0},
    correlation: {traceId: TRACE_1, spanId: SPAN_1},
    ...patch
  });
}

test('T01: reproduces committed SoftwareFactory historical GitHub proxy snapshot without OTel blocking', () => {
  const snapshot = JSON.parse(
    readFileSync(
      new URL('../../docs/evidence/softwarefactory-github-proxies-2026-11-25.json', import.meta.url),
      'utf8'
    )
  );
  const expectedPr = aggregateGithubTiming(
    snapshot.rows['pr-created-to-merge'],
    {...snapshot.query, metric: 'pr-created-to-merge'},
    snapshot.authorizedRepositoryIds
  );
  const expectedIssue = aggregateGithubTiming(
    snapshot.rows['issue-created-to-close'],
    {...snapshot.query, metric: 'issue-created-to-close'},
    snapshot.authorizedRepositoryIds
  );

  const issues = snapshot.rows['issue-created-to-close'].map(row => ({
    repositoryId: row.repositoryId,
    cohort: 'opening-2026-11-25',
    number: row.id,
    state: row.state === 'completed' ? 'closed' : row.state,
    createdAt: row.openedMs,
    closedAt: row.state === 'completed' ? row.endedMs : null,
    reopenedCount: 0,
    lastReopenedAt: null
  }));
  const pulls = snapshot.rows['pr-created-to-merge'].map(row => ({
    repositoryId: row.repositoryId,
    cohort: 'opening-2026-11-25',
    number: row.id,
    state: row.state === 'completed' ? 'merged' : row.state,
    isDraft: false,
    partial: false,
    createdAt: row.openedMs,
    mergedAt: row.state === 'completed' ? row.endedMs : null,
    closedAt: row.state === 'closed-unmerged' ? row.endedMs : null
  }));

  const report = buildHistoricalAndOtelEvidenceReport({
    query: {
      repositoryKey: 'SoftwareFactory',
      repositoryId: snapshot.query.repositoryId,
      cohort: 'opening-2026-11-25',
      fromMs: snapshot.query.fromMs,
      toMs: snapshot.query.toMs,
      observedMs: snapshot.query.observedMs,
      nowMs: snapshot.query.nowMs,
      maxAgeMs: snapshot.query.maxAgeMs,
      historicalSourceComplete: snapshot.query.sourceComplete
    },
    authorizedRepositories: baseAuth(),
    issues,
    pulls,
    links: []
  });

  assert.equal(report.valid, true);
  assert.equal(report.schemaVersion, HISTORICAL_OTEL_REPORT_SCHEMA_VERSION);
  assert.equal(report.shadow, true);
  assert.equal(report.readOnly, true);
  assert.equal(report.liveDispatch, false);
  assert.equal(report.liveMerge, false);
  assert.equal(report.createsSchedule, false);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.historicalProxies), true);

  assert.equal(report.historicalProxies.provenance, 'historical-github-proxy');
  assert.equal(report.historicalProxies.nonAutonomousProxyOnly, true);
  assert.equal(report.historicalProxies.sloEligible, false);
  assert.equal(report.historicalProxies.prCreatedToMergeMs.p50Ms, expectedPr.p50);
  assert.equal(report.historicalProxies.prCreatedToMergeMs.p95Ms, expectedPr.p95);
  assert.deepEqual(report.historicalProxies.prCreatedToMergeMs.counts, expectedPr.counts);
  assert.equal(report.historicalProxies.issueCreatedToCloseMs.p50Ms, expectedIssue.p50);
  assert.equal(report.historicalProxies.issueCreatedToCloseMs.p95Ms, expectedIssue.p95);
  assert.equal(report.historicalProxies.issueCreatedToCloseMs.counts.completed, expectedIssue.counts.completed);
  assert.equal(report.historicalProxies.issueCreatedToCloseMs.counts.censored, expectedIssue.counts.censored);

  // Historical proxies never populate autonomous OTel metrics or accepted outcomes
  assert.equal(report.throughput.acceptedOutcomesInWindow, 0);
  assert.equal(report.autonomousOtel.status, 'not-provided');
  assert.equal(report.autonomousOtel.autonomousClaimEligible, false);
  assert.equal(report.autonomousOtel.issueReadyToFirstPrMs.p50Ms, null);
  assert.equal(report.autonomousOtel.prToVerifiedMainMs.p50Ms, null);
  assert.equal(report.autonomousOtel.issueReadyToOutcomeMs.p50Ms, null);
  assert.equal(report.autonomousOtel.standardAutomatedCiMs.p50Ms, null);
  assert.equal(report.autonomousOtel.routineHumanInterventions.totalRoutineCount, null);
});

test('T01 & T04: strictly separates historical proxies from all 5 verified autonomous OTel outcomes and W3C traceparent receipts', () => {
  const issues = [];
  const pulls = [];
  const links = [];
  const ciRuns = [];
  const interventions = [];

  // 5 comparable accepted issues meeting stretch & initial targets, while historical creation timestamps are hours earlier
  for (let i = 1; i <= 5; i++) {
    const issueCreatedAt = 1_000_000 + i * 1000;
    const readyAt = issueCreatedAt + 7_200_000; // 2 hours after creation!
    const prCreatedAt = readyAt + 90_000; // 1.5m ready->firstPr (meets 2m stretch & 10m initial; created->firstPr is 121.5m!)
    const mergedAt = prCreatedAt + 180_000; // 3m PR->merge
    const mainVerifiedAt = prCreatedAt + 240_000; // 4m PR->verifiedMain (meets 5m stretch & 15m initial)
    const acceptedAt = readyAt + 360_000; // 6m ready->outcome (meets 7m stretch & 25m initial)
    const closedAt = acceptedAt + 60_000;

    issues.push(makeIssue(i, {
      createdAt: issueCreatedAt,
      readyAt,
      acceptedAt,
      closedAt,
      requiredPullNumbers: [100 + i]
    }));
    pulls.push(makePull(100 + i, {
      isDraft: i === 1, // draft PR still counts as first attributable PR creation
      createdAt: prCreatedAt,
      mergedAt,
      closedAt: mergedAt,
      mainVerifiedAt
    }));
    links.push(makeLink(i, 100 + i, {
      evidenceKind: ALLOWED_EXPLICIT_LINK_KINDS[i % ALLOWED_EXPLICIT_LINK_KINDS.length]
    }));
    ciRuns.push(makeCiRun(`ci-${i}`, 100 + i, {
      startedAt: prCreatedAt + 1_000,
      completedAt: prCreatedAt + 29_000 // 28s (<75s initial, <=30s stretch)
    }));
    interventions.push(makeIntervention(i, {
      verified: true,
      routineCount: 0,
      governanceCount: i === 1 ? 1 : 0
    }));
  }

  const receipts = [
    makeHostedReceipt('gh-1-reconcile', 'reconcile'),
    makeHostedReceipt('gh-1-dispatch', 'dispatch'),
    makeHostedReceipt('gh-1-ci', 'ci'),
    makeHostedReceipt('gh-1-review', 'review'),
    makeHostedReceipt('gh-1-merge', 'merge-shadow'),
    makeHostedReceipt('gh-1-main', 'verify-main'),
    makeHostedReceipt('gh-1-accept', 'acceptance'),
    makeHostedReceipt('gh-1-blocked-lease', 'evaluate', {
      outcome: 'blocked',
      reason: 'LEASE',
      correlation: {traceId: null, spanId: null}
    }),
    makeHostedReceipt('gh-1-blocked-lease-2', 'evaluate', {
      outcome: 'blocked',
      reason: 'LEASE',
      correlation: {traceId: null, spanId: null}
    }),
    makeHostedReceipt('gh-prior-window', 'dispatch', {observedMs: 500_000})
  ];

  const report = buildHistoricalAndOtelEvidenceReport({
    query: baseQuery(),
    authorizedRepositories: baseAuth(),
    issues,
    pulls,
    links,
    otel: {
      provenance: 'verified-autonomous-otel',
      complete: true,
      receipts,
      ciRuns,
      interventions,
      traceparents: [{receiptId: 'gh-1-dispatch', traceparent: TRACEPARENT_1}]
    }
  });

  assert.equal(report.valid, true);
  assert.equal(report.reason, 'MEASURED_REPORT');
  assert.equal(report.autonomousOtel.status, 'measured');
  assert.equal(report.autonomousOtel.autonomousClaimEligible, true);

  // Historical proxy reflects 2h+ backlog wait, strictly quarantined from autonomous 90s ready->firstPr
  assert.equal(report.historicalProxies.issueCreatedToFirstPrMs.p50Ms, 7_290_000);
  assert.equal(report.autonomousOtel.issueReadyToFirstPrMs.p50Ms, 90_000);
  assert.equal(report.autonomousOtel.issueReadyToFirstPrMs.slo.p50MeetsInitial, true);
  assert.equal(report.autonomousOtel.issueReadyToFirstPrMs.slo.p50MeetsStretch, true);

  assert.equal(report.historicalProxies.prCreatedToMergeMs.p50Ms, 180_000);
  assert.equal(report.autonomousOtel.prToVerifiedMainMs.p50Ms, 240_000);
  assert.equal(report.autonomousOtel.prToVerifiedMainMs.slo.p50MeetsInitial, true);
  assert.equal(report.autonomousOtel.prToVerifiedMainMs.slo.p50MeetsStretch, true);

  assert.equal(report.historicalProxies.issueCreatedToCloseMs.p50Ms, 7_620_000);
  assert.equal(report.autonomousOtel.issueReadyToOutcomeMs.p50Ms, 360_000);
  assert.equal(report.autonomousOtel.issueReadyToOutcomeMs.slo.p50MeetsInitial, true);
  assert.equal(report.autonomousOtel.issueReadyToOutcomeMs.slo.p50MeetsStretch, true);

  assert.equal(report.autonomousOtel.standardAutomatedCiMs.p50Ms, 28_000);
  assert.equal(report.autonomousOtel.standardAutomatedCiMs.slo.p50MeetsInitial, true);
  assert.equal(report.autonomousOtel.standardAutomatedCiMs.slo.p50MeetsStretch, true);

  assert.equal(report.autonomousOtel.routineHumanInterventions.status, 'measured');
  assert.equal(report.autonomousOtel.routineHumanInterventions.totalRoutineCount, 0);
  assert.equal(report.autonomousOtel.routineHumanInterventions.totalGovernanceCount, 1);
  assert.equal(report.autonomousOtel.routineHumanInterventions.zeroRoutineVerified, true);
  assert.equal(report.autonomousOtel.routineHumanInterventions.sloMet, true);

  const ev = report.autonomousOtel.receiptEvidence;
  assert.equal(ev.inWindowReceiptCount, 9);
  assert.equal(ev.correlatedReceiptCount, 7);
  assert.equal(ev.uncorrelatedReceiptCount, 2);
  assert.equal(ev.verifiedTraceparentCount, 1);
  assert.deepEqual(ev.stageEventCounts, {
    reconcile: 1,
    dispatch: 1,
    ci: 1,
    review: 1,
    mergeShadow: 1,
    verifyMain: 1,
    acceptance: 1
  });
  assert.deepEqual(ev.blockedByReason, {LEASE: 2});
  assert.equal(ev.stageRows.length, 7);
});

test('T02: handles reopened issues, partial PRs, many-to-many linkage, title-similarity rejection, unlinked PRs, censored work, and null missing timestamps (never 0)', () => {
  const issues = [
    // #1: Multi-PR issue (partial PR #201 + completing PR #202), reopened once BEFORE acceptance -> accepted once!
    makeIssue(1, {
      createdAt: 2_000_000,
      readyAt: 2_100_000,
      reopenedCount: 1,
      lastReopenedAt: 2_300_000,
      acceptedAt: 2_800_000,
      closedAt: 2_800_000,
      requiredPullNumbers: [201, 202]
    }),
    // #2: Shares PR #202 (many-to-many!) + completed cleanly -> accepted once!
    makeIssue(2, {
      createdAt: 2_050_000,
      readyAt: 2_150_000,
      acceptedAt: 2_850_000,
      closedAt: 2_850_000,
      requiredPullNumbers: [202]
    }),
    // #3: Closed prematurely with ONLY a partial PR (#203) -> partial-only, never accepted!
    makeIssue(3, {
      createdAt: 3_000_000,
      readyAt: 3_100_000,
      acceptedAt: 3_500_000,
      closedAt: 3_500_000,
      acceptanceVerified: true,
      requiredPullNumbers: [203]
    }),
    // #4: Reopened AT/AFTER prior acceptedAt -> reopened-unaccepted, never accepted!
    makeIssue(4, {
      createdAt: 4_000_000,
      readyAt: 4_100_000,
      reopenedCount: 1,
      lastReopenedAt: 4_600_000,
      acceptedAt: 4_600_000,
      closedAt: 4_700_000,
      acceptanceVerified: true,
      requiredPullNumbers: [204]
    }),
    // #5: Linked ONLY by title-similarity (#205) -> link rejected, acceptance unverified/unknown, firstPr null!
    makeIssue(5, {
      createdAt: 5_000_000,
      readyAt: 5_100_000,
      acceptedAt: 5_600_000,
      closedAt: 5_600_000,
      acceptanceVerified: true,
      requiredPullNumbers: [205]
    }),
    // #6: Censored open issue (overdue >25m at observedMs)
    makeIssue(6, {
      state: 'open',
      createdAt: 6_000_000,
      readyAt: 6_100_000,
      closedAt: null,
      acceptedAt: null,
      acceptanceVerified: false,
      requiredPullNumbers: null
    }),
    // #7: Missing timestamps (createdAt: null, readyAt: null, closedAt: null, acceptedAt: null) -> null, NEVER 0!
    makeIssue(7, {
      state: 'closed',
      createdAt: null,
      readyAt: null,
      closedAt: null,
      acceptedAt: null,
      acceptanceVerified: true,
      requiredPullNumbers: null
    }),
    // #8: Reopened and closed without re-verified acceptance -> reopened-unaccepted
    makeIssue(8, {
      state: 'closed',
      createdAt: 7_000_000,
      readyAt: null,
      reopenedCount: 2,
      lastReopenedAt: 7_200_000,
      closedAt: 7_500_000,
      acceptedAt: null,
      acceptanceVerified: false,
      requiredPullNumbers: null,
      otelVerified: false
    })
  ];

  const pulls = [
    // #201: Partial slice PR for #1
    makePull(201, {
      partial: true,
      createdAt: 2_150_000,
      mergedAt: 2_250_000,
      closedAt: 2_250_000,
      mainVerifiedAt: 2_260_000
    }),
    // #202: Completing PR shared by #1 and #2 (many-to-many)
    makePull(202, {
      partial: false,
      createdAt: 2_400_000,
      mergedAt: 2_700_000,
      closedAt: 2_700_000,
      mergeSha: SHA_B,
      mainVerifiedSha: SHA_B,
      mainVerifiedAt: 2_750_000
    }),
    // #203: Partial-only PR for #3
    makePull(203, {
      partial: true,
      createdAt: 3_150_000,
      mergedAt: 3_400_000,
      closedAt: 3_400_000,
      mainVerifiedAt: 3_420_000
    }),
    // #204: PR for reopened #4
    makePull(204, {
      createdAt: 4_200_000,
      mergedAt: 4_500_000,
      closedAt: 4_500_000,
      mainVerifiedAt: 4_520_000
    }),
    // #205: PR with ONLY title-similarity link -> remains unlinked!
    makePull(205, {
      createdAt: 5_200_000,
      mergedAt: 5_400_000,
      closedAt: 5_400_000,
      mainVerifiedAt: 5_450_000
    }),
    // #206: Completely unlinked open PR (censored)
    makePull(206, {
      state: 'open',
      createdAt: 6_200_000,
      mergedAt: null,
      closedAt: null,
      mergeSha: null,
      mainVerifiedSha: null,
      mainVerified: false,
      mainVerifiedAt: null
    }),
    // #207: Merged PR with missing mergedAt & mainVerifiedAt (null, NEVER 0!)
    makePull(207, {
      state: 'merged',
      createdAt: 6_500_000,
      mergedAt: null,
      closedAt: null,
      mergeSha: SHA_C,
      mainVerifiedSha: SHA_C,
      mainVerified: true,
      mainVerifiedAt: null
    })
  ];

  const links = [
    makeLink(1, 201, {partial: true}),
    makeLink(1, 201, {evidenceKind: 'timeline-cross-reference', partial: true}), // duplicate explicit link deduplicated
    makeLink(1, 202, {partial: false}),
    makeLink(2, 202, {partial: false}),
    makeLink(3, 203, {partial: true}),
    makeLink(4, 204),
    makeLink(5, 205, {evidenceKind: 'title-similarity'}) // rejected!
  ];

  const ciRuns = [
    // Exact 75_000ms boundary MISSES strict `< 75s` initial objective!
    makeCiRun('ci-boundary-miss', 201, {startedAt: 2_160_000, completedAt: 2_235_000}),
    // Identical duplicate CI run deduplicated
    makeCiRun('ci-boundary-miss', 201, {startedAt: 2_160_000, completedAt: 2_235_000}),
    // Missing completedAt -> null / unknown, never 0
    makeCiRun('ci-missing-end', 202, {startedAt: 2_410_000, completedAt: null}),
    // Open overdue CI run -> censored + overdueOpenCount
    makeCiRun('ci-open', 206, {state: 'open', startedAt: 6_210_000, completedAt: null, traceparent: null})
  ];

  const report = buildHistoricalAndOtelEvidenceReport({
    query: baseQuery(),
    authorizedRepositories: baseAuth(),
    issues,
    pulls,
    links,
    otel: {
      provenance: 'verified-autonomous-otel',
      complete: true,
      receipts: [],
      ciRuns,
      // Issue #1 has verified 0 routine, Issue #2 has unverified (null) interventions -> partial, never 0!
      interventions: [
        makeIntervention(1, {verified: true, routineCount: 0, governanceCount: 0}),
        makeIntervention(2, {verified: false, routineCount: null, governanceCount: null})
      ]
    }
  });

  assert.equal(report.valid, true);
  assert.equal(report.reason, 'PARTIAL_EVIDENCE');

  // Many-to-many, duplicates, title-similarity quarantine, unlinked & partial PRs
  assert.equal(report.correlation.manyToManyPresent, true);
  assert.deepEqual(report.correlation.multiPrIssueNumbers, [1]);
  assert.deepEqual(report.correlation.multiIssuePullNumbers, [202]);
  assert.deepEqual(report.correlation.unlinkedPullNumbers, [205, 206, 207]);
  assert.deepEqual(report.correlation.partialPullNumbers, [201, 203]);
  assert.deepEqual(report.correlation.reopenedIssueNumbers, [1, 4, 8]);
  assert.equal(report.correlation.counts.deduplicatedExplicitLinks, 1);
  assert.deepEqual(report.correlation.rejectedTitleSimilarityLinks, [{issueNumber: 5, pullNumber: 205}]);

  // Only #1 and #2 are accepted outcomes (counted once per issue = 2, even though 5 PRs merged!)
  assert.equal(report.throughput.acceptedOutcomesInWindow, 2);
  assert.equal(report.throughput.mergedPullsInWindow, 5);
  assert.equal(report.throughput.mergedPullsActivityOnly, true);
  assert.equal(report.throughput.complete, false);
  assert.equal(report.throughput.acceptedOutcomesPerDay, null);

  const byIssue = new Map(report.correlation.issueOutcomes.map(o => [o.issueNumber, o]));
  // #1: uses earliest linked PR (#201 at 2_150_000) and keeps original readyAt (2_100_000) across reopen!
  assert.equal(byIssue.get(1).classification, 'accepted');
  assert.equal(byIssue.get(1).autonomousIssueReadyToFirstPrMs, 50_000);
  assert.equal(byIssue.get(1).autonomousIssueReadyToOutcomeMs, 700_000);
  // #3: partial-only
  assert.equal(byIssue.get(3).classification, 'partial-only');
  assert.equal(byIssue.get(3).autonomousIssueReadyToOutcomeMs, null);
  // #4: reopened at/after acceptedAt
  assert.equal(byIssue.get(4).classification, 'reopened-unaccepted');
  assert.equal(byIssue.get(4).autonomousIssueReadyToOutcomeMs, null);
  // #5: title-similarity rejected -> null firstPr and unknown outcome (never 0!)
  assert.equal(byIssue.get(5).classification, 'unknown');
  assert.equal(byIssue.get(5).historicalIssueCreatedToFirstPrMs, null);
  assert.equal(byIssue.get(5).autonomousIssueReadyToFirstPrMs, null);
  assert.equal(byIssue.get(5).autonomousIssueReadyToOutcomeMs, null);
  // #6: censored open
  assert.equal(byIssue.get(6).classification, 'censored-open');
  assert.equal(byIssue.get(6).autonomousIssueReadyToOutcomeMs, null);
  // #7: missing timestamps -> null, never 0!
  assert.equal(byIssue.get(7).classification, 'unknown');
  assert.equal(byIssue.get(7).historicalIssueCreatedToFirstPrMs, null);
  assert.equal(byIssue.get(7).historicalIssueCreatedToCloseMs, null);
  assert.equal(byIssue.get(7).autonomousIssueReadyToFirstPrMs, null);
  assert.equal(byIssue.get(7).autonomousIssueReadyToOutcomeMs, null);
  // #8: reopened-unaccepted historical close preserved without claiming acceptance
  assert.equal(byIssue.get(8).classification, 'reopened-unaccepted');
  assert.equal(byIssue.get(8).historicalIssueCreatedToCloseMs, 500_000);

  // CI boundary & missing timestamp checks
  assert.equal(report.autonomousOtel.standardAutomatedCiMs.p50Ms, 75_000);
  assert.equal(report.autonomousOtel.standardAutomatedCiMs.slo.initialMissCount, 1);
  assert.equal(report.autonomousOtel.standardAutomatedCiMs.slo.stretchMissCount, 1);
  assert.equal(report.autonomousOtel.standardAutomatedCiMs.slo.overdueOpenCount, 1);
  assert.equal(report.autonomousOtel.standardAutomatedCiMs.counts.unknown, 1);
  assert.equal(report.autonomousOtel.standardAutomatedCiMs.slo.p50MeetsInitial, null);

  // Incomplete human intervention evidence stays partial/null, never 0
  assert.equal(report.autonomousOtel.routineHumanInterventions.status, 'partial');
  assert.equal(report.autonomousOtel.routineHumanInterventions.totalRoutineCount, null);
  assert.equal(report.autonomousOtel.routineHumanInterventions.zeroRoutineVerified, false);
  assert.equal(report.autonomousOtel.routineHumanInterventions.sloMet, null);
});

test('per-repository cohort authorization and cross-repository / cross-cohort isolation', () => {
  assert.deepEqual(SUPPORTED_COHORT_REPOSITORIES, [
    'SoftwareFactory',
    'FamilyTree',
    'Spellbook',
    'FamilyHub'
  ]);

  // Repository name alone never grants read access when readAuthorized is false
  for (const [repositoryKey, repositoryId] of [
    ['FamilyTree', 2001],
    ['Spellbook', 2002],
    ['FamilyHub', 2003]
  ]) {
    const denied = buildHistoricalAndOtelEvidenceReport({
      query: baseQuery({repositoryKey, repositoryId}),
      authorizedRepositories: baseAuth(),
      issues: [],
      pulls: [],
      links: []
    });
    assert.equal(denied.valid, false);
    assert.equal(denied.reason, 'REPOSITORY_NOT_AUTHORIZED');

    // Explicitly authorizing that single consumer repository succeeds in isolation
    const allowed = buildHistoricalAndOtelEvidenceReport({
      query: baseQuery({repositoryKey, repositoryId}),
      authorizedRepositories: [{repositoryKey, repositoryId, readAuthorized: true}],
      issues: [],
      pulls: [],
      links: []
    });
    assert.equal(allowed.valid, true);
    assert.equal(allowed.repositoryKey, repositoryKey);
    assert.equal(allowed.repositoryId, repositoryId);
  }

  // SoftwareFactory ID binding cannot be spoofed
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({
      query: baseQuery({repositoryKey: 'SoftwareFactory', repositoryId: 9999}),
      authorizedRepositories: [{repositoryKey: 'SoftwareFactory', repositoryId: 9999, readAuthorized: true}],
      issues: [],
      pulls: [],
      links: []
    }).reason,
    'INVALID_QUERY'
  );
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({
      query: baseQuery({repositoryKey: 'FamilyTree', repositoryId: SF_ID}),
      authorizedRepositories: [{repositoryKey: 'FamilyTree', repositoryId: SF_ID, readAuthorized: true}],
      issues: [],
      pulls: [],
      links: []
    }).reason,
    'INVALID_QUERY'
  );

  // Cross-repository contamination fails closed across every collection
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({
      query: baseQuery(),
      authorizedRepositories: baseAuth(),
      issues: [makeIssue(1, {repositoryId: 2001})],
      pulls: [],
      links: []
    }).reason,
    'CROSS_REPOSITORY_CONTAMINATION'
  );
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({
      query: baseQuery(),
      authorizedRepositories: baseAuth(),
      issues: [],
      pulls: [makePull(101, {repositoryId: 2001})],
      links: []
    }).reason,
    'CROSS_REPOSITORY_CONTAMINATION'
  );
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({
      query: baseQuery(),
      authorizedRepositories: baseAuth(),
      issues: [],
      pulls: [],
      links: [makeLink(1, 101, {repositoryId: 2001})]
    }).reason,
    'CROSS_REPOSITORY_CONTAMINATION'
  );
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({
      query: baseQuery(),
      authorizedRepositories: baseAuth(),
      issues: [],
      pulls: [],
      links: [],
      otel: {
        provenance: 'verified-autonomous-otel',
        complete: true,
        receipts: [makeHostedReceipt('r-other-repo', 'dispatch', {repositoryId: 2001})],
        ciRuns: [],
        interventions: []
      }
    }).reason,
    'CROSS_REPOSITORY_CONTAMINATION'
  );
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({
      query: baseQuery(),
      authorizedRepositories: baseAuth(),
      issues: [],
      pulls: [],
      links: [],
      otel: {
        provenance: 'verified-autonomous-otel',
        complete: true,
        receipts: [],
        ciRuns: [makeCiRun('ci-other', 101, {repositoryId: 2001})],
        interventions: []
      }
    }).reason,
    'CROSS_REPOSITORY_CONTAMINATION'
  );
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({
      query: baseQuery(),
      authorizedRepositories: baseAuth(),
      issues: [],
      pulls: [],
      links: [],
      otel: {
        provenance: 'verified-autonomous-otel',
        complete: true,
        receipts: [],
        ciRuns: [],
        interventions: [makeIntervention(1, {repositoryId: 2001})]
      }
    }).reason,
    'CROSS_REPOSITORY_CONTAMINATION'
  );

  // Cohort mismatch fails closed across issues, pulls, ciRuns, and interventions
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({
      query: baseQuery(),
      authorizedRepositories: baseAuth(),
      issues: [makeIssue(1, {cohort: 'other-cohort'})],
      pulls: [],
      links: []
    }).reason,
    'COHORT_MISMATCH'
  );
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({
      query: baseQuery(),
      authorizedRepositories: baseAuth(),
      issues: [],
      pulls: [makePull(101, {cohort: 'other-cohort'})],
      links: []
    }).reason,
    'COHORT_MISMATCH'
  );
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({
      query: baseQuery(),
      authorizedRepositories: baseAuth(),
      issues: [],
      pulls: [],
      links: [],
      otel: {
        provenance: 'verified-autonomous-otel',
        complete: true,
        receipts: [],
        ciRuns: [makeCiRun('ci-1', 101, {cohort: 'other-cohort'})],
        interventions: []
      }
    }).reason,
    'COHORT_MISMATCH'
  );
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({
      query: baseQuery(),
      authorizedRepositories: baseAuth(),
      issues: [],
      pulls: [],
      links: [],
      otel: {
        provenance: 'verified-autonomous-otel',
        complete: true,
        receipts: [],
        ciRuns: [],
        interventions: [makeIntervention(1, {cohort: 'other-cohort'})]
      }
    }).reason,
    'COHORT_MISMATCH'
  );
});

test('T03: repeatable baseline comparison evaluates 2x-25x checkpoints and blocks invalid comparisons', () => {
  assert.deepEqual(THROUGHPUT_CHECKPOINTS, [2, 5, 10, 15, 20, 25]);
  assert.equal(AUTONOMOUS_OTEL_OBJECTIVES.issueReadyToFirstPrMs.initialMs, 600_000);
  assert.equal(AUTONOMOUS_OTEL_OBJECTIVES.prToVerifiedMainMs.initialMs, 900_000);
  assert.equal(AUTONOMOUS_OTEL_OBJECTIVES.issueReadyToOutcomeMs.initialMs, 1_500_000);
  assert.equal(AUTONOMOUS_OTEL_OBJECTIVES.standardAutomatedCiMs.initialMs, 75_000);

  function buildWindowCohort(fromMs, toMs, count, provenance = 'verified-autonomous-otel', cohort = 'small-comparable') {
    const issues = [];
    const pulls = [];
    const links = [];
    const interventions = [];
    for (let i = 1; i <= count; i++) {
      const createdAt = fromMs + i * 1000;
      const readyAt = createdAt + 1000;
      const prCreatedAt = readyAt + 60_000;
      const mergedAt = prCreatedAt + 120_000;
      const mainVerifiedAt = mergedAt + 30_000;
      const acceptedAt = mainVerifiedAt + 30_000;
      issues.push(makeIssue(i, {
        cohort,
        createdAt,
        readyAt,
        acceptedAt,
        closedAt: acceptedAt,
        requiredPullNumbers: [1000 + i]
      }));
      pulls.push(makePull(1000 + i, {
        cohort,
        createdAt: prCreatedAt,
        mergedAt,
        closedAt: mergedAt,
        mainVerifiedAt
      }));
      links.push(makeLink(i, 1000 + i));
      interventions.push(makeIntervention(i, {cohort}));
    }
    return {
      query: baseQuery({
        cohort,
        fromMs,
        toMs,
        observedMs: toMs + 10_000,
        nowMs: toMs + 20_000
      }),
      authorizedRepositories: baseAuth(),
      issues,
      pulls,
      links,
      otel: {
        provenance,
        complete: true,
        receipts: [
          createExecutionReceipt({
            source: provenance === 'verified-autonomous-otel' ? 'github-hosted' : 'synthetic',
            repositoryId: SF_ID,
            receiptId: `r-${fromMs}`,
            observedMs: fromMs + 5_000,
            stage: 'acceptance',
            durationMs: 100,
            outcome: 'eligible',
            reason: 'NONE',
            quota: {verified: true, includedOnly: true, available: true},
            cost: {verified: true, currency: 'USD', amountMicros: 0},
            humanTouches: {verified: true, count: 0}
          })
        ],
        ciRuns: [makeCiRun(`ci-${fromMs}`, 1001, {
          cohort,
          startedAt: fromMs + 70_000,
          completedAt: fromMs + 95_000
        })],
        interventions
      }
    };
  }

  const baselineReport = buildHistoricalAndOtelEvidenceReport(
    buildWindowCohort(1_000_000, 87_400_000, 5)
  );
  assert.equal(baselineReport.valid, true);

  // 25 accepted outcomes vs 5 baseline = 5x checkpoint reached!
  const currentInput = buildWindowCohort(87_400_000, 173_800_000, 25);
  const compared = buildHistoricalAndOtelEvidenceReport({...currentInput, baseline: baselineReport});
  assert.equal(compared.valid, true);
  assert.equal(compared.baselineComparison.comparable, true);
  assert.equal(compared.baselineComparison.throughputMultiplier, 5);
  assert.deepEqual(compared.baselineComparison.reachedCheckpoints, [2, 5]);
  assert.equal(compared.baselineComparison.highestCheckpointReached, 5);
  assert.equal(compared.baselineComparison.autonomousSpeedClaimEligible, true);

  // Below 2x multiplier reaches zero checkpoints (highestCheckpointReached === null)
  const modest = buildHistoricalAndOtelEvidenceReport({
    ...buildWindowCohort(87_400_000, 173_800_000, 6),
    baseline: baselineReport
  });
  assert.equal(modest.baselineComparison.comparable, true);
  assert.equal(modest.baselineComparison.highestCheckpointReached, null);

  // Scope mismatch
  const wrongCohortBase = buildHistoricalAndOtelEvidenceReport(
    buildWindowCohort(1_000_000, 87_400_000, 5, 'verified-autonomous-otel', 'other-cohort')
  );
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({...currentInput, baseline: wrongCohortBase}).baselineComparison.reason,
    'SCOPE_MISMATCH'
  );

  // Missing OTel on baseline -> AUTONOMOUS_OTEL_REQUIRED
  const noOtelBaseInput = buildWindowCohort(1_000_000, 87_400_000, 5);
  delete noOtelBaseInput.otel;
  const noOtelBase = buildHistoricalAndOtelEvidenceReport(noOtelBaseInput);
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({...currentInput, baseline: noOtelBase}).baselineComparison.reason,
    'AUTONOMOUS_OTEL_REQUIRED'
  );

  // Overlapping / unequal windows -> WINDOWS_NOT_COMPARABLE
  const unequalBase = buildHistoricalAndOtelEvidenceReport(
    buildWindowCohort(1_000_000, 50_000_000, 5)
  );
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({...currentInput, baseline: unequalBase}).baselineComparison.reason,
    'WINDOWS_NOT_COMPARABLE'
  );

  // Fewer than 5 accepted outcomes -> INSUFFICIENT_COMPARABLE_EVIDENCE
  const smallBase = buildHistoricalAndOtelEvidenceReport(
    buildWindowCohort(1_000_000, 87_400_000, 4)
  );
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({...currentInput, baseline: smallBase}).baselineComparison.reason,
    'INSUFFICIENT_COMPARABLE_EVIDENCE'
  );

  // Synthetic vs verified-autonomous-otel provenance mixing -> PROVENANCE_ISOLATION_VIOLATION
  const syntheticBase = buildHistoricalAndOtelEvidenceReport(
    buildWindowCohort(1_000_000, 87_400_000, 5, 'synthetic-otel-fixture')
  );
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({...currentInput, baseline: syntheticBase}).reason,
    'PROVENANCE_ISOLATION_VIOLATION'
  );

  // Historical proxy object passed as baseline or otel -> PROVENANCE_ISOLATION_VIOLATION
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({
      ...currentInput,
      baseline: baselineReport.historicalProxies
    }).reason,
    'PROVENANCE_ISOLATION_VIOLATION'
  );
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({
      ...currentInput,
      otel: {provenance: 'historical-github-proxy'}
    }).reason,
    'PROVENANCE_ISOLATION_VIOLATION'
  );
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({...currentInput, baseline: {invalid: true}}).reason,
    'INVALID_BASELINE_REPORT'
  );
});

test('rejects proxies, getters, custom prototypes, symbols, extra fields, and prototype pollution with zero trap/getter calls', () => {
  let trapCalls = 0;
  const trap = () => {
    trapCalls++;
    throw new Error('unexpected trap or getter');
  };
  const proxyHandler = {
    get: trap,
    getOwnPropertyDescriptor: trap,
    ownKeys: trap,
    getPrototypeOf: trap
  };

  const validInput = () => ({
    query: baseQuery(),
    authorizedRepositories: baseAuth(),
    issues: [makeIssue(1)],
    pulls: [makePull(101)],
    links: [makeLink(1, 101)]
  });

  // Top-level & nested proxies (including revoked proxy)
  assert.equal(buildHistoricalAndOtelEvidenceReport(new Proxy(validInput(), proxyHandler)).reason, 'INVALID_INPUT');
  const revoked = Proxy.revocable(validInput().issues, proxyHandler);
  revoked.revoke();
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({...validInput(), issues: revoked.proxy}).reason,
    'INVALID_ISSUES'
  );
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({...validInput(), issues: [new Proxy(makeIssue(1), proxyHandler)]}).reason,
    'INVALID_ISSUE'
  );
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({...validInput(), pulls: [new Proxy(makePull(101), proxyHandler)]}).reason,
    'INVALID_PULL'
  );
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({...validInput(), links: [new Proxy(makeLink(1, 101), proxyHandler)]}).reason,
    'INVALID_LINK_EVIDENCE'
  );

  // Getters on object properties and array elements
  const getterIssue = makeIssue(1);
  Object.defineProperty(getterIssue, 'state', {get: trap, enumerable: true});
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({...validInput(), issues: [getterIssue]}).reason,
    'INVALID_ISSUE'
  );

  const getterArray = [makePull(101)];
  Object.defineProperty(getterArray, 0, {get: trap, enumerable: true});
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({...validInput(), pulls: getterArray}).reason,
    'INVALID_PULLS'
  );

  // Symbol keys, non-plain prototypes, sparse arrays, extra private-text fields (title/body/author)
  const symInput = {...validInput(), [Symbol('secret')]: 'hidden'};
  assert.equal(buildHistoricalAndOtelEvidenceReport(symInput).reason, 'INVALID_INPUT');
  assert.equal(buildHistoricalAndOtelEvidenceReport(Object.create(validInput())).reason, 'INVALID_INPUT');
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({...validInput(), issues: [{...makeIssue(1), title: 'raw title'}]}).reason,
    'INVALID_ISSUE'
  );
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({...validInput(), pulls: [{...makePull(101), author: 'alice'}]}).reason,
    'INVALID_PULL'
  );
  const sparse = new Array(1);
  assert.equal(buildHistoricalAndOtelEvidenceReport({...validInput(), links: sparse}).reason, 'INVALID_LINKS');

  // Object.prototype getter pollution cannot intercept omitted optional keys
  try {
    Object.defineProperty(Object.prototype, 'otel', {get: trap, configurable: true});
    Object.defineProperty(Object.prototype, 'baseline', {get: trap, configurable: true});
    Object.defineProperty(Object.prototype, 'partial', {get: trap, configurable: true});
    const cleanRes = buildHistoricalAndOtelEvidenceReport(validInput());
    assert.equal(cleanRes.valid, true);
  } finally {
    delete Object.prototype.otel;
    delete Object.prototype.baseline;
    delete Object.prototype.partial;
  }

  assert.equal(trapCalls, 0);
});

test('covers fail-closed validation and edge branches across query, historical states, correlation, and OTel subsections', () => {
  // Invalid query, freshness, and staleness
  assert.equal(buildHistoricalAndOtelEvidenceReport(null).reason, 'INVALID_INPUT');
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({
      query: baseQuery({fromMs: 5_000, toMs: 5_000}),
      authorizedRepositories: baseAuth(),
      issues: [],
      pulls: [],
      links: []
    }).reason,
    'INVALID_QUERY'
  );
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({
      query: baseQuery({observedMs: 87_399_999}),
      authorizedRepositories: baseAuth(),
      issues: [],
      pulls: [],
      links: []
    }).reason,
    'FRESHNESS_UNKNOWN'
  );
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({
      query: baseQuery({nowMs: 89_000_000, maxAgeMs: 100_000}),
      authorizedRepositories: baseAuth(),
      issues: [],
      pulls: [],
      links: []
    }).reason,
    'STALE_EVIDENCE'
  );

  // Invalid authorization lists
  for (const badAuth of [
    [],
    [{repositoryKey: 'SoftwareFactory', repositoryId: SF_ID, readAuthorized: 'yes'}],
    [
      {repositoryKey: 'SoftwareFactory', repositoryId: SF_ID, readAuthorized: true},
      {repositoryKey: 'SoftwareFactory', repositoryId: SF_ID, readAuthorized: true}
    ]
  ]) {
    assert.equal(
      buildHistoricalAndOtelEvidenceReport({
        query: baseQuery(),
        authorizedRepositories: badAuth,
        issues: [],
        pulls: [],
        links: []
      }).reason,
      'INVALID_AUTHORIZATION'
    );
  }

  // Duplicate IDs & invalid issue/pull/link shapes
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({
      query: baseQuery(),
      authorizedRepositories: baseAuth(),
      issues: [makeIssue(1), makeIssue(1)],
      pulls: [],
      links: []
    }).reason,
    'DUPLICATE_ISSUE'
  );
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({
      query: baseQuery(),
      authorizedRepositories: baseAuth(),
      issues: [makeIssue(1, {requiredPullNumbers: [101, 101]})],
      pulls: [],
      links: []
    }).reason,
    'INVALID_ISSUE'
  );
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({
      query: baseQuery(),
      authorizedRepositories: baseAuth(),
      issues: [makeIssue(1, {state: 'invalid'})],
      pulls: [],
      links: []
    }).reason,
    'INVALID_ISSUE'
  );
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({
      query: baseQuery(),
      authorizedRepositories: baseAuth(),
      issues: [],
      pulls: [makePull(101), makePull(101)],
      links: []
    }).reason,
    'DUPLICATE_PULL'
  );
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({
      query: baseQuery(),
      authorizedRepositories: baseAuth(),
      issues: [],
      pulls: [makePull(101, {mergeSha: 'BAD_SHA'})],
      links: []
    }).reason,
    'INVALID_PULL'
  );
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({
      query: baseQuery(),
      authorizedRepositories: baseAuth(),
      issues: [],
      pulls: [],
      links: [makeLink(1, 101, {evidenceKind: 'branch-guess'})]
    }).reason,
    'INVALID_LINK_EVIDENCE'
  );
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({
      query: baseQuery(),
      authorizedRepositories: baseAuth(),
      issues: [],
      pulls: [],
      links: [makeLink(1, 101, {partial: 'no'})]
    }).reason,
    'INVALID_LINK_EVIDENCE'
  );
  // Conflicting partial flag vs pull or duplicate link
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({
      query: baseQuery(),
      authorizedRepositories: baseAuth(),
      issues: [makeIssue(1)],
      pulls: [makePull(101, {partial: false})],
      links: [makeLink(1, 101, {partial: true})]
    }).reason,
    'CONFLICTING_LINK_EVIDENCE'
  );
  assert.equal(
    buildHistoricalAndOtelEvidenceReport({
      query: baseQuery(),
      authorizedRepositories: baseAuth(),
      issues: [makeIssue(1)],
      pulls: [],
      links: [makeLink(1, 999, {partial: false}), makeLink(1, 999, {partial: true})]
    }).reason,
    'CONFLICTING_LINK_EVIDENCE'
  );

  // Exercise remaining classification, cutoff-censoring, overdue-open, and unknown branches
  const richEdgeReport = buildHistoricalAndOtelEvidenceReport({
    query: baseQuery({historicalSourceComplete: false}),
    authorizedRepositories: baseAuth(),
    issues: [
      // Open issue with contradictory closedAt
      makeIssue(10, {
        state: 'open',
        createdAt: 2_000_000,
        closedAt: 2_100_000,
        readyAt: 2_010_000,
        acceptedAt: null,
        acceptanceVerified: false,
        requiredPullNumbers: null
      }),
      // Closed after toMs (right-censored at cutoff!)
      makeIssue(11, {
        state: 'closed',
        createdAt: 2_000_000,
        readyAt: 2_100_000,
        closedAt: 87_500_000,
        acceptedAt: 87_500_000,
        acceptanceVerified: true,
        requiredPullNumbers: [301]
      }),
      // Open issue with no PRs and overdue >10m ready->firstPr
      makeIssue(12, {
        state: 'open',
        createdAt: 2_000_000,
        readyAt: 2_100_000,
        closedAt: null,
        acceptedAt: null,
        acceptanceVerified: false,
        requiredPullNumbers: null
      }),
      // First PR created >= toMs (censored in firstPr proxy & OTel ready->firstPr)
      makeIssue(13, {
        state: 'open',
        createdAt: 2_000_000,
        readyAt: 2_100_000,
        closedAt: null,
        acceptedAt: null,
        acceptanceVerified: false,
        requiredPullNumbers: null
      }),
      // Closed with acceptanceVerified:false but non-null acceptedAt -> unknown
      makeIssue(14, {
        state: 'closed',
        createdAt: 2_000_000,
        readyAt: 2_100_000,
        closedAt: 2_500_000,
        acceptedAt: 2_500_000,
        acceptanceVerified: false,
        requiredPullNumbers: null
      }),
      // Reopened before readyAt -> unknown
      makeIssue(15, {
        state: 'closed',
        createdAt: 2_000_000,
        readyAt: 2_400_000,
        reopenedCount: 1,
        lastReopenedAt: 2_200_000,
        closedAt: 2_600_000,
        acceptedAt: 2_600_000,
        acceptanceVerified: true,
        requiredPullNumbers: [303]
      }),
      // Dangling explicit link on issue #16
      makeIssue(16, {
        state: 'open',
        createdAt: 2_000_000,
        readyAt: 2_100_000,
        closedAt: null,
        acceptedAt: null,
        acceptanceVerified: false,
        requiredPullNumbers: null
      }),
      // readyAt < createdAt -> unknown
      makeIssue(17, {
        state: 'open',
        createdAt: 2_500_000,
        readyAt: 2_100_000,
        closedAt: null,
        acceptedAt: null,
        acceptanceVerified: false,
        requiredPullNumbers: null
      }),
      // Inconsistent reopen evidence in window -> unknown in issueCreatedToCloseMs
      makeIssue(18, {
        state: 'closed',
        createdAt: 2_000_000,
        readyAt: null,
        reopenedCount: 1,
        lastReopenedAt: null,
        closedAt: 2_500_000,
        acceptedAt: null,
        acceptanceVerified: false,
        requiredPullNumbers: null,
        otelVerified: false
      }),
      // Closed issue in window with missing closedAt (null, never 0!) -> unknown in issueCreatedToCloseMs
      makeIssue(19, {
        state: 'closed',
        createdAt: 2_000_000,
        readyAt: null,
        closedAt: null,
        acceptedAt: null,
        acceptanceVerified: false,
        requiredPullNumbers: null,
        otelVerified: false
      })
    ],
    pulls: [
      // #301: Merged & verified main >= toMs (censored at cutoff)
      makePull(301, {
        createdAt: 2_200_000,
        mergedAt: 87_450_000,
        closedAt: 87_450_000,
        mainVerifiedAt: 87_480_000
      }),
      // #302: Created >= toMs (censored for #13)
      makePull(302, {
        state: 'open',
        createdAt: 87_500_000,
        mergedAt: null,
        closedAt: null,
        mergeSha: null,
        mainVerifiedSha: null,
        mainVerified: false,
        mainVerifiedAt: null
      }),
      // #303: Closed-unmerged in window + closed-unmerged after toMs + closed-unmerged missing closedAt
      makePull(303, {
        state: 'closed-unmerged',
        createdAt: 2_450_000,
        mergedAt: null,
        closedAt: 2_500_000,
        mergeSha: null,
        mainVerifiedSha: null,
        mainVerified: false,
        mainVerifiedAt: null
      }),
      makePull(304, {
        state: 'closed-unmerged',
        createdAt: 2_450_000,
        mergedAt: null,
        closedAt: 87_500_000,
        mergeSha: null,
        mainVerifiedSha: null,
        mainVerified: false,
        mainVerifiedAt: null
      }),
      makePull(305, {
        state: 'closed-unmerged',
        createdAt: 2_450_000,
        mergedAt: null,
        closedAt: null,
        mergeSha: null,
        mainVerifiedSha: null,
        mainVerified: false,
        mainVerifiedAt: null
      }),
      // #306: PR with null createdAt & #307: state unknown & #308: open with contradictory mergedAt
      makePull(306, {
        state: 'open',
        createdAt: null,
        mergedAt: null,
        closedAt: null,
        mergeSha: null,
        mainVerifiedSha: null,
        mainVerified: false,
        mainVerifiedAt: null
      }),
      makePull(307, {
        state: 'unknown',
        createdAt: 2_500_000,
        mergedAt: null,
        closedAt: null,
        mergeSha: null,
        mainVerifiedSha: null,
        mainVerified: false,
        mainVerifiedAt: null
      }),
      makePull(308, {
        state: 'open',
        createdAt: 2_500_000,
        mergedAt: 2_600_000,
        closedAt: null,
        mergeSha: null,
        mainVerifiedSha: null,
        mainVerified: false,
        mainVerifiedAt: null
      }),
      // #309: Merged before toMs, mainVerifiedAt >= toMs (censored in prToVerifiedMainMs, completed in prCreatedToMergeMs!)
      makePull(309, {
        state: 'merged',
        createdAt: 87_000_000,
        mergedAt: 87_300_000,
        closedAt: 87_300_000,
        mainVerifiedAt: 87_450_000
      })
    ],
    links: [
      makeLink(11, 301),
      makeLink(13, 302),
      makeLink(15, 303),
      makeLink(16, 999), // dangling pull
      makeLink(999, 301) // dangling issue
    ],
    otel: {
      provenance: 'verified-autonomous-otel',
      complete: false,
      receipts: [
        makeHostedReceipt('r-exhausted', 'dispatch', {
          quota: {verified: true, includedOnly: true, available: false},
          cost: {verified: false}
        }),
        makeHostedReceipt('r-unknown-quota', 'queue', {
          quota: {verified: false},
          cost: {verified: true, currency: 'USD', amountMicros: 0}
        })
      ],
      ciRuns: [
        makeCiRun('ci-null-start', 301, {startedAt: null, completedAt: null}),
        makeCiRun('ci-unknown-state', 301, {state: 'unknown', startedAt: 2_210_000, completedAt: null}),
        makeCiRun('ci-open-bad', 301, {state: 'open', startedAt: 2_210_000, completedAt: 2_220_000}),
        makeCiRun('ci-after-cutoff', 301, {startedAt: 87_380_000, completedAt: 87_420_000})
      ],
      interventions: []
    }
  });

  assert.equal(richEdgeReport.valid, true);
  assert.equal(richEdgeReport.autonomousOtel.issueReadyToFirstPrMs.slo.overdueOpenCount, 1);
  assert.equal(richEdgeReport.autonomousOtel.prToVerifiedMainMs.counts.closedUnmerged, 1);
  assert.equal(richEdgeReport.autonomousOtel.receiptEvidence.quota.exhaustedCount, 1);
  assert.equal(richEdgeReport.autonomousOtel.receiptEvidence.quota.unknownCount, 1);
  assert.equal(richEdgeReport.autonomousOtel.receiptEvidence.cost.unknownCount, 1);
  assert.equal(richEdgeReport.autonomousOtel.routineHumanInterventions.status, 'no-accepted-units');

  // OTel validation failures (invalid otel, receipts, traceparent, ciRuns, interventions)
  for (const [otelPatch, expectedReason] of [
    [{provenance: 'bad'}, 'INVALID_OTEL_EVIDENCE'],
    [{complete: 'yes'}, 'INVALID_OTEL_EVIDENCE'],
    [{receipts: null}, 'INVALID_OTEL_RECEIPTS'],
    [{receipts: [{provenance: 'historical-github-proxy'}]}, 'PROVENANCE_ISOLATION_VIOLATION'],
    [{receipts: [{bad: 1}]}, 'INVALID_OTEL_RECEIPT'],
    [
      {
        receipts: [
          createExecutionReceipt({
            source: 'synthetic',
            repositoryId: SF_ID,
            receiptId: 'syn-1',
            observedMs: 1_300_000,
            stage: 'dispatch',
            outcome: 'eligible',
            reason: 'NONE'
          })
        ]
      },
      'PROVENANCE_ISOLATION_VIOLATION'
    ],
    [{receipts: [makeHostedReceipt('r-future', 'dispatch', {observedMs: 99_000_000})]}, 'INVALID_OTEL_RECEIPT'],
    [{receipts: [makeHostedReceipt('r-dup', 'dispatch'), makeHostedReceipt('r-dup', 'dispatch')]}, 'DUPLICATE_OTEL_RECEIPT'],
    [{traceparents: 'bad'}, 'INVALID_OTEL_TRACEPARENT'],
    [{receipts: [makeHostedReceipt('r-tp', 'dispatch')], traceparents: [{bad: 1}]}, 'INVALID_OTEL_TRACEPARENT'],
    [
      {
        receipts: [makeHostedReceipt('r-tp', 'dispatch')],
        traceparents: [{receiptId: 'r-tp', traceparent: '00-' + '9'.repeat(32) + '-' + SPAN_1 + '-01'}]
      },
      'INVALID_OTEL_TRACEPARENT'
    ],
    [{ciRuns: null}, 'INVALID_CI_RUNS'],
    [{ciRuns: [{provenance: 'historical-github-proxy'}]}, 'PROVENANCE_ISOLATION_VIOLATION'],
    [{ciRuns: [{bad: 1}]}, 'INVALID_CI_RUN'],
    [{ciRuns: [makeCiRun(' bad id ', 101)]}, 'INVALID_CI_RUN'],
    [{ciRuns: [makeCiRun('ci-bad-tp', 101, {traceparent: 'invalid'})]}, 'INVALID_OTEL_TRACEPARENT'],
    [
      {
        ciRuns: [
          makeCiRun('ci-conflict', 101, {completedAt: 1_270_000}),
          makeCiRun('ci-conflict', 101, {completedAt: 1_275_000})
        ]
      },
      'CONFLICTING_CI_EVIDENCE'
    ],
    [{interventions: null}, 'INVALID_INTERVENTIONS'],
    [{interventions: [{provenance: 'historical-github-proxy'}]}, 'PROVENANCE_ISOLATION_VIOLATION'],
    [{interventions: [{bad: 1}]}, 'INVALID_INTERVENTION_EVIDENCE'],
    [{interventions: [makeIntervention(0)]}, 'INVALID_INTERVENTION_EVIDENCE'],
    [{interventions: [makeIntervention(1, {routineCount: 1001})]}, 'INVALID_INTERVENTION_EVIDENCE'],
    [{interventions: [makeIntervention(1, {verified: false, routineCount: 0, governanceCount: null})]}, 'INVALID_INTERVENTION_EVIDENCE'],
    [{interventions: [makeIntervention(1), makeIntervention(1)]}, 'DUPLICATE_INTERVENTION_EVIDENCE']
  ]) {
    const res = buildHistoricalAndOtelEvidenceReport({
      query: baseQuery(),
      authorizedRepositories: baseAuth(),
      issues: [],
      pulls: [],
      links: [],
      otel: {
        provenance: 'verified-autonomous-otel',
        complete: true,
        receipts: [],
        ciRuns: [],
        interventions: [],
        ...otelPatch
      }
    });
    assert.equal(res.valid, false);
    assert.equal(res.reason, expectedReason);
  }

  // Non-zero routine interventions fail the 0-intervention SLO
  const nonZeroRoutine = buildHistoricalAndOtelEvidenceReport({
    query: baseQuery(),
    authorizedRepositories: baseAuth(),
    issues: [makeIssue(1)],
    pulls: [makePull(101)],
    links: [makeLink(1, 101)],
    otel: {
      provenance: 'verified-autonomous-otel',
      complete: true,
      receipts: [],
      ciRuns: [],
      interventions: [makeIntervention(1, {routineCount: 2, governanceCount: 1})]
    }
  });
  assert.equal(nonZeroRoutine.autonomousOtel.routineHumanInterventions.status, 'measured');
  assert.equal(nonZeroRoutine.autonomousOtel.routineHumanInterventions.totalRoutineCount, 2);
  assert.equal(nonZeroRoutine.autonomousOtel.routineHumanInterventions.maxRoutinePerIssue, 2);
  assert.equal(nonZeroRoutine.autonomousOtel.routineHumanInterventions.zeroRoutineVerified, false);
  assert.equal(nonZeroRoutine.autonomousOtel.routineHumanInterventions.sloMet, false);
});
