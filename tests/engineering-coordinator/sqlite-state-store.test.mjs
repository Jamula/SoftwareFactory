import test from 'node:test';
import assert from 'node:assert/strict';
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
    assert.equal(store.get('api').leaseUntil, 2000);
    const next = store.claim('docs', 'worker-b', 2000, 1000, 4, first.workKey);
    assert.equal(next.workGeneration, 2);
    assert.equal(store.checkpoint('api', first.generation, first.owner, {}, 2001), false);
    assert.equal(store.renew('api', first.generation, first.owner, 2001, 1000, first.workKey, first.workGeneration), null);
  } finally { store.close(); }
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
  assert.equal(store.release('api', claim.generation, 'worker', 2), false);
  assert.equal(store.get('api'), null);
}));
