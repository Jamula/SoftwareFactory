import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_CREDIT_USD_CENTS,
  DEFAULT_BOTTLENECK_THRESHOLDS,
  KNOWN_VIOLATION_CODES,
  SCORECARD_SOURCE_KINDS,
  buildAiCreditAndAutonomyScorecard
} from '../../tools/engineering-factory/ai-credit-scorecard.mjs';

const REPO_ID = 1471342715;
const CONSUMER_REPO_ID = 2222222222;

function makeAutonomousRecord(index, overrides = {}) {
  return {
    id: `run-${index}`,
    issueNumber: 100 + index,
    repositoryId: REPO_ID,
    cohort: 'm02-baseline',
    sourceKind: 'verified-autonomous',
    observedMs: 10_000 + index * 1000,
    accepted: true,
    accounting: {
      status: 'verified',
      aiCredits: 20,
      incrementalBilledUsdCents: 0,
      cloudSandboxMinutes: 6,
      actionsRunnerMinutes: 4
    },
    ghAwQueueLatencyMs: 25_000 + index * 1000,
    maf: {
      supersteps: 10,
      checkpointResumes: 1,
      innerRepairIterations: 1
    },
    audit: {
      fullProvenance: true,
      killSwitchTripped: false,
      violations: []
    },
    ...overrides
  };
}

function makeBaseScorecardInput(records, overrides = {}) {
  return {
    repositoryId: REPO_ID,
    authorizedRepositoryIds: [REPO_ID, CONSUMER_REPO_ID],
    cohort: 'm02-baseline',
    sourceKind: 'verified-autonomous',
    fromMs: 10_000,
    toMs: 50_000,
    observedMs: 55_000,
    nowMs: 60_000,
    maxAgeMs: 10_000,
    records,
    ...overrides
  };
}

test('aggregates verified-autonomous AI credits, gh-aw queue latency, MAF supersteps, and audit traceability', () => {
  assert.equal(AI_CREDIT_USD_CENTS, 1);
  assert.deepEqual(SCORECARD_SOURCE_KINDS, ['verified-autonomous', 'historical-proxy']);
  assert.equal(KNOWN_VIOLATION_CODES.length, 7);
  assert.equal(DEFAULT_BOTTLENECK_THRESHOLDS.maxQueueP95Ms, 120000);

  const records = [
    makeAutonomousRecord(0, {observedMs: 9_000}), // out-of-window (before fromMs), ignored after validation
    makeAutonomousRecord(1),
    makeAutonomousRecord(2),
    makeAutonomousRecord(3),
    makeAutonomousRecord(4),
    makeAutonomousRecord(5, {
      accounting: {
        status: 'verified',
        aiCredits: 30,
        incrementalBilledUsdCents: 0,
        cloudSandboxMinutes: 10,
        actionsRunnerMinutes: 6
      },
      ghAwQueueLatencyMs: 45_000,
      maf: {supersteps: 20, checkpointResumes: 0, innerRepairIterations: 2}
    }),
    makeAutonomousRecord(6, {accepted: false, observedMs: 49_000})
  ];

  const sc = buildAiCreditAndAutonomyScorecard(makeBaseScorecardInput(records));
  assert.equal(sc.valid, true);
  assert.equal(sc.shadow, true);
  assert.equal(sc.readOnly, true);
  assert.equal(sc.reason, 'MEASURED_AUTONOMOUS_SCORECARD');
  assert.equal(sc.autonomousClaimEligible, true);
  assert.equal(sc.acceptedOutcomes, 5);
  assert.equal(sc.aiCreditsTotal, 130);
  assert.equal(sc.aiCreditsUsdCents, 130);
  assert.equal(sc.aiCreditsPerAcceptedOutcome, 26);
  assert.equal(sc.incrementalBilledUsdCents, 0);
  assert.equal(sc.estimatedOrMissingCount, 0);
  assert.equal(sc.cloudSandboxMinutes, 40);
  assert.equal(sc.actionsRunnerMinutes, 26);
  assert.deepEqual(sc.ghAwQueueLatencyMs, {
    p50: 28_000,
    p95: 45_000,
    sampleCount: 6,
    unknownCount: 0
  });
  assert.deepEqual(sc.mafTelemetry, {
    superstepsTotal: 70,
    checkpointResumes: 5,
    innerRepairIterations: 7,
    reworkRateBps: 1000,
    missingCount: 0
  });
  assert.equal(sc.auditTraceability.totalActions, 6);
  assert.equal(sc.auditTraceability.fullProvenanceActions, 6);
  assert.equal(sc.auditTraceability.provenanceCompletenessPct, 100);
  assert.equal(sc.auditTraceability.killSwitchTrips, 0);
  assert.deepEqual(sc.bottlenecks, []);

  // 5 retries/actions on a single issueNumber/workUnitId deduplicate to 1 accepted outcome while summing all AI credits
  const retryRecords = [
    makeAutonomousRecord(1, {id: 'r1', issueNumber: 42, accepted: false}),
    makeAutonomousRecord(2, {id: 'r2', issueNumber: 42, accepted: false}),
    makeAutonomousRecord(3, {id: 'r3', issueNumber: 42, accepted: true}),
    makeAutonomousRecord(4, {id: 'r4', issueNumber: 42, accepted: true}),
    makeAutonomousRecord(5, {id: 'r5', issueNumber: 42, accepted: true})
  ];
  const retrySc = buildAiCreditAndAutonomyScorecard(makeBaseScorecardInput(retryRecords));
  assert.equal(retrySc.valid, true);
  assert.equal(retrySc.acceptedOutcomes, 1);
  assert.equal(retrySc.acceptedActionRows, 3);
  assert.equal(retrySc.aiCreditsTotal, 100);
  assert.equal(retrySc.aiCreditsPerAcceptedOutcome, 100);
  assert.equal(retrySc.autonomousClaimEligible, false);

  // Also supports string workUnitId when issueNumber is omitted, and repo-level unaccepted rows with neither
  const unitKeyRecords = [
    makeAutonomousRecord(1, {issueNumber: undefined, workUnitId: 'wu-alpha'}),
    makeAutonomousRecord(2, {issueNumber: undefined, accepted: false})
  ];
  delete unitKeyRecords[0].issueNumber;
  delete unitKeyRecords[1].issueNumber;
  const unitKeySc = buildAiCreditAndAutonomyScorecard(makeBaseScorecardInput(unitKeyRecords));
  assert.equal(unitKeySc.valid, true);
  assert.equal(unitKeySc.acceptedOutcomes, 1);
});

test('never substitutes 0 for missing, estimated, or empty-window metrics', () => {
  // Empty in-window cohort -> provenanceCompletenessPct is null, totals are null (never 0)
  const emptySc = buildAiCreditAndAutonomyScorecard(makeBaseScorecardInput([]));
  assert.equal(emptySc.valid, true);
  assert.equal(emptySc.reason, 'PARTIAL_OR_EMPTY_AUTONOMOUS_EVIDENCE');
  assert.equal(emptySc.aiCreditsTotal, null);
  assert.equal(emptySc.aiCreditsUsdCents, null);
  assert.equal(emptySc.aiCreditsPerAcceptedOutcome, null);
  assert.equal(emptySc.incrementalBilledUsdCents, null);
  assert.equal(emptySc.cloudSandboxMinutes, null);
  assert.equal(emptySc.actionsRunnerMinutes, null);
  assert.deepEqual(emptySc.ghAwQueueLatencyMs, {p50: null, p95: null, sampleCount: 0, unknownCount: 0});
  assert.equal(emptySc.mafTelemetry.superstepsTotal, null);
  assert.equal(emptySc.mafTelemetry.reworkRateBps, null);
  assert.equal(emptySc.auditTraceability.totalActions, 0);
  assert.equal(emptySc.auditTraceability.fullProvenanceActions, 0);
  assert.equal(emptySc.auditTraceability.provenanceCompletenessPct, null);
  assert.equal(emptySc.auditTraceability.killSwitchTrips, null);
  assert.equal(emptySc.auditTraceability.violationCounts, null);

  // Estimated or missing accounting, null sandbox/runner, null queue, null MAF, and 0 observed audits vs partial audits
  const zeroAuditSc = buildAiCreditAndAutonomyScorecard(makeBaseScorecardInput([
    makeAutonomousRecord(1, {
      accounting: {status: 'estimated'},
      ghAwQueueLatencyMs: null,
      maf: null,
      audit: null
    })
  ]));
  assert.equal(zeroAuditSc.auditTraceability.observedAuditActions, 0);
  assert.equal(zeroAuditSc.auditTraceability.auditComplete, false);
  assert.equal(zeroAuditSc.auditTraceability.killSwitchTrips, null);
  assert.equal(zeroAuditSc.auditTraceability.violationCounts, null);
  assert.equal(zeroAuditSc.confirmedIncrementalBilledUsdCents, null);

  // Partial audit and partial accounting preserve observed lower-bound killSwitchTrips and confirmedIncrementalBilledUsdCents in bottlenecks
  const partialSc = buildAiCreditAndAutonomyScorecard(makeBaseScorecardInput([
    makeAutonomousRecord(1, {
      accounting: {status: 'estimated'},
      ghAwQueueLatencyMs: null,
      maf: null,
      audit: null
    }),
    makeAutonomousRecord(2, {
      accounting: {
        status: 'verified',
        aiCredits: 25,
        incrementalBilledUsdCents: 7,
        cloudSandboxMinutes: 5,
        actionsRunnerMinutes: 3
      },
      audit: {
        fullProvenance: false,
        killSwitchTripped: true,
        violations: ['OUT_OF_LANE_EDIT']
      }
    })
  ]));
  assert.equal(partialSc.valid, true);
  assert.equal(partialSc.estimatedOrMissingCount, 1);
  assert.equal(partialSc.aiCreditsTotal, null);
  assert.equal(partialSc.aiCreditsUsdCents, null);
  assert.equal(partialSc.aiCreditsPerAcceptedOutcome, null);
  assert.equal(partialSc.incrementalBilledUsdCents, null);
  assert.equal(partialSc.confirmedIncrementalBilledUsdCents, 7);
  assert.equal(partialSc.cloudSandboxMinutes, null);
  assert.equal(partialSc.actionsRunnerMinutes, null);
  assert.equal(partialSc.ghAwQueueLatencyMs.unknownCount, 1);
  assert.equal(partialSc.mafTelemetry.superstepsTotal, null);
  assert.equal(partialSc.mafTelemetry.missingCount, 1);
  assert.equal(partialSc.auditTraceability.observedAuditActions, 1);
  assert.equal(partialSc.auditTraceability.auditComplete, false);
  assert.equal(partialSc.auditTraceability.provenanceCompletenessPct, null);
  assert.equal(partialSc.auditTraceability.killSwitchTrips, 1);
  assert.equal(partialSc.auditTraceability.violationCounts.OUT_OF_LANE_EDIT, 1);
  assert.deepEqual(
    partialSc.bottlenecks.map(b => b.id),
    ['anti-rogue-kill-switch-trips', 'ai-credit-accounting-gap', 'incremental-billed-spend']
  );

  // Safe integer overflow across any accounting or MAF sum fails closed with UNSAFE_AGGREGATE_TOTAL
  const max = Number.MAX_SAFE_INTEGER;
  for (const secondOverride of [
    {accounting: {status: 'verified', aiCredits: max, incrementalBilledUsdCents: 0, cloudSandboxMinutes: 1, actionsRunnerMinutes: 1}},
    {accounting: {status: 'verified', aiCredits: 1, incrementalBilledUsdCents: max, cloudSandboxMinutes: 1, actionsRunnerMinutes: 1}},
    {accounting: {status: 'verified', aiCredits: 1, incrementalBilledUsdCents: 0, cloudSandboxMinutes: max, actionsRunnerMinutes: 1}},
    {accounting: {status: 'verified', aiCredits: 1, incrementalBilledUsdCents: 0, cloudSandboxMinutes: 1, actionsRunnerMinutes: max}},
    {maf: {supersteps: max, checkpointResumes: 0, innerRepairIterations: 0}},
    {maf: {supersteps: 1, checkpointResumes: max, innerRepairIterations: 0}},
    {maf: {supersteps: 1, checkpointResumes: 0, innerRepairIterations: max}}
  ]) {
    const r1 = makeAutonomousRecord(1, {
      accounting: {status: 'verified', aiCredits: 20, incrementalBilledUsdCents: 1, cloudSandboxMinutes: 5, actionsRunnerMinutes: 5},
      maf: {supersteps: 10, checkpointResumes: 1, innerRepairIterations: 1}
    });
    const r2 = makeAutonomousRecord(2, secondOverride);
    const overflowSc = buildAiCreditAndAutonomyScorecard(makeBaseScorecardInput([r1, r2]));
    assert.equal(overflowSc.valid, false);
    assert.equal(overflowSc.autonomousClaimEligible, false);
    assert.equal(overflowSc.reason, 'UNSAFE_AGGREGATE_TOTAL');
  }
  // Overflow of reworkRateBps (> MAX_SAFE_INTEGER when innerRepairs * 10000 / supersteps overflows) also fails closed
  const bpsOverflowSc = buildAiCreditAndAutonomyScorecard(makeBaseScorecardInput([
    makeAutonomousRecord(1, {maf: {supersteps: 1, checkpointResumes: 0, innerRepairIterations: max}})
  ]));
  assert.equal(bpsOverflowSc.valid, false);
  assert.equal(bpsOverflowSc.reason, 'UNSAFE_AGGREGATE_TOTAL');

  // Verified credits but null compute minutes or 0 accepted outcomes keep dependent metrics null
  const missingCompute = buildAiCreditAndAutonomyScorecard(makeBaseScorecardInput([
    makeAutonomousRecord(1, {
      accepted: false,
      accounting: {
        status: 'verified',
        aiCredits: 15,
        incrementalBilledUsdCents: 0,
        cloudSandboxMinutes: null,
        actionsRunnerMinutes: null
      }
    })
  ]));
  assert.equal(missingCompute.aiCreditsTotal, 15);
  assert.equal(missingCompute.aiCreditsPerAcceptedOutcome, null);
  assert.equal(missingCompute.cloudSandboxMinutes, null);
  assert.equal(missingCompute.actionsRunnerMinutes, null);
});

test('ranks bottlenecks deterministically across audit, spend, AI credits, MAF rework, queue latency, and compute', () => {
  const troubled = buildAiCreditAndAutonomyScorecard(makeBaseScorecardInput([
    makeAutonomousRecord(1, {
      accounting: {
        status: 'verified',
        aiCredits: 90,
        incrementalBilledUsdCents: 5,
        cloudSandboxMinutes: 25,
        actionsRunnerMinutes: 18
      },
      ghAwQueueLatencyMs: 180_000,
      maf: {supersteps: 10, checkpointResumes: 3, innerRepairIterations: 4},
      audit: {
        fullProvenance: false,
        killSwitchTripped: true,
        violations: ['OUT_OF_LANE_EDIT', 'RETRY_CAP_EXCEEDED']
      }
    })
  ], {
    thresholds: {
      maxAiCreditsPerOutcome: 40,
      maxQueueP95Ms: 120_000,
      maxReworkRateBps: 1500,
      maxSandboxMinutesPerOutcome: 12,
      maxActionsMinutesPerOutcome: 10
    }
  }));

  assert.equal(troubled.valid, true);
  assert.equal(troubled.auditTraceability.provenanceCompletenessPct, 0);
  assert.equal(troubled.auditTraceability.killSwitchTrips, 1);
  assert.equal(troubled.auditTraceability.violationCounts.OUT_OF_LANE_EDIT, 1);
  assert.equal(troubled.auditTraceability.violationCounts.RETRY_CAP_EXCEEDED, 1);
  assert.deepEqual(
    troubled.bottlenecks.map(b => b.id),
    [
      'anti-rogue-kill-switch-trips',
      'causal-provenance-gap',
      'incremental-billed-spend',
      'high-ai-credits-per-outcome',
      'maf-superstep-rework-high',
      'gh-aw-queue-latency-p95',
      'cloud-sandbox-minutes-high',
      'actions-runner-minutes-high'
    ]
  );
  assert.deepEqual(troubled.bottlenecks.map(b => b.rank), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('isolates historical-proxy sourceKind and forbids mixing with verified-autonomous or cross-repo cohorts', () => {
  const proxySc = buildAiCreditAndAutonomyScorecard({
    repositoryId: CONSUMER_REPO_ID,
    authorizedRepositoryIds: [REPO_ID, CONSUMER_REPO_ID],
    cohort: 'legacy-2026',
    sourceKind: 'historical-proxy',
    fromMs: 1_000,
    toMs: 10_000,
    observedMs: 10_500,
    nowMs: 11_000,
    maxAgeMs: 5_000,
    records: [
      {
        id: 'p-outside',
        repositoryId: CONSUMER_REPO_ID,
        cohort: 'legacy-2026',
        sourceKind: 'historical-proxy',
        observedMs: 500,
        metric: 'issue-created-to-close',
        durationMs: 99_000
      },
      {
        id: 'p-1',
        repositoryId: CONSUMER_REPO_ID,
        cohort: 'legacy-2026',
        sourceKind: 'historical-proxy',
        observedMs: 2_000,
        metric: 'issue-created-to-close',
        durationMs: 60_000
      },
      {
        id: 'p-2',
        repositoryId: CONSUMER_REPO_ID,
        cohort: 'legacy-2026',
        sourceKind: 'historical-proxy',
        observedMs: 3_000,
        metric: 'issue-created-to-close',
        durationMs: null
      },
      {
        id: 'p-3',
        repositoryId: CONSUMER_REPO_ID,
        cohort: 'legacy-2026',
        sourceKind: 'historical-proxy',
        observedMs: 4_000,
        metric: 'pr-created-to-merge',
        durationMs: 30_000
      },
      {
        id: 'p-4',
        repositoryId: CONSUMER_REPO_ID,
        cohort: 'legacy-2026',
        sourceKind: 'historical-proxy',
        observedMs: 5_000,
        metric: 'pr-created-to-merge',
        durationMs: null
      }
    ]
  });

  assert.equal(proxySc.valid, true);
  assert.equal(proxySc.sourceKind, 'historical-proxy');
  assert.equal(proxySc.autonomousClaimEligible, false);
  assert.equal(proxySc.aiCreditsTotal, null);
  assert.equal(proxySc.cloudSandboxMinutes, null);
  assert.equal(proxySc.mafTelemetry.superstepsTotal, null);
  assert.equal(proxySc.auditTraceability.provenanceCompletenessPct, null);
  assert.deepEqual(proxySc.bottlenecks, []);
  assert.deepEqual(proxySc.historicalProxySummary.issueCreatedToClose, {
    p50: 60_000,
    p95: 60_000,
    sampleCount: 1,
    unknownCount: 1
  });
  assert.deepEqual(proxySc.historicalProxySummary.prCreatedToMerge, {
    p50: 30_000,
    p95: 30_000,
    sampleCount: 1,
    unknownCount: 1
  });

  // Mixing proxy row into autonomous scorecard fails closed
  const mixed1 = buildAiCreditAndAutonomyScorecard(makeBaseScorecardInput([
    {
      id: 'proxy-intruder',
      repositoryId: REPO_ID,
      cohort: 'm02-baseline',
      sourceKind: 'historical-proxy',
      observedMs: 12_000,
      metric: 'pr-created-to-merge',
      durationMs: 10_000
    }
  ]));
  assert.equal(mixed1.valid, false);
  assert.equal(mixed1.reason, 'SOURCE_KIND_MIXING_FORBIDDEN');

  // Mixing autonomous row into historical-proxy scorecard fails closed
  const mixed2 = buildAiCreditAndAutonomyScorecard({
    ...makeBaseScorecardInput([makeAutonomousRecord(1)]),
    sourceKind: 'historical-proxy'
  });
  assert.equal(mixed2.valid, false);
  assert.equal(mixed2.reason, 'SOURCE_KIND_MIXING_FORBIDDEN');

  // Unauthorized repository, repo/cohort mismatch, duplicate IDs, stale evidence, invalid inputs
  assert.equal(
    buildAiCreditAndAutonomyScorecard(makeBaseScorecardInput([], {repositoryId: 999})).reason,
    'UNAUTHORIZED_REPOSITORY'
  );
  assert.equal(
    buildAiCreditAndAutonomyScorecard(makeBaseScorecardInput([
      makeAutonomousRecord(1, {repositoryId: CONSUMER_REPO_ID})
    ])).reason,
    'REPOSITORY_OR_COHORT_MISMATCH'
  );
  assert.equal(
    buildAiCreditAndAutonomyScorecard(makeBaseScorecardInput([
      makeAutonomousRecord(1),
      makeAutonomousRecord(1)
    ])).reason,
    'DUPLICATE_RECORD'
  );
  assert.equal(
    buildAiCreditAndAutonomyScorecard(makeBaseScorecardInput([], {nowMs: 80_000, maxAgeMs: 5_000})).reason,
    'STALE_EVIDENCE'
  );
  assert.equal(
    buildAiCreditAndAutonomyScorecard(makeBaseScorecardInput([], {fromMs: 50_000, toMs: 10_000})).reason,
    'INVALID_WINDOW'
  );
  assert.equal(
    buildAiCreditAndAutonomyScorecard(makeBaseScorecardInput([], {cohort: 'BAD COHORT'})).reason,
    'INVALID_SCOPE'
  );
  assert.equal(
    buildAiCreditAndAutonomyScorecard(makeBaseScorecardInput([], {thresholds: {maxQueueP95Ms: 0}})).reason,
    'INVALID_THRESHOLDS'
  );
  assert.equal(
    buildAiCreditAndAutonomyScorecard(makeBaseScorecardInput([], {thresholds: null})).reason,
    'INVALID_THRESHOLDS'
  );
  assert.equal(
    buildAiCreditAndAutonomyScorecard(new Proxy(makeBaseScorecardInput([]), {})).reason,
    'INVALID_INPUT'
  );
  assert.equal(
    buildAiCreditAndAutonomyScorecard(makeBaseScorecardInput(new Proxy([], {}))).reason,
    'INVALID_RECORDS'
  );
  const sparseRecords = new Array(1);
  assert.equal(
    buildAiCreditAndAutonomyScorecard(makeBaseScorecardInput(sparseRecords)).reason,
    'INVALID_RECORDS'
  );

  // Invalid nested record payloads (proxy, non-enumerable, bad accounting, bad MAF, bad audit, bad proxy row)
  const nonEnumRow = makeAutonomousRecord(1);
  Object.defineProperty(nonEnumRow, 'accepted', {value: true, enumerable: false});
  assert.equal(buildAiCreditAndAutonomyScorecard(makeBaseScorecardInput([nonEnumRow])).reason, 'INVALID_RECORD');

  for (const badRow of [
    null,
    {...makeAutonomousRecord(1), sourceKind: 'bogus'},
    makeAutonomousRecord(1, {accounting: {status: 'bogus'}}),
    makeAutonomousRecord(1, {accounting: 'bad'}),
    makeAutonomousRecord(1, {maf: {supersteps: 0, checkpointResumes: 0, innerRepairIterations: 0}}),
    makeAutonomousRecord(1, {audit: {fullProvenance: true, killSwitchTripped: false, violations: ['UNKNOWN']}}),
    makeAutonomousRecord(1, {issueNumber: 0}),
    makeAutonomousRecord(1, {workUnitId: 'both-keys-forbidden'})
  ]) {
    assert.equal(buildAiCreditAndAutonomyScorecard(makeBaseScorecardInput([badRow])).reason, 'INVALID_RECORD');
  }

  const badWorkUnitId = makeAutonomousRecord(1, {workUnitId: 'bad id!'});
  delete badWorkUnitId.issueNumber;
  assert.equal(buildAiCreditAndAutonomyScorecard(makeBaseScorecardInput([badWorkUnitId])).reason, 'INVALID_RECORD');

  const missingAcceptedUnit = makeAutonomousRecord(1);
  delete missingAcceptedUnit.issueNumber;
  assert.equal(
    buildAiCreditAndAutonomyScorecard(makeBaseScorecardInput([missingAcceptedUnit])).reason,
    'MISSING_ACCEPTED_WORK_UNIT'
  );

  // Non-empty violations with killSwitchTripped: false is rejected as inconsistent
  const inconsistentAudit = makeAutonomousRecord(1, {
    audit: {fullProvenance: true, killSwitchTripped: false, violations: ['OUT_OF_LANE_EDIT']}
  });
  assert.equal(
    buildAiCreditAndAutonomyScorecard(makeBaseScorecardInput([inconsistentAudit])).reason,
    'INCONSISTENT_AUDIT_RECORD'
  );

  for (const badProxy of [
    null,
    {id: 'p1', sourceKind: 'bogus'},
    {
      id: 'p1',
      repositoryId: REPO_ID,
      cohort: 'm02-baseline',
      sourceKind: 'historical-proxy',
      observedMs: 12_000,
      metric: 'unknown-metric',
      durationMs: 100
    },
    {
      id: 'p1',
      repositoryId: CONSUMER_REPO_ID,
      cohort: 'm02-baseline',
      sourceKind: 'historical-proxy',
      observedMs: 12_000,
      metric: 'pr-created-to-merge',
      durationMs: 100
    }
  ]) {
    assert.equal(
      buildAiCreditAndAutonomyScorecard({...makeBaseScorecardInput([badProxy]), sourceKind: 'historical-proxy'}).valid,
      false
    );
  }
  const dupProxies = [
    {
      id: 'p1',
      repositoryId: REPO_ID,
      cohort: 'm02-baseline',
      sourceKind: 'historical-proxy',
      observedMs: 12_000,
      metric: 'pr-created-to-merge',
      durationMs: 100
    },
    {
      id: 'p1',
      repositoryId: REPO_ID,
      cohort: 'm02-baseline',
      sourceKind: 'historical-proxy',
      observedMs: 13_000,
      metric: 'pr-created-to-merge',
      durationMs: 200
    }
  ];
  assert.equal(
    buildAiCreditAndAutonomyScorecard({...makeBaseScorecardInput(dupProxies), sourceKind: 'historical-proxy'}).reason,
    'DUPLICATE_RECORD'
  );
});
