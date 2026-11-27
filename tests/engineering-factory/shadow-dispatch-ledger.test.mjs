import {createHash, createHmac} from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Worker} from 'node:worker_threads';
import {openShadowDispatchLedger} from '../../tools/engineering-factory/shadow-dispatch-ledger.mjs';

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
    // Reconcile requires authoritative now (omitting now fails closed even when overdue), and past deadline marks expired.
    assert.equal(ledger.reconcile(r2.ticket, terminal(r2.ticket)).reason, 'TERMINAL_RECEIPT_UNKNOWN');
    assert.equal(ledger.reconcile(r2.ticket, terminal(r2.ticket), -1).reason, 'TERMINAL_RECEIPT_UNKNOWN');
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
      // Signed undercharged row (units !== plan.unitsPerRun) is rejected
      (() => {
        const rows = [{...baseRow, units: 1}];
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
    const migrated = openShadowDispatchLedger(legacyPath, plan);
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
