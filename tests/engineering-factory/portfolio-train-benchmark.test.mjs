import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  COORDINATOR_DISPATCHED_WAVE_PROVENANCE,
  FUTURE_GH_AW_CRON_PROVENANCE,
  LOGICAL_LANE_CLASSIFICATION,
  LOGICAL_LANE_TIERS,
  M01_EXIT_ANCHOR_ISSUE,
  PINNED_DOTNET_MAF_RUNTIME,
  PINNED_NODE_RUNTIME,
  SHARED_M01_ANCHOR_TARGET_OUTCOMES,
  SHARED_M02_COHORT_TARGET_OUTCOMES,
  SHARED_M02_EXIT_ISSUES,
  SOFTWARE_FACTORY_REPOSITORY,
  SOFTWARE_FACTORY_REPOSITORY_ID,
  SPELLBOOK_MAX_CONCURRENCY,
  STREAMLINED_M02_MIN_ACCEPTED_ISSUES,
  THROUGHPUT_COHORT_MULTIPLIERS,
  TWO_MINUTE_DRAIN_STRETCH_MS,
  UNATTENDED_COPILOT_ACTOR,
  allocatePortfolioCapacityAndSimulateTrains,
  evaluateDotnetConsolidationBenchmark,
  evaluateSharedFiveOutcomeM02Cohort,
  evaluateStreamlinedM02CohortReadout
} from '../../tools/engineering-factory/portfolio-train-benchmark.mjs';

const sha = ch => ch.repeat(40);
const MAIN_SHA = sha('a');
const HEAD_1 = sha('b');
const HEAD_2 = sha('c');
const SQUASH_1 = sha('1');
const SQUASH_2 = sha('2');
const WORKLOAD_SHA = sha('e');
const GATE_SET_SHA = sha('f');

const baseReceipt = () => ({
  receiptId: 'hs-portfolio-001',
  provider: 'github-copilot',
  includedOnly: true,
  overageDisabled: true,
  hardStopEnforced: true,
  paidUsageMicros: 0,
  observedMs: 100000
});

const baseBudget = (overrides = {}) => ({
  stop: false,
  environmentVerified: true,
  includedOnly: true,
  overageDisabled: true,
  authorityVerified: true,
  nowMs: 110000,
  observedMs: 105000,
  remaining: 120,
  reserved: 20,
  active: 2,
  maxActive: 6,
  unitsPerRun: 10,
  hardStopReceipt: baseReceipt(),
  ...overrides
});

const makeCredential = (id, repoSlug, overrides = {}) => ({
  credentialId: id,
  scope: 'repo-read-only-shadow',
  allowedRepositories: [repoSlug],
  sharedAdminToken: false,
  persistedInCheckout: false,
  ...overrides
});

const makeTrainCandidate = (pr, overrides = {}) => ({
  pr,
  head: HEAD_1,
  observedHead: HEAD_1,
  expectedBase: MAIN_SHA,
  compatibleBase: true,
  checksPassed: true,
  reviewState: 'APPROVED',
  independentReview: true,
  unresolvedFindings: 0,
  securityClear: true,
  threadsResolved: true,
  authorityVerified: true,
  coveredLines: 990,
  totalLines: 1000,
  coveredBranches: 960,
  totalBranches: 1000,
  ownedPaths: [`src/feature-${pr}`],
  simulatedSquashSha: String(pr).padStart(40, '1'),
  postMergeMainHealthy: true,
  eligibleToMergeMs: 25000,
  postMergeVerifyMs: 15000,
  blockedMs: 1000,
  ...overrides
});

const makeRepo = ({
  repositoryId,
  repository,
  localConcurrencyCap,
  maxConcurrency = localConcurrencyCap,
  minLinePercent,
  minBranchPercent,
  credentialId,
  inFlightLeases = [],
  candidates = [],
  mainHealthy = true,
  killSwitch = false,
  defaultBranch = 'main',
  mergeQueueOverrides = {},
  overrides = {}
}) => ({
  repositoryId,
  repository,
  enrolled: true,
  ownerAuthorized: true,
  killSwitch,
  localConcurrencyCap,
  maxConcurrency,
  minLinePercent,
  minBranchPercent,
  credential: makeCredential(credentialId, repository),
  inFlightLeases,
  train: {
    defaultBranch,
    mainSha: MAIN_SHA,
    mainHealthy,
    mergeQueue: {
      mode: 'native-merge-queue',
      supported: true,
      ownerApproved: true,
      costVerified: true,
      incrementalSpendMicros: 0,
      ...mergeQueueOverrides
    },
    candidates
  },
  ...overrides
});

const factoryRepo = (opts = {}) => makeRepo({
  repositoryId: SOFTWARE_FACTORY_REPOSITORY_ID,
  repository: SOFTWARE_FACTORY_REPOSITORY,
  localConcurrencyCap: 4,
  minLinePercent: 98,
  minBranchPercent: 95,
  credentialId: 'cred-sf',
  ...opts
});

const spellbookRepo = (opts = {}) => makeRepo({
  repositoryId: 200004,
  repository: 'example/spellbook',
  localConcurrencyCap: SPELLBOOK_MAX_CONCURRENCY,
  minLinePercent: 97,
  minBranchPercent: 90,
  credentialId: 'cred-spellbook',
  ...opts
});

const familyTreeRepo = (opts = {}) => makeRepo({
  repositoryId: 200003,
  repository: 'example/family-tree',
  localConcurrencyCap: 1,
  minLinePercent: 95,
  minBranchPercent: 90,
  credentialId: 'cred-familytree',
  ...opts
});

const familyHubRepo = (opts = {}) => makeRepo({
  repositoryId: 200005,
  repository: 'example/family-hub',
  localConcurrencyCap: 2,
  minLinePercent: 100,
  minBranchPercent: 100,
  credentialId: 'cred-familyhub',
  defaultBranch: 'trunk',
  ...opts
});

const makeWorkItem = (repositoryId, issue, criticalPathRank = 1, ownedPaths = [`src/item-${issue}`]) => ({
  repositoryId,
  issue,
  laneId: `lane-${repositoryId}-${issue}`,
  head: HEAD_2,
  criticalPathRank,
  ownedPaths
});

test('gives SoftwareFactory (1471342715) strict first-claim priority without cancelling in-flight consumer leases and enforces Spellbook <= 2', () => {
  const spellbookLease = {
    leaseId: 'lease-sb-active-1',
    issue: 101,
    laneId: 'lane-sb-active',
    head: HEAD_1,
    ownedPaths: ['ios/active']
  };
  const familyTreeLease = {
    leaseId: 'lease-ft-active-1',
    issue: 201,
    laneId: 'lane-ft-active',
    head: HEAD_1,
    ownedPaths: ['src/tree-active']
  };

  // Budget maxActive=6, active=2 (both held by consumers) -> 4 available slots.
  const result = allocatePortfolioCapacityAndSimulateTrains({
    stop: false,
    budget: baseBudget({active: 2, maxActive: 6}),
    repositories: [
      spellbookRepo({
        inFlightLeases: [spellbookLease],
        candidates: [
          makeTrainCandidate(11, {simulatedSquashSha: SQUASH_1, eligibleToMergeMs: 30000, postMergeVerifyMs: 20000}),
          makeTrainCandidate(12, {expectedBase: SQUASH_1, simulatedSquashSha: SQUASH_2, eligibleToMergeMs: 25000, postMergeVerifyMs: 15000})
        ]
      }),
      familyTreeRepo({inFlightLeases: [familyTreeLease]}),
      familyHubRepo(),
      factoryRepo({
        candidates: [
          makeTrainCandidate(1, {reviewState: 'COMMENTED_CLEAR', simulatedSquashSha: SQUASH_1})
        ]
      })
    ],
    workItems: [
      // Overlaps active Spellbook in-flight lease ios/active -> deferred by path overlap
      makeWorkItem(200004, 104, 1, ['ios/active/module.swift']),
      // Even though Spellbook has rank 1, SoftwareFactory (1471342715) claims first!
      makeWorkItem(200004, 102, 1, ['src/sb-1']),
      makeWorkItem(200004, 103, 1, ['src/sb-2']),
      makeWorkItem(200005, 301, 2, ['app/hub-1']),
      makeWorkItem(200005, 302, 2, ['app/hub-2']),
      makeWorkItem(SOFTWARE_FACTORY_REPOSITORY_ID, 16, 3, ['tools/sf-b']),
      makeWorkItem(SOFTWARE_FACTORY_REPOSITORY_ID, 14, 1, ['tools/sf-a']),
      // Overlaps tools/sf-a -> deferred by path overlap without consuming a slot
      makeWorkItem(SOFTWARE_FACTORY_REPOSITORY_ID, 17, 2, ['tools/sf-a/sub'])
    ]
  });

  assert.equal(result.valid, true);
  assert.equal(result.shadow, true);
  assert.equal(result.liveDispatch, false);
  assert.equal(result.liveMerge, false);
  assert.equal(result.reason, 'PORTFOLIO_SHADOW_ALLOCATED');
  assert.equal(result.cancelledInFlightLeases, 0);
  assert.equal(result.preservedInFlightLeases.length, 2);
  assert.deepEqual(
    result.preservedInFlightLeases.map(l => l.leaseId),
    ['lease-sb-active-1', 'lease-ft-active-1']
  );
  assert.equal(result.logicalLaneClassification, LOGICAL_LANE_CLASSIFICATION);
  assert.equal(result.logicalLanesAreConcurrentAgentAuthorization, false);
  assert.equal(result.authorizedConcurrentWorkers, 0);

  // 4 available slots:
  // 1) SF issue 14 (rank 1)
  // 2) SF issue 16 (rank 3) [SF issue 17 deferred due to path overlap]
  // 3) Spellbook issue 102 (rank 1 -> brings Spellbook to 1 in-flight + 1 allocated = 2 == cap!)
  //    Spellbook issue 103 is capped at 2 (REPO_CONCURRENCY_CAP_REACHED)!
  // 4) FamilyHub issue 301 (rank 2); FamilyHub issue 302 deferred (PORTFOLIO_CAPACITY_EXHAUSTED)
  assert.deepEqual(
    result.allocatedWorkItems.map(w => ({repo: w.repository, issue: w.issue, tier: w.priorityTier})),
    [
      {repo: 'Jamula/SoftwareFactory', issue: 14, tier: 'softwarefactory-first-claim'},
      {repo: 'Jamula/SoftwareFactory', issue: 16, tier: 'softwarefactory-first-claim'},
      {repo: 'example/spellbook', issue: 102, tier: 'consumer-fair-critical-path'},
      {repo: 'example/family-hub', issue: 301, tier: 'consumer-fair-critical-path'}
    ]
  );

  const deferredByIssue = new Map(result.deferredWorkItems.map(d => [d.issue, d.reason]));
  assert.equal(deferredByIssue.get(17), 'PATH_OVERLAP_DEFERRED');
  assert.equal(deferredByIssue.get(104), 'PATH_OVERLAP_DEFERRED');
  assert.equal(deferredByIssue.get(103), 'REPO_CONCURRENCY_CAP_REACHED');
  assert.equal(deferredByIssue.get(302), 'PORTFOLIO_CAPACITY_EXHAUSTED');

  const sbSummary = result.repositoryResults.find(r => r.repository === 'example/spellbook');
  assert.equal(sbSummary.effectiveActiveCount, 2);
  assert.equal(sbSummary.train.trainStatus, 'TRAIN_DRAINED');
  assert.deepEqual(sbSummary.train.mergedPrs, [11, 12]);
  assert.equal(sbSummary.train.rebasesPerformed, 0);
  assert.equal(sbSummary.train.lastMergeReceiptMs, 75000);
  assert.equal(sbSummary.train.verifiedMainMs, 90000);
  assert.equal(sbSummary.train.p50MergeMs, 25000);
  assert.equal(sbSummary.train.p95MergeMs, 30000);
  assert.equal(sbSummary.train.withinTwoMinuteStretchTarget, true);
  assert.equal(sbSummary.train.stretchTargetMs, TWO_MINUTE_DRAIN_STRETCH_MS);
  assert.equal(sbSummary.train.stretchTargetOnly, true);

  const sfSummary = result.repositoryResults.find(r => r.repository === SOFTWARE_FACTORY_REPOSITORY);
  assert.deepEqual(sfSummary.train.mergedPrs, [1]);
});

test('never cancels active consumer leases when capacity is exhausted and classifies 20-50 logical lanes as non-authorizing stretch', () => {
  const activeConsumerLease = {
    leaseId: 'lease-consumer-full',
    issue: 500,
    laneId: 'lane-consumer-500',
    head: HEAD_1,
    ownedPaths: ['src/core']
  };
  const twentyFourItems = Array.from({length: 24}, (_, idx) =>
    makeWorkItem(SOFTWARE_FACTORY_REPOSITORY_ID, idx + 1, 1, [`tools/mod-${idx}`])
  );

  const result = allocatePortfolioCapacityAndSimulateTrains({
    stop: false,
    budget: baseBudget({active: 1, maxActive: 1}),
    repositories: [
      spellbookRepo({inFlightLeases: [activeConsumerLease]}),
      factoryRepo({maxConcurrency: 4})
    ],
    workItems: twentyFourItems
  });

  assert.equal(result.valid, true);
  assert.equal(result.reason, 'PORTFOLIO_EVALUATED_NO_NEW_ALLOCATION');
  assert.equal(result.budgetAvailable, 0);
  assert.equal(result.cancelledInFlightLeases, 0);
  assert.equal(result.preservedInFlightLeases.length, 1);
  assert.equal(result.allocatedWorkItems.length, 0);
  assert.equal(result.logicalLanesTotal, 25);
  assert.equal(result.withinArchitecturalStretchBand20To50, true);
  assert.equal(result.logicalLanesAreConcurrentAgentAuthorization, false);
  assert.equal(result.authorizedConcurrentWorkers, 0);
  // First 4 viable SF items hit PORTFOLIO_CAPACITY_EXHAUSTED (activeCount stays 0 < 4)
  assert.equal(result.deferredWorkItems.length, 24);
  assert.equal(result.deferredWorkItems.every(d => d.reason === 'PORTFOLIO_CAPACITY_EXHAUSTED'), true);
});

test('isolates red main (both initial and post-merge) and per-repo kill switches strictly to the affected repository', () => {
  const result = allocatePortfolioCapacityAndSimulateTrains({
    stop: false,
    budget: baseBudget({active: 0, maxActive: 6}),
    repositories: [
      // Repo 1: initial red main -> blocks ONLY family-tree train & work items
      familyTreeRepo({
        mainHealthy: false,
        candidates: [makeTrainCandidate(31, {simulatedSquashSha: SQUASH_1})]
      }),
      // Repo 2: mid-train post-merge red main -> PR 41 merges then fails main, halting PR 42 and blocking spellbook work items
      spellbookRepo({
        candidates: [
          makeTrainCandidate(41, {simulatedSquashSha: SQUASH_1, postMergeMainHealthy: false}),
          makeTrainCandidate(42, {simulatedSquashSha: SQUASH_2, ownedPaths: ['src/other']})
        ]
      }),
      // Repo 3: local per-repo killSwitch -> stops ONLY family-hub
      familyHubRepo({
        killSwitch: true,
        candidates: [
          makeTrainCandidate(51, {
            simulatedSquashSha: SQUASH_1,
            coveredLines: 1000,
            coveredBranches: 1000
          })
        ]
      }),
      // Repo 4: healthy SoftwareFactory -> unaffected by all 3 peer stops/failures!
      factoryRepo({
        candidates: [makeTrainCandidate(61, {simulatedSquashSha: SQUASH_1})]
      })
    ],
    workItems: [
      makeWorkItem(200003, 1, 1),
      makeWorkItem(200004, 2, 1),
      makeWorkItem(200005, 3, 1),
      makeWorkItem(SOFTWARE_FACTORY_REPOSITORY_ID, 4, 1)
    ]
  });

  assert.equal(result.valid, true);
  assert.equal(result.crossRepoMainFailureSpillover, false);
  assert.deepEqual(result.isolatedUnhealthyMainRepositories, ['example/family-tree', 'example/spellbook']);
  assert.deepEqual(result.unaffectedHealthyRepositories, [SOFTWARE_FACTORY_REPOSITORY]);
  assert.deepEqual(result.allocatedWorkItems.map(w => w.repository), [SOFTWARE_FACTORY_REPOSITORY]);

  const byRepo = new Map(result.repositoryResults.map(r => [r.repository, r]));

  const ft = byRepo.get('example/family-tree');
  assert.equal(ft.train.trainStatus, 'BLOCKED_MAIN_UNHEALTHY');
  assert.equal(ft.train.tripRepoKillSwitch, true);
  assert.deepEqual(ft.train.mergedPrs, []);
  assert.deepEqual(ft.train.blockedAfterMainFailurePrs, [31]);

  const sb = byRepo.get('example/spellbook');
  assert.equal(sb.train.trainStatus, 'HALTED_ON_POST_MERGE_MAIN_FAILURE');
  assert.equal(sb.train.tripRepoKillSwitch, true);
  assert.deepEqual(sb.train.mergedPrs, [41]);
  assert.deepEqual(sb.train.blockedAfterMainFailurePrs, [42]);
  assert.equal(sb.train.withinTwoMinuteStretchTarget, false);

  const fh = byRepo.get('example/family-hub');
  assert.equal(fh.train.trainStatus, 'STOPPED_BY_KILL_SWITCH');
  assert.equal(fh.train.tripRepoKillSwitch, true);
  assert.deepEqual(fh.train.isolatedCandidates, [{pr: 51, reason: 'STOPPED_BY_KILL_SWITCH'}]);

  const sf = byRepo.get(SOFTWARE_FACTORY_REPOSITORY);
  assert.equal(sf.train.trainStatus, 'TRAIN_DRAINED');
  assert.equal(sf.train.mergeQueueMode, 'native-merge-queue');
  assert.deepEqual(sf.train.mergedPrs, [61]);

  const deferredMap = new Map(result.deferredWorkItems.map(d => [d.repository, d.reason]));
  assert.equal(deferredMap.get('example/family-tree'), 'REPO_MAIN_UNHEALTHY');
  assert.equal(deferredMap.get('example/spellbook'), 'REPO_MAIN_UNHEALTHY');
  assert.equal(deferredMap.get('example/family-hub'), 'REPO_KILL_SWITCH_ACTIVE');
});

test('simulates fair round-robin consumer allocation and isolates non-eligible train candidates without rebasing healthy train', () => {
  const consumerA = makeRepo({
    repositoryId: 300001,
    repository: 'example/alpha',
    localConcurrencyCap: 3,
    minLinePercent: 95,
    minBranchPercent: 90,
    credentialId: 'cred-alpha',
    mergeQueueOverrides: {mode: 'serialized-protected-squash'},
    candidates: [
      // Isolated: head changed
      makeTrainCandidate(1, {observedHead: HEAD_2, simulatedSquashSha: sha('3')}),
      // Isolated: checks incomplete
      makeTrainCandidate(2, {checksPassed: false, simulatedSquashSha: sha('4')}),
      // Isolated: COMMENTED_CLEAR is NOT sufficient for consumer repos!
      makeTrainCandidate(3, {reviewState: 'COMMENTED_CLEAR', simulatedSquashSha: sha('5')}),
      // Isolated: coverage below 95/90
      makeTrainCandidate(4, {coveredLines: 940, simulatedSquashSha: sha('6')}),
      // Eligible #1: claims src/shared-dir
      makeTrainCandidate(5, {
        ownedPaths: ['src/shared-dir'],
        simulatedSquashSha: sha('7'),
        eligibleToMergeMs: 80000,
        postMergeVerifyMs: 50000
      }),
      // Isolated: path conflict with PR 5 in same prevalidated train batch
      makeTrainCandidate(6, {
        ownedPaths: ['src/shared-dir/file.mjs'],
        simulatedSquashSha: sha('8')
      })
    ]
  });
  const consumerB = makeRepo({
    repositoryId: 300002,
    repository: 'example/beta',
    localConcurrencyCap: 3,
    minLinePercent: 95,
    minBranchPercent: 90,
    credentialId: 'cred-beta',
    candidates: [
      makeTrainCandidate(10, {checksPassed: false, simulatedSquashSha: sha('9')})
    ]
  });

  const result = allocatePortfolioCapacityAndSimulateTrains({
    stop: false,
    budget: baseBudget({active: 0, maxActive: 3}),
    repositories: [consumerA, consumerB],
    workItems: [
      // Equal criticalPathRank=1 across consumerA and consumerB -> round-robin A, B, A!
      makeWorkItem(300001, 11, 1, ['src/a1']),
      makeWorkItem(300001, 12, 1, ['src/a2']),
      makeWorkItem(300001, 10, 1, ['src/a0']),
      makeWorkItem(300002, 20, 1, ['src/b0']),
      // Overlapping item on consumerB
      makeWorkItem(300002, 21, 1, ['src/b0/nested']),
      makeWorkItem(300002, 22, 2, ['src/b2'])
    ]
  });

  assert.equal(result.valid, true);
  assert.deepEqual(
    result.allocatedWorkItems.map(w => `${w.repository}#${w.issue}`),
    ['example/alpha#10', 'example/beta#20', 'example/alpha#11']
  );
  assert.equal(result.nextConsumerCursorRepositoryId, 300001);

  // Cross-evaluation single-slot round-robin: passing lastServedConsumerRepositoryId prevents starvation
  const singleSlotCycle1 = allocatePortfolioCapacityAndSimulateTrains({
    stop: false,
    budget: baseBudget({active: 0, maxActive: 1}),
    repositories: [consumerA, consumerB],
    workItems: [makeWorkItem(300001, 10, 1, ['src/a0']), makeWorkItem(300002, 20, 1, ['src/b0'])]
  });
  assert.deepEqual(singleSlotCycle1.allocatedWorkItems.map(w => w.repository), ['example/alpha']);
  assert.equal(singleSlotCycle1.nextConsumerCursorRepositoryId, 300001);

  const singleSlotCycle2 = allocatePortfolioCapacityAndSimulateTrains({
    stop: false,
    lastServedConsumerRepositoryId: singleSlotCycle1.nextConsumerCursorRepositoryId,
    budget: baseBudget({active: 0, maxActive: 1}),
    repositories: [consumerA, consumerB],
    workItems: [makeWorkItem(300001, 11, 1, ['src/a1']), makeWorkItem(300002, 20, 1, ['src/b0'])]
  });
  assert.deepEqual(singleSlotCycle2.allocatedWorkItems.map(w => w.repository), ['example/beta']);
  assert.equal(singleSlotCycle2.nextConsumerCursorRepositoryId, 300002);

  const singleSlotCycle3 = allocatePortfolioCapacityAndSimulateTrains({
    stop: false,
    lastServedConsumerRepositoryId: singleSlotCycle2.nextConsumerCursorRepositoryId,
    budget: baseBudget({active: 0, maxActive: 1}),
    repositories: [consumerA, consumerB],
    workItems: [makeWorkItem(300001, 11, 1, ['src/a1']), makeWorkItem(300002, 22, 1, ['src/b2'])]
  });
  assert.deepEqual(singleSlotCycle3.allocatedWorkItems.map(w => w.repository), ['example/alpha']);
  assert.equal(singleSlotCycle3.nextConsumerCursorRepositoryId, 300001);

  const alphaTrain = result.repositoryResults[0].train;
  assert.equal(alphaTrain.trainStatus, 'TRAIN_DRAINED');
  assert.equal(alphaTrain.mergeQueueMode, 'serialized-protected-squash');
  assert.deepEqual(alphaTrain.mergedPrs, [5]);
  assert.equal(alphaTrain.verifiedMainMs, 130000);
  assert.equal(alphaTrain.withinTwoMinuteStretchTarget, false);
  assert.deepEqual(alphaTrain.isolatedCandidates, [
    {pr: 1, reason: 'HEAD_OR_BASE_MISMATCH'},
    {pr: 2, reason: 'CHECKS_OR_SECURITY_INCOMPLETE'},
    {pr: 3, reason: 'INDEPENDENT_REVIEW_INCOMPLETE'},
    {pr: 4, reason: 'COVERAGE_BELOW_POLICY'},
    {pr: 6, reason: 'PATH_CONFLICT_REBASE_REQUIRED'}
  ]);

  const betaTrain = result.repositoryResults[1].train;
  assert.equal(betaTrain.trainStatus, 'IDLE_NO_ELIGIBLE');
  assert.equal(betaTrain.p50MergeMs, null);
  assert.equal(betaTrain.p95MergeMs, null);
});

test('portfolio allocator fails closed on shared admin tokens, spoofing, cap breaches, proxies and getter traps', () => {
  const validInput = {
    stop: false,
    budget: baseBudget({active: 0, maxActive: 4}),
    repositories: [factoryRepo(), spellbookRepo()],
    workItems: [makeWorkItem(SOFTWARE_FACTORY_REPOSITORY_ID, 1, 1)]
  };

  assert.equal(allocatePortfolioCapacityAndSimulateTrains(null).reason, 'INPUT_UNKNOWN');
  assert.equal(allocatePortfolioCapacityAndSimulateTrains({...validInput, stop: true}).reason, 'STOPPED');

  const proxyInput = new Proxy(validInput, {get() { throw new Error('proxy getter must not run'); }});
  assert.equal(allocatePortfolioCapacityAndSimulateTrains(proxyInput).reason, 'INPUT_UNKNOWN');

  const getterInput = Object.defineProperties({}, {
    ...Object.getOwnPropertyDescriptors(validInput),
    stop: {enumerable: true, get() { throw new Error('accessor must not run'); }}
  });
  assert.equal(allocatePortfolioCapacityAndSimulateTrains(getterInput).reason, 'INPUT_UNKNOWN');

  const symbolInput = {...validInput, [Symbol('extra')]: 1};
  assert.equal(allocatePortfolioCapacityAndSimulateTrains(symbolInput).reason, 'INPUT_UNKNOWN');

  const {workItems: _omitted, ...missingRequired} = validInput;
  assert.equal(allocatePortfolioCapacityAndSimulateTrains(missingRequired).reason, 'INPUT_UNKNOWN');

  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({...validInput, budget: {...baseBudget(), extra: 1}}).reason,
    'BUDGET_UNKNOWN'
  );
  const {hardStopReceipt: _missingReceipt, ...budgetWithoutReceipt} = baseBudget();
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({...validInput, budget: budgetWithoutReceipt}).reason,
    'HARD_STOP_UNVERIFIED'
  );
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({
      ...validInput,
      budget: {...baseBudget(), hardStopReceipt: {...baseReceipt(), paidUsageMicros: 1}}
    }).reason,
    'PAID_USAGE_NONZERO'
  );
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({
      ...validInput,
      budget: {...baseBudget(), hardStopReceipt: {...baseReceipt(), extra: 1}}
    }).reason,
    'HARD_STOP_UNVERIFIED'
  );
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({
      ...validInput,
      budget: baseBudget({overageDisabled: false})
    }).reason,
    'BUDGET_UNKNOWN'
  );
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({...validInput, repositories: []}).reason,
    'INPUT_UNKNOWN'
  );

  // Sparse, custom-prototype, proxy, and getter arrays
  const sparseRepos = new Array(1);
  const protoRepos = Object.setPrototypeOf([factoryRepo()], {});
  const getterRepos = [factoryRepo()];
  Object.defineProperty(getterRepos, '0', {enumerable: true, get() { throw new Error('must not run'); }});
  for (const repositories of [sparseRepos, protoRepos, getterRepos, new Proxy([factoryRepo()], {})]) {
    assert.equal(
      allocatePortfolioCapacityAndSimulateTrains({...validInput, repositories}).reason,
      'INPUT_UNKNOWN'
    );
  }

  // Shared admin token & credential isolation
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({
      ...validInput,
      repositories: [factoryRepo({
        overrides: {credential: makeCredential('cred-sf', SOFTWARE_FACTORY_REPOSITORY, {sharedAdminToken: true})}
      })]
    }).reason,
    'SHARED_ADMIN_TOKEN_FORBIDDEN'
  );
  for (const credPatch of [
    {credentialId: 'bad space'},
    {scope: 'repo-admin'},
    {persistedInCheckout: true},
    {allowedRepositories: []},
    {allowedRepositories: ['other/repo']}
  ]) {
    assert.equal(
      allocatePortfolioCapacityAndSimulateTrains({
        ...validInput,
        repositories: [factoryRepo({
          overrides: {credential: makeCredential('cred-sf', SOFTWARE_FACTORY_REPOSITORY, credPatch)}
        })]
      }).reason,
      'CREDENTIAL_ISOLATION_VIOLATION'
    );
  }
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({
      ...validInput,
      repositories: [factoryRepo({credentialId: 'dup-cred'}), spellbookRepo({credentialId: 'DUP-CRED'})]
    }).reason,
    'CREDENTIAL_ISOLATION_VIOLATION'
  );

  // Identity spoofing, duplicates, enrollment, authorization
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({
      ...validInput,
      repositories: [makeRepo({
        repositoryId: 999999,
        repository: SOFTWARE_FACTORY_REPOSITORY,
        localConcurrencyCap: 2,
        minLinePercent: 98,
        minBranchPercent: 95,
        credentialId: 'c1'
      })]
    }).reason,
    'REPOSITORY_IDENTITY_MISMATCH'
  );
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({
      ...validInput,
      repositories: [makeRepo({
        repositoryId: SOFTWARE_FACTORY_REPOSITORY_ID,
        repository: 'jamula/softwarefactory',
        localConcurrencyCap: 2,
        minLinePercent: 98,
        minBranchPercent: 95,
        credentialId: 'c1'
      })]
    }).reason,
    'REPOSITORY_IDENTITY_MISMATCH'
  );
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({
      ...validInput,
      repositories: [spellbookRepo(), spellbookRepo({credentialId: 'cred-2'})]
    }).reason,
    'DUPLICATE_REPOSITORY'
  );
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({
      ...validInput,
      repositories: [spellbookRepo({overrides: {enrolled: false}})]
    }).reason,
    'UNENROLLED_REPOSITORY'
  );
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({
      ...validInput,
      repositories: [spellbookRepo({overrides: {ownerAuthorized: false}})]
    }).reason,
    'ENROLLMENT_NOT_AUTHORIZED'
  );

  // Concurrency cap & Spellbook <= 2 & coverage floors
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({
      ...validInput,
      repositories: [spellbookRepo({localConcurrencyCap: 3, maxConcurrency: 3})]
    }).reason,
    'REPO_CONCURRENCY_CAP_EXCEEDED'
  );
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({
      ...validInput,
      repositories: [factoryRepo({localConcurrencyCap: 2, maxConcurrency: 3})]
    }).reason,
    'REPO_CONCURRENCY_CAP_EXCEEDED'
  );
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({
      ...validInput,
      repositories: [factoryRepo({minLinePercent: 97})]
    }).reason,
    'REPO_POLICY_BELOW_MINIMUM'
  );
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({
      ...validInput,
      repositories: [spellbookRepo({minLinePercent: 96})]
    }).reason,
    'REPO_POLICY_BELOW_MINIMUM'
  );
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({
      ...validInput,
      repositories: [familyTreeRepo({minBranchPercent: 89})]
    }).reason,
    'REPO_POLICY_BELOW_MINIMUM'
  );

  // Lease accounting, in-flight validation, train validation, work item validation
  const lease1 = {leaseId: 'l1', issue: 1, laneId: 'lane-1', head: HEAD_1, ownedPaths: ['src/a']};
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({
      ...validInput,
      budget: baseBudget({active: 0, maxActive: 4}),
      repositories: [familyTreeRepo({inFlightLeases: [lease1]})]
    }).reason,
    'ACTIVE_LEASE_ACCOUNTING_MISMATCH'
  );
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({
      ...validInput,
      budget: baseBudget({active: 2, maxActive: 4}),
      repositories: [familyTreeRepo({localConcurrencyCap: 1, inFlightLeases: [lease1, {...lease1, leaseId: 'l2', issue: 2, laneId: 'lane-2', ownedPaths: ['src/b']}]})]
    }).reason,
    'REPO_CONCURRENCY_CAP_EXCEEDED'
  );
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({
      ...validInput,
      budget: baseBudget({active: 2, maxActive: 4}),
      repositories: [factoryRepo({
        inFlightLeases: [lease1, {...lease1, leaseId: 'l2', issue: 2, laneId: 'lane-2', ownedPaths: ['src/a/sub']}]
      })]
    }).reason,
    'INVALID_IN_FLIGHT_LEASE'
  );
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({
      ...validInput,
      budget: baseBudget({active: 1, maxActive: 4}),
      repositories: [factoryRepo({
        inFlightLeases: [{...lease1, ownedPaths: ['src/a', 'src/a/sub']}]
      })]
    }).reason,
    'INVALID_IN_FLIGHT_LEASE'
  );
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({
      ...validInput,
      repositories: [factoryRepo({overrides: {repositoryId: -1}})]
    }).reason,
    'REPOSITORY_SCHEMA_INVALID'
  );
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({
      ...validInput,
      repositories: [factoryRepo({defaultBranch: '../bad'})]
    }).reason,
    'INVALID_TRAIN_STATE'
  );
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({
      ...validInput,
      repositories: [factoryRepo({mergeQueueOverrides: {mode: 'unknown-mode'}})]
    }).reason,
    'INVALID_TRAIN_STATE'
  );
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({
      ...validInput,
      repositories: [factoryRepo({mergeQueueOverrides: {incrementalSpendMicros: 5}})]
    }).reason,
    'SPEND_UNKNOWN_OR_EXCEEDED'
  );
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({...validInput, lastServedConsumerRepositoryId: 0}).reason,
    'INPUT_UNKNOWN'
  );
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({
      ...validInput,
      repositories: [factoryRepo({mergeQueueOverrides: {supported: false}})]
    }).reason,
    'UNVERIFIED_MERGE_QUEUE'
  );
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({
      ...validInput,
      repositories: [factoryRepo({mergeQueueOverrides: {mode: 'serialized-protected-squash'}})]
    }).reason,
    'SOFTWARE_FACTORY_MERGE_QUEUE_REQUIRED'
  );
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({
      ...validInput,
      repositories: [factoryRepo({defaultBranch: 'trunk'})]
    }).reason,
    'SOFTWARE_FACTORY_MERGE_QUEUE_REQUIRED'
  );
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({
      ...validInput,
      repositories: [factoryRepo({candidates: [makeTrainCandidate(1, {simulatedSquashSha: MAIN_SHA})]})]
    }).reason,
    'INVALID_TRAIN_CANDIDATE'
  );
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({
      ...validInput,
      workItems: [makeWorkItem(999999, 1, 1)]
    }).reason,
    'UNENROLLED_REPOSITORY'
  );
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({
      ...validInput,
      workItems: [
        makeWorkItem(SOFTWARE_FACTORY_REPOSITORY_ID, 1, 1),
        makeWorkItem(SOFTWARE_FACTORY_REPOSITORY_ID, 1, 2, ['tools/other'])
      ]
    }).reason,
    'DUPLICATE_WORK_ITEM'
  );
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({
      ...validInput,
      workItems: [{...makeWorkItem(SOFTWARE_FACTORY_REPOSITORY_ID, 1, 1), ownedPaths: ['../escape']}]
    }).reason,
    'WORK_ITEM_UNKNOWN'
  );
});

const makeTier = (logicalLanes, wallClockMs, cpuTimeMs, peakMemoryMb, p95LatencyMs, contentionWaitMs, cancellationMs, overrides = {}) => ({
  logicalLanes,
  configuredWorkerCap: 12,
  observedPeakConcurrency: 12,
  concurrentAgentAuthorization: false,
  wallClockMs,
  cpuTimeMs,
  peakMemoryMb,
  p95LatencyMs,
  contentionWaitMs,
  cancellationPropagated: true,
  cancellationMs,
  duplicatePathLeases: 0,
  crossRepoLeaks: 0,
  ...overrides
});

const nodeBaselineProfile = () => ({
  runtime: PINNED_NODE_RUNTIME,
  workload: WORKLOAD_SHA,
  contractPreserved: true,
  deterministic: true,
  ciRestoreMs: 2000,
  ciCompileMs: 0,
  ciCoverageMs: 3000,
  coveredLines: 990,
  totalLines: 1000,
  coveredBranches: 970,
  totalBranches: 1000,
  securityReviewed: true,
  independentReview: true,
  rollbackReady: true,
  costVerified: true,
  incrementalSpendMicros: 0,
  logicalLaneTiers: [
    makeTier(100, 35000, 28000, 340, 900, 180, 45),
    makeTier(12, 10000, 6000, 150, 180, 25, 15),
    makeTier(50, 20000, 15000, 240, 460, 80, 30)
  ]
});

const dotnetMafCandidateProfile = () => ({
  runtime: PINNED_DOTNET_MAF_RUNTIME,
  dotnetSdkVersion: '10.0.404',
  mafWorkflowsVersion: '1.28.0',
  pregelSuperstepsVerified: true,
  checkpointResumeVerified: true,
  priorSuperstepsRepeatedOnResume: 0,
  aspireOtelActivitySourceVerified: true,
  forbiddenLegacyDependencies: [],
  shadowOnlyClientEnforced: true,
  workload: WORKLOAD_SHA,
  contractPreserved: true,
  deterministic: true,
  ciRestoreMs: 2500,
  ciCompileMs: 3000,
  ciCoverageMs: 2500,
  coveredLines: 995,
  totalLines: 1000,
  coveredBranches: 980,
  totalBranches: 1000,
  securityReviewed: true,
  independentReview: true,
  rollbackReady: true,
  costVerified: true,
  incrementalSpendMicros: 0,
  logicalLaneTiers: [
    makeTier(12, 2000, 1800, 95, 70, 8, 6),
    makeTier(50, 6000, 5000, 130, 160, 20, 10),
    makeTier(100, 12000, 10000, 180, 310, 45, 18)
  ]
});

const baseCohortSample = () => ({
  cohort: 'm02-maf-consolidation-v1',
  workload: WORKLOAD_SHA,
  gateSet: GATE_SET_SHA,
  complete: true,
  windowMs: 86400000,
  accepted: 5,
  censored: 0,
  gatesPassed: true,
  independentReview: true,
  mainHealthy: true,
  compatibleTrain: true,
  rollbackReady: true,
  duplicateDispatches: 0,
  unauthorizedWrites: 0,
  coveredLines: 990,
  totalLines: 1000,
  coveredBranches: 970,
  totalBranches: 1000,
  rework: 2,
  humanInterventions: 1,
  costVerified: true,
  incrementalSpendMicros: 0
});

const verifiedCohorts = (accepted = 50, source = 'verified', overrides = {}) => ({
  source,
  repository: SOFTWARE_FACTORY_REPOSITORY,
  policy: {minLinePercent: 98, minBranchPercent: 95},
  baseline: baseCohortSample(),
  candidate: {
    ...baseCohortSample(),
    accepted,
    coveredLines: 995,
    coveredBranches: 980,
    rework: 1,
    humanInterventions: 0
  },
  ...overrides
});

const benchmarkInput = (overrides = {}) => ({
  stop: false,
  hostedRunner: true,
  linuxAndWindowsVerified: true,
  workload: WORKLOAD_SHA,
  minNetGainPercent: 20,
  nodeBaseline: nodeBaselineProfile(),
  dotnetMafCandidate: dotnetMafCandidateProfile(),
  cohorts: verifiedCohorts(50, 'verified'),
  ...overrides
});

test('records Node 26.13.1 baseline across 12/50/100 logical lanes and marks unmeasured 2x-25x cohorts clearly', () => {
  const baselineOnly = evaluateDotnetConsolidationBenchmark(benchmarkInput({
    dotnetMafCandidate: null,
    cohorts: null
  }));

  assert.equal(baselineOnly.valid, true);
  assert.equal(baselineOnly.shadow, true);
  assert.equal(baselineOnly.liveDispatch, false);
  assert.equal(baselineOnly.liveMerge, false);
  assert.equal(baselineOnly.baselineReady, true);
  assert.equal(baselineOnly.comparable, false);
  assert.equal(baselineOnly.consolidationEligible, false);
  assert.equal(baselineOnly.recommendation, 'retain-node-authoritative');
  assert.equal(baselineOnly.reason, 'NODE_BASELINE_RECORDED');
  assert.equal(baselineOnly.logicalLaneClassification, LOGICAL_LANE_CLASSIFICATION);
  assert.equal(baselineOnly.logicalLanesAreConcurrentAgentAuthorization, false);
  assert.deepEqual(
    baselineOnly.nodeBaseline.logicalLaneTiers.map(t => t.logicalLanes),
    [...LOGICAL_LANE_TIERS]
  );
  assert.equal(
    baselineOnly.nodeBaseline.logicalLaneTiers.every(
      t => t.unitKind === 'logical-lanes' && t.concurrentAgentAuthorization === false
    ),
    true
  );
  // Node CI overhead = 2000 + 0 + 3000 = 5000ms -> end-to-end = [15000, 25000, 40000], suite net = 65000 + 5000 = 70000ms
  assert.deepEqual(
    baselineOnly.nodeBaseline.logicalLaneTiers.map(t => t.endToEndMs),
    [15000, 25000, 40000]
  );
  assert.equal(baselineOnly.nodeBaseline.netEndToEndMs, 70000);
  assert.equal(baselineOnly.cohorts.status, 'UNMEASURED_BASELINE_REQUIRED');
  assert.equal(baselineOnly.cohorts.keepStretchOpen, true);
  assert.equal(baselineOnly.cohorts.comparableAcceptedUnits, 0);
  assert.equal(baselineOnly.cohorts.baseline, null);
  assert.equal(baselineOnly.cohorts.candidate, null);
  assert.deepEqual(
    baselineOnly.cohorts.checkpoints.map(c => c.multiplier),
    [...THROUGHPUT_COHORT_MULTIPLIERS]
  );
});

test('approves single-runtime .NET 10 MAF 1.28.0 consolidation only when CI-inclusive logical lanes and verified 2x-25x cohorts pass', () => {
  const tenX = evaluateDotnetConsolidationBenchmark(benchmarkInput());
  assert.equal(tenX.valid, true);
  assert.equal(tenX.consolidationEligible, true);
  assert.equal(tenX.recommendation, 'dotnet-10-consolidation-eligible');
  assert.equal(tenX.reason, 'DOTNET_10_CONSOLIDATION_ELIGIBLE');
  // .NET CI overhead = 2500 + 3000 + 2500 = 8000ms -> tiers = [10000, 14000, 20000], suite net = 20000 + 8000 = 28000ms vs 70000ms (60% net gain!)
  assert.equal(tenX.netGainPercent, 60);
  assert.deepEqual(tenX.tierComparisons.map(t => t.logicalLanes), [12, 50, 100]);
  assert.equal(tenX.cohorts.highestCheckpoint, '10x');
  assert.equal(tenX.cohorts.keepStretchOpen, true);
  assert.equal(tenX.cohorts.comparableAcceptedUnits, 5);
  assert.deepEqual(tenX.cohorts.baseline, {
    accepted: 5,
    censored: 0,
    windowMs: 86400000,
    acceptedPerDay: 5,
    rework: 2,
    humanInterventions: 1,
    incrementalSpendMicros: 0,
    coverage: {coveredLines: 990, totalLines: 1000, coveredBranches: 970, totalBranches: 1000}
  });
  assert.deepEqual(tenX.cohorts.candidate, {
    accepted: 50,
    censored: 0,
    windowMs: 86400000,
    acceptedPerDay: 50,
    rework: 1,
    humanInterventions: 0,
    incrementalSpendMicros: 0,
    coverage: {coveredLines: 995, totalLines: 1000, coveredBranches: 980, totalBranches: 1000}
  });

  // Verified 25x closes stretch
  const twentyFiveX = evaluateDotnetConsolidationBenchmark(benchmarkInput({
    dotnetMafCandidate: {...dotnetMafCandidateProfile(), mafWorkflowsVersion: '2.0.0'},
    cohorts: verifiedCohorts(125, 'verified')
  }));
  assert.equal(twentyFiveX.consolidationEligible, true);
  assert.equal(twentyFiveX.cohorts.highestCheckpoint, '25x');
  assert.equal(twentyFiveX.cohorts.keepStretchOpen, false);

  // Spellbook & other consumer cohort policies work cleanly
  const spellbookCohorts = evaluateDotnetConsolidationBenchmark(benchmarkInput({
    cohorts: {
      source: 'verified',
      repository: 'Jamula/Spellbook',
      policy: {minLinePercent: 97, minBranchPercent: 90},
      baseline: {...baseCohortSample(), coveredLines: 975, coveredBranches: 910},
      candidate: {...baseCohortSample(), accepted: 25, coveredLines: 980, coveredBranches: 920}
    }
  }));
  assert.equal(spellbookCohorts.consolidationEligible, true);
  assert.equal(spellbookCohorts.cohorts.highestCheckpoint, '5x');

  const familyTreeCohorts = evaluateDotnetConsolidationBenchmark(benchmarkInput({
    cohorts: {
      source: 'verified',
      repository: 'Jamula/FamilyTree',
      policy: {minLinePercent: 95, minBranchPercent: 90},
      baseline: {...baseCohortSample(), coveredLines: 955, coveredBranches: 905},
      candidate: {...baseCohortSample(), accepted: 10, coveredLines: 960, coveredBranches: 910}
    }
  }));
  assert.equal(familyTreeCohorts.consolidationEligible, true);
  assert.equal(familyTreeCohorts.cohorts.highestCheckpoint, '2x');
});

test('retains Node as authoritative on CI overhead regressions, unmeasured/synthetic cohorts, legacy deps, safety, review or version failures', () => {
  // Concurrent agent authorization claim on logical-lane benchmark is rejected immediately
  const badAuthTier = evaluateDotnetConsolidationBenchmark(benchmarkInput({
    dotnetMafCandidate: {
      ...dotnetMafCandidateProfile(),
      logicalLaneTiers: [
        makeTier(12, 2000, 1800, 95, 70, 8, 6, {concurrentAgentAuthorization: true}),
        makeTier(50, 6000, 5000, 130, 160, 20, 10),
        makeTier(100, 12000, 10000, 180, 310, 45, 18)
      ]
    }
  }));
  assert.equal(badAuthTier.valid, false);
  assert.equal(badAuthTier.reason, 'UNAUTHORIZED_CONCURRENT_AGENT_CLAIM');

  assert.equal(
    evaluateDotnetConsolidationBenchmark(benchmarkInput({
      nodeBaseline: {
        ...nodeBaselineProfile(),
        logicalLaneTiers: [
          makeTier(12, 10000, 6000, 150, 180, 25, 15, {concurrentAgentAuthorization: true}),
          makeTier(50, 20000, 15000, 240, 460, 80, 30),
          makeTier(100, 35000, 28000, 340, 900, 180, 45)
        ]
      }
    })).reason,
    'UNAUTHORIZED_CONCURRENT_AGENT_CLAIM'
  );

  // Stop, hosted runner, cross-platform Linux + Windows gates
  assert.equal(evaluateDotnetConsolidationBenchmark(benchmarkInput({stop: true})).reason, 'STOPPED');
  assert.equal(
    evaluateDotnetConsolidationBenchmark(benchmarkInput({hostedRunner: false})).reason,
    'HOSTED_EVIDENCE_REQUIRED'
  );
  assert.equal(
    evaluateDotnetConsolidationBenchmark(benchmarkInput({linuxAndWindowsVerified: false})).reason,
    'CROSS_PLATFORM_EVIDENCE_REQUIRED'
  );

  // Unsupported .NET / MAF versions and excluded legacy packages
  for (const verPatch of [
    {dotnetSdkVersion: '9.0.300'},
    {dotnetSdkVersion: '10.0.404-rc.1'},
    {mafWorkflowsVersion: '1.27.9'},
    {mafWorkflowsVersion: '1.28.0-preview.1'}
  ]) {
    assert.equal(
      evaluateDotnetConsolidationBenchmark(benchmarkInput({
        dotnetMafCandidate: {...dotnetMafCandidateProfile(), ...verPatch}
      })).reason,
      'MAF_RUNTIME_VERSION_UNSUPPORTED'
    );
  }
  for (const legacyPkg of ['SemanticKernel', 'AutoGen', 'GitHubModels', 'Temporal', 'LangGraph']) {
    assert.equal(
      evaluateDotnetConsolidationBenchmark(benchmarkInput({
        dotnetMafCandidate: {...dotnetMafCandidateProfile(), forbiddenLegacyDependencies: [legacyPkg]}
      })).reason,
      'LEGACY_OR_EXCLUDED_DEPENDENCY_DETECTED'
    );
  }

  // Workload, paired worker-cap & spend checks on both Node and .NET
  assert.equal(
    evaluateDotnetConsolidationBenchmark(benchmarkInput({
      nodeBaseline: {
        ...nodeBaselineProfile(),
        logicalLaneTiers: [
          makeTier(12, 10000, 6000, 150, 180, 25, 15, {configuredWorkerCap: 1, observedPeakConcurrency: 1}),
          makeTier(50, 20000, 15000, 240, 460, 80, 30, {configuredWorkerCap: 1, observedPeakConcurrency: 1}),
          makeTier(100, 35000, 28000, 340, 900, 180, 45, {configuredWorkerCap: 1, observedPeakConcurrency: 1})
        ]
      }
    })).reason,
    'UNMATCHED_WORKER_CAP'
  );
  assert.equal(
    evaluateDotnetConsolidationBenchmark(benchmarkInput({
      nodeBaseline: {...nodeBaselineProfile(), workload: HEAD_1}
    })).reason,
    'UNMATCHED_WORKLOAD'
  );
  assert.equal(
    evaluateDotnetConsolidationBenchmark(benchmarkInput({
      dotnetMafCandidate: {...dotnetMafCandidateProfile(), workload: HEAD_1}
    })).reason,
    'UNMATCHED_WORKLOAD'
  );
  assert.equal(
    evaluateDotnetConsolidationBenchmark(benchmarkInput({
      nodeBaseline: {...nodeBaselineProfile(), incrementalSpendMicros: 1}
    })).reason,
    'SPEND_UNKNOWN_OR_EXCEEDED'
  );
  assert.equal(
    evaluateDotnetConsolidationBenchmark(benchmarkInput({
      dotnetMafCandidate: {...dotnetMafCandidateProfile(), costVerified: false}
    })).reason,
    'SPEND_UNKNOWN_OR_EXCEEDED'
  );

  // Node baseline unverified
  for (const nodePatch of [
    {contractPreserved: false},
    {coveredLines: 970},
    {securityReviewed: false},
    {
      logicalLaneTiers: [
        makeTier(12, 10000, 6000, 150, 180, 25, 15, {duplicatePathLeases: 1}),
        makeTier(50, 20000, 15000, 240, 460, 80, 30),
        makeTier(100, 35000, 28000, 340, 900, 180, 45)
      ]
    }
  ]) {
    assert.equal(
      evaluateDotnetConsolidationBenchmark(benchmarkInput({
        nodeBaseline: {...nodeBaselineProfile(), ...nodePatch}
      })).reason,
      'NODE_BASELINE_UNVERIFIED'
    );
  }

  // .NET MAF architecture, checkpoint resume, OTel, safety, coverage, review, rollback
  for (const mafSafetyPatch of [
    {contractPreserved: false},
    {deterministic: false},
    {shadowOnlyClientEnforced: false},
    {pregelSuperstepsVerified: false},
    {checkpointResumeVerified: false},
    {priorSuperstepsRepeatedOnResume: 1},
    {aspireOtelActivitySourceVerified: false},
    {
      logicalLaneTiers: [
        makeTier(12, 2000, 1800, 95, 70, 8, 6, {crossRepoLeaks: 1}),
        makeTier(50, 6000, 5000, 130, 160, 20, 10),
        makeTier(100, 12000, 10000, 180, 310, 45, 18)
      ]
    }
  ]) {
    const res = evaluateDotnetConsolidationBenchmark(benchmarkInput({
      dotnetMafCandidate: {...dotnetMafCandidateProfile(), ...mafSafetyPatch}
    }));
    assert.equal(res.consolidationEligible, false);
    assert.equal(res.recommendation, 'retain-node-authoritative');
    assert.equal(res.reason, 'MAF_ARCHITECTURE_OR_SAFETY_UNVERIFIED');
  }

  for (const covPatch of [{coveredLines: 979}, {coveredLines: 985}, {coveredBranches: 960}]) {
    const res = evaluateDotnetConsolidationBenchmark(benchmarkInput({
      dotnetMafCandidate: {...dotnetMafCandidateProfile(), ...covPatch}
    }));
    assert.equal(res.reason, 'CANDIDATE_COVERAGE_REGRESSION');
  }

  for (const revPatch of [{securityReviewed: false}, {independentReview: false}, {rollbackReady: false}]) {
    const res = evaluateDotnetConsolidationBenchmark(benchmarkInput({
      dotnetMafCandidate: {...dotnetMafCandidateProfile(), ...revPatch}
    }));
    assert.equal(res.reason, 'REVIEW_OR_ROLLBACK_UNREADY');
  }

  // Tier runtime metric regression vs CI overhead eating runtime gain vs insufficient net gain
  assert.equal(
    evaluateDotnetConsolidationBenchmark(benchmarkInput({
      dotnetMafCandidate: {
        ...dotnetMafCandidateProfile(),
        logicalLaneTiers: [
          makeTier(12, 2000, 1800, 200, 70, 8, 6),
          makeTier(50, 6000, 5000, 130, 160, 20, 10),
          makeTier(100, 12000, 10000, 180, 310, 45, 18)
        ]
      }
    })).reason,
    'TIER_METRIC_REGRESSION'
  );

  // CI restore+compile+coverage overhead exceeds 12-lane runtime savings (2000 + 14000 = 16000 >= 15000)
  assert.equal(
    evaluateDotnetConsolidationBenchmark(benchmarkInput({
      dotnetMafCandidate: {
        ...dotnetMafCandidateProfile(),
        ciRestoreMs: 5000,
        ciCompileMs: 6000,
        ciCoverageMs: 3000
      }
    })).reason,
    'CI_OVERHEAD_EXCEEDS_RUNTIME_GAIN'
  );

  // 12-lane tier saves 1000ms out of 15000ms (6.67% < 20% minNetGainPercent)
  assert.equal(
    evaluateDotnetConsolidationBenchmark(benchmarkInput({
      dotnetMafCandidate: {
        ...dotnetMafCandidateProfile(),
        ciRestoreMs: 4000,
        ciCompileMs: 5000,
        ciCoverageMs: 3000
      }
    })).reason,
    'INSUFFICIENT_NET_END_TO_END_GAIN'
  );

  // Suite-wide net gain below minNetGainPercent even when each individual tier meets it
  assert.equal(
    evaluateDotnetConsolidationBenchmark(benchmarkInput({
      minNetGainPercent: 30,
      nodeBaseline: {
        ...nodeBaselineProfile(),
        ciRestoreMs: 5000,
        ciCompileMs: 0,
        ciCoverageMs: 5000,
        logicalLaneTiers: [
          makeTier(12, 10000, 6000, 150, 180, 25, 15),
          makeTier(50, 10000, 6000, 150, 180, 25, 15),
          makeTier(100, 10000, 6000, 150, 180, 25, 15)
        ]
      },
      dotnetMafCandidate: {
        ...dotnetMafCandidateProfile(),
        ciRestoreMs: 0,
        ciCompileMs: 0,
        ciCoverageMs: 0,
        logicalLaneTiers: [
          makeTier(12, 10000, 6000, 150, 180, 25, 15),
          makeTier(50, 10000, 6000, 150, 180, 25, 15),
          makeTier(100, 10000, 6000, 150, 180, 25, 15)
        ]
      }
    })).reason,
    'INSUFFICIENT_NET_END_TO_END_GAIN'
  );

  // Cohort gates: unmeasured, below 2x, synthetic-only, policy/quality/coverage/rework/spend/throughput regressions
  assert.equal(
    evaluateDotnetConsolidationBenchmark(benchmarkInput({cohorts: null})).reason,
    'MEASURED_COHORTS_REQUIRED'
  );
  assert.equal(
    evaluateDotnetConsolidationBenchmark(benchmarkInput({cohorts: verifiedCohorts(8, 'verified')})).reason,
    'COHORT_BELOW_FIRST_CHECKPOINT'
  );
  assert.equal(
    evaluateDotnetConsolidationBenchmark(benchmarkInput({cohorts: verifiedCohorts(125, 'synthetic')})).reason,
    'VERIFIED_HOSTED_COHORTS_REQUIRED'
  );
  assert.equal(
    evaluateDotnetConsolidationBenchmark(benchmarkInput({
      cohorts: verifiedCohorts(25, 'verified', {policy: {minLinePercent: 97, minBranchPercent: 95}})
    })).reason,
    'POLICY_BELOW_MINIMUM'
  );
  assert.equal(
    evaluateDotnetConsolidationBenchmark(benchmarkInput({
      cohorts: verifiedCohorts(4, 'verified')
    })).reason,
    'UNMATCHED_OR_INCOMPLETE_COHORT'
  );
  assert.equal(
    evaluateDotnetConsolidationBenchmark(benchmarkInput({
      cohorts: {
        ...verifiedCohorts(25, 'verified'),
        candidate: {...verifiedCohorts(25, 'verified').candidate, gatesPassed: false}
      }
    })).reason,
    'QUALITY_OR_SAFETY_GATE_FAILED'
  );
  assert.equal(
    evaluateDotnetConsolidationBenchmark(benchmarkInput({
      cohorts: {
        ...verifiedCohorts(25, 'verified'),
        candidate: {...verifiedCohorts(25, 'verified').candidate, coveredLines: 985}
      }
    })).reason,
    'COVERAGE_REGRESSION'
  );
  assert.equal(
    evaluateDotnetConsolidationBenchmark(benchmarkInput({
      cohorts: {
        ...verifiedCohorts(25, 'verified'),
        baseline: {...baseCohortSample(), accepted: 10, windowMs: 172800000, rework: 2},
        candidate: {...verifiedCohorts(25, 'verified').candidate, accepted: 5, windowMs: 17280000, rework: 2}
      }
    })).reason,
    'REWORK_OR_INTERVENTION_REGRESSION'
  );
  assert.equal(
    evaluateDotnetConsolidationBenchmark(benchmarkInput({
      cohorts: {
        ...verifiedCohorts(25, 'verified'),
        candidate: {...verifiedCohorts(25, 'verified').candidate, incrementalSpendMicros: null}
      }
    })).reason,
    'SPEND_UNKNOWN_OR_EXCEEDED'
  );
  assert.equal(
    evaluateDotnetConsolidationBenchmark(benchmarkInput({
      cohorts: {
        ...verifiedCohorts(5, 'verified'),
        candidate: {...verifiedCohorts(5, 'verified').candidate, accepted: 5, windowMs: 172800000}
      }
    })).reason,
    'THROUGHPUT_REGRESSION'
  );

  // Malformed shapes, proxies, and getters on benchmark evaluator
  const trapBench = Object.defineProperties({}, {
    ...Object.getOwnPropertyDescriptors(benchmarkInput()),
    workload: {enumerable: true, get() { throw new Error('must not run'); }}
  });
  for (const invalid of [
    null,
    trapBench,
    new Proxy(benchmarkInput(), {get() { throw new Error('must not run'); }}),
    benchmarkInput({minNetGainPercent: 10}),
    benchmarkInput({nodeBaseline: {...nodeBaselineProfile(), runtime: 'other-node'}}),
    benchmarkInput({nodeBaseline: {...nodeBaselineProfile(), logicalLaneTiers: []}}),
    benchmarkInput({
      nodeBaseline: {
        ...nodeBaselineProfile(),
        logicalLaneTiers: [
          makeTier(12, 10000, 6000, 150, 180, 25, 15),
          makeTier(12, 20000, 15000, 240, 460, 80, 30),
          makeTier(100, 35000, 28000, 340, 900, 180, 45)
        ]
      }
    }),
    benchmarkInput({dotnetMafCandidate: {...dotnetMafCandidateProfile(), runtime: 'dotnet-other'}}),
    benchmarkInput({dotnetMafCandidate: {...dotnetMafCandidateProfile(), forbiddenLegacyDependencies: ['']}}),
    benchmarkInput({cohorts: {bad: true}})
  ]) {
    assert.equal(evaluateDotnetConsolidationBenchmark(invalid).reason, 'EVIDENCE_UNKNOWN');
  }
});

test('verifies committed m02-04-maf-throughput-cohort.json receipt across Waves 1-5 trains, .NET 10 MAF 1.28.0 benchmark, and 14-issue streamlined #16 cohort readout', () => {
  const receiptUrl = new URL('../../docs/evidence/m02-04-maf-throughput-cohort.json', import.meta.url);
  const receipt = JSON.parse(readFileSync(receiptUrl, 'utf8'));

  assert.equal(receipt.schemaVersion, 'm02-04-maf-throughput-cohort-v2');
  assert.equal(receipt.issue, 16);
  assert.equal(receipt.evaluatedMainHeadSha, '1371a40aa7958fdd9dfe1dbe549952f62adeeae8');
  assert.deepEqual(receipt.sharedClosureIssues, [...SHARED_M02_EXIT_ISSUES]);
  assert.equal(receipt.m01AnchorIssue, M01_EXIT_ANCHOR_ISSUE);
  assert.equal(receipt.provenance.streamlinedM02CohortVerified, true);
  assert.equal(receipt.provenance.multiCohortLadderRetired, true);
  assert.equal(receipt.provenance.keepIssue16Open, false);
  assert.equal(receipt.provenance.acceptedCohortIssuesCompleted, 14);
  assert.equal(receipt.provenance.acceptedCohortIssuesRequired, STREAMLINED_M02_MIN_ACCEPTED_ISSUES);
  assert.deepEqual(
    receipt.provenance.acceptedCohortIssueNumbers,
    [4, 5, 6, 7, 8, 9, 13, 15, 17, 18, 66, 105, 118, 136]
  );
  assert.equal(receipt.provenance.coordinatorDispatchedWavePrsMerged, 59);
  assert.equal(receipt.provenance.futureGhAwCronWavesStatus, 'DEFERRED_PENDING_GHAW_CRON_ENABLEMENT');
  assert.equal(receipt.provenance.futureGhAwCronOutcomesCompleted, 0);
  assert.equal(receipt.provenance.incrementalSpendUsd, 0);

  // Verify .NET 10.0.404 MAF 1.28.0 --smoke and --benchmark receipts
  assert.equal(receipt.dotnetMafCliReceipts.dotnetSdkVersion, '10.0.404');
  assert.equal(receipt.dotnetMafCliReceipts.smokeOutput.version, '1.28.0');
  assert.equal(receipt.dotnetMafCliReceipts.smokeOutput.superstepsCompleted, 9);
  assert.equal(receipt.dotnetMafCliReceipts.smokeOutput.priorSuperstepsRepeated, 0);
  assert.equal(receipt.dotnetMafCliReceipts.smokeOutput.incrementalSpendUsd, 0);
  assert.deepEqual(
    receipt.dotnetMafCliReceipts.benchmarkOutput.logicalLaneSimulations.map(s => s.logicalLanes),
    [12, 50, 100]
  );

  // Deterministically replay all 9 Squash Merge Queue sub-trains across Waves 1-5 (59 PRs total)
  for (const [waveKey, expectedStatus, expectedBefore, expectedAfter, expectedCount, expectedFinalSha] of [
    ['wave1a', 'TRAIN_DRAINED', true, true, 3, '1a9b910c626c1b7a32775da9ba681bd09af9670c'],
    ['wave1b', 'TRAIN_DRAINED', true, true, 7, '0eb14ed3d6bd8d0b1da190593110df0957e46c37'],
    ['wave1c', 'TRAIN_DRAINED', true, true, 5, '90f3a0e85e5ad87ef0993fa0ab9dd264adf35bbe'],
    ['wave1d', 'TRAIN_DRAINED', true, true, 2, 'c77612ec3f4e89d792b3b77741718824318ca676'],
    ['wave2', 'HALTED_ON_POST_MERGE_MAIN_FAILURE', true, false, 7, 'cec2745b7b8a21e77ad9f2839d4255d42305d419'],
    ['wave3', 'TRAIN_DRAINED', false, true, 21, 'b0924c3807f797e6090e1dc3e1e65fc9caa07550'],
    ['wave4', 'TRAIN_DRAINED', true, true, 4, 'ec438f54088f30856c2df6ff626e894dde2a0100'],
    ['wave5a', 'TRAIN_DRAINED', true, true, 8, 'e8e357febbfe1617189c38d211c8dfdfa6178aa3'],
    ['wave5b', 'TRAIN_DRAINED', true, true, 2, '1371a40aa7958fdd9dfe1dbe549952f62adeeae8']
  ]) {
    const sim = receipt.waveTrainSimulations[waveKey];
    assert.equal(
      sim.gateInputProvenance,
      'synthetic-gate-fixtures-over-measured-github-shas-paths-and-merge-queue-timestamps'
    );
    const replayed = allocatePortfolioCapacityAndSimulateTrains(sim.input);
    assert.deepEqual(replayed, sim.evaluation);
    assert.equal(replayed.valid, true);
    assert.equal(replayed.repositoryResults[0].train.trainStatus, expectedStatus);
    assert.equal(replayed.repositoryResults[0].train.mainHealthyBefore, expectedBefore);
    assert.equal(replayed.repositoryResults[0].train.mainHealthyAfter, expectedAfter);
    assert.equal(replayed.repositoryResults[0].train.mergedPrs.length, expectedCount);
    assert.equal(replayed.repositoryResults[0].train.isolatedCandidates.length, 0);
    assert.equal(replayed.repositoryResults[0].train.finalMainSha, expectedFinalSha);
  }
  const wave3SortedPrs = [...receipt.waveTrainSimulations.wave3.evaluation.repositoryResults[0].train.mergedPrs].sort((a, b) => a - b);
  assert.deepEqual(wave3SortedPrs, Array.from({length: 21}, (_, idx) => 145 + idx));

  // Deterministically replay single-runtime consolidation benchmark and verify provenance labels
  assert.equal(receipt.nodeLogicalLaneReceipt.runtime, PINNED_NODE_RUNTIME);
  assert.deepEqual(
    receipt.consolidationBenchmark.metricProvenance.illustrativeFields,
    ['cpuTimeMs', 'peakMemoryMb', 'p95LatencyMs', 'contentionWaitMs', 'cancellationMs']
  );
  const replayedConsolidation = evaluateDotnetConsolidationBenchmark(receipt.consolidationBenchmark.input);
  assert.deepEqual(replayedConsolidation, receipt.consolidationBenchmark.evaluation);
  assert.equal(replayedConsolidation.valid, true);
  assert.equal(replayedConsolidation.recommendation, 'retain-node-authoritative');

  // Deterministically replay streamlined M02 cohort readout across Waves 1-5 and 14 real accepted issues
  const params = receipt.streamlinedM02CohortReadout.parameters;
  const replayedStreamlined = evaluateStreamlinedM02CohortReadout({
    stop: params.stop,
    repositoryId: params.repositoryId,
    repository: params.repository,
    headSha: params.headSha,
    policy: params.policy,
    billingHardStopVerified: params.billingHardStopVerified,
    incrementalSpendMicros: params.incrementalSpendMicros,
    futureGhAwCronDisclosure: params.futureGhAwCronDisclosure,
    exactHeadCoverage: params.exactHeadCoverage,
    portfolioTrainInputs: params.portfolioTrainInputKeys.map(k => receipt.waveTrainSimulations[k].input),
    benchmarkInput: receipt.consolidationBenchmark.input,
    engineeringWaves: params.engineeringWaves,
    acceptedIssueOutcomes: params.acceptedIssueOutcomes
  });
  assert.deepEqual(replayedStreamlined, receipt.streamlinedM02CohortReadout.evaluation);
  assert.equal(replayedStreamlined.valid, true);
  assert.equal(replayedStreamlined.streamlinedM02CohortVerified, true);
  assert.equal(replayedStreamlined.issue16ExitReady, true);
  assert.equal(replayedStreamlined.keepIssue16Open, false);
  assert.equal(replayedStreamlined.provenanceSeparated, true);
  assert.equal(replayedStreamlined.coordinatorWaveProvenance, COORDINATOR_DISPATCHED_WAVE_PROVENANCE);
  assert.deepEqual(replayedStreamlined.futureGhAwCronDisclosure, {
    provenanceKind: FUTURE_GH_AW_CRON_PROVENANCE,
    status: 'DEFERRED_PENDING_GHAW_CRON_ENABLEMENT',
    completedCronOutcomes: 0,
    conflatedWithCoordinatorWaves: false
  });
  assert.equal(replayedStreamlined.runtimePosture, 'dual-runtime-retain-node-authoritative');
  assert.equal(replayedStreamlined.status, 'STREAMLINED_M02_COHORT_VERIFIED');
  assert.equal(replayedStreamlined.reason, 'STREAMLINED_M02_EXIT_ELIGIBLE');
  assert.equal(replayedStreamlined.engineeringWaveSummary.waveCount, 5);
  assert.equal(replayedStreamlined.engineeringWaveSummary.totalMergedPrs, 59);
  assert.equal(replayedStreamlined.engineeringWaveSummary.historicalPostMergeMainFailures, 2);
  assert.equal(replayedStreamlined.engineeringWaveSummary.unresolvedPostMergeMainFailures, 0);
  assert.equal(replayedStreamlined.acceptedCohortSummary.acceptedIssueCount, 14);
  assert.equal(replayedStreamlined.acceptedCohortSummary.partialOutcomeCount, 0);
  assert.equal(replayedStreamlined.acceptedCohortSummary.remainingRequiredCount, 0);
  assert.equal(replayedStreamlined.acceptedCohortSummary.acceptedTrainMainBreakages, 0);
  assert.equal(replayedStreamlined.acceptedCohortSummary.unresolvedFindings, 0);
  assert.equal(replayedStreamlined.acceptedCohortSummary.incrementalSpendMicros, 0);
});

const WAVE_END_SHA = sha('9');

const makeUnattendedOutcome = (idx, total = 5, overrides = {}) => ({
  repositoryId: SOFTWARE_FACTORY_REPOSITORY_ID,
  repository: SOFTWARE_FACTORY_REPOSITORY,
  issue: 200 + idx,
  pr: 300 + idx,
  provenanceKind: 'unattended-copilot-issue-outcome',
  agentActor: UNATTENDED_COPILOT_ACTOR,
  issueAccepted: true,
  allRequiredPrsMerged: true,
  m01CohortMember: idx <= 3,
  parallelBatchGroup: idx <= 2 ? 'm01-parallel-pair' : null,
  reviewRepairVerified: idx === 3,
  parentMainSha: idx === 1 ? WAVE_END_SHA : String(idx - 1).padStart(40, '8'),
  headSha: String(idx).padStart(40, '7'),
  squashMergeSha: idx === total ? WORKLOAD_SHA : String(idx).padStart(40, '8'),
  assignedAtMs: 1795900000000 + idx * 60000,
  mergedAtMs: 1795901800000 + idx * 60000,
  mergeQueueDurationMs: 180000 + idx * 5000,
  ownedPaths: [`tools/unattended-lane-${idx}.mjs`],
  coveredLines: 990,
  totalLines: 1000,
  coveredBranches: 970,
  totalBranches: 1000,
  checksPassed: true,
  securityClear: true,
  independentReview: true,
  unresolvedFindings: 0,
  mainHealthyAfterMerge: true,
  rollbackReady: true,
  reworkIterations: idx === 3 ? 1 : 0,
  routineHumanInterventions: 0,
  duplicateDispatches: 0,
  unauthorizedWrites: 0,
  incrementalSpendMicros: 0,
  ...overrides
});

const buildTrainCandidatesFromOutcomes = outcomes =>
  outcomes.map((o, idx) => makeTrainCandidate(o.pr, {
    head: o.headSha,
    observedHead: o.headSha,
    expectedBase: o.parentMainSha,
    simulatedSquashSha: idx === outcomes.length - 1 ? WORKLOAD_SHA : o.squashMergeSha,
    ownedPaths: [...o.ownedPaths],
    coveredLines: Math.max(990, o.coveredLines),
    totalLines: o.totalLines,
    coveredBranches: Math.max(970, o.coveredBranches),
    totalBranches: o.totalBranches,
    reviewState: 'APPROVED'
  }));

const makeSharedCohortMeasurements = (overrides = {}) => ({
  repositoryId: SOFTWARE_FACTORY_REPOSITORY_ID,
  repository: SOFTWARE_FACTORY_REPOSITORY,
  headSha: WORKLOAD_SHA,
  evaluatedIssueNumbers: [201, 202, 203, 204, 205],
  baselineExplorationStepsP50: 14,
  candidateExplorationStepsP50: 8,
  baselineContextBytesLoadedP50: 32000,
  candidateContextBytesLoadedP50: 18000,
  baselineReworkRateBps: 4000,
  candidateReworkRateBps: 2000,
  scorecardReadoutVerified: true,
  kaizenVerificationPassed: true,
  incrementalSpendMicros: 0,
  ...overrides
});

const makeSharedCohortInput = (overrides = {}) => {
  const repositoryId = overrides.repositoryId ?? SOFTWARE_FACTORY_REPOSITORY_ID;
  const repository = overrides.repository ?? SOFTWARE_FACTORY_REPOSITORY;
  const headSha = overrides.headSha ?? WORKLOAD_SHA;
  const unattendedOutcomes = overrides.unattendedOutcomes ??
    [1, 2, 3, 4, 5].map(idx => makeUnattendedOutcome(idx, 5));
  const acceptedIssues = unattendedOutcomes
    .filter(o => o.issueAccepted && o.allRequiredPrsMerged)
    .map(o => o.issue);
  const totalRework = unattendedOutcomes
    .filter(o => o.issueAccepted && o.allRequiredPrsMerged)
    .reduce((sum, o) => sum + o.reworkIterations, 0);
  const defaultMeasurements = acceptedIssues.length >= 5
    ? makeSharedCohortMeasurements({
      repositoryId,
      repository,
      headSha,
      evaluatedIssueNumbers: acceptedIssues,
      candidateReworkRateBps: Math.round((totalRework * 10000) / acceptedIssues.length)
    })
    : null;
  const waveFinalSha = unattendedOutcomes.length === 0 ? WORKLOAD_SHA : WAVE_END_SHA;
  const trainInitialSha = unattendedOutcomes.length === 0 ? MAIN_SHA : WAVE_END_SHA;
  const defaultCandidates = unattendedOutcomes.length === 0
    ? [makeTrainCandidate(168, {simulatedSquashSha: WORKLOAD_SHA, reviewState: 'COMMENTED_CLEAR'})]
    : buildTrainCandidatesFromOutcomes(unattendedOutcomes);
  const portfolioInput = {
    stop: false,
    budget: baseBudget({active: 0, maxActive: 4}),
    repositories: [
      factoryRepo({
        candidates: defaultCandidates,
        overrides: {
          train: {
            defaultBranch: 'main',
            mainSha: trainInitialSha,
            mainHealthy: true,
            mergeQueue: {
              mode: 'native-merge-queue',
              supported: true,
              ownerApproved: true,
              costVerified: true,
              incrementalSpendMicros: 0
            },
            candidates: defaultCandidates
          }
        }
      })
    ],
    workItems: [makeWorkItem(SOFTWARE_FACTORY_REPOSITORY_ID, 16, 1)]
  };
  return {
    stop: false,
    repositoryId,
    repository,
    headSha,
    policy: {minLinePercent: 98, minBranchPercent: 95},
    billingHardStopVerified: true,
    incrementalSpendMicros: 0,
    portfolioInput,
    benchmarkInput: benchmarkInput({cohorts: null}),
    engineeringWaves: [
      {
        waveId: 'wave-4',
        provenanceKind: 'session-orchestrated-merge-queue-wave',
        initialMainSha: MAIN_SHA,
        finalMainSha: waveFinalSha,
        windowStartMs: 1795800000000,
        windowEndMs: 1795803600000,
        prNumbers: [166, 167, 168, 169],
        mergeQueueDurationsMs: [138000, 204000, 186000, 180000],
        postMergeMainFailures: 0,
        recoveredBeforeNextWave: false,
        incrementalSpendMicros: 0
      }
    ],
    unattendedOutcomes,
    sharedCohortMeasurements: defaultMeasurements,
    ...overrides
  };
};

test('evaluates shared 5-outcome M02 cohort completion, composition requirements, and fail-closed regression gates', () => {
  // Invalid mainRecoveryVerified states in portfolio train fail closed
  assert.equal(
    allocatePortfolioCapacityAndSimulateTrains({
      stop: false,
      budget: baseBudget({active: 0, maxActive: 4}),
      repositories: [
        factoryRepo({
          overrides: {
            train: {
              defaultBranch: 'main',
              mainSha: MAIN_SHA,
              mainHealthy: true,
              mainRecoveryVerified: true,
              mergeQueue: {
                mode: 'native-merge-queue',
                supported: true,
                ownerApproved: true,
                costVerified: true,
                incrementalSpendMicros: 0
              },
              candidates: []
            }
          }
        })
      ],
      workItems: []
    }).reason,
    'INVALID_TRAIN_STATE'
  );

  // Composition-valid 5 outcomes with sharedCohortMeasurements: null sets cohortComplete=true while keeping m02ExitReady=false
  const pendingMeasurements = evaluateSharedFiveOutcomeM02Cohort(
    makeSharedCohortInput({sharedCohortMeasurements: null})
  );
  assert.equal(pendingMeasurements.valid, true);
  assert.equal(pendingMeasurements.cohortComplete, true);
  assert.equal(pendingMeasurements.measurementsVerified, false);
  assert.equal(pendingMeasurements.m02ExitReady, false);
  assert.equal(pendingMeasurements.keepIssue16Open, true);
  assert.equal(pendingMeasurements.status, 'PENDING_SHARED_COHORT_MEASUREMENTS');
  assert.equal(pendingMeasurements.reason, 'SHARED_COHORT_MEASUREMENTS_REQUIRED');

  // Eligible 5-outcome real @copilot cohort + bound measurements closes #16 alongside #14/#18/#137 (even with benchmarkInput.cohorts: null!)
  const eligible = evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput());
  assert.equal(eligible.valid, true);
  assert.equal(eligible.cohortComplete, true);
  assert.equal(eligible.measurementsVerified, true);
  assert.equal(eligible.m02ExitReady, true);
  assert.equal(eligible.keepIssue16Open, false);
  assert.equal(eligible.status, 'SHARED_5_OUTCOME_COHORT_VERIFIED');
  assert.equal(eligible.reason, 'SHARED_M02_COHORT_ELIGIBLE');
  assert.equal(eligible.runtimePosture, 'dual-runtime-retain-node-authoritative');
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({benchmarkInput: benchmarkInput()})).runtimePosture,
    'dotnet-10-single-runtime-consolidation-eligible'
  );
  assert.equal(eligible.m01AnchorTargetOutcomes, SHARED_M01_ANCHOR_TARGET_OUTCOMES);
  assert.equal(eligible.unattendedCohortSummary.acceptedCount, 5);
  assert.equal(eligible.unattendedCohortSummary.remainingRequiredCount, 0);
  assert.equal(eligible.unattendedCohortSummary.m01MemberCount, 3);
  assert.equal(eligible.unattendedCohortSummary.parallelBatchVerified, true);
  assert.equal(eligible.unattendedCohortSummary.reviewRepairLoopVerified, true);
  assert.equal(eligible.unattendedCohortSummary.totalReworkIterations, 1);
  assert.equal(eligible.unattendedCohortSummary.reworkRateBps, 2000);

  // Enrolled Spellbook (97/90) and FamilyTree (95/90) policies work cleanly
  const sbOutcomes = [1, 2, 3, 4, 5].map(idx => makeUnattendedOutcome(idx, 5, {
    repositoryId: 200004,
    repository: 'example/spellbook',
    coveredLines: 975,
    coveredBranches: 910
  }));
  const sbCandidates = buildTrainCandidatesFromOutcomes(sbOutcomes);
  const sbCohort = evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
    repositoryId: 200004,
    repository: 'example/spellbook',
    policy: {minLinePercent: 97, minBranchPercent: 90},
    unattendedOutcomes: sbOutcomes,
    portfolioInput: {
      stop: false,
      budget: baseBudget({active: 0, maxActive: 4}),
      repositories: [
        spellbookRepo({
          overrides: {
            train: {
              defaultBranch: 'main',
              mainSha: WAVE_END_SHA,
              mainHealthy: true,
              mergeQueue: {
                mode: 'native-merge-queue',
                supported: true,
                ownerApproved: true,
                costVerified: true,
                incrementalSpendMicros: 0
              },
              candidates: sbCandidates
            }
          }
        })
      ],
      workItems: []
    }
  }));
  assert.equal(sbCohort.valid, true);
  assert.equal(sbCohort.cohortComplete, true);

  const ftOutcomes = [1, 2, 3, 4, 5].map(idx => makeUnattendedOutcome(idx, 5, {
    repositoryId: 200003,
    repository: 'example/family-tree',
    coveredLines: 955,
    coveredBranches: 905
  }));
  const ftCandidates = buildTrainCandidatesFromOutcomes(ftOutcomes);
  const ftCohort = evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
    repositoryId: 200003,
    repository: 'example/family-tree',
    policy: {minLinePercent: 95, minBranchPercent: 90},
    unattendedOutcomes: ftOutcomes,
    portfolioInput: {
      stop: false,
      budget: baseBudget({active: 0, maxActive: 4}),
      repositories: [
        familyTreeRepo({
          overrides: {
            train: {
              defaultBranch: 'main',
              mainSha: WAVE_END_SHA,
              mainHealthy: true,
              mergeQueue: {
                mode: 'native-merge-queue',
                supported: true,
                ownerApproved: true,
                costVerified: true,
                incrementalSpendMicros: 0
              },
              candidates: ftCandidates
            }
          }
        })
      ],
      workItems: []
    }
  }));
  assert.equal(ftCohort.valid, true);
  assert.equal(ftCohort.cohortComplete, true);

  // Spoofed consumer repository slug with matching repositoryId is rejected
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      repositoryId: 200003,
      repository: 'example/spoofed-consumer',
      policy: {minLinePercent: 95, minBranchPercent: 90},
      unattendedOutcomes: ftOutcomes,
      portfolioInput: {
        stop: false,
        budget: baseBudget({active: 0, maxActive: 4}),
        repositories: [
          familyTreeRepo({
            overrides: {
              train: {
                defaultBranch: 'main',
                mainSha: WAVE_END_SHA,
                mainHealthy: true,
                mergeQueue: {
                  mode: 'native-merge-queue',
                  supported: true,
                  ownerApproved: true,
                  costVerified: true,
                  incrementalSpendMicros: 0
                },
                candidates: ftCandidates
              }
            }
          })
        ],
        workItems: []
      }
    })).reason,
    'REPOSITORY_IDENTITY_MISMATCH'
  );

  // Incomplete composition at 5 outcomes stays open without claiming completion
  for (const outcomes of [
    [1, 2, 3, 4, 5].map(idx => makeUnattendedOutcome(idx, 5, {m01CohortMember: idx <= 2})),
    [1, 2, 3, 4, 5].map(idx => makeUnattendedOutcome(idx, 5, {parallelBatchGroup: null})),
    // Parallel pair supplied only by non-M01 members (idx 4, 5) does not satisfy #10 anchor requirement
    [1, 2, 3, 4, 5].map(idx => makeUnattendedOutcome(idx, 5, {
      parallelBatchGroup: idx >= 4 ? 'non-m01-pair' : null
    })),
    // Review-repair supplied only by non-M01 member (idx 4) does not satisfy #10 anchor requirement
    [1, 2, 3, 4, 5].map(idx => makeUnattendedOutcome(idx, 5, {
      reviewRepairVerified: idx === 4,
      reworkIterations: idx === 4 ? 1 : 0
    })),
    // Serialized non-overlapping windows in both time orders do not satisfy concurrent execution
    [1, 2, 3, 4, 5].map(idx => makeUnattendedOutcome(idx, 5, {
      assignedAtMs: 1795900000000 + idx * 3600000,
      mergedAtMs: 1795901800000 + idx * 3600000
    })),
    [1, 2, 3, 4, 5].map(idx => makeUnattendedOutcome(idx, 5, {
      assignedAtMs: 1795930000000 - idx * 3600000,
      mergedAtMs: 1795931800000 - idx * 3600000
    })),
    [1, 2, 3, 4, 5].map(idx => makeUnattendedOutcome(idx, 5, {reviewRepairVerified: false, reworkIterations: 0}))
  ]) {
    const inc = evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({unattendedOutcomes: outcomes}));
    assert.equal(inc.valid, true);
    assert.equal(inc.cohortComplete, false);
    assert.equal(inc.keepIssue16Open, true);
    assert.equal(inc.status, 'INCOMPLETE_COHORT_COMPOSITION');
    assert.equal(inc.reason, 'COHORT_COMPOSITION_REQUIREMENTS_UNMET');
  }

  // Provenance conflation: smuggling a session-orchestrated wave PR (#168) or wrong provenanceKind is rejected
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      unattendedOutcomes: [makeUnattendedOutcome(1, 1, {pr: 168})]
    })).reason,
    'PROVENANCE_CONFLATION_REJECTED'
  );
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      unattendedOutcomes: [makeUnattendedOutcome(1, 1, {provenanceKind: 'manual-pr'})]
    })).reason,
    'PROVENANCE_CONFLATION_REJECTED'
  );
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      engineeringWaves: [{...makeSharedCohortInput().engineeringWaves[0], provenanceKind: 'unattended'}]
    })).reason,
    'PROVENANCE_CONFLATION_REJECTED'
  );

  // Cross-repository outcome mismatch and unverified protected-main Squash Merge Queue ancestry
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      unattendedOutcomes: [makeUnattendedOutcome(1, 1, {repositoryId: 999999})]
    })).reason,
    'CROSS_REPO_OUTCOME_MISMATCH'
  );
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      unattendedOutcomes: [makeUnattendedOutcome(1, 1, {repository: 'example/other'})]
    })).reason,
    'CROSS_REPO_OUTCOME_MISMATCH'
  );
  const baseWithFive = makeSharedCohortInput();
  for (const outcomePatch of [
    {pr: 999},
    {headSha: sha('6')},
    {parentMainSha: sha('5')},
    {squashMergeSha: sha('4')},
    {ownedPaths: ['tools/different-lane.mjs']},
    {ownedPaths: ['tools/unattended-lane-1.mjs', 'tools/extra-lane.mjs']}
  ]) {
    const mutatedOutcomes = baseWithFive.unattendedOutcomes.map((o, i) =>
      i === 0 ? {...o, ...outcomePatch} : o
    );
    assert.equal(
      evaluateSharedFiveOutcomeM02Cohort({
        ...baseWithFive,
        unattendedOutcomes: mutatedOutcomes
      }).reason,
      'UNVERIFIED_MAIN_ANCESTRY'
    );
  }

  // Healthy non-closing partial PRs are tracked under partialOutcomeCount and never complete the cohort
  for (const partialPatch of [{issueAccepted: false}, {allRequiredPrsMerged: false}]) {
    const partialRes = evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      unattendedOutcomes: [1, 2, 3, 4, 5].map(idx => makeUnattendedOutcome(idx, 5, partialPatch))
    }));
    assert.equal(partialRes.valid, true);
    assert.equal(partialRes.cohortComplete, false);
    assert.equal(partialRes.m02ExitReady, false);
    assert.equal(partialRes.keepIssue16Open, true);
    assert.equal(partialRes.status, 'PENDING_UNATTENDED_COPILOT_COHORT');
    assert.equal(partialRes.unattendedCohortSummary.acceptedCount, 0);
    assert.equal(partialRes.unattendedCohortSummary.partialOutcomeCount, 5);
  }

  // Actor, spend, repair cap, human intervention, gate, coverage, and overlapping train-path regressions
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      unattendedOutcomes: [makeUnattendedOutcome(1, 1, {agentActor: 'cyrusjamula'})]
    })).reason,
    'UNVERIFIED_UNATTENDED_ACTOR'
  );
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      unattendedOutcomes: [makeUnattendedOutcome(1, 1, {incrementalSpendMicros: null})]
    })).reason,
    'SPEND_UNKNOWN_OR_EXCEEDED'
  );
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      engineeringWaves: [{...makeSharedCohortInput().engineeringWaves[0], incrementalSpendMicros: null}]
    })).reason,
    'SPEND_UNKNOWN_OR_EXCEEDED'
  );
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({incrementalSpendMicros: null})).reason,
    'SPEND_UNKNOWN_OR_EXCEEDED'
  );
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({billingHardStopVerified: false})).reason,
    'SPEND_UNKNOWN_OR_EXCEEDED'
  );
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      unattendedOutcomes: [makeUnattendedOutcome(1, 1, {reworkIterations: 6})]
    })).reason,
    'REPAIR_BUDGET_EXCEEDED'
  );
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      unattendedOutcomes: [makeUnattendedOutcome(1, 1, {routineHumanInterventions: 1})]
    })).reason,
    'ROUTINE_HUMAN_INTERVENTION_DETECTED'
  );
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      unattendedOutcomes: [makeUnattendedOutcome(1, 1, {unauthorizedWrites: 1})]
    })).reason,
    'QUALITY_OR_SAFETY_GATE_FAILED'
  );
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      unattendedOutcomes: [makeUnattendedOutcome(1, 1, {coveredLines: 970})]
    })).reason,
    'COVERAGE_BELOW_POLICY'
  );
  // Overlapping outcome paths (even with null parallelBatchGroup) are rejected via train isolation
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      unattendedOutcomes: [
        makeUnattendedOutcome(1, 2, {parallelBatchGroup: null, ownedPaths: ['tools/shared']}),
        makeUnattendedOutcome(2, 2, {parallelBatchGroup: null, ownedPaths: ['tools/shared/file.mjs']})
      ]
    })).reason,
    'INTEGRATION_TRAIN_UNHEALTHY'
  );

  // Top-level, identity, policy, portfolio/train, benchmark, and wave failure gates
  assert.equal(evaluateSharedFiveOutcomeM02Cohort(null).reason, 'INPUT_UNKNOWN');
  assert.equal(evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({incrementalSpendMicros: -1})).reason, 'INPUT_UNKNOWN');
  assert.equal(evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({stop: true})).reason, 'STOPPED');
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({repositoryId: 999, repository: SOFTWARE_FACTORY_REPOSITORY})).reason,
    'REPOSITORY_IDENTITY_MISMATCH'
  );
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      repositoryId: SOFTWARE_FACTORY_REPOSITORY_ID,
      repository: 'jamula/softwarefactory'
    })).reason,
    'REPOSITORY_IDENTITY_MISMATCH'
  );
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({policy: {minLinePercent: 97, minBranchPercent: 95}})).reason,
    'POLICY_BELOW_MINIMUM'
  );
  // Stricter enrolled repository policy (e.g. FamilyHub 100/100) cannot be weakened by cohort policy
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      repositoryId: 200005,
      repository: 'example/family-hub',
      policy: {minLinePercent: 98, minBranchPercent: 100},
      portfolioInput: {
        stop: false,
        budget: baseBudget({active: 0, maxActive: 4}),
        repositories: [
          familyHubRepo({
            candidates: [makeTrainCandidate(79, {simulatedSquashSha: WORKLOAD_SHA, coveredLines: 1000, coveredBranches: 1000})]
          })
        ],
        workItems: []
      }
    })).reason,
    'POLICY_BELOW_MINIMUM'
  );
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      repositoryId: 200005,
      repository: 'example/family-hub',
      policy: {minLinePercent: 100, minBranchPercent: 99},
      portfolioInput: {
        stop: false,
        budget: baseBudget({active: 0, maxActive: 4}),
        repositories: [
          familyHubRepo({
            candidates: [makeTrainCandidate(79, {simulatedSquashSha: WORKLOAD_SHA, coveredLines: 1000, coveredBranches: 1000})]
          })
        ],
        workItems: []
      }
    })).reason,
    'POLICY_BELOW_MINIMUM'
  );
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({portfolioInput: null})).reason,
    'INPUT_UNKNOWN'
  );
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      portfolioInput: {
        stop: false,
        budget: baseBudget({active: 0, maxActive: 4}),
        repositories: [spellbookRepo()],
        workItems: []
      }
    })).reason,
    'INTEGRATION_TRAIN_UNHEALTHY'
  );
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      portfolioInput: {
        stop: false,
        budget: baseBudget({active: 0, maxActive: 4}),
        repositories: [factoryRepo({candidates: [makeTrainCandidate(1, {checksPassed: false, simulatedSquashSha: WORKLOAD_SHA})]})],
        workItems: []
      }
    })).reason,
    'INTEGRATION_TRAIN_UNHEALTHY'
  );
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      portfolioInput: {
        stop: false,
        budget: baseBudget({active: 0, maxActive: 4}),
        repositories: [factoryRepo({candidates: [makeTrainCandidate(1, {simulatedSquashSha: SQUASH_1, reviewState: 'COMMENTED_CLEAR'})]})],
        workItems: []
      }
    })).reason,
    'HEAD_SHA_MISMATCH'
  );
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({benchmarkInput: {...benchmarkInput(), stop: true}})).reason,
    'STOPPED'
  );
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      benchmarkInput: benchmarkInput({
        workload: SQUASH_1,
        nodeBaseline: {...nodeBaselineProfile(), workload: SQUASH_1},
        dotnetMafCandidate: {...dotnetMafCandidateProfile(), workload: SQUASH_1},
        cohorts: null
      })
    })).reason,
    'HEAD_SHA_MISMATCH'
  );
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      benchmarkInput: benchmarkInput({dotnetMafCandidate: null, cohorts: null})
    })).reason,
    'MAF_CANDIDATE_REQUIRED'
  );
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      benchmarkInput: benchmarkInput({dotnetMafCandidate: {...dotnetMafCandidateProfile(), checkpointResumeVerified: false}})
    })).reason,
    'MAF_ARCHITECTURE_OR_SAFETY_UNVERIFIED'
  );
  // Review/rollback flags are checked even when CANDIDATE_COVERAGE_REGRESSION occurred first in benchmarkEval
  for (const revFlag of ['securityReviewed', 'independentReview', 'rollbackReady']) {
    assert.equal(
      evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
        benchmarkInput: benchmarkInput({
          dotnetMafCandidate: {
            ...dotnetMafCandidateProfile(),
            coveredLines: 985,
            [revFlag]: false
          }
        })
      })).reason,
      'REVIEW_OR_ROLLBACK_UNREADY'
    );
  }
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      benchmarkInput: benchmarkInput({dotnetMafCandidate: {...dotnetMafCandidateProfile(), coveredLines: 970}})
    })).reason,
    'MAF_COVERAGE_BELOW_POLICY'
  );
  // Wave post-merge main failures, unrecovered/final-wave failures, and non-monotonic wave-end timestamps
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      engineeringWaves: [{...makeSharedCohortInput().engineeringWaves[0], postMergeMainFailures: 1}]
    })).reason,
    'WAVE_MAIN_FAILURE_DETECTED'
  );
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      engineeringWaves: [{
        ...makeSharedCohortInput().engineeringWaves[0],
        postMergeMainFailures: 1,
        recoveredBeforeNextWave: true
      }]
    })).reason,
    'WAVE_MAIN_FAILURE_DETECTED'
  );
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      engineeringWaves: [{
        ...makeSharedCohortInput().engineeringWaves[0],
        postMergeMainFailures: 0,
        recoveredBeforeNextWave: true
      }]
    })).reason,
    'ENGINEERING_WAVE_UNKNOWN'
  );
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      engineeringWaves: [{...makeSharedCohortInput().engineeringWaves[0], finalMainSha: SQUASH_1}]
    })).reason,
    'HEAD_SHA_MISMATCH'
  );
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      engineeringWaves: [
        {...makeSharedCohortInput().engineeringWaves[0], waveId: 'wave-3', initialMainSha: sha('9'), finalMainSha: MAIN_SHA},
        {...makeSharedCohortInput().engineeringWaves[0], initialMainSha: SQUASH_1}
      ]
    })).reason,
    'WAVE_CHAIN_DISCONTINUITY'
  );
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      engineeringWaves: [
        {
          ...makeSharedCohortInput().engineeringWaves[0],
          waveId: 'wave-3',
          initialMainSha: sha('6'),
          finalMainSha: MAIN_SHA,
          windowStartMs: 1795805000000,
          windowEndMs: 1795809000000
        },
        makeSharedCohortInput().engineeringWaves[0]
      ]
    })).reason,
    'WAVE_CHAIN_DISCONTINUITY'
  );
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      engineeringWaves: [
        makeSharedCohortInput().engineeringWaves[0],
        {...makeSharedCohortInput().engineeringWaves[0], waveId: 'wave-dup-pr', initialMainSha: WAVE_END_SHA, finalMainSha: SQUASH_1}
      ]
    })).reason,
    'ENGINEERING_WAVE_UNKNOWN'
  );
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      engineeringWaves: [{...makeSharedCohortInput().engineeringWaves[0], incrementalSpendMicros: -1}]
    })).reason,
    'ENGINEERING_WAVE_UNKNOWN'
  );

  // Shared cohort measurement validation, cohort-binding, spend, exploration/context/rework, and scorecard/Kaizen gates
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      sharedCohortMeasurements: {bad: true}
    })).reason,
    'MEASUREMENT_SCHEMA_INVALID'
  );
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      sharedCohortMeasurements: makeSharedCohortMeasurements({incrementalSpendMicros: -1})
    })).reason,
    'MEASUREMENT_SCHEMA_INVALID'
  );
  for (const mismatchPatch of [
    {repositoryId: 999999},
    {repository: 'example/other'},
    {headSha: SQUASH_1},
    {evaluatedIssueNumbers: [201, 202, 203, 204, 299]},
    {candidateReworkRateBps: 1999}
  ]) {
    assert.equal(
      evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
        sharedCohortMeasurements: makeSharedCohortMeasurements(mismatchPatch)
      })).reason,
      'MEASUREMENT_COHORT_MISMATCH'
    );
  }
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      unattendedOutcomes: [makeUnattendedOutcome(1, 1)],
      sharedCohortMeasurements: makeSharedCohortMeasurements({
        evaluatedIssueNumbers: [201],
        candidateReworkRateBps: 0
      })
    })).reason,
    'MEASUREMENT_COHORT_MISMATCH'
  );
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      sharedCohortMeasurements: makeSharedCohortMeasurements({incrementalSpendMicros: null})
    })).reason,
    'SPEND_UNKNOWN_OR_EXCEEDED'
  );
  for (const regPatch of [
    {candidateExplorationStepsP50: 15},
    {candidateContextBytesLoadedP50: 33000},
    {baselineReworkRateBps: 1000},
    {
      baselineExplorationStepsP50: 8,
      candidateExplorationStepsP50: 8,
      baselineContextBytesLoadedP50: 18000,
      candidateContextBytesLoadedP50: 18000,
      baselineReworkRateBps: 2000
    }
  ]) {
    assert.equal(
      evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
        sharedCohortMeasurements: makeSharedCohortMeasurements(regPatch)
      })).reason,
      'EXPLORATION_OR_REWORK_REGRESSION'
    );
  }
  // Improvement solely on contextBytes or solely on reworkRate also passes cleanly
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      sharedCohortMeasurements: makeSharedCohortMeasurements({
        baselineExplorationStepsP50: 8,
        candidateExplorationStepsP50: 8
      })
    })).m02ExitReady,
    true
  );
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      sharedCohortMeasurements: makeSharedCohortMeasurements({
        baselineExplorationStepsP50: 8,
        candidateExplorationStepsP50: 8,
        baselineContextBytesLoadedP50: 18000,
        candidateContextBytesLoadedP50: 18000
      })
    })).m02ExitReady,
    true
  );
  for (const gatePatch of [{scorecardReadoutVerified: false}, {kaizenVerificationPassed: false}]) {
    assert.equal(
      evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
        sharedCohortMeasurements: makeSharedCohortMeasurements(gatePatch)
      })).reason,
      'SHARED_COHORT_GATE_UNVERIFIED'
    );
  }

  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      unattendedOutcomes: [makeUnattendedOutcome(1, 1, {reviewRepairVerified: true, reworkIterations: 0})]
    })).reason,
    'OUTCOME_SCHEMA_INVALID'
  );
  assert.equal(
    evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({
      unattendedOutcomes: [makeUnattendedOutcome(1, 1, {incrementalSpendMicros: -1})]
    })).reason,
    'OUTCOME_SCHEMA_INVALID'
  );

  // Empty unattendedOutcomes keeps pending unattended gh-aw status cleanly
  const emptyUnattended = evaluateSharedFiveOutcomeM02Cohort(makeSharedCohortInput({unattendedOutcomes: []}));
  assert.equal(emptyUnattended.valid, true);
  assert.equal(emptyUnattended.cohortComplete, false);
  assert.equal(emptyUnattended.status, 'PENDING_UNATTENDED_COPILOT_COHORT');
  assert.equal(emptyUnattended.unattendedCohortSummary.acceptedCount, 0);
  assert.equal(emptyUnattended.unattendedCohortSummary.remainingRequiredCount, SHARED_M02_COHORT_TARGET_OUTCOMES);
});

const makeStreamlinedOutcome = (idx, total = 5, overrides = {}) => {
  const parentMainSha = idx === 1 ? WAVE_END_SHA : String(idx - 1).padStart(40, '8');
  const squashMergeSha = idx === total ? WORKLOAD_SHA : String(idx).padStart(40, '8');
  const prCreatedAtMs = 1795900000000 + idx * 60000;
  const addedToMergeQueueAtMs = prCreatedAtMs + 600000;
  const mergedAtMs = addedToMergeQueueAtMs + 180000;
  const issueClosedOnGitHub = overrides.issueClosedOnGitHub ?? true;
  return {
    repositoryId: SOFTWARE_FACTORY_REPOSITORY_ID,
    repository: SOFTWARE_FACTORY_REPOSITORY,
    issue: 400 + idx,
    milestone: `M02.0${idx}`,
    waveId: 'wave-5',
    acceptingPr: 500 + idx,
    supportingWavePrs: idx === 1 ? [166] : [],
    provenanceKind: COORDINATOR_DISPATCHED_WAVE_PROVENANCE,
    copilotCoAuthored: true,
    issueClosedOnGitHub,
    allAcceptanceCriteriaDelivered: true,
    expectedBaseSha: parentMainSha,
    parentMainSha,
    headSha: String(idx).padStart(40, '7'),
    squashMergeSha,
    prCreatedAtMs,
    addedToMergeQueueAtMs,
    mergedAtMs,
    issueClosedAtMs: issueClosedOnGitHub ? mergedAtMs + 30000 : null,
    mergeQueueDurationMs: 180000,
    ownedPaths: [`tools/streamlined-lane-${idx}.mjs`],
    checksPassed: true,
    securityClear: true,
    independentReview: true,
    reviewThreadsTotal: idx === 3 ? 4 : 0,
    unresolvedFindings: 0,
    mainHealthyAfterMerge: true,
    rollbackReady: true,
    reworkCommits: idx === 3 ? 2 : 0,
    branchSyncMergeCommits: idx === 2 ? 1 : 0,
    duplicateDispatches: 0,
    unauthorizedWrites: 0,
    incrementalSpendMicros: 0,
    ...overrides
  };
};

const makeStreamlinedInput = (overrides = {}) => {
  const repositoryId = overrides.repositoryId ?? SOFTWARE_FACTORY_REPOSITORY_ID;
  const repository = overrides.repository ?? SOFTWARE_FACTORY_REPOSITORY;
  const headSha = overrides.headSha ?? WORKLOAD_SHA;
  const acceptedIssueOutcomes = overrides.acceptedIssueOutcomes ??
    [1, 2, 3, 4, 5].map(idx => makeStreamlinedOutcome(idx, 5, {repositoryId, repository}));
  const defaultCandidates = acceptedIssueOutcomes.length === 0
    ? [makeTrainCandidate(501, {
      expectedBase: WAVE_END_SHA,
      simulatedSquashSha: headSha,
      eligibleToMergeMs: 180000,
      reviewState: 'APPROVED'
    })]
    : acceptedIssueOutcomes.map((o, idx) => makeTrainCandidate(o.acceptingPr, {
      head: o.headSha,
      observedHead: o.headSha,
      expectedBase: o.expectedBaseSha,
      simulatedSquashSha: idx === acceptedIssueOutcomes.length - 1 ? headSha : o.squashMergeSha,
      eligibleToMergeMs: o.mergeQueueDurationMs,
      ownedPaths: [...o.ownedPaths],
      coveredLines: Math.max(990, (overrides.policy?.minLinePercent ?? 98) * 10),
      totalLines: 1000,
      coveredBranches: Math.max(970, (overrides.policy?.minBranchPercent ?? 95) * 10),
      totalBranches: 1000,
      reviewState: 'APPROVED'
    }));
  const defaultRepo = repositoryId === SOFTWARE_FACTORY_REPOSITORY_ID
    ? factoryRepo({
      overrides: {
        train: {
          defaultBranch: 'main',
          mainSha: WAVE_END_SHA,
          mainHealthy: true,
          mergeQueue: {
            mode: 'native-merge-queue',
            supported: true,
            ownerApproved: true,
            costVerified: true,
            incrementalSpendMicros: 0
          },
          candidates: defaultCandidates
        }
      }
    })
    : makeRepo({
      repositoryId,
      repository,
      localConcurrencyCap: 2,
      minLinePercent: overrides.policy?.minLinePercent ?? 95,
      minBranchPercent: overrides.policy?.minBranchPercent ?? 90,
      credentialId: `cred-${repositoryId}`,
      overrides: {
        train: {
          defaultBranch: 'main',
          mainSha: WAVE_END_SHA,
          mainHealthy: true,
          mergeQueue: {
            mode: 'native-merge-queue',
            supported: true,
            ownerApproved: true,
            costVerified: true,
            incrementalSpendMicros: 0
          },
          candidates: defaultCandidates
        }
      }
    });
  return {
    stop: false,
    repositoryId,
    repository,
    headSha,
    policy: {minLinePercent: 98, minBranchPercent: 95},
    billingHardStopVerified: true,
    incrementalSpendMicros: 0,
    futureGhAwCronDisclosure: {
      provenanceKind: FUTURE_GH_AW_CRON_PROVENANCE,
      status: 'DEFERRED_PENDING_GHAW_CRON_ENABLEMENT',
      completedCronOutcomes: 0,
      conflatedWithCoordinatorWaves: false
    },
    exactHeadCoverage: {
      headSha,
      coveredLines: 990,
      totalLines: 1000,
      coveredBranches: 970,
      totalBranches: 1000
    },
    portfolioTrainInputs: [
      {
        stop: false,
        budget: baseBudget({active: 0, maxActive: 4}),
        repositories: [defaultRepo],
        workItems: []
      }
    ],
    benchmarkInput: benchmarkInput({cohorts: null}),
    engineeringWaves: [
      {
        waveId: 'wave-4',
        provenanceKind: 'session-orchestrated-merge-queue-wave',
        initialMainSha: MAIN_SHA,
        finalMainSha: WAVE_END_SHA,
        windowStartMs: 1795800000000,
        windowEndMs: 1795803600000,
        prNumbers: [166, 167],
        mergeQueueDurationsMs: [138000, 204000],
        postMergeMainFailures: 0,
        recoveredBeforeNextWave: false,
        incrementalSpendMicros: 0
      },
      {
        waveId: 'wave-5',
        provenanceKind: 'session-orchestrated-merge-queue-wave',
        initialMainSha: WAVE_END_SHA,
        finalMainSha: headSha,
        windowStartMs: 1795900000000,
        windowEndMs: 1795905000000,
        prNumbers: acceptedIssueOutcomes.length === 0
          ? [501]
          : acceptedIssueOutcomes.map(o => o.acceptingPr),
        mergeQueueDurationsMs: acceptedIssueOutcomes.length === 0
          ? [180000]
          : acceptedIssueOutcomes.map(o => o.mergeQueueDurationMs),
        postMergeMainFailures: 0,
        recoveredBeforeNextWave: false,
        incrementalSpendMicros: 0
      }
    ],
    acceptedIssueOutcomes,
    ...overrides
  };
};

test('evaluates streamlined M02 cohort readout, consumer policies, partial outcomes, and fail-closed provenance/safety gates', () => {
  // Single-runtime consolidation posture flows through when benchmarkInput is consolidation-eligible
  const singleRuntimeEligible = evaluateStreamlinedM02CohortReadout(
    makeStreamlinedInput({benchmarkInput: benchmarkInput()})
  );
  assert.equal(singleRuntimeEligible.valid, true);
  assert.equal(singleRuntimeEligible.streamlinedM02CohortVerified, true);
  assert.equal(singleRuntimeEligible.issue16ExitReady, true);
  assert.equal(singleRuntimeEligible.keepIssue16Open, false);
  assert.equal(singleRuntimeEligible.runtimePosture, 'dotnet-10-single-runtime-consolidation-eligible');

  // Spellbook (97/90), FamilyTree (95/90), and FamilyHub (100/100) consumer policies evaluate cleanly
  const sbReadout = evaluateStreamlinedM02CohortReadout(makeStreamlinedInput({
    repositoryId: 200004,
    repository: 'example/spellbook',
    policy: {minLinePercent: 97, minBranchPercent: 90},
    exactHeadCoverage: {
      headSha: WORKLOAD_SHA,
      coveredLines: 975,
      totalLines: 1000,
      coveredBranches: 910,
      totalBranches: 1000
    }
  }));
  assert.equal(sbReadout.streamlinedM02CohortVerified, true);

  const ftReadout = evaluateStreamlinedM02CohortReadout(makeStreamlinedInput({
    repositoryId: 200003,
    repository: 'example/family-tree',
    policy: {minLinePercent: 95, minBranchPercent: 90}
  }));
  assert.equal(ftReadout.streamlinedM02CohortVerified, true);

  const fhReadout = evaluateStreamlinedM02CohortReadout(makeStreamlinedInput({
    repositoryId: 200005,
    repository: 'example/family-hub',
    policy: {minLinePercent: 100, minBranchPercent: 100},
    exactHeadCoverage: {
      headSha: WORKLOAD_SHA,
      coveredLines: 1000,
      totalLines: 1000,
      coveredBranches: 1000,
      totalBranches: 1000
    }
  }));
  assert.equal(fhReadout.streamlinedM02CohortVerified, true, fhReadout.reason);

  // Empty or partial non-closing outcomes remain pending without closing #16
  const emptyReadout = evaluateStreamlinedM02CohortReadout(makeStreamlinedInput({acceptedIssueOutcomes: []}));
  assert.equal(emptyReadout.valid, true);
  assert.equal(emptyReadout.streamlinedM02CohortVerified, false);
  assert.equal(emptyReadout.keepIssue16Open, true);
  assert.equal(emptyReadout.status, 'PENDING_STREAMLINED_M02_COHORT');
  assert.equal(emptyReadout.reason, 'INSUFFICIENT_ACCEPTED_OUTCOMES');
  assert.equal(emptyReadout.acceptedCohortSummary.windowMs, null);
  assert.equal(emptyReadout.acceptedCohortSummary.acceptedPerDay, null);
  assert.equal(emptyReadout.acceptedCohortSummary.reworkRateBps, null);

  for (const partialPatch of [
    {issueClosedOnGitHub: false, issueClosedAtMs: null},
    {allAcceptanceCriteriaDelivered: false}
  ]) {
    const partial = evaluateStreamlinedM02CohortReadout(makeStreamlinedInput({
      acceptedIssueOutcomes: [1, 2, 3, 4, 5].map(idx => makeStreamlinedOutcome(idx, 5, partialPatch))
    }));
    assert.equal(partial.valid, true);
    assert.equal(partial.streamlinedM02CohortVerified, false);
    assert.equal(partial.keepIssue16Open, true);
    assert.equal(partial.acceptedCohortSummary.acceptedIssueCount, 0);
    assert.equal(partial.acceptedCohortSummary.partialOutcomeCount, 5);
  }

  // >=5 outcomes without concurrent execution windows or without review-repair remain INCOMPLETE_COHORT_COMPOSITION
  const serializedOutcomes = [1, 2, 3, 4, 5].map(idx => {
    const prCreatedAtMs = 1795900000000 + idx * 3600000;
    const addedToMergeQueueAtMs = prCreatedAtMs + 600000;
    const mergedAtMs = addedToMergeQueueAtMs + 180000;
    return makeStreamlinedOutcome(idx, 5, {
      prCreatedAtMs,
      addedToMergeQueueAtMs,
      mergedAtMs,
      issueClosedAtMs: mergedAtMs + 10000
    });
  });
  const noParallel = evaluateStreamlinedM02CohortReadout(
    makeStreamlinedInput({acceptedIssueOutcomes: serializedOutcomes})
  );
  assert.equal(noParallel.streamlinedM02CohortVerified, false);
  assert.equal(noParallel.status, 'INCOMPLETE_COHORT_COMPOSITION');
  assert.equal(noParallel.reason, 'COHORT_COMPOSITION_REQUIREMENTS_UNMET');

  const noRepair = evaluateStreamlinedM02CohortReadout(makeStreamlinedInput({
    acceptedIssueOutcomes: [1, 2, 3, 4, 5].map(idx =>
      makeStreamlinedOutcome(idx, 5, {reworkCommits: 0, reviewThreadsTotal: 0})
    )
  }));
  assert.equal(noRepair.streamlinedM02CohortVerified, false);
  assert.equal(noRepair.reason, 'COHORT_COMPOSITION_REQUIREMENTS_UNMET');

  // Top-level schema, stop, identity, policy, spend, gh-aw disclosure, and exact-head coverage gates
  assert.equal(evaluateStreamlinedM02CohortReadout(null).reason, 'INPUT_UNKNOWN');
  assert.equal(
    evaluateStreamlinedM02CohortReadout(makeStreamlinedInput({incrementalSpendMicros: -1})).reason,
    'INPUT_UNKNOWN'
  );
  assert.equal(evaluateStreamlinedM02CohortReadout(makeStreamlinedInput({stop: true})).reason, 'STOPPED');
  assert.equal(
    evaluateStreamlinedM02CohortReadout(makeStreamlinedInput({
      repositoryId: 999,
      repository: SOFTWARE_FACTORY_REPOSITORY
    })).reason,
    'REPOSITORY_IDENTITY_MISMATCH'
  );
  assert.equal(
    evaluateStreamlinedM02CohortReadout(makeStreamlinedInput({
      repositoryId: SOFTWARE_FACTORY_REPOSITORY_ID,
      repository: 'jamula/softwarefactory'
    })).reason,
    'REPOSITORY_IDENTITY_MISMATCH'
  );
  assert.equal(
    evaluateStreamlinedM02CohortReadout(makeStreamlinedInput({
      policy: {minLinePercent: 97, minBranchPercent: 95}
    })).reason,
    'POLICY_BELOW_MINIMUM'
  );
  assert.equal(
    evaluateStreamlinedM02CohortReadout(makeStreamlinedInput({billingHardStopVerified: false})).reason,
    'SPEND_UNKNOWN_OR_EXCEEDED'
  );
  assert.equal(
    evaluateStreamlinedM02CohortReadout(makeStreamlinedInput({incrementalSpendMicros: null})).reason,
    'SPEND_UNKNOWN_OR_EXCEEDED'
  );
  for (const conflated of [
    {provenanceKind: 'wrong-kind', conflatedWithCoordinatorWaves: false},
    {provenanceKind: FUTURE_GH_AW_CRON_PROVENANCE, conflatedWithCoordinatorWaves: true}
  ]) {
    assert.equal(
      evaluateStreamlinedM02CohortReadout(makeStreamlinedInput({
        futureGhAwCronDisclosure: {
          ...makeStreamlinedInput().futureGhAwCronDisclosure,
          ...conflated
        }
      })).reason,
      'PROVENANCE_CONFLATION_REJECTED'
    );
  }
  for (const badDisclosure of [
    {status: 'ACTIVE'},
    {completedCronOutcomes: 1}
  ]) {
    assert.equal(
      evaluateStreamlinedM02CohortReadout(makeStreamlinedInput({
        futureGhAwCronDisclosure: {
          ...makeStreamlinedInput().futureGhAwCronDisclosure,
          ...badDisclosure
        }
      })).reason,
      'GHAW_CRON_DISCLOSURE_INVALID'
    );
  }
  assert.equal(
    evaluateStreamlinedM02CohortReadout(makeStreamlinedInput({
      exactHeadCoverage: {...makeStreamlinedInput().exactHeadCoverage, headSha: SQUASH_1}
    })).reason,
    'HEAD_SHA_MISMATCH'
  );
  assert.equal(
    evaluateStreamlinedM02CohortReadout(makeStreamlinedInput({
      exactHeadCoverage: {...makeStreamlinedInput().exactHeadCoverage, coveredLines: 970}
    })).reason,
    'COVERAGE_BELOW_POLICY'
  );
  assert.equal(
    evaluateStreamlinedM02CohortReadout(makeStreamlinedInput({
      exactHeadCoverage: {...makeStreamlinedInput().exactHeadCoverage, coveredLines: 991}
    })).reason,
    'HEAD_COVERAGE_MISMATCH'
  );

  // Train chain, duplicate PRs, enrolled policy floor, benchmark, and wave boundary checks
  const baseStreamlined = makeStreamlinedInput();
  assert.equal(
    evaluateStreamlinedM02CohortReadout({
      ...baseStreamlined,
      portfolioTrainInputs: [{...baseStreamlined.portfolioTrainInputs[0], stop: true}]
    }).reason,
    'STOPPED'
  );
  assert.equal(
    evaluateStreamlinedM02CohortReadout({
      ...baseStreamlined,
      portfolioTrainInputs: [{
        stop: false,
        budget: baseBudget({active: 0, maxActive: 4}),
        repositories: [factoryRepo()],
        workItems: []
      }]
    }).reason,
    'INTEGRATION_TRAIN_UNHEALTHY'
  );
  assert.equal(
    evaluateStreamlinedM02CohortReadout(makeStreamlinedInput({
      repositoryId: 200003,
      repository: 'example/spoofed',
      policy: {minLinePercent: 95, minBranchPercent: 90},
      portfolioTrainInputs: [{
        stop: false,
        budget: baseBudget({active: 0, maxActive: 4}),
        repositories: [familyTreeRepo({candidates: [makeTrainCandidate(501, {simulatedSquashSha: WORKLOAD_SHA})]})],
        workItems: []
      }]
    })).reason,
    'REPOSITORY_IDENTITY_MISMATCH'
  );
  assert.equal(
    evaluateStreamlinedM02CohortReadout(makeStreamlinedInput({
      repositoryId: 200005,
      repository: 'example/family-hub',
      policy: {minLinePercent: 99, minBranchPercent: 100},
      exactHeadCoverage: {
        headSha: WORKLOAD_SHA,
        coveredLines: 1000,
        totalLines: 1000,
        coveredBranches: 1000,
        totalBranches: 1000
      },
      portfolioTrainInputs: [{
        stop: false,
        budget: baseBudget({active: 0, maxActive: 4}),
        repositories: [familyHubRepo({
          candidates: [makeTrainCandidate(501, {
            simulatedSquashSha: WORKLOAD_SHA,
            coveredLines: 1000,
            coveredBranches: 1000
          })]
        })],
        workItems: []
      }]
    })).reason,
    'POLICY_BELOW_MINIMUM'
  );
  assert.equal(
    evaluateStreamlinedM02CohortReadout({
      ...baseStreamlined,
      portfolioTrainInputs: [
        baseStreamlined.portfolioTrainInputs[0],
        baseStreamlined.portfolioTrainInputs[0]
      ]
    }).reason,
    'WAVE_CHAIN_DISCONTINUITY'
  );
  const dupPart1 = {
    stop: false,
    budget: baseBudget({active: 0, maxActive: 4}),
    repositories: [factoryRepo({
      candidates: [makeTrainCandidate(501, {simulatedSquashSha: WAVE_END_SHA, reviewState: 'APPROVED'})]
    })],
    workItems: []
  };
  assert.equal(
    evaluateStreamlinedM02CohortReadout({
      ...baseStreamlined,
      portfolioTrainInputs: [dupPart1, baseStreamlined.portfolioTrainInputs[0]]
    }).reason,
    'DUPLICATE_TRAIN_CANDIDATE'
  );
  assert.equal(
    evaluateStreamlinedM02CohortReadout({
      ...baseStreamlined,
      portfolioTrainInputs: [{
        stop: false,
        budget: baseBudget({active: 0, maxActive: 4}),
        repositories: [factoryRepo({
          candidates: [makeTrainCandidate(501, {simulatedSquashSha: SQUASH_1, reviewState: 'APPROVED'})]
        })],
        workItems: []
      }]
    }).reason,
    'HEAD_SHA_MISMATCH'
  );
  assert.equal(
    evaluateStreamlinedM02CohortReadout({
      ...baseStreamlined,
      benchmarkInput: {...benchmarkInput(), stop: true}
    }).reason,
    'STOPPED'
  );
  assert.equal(
    evaluateStreamlinedM02CohortReadout({
      ...baseStreamlined,
      benchmarkInput: benchmarkInput({
        workload: SQUASH_1,
        nodeBaseline: {...nodeBaselineProfile(), workload: SQUASH_1},
        dotnetMafCandidate: {...dotnetMafCandidateProfile(), workload: SQUASH_1},
        cohorts: null
      })
    }).reason,
    'HEAD_SHA_MISMATCH'
  );
  assert.equal(
    evaluateStreamlinedM02CohortReadout({
      ...baseStreamlined,
      benchmarkInput: benchmarkInput({dotnetMafCandidate: null, cohorts: null})
    }).reason,
    'MAF_CANDIDATE_REQUIRED'
  );
  assert.equal(
    evaluateStreamlinedM02CohortReadout({
      ...baseStreamlined,
      benchmarkInput: benchmarkInput({
        dotnetMafCandidate: {...dotnetMafCandidateProfile(), checkpointResumeVerified: false}
      })
    }).reason,
    'MAF_ARCHITECTURE_OR_SAFETY_UNVERIFIED'
  );
  assert.equal(
    evaluateStreamlinedM02CohortReadout({
      ...baseStreamlined,
      benchmarkInput: benchmarkInput({
        dotnetMafCandidate: {...dotnetMafCandidateProfile(), coveredLines: 970}
      })
    }).reason,
    'MAF_COVERAGE_BELOW_POLICY'
  );
  assert.equal(
    evaluateStreamlinedM02CohortReadout({
      ...baseStreamlined,
      benchmarkInput: benchmarkInput({
        dotnetMafCandidate: {...dotnetMafCandidateProfile(), coveredLines: 985, rollbackReady: false}
      })
    }).reason,
    'REVIEW_OR_ROLLBACK_UNREADY'
  );
  assert.equal(
    evaluateStreamlinedM02CohortReadout({
      ...baseStreamlined,
      engineeringWaves: [{...baseStreamlined.engineeringWaves[0], postMergeMainFailures: 1}]
    }).reason,
    'WAVE_MAIN_FAILURE_DETECTED'
  );
  assert.equal(
    evaluateStreamlinedM02CohortReadout({
      ...baseStreamlined,
      engineeringWaves: [{...baseStreamlined.engineeringWaves[0], finalMainSha: SQUASH_1}]
    }).reason,
    'HEAD_SHA_MISMATCH'
  );
  assert.equal(
    evaluateStreamlinedM02CohortReadout({
      ...baseStreamlined,
      engineeringWaves: [{
        ...baseStreamlined.engineeringWaves[1],
        initialMainSha: sha('4')
      }]
    }).reason,
    'WAVE_CHAIN_DISCONTINUITY'
  );
  // Wave vs. train PR sequence, merge-queue duration, and intermediate wave finalMainSha parity checks
  for (const badWaves of [
    [
      baseStreamlined.engineeringWaves[0],
      {...baseStreamlined.engineeringWaves[1], prNumbers: [501, 502, 503, 504, 599]}
    ],
    [
      baseStreamlined.engineeringWaves[0],
      {...baseStreamlined.engineeringWaves[1], mergeQueueDurationsMs: [180000, 180000, 180000, 180000, 181000]}
    ],
    [
      baseStreamlined.engineeringWaves[0],
      {
        ...baseStreamlined.engineeringWaves[1],
        prNumbers: [501, 502, 503, 504],
        mergeQueueDurationsMs: [180000, 180000, 180000, 180000],
        finalMainSha: String(4).padStart(40, '8')
      },
      {
        waveId: 'wave-6',
        provenanceKind: 'session-orchestrated-merge-queue-wave',
        initialMainSha: String(4).padStart(40, '8'),
        finalMainSha: WORKLOAD_SHA,
        windowStartMs: 1795905000000,
        windowEndMs: 1795906000000,
        prNumbers: [505, 506],
        mergeQueueDurationsMs: [180000, 180000],
        postMergeMainFailures: 0,
        recoveredBeforeNextWave: false,
        incrementalSpendMicros: 0
      }
    ],
    [
      baseStreamlined.engineeringWaves[0],
      {
        ...baseStreamlined.engineeringWaves[1],
        waveId: 'wave-5a',
        prNumbers: [501, 502],
        mergeQueueDurationsMs: [180000, 180000],
        finalMainSha: sha('3')
      },
      {
        waveId: 'wave-5b',
        provenanceKind: 'session-orchestrated-merge-queue-wave',
        initialMainSha: sha('3'),
        finalMainSha: WORKLOAD_SHA,
        windowStartMs: 1795905000000,
        windowEndMs: 1795906000000,
        prNumbers: [503, 504, 505],
        mergeQueueDurationsMs: [180000, 180000, 180000],
        postMergeMainFailures: 0,
        recoveredBeforeNextWave: false,
        incrementalSpendMicros: 0
      }
    ],
    [
      baseStreamlined.engineeringWaves[0],
      {
        ...baseStreamlined.engineeringWaves[1],
        prNumbers: [501, 502, 503, 504],
        mergeQueueDurationsMs: [180000, 180000, 180000, 180000]
      }
    ]
  ]) {
    assert.equal(
      evaluateStreamlinedM02CohortReadout({
        ...baseStreamlined,
        engineeringWaves: badWaves
      }).reason,
      'WAVE_TRAIN_PARITY_MISMATCH'
    );
  }

  // Trailing train candidates cycling back to WORKLOAD_SHA beyond engineeringWaves PR list are rejected
  const extraCycleTrainA = {
    stop: false,
    budget: baseBudget({active: 0, maxActive: 4}),
    repositories: [factoryRepo({
      overrides: {
        train: {
          defaultBranch: 'main',
          mainSha: WORKLOAD_SHA,
          mainHealthy: true,
          mergeQueue: {
            mode: 'native-merge-queue',
            supported: true,
            ownerApproved: true,
            costVerified: true,
            incrementalSpendMicros: 0
          },
          candidates: [
            makeTrainCandidate(601, {
              expectedBase: WORKLOAD_SHA,
              simulatedSquashSha: SQUASH_1,
              eligibleToMergeMs: 180000,
              reviewState: 'APPROVED'
            })
          ]
        }
      }
    })],
    workItems: []
  };
  const extraCycleTrainB = {
    stop: false,
    budget: baseBudget({active: 0, maxActive: 4}),
    repositories: [factoryRepo({
      overrides: {
        train: {
          defaultBranch: 'main',
          mainSha: SQUASH_1,
          mainHealthy: true,
          mergeQueue: {
            mode: 'native-merge-queue',
            supported: true,
            ownerApproved: true,
            costVerified: true,
            incrementalSpendMicros: 0
          },
          candidates: [
            makeTrainCandidate(602, {
              expectedBase: SQUASH_1,
              simulatedSquashSha: WORKLOAD_SHA,
              eligibleToMergeMs: 180000,
              ownedPaths: ['src/cycle-602'],
              reviewState: 'APPROVED'
            })
          ]
        }
      }
    })],
    workItems: []
  };
  assert.equal(
    evaluateStreamlinedM02CohortReadout({
      ...baseStreamlined,
      portfolioTrainInputs: [baseStreamlined.portfolioTrainInputs[0], extraCycleTrainA, extraCycleTrainB]
    }).reason,
    'WAVE_TRAIN_PARITY_MISMATCH'
  );

  // Outcome-level schema, cross-repo, provenance, co-author, ancestry, wave health, spend, and safety gates
  for (const badOutcome of [
    makeStreamlinedOutcome(1, 1, {supportingWavePrs: [501]}),
    makeStreamlinedOutcome(1, 1, {issueClosedOnGitHub: false, issueClosedAtMs: 1795999999999}),
    makeStreamlinedOutcome(1, 1, {incrementalSpendMicros: -1})
  ]) {
    assert.equal(
      evaluateStreamlinedM02CohortReadout({
        ...baseStreamlined,
        acceptedIssueOutcomes: [badOutcome]
      }).reason,
      'OUTCOME_SCHEMA_INVALID'
    );
  }
  assert.equal(
    evaluateStreamlinedM02CohortReadout({
      ...baseStreamlined,
      acceptedIssueOutcomes: [baseStreamlined.acceptedIssueOutcomes[0], baseStreamlined.acceptedIssueOutcomes[0]]
    }).reason,
    'OUTCOME_SCHEMA_INVALID'
  );
  assert.equal(
    evaluateStreamlinedM02CohortReadout({
      ...baseStreamlined,
      acceptedIssueOutcomes: [
        {...baseStreamlined.acceptedIssueOutcomes[0], repositoryId: 999999}
      ]
    }).reason,
    'CROSS_REPO_OUTCOME_MISMATCH'
  );
  assert.equal(
    evaluateStreamlinedM02CohortReadout({
      ...baseStreamlined,
      acceptedIssueOutcomes: [
        {...baseStreamlined.acceptedIssueOutcomes[0], provenanceKind: 'unattended-copilot-issue-outcome'}
      ]
    }).reason,
    'PROVENANCE_CONFLATION_REJECTED'
  );
  assert.equal(
    evaluateStreamlinedM02CohortReadout({
      ...baseStreamlined,
      acceptedIssueOutcomes: [
        {...baseStreamlined.acceptedIssueOutcomes[0], copilotCoAuthored: false}
      ]
    }).reason,
    'COPILOT_CO_AUTHOR_REQUIRED'
  );
  for (const ancestryPatch of [
    {waveId: 'wave-4'},
    {supportingWavePrs: [999]},
    {headSha: sha('6')},
    {expectedBaseSha: sha('5')},
    {parentMainSha: sha('4')},
    {squashMergeSha: sha('3')},
    {ownedPaths: ['tools/mismatch.mjs']}
  ]) {
    assert.equal(
      evaluateStreamlinedM02CohortReadout({
        ...baseStreamlined,
        acceptedIssueOutcomes: [{...baseStreamlined.acceptedIssueOutcomes[0], ...ancestryPatch}]
      }).reason,
      'UNVERIFIED_MAIN_ANCESTRY'
    );
  }
  // Closing train wave claiming postMergeMainFailures > 0 in engineeringWaves is rejected
  const trainWave4 = {
    stop: false,
    budget: baseBudget({active: 0, maxActive: 4}),
    repositories: [factoryRepo({
      candidates: [
        makeTrainCandidate(166, {
          expectedBase: MAIN_SHA,
          simulatedSquashSha: SQUASH_1,
          eligibleToMergeMs: 138000,
          reviewState: 'APPROVED'
        }),
        makeTrainCandidate(167, {
          expectedBase: SQUASH_1,
          simulatedSquashSha: WAVE_END_SHA,
          eligibleToMergeMs: 204000,
          ownedPaths: ['src/w4-167'],
          reviewState: 'APPROVED'
        })
      ]
    })],
    workItems: []
  };
  assert.equal(
    evaluateStreamlinedM02CohortReadout({
      ...baseStreamlined,
      portfolioTrainInputs: [trainWave4, baseStreamlined.portfolioTrainInputs[0]],
      engineeringWaves: [
        {
          ...baseStreamlined.engineeringWaves[0],
          postMergeMainFailures: 1,
          recoveredBeforeNextWave: true
        },
        baseStreamlined.engineeringWaves[1]
      ]
    }).reason,
    'ACCEPTED_WAVE_MAIN_FAILURE_DETECTED'
  );
  assert.equal(
    evaluateStreamlinedM02CohortReadout({
      ...baseStreamlined,
      acceptedIssueOutcomes: [{...baseStreamlined.acceptedIssueOutcomes[0], incrementalSpendMicros: null}]
    }).reason,
    'SPEND_UNKNOWN_OR_EXCEEDED'
  );
  assert.equal(
    evaluateStreamlinedM02CohortReadout({
      ...baseStreamlined,
      acceptedIssueOutcomes: [{...baseStreamlined.acceptedIssueOutcomes[0], unresolvedFindings: 1}]
    }).reason,
    'QUALITY_OR_SAFETY_GATE_FAILED'
  );
});
