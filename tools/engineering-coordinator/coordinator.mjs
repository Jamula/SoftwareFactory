import {planLanes} from './planner.mjs';

const failed = reason => ({shadow: true, completed: [], reason});

export async function runTick({config, tasks, active = [], store, tracker, agent, workerId, now, clock}) {
  if (!config || config.execution?.enabled !== true || config.execution.stop !== false ||
      config.execution.mode !== 'shadow') return failed('STOPPED');
  if (!store || typeof store.claim !== 'function' || typeof store.checkpoint !== 'function' ||
      typeof store.renew !== 'function' || typeof store.release !== 'function' ||
      typeof store.observeReserved !== 'function' || !tracker || typeof tracker.readTask !== 'function' ||
      !agent || typeof agent.inspect !== 'function' || typeof workerId !== 'string' ||
      !Number.isSafeInteger(now) || now < 0 || typeof clock !== 'function') return failed('INVALID_RUNTIME');
  const plan = planLanes(config, tasks, active);
  if (plan.reason === 'INVALID_PROJECT_CONFIG' || plan.reason === 'INVALID_INVENTORY' ||
      plan.reason === 'INVALID_TASK' || plan.reason === 'DEPENDENCY_UNKNOWN' ||
      plan.reason === 'DEPENDENCY_CYCLE' || plan.reason === 'INVALID_ACTIVE_LANE' ||
      plan.reason === 'ACTIVE_PATH_CONFLICT') return failed(plan.reason);
  const byId = new Map(tasks.map(task => [task.id, task]));
  const reserved = [...new Set([...active.map(item => item.lane),
    ...tasks.filter(task => task.state === 'active').map(task => task.lane)])];
  if (reserved.length) {
    try {
      if (store.observeReserved(reserved, now, config.limits.leaseMs) !== true)
        return failed('ACTIVE_RESERVATIONS_UNAVAILABLE');
    } catch { return failed('ACTIVE_RESERVATIONS_UNAVAILABLE'); }
  }
  const outcomes = await Promise.allSettled(plan.scheduled.map(async item => {
    const claim = store.claim(item.lane, workerId, now, config.limits.leaseMs,
      config.limits.maxConcurrentLanes);
    if (!claim) return {lane: item.lane, state: 'blocked', reason: 'LEASE_HELD'};
    let lastObservedTime = now;
    const renewLease = () => {
      let currentTime;
      try { currentTime = clock(); } catch { return {reason: 'CLOCK_UNAVAILABLE'}; }
      if (!Number.isSafeInteger(currentTime) || currentTime < lastObservedTime) return {reason: 'CLOCK_UNAVAILABLE'};
      lastObservedTime = currentTime;
      try {
        const renewed = store.renew(item.lane, claim.generation, workerId, currentTime, config.limits.leaseMs);
        return renewed && Number.isSafeInteger(renewed.leaseUntil) && renewed.leaseUntil > currentTime ?
          {time: currentTime} : {reason: 'LEASE_LOST'};
      } catch { return {reason: 'LEASE_UNAVAILABLE'}; }
    };
    try {
      const evidence = await tracker.readTask(item.id);
      if (!evidence?.accepted || evidence.task?.id !== item.id)
        return {lane: item.lane, state: 'blocked', reason: 'TASK_READ_FAILED'};
      if (evidence.task.state !== 'approved')
        return {lane: item.lane, taskId: item.id, state: 'blocked', reason: 'TASK_STATE_CHANGED'};
      const beforeInspection = renewLease();
      if (beforeInspection.reason)
        return {lane: item.lane, taskId: item.id, state: 'blocked', reason: beforeInspection.reason};
      const review = await agent.inspect(byId.get(item.id), {mode: 'shadow', projectKey: config.project.key});
      if (!review?.accepted || review.shadow !== true)
        return {lane: item.lane, state: 'blocked', reason: 'AGENT_REVIEW_FAILED'};
      const finalEvidence = await tracker.readTask(item.id);
      if (!finalEvidence?.accepted || finalEvidence.task?.id !== item.id)
        return {lane: item.lane, state: 'blocked', reason: 'TASK_READ_FAILED'};
      if (finalEvidence.task.state !== 'approved')
        return {lane: item.lane, taskId: item.id, state: 'blocked', reason: 'TASK_STATE_CHANGED'};
      const beforeCheckpoint = renewLease();
      if (beforeCheckpoint.reason)
        return {lane: item.lane, taskId: item.id, state: 'blocked', reason: beforeCheckpoint.reason};
      const completedAt = beforeCheckpoint.time;
      const checkpointed = store.checkpoint(item.lane, claim.generation, workerId,
        {taskId: item.id, observedState: finalEvidence.task.state, findings: review.findings ?? [], completedAt}, completedAt);
      return checkpointed ? {lane: item.lane, taskId: item.id, state: 'shadow-reviewed'} :
        {lane: item.lane, taskId: item.id, state: 'blocked', reason: 'STALE_CHECKPOINT'};
    } catch {
      return {lane: item.lane, taskId: item.id, state: 'blocked', reason: 'LANE_FAILED'};
    } finally {
      store.release(item.lane, claim.generation, workerId, lastObservedTime);
    }
  }));
  const completed = outcomes.map((outcome, index) => outcome.status === 'fulfilled' ? outcome.value :
    {lane: plan.scheduled[index].lane, state: 'blocked', reason: 'LANE_FAILED'});
  return {shadow: true, liveDispatch: false, liveMerge: false, completed,
    reason: completed.length ? 'SHADOW_TICK_COMPLETE' : plan.reason};
}
