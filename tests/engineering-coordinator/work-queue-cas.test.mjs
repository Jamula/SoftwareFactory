import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_LEASE_TTL_MS,
  PROTECTED_WORK_QUEUE_REF,
  ZERO_GIT_OID,
  claimWorkQueueLease,
  createInMemoryWorkQueueRefStore,
  planUnifiedWorkQueue,
  reconcileWorkQueueRunStates,
  renewWorkQueueLease,
  settleWorkQueueLease
} from '../../tools/engineering-coordinator/work-queue-cas.mjs';

const REPO = 'Jamula/SoftwareFactory';
const REPO_ID = 1471342715;
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const LOCK_SHA = 'c'.repeat(64);
const TRACE = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

function makeConfig(overrides = {}) {
  return {
    schemaVersion: 1,
    project: {
      key: 'software-factory',
      repository: REPO,
      defaultBranch: 'main'
    },
    execution: {
      enabled: true,
      mode: 'shadow',
      stop: false,
      ...overrides.execution
    },
    limits: {
      maxConcurrentLanes: 2,
      leaseMs: 60000,
      maxAttempts: 2,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      ...overrides.limits
    },
    adapters: {
      workTracker: 'mock',
      engineeringAgent: 'mock',
      state: 'sqlite'
    },
    lanes: overrides.lanes ?? [
      {id: 'factory', owners: ['tools/engineering-factory'], prompt: 'docs/prompts/factory.md', specialist: 'infra'},
      {id: 'coordinator', owners: ['tools/engineering-coordinator'], prompt: 'docs/prompts/coord.md', specialist: 'coordinator'},
      {id: 'docs', owners: ['docs'], prompt: 'docs/prompts/docs.md', specialist: 'docs'}
    ]
  };
}

function makeIssueCandidate(overrides = {}) {
  return {
    targetType: 'issue',
    repository: REPO,
    repositoryId: REPO_ID,
    issueNumber: 42,
    lane: 'factory',
    ownedPaths: ['tools/engineering-factory/core.mjs'],
    workerId: 'worker-alpha',
    runId: 1001,
    leaseTtlMs: 60000,
    maxExecutionMs: 180000,
    traceparent: TRACE,
    lockSha256: LOCK_SHA,
    ...overrides
  };
}

function makePrCandidate(overrides = {}) {
  return {
    targetType: 'pull_request',
    repository: REPO,
    repositoryId: REPO_ID,
    pullNumber: 99,
    headSha: HEAD_A,
    lane: 'coordinator',
    ownedPaths: ['tools/engineering-coordinator/planner.mjs'],
    workerId: 'worker-beta',
    runId: 2002,
    leaseTtlMs: 60000,
    maxExecutionMs: 120000,
    ...overrides
  };
}

test('in-memory git-ref CAS store enforces refs/heads/work-queue, non-force updates, and expectedOid matching', () => {
  assert.throws(() => createInMemoryWorkQueueRefStore({invalid: true}), /INVALID_INITIAL_WORK_QUEUE_STATE/);

  const store = createInMemoryWorkQueueRefStore();
  const initial = store.readRef();
  assert.equal(initial.ok, true);
  assert.equal(initial.ref, PROTECTED_WORK_QUEUE_REF);
  assert.equal(initial.oid, ZERO_GIT_OID);
  assert.equal(initial.state, null);

  assert.equal(store.readRef('refs/heads/main').reason, 'UNPROTECTED_WORK_QUEUE_REF');

  const validState = {
    schemaVersion: 1,
    protocol: 'v3',
    sequence: 1,
    nextGeneration: 1,
    entries: [],
    recoveryReceipts: []
  };

  assert.equal(store.compareAndSwapRef(null).reason, 'INVALID_CAS_REQUEST');
  assert.equal(store.compareAndSwapRef({
    ref: PROTECTED_WORK_QUEUE_REF,
    expectedOid: ZERO_GIT_OID,
    nextState: validState,
    force: true
  }).reason, 'FORCE_UPDATE_FORBIDDEN');
  assert.equal(store.compareAndSwapRef({
    ref: PROTECTED_WORK_QUEUE_REF,
    expectedOid: ZERO_GIT_OID,
    nextState: validState,
    force: 'yes'
  }).reason, 'INVALID_CAS_REQUEST');
  assert.equal(store.compareAndSwapRef({
    ref: 'refs/heads/main',
    expectedOid: ZERO_GIT_OID,
    nextState: validState,
    force: false
  }).reason, 'UNPROTECTED_WORK_QUEUE_REF');
  assert.equal(store.compareAndSwapRef({
    ref: PROTECTED_WORK_QUEUE_REF,
    expectedOid: 'bad-oid',
    nextState: validState
  }).reason, 'INVALID_CAS_REQUEST');
  assert.equal(store.compareAndSwapRef({
    ref: PROTECTED_WORK_QUEUE_REF,
    expectedOid: ZERO_GIT_OID,
    nextState: {...validState, schemaVersion: 99}
  }).reason, 'INVALID_NEXT_STATE');

  const applied = store.compareAndSwapRef({
    ref: PROTECTED_WORK_QUEUE_REF,
    expectedOid: ZERO_GIT_OID,
    nextState: validState,
    force: false
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.reason, 'CAS_APPLIED');
  assert.notEqual(applied.oid, ZERO_GIT_OID);

  const conflict = store.compareAndSwapRef({
    ref: PROTECTED_WORK_QUEUE_REF,
    expectedOid: ZERO_GIT_OID,
    nextState: {...validState, sequence: 2},
    force: false
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, 'CAS_CONFLICT');
  assert.equal(conflict.currentOid, applied.oid);

  const seededStore = createInMemoryWorkQueueRefStore(validState);
  const seededSnap = seededStore.readRef();
  assert.equal(seededSnap.oid, applied.oid);
  assert.deepEqual(seededSnap.state, validState);
});

test('planUnifiedWorkQueue bridges shadow-runtime tasks with planner.mjs lanes, policy, and active CAS leases', async () => {
  const config = makeConfig({limits: {maxConcurrentLanes: 3, leaseMs: 60000, maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1000}});
  const refStore = createInMemoryWorkQueueRefStore();

  const claimed = await claimWorkQueueLease({
    refStore,
    config,
    candidate: makeIssueCandidate({issueNumber: 1, ownedPaths: ['tools/engineering-factory/a.mjs']}),
    nowMs: 1000
  });
  assert.equal(claimed.ok, true);

  const shadowInput = {
    enabled: true,
    stop: false,
    capacity: 2,
    quotaVerified: true,
    tasks: [
      {id: 2, priority: 1, state: 'approved', dependencies: [], paths: ['tools/engineering-factory/b.mjs']},
      {id: 3, priority: 2, state: 'approved', dependencies: [], paths: ['tools/engineering-coordinator/c.mjs']},
      {id: 4, priority: 0, state: 'pending', dependencies: [], paths: ['docs/ROADMAP.md']},
      {id: 5, priority: 0, state: 'accepted', dependencies: [], paths: ['docs/POLICY.md']}
    ]
  };

  const duringActive = planUnifiedWorkQueue({
    config,
    shadowInput,
    activeLeases: [claimed.lease],
    nowMs: 2000,
    policy: {
      now: 2000,
      agingMs: 1000,
      riskCeiling: 'medium',
      ready: [
        {id: 2, readySince: 1000, risk: 'low'},
        {id: 3, readySince: 1000, risk: 'low'}
      ]
    }
  });
  assert.equal(duringActive.shadow, true);
  assert.equal(duringActive.liveDispatch, false);
  assert.deepEqual(duringActive.readyIds, [3]);
  assert.ok(duringActive.blockedTasks.some(item => item.id === 2));

  // Once the lease expires, task 2 is no longer blocked by the expired reservation.
  const afterExpiry = planUnifiedWorkQueue({
    config,
    shadowInput,
    activeLeases: [claimed.lease],
    nowMs: 200000
  });
  assert.deepEqual(afterExpiry.readyIds, [2, 3]);

  assert.equal(planUnifiedWorkQueue(null).reason, 'INVALID_UNIFIED_PLAN_INPUT');
  assert.equal(planUnifiedWorkQueue({config, shadowInput, nowMs: -1}).reason, 'INVALID_UNIFIED_PLAN_INPUT');
  assert.equal(planUnifiedWorkQueue({config: {}, shadowInput, nowMs: 0}).reason, 'INVALID_PROJECT_CONFIG');
  assert.equal(planUnifiedWorkQueue({config, shadowInput: null, nowMs: 0}).reason, 'INVALID_SHADOW_INPUT');
  assert.equal(planUnifiedWorkQueue({config, shadowInput: {...shadowInput, stop: true}, nowMs: 0}).reason, 'STOPPED');
  assert.equal(planUnifiedWorkQueue({config, shadowInput: {...shadowInput, quotaVerified: false}, nowMs: 0}).reason, 'CAPACITY_UNKNOWN');
  assert.equal(planUnifiedWorkQueue({config, shadowInput: {...shadowInput, tasks: null}, nowMs: 0}).reason, 'INVALID_TASKS');
  assert.equal(planUnifiedWorkQueue({config, shadowInput, activeLeases: [null], nowMs: 0}).reason, 'INVALID_ACTIVE_LEASES');
  assert.equal(planUnifiedWorkQueue({
    config,
    shadowInput: {...shadowInput, tasks: [{id: 1, priority: 0, state: 'invalid', dependencies: [], paths: ['docs/a.md']}]},
    nowMs: 0
  }).reason, 'INVALID_TASKS');

  // Regression: revoked Proxy policy and getter-backed policy/ready/entry fields fail closed without throwing or invoking getters
  let policyTraps = 0;
  const policyTrap = () => {
    policyTraps++;
    throw new Error('policy getter/trap must not run');
  };
  const revokedPolicy = Proxy.revocable({now: 0, agingMs: 1000, riskCeiling: 'low', ready: []}, {get: policyTrap});
  revokedPolicy.revoke();
  const getterPolicy = {now: 0, agingMs: 1000, riskCeiling: 'low'};
  Object.defineProperty(getterPolicy, 'ready', {enumerable: true, get: policyTrap});
  const getterReadyArr = [];
  Object.defineProperty(getterReadyArr, '0', {enumerable: true, get: policyTrap});
  getterReadyArr.length = 1;
  const getterEntry = {id: 2, readySince: 0};
  Object.defineProperty(getterEntry, 'risk', {enumerable: true, get: policyTrap});
  for (const badPolicy of [
    revokedPolicy.proxy,
    getterPolicy,
    {now: 0, agingMs: 1000, riskCeiling: 'low', ready: getterReadyArr},
    {now: 0, agingMs: 1000, riskCeiling: 'low', ready: [getterEntry]}
  ]) {
    assert.equal(planUnifiedWorkQueue({
      config,
      shadowInput,
      nowMs: 2000,
      policy: badPolicy
    }).reason, 'SCHEDULING_POLICY_UNKNOWN');
  }
  assert.equal(policyTraps, 0);
  const revokedDeps = Proxy.revocable([], {});
  revokedDeps.revoke();
  for (const badDeps of [null, 42, '', new Array(1), revokedDeps.proxy]) {
    assert.equal(planUnifiedWorkQueue({
      config,
      shadowInput: {...shadowInput, tasks: [{id: 1, priority: 0, state: 'approved', dependencies: badDeps, paths: ['docs/a.md']}]},
      nowMs: 0
    }).reason, 'INVALID_TASKS');
  }
  assert.equal(planUnifiedWorkQueue({
    config,
    shadowInput: {...shadowInput, tasks: [{id: 1, priority: 0, state: 'approved', dependencies: [], paths: ['unowned/file.mjs']}]},
    nowMs: 0
  }).reason, 'LANE_OWNERSHIP_VIOLATION');
  assert.equal(planUnifiedWorkQueue({
    config,
    shadowInput: {...shadowInput, tasks: [{id: 1, priority: 0, state: 'approved', lane: 'docs', dependencies: [], paths: ['tools/engineering-factory/a.mjs']}]},
    nowMs: 0
  }).reason, 'LANE_OWNERSHIP_VIOLATION');

  // PR active lease reservation id mapping
  const prClaim = await claimWorkQueueLease({
    refStore,
    config,
    candidate: makePrCandidate({pullNumber: 77}),
    nowMs: 2000
  });
  assert.equal(prClaim.ok, true);
  const withPrLease = planUnifiedWorkQueue({
    config,
    shadowInput: {
      enabled: true,
      stop: false,
      capacity: 3,
      quotaVerified: true,
      tasks: [{id: 88, priority: 0, state: 'approved', dependencies: [], paths: ['docs/GUIDE.md']}]
    },
    activeLeases: [prClaim.lease],
    nowMs: 3000
  });
  assert.deepEqual(withPrLease.readyIds, [88]);
});

test('prevents duplicate issue/PR+head claims, overlapping ownedPaths, reserved lanes, capacity breaches, and force updates', async () => {
  const config = makeConfig({
    lanes: [
      {id: 'factory-a', owners: ['tools/engineering-factory'], prompt: 'docs/prompts/a.md'},
      {id: 'coord', owners: ['tools/engineering-coordinator'], prompt: 'docs/prompts/b.md'},
      {id: 'docs', owners: ['docs'], prompt: 'docs/prompts/c.md'}
    ]
  });
  const refStore = createInMemoryWorkQueueRefStore();

  assert.equal((await claimWorkQueueLease({
    refStore,
    config,
    candidate: makeIssueCandidate({lane: 'factory-a'}),
    nowMs: 1000,
    force: true
  })).reason, 'FORCE_UPDATE_FORBIDDEN');

  assert.equal((await claimWorkQueueLease({
    refStore,
    config,
    candidate: makeIssueCandidate({lane: 'factory-a'}),
    nowMs: 1000,
    stop: true
  })).reason, 'STOPPED');

  const first = await claimWorkQueueLease({
    refStore,
    config,
    candidate: makeIssueCandidate({
      issueNumber: 10,
      lane: 'factory-a',
      ownedPaths: ['tools/engineering-factory/sub']
    }),
    nowMs: 1000
  });
  assert.equal(first.ok, true);
  assert.equal(first.lease.generation, 1);

  // Duplicate (repositoryId, issueNumber)
  const dupIssue = await claimWorkQueueLease({
    refStore,
    config,
    candidate: makeIssueCandidate({
      issueNumber: 10,
      lane: 'factory-a',
      ownedPaths: ['tools/engineering-factory/other.mjs'],
      workerId: 'worker-two',
      runId: 1002
    }),
    nowMs: 2000
  });
  assert.equal(dupIssue.reason, 'DUPLICATE_ACTIVE_CLAIM');

  // Overlapping path (parent dir overlaps tools/engineering-factory/sub even if lanes were reconfigured)
  const overlapCfg = {
    ...config,
    lanes: [
      {id: 'factory-root', owners: ['tools'], prompt: 'docs/b.md'},
      {id: 'docs', owners: ['docs'], prompt: 'docs/c.md'}
    ]
  };
  assert.equal((await claimWorkQueueLease({
    refStore,
    config: overlapCfg,
    candidate: makeIssueCandidate({
      issueNumber: 11,
      lane: 'factory-root',
      ownedPaths: ['tools/engineering-factory']
    }),
    nowMs: 2000
  })).reason, 'OWNED_PATHS_OVERLAP');

  // Same lane with disjoint path -> LANE_RESERVED
  assert.equal((await claimWorkQueueLease({
    refStore,
    config,
    candidate: makeIssueCandidate({
      issueNumber: 12,
      lane: 'factory-a',
      ownedPaths: ['tools/engineering-factory/disjoint.mjs']
    }),
    nowMs: 2000
  })).reason, 'LANE_RESERVED');

  // Claim PR candidate on second lane
  const prClaim = await claimWorkQueueLease({
    refStore,
    config,
    candidate: makePrCandidate({lane: 'coord', pullNumber: 55, headSha: HEAD_A}),
    nowMs: 2000
  });
  assert.equal(prClaim.ok, true);
  assert.equal(prClaim.lease.generation, 2);

  // Duplicate (repositoryId, pullNumber, headSha)
  assert.equal((await claimWorkQueueLease({
    refStore,
    config,
    candidate: makePrCandidate({lane: 'coord', pullNumber: 55, headSha: HEAD_A, runId: 2099}),
    nowMs: 2500
  })).reason, 'DUPLICATE_ACTIVE_CLAIM');

  // Different headSha on same PR when maxConcurrentLanes (2) is full -> CAPACITY_FULL
  assert.equal((await claimWorkQueueLease({
    refStore,
    config,
    candidate: makePrCandidate({
      lane: 'docs',
      pullNumber: 55,
      headSha: HEAD_B,
      ownedPaths: ['docs/GH-AW-ORCHESTRATION.md']
    }),
    nowMs: 2500
  })).reason, 'CAPACITY_FULL');
});

test('enforces bounded execution TTL (1..3_600_000 ms), clamps renewals, fences stale generations, and settles leases', async () => {
  const config = makeConfig();
  const refStore = createInMemoryWorkQueueRefStore();

  for (const badTtl of [0, -5, MAX_LEASE_TTL_MS + 1]) {
    assert.equal((await claimWorkQueueLease({
      refStore,
      config,
      candidate: makeIssueCandidate({leaseTtlMs: badTtl}),
      nowMs: 1000
    })).reason, 'INVALID_LEASE_TTL');
  }
  assert.equal((await claimWorkQueueLease({
    refStore,
    config,
    candidate: makeIssueCandidate({leaseTtlMs: 60000, maxExecutionMs: 30000}),
    nowMs: 1000
  })).reason, 'INVALID_LEASE_TTL');
  assert.equal((await claimWorkQueueLease({
    refStore,
    config,
    candidate: makeIssueCandidate({leaseTtlMs: 60000, maxExecutionMs: MAX_LEASE_TTL_MS + 1}),
    nowMs: 1000
  })).reason, 'INVALID_LEASE_TTL');

  const claim = await claimWorkQueueLease({
    refStore,
    config,
    candidate: makeIssueCandidate({
      issueNumber: 7,
      leaseTtlMs: 50000,
      maxExecutionMs: 90000
    }),
    nowMs: 10000
  });
  assert.equal(claim.ok, true);
  assert.equal(claim.lease.leaseExpiresAtMs, 60000);
  assert.equal(claim.lease.executionDeadlineMs, 100000);

  // Renew at t=50000 with 40000ms TTL advances leaseExpiresAtMs to 90000;
  // an out-of-order renewal at t=12000 with 50000ms TTL (62000) MUST NOT shorten leaseExpiresAtMs below 90000!
  const midRenewed = await renewWorkQueueLease({
    refStore,
    workId: claim.lease.workId,
    workerId: 'worker-alpha',
    generation: claim.lease.generation,
    leaseTtlMs: 40000,
    nowMs: 50000
  });
  assert.equal(midRenewed.ok, true);
  assert.equal(midRenewed.lease.leaseExpiresAtMs, 90000);

  const outOfOrderRenewed = await renewWorkQueueLease({
    refStore,
    workId: claim.lease.workId,
    workerId: 'worker-alpha',
    generation: claim.lease.generation,
    leaseTtlMs: 50000,
    nowMs: 12000
  });
  assert.equal(outOfOrderRenewed.ok, true);
  assert.equal(outOfOrderRenewed.lease.leaseExpiresAtMs, 90000);

  // Renew at t=55000 with 60000ms TTL clamps leaseExpiresAtMs to executionDeadlineMs (100000)
  const renewed = await renewWorkQueueLease({
    refStore,
    workId: claim.lease.workId,
    workerId: 'worker-alpha',
    generation: claim.lease.generation,
    leaseTtlMs: 60000,
    nowMs: 55000
  });
  assert.equal(renewed.ok, true);
  assert.equal(renewed.lease.leaseExpiresAtMs, 100000);

  // Cannot renew past executionDeadlineMs
  assert.equal((await renewWorkQueueLease({
    refStore,
    workId: claim.lease.workId,
    workerId: 'worker-alpha',
    generation: claim.lease.generation,
    leaseTtlMs: 30000,
    nowMs: 100000
  })).reason, 'EXECUTION_TTL_EXCEEDED');

  assert.equal((await renewWorkQueueLease({
    refStore,
    workId: claim.lease.workId,
    workerId: 'worker-alpha',
    generation: claim.lease.generation,
    leaseTtlMs: 30000,
    nowMs: 5000
  })).reason, 'CLOCK_SKEW_REJECTED');

  assert.equal((await renewWorkQueueLease({
    refStore,
    workId: 'missing',
    workerId: 'worker-alpha',
    generation: 1,
    leaseTtlMs: 1000,
    nowMs: 20000
  })).reason, 'WORK_NOT_FOUND');

  assert.equal((await renewWorkQueueLease({
    refStore,
    workId: claim.lease.workId,
    workerId: 'other-worker',
    generation: claim.lease.generation,
    leaseTtlMs: 1000,
    nowMs: 20000
  })).reason, 'LEASE_NOT_HELD');

  assert.equal((await renewWorkQueueLease({
    refStore,
    workId: claim.lease.workId,
    workerId: 'worker-alpha',
    generation: 999,
    leaseTtlMs: 1000,
    nowMs: 20000
  })).reason, 'STALE_GENERATION');

  // Settle completed within deadline
  const settled = await settleWorkQueueLease({
    refStore,
    workId: claim.lease.workId,
    workerId: 'worker-alpha',
    generation: claim.lease.generation,
    outcome: 'completed',
    nowMs: 80000
  });
  assert.equal(settled.ok, true);
  assert.equal(settled.lease.status, 'completed');

  // Completed work cannot be claimed again
  assert.equal((await claimWorkQueueLease({
    refStore,
    config,
    candidate: makeIssueCandidate({issueNumber: 7, runId: 1009}),
    nowMs: 81000
  })).reason, 'WORK_ALREADY_COMPLETED');

  // Regression: in-flight renewal race!
  // Lease A expires at t=100; A begins renewal at t=90 (initial readRef deferred),
  // B claims the same lane/paths at t=100 (atomically fencing expired A),
  // and A's CAS retry MUST fail closed with STALE_GENERATION instead of reactivating A alongside B!
  const raceStore = createInMemoryWorkQueueRefStore();
  const leaseA = await claimWorkQueueLease({
    refStore: raceStore,
    config,
    candidate: makeIssueCandidate({
      issueNumber: 200,
      lane: 'factory',
      ownedPaths: ['tools/engineering-factory/race.mjs'],
      workerId: 'worker-A',
      runId: 5001,
      leaseTtlMs: 100,
      maxExecutionMs: 500
    }),
    nowMs: 0
  });
  assert.equal(leaseA.ok, true);
  assert.equal(leaseA.lease.leaseExpiresAtMs, 100);

  let injectedCompetingClaim = false;
  const interleavedStore = {
    async readRef(ref) {
      return raceStore.readRef(ref);
    },
    async compareAndSwapRef(req) {
      if (!injectedCompetingClaim) {
        injectedCompetingClaim = true;
        const claimB = await claimWorkQueueLease({
          refStore: raceStore,
          config,
          candidate: makeIssueCandidate({
            issueNumber: 201,
            lane: 'factory',
            ownedPaths: ['tools/engineering-factory/race.mjs'],
            workerId: 'worker-B',
            runId: 5002,
            leaseTtlMs: 100,
            maxExecutionMs: 500
          }),
          nowMs: 100
        });
        assert.equal(claimB.ok, true);
      }
      return raceStore.compareAndSwapRef(req);
    }
  };

  const racingRenewal = await renewWorkQueueLease({
    refStore: interleavedStore,
    config,
    workId: leaseA.lease.workId,
    workerId: 'worker-A',
    generation: leaseA.lease.generation,
    leaseTtlMs: 60,
    nowMs: 90,
    maxCasAttempts: 3
  });
  assert.equal(racingRenewal.ok, false);
  assert.equal(racingRenewal.reason, 'STALE_GENERATION');

  const finalRaceEntries = raceStore.readRef().state.entries;
  const activeAfterRace = finalRaceEntries.filter(e => e.status === 'leased');
  assert.equal(activeAfterRace.length, 1);
  assert.equal(activeAfterRace[0].workerId, 'worker-B');

  // Regression: when config.limits.maxAttempts is lowered from 2 to 1 after attempt 1 is claimed,
  // claiming another item after attempt 1 expires marks the expired item 'exhausted' (not 'requeued')
  // so terminal compaction can archive it instead of stranding a non-claimable slot!
  const loweredCeilingStore = createInMemoryWorkQueueRefStore();
  const initialClaim = await claimWorkQueueLease({
    refStore: loweredCeilingStore,
    config: makeConfig({limits: {maxAttempts: 2}}),
    candidate: makeIssueCandidate({
      issueNumber: 250,
      lane: 'factory',
      ownedPaths: ['tools/engineering-factory/lowered-ceiling.mjs'],
      workerId: 'worker-1',
      runId: 5101,
      leaseTtlMs: 100,
      maxExecutionMs: 500,
      maxAttempts: 2
    }),
    nowMs: 0
  });
  assert.equal(initialClaim.ok, true);
  assert.equal(initialClaim.lease.attempts, 1);
  assert.equal(initialClaim.lease.maxAttempts, 2);

  const loweredConfig = makeConfig({limits: {maxAttempts: 1}});
  const nextClaimAfterExpiry = await claimWorkQueueLease({
    refStore: loweredCeilingStore,
    config: loweredConfig,
    candidate: makeIssueCandidate({
      issueNumber: 251,
      lane: 'factory',
      ownedPaths: ['tools/engineering-factory/lowered-ceiling.mjs'],
      workerId: 'worker-2',
      runId: 5102,
      leaseTtlMs: 100,
      maxExecutionMs: 500,
      maxAttempts: 1
    }),
    nowMs: 100
  });
  assert.equal(nextClaimAfterExpiry.ok, true);
  const loweredState = loweredCeilingStore.readRef().state;
  const fencedExpired = loweredState.entries.find(e => e.workId === initialClaim.lease.workId);
  assert.equal(fencedExpired.status, 'exhausted');
  assert.equal(fencedExpired.maxAttempts, 1);
  assert.equal(loweredState.recoveryReceipts.at(-1).outcome, 'exhausted');
  assert.equal(loweredState.recoveryReceipts.at(-1).maxAttempts, 1);

  // Invalid config and config-level stop on renewWorkQueueLease fail closed
  assert.equal((await renewWorkQueueLease({
    refStore: raceStore,
    config: {},
    workId: activeAfterRace[0].workId,
    workerId: 'worker-B',
    generation: activeAfterRace[0].generation,
    leaseTtlMs: 50,
    nowMs: 110
  })).reason, 'INVALID_PROJECT_CONFIG');
  assert.equal((await renewWorkQueueLease({
    refStore: raceStore,
    config: makeConfig({execution: {enabled: true, mode: 'shadow', stop: true}}),
    workId: activeAfterRace[0].workId,
    workerId: 'worker-B',
    generation: activeAfterRace[0].generation,
    leaseTtlMs: 50,
    nowMs: 110
  })).reason, 'STOPPED');

  // Defense-in-depth in renewWorkQueueLease: reject renewal if persisted state has another active entry
  // holding the same lane, overlapping paths, or exceeding maxConcurrentLanes!
  const makeSeededActive = (issueNumber, lane, ownedPath, generation) => ({
    workId: `${REPO_ID}:issue:${issueNumber}`,
    targetType: 'issue',
    repository: REPO,
    repositoryId: REPO_ID,
    issueNumber,
    pullNumber: null,
    headSha: null,
    lane,
    ownedPaths: [ownedPath],
    status: 'leased',
    generation,
    attempts: 1,
    maxAttempts: 2,
    workerId: `worker-${issueNumber}`,
    runId: 6000 + issueNumber,
    runAttempt: 1,
    claimedAtMs: 100,
    leaseTtlMs: 500,
    leaseExpiresAtMs: 600,
    maxExecutionMs: 1000,
    executionDeadlineMs: 1100
  });

  const laneConflictStore = createInMemoryWorkQueueRefStore({
    schemaVersion: 1,
    protocol: 'v3',
    sequence: 2,
    nextGeneration: 3,
    entries: [
      makeSeededActive(301, 'factory', 'tools/engineering-factory/a.mjs', 1),
      makeSeededActive(302, 'factory', 'tools/engineering-factory/b.mjs', 2)
    ],
    recoveryReceipts: []
  });
  assert.equal((await renewWorkQueueLease({
    refStore: laneConflictStore,
    config,
    workId: `${REPO_ID}:issue:301`,
    workerId: 'worker-301',
    generation: 1,
    leaseTtlMs: 100,
    nowMs: 200
  })).reason, 'LANE_RESERVED');

  const pathOverlapStore = createInMemoryWorkQueueRefStore({
    schemaVersion: 1,
    protocol: 'v3',
    sequence: 2,
    nextGeneration: 3,
    entries: [
      makeSeededActive(303, 'factory', 'tools/engineering-factory', 1),
      makeSeededActive(304, 'coordinator', 'tools/engineering-factory/sub.mjs', 2)
    ],
    recoveryReceipts: []
  });
  assert.equal((await renewWorkQueueLease({
    refStore: pathOverlapStore,
    config,
    workId: `${REPO_ID}:issue:303`,
    workerId: 'worker-303',
    generation: 1,
    leaseTtlMs: 100,
    nowMs: 200
  })).reason, 'OWNED_PATHS_OVERLAP');

  const capExceededStore = createInMemoryWorkQueueRefStore({
    schemaVersion: 1,
    protocol: 'v3',
    sequence: 2,
    nextGeneration: 3,
    entries: [
      makeSeededActive(305, 'factory', 'tools/engineering-factory/a.mjs', 1),
      makeSeededActive(306, 'coordinator', 'tools/engineering-coordinator/b.mjs', 2)
    ],
    recoveryReceipts: []
  });
  assert.equal((await renewWorkQueueLease({
    refStore: capExceededStore,
    config: makeConfig({limits: {maxConcurrentLanes: 1, leaseMs: 60000, maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1000}}),
    workId: `${REPO_ID}:issue:305`,
    workerId: 'worker-305',
    generation: 1,
    leaseTtlMs: 100,
    nowMs: 200
  })).reason, 'CAPACITY_FULL');
});

test('reconcileWorkQueueRunStates handles launch_failed, worker_terminated, run_terminal, run_missing, expiry, maxAttempts, and stop', async () => {
  const config = makeConfig({
    limits: {maxConcurrentLanes: 4, leaseMs: 60000, maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1000},
    lanes: [
      {id: 'l1', owners: ['src/a'], prompt: 'docs/p.md'},
      {id: 'l2', owners: ['src/b'], prompt: 'docs/p.md'},
      {id: 'l3', owners: ['src/c'], prompt: 'docs/p.md'},
      {id: 'l4', owners: ['src/d'], prompt: 'docs/p.md'}
    ]
  });
  const refStore = createInMemoryWorkQueueRefStore();

  const c1 = await claimWorkQueueLease({
    refStore, config, nowMs: 1000,
    candidate: makeIssueCandidate({issueNumber: 1, lane: 'l1', ownedPaths: ['src/a/1.mjs'], runId: 101})
  });
  const c2 = await claimWorkQueueLease({
    refStore, config, nowMs: 1000,
    candidate: makeIssueCandidate({issueNumber: 2, lane: 'l2', ownedPaths: ['src/b/2.mjs'], runId: 102})
  });
  const c3 = await claimWorkQueueLease({
    refStore, config, nowMs: 1000,
    candidate: makeIssueCandidate({issueNumber: 3, lane: 'l3', ownedPaths: ['src/c/3.mjs'], runId: 103})
  });
  const c4 = await claimWorkQueueLease({
    refStore, config, nowMs: 1000,
    candidate: makeIssueCandidate({issueNumber: 4, lane: 'l4', ownedPaths: ['src/d/4.mjs'], runId: 104, runAttempt: 2, leaseTtlMs: 5000, maxExecutionMs: 10000})
  });
  assert.equal(c4.ok, true);
  assert.equal(c4.lease.runAttempt, 2);

  // Emergency stop blocks crash recovery mutations
  const stopped = await reconcileWorkQueueRunStates({
    refStore,
    observedRuns: [{workId: c1.lease.workId, runId: 101, runAttempt: 1, leaseGeneration: c1.lease.generation, runState: 'launch_failed'}],
    nowMs: 2000,
    stop: true
  });
  assert.equal(stopped.ok, false);
  assert.equal(stopped.reason, 'STOPPED');

  // Regression: nowMs < entry.claimedAtMs (500 < 1000) MUST fail closed with CLOCK_SKEW_REJECTED!
  const clockSkewed = await reconcileWorkQueueRunStates({
    refStore,
    observedRuns: [{workId: c1.lease.workId, runId: 101, runAttempt: 1, leaseGeneration: c1.lease.generation, runState: 'launch_failed'}],
    nowMs: 500
  });
  assert.equal(clockSkewed.ok, false);
  assert.equal(clockSkewed.reason, 'CLOCK_SKEW_REJECTED');

  // Config-level stop also blocks crash recovery mutations; invalid config fails closed
  assert.equal((await reconcileWorkQueueRunStates({
    refStore,
    config: {},
    observedRuns: [],
    nowMs: 2000
  })).reason, 'INVALID_PROJECT_CONFIG');
  assert.equal((await reconcileWorkQueueRunStates({
    refStore,
    config: makeConfig({execution: {enabled: true, mode: 'shadow', stop: true}}),
    observedRuns: [],
    nowMs: 2000
  })).reason, 'STOPPED');

  // Reconcile all 4 states + expired c4 + unknown workId
  const reconciled = await reconcileWorkQueueRunStates({
    refStore,
    config,
    observedRuns: [
      {workId: c1.lease.workId, runId: 101, runAttempt: 1, leaseGeneration: c1.lease.generation, runState: 'launch_failed'},
      {workId: c2.lease.workId, runId: 102, runAttempt: 1, leaseGeneration: c2.lease.generation, runState: 'worker_terminated'},
      {workId: c3.lease.workId, runId: 103, runAttempt: 1, leaseGeneration: c3.lease.generation, runState: 'run_terminal', conclusion: 'success'},
      {workId: `${REPO_ID}:issue:999`, runId: 999, runAttempt: 1, leaseGeneration: 1, runState: 'run_missing'}
    ],
    nowMs: 7000
  });
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.reason, 'ORPHANS_RECLAIMED');
  assert.equal(reconciled.receipts.length, 4);
  assert.equal(reconciled.receipts[3].workId, c4.lease.workId);
  assert.equal(reconciled.receipts[3].previousRunAttempt, 2);
  assert.equal(reconciled.skipped.length, 1);
  assert.equal(reconciled.skipped[0].reason, 'UNKNOWN_WORK_ID');

  // Generation bumped monotonically beyond initial claims (1..4 -> 5..8)
  assert.deepEqual(reconciled.receipts.map(r => r.reclaimedGeneration), [5, 6, 7, 8]);
  assert.deepEqual(reconciled.receipts.map(r => r.outcome), ['requeued', 'requeued', 'completed', 'requeued']);
  assert.equal(reconciled.receipts[3].runState, 'lease_expired');

  // Zombie worker from generation 1 is fenced off
  assert.equal((await settleWorkQueueLease({
    refStore,
    workId: c1.lease.workId,
    workerId: 'worker-alpha',
    generation: c1.lease.generation,
    outcome: 'completed',
    nowMs: 7500
  })).reason, 'STALE_GENERATION');

  // Re-claim c1 for attempt 2 of 2 (reusing runId 201, runAttempt 2), verify runAttempt & leaseGeneration matching
  const retryClaim = await claimWorkQueueLease({
    refStore, config, nowMs: 8000,
    candidate: makeIssueCandidate({issueNumber: 1, lane: 'l1', ownedPaths: ['src/a/1.mjs'], runId: 201, runAttempt: 2, leaseTtlMs: 3000, maxExecutionMs: 20000})
  });
  assert.equal(retryClaim.ok, true);
  assert.equal(retryClaim.lease.attempts, 2);
  assert.equal(retryClaim.lease.generation, 9);
  assert.equal(retryClaim.lease.runAttempt, 2);

  // Same runId 201 with mismatched runAttempt (1 vs 2) or mismatched leaseGeneration (1 vs 9) is rejected as stale!
  for (const mismatchObs of [
    {workId: c1.lease.workId, runId: 201, runAttempt: 1, leaseGeneration: retryClaim.lease.generation, runState: 'run_terminal', conclusion: 'success'},
    {workId: c1.lease.workId, runId: 201, runAttempt: 2, leaseGeneration: c1.lease.generation, runState: 'worker_terminated'}
  ]) {
    const staleReport = await reconcileWorkQueueRunStates({
      refStore,
      observedRuns: [mismatchObs],
      nowMs: 8500
    });
    assert.equal(staleReport.ok, true);
    assert.equal(staleReport.reason, 'NO_ORPHANS_DETECTED');
    assert.equal(staleReport.skipped[0].reason, 'STALE_OR_INACTIVE_RUN');
  }

  // Regression: once retryClaim's lease expires (t=12000 >= 11000), a stale observation for old runId 101
  // MUST record STALE_OR_INACTIVE_RUN AND still reclaim the expired replacement lease!
  const stalePlusExpired = await reconcileWorkQueueRunStates({
    refStore,
    observedRuns: [{workId: c1.lease.workId, runId: 101, runAttempt: 1, leaseGeneration: c1.lease.generation, runState: 'worker_terminated'}],
    nowMs: 12000
  });
  assert.equal(stalePlusExpired.ok, true);
  assert.equal(stalePlusExpired.reason, 'ORPHANS_RECLAIMED');
  assert.equal(stalePlusExpired.skipped.length, 1);
  assert.equal(stalePlusExpired.skipped[0].reason, 'STALE_OR_INACTIVE_RUN');
  assert.equal(stalePlusExpired.receipts.length, 1);
  assert.equal(stalePlusExpired.receipts[0].runState, 'lease_expired');
  assert.equal(stalePlusExpired.receipts[0].outcome, 'exhausted');

  // Further claim on c1 fails closed with RETRY_CEILING_EXHAUSTED
  assert.equal((await claimWorkQueueLease({
    refStore, config, nowMs: 12500,
    candidate: makeIssueCandidate({issueNumber: 1, lane: 'l1', ownedPaths: ['src/a/1.mjs'], runId: 301})
  })).reason, 'RETRY_CEILING_EXHAUSTED');

  // Regression: terminal 'success' arriving AFTER leaseExpiresAtMs (even before executionDeadlineMs)
  // MUST NOT mark completed — it must reclaim as lease_expired!
  const c2Retry = await claimWorkQueueLease({
    refStore, config, nowMs: 13000,
    candidate: makeIssueCandidate({issueNumber: 2, lane: 'l2', ownedPaths: ['src/b/2.mjs'], runId: 202, leaseTtlMs: 2000, maxExecutionMs: 20000})
  });
  assert.equal(c2Retry.ok, true);
  const lateTerminalSuccess = await reconcileWorkQueueRunStates({
    refStore,
    observedRuns: [{
      workId: c2Retry.lease.workId,
      runId: 202,
      runAttempt: 1,
      leaseGeneration: c2Retry.lease.generation,
      runState: 'run_terminal',
      conclusion: 'success'
    }],
    nowMs: 16000
  });
  assert.equal(lateTerminalSuccess.ok, true);
  assert.equal(lateTerminalSuccess.receipts[0].runState, 'lease_expired');
  assert.equal(lateTerminalSuccess.receipts[0].outcome, 'exhausted');

  // Regression: candidate maxAttempts > config.limits.maxAttempts is rejected, and tightened config.limits.maxAttempts clamps reclamation
  const strictOneAttemptCfg = makeConfig({
    limits: {maxConcurrentLanes: 4, leaseMs: 60000, maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 1000},
    lanes: config.lanes
  });
  assert.equal((await claimWorkQueueLease({
    refStore,
    config: strictOneAttemptCfg,
    nowMs: 17000,
    candidate: makeIssueCandidate({issueNumber: 90, lane: 'l4', ownedPaths: ['src/d/90.mjs'], maxAttempts: 3})
  })).reason, 'RETRY_CEILING_EXCEEDED');

  // c4 was requeued with attempts=1, maxAttempts=2 under earlier config; re-claiming under strictOneAttemptCfg rejects with RETRY_CEILING_EXHAUSTED!
  assert.equal((await claimWorkQueueLease({
    refStore,
    config: strictOneAttemptCfg,
    nowMs: 17000,
    candidate: makeIssueCandidate({issueNumber: 4, lane: 'l4', ownedPaths: ['src/d/4.mjs'], runId: 404})
  })).reason, 'RETRY_CEILING_EXHAUSTED');

  // Claim fresh task 91 under 2-attempt config, then reconcile failure under strictOneAttemptCfg -> clamped to exhausted!
  const c91 = await claimWorkQueueLease({
    refStore,
    config,
    nowMs: 17000,
    candidate: makeIssueCandidate({issueNumber: 91, lane: 'l4', ownedPaths: ['src/d/91.mjs'], runId: 910})
  });
  assert.equal(c91.ok, true);
  const clampedReconcile = await reconcileWorkQueueRunStates({
    refStore,
    config: strictOneAttemptCfg,
    observedRuns: [{
      workId: c91.lease.workId,
      runId: 910,
      runAttempt: 1,
      leaseGeneration: c91.lease.generation,
      runState: 'run_missing'
    }],
    nowMs: 17500
  });
  assert.equal(clampedReconcile.ok, true);
  assert.equal(clampedReconcile.receipts[0].maxAttempts, 1);
  assert.equal(clampedReconcile.receipts[0].outcome, 'exhausted');

  // Regression: lowering config.limits.maxAttempts from 2 to 1 during attempt 2 must NOT fail with INVALID_NEXT_STATE!
  const c92Attempt1 = await claimWorkQueueLease({
    refStore,
    config,
    nowMs: 18000,
    candidate: makeIssueCandidate({issueNumber: 92, lane: 'l4', ownedPaths: ['src/d/92.mjs'], runId: 920})
  });
  assert.equal(c92Attempt1.ok, true);
  assert.equal((await reconcileWorkQueueRunStates({
    refStore,
    config,
    observedRuns: [{
      workId: c92Attempt1.lease.workId,
      runId: 920,
      runAttempt: 1,
      leaseGeneration: c92Attempt1.lease.generation,
      runState: 'worker_terminated'
    }],
    nowMs: 18500
  })).receipts[0].outcome, 'requeued');

  const c92Attempt2 = await claimWorkQueueLease({
    refStore,
    config,
    nowMs: 19000,
    candidate: makeIssueCandidate({issueNumber: 92, lane: 'l4', ownedPaths: ['src/d/92.mjs'], runId: 921, leaseTtlMs: 2000, maxExecutionMs: 10000})
  });
  assert.equal(c92Attempt2.ok, true);
  assert.equal(c92Attempt2.lease.attempts, 2);

  // Now reconcile under strictOneAttemptCfg (maxAttempts = 1 while attempts === 2)
  const c92LoweredReconcile = await reconcileWorkQueueRunStates({
    refStore,
    config: strictOneAttemptCfg,
    observedRuns: [{
      workId: c92Attempt2.lease.workId,
      runId: 921,
      runAttempt: 1,
      leaseGeneration: c92Attempt2.lease.generation,
      runState: 'worker_terminated'
    }],
    nowMs: 19500
  });
  assert.equal(c92LoweredReconcile.ok, true);
  assert.equal(c92LoweredReconcile.reason, 'ORPHANS_RECLAIMED');
  assert.equal(c92LoweredReconcile.receipts[0].attempts, 2);
  assert.equal(c92LoweredReconcile.receipts[0].maxAttempts, 1);
  assert.equal(c92LoweredReconcile.receipts[0].outcome, 'exhausted');
});

test('retries transient CAS conflicts and fails closed on proxies, store errors, cancelled work, and invalid options', async () => {
  const config = makeConfig();
  const backing = createInMemoryWorkQueueRefStore();

  let conflictOnce = true;
  const flakyStore = {
    readRef(ref) {
      return backing.readRef(ref);
    },
    compareAndSwapRef(req) {
      if (conflictOnce) {
        conflictOnce = false;
        return {ok: false, reason: 'CAS_CONFLICT', currentOid: ZERO_GIT_OID};
      }
      return backing.compareAndSwapRef(req);
    }
  };

  const claimedAfterRetry = await claimWorkQueueLease({
    refStore: flakyStore,
    config,
    candidate: makeIssueCandidate({issueNumber: 50, maxExecutionMs: undefined, traceparent: undefined, lockSha256: undefined}),
    nowMs: 1000,
    maxCasAttempts: 2
  });
  assert.equal(claimedAfterRetry.ok, true);
  assert.equal(claimedAfterRetry.casAttempts, 2);

  // Settle as cancelled -> subsequent claim rejected with WORK_CANCELLED
  const cancelled = await settleWorkQueueLease({
    refStore: backing,
    workId: claimedAfterRetry.lease.workId,
    workerId: 'worker-alpha',
    generation: claimedAfterRetry.lease.generation,
    outcome: 'cancelled',
    nowMs: 1500
  });
  assert.equal(cancelled.ok, true);
  assert.equal((await claimWorkQueueLease({
    refStore: backing,
    config,
    candidate: makeIssueCandidate({issueNumber: 50, runId: 1051}),
    nowMs: 2000
  })).reason, 'WORK_CANCELLED');

  // Settle requeued when attempts >= maxAttempts becomes exhausted
  const oneShotClaim = await claimWorkQueueLease({
    refStore: backing,
    config,
    candidate: makeIssueCandidate({issueNumber: 51, maxAttempts: 1}),
    nowMs: 2000
  });
  const settledExhausted = await settleWorkQueueLease({
    refStore: backing,
    workId: oneShotClaim.lease.workId,
    workerId: 'worker-alpha',
    generation: oneShotClaim.lease.generation,
    outcome: 'requeued',
    nowMs: 2500
  });
  assert.equal(settledExhausted.lease.status, 'exhausted');

  // Always-conflicting store hits CAS_CONFLICT_EXHAUSTED across claim, renew, settle, reconcile
  const activeClaim = await claimWorkQueueLease({
    refStore: backing,
    config,
    candidate: makeIssueCandidate({issueNumber: 52, leaseTtlMs: 5000, maxExecutionMs: 20000}),
    nowMs: 3000
  });
  assert.equal(activeClaim.ok, true);

  // Lease expired before executionDeadlineMs on renew & settle completed
  assert.equal((await renewWorkQueueLease({
    refStore: backing,
    workId: activeClaim.lease.workId,
    workerId: 'worker-alpha',
    generation: activeClaim.lease.generation,
    leaseTtlMs: 5000,
    nowMs: 9000
  })).reason, 'LEASE_EXPIRED');
  assert.equal((await settleWorkQueueLease({
    refStore: backing,
    workId: activeClaim.lease.workId,
    workerId: 'worker-alpha',
    generation: activeClaim.lease.generation,
    outcome: 'completed',
    nowMs: 9000
  })).reason, 'LEASE_EXPIRED');
  assert.equal((await settleWorkQueueLease({
    refStore: backing,
    workId: activeClaim.lease.workId,
    workerId: 'worker-alpha',
    generation: activeClaim.lease.generation,
    outcome: 'completed',
    nowMs: 25000
  })).reason, 'EXECUTION_TTL_EXCEEDED');

  const activeClaim2 = await claimWorkQueueLease({
    refStore: backing,
    config,
    candidate: makePrCandidate({pullNumber: 60}),
    nowMs: 10000
  });
  const alwaysConflictStore = {
    readRef: ref => backing.readRef(ref),
    compareAndSwapRef: () => ({ok: false, reason: 'CAS_CONFLICT'})
  };
  assert.equal((await claimWorkQueueLease({
    refStore: alwaysConflictStore,
    config,
    candidate: makeIssueCandidate({issueNumber: 61, lane: 'docs', ownedPaths: ['docs/A.md']}),
    nowMs: 10500,
    maxCasAttempts: 1
  })).reason, 'CAS_CONFLICT_EXHAUSTED');
  assert.equal((await renewWorkQueueLease({
    refStore: alwaysConflictStore,
    workId: activeClaim2.lease.workId,
    workerId: 'worker-beta',
    generation: activeClaim2.lease.generation,
    leaseTtlMs: 5000,
    nowMs: 10500,
    maxCasAttempts: 1
  })).reason, 'CAS_CONFLICT_EXHAUSTED');
  assert.equal((await settleWorkQueueLease({
    refStore: alwaysConflictStore,
    workId: activeClaim2.lease.workId,
    workerId: 'worker-beta',
    generation: activeClaim2.lease.generation,
    outcome: 'completed',
    nowMs: 10500,
    maxCasAttempts: 1
  })).reason, 'CAS_CONFLICT_EXHAUSTED');
  assert.equal((await reconcileWorkQueueRunStates({
    refStore: alwaysConflictStore,
    observedRuns: [{workId: activeClaim2.lease.workId, runId: 2002, runAttempt: 1, leaseGeneration: activeClaim2.lease.generation, runState: 'worker_terminated'}],
    nowMs: 10500,
    maxCasAttempts: 1
  })).reason, 'CAS_CONFLICT_EXHAUSTED');

  // Throwing / corrupted refStore handling
  const throwingReadStore = {
    readRef() { throw new Error('network down'); },
    compareAndSwapRef() { throw new Error('network down'); }
  };
  assert.equal((await claimWorkQueueLease({
    refStore: throwingReadStore,
    config,
    candidate: makeIssueCandidate({issueNumber: 70}),
    nowMs: 1000
  })).reason, 'REF_STORE_UNAVAILABLE');

  const throwingWriteStore = {
    readRef: ref => backing.readRef(ref),
    compareAndSwapRef() { throw new Error('write failed'); }
  };
  assert.equal((await renewWorkQueueLease({
    refStore: throwingWriteStore,
    workId: activeClaim2.lease.workId,
    workerId: 'worker-beta',
    generation: activeClaim2.lease.generation,
    leaseTtlMs: 5000,
    nowMs: 10500
  })).reason, 'REF_STORE_UNAVAILABLE');
  assert.equal((await settleWorkQueueLease({
    refStore: throwingWriteStore,
    workId: activeClaim2.lease.workId,
    workerId: 'worker-beta',
    generation: activeClaim2.lease.generation,
    outcome: 'completed',
    nowMs: 10500
  })).reason, 'REF_STORE_UNAVAILABLE');
  assert.equal((await reconcileWorkQueueRunStates({
    refStore: throwingWriteStore,
    observedRuns: [{workId: activeClaim2.lease.workId, runId: 2002, runAttempt: 1, leaseGeneration: activeClaim2.lease.generation, runState: 'worker_terminated'}],
    nowMs: 10500
  })).reason, 'REF_STORE_UNAVAILABLE');

  const corruptedStore = {
    readRef: () => ({ok: true, oid: HEAD_A, state: null}),
    compareAndSwapRef: () => ({ok: false, reason: 'ERR'})
  };
  assert.equal((await claimWorkQueueLease({
    refStore: corruptedStore,
    config,
    candidate: makeIssueCandidate({issueNumber: 71}),
    nowMs: 1000
  })).reason, 'INVALID_QUEUE_STATE');

  // Revoked and throwing-getter Proxy responses from readRef() and compareAndSwapRef() must never invoke traps!
  let proxyTrapCount = 0;
  const badTrap = () => {
    proxyTrapCount++;
    throw new Error('proxy trap invoked');
  };
  const trapHandler = {get: badTrap, getOwnPropertyDescriptor: badTrap, ownKeys: badTrap, getPrototypeOf: badTrap};
  const revokedSnap = Proxy.revocable({ok: false, reason: 'TRAP'}, trapHandler);
  revokedSnap.revoke();
  const proxyReadStore = {
    readRef: () => new Proxy({ok: false, reason: 'TRAP'}, trapHandler),
    compareAndSwapRef: () => ({ok: false})
  };
  const revokedReadStore = {
    readRef: () => revokedSnap.proxy,
    compareAndSwapRef: () => ({ok: false})
  };
  const getterReadObj = {};
  Object.defineProperty(getterReadObj, 'ok', {enumerable: true, get: badTrap});
  const getterReadStore = {
    readRef: () => getterReadObj,
    compareAndSwapRef: () => ({ok: false})
  };
  const proxyCasStore = {
    readRef: ref => backing.readRef(ref),
    compareAndSwapRef: () => new Proxy({ok: false, reason: 'TRAP'}, trapHandler)
  };
  const revokedCasStore = {
    readRef: ref => backing.readRef(ref),
    compareAndSwapRef: () => revokedSnap.proxy
  };
  const asyncNullCasStore = {
    readRef: ref => backing.readRef(ref),
    compareAndSwapRef: async () => null
  };
  // Thenable plain objects with throwing `get then()` accessors must NEVER invoke `then`!
  const thenGetterReadObj = {ok: true, oid: ZERO_GIT_OID, state: null};
  Object.defineProperty(thenGetterReadObj, 'then', {enumerable: true, get: badTrap});
  const thenGetterReadStore = {
    readRef: () => thenGetterReadObj,
    compareAndSwapRef: () => ({ok: false})
  };
  const thenGetterCasObj = {ok: true, oid: HEAD_A};
  Object.defineProperty(thenGetterCasObj, 'then', {enumerable: true, get: badTrap});
  const thenGetterCasStore = {
    readRef: ref => backing.readRef(ref),
    compareAndSwapRef: () => thenGetterCasObj
  };
  const taggedPromise = Promise.resolve({ok: true, oid: ZERO_GIT_OID, state: null});
  Object.defineProperty(taggedPromise, 'then', {enumerable: true, get: badTrap});
  const taggedPromiseReadStore = {
    readRef: () => taggedPromise,
    compareAndSwapRef: () => ({ok: false})
  };
  for (const unsafeStore of [
    proxyReadStore,
    revokedReadStore,
    getterReadStore,
    proxyCasStore,
    revokedCasStore,
    asyncNullCasStore,
    thenGetterReadStore,
    thenGetterCasStore,
    taggedPromiseReadStore
  ]) {
    const res = await claimWorkQueueLease({
      refStore: unsafeStore,
      config,
      candidate: makeIssueCandidate({issueNumber: 72, lane: 'docs', ownedPaths: ['docs/PROXY.md']}),
      nowMs: 11000
    });
    assert.equal(res.reason, 'REF_STORE_UNAVAILABLE');
  }
  assert.equal(proxyTrapCount, 0);

  // Regression: mutating caller-owned candidate.ownedPaths or config.limits during async readRef()
  // MUST NOT persist unvalidated paths or altered limits!
  const mutatingBacking = createInMemoryWorkQueueRefStore();
  const mutablePaths = ['docs/SAFE.md'];
  const mutableCandidate = makeIssueCandidate({
    issueNumber: 73,
    lane: 'docs',
    ownedPaths: mutablePaths
  });
  const mutableConfig = makeConfig();
  const mutatingStore = {
    async readRef(ref) {
      const snap = mutatingBacking.readRef(ref);
      await Promise.resolve();
      mutablePaths[0] = '.github/workflows/evil.yml';
      mutableCandidate.lane = 'hacked';
      mutableConfig.limits.maxAttempts = 5;
      return snap;
    },
    compareAndSwapRef(req) {
      return mutatingBacking.compareAndSwapRef(req);
    }
  };
  const snapshotSafeClaim = await claimWorkQueueLease({
    refStore: mutatingStore,
    config: mutableConfig,
    candidate: mutableCandidate,
    nowMs: 11000
  });
  assert.equal(snapshotSafeClaim.ok, true);
  assert.deepEqual(snapshotSafeClaim.lease.ownedPaths, ['docs/SAFE.md']);
  assert.equal(snapshotSafeClaim.lease.lane, 'docs');
  assert.equal(snapshotSafeClaim.lease.maxAttempts, 2);

  // Regression: mid-flight mutations during deferred readRef() in renew, settle, and reconcile MUST NOT alter validated requests!
  let onDeferredRead = null;
  const deferredStore = {
    async readRef(ref) {
      const snap = mutatingBacking.readRef(ref);
      await Promise.resolve();
      if (onDeferredRead !== null) onDeferredRead();
      return snap;
    },
    compareAndSwapRef(req) {
      return mutatingBacking.compareAndSwapRef(req);
    }
  };

  // 1) Renewal mid-flight mutation (leaseTtlMs 50000 -> 0, workerId -> 'hijacked')
  const mutableRenewOpts = {
    refStore: deferredStore,
    workId: snapshotSafeClaim.lease.workId,
    workerId: 'worker-alpha',
    generation: snapshotSafeClaim.lease.generation,
    leaseTtlMs: 50000,
    nowMs: 50000
  };
  onDeferredRead = () => {
    mutableRenewOpts.leaseTtlMs = 0;
    mutableRenewOpts.workerId = 'hijacked';
    mutableRenewOpts.generation = 999;
  };
  const snapRenewed = await renewWorkQueueLease(mutableRenewOpts);
  assert.equal(snapRenewed.ok, true);
  assert.equal(snapRenewed.lease.leaseExpiresAtMs, 100000);

  // 2) Settlement mid-flight mutation (outcome 'requeued' -> 'completed')
  const mutableSettleOpts = {
    refStore: deferredStore,
    workId: snapshotSafeClaim.lease.workId,
    workerId: 'worker-alpha',
    generation: snapshotSafeClaim.lease.generation,
    outcome: 'requeued',
    nowMs: 55000
  };
  onDeferredRead = () => {
    mutableSettleOpts.outcome = 'completed';
    mutableSettleOpts.workerId = 'hijacked';
  };
  const snapSettled = await settleWorkQueueLease(mutableSettleOpts);
  assert.equal(snapSettled.ok, true);
  assert.equal(snapSettled.lease.status, 'requeued');

  // 3) Reconciliation mid-flight mutation (observation 'worker_terminated' -> 'run_terminal'/'success')
  const reClaimed73 = await claimWorkQueueLease({
    refStore: mutatingBacking,
    config: makeConfig(),
    candidate: makeIssueCandidate({issueNumber: 73, lane: 'docs', ownedPaths: ['docs/SAFE.md'], runId: 1730}),
    nowMs: 56000
  });
  assert.equal(reClaimed73.ok, true);
  const mutableObs = {
    workId: reClaimed73.lease.workId,
    runId: 1730,
    runAttempt: 1,
    leaseGeneration: reClaimed73.lease.generation,
    runState: 'worker_terminated'
  };
  const mutableReconcileOpts = {
    refStore: deferredStore,
    observedRuns: [mutableObs],
    nowMs: 57000
  };
  onDeferredRead = () => {
    mutableObs.runState = 'run_terminal';
    mutableObs.conclusion = 'success';
    mutableReconcileOpts.nowMs = 0;
  };
  const snapReconciled = await reconcileWorkQueueRunStates(mutableReconcileOpts);
  onDeferredRead = null;
  assert.equal(snapReconciled.ok, true);
  assert.equal(snapReconciled.receipts[0].runState, 'worker_terminated');
  assert.equal(snapReconciled.receipts[0].outcome, 'exhausted');

  // Regression: 'neutral' and 'skipped' terminal conclusions are accepted and requeue/exhaust cleanly
  const neutralClaim = await claimWorkQueueLease({
    refStore: mutatingBacking,
    config: makeConfig(),
    candidate: makePrCandidate({pullNumber: 74, headSha: HEAD_A}),
    nowMs: 58000
  });
  assert.equal(neutralClaim.ok, true);
  const neutralReconciled = await reconcileWorkQueueRunStates({
    refStore: mutatingBacking,
    observedRuns: [{
      workId: neutralClaim.lease.workId,
      runId: 2002,
      runAttempt: 1,
      leaseGeneration: neutralClaim.lease.generation,
      runState: 'run_terminal',
      conclusion: 'neutral'
    }],
    nowMs: 58500
  });
  assert.equal(neutralReconciled.ok, true);
  assert.equal(neutralReconciled.receipts[0].conclusion, 'neutral');
  assert.equal(neutralReconciled.receipts[0].outcome, 'requeued');

  const skippedRetry = await claimWorkQueueLease({
    refStore: mutatingBacking,
    config: makeConfig(),
    candidate: makePrCandidate({pullNumber: 74, headSha: HEAD_A, runId: 2003}),
    nowMs: 59000
  });
  const skippedReconciled = await reconcileWorkQueueRunStates({
    refStore: mutatingBacking,
    observedRuns: [{
      workId: skippedRetry.lease.workId,
      runId: 2003,
      runAttempt: 1,
      leaseGeneration: skippedRetry.lease.generation,
      runState: 'run_terminal',
      conclusion: 'skipped'
    }],
    nowMs: 59500
  });
  assert.equal(skippedReconciled.ok, true);
  assert.equal(skippedReconciled.receipts[0].conclusion, 'skipped');
  assert.equal(skippedReconciled.receipts[0].outcome, 'exhausted');

  // Revoked proxy safety across all entrypoints
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.equal((await claimWorkQueueLease(revoked.proxy)).reason, 'INVALID_CLAIM_OPTIONS');
  assert.equal((await renewWorkQueueLease(revoked.proxy)).reason, 'INVALID_RENEW_OPTIONS');
  assert.equal((await settleWorkQueueLease(revoked.proxy)).reason, 'INVALID_SETTLE_OPTIONS');
  assert.equal((await reconcileWorkQueueRunStates(revoked.proxy)).reason, 'INVALID_RECONCILE_INPUT');

  // Non-string workerId values (arrays, symbols, objects without toString) must fail closed without coercion or throwing!
  for (const nonStringWorker of [['worker-alpha'], Symbol('worker'), {toString: null, valueOf: null}, 123]) {
    assert.equal((await claimWorkQueueLease({
      refStore: backing,
      config,
      candidate: makeIssueCandidate({workerId: nonStringWorker, lane: 'docs', ownedPaths: ['docs/W.md']}),
      nowMs: 11000
    })).reason, 'INVALID_CANDIDATE');
    assert.equal((await renewWorkQueueLease({
      refStore: backing, workId: 'w', workerId: nonStringWorker, generation: 1, leaseTtlMs: 1000, nowMs: 1
    })).reason, 'INVALID_RENEW_OPTIONS');
    assert.equal((await settleWorkQueueLease({
      refStore: backing, workId: 'w', workerId: nonStringWorker, generation: 1, outcome: 'completed', nowMs: 1
    })).reason, 'INVALID_SETTLE_OPTIONS');
  }

  // Force forbidden & invalid option branches across renew, settle, reconcile, and candidate validation
  assert.equal((await renewWorkQueueLease({
    refStore: backing, workId: 'w', workerId: 'worker-a', generation: 1, leaseTtlMs: 1000, nowMs: 1, force: true
  })).reason, 'FORCE_UPDATE_FORBIDDEN');
  assert.equal((await renewWorkQueueLease({
    refStore: backing, workId: 'w', workerId: 'worker-a', generation: 1, leaseTtlMs: 1000, nowMs: 1, stop: true
  })).reason, 'STOPPED');
  assert.equal((await renewWorkQueueLease({
    refStore: backing, workId: 'w', workerId: 'worker-a', generation: 1, leaseTtlMs: 0, nowMs: 1
  })).reason, 'INVALID_LEASE_TTL');
  assert.equal((await settleWorkQueueLease({
    refStore: backing, workId: 'w', workerId: 'worker-a', generation: 1, outcome: 'completed', nowMs: 1, force: true
  })).reason, 'FORCE_UPDATE_FORBIDDEN');
  assert.equal((await settleWorkQueueLease({
    refStore: backing, workId: 'w', workerId: 'worker-a', generation: 1, outcome: 'completed', nowMs: 1, stop: true
  })).reason, 'STOPPED');
  assert.equal((await reconcileWorkQueueRunStates({
    refStore: backing, observedRuns: [], nowMs: 1, force: true
  })).reason, 'FORCE_UPDATE_FORBIDDEN');
  assert.equal((await reconcileWorkQueueRunStates({
    refStore: backing,
    observedRuns: [{workId: 'w', runId: 1, runAttempt: 1, leaseGeneration: 1, runState: 'unknown_state'}],
    nowMs: 1
  })).reason, 'INVALID_RECONCILE_INPUT');
  assert.equal((await reconcileWorkQueueRunStates({
    refStore: backing,
    observedRuns: [{workId: 'w', runId: 1, runAttempt: 1, leaseGeneration: 1, runState: 'launch_failed', conclusion: 'failure'}],
    nowMs: 1
  })).reason, 'INVALID_RECONCILE_INPUT');
  assert.equal((await reconcileWorkQueueRunStates({
    refStore: backing,
    observedRuns: [{workId: 'w', runId: 1, runAttempt: 1, leaseGeneration: 1, runState: 'run_terminal'}],
    nowMs: 1
  })).reason, 'INVALID_RECONCILE_INPUT');
  assert.equal((await reconcileWorkQueueRunStates({
    refStore: backing,
    observedRuns: [{workId: 'w', runId: 1, runAttempt: 1, leaseGeneration: 1, runState: 'run_terminal', conclusion: null}],
    nowMs: 1
  })).reason, 'INVALID_RECONCILE_INPUT');
  assert.equal((await reconcileWorkQueueRunStates({
    refStore: backing,
    observedRuns: [{workId: 'w', runId: 1, runState: 'launch_failed'}],
    nowMs: 1
  })).reason, 'INVALID_RECONCILE_INPUT');

  for (const [badCand, expectedReason] of [
    [null, 'INVALID_CANDIDATE'],
    [makeIssueCandidate({repository: 'a/../b'}), 'INVALID_CANDIDATE'],
    [makeIssueCandidate({ownedPaths: ['/abs/path.mjs']}), 'INVALID_CANDIDATE'],
    [makeIssueCandidate({ownedPaths: ['dup.mjs', 'dup.mjs']}), 'INVALID_CANDIDATE'],
    [makeIssueCandidate({repository: 'Other/Repo'}), 'CROSS_REPO_CANDIDATE_REJECTED'],
    [makeIssueCandidate({lane: 'unknown'}), 'LANE_OWNERSHIP_VIOLATION'],
    [makeIssueCandidate({ownedPaths: ['docs/wrong-lane.md']}), 'LANE_OWNERSHIP_VIOLATION'],
    [makeIssueCandidate({targetType: 'unknown'}), 'INVALID_CANDIDATE'],
    [makeIssueCandidate({traceparent: 'invalid'}), 'INVALID_CANDIDATE'],
    [makeIssueCandidate({lockSha256: 'invalid'}), 'INVALID_CANDIDATE'],
    [makeIssueCandidate({maxAttempts: 9}), 'INVALID_CANDIDATE'],
    [makeIssueCandidate({maxAttempts: 4}), 'RETRY_CEILING_EXCEEDED'],
    [makeIssueCandidate({runAttempt: 0}), 'INVALID_CANDIDATE'],
    [makeIssueCandidate({pullNumber: 1}), 'INVALID_CANDIDATE'],
    [makePrCandidate({issueNumber: 1}), 'INVALID_CANDIDATE']
  ]) {
    assert.equal((await claimWorkQueueLease({
      refStore: backing,
      config,
      candidate: badCand,
      nowMs: 11000
    })).reason, expectedReason);
  }

  // Invalid force/options/store permutations and state corruption validation
  const holeyArr = new Array(1);
  assert.equal(planUnifiedWorkQueue({
    config,
    shadowInput: {enabled: true, stop: false, capacity: 1, quotaVerified: true, tasks: holeyArr},
    nowMs: 0
  }).reason, 'INVALID_TASKS');

  assert.equal((await claimWorkQueueLease({
    refStore: backing, config, candidate: makeIssueCandidate(), nowMs: 1000, force: 'bad'
  })).reason, 'INVALID_CLAIM_OPTIONS');
  assert.equal((await claimWorkQueueLease({
    refStore: null, config, candidate: makeIssueCandidate(), nowMs: 1000, maxCasAttempts: 99
  })).reason, 'INVALID_CLAIM_OPTIONS');

  assert.equal((await renewWorkQueueLease({
    refStore: backing, workId: 'w', workerId: 'worker-a', generation: 1, leaseTtlMs: 1000, nowMs: 1, force: 'bad'
  })).reason, 'INVALID_RENEW_OPTIONS');
  assert.equal((await renewWorkQueueLease({
    refStore: backing, workId: '', workerId: 'worker-a', generation: 1, leaseTtlMs: 1000, nowMs: 1
  })).reason, 'INVALID_RENEW_OPTIONS');

  assert.equal((await settleWorkQueueLease({
    refStore: backing, workId: 'w', workerId: 'worker-a', generation: 1, outcome: 'completed', nowMs: 1, force: 'bad'
  })).reason, 'INVALID_SETTLE_OPTIONS');
  assert.equal((await settleWorkQueueLease({
    refStore: backing, workId: 'w', workerId: 'worker-a', generation: 1, outcome: 'bad', nowMs: 1
  })).reason, 'INVALID_SETTLE_OPTIONS');
  assert.equal((await settleWorkQueueLease({
    refStore: backing, workId: 'missing', workerId: 'worker-a', generation: 1, outcome: 'cancelled', nowMs: 10500
  })).reason, 'WORK_NOT_FOUND');
  assert.equal((await settleWorkQueueLease({
    refStore: backing, workId: activeClaim2.lease.workId, workerId: 'wrong-worker', generation: activeClaim2.lease.generation, outcome: 'cancelled', nowMs: 10500
  })).reason, 'LEASE_NOT_HELD');
  assert.equal((await settleWorkQueueLease({
    refStore: backing, workId: activeClaim2.lease.workId, workerId: 'worker-beta', generation: activeClaim2.lease.generation, outcome: 'cancelled', nowMs: 5000
  })).reason, 'CLOCK_SKEW_REJECTED');

  assert.equal((await reconcileWorkQueueRunStates({
    refStore: backing, observedRuns: [], nowMs: 1, force: 'bad'
  })).reason, 'INVALID_RECONCILE_INPUT');
  assert.equal((await reconcileWorkQueueRunStates({
    refStore: backing, observedRuns: [], nowMs: 1, maxCasAttempts: 0
  })).reason, 'INVALID_RECONCILE_INPUT');

  // Custom read/write failure reasons and corrupted non-null state
  const customReadFail = {
    readRef: () => ({ok: false, reason: 'CUSTOM_READ_DENIED'}),
    compareAndSwapRef: () => ({ok: false})
  };
  assert.equal((await claimWorkQueueLease({
    refStore: customReadFail, config, candidate: makeIssueCandidate(), nowMs: 1000
  })).reason, 'CUSTOM_READ_DENIED');

  const corruptedNonNull = {
    readRef: () => ({ok: true, oid: HEAD_A, state: {schemaVersion: 1, protocol: 'v3', sequence: 0, nextGeneration: 1, entries: [{}], recoveryReceipts: []}}),
    compareAndSwapRef: () => ({ok: false})
  };
  assert.equal((await claimWorkQueueLease({
    refStore: corruptedNonNull, config, candidate: makeIssueCandidate(), nowMs: 1000
  })).reason, 'INVALID_QUEUE_STATE');

  const customWriteFail = {
    readRef: ref => backing.readRef(ref),
    compareAndSwapRef: () => ({ok: false, reason: 'CUSTOM_WRITE_DENIED'})
  };
  assert.equal((await claimWorkQueueLease({
    refStore: customWriteFail,
    config,
    candidate: makeIssueCandidate({issueNumber: 91, lane: 'docs', ownedPaths: ['docs/X.md']}),
    nowMs: 11000
  })).reason, 'CUSTOM_WRITE_DENIED');

  const badCasOidStore = {
    readRef: ref => backing.readRef(ref),
    compareAndSwapRef: () => ({ok: true, oid: 12345})
  };
  assert.equal((await claimWorkQueueLease({
    refStore: badCasOidStore,
    config,
    candidate: makeIssueCandidate({issueNumber: 93, lane: 'docs', ownedPaths: ['docs/Y.md']}),
    nowMs: 11000
  })).reason, 'REF_STORE_UNAVAILABLE');

  const badReadOidStore = {
    readRef: () => ({ok: true, oid: 12345, state: null}),
    compareAndSwapRef: () => ({ok: false})
  };
  assert.equal((await claimWorkQueueLease({
    refStore: badReadOidStore,
    config,
    candidate: makeIssueCandidate({issueNumber: 94, lane: 'docs', ownedPaths: ['docs/Z.md']}),
    nowMs: 11000
  })).reason, 'REF_STORE_UNAVAILABLE');

  // Validate state entries, receipts, and QUEUE_CAPACITY_EXCEEDED (250 entries)
  const snap = backing.readRef().state;
  const baseEntry = {...activeClaim2.lease, ownedPaths: [...activeClaim2.lease.ownedPaths]};
  for (const badState of [
    {...snap, entries: [{...baseEntry, workerId: ['worker-beta']}]},
    {...snap, entries: [{...baseEntry, headSha: [HEAD_A]}]},
    {...snap, entries: [{...baseEntry, leaseExpiresAtMs: baseEntry.executionDeadlineMs + 1}]},
    {...snap, entries: [{...baseEntry, targetType: 'unknown'}]},
    {...snap, entries: [{...baseEntry, targetType: 'issue', issueNumber: 0, pullNumber: null, headSha: null}]},
    {...snap, entries: [{...baseEntry, targetType: 'pull_request', pullNumber: 0}]},
    {...snap, entries: [{...baseEntry, workId: 'mismatch'}]},
    {...snap, entries: [{...baseEntry, traceparent: 'bad'}]},
    {...snap, entries: [{...baseEntry, traceparent: 123}]},
    {...snap, entries: [{...baseEntry, lockSha256: 123}]},
    {...snap, entries: [{...baseEntry, lockSha256: 'bad'}]},
    {...snap, entries: [baseEntry, baseEntry]},
    {...snap, recoveryReceipts: [{invalid: true}]},
    {...snap, recoveryReceipts: [{
      workId: baseEntry.workId,
      repositoryId: REPO_ID,
      targetType: 'pull_request',
      runState: 'worker_terminated',
      conclusion: null,
      previousRunId: 1,
      previousRunAttempt: 1,
      previousGeneration: 5,
      reclaimedGeneration: 3,
      attempts: 1,
      maxAttempts: 2,
      outcome: 'requeued',
      reclaimedAtMs: 100
    }]}
  ]) {
    assert.throws(() => createInMemoryWorkQueueRefStore(badState), /INVALID_INITIAL_WORK_QUEUE_STATE/);
  }

  const fullEntries = Array.from({length: 250}, (_, idx) => ({
    workId: `${REPO_ID}:issue:${idx + 1}`,
    targetType: 'issue',
    repository: REPO,
    repositoryId: REPO_ID,
    issueNumber: idx + 1,
    pullNumber: null,
    headSha: null,
    lane: 'docs',
    ownedPaths: ['docs/FULL.md'],
    status: 'completed',
    generation: idx + 1,
    attempts: 1,
    maxAttempts: 2,
    workerId: 'worker-seed',
    runId: idx + 1,
    runAttempt: 1,
    claimedAtMs: 100,
    leaseTtlMs: 1000,
    leaseExpiresAtMs: 100,
    maxExecutionMs: 2000,
    executionDeadlineMs: 2100
  }));
  // Compaction at 250 entries: completed entries are compacted into archivedTerminal to free active capacity
  // while preserving durable completed/cancelled/exhausted deduplication!
  fullEntries[1].status = 'cancelled';
  fullEntries[2].status = 'exhausted';
  const fullStore = createInMemoryWorkQueueRefStore({
    schemaVersion: 1,
    protocol: 'v4',
    sequence: 250,
    nextGeneration: 251,
    entries: fullEntries,
    recoveryReceipts: [{
      workId: `${REPO_ID}:issue:1`,
      repositoryId: REPO_ID,
      targetType: 'issue',
      runState: 'worker_terminated',
      conclusion: null,
      previousRunId: 1,
      previousRunAttempt: 1,
      previousGeneration: 1,
      reclaimedGeneration: 2,
      attempts: 1,
      maxAttempts: 2,
      outcome: 'requeued',
      reclaimedAtMs: 150
    }]
  });
  for (const issueNumber of [999, 1000, 1001]) {
    const compactedClaim = await claimWorkQueueLease({
      refStore: fullStore,
      config,
      candidate: makeIssueCandidate({issueNumber, lane: 'docs', ownedPaths: ['docs/NEW.md'], leaseTtlMs: 100, maxExecutionMs: 200}),
      nowMs: 5000 + issueNumber * 500
    });
    assert.equal(compactedClaim.ok, true);
  }
  // Evicted issue #1 (completed), #2 (cancelled), and #3 (exhausted) remain durably deduplicated via archivedTerminal!
  assert.equal((await claimWorkQueueLease({
    refStore: fullStore,
    config,
    candidate: makeIssueCandidate({issueNumber: 1, lane: 'docs', ownedPaths: ['docs/NEW.md']}),
    nowMs: 600000
  })).reason, 'WORK_ALREADY_COMPLETED');
  assert.equal((await claimWorkQueueLease({
    refStore: fullStore,
    config,
    candidate: makeIssueCandidate({issueNumber: 2, lane: 'docs', ownedPaths: ['docs/NEW.md']}),
    nowMs: 600000
  })).reason, 'WORK_CANCELLED');
  assert.equal((await claimWorkQueueLease({
    refStore: fullStore,
    config,
    candidate: makeIssueCandidate({issueNumber: 3, lane: 'docs', ownedPaths: ['docs/NEW.md']}),
    nowMs: 600000
  })).reason, 'RETRY_CEILING_EXHAUSTED');

  // Invalid archivedTerminal in persisted state is rejected
  assert.throws(() => createInMemoryWorkQueueRefStore({
    ...fullStore.readRef().state,
    archivedTerminal: [{workId: '', status: 'completed'}]
  }), /INVALID_INITIAL_WORK_QUEUE_STATE/);

  // When both entries (250) and archivedTerminal (2,000) are full, fail closed with ARCHIVE_CAPACITY_EXHAUSTED
  // instead of evicting/forgetting terminal deduplication history!
  const saturatedArchived = Array.from({length: 2000}, (_, idx) => ({
    workId: `${REPO_ID}:issue:${idx + 10000}`,
    status: 'completed'
  }));
  const archiveFullStore = createInMemoryWorkQueueRefStore({
    schemaVersion: 1,
    protocol: 'v3',
    sequence: 2250,
    nextGeneration: 251,
    entries: fullEntries,
    archivedTerminal: saturatedArchived,
    recoveryReceipts: []
  });
  assert.equal((await claimWorkQueueLease({
    refStore: archiveFullStore,
    config,
    candidate: makeIssueCandidate({issueNumber: 50000, lane: 'docs', ownedPaths: ['docs/NEW.md']}),
    nowMs: 5000
  })).reason, 'ARCHIVE_CAPACITY_EXHAUSTED');
  assert.equal(archiveFullStore.readRef().state.archivedTerminal.length, 2000);
  assert.equal((await claimWorkQueueLease({
    refStore: archiveFullStore,
    config,
    candidate: makeIssueCandidate({issueNumber: 10000, lane: 'docs', ownedPaths: ['docs/NEW.md']}),
    nowMs: 5000
  })).reason, 'WORK_ALREADY_COMPLETED');

  // When all 250 entries are non-terminal ('requeued'), QUEUE_CAPACITY_EXCEEDED is returned!
  const nonTerminalEntries = fullEntries.map(item => ({...item, status: 'requeued'}));
  const nonTerminalFullStore = createInMemoryWorkQueueRefStore({
    schemaVersion: 1,
    protocol: 'v3',
    sequence: 250,
    nextGeneration: 251,
    entries: nonTerminalEntries,
    recoveryReceipts: []
  });
  assert.equal((await claimWorkQueueLease({
    refStore: nonTerminalFullStore,
    config,
    candidate: makeIssueCandidate({issueNumber: 999, lane: 'docs', ownedPaths: ['docs/NEW.md']}),
    nowMs: 5000
  })).reason, 'QUEUE_CAPACITY_EXCEEDED');
});
