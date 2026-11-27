import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_HUMAN_EXCEPTION_CATEGORIES,
  ALLOWED_PR_STATES,
  ALLOWED_PUBLICATION_SOURCES,
  ALLOWED_SAMPLE_PROVENANCES,
  DEFAULT_FACTORY_REPOSITORY_ID,
  PARALLEL_STAGE_KEYS,
  PR_MERGE_LATENCY_SLO_TARGETS,
  STAGE_ATTRIBUTION_KEYS,
  evaluatePullMergeLatencySample,
  evaluatePullMergeLatencySlo
} from '../../tools/engineering-factory/merge-queue-slo.mjs';

const HEAD_1 = '1'.repeat(40);
const HEAD_2 = '2'.repeat(40);
const HEAD_3 = '3'.repeat(40);

function completeCohortOptions(overrides = {}) {
  return {
    repositoryId: DEFAULT_FACTORY_REPOSITORY_ID,
    provenance: 'github-timeline',
    cohort: 'small-pr-slice',
    fromMs: 900_000,
    toMs: 1_250_000,
    observedAt: 1_300_000,
    nowMs: 1_320_000,
    maxAgeMs: 60_000,
    sourceComplete: true,
    ...overrides
  };
}

function baseDraftSample(overrides = {}) {
  return {
    prNumber: 101,
    repositoryId: DEFAULT_FACTORY_REPOSITORY_ID,
    provenance: 'github-timeline',
    historyComplete: true,
    creationStateVerified: true,
    publicationSource: 'timeline',
    createdAsDraft: true,
    createdAt: 1_000_000,
    observedAt: 1_300_000,
    publicationEvents: [{type: 'published', at: 1_045_000}],
    headCommits: [{sha: HEAD_1, at: 1_000_000}],
    eligibilityTimestamps: [1_180_000],
    enqueuedAt: 1_185_000,
    retryTimestamps: [],
    mergedAt: 1_205_000,
    mainVerifiedAt: 1_235_000,
    humanTouchesComplete: true,
    humanTouches: [],
    stages: {
      ciQueueWaitMs: 6_000,
      linuxRuntimeMs: 52_000,
      windowsRuntimeMs: 116_000,
      securityScanMs: 44_000,
      reviewReworkMs: 38_000,
      publicationIdleMs: 12_000,
      eligibilityToEnqueueMs: 5_000,
      mergeQueueRevalidationMs: 20_000,
      mainVerificationMs: 30_000
    },
    ...overrides
  };
}

function baseReadySample(overrides = {}) {
  return baseDraftSample({
    prNumber: 102,
    publicationSource: 'creation-state',
    createdAsDraft: false,
    publicationEvents: [],
    ...overrides
  });
}

test('exports frozen #8 SLO targets, stage attribution keys, and provenance allowlists', () => {
  assert.equal(Object.isFrozen(PR_MERGE_LATENCY_SLO_TARGETS), true);
  assert.equal(Object.isFrozen(STAGE_ATTRIBUTION_KEYS), true);
  assert.equal(Object.isFrozen(PARALLEL_STAGE_KEYS), true);
  assert.equal(Object.isFrozen(ALLOWED_SAMPLE_PROVENANCES), true);
  assert.equal(Object.isFrozen(ALLOWED_PR_STATES), true);
  assert.equal(Object.isFrozen(ALLOWED_PUBLICATION_SOURCES), true);
  assert.equal(Object.isFrozen(ALLOWED_HUMAN_EXCEPTION_CATEGORIES), true);

  assert.deepEqual(PR_MERGE_LATENCY_SLO_TARGETS.draftToPublishMs, {
    targetMs: 180_000,
    stretchMs: 60_000,
    primaryQuantile: 'p50',
    openAgeKey: 'openDraftAgeMs'
  });
  assert.deepEqual(PR_MERGE_LATENCY_SLO_TARGETS.publishToMergeMs, {
    targetMs: 420_000,
    stretchMs: 180_000,
    primaryQuantile: 'p50',
    openAgeKey: 'openPublishedAgeMs'
  });
  assert.deepEqual(PR_MERGE_LATENCY_SLO_TARGETS.creationToMergeMs, {
    targetMs: 600_000,
    stretchMs: 240_000,
    primaryQuantile: 'p50',
    openAgeKey: 'openAgeMs'
  });
  assert.deepEqual(PR_MERGE_LATENCY_SLO_TARGETS.eligibleToMergeMs, {
    targetMs: 120_000,
    stretchMs: 30_000,
    primaryQuantile: 'p95',
    openAgeKey: 'openEligibleAgeMs'
  });
  assert.deepEqual(PR_MERGE_LATENCY_SLO_TARGETS.mergeToVerifiedMainMs, {
    targetMs: 120_000,
    stretchMs: 60_000,
    primaryQuantile: 'p50',
    openAgeKey: 'verificationPendingAgeMs'
  });
});

test('measures draft-to-publish as 0 ONLY with explicit verified createdAsDraft === false evidence', () => {
  const ready = evaluatePullMergeLatencySample(baseReadySample());
  assert.equal(ready.valid, true);
  assert.equal(ready.draftToPublishMs, 0);
  assert.equal(ready.publishToMergeMs, 205_000);
  assert.equal(ready.creationToMergeMs, 205_000);
  assert.equal(ready.eligibleToMergeMs, 25_000);
  assert.equal(ready.mergeToVerifiedMainMs, 30_000);

  const draftAtSameTimestamp = evaluatePullMergeLatencySample(baseDraftSample({
    publicationEvents: [{type: 'published', at: 1_000_000}]
  }));
  assert.equal(draftAtSameTimestamp.valid, false);
  assert.equal(draftAtSameTimestamp.reason, 'INVALID_TIMELINE_ORDER');

  const draftClaimingCreationState = evaluatePullMergeLatencySample(baseDraftSample({
    publicationSource: 'creation-state'
  }));
  assert.equal(draftClaimingCreationState.valid, false);
  assert.equal(draftClaimingCreationState.reason, 'PUBLICATION_EVIDENCE_UNKNOWN');

  for (const bad of [
    baseReadySample({creationStateVerified: false}),
    baseReadySample({createdAsDraft: null})
  ]) {
    const res = evaluatePullMergeLatencySample(bad);
    assert.equal(res.valid, false);
    assert.equal(res.reason, 'CREATION_STATE_UNVERIFIED');
  }
});

test('forbids updated_at / updatedAt publication inference fail-closed', () => {
  for (const bad of [
    {...baseDraftSample(), updated_at: 1_045_000},
    {...baseDraftSample(), updatedAt: 1_045_000},
    baseDraftSample({publicationSource: 'updated_at'}),
    baseDraftSample({provenance: 'updated_at'})
  ]) {
    const sampleRes = evaluatePullMergeLatencySample(bad);
    assert.equal(sampleRes.valid, false);
    assert.equal(sampleRes.reason, 'UPDATED_AT_FORBIDDEN');

    const cohortRes = evaluatePullMergeLatencySlo([bad]);
    assert.equal(cohortRes.valid, false);
    assert.equal(cohortRes.sloMet, null);
    assert.equal(cohortRes.reason, 'UPDATED_AT_FORBIDDEN');
  }
});

test('never resets lifecycle clocks on head updates, re-drafting, re-eligibility, or retries', () => {
  const reworkedDraft = baseDraftSample({
    prNumber: 201,
    createdAt: 0,
    observedAt: 600_000,
    publicationEvents: [
      {type: 'published', at: 50_000},
      {type: 'redrafted', at: 110_000},
      {type: 'published', at: 190_000},
      {type: 'redrafted', at: 210_000},
      {type: 'published', at: 250_000}
    ],
    headCommits: [
      {sha: HEAD_1, at: 0},
      {sha: HEAD_2, at: 130_000},
      {sha: HEAD_3, at: 230_000},
      {sha: HEAD_1, at: 245_000}
    ],
    eligibilityTimestamps: [200_000, 290_000],
    enqueuedAt: 295_000,
    retryTimestamps: [140_000, 260_000],
    mergedAt: 315_000,
    mainVerifiedAt: 355_000,
    stages: {
      ciQueueWaitMs: 9_000,
      linuxRuntimeMs: 54_000,
      windowsRuntimeMs: 118_000,
      securityScanMs: 49_000,
      reviewReworkMs: 120_000,
      publicationIdleMs: 15_000,
      eligibilityToEnqueueMs: 95_000,
      mergeQueueRevalidationMs: 20_000,
      mainVerificationMs: 40_000
    }
  });

  const reworkedReady = baseReadySample({
    prNumber: 202,
    publicationSource: 'timeline',
    createdAt: 0,
    observedAt: 400_000,
    publicationEvents: [
      {type: 'redrafted', at: 40_000},
      {type: 'published', at: 90_000}
    ],
    headCommits: [
      {sha: HEAD_1, at: 0},
      {sha: HEAD_2, at: 60_000}
    ],
    eligibilityTimestamps: [120_000],
    enqueuedAt: 125_000,
    retryTimestamps: [80_000],
    mergedAt: 145_000,
    mainVerifiedAt: 175_000,
    stages: {
      ciQueueWaitMs: 4_000,
      linuxRuntimeMs: 50_000,
      windowsRuntimeMs: 95_000,
      securityScanMs: 40_000,
      reviewReworkMs: 35_000,
      publicationIdleMs: 0,
      eligibilityToEnqueueMs: 5_000,
      mergeQueueRevalidationMs: 20_000,
      mainVerificationMs: 30_000
    }
  });

  const report = evaluatePullMergeLatencySlo([reworkedDraft, reworkedReady]);
  assert.equal(report.valid, true);
  assert.equal(report.rework.clockResetsApplied, 0);

  const [first, second] = report.samples;
  assert.equal(first.draftToPublishMs, 50_000);
  assert.equal(first.publishToMergeMs, 265_000);
  assert.equal(first.creationToMergeMs, 315_000);
  assert.equal(first.eligibleToMergeMs, 115_000);
  assert.equal(first.mergeToVerifiedMainMs, 40_000);
  assert.equal(first.headChangesCount, 3);
  assert.equal(first.distinctHeadCount, 3);
  assert.equal(first.redraftCount, 2);
  assert.equal(first.republishCount, 2);
  assert.equal(first.reeligibilityCount, 1);
  assert.equal(first.retryCount, 2);

  assert.equal(second.draftToPublishMs, 0);
  assert.equal(second.publishToMergeMs, 145_000);
  assert.equal(second.creationToMergeMs, 145_000);
  assert.equal(second.eligibleToMergeMs, 25_000);
  assert.equal(second.headChangesCount, 1);
  assert.equal(second.redraftCount, 1);
  assert.equal(second.republishCount, 1);

  assert.equal(report.headChangesCount, 4);
  assert.equal(report.redraftCount, 3);
  assert.deepEqual(report.rework, {
    headChangesCount: 4,
    redraftCount: 3,
    republishCount: 3,
    reeligibilityCount: 1,
    retryCount: 3,
    prsWithHeadChangesCount: 2,
    prsWithRedraftCount: 2,
    clockResetsApplied: 0
  });
});

test('keeps parallel stage attribution non-additive and preserves null for unmeasured stages', () => {
  const sample = baseDraftSample({
    createdAt: 0,
    observedAt: 300_000,
    publicationEvents: [{type: 'published', at: 30_000}],
    headCommits: [{sha: HEAD_1, at: 0}],
    eligibilityTimestamps: [160_000],
    enqueuedAt: null,
    mergedAt: 185_000,
    mainVerifiedAt: 215_000,
    stages: {
      ciQueueWaitMs: 10_000,
      linuxRuntimeMs: 55_000,
      windowsRuntimeMs: 120_000,
      securityScanMs: 48_000,
      reviewReworkMs: null,
      publicationIdleMs: 8_000,
      eligibilityToEnqueueMs: 5_000,
      mergeQueueRevalidationMs: 20_000,
      mainVerificationMs: 30_000
    }
  });
  const unmeasuredAllParallel = baseReadySample({
    prNumber: 305,
    createdAt: 0,
    observedAt: 250_000,
    headCommits: [{sha: HEAD_1, at: 0}],
    eligibilityTimestamps: [130_000],
    enqueuedAt: null,
    mergedAt: 150_000,
    mainVerifiedAt: 170_000,
    stages: {
      ciQueueWaitMs: null,
      linuxRuntimeMs: null,
      windowsRuntimeMs: null,
      securityScanMs: null,
      reviewReworkMs: null,
      publicationIdleMs: null,
      eligibilityToEnqueueMs: null,
      mergeQueueRevalidationMs: null,
      mainVerificationMs: null
    }
  });

  const report = evaluatePullMergeLatencySlo([sample, unmeasuredAllParallel], {
    repositoryId: DEFAULT_FACTORY_REPOSITORY_ID,
    provenance: 'github-timeline',
    cohort: 'small-pr-slice',
    fromMs: 0,
    toMs: 250_000,
    observedAt: 300_000,
    nowMs: 320_000,
    maxAgeMs: 60_000,
    sourceComplete: true
  });
  assert.equal(report.valid, true);
  assert.equal(report.known, true);
  assert.equal(report.status, 'complete');
  assert.equal(report.sourceComplete, true);
  assert.equal(report.fromMs, 0);
  assert.equal(report.toMs, 250_000);
  assert.equal(report.observedMs, 300_000);
  assert.equal(report.sloMet, true);
  assert.equal(report.stretchMet, true);
  assert.equal(report.reason, 'SLO_MET');
  assert.equal(report.cohort, 'small-pr-slice');

  const parallelSum = 10_000 + 55_000 + 120_000 + 48_000;
  assert.equal(parallelSum > report.samples[0].creationToMergeMs, true);
  assert.equal(report.samples[0].stageAttribution.additiveWallClock, false);
  assert.equal(report.samples[0].stageAttribution.parallelStagesOverlap, true);
  assert.equal(report.samples[0].stageAttribution.summedWallClockMs, null);
  assert.equal(report.samples[0].stageAttribution.parallelEnvelopeMaxMs, 120_000);
  assert.equal(report.samples[1].stageAttribution.parallelEnvelopeMaxMs, null);

  assert.equal(report.stageAttribution.additiveWallClock, false);
  assert.equal(report.stageAttribution.summedWallClockMs, null);
  assert.deepEqual(report.stageAttribution.stages.windowsRuntimeMs, {
    stage: 'windowsRuntimeMs',
    parallel: true,
    sampleCount: 1,
    unknownCount: 1,
    p50Ms: 120_000,
    p95Ms: 120_000,
    maxMs: 120_000
  });
  assert.deepEqual(report.stageAttribution.stages.reviewReworkMs, {
    stage: 'reviewReworkMs',
    parallel: true,
    sampleCount: 0,
    unknownCount: 2,
    p50Ms: null,
    p95Ms: null,
    maxMs: null
  });
  assert.equal(report.stageAttribution.stages.mainVerificationMs.parallel, false);
});

test('records right-censored open PR ages, closed-unmerged PRs, pending main verification, and overdue open breaches', () => {
  const openDraft = baseDraftSample({
    prNumber: 401,
    state: 'open',
    closedAt: null,
    createdAt: 220_000,
    observedAt: 260_000,
    publicationEvents: [],
    headCommits: [{sha: HEAD_1, at: 220_000}],
    eligibilityTimestamps: [],
    enqueuedAt: null,
    mergedAt: null,
    mainVerifiedAt: null,
    stages: {
      ciQueueWaitMs: 3_000,
      linuxRuntimeMs: null,
      windowsRuntimeMs: null,
      securityScanMs: null,
      reviewReworkMs: null,
      publicationIdleMs: 10_000,
      eligibilityToEnqueueMs: null,
      mergeQueueRevalidationMs: null,
      mainVerificationMs: null
    }
  });
  const openEligible = baseDraftSample({
    prNumber: 402,
    createdAt: 150_000,
    observedAt: 260_000,
    publicationEvents: [{type: 'published', at: 170_000}],
    headCommits: [{sha: HEAD_1, at: 150_000}],
    eligibilityTimestamps: [215_000],
    enqueuedAt: 220_000,
    mergedAt: null,
    mainVerifiedAt: null,
    stages: {
      ciQueueWaitMs: 4_000,
      linuxRuntimeMs: 40_000,
      windowsRuntimeMs: null,
      securityScanMs: 35_000,
      reviewReworkMs: 20_000,
      publicationIdleMs: 5_000,
      eligibilityToEnqueueMs: 5_000,
      mergeQueueRevalidationMs: null,
      mainVerificationMs: null
    }
  });
  const pendingVerify = baseDraftSample({
    prNumber: 403,
    state: 'merged',
    closedAt: 220_000,
    createdAt: 100_000,
    observedAt: 260_000,
    publicationEvents: [{type: 'published', at: 130_000}],
    headCommits: [{sha: HEAD_1, at: 100_000}],
    eligibilityTimestamps: [200_000],
    enqueuedAt: 205_000,
    mergedAt: 220_000,
    mainVerifiedAt: null,
    stages: {
      ciQueueWaitMs: 4_000,
      linuxRuntimeMs: 45_000,
      windowsRuntimeMs: 65_000,
      securityScanMs: 38_000,
      reviewReworkMs: 25_000,
      publicationIdleMs: 5_000,
      eligibilityToEnqueueMs: 5_000,
      mergeQueueRevalidationMs: 15_000,
      mainVerificationMs: null
    }
  });
  const abandonedDraft = baseDraftSample({
    prNumber: 406,
    state: 'closed-unmerged',
    closedAt: 120_000,
    createdAt: 100_000,
    observedAt: 260_000,
    publicationEvents: [],
    headCommits: [{sha: HEAD_1, at: 100_000}],
    eligibilityTimestamps: [],
    enqueuedAt: null,
    mergedAt: null,
    mainVerifiedAt: null,
    stages: {
      ciQueueWaitMs: 2_000,
      linuxRuntimeMs: null,
      windowsRuntimeMs: null,
      securityScanMs: null,
      reviewReworkMs: null,
      publicationIdleMs: null,
      eligibilityToEnqueueMs: null,
      mergeQueueRevalidationMs: null,
      mainVerificationMs: null
    }
  });

  const openWindowOpts = completeCohortOptions({
    fromMs: 90_000,
    toMs: 250_000,
    observedAt: 260_000,
    nowMs: 270_000,
    maxAgeMs: 60_000
  });
  const incomplete = evaluatePullMergeLatencySlo(
    [openDraft, openEligible, pendingVerify, abandonedDraft],
    openWindowOpts
  );
  assert.equal(incomplete.valid, true);
  assert.equal(incomplete.sloMet, null);
  assert.equal(incomplete.stretchMet, false);
  assert.equal(incomplete.reason, 'SLO_INCOMPLETE');
  assert.equal(incomplete.counts.openCensoredCount, 2);
  assert.equal(incomplete.counts.closedUnmergedCount, 1);
  assert.equal(incomplete.counts.verificationPendingCount, 1);
  assert.equal(incomplete.openPullRequests.length, 3);
  assert.deepEqual(incomplete.closedUnmergedPullRequests, [{
    prNumber: 406,
    createdAsDraft: true,
    currentlyDraft: true,
    closedAt: 120_000,
    timeToCloseUnmergedMs: 20_000
  }]);
  assert.deepEqual(incomplete.openPullRequests[0], {
    prNumber: 401,
    currentlyDraft: true,
    openAgeMs: 40_000,
    openDraftAgeMs: 40_000,
    openPublishedAgeMs: null,
    openEligibleAgeMs: null,
    verificationPendingAgeMs: null
  });
  assert.deepEqual(incomplete.openPullRequests[1], {
    prNumber: 402,
    currentlyDraft: false,
    openAgeMs: 110_000,
    openDraftAgeMs: null,
    openPublishedAgeMs: 90_000,
    openEligibleAgeMs: 45_000,
    verificationPendingAgeMs: null
  });
  assert.deepEqual(incomplete.openPullRequests[2], {
    prNumber: 403,
    currentlyDraft: false,
    openAgeMs: null,
    openDraftAgeMs: null,
    openPublishedAgeMs: null,
    openEligibleAgeMs: null,
    verificationPendingAgeMs: 40_000
  });

  const freshOpenOnly = evaluatePullMergeLatencySlo([openDraft], openWindowOpts);
  assert.equal(freshOpenOnly.sloMet, null);
  assert.equal(freshOpenOnly.stretchMet, null);
  assert.equal(freshOpenOnly.metrics.publishToMergeMs.unreachedCount, 1);
  assert.equal(freshOpenOnly.metrics.publishToMergeMs.missRate, null);

  const closedUnmergedLongAgo = evaluatePullMergeLatencySlo([
    baseDraftSample({prNumber: 407}),
    {...abandonedDraft, prNumber: 408, createdAt: 910_000, closedAt: 930_000, observedAt: 1_300_000,
      headCommits: [{sha: HEAD_1, at: 910_000}]}
  ], completeCohortOptions());
  assert.equal(closedUnmergedLongAgo.sloMet, true);
  assert.equal(closedUnmergedLongAgo.counts.closedUnmergedCount, 1);
  assert.equal(closedUnmergedLongAgo.counts.openCensoredCount, 0);
  assert.equal(closedUnmergedLongAgo.metrics.draftToPublishMs.closedUnmergedCount, 1);
  assert.equal(closedUnmergedLongAgo.metrics.creationToMergeMs.closedUnmergedCount, 1);
  assert.equal(closedUnmergedLongAgo.metrics.creationToMergeMs.overdueOpenCount, 0);

  const publishedLateThenClosedUnmerged = evaluatePullMergeLatencySlo([
    baseDraftSample({prNumber: 409, createdAt: 300_000, publicationEvents: [{type: 'published', at: 330_000}],
      headCommits: [{sha: HEAD_1, at: 300_000}]}),
    baseDraftSample({
      prNumber: 410,
      state: 'closed-unmerged',
      closedAt: 950_000,
      createdAt: 300_000,
      observedAt: 1_300_000,
      publicationEvents: [{type: 'published', at: 900_000}],
      headCommits: [{sha: HEAD_1, at: 300_000}],
      eligibilityTimestamps: [],
      enqueuedAt: null,
      mergedAt: null,
      mainVerifiedAt: null,
      stages: {
        ciQueueWaitMs: 5_000,
        linuxRuntimeMs: 45_000,
        windowsRuntimeMs: null,
        securityScanMs: 30_000,
        reviewReworkMs: null,
        publicationIdleMs: 500_000,
        eligibilityToEnqueueMs: null,
        mergeQueueRevalidationMs: null,
        mainVerificationMs: null
      }
    }),
    baseDraftSample({
      prNumber: 411,
      state: 'closed-unmerged',
      closedAt: 960_000,
      createdAt: 310_000,
      observedAt: 1_300_000,
      publicationEvents: [{type: 'published', at: 910_000}],
      headCommits: [{sha: HEAD_1, at: 310_000}],
      eligibilityTimestamps: [],
      enqueuedAt: null,
      mergedAt: null,
      mainVerifiedAt: null,
      stages: {
        ciQueueWaitMs: 5_000,
        linuxRuntimeMs: 45_000,
        windowsRuntimeMs: null,
        securityScanMs: 30_000,
        reviewReworkMs: null,
        publicationIdleMs: 500_000,
        eligibilityToEnqueueMs: null,
        mergeQueueRevalidationMs: null,
        mainVerificationMs: null
      }
    })
  ], completeCohortOptions({fromMs: 250_000}));
  assert.equal(publishedLateThenClosedUnmerged.metrics.draftToPublishMs.sampleCount, 3);
  assert.equal(publishedLateThenClosedUnmerged.metrics.draftToPublishMs.targetMissCount, 2);
  assert.equal(publishedLateThenClosedUnmerged.metrics.draftToPublishMs.meetsTarget, false);
  assert.equal(publishedLateThenClosedUnmerged.metrics.creationToMergeMs.closedUnmergedCount, 2);
  assert.equal(publishedLateThenClosedUnmerged.metrics.creationToMergeMs.overdueOpenCount, 0);
  assert.equal(publishedLateThenClosedUnmerged.sloMet, false);
  assert.equal(publishedLateThenClosedUnmerged.reason, 'SLO_MISSED');

  const stalledOpen = evaluatePullMergeLatencySlo([
    baseDraftSample({prNumber: 404}),
    {
      ...openDraft,
      prNumber: 405,
      createdAt: 600_000,
      observedAt: 1_300_000,
      headCommits: [{sha: HEAD_1, at: 600_000}]
    }
  ], completeCohortOptions({fromMs: 500_000}));
  assert.equal(stalledOpen.sloMet, false);
  assert.equal(stalledOpen.reason, 'SLO_MISSED');
  assert.equal(stalledOpen.metrics.draftToPublishMs.overdueOpenCount, 1);
  assert.equal(stalledOpen.metrics.creationToMergeMs.overdueOpenCount, 1);
});

test('distinguishes routine human interventions from documented governance exceptions and evaluates p95 eligibleToMergeMs', () => {
  const withApprovedException = baseDraftSample({
    prNumber: 501,
    humanTouches: [{
      kind: 'exception',
      category: 'authorization',
      at: 1_190_000,
      summary: 'Protected workflow permission approval required',
      attemptedRemediation: 'Verified read-only shadow adapter and exact-head checks',
      requiredIntervention: 'Owner ruleset authorization sign-off'
    }]
  });

  const partialWithoutWindow = evaluatePullMergeLatencySlo([withApprovedException]);
  assert.equal(partialWithoutWindow.valid, true);
  assert.equal(partialWithoutWindow.known, false);
  assert.equal(partialWithoutWindow.status, 'partial');
  assert.equal(partialWithoutWindow.sloMet, null);
  assert.equal(partialWithoutWindow.stretchMet, null);
  assert.equal(partialWithoutWindow.reason, 'PARTIAL_COHORT_EVIDENCE');

  const partialExplicitFlag = evaluatePullMergeLatencySlo(
    [withApprovedException],
    completeCohortOptions({sourceComplete: false})
  );
  assert.equal(partialExplicitFlag.valid, true);
  assert.equal(partialExplicitFlag.known, false);
  assert.equal(partialExplicitFlag.status, 'partial');
  assert.equal(partialExplicitFlag.sloMet, null);
  assert.equal(partialExplicitFlag.reason, 'PARTIAL_COHORT_EVIDENCE');

  const exceptionCohort = evaluatePullMergeLatencySlo([withApprovedException], completeCohortOptions());
  assert.equal(exceptionCohort.valid, true);
  assert.equal(exceptionCohort.sloMet, true);
  assert.equal(exceptionCohort.humanTouchesComplete, true);
  assert.equal(exceptionCohort.humanTouchesCount, 1);
  assert.equal(exceptionCohort.routineHumanTouchesCount, 0);
  assert.equal(exceptionCohort.exceptionHumanTouchesCount, 1);
  assert.equal(exceptionCohort.zeroRoutineHumanTouchesMet, true);
  assert.equal(exceptionCohort.counts.unattendedMergedCount, 1);
  assert.equal(exceptionCohort.counts.unknownHumanTouchesCount, 0);
  assert.equal(exceptionCohort.humanTouches.exceptions.length, 1);

  const untrackedEmpty = baseDraftSample({
    prNumber: 503,
    humanTouchesComplete: false,
    humanTouches: []
  });
  const untrackedNull = baseDraftSample({
    prNumber: 504,
    humanTouchesComplete: false,
    humanTouches: null
  });
  const untrackedCohort = evaluatePullMergeLatencySlo(
    [untrackedEmpty, untrackedNull],
    completeCohortOptions()
  );
  assert.equal(untrackedCohort.valid, true);
  assert.equal(untrackedCohort.known, true);
  assert.equal(untrackedCohort.humanTouchesComplete, false);
  assert.equal(untrackedCohort.humanTouchesCount, null);
  assert.equal(untrackedCohort.routineHumanTouchesCount, null);
  assert.equal(untrackedCohort.exceptionHumanTouchesCount, null);
  assert.equal(untrackedCohort.zeroRoutineHumanTouchesMet, null);
  assert.equal(untrackedCohort.counts.unattendedMergedCount, 0);
  assert.equal(untrackedCohort.counts.unknownUnattendedMergedCount, 2);
  assert.equal(untrackedCohort.counts.unknownHumanTouchesCount, 2);
  assert.equal(untrackedCohort.sloMet, null);
  assert.equal(untrackedCohort.stretchMet, null);
  assert.equal(untrackedCohort.reason, 'SLO_INCOMPLETE');

  const partialTrackingWithRoutineBreach = evaluatePullMergeLatencySlo([
    baseDraftSample({
      prNumber: 505,
      humanTouchesComplete: false,
      humanTouches: [{
        kind: 'routine',
        at: 1_205_000,
        summary: 'Observed manual merge while audit log still syncing'
      }]
    })
  ], completeCohortOptions());
  assert.equal(partialTrackingWithRoutineBreach.zeroRoutineHumanTouchesMet, false);
  assert.equal(partialTrackingWithRoutineBreach.samples[0].unattendedMerge, false);
  assert.equal(partialTrackingWithRoutineBreach.sloMet, false);
  assert.equal(partialTrackingWithRoutineBreach.reason, 'SLO_MISSED');

  const manualMerge = baseDraftSample({
    prNumber: 502,
    eligibilityTimestamps: [],
    enqueuedAt: null,
    stages: {
      ...baseDraftSample().stages,
      eligibilityToEnqueueMs: null
    },
    humanTouches: [{
      kind: 'routine',
      at: 1_205_000,
      summary: 'Owner manually squash-merged pull request'
    }]
  });
  const manualCohort = evaluatePullMergeLatencySlo(
    [withApprovedException, manualMerge],
    completeCohortOptions()
  );
  assert.equal(manualCohort.valid, true);
  assert.equal(manualCohort.metrics.eligibleToMergeMs.unknownCount, 1);
  assert.equal(manualCohort.metrics.eligibleToMergeMs.meetsTarget, null);
  assert.equal(manualCohort.sloMet, false);
  assert.equal(manualCohort.reason, 'SLO_MISSED');
  assert.equal(manualCohort.routineHumanTouchesCount, 1);
  assert.equal(manualCohort.zeroRoutineHumanTouchesMet, false);
  assert.equal(manualCohort.counts.unattendedMergedCount, 1);

  const missingEligibilityNoBreach = evaluatePullMergeLatencySlo([
    withApprovedException,
    baseDraftSample({
      prNumber: 506,
      eligibilityTimestamps: [],
      enqueuedAt: null,
      stages: {
        ...baseDraftSample().stages,
        eligibilityToEnqueueMs: null
      }
    })
  ], completeCohortOptions());
  assert.equal(missingEligibilityNoBreach.metrics.eligibleToMergeMs.sampleCount, 1);
  assert.equal(missingEligibilityNoBreach.metrics.eligibleToMergeMs.unknownCount, 1);
  assert.equal(missingEligibilityNoBreach.metrics.eligibleToMergeMs.p95MeetsTarget, null);
  assert.equal(missingEligibilityNoBreach.metrics.eligibleToMergeMs.meetsTarget, null);
  assert.equal(missingEligibilityNoBreach.metrics.eligibleToMergeMs.meetsStretch, null);
  assert.equal(missingEligibilityNoBreach.sloMet, null);
  assert.equal(missingEligibilityNoBreach.stretchMet, null);
  assert.equal(missingEligibilityNoBreach.reason, 'SLO_INCOMPLETE');

  const p95BreachSamples = Array.from({length: 18}, (_, index) => baseDraftSample({
    prNumber: 600 + index,
    eligibilityTimestamps: [1_180_000],
    enqueuedAt: 1_182_000,
    mergedAt: 1_205_000,
    mainVerifiedAt: 1_235_000,
    stages: {
      ...baseDraftSample().stages,
      eligibilityToEnqueueMs: 2_000
    }
  }));
  for (const prNumber of [698, 699]) {
    p95BreachSamples.push(baseDraftSample({
      prNumber,
      eligibilityTimestamps: [1_050_000],
      enqueuedAt: 1_055_000,
      mergedAt: 1_205_000,
      mainVerifiedAt: 1_235_000,
      stages: {
        ...baseDraftSample().stages,
        eligibilityToEnqueueMs: 5_000
      }
    }));
  }
  const p95Cohort = evaluatePullMergeLatencySlo(p95BreachSamples, completeCohortOptions());
  assert.equal(p95Cohort.metrics.eligibleToMergeMs.p50Ms, 25_000);
  assert.equal(p95Cohort.metrics.eligibleToMergeMs.p95Ms, 155_000);
  assert.equal(p95Cohort.metrics.eligibleToMergeMs.p50MeetsTarget, true);
  assert.equal(p95Cohort.metrics.eligibleToMergeMs.p95MeetsTarget, false);
  assert.equal(p95Cohort.metrics.eligibleToMergeMs.meetsTarget, false);
  assert.equal(p95Cohort.metrics.eligibleToMergeMs.missRate, 2 / 20);
  assert.equal(p95Cohort.sloMet, false);

  const targetOnlySample = baseDraftSample({
    prNumber: 700,
    publicationEvents: [{type: 'published', at: 1_120_000}],
    eligibilityTimestamps: [1_160_000],
    enqueuedAt: 1_165_000,
    mergedAt: 1_205_000,
    mainVerifiedAt: 1_275_000,
    stages: {
      ...baseDraftSample().stages,
      eligibilityToEnqueueMs: 5_000,
      mainVerificationMs: 70_000
    }
  });
  const targetMetStretchMissed = evaluatePullMergeLatencySlo(
    [targetOnlySample],
    completeCohortOptions()
  );
  assert.equal(targetMetStretchMissed.sloMet, true);
  assert.equal(targetMetStretchMissed.stretchMet, false);
});

test('rejects proxies, getters, custom prototypes, sparse arrays, symbol keys, and malformed inputs without invoking getters', () => {
  let getterReads = 0;
  const trappedSample = baseDraftSample();
  Object.defineProperty(trappedSample, 'createdAt', {
    enumerable: true,
    get() {
      getterReads++;
      throw new Error('sample getter should never run');
    }
  });
  assert.equal(evaluatePullMergeLatencySample(trappedSample).reason, 'INVALID_SAMPLE');

  const trappedOptions = {};
  Object.defineProperty(trappedOptions, 'repositoryId', {
    enumerable: true,
    get() {
      getterReads++;
      throw new Error('options getter should never run');
    }
  });
  assert.equal(evaluatePullMergeLatencySlo([baseDraftSample()], trappedOptions).reason, 'INVALID_OPTIONS');

  const trappedStages = {...baseDraftSample().stages};
  Object.defineProperty(trappedStages, 'ciQueueWaitMs', {
    enumerable: true,
    get() {
      getterReads++;
      throw new Error('stage getter should never run');
    }
  });
  assert.equal(evaluatePullMergeLatencySample(baseDraftSample({stages: trappedStages})).reason, 'STAGE_ATTRIBUTION_UNKNOWN');

  const trappedSamples = [baseDraftSample()];
  Object.defineProperty(trappedSamples, '0', {
    enumerable: true,
    get() {
      getterReads++;
      throw new Error('array getter should never run');
    }
  });
  assert.equal(evaluatePullMergeLatencySlo(trappedSamples).reason, 'INVALID_SAMPLES');
  assert.equal(getterReads, 0);

  let coercionReads = 0;
  const coercionTrap = () => ({
    valueOf() {
      coercionReads++;
      throw new Error('valueOf coercion should never run');
    },
    [Symbol.toPrimitive]() {
      coercionReads++;
      throw new Error('Symbol.toPrimitive coercion should never run');
    }
  });
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({createdAt: coercionTrap()})).reason,
    'HISTORY_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({observedAt: coercionTrap()})).reason,
    'HISTORY_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({mergedAt: coercionTrap()})).reason,
    'MERGE_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({mainVerifiedAt: coercionTrap()})).reason,
    'VERIFICATION_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({closedAt: coercionTrap()})).reason,
    'CLOSURE_EVIDENCE_UNKNOWN'
  );
  assert.equal(coercionReads, 0);

  const symbolObj = baseDraftSample();
  symbolObj[Symbol('secret')] = 1;
  assert.equal(evaluatePullMergeLatencySample(symbolObj).reason, 'INVALID_SAMPLE');

  const protoObj = Object.create({inherited: true});
  Object.assign(protoObj, baseDraftSample());
  assert.equal(evaluatePullMergeLatencySample(protoObj).reason, 'INVALID_SAMPLE');

  const nonEnumObj = baseDraftSample();
  Object.defineProperty(nonEnumObj, 'hidden', {value: 1, enumerable: false});
  assert.equal(evaluatePullMergeLatencySample(nonEnumObj).reason, 'INVALID_SAMPLE');

  const missingRequired = baseDraftSample();
  delete missingRequired.stages;
  assert.equal(evaluatePullMergeLatencySample(missingRequired).reason, 'INVALID_SAMPLE');

  const undefinedFieldObj = baseDraftSample({enqueuedAt: undefined});
  assert.equal(evaluatePullMergeLatencySample(undefinedFieldObj).reason, 'INVALID_SAMPLE');

  assert.equal(evaluatePullMergeLatencySample(null).reason, 'INVALID_SAMPLE');
  assert.equal(evaluatePullMergeLatencySample([]).reason, 'INVALID_SAMPLE');
  assert.equal(evaluatePullMergeLatencySample(new Proxy(baseDraftSample(), {})).reason, 'INVALID_SAMPLE');
  assert.equal(evaluatePullMergeLatencySample({...baseDraftSample(), extra: 1}).reason, 'INVALID_SAMPLE');
  assert.equal(evaluatePullMergeLatencySample(baseDraftSample({prNumber: 0})).reason, 'INVALID_SAMPLE');
  assert.equal(evaluatePullMergeLatencySample(baseDraftSample({prNumber: 1_000_000_001})).reason, 'INVALID_SAMPLE');
  assert.equal(evaluatePullMergeLatencySample(baseDraftSample({repositoryId: 0})).reason, 'INVALID_SAMPLE');

  const sparse = [];
  sparse[1] = baseDraftSample();
  assert.equal(evaluatePullMergeLatencySlo(sparse).reason, 'INVALID_SAMPLES');
  assert.equal(evaluatePullMergeLatencySlo(new Proxy([baseDraftSample()], {})).reason, 'INVALID_SAMPLES');
  assert.equal(evaluatePullMergeLatencySlo('not-an-array').reason, 'INVALID_SAMPLES');
  assert.equal(evaluatePullMergeLatencySlo([]).reason, 'NO_SAMPLES');
});

test('enforces fail-closed timeline, provenance, scope, freshness, human-touch, and stage consistency', () => {
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({provenance: 'historical-github-proxy'})).reason,
    'UNTRUSTED_PROVENANCE'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseReadySample({publicationSource: 'inferred'})).reason,
    'PUBLICATION_EVIDENCE_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({publicationEvents: 'bad'})).reason,
    'PUBLICATION_EVIDENCE_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({publicationEvents: [{type: 'redrafted', at: 1_045_000}]})).reason,
    'PUBLICATION_EVIDENCE_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({publicationEvents: [{type: 'published', at: 1_250_000}]})).reason,
    'INVALID_TIMELINE_ORDER'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({
      publicationEvents: [
        {type: 'published', at: 1_045_000},
        {type: 'redrafted', at: 1_100_000}
      ]
    })).reason,
    'MERGED_WHILE_DRAFT'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseReadySample({historyComplete: false})).reason,
    'HISTORY_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseReadySample({observedAt: 999_999})).reason,
    'HISTORY_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({mainVerifiedAt: 1_200_000})).reason,
    'VERIFICATION_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({mergedAt: 1_300_001})).reason,
    'MERGE_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({state: 'merged', mergedAt: null, mainVerifiedAt: null})).reason,
    'MERGE_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({state: 'merged', closedAt: 1_200_000})).reason,
    'MERGE_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({state: 'unknown-state'})).reason,
    'CLOSURE_EVIDENCE_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({
      state: 'open',
      closedAt: 1_100_000,
      mergedAt: null,
      mainVerifiedAt: null
    })).reason,
    'CLOSURE_EVIDENCE_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({
      state: 'closed-unmerged',
      closedAt: null,
      mergedAt: null,
      mainVerifiedAt: null
    })).reason,
    'CLOSURE_EVIDENCE_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({
      state: 'closed-unmerged',
      closedAt: 999_999,
      mergedAt: null,
      mainVerifiedAt: null
    })).reason,
    'CLOSURE_EVIDENCE_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({
      state: 'closed-unmerged',
      closedAt: 1_300_001,
      mergedAt: null,
      mainVerifiedAt: null
    })).reason,
    'CLOSURE_EVIDENCE_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({
      mergedAt: null,
      mainVerifiedAt: 1_235_000
    })).reason,
    'VERIFICATION_UNKNOWN'
  );

  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({headCommits: []})).reason,
    'HEAD_HISTORY_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({headCommits: [{sha: 'bad-sha', at: 1_000_000}]})).reason,
    'HEAD_HISTORY_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({headCommits: [{sha: HEAD_1, at: 1_000_001}]})).reason,
    'INVALID_HEAD_TIMELINE'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({
      headCommits: [{sha: HEAD_1, at: 1_000_000}, {sha: HEAD_1, at: 1_050_000}]
    })).reason,
    'INVALID_HEAD_TIMELINE'
  );

  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({eligibilityTimestamps: 'bad'})).reason,
    'ELIGIBILITY_EVIDENCE_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({
      publicationEvents: [],
      mergedAt: null,
      mainVerifiedAt: null,
      eligibilityTimestamps: [1_050_000]
    })).reason,
    'ELIGIBILITY_BEFORE_PUBLICATION'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({
      eligibilityTimestamps: [1_040_000]
    })).reason,
    'INVALID_TIMELINE_ORDER'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({enqueuedAt: 1_179_000})).reason,
    'INVALID_ENQUEUE_TIMESTAMP'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({enqueuedAt: 1_206_000})).reason,
    'INVALID_ENQUEUE_TIMESTAMP'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({enqueuedAt: 'bad'})).reason,
    'INVALID_ENQUEUE_TIMESTAMP'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({
      eligibilityTimestamps: [],
      enqueuedAt: 1_185_000
    })).reason,
    'INVALID_ENQUEUE_TIMESTAMP'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({retryTimestamps: 'bad'})).reason,
    'RETRY_EVIDENCE_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({retryTimestamps: [999_999]})).reason,
    'INVALID_TIMELINE_ORDER'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({retryTimestamps: [1_206_000]})).reason,
    'INVALID_TIMELINE_ORDER'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({retryTimestamps: ['bad']})).reason,
    'INVALID_TIMELINE_ORDER'
  );

  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({humanTouchesComplete: 'bad'})).reason,
    'HUMAN_TOUCH_EVIDENCE_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({humanTouchesComplete: true, humanTouches: null})).reason,
    'HUMAN_TOUCH_EVIDENCE_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({humanTouches: 'bad'})).reason,
    'HUMAN_TOUCH_EVIDENCE_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({humanTouches: [null]})).reason,
    'HUMAN_TOUCH_EVIDENCE_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({humanTouches: [{}]})).reason,
    'HUMAN_TOUCH_EVIDENCE_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({humanTouches: [{kind: 'other'}]})).reason,
    'HUMAN_TOUCH_EVIDENCE_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({
      humanTouches: [{kind: 'routine', at: 1_100_000, summary: 'Valid', extra: 1}]
    })).reason,
    'HUMAN_TOUCH_EVIDENCE_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({
      humanTouches: [{kind: 'routine', at: 999_999, summary: 'Valid summary'}]
    })).reason,
    'HUMAN_TOUCH_EVIDENCE_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({
      humanTouches: [{kind: 'routine', at: 1_300_001, summary: 'Valid summary'}]
    })).reason,
    'HUMAN_TOUCH_EVIDENCE_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({
      humanTouches: [{kind: 'routine', at: 'bad', summary: 'Valid summary'}]
    })).reason,
    'HUMAN_TOUCH_EVIDENCE_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({
      humanTouches: [{kind: 'routine', at: 1_100_000, summary: 'x'}]
    })).reason,
    'HUMAN_TOUCH_EVIDENCE_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({
      humanTouches: [{kind: 'routine', at: 1_100_000, summary: 123}]
    })).reason,
    'HUMAN_TOUCH_EVIDENCE_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({
      humanTouches: [{kind: 'exception', at: 1_100_000}]
    })).reason,
    'HUMAN_TOUCH_EVIDENCE_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({
      humanTouches: [{
        kind: 'exception',
        category: 'convenience',
        at: 1_100_000,
        summary: 'Invalid category',
        attemptedRemediation: 'Ran checks',
        requiredIntervention: 'Approve'
      }]
    })).reason,
    'HUMAN_TOUCH_EVIDENCE_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({
      humanTouches: [{
        kind: 'exception',
        category: 'budget',
        at: 999_999,
        summary: 'Quota exhausted',
        attemptedRemediation: 'Checked included quota',
        requiredIntervention: 'Wait for reset'
      }]
    })).reason,
    'HUMAN_TOUCH_EVIDENCE_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({
      humanTouches: [{
        kind: 'exception',
        category: 'budget',
        at: 1_300_001,
        summary: 'Quota exhausted',
        attemptedRemediation: 'Checked included quota',
        requiredIntervention: 'Wait for reset'
      }]
    })).reason,
    'HUMAN_TOUCH_EVIDENCE_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({
      humanTouches: [{
        kind: 'exception',
        category: 'budget',
        at: 'bad',
        summary: 'Quota exhausted',
        attemptedRemediation: 'Checked included quota',
        requiredIntervention: 'Wait for reset'
      }]
    })).reason,
    'HUMAN_TOUCH_EVIDENCE_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({
      humanTouches: [{
        kind: 'exception',
        category: 'budget',
        at: 1_100_000,
        summary: 'Quota exhausted\u0000',
        attemptedRemediation: 'Checked included quota',
        requiredIntervention: 'Wait for reset'
      }]
    })).reason,
    'HUMAN_TOUCH_EVIDENCE_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({
      humanTouches: [{
        kind: 'exception',
        category: 'budget',
        at: 1_100_000,
        summary: 'Quota exhausted',
        attemptedRemediation: 'x',
        requiredIntervention: 'Wait for reset'
      }]
    })).reason,
    'HUMAN_TOUCH_EVIDENCE_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({
      humanTouches: [{
        kind: 'exception',
        category: 'budget',
        at: 1_100_000,
        summary: 'Quota exhausted',
        attemptedRemediation: 'Checked included quota',
        requiredIntervention: 'x'
      }]
    })).reason,
    'HUMAN_TOUCH_EVIDENCE_UNKNOWN'
  );

  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({stages: {}})).reason,
    'STAGE_ATTRIBUTION_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({
      stages: {...baseDraftSample().stages, ciQueueWaitMs: -1}
    })).reason,
    'STAGE_ATTRIBUTION_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({
      stages: {...baseDraftSample().stages, ciQueueWaitMs: 8 * 86_400_000}
    })).reason,
    'STAGE_ATTRIBUTION_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({
      eligibilityTimestamps: [],
      enqueuedAt: null
    })).reason,
    'INCONSISTENT_STAGE_ATTRIBUTION'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({
      publicationEvents: [],
      eligibilityTimestamps: [],
      enqueuedAt: null,
      mergedAt: null,
      mainVerifiedAt: null,
      stages: {
        ...baseDraftSample().stages,
        eligibilityToEnqueueMs: null,
        mainVerificationMs: null
      }
    })).reason,
    'INCONSISTENT_STAGE_ATTRIBUTION'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({
      mainVerifiedAt: null
    })).reason,
    'INCONSISTENT_STAGE_ATTRIBUTION'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({
      stages: {...baseDraftSample().stages, mainVerificationMs: 99_999}
    })).reason,
    'INCONSISTENT_STAGE_ATTRIBUTION'
  );
  assert.equal(
    evaluatePullMergeLatencySample(baseDraftSample({
      stages: {...baseDraftSample().stages, eligibilityToEnqueueMs: 9_000}
    })).reason,
    'INCONSISTENT_STAGE_ATTRIBUTION'
  );
  const withoutEnqueue = baseDraftSample({
    stages: {...baseDraftSample().stages, eligibilityToEnqueueMs: 90_000}
  });
  delete withoutEnqueue.enqueuedAt;
  assert.equal(
    evaluatePullMergeLatencySample(withoutEnqueue).reason,
    'INCONSISTENT_STAGE_ATTRIBUTION'
  );

  assert.equal(evaluatePullMergeLatencySlo([baseDraftSample()], null).reason, 'INVALID_OPTIONS');
  assert.equal(evaluatePullMergeLatencySlo([baseDraftSample()], {repositoryId: 0}).reason, 'INVALID_OPTIONS');
  assert.equal(evaluatePullMergeLatencySlo([baseDraftSample()], {cohort: 'BAD_SLUG'}).reason, 'INVALID_OPTIONS');
  assert.equal(
    evaluatePullMergeLatencySlo([baseDraftSample()], {provenance: 'historical-github-proxy'}).reason,
    'UNTRUSTED_PROVENANCE'
  );
  assert.equal(
    evaluatePullMergeLatencySlo([baseDraftSample()], {observedAt: 1_300_000}).reason,
    'FRESHNESS_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySlo([baseDraftSample()], {observedAt: 1_300_000, nowMs: 1_310_000}).reason,
    'FRESHNESS_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySlo([baseDraftSample()], {
      observedAt: 1_310_000,
      nowMs: 1_300_000,
      maxAgeMs: 60_000
    }).reason,
    'FRESHNESS_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySlo([baseDraftSample()], {
      observedAt: 1_300_000,
      nowMs: 1_310_000,
      maxAgeMs: 0
    }).reason,
    'FRESHNESS_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySlo([baseDraftSample()], {
      observedAt: 1_300_000,
      nowMs: 1_400_000,
      maxAgeMs: 30_000
    }).reason,
    'STALE_EVIDENCE'
  );
  assert.equal(
    evaluatePullMergeLatencySlo([baseDraftSample()], {
      observedAt: 1_299_999,
      nowMs: 1_310_000,
      maxAgeMs: 60_000
    }).reason,
    'SAMPLE_AFTER_OBSERVATION'
  );
  const staleOpenSample = baseDraftSample({
    prNumber: 801,
    createdAt: 50,
    observedAt: 100,
    publicationEvents: [],
    headCommits: [{sha: HEAD_1, at: 50}],
    eligibilityTimestamps: [],
    enqueuedAt: null,
    mergedAt: null,
    mainVerifiedAt: null,
    stages: {
      ciQueueWaitMs: null,
      linuxRuntimeMs: null,
      windowsRuntimeMs: null,
      securityScanMs: null,
      reviewReworkMs: null,
      publicationIdleMs: null,
      eligibilityToEnqueueMs: null,
      mergeQueueRevalidationMs: null,
      mainVerificationMs: null
    }
  });
  assert.equal(
    evaluatePullMergeLatencySlo([baseDraftSample({prNumber: 800}), staleOpenSample], {
      cohort: 'stale-check',
      fromMs: 0,
      toMs: 2_000_000,
      observedAt: 10_000_000,
      nowMs: 10_000_000,
      maxAgeMs: 1_000,
      sourceComplete: true
    }).reason,
    'STALE_EVIDENCE'
  );
  assert.equal(
    evaluatePullMergeLatencySlo([baseDraftSample({prNumber: 802, observedAt: 10_000_000}), staleOpenSample]).reason,
    'STALE_EVIDENCE'
  );
  const staleClosedUnmerged = baseDraftSample({
    prNumber: 803,
    state: 'closed-unmerged',
    closedAt: 1_050_000,
    createdAt: 1_000_000,
    observedAt: 1_100_000,
    publicationEvents: [],
    headCommits: [{sha: HEAD_1, at: 1_000_000}],
    eligibilityTimestamps: [],
    enqueuedAt: null,
    mergedAt: null,
    mainVerifiedAt: null,
    stages: {
      ciQueueWaitMs: null,
      linuxRuntimeMs: null,
      windowsRuntimeMs: null,
      securityScanMs: null,
      reviewReworkMs: null,
      publicationIdleMs: null,
      eligibilityToEnqueueMs: null,
      mergeQueueRevalidationMs: null,
      mainVerificationMs: null
    }
  });
  assert.equal(
    evaluatePullMergeLatencySlo(
      [baseDraftSample({prNumber: 804}), staleClosedUnmerged],
      completeCohortOptions()
    ).reason,
    'STALE_EVIDENCE'
  );
  assert.equal(
    evaluatePullMergeLatencySlo([baseDraftSample({prNumber: 805}), staleClosedUnmerged]).reason,
    'STALE_EVIDENCE'
  );
  assert.equal(
    evaluatePullMergeLatencySlo([baseDraftSample()], {fromMs: 0, toMs: 2_000_000}).reason,
    'COHORT_WINDOW_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySlo([baseDraftSample()], completeCohortOptions({fromMs: 1_250_000})).reason,
    'COHORT_WINDOW_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySlo([baseDraftSample()], completeCohortOptions({sourceComplete: 'yes'})).reason,
    'COHORT_WINDOW_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySlo([baseDraftSample()], completeCohortOptions({
      toMs: 1_310_000,
      observedAt: 1_300_000,
      nowMs: 1_320_000
    })).reason,
    'FRESHNESS_UNKNOWN'
  );
  assert.equal(
    evaluatePullMergeLatencySlo([baseDraftSample()], completeCohortOptions({
      fromMs: 1_000_001
    })).reason,
    'SAMPLE_OUTSIDE_WINDOW'
  );
  assert.equal(
    evaluatePullMergeLatencySlo([baseDraftSample()], completeCohortOptions({
      toMs: 1_000_000
    })).reason,
    'SAMPLE_OUTSIDE_WINDOW'
  );
  assert.equal(
    evaluatePullMergeLatencySlo([
      baseDraftSample({prNumber: 1}),
      baseDraftSample({prNumber: 2, repositoryId: 999999})
    ]).reason,
    'REPOSITORY_SCOPE_MISMATCH'
  );
  assert.equal(
    evaluatePullMergeLatencySlo([
      baseDraftSample({prNumber: 1, provenance: 'github-timeline'}),
      baseDraftSample({prNumber: 2, provenance: 'synthetic-fixture'})
    ]).reason,
    'PROVENANCE_ISOLATION_VIOLATION'
  );
  assert.equal(
    evaluatePullMergeLatencySlo([
      baseDraftSample({prNumber: 1}),
      baseDraftSample({prNumber: 1})
    ]).reason,
    'DUPLICATE_PR_SAMPLE'
  );
});
