import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createSQLiteStateStore} from '../../tools/engineering-coordinator/sqlite-state-store.mjs';

function withDb(run) {
  const directory = mkdtempSync(join(tmpdir(), 'engineering-coordinator-'));
  const filename = join(directory, 'state.sqlite');
  try { return run(filename); } finally { rmSync(directory, {recursive: true, force: true}); }
}

test('claims isolated lanes and denies a live duplicate claim', () => withDb(filename => {
  const store = createSQLiteStateStore(filename);
  const first = store.claim('api', 'worker-a', 1000, 5000);
  assert.equal(first.generation, 1);
  assert.equal(store.claim('api', 'worker-b', 1001, 5000), null);
  assert.equal(store.claim('web', 'worker-b', 1001, 5000).generation, 1);
  store.close();
}));

test('serializes one repository issue reservation across lanes and repositories', () => withDb(filename => {
  const a = createSQLiteStateStore(filename);
  const b = createSQLiteStateStore(filename);
  try {
    const first = a.claim('api', 'worker-a', 1000, 5000, 4, 'example/alpha#9');
    assert.equal(first.workGeneration, 1);
    assert.equal(first.workKey, 'example/alpha#9');
    assert.equal(b.claim('web', 'worker-b', 1001, 5000, 4, 'example/alpha#9'), null);
    const otherRepository = b.claim('web', 'worker-b', 1001, 5000, 4, 'example/beta#9');
    assert.equal(otherRepository.workGeneration, 1);
    assert.equal(b.release('web', otherRepository.generation, 'worker-b', 1002,
      otherRepository.workKey, otherRepository.workGeneration), true);
    assert.equal(a.release('api', first.generation, 'worker-a', 1002,
      first.workKey, first.workGeneration), true);
    const reclaimed = b.claim('docs', 'worker-b', 1003, 5000, 4, 'example/alpha#9');
    assert.equal(reclaimed.workGeneration, 2);
  } finally { a.close(); b.close(); }
}));

test('recovers work reservations after restart and fences stale owners', () => withDb(filename => {
  const firstStore = createSQLiteStateStore(filename);
  const first = firstStore.claim('api', 'worker-a', 1000, 1000, 4, 'example/alpha#9');
  firstStore.close();
  const restarted = createSQLiteStateStore(filename);
  assert.equal(restarted.claim('web', 'worker-b', 1999, 1000, 4, 'example/alpha#9'), null);
  const next = restarted.claim('web', 'worker-b', 2000, 1000, 4, 'example/alpha#9');
  assert.equal(next.workGeneration, 2);
  assert.equal(restarted.renew('api', first.generation, first.owner, 2001, 1000,
    first.workKey, first.workGeneration), null);
  assert.equal(restarted.checkpoint('api', first.generation, first.owner, {phase: 'stale'}, 2001,
    first.workKey, first.workGeneration), false);
  assert.equal(restarted.release('api', first.generation, first.owner, 2001,
    first.workKey, first.workGeneration), false);
  assert.equal(restarted.get('api').leaseUntil, 2000, 'stale release must roll back the lane update');
  assert.equal(restarted.claim('api', 'worker-c', 2001, 1000, 4, 'example/alpha#9'), null,
    'the recovered work key remains reserved');
  assert.equal(restarted.release('web', next.generation, next.owner, 2001,
    next.workKey, next.workGeneration), true);
  restarted.close();
}));

test('requires the exact work association for all operations on a work-backed lane', () => withDb(filename => {
  const store = createSQLiteStateStore(filename);
  try {
    const first = store.claim('api', 'worker', 1000, 1000, 4, 'example/alpha#9');
    const other = store.claim('web', 'worker', 1000, 1000, 4, 'example/alpha#10');
    assert.equal(store.renew('api', first.generation, first.owner, 1500, 1000), null);
    assert.equal(store.checkpoint('api', first.generation, first.owner, {}, 1500), false);
    assert.equal(store.release('api', first.generation, first.owner, 1500), false);
    assert.equal(store.renew('api', first.generation, first.owner, 1500, 1000, other.workKey, other.workGeneration), null);
    assert.equal(store.checkpoint('api', first.generation, first.owner, {}, 1500, other.workKey, other.workGeneration), false);
    assert.equal(store.release('api', first.generation, first.owner, 1500, other.workKey, other.workGeneration), false);
    assert.equal(store.checkpoint('api', first.generation + 1, first.owner, {phase: 'stale'}, 1500,
      first.workKey, first.workGeneration), false);
    assert.deepEqual(store.get('api').payload, {});
    assert.equal(store.get('api').leaseUntil, 2000);
    const next = store.claim('docs', 'worker-b', 2000, 1000, 4, first.workKey);
    assert.equal(next.workGeneration, 2);
    assert.equal(store.checkpoint('api', first.generation, first.owner, {}, 2001), false);
    assert.equal(store.renew('api', first.generation, first.owner, 2001, 1000, first.workKey, first.workGeneration), null);
  } finally { store.close(); }
}));

test('rolls back a failed association upgrade and permits recovery', () => withDb(filename => {
  const db = new DatabaseSync(filename);
  db.exec('CREATE TABLE coordinator_lanes (lane_id TEXT PRIMARY KEY)');
  assert.throws(() => createSQLiteStateStore(filename));
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='coordinator_lane_work'").get(), undefined);
  db.exec('DROP TABLE coordinator_lanes');
  db.close();
  const recovered = createSQLiteStateStore(filename);
  assert.equal(recovered.claim('api', 'worker', 1000, 1000).generation, 1);
  recovered.close();
}));

test('upgrading old state fences unknown in-flight associations until expiry', () => withDb(filename => {
  const db = new DatabaseSync(filename);
  db.exec("CREATE TABLE coordinator_lanes (lane_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, owner TEXT NOT NULL, lease_until INTEGER NOT NULL, payload TEXT NOT NULL); INSERT INTO coordinator_lanes VALUES ('api', 1, 'worker', 2000, '{}')");
  db.close();
  const store = createSQLiteStateStore(filename);
  try {
    assert.equal(store.renew('api', 1, 'worker', 1500, 1000), null);
    assert.equal(store.checkpoint('api', 1, 'worker', {}, 1500), false);
    assert.equal(store.release('api', 1, 'worker', 1500), false);
    assert.equal(store.claim('api', 'worker', 1999, 1000), null);
    const next = store.claim('api', 'worker', 2000, 1000);
    assert.equal(next.generation, 2);
    assert.deepEqual(store.renew('api', 2, 'worker', 2001, 1000), {leaseUntil: 3001});
    assert.equal(store.checkpoint('api', 2, 'worker', {phase: 'ok'}, 2001), true);
    assert.equal(store.release('api', 2, 'worker', 2001), true);
  } finally { store.close(); }
}));

test('serializes a project capacity limit across SQLite connections and counts reserved lanes once', () => withDb(filename => {
  const a = createSQLiteStateStore(filename);
  const b = createSQLiteStateStore(filename);
  try {
    const original = a.claim('api', 'worker-a', 1000, 1000, 1);
    assert.equal(original.generation, 1);
    assert.equal(b.claim('web', 'worker-b', 1999, 1000, 1), null);
    assert.equal(a.observeReserved(['docs', 'api', 'docs'], 1500, 2000), true);
    assert.equal(b.claim('web', 'worker-b', 1900, 1000, 3).generation, 1);
    assert.equal(a.claim('other', 'worker-a', 2000, 1000, 3), null);
    assert.equal(b.observeReserved(['api'], 2000, 1000), true);
    assert.equal(b.observeReserved([], 2001, 1000), true);
    assert.equal(b.claim('web', 'worker-b', 2001, 1000, 4), null);
    assert.equal(b.claim('api', 'worker-b', 3000, 1000, 4), null, 'shorter reports must not lower expiry');
    assert.equal(a.claim('api', 'worker-a', 3500, 1000, 1).generation, 2);
    assert.equal(a.release('api', 2, 'worker-a', 3501), true);
    assert.equal(b.claim('docs', 'worker-b', 3501, 1000, 1).generation, 1);
  } finally { a.close(); b.close(); }
}));

test('persists checkpoints across restart and rejects stale generation updates', () => withDb(filename => {
  const firstStore = createSQLiteStateStore(filename);
  const claim = firstStore.claim('api', 'worker-a', 1000, 1000);
  assert.equal(firstStore.checkpoint('api', claim.generation, 'worker-a', {taskId: 9, phase: 'reviewed'}, 1001), true);
  firstStore.close();
  const nextStore = createSQLiteStateStore(filename);
  const next = nextStore.claim('api', 'worker-b', 2000, 1000);
  assert.equal(next.generation, 2);
  assert.deepEqual(next.payload, {taskId: 9, phase: 'reviewed'});
  assert.equal(nextStore.checkpoint('api', 1, 'worker-a', {phase: 'stale'}, 2001), false);
  assert.equal(nextStore.release('api', next.generation, 'worker-b', 2001), true);
  nextStore.close();
  const finalStore = createSQLiteStateStore(filename);
  assert.equal(finalStore.get('api').payload.phase, 'reviewed');
  finalStore.close();
}));

test('validates lane, owner, time, lease and checkpoints', () => withDb(filename => {
  assert.throws(() => createSQLiteStateStore(''), /INVALID_STATE_PATH/);
  const store = createSQLiteStateStore(filename);
  assert.equal(store.claim('../api', 'worker', 1, 5000), null);
  assert.equal(store.claim('api', 'bad worker', 1, 5000), null);
  assert.equal(store.claim('api', 'worker', -1, 5000), null);
  assert.equal(store.claim('api', 'worker', 1, 999), null);
  assert.equal(store.claim('api', 'worker', 1, 3600001), null);
  assert.equal(store.claim('api', 'worker', 1, Number.NaN), null);
  assert.equal(store.claim('api', 'worker', Number.MAX_SAFE_INTEGER - 500, 1000), null);
  for (const maximum of [0, 1.5, 33]) assert.equal(store.claim('api', 'worker', 1, 1000, maximum), null);
  for (const reserved of [null, new Array(1), new Array(33), ['bad lane']])
    assert.equal(store.observeReserved(reserved, 1, 1000), false);
  for (const [now, duration] of [[-1, 1000], [1, 1000.1], [1, 999], [1, 3600001], [Number.MAX_SAFE_INTEGER, 1000]])
    assert.equal(store.observeReserved(['api'], now, duration), false);
  assert.equal(store.checkpoint('api', 0, 'worker', {}, 1001), false);
  assert.equal(store.checkpoint('../api', 1, 'worker', {}, 1001), false);
  assert.equal(store.checkpoint('api', 1, 'bad worker', {}, 1001), false);
  assert.equal(store.checkpoint('api', 1, 'worker', null, 1001), false);
  assert.equal(store.checkpoint('api', 1, 'worker', [], 1001), false);
  assert.equal(store.checkpoint('api', 1, 'worker', {}, -1), false);
  const claim = store.claim('api', 'worker', 1000, 5000);
  assert.equal(store.checkpoint('api', claim.generation, 'worker', {toJSON() { throw Error('bad'); }}, 1001), false);
  assert.equal(store.release('api', 0, 'worker', 1001), false);
  assert.equal(store.release('../api', 1, 'worker', 1001), false);
  assert.equal(store.release('api', 1, 'bad worker', 1001), false);
  assert.equal(store.release('api', 1, 'worker', -1), false);
  assert.equal(store.get('../api'), null);
  assert.equal(store.get('unknown'), null);
  store.close();
}));

test('validates work keys and paired work fencing inputs', () => withDb(filename => {
  const store = createSQLiteStateStore(filename);
  for (const invalid of ['', 'example#9', 'example/alpha#0', `example/${'x'.repeat(210)}#9`])
    assert.equal(store.claim('api', 'worker', 1000, 1000, 4, invalid), null);
  const maximumLength = store.claim('api', 'worker', 1000, 1000, 4,
    `${'a'.repeat(100)}/${'b'.repeat(99)}#${'9'.repeat(16)}`);
  assert.equal(maximumLength.workGeneration, 1);
  assert.equal(store.claim('web', 'worker', 1000, 1000, 4, null).workKey, undefined);
  assert.equal(store.checkpoint('api', 1, 'worker', {}, 1000, 'example/alpha#9'), false);
  assert.equal(store.checkpoint('api', 1, 'worker', {}, 1000, 'bad', 1), false);
  assert.equal(store.checkpoint('api', 1, 'worker', {}, 1000, 'example/alpha#9', 0), false);
  assert.equal(store.renew('api', 1, 'worker', 1000, 1000, 'example/alpha#9'), null);
  assert.equal(store.renew('api', 1, 'worker', 1000, 1000, 'bad', 1), null);
  assert.equal(store.renew('api', 1, 'worker', 1000, 1000, 'example/alpha#9', 0), null);
  assert.equal(store.release('api', 1, 'worker', 1000, 'example/alpha#9'), false);
  assert.equal(store.release('api', 1, 'worker', 1000, 'bad', 1), false);
  assert.equal(store.release('api', 1, 'worker', 1000, 'example/alpha#9', 0), false);
  store.close();
}));

test('rolls back partial paired-lease operations and rejects expired lane checkpoints', () => withDb(filename => {
  const store = createSQLiteStateStore(filename);
  const stale = store.claim('stale', 'worker-a', 1000, 5000, 4, 'example/alpha#10');
  assert.equal(store.release('stale', stale.generation, stale.owner, 1001,
    stale.workKey, stale.workGeneration), true);
  assert.equal(store.checkpoint('stale', stale.generation, stale.owner, {phase: 'stale'}, 1001,
    stale.workKey, stale.workGeneration), false);

  const checkpoint = store.claim('checkpoint', 'worker-a', 1000, 5000, 4, 'example/alpha#11');
  const db = new DatabaseSync(filename);
  db.exec("CREATE TRIGGER reject_checkpoint BEFORE UPDATE ON coordinator_lanes WHEN NEW.lane_id='checkpoint' BEGIN SELECT RAISE(FAIL, 'injected'); END;");
  assert.equal(store.checkpoint('checkpoint', checkpoint.generation, checkpoint.owner, {phase: 'rejected'}, 1001,
    checkpoint.workKey, checkpoint.workGeneration), false);
  assert.deepEqual(store.get('checkpoint').payload, {});
  db.exec('DROP TRIGGER reject_checkpoint');

  const renewal = store.claim('renewal', 'worker-a', 1000, 5000, 4, 'example/alpha#12');
  db.exec("CREATE TRIGGER reject_renewal BEFORE UPDATE ON coordinator_work_claims WHEN NEW.work_key='example/alpha#12' BEGIN SELECT RAISE(FAIL, 'injected'); END;");
  assert.equal(store.renew('renewal', renewal.generation, renewal.owner, 1001, 5000,
    renewal.workKey, renewal.workGeneration), null);
  assert.equal(store.get('renewal').leaseUntil, 6000);
  db.exec('DROP TRIGGER reject_renewal');

  const release = store.claim('release', 'worker-a', 1000, 5000, 4, 'example/alpha#13');
  db.exec("CREATE TRIGGER reject_release BEFORE UPDATE ON coordinator_work_claims WHEN NEW.work_key='example/alpha#13' BEGIN SELECT RAISE(FAIL, 'injected'); END;");
  assert.equal(store.release('release', release.generation, release.owner, 1001,
    release.workKey, release.workGeneration), false);
  assert.equal(store.get('release').leaseUntil, 6000);
  assert.equal(store.claim('other', 'worker-b', 1002, 1000, 4, 'example/alpha#13'), null);
  db.close();
  store.close();
}));

test('an expired lease can be reclaimed with a new fencing generation', () => withDb(filename => {
  const store = createSQLiteStateStore(filename);
  assert.equal(store.claim('docs', 'worker-a', 1000, 1000).generation, 1);
  assert.equal(store.claim('docs', 'worker-b', 1999, 1000), null);
  assert.equal(store.claim('docs', 'worker-b', 2000, 1000).generation, 2);
  store.close();
}));

test('checkpoints stop at expiry and after release even before another worker claims the lane', () => withDb(filename => {
  const store = createSQLiteStateStore(filename);
  try {
    const first = store.claim('api', 'worker-a', 1000, 1000);
    const receipt = {phase: 'reviewed'};
    assert.equal(store.checkpoint('api', first.generation, first.owner, receipt, 1999), true);
    assert.equal(store.checkpoint('api', first.generation, first.owner, {}, 2000), false);
    assert.deepEqual(store.get('api').payload, receipt);
    const second = store.claim('api', 'worker-b', 2000, 1000);
    assert.equal(store.release('api', second.generation, second.owner, 2001), true);
    assert.equal(store.checkpoint('api', second.generation, second.owner, {}, 2001), false);
    assert.equal(store.checkpoint('api', second.generation, second.owner, {}, 2000), false);
    assert.deepEqual(store.get('api').payload, receipt);
  } finally { store.close(); }
}));

test('renews only the current unexpired lease owner', () => withDb(filename => {
  const store = createSQLiteStateStore(filename);
  const claim = store.claim('api', 'worker-a', 1000, 1000);
  assert.deepEqual(store.renew('api', claim.generation, 'worker-a', 1500, 1000), {leaseUntil: 2500});
  assert.equal(store.claim('api', 'worker-b', 2499, 1000), null);
  assert.equal(store.renew('api', claim.generation, 'worker-a', 2500, 1000), null);
  const next = store.claim('api', 'worker-b', 2500, 1000);
  assert.equal(next.generation, 2);
  assert.equal(store.renew('api', claim.generation, 'worker-a', 2501, 1000), null);
  assert.equal(store.renew('api', next.generation, 'worker-b', -1, 1000), null);
  store.close();
}));

test('rejects generation overflow and rolls back failed writes', () => withDb(filename => {
  const store = createSQLiteStateStore(filename);
  const db = new DatabaseSync(filename);
  db.prepare('INSERT INTO coordinator_lanes(lane_id,generation,owner,lease_until,payload) VALUES(?,?,?,?,?)')
    .run('overflow', Number.MAX_SAFE_INTEGER, 'worker-a', 0, '{}');
  db.exec("CREATE TRIGGER reject_lane BEFORE INSERT ON coordinator_lanes WHEN NEW.lane_id='denied' BEGIN SELECT RAISE(FAIL, 'injected'); END;");
  db.close();
  assert.equal(store.claim('overflow', 'worker-b', 10, 1000), null);
  assert.equal(store.claim('denied', 'worker-b', 10, 1000), null);
  store.close();
}));

test('contains a SQLite writer lock and invalid persisted state', () => withDb(filename => {
  const store = createSQLiteStateStore(filename);
  const lock = new DatabaseSync(filename);
  lock.exec('BEGIN IMMEDIATE');
  assert.equal(store.claim('locked', 'worker-b', 10, 1000), null);
  lock.exec('ROLLBACK');
  lock.close();
  const edit = new DatabaseSync(filename);
  edit.prepare('INSERT INTO coordinator_lanes(lane_id,generation,owner,lease_until,payload) VALUES(?,?,?,?,?)')
    .run('corrupt', 1, 'worker-a', 0, 'invalid-json');
  edit.close();
  assert.equal(store.claim('corrupt', 'worker-b', 10, 1000), null);
  assert.equal(store.get('corrupt'), null);
  store.close();
}));

test('handles persistence calls after close and rejects inaccessible paths', () => withDb(filename => {
  assert.throws(() => createSQLiteStateStore(join(filename, 'missing', 'state.sqlite')));
  const store = createSQLiteStateStore(filename);
  const claim = store.claim('api', 'worker', 1, 1000);
  store.close();
  assert.equal(store.observeReserved(['web'], 1001, 1000), false);
  assert.equal(store.checkpoint('api', claim.generation, 'worker', {phase: 'late'}, 2), false);
  assert.equal(store.renew('api', claim.generation, 'worker', 2, 1000), null);
  assert.equal(store.release('api', claim.generation, 'worker', 2), false);
  assert.equal(store.exportSnapshot(1002).reason, 'STORE_UNAVAILABLE');
  assert.equal(store.get('api'), null);
}));

test('exports deterministic integrity-checked snapshots and recovers leases, reservations, legacy fences, and checkpoints on a fresh store', () => withDb(filename => {
  const seed = new DatabaseSync(filename);
  seed.exec("CREATE TABLE coordinator_lanes (lane_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, owner TEXT NOT NULL, lease_until INTEGER NOT NULL, payload TEXT NOT NULL); CREATE TABLE coordinator_work_claims (work_key TEXT PRIMARY KEY, lane_id TEXT NOT NULL, generation INTEGER NOT NULL, owner TEXT NOT NULL, lease_until INTEGER NOT NULL); INSERT INTO coordinator_lanes VALUES ('legacy', 1, 'worker-legacy', 2500, '{}'); INSERT INTO coordinator_work_claims VALUES ('example/alpha#99', 'legacy', 1, 'worker-legacy', 2500)");
  seed.close();

  const source = createSQLiteStateStore(filename);
  const target = createSQLiteStateStore(':memory:');
  try {
    const completed = source.claim('api', 'worker-a', 1000, 1000, 4, 'example/alpha#9');
    assert.equal(source.checkpoint('api', completed.generation, 'worker-a',
      {z: [1, true, 'ok', null], a: {nested: 2}}, 1200, completed.workKey, completed.workGeneration), true);
    assert.equal(source.release('api', completed.generation, 'worker-a', 1300,
      completed.workKey, completed.workGeneration), true);
    const inFlight = source.claim('web', 'worker-b', 1400, 2000, 4, 'example/alpha#10');
    const laneOnly = source.claim('docs', 'worker-c', 1400, 1000, 4);
    assert.equal(source.release('docs', laneOnly.generation, 'worker-c', 1450), true);
    assert.equal(source.observeReserved(['ops'], 400, 1000), true);
    assert.equal(source.observeReserved(['qa'], 1500, 2000), true);

    const exported = source.exportSnapshot(1500);
    assert.equal(exported.ok, true);
    assert.equal(exported.reason, 'SNAPSHOT_EXPORTED');
    assert.equal(exported.snapshot.snapshotGeneration, 1);
    assert.deepEqual(exported.snapshot.lanes.map(item => item.laneId), ['api', 'docs', 'legacy', 'web']);
    assert.deepEqual(Object.keys(exported.snapshot.lanes[0].payload), ['a', 'z']);
    assert.deepEqual(exported.snapshot.reservations, [{laneId: 'qa', expires: 3500}]);

    const wireCopy = JSON.parse(JSON.stringify(exported.snapshot));
    assert.deepEqual(target.importSnapshot(wireCopy, 1600),
      {ok: true, reason: 'SNAPSHOT_IMPORTED', snapshotGeneration: 1});
    assert.deepEqual(target.get('api').payload, {a: {nested: 2}, z: [1, true, 'ok', null]});
    assert.equal(target.claim('web', 'worker-x', 2000, 1000, 4), null);
    assert.equal(target.claim('docs', 'worker-x', 2000, 1000, 4, 'example/alpha#10'), null);
    assert.equal(target.renew('legacy', 1, 'worker-legacy', 2000, 1000), null, 'legacy fence survives import');
    assert.deepEqual(target.renew('web', inFlight.generation, 'worker-b', 2000, 2000,
      inFlight.workKey, inFlight.workGeneration), {leaseUntil: 4000});
    assert.equal(target.claim('qa', 'worker-x', 2000, 1000, 4), null, 'unexpired reservation survives import');
    const reclaimedApi = target.claim('api', 'worker-d', 2000, 1000, 4, 'example/alpha#9');
    assert.equal(reclaimedApi.generation, 2);
    assert.equal(reclaimedApi.workGeneration, 2);
    assert.equal(target.exportSnapshot(2500).snapshot.snapshotGeneration, 2);
  } finally {
    source.close();
    target.close();
  }
}));

test('rejects stale snapshot generations, missing lanes or work keys, and generation regressions', () => {
  const source = createSQLiteStateStore(':memory:');
  const target = createSQLiteStateStore(':memory:');
  const splitBrain = createSQLiteStateStore(':memory:');
  try {
    const claim = source.claim('api', 'worker-a', 1000, 1000, 4, 'example/alpha#9');
    source.release('api', claim.generation, 'worker-a', 1100, claim.workKey, claim.workGeneration);
    const firstSnap = source.exportSnapshot(1200).snapshot;
    assert.equal(target.importSnapshot(firstSnap, 1300).ok, true);
    assert.equal(target.importSnapshot(firstSnap, 1400).reason, 'STALE_GENERATION');

    // Advance target locally to generation 2 on lane api and work key example/alpha#9.
    const secondClaim = target.claim('api', 'worker-a', 1400, 1000, 4, 'example/alpha#9');
    target.release('api', secondClaim.generation, 'worker-a', 1500, secondClaim.workKey, secondClaim.workGeneration);

    // Split-brain store has higher snapshotGeneration (3), but is missing 'api' or has lower lane/work generations.
    splitBrain.exportSnapshot(1500);
    splitBrain.exportSnapshot(1600);
    const missingLaneSnap = splitBrain.exportSnapshot(1700).snapshot;
    assert.equal(target.importSnapshot(missingLaneSnap, 1800).reason, 'STALE_GENERATION');

    const regressedLane = splitBrain.claim('api', 'worker-a', 1800, 1000, 4);
    splitBrain.release('api', regressedLane.generation, 'worker-a', 1850);
    const lowerLaneGenSnap = splitBrain.exportSnapshot(1900).snapshot;
    assert.equal(target.importSnapshot(lowerLaneGenSnap, 2000).reason, 'STALE_GENERATION');

    const secondLaneClaim = splitBrain.claim('api', 'worker-a', 2000, 1000, 4);
    splitBrain.release('api', secondLaneClaim.generation, 'worker-a', 2050);
    const thirdLaneClaim = splitBrain.claim('api', 'worker-a', 2060, 1000, 4);
    splitBrain.release('api', thirdLaneClaim.generation, 'worker-a', 2080);
    const missingWorkSnap = splitBrain.exportSnapshot(2100).snapshot;
    assert.equal(target.importSnapshot(missingWorkSnap, 2200).reason, 'STALE_GENERATION');

    const regressedWork = splitBrain.claim('web', 'worker-a', 2200, 1000, 4, 'example/alpha#9');
    splitBrain.release('web', regressedWork.generation, 'worker-a', 2250, regressedWork.workKey, regressedWork.workGeneration);
    const lowerWorkGenSnap = splitBrain.exportSnapshot(2300).snapshot;
    assert.equal(target.importSnapshot(lowerWorkGenSnap, 2400).reason, 'STALE_GENERATION');
    assert.equal(target.get('api').generation, 2);
  } finally {
    source.close();
    target.close();
    splitBrain.close();
  }
});

test('rejects tampered digests and malformed or internally inconsistent snapshot payloads', () => {
  const source = createSQLiteStateStore(':memory:');
  const target = createSQLiteStateStore(':memory:');
  try {
    source.claim('api', 'worker-a', 1000, 2000, 4, 'example/alpha#9');
    source.observeReserved(['docs'], 1000, 2000);
    const valid = JSON.parse(JSON.stringify(source.exportSnapshot(1500).snapshot));

    for (const mutate of [
      snap => { snap.snapshotGeneration = 2; },
      snap => { snap.exportedAt = 1501; },
      snap => { snap.lanes[0].owner = 'worker-b'; },
      snap => { snap.lanes[0].payload = {tampered: true}; },
      snap => { snap.workClaims[0].leaseUntil = 2999; },
      snap => { snap.reservations[0].expires = 2999; }
    ]) {
      const copy = JSON.parse(JSON.stringify(valid));
      mutate(copy);
      assert.equal(target.importSnapshot(copy, 2000).reason, 'SNAPSHOT_TAMPERED');
    }

    let deep = {leaf: 1};
    for (let i = 0; i < 17; i++) deep = {next: deep};
    const getterSnap = JSON.parse(JSON.stringify(valid));
    Object.defineProperty(getterSnap, 'schemaVersion', {get: () => 1, enumerable: true});
    const sparseLanes = new Array(1);
    const nonDataArray = [valid.lanes[0]];
    Object.defineProperty(nonDataArray, '0', {get: () => valid.lanes[0], enumerable: true});

    for (const malformed of [
      null, [], new Proxy(valid, {}), getterSnap,
      {...valid, extra: true}, {...valid, schemaVersion: 2}, {...valid, snapshotGeneration: 0},
      {...valid, exportedAt: -1}, {...valid, digest: 'bad'},
      {...valid, lanes: sparseLanes}, {...valid, lanes: nonDataArray},
      {...valid, lanes: [{...valid.lanes[0], laneId: '../bad'}]},
      {...valid, lanes: [valid.lanes[0], valid.lanes[0]]},
      {...valid, lanes: [{...valid.lanes[0], payload: deep}]},
      {...valid, lanes: [{...valid.lanes[0], payload: {bad: Number.NaN}}]},
      {...valid, lanes: [{...valid.lanes[0], payload: {bad: [undefined]}}]},
      {...valid, lanes: [{...valid.lanes[0], payload: {bad: new Array(1)}}]},
      {...valid, lanes: [{...valid.lanes[0], payload: {bad: new Date()}}]},
      {...valid, lanes: [{...valid.lanes[0], payload: {huge: 'x'.repeat(65536)}}]},
      {...valid, lanes: [{...valid.lanes[0], workKey: 'example/alpha#9', workGeneration: 0}]},
      {...valid, workClaims: [{...valid.workClaims[0], workKey: 'bad'}]},
      {...valid, workClaims: [valid.workClaims[0], valid.workClaims[0]]},
      {...valid, reservations: [{laneId: 'docs', expires: 1500}]},
      {...valid, reservations: [valid.reservations[0], valid.reservations[0]]},
      JSON.parse(JSON.stringify(valid).replace('"payload":{}', '"payload":{"__proto__":{"tampered":true}}')),
      rehash({...valid, workClaims: []}),
      rehash({...valid, lanes: [], workClaims: [valid.workClaims[0]]}),
      rehash({
        ...valid,
        lanes: [{...valid.lanes[0], leaseUntil: 0, workGeneration: 2}],
        workClaims: [{...valid.workClaims[0], leaseUntil: 0, generation: 1}]
      }),
      rehash({
        ...valid,
        lanes: [],
        workClaims: [{...valid.workClaims[0], leaseUntil: 0}]
      })
    ]) {
      assert.equal(target.importSnapshot(malformed, 2000).reason, 'INVALID_SNAPSHOT');
    }
  } finally {
    source.close();
    target.close();
  }
});

function rehash(snap) {
  const digest = createHash('sha256').update(JSON.stringify([
    snap.schemaVersion, snap.snapshotGeneration, snap.exportedAt,
    snap.lanes, snap.workClaims, snap.reservations
  ])).digest('hex');
  return {...snap, digest};
}

test('rejects active ownership conflicts, clock rollback, corrupt state export, overflow, and failed import writes', () => withDb(filename => {
  const source = createSQLiteStateStore(':memory:');
  const target = createSQLiteStateStore(filename);
  try {
    assert.equal(source.exportSnapshot(-1).reason, 'CLOCK_UNAVAILABLE');
    const c1 = source.claim('api', 'worker-a', 2000, 2000, 4, 'example/alpha#9');
    assert.equal(source.exportSnapshot(1999).reason, 'CLOCK_ROLLBACK');
    const activeSnap = source.exportSnapshot(2500).snapshot;

    assert.equal(target.importSnapshot(activeSnap, -1).reason, 'CLOCK_UNAVAILABLE');
    assert.equal(target.importSnapshot(activeSnap, 2499).reason, 'CLOCK_ROLLBACK');

    // Local active lease blocks import.
    const localClaim = target.claim('docs', 'worker-local', 2500, 1000);
    assert.equal(target.importSnapshot(activeSnap, 2600).reason, 'ACTIVE_OWNERSHIP_CONFLICT');
    target.release('docs', localClaim.generation, 'worker-local', 2600);

    // Local unexpired reservation on 'api' conflicts with incoming active lease on 'api' (until 4000),
    // while a local observed_at > import now or an earlier exportedAt than last_snapshot_at fails CLOCK_ROLLBACK.
    target.observeReserved(['api'], 2600, 1000);
    assert.equal(target.importSnapshot(activeSnap, 3000).reason, 'ACTIVE_OWNERSHIP_CONFLICT');
    target.observeReserved(['ops'], 3600, 2000);
    assert.equal(target.importSnapshot(activeSnap, 3500).reason, 'CLOCK_ROLLBACK');

    const olderExport = createSQLiteStateStore(':memory:');
    const targetWithSnapshot = createSQLiteStateStore(':memory:');
    try {
      const snapAt3000 = targetWithSnapshot.exportSnapshot(3000).snapshot;
      assert.equal(snapAt3000.snapshotGeneration, 1);
      olderExport.exportSnapshot(2000);
      const gen2At2100 = olderExport.exportSnapshot(2100).snapshot;
      assert.equal(targetWithSnapshot.importSnapshot(gen2At2100, 3100).reason, 'CLOCK_ROLLBACK');
    } finally {
      olderExport.close();
      targetWithSnapshot.close();
    }

    source.release('api', c1.generation, 'worker-a', 3650, c1.workKey, c1.workGeneration);
    const idleSnap = source.exportSnapshot(3700).snapshot;
    // Note: target already has 'docs' at generation 1, so export from a store that also includes 'docs' to test owner mismatch & trigger rollback.
    const fullSource = createSQLiteStateStore(':memory:');
    try {
      const badDocs = fullSource.claim('docs', 'different-owner', 3700, 1000);
      fullSource.release('docs', badDocs.generation, 'different-owner', 3710);
      const ownerConflictSnap = fullSource.exportSnapshot(3720).snapshot;
      assert.equal(target.importSnapshot(ownerConflictSnap, 3750).reason, 'ACTIVE_OWNERSHIP_CONFLICT');
    } finally { fullSource.close(); }

    const workConflictTarget = createSQLiteStateStore(':memory:');
    const workConflictSource = createSQLiteStateStore(':memory:');
    try {
      const wc = workConflictTarget.claim('api', 'worker-a', 1000, 1000, 4, 'example/alpha#9');
      workConflictTarget.release('api', wc.generation, 'worker-a', 1100, wc.workKey, wc.workGeneration);
      const wc2 = workConflictSource.claim('api', 'worker-a', 1000, 1000);
      workConflictSource.release('api', wc2.generation, 'worker-a', 1050);
      const wc3 = workConflictSource.claim('web', 'worker-b', 1100, 1000, 4, 'example/alpha#9');
      workConflictSource.release('web', wc3.generation, 'worker-b', 1150, wc3.workKey, wc3.workGeneration);
      const workOwnerConflictSnap = workConflictSource.exportSnapshot(1200).snapshot;
      assert.equal(workConflictTarget.importSnapshot(workOwnerConflictSnap, 1300).reason, 'ACTIVE_OWNERSHIP_CONFLICT');
    } finally {
      workConflictTarget.close();
      workConflictSource.close();
    }

    // Trigger rollback during importSnapshot leaves DB unchanged.
    const freshTarget = createSQLiteStateStore(filename);
    const db = new DatabaseSync(filename);
    db.exec('DELETE FROM coordinator_lanes; UPDATE coordinator_snapshot_fence SET snapshot_generation = 0, observed_at = 0;');
    db.exec("CREATE TRIGGER reject_import BEFORE INSERT ON coordinator_lanes BEGIN SELECT RAISE(FAIL, 'injected'); END;");
    assert.equal(freshTarget.importSnapshot(idleSnap, 3800).reason, 'STORE_UNAVAILABLE');
    assert.equal(freshTarget.get('api'), null);
    db.exec('DROP TRIGGER reject_import');
    assert.equal(freshTarget.importSnapshot(idleSnap, 3800).ok, true);

    // Corrupt state and generation overflow on exportSnapshot.
    db.exec('UPDATE coordinator_snapshot_fence SET snapshot_generation = 9007199254740991 WHERE id = 1');
    assert.equal(freshTarget.exportSnapshot(3900).reason, 'GENERATION_OVERFLOW');
    db.exec('UPDATE coordinator_snapshot_fence SET snapshot_generation = 1 WHERE id = 1');
    db.prepare('INSERT INTO coordinator_lanes(lane_id,generation,owner,lease_until,payload) VALUES(?,?,?,?,?)')
      .run('corrupt', 1, 'worker-a', 0, 'not-json');
    assert.equal(freshTarget.exportSnapshot(3900).reason, 'CORRUPT_STATE');
    db.close();
    freshTarget.close();
  } finally {
    source.close();
    target.close();
  }
}));

test('fences same-generation lease resurrection, checkpoint clobbering, proto payloads, and table capacity bounds', () => withDb(filename => {
  const runner1 = createSQLiteStateStore(filename);
  const runner2 = createSQLiteStateStore(':memory:');
  try {
    const claim = runner1.claim('api', 'worker-a', 1000, 5000, 4, 'example/alpha#9');
    assert.equal(runner1.checkpoint('api', claim.generation, 'worker-a',
      JSON.parse('{"__proto__":{"bad":1},"x":1}'), 1100, claim.workKey, claim.workGeneration), false);
    assert.equal(runner1.checkpoint('api', claim.generation, 'worker-a',
      new Date(), 1100, claim.workKey, claim.workGeneration), false);
    assert.equal(runner1.checkpoint('api', claim.generation, 'worker-a',
      {items: Array.from({length: 1001}, () => 1)}, 1100, claim.workKey, claim.workGeneration), false);

    // Export in-flight S1, import on runner2, then checkpoint and release on runner1.
    const inFlightSnap = runner1.exportSnapshot(1200).snapshot;
    assert.equal(runner2.importSnapshot(inFlightSnap, 1300).ok, true);
    assert.equal(runner1.checkpoint('api', claim.generation, 'worker-a',
      {findings: ['critical']}, 1400, claim.workKey, claim.workGeneration), true);
    assert.equal(runner1.release('api', claim.generation, 'worker-a',
      1500, claim.workKey, claim.workGeneration), true);

    // Re-exporting stale in-flight state from runner2 (snapshotGeneration 2) must NOT resurrect lease or clobber checkpoint!
    const staleReexport = runner2.exportSnapshot(1600).snapshot;
    assert.equal(runner1.importSnapshot(staleReexport, 1700).reason, 'STALE_GENERATION');
    assert.deepEqual(runner1.get('api'), {
      laneId: 'api', generation: 1, owner: 'worker-a', leaseUntil: 0, payload: {findings: ['critical']}
    });

    // Conversely, runner2 (whose expired local claim had empty '{}' payload) CAN advance to runner1's released checkpoint!
    runner1.exportSnapshot(6050);
    const completedSnap = runner1.exportSnapshot(6100).snapshot;
    assert.equal(runner2.importSnapshot(completedSnap, 6200).ok, true);
    assert.deepEqual(runner2.get('api'), {
      laneId: 'api', generation: 1, owner: 'worker-a', leaseUntil: 0, payload: {findings: ['critical']}
    });

    // Divergent terminal checkpoint, work-association mismatch, pre-renewal regression, and corrupt local row on same generation.
    const a = createSQLiteStateStore(':memory:');
    const b = createSQLiteStateStore(':memory:');
    try {
      const ca = a.claim('api', 'worker-a', 1000, 1000);
      a.checkpoint('api', ca.generation, 'worker-a', {side: 'a'}, 1100);
      a.release('api', ca.generation, 'worker-a', 1200);
      const cb = b.claim('api', 'worker-a', 1000, 1000);
      b.exportSnapshot(1050);
      b.checkpoint('api', cb.generation, 'worker-a', {side: 'b'}, 1100);
      b.release('api', cb.generation, 'worker-a', 1200);
      const divergentTerminal = b.exportSnapshot(1300).snapshot;
      assert.equal(a.importSnapshot(divergentTerminal, 1400).reason, 'ACTIVE_OWNERSHIP_CONFLICT');
    } finally { a.close(); b.close(); }

    const assocA = createSQLiteStateStore(':memory:');
    const assocB = createSQLiteStateStore(':memory:');
    try {
      const la = assocA.claim('api', 'worker-a', 1000, 1000);
      assocA.release('api', la.generation, 'worker-a', 1100);
      const lb = assocB.claim('api', 'worker-a', 1000, 1000, 4, 'example/alpha#9');
      assocB.release('api', lb.generation, 'worker-a', 1100, lb.workKey, lb.workGeneration);
      const assocSnap = assocB.exportSnapshot(1200).snapshot;
      assert.equal(assocA.importSnapshot(assocSnap, 1300).reason, 'ACTIVE_OWNERSHIP_CONFLICT');
    } finally { assocA.close(); assocB.close(); }

    const preRenewLocal = createSQLiteStateStore(':memory:');
    const preRenewRemote = createSQLiteStateStore(':memory:');
    try {
      const pr = preRenewRemote.claim('api', 'worker-a', 1000, 1000, 4, 'example/alpha#9');
      const snap1 = preRenewRemote.exportSnapshot(1100).snapshot;
      assert.equal(preRenewLocal.importSnapshot(snap1, 1200).ok, true);
      assert.ok(preRenewLocal.renew('api', pr.generation, 'worker-a', 1500, 1000, pr.workKey, pr.workGeneration));
      const snap2 = preRenewRemote.exportSnapshot(2600).snapshot;
      assert.equal(preRenewLocal.importSnapshot(snap2, 2700).reason, 'STALE_GENERATION');
    } finally { preRenewLocal.close(); preRenewRemote.close(); }

    // Total active reservations capped at 32 across multiple observeReserved calls.
    const capStore = createSQLiteStateStore(':memory:');
    try {
      assert.equal(capStore.observeReserved(Array.from({length: 20}, (_, i) => `r-${i}`), 1000, 5000), true);
      assert.equal(capStore.observeReserved(Array.from({length: 20}, (_, i) => `s-${i}`), 1100, 5000), false);
    } finally { capStore.close(); }

    // Corrupt local lane payload during same-generation import check and over-limit lanes fail closed.
    const db = new DatabaseSync(filename);
    db.prepare("UPDATE coordinator_lanes SET payload='bad-json' WHERE lane_id='api'").run();
    const corruptLocal = createSQLiteStateStore(filename);
    const runner3 = createSQLiteStateStore(':memory:');
    try {
      runner3.importSnapshot(completedSnap, 6300);
      const nextSnap = runner3.exportSnapshot(6400).snapshot;
      assert.equal(corruptLocal.importSnapshot(nextSnap, 6500).reason, 'CORRUPT_STATE');
      db.exec("DELETE FROM coordinator_lanes; DELETE FROM coordinator_lane_work; DELETE FROM coordinator_work_claims;");
      const insertLane = db.prepare("INSERT INTO coordinator_lanes VALUES (?, 1, 'w', 0, '{}')");
      const insertAssoc = db.prepare('INSERT INTO coordinator_lane_work VALUES (?, 1, NULL, NULL)');
      for (let i = 0; i < 250; i++) {
        insertLane.run(`lane-${i}`);
        insertAssoc.run(`lane-${i}`);
      }
      assert.equal(corruptLocal.claim('extra-lane', 'w', 7000, 1000), null);
      insertLane.run('overflow-lane');
      insertAssoc.run('overflow-lane');
      assert.equal(corruptLocal.exportSnapshot(7100).reason, 'CORRUPT_STATE');
    } finally {
      runner3.close();
      corruptLocal.close();
      db.close();
    }
  } finally {
    runner1.close();
    runner2.close();
  }
}));
