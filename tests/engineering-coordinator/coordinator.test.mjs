import test from 'node:test';
import assert from 'node:assert/strict';
import {runTick as executeTick} from '../../tools/engineering-coordinator/coordinator.mjs';

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
  return {claim: (lane, owner, now, leaseMs) => ({laneId: lane, owner, generation: 1, leaseUntil: now + leaseMs}),
    renew: (lane, generation, owner, now, leaseMs) => ({leaseUntil: now + leaseMs}), checkpoint, release: () => true};
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
    {store: {...store(), renew: null}}, {clock: null}, {tracker: null}, {tracker: {}},
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
  const result = await runTick({config: config(), tasks: [tasks()[0]],
    store: store((...args) => { calls.push(args); return true; }),
    tracker, agent, workerId: 'worker', now: 1000, clock: () => clockSamples.shift()});
  assert.equal(result.completed[0].state, 'shadow-reviewed');
  assert.deepEqual(calls, [['api', 1, 'worker', {
    taskId: 1, observedState: 'approved', findings: [], completedAt: 1300
  }, 1300]]);
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
    {clock: () => 1, store: {...store(), renew: (_lane, _generation, _owner, now) => ({leaseUntil: now})}, reason: 'LEASE_LOST'}
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
