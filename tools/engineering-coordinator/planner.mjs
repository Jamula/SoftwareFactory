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

export function planLanes(config, tasks, active = []) {
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
  if (new Set(tasks.map(task => task.id)).size !== tasks.length ||
      tasks.some(task => task.dependencies.some(dependency => !tasks.some(candidate => candidate.id === dependency))))
    return blocked('DEPENDENCY_UNKNOWN');
  const byId = new Map(tasks.map(task => [task.id, task]));
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
  const laneCounts = new Map();
  const ownedPaths = [];
  for (const item of reservations) {
    laneCounts.set(item.lane, (laneCounts.get(item.lane) ?? 0) + 1);
    if (item.paths.some(path => ownedPaths.some(owned => overlaps(path, owned))))
      return blocked('ACTIVE_PATH_CONFLICT');
    ownedPaths.push(...item.paths);
  }
  const accepted = new Set(tasks.filter(task => task.state === 'accepted').map(task => task.id));
  // Longest unfinished downstream chain, computed only after DAG validation.
  const downstream = new Map(tasks.map(task => [task.id, []]));
  for (const task of tasks) {
    if (task.state !== 'accepted') for (const dependency of task.dependencies) downstream.get(dependency).push(task.id);
  }
  const depths = new Map();
  function depth(id) {
    if (!depths.has(id)) depths.set(id, downstream.get(id).reduce((best, child) => Math.max(best, 1 + depth(child)), 0));
    return depths.get(id);
  }
  const candidates = tasks.filter(task => task.state === 'approved' &&
    task.dependencies.every(dependency => accepted.has(dependency)))
    .sort((left, right) => left.priority - right.priority || depth(right.id) - depth(left.id) || left.id - right.id);
  const counts = new Map(laneCounts);
  const scheduled = [];
  for (const task of candidates) {
    if ((counts.get(task.lane) ?? 0) >= 1 ||
        task.paths.some(path => ownedPaths.some(owned => overlaps(path, owned)))) continue;
    if (scheduled.length + reservations.length >= config.limits.maxConcurrentLanes) break;
    scheduled.push({id: task.id, lane: task.lane, paths: [...task.paths]});
    counts.set(task.lane, (counts.get(task.lane) ?? 0) + 1);
    ownedPaths.push(...task.paths);
  }
  return {shadow: true, scheduled, reason: scheduled.length ? 'SHADOW_PLAN' : 'NO_READY_WORK'};
}
