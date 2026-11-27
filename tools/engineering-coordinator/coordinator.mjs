import {performance} from 'node:perf_hooks';
import {planLanes} from './planner.mjs';

const failed = reason => ({shadow: true, completed: [], reason});
const maxExecutionCeilingMs = 10800000;

export async function runTick({
  config, tasks, active = [], store, tracker, agent, workerId, now, clock, maxExecutionMs, policy
}) {
  if (!config || config.execution?.enabled !== true || config.execution.stop !== false ||
      config.execution.mode !== 'shadow') return failed('STOPPED');
  if (!store || typeof store.claim !== 'function' || typeof store.checkpoint !== 'function' ||
      typeof store.renew !== 'function' || typeof store.release !== 'function' ||
      typeof store.observeReserved !== 'function' || !tracker || typeof tracker.readTask !== 'function' ||
      !agent || typeof agent.inspect !== 'function' || typeof workerId !== 'string' ||
      !Number.isSafeInteger(now) || now < 0 || typeof clock !== 'function' ||
      (maxExecutionMs !== undefined && (!Number.isSafeInteger(maxExecutionMs) ||
        maxExecutionMs < 1 || maxExecutionMs > maxExecutionCeilingMs))) return failed('INVALID_RUNTIME');
  const plan = planLanes(config, tasks, active, policy);
  if (plan.reason === 'INVALID_PROJECT_CONFIG' || plan.reason === 'INVALID_INVENTORY' ||
      plan.reason === 'INVALID_TASK' || plan.reason === 'DEPENDENCY_UNKNOWN' ||
      plan.reason === 'SCHEDULING_POLICY_UNKNOWN' || plan.reason === 'DEPENDENCY_CYCLE' ||
      plan.reason === 'INVALID_ACTIVE_LANE' || plan.reason === 'ACTIVE_PATH_CONFLICT') return failed(plan.reason);
  const executionBudgetMs = maxExecutionMs ?? config.limits.leaseMs * 3;
  if (!Number.isSafeInteger(now + executionBudgetMs)) return failed('INVALID_RUNTIME');
  const executionDeadline = now + executionBudgetMs;
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
    const monotonicDeadline = performance.now() + executionBudgetMs;
    const workKey = `${config.project.repository.toLowerCase()}#${item.id}`;
    const claim = store.claim(item.lane, workerId, now, config.limits.leaseMs,
      config.limits.maxConcurrentLanes, workKey);
    if (!claim) return {lane: item.lane, state: 'blocked', reason: 'LEASE_HELD'};
    if (claim.laneId !== item.lane || claim.owner !== workerId ||
        !Number.isSafeInteger(claim.generation) || claim.generation < 1 || claim.workKey !== workKey ||
        !Number.isSafeInteger(claim.workGeneration) || claim.workGeneration < 1)
      return {lane: item.lane, taskId: item.id, state: 'blocked', reason: 'WORK_RESERVATION_UNKNOWN'};
    let lastObservedTime = now;
    let elapsedTimerMs = 0;
    let releaseClaim = true;
    let inspecting = false;
    let deadlineExpired = false;
    const cancellation = new AbortController();
    const baseIntervalMs = Math.floor(config.limits.leaseMs / 3);
    const timedOut = () => deadlineExpired || performance.now() >= monotonicDeadline;
    const sampleClock = () => {
      if (timedOut()) return {reason: 'EXECUTION_TIMEOUT'};
      let currentTime;
      try { currentTime = clock(); } catch { return {reason: 'CLOCK_UNAVAILABLE'}; }
      if (!Number.isSafeInteger(currentTime) || currentTime < lastObservedTime) return {reason: 'CLOCK_UNAVAILABLE'};
      lastObservedTime = currentTime;
      return currentTime >= executionDeadline || timedOut() ? {reason: 'EXECUTION_TIMEOUT'} : {time: currentTime};
    };
    const renewLease = () => {
      const observed = sampleClock();
      if (observed.reason) return observed;
      try {
        const renewed = store.renew(item.lane, claim.generation, workerId, observed.time, config.limits.leaseMs,
          workKey, claim.workGeneration);
        return renewed && Number.isSafeInteger(observed.time + config.limits.leaseMs) &&
          Number.isSafeInteger(renewed.leaseUntil) && renewed.leaseUntil >= observed.time + config.limits.leaseMs ?
          observed : {reason: 'LEASE_LOST'};
      } catch { return {reason: 'LEASE_UNAVAILABLE'}; }
    };
    let laneTimer;
    const laneFailure = new Promise(resolve => {
      let stepMs = Math.min(baseIntervalMs, executionBudgetMs);
      const schedule = () => {
        laneTimer = setInterval(() => {
          elapsedTimerMs += stepMs;
          const checked = elapsedTimerMs >= executionBudgetMs || timedOut() ?
            {reason: 'EXECUTION_TIMEOUT'} :
            (inspecting ? renewLease() : sampleClock());
          if (checked.reason) {
            deadlineExpired = true;
            clearInterval(laneTimer);
            if (inspecting) releaseClaim = false;
            resolve(checked);
            if (inspecting) cancellation.abort();
            return;
          }
          const nextStepMs = Math.min(baseIntervalMs, executionBudgetMs - elapsedTimerMs,
            executionDeadline - checked.time);
          if (nextStepMs < stepMs) {
            clearInterval(laneTimer);
            stepMs = nextStepMs;
            schedule();
          }
        }, stepMs);
      };
      schedule();
    });
    const raceLane = operation => Promise.race([
      Promise.resolve().then(operation).then(value => ({value})),
      laneFailure
    ]);
    try {
      if (timedOut())
        return {lane: item.lane, taskId: item.id, state: 'blocked', reason: 'EXECUTION_TIMEOUT'};
      const firstRead = await raceLane(() => tracker.readTask(item.id));
      if (firstRead.reason)
        return {lane: item.lane, taskId: item.id, state: 'blocked', reason: firstRead.reason};
      const evidence = firstRead.value;
      if (!evidence?.accepted || evidence.task?.id !== item.id)
        return {lane: item.lane, state: 'blocked', reason: 'TASK_READ_FAILED'};
      if (evidence.task.state !== 'approved')
        return {lane: item.lane, taskId: item.id, state: 'blocked', reason: 'TASK_STATE_CHANGED'};
      const beforeInspection = renewLease();
      if (beforeInspection.reason)
        return {lane: item.lane, taskId: item.id, state: 'blocked', reason: beforeInspection.reason};
      inspecting = true;
      let inspection;
      try {
        inspection = await raceLane(() => agent.inspect(byId.get(item.id),
          {mode: 'shadow', projectKey: config.project.key, signal: cancellation.signal}));
      } finally {
        inspecting = false;
      }
      if (inspection.reason)
        return {lane: item.lane, taskId: item.id, state: 'blocked', reason: inspection.reason};
      if (timedOut())
        return {lane: item.lane, taskId: item.id, state: 'blocked', reason: 'EXECUTION_TIMEOUT'};
      const review = inspection.value;
      if (!review?.accepted || review.shadow !== true)
        return {lane: item.lane, state: 'blocked', reason: 'AGENT_REVIEW_FAILED'};
      const secondRead = await raceLane(() => tracker.readTask(item.id));
      if (secondRead.reason)
        return {lane: item.lane, taskId: item.id, state: 'blocked', reason: secondRead.reason};
      const finalEvidence = secondRead.value;
      if (!finalEvidence?.accepted || finalEvidence.task?.id !== item.id)
        return {lane: item.lane, state: 'blocked', reason: 'TASK_READ_FAILED'};
      if (finalEvidence.task.state !== 'approved')
        return {lane: item.lane, taskId: item.id, state: 'blocked', reason: 'TASK_STATE_CHANGED'};
      const beforeCheckpoint = renewLease();
      if (beforeCheckpoint.reason)
        return {lane: item.lane, taskId: item.id, state: 'blocked', reason: beforeCheckpoint.reason};
      const completedAt = beforeCheckpoint.time;
      const checkpointed = store.checkpoint(item.lane, claim.generation, workerId,
        {taskId: item.id, observedState: finalEvidence.task.state, findings: review.findings ?? [], completedAt},
        completedAt, workKey, claim.workGeneration);
      return checkpointed ? {lane: item.lane, taskId: item.id, state: 'shadow-reviewed'} :
        {lane: item.lane, taskId: item.id, state: 'blocked', reason: 'STALE_CHECKPOINT'};
    } catch {
      return {lane: item.lane, taskId: item.id, state: 'blocked', reason: 'LANE_FAILED'};
    } finally {
      clearInterval(laneTimer);
      if (releaseClaim)
        store.release(item.lane, claim.generation, workerId, lastObservedTime, workKey, claim.workGeneration);
    }
  }));
  const completed = outcomes.map((outcome, index) => outcome.status === 'fulfilled' ? outcome.value :
    {lane: plan.scheduled[index].lane, state: 'blocked', reason: 'LANE_FAILED'});
  return {shadow: true, liveDispatch: false, liveMerge: false, completed,
    reason: completed.length ? 'SHADOW_TICK_COMPLETE' : plan.reason};
}
