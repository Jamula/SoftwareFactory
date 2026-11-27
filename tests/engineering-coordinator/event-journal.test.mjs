import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Worker} from 'node:worker_threads';
import {
  exportJournalSnapshot,
  importJournalSnapshot,
  openEventJournal,
  reconcileJournalOnce
} from '../../tools/engineering-coordinator/event-journal.mjs';

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

test('bounded journal reconciliation acknowledges only fresh shadow evidence; moved heads are superseded',async()=>{
 const j=openEventJournal(':memory:');
 try {
  j.enqueue(original);j.enqueue(next);
  let now=1;
  const runtime={journal:j,repositoryId:1,owner:'worker-a',leaseMs:1000,clock:()=>now,stop:false};
  const read=async hint=>({...hint,shadow:true,fresh:true});
  assert.equal((await reconcileJournalOnce({...runtime,read})).reason,'SHADOW_RECONCILED');
  assert.equal((await reconcileJournalOnce({...runtime,read:async hint=>({...await read(hint),head:original.head})})).reason,'SHADOW_HEAD_SUPERSEDED');
  assert.equal((await reconcileJournalOnce({...runtime,read})).reason,'NO_CLAIM');
 } finally{j.close();}
});
test('invalid evidence or lost lease leaves claim available for recovery',async()=>{
 for(const change of [null,{shadow:false},{fresh:false},{repositoryId:2},{kind:'check'},{subject:43},{head:'bad'}]){
  const j=openEventJournal(':memory:');
  try{
   j.enqueue(original);let now=0;
   const opts={journal:j,repositoryId:1,owner:'worker-a',leaseMs:1000,clock:()=>now,stop:false,
    read:async hint=>change===null?null:{...hint,shadow:true,fresh:true,...change}};
   assert.equal((await reconcileJournalOnce(opts)).reason,'EVIDENCE_UNKNOWN');
   assert.equal(j.claim(1,'worker-b',999,1000),null);
   assert.equal(j.claim(1,'worker-b',1000,1000).generation,2);
  }finally{j.close();}
 }
 const j=openEventJournal(':memory:');
 try{
  j.enqueue(original);let now=0;
  const opts={journal:j,repositoryId:1,owner:'worker-a',leaseMs:1000,clock:()=>now,stop:false};
  assert.equal((await reconcileJournalOnce({...opts,read:async hint=>{now=1000;return {...hint,shadow:true,fresh:true};}})).reason,'LEASE_OR_CLOCK_UNKNOWN');
  assert.equal(j.claim(1,'worker-b',1000,1000).generation,2);
 }finally{j.close();}
});
test('runtime, clock, exceptions and fencing fail closed',async()=>{
 const hint={...original,owner:'w',generation:1,leaseUntil:1000};
 const journal={claim:()=>hint,complete:()=>false};
 const opts={journal,repositoryId:1,owner:'w',leaseMs:1000,clock:()=>0,stop:false,read:async v=>({...v,shadow:true,fresh:true})};
 for(const x of [undefined,{...opts,stop:true}])assert.equal((await reconcileJournalOnce(x)).reason,'STOPPED');
 for(const x of [{journal:null},{journal:{}},{journal:{claim:()=>hint}},{clock:null},{read:null}])
  assert.equal((await reconcileJournalOnce({...opts,...x})).reason,'RUNTIME_UNKNOWN');
 assert.equal((await reconcileJournalOnce({...opts,clock:()=>-1})).reason,'CLOCK_UNKNOWN');
 for(const values of [[0,-1],[1,0]]){
  const samples=[...values];assert.equal((await reconcileJournalOnce({...opts,clock:()=>samples.shift()})).reason,'LEASE_OR_CLOCK_UNKNOWN');
 }
 assert.equal((await reconcileJournalOnce(opts)).reason,'CLAIM_LOST');
 assert.equal((await reconcileJournalOnce({...opts,read:async()=>{throw Error('offline')}})).reason,'RECONCILIATION_UNAVAILABLE');
});

test('kind-filtered claim retains unsupported hints and repository-wide exclusivity',()=>{
 const j=openEventJournal(':memory:');try{
  j.enqueue({...original,deliveryId:'review',kind:'review'});j.enqueue(original);
  assert.equal(j.claim(1,'w',0,1000,'invalid'),null);
  const p=j.claim(1,'w',0,1000,'pull');assert.equal(p.kind,'pull');
  assert.equal(j.claim(1,'other',1,1000,'review'),null);
  assert.equal(j.complete(p,1),true);
  assert.equal(j.claim(1,'other',1,1000,'review').deliveryId,'review');
 }finally{j.close();}
});

test('durable retry deferral keeps lease fencing and pending evidence',()=>{
 const dir=mkdtempSync(join(tmpdir(),'factory-defer-')),path=join(dir,'state.db');let j=openEventJournal(path);
 try{
  j.enqueue(original);j.enqueue(next);const p=j.claim(1,'w',0,1000);
  for(const args of [[null,0,60000],[{...p,owner:'other'},0,60000],[{...p,generation:2},0,60000],[p,1000,60000],[p,-1,60000],[p,0,59999],[p,0,3600001],[p,0,NaN]])assert.equal(j.defer(...args),false);
  for(const field of ['repositoryId','deliveryId','generation'])assert.equal(j.defer({...p,[field]:null},0,60000),false);
  assert.equal(j.defer(p,0,60000),true);assert.equal(j.defer(p,0,60000),false);
  assert.equal(j.claim(1,'other',999,1000),null);
  j.close();j=openEventJournal(path);const q=j.claim(1,'other',1000,1000);assert.equal(q.deliveryId,next.deliveryId);assert.equal(j.complete(q,1001),true);
  assert.equal(j.claim(1,'other',59999,1000),null);assert.equal(j.claim(1,'other',60000,1000).deliveryId,original.deliveryId);
 }finally{j.close();rmSync(dir,{recursive:true,force:true});}
});

test('defer callback receives only the validated clock sample and never acknowledges evidence',async()=>{
 const j=openEventJournal(':memory:');try{
  j.enqueue(original);let now=600000,calls=0;const opts={journal:j,repositoryId:1,owner:'worker-a',leaseMs:1000,clock:()=>now,stop:false,read:async()=>{now=600001;return null;}};
  assert.equal((await reconcileJournalOnce({...opts,deferUnknown:'bad'})).reason,'RUNTIME_UNKNOWN');
  const result=await reconcileJournalOnce({...opts,deferUnknown(ticket,finished){calls++;assert.equal(finished,600001);assert.equal(ticket.leaseUntil,601000);return j.defer(ticket,finished,60000);}});
  assert.equal(result.reason,'EVIDENCE_UNKNOWN');assert.equal(calls,1);assert.equal(j.claim(1,'other',601000,1000),null);
  assert.equal(j.claim(1,'other',660001,1000).deliveryId,original.deliveryId);
 }finally{j.close();}
});

test('active lease checks use a partial index across a pending backlog', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-event-active-index-'));
  const path = join(dir, 'events.sqlite');
  const store = openEventJournal(path);
  store.close();
  const db = new DatabaseSync(path);
  try {
    const plan = db.prepare(`EXPLAIN QUERY PLAN
      SELECT pending.id FROM coordinator_events AS pending
      WHERE pending.repository_id = ? AND pending.completed = 0
        AND pending.expires <= ? AND pending.generation < ?
        AND NOT EXISTS (
          SELECT 1 FROM coordinator_events AS active
          WHERE active.repository_id = pending.repository_id
            AND active.completed = 0 AND active.expires > ?
        )
      ORDER BY pending.id LIMIT 1`).all(1, 0, Number.MAX_SAFE_INTEGER, 0);
    const activeLookup = plan.find(row => String(row.detail).includes('active'));
    assert.match(activeLookup?.detail ?? '', /coordinator_events_active/);
  } finally {
    db.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('exports and imports deterministic cross-run snapshots with fencing and deferral recovery', () => {
  const source = openEventJournal(':memory:');
  const restored = openEventJournal(':memory:');
  const shaA = 'a'.repeat(40);
  const shaB = 'b'.repeat(40);
  try {
    assert.equal(source.enqueue({repositoryId: 1, deliveryId: 'done-1', kind: 'main', subject: 0, head: shaA}).queued, true);
    const doneClaim = source.claim(1, 'runner-1', 10, 1000);
    assert.equal(source.complete(doneClaim, 20), true);

    assert.equal(source.enqueue({repositoryId: 1, deliveryId: 'deferred-1', kind: 'check', subject: 99, head: shaA}).queued, true);
    const deferredClaim = source.claim(1, 'runner-1', 30, 1000);
    assert.equal(source.defer(deferredClaim, 40, 60000), true);

    assert.equal(source.enqueue({repositoryId: 1, deliveryId: 'pending-1', kind: 'review', subject: 7, head: shaB}).queued, true);
    assert.equal(source.enqueue({repositoryId: 2, deliveryId: 'other-repo', kind: 'issue', subject: 5, head: shaA}).queued, true);

    const repoOnly = exportJournalSnapshot(source, {repositoryId: 1});
    assert.equal(repoOnly.exported, true);
    assert.equal(repoOnly.entries.length, 3);

    const fullSnapshot = exportJournalSnapshot(source);
    assert.equal(fullSnapshot.exported, true);
    assert.equal(fullSnapshot.schemaVersion, 1);
    assert.equal(Object.isFrozen(fullSnapshot), true);
    assert.equal(Object.isFrozen(fullSnapshot.entries), true);
    assert.equal(Object.isFrozen(fullSnapshot.entries[0]), true);

    const serialized = JSON.parse(JSON.stringify(fullSnapshot));
    assert.deepEqual(importJournalSnapshot(restored, serialized), {
      shadow: true, imported: true, reason: 'SNAPSHOT_IMPORTED', importedCount: 4, duplicateCount: 0
    });
    assert.deepEqual(exportJournalSnapshot(restored), fullSnapshot);

    // Completed receipts stay deduplicated; expired deferred/unclaimed hints recover with fenced generation.
    assert.equal(restored.enqueue({repositoryId: 1, deliveryId: 'done-1', kind: 'main', subject: 0, head: shaA}).reason,
      'DUPLICATE_DELIVERY');
    const nextClaim = restored.claim(1, 'runner-2', 2000, 1000);
    assert.equal(nextClaim.deliveryId, 'pending-1');
    assert.equal(nextClaim.generation, 1);
    assert.equal(restored.complete(nextClaim, 2001), true);

    assert.equal(restored.claim(1, 'runner-2', 60039, 1000), null);
    const recoveredDeferred = restored.claim(1, 'runner-2', 60040, 1000);
    assert.equal(recoveredDeferred.deliveryId, 'deferred-1');
    assert.equal(recoveredDeferred.generation, 2);
    assert.equal(restored.complete(deferredClaim, 60041), false);
    assert.equal(restored.complete(recoveredDeferred, 60041), true);

    // Defer -> reclaim -> complete clears retryAfter so subsequent export/import roundtrips cleanly.
    const postDeferredExport = exportJournalSnapshot(restored);
    const completedDeferred = postDeferredExport.entries.find(row => row.deliveryId === 'deferred-1');
    assert.equal(completedDeferred.completed, true);
    assert.equal(completedDeferred.retryAfter, null);
    const third = openEventJournal(':memory:');
    try {
      assert.equal(importJournalSnapshot(third, JSON.parse(JSON.stringify(postDeferredExport))).imported, true);
    } finally {
      third.close();
    }
  } finally {
    source.close();
    restored.close();
  }
});

test('snapshot import merges monotonically and rolls back atomically on conflicts or capacity limits', () => {
  const target = openEventJournal(':memory:');
  const head = 'a'.repeat(40);
  try {
    target.enqueue({repositoryId: 1, deliveryId: 'already-done', kind: 'main', subject: 0, head});
    const t1 = target.claim(1, 'w1', 0, 1000);
    assert.equal(target.complete(t1, 10), true);

    target.enqueue({repositoryId: 1, deliveryId: 'to-complete', kind: 'check', subject: 2, head});
    const t2 = target.claim(1, 'w1', 1000, 1000);
    assert.equal(target.defer(t2, 1001, 60000), true);

    target.enqueue({repositoryId: 1, deliveryId: 'claim-advance', kind: 'pull', subject: 1, head});
    const t3 = target.claim(1, 'w1', 2000, 1000);
    assert.equal(t3.generation, 1);

    const mergeResult = importJournalSnapshot(target, {
      schemaVersion: 1,
      shadow: true,
      entries: [
        {repositoryId: 1, deliveryId: 'claim-advance', kind: 'pull', subject: 1, head, owner: 'w2', generation: 3, expires: 5000, completed: false, retryAfter: 70000},
        {repositoryId: 1, deliveryId: 'to-complete', kind: 'check', subject: 2, head, owner: 'w2', generation: 2, expires: 0, completed: true, retryAfter: null},
        {repositoryId: 1, deliveryId: 'already-done', kind: 'main', subject: 0, head, owner: null, generation: 0, expires: 0, completed: false, retryAfter: null}
      ]
    });
    assert.deepEqual(mergeResult, {
      shadow: true, imported: true, reason: 'SNAPSHOT_IMPORTED', importedCount: 0, duplicateCount: 3
    });
    // Lower incoming generation never regresses higher generation, while retryAfter still advances.
    assert.equal(importJournalSnapshot(target, {
      schemaVersion: 1,
      shadow: true,
      entries: [
        {repositoryId: 1, deliveryId: 'claim-advance', kind: 'pull', subject: 1, head, owner: 'w0', generation: 1, expires: 100, completed: false, retryAfter: 90000}
      ]
    }).imported, true);
    const exported = exportJournalSnapshot(target, {repositoryId: 1});
    assert.deepEqual(exported.entries, [
      {repositoryId: 1, deliveryId: 'already-done', kind: 'main', subject: 0, head, owner: 'w1', generation: 1, expires: 0, completed: true, retryAfter: null},
      {repositoryId: 1, deliveryId: 'to-complete', kind: 'check', subject: 2, head, owner: 'w2', generation: 2, expires: 0, completed: true, retryAfter: null},
      {repositoryId: 1, deliveryId: 'claim-advance', kind: 'pull', subject: 1, head, owner: 'w2', generation: 3, expires: 5000, completed: false, retryAfter: 90000}
    ]);

    // Conflicting metadata after a valid new entry rolls back the entire batch.
    const conflict = importJournalSnapshot(target, {
      schemaVersion: 1,
      shadow: true,
      entries: [
        {repositoryId: 1, deliveryId: 'rolled-back', kind: 'issue', subject: 9, head, owner: null, generation: 0, expires: 0, completed: false, retryAfter: null},
        {repositoryId: 1, deliveryId: 'claim-advance', kind: 'pull', subject: 999, head, owner: null, generation: 0, expires: 0, completed: false, retryAfter: null}
      ]
    });
    assert.equal(conflict.reason, 'DELIVERY_CONFLICT');
    assert.equal(exportJournalSnapshot(target, {repositoryId: 1}).entries.length, 3);
  } finally {
    target.close();
  }

  // Populated-target lease exclusivity: reject concurrent active leases and fence expired ones.
  const leaseStore = openEventJournal(':memory:');
  try {
    leaseStore.enqueue({repositoryId: 1, deliveryId: 'expired-b', kind: 'pull', subject: 2, head});
    const expiredTicket = leaseStore.claim(1, 'w1', 0, 1000);
    assert.equal(leaseStore.defer(expiredTicket, 10, 60000), true);
    leaseStore.enqueue({repositoryId: 1, deliveryId: 'active-a', kind: 'pull', subject: 1, head});
    const activeTicket = leaseStore.claim(1, 'w1', 1500, 3500);
    assert.equal(activeTicket.deliveryId, 'active-a');

    // Importing a new leased delivery C while 'active-a' (expires: 5000) is unexpired at now=2000 rolls back.
    assert.equal(importJournalSnapshot(leaseStore, {
      schemaVersion: 1,
      shadow: true,
      entries: [
        {repositoryId: 1, deliveryId: 'leased-c', kind: 'check', subject: 9, head, owner: 'w2', generation: 1, expires: 6000, completed: false, retryAfter: null}
      ]
    }, {now: 2000}).reason, 'LEASE_CONFLICT');
    assert.equal(leaseStore.complete({repositoryId: 1, deliveryId: 'leased-c', owner: 'w2', generation: 1}, 2001), false);

    // Advancing 'expired-b' to an unexpired lease while 'active-a' is still active also rolls back.
    assert.equal(importJournalSnapshot(leaseStore, {
      schemaVersion: 1,
      shadow: true,
      entries: [
        {repositoryId: 1, deliveryId: 'expired-b', kind: 'pull', subject: 2, head, owner: 'w2', generation: 2, expires: 6000, completed: false, retryAfter: null}
      ]
    }, {now: 2000}).reason, 'LEASE_CONFLICT');
    assert.equal(leaseStore.complete(activeTicket, 2001), true);

    // Once no active lease exists at now=2001, importing 'leased-c' (expires: 6000) succeeds and fences 'expired-b' (expires -> 0).
    assert.equal(importJournalSnapshot(leaseStore, {
      schemaVersion: 1,
      shadow: true,
      entries: [
        {repositoryId: 1, deliveryId: 'leased-c', kind: 'check', subject: 9, head, owner: 'w2', generation: 1, expires: 6000, completed: false, retryAfter: null}
      ]
    }, {now: 2001}).imported, true);
    assert.equal(leaseStore.complete(expiredTicket, 500), false);
    assert.equal(leaseStore.complete({repositoryId: 1, deliveryId: 'leased-c', owner: 'w2', generation: 1}, 2002), true);
  } finally {
    leaseStore.close();
  }

  const dir = mkdtempSync(join(tmpdir(), 'factory-snap-full-'));
  const path = join(dir, 'events.sqlite');
  const fullStore = openEventJournal(path);
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      WITH RECURSIVE ids(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM ids WHERE value < 10000)
      INSERT INTO coordinator_events (repository_id, delivery_id, kind, subject, head)
      SELECT 1, 'id-' || value, 'manual', 0, '${head}' FROM ids;
    `);
    assert.equal(importJournalSnapshot(fullStore, {
      schemaVersion: 1,
      shadow: true,
      entries: [{repositoryId: 1, deliveryId: 'extra', kind: 'main', subject: 0, head, owner: null, generation: 0, expires: 0, completed: false, retryAfter: null}]
    }).reason, 'JOURNAL_FULL');

    // Multi-repository totals above 10,000 reject unscoped exports explicitly while per-repo snapshots succeed.
    db.exec(`
      WITH RECURSIVE ids(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM ids WHERE value < 10)
      INSERT INTO coordinator_events (repository_id, delivery_id, kind, subject, head)
      SELECT 2, 'r2-' || value, 'manual', 0, '${head}' FROM ids;
    `);
    assert.deepEqual(exportJournalSnapshot(fullStore), {
      shadow: true, exported: false, reason: 'SNAPSHOT_LIMIT'
    });
    const repo2Snap = exportJournalSnapshot(fullStore, {repositoryId: 2});
    assert.equal(repo2Snap.exported, true);
    assert.equal(repo2Snap.entries.length, 10);
  } finally {
    db.close();
    fullStore.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('snapshot export and import reject malformed scopes, payloads, proxies and closed handles', () => {
  const store = openEventJournal(':memory:');
  const head = 'a'.repeat(40);
  const validEntry = {
    repositoryId: 1, deliveryId: 'd-1', kind: 'pull', subject: 1, head,
    owner: null, generation: 0, expires: 0, completed: false, retryAfter: null
  };
  try {
    assert.equal(exportJournalSnapshot(null).reason, 'JOURNAL_UNAVAILABLE');
    assert.equal(importJournalSnapshot(null, {schemaVersion: 1, shadow: true, entries: []}).reason, 'JOURNAL_UNAVAILABLE');
    for (const badOptions of [
      null, [], Object.create({}), {extra: 1}, {repositoryId: 0},
      {get repositoryId() { return 1; }}
    ]) {
      assert.equal(exportJournalSnapshot(store, badOptions).reason, 'INVALID_SCOPE');
    }
    for (const badImportOpts of [
      null, [], Object.create({}), {extra: 1}, {now: -1},
      {get now() { return 1; }}
    ]) {
      assert.equal(importJournalSnapshot(store, {schemaVersion: 1, shadow: true, entries: []}, badImportOpts).reason, 'CLOCK_UNKNOWN');
    }

    const sparse = [];
    sparse[1] = validEntry;
    for (const badSnapshot of [
      null, [], Object.create({}),
      {schemaVersion: 2, shadow: true, entries: []},
      {schemaVersion: 1, shadow: false, entries: []},
      {schemaVersion: 1, shadow: true, entries: null},
      {schemaVersion: 1, shadow: true, entries: sparse},
      {schemaVersion: 1, shadow: true, entries: [], unexpected: true},
      {schemaVersion: 1, shadow: true, entries: [], get reason() { return 'x'; }},
      {schemaVersion: 1, shadow: true, entries: [validEntry, validEntry]}
    ]) {
      assert.equal(importJournalSnapshot(store, badSnapshot).reason, 'INVALID_SNAPSHOT');
    }

    for (const badEntry of [
      null, {...validEntry, extra: 1},
      {...validEntry, repositoryId: 0},
      {...validEntry, deliveryId: 'bad id'},
      {...validEntry, kind: 'unknown'},
      {...validEntry, subject: -1},
      {...validEntry, head: 'bad'},
      {...validEntry, completed: 'no'},
      {...validEntry, generation: -1},
      {...validEntry, expires: -1},
      {...validEntry, owner: 'w1'},
      {...validEntry, expires: 10},
      {...validEntry, completed: true},
      {...validEntry, retryAfter: 60000},
      {...validEntry, generation: 1, owner: null},
      {...validEntry, generation: 1, owner: 'w1', completed: true, expires: 10},
      {...validEntry, generation: 1, owner: 'w1', completed: true, retryAfter: 60000},
      {...validEntry, generation: 1, owner: 'w1', completed: false, retryAfter: 0}
    ]) {
      assert.equal(importJournalSnapshot(store, {schemaVersion: 1, shadow: true, entries: [badEntry]}).reason, 'INVALID_SNAPSHOT');
    }
  } finally {
    store.close();
  }
  assert.equal(exportJournalSnapshot(store).reason, 'JOURNAL_UNAVAILABLE');
  assert.equal(importJournalSnapshot(store, {schemaVersion: 1, shadow: true, entries: [validEntry]}).reason, 'JOURNAL_UNAVAILABLE');
});
