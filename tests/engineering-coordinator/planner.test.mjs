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

test('within explicit priority, longest unfinished dependency chain wins; stable ties', () => {
  const c=config(); c.limits.maxConcurrentLanes=1;
  const tasks=[{...task(1),priority:0},{...task(2,'web'),priority:0},
    task(3,'web','approved',['src/web/3'],[2]),
    task(4,'api','approved',['src/api/4'],[3])];
  assert.deepEqual(planLanes(c,tasks).scheduled.map(t=>t.id),[2]);
  assert.deepEqual(planLanes(c,[{...task(1),priority:0},{...task(2,'web'),priority:0}]).scheduled.map(t=>t.id),[1]);
  assert.deepEqual(planLanes(c,[{...task(1),priority:0},{...task(2,'web'),priority:1},...tasks.slice(2)]).scheduled.map(t=>t.id),[1]);
  assert.deepEqual(planLanes(c,[...tasks.slice(0,2),{...tasks[2],state:'accepted'},{...tasks[3],state:'accepted'}]).scheduled.map(t=>t.id),[1]);
});

test('rejects out-of-scope reservations and stale task state before allocating workers', () => {
  for (const state of ['approved','accepted','blocked']) {
    assert.equal(planLanes(config(), [task(1,'web',state), task(2)],
      [{id:1,lane:'api',paths:['src/api/1']}]).reason,'INVALID_ACTIVE_LANE');
  }
  assert.equal(planLanes(config(), [task(1)], 
    [{id:9,lane:'web',paths:['src/api/unrelated']}]).reason,'INVALID_ACTIVE_LANE');
  assert.equal(planLanes(config(), [task(1)], 
    [{id:1,lane:'api',paths:['src/api/1']}]).reason,'INVALID_ACTIVE_LANE');
});
test('factory shadow planner fills twelve isolated logical lanes', () => {
  const c=config();
  c.project.repository='Jamula/SoftwareFactory';
  c.limits.maxConcurrentLanes=12;
  c.lanes=Array.from({length:13},(_,i)=>({id:'lane-'+i,owners:['src/lane-'+i],prompt:'agent.md'}));
  const tasks=c.lanes.map((lane,i)=>task(i+1,lane.id,'approved',lane.owners));
  const result=planLanes(c,tasks);
  assert.equal(result.shadow,true);
  assert.deepEqual(result.scheduled.map(x=>x.id),Array.from({length:12},(_,i)=>i+1));
  const active={...tasks[0],state:'active'};
  assert.deepEqual(planLanes(c,[active,...tasks.slice(1)]).scheduled.map(x=>x.id),Array.from({length:11},(_,i)=>i+2));
});

test('validates a dense reordered dependency graph before scheduling', () => {
  const c = config();
  c.project.repository = 'Jamula/SoftwareFactory';
  c.limits.maxConcurrentLanes = 12;
  c.lanes = Array.from({length: 12}, (_, i) => ({id: 'lane-' + i, owners: ['src/lane-' + i], prompt: 'agent.md'}));
  const acceptedIds = Array.from({length: 238}, (_, i) => i + 1);
  const accepted = acceptedIds.map((id, i) => ({
    ...task(id, 'lane-0', 'accepted', ['src/lane-0/' + id], acceptedIds.slice(0, i)), priority: 0
  }));
  const ready = c.lanes.map(({id}, i) => ({
    ...task(239 + i, id, 'approved', ['src/' + id + '/ready'], acceptedIds), priority: 1
  }));
  const inventory = [...ready, ...accepted].reverse();
  assert.deepEqual(planLanes(c, inventory).scheduled.map(item => item.id), ready.map(item => item.id));
  assert.equal(planLanes(c, [...accepted, ...ready.slice(0, -1), {
    ...ready.at(-1), dependencies: [...acceptedIds, 251]
  }]).reason, 'DEPENDENCY_UNKNOWN');
});

const ready = (id, readySince = 0, risk = 'low') => ({id, readySince, risk});
const policy = (entries, now = 10000) => ({now, agingMs: 1000, riskCeiling: 'medium', ready: entries});

test('ages waiting work into priority zero and breaks ties by readiness, then dependency depth', () => {
  const settings = config();
  settings.limits.maxConcurrentLanes = 1;
  const older = {...task(1), priority: 5};
  const newer = {...task(2, 'web'), priority: 0};
  const metadata = [ready(1), ready(2, 4000)];
  assert.equal(planLanes(settings, [older, newer], [], policy(metadata, 4000)).scheduled[0].id, 2);
  assert.equal(planLanes(settings, [newer, older], [], policy(metadata, 5000)).scheduled[0].id, 1);
  const dependent = task(3, 'web', 'approved', ['src/web/3'], [2]);
  const readySameTime = [ready(1), ready(2), ready(3)];
  assert.equal(planLanes(settings, [older, newer, dependent], [], policy(readySameTime)).scheduled[0].id, 2);
  assert.equal(planLanes(settings, [newer, older], [], policy(readySameTime.slice(0, 2))).scheduled[0].id, 1);
  assert.equal(planLanes(settings, [older, newer]).scheduled[0].id, 2, 'legacy priority sorting is unchanged');
});

test('reports risk, dependencies, lane and project capacity in deterministic order', () => {
  const settings = config();
  settings.limits.maxConcurrentLanes = 1;
  const tasks = [
    {...task(1), priority: 0},
    {...task(2, 'web'), priority: 0},
    task(3),
    task(4, 'web', 'approved', ['src/web/4'], [1]),
    task(5, 'web', 'blocked'),
    task(6, 'api', 'accepted'),
    task(7, 'web')
  ];
  const meta = [ready(7, 0, 'high'), ready(4, 100, 'medium'), ready(3), ready(2, 5000), ready(1)];
  assert.deepEqual(planLanes(settings, tasks.reverse(), [], policy(meta)), {
    shadow: true, scheduled: [{id: 1, lane: 'api', paths: ['src/api/1']}], reason: 'SHADOW_PLAN',
    blockedTasks: [
      {id: 2, reason: 'CAPACITY_FULL'},
      {id: 3, reason: 'LANE_OR_PATH_RESERVED'},
      {id: 4, reason: 'DEPENDENCY_UNACCEPTED'},
      {id: 5, reason: 'TASK_BLOCKED'},
      {id: 7, reason: 'RISK_ABOVE_CEILING'}
    ]
  });
  assert.deepEqual(planLanes(settings, [task(5, 'web', 'blocked')], [], policy([])),
    {shadow: true, scheduled: [], reason: 'NO_READY_WORK', blockedTasks: [{id: 5, reason: 'TASK_BLOCKED'}]});
  assert.deepEqual(planLanes(settings, [task(1), task(2)], [], policy([ready(1), ready(2)]))
    .blockedTasks, [{id: 2, reason: 'LANE_OR_PATH_RESERVED'}]);
});

test('fails closed on incomplete or malformed scheduling-policy evidence', () => {
  const validPolicy = policy([ready(1), ready(2)]);
  const tasks = [task(1), task(2, 'web'), task(3, 'web', 'accepted')];
  for (const supplied of [
    null, {...validPolicy, now: -1}, {...validPolicy, agingMs: 0}, {...validPolicy, riskCeiling: 'unknown'},
    {...validPolicy, ready: new Array(2)}, {...validPolicy, ready: [ready(1), ready(2), ready(3), ready(4)]},
    policy([]), policy([null, ready(2)]), policy([ready(1), ready(1)]), policy([ready(1), ready(3)]),
    policy([ready(1), ready(9)]), policy([ready(1), ready(2, 1, 'unknown')]),
    policy([ready(1), ready(2, -1)]), policy([ready(1), ready(2, 10001)])
  ]) assert.deepEqual(planLanes(config(), tasks, [], supplied),
    {shadow: true, scheduled: [], reason: 'SCHEDULING_POLICY_UNKNOWN'});
});
