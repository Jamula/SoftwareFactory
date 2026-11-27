import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {runTick as executeTick} from '../../tools/engineering-coordinator/coordinator.mjs';
import {createSQLiteStateStore} from '../../tools/engineering-coordinator/sqlite-state-store.mjs';

const runTick = options => executeTick({...options,
  clock: Object.hasOwn(options, 'clock') ? options.clock : () => options.now});

const config = () => ({schemaVersion: 1,
  project: {key: 'alpha', repository: 'example/alpha', defaultBranch: 'main'},
  execution: {enabled: true, mode: 'shadow', stop: false},
  limits: {maxConcurrentLanes: 2, leaseMs: 5000, maxAttempts: 2, baseDelayMs: 5, maxDelayMs: 30},
  adapters: {workTracker: 'mock', engineeringAgent: 'mock', state: 'sqlite'},
  lanes: [{id: 'api', owners: ['src/api'], prompt: 'agent.md'}, {id: 'web', owners: ['src/web'], prompt: 'agent.md'}]});
const tasks = () => [{id: 1, lane: 'api', state: 'approved', priority: 1, dependencies: [], paths: ['src/api/one']},
  {id: 2, lane: 'web', state: 'approved', priority: 2, dependencies: [], paths: ['src/web/two']}];
function store(checkpoint = () => true) {
  return {claim: (lane, owner, now, leaseMs, _maxConcurrentLanes, workKey) =>
      ({laneId: lane, owner, generation: 1, leaseUntil: now + leaseMs, workKey, workGeneration: 1}),
    observeReserved: () => true, renew: (lane, generation, owner, now, leaseMs) => ({leaseUntil: now + leaseMs}),
    checkpoint, release: () => true};
}
const tracker = {readTask: async id => ({accepted: true, task: {id, state: 'approved'}})};
const agent = {inspect: async () => ({shadow: true, accepted: true, findings: []})};

test('stays stopped unless enabled in shadow mode with the kill switch clear', async () => {
  assert.equal((await runTick({config: {...config(), execution: {enabled: false, mode: 'shadow', stop: true}}})).reason, 'STOPPED');
  assert.equal((await runTick({config: {...config(), execution: {enabled: true, mode: 'live', stop: false}}})).reason, 'STOPPED');
});

test('validates injected runtime dependencies', async () => {
  assert.equal((await runTick({config: config(), tasks: tasks(), now: 1})).reason, 'INVALID_RUNTIME');
  assert.equal((await runTick({config: config(), tasks: [null], store: store(), tracker, agent, workerId: 'worker', now: 1})).reason,
    'INVALID_TASK');
});

test('rejects malformed config, inventory, dependencies and active lane evidence', async () => {
  const options = {config: config(), tasks: tasks(), store: store(), tracker, agent, workerId: 'worker', now: 1};
  assert.equal((await runTick({...options, config: {...config(), adapters: {...config().adapters, state: 'memory'}}})).reason,
    'INVALID_PROJECT_CONFIG');
  assert.equal((await runTick({...options, tasks: new Array(1)})).reason, 'INVALID_INVENTORY');
  assert.equal((await runTick({...options, tasks: [{...tasks()[0], dependencies: [99]}]})).reason, 'DEPENDENCY_UNKNOWN');
  const cyclic = [{...tasks()[0], dependencies: [2]}, {...tasks()[1], dependencies: [1]}];
  assert.equal((await runTick({...options, tasks: cyclic})).reason, 'DEPENDENCY_CYCLE');
  assert.equal((await runTick({...options, active: [{id: 9, lane: 'missing', paths: ['src/api/x']}]})).reason,
    'INVALID_ACTIVE_LANE');
  assert.equal((await runTick({...options, active: [{id: 9, lane: 'api', paths: ['src/api/shared']},
    {id: 10, lane: 'web', paths: ['src/api/shared']}]})).reason, 'ACTIVE_PATH_CONFLICT');
});

test('validates the runtime one requirement at a time', async () => {
  const options = {config: config(), tasks: tasks(), store: store(), tracker, agent, workerId: 'worker', now: 1};
  for (const override of [
    {store: null}, {store: {claim() {}, release() {}}}, {store: {claim() {}, checkpoint() {}, release() {}}},
    {store: {...store(), renew: null}}, {store: {...store(), observeReserved: null}}, {clock: null}, {tracker: null}, {tracker: {}},
    {agent: null}, {agent: {}}, {workerId: 1}, {now: -1}
  ]) assert.equal((await runTick({...options, ...override})).reason, 'INVALID_RUNTIME');
});

test('checkpoints shadow-only results while isolating a failing lane', async () => {
  const outcomes = await runTick({config: config(), tasks: tasks(), store: store(), tracker,
    agent: {inspect: async task => { if (task.id === 1) throw Error('private'); return {shadow: true, accepted: true, findings: ['ok']}; }},
    workerId: 'worker-a', now: 1000});
  assert.equal(outcomes.completed.length, 2);
  assert.equal(outcomes.completed[0].reason, 'LANE_FAILED');
  assert.equal(outcomes.completed[1].state, 'shadow-reviewed');
  assert.equal(outcomes.liveDispatch, false);
  assert.equal(outcomes.liveMerge, false);
});

test('passes the fresh lease check time to the checkpoint adapter', async () => {
  const clockSamples = [1001, 1300];
  const calls = [];
  const leaseCalls = [];
  const backingStore = store((...args) => { calls.push(args); return true; });
  const instrumentedStore = {...backingStore,
    claim: (...args) => { leaseCalls.push(['claim', ...args]); return backingStore.claim(...args); },
    renew: (...args) => { leaseCalls.push(['renew', ...args]); return backingStore.renew(...args); },
    release: (...args) => { leaseCalls.push(['release', ...args]); return backingStore.release(...args); }};
  const result = await runTick({config: config(), tasks: [tasks()[0]],
    store: instrumentedStore,
    tracker, agent, workerId: 'worker', now: 1000, clock: () => clockSamples.shift()});
  assert.equal(result.completed[0].state, 'shadow-reviewed');
  assert.deepEqual(leaseCalls, [
    ['claim', 'api', 'worker', 1000, 5000, 2, 'example/alpha#1'],
    ['renew', 'api', 1, 'worker', 1001, 5000, 'example/alpha#1', 1],
    ['renew', 'api', 1, 'worker', 1300, 5000, 'example/alpha#1', 1],
    ['release', 'api', 1, 'worker', 1300, 'example/alpha#1', 1]
  ]);
  assert.deepEqual(calls, [['api', 1, 'worker', {
    taskId: 1, observedState: 'approved', findings: [], completedAt: 1300
  }, 1300, 'example/alpha#1', 1]]);
});

test('fails closed when a state adapter cannot prove its repository issue reservation', async () => {
  for (const receipt of [
    {laneId: 'api', owner: 'worker', generation: 1},
    {laneId: 'api', owner: 'worker', generation: 1, workKey: 'other/repo#1', workGeneration: 1},
    {laneId: 'api', owner: 'worker', generation: 1, workKey: 'example/alpha#1', workGeneration: 0}
  ]) {
    let reads = 0;
    let inspections = 0;
    const result = await runTick({config: config(), tasks: [tasks()[0]], store: {...store(), claim: () => receipt},
      tracker: {readTask: async () => { reads++; return {accepted: true, task: {id: 1, state: 'approved'}}; }},
      agent: {inspect: async () => { inspections++; return {accepted: true, shadow: true}; }},
      workerId: 'worker', now: 1});
    assert.equal(result.completed[0].reason, 'WORK_RESERVATION_UNKNOWN');
    assert.equal(reads, 0);
    assert.equal(inspections, 0);
  }
});

test('blocks checkpointing if the clock moves backwards during inspection', async () => {
  const clockSamples = [1300, 1200];
  let wrote = false;
  const result = await runTick({config: config(), tasks: [tasks()[0]],
    store: store(() => { wrote = true; return true; }),
    tracker, agent, workerId: 'worker', now: 1000, clock: () => clockSamples.shift()});
  assert.equal(result.completed[0].reason, 'CLOCK_UNAVAILABLE');
  assert.equal(wrote, false);
});

test('blocks held leases, failed reads, failed reviews and stale checkpoints', async () => {
  const held = await runTick({config: config(), tasks: tasks(), store: {...store(), claim: () => null}, tracker, agent, workerId: 'worker', now: 1});
  assert.equal(held.completed[0].reason, 'LEASE_HELD');
  const unread = await runTick({config: config(), tasks: tasks(), store: store(), tracker: {readTask: async () => ({accepted: false})}, agent, workerId: 'worker', now: 1});
  assert.equal(unread.completed[0].reason, 'TASK_READ_FAILED');
  const rejected = await runTick({config: config(), tasks: tasks(), store: store(), tracker,
    agent: {inspect: async () => ({accepted: false})}, workerId: 'worker', now: 1});
  assert.equal(rejected.completed[0].reason, 'AGENT_REVIEW_FAILED');
  const stale = await runTick({config: config(), tasks: tasks(), store: store(() => false), tracker, agent, workerId: 'worker', now: 1});
  assert.equal(stale.completed[0].reason, 'STALE_CHECKPOINT');
});

test('passes one reservation per lane and the project capacity to the claim adapter', async () => {
  const [active, approved] = tasks();
  const requests = [];
  const reports = [];
  const firstStore = store();
  const result = await runTick({config: config(), tasks: [{...active, state: 'active'}, approved],
    active: [{id: active.id, lane: active.lane, paths: active.paths}],
    store: {...firstStore, observeReserved: (...args) => { reports.push(args); return true; }, claim: (...args) => {
      requests.push(args);
      return firstStore.claim(...args);
    }},
    tracker, agent, workerId: 'worker', now: 1000});
  assert.deepEqual(reports, [[['api'], 1000, 5000]]);
  assert.deepEqual(requests, [['web', 'worker', 1000, 5000, 2, 'example/alpha#2']]);
  assert.equal(result.completed[0].state, 'shadow-reviewed');
});

test('never claims a lane when a reported reservation cannot be persisted', async () => {
  const [active, approved] = tasks();
  for (const observeReserved of [() => false, () => { throw Error('unavailable'); }]) {
    const result = await runTick({config: config(), tasks: [{...active, state: 'active'}, approved],
      store: {...store(), observeReserved, claim() { assert.fail('unexpected claim'); }},
      tracker, agent, workerId: 'worker', now: 1000});
    assert.deepEqual(result, {shadow: true, completed: [], reason: 'ACTIVE_RESERVATIONS_UNAVAILABLE'});
  }
});

test('overlapping ticks share capacity when only one inventory reports the active external lane', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coordinator-shared-capacity-'));
  const path = join(directory, 'state.sqlite');
  const firstStore = createSQLiteStateStore(path);
  const secondStore = createSQLiteStateStore(path);
  const settings = config();
  settings.lanes.push({id: 'docs', owners: ['docs'], prompt: 'agent.md'});
  const [api, web] = tasks();
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const first = runTick({config: settings, tasks: [api], store: firstStore, tracker, workerId: 'worker-a',
    active: [{id: 3, lane: 'docs', paths: ['docs/notes.md']}],
    now: 1000, agent: {inspect: async () => {
      entered.resolve();
      await finish.promise;
      return {shadow: true, accepted: true};
    }}});
  try {
    await Promise.race([entered.promise, first.then(() => { throw Error('first worker did not wait for release'); })]);
    let secondInspections = 0;
    const options = {config: settings, tasks: [web], store: secondStore, tracker, workerId: 'worker-b',
      now: 1001, agent: {inspect: async () => {
        secondInspections++;
        return {shadow: true, accepted: true};
      }}};
    assert.equal((await runTick(options)).completed[0].reason, 'LEASE_HELD');
    assert.equal(secondInspections, 0);
    finish.resolve();
    assert.equal((await first).completed[0].state, 'shadow-reviewed');
    assert.equal((await runTick(options)).completed[0].state, 'shadow-reviewed');
    assert.equal(secondInspections, 1);
  } finally {
    finish.resolve();
    await first;
    firstStore.close();
    secondStore.close();
    rmSync(directory, {recursive: true, force: true});
  }
});

test('prevents overlapping stale inventories from assigning one repository issue to different lanes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coordinator-shared-work-'));
  const path = join(directory, 'state.sqlite');
  const firstStore = createSQLiteStateStore(path);
  const secondStore = createSQLiteStateStore(path);
  const settings = config();
  const task = {...tasks()[0], id: 9};
  const alternate = {...tasks()[1], id: 9};
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const first = runTick({config: settings, tasks: [task], store: firstStore, tracker, workerId: 'worker-a', now: 1000,
    agent: {inspect: async () => {
      entered.resolve();
      await finish.promise;
      return {shadow: true, accepted: true};
    }}});
  try {
    await Promise.race([entered.promise, first.then(() => { throw Error('first worker did not enter inspection'); })]);
    let secondInspections = 0;
    const secondOptions = {config: settings, tasks: [alternate], store: secondStore, tracker,
      workerId: 'worker-b', now: 1001,
      agent: {inspect: async () => { secondInspections++; return {shadow: true, accepted: true}; }}};
    assert.equal((await runTick(secondOptions)).completed[0].reason, 'LEASE_HELD');
    assert.equal(secondInspections, 0);
    finish.resolve();
    assert.equal((await first).completed[0].state, 'shadow-reviewed');
    assert.equal((await runTick(secondOptions)).completed[0].state, 'shadow-reviewed');
    assert.equal(secondInspections, 1);
  } finally {
    finish.resolve();
    await first;
    firstStore.close();
    secondStore.close();
    rmSync(directory, {recursive: true, force: true});
  }
});

test('renews both fences during a pending inspection beyond the original expiry', async t => {
  t.mock.timers.enable({apis: ['setInterval']});
  const state = createSQLiteStateStore(':memory:');
  const settings = config();
  settings.limits.leaseMs = 1000;
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let time = 1000;
  const first = runTick({config: settings, tasks: [{...tasks()[0], id: 9}], store: state, tracker,
    workerId: 'worker-a', now: time, clock: () => time, agent: {inspect: async () => {
      entered.resolve();
      await finish.promise;
      return {shadow: true, accepted: true};
    }}});
  try {
    await entered.promise;
    time = 1800;
    t.mock.timers.tick(333);
    time = 2600;
    t.mock.timers.tick(333);
    let inspections = 0;
    const second = await runTick({config: settings, tasks: [{...tasks()[1], id: 9}], store: state, tracker,
      workerId: 'worker-b', now: time, agent: {inspect: async () => { inspections++; }}});
    assert.equal(second.completed[0].reason, 'LEASE_HELD');
    assert.equal(inspections, 0);
    finish.resolve();
    assert.equal((await first).completed[0].state, 'shadow-reviewed');
  } finally {
    finish.resolve();
    await first;
    state.close();
  }
});

test('aborts pending inspection and blocks checkpoint when a heartbeat loses its lease', async t => {
  t.mock.timers.enable({apis: ['setInterval']});
  const state = createSQLiteStateStore(':memory:');
  const settings = config();
  settings.limits.leaseMs = 1000;
  const entered = Promise.withResolvers();
  let time = 1000;
  let signal;
  const first = runTick({config: settings, tasks: [{...tasks()[0], id: 9}], store: state, tracker,
    workerId: 'worker-a', now: time, clock: () => time, agent: {inspect: (_task, context) => {
      signal = context.signal;
      entered.resolve();
      return new Promise(resolve => signal.addEventListener('abort',
        () => resolve({shadow: true, accepted: true})));
    }}});
  try {
    await entered.promise;
    time = 2000;
    const next = state.claim('web', 'worker-b', time, 1000, 2, 'example/alpha#9');
    assert.ok(next);
    t.mock.timers.tick(333);
    assert.equal(signal.aborted, true);
    assert.equal((await first).completed[0].reason, 'LEASE_LOST');
    assert.deepEqual(state.get('api').payload, {});
    assert.equal(state.claim('docs', 'worker-c', time, 1000, 2, 'example/alpha#9'), null);
  } finally { state.close(); }
});

test('does not release an uncertain claim after a failed heartbeat', async t => {
  t.mock.timers.enable({apis: ['setInterval']});
  let renewals = 0;
  let releases = 0;
  const entered = Promise.withResolvers();
  let signal;
  const backingStore = store();
  const result = runTick({config: config(), tasks: [tasks()[0]], tracker, workerId: 'worker', now: 1,
    store: {...backingStore, renew: (...args) => ++renewals === 1 ? backingStore.renew(...args) : null,
      release: () => { releases++; }},
    agent: {inspect: (_task, context) => {
      signal = context.signal;
      entered.resolve();
      return new Promise(() => {});
    }}});
  await entered.promise;
  t.mock.timers.tick(Math.floor(config().limits.leaseMs / 3));
  assert.equal((await result).completed[0].reason, 'LEASE_LOST');
  assert.equal(signal.aborted, true);
  assert.equal(releases, 0);
});

test('persists validated reservations even if a tick has no approved candidates', async () => {
  const state = createSQLiteStateStore(':memory:');
  try {
    const [active] = tasks();
    const result = await runTick({config: config(), tasks: [{...active, state: 'active'}],
      store: state, tracker, agent, workerId: 'worker', now: 1000});
    assert.equal(result.reason, 'NO_READY_WORK');
    assert.equal(state.claim('web', 'test', 1001, 1000, 1), null);
  } finally { state.close(); }
});

test('does not review or checkpoint a task whose authoritative state changed after planning', async () => {
  let inspections = 0;
  let checkpoints = 0;
  const result = await runTick({config: config(), tasks: [tasks()[0]], store: {...store(), checkpoint: () => { checkpoints++; return true; }},
    tracker: {readTask: async id => ({accepted: true, task: {id, state: 'blocked'}})},
    agent: {inspect: async () => { inspections++; return {shadow: true, accepted: true, findings: []}; }},
    workerId: 'worker', now: 1});
  assert.equal(result.completed[0].reason, 'TASK_STATE_CHANGED');
  assert.equal(inspections, 0);
  assert.equal(checkpoints, 0);
});

test('blocks checkpointing when the final authoritative read is unavailable', async () => {
  let reads = 0;
  let checkpoints = 0;
  const result = await runTick({config: config(), tasks: [tasks()[0]], store: {...store(), checkpoint: () => { checkpoints++; return true; }},
    tracker: {readTask: async id => ++reads === 1 ? {accepted: true, task: {id, state: 'approved'}} : {accepted: false}},
    agent, workerId: 'worker', now: 1});
  assert.equal(result.completed[0].reason, 'TASK_READ_FAILED');
  assert.equal(reads, 2);
  assert.equal(checkpoints, 0);
});

test('rechecks authoritative task state after inspection and before checkpointing', async () => {
  let reads = 0;
  let checkpoints = 0;
  const result = await runTick({config: config(), tasks: [tasks()[0]], store: {...store(), checkpoint: () => { checkpoints++; return true; }},
    tracker: {readTask: async id => ({accepted: true, task: {id, state: ++reads === 1 ? 'approved' : 'blocked'}})},
    agent, workerId: 'worker', now: 1});
  assert.equal(result.completed[0].reason, 'TASK_STATE_CHANGED');
  assert.equal(reads, 2);
  assert.equal(checkpoints, 0);
});

test('cancels inspection when lease renewal fails after a delayed task read', async () => {
  let inspections = 0;
  let checkpoints = 0;
  const result = await runTick({config: config(), tasks: [tasks()[0]], store: {...store(), renew: () => null,
    checkpoint: () => { checkpoints++; return true; }},
    tracker: {readTask: async id => ({accepted: true, task: {id, state: 'approved'}})},
    agent: {inspect: async () => { inspections++; return {shadow: true, accepted: true, findings: []}; }},
    workerId: 'worker', now: 1, clock: () => 6000});
  assert.equal(result.completed[0].reason, 'LEASE_LOST');
  assert.equal(inspections, 0);
  assert.equal(checkpoints, 0);
});

test('fails closed for unusable clocks and invalid lease renewal receipts', async () => {
  const cases = [
    {clock: () => { throw Error('clock'); }, reason: 'CLOCK_UNAVAILABLE'},
    {clock: () => Number.NaN, reason: 'CLOCK_UNAVAILABLE'},
    {clock: () => 0, reason: 'CLOCK_UNAVAILABLE'},
    {clock: () => 1, store: {...store(), renew: () => { throw Error('store'); }}, reason: 'LEASE_UNAVAILABLE'},
    {clock: () => 1, store: {...store(), renew: () => ({leaseUntil: Number.NaN})}, reason: 'LEASE_LOST'},
    {clock: () => 1, store: {...store(), renew: (_lane, _generation, _owner, now) => ({leaseUntil: now})}, reason: 'LEASE_LOST'},
    {clock: () => 1, store: {...store(), renew: (_lane, _generation, _owner, now) => ({leaseUntil: now + 1})}, reason: 'LEASE_LOST'}
  ];
  for (const scenario of cases) {
    const result = await runTick({config: config(), tasks: [tasks()[0]], store: scenario.store ?? store(), tracker, agent,
      workerId: 'worker', now: 1, clock: scenario.clock});
    assert.equal(result.completed[0].reason, scenario.reason);
  }
});

test('a no-work tick is a shadow-only no-op', async () => {
  const result = await runTick({config: config(), tasks: [], store: store(), tracker, agent, workerId: 'worker', now: 2});
  assert.deepEqual(result, {shadow: true, liveDispatch: false, liveMerge: false, completed: [], reason: 'NO_READY_WORK'});
});

test('contains claim and release exceptions to their own lane', async () => {
  const claimFailure = await runTick({config: config(), tasks: tasks(), store: {...store(), claim: () => { throw Error('db'); }},
    tracker, agent, workerId: 'worker', now: 1});
  assert.equal(claimFailure.completed[0].reason, 'LANE_FAILED');
  const releaseFailure = await runTick({config: config(), tasks: tasks(), store: {...store(), release: () => { throw Error('db'); }},
    tracker, agent, workerId: 'worker', now: 1});
  assert.equal(releaseFailure.completed[0].reason, 'LANE_FAILED');
});

test('aborts a hung inspection at the bounded execution deadline, stops renewals, and lets another worker reclaim after expiry', async t => {
  t.mock.timers.enable({apis: ['setInterval']});
  const state = createSQLiteStateStore(':memory:');
  const settings = config();
  settings.limits.leaseMs = 1000;
  const entered = Promise.withResolvers();
  let time = 1000;
  let signal;
  const hung = runTick({
    config: settings, tasks: [{...tasks()[0], id: 9}], store: state, tracker,
    workerId: 'worker-a', now: time, clock: () => time, maxExecutionMs: 2000,
    agent: {inspect: (_task, context) => {
      signal = context.signal;
      entered.resolve();
      return new Promise(() => {});
    }}
  });
  try {
    await entered.promise;
    time = 1800;
    t.mock.timers.tick(333);
    time = 2600;
    t.mock.timers.tick(333);
    assert.equal(state.get('api').leaseUntil, 3600);
    time = 3000;
    t.mock.timers.tick(333);
    assert.deepEqual((await hung).completed, [{lane: 'api', taskId: 9, state: 'blocked', reason: 'EXECUTION_TIMEOUT'}]);
    assert.equal(signal.aborted, true);
    time = 3500;
    t.mock.timers.tick(2000);
    assert.equal(state.get('api').leaseUntil, 3600, 'no further renewals occur after timeout');
    const beforeExpiry = await runTick({
      config: settings, tasks: [{...tasks()[1], id: 9}], store: state, tracker,
      workerId: 'worker-b', now: 3500, agent
    });
    assert.equal(beforeExpiry.completed[0].reason, 'LEASE_HELD', 'uncertain hung claim is not released early');
    const reclaimed = await runTick({
      config: settings, tasks: [{...tasks()[0], id: 9}], store: state, tracker,
      workerId: 'worker-b', now: 3600, agent
    });
    assert.equal(reclaimed.completed[0].state, 'shadow-reviewed');
    assert.equal(state.get('api').generation, 2);
  } finally {
    state.close();
  }
});

test('enforces timer-bounded deadline when clock stalls and handles pre/post-inspection timeouts and policy validation', async t => {
  t.mock.timers.enable({apis: ['setInterval']});
  let renewals = 0;
  let releases = 0;
  let signal;
  const entered = Promise.withResolvers();
  const backingStore = store();
  const stalledClock = runTick({
    config: config(), tasks: [tasks()[0]], tracker, workerId: 'worker', now: 1000, maxExecutionMs: 500,
    store: {
      ...backingStore,
      renew: (...args) => { renewals++; return backingStore.renew(...args); },
      release: () => { releases++; return true; }
    },
    agent: {inspect: (_task, context) => {
      signal = context.signal;
      entered.resolve();
      return new Promise(() => {});
    }}
  });
  await entered.promise;
  t.mock.timers.tick(500);
  assert.equal((await stalledClock).completed[0].reason, 'EXECUTION_TIMEOUT');
  assert.equal(signal.aborted, true);
  assert.equal(renewals, 1);
  assert.equal(releases, 0);

  // Sub-interval rescheduling near deadline: leaseMs = 3000 (base step 1000ms), maxExecutionMs = 1001ms.
  const subEntered = Promise.withResolvers();
  let subSignal;
  let subTime = 1000;
  const subSettings = config();
  subSettings.limits.leaseMs = 3000;
  const subDeadline = runTick({
    config: subSettings, tasks: [tasks()[0]], store: backingStore, tracker, workerId: 'worker',
    now: subTime, clock: () => subTime, maxExecutionMs: 1001,
    agent: {inspect: (_task, context) => {
      subSignal = context.signal;
      subEntered.resolve();
      return new Promise(() => {});
    }}
  });
  await subEntered.promise;
  subTime = 2000;
  t.mock.timers.tick(1000);
  assert.equal(subSignal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(subSignal.aborted, true);
  assert.equal((await subDeadline).completed[0].reason, 'EXECUTION_TIMEOUT');

  let preInspections = 0;
  let preReleases = 0;
  const preTimeout = await runTick({
    config: config(), tasks: [tasks()[0]], tracker, workerId: 'worker', now: 1000,
    clock: () => 16000,
    store: {...backingStore, release: () => { preReleases++; return true; }},
    agent: {inspect: async () => { preInspections++; return {shadow: true, accepted: true}; }}
  });
  assert.equal(preTimeout.completed[0].reason, 'EXECUTION_TIMEOUT');
  assert.equal(preInspections, 0);
  assert.equal(preReleases, 1);

  let postCheckpoints = 0;
  let postReleases = 0;
  const samples = [1100, 16000];
  const postTimeout = await runTick({
    config: config(), tasks: [tasks()[0]], tracker, agent, workerId: 'worker', now: 1000,
    clock: () => samples.shift(),
    store: {
      ...backingStore,
      checkpoint: () => { postCheckpoints++; return true; },
      release: () => { postReleases++; return true; }
    }
  });
  assert.equal(postTimeout.completed[0].reason, 'EXECUTION_TIMEOUT');
  assert.equal(postCheckpoints, 0);
  assert.equal(postReleases, 1);

  // Hung first tracker.readTask and hung second tracker.readTask both time out via timer and release cleanly.
  let hungFirstReleases = 0;
  let hungFirstInspections = 0;
  const hungFirstRead = runTick({
    config: config(), tasks: [tasks()[0]], agent: {inspect: async () => { hungFirstInspections++; }},
    workerId: 'worker', now: 1000, maxExecutionMs: 500,
    tracker: {readTask: () => new Promise(() => {})},
    store: {...backingStore, release: () => { hungFirstReleases++; return true; }}
  });
  await Promise.resolve();
  t.mock.timers.tick(500);
  assert.equal((await hungFirstRead).completed[0].reason, 'EXECUTION_TIMEOUT');
  assert.equal(hungFirstInspections, 0);
  assert.equal(hungFirstReleases, 1);

  let hungSecondReleases = 0;
  let hungSecondCheckpoints = 0;
  let readAttempt = 0;
  const hungSecondRead = runTick({
    config: config(), tasks: [tasks()[0]], agent, workerId: 'worker', now: 1000, maxExecutionMs: 500,
    tracker: {readTask: id => ++readAttempt === 1 ?
      Promise.resolve({accepted: true, task: {id, state: 'approved'}}) :
      new Promise(() => {})},
    store: {
      ...backingStore,
      checkpoint: () => { hungSecondCheckpoints++; return true; },
      release: () => { hungSecondReleases++; return true; }
    }
  });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(500);
  assert.equal((await hungSecondRead).completed[0].reason, 'EXECUTION_TIMEOUT');
  assert.equal(hungSecondCheckpoints, 0);
  assert.equal(hungSecondReleases, 1);

  for (const invalidMax of [0, -1, 1.5, 10800001]) {
    assert.equal((await runTick({
      config: config(), tasks: tasks(), store: backingStore, tracker, agent,
      workerId: 'worker', now: 1, maxExecutionMs: invalidMax
    })).reason, 'INVALID_RUNTIME');
  }
  assert.equal((await runTick({
    config: config(), tasks: tasks(), store: backingStore, tracker, agent,
    workerId: 'worker', now: Number.MAX_SAFE_INTEGER - 1000
  })).reason, 'INVALID_RUNTIME');
  assert.equal((await runTick({
    config: config(), tasks: tasks(), store: backingStore, tracker, agent,
    workerId: 'worker', now: 1000, policy: null
  })).reason, 'SCHEDULING_POLICY_UNKNOWN');
});

test('enforces a single lane-wide deadline across sequential partial waits and synchronous monotonic overruns', async t => {
  t.mock.timers.enable({apis: ['setInterval']});
  let monoNow = 0;
  t.mock.method(performance, 'now', () => monoNow);
  const backingStore = store();

  // Three sequential 250ms phases (750ms total) with stalled clock must fail at exact 600ms maxExecutionMs.
  const read1 = Promise.withResolvers();
  const inspectPhase = Promise.withResolvers();
  const read2 = Promise.withResolvers();
  let phaseReads = 0;
  let seqCheckpoints = 0;
  let seqReleases = 0;
  const sequential = runTick({
    config: config(), tasks: [tasks()[0]], workerId: 'worker', now: 1000, maxExecutionMs: 600,
    tracker: {readTask: () => ++phaseReads === 1 ? read1.promise : read2.promise},
    agent: {inspect: () => inspectPhase.promise},
    store: {
      ...backingStore,
      checkpoint: () => { seqCheckpoints++; return true; },
      release: () => { seqReleases++; return true; }
    }
  });
  await Promise.resolve();
  monoNow += 250;
  t.mock.timers.tick(250);
  read1.resolve({accepted: true, task: {id: 1, state: 'approved'}});
  await Promise.resolve();
  await Promise.resolve();
  monoNow += 250;
  t.mock.timers.tick(250);
  inspectPhase.resolve({shadow: true, accepted: true, findings: []});
  await Promise.resolve();
  await Promise.resolve();
  monoNow += 100;
  t.mock.timers.tick(100);
  assert.equal((await sequential).completed[0].reason, 'EXECUTION_TIMEOUT');
  assert.equal(seqCheckpoints, 0);
  assert.equal(seqReleases, 1);

  // Synchronous monotonic overrun during claim (before firstRead) and during inspect (before accepting review).
  let syncReads = 0;
  const syncPreRead = await runTick({
    config: config(), tasks: [tasks()[0]], workerId: 'worker', now: 1000, maxExecutionMs: 100,
    store: {
      ...backingStore,
      claim: (...args) => {
        const claimed = backingStore.claim(...args);
        monoNow += 200;
        return claimed;
      }
    },
    tracker: {readTask: async id => { syncReads++; return {accepted: true, task: {id, state: 'approved'}}; }},
    agent
  });
  assert.equal(syncPreRead.completed[0].reason, 'EXECUTION_TIMEOUT');
  assert.equal(syncReads, 0);

  let postInspectReads = 0;
  const syncInspect = await runTick({
    config: config(), tasks: [tasks()[0]], workerId: 'worker', now: 1000, maxExecutionMs: 100,
    store: backingStore,
    tracker: {readTask: async id => { postInspectReads++; return {accepted: true, task: {id, state: 'approved'}}; }},
    agent: {inspect: async () => {
      monoNow += 200;
      return {shadow: true, accepted: true, findings: []};
    }}
  });
  assert.equal(syncInspect.completed[0].reason, 'EXECUTION_TIMEOUT');
  assert.equal(postInspectReads, 1);
});

test('recovers cross-run state across stateless SQLite stores via fenced snapshots', async () => {
  const firstRun = createSQLiteStateStore(':memory:');
  const secondRun = createSQLiteStateStore(':memory:');
  try {
    const first = await runTick({
      config: config(), tasks: [tasks()[0]], store: firstRun, tracker,
      agent: {inspect: async () => ({shadow: true, accepted: true, findings: ['verified']})},
      workerId: 'runner-1', now: 1000, clock: () => 1200
    });
    assert.equal(first.completed[0].state, 'shadow-reviewed');
    const exported = firstRun.exportSnapshot(1500);
    assert.equal(exported.ok, true);
    const transferred = JSON.parse(JSON.stringify(exported.snapshot));
    assert.deepEqual(secondRun.importSnapshot(transferred, 2000),
      {ok: true, reason: 'SNAPSHOT_IMPORTED', snapshotGeneration: 1});
    assert.deepEqual(secondRun.get('api').payload, {
      completedAt: 1200, findings: ['verified'], observedState: 'approved', taskId: 1
    });
    const second = await runTick({
      config: config(), tasks: [tasks()[0]], store: secondRun, tracker, agent,
      workerId: 'runner-2', now: 2100, clock: () => 2200
    });
    assert.equal(second.completed[0].state, 'shadow-reviewed');
    assert.equal(secondRun.get('api').generation, 2);
  } finally {
    firstRun.close();
    secondRun.close();
  }
});
