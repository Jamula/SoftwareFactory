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

test('persists checkpoints across restart and rejects stale generation updates', () => withDb(filename => {
  const firstStore = createSQLiteStateStore(filename);
  const claim = firstStore.claim('api', 'worker-a', 1000, 1000);
  assert.equal(firstStore.checkpoint('api', claim.generation, 'worker-a', {taskId: 9, phase: 'reviewed'}), true);
  firstStore.close();
  const nextStore = createSQLiteStateStore(filename);
  const next = nextStore.claim('api', 'worker-b', 2000, 1000);
  assert.equal(next.generation, 2);
  assert.deepEqual(next.payload, {taskId: 9, phase: 'reviewed'});
  assert.equal(nextStore.checkpoint('api', 1, 'worker-a', {phase: 'stale'}), false);
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
  assert.equal(store.checkpoint('api', 0, 'worker', {}), false);
  assert.equal(store.checkpoint('../api', 1, 'worker', {}), false);
  assert.equal(store.checkpoint('api', 1, 'bad worker', {}), false);
  assert.equal(store.checkpoint('api', 1, 'worker', null), false);
  assert.equal(store.checkpoint('api', 1, 'worker', []), false);
  const claim = store.claim('api', 'worker', 1000, 5000);
  assert.equal(store.checkpoint('api', claim.generation, 'worker', {toJSON() { throw Error('bad'); }}), false);
  assert.equal(store.release('api', 0, 'worker', 1001), false);
  assert.equal(store.release('../api', 1, 'worker', 1001), false);
  assert.equal(store.release('api', 1, 'bad worker', 1001), false);
  assert.equal(store.release('api', 1, 'worker', -1), false);
  assert.equal(store.get('../api'), null);
  assert.equal(store.get('unknown'), null);
  store.close();
}));

test('an expired lease can be reclaimed with a new fencing generation', () => withDb(filename => {
  const store = createSQLiteStateStore(filename);
  assert.equal(store.claim('docs', 'worker-a', 1000, 1000).generation, 1);
  assert.equal(store.claim('docs', 'worker-b', 1999, 1000), null);
  assert.equal(store.claim('docs', 'worker-b', 2000, 1000).generation, 2);
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
  assert.equal(store.checkpoint('api', claim.generation, 'worker', {phase: 'late'}), false);
  assert.equal(store.release('api', claim.generation, 'worker', 2), false);
  assert.equal(store.get('api'), null);
}));
