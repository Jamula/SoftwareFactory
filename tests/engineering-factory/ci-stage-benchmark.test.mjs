import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASPIRE_FAILURE_CATEGORIES,
  ASPIRE_STAGE_KEYS,
  BASELINE_CONSOLIDATION_CHECK_COUNT,
  CHECK_CONSOLIDATION_KINDS,
  FAST_FEEDBACK_STRETCH_MS,
  LANE_TARGET_MS,
  MANDATORY_CI_CHECK_CONTEXTS,
  MANDATORY_CONSOLIDATED_CHECK_GATES,
  MAX_AUTO_REPAIR_ATTEMPTS,
  PINNED_CI_TOOLCHAIN,
  STANDARD_CI_P50_TARGET_MS,
  TARGET_CONSOLIDATION_CHECK_COUNT,
  WINDOWS_ASPIRE_RUNTIME_PROVISIONAL_TARGET_MS,
  analyzeAspireRuntimeStages,
  buildExactInputCacheManifest,
  buildMafBoundedRepairHandoff,
  defaultSoftwareFactoryConsolidationProposal,
  evaluateCheckConsolidationParity,
  evaluateCiCriticalPath
} from '../../tools/engineering-factory/ci-stage-benchmark.mjs';
import {defaultSoftwareFactoryTestInventory} from '../../tools/engineering-factory/contract-routing.mjs';
import {hashLockedContent} from '../../tools/engineering-factory/locked-build-cache.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const SHA_D = 'd'.repeat(40);
const SHA_E = 'e'.repeat(40);
const SHA_F = 'f'.repeat(40);

function makePassingChecks(headSha, eventAtMs = 1_000, timings = {}) {
  const {
    linuxBuildEnd = 52_000,
    coverageQueued = 24_000,
    coverageStart = 25_500,
    coverageEnd = 31_000,
    linuxStart = 3_000,
    windowsStart = 5_000,
    windowsEnd = 62_000,
    securityStart = 4_000,
    securityEnd = 58_000
  } = timings;
  return [
    {
      context: 'build-test',
      lane: 'linux',
      headSha,
      conclusion: 'success',
      queuedAtMs: eventAtMs,
      startedAtMs: eventAtMs + linuxStart,
      completedAtMs: eventAtMs + linuxBuildEnd
    },
    {
      context: 'upload-coverage-javascript',
      lane: 'linux',
      headSha,
      conclusion: 'success',
      queuedAtMs: eventAtMs + coverageQueued,
      startedAtMs: eventAtMs + coverageStart,
      completedAtMs: eventAtMs + coverageEnd
    },
    {
      context: 'windows-aspire-runtime',
      lane: 'windows',
      headSha,
      conclusion: 'success',
      queuedAtMs: eventAtMs,
      startedAtMs: eventAtMs + windowsStart,
      completedAtMs: eventAtMs + windowsEnd
    },
    {
      context: 'CodeQL',
      lane: 'security',
      headSha,
      conclusion: 'success',
      queuedAtMs: eventAtMs,
      startedAtMs: eventAtMs + securityStart,
      completedAtMs: eventAtMs + securityEnd
    }
  ];
}

test('exported SLO constants and mandatory gate contracts match engineering standards', () => {
  assert.equal(STANDARD_CI_P50_TARGET_MS, 75_000);
  assert.equal(FAST_FEEDBACK_STRETCH_MS, 30_000);
  assert.equal(LANE_TARGET_MS, 65_000);
  assert.equal(WINDOWS_ASPIRE_RUNTIME_PROVISIONAL_TARGET_MS, 120_000);
  assert.equal(MAX_AUTO_REPAIR_ATTEMPTS, 2);
  assert.deepEqual(MANDATORY_CI_CHECK_CONTEXTS, [
    'build-test',
    'upload-coverage-javascript',
    'windows-aspire-runtime',
    'CodeQL'
  ]);
  assert.equal(BASELINE_CONSOLIDATION_CHECK_COUNT, 12);
  assert.equal(TARGET_CONSOLIDATION_CHECK_COUNT, 8);
  assert.deepEqual(CHECK_CONSOLIDATION_KINDS, [
    'required-execution',
    'reporting',
    'disabled-shadow-inventory'
  ]);
  assert.deepEqual(MANDATORY_CONSOLIDATED_CHECK_GATES, [
    'build-test',
    'upload-coverage-javascript',
    'windows-aspire-runtime',
    '.NET MAF specialist agents',
    'CodeQL'
  ]);
  assert.equal(ASPIRE_STAGE_KEYS.length, 8);
  assert.equal(ASPIRE_FAILURE_CATEGORIES.length, 8);
  assert.deepEqual(PINNED_CI_TOOLCHAIN, {
    node: '26.13.1',
    dotnet: '10.0.404',
    aspireCli: '17.0.0'
  });
});

test('evaluateCiCriticalPath computes max(endMs) - eventAtMs across parallel lanes, separates cold/warm cohorts, and never treats <75s as a timeout or gate waiver', () => {
  const runs = [
    {
      runId: 'warm-fast-1',
      headSha: SHA_A,
      cacheCohort: 'warm',
      eventAtMs: 1_000,
      independentReviewAtMs: 1_000 + 95_000,
      independentReviewHeadSha: SHA_A,
      checks: [
        ...makePassingChecks(SHA_A, 1_000, {
          linuxStart: 2_000,
          linuxBuildEnd: 26_000,
          coverageQueued: 18_000,
          coverageStart: 19_000,
          coverageEnd: 24_000,
          windowsStart: 3_000,
          windowsEnd: 29_000,
          securityStart: 2_500,
          securityEnd: 28_000
        }),
        {
          context: 'optional-advisory',
          lane: 'linux',
          headSha: SHA_A,
          conclusion: 'skipped',
          queuedAtMs: 1_000,
          startedAtMs: null,
          completedAtMs: null
        }
      ]
    },
    {
      runId: 'warm-pass-2',
      headSha: SHA_B,
      cacheCohort: 'warm',
      eventAtMs: 10_000,
      independentReviewAtMs: 10_000 + 80_000,
      independentReviewHeadSha: SHA_A, // stale review head -> ignored for independentReviewMs
      checks: makePassingChecks(SHA_B, 10_000, {
        linuxStart: 2_000,
        linuxBuildEnd: 52_000,
        windowsStart: 6_000,
        windowsEnd: 63_000,
        securityStart: 3_000,
        securityEnd: 59_000
      })
    },
    {
      runId: 'cold-boundary-miss-75s',
      headSha: SHA_C,
      cacheCohort: 'cold',
      eventAtMs: 0,
      independentReviewAtMs: null,
      checks: makePassingChecks(SHA_C, 0, {
        linuxStart: 4_000,
        linuxBuildEnd: 68_000, // exceeds 65s lane target
        windowsStart: 7_000,
        windowsEnd: 75_000, // exact 75_000ms misses strict <75_000ms SLO!
        securityStart: 3_000,
        securityEnd: 61_000
      })
    },
    {
      runId: 'cold-failed-1',
      headSha: SHA_D,
      cacheCohort: 'cold',
      eventAtMs: 5_000,
      attempt: 1,
      checks: [
        ...makePassingChecks(SHA_D, 5_000).slice(0, 3),
        {
          context: 'CodeQL',
          lane: 'security',
          headSha: SHA_D,
          conclusion: 'cancelled',
          queuedAtMs: 5_000,
          startedAtMs: 7_000,
          completedAtMs: 25_000
        }
      ]
    },
    {
      runId: 'warm-retry-sha-d',
      headSha: SHA_D, // same-head retry after cold-failed-1
      cacheCohort: 'warm',
      eventAtMs: 50_000,
      attempt: 2,
      checks: makePassingChecks(SHA_D, 50_000, {
        linuxStart: 2_000,
        linuxBuildEnd: 48_000,
        windowsStart: 4_000,
        windowsEnd: 55_000,
        securityStart: 3_000,
        securityEnd: 50_000
      })
    },
    {
      runId: 'cold-missing-mandatory',
      headSha: SHA_E,
      cacheCohort: 'cold',
      eventAtMs: 0,
      attempt: 3, // standalone attempt=3 -> 2 prior same-head retries
      checks: makePassingChecks(SHA_E, 0).slice(0, 3) // missing CodeQL
    },
    {
      runId: 'warm-head-mismatch',
      headSha: SHA_F,
      cacheCohort: 'warm',
      eventAtMs: 0,
      checks: [
        ...makePassingChecks(SHA_F, 0).slice(0, 3),
        {
          context: 'CodeQL',
          lane: 'security',
          headSha: SHA_A, // wrong headSha -> ineligible
          conclusion: 'success',
          queuedAtMs: 0,
          startedAtMs: 2_000,
          completedAtMs: 40_000
        }
      ]
    }
  ];

  const report = evaluateCiCriticalPath(runs);
  assert.equal(report.valid, true);
  assert.equal(report.reason, 'CI_CRITICAL_PATH_EVALUATED');
  assert.equal(report.sloIsTimeoutOrGateWaiver, false);
  assert.equal(report.fullVerificationRequired, true);
  assert.equal(report.skipRequiredChecks, false);

  // Parallel sum on warm-fast-1 would be 26k + 29k + 28k = 83k; max(end) - eventAtMs is 29_000ms!
  const warmFast = report.runs[0];
  assert.equal(warmFast.eligibleSample, true);
  assert.equal(warmFast.eventToLastRequiredCheckMs, 29_000);
  assert.equal(warmFast.firstJobStartToLastCheckMs, 27_000);
  assert.equal(warmFast.runnerQueueWaitMs, 3_000);
  assert.equal(warmFast.independentReviewMs, 95_000);
  assert.equal(warmFast.mergeReadinessCriticalPathMs, 95_000);
  assert.equal(warmFast.meetsStandardSlo, true);
  assert.equal(warmFast.meetsFastFeedbackStretch, true);

  // Stale review head on warm-pass-2 yields independentReviewMs: null
  const warmPass2 = report.runs[1];
  assert.equal(warmPass2.eventToLastRequiredCheckMs, 63_000);
  assert.equal(warmPass2.independentReviewMs, null);
  assert.equal(warmPass2.mergeReadinessCriticalPathMs, null);

  // Exact 75_000ms run is still an eligible sample (never waived or timed out!) and increments sloMissCount
  const coldSlow = report.runs[2];
  assert.equal(coldSlow.eligibleSample, true);
  assert.equal(coldSlow.gateWaived, false);
  assert.equal(coldSlow.cancelledBySlo, false);
  assert.equal(coldSlow.eventToLastRequiredCheckMs, 75_000);
  assert.equal(coldSlow.meetsStandardSlo, false);
  assert.equal(coldSlow.lanes.linux.meetsTarget, false);
  assert.equal(coldSlow.lanes.windows.meetsTarget, false);
  assert.equal(coldSlow.lanes.security.meetsTarget, true);

  // Cohort separation: warm has 3 eligible (29_000, 55_000, 63_000), cold has 1 eligible (75_000)
  assert.equal(report.sampleCount, 4);
  assert.equal(report.p50Ms, 55_000);
  assert.equal(report.p95Ms, 75_000);
  assert.equal(report.p50MeetsStandardTarget, true);
  assert.equal(report.p50MeetsStretchTarget, false);
  assert.equal(report.sloMissCount, 1);
  assert.equal(report.failedOrCancelledCount, 1);
  assert.equal(report.incompleteOrMismatchedCount, 2);
  assert.equal(report.sameHeadRetryCount, 3); // 1 on SHA_D + 2 on SHA_E (1 cold + 1 unattributed)
  assert.equal(report.unattributedRetryCount, 1);
  assert.equal(report.missingAttemptCount, 2);
  assert.equal(report.incompleteAttemptHistory, true);

  assert.equal(report.cohorts.warm.sampleCount, 3);
  assert.equal(report.cohorts.warm.p50Ms, 55_000);
  assert.equal(report.cohorts.warm.p95Ms, 63_000);
  assert.equal(report.cohorts.warm.p50MeetsStandardTarget, true);
  assert.equal(report.cohorts.warm.sloMissCount, 0);
  assert.equal(report.cohorts.warm.sameHeadRetryCount, 1);
  assert.equal(report.cohorts.warm.independentReviewMs.sampleCount, 1);
  assert.equal(report.cohorts.warm.independentReviewMs.p50Ms, 95_000);

  assert.equal(report.cohorts.cold.sampleCount, 1);
  assert.equal(report.cohorts.cold.p50Ms, 75_000);
  assert.equal(report.cohorts.cold.p50MeetsStandardTarget, false);
  assert.equal(report.cohorts.cold.sloMissCount, 1);
  assert.equal(report.cohorts.cold.failedOrCancelledCount, 1);
  assert.equal(report.cohorts.cold.incompleteOrMismatchedCount, 1);
  assert.equal(report.cohorts.cold.sameHeadRetryCount, 1);
  assert.equal(report.cohorts.cold.lanes.linux.targetMissCount, 1);
  assert.equal(report.cohorts.cold.lanes.windows.targetMissCount, 1);
  assert.equal(report.cohorts.cold.lanes.security.targetMissCount, 0);
});

test('evaluateCiCriticalPath isolates required-check critical path from slow optional checks, requires explicit independentReviewHeadSha, and aggregates same-head attempts order-invariantly', () => {
  // 1 & 3: Mandatory checks finish at 30s while slow optional advisory finishes at 120s;
  // independentReviewAtMs without independentReviewHeadSha stays null (unknown head).
  const optionalSlowReport = evaluateCiCriticalPath([
    {
      runId: 'warm-30s-required-120s-optional',
      headSha: SHA_A,
      cacheCohort: 'warm',
      eventAtMs: 0,
      independentReviewAtMs: 45_000, // missing independentReviewHeadSha -> must NOT be credited
      checks: [
        ...makePassingChecks(SHA_A, 0, {
          linuxStart: 1_000,
          linuxBuildEnd: 28_000,
          coverageQueued: 15_000,
          coverageStart: 16_000,
          coverageEnd: 22_000,
          windowsStart: 2_000,
          windowsEnd: 30_000,
          securityStart: 1_500,
          securityEnd: 27_000
        }),
        {
          context: 'slow-optional-benchmark',
          lane: 'windows',
          headSha: SHA_A,
          conclusion: 'success',
          queuedAtMs: 10_000,
          startedAtMs: 25_000,
          completedAtMs: 120_000
        }
      ]
    },
    {
      runId: 'warm-null-review-head',
      headSha: SHA_B,
      cacheCohort: 'warm',
      eventAtMs: 0,
      independentReviewAtMs: 40_000,
      independentReviewHeadSha: null, // explicit null review head -> unknown
      checks: makePassingChecks(SHA_B, 0, {
        linuxStart: 1_000,
        linuxBuildEnd: 25_000,
        coverageQueued: 12_000,
        coverageStart: 13_000,
        coverageEnd: 20_000,
        windowsStart: 2_000,
        windowsEnd: 29_000,
        securityStart: 1_500,
        securityEnd: 26_000
      })
    }
  ]);

  assert.equal(optionalSlowReport.valid, true);
  assert.equal(optionalSlowReport.sampleCount, 2);
  assert.equal(optionalSlowReport.p50Ms, 29_000);
  assert.equal(optionalSlowReport.p95Ms, 30_000);
  assert.equal(optionalSlowReport.sloMissCount, 0);
  assert.equal(optionalSlowReport.p50MeetsStandardTarget, true);
  assert.equal(optionalSlowReport.p50MeetsStretchTarget, true);
  assert.equal(optionalSlowReport.independentReviewMs.sampleCount, 0);
  assert.equal(optionalSlowReport.independentReviewMs.p50Ms, null);

  const firstRun = optionalSlowReport.runs[0];
  assert.equal(firstRun.eventToLastRequiredCheckMs, 30_000);
  assert.equal(firstRun.allObservedChecksDurationMs, 120_000);
  assert.equal(firstRun.firstJobStartToLastCheckMs, 29_000);
  assert.equal(firstRun.runnerQueueWaitMs, 2_000);
  assert.equal(firstRun.lanes.windows.durationMs, 30_000);
  assert.equal(firstRun.meetsStandardSlo, true);
  assert.equal(firstRun.meetsFastFeedbackStretch, true);
  assert.equal(firstRun.independentReviewMs, null);
  assert.equal(firstRun.mergeReadinessCriticalPathMs, null);
  assert.equal(optionalSlowReport.runs[1].independentReviewMs, null);

  // Prerequisite validation job (test-coverage at 1_000ms) sets firstJobStartMs while
  // required checks starting >=20_000ms set lastRequiredCheckEndMs (70_000ms -> 69_000ms span)
  // and a 120_000ms optional check stays isolated in allObservedChecksDurationMs.
  const prerequisiteReport = evaluateCiCriticalPath([
    {
      runId: 'prerequisite-and-optional-run',
      headSha: SHA_C,
      cacheCohort: 'warm',
      eventAtMs: 0,
      checks: [
        {
          context: 'test-coverage',
          lane: 'linux',
          headSha: SHA_C,
          conclusion: 'success',
          queuedAtMs: 0,
          startedAtMs: 1_000,
          completedAtMs: 19_000
        },
        {
          context: 'build-test',
          lane: 'linux',
          headSha: SHA_C,
          conclusion: 'success',
          queuedAtMs: 19_000,
          startedAtMs: 20_000,
          completedAtMs: 22_000
        },
        {
          context: 'upload-coverage-javascript',
          lane: 'linux',
          headSha: SHA_C,
          conclusion: 'success',
          queuedAtMs: 19_000,
          startedAtMs: 20_500,
          completedAtMs: 25_000
        },
        {
          context: 'windows-aspire-runtime',
          lane: 'windows',
          headSha: SHA_C,
          conclusion: 'success',
          queuedAtMs: 18_000,
          startedAtMs: 21_000,
          completedAtMs: 70_000
        },
        {
          context: 'CodeQL',
          lane: 'security',
          headSha: SHA_C,
          conclusion: 'success',
          queuedAtMs: 19_000,
          startedAtMs: 20_000,
          completedAtMs: 64_000
        },
        {
          context: 'optional-advisory-suite',
          lane: 'linux',
          headSha: SHA_C,
          conclusion: 'success',
          queuedAtMs: 10_000,
          startedAtMs: 30_000,
          completedAtMs: 120_000
        }
      ]
    }
  ]);
  assert.equal(prerequisiteReport.valid, true);
  assert.equal(prerequisiteReport.sloMissCount, 0);
  assert.equal(prerequisiteReport.runs[0].eventToLastRequiredCheckMs, 70_000);
  assert.equal(prerequisiteReport.runs[0].firstJobStartToLastCheckMs, 69_000);
  assert.equal(prerequisiteReport.runs[0].runnerQueueWaitMs, 3_000);
  assert.equal(prerequisiteReport.runs[0].allObservedChecksDurationMs, 120_000);

  // Custom stricter policy requiredCheckContexts includes extra required context in critical path
  const customRequired = evaluateCiCriticalPath(
    [
      {
        runId: 'custom-policy-run',
        headSha: SHA_A,
        cacheCohort: 'warm',
        eventAtMs: 0,
        checks: [
          ...makePassingChecks(SHA_A, 0, {
            linuxBuildEnd: 28_000,
            windowsEnd: 30_000,
            securityEnd: 27_000
          }),
          {
            context: 'consumer-e2e',
            lane: 'linux',
            headSha: SHA_A,
            conclusion: 'success',
            queuedAtMs: 0,
            startedAtMs: 2_000,
            completedAtMs: 80_000
          }
        ]
      }
    ],
    [...MANDATORY_CI_CHECK_CONTEXTS, 'consumer-e2e']
  );
  assert.equal(customRequired.valid, true);
  assert.equal(customRequired.p50Ms, 80_000);
  assert.equal(customRequired.sloMissCount, 1);

  for (const badRequired of [
    null,
    ['build-test', 'upload-coverage-javascript', 'windows-aspire-runtime'], // missing CodeQL
    [...MANDATORY_CI_CHECK_CONTEXTS, 'CodeQL'], // duplicate
    [...MANDATORY_CI_CHECK_CONTEXTS, '']
  ]) {
    assert.equal(evaluateCiCriticalPath([
      {
        runId: 'r1',
        headSha: SHA_A,
        cacheCohort: 'warm',
        eventAtMs: 0,
        checks: makePassingChecks(SHA_A, 0)
      }
    ], badRequired).reason, 'REQUIRED_CONTEXTS_INVALID');
  }

  // 4: Order-invariant per-head retry aggregation on incomplete [1, 3] vs [3, 1] and tied attempts
  const attempt1Cold = {
    runId: 'head-d-attempt-1',
    headSha: SHA_D,
    cacheCohort: 'cold',
    eventAtMs: 1_000,
    attempt: 1,
    checks: [
      ...makePassingChecks(SHA_D, 1_000).slice(0, 3),
      {
        context: 'CodeQL',
        lane: 'security',
        headSha: SHA_D,
        conclusion: 'timed_out',
        queuedAtMs: 1_000,
        startedAtMs: 2_000,
        completedAtMs: 60_000
      }
    ]
  };
  const attempt3Warm = {
    runId: 'head-d-attempt-3',
    headSha: SHA_D,
    cacheCohort: 'warm',
    eventAtMs: 90_000,
    attempt: 3,
    checks: makePassingChecks(SHA_D, 90_000, {
      linuxBuildEnd: 40_000,
      windowsEnd: 48_000,
      securityEnd: 44_000
    })
  };
  // Locale-independent UTF-16 code-unit tie-breaker ('I' = 0x0049 < 'i' = 0x0069 across en-US, tr-TR, etc.)
  const sameTimestampA = {
    runId: 'I',
    headSha: SHA_E,
    cacheCohort: 'cold',
    eventAtMs: 5_000,
    checks: makePassingChecks(SHA_E, 5_000, {windowsEnd: 50_000})
  };
  const sameTimestampB = {
    runId: 'i',
    headSha: SHA_E,
    cacheCohort: 'warm',
    eventAtMs: 5_000,
    checks: makePassingChecks(SHA_E, 5_000, {windowsEnd: 42_000})
  };
  const diffTimestampA = {
    runId: 'head-f-early',
    headSha: SHA_F,
    cacheCohort: 'cold',
    eventAtMs: 2_000,
    checks: makePassingChecks(SHA_F, 2_000, {windowsEnd: 52_000})
  };
  const diffTimestampB = {
    runId: 'head-f-late',
    headSha: SHA_F,
    cacheCohort: 'warm',
    eventAtMs: 8_000,
    checks: makePassingChecks(SHA_F, 8_000, {windowsEnd: 45_000})
  };

  const forward = evaluateCiCriticalPath([
    attempt1Cold, attempt3Warm, sameTimestampA, sameTimestampB, diffTimestampA, diffTimestampB
  ]);
  const reversed = evaluateCiCriticalPath([
    diffTimestampB, diffTimestampA, sameTimestampB, sameTimestampA, attempt3Warm, attempt1Cold
  ]);

  assert.equal(forward.sameHeadRetryCount, 4); // 2 on SHA_D + 1 on SHA_E + 1 on SHA_F
  assert.equal(forward.unattributedRetryCount, 1); // missing attempt 2 on SHA_D
  assert.equal(forward.missingAttemptCount, 1);
  assert.equal(forward.incompleteAttemptHistory, true);
  assert.equal(forward.cohorts.cold.sameHeadRetryCount, 0); // initial attempts never miscounted as retries
  assert.equal(forward.cohorts.warm.sameHeadRetryCount, 3);

  assert.equal(reversed.sameHeadRetryCount, forward.sameHeadRetryCount);
  assert.equal(reversed.unattributedRetryCount, forward.unattributedRetryCount);
  assert.equal(reversed.missingAttemptCount, forward.missingAttemptCount);
  assert.equal(reversed.incompleteAttemptHistory, forward.incompleteAttemptHistory);
  assert.deepEqual(reversed.cohorts, forward.cohorts);
  assert.equal(reversed.p50Ms, forward.p50Ms);
  assert.equal(reversed.p95Ms, forward.p95Ms);

  const forwardById = new Map(forward.runs.map(r => [r.runId, r]));
  const reversedById = new Map(reversed.runs.map(r => [r.runId, r]));
  for (const id of forwardById.keys()) {
    assert.deepEqual(reversedById.get(id), forwardById.get(id));
  }
});

test('evaluateCiCriticalPath fails closed on proxies, non-plain objects, non-data descriptors, duplicates, and malformed checks', () => {
  const validRun = {
    runId: 'run-1',
    headSha: SHA_A,
    cacheCohort: 'warm',
    eventAtMs: 1_000,
    checks: makePassingChecks(SHA_A, 1_000)
  };
  const proxyArray = new Proxy([validRun], {
    get() {
      throw new Error('proxy trap must not execute');
    }
  });
  const proxyRun = new Proxy(validRun, {
    get() {
      throw new Error('proxy trap must not execute');
    }
  });
  const getterRun = {...validRun};
  Object.defineProperty(getterRun, 'headSha', {
    enumerable: true,
    get() {
      throw new Error('getter must not execute');
    }
  });
  const hiddenPropRun = {...validRun};
  Object.defineProperty(hiddenPropRun, 'hidden', {value: 1, enumerable: false});
  const symbolRun = {...validRun, [Symbol('extra')]: true};
  const nonEnumArrayItem = [validRun];
  Object.defineProperty(nonEnumArrayItem, '0', {value: validRun, enumerable: false});
  const extraArrayKey = [validRun];
  extraArrayKey.extra = true;

  for (const badRuns of [
    null,
    {},
    [],
    proxyArray,
    new Array(1),
    nonEnumArrayItem,
    extraArrayKey,
    Object.setPrototypeOf([validRun], {})
  ]) {
    const res = evaluateCiCriticalPath(badRuns);
    assert.equal(res.valid, false);
    assert.equal(res.reason, 'RUNS_INVALID');
    assert.equal(res.sloIsTimeoutOrGateWaiver, false);
  }

  for (const badRun of [
    null,
    [],
    proxyRun,
    Object.create(validRun),
    getterRun,
    hiddenPropRun,
    symbolRun,
    {...validRun, extraKey: 'forbidden'},
    {...validRun, attempt: undefined},
    {...validRun, runId: 'bad id!'},
    {...validRun, headSha: 'bad'},
    {...validRun, cacheCohort: 'lukewarm'},
    {...validRun, eventAtMs: -1},
    {...validRun, attempt: 0},
    {...validRun, attempt: 21},
    {...validRun, independentReviewAtMs: 500}, // before eventAtMs
    {...validRun, independentReviewAtMs: '2000'},
    {...validRun, independentReviewHeadSha: SHA_A}, // head without timestamp
    {...validRun, independentReviewAtMs: 2_000, independentReviewHeadSha: 'bad'},
    {...validRun, checks: []},
    {
      ...validRun,
      checks: [{...makePassingChecks(SHA_A, 1_000)[0], queuedAtMs: 500}] // queued before eventAtMs
    },
    {
      ...validRun,
      checks: [{...makePassingChecks(SHA_A, 1_000)[0], startedAtMs: null, completedAtMs: null}] // success cannot have null start
    },
    {
      ...validRun,
      checks: [{...makePassingChecks(SHA_A, 1_000)[0], completedAtMs: 2_000}] // completed before started
    },
    {
      ...validRun,
      checks: [{
        ...makePassingChecks(SHA_A, 1_000)[0],
        conclusion: 'cancelled',
        startedAtMs: 4_000,
        completedAtMs: 3_000 // completed before started on non-success
      }]
    },
    {
      ...validRun,
      checks: [{
        ...makePassingChecks(SHA_A, 1_000)[0],
        conclusion: 'cancelled',
        startedAtMs: 4_000,
        completedAtMs: null // half-null timestamps
      }]
    }
  ]) {
    assert.equal(evaluateCiCriticalPath([badRun]).reason, 'INVALID_RUN');
  }

  assert.equal(
    evaluateCiCriticalPath([validRun, {...validRun, headSha: SHA_B}]).reason,
    'DUPLICATE_RUN_ID'
  );
  assert.equal(
    evaluateCiCriticalPath([{
      ...validRun,
      checks: [{...makePassingChecks(SHA_A, 1_000)[0], lane: 'windows'}]
    }]).reason,
    'INVALID_CHECK_LANE'
  );
  assert.equal(
    evaluateCiCriticalPath([{
      ...validRun,
      checks: [makePassingChecks(SHA_A, 1_000)[0], makePassingChecks(SHA_A, 1_000)[0]]
    }]).reason,
    'DUPLICATE_CHECK_CONTEXT'
  );
});

test('analyzeAspireRuntimeStages decomposes Linux/Windows stages, flags dominant bottleneck, checks <120s Windows target, and classifies all 8 failure categories without raw logs', () => {
  const baseWin = {
    platform: 'windows',
    headSha: SHA_A,
    runnerEnvironment: 'github-hosted',
    outcome: 'succeeded',
    queueWaitMs: 6_000,
    setupMs: 8_000,
    restoreBuildMs: 44_000,
    certificateExportMs: 3_000,
    appHostStartupMs: 21_000,
    syntheticWorkloadMs: 9_000,
    exportVerifyMs: 7_000,
    stopCleanupMs: 4_000
  };

  const winOk = analyzeAspireRuntimeStages(baseWin);
  assert.equal(winOk.valid, true);
  assert.equal(winOk.reason, 'ASPIRE_RUNTIME_STAGES_ANALYZED');
  assert.equal(winOk.queueWaitMs, 6_000);
  assert.equal(winOk.runtimeExecutionMs, 96_000);
  assert.equal(winOk.totalWallMs, 102_000);
  assert.equal(winOk.dominantStage, 'restoreBuildMs');
  assert.equal(winOk.dominantStageMs, 44_000);
  assert.equal(winOk.meetsWindowsProvisionalTarget, true);
  assert.equal(winOk.meetsLaneTarget, false);
  assert.equal(winOk.failureCategory, null);
  assert.equal(winOk.tlsVerificationRequired, true);

  // Provisional target is strict < 120_000ms on runtimeExecutionMs (queueWaitMs excluded from runtimeExecutionMs)
  const winExact120s = analyzeAspireRuntimeStages({
    ...baseWin,
    restoreBuildMs: 68_000 // runtimeExecutionMs becomes exact 120_000ms
  });
  assert.equal(winExact120s.runtimeExecutionMs, 120_000);
  assert.equal(winExact120s.meetsWindowsProvisionalTarget, false);

  const linuxFast = analyzeAspireRuntimeStages({
    ...baseWin,
    platform: 'linux',
    queueWaitMs: 2_000,
    setupMs: 5_000,
    restoreBuildMs: 14_000,
    certificateExportMs: 1_000,
    appHostStartupMs: 16_000,
    syntheticWorkloadMs: 6_000,
    exportVerifyMs: 4_000,
    stopCleanupMs: 2_000
  });
  assert.equal(linuxFast.meetsWindowsProvisionalTarget, null);
  assert.equal(linuxFast.meetsLaneTarget, true);
  assert.equal(linuxFast.dominantStage, 'appHostStartupMs');
  assert.equal(linuxFast.dominantStageMs, 16_000);

  // Verify all 8 sanitized failure categories via bounded failureCode and stage-based fallback
  const codeCases = [
    ['tls-or-certificate', 'tls-or-certificate'],
    ['dashboard-401', 'authentication'],
    ['invalid-cli-option', 'arguments'],
    ['sharing-violation', 'file-access'],
    ['apphost-start-timeout', 'startup-timeout'],
    ['nuget-restore-failed', 'restore-build'],
    ['metric-receipt-missing', 'export-receipt'],
    ['unclassified', 'unclassified']
  ];
  for (const [failureCode, expectedCategory] of codeCases) {
    const res = analyzeAspireRuntimeStages({
      ...baseWin,
      outcome: 'failed',
      syntheticWorkloadMs: null,
      exportVerifyMs: null,
      failureCode
    });
    assert.equal(res.valid, true);
    assert.equal(res.failureCategory, expectedCategory);
    assert.equal(res.meetsWindowsProvisionalTarget, false);
    assert.equal(res.meetsLaneTarget, false);
  }

  // Stage-inferred categories when failureCode is omitted/null, plus cancelled-in-queue (all active stages null)
  const inferredCases = [
    [{outcome: 'failed', failedStage: 'certificateExportMs', failureCode: null}, 'tls-or-certificate'],
    [{outcome: 'timed-out', failedStage: 'appHostStartupMs'}, 'startup-timeout'],
    [{outcome: 'failed', failedStage: 'restoreBuildMs'}, 'restore-build'],
    [{outcome: 'failed', failedStage: 'exportVerifyMs'}, 'export-receipt'],
    [{outcome: 'cancelled', failedStage: 'setupMs'}, 'unclassified']
  ];
  for (const [overrides, expectedCategory] of inferredCases) {
    const res = analyzeAspireRuntimeStages({...baseWin, ...overrides});
    assert.equal(res.failureCategory, expectedCategory);
  }

  const cancelledInQueue = analyzeAspireRuntimeStages({
    platform: 'windows',
    headSha: SHA_A,
    runnerEnvironment: 'github-hosted',
    outcome: 'cancelled',
    queueWaitMs: 15_000,
    setupMs: null,
    restoreBuildMs: null,
    certificateExportMs: null,
    appHostStartupMs: null,
    syntheticWorkloadMs: null,
    exportVerifyMs: null,
    stopCleanupMs: null
  });
  assert.equal(cancelledInQueue.valid, true);
  assert.equal(cancelledInQueue.dominantStage, null);
  assert.equal(cancelledInQueue.dominantStageMs, null);
  assert.equal(cancelledInQueue.runtimeExecutionMs, 0);
  assert.equal(cancelledInQueue.failureCategory, 'unclassified');

  // Reject raw logs, tokens, URLs, PEM blocks, self-hosted runners, and contradictory outcomes
  for (const secretOrRawLog of [
    'https://127.0.0.1:18888/login?t=secret-token',
    '-----BEGIN CERTIFICATE-----',
    'Error: SSL trust chain failed',
    'unknown-custom-code'
  ]) {
    const rejected = analyzeAspireRuntimeStages({
      ...baseWin,
      outcome: 'failed',
      failureCode: secretOrRawLog
    });
    assert.equal(rejected.valid, false);
    assert.equal(rejected.reason, 'UNSAFE_DIAGNOSTIC_REJECTED');
    assert.equal(JSON.stringify(rejected).includes(secretOrRawLog), false);
  }

  assert.equal(
    analyzeAspireRuntimeStages({...baseWin, runnerEnvironment: 'self-hosted'}).reason,
    'UNSUPPORTED_RUNNER_ENVIRONMENT'
  );
  assert.equal(
    analyzeAspireRuntimeStages({...baseWin, failureCode: 'arguments'}).reason,
    'CONTRADICTORY_OUTCOME'
  );
  assert.equal(
    analyzeAspireRuntimeStages({...baseWin, failedStage: 'setupMs'}).reason,
    'CONTRADICTORY_OUTCOME'
  );

  for (const invalidSample of [
    null,
    [],
    new Proxy(baseWin, {get() { throw new Error('must not run'); }}),
    {...baseWin, rawLogs: 'secret output'},
    {...baseWin, platform: 'darwin'},
    {...baseWin, headSha: 'bad'},
    {...baseWin, outcome: 'unknown'},
    {...baseWin, queueWaitMs: -1},
    {...baseWin, setupMs: null}, // succeeded cannot have null active stage
    {...baseWin, outcome: 'failed', setupMs: -5},
    {...baseWin, outcome: 'failed', setupMs: 3_600_001},
    {...baseWin, outcome: 'failed', failedStage: 'queueWaitMs'}
  ]) {
    assert.equal(analyzeAspireRuntimeStages(invalidSample).reason, 'STAGE_SAMPLE_INVALID');
  }
});

function makeManifestInput(overrides = {}) {
  return {
    repositoryId: 1471342715,
    repository: 'Jamula/SoftwareFactory',
    trustedSource: true,
    isFork: false,
    branchProtected: false,
    os: 'linux',
    arch: 'x64',
    toolchain: {
      node: '26.13.1',
      dotnet: '10.0.404',
      aspireCli: '17.0.0'
    },
    packageJsonSha256: hashLockedContent('{"name":"softwarefactory","private":true}'),
    packageLockSha256: hashLockedContent('{"name":"softwarefactory","lockfileVersion":3}'),
    globalJsonSha256: hashLockedContent('{"sdk":{"version":"10.0.404","rollForward":"disable"}}'),
    appHostSha256: hashLockedContent('#:package Aspire.Hosting.AppHost@17.0.0'),
    ...overrides
  };
}

test('buildExactInputCacheManifest derives deterministic SHA-256 keys, enforces fork/protected write isolation, and invalidates reuse fail-closed on any digest mismatch', () => {
  const linuxPr = buildExactInputCacheManifest(makeManifestInput());
  const winMain = buildExactInputCacheManifest(makeManifestInput({
    os: 'windows',
    branchProtected: true,
    nugetLockSha256: '4'.repeat(64),
    packageJsonSha256: hashLockedContent('{"name":"softwarefactory","private":true}')
  }));
  const win32Alias = buildExactInputCacheManifest(makeManifestInput({
    os: 'win32',
    branchProtected: true,
    nugetLockSha256: '4'.repeat(64),
    packageJsonSha256: hashLockedContent('{"name":"softwarefactory","private":true}')
  }));

  assert.equal(linuxPr.valid, true);
  assert.equal(linuxPr.reason, 'EXACT_CACHE_MANIFEST_BUILT');
  assert.equal(linuxPr.rid, 'linux-x64');
  assert.equal(linuxPr.allowProtectedCacheWrite, false); // PR branch cannot write to protected scope
  assert.equal(linuxPr.fullVerificationRequired, true);
  assert.equal(linuxPr.skipRequiredChecks, false);
  assert.match(linuxPr.keys.npm, /^sf-npm-v1-linux-x64-node-26\.13\.1-[a-f0-9]{64}$/);
  assert.match(linuxPr.keys.nuget, /^sf-nuget-v1-linux-x64-dotnet-10\.0\.404-release-[a-f0-9]{64}$/);
  assert.match(linuxPr.keys['aspire-cli'], /^sf-aspire-cli-v1-linux-x64-aspire-17\.0\.0-[a-f0-9]{64}$/);
  assert.equal(linuxPr.entries.nuget.nugetLockBound, false);

  assert.equal(winMain.valid, true);
  assert.equal(winMain.rid, 'win-x64');
  assert.equal(winMain.allowProtectedCacheWrite, true); // non-fork protected branch allowed
  assert.equal(winMain.entries.nuget.nugetLockBound, true);
  assert.deepEqual(winMain, win32Alias);

  // Every input digest rotation (including package.json-only with identical lockfile) changes its exact target key
  const manifestOnlyChanged = buildExactInputCacheManifest(
    makeManifestInput({packageJsonSha256: '7'.repeat(64)})
  );
  assert.notEqual(manifestOnlyChanged.keys.npm, linuxPr.keys.npm);
  assert.notEqual(manifestOnlyChanged.entries.npm.inputSha256, linuxPr.entries.npm.inputSha256);
  assert.equal(manifestOnlyChanged.keys.nuget, linuxPr.keys.nuget);

  const lockChanged = buildExactInputCacheManifest(makeManifestInput({packageLockSha256: '1'.repeat(64)}));
  assert.notEqual(lockChanged.keys.npm, linuxPr.keys.npm);
  assert.equal(lockChanged.keys.nuget, linuxPr.keys.nuget);

  const globalChanged = buildExactInputCacheManifest(makeManifestInput({globalJsonSha256: '2'.repeat(64)}));
  assert.notEqual(globalChanged.keys.nuget, linuxPr.keys.nuget);
  assert.notEqual(globalChanged.keys['aspire-cli'], linuxPr.keys['aspire-cli']);

  const appHostChanged = buildExactInputCacheManifest(makeManifestInput({appHostSha256: '3'.repeat(64)}));
  assert.notEqual(appHostChanged.keys.nuget, linuxPr.keys.nuget);
  assert.equal(appHostChanged.keys.npm, linuxPr.keys.npm);

  const nugetLockAdded = buildExactInputCacheManifest(makeManifestInput({nugetLockSha256: '5'.repeat(64)}));
  assert.notEqual(nugetLockAdded.keys.nuget, linuxPr.keys.nuget);

  // Observed cache verification succeeds only when writer is non-fork protected and digests match
  const makeObserved = (manifest, target, overrides = {}) => ({
    key: manifest.entries[target].key,
    inputSha256: manifest.entries[target].inputSha256,
    expectedArtifactSha256: '9'.repeat(64),
    observedArtifactSha256: '9'.repeat(64),
    writerRepositoryId: 1471342715,
    writerRepository: 'Jamula/SoftwareFactory',
    writerTrusted: true,
    writerIsFork: false,
    writerBranchProtected: true,
    cleanLayout: true,
    ...overrides
  });

  const verifiedManifest = buildExactInputCacheManifest(makeManifestInput({
    nugetLockSha256: '5'.repeat(64),
    observedCache: {
      npm: makeObserved(nugetLockAdded, 'npm'),
      nuget: makeObserved(nugetLockAdded, 'nuget'),
      'aspire-cli': makeObserved(nugetLockAdded, 'aspire-cli')
    }
  }));
  assert.equal(verifiedManifest.valid, true);
  assert.equal(verifiedManifest.reason, 'EXACT_CACHE_MANIFEST_VERIFIED');
  assert.equal(verifiedManifest.reuseEligible, true);
  assert.equal(verifiedManifest.entries.npm.verifiedHit, true);
  assert.equal(verifiedManifest.entries.nuget.verifiedHit, true);
  assert.equal(verifiedManifest.entries['aspire-cli'].verifiedHit, true);

  // Partial observedCache (e.g. only npm hit) marks only npm verifiedHit
  const partialHit = buildExactInputCacheManifest(makeManifestInput({
    branchProtected: undefined, // test omitted optional branchProtected via delete below
    observedCache: {npm: makeObserved(linuxPr, 'npm')}
  }));
  assert.equal(partialHit.valid, false); // explicit undefined property is rejected!
  const omittedProtected = makeManifestInput({observedCache: {npm: makeObserved(linuxPr, 'npm')}});
  delete omittedProtected.branchProtected;
  const validPartial = buildExactInputCacheManifest(omittedProtected);
  assert.equal(validPartial.valid, true);
  assert.equal(validPartial.allowProtectedCacheWrite, false);
  assert.equal(validPartial.entries.npm.verifiedHit, true);
  assert.equal(validPartial.entries.nuget.verifiedHit, false);

  // Fork PRs never derive keys or write to protected cache scopes
  const forkDenied = buildExactInputCacheManifest(makeManifestInput({
    isFork: true,
    branchProtected: true
  }));
  assert.equal(forkDenied.valid, false);
  assert.equal(forkDenied.reason, 'UNTRUSTED_PROVENANCE');
  assert.equal(forkDenied.allowProtectedCacheWrite, false);
  assert.equal(forkDenied.reuseEligible, false);

  // Digest mismatch on packageJsonSha256, nugetLockSha256, or observed entry invalidates reuse fail-closed
  const packageJsonMismatch = buildExactInputCacheManifest(makeManifestInput({
    packageJsonSha256: '7'.repeat(64),
    observedCache: {npm: makeObserved(linuxPr, 'npm')}
  }));
  assert.equal(packageJsonMismatch.valid, false);
  assert.equal(packageJsonMismatch.reason, 'DIGEST_MISMATCH');
  assert.equal(packageJsonMismatch.reuseEligible, false);

  const omittedPackageJson = makeManifestInput();
  delete omittedPackageJson.packageJsonSha256;
  const missingManifestDenied = buildExactInputCacheManifest(omittedPackageJson);
  assert.equal(missingManifestDenied.valid, false);
  assert.equal(missingManifestDenied.reason, 'MANIFEST_INPUT_INVALID');
  assert.equal(missingManifestDenied.reuseEligible, false);
  assert.equal(missingManifestDenied.allowProtectedCacheWrite, false);

  const nugetLockMismatch = buildExactInputCacheManifest(makeManifestInput({
    nugetLockSha256: '6'.repeat(64),
    observedCache: {nuget: makeObserved(nugetLockAdded, 'nuget')}
  }));
  assert.equal(nugetLockMismatch.valid, false);
  assert.equal(nugetLockMismatch.reason, 'DIGEST_MISMATCH');
  assert.equal(nugetLockMismatch.reuseEligible, false);

  const keySpoofed = buildExactInputCacheManifest(makeManifestInput({
    observedCache: {npm: makeObserved(linuxPr, 'npm', {key: 'sf-npm-spoofed'})}
  }));
  assert.equal(keySpoofed.valid, false);
  assert.equal(keySpoofed.reason, 'CACHE_POISONING_DETECTED');

  const forkWriter = buildExactInputCacheManifest(makeManifestInput({
    observedCache: {npm: makeObserved(linuxPr, 'npm', {writerIsFork: true})}
  }));
  assert.equal(forkWriter.valid, false);
  assert.equal(forkWriter.reason, 'UNTRUSTED_WRITER_PROVENANCE');

  // OS/arch/toolchain drift and invalid digests/inputs fail closed
  for (const drifted of [
    makeManifestInput({os: 'darwin'}),
    makeManifestInput({arch: 'arm64'}),
    makeManifestInput({toolchain: {...PINNED_CI_TOOLCHAIN, node: '26.13.0'}}),
    makeManifestInput({toolchain: {...PINNED_CI_TOOLCHAIN, dotnet: '10.0.400'}}),
    makeManifestInput({toolchain: {...PINNED_CI_TOOLCHAIN, aspireCli: '17.0.1'}})
  ]) {
    assert.equal(buildExactInputCacheManifest(drifted).reason, 'TOOLCHAIN_OR_OS_DRIFT');
  }

  for (const badDigest of [
    makeManifestInput({packageLockSha256: 'bad'}),
    makeManifestInput({globalJsonSha256: 'A'.repeat(64)}),
    makeManifestInput({appHostSha256: 'short'}),
    makeManifestInput({packageJsonSha256: 'bad'}),
    makeManifestInput({nugetLockSha256: 'bad'})
  ]) {
    assert.equal(buildExactInputCacheManifest(badDigest).reason, 'INVALID_DIGEST');
  }

  // Explicit null nugetLockSha256 and observedCache: null are accepted cleanly
  const explicitNulls = buildExactInputCacheManifest(
    makeManifestInput({nugetLockSha256: null, observedCache: null})
  );
  assert.equal(explicitNulls.valid, true);
  assert.equal(explicitNulls.reuseEligible, false);

  for (const badCache of [
    makeManifestInput({observedCache: {}}),
    makeManifestInput({observedCache: []}),
    makeManifestInput({observedCache: {npm: null}}),
    makeManifestInput({observedCache: {npm: makeObserved(linuxPr, 'npm', {key: 123})}}),
    makeManifestInput({observedCache: {npm: makeObserved(linuxPr, 'npm', {key: ''})}}),
    makeManifestInput({observedCache: {npm: makeObserved(linuxPr, 'npm', {key: 'k'.repeat(201)})}})
  ]) {
    assert.equal(buildExactInputCacheManifest(badCache).reason, 'CACHE_ENTRY_UNKNOWN');
  }

  for (const badInput of [
    null,
    [],
    new Proxy(makeManifestInput(), {get() { throw new Error('must not run'); }}),
    makeManifestInput({toolchain: null}),
    makeManifestInput({branchProtected: 'true'})
  ]) {
    assert.equal(buildExactInputCacheManifest(badInput).reason, 'MANIFEST_INPUT_INVALID');
  }
});

function makeHandoffInput(signal = 'test-failure', failureOverrides = {}, topOverrides = {}) {
  const baseSha = SHA_A;
  const headSha = SHA_B;
  return {
    repository: 'Jamula/SoftwareFactory',
    baseSha,
    headSha,
    changeEvidence: {
      repository: 'Jamula/SoftwareFactory',
      producer: 'trusted-ci',
      verified: true,
      complete: true,
      base: baseSha,
      head: headSha,
      paths: ['docs/CI-CONSOLIDATION.md'],
      testInventory: defaultSoftwareFactoryTestInventory()
    },
    failureEvidence: {
      head: headSha,
      complete: true,
      producer: 'trusted-ci',
      verified: true,
      signal,
      transient: false,
      attempt: 0,
      retryLimit: 2,
      repairAttempt: 0,
      maxRepairAttempts: 2,
      ...failureOverrides
    },
    ...topOverrides
  };
}

test('buildMafBoundedRepairHandoff routes test, coverage, dependency, infra, permission, and security signals with maxAttempts <= 2 and mandatoryFullGatesPreserved', () => {
  // Deterministic repairable categories: test, coverage, dependency, and deterministic stage timeout
  for (const [signal, expectedCategory, expectedAction] of [
    ['test-failure', 'test', 'repair-code-or-test'],
    ['coverage-below-target', 'coverage', 'add-targeted-coverage-tests'],
    ['npm-lock-mismatch', 'dependency', 'reconcile-locked-dependencies'],
    ['job-step-timeout', 'infra', 'diagnose-stage-timeout']
  ]) {
    const handoff = buildMafBoundedRepairHandoff(
      makeHandoffInput(signal, {}, {requestedMaxAttempts: 5}) // capped at <= 2!
    );
    assert.equal(handoff.valid, true);
    assert.equal(handoff.reason, 'BOUNDED_REPAIR_HANDOFF_READY');
    assert.equal(handoff.failureCategory, expectedCategory);
    assert.equal(handoff.repairAction, expectedAction);
    assert.equal(handoff.eligibleForAutoRepair, true);
    assert.equal(handoff.eligibleForTransientRetry, false);
    assert.equal(handoff.blindRetryRejected, true);
    assert.equal(handoff.maxAttempts, 2);
    assert.equal(handoff.remainingAttempts, 2);
    assert.equal(handoff.mandatoryFullGatesPreserved, true);
    assert.equal(handoff.fullValidationRequired, true);
    assert.equal(handoff.skipRequiredChecks, false);
    assert.equal(handoff.escalateToHuman, false);
    assert.deepEqual(handoff.fastFeedbackChecks, [
      'tests/engineering-factory/contract-routing.test.mjs',
      'tests/engineering-factory/run.test.mjs',
      'tests/engineering-factory/validation-diagnosis.test.mjs'
    ]);

    // Exhausted repair budget escalates to human
    const exhausted = buildMafBoundedRepairHandoff(
      makeHandoffInput(signal, {repairAttempt: 2, maxRepairAttempts: 2})
    );
    assert.equal(exhausted.valid, true);
    assert.equal(exhausted.reason, 'REPAIR_BUDGET_EXHAUSTED');
    assert.equal(exhausted.eligibleForAutoRepair, false);
    assert.equal(exhausted.maxAttempts, 2);
    assert.equal(exhausted.remainingAttempts, 0);
    assert.equal(exhausted.mandatoryFullGatesPreserved, true);
    assert.equal(exhausted.escalateToHuman, true);
  }

  // Transient infra failure: bounded retry without code mutation, then escalate when exhausted
  const transientInfra = buildMafBoundedRepairHandoff(
    makeHandoffInput('runner-lost', {transient: true, attempt: 1, retryLimit: 2}, {requestedMaxAttempts: 10})
  );
  assert.equal(transientInfra.valid, true);
  assert.equal(transientInfra.failureCategory, 'infra');
  assert.equal(transientInfra.reason, 'TRANSIENT_INFRA_RETRY_HANDOFF');
  assert.equal(transientInfra.eligibleForAutoRepair, false);
  assert.equal(transientInfra.eligibleForTransientRetry, true);
  assert.equal(transientInfra.maxAttempts, 2);
  assert.equal(transientInfra.remainingAttempts, 1);
  assert.equal(transientInfra.escalateToHuman, false);
  assert.equal(transientInfra.mandatoryFullGatesPreserved, true);

  const transientExhausted = buildMafBoundedRepairHandoff(
    makeHandoffInput('runner-lost', {transient: true, attempt: 2, retryLimit: 2})
  );
  assert.equal(transientExhausted.reason, 'INFRA_RETRY_BUDGET_EXHAUSTED');
  assert.equal(transientExhausted.eligibleForAutoRepair, false);
  assert.equal(transientExhausted.eligibleForTransientRetry, false);
  assert.equal(transientExhausted.remainingAttempts, 0);
  assert.equal(transientExhausted.escalateToHuman, true);

  // Permission and security categories ALWAYS block auto-repair and escalate to human
  for (const [signal, expectedCategory, expectedReason] of [
    ['http-403-forbidden', 'permission', 'PERMISSION_BOUNDARY_BLOCKED'],
    ['codeql-alert', 'security', 'SECURITY_GATE_BLOCKED'],
    ['tls-or-certificate', 'security', 'SECURITY_GATE_BLOCKED']
  ]) {
    const terminal = buildMafBoundedRepairHandoff(makeHandoffInput(signal));
    assert.equal(terminal.valid, true);
    assert.equal(terminal.failureCategory, expectedCategory);
    assert.equal(terminal.reason, expectedReason);
    assert.equal(terminal.eligibleForAutoRepair, false);
    assert.equal(terminal.eligibleForTransientRetry, false);
    assert.equal(terminal.maxAttempts, 0);
    assert.equal(terminal.remainingAttempts, 0);
    assert.equal(terminal.mandatoryFullGatesPreserved, true);
    assert.equal(terminal.escalateToHuman, true);
  }

  // Newly added ci-stage-benchmark suite and WORKSTATION-COMPATIBILITY doc map cleanly via change graph
  const newSuite = 'tests/engineering-factory/ci-stage-benchmark.test.mjs';
  const selfMapped = buildMafBoundedRepairHandoff(makeHandoffInput('assertion-failed', {}, {
    changeEvidence: {
      ...makeHandoffInput().changeEvidence,
      paths: [
        'tools/engineering-factory/ci-stage-benchmark.mjs',
        newSuite,
        'docs/WORKSTATION-COMPATIBILITY.md'
      ],
      testInventory: [...defaultSoftwareFactoryTestInventory(), newSuite]
    }
  }));
  assert.equal(selfMapped.valid, true);
  assert.equal(selfMapped.eligibleForAutoRepair, true);
  assert.ok(selfMapped.fastFeedbackChecks.includes(newSuite));
  assert.ok(selfMapped.affectedComponents.includes('engineering-factory'));
  assert.ok(selfMapped.affectedComponents.includes('repository-docs'));
});

test('buildMafBoundedRepairHandoff fails closed with escalateToHuman on invalid, proxy, unmapped, or stale evidence', () => {
  const unmapped = buildMafBoundedRepairHandoff(makeHandoffInput('test-failure', {}, {
    changeEvidence: {
      ...makeHandoffInput().changeEvidence,
      paths: ['unmapped-folder/file.mjs']
    }
  }));
  assert.equal(unmapped.valid, false);
  assert.equal(unmapped.reason, 'PATH_UNMAPPED');
  assert.equal(unmapped.eligibleForAutoRepair, false);
  assert.equal(unmapped.mandatoryFullGatesPreserved, true);
  assert.equal(unmapped.escalateToHuman, true);

  const staleFailure = buildMafBoundedRepairHandoff(
    makeHandoffInput('test-failure', {head: SHA_C})
  );
  assert.equal(staleFailure.valid, false);
  assert.equal(staleFailure.reason, 'EVIDENCE_INVALID_OR_STALE');
  assert.equal(staleFailure.eligibleForAutoRepair, false);
  assert.equal(staleFailure.escalateToHuman, true);

  for (const invalid of [
    null,
    [],
    new Proxy(makeHandoffInput(), {get() { throw new Error('must not run'); }}),
    makeHandoffInput('test-failure', {}, {changeEvidence: null}),
    makeHandoffInput('test-failure', {}, {failureEvidence: null}),
    makeHandoffInput('test-failure', {}, {requestedMaxAttempts: -1}),
    makeHandoffInput('test-failure', {}, {requestedMaxAttempts: 101})
  ]) {
    const denied = buildMafBoundedRepairHandoff(invalid);
    assert.equal(denied.valid, false);
    assert.equal(denied.reason, 'HANDOFF_INPUT_INVALID');
    assert.equal(denied.mandatoryFullGatesPreserved, true);
    assert.equal(denied.escalateToHuman, true);
  }
});

test('evaluateCheckConsolidationParity verifies 12-to-8 check consolidation and distinguishes required execution, reporting, and disabled shadow inventory', () => {
  const proposal = defaultSoftwareFactoryConsolidationProposal();
  const verified = evaluateCheckConsolidationParity(proposal);

  assert.equal(verified.valid, true);
  assert.equal(verified.state, 'verified');
  assert.equal(verified.shadow, true);
  assert.equal(verified.consolidationAllowed, true);
  assert.equal(verified.parityVerified, true);
  assert.equal(verified.reason, 'CHECK_CONSOLIDATION_PARITY_VERIFIED');
  assert.equal(verified.exactTwelveToEight, true);
  assert.equal(verified.meaningfulChecksReducedBy, 4);
  assert.equal(verified.fullVerificationRequired, true);
  assert.equal(verified.skipRequiredChecks, false);
  assert.deepEqual(verified.missingMandatoryGates, []);

  assert.equal(verified.classification.baseline.totalCount, 13);
  assert.equal(verified.classification.baseline.meaningfulCount, 12);
  assert.equal(verified.classification.baseline.requiredExecution.length, 9);
  assert.equal(verified.classification.baseline.reporting.length, 3);
  assert.deepEqual(verified.classification.baseline.disabledShadowInventory, ['inventory']);

  assert.equal(verified.classification.proposed.totalCount, 9);
  assert.equal(verified.classification.proposed.meaningfulCount, 8);
  assert.equal(verified.classification.proposed.requiredExecution.length, 7);
  assert.deepEqual(verified.classification.proposed.reporting, ['upload-coverage-javascript']);
  assert.deepEqual(verified.classification.proposed.disabledShadowInventory, ['inventory']);
  assert.equal(verified.consolidatedChecks.length, 4);

  assert.deepEqual(verified.preservedGates, {
    buildTest: true,
    uploadCoverageJavascript: true,
    windowsAspireRuntime: true,
    dotnetMafSpecialistAgents: true,
    codeql: true,
    secretScanning: true,
    mergeGroupCoverage: true,
    independentExactHeadReview: true,
    coverageThresholds98And95: true,
    shadowInventoryPreserved: true
  });

  // Also accepts single consolidated '.NET MAF specialist agents' context when explicit Linux/Windows platforms,
  // trusted producers, repositoryId, and affirmative verification prerequisites are supplied
  const minimalChecks = [
    {
      context: 'build-test',
      kind: 'required-execution',
      platforms: ['linux'],
      triggers: ['pull_request', 'merge_group'],
      trustedProducer: true
    },
    {
      context: 'upload-coverage-javascript',
      kind: 'reporting',
      platforms: ['linux'],
      triggers: ['pull_request', 'merge_group'],
      trustedProducer: true
    },
    {
      context: 'windows-aspire-runtime',
      kind: 'required-execution',
      platforms: ['windows'],
      triggers: ['pull_request', 'merge_group'],
      trustedProducer: true
    },
    {
      context: '.NET MAF specialist agents',
      kind: 'required-execution',
      platforms: ['linux', 'windows'],
      triggers: ['pull_request', 'merge_group'],
      trustedProducer: true
    },
    {
      context: 'CodeQL',
      kind: 'required-execution',
      platforms: ['linux'],
      triggers: ['pull_request'],
      trustedProducer: true
    },
    {
      context: 'inventory',
      kind: 'disabled-shadow-inventory',
      triggers: ['schedule', 'workflow_dispatch'],
      trustedProducer: true
    }
  ];
  const minimalProposal = {
    repositoryId: 1471342715,
    repository: 'Jamula/SoftwareFactory',
    baselineChecks: [
      ...minimalChecks.map(c => ({
        ...c,
        ...(c.platforms ? {platforms: [...c.platforms]} : {}),
        triggers: [...c.triggers]
      })),
      {
        context: 'legacy-component-check',
        kind: 'required-execution',
        triggers: ['pull_request', 'merge_group'],
        trustedProducer: true,
        consolidatedInto: 'build-test'
      }
    ],
    proposedChecks: minimalChecks.map(c => ({
      ...c,
      ...(c.platforms ? {platforms: [...c.platforms]} : {}),
      triggers: [...c.triggers]
    })),
    gates: {
      secretScanning: true,
      mergeGroupCoverage: true,
      independentExactHeadReview: true,
      lineCoverageMinPct: 98,
      branchCoverageMinPct: 95,
      nativeCoverageIntegrated: true,
      equivalentVerificationProven: true,
      shadowEventIngestionPreserved: true
    }
  };
  const minimalVerified = evaluateCheckConsolidationParity(minimalProposal);
  assert.equal(minimalVerified.valid, true);
  assert.equal(minimalVerified.consolidationAllowed, true);
  assert.equal(minimalVerified.exactTwelveToEight, false);
  assert.equal(minimalVerified.meaningfulChecksReducedBy, 1);

  // Missing platform metadata on '.NET MAF specialist agents' (or other mandatory checks) is rejected
  const missingMafPlatforms = structuredClone(minimalProposal);
  delete missingMafPlatforms.baselineChecks.find(c => c.context === '.NET MAF specialist agents').platforms;
  delete missingMafPlatforms.proposedChecks.find(c => c.context === '.NET MAF specialist agents').platforms;
  const missingMafPlatformsRes = evaluateCheckConsolidationParity(missingMafPlatforms);
  assert.equal(missingMafPlatformsRes.consolidationAllowed, false);
  assert.equal(missingMafPlatformsRes.reason, 'MANDATORY_CHECK_ROLE_INVALID');
  assert.equal(missingMafPlatformsRes.preservedGates.dotnetMafSpecialistAgents, false);
});

test('evaluateCheckConsolidationParity blocks any proposal dropping mandatory execution/reporting checks, secret scanning, merge_group, review, coverage, or shadow inventory', () => {
  // Dropping each mandatory check context / workflow gate blocks with MANDATORY_CHECK_DROPPED
  for (const [label, filterFn, preservedKey] of [
    ['build-test', c => c.context !== 'build-test', 'buildTest'],
    ['upload-coverage-javascript', c => c.context !== 'upload-coverage-javascript', 'uploadCoverageJavascript'],
    ['windows-aspire-runtime', c => c.context !== 'windows-aspire-runtime', 'windowsAspireRuntime'],
    ['.NET MAF specialist agents', c => c.workflow !== '.NET MAF specialist agents', 'dotnetMafSpecialistAgents'],
    ['CodeQL', c => c.context !== 'CodeQL', 'codeql']
  ]) {
    const p = defaultSoftwareFactoryConsolidationProposal();
    p.proposedChecks = p.proposedChecks.filter(filterFn);
    const res = evaluateCheckConsolidationParity(p);
    assert.equal(res.valid, false);
    assert.equal(res.state, 'blocked');
    assert.equal(res.consolidationAllowed, false);
    assert.equal(res.reason, 'MANDATORY_CHECK_DROPPED');
    assert.deepEqual(res.missingMandatoryGates, [label]);
    assert.equal(res.preservedGates[preservedKey], false);
  }

  // Dropping secret scanning, merge_group coverage, or independent exact-head review
  const noSecretScan = defaultSoftwareFactoryConsolidationProposal();
  noSecretScan.gates.secretScanning = false;
  const secretRes = evaluateCheckConsolidationParity(noSecretScan);
  assert.equal(secretRes.consolidationAllowed, false);
  assert.equal(secretRes.reason, 'SECRET_SCANNING_DROPPED');
  assert.equal(secretRes.preservedGates.secretScanning, false);

  const noReview = defaultSoftwareFactoryConsolidationProposal();
  noReview.gates.independentExactHeadReview = false;
  const reviewRes = evaluateCheckConsolidationParity(noReview);
  assert.equal(reviewRes.consolidationAllowed, false);
  assert.equal(reviewRes.reason, 'INDEPENDENT_REVIEW_DROPPED');
  assert.equal(reviewRes.preservedGates.independentExactHeadReview, false);

  const noMergeGroupFlag = defaultSoftwareFactoryConsolidationProposal();
  noMergeGroupFlag.gates.mergeGroupCoverage = false;
  const mgFlagRes = evaluateCheckConsolidationParity(noMergeGroupFlag);
  assert.equal(mgFlagRes.consolidationAllowed, false);
  assert.equal(mgFlagRes.reason, 'MERGE_GROUP_COVERAGE_DROPPED');
  assert.equal(mgFlagRes.preservedGates.mergeGroupCoverage, false);

  // Structural merge_group drops on mandatory checks and consolidated checks
  for (const dropCtx of [
    'build-test',
    'upload-coverage-javascript',
    'windows-aspire-runtime',
    'windows-dotnet-agents',
    'pinned-synthetic-replay'
  ]) {
    const p = defaultSoftwareFactoryConsolidationProposal();
    const check = p.proposedChecks.find(c => c.context === dropCtx);
    check.triggers = ['pull_request', 'push_main'];
    const res = evaluateCheckConsolidationParity(p);
    assert.equal(res.consolidationAllowed, false, dropCtx);
    assert.equal(res.reason, 'MERGE_GROUP_COVERAGE_DROPPED', dropCtx);
    assert.equal(res.preservedGates.mergeGroupCoverage, false, dropCtx);
  }

  // Mandatory role downgrades, untrusted producer, missing pull_request trigger, and Windows MAF drop
  const downgradeWindows = defaultSoftwareFactoryConsolidationProposal();
  downgradeWindows.proposedChecks.find(c => c.context === 'windows-aspire-runtime').kind = 'reporting';
  assert.equal(evaluateCheckConsolidationParity(downgradeWindows).reason, 'MANDATORY_CHECK_ROLE_INVALID');

  const misclassifyUpload = defaultSoftwareFactoryConsolidationProposal();
  misclassifyUpload.proposedChecks.find(c => c.context === 'upload-coverage-javascript').kind = 'required-execution';
  assert.equal(evaluateCheckConsolidationParity(misclassifyUpload).reason, 'MANDATORY_CHECK_ROLE_INVALID');

  const untrustedBuildTest = defaultSoftwareFactoryConsolidationProposal();
  untrustedBuildTest.proposedChecks.find(c => c.context === 'build-test').trustedProducer = false;
  assert.equal(evaluateCheckConsolidationParity(untrustedBuildTest).reason, 'MANDATORY_CHECK_ROLE_INVALID');

  const wrongPlatformWin = defaultSoftwareFactoryConsolidationProposal();
  wrongPlatformWin.proposedChecks.find(c => c.context === 'windows-aspire-runtime').platforms = ['linux'];
  assert.equal(evaluateCheckConsolidationParity(wrongPlatformWin).reason, 'MANDATORY_CHECK_ROLE_INVALID');

  const dropWindowsDotnet = defaultSoftwareFactoryConsolidationProposal();
  dropWindowsDotnet.proposedChecks = dropWindowsDotnet.proposedChecks.filter(
    c => c.context !== 'windows-dotnet-agents'
  );
  const winMafDroppedRes = evaluateCheckConsolidationParity(dropWindowsDotnet);
  assert.equal(winMafDroppedRes.reason, 'MANDATORY_CHECK_ROLE_INVALID');
  assert.equal(winMafDroppedRes.preservedGates.dotnetMafSpecialistAgents, false);

  const noPrTrigger = defaultSoftwareFactoryConsolidationProposal();
  noPrTrigger.proposedChecks.find(c => c.context === 'CodeQL').triggers = ['push_main'];
  assert.equal(evaluateCheckConsolidationParity(noPrTrigger).reason, 'MANDATORY_CHECK_ROLE_INVALID');

  // Coverage gate weakening
  for (const gateOverride of [
    {lineCoverageMinPct: 97.9},
    {branchCoverageMinPct: 94.9},
    {nativeCoverageIntegrated: false}
  ]) {
    const p = defaultSoftwareFactoryConsolidationProposal();
    Object.assign(p.gates, gateOverride);
    const res = evaluateCheckConsolidationParity(p);
    assert.equal(res.reason, 'COVERAGE_GATE_WEAKENED');
    assert.equal(res.preservedGates.coverageThresholds98And95, false);
  }

  // Shadow inventory deletion, promotion, disguise, or disabled ingestion
  const dropShadow = defaultSoftwareFactoryConsolidationProposal();
  dropShadow.proposedChecks = dropShadow.proposedChecks.filter(c => c.context !== 'inventory');
  assert.equal(evaluateCheckConsolidationParity(dropShadow).reason, 'SHADOW_INVENTORY_VIOLATION');

  const promoteShadow = defaultSoftwareFactoryConsolidationProposal();
  promoteShadow.proposedChecks.find(c => c.context === 'inventory').kind = 'reporting';
  assert.equal(evaluateCheckConsolidationParity(promoteShadow).reason, 'SHADOW_INVENTORY_VIOLATION');

  const disguiseActiveAsShadow = defaultSoftwareFactoryConsolidationProposal();
  disguiseActiveAsShadow.proposedChecks.find(c => c.context === 'pinned-synthetic-replay').kind = 'disabled-shadow-inventory';
  assert.equal(evaluateCheckConsolidationParity(disguiseActiveAsShadow).reason, 'SHADOW_INVENTORY_VIOLATION');

  const disableShadowFlag = defaultSoftwareFactoryConsolidationProposal();
  disableShadowFlag.gates.shadowEventIngestionPreserved = false;
  assert.equal(evaluateCheckConsolidationParity(disableShadowFlag).reason, 'SHADOW_INVENTORY_VIOLATION');

  const shadowTriggerDropped = defaultSoftwareFactoryConsolidationProposal();
  shadowTriggerDropped.proposedChecks.find(c => c.context === 'inventory').triggers = ['workflow_dispatch'];
  const shadowTriggerRes = evaluateCheckConsolidationParity(shadowTriggerDropped);
  assert.equal(shadowTriggerRes.reason, 'SHADOW_INVENTORY_VIOLATION');
  assert.equal(shadowTriggerRes.preservedGates.shadowInventoryPreserved, false);

  const shadowPlatformDropped = defaultSoftwareFactoryConsolidationProposal();
  delete shadowPlatformDropped.proposedChecks.find(c => c.context === 'inventory').platforms;
  assert.equal(evaluateCheckConsolidationParity(shadowPlatformDropped).reason, 'SHADOW_INVENTORY_VIOLATION');

  // Unverified consolidation: missing consolidatedInto, execution->reporting downgrade, platform/trigger loss, or unproven equivalence
  const unmappedDrop = defaultSoftwareFactoryConsolidationProposal();
  delete unmappedDrop.baselineChecks.find(c => c.context === 'test-coverage').consolidatedInto;
  assert.equal(evaluateCheckConsolidationParity(unmappedDrop).reason, 'UNVERIFIED_CHECK_CONSOLIDATION');

  const execIntoReporting = defaultSoftwareFactoryConsolidationProposal();
  execIntoReporting.baselineChecks.find(c => c.context === 'pinned-synthetic-replay').consolidatedInto = 'upload-coverage-javascript';
  execIntoReporting.proposedChecks = execIntoReporting.proposedChecks.filter(
    c => c.context !== 'pinned-synthetic-replay'
  );
  assert.equal(evaluateCheckConsolidationParity(execIntoReporting).reason, 'UNVERIFIED_CHECK_CONSOLIDATION');

  for (const subjob of ['test-coverage', 'linux-aspire-runtime']) {
    const subjobIntoReporting = defaultSoftwareFactoryConsolidationProposal();
    subjobIntoReporting.baselineChecks.find(c => c.context === subjob).consolidatedInto = 'upload-coverage-javascript';
    assert.equal(
      evaluateCheckConsolidationParity(subjobIntoReporting).reason,
      'UNVERIFIED_CHECK_CONSOLIDATION',
      subjob
    );

    const subjobMisclassified = defaultSoftwareFactoryConsolidationProposal();
    subjobMisclassified.baselineChecks.find(c => c.context === subjob).kind = 'reporting';
    assert.equal(
      evaluateCheckConsolidationParity(subjobMisclassified).reason,
      'UNVERIFIED_CHECK_CONSOLIDATION',
      subjob
    );
  }

  const retainedDowngrade = defaultSoftwareFactoryConsolidationProposal();
  retainedDowngrade.proposedChecks.find(c => c.context === 'pinned-synthetic-replay').kind = 'reporting';
  assert.equal(evaluateCheckConsolidationParity(retainedDowngrade).reason, 'UNVERIFIED_CHECK_CONSOLIDATION');

  const retainedUntrusted = defaultSoftwareFactoryConsolidationProposal();
  retainedUntrusted.proposedChecks.find(c => c.context === 'pinned-synthetic-replay').trustedProducer = false;
  assert.equal(evaluateCheckConsolidationParity(retainedUntrusted).reason, 'UNVERIFIED_CHECK_CONSOLIDATION');

  const retainedPlatformDropped = defaultSoftwareFactoryConsolidationProposal();
  delete retainedPlatformDropped.proposedChecks.find(c => c.context === 'pinned-synthetic-replay').platforms;
  assert.equal(evaluateCheckConsolidationParity(retainedPlatformDropped).reason, 'UNVERIFIED_CHECK_CONSOLIDATION');

  const retainedPushMainDropped = defaultSoftwareFactoryConsolidationProposal();
  retainedPushMainDropped.proposedChecks.find(c => c.context === 'pinned-synthetic-replay').triggers = [
    'pull_request',
    'merge_group'
  ];
  assert.equal(evaluateCheckConsolidationParity(retainedPushMainDropped).reason, 'UNVERIFIED_CHECK_CONSOLIDATION');

  const retainedPrTriggerDropped = defaultSoftwareFactoryConsolidationProposal();
  retainedPrTriggerDropped.proposedChecks.find(
    c => c.context === 'CodeQL / Analyze (actions)'
  ).triggers = ['push_main'];
  assert.equal(evaluateCheckConsolidationParity(retainedPrTriggerDropped).reason, 'UNVERIFIED_CHECK_CONSOLIDATION');

  const consolidatedMergeGroupMissing = defaultSoftwareFactoryConsolidationProposal();
  consolidatedMergeGroupMissing.baselineChecks.push({
    context: 'legacy-mg-check',
    kind: 'reporting',
    platforms: ['linux'],
    triggers: ['pull_request', 'merge_group'],
    trustedProducer: true,
    consolidatedInto: 'CodeQL / Analyze (actions)' // lacks merge_group!
  });
  assert.equal(
    evaluateCheckConsolidationParity(consolidatedMergeGroupMissing).reason,
    'MERGE_GROUP_COVERAGE_DROPPED'
  );

  const consolidatedPushMainMissing = defaultSoftwareFactoryConsolidationProposal();
  consolidatedPushMainMissing.proposedChecks.push({
    context: 'pr-only-target',
    kind: 'reporting',
    platforms: ['linux'],
    triggers: ['pull_request'],
    trustedProducer: true
  });
  consolidatedPushMainMissing.proposedChecks = consolidatedPushMainMissing.proposedChecks.filter(
    c => c.context !== 'pinned-synthetic-replay'
  );
  consolidatedPushMainMissing.baselineChecks.find(
    c => c.context === 'pinned-synthetic-replay'
  ).consolidatedInto = 'build-test';
  consolidatedPushMainMissing.baselineChecks.push({
    context: 'legacy-push-report',
    kind: 'reporting',
    platforms: ['linux'],
    triggers: ['pull_request', 'push_main'],
    consolidatedInto: 'pr-only-target'
  });
  assert.equal(
    evaluateCheckConsolidationParity(consolidatedPushMainMissing).reason,
    'UNVERIFIED_CHECK_CONSOLIDATION'
  );

  const targetUntrusted = defaultSoftwareFactoryConsolidationProposal();
  targetUntrusted.proposedChecks.push({
    context: 'untrusted-target',
    kind: 'reporting',
    platforms: ['linux'],
    triggers: ['pull_request'],
    trustedProducer: false
  });
  targetUntrusted.proposedChecks = targetUntrusted.proposedChecks.filter(
    c => c.context !== 'pinned-synthetic-replay'
  );
  targetUntrusted.baselineChecks.find(
    c => c.context === 'pinned-synthetic-replay'
  ).consolidatedInto = 'build-test';
  targetUntrusted.baselineChecks.find(
    c => c.context === 'CodeQL - Code Quality / Analyze (csharp)'
  ).consolidatedInto = 'untrusted-target';
  assert.equal(evaluateCheckConsolidationParity(targetUntrusted).reason, 'UNVERIFIED_CHECK_CONSOLIDATION');

  const targetPlatformMismatch = defaultSoftwareFactoryConsolidationProposal();
  targetPlatformMismatch.baselineChecks.push({
    context: 'legacy-win-smoke',
    kind: 'reporting',
    platforms: ['windows'],
    triggers: ['pull_request'],
    trustedProducer: true,
    consolidatedInto: 'build-test' // Linux-only target!
  });
  assert.equal(evaluateCheckConsolidationParity(targetPlatformMismatch).reason, 'UNVERIFIED_CHECK_CONSOLIDATION');

  const unprovenEquivalence = defaultSoftwareFactoryConsolidationProposal();
  unprovenEquivalence.gates.equivalentVerificationProven = false;
  assert.equal(evaluateCheckConsolidationParity(unprovenEquivalence).reason, 'UNVERIFIED_CHECK_CONSOLIDATION');

  // Check-count contract mismatch: >8 meaningful checks or increasing check count
  const nineMeaningful = defaultSoftwareFactoryConsolidationProposal();
  nineMeaningful.proposedChecks.push({
    context: 'extra-ninth-check',
    kind: 'reporting',
    platforms: ['linux'],
    triggers: ['pull_request'],
    trustedProducer: true
  });
  assert.equal(evaluateCheckConsolidationParity(nineMeaningful).reason, 'CHECK_COUNT_CONTRACT_MISMATCH');

  const noReductionEightToEight = defaultSoftwareFactoryConsolidationProposal();
  noReductionEightToEight.baselineChecks = structuredClone(noReductionEightToEight.proposedChecks);
  assert.equal(evaluateCheckConsolidationParity(noReductionEightToEight).reason, 'CHECK_COUNT_CONTRACT_MISMATCH');

  const bloatedFromSeven = defaultSoftwareFactoryConsolidationProposal();
  bloatedFromSeven.baselineChecks = bloatedFromSeven.proposedChecks.filter(
    c => c.context !== 'pinned-synthetic-replay'
  );
  assert.equal(evaluateCheckConsolidationParity(bloatedFromSeven).reason, 'CHECK_COUNT_CONTRACT_MISMATCH');
});

test('evaluateCheckConsolidationParity fails closed on proxies, malformed descriptors, cross-repo inputs, and duplicates', () => {
  const base = defaultSoftwareFactoryConsolidationProposal();
  const proxyInput = new Proxy(base, {get() { throw new Error('proxy must not run'); }});
  const proxyGates = {...base, gates: new Proxy(base.gates, {get() { throw new Error('proxy must not run'); }})};
  const proxyCheck = {
    ...base,
    proposedChecks: [new Proxy(base.proposedChecks[0], {get() { throw new Error('proxy must not run'); }})]
  };

  const missingRepoId = structuredClone(base);
  delete missingRepoId.repositoryId;
  const missingNativeCoverage = structuredClone(base);
  delete missingNativeCoverage.gates.nativeCoverageIntegrated;
  const missingEquivalentProof = structuredClone(base);
  delete missingEquivalentProof.gates.equivalentVerificationProven;
  const missingShadowPreserved = structuredClone(base);
  delete missingShadowPreserved.gates.shadowEventIngestionPreserved;

  for (const bad of [
    null,
    [],
    proxyInput,
    proxyGates,
    proxyCheck,
    missingRepoId,
    missingNativeCoverage,
    missingEquivalentProof,
    missingShadowPreserved,
    {...base, repository: ' Jamula/SoftwareFactory '},
    {...base, repositoryId: 0},
    {...base, gates: {...base.gates, secretScanning: 'true'}},
    {...base, gates: {...base.gates, mergeGroupCoverage: 1}},
    {...base, gates: {...base.gates, independentExactHeadReview: null}},
    {...base, gates: {...base.gates, lineCoverageMinPct: 101}},
    {...base, gates: {...base.gates, branchCoverageMinPct: -1}},
    {...base, gates: {...base.gates, nativeCoverageIntegrated: 'yes'}},
    {...base, gates: {...base.gates, equivalentVerificationProven: 'yes'}},
    {...base, gates: {...base.gates, shadowEventIngestionPreserved: 'yes'}},
    {...base, baselineChecks: []},
    {...base, proposedChecks: []},
    {...base, proposedChecks: [{...base.proposedChecks[0], workflow: ' bad '}]},
    {...base, proposedChecks: [{...base.proposedChecks[0], platforms: ['darwin']}]},
    {...base, proposedChecks: [{...base.proposedChecks[0], platforms: ['linux', 'linux']}]},
    {...base, proposedChecks: [{...base.proposedChecks[0], trustedProducer: 'true'}]},
    {...base, baselineChecks: [{...base.baselineChecks[8], consolidatedInto: ''}]},
    {...base, proposedChecks: [{...base.proposedChecks[0], triggers: ['pull_request', 'pull_request']}]},
    {...base, proposedChecks: [{...base.proposedChecks[0], kind: 'unknown'}]}
  ]) {
    const res = evaluateCheckConsolidationParity(bad);
    assert.equal(res.valid, false);
    assert.equal(res.consolidationAllowed, false);
    assert.equal(res.reason, 'CONSOLIDATION_INPUT_INVALID');
  }

  assert.equal(
    evaluateCheckConsolidationParity({...base, repository: 'other/repo'}).reason,
    'UNTRUSTED_REPOSITORY'
  );
  assert.equal(
    evaluateCheckConsolidationParity({...base, repositoryId: 999}).reason,
    'UNTRUSTED_REPOSITORY'
  );
  assert.equal(
    evaluateCheckConsolidationParity({
      ...base,
      baselineChecks: [base.baselineChecks[0], base.baselineChecks[0]]
    }).reason,
    'DUPLICATE_CHECK_CONTEXT'
  );
  assert.equal(
    evaluateCheckConsolidationParity({
      ...base,
      proposedChecks: [base.proposedChecks[0], base.proposedChecks[0]]
    }).reason,
    'DUPLICATE_CHECK_CONTEXT'
  );
});

test('dotnet-agents.yml enforces SHA-pinned exact-input NuGet caching, 98/95 Coverlet gates, stage timing, and zero script interpolation', () => {
  const workflowUrl = new URL('../../.github/workflows/dotnet-agents.yml', import.meta.url);
  const content = readFileSync(workflowUrl, 'utf8');

  assert.match(content, /^name: \.NET MAF specialist agents$/m);
  assert.match(content, /^permissions:\n  contents: read$/m);
  assert.match(content, /runs-on: ubuntu-latest/);
  assert.match(content, /runs-on: windows-latest/);
  assert.match(
    content,
    /^on:\n  pull_request:\n    paths:\n      - 'src\/\*\*'\n      - 'tests\/SoftwareFactory\.Agents\.Tests\/\*\*'\n      - 'apphost\.cs'\n      - 'global\.json'\n      - 'Directory\.Build\.props'\n      - 'Directory\.Packages\.props'\n      - '\.github\/workflows\/dotnet-agents\.yml'\n  merge_group:\n    types: \[checks_requested\]\n  push:\n    branches: \[main\]$/m
  );

  // Every uses: line must be pinned to an exact 40-char lowercase hex commit SHA
  const usesMatches = [...content.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map(m => m[1]);
  assert.equal(usesMatches.length, 8);
  for (const ref of usesMatches) {
    assert.match(ref, /^actions\/[a-z0-9/-]+@[a-f0-9]{40}$/);
  }
  assert.ok(usesMatches.includes('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'));
  assert.ok(usesMatches.includes('actions/setup-dotnet@0f4a354dd5547a28c70b7853dbd95d5b67886e73'));
  assert.ok(usesMatches.includes('actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9'));
  assert.ok(usesMatches.includes('actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9'));
  assert.equal(content.includes('restore-keys:'), false);

  // Write-capable actions/cache is gated strictly to protected main push on Jamula/SoftwareFactory
  assert.match(
    content,
    /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' && github\.ref_protected == true && github\.repository == 'Jamula\/SoftwareFactory' && github\.repository_id == '1471342715'/
  );

  // Per-stage millisecond durations and Coverlet 98/95 enforcement on both platforms
  for (const token of ['restore_ms=', 'build_ms=', 'test_coverage_ms=', 'smoke_ms=', 'CollectCoverage=true']) {
    assert.equal(content.split(token).length - 1, 2, `expected ${token} in both Linux and Windows jobs`);
  }

  // Job-level env blocks (4-space indent) must never reference runner.* context
  const jobEnvMatches = [...content.matchAll(/^    env:\n((?:      .+\n)+)/gm)].map(m => m[1]);
  assert.equal(jobEnvMatches.length, 2);
  for (const jobEnv of jobEnvMatches) {
    assert.equal(jobEnv.includes('runner.'), false, `runner context is invalid in job-level env: ${jobEnv}`);
  }

  // Zero ${{ ... }} interpolation inside any run: | script block
  const lines = content.split('\n');
  let runIndent = null;
  let runBlocksChecked = 0;
  for (const line of lines) {
    if (runIndent !== null) {
      if (line.trim() === '') continue;
      const indent = line.match(/^ */)[0].length;
      if (indent > runIndent) {
        assert.equal(line.includes('${{'), false, `forbidden expression interpolation in run script: ${line}`);
        continue;
      }
      runIndent = null;
    }
    const startMatch = line.match(/^( *)(?:-\s*)?run:\s*(\||.+)$/);
    if (startMatch) {
      runBlocksChecked++;
      assert.equal(startMatch[2].includes('${{'), false, `forbidden inline expression in run: ${line}`);
      if (line.trimEnd().endsWith('|')) {
        runIndent = startMatch[1].length;
      }
    }
  }
  assert.equal(runBlocksChecked, 8);
});

function assertWorkflowPinnedAndSafe(content, expectedUsesCount, expectedJobEnvCount, expectedRunBlocks) {
  const usesMatches = [...content.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map(m => m[1]);
  assert.equal(usesMatches.length, expectedUsesCount);
  for (const ref of usesMatches) {
    assert.match(ref, /^actions\/[a-z0-9/-]+@[a-f0-9]{40}$/);
  }
  assert.equal(content.includes('restore-keys:'), false);

  const jobEnvMatches = [...content.matchAll(/^    env:\n((?:      .+\n)+)/gm)].map(m => m[1]);
  assert.equal(jobEnvMatches.length, expectedJobEnvCount);
  for (const jobEnv of jobEnvMatches) {
    assert.equal(jobEnv.includes('runner.'), false, `runner context is invalid in job-level env: ${jobEnv}`);
  }

  const lines = content.split('\n');
  let runIndent = null;
  let runBlocksChecked = 0;
  for (const line of lines) {
    if (runIndent !== null) {
      if (line.trim() === '') continue;
      const indent = line.match(/^ */)[0].length;
      if (indent > runIndent) {
        assert.equal(line.includes('${{'), false, `forbidden expression interpolation in run script: ${line}`);
        continue;
      }
      runIndent = null;
    }
    const startMatch = line.match(/^( *)(?:-\s*)?run:\s*(\||.+)$/);
    if (startMatch) {
      runBlocksChecked++;
      assert.equal(startMatch[2].includes('${{'), false, `forbidden inline expression in run: ${line}`);
      if (line.trimEnd().endsWith('|')) {
        runIndent = startMatch[1].length;
      }
    }
  }
  assert.equal(runBlocksChecked, expectedRunBlocks);
  return usesMatches;
}

test('validate.yml, windows-aspire.yml, and shadow-reconcile.yml enforce poison-safe exact-lockfile caching, deduplicated runtime verifiers, and dispatch-only legacy reconciliation', () => {
  const validateContent = readFileSync(new URL('../../.github/workflows/validate.yml', import.meta.url), 'utf8');
  const windowsContent = readFileSync(new URL('../../.github/workflows/windows-aspire.yml', import.meta.url), 'utf8');
  const shadowContent = readFileSync(new URL('../../.github/workflows/shadow-reconcile.yml', import.meta.url), 'utf8');

  const protectedMainGuard =
    "if: github.event_name == 'push' && github.ref == 'refs/heads/main' && github.ref_protected == true && github.repository == 'Jamula/SoftwareFactory' && github.repository_id == '1471342715'";
  const npmKeyExpr =
    "key: sf-npm-ci-v1-${{ runner.os }}-${{ runner.arch }}-node-26.13.1-ignore-scripts-${{ hashFiles('package.json', 'package-lock.json') }}";
  const aspireKeyExpr =
    "key: sf-aspire-nuget-v2-${{ runner.os }}-${{ runner.arch }}-dotnet-10.0.404-aspire-17.0.0-release-${{ hashFiles('global.json', 'apphost.cs', 'src/SoftwareFactory.Agents/SoftwareFactory.Agents.csproj', '**/packages.lock.json', 'Directory.Build.props', 'Directory.Packages.props') }}";

  // validate.yml invariants: 4 required jobs, SHA-pinned actions, 3 cache pairs (2 npm + 1 NuGet/Aspire.Cli), zero duplicate node --test inside runtime
  assert.match(validateContent, /^name: Factory validation$/m);
  assert.match(validateContent, /^permissions:\n  contents: read$/m);
  for (const jobId of ['test-coverage', 'linux-aspire-runtime', 'build-test', 'upload-coverage-javascript']) {
    assert.match(validateContent, new RegExp(`^  ${jobId}:$`, 'm'));
  }
  const validateUses = assertWorkflowPinnedAndSafe(validateContent, 14, 0, 9);
  assert.equal(
    validateUses.filter(u => u === 'actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9').length,
    3
  );
  assert.equal(
    validateUses.filter(u => u === 'actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9').length,
    3
  );
  assert.equal(validateContent.split(protectedMainGuard).length - 1, 3);
  assert.equal(validateContent.split("if: github.event_name != 'push'").length - 1, 3);
  assert.equal(validateContent.split(npmKeyExpr).length - 1, 4);
  assert.equal(validateContent.split(aspireKeyExpr).length - 1, 2);
  assert.equal(validateContent.includes('npm run test:coverage'), true);
  assert.equal(validateContent.includes('node tools/engineering-factory/verify-dashboard-export.mjs "$archive"'), true);
  assert.equal(validateContent.includes('node tools/engineering-factory/verify-dashboard-metric-receipt.mjs "$data_root"'), true);
  assert.equal(validateContent.includes('node --test'), false);
  assert.equal(
    validateContent.includes('31599e3906c24c5b05787651ac52859ca0e267973ff2bb9f38ca5f968e355f1d'),
    true
  );
  assert.equal(
    validateContent.includes('e82a0663bc83b4cccd1c23403baa45eef2141a889e84f97030e50c21f3f5781f'),
    true
  );

  // windows-aspire.yml invariants: SHA-pinned actions, 2 cache pairs (1 npm + 1 NuGet/Aspire.Cli), zero duplicate node --test, TLS/auth intact
  assert.match(windowsContent, /^name: Windows Aspire runtime$/m);
  assert.match(windowsContent, /^permissions:\n  contents: read$/m);
  assert.match(windowsContent, /^  windows-aspire-runtime:$/m);
  const windowsUses = assertWorkflowPinnedAndSafe(windowsContent, 7, 1, 4);
  assert.equal(
    windowsUses.filter(u => u === 'actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9').length,
    2
  );
  assert.equal(
    windowsUses.filter(u => u === 'actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9').length,
    2
  );
  assert.equal(windowsContent.split(protectedMainGuard).length - 1, 2);
  assert.equal(windowsContent.split("if: github.event_name != 'push'").length - 1, 2);
  assert.equal(windowsContent.split(npmKeyExpr).length - 1, 2);
  assert.equal(windowsContent.split(aspireKeyExpr).length - 1, 2);
  assert.equal(windowsContent.includes('node tools/engineering-factory/verify-dashboard-api.mjs'), true);
  assert.equal(windowsContent.includes('node tools/engineering-factory/verify-dashboard-metric-receipt.mjs $dataRoot'), true);
  assert.equal(
    windowsContent.includes('node --test tests/engineering-factory/verify-dashboard-metric-receipt.test.mjs'),
    true
  );
  assert.equal(windowsContent.includes('verify-dashboard-api.test.mjs'), false);
  assert.equal(
    windowsContent.includes('31599e3906c24c5b05787651ac52859ca0e267973ff2bb9f38ca5f968e355f1d'),
    true
  );
  assert.equal(
    windowsContent.includes('590e1d28d581fd532fa24a60a2adef8792cb3bd438585f57879551fc510458ea'),
    true
  );
  assert.match(windowsContent, /\^17\\\.0\\\.0\(\?:\\\+\[0-9a-f\]\+\)\?\$/);

  // shadow-reconcile.yml invariants: restricted to workflow_dispatch only under on:
  assert.match(shadowContent, /^name: Factory shadow reconciliation$/m);
  assert.match(
    shadowContent,
    /^on:\n  workflow_dispatch:\n    inputs:\n      issue_number:\n        description: Optional issue number for a read-only manual reconciliation\n        required: false\n        type: string\n        default: ''\npermissions:\n  contents: read$/m
  );
  assertWorkflowPinnedAndSafe(shadowContent, 2, 0, 6);
});

test('m02-01-ci-acceleration-receipt.json replays real cold-run critical-path, Aspire stage bottlenecks, and exact-lockfile cache keys fail-closed', () => {
  const receipt = JSON.parse(
    readFileSync(new URL('../../docs/evidence/m02-01-ci-acceleration-receipt.json', import.meta.url), 'utf8')
  );
  assert.equal(receipt.milestone, 'M02.01');
  assert.equal(receipt.issueNumber, 15);
  assert.equal(receipt.repository, 'Jamula/SoftwareFactory');
  assert.equal(receipt.repositoryId, 1471342715);
  assert.equal(receipt.status.coldBaselineCaptured, true);
  assert.equal(receipt.status.exactLockCachingWired, true);
  assert.equal(receipt.status.warmCohortVerified, false);
  assert.equal(receipt.status.closesIssue15, false);
  assert.equal(receipt.status.gatesWeakened, false);
  assert.equal(receipt.status.restoreKeysFallbackUsed, false);
  assert.equal(receipt.status.incrementalSpendUsdCents, 0);

  // Replay historical receipt self-consistently from its recorded snapshot digests (independent of future checkout edits)
  const {
    packageJsonSha256,
    packageLockSha256,
    globalJsonSha256,
    appHostSha256,
    agentsCsprojSha256
  } = receipt.lockedInputDigests;
  for (const recordedDigest of [
    packageJsonSha256,
    packageLockSha256,
    globalJsonSha256,
    appHostSha256,
    agentsCsprojSha256
  ]) {
    assert.match(recordedDigest, /^[a-f0-9]{64}$/);
  }
  assert.deepEqual(receipt.exactLockCacheSafety.aspireCliNupkgSha256, {
    'aspire.cli.17.0.0.nupkg': '31599e3906c24c5b05787651ac52859ca0e267973ff2bb9f38ca5f968e355f1d',
    'aspire.cli.linux-x64.17.0.0.nupkg': 'e82a0663bc83b4cccd1c23403baa45eef2141a889e84f97030e50c21f3f5781f',
    'aspire.cli.win-x64.17.0.0.nupkg': '590e1d28d581fd532fa24a60a2adef8792cb3bd438585f57879551fc510458ea'
  });

  for (const [label, osName] of [['linux', 'linux'], ['windows', 'windows']]) {
    const manifest = buildExactInputCacheManifest({
      repositoryId: 1471342715,
      repository: 'Jamula/SoftwareFactory',
      trustedSource: true,
      isFork: false,
      branchProtected: true,
      os: osName,
      arch: 'x64',
      toolchain: {
        node: receipt.toolchain.node,
        dotnet: receipt.toolchain.dotnet,
        aspireCli: receipt.toolchain.aspireCli
      },
      packageJsonSha256,
      packageLockSha256,
      globalJsonSha256,
      appHostSha256
    });
    assert.equal(manifest.valid, true);
    assert.equal(manifest.allowProtectedCacheWrite, true);
    assert.equal(manifest.skipRequiredChecks, false);
    assert.deepEqual(manifest.keys, receipt.exactLockCacheSafety.manifestKeys[label]);
    assert.deepEqual(
      {
        npmCi: manifest.entries.npm.lockedKey,
        nugetApphost: manifest.entries.nuget.lockedKey,
        aspireCli: manifest.entries['aspire-cli'].lockedKey
      },
      receipt.exactLockCacheSafety.derivedKeys[label]
    );
  }

  // Replay Aspire stage breakdown on ec438f5 Linux & Windows runs
  const linuxAnalysis = analyzeAspireRuntimeStages(receipt.aspireStageBaseline.linux.sample);
  const windowsAnalysis = analyzeAspireRuntimeStages(receipt.aspireStageBaseline.windows.sample);
  assert.deepEqual(linuxAnalysis, receipt.aspireStageBaseline.linux.analysis);
  assert.deepEqual(windowsAnalysis, receipt.aspireStageBaseline.windows.analysis);
  assert.equal(linuxAnalysis.dominantStage, 'restoreBuildMs');
  assert.equal(windowsAnalysis.dominantStage, 'restoreBuildMs');
  assert.equal(windowsAnalysis.meetsWindowsProvisionalTarget, false);

  // Replay 5-PR cold critical-path cohort
  const criticalPath = evaluateCiCriticalPath(receipt.coldPullRequestCohort.runs);
  assert.equal(criticalPath.valid, true);
  assert.equal(criticalPath.sloIsTimeoutOrGateWaiver, false);
  assert.equal(criticalPath.skipRequiredChecks, false);
  assert.deepEqual(
    {
      valid: criticalPath.valid,
      reason: criticalPath.reason,
      sampleCount: criticalPath.sampleCount,
      p50Ms: criticalPath.p50Ms,
      p95Ms: criticalPath.p95Ms,
      p50MeetsStandardTarget: criticalPath.p50MeetsStandardTarget,
      p50MeetsStretchTarget: criticalPath.p50MeetsStretchTarget,
      sloMissCount: criticalPath.sloMissCount,
      firstJobStartToLastCheckMs: criticalPath.firstJobStartToLastCheckMs,
      runnerQueueWaitMs: criticalPath.runnerQueueWaitMs
    },
    receipt.coldPullRequestCohort.summary
  );
});
