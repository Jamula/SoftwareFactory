import {createHash, createHmac} from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Worker} from 'node:worker_threads';
import {createInMemoryWorkQueueRefStore} from '../../tools/engineering-coordinator/work-queue-cas.mjs';
import {
  MAX_CROSS_RUN_LEASE_TTL_MS,
  PROTECTED_WORK_QUEUE_REF,
  SUPPORTED_CLOUD_HARNESSES,
  SUPPORTED_QUEUE_PROTOCOLS,
  ZERO_GIT_OID,
  computeReservationHeadLock,
  computeWorkQueueStateOid,
  openShadowDispatchLedger,
  reconcileLedgerWithWorkQueueCas,
  verifySignedLedgerSnapshot
} from '../../tools/engineering-factory/shadow-dispatch-ledger.mjs';

const head = 'a'.repeat(40);
const now = 1000;
const plan = {window: 'synthetic-window', maxActive: 2, includedUnits: 6, unitsPerRun: 2,
  repositories: [{repositoryId: 1, maxActive: 1}, {repositoryId: 2, maxActive: 2}]};
const candidate = (repositoryId = 1, issue = 12) => ({repositoryId, approvedRepositoryId: repositoryId, issue,
  head, generation: 1, approved: true, stop: false, includedOnly: true, overageDisabled: true,
  capacity: 10, leaseVerified: true, alreadyDispatched: false, leaseUntil: 2000, observedMs: now});
const quota = (repositoryId = 1) => ({window: plan.window, repositoryId, remaining: 6, active: 0,
  repoActive: 0, observedMs: now, includedOnly: true, overageDisabled: true, authorityVerified: true});
const terminal = (ticket, state = 'completed') => ({...ticket, state, shadow: true});
const root = 'softwarefactory-shadow-dispatch-';

test('bounds repo and global slots and settles only the exact in-flight reservation across restarts', () => {
  const dir = mkdtempSync(join(tmpdir(), root));
  const path = join(dir, 'ledger.sqlite');
  let ledger = openShadowDispatchLedger(path, plan);
  const fixture = candidate();
  try {
    const first = ledger.reserve(fixture, quota(), now);
    assert.equal(first.reason, 'SHADOW_RESERVED');
    assert.equal(first.liveDispatch, false);
    assert.deepEqual(first.ticket, {repositoryId: 1, issue: 12, head, generation: 1});
    assert.equal(Object.isFrozen(first.ticket), true);
    assert.equal(ledger.reserve(candidate(1, 13), quota(), now).reason, 'REPO_CAPACITY_EXHAUSTED');
    const other = ledger.reserve(candidate(2, 12), quota(2), now);
    assert.equal(other.reason, 'SHADOW_RESERVED');
    assert.equal(ledger.reserve(candidate(2, 13), quota(2), now).reason, 'CAPACITY_EXHAUSTED');
    assert.equal(ledger.reconcile(first.ticket, terminal(first.ticket), now).reason, 'RESERVATION_UNAVAILABLE');
    assert.equal(ledger.begin(first.ticket, fixture, now).reason, 'SHADOW_SIMULATION_RECORDED');
    assert.equal(ledger.begin(first.ticket, fixture, now).reason, 'RESERVATION_UNAVAILABLE');
    assert.equal(ledger.cancel(first.ticket).reason, 'RESERVATION_UNAVAILABLE');
    ledger.close();
    ledger = openShadowDispatchLedger(path, {...plan, repositories: [...plan.repositories].reverse()});
    assert.equal(ledger.reserve(candidate(1, 13), quota(), now).reason, 'CAPACITY_EXHAUSTED');
    for (const change of [{generation: 2}, {head: 'b'.repeat(40)}, {repositoryId: 2},
      {state: 'pending'}, {shadow: false}]) {
      assert.equal(ledger.reconcile(first.ticket, {...terminal(first.ticket), ...change}, now).reason,
        'TERMINAL_RECEIPT_UNKNOWN');
    }
    assert.equal(ledger.reconcile(first.ticket, first.ticket, now).reason, 'TERMINAL_RECEIPT_UNKNOWN');
    assert.equal(ledger.reconcile(first.ticket, terminal(first.ticket)).reason, 'TERMINAL_RECEIPT_UNKNOWN');
    assert.equal(ledger.reconcile(first.ticket, terminal(first.ticket), now).reason, 'SHADOW_SETTLED');
    assert.equal(ledger.reconcile(first.ticket, terminal(first.ticket), now).reason, 'RESERVATION_UNAVAILABLE');
    assert.equal(ledger.reserve({...fixture, generation: 2}, quota(), now).reason, 'DUPLICATE_OR_ACTIVE');
    assert.equal(ledger.cancel(other.ticket).reason, 'SHADOW_CANCELLED_BEFORE_SIMULATION');
    assert.equal(ledger.cancel(other.ticket).reason, 'RESERVATION_UNAVAILABLE');
    const last = ledger.reserve(candidate(2, 13), quota(2), now);
    assert.equal(last.reason, 'SHADOW_RESERVED');
    assert.equal(ledger.begin(last.ticket, candidate(2, 13), now).reason, 'SHADOW_SIMULATION_RECORDED');
    assert.equal(ledger.reconcile(last.ticket, terminal(last.ticket, 'cancelled'), now).reason, 'SHADOW_SETTLED');
    assert.equal(ledger.reserve(candidate(2, 14), quota(2), now).reason, 'SHADOW_RESERVED');
    assert.equal(ledger.reserve(candidate(1, 15), quota(), now).reason, 'CAPACITY_EXHAUSTED');
    assert.throws(() => openShadowDispatchLedger(path, {...plan, window: 'different'}),
      /SHADOW_DISPATCH_PLAN_CHANGED/);
  } finally {
    ledger.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('rechecks stop, identity, lease and freshness before recording a dry-run start', () => {
  const ledger = openShadowDispatchLedger(':memory:', plan);
  try {
    const c = candidate();
    const ticket = ledger.reserve(c, quota(), now).ticket;
    for (const input of [null, {...ticket, repositoryId: 0}, {...ticket, issue: 0}, {...ticket, head: null},
      {...ticket, head: 'bad'}, {...ticket, generation: 0}]) {
      assert.equal(ledger.begin(input, c, now).reason, 'SCOPE_OR_LEASE_UNKNOWN');
      assert.equal(ledger.cancel(input).reason, 'SCOPE_OR_LEASE_UNKNOWN');
      assert.equal(ledger.reconcile(input, terminal(ticket), now).reason, 'TERMINAL_RECEIPT_UNKNOWN');
    }
    for (const change of [{generation: 2}, {leaseUntil: null}, {leaseUntil: now}]) {
      assert.equal(ledger.begin(ticket, {...c, ...change}, now).reason, 'SCOPE_OR_LEASE_UNKNOWN');
    }
    assert.equal(ledger.begin(ticket, null, now).reason, 'SCOPE_OR_LEASE_UNKNOWN');
    assert.equal(ledger.begin(ticket, c, -1).reason, 'SCOPE_OR_LEASE_UNKNOWN');
    for (const observedMs of [null, now + 1]) {
      assert.equal(ledger.begin(ticket, {...c, observedMs}, now).reason, 'STALE_LEASE_EVIDENCE');
    }
    assert.equal(ledger.begin(ticket, {...c, leaseUntil: 7000}, 6001).reason, 'STALE_LEASE_EVIDENCE');
    assert.equal(ledger.begin(ticket, {...c, stop: true}, now).reason, 'STOPPED');
    assert.equal(ledger.begin(ticket, {...c, leaseVerified: false}, now).reason, 'SCOPE_OR_LEASE_UNKNOWN');
    assert.equal(ledger.begin(ticket, {...c, observedMs: 2000, leaseUntil: 3000}, 2000).reason, 'RESERVATION_UNAVAILABLE');
    assert.equal(ledger.cancel(ticket).reason, 'SHADOW_CANCELLED_BEFORE_SIMULATION');
    assert.equal(ledger.reserve({...c, generation: 2}, quota(), now).reason, 'DUPLICATE_OR_ACTIVE');
    const other = candidate(2);
    const held = ledger.reserve(other, quota(2), now).ticket;
    assert.equal(ledger.reserve({...other, head: 'c'.repeat(40)}, quota(2), now).reason, 'DUPLICATE_OR_ACTIVE');
    assert.equal(ledger.begin(held, {...other, observedMs: now - 1}, now - 1).reason, 'RESERVATION_UNAVAILABLE');
    assert.equal(ledger.begin(held, other, now).reason, 'SHADOW_SIMULATION_RECORDED');
  } finally { ledger.close(); }
});

test('fails closed on malformed evidence, included quota and per-repository active limits', () => {
  const ledger = openShadowDispatchLedger(':memory:', plan);
  try {
    const c = candidate();
    for (const invalid of [null, [], {...c, leaseUntil: Infinity}, {...c, leaseUntil: now}]) {
      assert.equal(ledger.reserve(invalid, quota(), now).reason, 'SCOPE_OR_LEASE_UNKNOWN');
    }
    assert.equal(ledger.reserve(c, quota(), NaN).reason, 'SCOPE_OR_LEASE_UNKNOWN');
    assert.equal(ledger.reserve({...c, stop: true}, quota(), now).reason, 'STOPPED');
    assert.equal(ledger.reserve({...c, alreadyDispatched: true}, quota(), now).reason, 'DUPLICATE_OR_UNKNOWN');
    assert.equal(ledger.reserve(candidate(9), quota(9), now).reason, 'BUDGET_UNKNOWN');
    for (const invalid of [null, {...quota(), window: 'other'}, quota(2), {...quota(), remaining: 7},
      {...quota(), active: 251}, {...quota(), repoActive: 1}]) {
      assert.equal(ledger.reserve(c, invalid, now).reason, 'BUDGET_UNKNOWN');
    }
    for (const field of ['includedOnly', 'overageDisabled', 'authorityVerified']) {
      assert.equal(ledger.reserve(c, {...quota(), [field]: false}, now).reason, 'BUDGET_UNKNOWN');
    }
    assert.equal(ledger.reserve(c, {...quota(), observedMs: 0}, 60001).reason, 'SCOPE_OR_LEASE_UNKNOWN');
    assert.equal(ledger.reserve({...c, leaseUntil: 80000}, {...quota(), observedMs: 0}, 60001).reason, 'STALE_QUOTA');
    assert.equal(ledger.reserve(c, {...quota(), remaining: 1}, now).reason, 'CAPACITY_EXHAUSTED');
    assert.equal(ledger.reserve(c, {...quota(), active: 1, repoActive: 1}, now).reason, 'REPO_CAPACITY_EXHAUSTED');
    assert.equal(ledger.reserve(c, {...quota(), active: 2}, now).reason, 'CAPACITY_EXHAUSTED');
    let calls = 0;
    const poison = () => { calls++; throw Error('unexpected'); };
    const getter = {...quota()};
    Object.defineProperty(getter, 'observedMs', {get: poison});
    assert.equal(ledger.reserve(c, getter, now).reason, 'BUDGET_UNKNOWN');
    assert.equal(ledger.reserve(c, {...quota(), observedMs: {valueOf: poison}}, now).reason, 'STALE_QUOTA');
    assert.equal(ledger.reserve(new Proxy(c, {get: poison}), quota(), now).reason, 'SCOPE_OR_LEASE_UNKNOWN');
    assert.equal(calls, 0);
  } finally { ledger.close(); }
});

test('verifies bounded fixed fixture plan before any reservation', () => {
  const duplicate = [...plan.repositories, plan.repositories[0]];
  for (const change of [null, {...plan, window: 13}, {...plan, window: 'not a window'},
    {...plan, maxActive: 0}, {...plan, maxActive: 251},
    {...plan, includedUnits: 0}, {...plan, includedUnits: 10000001},
    {...plan, unitsPerRun: 0}, {...plan, unitsPerRun: 7},
    ...[null, [], new Array(1), Array(251).fill(plan.repositories[0]), Number(1),
      Object.setPrototypeOf([...plan.repositories], Object.create(Array.prototype)),
      new Proxy(plan.repositories, {}), Object.assign([...plan.repositories], {extra: 1}),
      [{maxActive: 1}], [{repositoryId: 0, maxActive: 1}], [{repositoryId: 1, maxActive: 0}],
      [{repositoryId: 1, maxActive: 3}], duplicate].map(repositories => ({...plan, repositories}))
  ]) assert.throws(() => openShadowDispatchLedger(':memory:', change), /INVALID_SHADOW_DISPATCH_PLAN/);
    const getterPlan = {...plan};
    Object.defineProperty(getterPlan, 'maxExecutionMs', {get() { return 5000; }});
    for (const invalidExec of [0, -1, 3600001, null]) {
      assert.throws(() => openShadowDispatchLedger(':memory:', {...plan, maxExecutionMs: invalidExec}),
        /INVALID_SHADOW_DISPATCH_PLAN/);
    }
    assert.throws(() => openShadowDispatchLedger(':memory:', getterPlan), /INVALID_SHADOW_DISPATCH_PLAN/);
});

test('bounds stored reservations and fails closed on locked, broken, and closed storage', () => {
  const dir = mkdtempSync(join(tmpdir(), root));
  const path = join(dir, 'ledger.sqlite');
  const ledger = openShadowDispatchLedger(path, plan);
  const db = new DatabaseSync(path);
  const c = candidate();
  try {
    db.exec('BEGIN IMMEDIATE');
    assert.equal(ledger.reserve(c, quota(), now).reason, 'STORE_UNAVAILABLE');
    db.exec('ROLLBACK');
    db.exec("CREATE TRIGGER stop_insert BEFORE INSERT ON shadow_dispatch_reservations BEGIN SELECT RAISE(ABORT, 'test'); END");
    assert.equal(ledger.reserve(c, quota(), now).reason, 'STORE_UNAVAILABLE');
    db.exec('DROP TRIGGER stop_insert');
    const ticket = ledger.reserve(c, quota(), now).ticket;
    assert.equal(ledger.cancel(ticket).reason, 'SHADOW_CANCELLED_BEFORE_SIMULATION');
    db.exec(`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM ids WHERE n < 9999)
      INSERT INTO shadow_dispatch_reservations
      SELECT 2, n, 'b', 1, 1, 'cancelled', 1000, 1000 FROM ids;`);
    assert.equal(ledger.reserve(candidate(1, 13), quota(), now).reason, 'STORE_FULL');
    ledger.close();
    assert.equal(ledger.reserve(c, quota(), now).reason, 'STORE_UNAVAILABLE');
    assert.equal(ledger.begin(ticket, c, now).reason, 'STORE_UNAVAILABLE');
    assert.equal(ledger.expire(now).reason, 'STORE_UNAVAILABLE');
    assert.equal(ledger.cancel(ticket).reason, 'STORE_UNAVAILABLE');
    assert.equal(ledger.reconcile(ticket, terminal(ticket), now).reason, 'STORE_UNAVAILABLE');
    assert.equal(ledger.exportSnapshot({signingKey: 'synthetic-key-012345', now}).reason, 'STORE_UNAVAILABLE');
    assert.equal(ledger.importSnapshot({
      version: 1,
      window: plan.window,
      planSignature: JSON.stringify([plan.window, plan.maxActive, plan.includedUnits, plan.unitsPerRun, 900000,
        [[1, 1], [2, 2]]]),
      sequence: 1,
      exportedAt: now,
      reservations: [],
      digest: createHash('sha256').update(JSON.stringify([1, JSON.stringify([plan.window, plan.maxActive,
        plan.includedUnits, plan.unitsPerRun, 900000, [[1, 1], [2, 2]]]), 1, now, []])).digest('hex'),
      hmac: createHmac('sha256', 'synthetic-key-012345').update(JSON.stringify([1, JSON.stringify([plan.window,
        plan.maxActive, plan.includedUnits, plan.unitsPerRun, 900000, [[1, 1], [2, 2]]]), 1, now, []])).digest('hex')
    }, {signingKey: 'synthetic-key-012345', now}).reason, 'STORE_UNAVAILABLE');
  } finally {
    db.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('reclaims expired reserved and hung in-flight workers deterministically under bounded execution deadlines', () => {
  const boundedPlan = {...plan, includedUnits: 8, maxExecutionMs: 500};
  const ledger = openShadowDispatchLedger(':memory:', boundedPlan);
  const receipt = {
    receiptId: 'hsr-ledger-1',
    provider: 'github-hosted-copilot',
    includedOnly: true,
    overageDisabled: true,
    hardStopEnforced: true,
    paidUsageMicros: 0,
    observedMs: now
  };
  try {
    for (const badNow of [-1, null, NaN]) {
      assert.equal(ledger.expire(badNow).reason, 'INVALID_TIME');
    }
    assert.deepEqual(ledger.expire(now), {
      shadow: true,
      liveDispatch: false,
      reason: 'NO_EXPIRED_RESERVATIONS',
      expiredReserved: 0,
      expiredInFlight: 0,
      reclaimed: 0
    });
    // Optional quota hard-stop receipt and environment checks pass through fail-closed.
    const c1 = candidate(1, 10);
    const q1 = {...quota(1), remaining: 8};
    const getterQuota = {...q1};
    Object.defineProperty(getterQuota, 'hardStopReceipt', {get() { throw Error('unexpected'); }});
    assert.equal(ledger.reserve(c1, getterQuota, now).reason, 'BUDGET_UNKNOWN');
    const getterEnvQuota = {...q1};
    Object.defineProperty(getterEnvQuota, 'environmentVerified', {get() { throw Error('unexpected'); }});
    assert.equal(ledger.reserve(c1, getterEnvQuota, now).reason, 'BUDGET_UNKNOWN');
    assert.equal(ledger.reserve(c1, {...q1, environmentVerified: false}, now).reason, 'ENVIRONMENT_UNVERIFIED');
    assert.equal(ledger.reserve(c1, {...q1, hardStopReceipt: {...receipt, overageDisabled: false}}, now).reason,
      'OVERAGE_ENABLED');

    // 1. Reserve c1 (valid_through = 1999) and never call begin; expire at 2000 returns slot + unstarted units.
    const r1 = ledger.reserve(c1, {...q1, environmentVerified: true, hardStopReceipt: receipt}, now);
    assert.equal(r1.reason, 'SHADOW_RESERVED');
    assert.equal(ledger.expire(1999).reason, 'NO_EXPIRED_RESERVATIONS');
    assert.deepEqual(ledger.expire(2000), {
      shadow: true,
      liveDispatch: false,
      reason: 'SHADOW_EXPIRED_RECLAIMED',
      expiredReserved: 1,
      expiredInFlight: 0,
      reclaimed: 1
    });
    // Exact candidate stays fenced, while a new head on the same issue can reserve and reuse the returned units.
    assert.equal(ledger.reserve({...c1, leaseUntil: 9000}, {...q1, observedMs: 2000}, 2000).reason,
      'DUPLICATE_OR_ACTIVE');
    const c1NextHead = {...c1, head: 'b'.repeat(40), leaseUntil: 99999999, observedMs: 2000};
    const r2 = ledger.reserve(c1NextHead, {...q1, observedMs: 2000}, 2000);
    assert.equal(r2.reason, 'SHADOW_RESERVED');

    // Validate executionTtlMs bounds and authoritative hardStopReceipt clock in begin.
    const getterCurrent = {...c1NextHead};
    Object.defineProperty(getterCurrent, 'executionTtlMs', {get() { return 100; }});
    assert.equal(ledger.begin(r2.ticket, getterCurrent, 2000).reason, 'EXECUTION_DEADLINE_INVALID');
    for (const badTtl of [0, -1, 501, null]) {
      assert.equal(ledger.begin(r2.ticket, {...c1NextHead, executionTtlMs: badTtl}, 2000).reason,
        'EXECUTION_DEADLINE_INVALID');
    }
    // Stale hardStopReceipt or mismatched nowMs on candidate/current is rejected against authoritative ledger now.
    assert.equal(ledger.reserve({...candidate(2, 77), leaseUntil: 80000, hardStopReceipt: receipt, nowMs: now},
      {...quota(2), remaining: 8, observedMs: 70000}, 70000).reason, 'STALE_HARD_STOP_RECEIPT');
    assert.equal(ledger.begin(r2.ticket, {...c1NextHead, hardStopReceipt: receipt, nowMs: now}, 2000).reason,
      'STALE_HARD_STOP_RECEIPT');

    // Even with huge leaseUntil, begin enforces plan.maxExecutionMs (500ms -> deadline 2500) or smaller executionTtlMs.
    const started = ledger.begin(r2.ticket, {...c1NextHead, executionTtlMs: 300}, 2000);
    assert.deepEqual(started, {
      shadow: true,
      liveDispatch: false,
      reason: 'SHADOW_SIMULATION_RECORDED',
      executionDeadline: 2300
    });
    // Repo 1 maxActive=1 is occupied while in-flight before deadline.
    assert.equal(ledger.reserve({...candidate(1, 11), leaseUntil: 9000}, {...q1, observedMs: 2300}, 2300).reason,
      'REPO_CAPACITY_EXHAUSTED');
    // Reconcile requires authoritative now >= reserved_at (omitting now fails closed even when overdue), and past deadline marks expired.
    assert.equal(ledger.reconcile(r2.ticket, terminal(r2.ticket)).reason, 'TERMINAL_RECEIPT_UNKNOWN');
    assert.equal(ledger.reconcile(r2.ticket, terminal(r2.ticket), -1).reason, 'TERMINAL_RECEIPT_UNKNOWN');
    assert.equal(ledger.reconcile(r2.ticket, terminal(r2.ticket), 1999).reason, 'TERMINAL_RECEIPT_UNKNOWN');
    const missingTicket = {...r2.ticket, generation: 99};
    assert.equal(ledger.reconcile(missingTicket, terminal(missingTicket), 2000).reason, 'RESERVATION_UNAVAILABLE');
    assert.equal(ledger.reconcile(r2.ticket, terminal(r2.ticket), 2301).reason, 'EXECUTION_DEADLINE_EXCEEDED');
    assert.equal(ledger.reconcile(r2.ticket, terminal(r2.ticket), 2302).reason, 'EXECUTION_DEADLINE_EXCEEDED');

    // Slot is now free, and inline expiry during reserve also reclaims hung runs using plan.maxExecutionMs.
    const c3 = {...candidate(1, 11), leaseUntil: 99999999, observedMs: 2400};
    const r3 = ledger.reserve(c3, {...q1, observedMs: 2400}, 2400);
    assert.equal(r3.reason, 'SHADOW_RESERVED');
    const started3 = ledger.begin(r3.ticket, c3, 2400);
    assert.equal(started3.executionDeadline, 2900);
    // At 2901, inline reclamation during reserve frees repo 1 slot; spent units from r2 (2) + r3 (2) = 4 are retained!
    const c4 = {...candidate(1, 14), leaseUntil: 9000, observedMs: 2901};
    assert.equal(ledger.reserve(c4, {...q1, remaining: 4, observedMs: 2901}, 2901).reason, 'CAPACITY_EXHAUSTED');
    const r4 = ledger.reserve(c4, {...q1, remaining: 6, observedMs: 2901}, 2901);
    assert.equal(r4.reason, 'SHADOW_RESERVED');
    assert.equal(ledger.begin(r4.ticket, c4, 2901).reason, 'SHADOW_SIMULATION_RECORDED');
    assert.equal(ledger.reconcile(r4.ticket, terminal(r4.ticket), 3000).reason, 'SHADOW_SETTLED');

    // Explicit expire(now) also reclaims hung in-flight runs directly.
    const c5 = {...candidate(2, 20), leaseUntil: 99999999, observedMs: 3000};
    const r5 = ledger.reserve(c5, {...quota(2), remaining: 8, observedMs: 3000}, 3000);
    assert.equal(ledger.begin(r5.ticket, c5, 3000).executionDeadline, 3500);
    assert.deepEqual(ledger.expire(3501), {
      shadow: true,
      liveDispatch: false,
      reason: 'SHADOW_EXPIRED_RECLAIMED',
      expiredReserved: 0,
      expiredInFlight: 1,
      reclaimed: 1
    });
  } finally {
    ledger.close();
  }
});

test('exports and restores integrity/signature-fenced snapshots across stateless runners and rejects tampering or regression', () => {
  const signingKey = 'stateless-runner-hmac-key-0001';
  const runnerPlan = {...plan, includedUnits: 10, maxActive: 3};
  const runnerA = openShadowDispatchLedger(':memory:', runnerPlan);
  const runnerB = openShadowDispatchLedger(':memory:', runnerPlan);
  const wrongPlanLedger = openShadowDispatchLedger(':memory:', {...runnerPlan, maxExecutionMs: 60000});
  const sign = (pSig, seq, expAt, rows, key = signingKey) => {
    const canonical = JSON.stringify([1, pSig, seq, expAt, rows]);
    return {
      digest: createHash('sha256').update(canonical).digest('hex'),
      hmac: createHmac('sha256', key).update(canonical).digest('hex')
    };
  };
  try {
    const q = (repoId = 1) => ({...quota(repoId), remaining: 10, observedMs: now});
    // Populate Runner A with cancelled, settled, and reserved entries across repos/issues/heads.
    const tCancelled = runnerA.reserve({...candidate(1, 10), head: '1'.repeat(40)}, q(1), now).ticket;
    assert.equal(runnerA.cancel(tCancelled).reason, 'SHADOW_CANCELLED_BEFORE_SIMULATION');
    const cSettled = {...candidate(1, 10), head: '2'.repeat(40)};
    const tSettled = runnerA.reserve(cSettled, q(1), now).ticket;
    assert.equal(runnerA.begin(tSettled, cSettled, now).reason, 'SHADOW_SIMULATION_RECORDED');
    assert.equal(runnerA.reconcile(tSettled, terminal(tSettled), now).reason, 'SHADOW_SETTLED');
    const tReserved = runnerA.reserve(candidate(1, 11), q(1), now).ticket;
    const cInFlight = candidate(2, 5);
    const tInFlight = runnerA.reserve(cInFlight, q(2), now).ticket;
    assert.equal(runnerA.begin(tInFlight, cInFlight, now).reason, 'SHADOW_SIMULATION_RECORDED');

    for (const badOpts of [null, {}, {signingKey: 'short', now}, {signingKey, now: -1}]) {
      assert.equal(runnerA.exportSnapshot(badOpts).reason, 'SNAPSHOT_KEY_OR_TIME_INVALID');
      assert.equal(runnerB.importSnapshot({}, badOpts).reason, 'SNAPSHOT_KEY_OR_TIME_INVALID');
    }

    const exported1 = runnerA.exportSnapshot({signingKey, now: 1200});
    assert.equal(exported1.reason, 'SHADOW_SNAPSHOT_EXPORTED');
    assert.equal(exported1.liveDispatch, false);
    assert.equal(exported1.snapshot.sequence, 1);
    assert.equal(exported1.snapshot.reservations.length, 4);
    assert.equal(Object.isFrozen(exported1.snapshot), true);

    // Plan mismatch and wrong signing key or tampered payload fail closed.
    assert.equal(wrongPlanLedger.importSnapshot(exported1.snapshot, {signingKey, now: 1200}).reason,
      'PLAN_SIGNATURE_MISMATCH');
    assert.equal(runnerB.importSnapshot(exported1.snapshot,
      {signingKey: 'wrong-signing-key-00000001', now: 1200}).reason, 'SNAPSHOT_SIGNATURE_INVALID');
    assert.equal(runnerB.importSnapshot({...exported1.snapshot, digest: '0'.repeat(64)},
      {signingKey, now: 1200}).reason, 'SNAPSHOT_SIGNATURE_INVALID');

    // Structural and invariant validation on importSnapshot.
    const pSig = exported1.snapshot.planSignature;
    const baseRow = exported1.snapshot.reservations[2];
    const forgedCases = [
      null,
      {...exported1.snapshot, extra: true},
      {...exported1.snapshot, version: 2},
      {...exported1.snapshot, exportedAt: 1201},
      {...exported1.snapshot, sequence: 0},
      {...exported1.snapshot, reservations: new Proxy([], {})},
      {...exported1.snapshot, reservations: Object.assign(new Array(1), {extra: 1})},
      {...exported1.snapshot, reservations: [{...baseRow, extra: true}]},
      {...exported1.snapshot, digest: 'bad'},
      {...exported1.snapshot, hmac: 'bad'},
      // Unsorted rows (across repos and within same repo+issue) and duplicate rows
      (() => {
        const rows = [...exported1.snapshot.reservations].reverse();
        return {...exported1.snapshot, reservations: rows, ...sign(pSig, 1, 1200, rows)};
      })(),
      (() => {
        const rows = [exported1.snapshot.reservations[1], exported1.snapshot.reservations[0]];
        return {...exported1.snapshot, reservations: rows, ...sign(pSig, 1, 1200, rows)};
      })(),
      (() => {
        const rows = [baseRow, baseRow];
        return {...exported1.snapshot, reservations: rows, ...sign(pSig, 1, 1200, rows)};
      })(),
      // Same repo + issue with two active rows
      (() => {
        const rows = [baseRow, {...baseRow, head: 'f'.repeat(40)}];
        return {...exported1.snapshot, reservations: rows, ...sign(pSig, 1, 1200, rows)};
      })(),
      // Exceeds per-repo active cap (repo 1 cap is 1)
      (() => {
        const rows = [baseRow, {...baseRow, issue: 99}];
        return {...exported1.snapshot, reservations: rows, ...sign(pSig, 1, 1200, rows)};
      })(),
      // Signed undercharged or overcharged row (units !== plan.unitsPerRun) is rejected
      (() => {
        const rows = [{...baseRow, units: 1}];
        return {...exported1.snapshot, reservations: rows, ...sign(pSig, 1, 1200, rows)};
      })(),
      (() => {
        const rows = [{...baseRow, units: 4}];
        return {...exported1.snapshot, reservations: rows, ...sign(pSig, 1, 1200, rows)};
      })(),
      // Exceeds includedUnits (10) while matching unitsPerRun (2 * 6 = 12 > 10)
      (() => {
        const rows = Array.from({length: 6}, (_, idx) => ({...baseRow, issue: 50 + idx, phase: 'settled'}));
        return {...exported1.snapshot, reservations: rows, ...sign(pSig, 1, 1200, rows)};
      })(),
      // Bad row field (validThrough < reservedAt), future reservedAt, and oversized reserved/in-flight deadlines
      (() => {
        const rows = [{...baseRow, validThrough: 500, reservedAt: 1000}];
        return {...exported1.snapshot, reservations: rows, ...sign(pSig, 1, 1200, rows)};
      })(),
      (() => {
        const rows = [{...baseRow, reservedAt: 1201, validThrough: 1300}];
        return {...exported1.snapshot, reservations: rows, ...sign(pSig, 1, 1200, rows)};
      })(),
      (() => {
        const rows = [{...baseRow, phase: 'reserved', reservedAt: 1000, validThrough: 61001}];
        return {...exported1.snapshot, reservations: rows, ...sign(pSig, 1, 1200, rows)};
      })(),
      (() => {
        const rows = [{...baseRow, phase: 'in-flight', reservedAt: 1000, validThrough: 1200 + 900001}];
        return {...exported1.snapshot, reservations: rows, ...sign(pSig, 1, 1200, rows)};
      })()
    ];
    for (const badSnap of forgedCases) {
      assert.equal(runnerB.importSnapshot(badSnap, {signingKey, now: 1200}).reason, 'INVALID_SNAPSHOT');
    }
    const lateExportRows = [{...baseRow, phase: 'in-flight', reservedAt: 1000, validThrough: 61000 + 900001}];
    assert.equal(runnerB.importSnapshot({
      ...exported1.snapshot,
      exportedAt: 100000,
      reservations: lateExportRows,
      ...sign(pSig, 1, 100000, lateExportRows)
    }, {signingKey, now: 100000}).reason, 'INVALID_SNAPSHOT');

    // Regression: signed undercharged row with units: 1 under unitsPerRun: 4 is rejected.
    const fourUnitPlan = {...runnerPlan, includedUnits: 12, unitsPerRun: 4};
    const fourUnitLedger = openShadowDispatchLedger(':memory:', fourUnitPlan);
    try {
      const fourUnitSig = fourUnitLedger.exportSnapshot({signingKey, now: 1000}).snapshot.planSignature;
      const underchargedRows = [{...baseRow, units: 1, reservedAt: 1000, validThrough: 1999}];
      assert.equal(fourUnitLedger.importSnapshot({
        version: 1,
        window: fourUnitPlan.window,
        planSignature: fourUnitSig,
        sequence: 2,
        exportedAt: 1000,
        reservations: underchargedRows,
        ...sign(fourUnitSig, 2, 1000, underchargedRows)
      }, {signingKey, now: 1000}).reason, 'INVALID_SNAPSHOT');
    } finally {
      fourUnitLedger.close();
    }

    // Regression: maxExecutionMs: 500, exportedAt: 1000, signed in-flight row with validThrough: MAX_SAFE_INTEGER fails closed,
    // and near-MAX_SAFE_INTEGER timestamps remain overflow-safe.
    const shortExecPlan = {...runnerPlan, maxExecutionMs: 500};
    const shortExecLedger = openShadowDispatchLedger(':memory:', shortExecPlan);
    try {
      const shortSig = shortExecLedger.exportSnapshot({signingKey, now: 1000}).snapshot.planSignature;
      for (const badValidThrough of [Number.MAX_SAFE_INTEGER, 1501]) {
        const overlongRows = [{...baseRow, phase: 'in-flight', reservedAt: 1000, validThrough: badValidThrough}];
        assert.equal(shortExecLedger.importSnapshot({
          version: 1,
          window: shortExecPlan.window,
          planSignature: shortSig,
          sequence: 2,
          exportedAt: 1000,
          reservations: overlongRows,
          ...sign(shortSig, 2, 1000, overlongRows)
        }, {signingKey, now: 1000}).reason, 'INVALID_SNAPSHOT');
      }
      const nearMaxReserved = Number.MAX_SAFE_INTEGER - 10;
      const nearMaxExported = Number.MAX_SAFE_INTEGER - 5;
      const nearMaxRows = [{
        ...baseRow,
        phase: 'in-flight',
        reservedAt: nearMaxReserved,
        validThrough: Number.MAX_SAFE_INTEGER
      }];
      assert.equal(shortExecLedger.importSnapshot({
        version: 1,
        window: shortExecPlan.window,
        planSignature: shortSig,
        sequence: 2,
        exportedAt: nearMaxExported,
        reservations: nearMaxRows,
        ...sign(shortSig, 2, nearMaxExported, nearMaxRows)
      }, {signingKey, now: Number.MAX_SAFE_INTEGER}).reason, 'SHADOW_SNAPSHOT_IMPORTED');
    } finally {
      shortExecLedger.close();
    }

    // Regression: local reserved row (valid_through=1999) under maxExecutionMs=500 rejects execution deadline > 2499
    // and rejects cancelled transition with mutated validThrough.
    const localBoundLedger = openShadowDispatchLedger(':memory:', shortExecPlan);
    try {
      assert.equal(localBoundLedger.reserve(candidate(1, 10), q(1), now).reason, 'SHADOW_RESERVED');
      const localSnap = localBoundLedger.exportSnapshot({signingKey, now}).snapshot;
      const localSig = localSnap.planSignature;
      const localRow = localSnap.reservations[0];
      for (const badRow of [
        {...localRow, phase: 'in-flight', validThrough: 61500},
        {...localRow, phase: 'in-flight', validThrough: 2500},
        {...localRow, phase: 'cancelled', validThrough: 1998}
      ]) {
        const rows = [badRow];
        assert.equal(localBoundLedger.importSnapshot({
          version: 1,
          window: shortExecPlan.window,
          planSignature: localSig,
          sequence: 2,
          exportedAt: 61000,
          reservations: rows,
          ...sign(localSig, 2, 61000, rows)
        }, {signingKey, now: 61000}).reason, 'SNAPSHOT_STATE_REGRESSION');
      }
      const okRows = [{...localRow, phase: 'in-flight', validThrough: 2499}];
      assert.equal(localBoundLedger.importSnapshot({
        version: 1,
        window: shortExecPlan.window,
        planSignature: localSig,
        sequence: 2,
        exportedAt: 61000,
        reservations: okRows,
        ...sign(localSig, 2, 61000, okRows)
      }, {signingKey, now: 61000}).reason, 'SHADOW_SNAPSHOT_IMPORTED');
    } finally {
      localBoundLedger.close();
    }

    // Restore onto stateless Runner B and verify active slots, units, and duplicate fencing carry over.
    const imported1 = runnerB.importSnapshot(exported1.snapshot, {signingKey, now: 1200});
    assert.deepEqual(imported1, {
      shadow: true,
      liveDispatch: false,
      reason: 'SHADOW_SNAPSHOT_IMPORTED',
      sequence: 1,
      restored: 4
    });
    // Replay of sequence 1 is rejected.
    assert.equal(runnerB.importSnapshot(exported1.snapshot, {signingKey, now: 1200}).reason,
      'STALE_SNAPSHOT_SEQUENCE');
    // Repo 1 active slot is still held by tReserved; tSettled remains fenced against duplicate attempts.
    assert.equal(runnerB.reserve(candidate(1, 12), q(1), 1200).reason, 'REPO_CAPACITY_EXHAUSTED');
    assert.equal(runnerB.cancel(tReserved).reason, 'SHADOW_CANCELLED_BEFORE_SIMULATION');
    assert.equal(runnerB.reserve({...cSettled, generation: 2, leaseUntil: 3000}, {...q(1), observedMs: 1200}, 1200).reason,
      'DUPLICATE_OR_ACTIVE');

    // Advance state on Runner B (settle tInFlight, reserve new issue on repo 2) and export sequence 2.
    assert.equal(runnerB.reconcile(tInFlight, terminal(tInFlight), 1200).reason, 'SHADOW_SETTLED');
    const cNew = {...candidate(2, 30), leaseUntil: 3000, observedMs: 1200};
    assert.equal(runnerB.reserve(cNew, {...q(2), observedMs: 1200}, 1200).reason, 'SHADOW_RESERVED');
    const exported2 = runnerB.exportSnapshot({signingKey, now: 1300});
    assert.equal(exported2.snapshot.sequence, 2);

    // State regression checks against Runner A (sequence 1):
    // 1) Dropping an existing row
    const droppedRows = exported2.snapshot.reservations.slice(1);
    assert.equal(runnerA.importSnapshot({
      ...exported2.snapshot,
      sequence: 3,
      reservations: droppedRows,
      ...sign(pSig, 3, 1300, droppedRows)
    }, {signingKey, now: 1300}).reason, 'SNAPSHOT_STATE_REGRESSION');
    // 2) Regressing terminal settled row back to in-flight
    const regressedRows = exported2.snapshot.reservations.map(r =>
      r.head === '2'.repeat(40) ? {...r, phase: 'in-flight'} : r);
    assert.equal(runnerA.importSnapshot({
      ...exported2.snapshot,
      sequence: 3,
      reservations: regressedRows,
      ...sign(pSig, 3, 1300, regressedRows)
    }, {signingKey, now: 1300}).reason, 'SNAPSHOT_STATE_REGRESSION');
    // 3) Regressing in-flight row back to reserved
    const regressedInFlight = exported2.snapshot.reservations.map(r =>
      r.repositoryId === 2 && r.issue === 5 ? {...r, phase: 'reserved'} : r);
    assert.equal(runnerA.importSnapshot({
      ...exported2.snapshot,
      sequence: 3,
      reservations: regressedInFlight,
      ...sign(pSig, 3, 1300, regressedInFlight)
    }, {signingKey, now: 1300}).reason, 'SNAPSHOT_STATE_REGRESSION');
    // 4) Mutating validThrough without changing phase
    const mutatedValid = exported2.snapshot.reservations.map(r =>
      r.head === '1'.repeat(40) ? {...r, validThrough: r.validThrough + 1} : r);
    assert.equal(runnerA.importSnapshot({
      ...exported2.snapshot,
      sequence: 3,
      reservations: mutatedValid,
      ...sign(pSig, 3, 1300, mutatedValid)
    }, {signingKey, now: 1300}).reason, 'SNAPSHOT_STATE_REGRESSION');

    // Valid monotonic forward import of sequence 2 onto Runner A succeeds!
    assert.equal(runnerA.importSnapshot(exported2.snapshot, {signingKey, now: 1300}).reason,
      'SHADOW_SNAPSHOT_IMPORTED');
  } finally {
    runnerA.close();
    runnerB.close();
    wrongPlanLedger.close();
  }
});

test('fails closed on storage lock and rollback errors during expire, reconcile, exportSnapshot, and importSnapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), root));
  const path = join(dir, 'ledger-errors.sqlite');
  const signingKey = 'error-branch-signing-key-01';
  const ledger = openShadowDispatchLedger(path, plan);
  const db = new DatabaseSync(path);
  try {
    const c = candidate(1, 12);
    const ticket = ledger.reserve(c, quota(), now).ticket;
    assert.equal(ledger.begin(ticket, c, now).reason, 'SHADOW_SIMULATION_RECORDED');
    const snap = ledger.exportSnapshot({signingKey, now}).snapshot;
    const rows2 = snap.reservations.map(r => ({...r, phase: 'settled'}));
    const canonical2 = JSON.stringify([1, snap.planSignature, 2, now, rows2]);
    const snap2 = {
      ...snap,
      sequence: 2,
      reservations: rows2,
      digest: createHash('sha256').update(canonical2).digest('hex'),
      hmac: createHmac('sha256', signingKey).update(canonical2).digest('hex')
    };

    // Locked DB triggers outer BEGIN IMMEDIATE catch on expire, reconcile, exportSnapshot, importSnapshot.
    db.exec('BEGIN IMMEDIATE');
    assert.equal(ledger.expire(now).reason, 'STORE_UNAVAILABLE');
    assert.equal(ledger.reconcile(ticket, terminal(ticket), now).reason, 'STORE_UNAVAILABLE');
    assert.equal(ledger.exportSnapshot({signingKey, now}).reason, 'STORE_UNAVAILABLE');
    assert.equal(ledger.importSnapshot(snap2, {signingKey, now}).reason, 'STORE_UNAVAILABLE');
    db.exec('ROLLBACK');

    // Triggers with RAISE(ROLLBACK) end the transaction inside SQLite so inner ROLLBACK catch is also exercised.
    db.exec("CREATE TRIGGER abort_res_update BEFORE UPDATE ON shadow_dispatch_reservations BEGIN SELECT RAISE(ROLLBACK, 'abort'); END");
    assert.equal(ledger.expire(5000).reason, 'STORE_UNAVAILABLE');
    assert.equal(ledger.reconcile(ticket, terminal(ticket), now).reason, 'STORE_UNAVAILABLE');
    assert.equal(ledger.importSnapshot(snap2, {signingKey, now}).reason, 'STORE_UNAVAILABLE');
    db.exec('DROP TRIGGER abort_res_update');

    db.exec("CREATE TRIGGER abort_seq_update BEFORE UPDATE ON shadow_dispatch_snapshot_fence BEGIN SELECT RAISE(ROLLBACK, 'abort'); END");
    assert.equal(ledger.exportSnapshot({signingKey, now}).reason, 'STORE_UNAVAILABLE');
    db.exec('DROP TRIGGER abort_seq_update');
  } finally {
    ledger.close();
    db.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('migrates pre-deadline v0 on-disk ledgers in place while preserving spent units, duplicate fences, and plan checks', () => {
  const dir = mkdtempSync(join(tmpdir(), root));
  const legacyPath = join(dir, 'legacy-v0.sqlite');
  const legacySignature = JSON.stringify([plan.window, plan.maxActive, plan.includedUnits, plan.unitsPerRun,
    [[1, 1], [2, 2]]]);
  const raw = new DatabaseSync(legacyPath);
  raw.exec(`
    CREATE TABLE shadow_dispatch_plan (
      id INTEGER PRIMARY KEY CHECK(id = 1), signature TEXT NOT NULL
    );
    CREATE TABLE shadow_dispatch_reservations (
      repository INTEGER NOT NULL, issue INTEGER NOT NULL, head TEXT NOT NULL, generation INTEGER NOT NULL,
      units INTEGER NOT NULL CHECK(units > 0),
      phase TEXT NOT NULL CHECK(phase IN ('reserved', 'in-flight', 'settled', 'cancelled')),
      valid_through INTEGER NOT NULL, reserved_at INTEGER NOT NULL CHECK(reserved_at >= 0),
      CHECK(valid_through >= reserved_at),
      PRIMARY KEY (repository, issue, head)
    );
  `);
  raw.prepare('INSERT INTO shadow_dispatch_plan VALUES (1, ?)').run(legacySignature);
  raw.prepare('INSERT INTO shadow_dispatch_reservations VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(1, 12, head, 1, 2, 'settled', 1999, 1000);
  raw.prepare('INSERT INTO shadow_dispatch_reservations VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(2, 20, 'c'.repeat(40), 1, 2, 'in-flight', 1500, 1000);
  raw.close();

  try {
    // Opening a legacy DB with a custom maxExecutionMs or changed plan still fails closed without mutating it.
    assert.throws(() => openShadowDispatchLedger(legacyPath, {...plan, maxExecutionMs: 60000}),
      /SHADOW_DISPATCH_PLAN_CHANGED/);
    assert.throws(() => openShadowDispatchLedger(legacyPath, {...plan, window: 'different'}),
      /SHADOW_DISPATCH_PLAN_CHANGED/);
    const migrated = openShadowDispatchLedger(legacyPath, {...plan, maxExecutionMs: 900000});
    try {
      // Duplicate fence on settled v0 entry is preserved before expiry.
      assert.equal(migrated.reserve(candidate(1, 12), quota(1), 1400).reason, 'DUPLICATE_OR_ACTIVE');
      // Phase constraint is upgraded so hung v0 in-flight entry (valid_through=1500) transitions to 'expired' at 1600.
      assert.deepEqual(migrated.expire(1600), {
        shadow: true,
        liveDispatch: false,
        reason: 'SHADOW_EXPIRED_RECLAIMED',
        expiredReserved: 0,
        expiredInFlight: 1,
        reclaimed: 1
      });
      // Spent units from settled (2) + expired in-flight (2) = 4 are preserved: remaining=5 (only 1 free unit) exhausts!
      assert.equal(migrated.reserve({...candidate(1, 13), leaseUntil: 4000, observedMs: 1600},
        {...quota(1), remaining: 5, observedMs: 1600}, 1600).reason, 'CAPACITY_EXHAUSTED');
      assert.equal(migrated.reserve({...candidate(1, 13), leaseUntil: 4000, observedMs: 1600},
        {...quota(1), remaining: 6, observedMs: 1600}, 1600).reason, 'SHADOW_RESERVED');
    } finally {
      migrated.close();
    }
    // Verify PRAGMA user_version was promoted to 1 and unsupported future schema versions fail closed.
    const verifyDb = new DatabaseSync(legacyPath);
    try {
      assert.equal(verifyDb.prepare('PRAGMA user_version').get().user_version, 1);
      verifyDb.exec('PRAGMA user_version = 2');
    } finally {
      verifyDb.close();
    }
    assert.throws(() => openShadowDispatchLedger(legacyPath, plan), /SHADOW_DISPATCH_SCHEMA_UNSUPPORTED/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('two workers with separate connections cannot reserve the same last slot', {timeout: 10000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), root));
  const path = join(dir, 'ledger.sqlite');
  const ledger = openShadowDispatchLedger(path, plan);
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const workers = [];
  let ready = 0;
  try {
    const moduleUrl = new URL('../../tools/engineering-factory/shadow-dispatch-ledger.mjs', import.meta.url).href;
    const results = [candidate(1), candidate(1, 13)].map(c => new Promise((resolve, reject) => {
      const worker = new Worker(`
        const {parentPort, workerData} = require('node:worker_threads');
        import(workerData.moduleUrl).then(({openShadowDispatchLedger}) => {
          const store = openShadowDispatchLedger(workerData.path, workerData.plan);
          try {
            const gate = new Int32Array(workerData.buffer);
            parentPort.postMessage({ready: true});
            Atomics.wait(gate, 0, 0, 5000);
            parentPort.postMessage({result: store.reserve(workerData.candidate, workerData.quota, workerData.now)});
          } finally { store.close(); }
        }).catch(error => { process.nextTick(() => { throw error; }); });
      `, {eval: true, workerData: {moduleUrl, path, plan, candidate: c, quota: quota(), buffer: gate.buffer, now}});
      workers.push(worker);
      worker.on('error', reject);
      worker.on('exit', code => { if (code !== 0) reject(new Error('reservation worker failed')); });
      worker.on('message', message => {
        if (message.ready) {
          if (++ready === 2) {
            Atomics.store(gate, 0, 1);
            Atomics.notify(gate, 0);
          }
        } else resolve(message.result.reason);
      });
    }));
    assert.deepEqual((await Promise.all(results)).sort(), ['REPO_CAPACITY_EXHAUSTED', 'SHADOW_RESERVED']);
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
    ledger.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

const casSigningKey = 'cross-run-cas-signing-key-0001';
const baseAdmission = () => ({
  includedOnly: true,
  overageDisabled: true,
  incrementalSpendUsdCents: 0,
  personalPatConfigured: false,
  repositoryVisibility: 'private',
  harness: 'copilot-cloud-agent',
  agentLogin: 'copilot-swe-agent[bot]',
  authorityVerified: true,
  entitlementVerified: true,
  hardStopEnforced: true,
  repositoryId: 1,
  approvedRepositoryId: 1,
  observedMs: 1000,
  remainingIncludedUnits: 6
});
const signRawSnapshot = (planSig, seq, exportedAt, rows, key = casSigningKey, win = plan.window) => {
  const canonical = JSON.stringify([1, planSig, seq, exportedAt, rows]);
  return {
    version: 1,
    window: win,
    planSignature: planSig,
    sequence: seq,
    exportedAt,
    reservations: rows,
    digest: createHash('sha256').update(canonical).digest('hex'),
    hmac: createHmac('sha256', key).update(canonical).digest('hex')
  };
};

test('binds signed ledger snapshots to work-queue-cas across ephemeral runner restarts, crash recovery, and zombie fencing', async () => {
  assert.equal(PROTECTED_WORK_QUEUE_REF, 'refs/heads/work-queue');
  assert.equal(ZERO_GIT_OID, '0'.repeat(40));
  assert.equal(MAX_CROSS_RUN_LEASE_TTL_MS, 3600000);
  assert.deepEqual(SUPPORTED_QUEUE_PROTOCOLS, ['v3', 'v4']);
  assert.deepEqual(SUPPORTED_CLOUD_HARNESSES, [
    'copilot-cloud-agent',
    'copilot-cloud-automation',
    'copilot-sdk'
  ]);

  const crossPlan = {...plan, includedUnits: 12, maxExecutionMs: 600000};
  const runner1 = openShadowDispatchLedger(':memory:', crossPlan);
  const runner2 = openShadowDispatchLedger(':memory:', crossPlan);
  const runner3 = openShadowDispatchLedger(':memory:', crossPlan);
  const refStore = createInMemoryWorkQueueRefStore();

  try {
    const snap0 = runner1.exportSnapshot({signingKey: casSigningKey, now: 1000}).snapshot;

    // 1. Atomic CAS claim + ledger reservation starting from empty refs/heads/work-queue (ZERO_GIT_OID).
    const step1 = reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: snap0,
      signingKey: casSigningKey,
      casState: refStore.readRef(),
      expectedRefOid: ZERO_GIT_OID,
      admissionEvidence: {...baseAdmission(), remainingIncludedUnits: 12},
      candidate: {
        repositoryId: 1,
        issue: 12,
        head,
        generation: 1,
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-ledger',
        ownedPaths: ['tools/engineering-factory/shadow-dispatch-ledger.mjs'],
        workerId: 'worker-run-1',
        runId: 1001,
        runAttempt: 1,
        leaseTtlMs: 60000,
        maxExecutionMs: 300000,
        traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`,
        lockSha256: computeReservationHeadLock(1, 12, head, 1)
      },
      nowMs: 1000
    });
    assert.equal(step1.ok, true);
    assert.equal(step1.reconciled, true);
    assert.equal(step1.shadow, true);
    assert.equal(step1.liveDispatch, false);
    assert.equal(step1.liveMerge, false);
    assert.equal(step1.reason, 'CROSS_RUN_CAS_RESERVED');
    assert.equal(step1.protocol, 'v3');
    assert.equal(step1.casMutationRequired, true);
    assert.equal(step1.ledgerMutationRequired, true);
    assert.equal(Object.isFrozen(step1), true);
    assert.equal(Object.isFrozen(step1.nextCasState), true);
    assert.equal(Object.isFrozen(step1.nextLedgerSnapshot), true);
    assert.deepEqual(step1.ticket, {repositoryId: 1, issue: 12, head, generation: 1});

    // Commit nextCasState to work-queue-cas store; deterministic OID matches byte-for-byte.
    const casCommit1 = refStore.compareAndSwapRef({
      ref: PROTECTED_WORK_QUEUE_REF,
      expectedOid: ZERO_GIT_OID,
      nextState: step1.nextCasState,
      force: false
    });
    assert.equal(casCommit1.ok, true);
    assert.equal(casCommit1.oid, step1.nextRefOid);

    // Import signed nextLedgerSnapshot onto stateless Runner 2.
    const importedOnRunner2 = runner2.importSnapshot(step1.nextLedgerSnapshot, {
      signingKey: casSigningKey,
      now: 1000
    });
    assert.equal(importedOnRunner2.reason, 'SHADOW_SNAPSHOT_IMPORTED');

    // 2. Stale expectedRefOid fails closed with CAS_CONFLICT and exposes actualRefOid.
    const conflict = reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: step1.nextLedgerSnapshot,
      signingKey: casSigningKey,
      casState: refStore.readRef(),
      expectedRefOid: ZERO_GIT_OID,
      admissionEvidence: {...baseAdmission(), observedMs: 1200, remainingIncludedUnits: 12},
      nowMs: 1200
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.reason, 'CAS_CONFLICT');
    assert.equal(conflict.expectedRefOid, ZERO_GIT_OID);
    assert.equal(conflict.actualRefOid, casCommit1.oid);

    // 3. Advance 'reserved' -> 'in-flight' against active CAS lease on Runner 2 (fences CAS sequence too).
    const step2 = reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: step1.nextLedgerSnapshot,
      signingKey: casSigningKey,
      casState: refStore.readRef(),
      expectedRefOid: casCommit1.oid,
      admissionEvidence: {...baseAdmission(), observedMs: 1500, remainingIncludedUnits: 12},
      candidate: {
        repositoryId: 1,
        issue: 12,
        head,
        generation: 1,
        phase: 'in-flight',
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-ledger',
        ownedPaths: ['tools/engineering-factory/shadow-dispatch-ledger.mjs'],
        workerId: 'worker-run-1',
        runId: 1001,
        runAttempt: 1
      },
      nowMs: 1500
    });
    assert.equal(step2.ok, true);
    assert.equal(step2.reason, 'CROSS_RUN_CAS_SIMULATION_STARTED');
    assert.equal(step2.casMutationRequired, true);
    assert.equal(step2.ledgerMutationRequired, true);
    const casCommitStep2 = refStore.compareAndSwapRef({
      ref: PROTECTED_WORK_QUEUE_REF,
      expectedOid: casCommit1.oid,
      nextState: step2.nextCasState,
      force: false
    });
    assert.equal(casCommitStep2.ok, true);
    assert.equal(casCommitStep2.oid, step2.nextRefOid);
    assert.equal(runner2.importSnapshot(step2.nextLedgerSnapshot, {
      signingKey: casSigningKey,
      now: 1500
    }).reason, 'SHADOW_SNAPSHOT_IMPORTED');

    // Healthy steady-state check performs zero mutations on either store.
    const steady = reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: step2.nextLedgerSnapshot,
      signingKey: casSigningKey,
      casState: refStore.readRef(),
      expectedRefOid: casCommitStep2.oid,
      admissionEvidence: {...baseAdmission(), observedMs: 1600, remainingIncludedUnits: 12},
      nowMs: 1600
    });
    assert.equal(steady.ok, true);
    assert.equal(steady.reason, 'CROSS_RUN_CAS_RECONCILED');
    assert.equal(steady.casMutationRequired, false);
    assert.equal(steady.ledgerMutationRequired, false);
    assert.deepEqual(steady.nextLedgerSnapshot, step2.nextLedgerSnapshot);

    // 4. Simulate worker_terminated crash on Runner 1 and reconcile orphan across runs.
    const crashReconcile = reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: step2.nextLedgerSnapshot,
      signingKey: casSigningKey,
      casState: refStore.readRef(),
      expectedRefOid: casCommitStep2.oid,
      admissionEvidence: {...baseAdmission(), observedMs: 2000, remainingIncludedUnits: 12},
      observedRuns: [
        {
          workId: '1:issue:12',
          runId: 1001,
          runAttempt: 1,
          leaseGeneration: 1,
          runState: 'worker_terminated'
        },
        {
          workId: '1:issue:999',
          runId: 9999,
          runAttempt: 1,
          leaseGeneration: 1,
          runState: 'run_missing'
        }
      ],
      nowMs: 2000
    });
    assert.equal(crashReconcile.ok, true);
    assert.equal(crashReconcile.releasedOrphanCount, 1);
    assert.deepEqual(crashReconcile.reclaimedCasWorkIds, ['1:issue:12']);
    assert.equal(crashReconcile.skippedRunObservations.length, 1);
    assert.equal(crashReconcile.skippedRunObservations[0].reason, 'UNKNOWN_WORK_ID');
    assert.equal(crashReconcile.reconciledActions[0].toPhase, 'expired');
    assert.equal(crashReconcile.reconciledActions[0].trigger, 'orphan_terminal_run');

    const casCommit2 = refStore.compareAndSwapRef({
      ref: PROTECTED_WORK_QUEUE_REF,
      expectedOid: casCommitStep2.oid,
      nextState: crashReconcile.nextCasState,
      force: false
    });
    assert.equal(casCommit2.ok, true);
    assert.equal(casCommit2.oid, crashReconcile.nextRefOid);

    // 5. Zombie worker with generation 1 or duplicate (repositoryId, issue, head) is fenced!
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: crashReconcile.nextLedgerSnapshot,
      signingKey: casSigningKey,
      casState: refStore.readRef(),
      expectedRefOid: casCommit2.oid,
      admissionEvidence: {...baseAdmission(), observedMs: 2100},
      candidate: {repositoryId: 1, issue: 12, head: 'b'.repeat(40), generation: 1},
      nowMs: 2100
    }).reason, 'STALE_LEASE_GENERATION');

    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: crashReconcile.nextLedgerSnapshot,
      signingKey: casSigningKey,
      casState: refStore.readRef(),
      expectedRefOid: casCommit2.oid,
      admissionEvidence: {...baseAdmission(), observedMs: 2100},
      candidate: {repositoryId: 1, issue: 12, head, generation: 3},
      nowMs: 2100
    }).reason, 'DUPLICATE_RESERVATION');

    // Reusing the exact prior (runId, runAttempt) fails closed with DUPLICATE_RUN_ATTEMPT.
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: crashReconcile.nextLedgerSnapshot,
      signingKey: casSigningKey,
      casState: refStore.readRef(),
      expectedRefOid: casCommit2.oid,
      admissionEvidence: {...baseAdmission(), observedMs: 2100},
      candidate: {
        repositoryId: 1,
        issue: 12,
        head: 'b'.repeat(40),
        generation: 3,
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-ledger',
        ownedPaths: ['tools/engineering-factory/shadow-dispatch-ledger.mjs'],
        workerId: 'worker-run-2',
        runId: 1001,
        runAttempt: 1,
        leaseTtlMs: 60000
      },
      nowMs: 2100
    }).reason, 'DUPLICATE_RUN_ATTEMPT');

    // 6. Runner 3 atomically claims generation 3 on the requeued CAS entry + binds new head in ledger,
    // commits to work-queue-cas refStore (verifying priorRuns & OID match), then settles cleanly.
    const boundRetry = reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: crashReconcile.nextLedgerSnapshot,
      signingKey: casSigningKey,
      casState: refStore.readRef(),
      expectedRefOid: casCommit2.oid,
      admissionEvidence: {...baseAdmission(), observedMs: 2200, remainingIncludedUnits: 12},
      candidate: {
        repositoryId: 1,
        issue: 12,
        head: 'b'.repeat(40),
        generation: 3,
        phase: 'in-flight',
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-ledger',
        ownedPaths: ['tools/engineering-factory/shadow-dispatch-ledger.mjs'],
        workerId: 'worker-run-3',
        runId: 1002,
        runAttempt: 1,
        leaseTtlMs: 60000
      },
      nowMs: 2200
    });
    assert.equal(boundRetry.ok, true);
    assert.equal(boundRetry.reason, 'CROSS_RUN_CAS_SIMULATION_STARTED');
    assert.deepEqual(boundRetry.nextCasState.entries[0].priorRuns, [{runId: 1001, runAttempt: 1}]);

    const casCommit3 = refStore.compareAndSwapRef({
      ref: PROTECTED_WORK_QUEUE_REF,
      expectedOid: casCommit2.oid,
      nextState: boundRetry.nextCasState,
      force: false
    });
    assert.equal(casCommit3.ok, true);
    assert.equal(casCommit3.oid, boundRetry.nextRefOid);

    // Settle via run_terminal 'success' before lease expiry -> ledger row becomes 'settled'.
    const settledStep = reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: boundRetry.nextLedgerSnapshot,
      signingKey: casSigningKey,
      casState: refStore.readRef(),
      expectedRefOid: casCommit3.oid,
      admissionEvidence: {...baseAdmission(), observedMs: 2500, remainingIncludedUnits: 12},
      observedRuns: [{
        workId: '1:issue:12',
        runId: 1002,
        runAttempt: 1,
        leaseGeneration: 3,
        runState: 'run_terminal',
        conclusion: 'success'
      }],
      nowMs: 2500
    });
    assert.equal(settledStep.ok, true);
    assert.equal(settledStep.nextCasState.entries[0].status, 'completed');
    assert.equal(settledStep.reconciledActions[0].toPhase, 'settled');
    assert.equal(runner3.importSnapshot(settledStep.nextLedgerSnapshot, {
      signingKey: casSigningKey,
      now: 2500
    }).reason, 'SHADOW_SNAPSHOT_IMPORTED');
  } finally {
    runner1.close();
    runner2.close();
    runner3.close();
  }
});

test('enforces protocol v3 vs gated v4 and #105 $0 overage hard-stop & Cloud Agent / Cloud Automations contract', () => {
  const ledger = openShadowDispatchLedger(':memory:', plan);
  try {
    const snap = ledger.exportSnapshot({signingKey: casSigningKey, now: 1000}).snapshot;
    const v3State = {
      schemaVersion: 1,
      protocol: 'v3',
      sequence: 1,
      nextGeneration: 1,
      entries: [],
      recoveryReceipts: []
    };
    const v3Oid = computeWorkQueueStateOid(v3State);
    const v4State = {...v3State, protocol: 'v4'};
    const v4Oid = computeWorkQueueStateOid(v4State);

    // Protocol v4 without protocolV4ReleaseVerified === true fails closed with UNVERIFIED_QUEUE_PROTOCOL.
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: snap,
      signingKey: casSigningKey,
      casState: v4State,
      expectedRefOid: v4Oid,
      admissionEvidence: baseAdmission(),
      nowMs: 1000
    }).reason, 'UNVERIFIED_QUEUE_PROTOCOL');

    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: snap,
      signingKey: casSigningKey,
      casState: v4State,
      expectedRefOid: v4Oid,
      protocolV4ReleaseVerified: false,
      admissionEvidence: baseAdmission(),
      nowMs: 1000
    }).reason, 'UNVERIFIED_QUEUE_PROTOCOL');

    // Conflicting top-level vs admissionEvidence protocolV4ReleaseVerified fails closed.
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: snap,
      signingKey: casSigningKey,
      casState: v4State,
      expectedRefOid: v4Oid,
      protocolV4ReleaseVerified: true,
      admissionEvidence: {...baseAdmission(), protocolV4ReleaseVerified: false},
      nowMs: 1000
    }).reason, 'UNVERIFIED_QUEUE_PROTOCOL');

    // Empty queue with requestedProtocol 'v4' or unknown protocol also enforces protocolV4ReleaseVerified.
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: snap,
      signingKey: casSigningKey,
      casState: null,
      expectedRefOid: ZERO_GIT_OID,
      requestedProtocol: 'v4',
      admissionEvidence: baseAdmission(),
      nowMs: 1000
    }).reason, 'UNVERIFIED_QUEUE_PROTOCOL');
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: snap,
      signingKey: casSigningKey,
      casState: null,
      expectedRefOid: ZERO_GIT_OID,
      requestedProtocol: 'v2',
      admissionEvidence: baseAdmission(),
      nowMs: 1000
    }).reason, 'UNVERIFIED_QUEUE_PROTOCOL');
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: snap,
      signingKey: casSigningKey,
      casState: {ref: PROTECTED_WORK_QUEUE_REF, oid: ZERO_GIT_OID, state: null},
      expectedRefOid: ZERO_GIT_OID,
      requestedProtocol: 'v4',
      admissionEvidence: baseAdmission(),
      nowMs: 1000
    }).reason, 'UNVERIFIED_QUEUE_PROTOCOL');
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: snap,
      signingKey: casSigningKey,
      casState: {ref: PROTECTED_WORK_QUEUE_REF, oid: ZERO_GIT_OID, state: null},
      expectedRefOid: ZERO_GIT_OID,
      requestedProtocol: 'v2',
      admissionEvidence: baseAdmission(),
      nowMs: 1000
    }).reason, 'UNVERIFIED_QUEUE_PROTOCOL');
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: snap,
      signingKey: casSigningKey,
      casState: {...v3State, protocol: 'v2'},
      expectedRefOid: v3Oid,
      admissionEvidence: baseAdmission(),
      nowMs: 1000
    }).reason, 'UNVERIFIED_QUEUE_PROTOCOL');

    // Verified Protocol v4 succeeds (both direct casState, empty requestedProtocol, and ref envelope).
    const v4Admitted = reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: snap,
      signingKey: casSigningKey,
      casState: v4State,
      expectedRefOid: v4Oid,
      protocolV4ReleaseVerified: true,
      requestedProtocol: 'v4',
      admissionEvidence: baseAdmission(),
      nowMs: 1000
    });
    assert.equal(v4Admitted.ok, true);
    assert.equal(v4Admitted.protocol, 'v4');

    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: snap,
      signingKey: casSigningKey,
      casState: {ref: PROTECTED_WORK_QUEUE_REF, oid: v4Oid, state: v4State},
      expectedRefOid: v4Oid,
      admissionEvidence: {...baseAdmission(), protocolV4ReleaseVerified: true},
      requestedProtocol: 'v3',
      nowMs: 1000
    }).reason, 'UNVERIFIED_QUEUE_PROTOCOL');

    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: snap,
      signingKey: casSigningKey,
      casState: v4State,
      expectedRefOid: v4Oid,
      protocolV4ReleaseVerified: true,
      requestedProtocol: 'v3',
      admissionEvidence: baseAdmission(),
      nowMs: 1000
    }).reason, 'UNVERIFIED_QUEUE_PROTOCOL');

    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: snap,
      signingKey: casSigningKey,
      casState: null,
      expectedRefOid: ZERO_GIT_OID,
      protocolV4ReleaseVerified: true,
      requestedProtocol: 'v4',
      admissionEvidence: baseAdmission(),
      nowMs: 1000
    }).protocol, 'v4');

    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: snap,
      signingKey: casSigningKey,
      casState: {ref: PROTECTED_WORK_QUEUE_REF, oid: ZERO_GIT_OID, state: null},
      expectedRefOid: ZERO_GIT_OID,
      protocolV4ReleaseVerified: true,
      requestedProtocol: 'v4',
      admissionEvidence: baseAdmission(),
      nowMs: 1000
    }).protocol, 'v4');

    // #105 $0 hard-stop & PAT & harness visibility checks.
    const checkAdmission = overrides => reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: snap,
      signingKey: casSigningKey,
      casState: v3State,
      expectedRefOid: v3Oid,
      admissionEvidence: {...baseAdmission(), ...overrides},
      nowMs: 1000
    });

    assert.equal(checkAdmission({stop: true}).reason, 'STOPPED');
    assert.equal(checkAdmission({personalPatConfigured: true}).reason, 'PERSONAL_PAT_FORBIDDEN');
    assert.equal(checkAdmission({includedOnly: false}).reason, 'INCLUDED_ONLY_REQUIRED');
    assert.equal(checkAdmission({overageDisabled: false}).reason, 'OVERAGE_HARD_STOP_REQUIRED');
    assert.equal(checkAdmission({hardStopEnforced: false}).reason, 'OVERAGE_HARD_STOP_REQUIRED');
    assert.equal(checkAdmission({incrementalSpendUsdCents: 1}).reason, 'NONZERO_INCREMENTAL_SPEND');
    assert.equal(checkAdmission({incrementalSpendUsdCents: -1}).reason, 'NONZERO_INCREMENTAL_SPEND');
    assert.equal(checkAdmission({authorityVerified: false}).reason, 'BILLING_AUTHORITY_UNVERIFIED');
    assert.equal(checkAdmission({entitlementVerified: false}).reason, 'BILLING_AUTHORITY_UNVERIFIED');
    assert.equal(checkAdmission({repositoryId: 99, approvedRepositoryId: 99}).reason, 'UNCONFIGURED_REPOSITORY');
    assert.equal(checkAdmission({repositoryId: 1, approvedRepositoryId: 2}).reason, 'REPOSITORY_SCOPE_MISMATCH');
    assert.equal(checkAdmission({repositoryId: undefined, approvedRepositoryId: 2}).reason, 'REPOSITORY_SCOPE_MISMATCH');
    assert.equal(checkAdmission({repositoryId: 1, approvedRepositoryId: undefined}).reason, 'REPOSITORY_SCOPE_MISMATCH');
    assert.equal(checkAdmission({observedMs: 1001}).reason, 'STALE_ADMISSION_EVIDENCE');
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: snap,
      signingKey: casSigningKey,
      casState: v3State,
      expectedRefOid: v3Oid,
      admissionEvidence: {...baseAdmission(), observedMs: 1000, maxQuotaAgeMs: 5000},
      nowMs: 7000
    }).reason, 'STALE_ADMISSION_EVIDENCE');

    // Cloud Agent on public/private/internal succeeds; Cloud Automation requires private/internal.
    for (const vis of ['public', 'private', 'internal']) {
      assert.equal(checkAdmission({repositoryVisibility: vis, harness: 'copilot-cloud-agent'}).ok, true);
    }
    assert.equal(checkAdmission({
      repositoryVisibility: 'public',
      harness: 'copilot-cloud-automation',
      agentLogin: undefined
    }).reason, 'AUTOMATION_REQUIRES_PRIVATE_REPO');
    for (const vis of ['private', 'internal']) {
      const adm = baseAdmission();
      delete adm.agentLogin;
      assert.equal(reconcileLedgerWithWorkQueueCas({
        ledgerSnapshot: snap,
        signingKey: casSigningKey,
        casState: v3State,
        expectedRefOid: v3Oid,
        admissionEvidence: {...adm, repositoryVisibility: vis, harness: 'copilot-cloud-automation'},
        nowMs: 1000
      }).ok, true);
    }

    // Object harness shape, agentLogin identity, and pinned @microsoft/copilot-sdk v2.0.3 checks.
    const admNoLogin = baseAdmission();
    delete admNoLogin.agentLogin;
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: snap,
      signingKey: casSigningKey,
      casState: v3State,
      expectedRefOid: v3Oid,
      admissionEvidence: {
        ...admNoLogin,
        harness: {kind: 'copilot-cloud-agent', verified: true, agentLogin: 'copilot-swe-agent[bot]'}
      },
      nowMs: 1000
    }).ok, true);
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: snap,
      signingKey: casSigningKey,
      casState: v3State,
      expectedRefOid: v3Oid,
      admissionEvidence: {...admNoLogin, harness: {kind: 'copilot-cloud-agent', verified: false}},
      nowMs: 1000
    }).reason, 'HARNESS_UNVERIFIED');
    assert.equal(checkAdmission({agentLogin: 'personal-user'}).reason, 'AGENT_IDENTITY_MISMATCH');
    assert.equal(checkAdmission({
      harness: 'copilot-cloud-automation',
      repositoryVisibility: 'private'
    }).reason, 'AGENT_IDENTITY_MISMATCH');
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: snap,
      signingKey: casSigningKey,
      casState: v3State,
      expectedRefOid: v3Oid,
      admissionEvidence: {...admNoLogin, harness: 'github-models'},
      nowMs: 1000
    }).reason, 'UNSUPPORTED_PROVIDER_HARNESS');
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: snap,
      signingKey: casSigningKey,
      casState: v3State,
      expectedRefOid: v3Oid,
      admissionEvidence: {...admNoLogin, harness: {kind: 'copilot-sdk', verified: true, sdkVersion: 'v2.0.3'}},
      nowMs: 1000
    }).ok, true);
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: snap,
      signingKey: casSigningKey,
      casState: v3State,
      expectedRefOid: v3Oid,
      admissionEvidence: {...admNoLogin, harness: 'copilot-sdk', sdkVersion: '1.9.0'},
      nowMs: 1000
    }).reason, 'SDK_VERSION_MISMATCH');
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: snap,
      signingKey: casSigningKey,
      casState: v3State,
      expectedRefOid: v3Oid,
      admissionEvidence: {...admNoLogin, harness: 'copilot-sdk'},
      nowMs: 1000
    }).reason, 'SDK_VERSION_MISMATCH');
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: snap,
      signingKey: casSigningKey,
      casState: v3State,
      expectedRefOid: v3Oid,
      admissionEvidence: {...admNoLogin, harness: 'copilot-cloud-agent', sdkVersion: '2.0.3'},
      nowMs: 1000
    }).reason, 'INVALID_ADMISSION_EVIDENCE');
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: snap,
      signingKey: casSigningKey,
      casState: v3State,
      expectedRefOid: v3Oid,
      admissionEvidence: {
        ...admNoLogin,
        agentLogin: 'copilot-swe-agent[bot]',
        harness: {kind: 'copilot-cloud-agent', verified: true, agentLogin: 'other-bot'}
      },
      nowMs: 1000
    }).reason, 'INVALID_ADMISSION_EVIDENCE');
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: snap,
      signingKey: casSigningKey,
      casState: v3State,
      expectedRefOid: v3Oid,
      admissionEvidence: {
        ...admNoLogin,
        sdkVersion: '2.0.3',
        harness: {kind: 'copilot-sdk', verified: true, sdkVersion: '2.0.2'}
      },
      nowMs: 1000
    }).reason, 'INVALID_ADMISSION_EVIDENCE');

    // gh-aw AI credit soft caps validation.
    assert.equal(checkAdmission({
      ghAwCaps: {maxAiCredits: 0, maxDailyAiCredits: 10, dailyAiCreditsUsed: 0, runAiCreditsRequired: 1}
    }).reason, 'GH_AW_SOFT_CAPS_INVALID');
    assert.equal(checkAdmission({
      ghAwCaps: {maxAiCredits: 5, maxDailyAiCredits: 10, dailyAiCreditsUsed: 0, runAiCreditsRequired: 6}
    }).reason, 'GH_AW_MAX_AI_CREDITS_EXCEEDED');
    assert.equal(checkAdmission({
      ghAwCaps: {maxAiCredits: 5, maxDailyAiCredits: 10, dailyAiCreditsUsed: 11, runAiCreditsRequired: 2}
    }).reason, 'GH_AW_DAILY_AI_CREDITS_EXCEEDED');
    assert.equal(checkAdmission({
      ghAwCaps: {maxAiCredits: 5, maxDailyAiCredits: 10, dailyAiCreditsUsed: 6, runAiCreditsRequired: 4}
    }).ok, true);
  } finally {
    ledger.close();
  }
});

test('verifies signed ledger snapshots, rejects active/revoked Proxies and getters, and covers TTL/orphan/compaction edge cases', () => {
  const bigPlan = {
    window: 'cas-edge-window',
    maxActive: 4,
    includedUnits: 5000,
    unitsPerRun: 2,
    maxExecutionMs: MAX_CROSS_RUN_LEASE_TTL_MS,
    repositories: [{repositoryId: 1, maxActive: 2}, {repositoryId: 2, maxActive: 2}]
  };
  const ledger = openShadowDispatchLedger(':memory:', bigPlan);
  try {
    const snap0 = ledger.exportSnapshot({signingKey: casSigningKey, now: 1000}).snapshot;
    const planSig = snap0.planSignature;

    // 1. Standalone verifySignedLedgerSnapshot & computeWorkQueueStateOid validation.
    assert.equal(computeWorkQueueStateOid(null, 'bad-oid'), null);
    assert.equal(computeWorkQueueStateOid(null, 'a'.repeat(40)), null);
    assert.equal(computeWorkQueueStateOid(null), ZERO_GIT_OID);
    assert.equal(computeWorkQueueStateOid({bad: true}), null);

    for (const badOpts of [
      null,
      {signingKey: 'short', nowMs: 1000},
      {signingKey: casSigningKey, nowMs: -1},
      {signingKey: casSigningKey, nowMs: 1000, minSequence: -1},
      {signingKey: casSigningKey, nowMs: 1000, maxSnapshotAgeMs: 0},
      {signingKey: casSigningKey, nowMs: 1000, maxSnapshotAgeMs: 86400001}
    ]) {
      assert.equal(verifySignedLedgerSnapshot(snap0, badOpts).reason, 'SNAPSHOT_KEY_OR_TIME_INVALID');
    }
    assert.equal(verifySignedLedgerSnapshot(snap0, {
      signingKey: casSigningKey,
      nowMs: 1000,
      fixturePlan: {bad: true}
    }).reason, 'INVALID_SHADOW_DISPATCH_PLAN');
    assert.equal(verifySignedLedgerSnapshot(snap0, {
      signingKey: casSigningKey,
      nowMs: 1000,
      fixturePlan: {...bigPlan, window: 'other-window'}
    }).reason, 'PLAN_SIGNATURE_MISMATCH');
    assert.equal(verifySignedLedgerSnapshot(snap0, {
      signingKey: casSigningKey,
      nowMs: 999
    }).reason, 'INVALID_SNAPSHOT');
    assert.equal(verifySignedLedgerSnapshot(snap0, {
      signingKey: casSigningKey,
      nowMs: 1000,
      minSequence: 2
    }).reason, 'STALE_SNAPSHOT_SEQUENCE');
    assert.equal(verifySignedLedgerSnapshot(snap0, {
      signingKey: casSigningKey,
      nowMs: 5000,
      maxSnapshotAgeMs: 1000
    }).reason, 'STALE_LEDGER_SNAPSHOT');

    // Unsigned tampering of row data always yields SNAPSHOT_SIGNATURE_INVALID.
    const rowValid = {
      repositoryId: 1,
      issue: 10,
      head,
      generation: 1,
      units: 2,
      phase: 'reserved',
      validThrough: 2000,
      reservedAt: 1000
    };
    const snapWithRow = signRawSnapshot(planSig, 2, 1000, [rowValid], casSigningKey, bigPlan.window);
    assert.equal(verifySignedLedgerSnapshot(snapWithRow, {
      signingKey: casSigningKey,
      nowMs: 1000,
      fixturePlan: bigPlan
    }).ok, true);
    assert.equal(verifySignedLedgerSnapshot({
      ...snapWithRow,
      reservations: [{...rowValid, units: 99}]
    }, {signingKey: casSigningKey, nowMs: 1000}).reason, 'SNAPSHOT_SIGNATURE_INVALID');
    assert.equal(verifySignedLedgerSnapshot({
      ...snapWithRow,
      hmac: '0'.repeat(64)
    }, {signingKey: casSigningKey, nowMs: 1000}).reason, 'SNAPSHOT_SIGNATURE_INVALID');

    // Signed invalid planSignature or semantic row violations fail closed with INVALID_SNAPSHOT.
    for (const badSig of [
      '',
      'not-json',
      JSON.stringify([1, 2]),
      JSON.stringify(['wrong-win', 4, 20, 2, 3600000, [[1, 2]]]),
      JSON.stringify([bigPlan.window, 4, 20, 2, 3600000, [[2, 2], [1, 2]]])
    ]) {
      const forged = signRawSnapshot(badSig, 2, 1000, [], casSigningKey, bigPlan.window);
      assert.equal(verifySignedLedgerSnapshot(forged, {
        signingKey: casSigningKey,
        nowMs: 1000
      }).reason, 'INVALID_SNAPSHOT');
    }
    for (const badRows of [
      [{...rowValid, repositoryId: 99}],
      [{...rowValid, units: 4}],
      [{...rowValid, phase: 'reserved', reservedAt: 1000, validThrough: 62000}],
      [{...rowValid, phase: 'in-flight', reservedAt: 1000, validThrough: 1000 + MAX_CROSS_RUN_LEASE_TTL_MS + 1}],
      [rowValid, {...rowValid, head: '0'.repeat(40)}],
      [rowValid, {...rowValid, head: 'f'.repeat(40)}],
      Array.from({length: 2501}, (_, idx) => ({...rowValid, issue: idx + 1, phase: 'settled'}))
    ]) {
      const forged = signRawSnapshot(planSig, 2, 1000, badRows, casSigningKey, bigPlan.window);
      assert.equal(verifySignedLedgerSnapshot(forged, {
        signingKey: casSigningKey,
        nowMs: 1000
      }).reason, 'INVALID_SNAPSHOT');
    }
    const lateExportForged = signRawSnapshot(
      planSig,
      2,
      80000,
      [{...rowValid, phase: 'in-flight', reservedAt: 1000, validThrough: 61000 + MAX_CROSS_RUN_LEASE_TTL_MS + 1}],
      casSigningKey,
      bigPlan.window
    );
    assert.equal(verifySignedLedgerSnapshot(lateExportForged, {
      signingKey: casSigningKey,
      nowMs: 80000
    }).reason, 'INVALID_SNAPSHOT');
    assert.equal(verifySignedLedgerSnapshot({
      ...snap0,
      reservations: [{...rowValid, units: 'bad'}]
    }, {signingKey: casSigningKey, nowMs: 1000}).reason, 'INVALID_SNAPSHOT');

    // 2. Active Proxy, Revoked Proxy, non-Object.prototype, sparse array, and getter traps never execute or throw!
    let trapCalls = 0;
    const trap = () => {
      trapCalls++;
      throw new Error('trap invoked');
    };
    const revocableObj = Proxy.revocable({a: 1}, {get: trap});
    revocableObj.revoke();
    const revocableArr = Proxy.revocable([], {get: trap});
    revocableArr.revoke();
    const getterInput = {
      ledgerSnapshot: snap0,
      signingKey: casSigningKey,
      casState: null,
      expectedRefOid: ZERO_GIT_OID,
      admissionEvidence: baseAdmission(),
      nowMs: 1000
    };
    Object.defineProperty(getterInput, 'stop', {enumerable: true, get: trap});
    const sparseArr = [];
    sparseArr.length = 1;

    for (const badInput of [
      null,
      new Proxy(getterInput, {get: trap}),
      revocableObj.proxy,
      Object.create(null),
      getterInput,
      {...snap0}
    ]) {
      assert.equal(reconcileLedgerWithWorkQueueCas(badInput).reason, 'INVALID_RECONCILE_OPTIONS');
    }
    assert.equal(verifySignedLedgerSnapshot(revocableObj.proxy, {
      signingKey: casSigningKey,
      nowMs: 1000
    }).reason, 'INVALID_SNAPSHOT');
    assert.equal(verifySignedLedgerSnapshot({...snap0, reservations: revocableArr.proxy}, {
      signingKey: casSigningKey,
      nowMs: 1000
    }).reason, 'INVALID_SNAPSHOT');
    assert.equal(verifySignedLedgerSnapshot({...snap0, reservations: sparseArr}, {
      signingKey: casSigningKey,
      nowMs: 1000
    }).reason, 'INVALID_SNAPSHOT');
    assert.equal(trapCalls, 0);

    // 3. Top-level option guards, ref protection, force push block, and OID modes.
    const baseReq = {
      ledgerSnapshot: snap0,
      signingKey: casSigningKey,
      casState: null,
      expectedRefOid: ZERO_GIT_OID,
      admissionEvidence: {...baseAdmission(), remainingIncludedUnits: 5000},
      nowMs: 1000
    };
    assert.equal(reconcileLedgerWithWorkQueueCas({...baseReq, stop: true}).reason, 'STOPPED');
    assert.equal(reconcileLedgerWithWorkQueueCas({...baseReq, force: true}).reason, 'FORCE_UPDATE_FORBIDDEN');
    assert.equal(reconcileLedgerWithWorkQueueCas({...baseReq, force: 'no'}).reason, 'INVALID_RECONCILE_OPTIONS');
    assert.equal(reconcileLedgerWithWorkQueueCas({...baseReq, targetRef: 42}).reason, 'INVALID_RECONCILE_OPTIONS');
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      targetRef: 'refs/heads/main'
    }).reason, 'UNPROTECTED_WORK_QUEUE_REF');
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      expectedRefOid: 'not-a-sha'
    }).reason, 'INVALID_EXPECTED_REF_OID');
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      actualRefOid: 'bad'
    }).reason, 'INVALID_RECONCILE_OPTIONS');
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      previousRefOid: 'bad'
    }).reason, 'INVALID_RECONCILE_OPTIONS');
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      previousRefOid: '1'.repeat(40)
    }).reason, 'INVALID_RECONCILE_OPTIONS');
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      actualRefOid: '1'.repeat(40)
    }).reason, 'INVALID_QUEUE_STATE');
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      casState: {ref: PROTECTED_WORK_QUEUE_REF, oid: ZERO_GIT_OID, state: null, ok: false}
    }).reason, 'REF_STORE_UNAVAILABLE');
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      casState: {ref: 'refs/heads/other', oid: ZERO_GIT_OID, state: null}
    }).reason, 'UNPROTECTED_WORK_QUEUE_REF');
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      casState: {ref: PROTECTED_WORK_QUEUE_REF, oid: 'bad', state: null}
    }).reason, 'INVALID_QUEUE_STATE');
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      casState: {ref: PROTECTED_WORK_QUEUE_REF, oid: '1'.repeat(40), state: null},
      expectedRefOid: '1'.repeat(40)
    }).reason, 'INVALID_QUEUE_STATE');
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      casState: {ref: PROTECTED_WORK_QUEUE_REF, oid: ZERO_GIT_OID, state: null},
      previousRefOid: '1'.repeat(40)
    }).reason, 'INVALID_RECONCILE_OPTIONS');
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      casState: {ref: PROTECTED_WORK_QUEUE_REF, oid: ZERO_GIT_OID, state: null},
      actualRefOid: '1'.repeat(40)
    }).reason, 'CAS_CONFLICT');

    // Chained previousRefOid works deterministically when actualRefOid is not simultaneously passed.
    const emptyCasState = {
      schemaVersion: 1,
      protocol: 'v3',
      sequence: 1,
      nextGeneration: 1,
      entries: [],
      recoveryReceipts: []
    };
    const prevOid = '2'.repeat(40);
    const chainedOid = computeWorkQueueStateOid(emptyCasState, prevOid);
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      casState: emptyCasState,
      previousRefOid: prevOid,
      actualRefOid: chainedOid,
      expectedRefOid: chainedOid
    }).reason, 'INVALID_RECONCILE_OPTIONS');
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      casState: emptyCasState,
      previousRefOid: prevOid,
      expectedRefOid: chainedOid
    }).ok, true);

    // 4. CAS entry TTL > 3_600_000 ms, clock skew, receipts, priorRuns, PR head movement, and orphan states.
    const makePrEntry = (overrides = {}) => ({
      workId: `1:pr:42:${head}`,
      targetType: 'pull_request',
      repository: 'Jamula/SoftwareFactory',
      repositoryId: 1,
      issueNumber: null,
      pullNumber: 42,
      headSha: head,
      lane: 'lane-ledger',
      ownedPaths: ['tools/engineering-factory/shadow-dispatch-ledger.mjs'],
      status: 'leased',
      generation: 1,
      attempts: 2,
      maxAttempts: 3,
      workerId: 'worker-pr',
      runId: 500,
      runAttempt: 1,
      claimedAtMs: 1000,
      leaseTtlMs: 60000,
      leaseExpiresAtMs: 61000,
      maxExecutionMs: 300000,
      executionDeadlineMs: 301000,
      priorRuns: [{runId: 499, runAttempt: 1}],
      ...overrides
    });

    const overTtlState = {...emptyCasState, nextGeneration: 2, entries: [makePrEntry({
      leaseTtlMs: MAX_CROSS_RUN_LEASE_TTL_MS + 1,
      maxExecutionMs: MAX_CROSS_RUN_LEASE_TTL_MS + 1,
      executionDeadlineMs: 1000 + MAX_CROSS_RUN_LEASE_TTL_MS + 1
    })]};
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      casState: overTtlState,
      expectedRefOid: ZERO_GIT_OID
    }).reason, 'LEASE_TTL_EXCEEDED');

    for (const badEntry of [
      null,
      makePrEntry({targetType: 'other'}),
      makePrEntry({targetType: 'issue', issueNumber: 0, pullNumber: null, headSha: null, workId: '1:issue:0'}),
      makePrEntry({pullNumber: 0}),
      makePrEntry({workId: 'wrong'}),
      makePrEntry({priorRuns: [{runId: 500, runAttempt: 1}]}),
      makePrEntry({priorRuns: [{runId: 0, runAttempt: 1}]}),
      makePrEntry({priorRuns: []})
    ]) {
      assert.equal(reconcileLedgerWithWorkQueueCas({
        ...baseReq,
        casState: {...emptyCasState, nextGeneration: 2, entries: [badEntry]},
        expectedRefOid: ZERO_GIT_OID
      }).reason, 'INVALID_QUEUE_STATE');
    }

    // Clock skew on claimedAtMs and recoveryReceipts.reclaimedAtMs.
    const skewEntryState = {...emptyCasState, nextGeneration: 2, entries: [makePrEntry({
      claimedAtMs: 2000,
      leaseExpiresAtMs: 62000,
      executionDeadlineMs: 302000
    })]};
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      casState: skewEntryState,
      expectedRefOid: ZERO_GIT_OID,
      nowMs: 1000
    }).reason, 'CLOCK_SKEW_REJECTED');

    const validReceipt = {
      workId: `1:pr:42:${head}`,
      repositoryId: 1,
      targetType: 'pull_request',
      runState: 'lease_expired',
      conclusion: null,
      previousRunId: 499,
      previousRunAttempt: 1,
      previousGeneration: 1,
      reclaimedGeneration: 2,
      attempts: 1,
      maxAttempts: 3,
      outcome: 'requeued',
      reclaimedAtMs: 2000
    };
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      casState: {...emptyCasState, nextGeneration: 3, recoveryReceipts: [validReceipt]},
      expectedRefOid: ZERO_GIT_OID,
      nowMs: 1000
    }).reason, 'CLOCK_SKEW_REJECTED');
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      casState: {...emptyCasState, nextGeneration: 2, recoveryReceipts: [validReceipt]},
      expectedRefOid: ZERO_GIT_OID,
      nowMs: 3000
    }).reason, 'INVALID_QUEUE_STATE');
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      casState: {...emptyCasState, archivedTerminal: [{workId: '', status: 'completed'}]},
      expectedRefOid: ZERO_GIT_OID
    }).reason, 'INVALID_QUEUE_STATE');

    // Conflicting active CAS leases on the same lane fail closed with ACTIVE_CAS_LEASE_CONFLICT.
    const conflictCas = {
      ...emptyCasState,
      nextGeneration: 3,
      entries: [
        makePrEntry({generation: 1}),
        makePrEntry({
          workId: `1:pr:43:${'b'.repeat(40)}`,
          pullNumber: 43,
          headSha: 'b'.repeat(40),
          generation: 2
        })
      ]
    };
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      casState: conflictCas,
      expectedRefOid: computeWorkQueueStateOid(conflictCas),
      admissionEvidence: {...baseAdmission(), observedMs: 1500},
      nowMs: 1500
    }).reason, 'ACTIVE_CAS_LEASE_CONFLICT');

    // Reclaim expired TTLs, unbacked reservations, superseded PR heads, and archived terminal orphans.
    const multiRowSnap = signRawSnapshot(planSig, 2, 1000, [
      // (1, 10): ledger TTL expired ('reserved' -> 'cancelled')
      {repositoryId: 1, issue: 10, head: '1'.repeat(40), generation: 1, units: 2, phase: 'reserved', validThrough: 1500, reservedAt: 1000},
      // (1, 42, head): superseded by newer PR head on pullNumber 42 ('in-flight' -> 'expired')
      {repositoryId: 1, issue: 42, head, generation: 1, units: 2, phase: 'in-flight', validThrough: 5000, reservedAt: 1000},
      // (2, 20): archived 'completed' in CAS ('in-flight' -> 'settled')
      {repositoryId: 2, issue: 20, head: '2'.repeat(40), generation: 1, units: 2, phase: 'in-flight', validThrough: 5000, reservedAt: 1000},
      // (2, 21): unbacked reservation ('reserved' -> 'cancelled')
      {repositoryId: 2, issue: 21, head: '3'.repeat(40), generation: 1, units: 2, phase: 'reserved', validThrough: 5000, reservedAt: 1000}
    ], casSigningKey, bigPlan.window);
    const prMovedCas = {
      schemaVersion: 1,
      protocol: 'v3',
      sequence: 3,
      nextGeneration: 4,
      entries: [
        makePrEntry({
          workId: `1:pr:42:${'c'.repeat(40)}`,
          pullNumber: 42,
          headSha: 'c'.repeat(40),
          generation: 2,
          leaseTtlMs: 8000,
          leaseExpiresAtMs: 9000,
          maxExecutionMs: 8000,
          executionDeadlineMs: 9000
        }),
        {
          workId: '1:issue:50',
          targetType: 'issue',
          repository: 'Jamula/SoftwareFactory',
          repositoryId: 1,
          issueNumber: 50,
          pullNumber: null,
          headSha: null,
          lane: 'lane-docs',
          ownedPaths: ['docs/COORDINATOR-EVENT-JOURNAL.md'],
          status: 'leased',
          generation: 3,
          attempts: 3,
          maxAttempts: 3,
          workerId: 'worker-exp',
          runId: 700,
          runAttempt: 1,
          claimedAtMs: 1000,
          leaseTtlMs: 500,
          leaseExpiresAtMs: 1500,
          maxExecutionMs: 500,
          executionDeadlineMs: 1500
        }
      ],
      recoveryReceipts: [],
      archivedTerminal: [{workId: '2:issue:20', status: 'completed'}]
    };
    const multiRec = reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: multiRowSnap,
      signingKey: casSigningKey,
      casState: prMovedCas,
      expectedRefOid: computeWorkQueueStateOid(prMovedCas),
      fixturePlan: bigPlan,
      minSnapshotSequence: 2,
      maxSnapshotAgeMs: 5000,
      admissionEvidence: {...baseAdmission(), observedMs: 2000, remainingIncludedUnits: 20},
      observedRuns: [{
        workId: '1:issue:50',
        runId: 999,
        runAttempt: 1,
        leaseGeneration: 3,
        runState: 'run_missing'
      }],
      nowMs: 2000
    });
    assert.equal(multiRec.ok, true);
    assert.equal(multiRec.reclaimedExpiredCount, 2);
    assert.equal(multiRec.releasedOrphanCount, 3);
    assert.equal(multiRec.skippedRunObservations[0].reason, 'STALE_OR_INACTIVE_RUN');
    assert.equal(multiRec.nextCasState.entries[1].status, 'exhausted');
    assert.deepEqual(
      multiRec.reconciledActions.map(a => [a.issue, a.toPhase, a.trigger]),
      [
        [10, 'cancelled', 'ledger_ttl_expired'],
        [42, 'expired', 'superseded_generation'],
        [20, 'settled', 'orphan_terminal_run'],
        [21, 'cancelled', 'unbacked_reservation']
      ]
    );

    // Ledger row with generation >= casState.nextGeneration fails closed with STALE_LEASE_GENERATION.
    const futureGenSnap = signRawSnapshot(planSig, 2, 1000, [
      {...rowValid, generation: 5}
    ], casSigningKey, bigPlan.window);
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: futureGenSnap,
      signingKey: casSigningKey,
      casState: emptyCasState,
      expectedRefOid: computeWorkQueueStateOid(emptyCasState),
      admissionEvidence: baseAdmission(),
      nowMs: 1000
    }).reason, 'STALE_LEASE_GENERATION');

    // 5. Invalid observedRuns, candidate edge cases, lane/path overlap, peer CAS capacity, and queue compaction.
    for (const badObs of [
      'not-an-array',
      [null],
      [{workId: '1:issue:1', runId: 1, runAttempt: 1, leaseGeneration: 1, runState: 'run_terminal'}],
      [{workId: '1:issue:1', runId: 1, runAttempt: 1, leaseGeneration: 1, runState: 'run_missing', conclusion: 'failure'}]
    ]) {
      assert.equal(reconcileLedgerWithWorkQueueCas({
        ...baseReq,
        observedRuns: badObs
      }).reason, 'INVALID_OBSERVED_RUNS');
    }

    for (const [cand, expectedReason] of [
      [null, 'INVALID_CANDIDATE'],
      [{repositoryId: 99, issue: 1, head, generation: 1}, 'UNCONFIGURED_REPOSITORY'],
      [{repositoryId: 2, issue: 1, head, generation: 1}, 'REPOSITORY_SCOPE_MISMATCH'],
      [{repositoryId: 1, issue: 1, head, generation: 1, targetType: 'bad'}, 'INVALID_CANDIDATE'],
      [{repositoryId: 1, issue: 1, head, generation: 1, phase: 'settled'}, 'INVALID_CANDIDATE'],
      [{repositoryId: 1, issue: 1, head, generation: 1, leaseTtlMs: 0}, 'INVALID_CANDIDATE'],
      [{repositoryId: 1, issue: 1, head, generation: 1, leaseTtlMs: MAX_CROSS_RUN_LEASE_TTL_MS + 1}, 'LEASE_TTL_EXCEEDED'],
      [{repositoryId: 1, issue: 1, head, generation: 1, maxExecutionMs: 0}, 'INVALID_CANDIDATE'],
      [{repositoryId: 1, issue: 1, head, generation: 1, maxExecutionMs: MAX_CROSS_RUN_LEASE_TTL_MS + 1}, 'LEASE_TTL_EXCEEDED'],
      [{repositoryId: 1, issue: 1, head, generation: 1, leaseTtlMs: 5000, maxExecutionMs: 4000}, 'INVALID_CANDIDATE'],
      [{repositoryId: 1, issue: 1, head, generation: 1, lane: 'BAD_LANE'}, 'INVALID_CANDIDATE'],
      [{repositoryId: 1, issue: 1, head, generation: 1}, 'CAS_LEASE_REQUIRED']
    ]) {
      assert.equal(reconcileLedgerWithWorkQueueCas({
        ...baseReq,
        candidate: cand
      }).reason, expectedReason);
    }

    // Active CAS lease owner mismatch, overlapping paths, reserved lane, and peer CAS repo capacity saturation.
    const activeTwoRepoCas = {
      schemaVersion: 1,
      protocol: 'v3',
      sequence: 2,
      nextGeneration: 3,
      entries: [
        makePrEntry({
          workId: `1:pr:10:${head}`,
          pullNumber: 10,
          generation: 1,
          attempts: 1,
          priorRuns: undefined,
          workerId: 'owner-1'
        }),
        makePrEntry({
          workId: `1:pr:11:${'d'.repeat(40)}`,
          pullNumber: 11,
          headSha: 'd'.repeat(40),
          lane: 'lane-docs',
          ownedPaths: ['docs/COORDINATOR-EVENT-JOURNAL.md'],
          generation: 2,
          attempts: 1,
          priorRuns: undefined,
          workerId: 'owner-2'
        })
      ],
      recoveryReceipts: []
    };
    const twoOid = computeWorkQueueStateOid(activeTwoRepoCas);
    const twoActiveLedgerSnap = signRawSnapshot(planSig, 2, 1000, [
      {repositoryId: 1, issue: 10, head, generation: 1, units: 2, phase: 'in-flight', validThrough: 61000, reservedAt: 1000},
      {repositoryId: 1, issue: 11, head: 'd'.repeat(40), generation: 2, units: 2, phase: 'in-flight', validThrough: 61000, reservedAt: 1000}
    ], casSigningKey, bigPlan.window);
    const oneActiveLedgerSnap = signRawSnapshot(planSig, 2, 1000, [
      {repositoryId: 1, issue: 10, head, generation: 1, units: 2, phase: 'in-flight', validThrough: 61000, reservedAt: 1000}
    ], casSigningKey, bigPlan.window);

    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      casState: activeTwoRepoCas,
      expectedRefOid: twoOid,
      candidate: {
        repositoryId: 1,
        issue: 10,
        head,
        generation: 1,
        targetType: 'pull_request',
        workerId: 'wrong-worker',
        runId: 500,
        runAttempt: 1
      }
    }).reason, 'LEASE_OWNER_MISMATCH');

    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      casState: activeTwoRepoCas,
      expectedRefOid: twoOid,
      candidate: {
        repositoryId: 1,
        issue: 10,
        head,
        generation: 2,
        targetType: 'pull_request',
        workerId: 'owner-1',
        runId: 500,
        runAttempt: 1
      }
    }).reason, 'DUPLICATE_RESERVATION');

    // Different head on already-active PR 10 fails closed with DUPLICATE_RESERVATION.
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      casState: activeTwoRepoCas,
      expectedRefOid: twoOid,
      candidate: {
        repositoryId: 1,
        issue: 10,
        head: 'e'.repeat(40),
        generation: 3,
        targetType: 'pull_request'
      }
    }).reason, 'DUPLICATE_RESERVATION');

    // Overlapping path and reserved lane on new CAS claim fail closed.
    const oneActiveCas = {
      ...activeTwoRepoCas,
      nextGeneration: 2,
      entries: [activeTwoRepoCas.entries[0]]
    };
    const oneOid = computeWorkQueueStateOid(oneActiveCas);
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      ledgerSnapshot: oneActiveLedgerSnap,
      casState: oneActiveCas,
      expectedRefOid: oneOid,
      candidate: {
        repositoryId: 1,
        issue: 99,
        head: 'e'.repeat(40),
        generation: 2,
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-other',
        ownedPaths: ['tools/engineering-factory'],
        workerId: 'worker-new',
        runId: 800,
        leaseTtlMs: 10000
      }
    }).reason, 'OWNED_PATHS_OVERLAP');

    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      ledgerSnapshot: oneActiveLedgerSnap,
      casState: oneActiveCas,
      expectedRefOid: oneOid,
      candidate: {
        repositoryId: 1,
        issue: 99,
        head: 'e'.repeat(40),
        generation: 2,
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-ledger',
        ownedPaths: ['docs/ROADMAP.md'],
        workerId: 'worker-new',
        runId: 800,
        leaseTtlMs: 10000
      }
    }).reason, 'LANE_RESERVED');

    // Peer active CAS leases (2 on repo 1, where repo 1 maxActive is 2) block a 3rd claim with REPO_CAPACITY_EXHAUSTED!
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      ledgerSnapshot: twoActiveLedgerSnap,
      casState: activeTwoRepoCas,
      expectedRefOid: twoOid,
      candidate: {
        repositoryId: 1,
        issue: 99,
        head: 'e'.repeat(40),
        generation: 3,
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-third',
        ownedPaths: ['src/other.mjs'],
        workerId: 'worker-3',
        runId: 801,
        leaseTtlMs: 10000
      }
    }).reason, 'REPO_CAPACITY_EXHAUSTED');

    // Terminal compaction at 250 CAS entries & archive ceiling at 2000, plus remainingIncludedUnits checks.
    const terminal250 = Array.from({length: 250}, (_, idx) => ({
      workId: `2:issue:${idx + 1}`,
      targetType: 'issue',
      repository: 'Jamula/SoftwareFactory',
      repositoryId: 2,
      issueNumber: idx + 1,
      pullNumber: null,
      headSha: null,
      lane: `lane-${idx + 1}`,
      ownedPaths: [`docs/f-${idx + 1}.md`],
      status: 'completed',
      generation: idx + 1,
      attempts: 1,
      maxAttempts: 3,
      workerId: 'w-done',
      runId: idx + 1,
      runAttempt: 1,
      claimedAtMs: 500,
      leaseTtlMs: 100,
      leaseExpiresAtMs: 600,
      maxExecutionMs: 100,
      executionDeadlineMs: 600
    }));
    const ledger250Snap = signRawSnapshot(
      planSig,
      2,
      1000,
      Array.from({length: 250}, (_, idx) => ({
        repositoryId: 2,
        issue: idx + 1,
        head: 'a'.repeat(40),
        generation: idx + 1,
        units: 2,
        phase: 'settled',
        validThrough: 600,
        reservedAt: 500
      })),
      casSigningKey,
      bigPlan.window
    );
    const fullCompactingCas = {
      schemaVersion: 1,
      protocol: 'v3',
      sequence: 10,
      nextGeneration: 251,
      entries: terminal250,
      recoveryReceipts: []
    };
    const compactedRes = reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      ledgerSnapshot: ledger250Snap,
      casState: fullCompactingCas,
      expectedRefOid: computeWorkQueueStateOid(fullCompactingCas),
      candidate: {
        repositoryId: 1,
        issue: 500,
        head: '9'.repeat(40),
        generation: 251,
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-ledger',
        ownedPaths: ['tools/engineering-factory/shadow-dispatch-ledger.mjs'],
        workerId: 'w-compact',
        runId: 9001,
        leaseTtlMs: 5000
      }
    });
    assert.equal(compactedRes.ok, true);
    assert.equal(compactedRes.nextCasState.entries.length, 250);
    assert.equal(compactedRes.nextCasState.archivedTerminal.length, 1);

    const archiveFullCas = {
      ...fullCompactingCas,
      archivedTerminal: Array.from({length: 2000}, (_, idx) => ({
        workId: `2:issue:${1000 + idx}`,
        status: 'exhausted'
      }))
    };
    const ledger2250Rows = [
      ...Array.from({length: 250}, (_, idx) => ({
        repositoryId: 2,
        issue: idx + 1,
        head: 'a'.repeat(40),
        generation: idx + 1,
        units: 2,
        phase: 'settled',
        validThrough: 600,
        reservedAt: 500
      })),
      ...Array.from({length: 2000}, (_, idx) => ({
        repositoryId: 2,
        issue: 1000 + idx,
        head: 'a'.repeat(40),
        generation: 1,
        units: 2,
        phase: 'expired',
        validThrough: 600,
        reservedAt: 500
      }))
    ];
    const ledger2250Snap = signRawSnapshot(planSig, 3, 1000, ledger2250Rows, casSigningKey, bigPlan.window);
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      ledgerSnapshot: ledger2250Snap,
      casState: archiveFullCas,
      expectedRefOid: computeWorkQueueStateOid(archiveFullCas),
      candidate: {
        repositoryId: 1,
        issue: 500,
        head: '9'.repeat(40),
        generation: 251,
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-ledger',
        ownedPaths: ['tools/engineering-factory/shadow-dispatch-ledger.mjs'],
        workerId: 'w-compact',
        runId: 9001,
        leaseTtlMs: 5000
      }
    }).reason, 'ARCHIVE_CAPACITY_EXHAUSTED');

    // Archived 'exhausted' vs 'completed' candidate checks and remainingIncludedUnits exhaustion.
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      ledgerSnapshot: ledger2250Snap,
      casState: archiveFullCas,
      expectedRefOid: computeWorkQueueStateOid(archiveFullCas),
      admissionEvidence: {...baseAdmission(), repositoryId: 2, approvedRepositoryId: 2, remainingIncludedUnits: 5000},
      candidate: {repositoryId: 2, issue: 1000, head: '8'.repeat(40), generation: 251}
    }).reason, 'RETRY_CEILING_EXHAUSTED');

    // Passive cleanup succeeds even when remainingIncludedUnits === 0 (Copilot 4725493439),
    // while candidate startup/admission remains blocked with CAPACITY_EXHAUSTED!
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      ledgerSnapshot: compactedRes.nextLedgerSnapshot,
      casState: compactedRes.nextCasState,
      expectedRefOid: computeWorkQueueStateOid(compactedRes.nextCasState),
      admissionEvidence: {...baseAdmission(), remainingIncludedUnits: 0},
      nowMs: 1000
    }).ok, true);

    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      ledgerSnapshot: compactedRes.nextLedgerSnapshot,
      casState: compactedRes.nextCasState,
      expectedRefOid: computeWorkQueueStateOid(compactedRes.nextCasState),
      admissionEvidence: {...baseAdmission(), remainingIncludedUnits: 1},
      candidate: {
        repositoryId: 1,
        issue: 500,
        head: '9'.repeat(40),
        generation: 251,
        phase: 'in-flight',
        workerId: 'w-compact',
        runId: 9001,
        runAttempt: 1
      },
      nowMs: 1000
    }).reason, 'CAPACITY_EXHAUSTED');

    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      casState: oneActiveCas,
      expectedRefOid: oneOid,
      admissionEvidence: {
        ...baseAdmission(),
        remainingIncludedUnits: 5000,
        ghAwCaps: {maxAiCredits: 5, maxDailyAiCredits: 10, dailyAiCreditsUsed: 8, runAiCreditsRequired: 4}
      },
      candidate: {
        repositoryId: 1,
        issue: 10,
        head,
        generation: 1,
        targetType: 'pull_request',
        workerId: 'owner-1',
        runId: 500,
        runAttempt: 1
      }
    }).reason, 'GH_AW_DAILY_AI_CREDITS_EXCEEDED');

    // Additional edge cases: cas_lease_expired trigger on active ledger row, stale/completed/exhausted CAS entries,
    // QUEUE_CAPACITY_EXCEEDED (250 active leased entries), CAPACITY_EXHAUSTED on new reserve, and STORE_FULL (10000 rows).
    const casExpiredWithLedgerSnap = signRawSnapshot(planSig, 2, 1000, [
      {repositoryId: 1, issue: 50, head: '1'.repeat(40), generation: 1, units: 2, phase: 'expired', validThrough: 1200, reservedAt: 1000},
      {repositoryId: 1, issue: 50, head: '2'.repeat(40), generation: 1, units: 2, phase: 'expired', validThrough: 1300, reservedAt: 1000},
      {repositoryId: 1, issue: 50, head, generation: 1, units: 2, phase: 'in-flight', validThrough: 9000, reservedAt: 1000}
    ], casSigningKey, bigPlan.window);
    const casExpiredEntryState = {
      schemaVersion: 1,
      protocol: 'v3',
      sequence: 1,
      nextGeneration: 2,
      entries: [{
        workId: '1:issue:50',
        targetType: 'issue',
        repository: 'Jamula/SoftwareFactory',
        repositoryId: 1,
        issueNumber: 50,
        pullNumber: null,
        headSha: null,
        lane: 'lane-ledger',
        ownedPaths: ['tools/engineering-factory/shadow-dispatch-ledger.mjs'],
        status: 'leased',
        generation: 1,
        attempts: 3,
        maxAttempts: 3,
        workerId: 'w-exp',
        runId: 77,
        runAttempt: 1,
        claimedAtMs: 1000,
        leaseTtlMs: 500,
        leaseExpiresAtMs: 1500,
        maxExecutionMs: 500,
        executionDeadlineMs: 1500
      }],
      recoveryReceipts: []
    };
    const casExpRec = reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: casExpiredWithLedgerSnap,
      signingKey: casSigningKey,
      casState: casExpiredEntryState,
      expectedRefOid: computeWorkQueueStateOid(casExpiredEntryState),
      admissionEvidence: {...baseAdmission(), observedMs: 2000, remainingIncludedUnits: 5000},
      nowMs: 2000
    });
    assert.equal(casExpRec.ok, true);
    assert.equal(casExpRec.reconciledActions[0].trigger, 'cas_lease_expired');
    assert.equal(casExpRec.nextCasState.entries[0].status, 'exhausted');

    // Candidate on exhausted non-archived CAS entry hits RETRY_CEILING_EXHAUSTED.
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: casExpRec.nextLedgerSnapshot,
      signingKey: casSigningKey,
      casState: casExpRec.nextCasState,
      expectedRefOid: computeWorkQueueStateOid(casExpRec.nextCasState),
      admissionEvidence: {...baseAdmission(), observedMs: 2000, remainingIncludedUnits: 5000},
      candidate: {
        repositoryId: 1,
        issue: 50,
        head: '8'.repeat(40),
        generation: 3,
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-ledger',
        ownedPaths: ['tools/engineering-factory/shadow-dispatch-ledger.mjs'],
        workerId: 'w-retry',
        runId: 78,
        leaseTtlMs: 5000
      },
      nowMs: 2000
    }).reason, 'RETRY_CEILING_EXHAUSTED');

    // Candidate on completed non-archived CAS entry hits DUPLICATE_RESERVATION.
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      ledgerSnapshot: ledger250Snap,
      casState: fullCompactingCas,
      expectedRefOid: computeWorkQueueStateOid(fullCompactingCas),
      admissionEvidence: {...baseAdmission(), repositoryId: 2, approvedRepositoryId: 2, remainingIncludedUnits: 5000},
      candidate: {repositoryId: 2, issue: 1, head: '8'.repeat(40), generation: 251}
    }).reason, 'DUPLICATE_RESERVATION');

    // Candidate with generation < existing ledger row generation hits STALE_LEASE_GENERATION;
    // candidate on different head while another head on same issue is active hits DUPLICATE_RESERVATION.
    const gen2RowSnap = signRawSnapshot(planSig, 2, 1000, [
      {repositoryId: 1, issue: 10, head, generation: 2, units: 2, phase: 'reserved', validThrough: 5000, reservedAt: 1000}
    ], casSigningKey, bigPlan.window);
    const gen2ActiveCas = {
      schemaVersion: 1,
      protocol: 'v3',
      sequence: 2,
      nextGeneration: 3,
      entries: [makePrEntry({workId: `1:pr:10:${head}`, pullNumber: 10, generation: 2, attempts: 1, priorRuns: undefined})],
      recoveryReceipts: []
    };
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      ledgerSnapshot: gen2RowSnap,
      casState: gen2ActiveCas,
      expectedRefOid: computeWorkQueueStateOid(gen2ActiveCas),
      candidate: {repositoryId: 1, issue: 10, head, generation: 1, targetType: 'pull_request'}
    }).reason, 'STALE_LEASE_GENERATION');
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      ledgerSnapshot: gen2RowSnap,
      casState: gen2ActiveCas,
      expectedRefOid: computeWorkQueueStateOid(gen2ActiveCas),
      candidate: {repositoryId: 1, issue: 10, head: '7'.repeat(40), generation: 3, targetType: 'pull_request'}
    }).reason, 'DUPLICATE_RESERVATION');

    // QUEUE_CAPACITY_EXCEEDED when all 250 CAS entries are requeued (non-terminal, non-evictable).
    const requeued250Cas = {
      schemaVersion: 1,
      protocol: 'v3',
      sequence: 10,
      nextGeneration: 251,
      entries: terminal250.map(e => ({
        ...e,
        status: 'requeued'
      })),
      recoveryReceipts: []
    };
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      ledgerSnapshot: ledger250Snap,
      casState: requeued250Cas,
      expectedRefOid: computeWorkQueueStateOid(requeued250Cas),
      candidate: {
        repositoryId: 1,
        issue: 500,
        head: '9'.repeat(40),
        generation: 251,
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-ledger',
        ownedPaths: ['tools/engineering-factory/shadow-dispatch-ledger.mjs'],
        workerId: 'w-qfull',
        runId: 9002,
        leaseTtlMs: 5000
      }
    }).reason, 'QUEUE_CAPACITY_EXCEEDED');

    // STORE_FULL when ledgerSnapshot already holds 10000 cancelled historical rows.
    const rows10000 = Array.from({length: 10000}, (_, idx) => ({
      repositoryId: 2,
      issue: idx + 1,
      head: '6'.repeat(40),
      generation: 1,
      units: 2,
      phase: 'cancelled',
      validThrough: 1000,
      reservedAt: 1000
    }));
    const fullLedgerSnap = signRawSnapshot(planSig, 3, 1000, rows10000, casSigningKey, bigPlan.window);
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      ledgerSnapshot: fullLedgerSnap,
      casState: oneActiveCas,
      expectedRefOid: oneOid,
      candidate: {
        repositoryId: 1,
        issue: 10,
        head,
        generation: 1,
        targetType: 'pull_request',
        workerId: 'owner-1',
        runId: 500,
        runAttempt: 1
      }
    }).reason, 'STORE_FULL');

    // CAPACITY_EXHAUSTED when new candidate units exceed remainingIncludedUnits.
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      casState: oneActiveCas,
      expectedRefOid: oneOid,
      admissionEvidence: {...baseAdmission(), remainingIncludedUnits: 1},
      candidate: {
        repositoryId: 1,
        issue: 10,
        head,
        generation: 1,
        targetType: 'pull_request',
        workerId: 'owner-1',
        runId: 500,
        runAttempt: 1
      }
    }).reason, 'CAPACITY_EXHAUSTED');

    // Reconcile without candidate enforces configured repos and per-repo/global active ceilings on CAS leases,
    // and keeps short-maxExecutionMs unstarted 'reserved' orphans importable as 'cancelled'.
    const unconfRepoCas = {
      schemaVersion: 1,
      protocol: 'v3',
      sequence: 1,
      nextGeneration: 2,
      entries: [makePrEntry({workId: `99:pr:10:${head}`, repositoryId: 99, pullNumber: 10})],
      recoveryReceipts: []
    };
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ...baseReq,
      casState: unconfRepoCas,
      expectedRefOid: computeWorkQueueStateOid(unconfRepoCas)
    }).reason, 'UNCONFIGURED_REPOSITORY');

    const smallPlan = {...plan, maxExecutionMs: 500};
    const smallLedger = openShadowDispatchLedger(':memory:', smallPlan);
    try {
      const smallSnap0 = smallLedger.exportSnapshot({signingKey: casSigningKey, now: 1000}).snapshot;
      // Repo 1 cap is 1 in smallPlan; activeTwoRepoCas has 2 active leases on repo 1 -> REPO_CAPACITY_EXHAUSTED.
      assert.equal(reconcileLedgerWithWorkQueueCas({
        ledgerSnapshot: smallSnap0,
        signingKey: casSigningKey,
        casState: activeTwoRepoCas,
        expectedRefOid: twoOid,
        admissionEvidence: baseAdmission(),
        nowMs: 1000
      }).reason, 'REPO_CAPACITY_EXHAUSTED');

      // Global maxActive is 2 in smallPlan; 1 active on repo 1 + 2 active on repo 2 = 3 -> CAPACITY_EXHAUSTED.
      const threeGlobalCas = {
        schemaVersion: 1,
        protocol: 'v3',
        sequence: 3,
        nextGeneration: 4,
        entries: [
          makePrEntry({workId: `1:pr:10:${head}`, repositoryId: 1, pullNumber: 10, generation: 1}),
          makePrEntry({
            workId: `2:pr:20:${'b'.repeat(40)}`,
            repositoryId: 2,
            pullNumber: 20,
            headSha: 'b'.repeat(40),
            lane: 'lane-a',
            ownedPaths: ['docs/a.md'],
            generation: 2
          }),
          makePrEntry({
            workId: `2:pr:21:${'c'.repeat(40)}`,
            repositoryId: 2,
            pullNumber: 21,
            headSha: 'c'.repeat(40),
            lane: 'lane-b',
            ownedPaths: ['docs/b.md'],
            generation: 3
          })
        ],
        recoveryReceipts: []
      };
      assert.equal(reconcileLedgerWithWorkQueueCas({
        ledgerSnapshot: smallSnap0,
        signingKey: casSigningKey,
        casState: threeGlobalCas,
        expectedRefOid: computeWorkQueueStateOid(threeGlobalCas),
        admissionEvidence: baseAdmission(),
        nowMs: 1000
      }).reason, 'CAPACITY_EXHAUSTED');

      // Unstarted 'reserved' row with validThrough=61000 under maxExecutionMs=500 reconciles to 'cancelled'
      // and imports cleanly into smallLedger without deadline failure.
      const shortReservedSnap = signRawSnapshot(smallSnap0.planSignature, 2, 1000, [
        {repositoryId: 1, issue: 10, head, generation: 1, units: 2, phase: 'reserved', validThrough: 61000, reservedAt: 1000}
      ], casSigningKey, smallPlan.window);
      const completedIssueCas = {
        schemaVersion: 1,
        protocol: 'v3',
        sequence: 2,
        nextGeneration: 3,
        entries: [{
          workId: '1:issue:10',
          targetType: 'issue',
          repository: 'Jamula/SoftwareFactory',
          repositoryId: 1,
          issueNumber: 10,
          pullNumber: null,
          headSha: null,
          lane: 'lane-ledger',
          ownedPaths: ['tools/engineering-factory/shadow-dispatch-ledger.mjs'],
          status: 'completed',
          generation: 2,
          attempts: 1,
          maxAttempts: 3,
          workerId: 'w-done',
          runId: 50,
          runAttempt: 1,
          claimedAtMs: 1000,
          leaseTtlMs: 400,
          leaseExpiresAtMs: 1400,
          maxExecutionMs: 400,
          executionDeadlineMs: 1400
        }],
        recoveryReceipts: []
      };
      const shortRec = reconcileLedgerWithWorkQueueCas({
        ledgerSnapshot: shortReservedSnap,
        signingKey: casSigningKey,
        casState: completedIssueCas,
        expectedRefOid: computeWorkQueueStateOid(completedIssueCas),
        admissionEvidence: {...baseAdmission(), observedMs: 1200},
        nowMs: 1200
      });
      assert.equal(shortRec.ok, true);
      assert.equal(shortRec.reconciledActions[0].toPhase, 'cancelled');
      assert.equal(smallLedger.importSnapshot(shortRec.nextLedgerSnapshot, {
        signingKey: casSigningKey,
        now: 1200
      }).reason, 'SHADOW_SNAPSHOT_IMPORTED');
    } finally {
      smallLedger.close();
    }
  } finally {
    ledger.close();
  }
});

test('remediates all 7 Codex and Copilot review findings: repository scope, billing/quota freshness, cross-run ledger completeness, owner/head binding, and start-time daily credit caps', () => {
  assert.equal(computeReservationHeadLock(0, 1, head, 1), null);
  assert.equal(computeReservationHeadLock(1, 0, head, 1), null);
  assert.equal(computeReservationHeadLock(1, 1, 'bad', 1), null);
  assert.equal(computeReservationHeadLock(1, 1, head, 0), null);

  const tightPlan = {
    window: 'review-regression-window',
    maxActive: 2,
    includedUnits: 2,
    unitsPerRun: 2,
    maxExecutionMs: 300000,
    repositories: [{repositoryId: 1, maxActive: 2}, {repositoryId: 2, maxActive: 2}]
  };
  const ledger = openShadowDispatchLedger(':memory:', tightPlan);
  try {
    const emptySnap = ledger.exportSnapshot({signingKey: casSigningKey, now: 1000}).snapshot;

    // 1. Missing repositoryId / approvedRepositoryId or unscoped admission is rejected (Codex 4725368189, Copilot 4725378397).
    const unscopedAdmission = baseAdmission();
    delete unscopedAdmission.repositoryId;
    delete unscopedAdmission.approvedRepositoryId;
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: emptySnap,
      signingKey: casSigningKey,
      casState: null,
      expectedRefOid: ZERO_GIT_OID,
      admissionEvidence: {...unscopedAdmission, remainingIncludedUnits: 2},
      candidate: {
        repositoryId: 1,
        issue: 12,
        head,
        generation: 1,
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-ledger',
        ownedPaths: ['tools/engineering-factory/shadow-dispatch-ledger.mjs'],
        workerId: 'w-1',
        runId: 101,
        leaseTtlMs: 30000
      },
      nowMs: 1000
    }).reason, 'REPOSITORY_SCOPE_MISMATCH');

    // 2. Missing affirmative billing verification flags, observedMs, or remainingIncludedUnits is rejected (Copilot 4725378420).
    for (const [omittedKey, expectedReason] of [
      ['authorityVerified', 'BILLING_AUTHORITY_UNVERIFIED'],
      ['entitlementVerified', 'BILLING_AUTHORITY_UNVERIFIED'],
      ['hardStopEnforced', 'OVERAGE_HARD_STOP_REQUIRED'],
      ['observedMs', 'STALE_ADMISSION_EVIDENCE'],
      ['remainingIncludedUnits', 'BUDGET_UNKNOWN']
    ]) {
      const adm = {...baseAdmission(), remainingIncludedUnits: 2};
      delete adm[omittedKey];
      assert.equal(reconcileLedgerWithWorkQueueCas({
        ledgerSnapshot: emptySnap,
        signingKey: casSigningKey,
        casState: null,
        expectedRefOid: ZERO_GIT_OID,
        admissionEvidence: adm,
        nowMs: 1000
      }).reason, expectedReason);
    }

    // 3. Reserve first run cleanly (consumes 2 of 2 includedUnits).
    const first = reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: emptySnap,
      signingKey: casSigningKey,
      casState: null,
      expectedRefOid: ZERO_GIT_OID,
      admissionEvidence: {...baseAdmission(), remainingIncludedUnits: 2},
      candidate: {
        repositoryId: 1,
        issue: 12,
        head,
        generation: 1,
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-ledger',
        ownedPaths: ['tools/engineering-factory/shadow-dispatch-ledger.mjs'],
        workerId: 'w-1',
        runId: 101,
        runAttempt: 1,
        leaseTtlMs: 30000
      },
      nowMs: 1000
    });
    assert.equal(first.ok, true);
    assert.equal(first.reason, 'CROSS_RUN_CAS_RESERVED');

    // 4. Cold runner reusing empty/stale ledgerSnapshot against CAS state with an active peer reservation
    // fails closed with STALE_OR_INCOMPLETE_LEDGER on candidate admission AND CAPACITY_EXHAUSTED when
    // unaccounted CAS units exceed remainingIncludedUnits (Codex 4725368181, Copilot 4725378433).
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: emptySnap,
      signingKey: casSigningKey,
      casState: first.nextCasState,
      expectedRefOid: first.nextRefOid,
      admissionEvidence: {...baseAdmission(), remainingIncludedUnits: 2},
      candidate: {
        repositoryId: 1,
        issue: 13,
        head: 'b'.repeat(40),
        generation: 2,
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-docs',
        ownedPaths: ['docs/COORDINATOR-EVENT-JOURNAL.md'],
        workerId: 'w-2',
        runId: 102,
        runAttempt: 1,
        leaseTtlMs: 30000
      },
      nowMs: 1000
    }).reason, 'STALE_OR_INCOMPLETE_LEDGER');

    // Passive reconcile with empty snapshot against checkpoint-bound CAS fails with STALE_OR_INCOMPLETE_LEDGER,
    // and passive reconcile when unaccounted CAS runs exceed plan.includedUnits fails with CAPACITY_EXHAUSTED.
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: emptySnap,
      signingKey: casSigningKey,
      casState: first.nextCasState,
      expectedRefOid: first.nextRefOid,
      admissionEvidence: {...baseAdmission(), remainingIncludedUnits: 1},
      nowMs: 1000
    }).reason, 'STALE_OR_INCOMPLETE_LEDGER');

    const overPlanCas = {
      schemaVersion: 1,
      protocol: 'v3',
      sequence: 2,
      nextGeneration: 3,
      entries: [
        {
          workId: '1:issue:70',
          targetType: 'issue',
          repository: 'Jamula/SoftwareFactory',
          repositoryId: 1,
          issueNumber: 70,
          pullNumber: null,
          headSha: null,
          lane: 'lane-a',
          ownedPaths: ['docs/a.md'],
          status: 'completed',
          generation: 1,
          attempts: 1,
          maxAttempts: 3,
          workerId: 'w-a',
          runId: 701,
          runAttempt: 1,
          claimedAtMs: 500,
          leaseTtlMs: 100,
          leaseExpiresAtMs: 600,
          maxExecutionMs: 100,
          executionDeadlineMs: 600
        },
        {
          workId: '1:issue:71',
          targetType: 'issue',
          repository: 'Jamula/SoftwareFactory',
          repositoryId: 1,
          issueNumber: 71,
          pullNumber: null,
          headSha: null,
          lane: 'lane-b',
          ownedPaths: ['docs/b.md'],
          status: 'completed',
          generation: 2,
          attempts: 1,
          maxAttempts: 3,
          workerId: 'w-b',
          runId: 702,
          runAttempt: 1,
          claimedAtMs: 500,
          leaseTtlMs: 100,
          leaseExpiresAtMs: 600,
          maxExecutionMs: 100,
          executionDeadlineMs: 600
        }
      ],
      recoveryReceipts: []
    };
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: emptySnap,
      signingKey: casSigningKey,
      casState: overPlanCas,
      expectedRefOid: computeWorkQueueStateOid(overPlanCas),
      admissionEvidence: {...baseAdmission(), remainingIncludedUnits: 0},
      nowMs: 1000
    }).reason, 'CAPACITY_EXHAUSTED');

    // Also blocks incomplete PR / archived PR history against empty snapshot.
    const archivedPrCas = {
      schemaVersion: 1,
      protocol: 'v3',
      sequence: 1,
      nextGeneration: 2,
      entries: [],
      recoveryReceipts: [],
      archivedTerminal: [{workId: `1:pr:88:${head}`, status: 'completed'}]
    };
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: emptySnap,
      signingKey: casSigningKey,
      casState: archivedPrCas,
      expectedRefOid: computeWorkQueueStateOid(archivedPrCas),
      admissionEvidence: {...baseAdmission(), remainingIncludedUnits: 2},
      candidate: {
        repositoryId: 1,
        issue: 89,
        head: 'b'.repeat(40),
        generation: 2,
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-docs',
        ownedPaths: ['docs/COORDINATOR-EVENT-JOURNAL.md'],
        workerId: 'w-2',
        runId: 102,
        leaseTtlMs: 30000
      },
      nowMs: 1000
    }).reason, 'STALE_OR_INCOMPLETE_LEDGER');

    // 5. Binding an existing active CAS lease requires explicit matching (workerId, runId, runAttempt)
    // AND matching SHA-256 head-binding lockSha256 (Codex 4725368188).
    // Omitting workerId/runId/runAttempt fails closed with LEASE_OWNER_MISMATCH:
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: emptySnap,
      signingKey: casSigningKey,
      casState: first.nextCasState,
      expectedRefOid: first.nextRefOid,
      admissionEvidence: {...baseAdmission(), remainingIncludedUnits: 2},
      candidate: {
        repositoryId: 1,
        issue: 12,
        head,
        generation: 1,
        phase: 'in-flight'
      },
      nowMs: 1000
    }).reason, 'LEASE_OWNER_MISMATCH');

    // Attempting to bind a different head B against Issue 12's head-locked CAS lease fails closed with HEAD_BINDING_MISMATCH:
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: emptySnap,
      signingKey: casSigningKey,
      casState: first.nextCasState,
      expectedRefOid: first.nextRefOid,
      admissionEvidence: {...baseAdmission(), remainingIncludedUnits: 2},
      candidate: {
        repositoryId: 1,
        issue: 12,
        head: 'b'.repeat(40),
        generation: 1,
        phase: 'in-flight',
        workerId: 'w-1',
        runId: 101,
        runAttempt: 1
      },
      nowMs: 1000
    }).reason, 'HEAD_BINDING_MISMATCH');

    // Even the legitimate worker replaying emptySnap on the SAME head against an already ledger-bound CAS lease
    // fails closed with STALE_OR_INCOMPLETE_LEDGER:
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: emptySnap,
      signingKey: casSigningKey,
      casState: first.nextCasState,
      expectedRefOid: first.nextRefOid,
      admissionEvidence: {...baseAdmission(), remainingIncludedUnits: 2},
      candidate: {
        repositoryId: 1,
        issue: 12,
        head,
        generation: 1,
        workerId: 'w-1',
        runId: 101,
        runAttempt: 1
      },
      nowMs: 1000
    }).reason, 'STALE_OR_INCOMPLETE_LEDGER');

    // Pre-claimed external CAS lease with computeReservationHeadLock binds once, upgrades lockSha256, and fences replay:
    const externalPreClaimedCas = {
      schemaVersion: 1,
      protocol: 'v3',
      sequence: 1,
      nextGeneration: 2,
      entries: [{
        workId: '1:issue:12',
        targetType: 'issue',
        repository: 'Jamula/SoftwareFactory',
        repositoryId: 1,
        issueNumber: 12,
        pullNumber: null,
        headSha: null,
        lane: 'lane-ledger',
        ownedPaths: ['tools/engineering-factory/shadow-dispatch-ledger.mjs'],
        status: 'leased',
        generation: 1,
        attempts: 1,
        maxAttempts: 3,
        workerId: 'w-ext',
        runId: 202,
        runAttempt: 1,
        claimedAtMs: 1000,
        leaseTtlMs: 30000,
        leaseExpiresAtMs: 31000,
        maxExecutionMs: 30000,
        executionDeadlineMs: 31000,
        lockSha256: computeReservationHeadLock(1, 12, head, 1)
      }],
      recoveryReceipts: []
    };
    const extBind = reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: emptySnap,
      signingKey: casSigningKey,
      casState: externalPreClaimedCas,
      expectedRefOid: computeWorkQueueStateOid(externalPreClaimedCas),
      admissionEvidence: {...baseAdmission(), remainingIncludedUnits: 2},
      candidate: {
        repositoryId: 1,
        issue: 12,
        head,
        generation: 1,
        workerId: 'w-ext',
        runId: 202,
        runAttempt: 1
      },
      nowMs: 1000
    });
    assert.equal(extBind.ok, true);
    assert.equal(extBind.casMutationRequired, true);
    assert.notEqual(extBind.nextRefOid, computeWorkQueueStateOid(externalPreClaimedCas));

    // Claiming a new lease with a forged lockSha256 also fails closed with HEAD_BINDING_MISMATCH:
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: emptySnap,
      signingKey: casSigningKey,
      casState: null,
      expectedRefOid: ZERO_GIT_OID,
      admissionEvidence: {...baseAdmission(), remainingIncludedUnits: 2},
      candidate: {
        repositoryId: 1,
        issue: 12,
        head,
        generation: 1,
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-ledger',
        ownedPaths: ['tools/engineering-factory/shadow-dispatch-ledger.mjs'],
        workerId: 'w-1',
        runId: 101,
        leaseTtlMs: 30000,
        lockSha256: 'f'.repeat(64)
      },
      nowMs: 1000
    }).reason, 'HEAD_BINDING_MISMATCH');

    // 6. Advancing 'reserved' -> 'in-flight' rechecks projected daily AI credits (Copilot 4725378458).
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: first.nextLedgerSnapshot,
      signingKey: casSigningKey,
      casState: first.nextCasState,
      expectedRefOid: first.nextRefOid,
      admissionEvidence: {
        ...baseAdmission(),
        observedMs: 1200,
        remainingIncludedUnits: 2,
        ghAwCaps: {
          maxAiCredits: 5,
          maxDailyAiCredits: 10,
          dailyAiCreditsUsed: 8,
          runAiCreditsRequired: 4
        }
      },
      candidate: {
        repositoryId: 1,
        issue: 12,
        head,
        generation: 1,
        phase: 'in-flight',
        workerId: 'w-1',
        runId: 101,
        runAttempt: 1
      },
      nowMs: 1200
    }).reason, 'GH_AW_DAILY_AI_CREDITS_EXCEEDED');
  } finally {
    ledger.close();
  }
});

test('remediates Round 2 review findings: started c2 lock, compaction attempt/checkpoint fidelity, cross-target subject isolation, issue lock requirement, peer AI-credit projection, and zero-quota cleanup', () => {
  const round2Plan = {
    window: 'round2-regression-window',
    maxActive: 4,
    includedUnits: 600,
    unitsPerRun: 2,
    maxExecutionMs: 300000,
    repositories: [{repositoryId: 1, maxActive: 3}, {repositoryId: 2, maxActive: 3}]
  };
  const ledger = openShadowDispatchLedger(':memory:', round2Plan);
  try {
    const snap0 = ledger.exportSnapshot({signingKey: casSigningKey, now: 1000}).snapshot;
    const planSig = snap0.planSignature;

    // 1 & 5. Persist started ('c2') phase in CAS lockSha256 and reject replaying pre-start 'reserved' snapshot
    // after startup is committed (Codex 4725484777 & Copilot 4725493410).
    const reservedRes = reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: snap0,
      signingKey: casSigningKey,
      casState: null,
      expectedRefOid: ZERO_GIT_OID,
      admissionEvidence: {...baseAdmission(), remainingIncludedUnits: 10},
      candidate: {
        repositoryId: 1,
        issue: 12,
        head,
        generation: 1,
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-ledger',
        ownedPaths: ['tools/engineering-factory/shadow-dispatch-ledger.mjs'],
        workerId: 'w-start',
        runId: 301,
        runAttempt: 1,
        leaseTtlMs: 30000
      },
      nowMs: 1000
    });
    assert.equal(reservedRes.ok, true);
    assert.equal(reservedRes.nextCasState.entries[0].lockSha256.startsWith('c1'), true);

    const startedRes = reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: reservedRes.nextLedgerSnapshot,
      signingKey: casSigningKey,
      casState: {
        ref: PROTECTED_WORK_QUEUE_REF,
        oid: reservedRes.nextRefOid,
        state: reservedRes.nextCasState
      },
      expectedRefOid: reservedRes.nextRefOid,
      admissionEvidence: {...baseAdmission(), observedMs: 1200, remainingIncludedUnits: 10},
      candidate: {
        repositoryId: 1,
        issue: 12,
        head,
        generation: 1,
        phase: 'in-flight',
        workerId: 'w-start',
        runId: 301,
        runAttempt: 1
      },
      nowMs: 1200
    });
    assert.equal(startedRes.ok, true);
    assert.equal(startedRes.reason, 'CROSS_RUN_CAS_SIMULATION_STARTED');
    assert.equal(startedRes.nextCasState.entries[0].lockSha256.startsWith('c2'), true);

    // Replaying the earlier signed 'reserved' snapshot against the started CAS OID fails closed!
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: reservedRes.nextLedgerSnapshot,
      signingKey: casSigningKey,
      casState: {
        ref: PROTECTED_WORK_QUEUE_REF,
        oid: startedRes.nextRefOid,
        state: startedRes.nextCasState
      },
      expectedRefOid: startedRes.nextRefOid,
      admissionEvidence: {...baseAdmission(), observedMs: 1300, remainingIncludedUnits: 10},
      candidate: {
        repositoryId: 1,
        issue: 12,
        head,
        generation: 1,
        phase: 'in-flight',
        workerId: 'w-start',
        runId: 301,
        runAttempt: 1
      },
      nowMs: 1300
    }).reason, 'STALE_OR_INCOMPLETE_LEDGER');

    // 4. Require a bound lock for issue phase advances — unlocked external issue lease + signed reserved row fails closed (Copilot 4725493396).
    const unlockedExternalIssueCas = {
      schemaVersion: 1,
      protocol: 'v3',
      sequence: 1,
      nextGeneration: 2,
      entries: [{
        workId: '1:issue:12',
        targetType: 'issue',
        repository: 'Jamula/SoftwareFactory',
        repositoryId: 1,
        issueNumber: 12,
        pullNumber: null,
        headSha: null,
        lane: 'lane-ledger',
        ownedPaths: ['tools/engineering-factory/shadow-dispatch-ledger.mjs'],
        status: 'leased',
        generation: 1,
        attempts: 1,
        maxAttempts: 3,
        workerId: 'w-start',
        runId: 301,
        runAttempt: 1,
        claimedAtMs: 1000,
        leaseTtlMs: 30000,
        leaseExpiresAtMs: 31000,
        maxExecutionMs: 30000,
        executionDeadlineMs: 31000
      }],
      recoveryReceipts: []
    };
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: reservedRes.nextLedgerSnapshot,
      signingKey: casSigningKey,
      casState: unlockedExternalIssueCas,
      expectedRefOid: computeWorkQueueStateOid(unlockedExternalIssueCas),
      admissionEvidence: {...baseAdmission(), observedMs: 1200, remainingIncludedUnits: 10},
      candidate: {
        repositoryId: 1,
        issue: 12,
        head,
        generation: 1,
        phase: 'in-flight',
        workerId: 'w-start',
        runId: 301,
        runAttempt: 1
      },
      nowMs: 1200
    }).reason, 'HEAD_BINDING_MISMATCH');

    // 3. Reject duplicate worker leases across issue and PR targets sharing the same numeric subject (Copilot 4725493381).
    const dualTargetCas = {
      schemaVersion: 1,
      protocol: 'v3',
      sequence: 2,
      nextGeneration: 3,
      entries: [
        {
          workId: '1:issue:42',
          targetType: 'issue',
          repository: 'Jamula/SoftwareFactory',
          repositoryId: 1,
          issueNumber: 42,
          pullNumber: null,
          headSha: null,
          lane: 'lane-a',
          ownedPaths: ['docs/a.md'],
          status: 'leased',
          generation: 1,
          attempts: 1,
          maxAttempts: 3,
          workerId: 'w-issue',
          runId: 401,
          runAttempt: 1,
          claimedAtMs: 1000,
          leaseTtlMs: 30000,
          leaseExpiresAtMs: 31000,
          maxExecutionMs: 30000,
          executionDeadlineMs: 31000
        },
        {
          workId: `1:pr:42:${head}`,
          targetType: 'pull_request',
          repository: 'Jamula/SoftwareFactory',
          repositoryId: 1,
          issueNumber: null,
          pullNumber: 42,
          headSha: head,
          lane: 'lane-b',
          ownedPaths: ['docs/b.md'],
          status: 'leased',
          generation: 2,
          attempts: 1,
          maxAttempts: 3,
          workerId: 'w-pr',
          runId: 402,
          runAttempt: 1,
          claimedAtMs: 1000,
          leaseTtlMs: 30000,
          leaseExpiresAtMs: 31000,
          maxExecutionMs: 30000,
          executionDeadlineMs: 31000
        }
      ],
      recoveryReceipts: []
    };
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: snap0,
      signingKey: casSigningKey,
      casState: dualTargetCas,
      expectedRefOid: computeWorkQueueStateOid(dualTargetCas),
      admissionEvidence: {...baseAdmission(), remainingIncludedUnits: 10},
      nowMs: 1000
    }).reason, 'ACTIVE_CAS_LEASE_CONFLICT');

    // Candidate PR #42 is also rejected with DUPLICATE_RESERVATION when Issue #42 holds an active lease:
    const singleIssue42Cas = {
      ...dualTargetCas,
      nextGeneration: 2,
      entries: [dualTargetCas.entries[0]]
    };
    const issue42Snap = signRawSnapshot(planSig, 2, 1000, [
      {repositoryId: 1, issue: 42, head: '1'.repeat(40), generation: 1, units: 2, phase: 'in-flight', validThrough: 31000, reservedAt: 1000}
    ], casSigningKey, round2Plan.window);
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: issue42Snap,
      signingKey: casSigningKey,
      casState: singleIssue42Cas,
      expectedRefOid: computeWorkQueueStateOid(singleIssue42Cas),
      admissionEvidence: {...baseAdmission(), remainingIncludedUnits: 10},
      candidate: {
        repositoryId: 1,
        issue: 42,
        head: '2'.repeat(40),
        generation: 2,
        targetType: 'pull_request',
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-b',
        ownedPaths: ['docs/b.md'],
        workerId: 'w-pr',
        runId: 402,
        leaseTtlMs: 30000
      },
      nowMs: 1000
    }).reason, 'DUPLICATE_RESERVATION');

    // 6. Include peer active reservations' AI-credit commitments in maxDailyAiCredits projections (Copilot 4725493426):
    // Candidate 1 (dailyAiCreditsUsed=6, runAiCreditsRequired=4, maxDailyAiCredits=10) succeeds (6 + 0 + 4 = 10),
    // while disjoint Candidate 2 on the successive CAS state fails closed (6 + 4 + 4 = 14 > 10)!
    const creditCaps = {
      maxAiCredits: 5,
      maxDailyAiCredits: 10,
      dailyAiCreditsUsed: 6,
      runAiCreditsRequired: 4
    };
    const creditCand1 = reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: snap0,
      signingKey: casSigningKey,
      casState: null,
      expectedRefOid: ZERO_GIT_OID,
      admissionEvidence: {...baseAdmission(), remainingIncludedUnits: 10, ghAwCaps: creditCaps},
      candidate: {
        repositoryId: 1,
        issue: 60,
        head: '1'.repeat(40),
        generation: 1,
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-a',
        ownedPaths: ['docs/a.md'],
        workerId: 'w-c1',
        runId: 601,
        leaseTtlMs: 30000
      },
      nowMs: 1000
    });
    assert.equal(creditCand1.ok, true);

    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: creditCand1.nextLedgerSnapshot,
      signingKey: casSigningKey,
      casState: {
        ref: PROTECTED_WORK_QUEUE_REF,
        oid: creditCand1.nextRefOid,
        state: creditCand1.nextCasState
      },
      expectedRefOid: creditCand1.nextRefOid,
      admissionEvidence: {...baseAdmission(), remainingIncludedUnits: 10, ghAwCaps: creditCaps},
      candidate: {
        repositoryId: 1,
        issue: 61,
        head: '2'.repeat(40),
        generation: 2,
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-b',
        ownedPaths: ['docs/b.md'],
        workerId: 'w-c2',
        runId: 602,
        leaseTtlMs: 30000
      },
      nowMs: 1000
    }).reason, 'GH_AW_DAILY_AI_CREDITS_EXCEEDED');

    // Invalid dailyUsageIncludesReservations type fails closed with GH_AW_SOFT_CAPS_INVALID:
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: snap0,
      signingKey: casSigningKey,
      casState: null,
      expectedRefOid: ZERO_GIT_OID,
      admissionEvidence: {
        ...baseAdmission(),
        remainingIncludedUnits: 10,
        ghAwCaps: {...creditCaps, dailyUsageIncludesReservations: 'yes'}
      },
      nowMs: 1000
    }).reason, 'GH_AW_SOFT_CAPS_INVALID');

    // 2. Compaction preserves multi-attempt & charge fidelity via recoveryReceipts AND CAS checkpoint lock (Copilot 4725493369):
    const threeAttemptArchivedCas = {
      schemaVersion: 1,
      protocol: 'v3',
      sequence: 5,
      nextGeneration: 6,
      entries: [],
      recoveryReceipts: [
        {
          workId: '1:issue:90',
          repositoryId: 1,
          targetType: 'issue',
          runState: 'worker_terminated',
          conclusion: null,
          previousRunId: 901,
          previousRunAttempt: 1,
          previousGeneration: 1,
          reclaimedGeneration: 2,
          attempts: 1,
          maxAttempts: 3,
          outcome: 'requeued',
          reclaimedAtMs: 600
        },
        {
          workId: '1:issue:90',
          repositoryId: 1,
          targetType: 'issue',
          runState: 'worker_terminated',
          conclusion: null,
          previousRunId: 902,
          previousRunAttempt: 1,
          previousGeneration: 3,
          reclaimedGeneration: 4,
          attempts: 2,
          maxAttempts: 3,
          outcome: 'requeued',
          reclaimedAtMs: 800
        }
      ],
      archivedTerminal: [{workId: '1:issue:90', status: 'completed'}]
    };
    const oneAttemptStaleSnap = signRawSnapshot(planSig, 2, 1000, [
      {repositoryId: 1, issue: 90, head: '1'.repeat(40), generation: 1, units: 2, phase: 'expired', validThrough: 600, reservedAt: 500}
    ], casSigningKey, round2Plan.window);
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: oneAttemptStaleSnap,
      signingKey: casSigningKey,
      casState: threeAttemptArchivedCas,
      expectedRefOid: computeWorkQueueStateOid(threeAttemptArchivedCas),
      admissionEvidence: {...baseAdmission(), remainingIncludedUnits: 10},
      candidate: {
        repositoryId: 1,
        issue: 91,
        head: '9'.repeat(40),
        generation: 6,
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-a',
        ownedPaths: ['docs/a.md'],
        workerId: 'w-91',
        runId: 910,
        leaseTtlMs: 30000
      },
      nowMs: 1000
    }).reason, 'STALE_OR_INCOMPLETE_LEDGER');

    // 7. Terminal-run & expiry cleanup succeeds when remainingIncludedUnits === 0, while starts/admissions stay blocked (Copilot 4725493439):
    const cleanupRes = reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: startedRes.nextLedgerSnapshot,
      signingKey: casSigningKey,
      casState: {
        ref: PROTECTED_WORK_QUEUE_REF,
        oid: startedRes.nextRefOid,
        state: startedRes.nextCasState
      },
      expectedRefOid: startedRes.nextRefOid,
      admissionEvidence: {...baseAdmission(), observedMs: 2000, remainingIncludedUnits: 0},
      observedRuns: [{
        workId: '1:issue:12',
        runId: 301,
        runAttempt: 1,
        leaseGeneration: 1,
        runState: 'run_terminal',
        conclusion: 'success'
      }],
      nowMs: 2000
    });
    assert.equal(cleanupRes.ok, true);
    assert.equal(cleanupRes.casMutationRequired, true);
    assert.equal(cleanupRes.ledgerMutationRequired, true);
    assert.equal(cleanupRes.nextCasState.entries[0].status, 'completed');
    assert.equal(cleanupRes.reconciledActions[0].toPhase, 'settled');
  } finally {
    ledger.close();
  }
});

test('remediates Round 3 review findings: unstarted expiry budget release, receipt-rollover compaction, exact peer AI credits, startup credit dedup, cumulative vs remaining quota, and renewable in-flight deadlines', () => {
  // 1. Codex 4725538942: Unstarted 'c1' reservation that expires before starting releases its budget cleanly.
  const twoUnitPlan = {
    window: 'round3-two-unit-window',
    maxActive: 2,
    includedUnits: 2,
    unitsPerRun: 2,
    maxExecutionMs: 300000,
    repositories: [{repositoryId: 1, maxActive: 2}]
  };
  const twoUnitLedger = openShadowDispatchLedger(':memory:', twoUnitPlan);
  try {
    const empty2Snap = twoUnitLedger.exportSnapshot({signingKey: casSigningKey, now: 1000}).snapshot;
    const res1 = reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: empty2Snap,
      signingKey: casSigningKey,
      casState: null,
      expectedRefOid: ZERO_GIT_OID,
      admissionEvidence: {...baseAdmission(), remainingIncludedUnits: 2},
      candidate: {
        repositoryId: 1,
        issue: 10,
        head: '1'.repeat(40),
        generation: 1,
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-a',
        ownedPaths: ['docs/a.md'],
        workerId: 'w-exp',
        runId: 10,
        leaseTtlMs: 500
      },
      nowMs: 1000
    });
    assert.equal(res1.ok, true);

    // Let reservation expire at nowMs = 2000 (> 1500) without starting; passive cleanup marks row 'cancelled'.
    const expiredCleanup = reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: res1.nextLedgerSnapshot,
      signingKey: casSigningKey,
      casState: {
        ref: PROTECTED_WORK_QUEUE_REF,
        oid: res1.nextRefOid,
        state: res1.nextCasState
      },
      expectedRefOid: res1.nextRefOid,
      admissionEvidence: {...baseAdmission(), observedMs: 2000, remainingIncludedUnits: 2},
      nowMs: 2000
    });
    assert.equal(expiredCleanup.ok, true);
    assert.equal(expiredCleanup.nextLedgerSnapshot.reservations[0].phase, 'cancelled');
    assert.equal(expiredCleanup.nextCasState.entries[0].status, 'requeued');

    // Reserving a different issue now succeeds because unstarted 'cancelled' reservation released all 2 units!
    const res2 = reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: expiredCleanup.nextLedgerSnapshot,
      signingKey: casSigningKey,
      casState: {
        ref: PROTECTED_WORK_QUEUE_REF,
        oid: expiredCleanup.nextRefOid,
        state: expiredCleanup.nextCasState
      },
      expectedRefOid: expiredCleanup.nextRefOid,
      admissionEvidence: {...baseAdmission(), observedMs: 2100, remainingIncludedUnits: 2},
      candidate: {
        repositoryId: 1,
        issue: 11,
        head: '2'.repeat(40),
        generation: 3,
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-b',
        ownedPaths: ['docs/b.md'],
        workerId: 'w-next',
        runId: 11,
        leaseTtlMs: 5000
      },
      nowMs: 2100
    });
    assert.equal(res2.ok, true);
    assert.equal(res2.reason, 'CROSS_RUN_CAS_RESERVED');
  } finally {
    twoUnitLedger.close();
  }

  // 2. Copilot 4725546493 & 4725546503: Sum each peer's actual persisted credit commitment (8 + 1 + 4 = 13 > 12),
  // fail closed when peer commitments are unknown, and avoid double-counting target startup when dailyUsageIncludesReservations === true.
  const sixUnitPlan = {
    window: 'round3-six-unit-window',
    maxActive: 4,
    includedUnits: 6,
    unitsPerRun: 2,
    maxExecutionMs: 300000,
    repositories: [{repositoryId: 1, maxActive: 4}, {repositoryId: 2, maxActive: 4}]
  };
  const sixUnitLedger = openShadowDispatchLedger(':memory:', sixUnitPlan);
  try {
    const empty6Snap = sixUnitLedger.exportSnapshot({signingKey: casSigningKey, now: 1000}).snapshot;

    // Reserve an 8-credit run (dailyAiCreditsUsed = 4, maxDailyAiCredits = 12 -> 4 + 8 = 12 <= 12):
    const eightCreditRun = reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: empty6Snap,
      signingKey: casSigningKey,
      casState: null,
      expectedRefOid: ZERO_GIT_OID,
      admissionEvidence: {
        ...baseAdmission(),
        remainingIncludedUnits: 6,
        ghAwCaps: {
          maxAiCredits: 10,
          maxDailyAiCredits: 12,
          dailyAiCreditsUsed: 4,
          runAiCreditsRequired: 8
        }
      },
      candidate: {
        repositoryId: 1,
        issue: 20,
        head: '1'.repeat(40),
        generation: 1,
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-a',
        ownedPaths: ['docs/a.md'],
        workerId: 'w-8c',
        runId: 201,
        leaseTtlMs: 30000
      },
      nowMs: 1000
    });
    assert.equal(eightCreditRun.ok, true);

    // Subsequent disjoint 1-credit run projects 4 + 8 (persisted peer!) + 1 = 13 > 12 -> GH_AW_DAILY_AI_CREDITS_EXCEEDED!
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: eightCreditRun.nextLedgerSnapshot,
      signingKey: casSigningKey,
      casState: {
        ref: PROTECTED_WORK_QUEUE_REF,
        oid: eightCreditRun.nextRefOid,
        state: eightCreditRun.nextCasState
      },
      expectedRefOid: eightCreditRun.nextRefOid,
      admissionEvidence: {
        ...baseAdmission(),
        remainingIncludedUnits: 6,
        ghAwCaps: {
          maxAiCredits: 10,
          maxDailyAiCredits: 12,
          dailyAiCreditsUsed: 4,
          runAiCreditsRequired: 1
        }
      },
      candidate: {
        repositoryId: 1,
        issue: 21,
        head: '2'.repeat(40),
        generation: 2,
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-b',
        ownedPaths: ['docs/b.md'],
        workerId: 'w-1c',
        runId: 202,
        leaseTtlMs: 30000
      },
      nowMs: 1000
    }).reason, 'GH_AW_DAILY_AI_CREDITS_EXCEEDED');

    // Startup of the 8-credit reservation with dailyUsageIncludesReservations: true and dailyAiCreditsUsed = 12
    // adds 0 new commitment (12 + (8 - 8) = 12 <= 12) AND keeps validThrough at executionDeadlineMs (301200) rather than leaseExpiresAtMs (31000)!
    const startedEight = reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: eightCreditRun.nextLedgerSnapshot,
      signingKey: casSigningKey,
      casState: {
        ref: PROTECTED_WORK_QUEUE_REF,
        oid: eightCreditRun.nextRefOid,
        state: eightCreditRun.nextCasState
      },
      expectedRefOid: eightCreditRun.nextRefOid,
      admissionEvidence: {
        ...baseAdmission(),
        observedMs: 1200,
        remainingIncludedUnits: 6,
        ghAwCaps: {
          maxAiCredits: 10,
          maxDailyAiCredits: 12,
          dailyAiCreditsUsed: 12,
          runAiCreditsRequired: 8,
          dailyUsageIncludesReservations: true
        }
      },
      candidate: {
        repositoryId: 1,
        issue: 20,
        head: '1'.repeat(40),
        generation: 1,
        phase: 'in-flight',
        workerId: 'w-8c',
        runId: 201,
        runAttempt: 1
      },
      nowMs: 1200
    });
    assert.equal(startedEight.ok, true);
    // Copilot 4725546535: validThrough is bounded by immutable executionDeadlineMs (301000), NOT short leaseExpiresAtMs (31000)!
    assert.equal(startedEight.nextLedgerSnapshot.reservations[0].validThrough, 301000);

    // Simulate renewWorkQueueLease extending leaseExpiresAtMs past 31000 -> reconciliation at nowMs = 50000 keeps row 'in-flight'!
    const renewedCasState = {
      ...startedEight.nextCasState,
      sequence: startedEight.nextCasState.sequence + 1,
      entries: [{
        ...startedEight.nextCasState.entries[0],
        leaseExpiresAtMs: 80000
      }]
    };
    const afterRenewRec = reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: startedEight.nextLedgerSnapshot,
      signingKey: casSigningKey,
      casState: {
        ref: PROTECTED_WORK_QUEUE_REF,
        oid: computeWorkQueueStateOid(renewedCasState),
        state: renewedCasState
      },
      expectedRefOid: computeWorkQueueStateOid(renewedCasState),
      admissionEvidence: {...baseAdmission(), observedMs: 50000, remainingIncludedUnits: 6},
      nowMs: 50000
    });
    assert.equal(afterRenewRec.ok, true);
    assert.equal(afterRenewRec.ledgerMutationRequired, false);
    assert.equal(afterRenewRec.nextLedgerSnapshot.reservations[0].phase, 'in-flight');

    // Unknown peer credit commitment (peer reserved without ghAwCaps) fails closed with PEER_CREDIT_COMMITMENTS_UNKNOWN:
    const noCapsPeer = reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: empty6Snap,
      signingKey: casSigningKey,
      casState: null,
      expectedRefOid: ZERO_GIT_OID,
      admissionEvidence: {...baseAdmission(), remainingIncludedUnits: 6},
      candidate: {
        repositoryId: 1,
        issue: 30,
        head: '3'.repeat(40),
        generation: 1,
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-a',
        ownedPaths: ['docs/a.md'],
        workerId: 'w-nocaps',
        runId: 301,
        leaseTtlMs: 30000
      },
      nowMs: 1000
    });
    assert.equal(noCapsPeer.ok, true);
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: noCapsPeer.nextLedgerSnapshot,
      signingKey: casSigningKey,
      casState: {
        ref: PROTECTED_WORK_QUEUE_REF,
        oid: noCapsPeer.nextRefOid,
        state: noCapsPeer.nextCasState
      },
      expectedRefOid: noCapsPeer.nextRefOid,
      admissionEvidence: {
        ...baseAdmission(),
        remainingIncludedUnits: 6,
        ghAwCaps: {
          maxAiCredits: 10,
          maxDailyAiCredits: 12,
          dailyAiCreditsUsed: 4,
          runAiCreditsRequired: 2
        }
      },
      candidate: {
        repositoryId: 1,
        issue: 31,
        head: '4'.repeat(40),
        generation: 2,
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-b',
        ownedPaths: ['docs/b.md'],
        workerId: 'w-c2',
        runId: 302,
        leaseTtlMs: 30000
      },
      nowMs: 1000
    }).reason, 'PEER_CREDIT_COMMITMENTS_UNKNOWN');

    // Startup with dailyUsageIncludesReservations: true when reservation had unknown credits also fails closed:
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: noCapsPeer.nextLedgerSnapshot,
      signingKey: casSigningKey,
      casState: {
        ref: PROTECTED_WORK_QUEUE_REF,
        oid: noCapsPeer.nextRefOid,
        state: noCapsPeer.nextCasState
      },
      expectedRefOid: noCapsPeer.nextRefOid,
      admissionEvidence: {
        ...baseAdmission(),
        remainingIncludedUnits: 6,
        ghAwCaps: {
          maxAiCredits: 10,
          maxDailyAiCredits: 12,
          dailyAiCreditsUsed: 4,
          runAiCreditsRequired: 2,
          dailyUsageIncludesReservations: true
        }
      },
      candidate: {
        repositoryId: 1,
        issue: 30,
        head: '3'.repeat(40),
        generation: 1,
        phase: 'in-flight',
        workerId: 'w-nocaps',
        runId: 301,
        runAttempt: 1
      },
      nowMs: 1000
    }).reason, 'PEER_CREDIT_COMMITMENTS_UNKNOWN');

    // 3. Copilot 4725546518: Six-unit plan with two settled two-unit runs (4 cumulative units) and fresh
    // remainingIncludedUnits: 2 admits a third two-unit reservation AND its startup!
    const twoSettledSnap = signRawSnapshot(empty6Snap.planSignature, 2, 1000, [
      {repositoryId: 1, issue: 1, head: '1'.repeat(40), generation: 1, units: 2, phase: 'settled', validThrough: 900, reservedAt: 500},
      {repositoryId: 1, issue: 2, head: '2'.repeat(40), generation: 2, units: 2, phase: 'settled', validThrough: 900, reservedAt: 500}
    ], casSigningKey, sixUnitPlan.window);
    const twoSettledCas = {
      schemaVersion: 1,
      protocol: 'v3',
      sequence: 2,
      nextGeneration: 3,
      entries: [
        {
          workId: '1:issue:1',
          targetType: 'issue',
          repository: 'Jamula/SoftwareFactory',
          repositoryId: 1,
          issueNumber: 1,
          pullNumber: null,
          headSha: null,
          lane: 'lane-a',
          ownedPaths: ['docs/a.md'],
          status: 'completed',
          generation: 1,
          attempts: 1,
          maxAttempts: 3,
          workerId: 'w-1',
          runId: 1,
          runAttempt: 1,
          claimedAtMs: 500,
          leaseTtlMs: 400,
          leaseExpiresAtMs: 900,
          maxExecutionMs: 400,
          executionDeadlineMs: 900
        },
        {
          workId: '1:issue:2',
          targetType: 'issue',
          repository: 'Jamula/SoftwareFactory',
          repositoryId: 1,
          issueNumber: 2,
          pullNumber: null,
          headSha: null,
          lane: 'lane-b',
          ownedPaths: ['docs/b.md'],
          status: 'completed',
          generation: 2,
          attempts: 1,
          maxAttempts: 3,
          workerId: 'w-2',
          runId: 2,
          runAttempt: 1,
          claimedAtMs: 500,
          leaseTtlMs: 400,
          leaseExpiresAtMs: 900,
          maxExecutionMs: 400,
          executionDeadlineMs: 900
        }
      ],
      recoveryReceipts: []
    };
    const thirdRes = reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: twoSettledSnap,
      signingKey: casSigningKey,
      casState: twoSettledCas,
      expectedRefOid: computeWorkQueueStateOid(twoSettledCas),
      admissionEvidence: {...baseAdmission(), remainingIncludedUnits: 2},
      candidate: {
        repositoryId: 1,
        issue: 3,
        head: '3'.repeat(40),
        generation: 3,
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-c',
        ownedPaths: ['docs/c.md'],
        workerId: 'w-3',
        runId: 3,
        leaseTtlMs: 30000
      },
      nowMs: 1000
    });
    assert.equal(thirdRes.ok, true);
    assert.equal(thirdRes.reason, 'CROSS_RUN_CAS_RESERVED');

    // Startup of that 3rd reservation succeeds both when netOfReservationsVerified: false (remaining=2)
    // and when netOfReservationsVerified: true (remaining=0 after deducting reservation)!
    const thirdStart = reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: thirdRes.nextLedgerSnapshot,
      signingKey: casSigningKey,
      casState: {
        ref: PROTECTED_WORK_QUEUE_REF,
        oid: thirdRes.nextRefOid,
        state: thirdRes.nextCasState
      },
      expectedRefOid: thirdRes.nextRefOid,
      admissionEvidence: {
        ...baseAdmission(),
        observedMs: 1200,
        remainingIncludedUnits: 0,
        netOfReservationsVerified: true
      },
      candidate: {
        repositoryId: 1,
        issue: 3,
        head: '3'.repeat(40),
        generation: 3,
        phase: 'in-flight',
        workerId: 'w-3',
        runId: 3,
        runAttempt: 1
      },
      nowMs: 1200
    });
    assert.equal(thirdStart.ok, true);
    assert.equal(thirdStart.reason, 'CROSS_RUN_CAS_SIMULATION_STARTED');
  } finally {
    sixUnitLedger.close();
  }

  // 4. Copilot 4725546480: Receipt-rollover compaction regression (>250 receipts rolled out):
  const rolloverPlan = {
    window: 'round3-rollover-window',
    maxActive: 4,
    includedUnits: 600,
    unitsPerRun: 2,
    maxExecutionMs: 300000,
    repositories: [{repositoryId: 1, maxActive: 2}, {repositoryId: 2, maxActive: 2}]
  };
  const rolloverLedger = openShadowDispatchLedger(':memory:', rolloverPlan);
  try {
    const baseRolloverSnap = rolloverLedger.exportSnapshot({signingKey: casSigningKey, now: 1000}).snapshot;
    const rolloverSig = baseRolloverSnap.planSignature;

    // Issue 1 has 3 attempts (6 units); entries 2..250 have 1 attempt each (249 * 2 = 498 units; total = 504 units).
    // 250 unrelated recoveryReceipts saturate maxCasReceipts so Issue 1's receipts have completely rolled out!
    const entries250With3AttemptFirst = Array.from({length: 250}, (_, idx) => ({
      workId: `2:issue:${idx + 1}`,
      targetType: 'issue',
      repository: 'Jamula/SoftwareFactory',
      repositoryId: 2,
      issueNumber: idx + 1,
      pullNumber: null,
      headSha: null,
      lane: `lane-${idx + 1}`,
      ownedPaths: [`docs/r-${idx + 1}.md`],
      status: 'completed',
      generation: idx + 10,
      attempts: idx === 0 ? 3 : 1,
      maxAttempts: 3,
      workerId: 'w-done',
      runId: 1000 + idx,
      runAttempt: 1,
      claimedAtMs: 500,
      leaseTtlMs: 100,
      leaseExpiresAtMs: 600,
      maxExecutionMs: 100,
      executionDeadlineMs: 600,
      ...(idx === 0 ? {priorRuns: [{runId: 998, runAttempt: 1}, {runId: 999, runAttempt: 1}]} : {})
    }));
    const saturatedReceipts250 = Array.from({length: 250}, (_, idx) => ({
      workId: `2:issue:${500 + idx}`,
      repositoryId: 2,
      targetType: 'issue',
      runState: 'lease_expired',
      conclusion: null,
      previousRunId: 5000 + idx,
      previousRunAttempt: 1,
      previousGeneration: 300 + idx * 2,
      reclaimedGeneration: 301 + idx * 2,
      attempts: 1,
      maxAttempts: 3,
      outcome: 'requeued',
      reclaimedAtMs: 700
    }));
    const full3AttemptLedgerRows = [
      {repositoryId: 2, issue: 1, head: '1'.repeat(40), generation: 1, units: 2, phase: 'expired', validThrough: 600, reservedAt: 500},
      {repositoryId: 2, issue: 1, head: '2'.repeat(40), generation: 2, units: 2, phase: 'expired', validThrough: 600, reservedAt: 500},
      {repositoryId: 2, issue: 1, head: '3'.repeat(40), generation: 10, units: 2, phase: 'settled', validThrough: 600, reservedAt: 500},
      ...Array.from({length: 249}, (_, idx) => ({
        repositoryId: 2,
        issue: idx + 2,
        head: 'a'.repeat(40),
        generation: idx + 11,
        units: 2,
        phase: 'settled',
        validThrough: 600,
        reservedAt: 500
      }))
    ];
    const fullRolloverSnap = signRawSnapshot(rolloverSig, 2, 1000, full3AttemptLedgerRows, casSigningKey, rolloverPlan.window);
    const rolloverCas = {
      schemaVersion: 1,
      protocol: 'v3',
      sequence: 20,
      nextGeneration: 900,
      entries: entries250With3AttemptFirst,
      recoveryReceipts: saturatedReceipts250
    };

    // Compacting Issue 1 keeps strict 2-key {workId, status} archivedTerminal compatible with work-queue-cas
    // compareAndSwapRef while encoding cumulative 3 attempts & 3 charged runs in checkpoint lockSha256!
    const rolloverRefStore = createInMemoryWorkQueueRefStore(rolloverCas);
    const initialRolloverOid = rolloverRefStore.readRef().oid;
    const compactedRollover = reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: fullRolloverSnap,
      signingKey: casSigningKey,
      casState: rolloverRefStore.readRef(),
      expectedRefOid: initialRolloverOid,
      admissionEvidence: {...baseAdmission(), remainingIncludedUnits: 100},
      candidate: {
        repositoryId: 1,
        issue: 600,
        head: 'b'.repeat(40),
        generation: 900,
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-ledger',
        ownedPaths: ['tools/engineering-factory/shadow-dispatch-ledger.mjs'],
        workerId: 'w-roll',
        runId: 9600,
        leaseTtlMs: 30000
      },
      nowMs: 1000
    });
    assert.equal(compactedRollover.ok, true);
    assert.deepEqual(compactedRollover.nextCasState.archivedTerminal[0], {
      workId: '2:issue:1',
      status: 'completed'
    });
    // Round-trip through createInMemoryWorkQueueRefStore().compareAndSwapRef() succeeds with exact OID match!
    const casRolloverCommit = rolloverRefStore.compareAndSwapRef({
      ref: PROTECTED_WORK_QUEUE_REF,
      expectedOid: initialRolloverOid,
      nextState: compactedRollover.nextCasState,
      force: false
    });
    assert.equal(casRolloverCommit.ok, true);
    assert.equal(casRolloverCommit.oid, compactedRollover.nextRefOid);

    // Complete 3-row snapshot continues admitting after compareAndSwapRef round-trip across saturated receipts!
    const postRolloverAdmit = reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: compactedRollover.nextLedgerSnapshot,
      signingKey: casSigningKey,
      casState: rolloverRefStore.readRef(),
      expectedRefOid: casRolloverCommit.oid,
      admissionEvidence: {...baseAdmission(), observedMs: 1200, remainingIncludedUnits: 100},
      candidate: {
        repositoryId: 1,
        issue: 601,
        head: 'c'.repeat(40),
        generation: 901,
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-docs',
        ownedPaths: ['docs/ROADMAP.md'],
        workerId: 'w-roll-2',
        runId: 9601,
        leaseTtlMs: 30000
      },
      nowMs: 1200
    });
    assert.equal(postRolloverAdmit.ok, true);

    // Stale 1-row snapshot for Issue 1 fails closed both against checkpointed CAS state AND stripped-lock external archive!
    const stale1RowForIssue1 = [
      {repositoryId: 1, issue: 600, head: 'b'.repeat(40), generation: 900, units: 2, phase: 'reserved', validThrough: 31000, reservedAt: 1000},
      {repositoryId: 2, issue: 1, head: '1'.repeat(40), generation: 1, units: 2, phase: 'settled', validThrough: 600, reservedAt: 500},
      ...full3AttemptLedgerRows.slice(3)
    ];
    const staleRolloverSnap = signRawSnapshot(rolloverSig, 3, 1000, stale1RowForIssue1, casSigningKey, rolloverPlan.window);
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: staleRolloverSnap,
      signingKey: casSigningKey,
      casState: rolloverRefStore.readRef(),
      expectedRefOid: casRolloverCommit.oid,
      admissionEvidence: {...baseAdmission(), remainingIncludedUnits: 100},
      candidate: {
        repositoryId: 1,
        issue: 601,
        head: 'c'.repeat(40),
        generation: 901,
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-docs',
        ownedPaths: ['docs/ROADMAP.md'],
        workerId: 'w-roll-2',
        runId: 9601,
        leaseTtlMs: 30000
      },
      nowMs: 1000
    }).reason, 'STALE_OR_INCOMPLETE_LEDGER');

    const strippedLocksCas = {
      ...compactedRollover.nextCasState,
      entries: compactedRollover.nextCasState.entries.map(e => {
        const copy = {...e};
        delete copy.lockSha256;
        return copy;
      })
    };
    assert.equal(reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: staleRolloverSnap,
      signingKey: casSigningKey,
      casState: strippedLocksCas,
      expectedRefOid: computeWorkQueueStateOid(strippedLocksCas),
      admissionEvidence: {...baseAdmission(), remainingIncludedUnits: 100},
      candidate: {
        repositoryId: 1,
        issue: 601,
        head: 'c'.repeat(40),
        generation: 901,
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-docs',
        ownedPaths: ['docs/ROADMAP.md'],
        workerId: 'w-roll-2',
        runId: 9601,
        leaseTtlMs: 30000
      },
      nowMs: 1000
    }).reason, 'STALE_OR_INCOMPLETE_LEDGER');

    // 5. Copilot 4725604667: Active and revoked Proxy items in archivedTerminal never execute traps or throw!
    let archiveTrapCalls = 0;
    const archiveTrap = () => {
      archiveTrapCalls++;
      throw new Error('archive proxy trap invoked');
    };
    const activeArchiveProxy = new Proxy(
      {workId: '2:issue:1', status: 'completed'},
      {get: archiveTrap, getOwnPropertyDescriptor: archiveTrap, ownKeys: archiveTrap}
    );
    const revokedArchive = Proxy.revocable({workId: '2:issue:1', status: 'completed'}, {get: archiveTrap});
    revokedArchive.revoke();
    for (const badItem of [activeArchiveProxy, revokedArchive.proxy]) {
      const proxyArchiveCas = {
        schemaVersion: 1,
        protocol: 'v3',
        sequence: 1,
        nextGeneration: 2,
        entries: [],
        recoveryReceipts: [],
        archivedTerminal: [badItem]
      };
      assert.equal(computeWorkQueueStateOid(proxyArchiveCas), null);
      assert.equal(reconcileLedgerWithWorkQueueCas({
        ledgerSnapshot: baseRolloverSnap,
        signingKey: casSigningKey,
        casState: proxyArchiveCas,
        expectedRefOid: ZERO_GIT_OID,
        admissionEvidence: {...baseAdmission(), remainingIncludedUnits: 100},
        nowMs: 1000
      }).reason, 'INVALID_QUEUE_STATE');
    }
    assert.equal(archiveTrapCalls, 0);

    // 6. Copilot 4725604689: Compacting an unstarted, cancelled PR head A when a later PR head B on the same PR
    // has settled records 0 charges for head A, so the next audit accepts the complete snapshot!
    const headA = '1'.repeat(40);
    const headB = '2'.repeat(40);
    const prEntries250 = [
      {
        workId: `2:pr:77:${headA}`,
        targetType: 'pull_request',
        repository: 'Jamula/SoftwareFactory',
        repositoryId: 2,
        issueNumber: null,
        pullNumber: 77,
        headSha: headA,
        lane: 'lane-pr-a',
        ownedPaths: ['docs/pr-a.md'],
        status: 'cancelled',
        generation: 1,
        attempts: 1,
        maxAttempts: 3,
        workerId: 'w-pr-a',
        runId: 7701,
        runAttempt: 1,
        claimedAtMs: 500,
        leaseTtlMs: 100,
        leaseExpiresAtMs: 600,
        maxExecutionMs: 100,
        executionDeadlineMs: 600
      },
      {
        workId: `2:pr:77:${headB}`,
        targetType: 'pull_request',
        repository: 'Jamula/SoftwareFactory',
        repositoryId: 2,
        issueNumber: null,
        pullNumber: 77,
        headSha: headB,
        lane: 'lane-pr-b',
        ownedPaths: ['docs/pr-b.md'],
        status: 'completed',
        generation: 2,
        attempts: 1,
        maxAttempts: 3,
        workerId: 'w-pr-b',
        runId: 7702,
        runAttempt: 1,
        claimedAtMs: 500,
        leaseTtlMs: 100,
        leaseExpiresAtMs: 600,
        maxExecutionMs: 100,
        executionDeadlineMs: 600
      },
      ...Array.from({length: 248}, (_, idx) => ({
        workId: `2:issue:${100 + idx}`,
        targetType: 'issue',
        repository: 'Jamula/SoftwareFactory',
        repositoryId: 2,
        issueNumber: 100 + idx,
        pullNumber: null,
        headSha: null,
        lane: `lane-fill-${idx}`,
        ownedPaths: [`docs/fill-${idx}.md`],
        status: 'completed',
        generation: idx + 3,
        attempts: 1,
        maxAttempts: 3,
        workerId: 'w-fill',
        runId: 8000 + idx,
        runAttempt: 1,
        claimedAtMs: 500,
        leaseTtlMs: 100,
        leaseExpiresAtMs: 600,
        maxExecutionMs: 100,
        executionDeadlineMs: 600
      }))
    ];
    const prMultiHeadRows = [
      {repositoryId: 2, issue: 77, head: headA, generation: 1, units: 2, phase: 'cancelled', validThrough: 600, reservedAt: 500},
      {repositoryId: 2, issue: 77, head: headB, generation: 2, units: 2, phase: 'settled', validThrough: 600, reservedAt: 500},
      ...Array.from({length: 248}, (_, idx) => ({
        repositoryId: 2,
        issue: 100 + idx,
        head: 'a'.repeat(40),
        generation: idx + 3,
        units: 2,
        phase: 'settled',
        validThrough: 600,
        reservedAt: 500
      }))
    ];
    const prMultiHeadSnap = signRawSnapshot(rolloverSig, 4, 1000, prMultiHeadRows, casSigningKey, rolloverPlan.window);
    const prMultiHeadStore = createInMemoryWorkQueueRefStore({
      schemaVersion: 1,
      protocol: 'v3',
      sequence: 5,
      nextGeneration: 251,
      entries: prEntries250,
      recoveryReceipts: []
    });
    // Compact cancelled PR head A into archivedTerminal:
    const compactPrHeadA = reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: prMultiHeadSnap,
      signingKey: casSigningKey,
      casState: prMultiHeadStore.readRef(),
      expectedRefOid: prMultiHeadStore.readRef().oid,
      admissionEvidence: {...baseAdmission(), remainingIncludedUnits: 100},
      candidate: {
        repositoryId: 1,
        issue: 700,
        head: 'd'.repeat(40),
        generation: 251,
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-ledger',
        ownedPaths: ['tools/engineering-factory/shadow-dispatch-ledger.mjs'],
        workerId: 'w-pr-next',
        runId: 9700,
        leaseTtlMs: 30000
      },
      nowMs: 1000
    });
    assert.equal(compactPrHeadA.ok, true);
    const prCasCommit = prMultiHeadStore.compareAndSwapRef({
      ref: PROTECTED_WORK_QUEUE_REF,
      expectedOid: prMultiHeadStore.readRef().oid,
      nextState: compactPrHeadA.nextCasState,
      force: false
    });
    assert.equal(prCasCommit.ok, true);

    // Next audit accepts the complete snapshot without misattributing head B's charge to archived head A!
    const nextPrAudit = reconcileLedgerWithWorkQueueCas({
      ledgerSnapshot: compactPrHeadA.nextLedgerSnapshot,
      signingKey: casSigningKey,
      casState: prMultiHeadStore.readRef(),
      expectedRefOid: prCasCommit.oid,
      admissionEvidence: {...baseAdmission(), observedMs: 1200, remainingIncludedUnits: 100},
      candidate: {
        repositoryId: 1,
        issue: 701,
        head: 'e'.repeat(40),
        generation: 252,
        repository: 'Jamula/SoftwareFactory',
        lane: 'lane-docs',
        ownedPaths: ['docs/ROADMAP.md'],
        workerId: 'w-pr-next-2',
        runId: 9701,
        leaseTtlMs: 30000
      },
      nowMs: 1200
    });
    assert.equal(nextPrAudit.ok, true);
  } finally {
    rolloverLedger.close();
  }
});
