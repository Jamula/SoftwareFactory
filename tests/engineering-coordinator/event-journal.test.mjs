import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Worker} from 'node:worker_threads';
import {openEventJournal} from '../../tools/engineering-coordinator/event-journal.mjs';

const original = {repositoryId: 1, deliveryId: 'run-8', kind: 'pull', subject: 42, head: 'a'.repeat(40)};
const next = {...original, deliveryId: 'run-2', head: 'b'.repeat(40)};

test('replays an expired claim after restart, serializes a repository, and fences the prior owner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-event-replay-'));
  const path = join(dir, 'events.sqlite');
  let a = openEventJournal(path);
  const b = openEventJournal(path);
  try {
    assert.deepEqual(a.enqueue({...original, body: 'ignored'}), {queued: true, reason: 'QUEUED'});
    assert.equal(b.enqueue(original).reason, 'DUPLICATE_DELIVERY');
    for (const changes of [{kind: 'review'}, {subject: 43}, {head: next.head}]) {
      assert.equal(b.enqueue({...original, ...changes}).reason, 'DELIVERY_CONFLICT');
    }
    assert.equal(b.enqueue(next).queued, true);
    assert.equal(a.enqueue({...original, repositoryId: 2}).queued, true);
    const first = a.claim(1, 'worker-a', 0, 1000);
    assert.deepEqual(first, {...original, owner: 'worker-a', generation: 1, leaseUntil: 1000});
    assert.equal(b.claim(1, 'worker-b', 999, 1000), null);
    assert.equal(b.claim(2, 'worker-b', 999, 1000).repositoryId, 2);
    a.close();
    a = openEventJournal(path);
    assert.equal(a.complete(first, 1000), false);
    const replay = a.claim(1, 'worker-b', 1000, 1000);
    assert.equal(replay.deliveryId, original.deliveryId);
    assert.equal(replay.generation, 2);
    assert.equal(b.complete(first, 1001), false);
    assert.equal(b.complete({...replay, owner: 'worker-a'}, 1001), false);
    assert.equal(b.complete(replay, 1001), true);
    assert.equal(a.complete(replay, 1001), false);
    assert.equal(a.enqueue(original).reason, 'DUPLICATE_DELIVERY');
    assert.equal(a.claim(1, 'worker-a', 1001, 1000).deliveryId, next.deliveryId);
  } finally {
    a.close();
    b.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('rejects malformed inputs and fails closed on unavailable storage', () => {
  const store = openEventJournal(':memory:');
  assert.equal(store.enqueue(null).reason, 'JOURNAL_UNAVAILABLE');
  for (const changes of [
    {repositoryId: 0}, {deliveryId: 7}, {deliveryId: 'bad id'},
    {kind: 'body'}, {subject: -1}, {head: 4}, {head: 'bad'}
  ]) assert.equal(store.enqueue({...original, ...changes}).reason, 'INVALID_EVENT');
  for (const args of [
    [0, 'w', 0, 1000], [1, '', 0, 1000], [1, 'w', -1, 1000],
    [1, 'w', 0, 1000.1], [1, 'w', 0, 999], [1, 'w', 0, 3600001],
    [1, 'w', Number.MAX_SAFE_INTEGER, 1000]
  ]) assert.equal(store.claim(...args), null);
  assert.equal(store.claim(1, 'w', 0, 1000), null);
  assert.equal(store.complete(null, 0), false);
  const ticket = {...original, owner: 'worker', generation: 1};
  for (const changes of [{repositoryId: 0}, {deliveryId: ''}, {owner: null}, {generation: 0}]) {
    assert.equal(store.complete({...ticket, ...changes}, 0), false);
  }
  assert.equal(store.complete(ticket, -1), false);
  store.close();
  assert.equal(store.enqueue(original).reason, 'JOURNAL_UNAVAILABLE');
  assert.equal(store.claim(1, 'w', 0, 1000), null);
  assert.equal(store.complete(ticket, 0), false);
});

test('bounds storage and keeps a full journal able to identify prior deliveries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-event-limit-'));
  const path = join(dir, 'events.sqlite');
  const store = openEventJournal(path);
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      WITH RECURSIVE ids(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM ids WHERE value < 10000)
      INSERT INTO coordinator_events (repository_id, delivery_id, kind, subject, head)
      SELECT 1, 'id-' || value, 'manual', 0, '${original.head}' FROM ids;
    `);
    assert.equal(store.enqueue(original).reason, 'JOURNAL_FULL');
    assert.equal(store.enqueue({...original, deliveryId: 'id-1', kind: 'manual', subject: 0}).reason,
      'DUPLICATE_DELIVERY');
    assert.equal(store.enqueue({...original, repositoryId: 2}).queued, true);
  } finally {
    db.close();
    store.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('closes a handle after SQL initialization fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-event-schema-'));
  const path = join(dir, 'events.sqlite');
  const db = new DatabaseSync(path);
  try {
    db.exec('CREATE TABLE coordinator_events (unrelated INTEGER)');
    assert.throws(() => openEventJournal(path), /no such column/);
  } finally {
    db.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('separate workers cannot claim two deliveries for the same repository', {timeout: 10000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-event-workers-'));
  const path = join(dir, 'events.sqlite');
  const store = openEventJournal(path);
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const workers = [];
  let ready = 0;
  try {
    assert.equal(store.enqueue(original).queued, true);
    assert.equal(store.enqueue(next).queued, true);
    const moduleUrl = new URL('../../tools/engineering-coordinator/event-journal.mjs', import.meta.url).href;
    const results = ['worker-a', 'worker-b'].map(owner => new Promise((resolve, reject) => {
      const worker = new Worker(`
        const {parentPort, workerData} = require('node:worker_threads');
        import(workerData.moduleUrl).then(({openEventJournal}) => {
          const store = openEventJournal(workerData.path);
          try {
            const gate = new Int32Array(workerData.buffer);
            parentPort.postMessage({ready: true});
            Atomics.wait(gate, 0, 0, 5000);
            parentPort.postMessage({claim: store.claim(1, workerData.owner, 0, 1000)});
          } finally { store.close(); }
        }).catch(error => { process.nextTick(() => { throw error; }); });
      `, {eval: true, workerData: {moduleUrl, path, owner, buffer: gate.buffer}});
      workers.push(worker);
      worker.on('error', reject);
      worker.on('exit', code => { if (code !== 0) reject(new Error('lease worker failed')); });
      worker.on('message', message => {
        if (message.ready) {
          if (++ready === 2) {
            Atomics.store(gate, 0, 1);
            Atomics.notify(gate, 0);
          }
        } else resolve(message.claim);
      });
    }));
    const claims = (await Promise.all(results)).filter(Boolean);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].deliveryId, original.deliveryId);
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
    store.close();
    rmSync(dir, {recursive: true, force: true});
  }
});
