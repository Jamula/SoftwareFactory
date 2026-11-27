import {validateProjectConfig} from './project-config.mjs';

const exact = (value, keys) => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));
const dense = value => Array.isArray(value) && Object.keys(value).length === value.length &&
  Array.from({length: value.length}, (_, index) => Object.hasOwn(value, index)).every(Boolean);
const positive = value => Number.isSafeInteger(value) && value > 0;
const validPath = value => typeof value === 'string' && value.length > 0 &&
  !value.startsWith('/') && !value.includes('\\') &&
  !value.split('/').some(part => !part || part === '.' || part === '..');
const overlaps = (left, right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
const blocked = reason => ({shadow: true, scheduled: [], reason});
const riskLevels = new Map([['low', 0], ['medium', 1], ['high', 2]]);
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;

export const pathsOverlap = (left, right) => validPath(left) && validPath(right) && overlaps(left, right);

function schedulingEvidence(policy, byId) {
  if (!exact(policy, ['now', 'agingMs', 'riskCeiling', 'ready']) ||
      !nonnegative(policy.now) || !positive(policy.agingMs) || !riskLevels.has(policy.riskCeiling) ||
      !dense(policy.ready) || policy.ready.length > byId.size) return null;
  const evidence = new Map();
  for (const entry of policy.ready) {
    if (!exact(entry, ['id', 'readySince', 'risk']) || byId.get(entry.id)?.state !== 'approved' ||
        evidence.has(entry.id) || !riskLevels.has(entry.risk) || !nonnegative(entry.readySince) ||
        entry.readySince > policy.now) return null;
    evidence.set(entry.id, {
      readySince: entry.readySince,
      riskLabel: entry.risk,
      risk: riskLevels.get(entry.risk),
      waitMs: policy.now - entry.readySince,
      priority: Math.max(0, byId.get(entry.id).priority - Math.floor((policy.now - entry.readySince) / policy.agingMs))
    });
  }
  if ([...byId.values()].some(task => task.state === 'approved' && !evidence.has(task.id))) return null;
  return evidence;
}

function evaluatePlan(config, tasks, active = [], policy) {
  if (!validateProjectConfig(config)) return blocked('INVALID_PROJECT_CONFIG');
  if (!dense(tasks) || tasks.length > 250 || !dense(active) || active.length > 32) return blocked('INVALID_INVENTORY');
  const lanes = new Map(config.lanes.map(lane => [lane.id, lane]));
  if (tasks.some(task => !exact(task, ['id', 'lane', 'state', 'priority', 'dependencies', 'paths']) ||
      !positive(task.id) || !lanes.has(task.lane) || !['approved', 'active', 'accepted', 'blocked'].includes(task.state) ||
      !Number.isSafeInteger(task.priority) || task.priority < 0 || task.priority > 100 ||
      !dense(task.dependencies) || task.dependencies.some(dependency => !positive(dependency)) ||
      new Set(task.dependencies).size !== task.dependencies.length ||
      !dense(task.paths) || task.paths.length === 0 || !task.paths.every(validPath) ||
      task.paths.some(path => !lanes.get(task.lane).owners.some(owner =>
        path === owner || path.startsWith(`${owner}/`))))) return blocked('INVALID_TASK');
  const byId = new Map(tasks.map(task => [task.id, task]));
  if (byId.size !== tasks.length ||
      tasks.some(task => task.dependencies.some(dependency => !byId.has(dependency))))
    return blocked('DEPENDENCY_UNKNOWN');
  let policyEvidence;
  if (policy !== undefined) {
    policyEvidence = schedulingEvidence(policy, byId);
    if (!policyEvidence) return blocked('SCHEDULING_POLICY_UNKNOWN');
  }
  const visiting = new Set();
  const visited = new Set();
  function acyclic(id) {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    if (!byId.get(id).dependencies.every(acyclic)) return false;
    visiting.delete(id);
    visited.add(id);
    return true;
  }
  if (!tasks.every(task => acyclic(task.id))) return blocked('DEPENDENCY_CYCLE');
  if (active.some(item => !exact(item, ['id', 'lane', 'paths']) || !positive(item.id) ||
      !lanes.has(item.lane) || !dense(item.paths) || !item.paths.length || !item.paths.every(validPath)))
    return blocked('INVALID_ACTIVE_LANE');
  const reservations = [...active];
  for (const task of tasks.filter(item => item.state === 'active')) {
    const existing = reservations.find(item => item.id === task.id);
    if (existing) {
      if (existing.lane !== task.lane || existing.paths.length !== task.paths.length ||
          !existing.paths.every((path, index) => path === task.paths[index])) return blocked('INVALID_ACTIVE_LANE');
      continue;
    }
    if (reservations.some(item => item.lane === task.lane)) return blocked('INVALID_ACTIVE_LANE');
    reservations.push({id: task.id, lane: task.lane, paths: task.paths});
  }
  if (reservations.length > 32 || new Set(reservations.map(item => item.id)).size !== reservations.length ||
      new Set(reservations.map(item => item.lane)).size !== reservations.length)
    return blocked('INVALID_ACTIVE_LANE');
  const laneHolder = new Map();
  const ownedEntries = [];
  for (const item of reservations) {
    laneHolder.set(item.lane, item.id);
    if (item.paths.some(path => ownedEntries.some(entry => overlaps(path, entry.path))))
      return blocked('ACTIVE_PATH_CONFLICT');
    for (const path of item.paths) ownedEntries.push({taskId: item.id, path});
  }
  // Reject a reservation inconsistent with the authoritative lane inventory.
  for (const item of reservations) {
    if (!item.paths.every(path => lanes.get(item.lane).owners.some(owner =>
      path === owner || path.startsWith(`${owner}/`)))) return blocked('INVALID_ACTIVE_LANE');
    const task = byId.get(item.id);
    if (task && (task.state !== 'active' || task.lane !== item.lane))
      return blocked('INVALID_ACTIVE_LANE');
  }
  const accepted = new Set(tasks.filter(task => task.state === 'accepted').map(task => task.id));
  // Longest unfinished downstream chain and transitive unfinished fan-out, computed only after DAG validation.
  const downstream = new Map(tasks.map(task => [task.id, []]));
  for (const task of tasks) {
    if (task.state !== 'accepted') for (const dependency of task.dependencies) downstream.get(dependency).push(task.id);
  }
  const depths = new Map();
  function depth(id) {
    if (!depths.has(id)) depths.set(id, downstream.get(id).reduce((best, child) => Math.max(best, 1 + depth(child)), 0));
    return depths.get(id);
  }
  const descendantSets = new Map();
  function unfinishedDescendants(id) {
    if (!descendantSets.has(id)) {
      const seen = new Set();
      for (const child of downstream.get(id)) {
        seen.add(child);
        for (const nested of unfinishedDescendants(child)) seen.add(nested);
      }
      descendantSets.set(id, seen);
    }
    return descendantSets.get(id);
  }
  const blockedTasks = [];
  const decisions = new Map();
  const denyTask = (task, reason) => { if (policyEvidence) blockedTasks.push({id: task.id, reason}); };
  const candidates = tasks.filter(task => {
    if (task.state === 'accepted') {
      decisions.set(task.id, {outcome: 'accepted', reason: 'ALREADY_ACCEPTED', overlappingPaths: [], conflictingTaskIds: []});
      return false;
    }
    if (task.state === 'active') {
      decisions.set(task.id, {outcome: 'active', reason: 'ACTIVE_RESERVATION', overlappingPaths: [], conflictingTaskIds: []});
      return false;
    }
    if (task.state === 'blocked') {
      denyTask(task, 'TASK_BLOCKED');
      decisions.set(task.id, {outcome: 'blocked', reason: 'TASK_BLOCKED', overlappingPaths: [], conflictingTaskIds: []});
      return false;
    }
    if (policyEvidence && policyEvidence.get(task.id).risk > riskLevels.get(policy.riskCeiling)) {
      denyTask(task, 'RISK_ABOVE_CEILING');
      decisions.set(task.id, {outcome: 'blocked', reason: 'RISK_ABOVE_CEILING', overlappingPaths: [], conflictingTaskIds: []});
      return false;
    }
    if (!task.dependencies.every(dependency => accepted.has(dependency))) {
      denyTask(task, 'DEPENDENCY_UNACCEPTED');
      decisions.set(task.id, {outcome: 'blocked', reason: 'DEPENDENCY_UNACCEPTED', overlappingPaths: [], conflictingTaskIds: []});
      return false;
    }
    return true;
  }).sort((left, right) => {
    if (policyEvidence) {
      const a = policyEvidence.get(left.id);
      const b = policyEvidence.get(right.id);
      return a.priority - b.priority || a.readySince - b.readySince ||
        depth(right.id) - depth(left.id) ||
        unfinishedDescendants(right.id).size - unfinishedDescendants(left.id).size ||
        left.id - right.id;
    }
    return left.priority - right.priority ||
      depth(right.id) - depth(left.id) ||
      unfinishedDescendants(right.id).size - unfinishedDescendants(left.id).size ||
      left.id - right.id;
  });
  const scheduled = [];
  for (const task of candidates) {
    const overlappingPaths = [...new Set(task.paths.filter(path =>
      ownedEntries.some(entry => overlaps(path, entry.path))))].sort();
    const holder = laneHolder.get(task.lane);
    if (holder !== undefined || overlappingPaths.length > 0) {
      denyTask(task, 'LANE_OR_PATH_RESERVED');
      const pathConflicts = ownedEntries
        .filter(entry => task.paths.some(path => overlaps(path, entry.path)))
        .map(entry => entry.taskId);
      const conflictingTaskIds = [...new Set(holder === undefined ? pathConflicts : [holder, ...pathConflicts])]
        .sort((a, b) => a - b);
      decisions.set(task.id, {
        outcome: 'blocked',
        reason: overlappingPaths.length > 0 ? 'PATH_OVERLAP' : 'LANE_RESERVED',
        overlappingPaths,
        conflictingTaskIds
      });
      continue;
    }
    if (scheduled.length + reservations.length >= config.limits.maxConcurrentLanes) {
      denyTask(task, 'CAPACITY_FULL');
      decisions.set(task.id, {outcome: 'blocked', reason: 'CAPACITY_FULL', overlappingPaths: [], conflictingTaskIds: []});
      continue;
    }
    scheduled.push({id: task.id, lane: task.lane, paths: [...task.paths]});
    laneHolder.set(task.lane, task.id);
    for (const path of task.paths) ownedEntries.push({taskId: task.id, path});
    decisions.set(task.id, {outcome: 'scheduled', reason: 'SCHEDULED', overlappingPaths: [], conflictingTaskIds: []});
  }
  const diagnosticRows = [...tasks].sort((a, b) => a.id - b.id).map(task => {
    const meta = policyEvidence?.get(task.id);
    const effectivePriority = meta ? meta.priority : task.priority;
    const decision = decisions.get(task.id);
    return {
      id: task.id,
      lane: task.lane,
      state: task.state,
      outcome: decision.outcome,
      reason: decision.reason,
      basePriority: task.priority,
      effectivePriority,
      agingBoost: task.priority - effectivePriority,
      waitMs: meta ? meta.waitMs : null,
      risk: meta ? meta.riskLabel : null,
      criticalPathDepth: task.state === 'accepted' ? 0 : depth(task.id),
      unfinishedDescendants: task.state === 'accepted' ? 0 : unfinishedDescendants(task.id).size,
      unacceptedDependencies: task.dependencies.filter(dependency => !accepted.has(dependency)).sort((a, b) => a - b),
      overlappingPaths: decision.overlappingPaths,
      conflictingTaskIds: decision.conflictingTaskIds
    };
  });
  const result = {shadow: true, scheduled, reason: scheduled.length ? 'SHADOW_PLAN' : 'NO_READY_WORK'};
  return {
    plan: policyEvidence ? {...result, blockedTasks: blockedTasks.sort((a, b) => a.id - b.id)} : result,
    diagnostics: {
      utilization: {
        configuredLanes: config.lanes.length,
        maxConcurrentLanes: config.limits.maxConcurrentLanes,
        reservedLanes: reservations.length,
        scheduledLanes: scheduled.length,
        availableLanes: Math.max(0, config.limits.maxConcurrentLanes - reservations.length - scheduled.length)
      },
      criticalPath: {
        maxUnfinishedDepth: diagnosticRows.reduce((best, row) => Math.max(best, row.criticalPathDepth), 0),
        maxUnfinishedDescendants: diagnosticRows.reduce((best, row) => Math.max(best, row.unfinishedDescendants), 0)
      },
      tasks: diagnosticRows
    }
  };
}

export function planLanes(config, tasks, active = [], policy) {
  const evaluated = evaluatePlan(config, tasks, active, policy);
  return evaluated.plan ?? evaluated;
}

export function diagnosePlan(config, tasks, active = [], policy) {
  const evaluated = evaluatePlan(config, tasks, active, policy);
  return evaluated.plan ? {...evaluated.plan, diagnostics: evaluated.diagnostics} : {...evaluated, diagnostics: null};
}
