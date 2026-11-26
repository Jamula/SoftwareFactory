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
    assert.equal(ledger.reconcile(first.ticket, terminal(first.ticket)).reason, 'RESERVATION_UNAVAILABLE');
    assert.equal(ledger.begin(first.ticket, fixture, now).reason, 'SHADOW_SIMULATION_RECORDED');
    assert.equal(ledger.begin(first.ticket, fixture, now).reason, 'RESERVATION_UNAVAILABLE');
    assert.equal(ledger.cancel(first.ticket).reason, 'RESERVATION_UNAVAILABLE');
    ledger.close();
    ledger = openShadowDispatchLedger(path, {...plan, repositories: [...plan.repositories].reverse()});
    assert.equal(ledger.reserve(candidate(1, 13), quota(), now).reason, 'CAPACITY_EXHAUSTED');
    for (const change of [{generation: 2}, {head: 'b'.repeat(40)}, {repositoryId: 2},
      {state: 'pending'}, {shadow: false}]) {
      assert.equal(ledger.reconcile(first.ticket, {...terminal(first.ticket), ...change}).reason,
        'TERMINAL_RECEIPT_UNKNOWN');
    }
    assert.equal(ledger.reconcile(first.ticket, first.ticket).reason, 'TERMINAL_RECEIPT_UNKNOWN');
    assert.equal(ledger.reconcile(first.ticket, terminal(first.ticket)).reason, 'SHADOW_SETTLED');
    assert.equal(ledger.reconcile(first.ticket, terminal(first.ticket)).reason, 'RESERVATION_UNAVAILABLE');
    assert.equal(ledger.reserve({...fixture, generation: 2}, quota(), now).reason, 'DUPLICATE_OR_ACTIVE');
    assert.equal(ledger.cancel(other.ticket).reason, 'SHADOW_CANCELLED_BEFORE_SIMULATION');
    assert.equal(ledger.cancel(other.ticket).reason, 'RESERVATION_UNAVAILABLE');
    const last = ledger.reserve(candidate(2, 13), quota(2), now);
    assert.equal(last.reason, 'SHADOW_RESERVED');
    assert.equal(ledger.begin(last.ticket, candidate(2, 13), now).reason, 'SHADOW_SIMULATION_RECORDED');
    assert.equal(ledger.reconcile(last.ticket, terminal(last.ticket, 'cancelled')).reason, 'SHADOW_SETTLED');
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
      assert.equal(ledger.reconcile(input, terminal(ticket)).reason, 'TERMINAL_RECEIPT_UNKNOWN');
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
    assert.equal(ledger.cancel(ticket).reason, 'STORE_UNAVAILABLE');
    assert.equal(ledger.reconcile(ticket, terminal(ticket)).reason, 'STORE_UNAVAILABLE');
  } finally {
    db.close();
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
