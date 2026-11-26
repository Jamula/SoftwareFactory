import {withBoundedRetry} from './retry.mjs';

const validId = value => Number.isSafeInteger(value) && value > 0;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const dense = value => Array.isArray(value) && Object.keys(value).length === value.length &&
  Array.from({length: value.length}, (_, index) => Object.hasOwn(value, index)).every(Boolean);
const denied = reason => ({shadow: true, accepted: false, reason});

export function createWorkTrackerAdapter(transport, retry) {
  if (!transport || typeof transport.readTask !== 'function' || !retry)
    throw new TypeError('INVALID_WORK_TRACKER_ADAPTER');
  return Object.freeze({
    async readTask(taskId) {
      if (!validId(taskId)) return denied('INVALID_TASK_ID');
      const result = await withBoundedRetry(() => transport.readTask(taskId), retry);
      if (!result.ok) return denied(result.reason);
      if (!record(result.value) || result.value.id !== taskId || typeof result.value.state !== 'string')
        return denied('INVALID_TASK_EVIDENCE');
      return {shadow: true, accepted: true, task: {id: taskId, state: result.value.state}};
    }
  });
}

export function createEngineeringAgentAdapter(agent) {
  if (!agent || typeof agent.inspect !== 'function') throw new TypeError('INVALID_AGENT_ADAPTER');
  return Object.freeze({
    async inspect(task, context) {
      if (!record(task) || !validId(task.id) || !record(context) || context.mode !== 'shadow')
        return denied('INVALID_INSPECTION_REQUEST');
      try {
        const result = await agent.inspect(Object.freeze({id: task.id, title: String(task.title ?? '').slice(0, 240)}),
          Object.freeze({mode: 'shadow', projectKey: context.projectKey,
            ...(context.signal === undefined ? {} : {signal: context.signal})}));
        if (!record(result) || typeof result.summary !== 'string' || result.summary.length > 1000 ||
            !dense(result.findings) || result.findings.length > 50 ||
            !result.findings.every(item => typeof item === 'string' && item.length <= 240))
          return denied('INVALID_AGENT_RESULT');
        return {shadow: true, accepted: true, summary: result.summary, findings: [...result.findings]};
      } catch {
        return denied('AGENT_UNAVAILABLE');
      }
    },
    async dispatch() { return denied('LIVE_DISPATCH_DISABLED'); }
  });
}
