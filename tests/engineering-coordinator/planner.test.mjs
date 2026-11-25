import test from 'node:test';
import assert from 'node:assert/strict';
import {planLanes} from '../../tools/engineering-coordinator/planner.mjs';

const config = () => ({schemaVersion: 1,
  project: {key: 'alpha', repository: 'example/alpha', defaultBranch: 'main'},
  execution: {enabled: false, mode: 'shadow', stop: true},
  limits: {maxConcurrentLanes: 2, leaseMs: 5000, maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 1000},
  adapters: {workTracker: 'mock', engineeringAgent: 'mock', state: 'sqlite'},
  lanes: [{id: 'api', owners: ['src/api'], prompt: 'agent.md'}, {id: 'web', owners: ['src/web'], prompt: 'agent.md'}]});
const task = (id, lane = 'api', state = 'approved', paths = [`src/${lane}/${id}`], dependencies = []) =>
  ({id, lane, state, priority: id, dependencies, paths});

test('orders ready work and respects accepted dependencies and path owners', () => {
  const result = planLanes(config(), [task(1), task(2, 'web'), task(3, 'api', 'approved', ['src/api/3'], [1])]);
  assert.deepEqual(result.scheduled.map(item => item.id), [1, 2]);
  assert.equal(result.reason, 'SHADOW_PLAN');
});

test('schedules at most one task per lane and fills capacity from independent lanes', () => {
  const result = planLanes(config(), [task(1), task(2), task(3, 'web')]);
  assert.deepEqual(result.scheduled.map(item => item.id), [1, 3]);
});

test('active inventory reserves its lane, paths and global capacity', () => {
  const activeTask = task(1, 'api', 'active', ['src/api/shared']);
  const result = planLanes(config(), [activeTask, task(2, 'api'), task(3, 'web')]);
  assert.deepEqual(result.scheduled.map(item => item.id), [3]);
  assert.deepEqual(planLanes(config(), [activeTask, task(3, 'web')],
    [{id: 1, lane: 'api', paths: ['src/api/shared']}]).scheduled.map(item => item.id), [3]);
  assert.equal(planLanes(config(), [activeTask, task(2, 'api', 'active')]).reason, 'INVALID_ACTIVE_LANE');
});

test('rejects an invalid config, inventory, task and active record', () => {
  assert.equal(planLanes({}, []).reason, 'INVALID_PROJECT_CONFIG');
  assert.equal(planLanes(config(), new Array(1)).reason, 'INVALID_INVENTORY');
  assert.equal(planLanes(config(), [{...task(1), paths: ['../private']}]).reason, 'INVALID_TASK');
  assert.equal(planLanes(config(), [task(1)], [{id: 4, lane: 'missing', paths: ['x']}]).reason, 'INVALID_ACTIVE_LANE');
});

test('denies duplicate task ids, unknown dependencies and dependency cycles', () => {
  assert.equal(planLanes(config(), [task(1), task(1, 'web')]).reason, 'DEPENDENCY_UNKNOWN');
  assert.equal(planLanes(config(), [task(1, 'api', 'approved', ['src/api/1'], [9])]).reason, 'DEPENDENCY_UNKNOWN');
  assert.equal(planLanes(config(), [task(1, 'api', 'approved', ['src/api/1'], [2]), task(2, 'web', 'approved', ['src/web/2'], [1])]).reason, 'DEPENDENCY_CYCLE');
});

test('rejects duplicate paths and paths outside lane ownership', () => {
  assert.equal(planLanes(config(), [task(1, 'api', 'approved', ['src/web/x'])]).reason, 'INVALID_TASK');
  assert.equal(planLanes(config(), [task(1, 'api', 'approved', ['src/api/x']), task(2, 'web')],
    [{id: 9, lane: 'api', paths: ['src/api/x']}]).scheduled.length, 1);
});

test('isolates active path conflicts and honors active lane capacity', () => {
  const tasks = [task(1), task(2, 'web')];
  assert.equal(planLanes(config(), tasks, [{id: 7, lane: 'api', paths: ['src/api/7']}]).scheduled.length, 1);
  assert.equal(planLanes(config(), tasks, [{id: 7, lane: 'api', paths: ['src/api/shared']},
    {id: 8, lane: 'web', paths: ['src/api/shared']}]).reason, 'ACTIVE_PATH_CONFLICT');
});

test('returns no ready work when every candidate is blocked or accepted', () => {
  const result = planLanes(config(), [task(1, 'api', 'blocked'), task(2, 'web', 'accepted')]);
  assert.deepEqual(result, {shadow: true, scheduled: [], reason: 'NO_READY_WORK'});
});
