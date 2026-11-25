import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkTrackerAdapter, createEngineeringAgentAdapter} from '../../tools/engineering-coordinator/provider-adapters.mjs';

const retry = {maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 5, sleep: async () => {},
  classify: error => ({kind: error.kind}), random: () => 0.5};

test('work tracker adapter exposes bounded read-only task metadata', async () => {
  const adapter = createWorkTrackerAdapter({readTask: async id => ({id, state: 'approved', title: 'hidden'})}, retry);
  assert.deepEqual(await adapter.readTask(7), {shadow: true, accepted: true, task: {id: 7, state: 'approved'}});
  assert.equal((await adapter.readTask(0)).reason, 'INVALID_TASK_ID');
});

test('work tracker retries transient errors and denies invalid evidence', async () => {
  let calls = 0;
  const adapter = createWorkTrackerAdapter({readTask: async id => {
    calls++;
    if (calls === 1) throw {kind: 'NETWORK_TIMEOUT'};
    return {id, state: 'open'};
  }}, retry);
  assert.equal((await adapter.readTask(3)).accepted, true);
  assert.equal(calls, 2);
  assert.equal((await createWorkTrackerAdapter({readTask: async () => ({id: 4})}, retry).readTask(3)).reason,
    'INVALID_TASK_EVIDENCE');
  assert.equal((await createWorkTrackerAdapter({readTask: async () => { throw {kind: 'FORBIDDEN'}; }}, retry).readTask(3)).reason,
    'FORBIDDEN');
});

test('rejects an incomplete tracker adapter', () => {
  assert.throws(() => createWorkTrackerAdapter({}, retry), /INVALID_WORK_TRACKER_ADAPTER/);
  assert.throws(() => createWorkTrackerAdapter({readTask() {}}, null), /INVALID_WORK_TRACKER_ADAPTER/);
});

test('agent inspection receives only bounded synthetic context and returns bounded findings', async () => {
  let seen;
  const adapter = createEngineeringAgentAdapter({inspect: async (task, context) => {
    seen = {task, context}; return {summary: 'reviewed', findings: ['one']};
  }});
  assert.deepEqual(await adapter.inspect({id: 8, title: 'x'.repeat(300), secret: 'omit'},
    {mode: 'shadow', projectKey: 'alpha'}), {shadow: true, accepted: true, summary: 'reviewed', findings: ['one']});
  assert.equal(seen.task.title.length, 240);
  assert.deepEqual(Object.keys(seen.task), ['id', 'title']);
  assert.equal((await adapter.dispatch()).reason, 'LIVE_DISPATCH_DISABLED');
});

test('agent adapter denies bad requests, results and exceptions', async () => {
  const good = createEngineeringAgentAdapter({inspect: async () => ({summary: 'ok', findings: 'invalid'})});
  assert.equal((await good.inspect({id: 1}, {mode: 'live'})).reason, 'INVALID_INSPECTION_REQUEST');
  assert.equal((await good.inspect({id: 1}, {mode: 'shadow'})).reason, 'INVALID_AGENT_RESULT');
  const sparse = createEngineeringAgentAdapter({inspect: async () => ({summary: 'ok', findings: new Array(1)})});
  assert.equal((await sparse.inspect({id: 1}, {mode: 'shadow'})).reason, 'INVALID_AGENT_RESULT');
  const broken = createEngineeringAgentAdapter({inspect: async () => { throw Error('private detail'); }});
  assert.equal((await broken.inspect({id: 1}, {mode: 'shadow'})).reason, 'AGENT_UNAVAILABLE');
  assert.throws(() => createEngineeringAgentAdapter({}), /INVALID_AGENT_ADAPTER/);
});
