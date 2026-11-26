const exact = (value, keys) => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));
const text = (value, max = 120) => typeof value === 'string' && value.length > 0 &&
  value.length <= max && value.trim() === value;
const id = value => text(value, 64) && /^[a-z0-9][a-z0-9-]*$/.test(value);
const dense = value => Array.isArray(value) && Object.keys(value).length === value.length &&
  Array.from({length: value.length}, (_, index) => Object.hasOwn(value, index)).every(Boolean);
const unique = values => new Set(values).size === values.length;
const path = value => text(value, 200) && !value.startsWith('/') && !value.includes('\\') &&
  !value.includes(':') && !/[\u0000-\u001f]/.test(value) &&
  !value.split('/').some(part => !part || part === '.' || part === '..');
const repository = value => text(value, 200) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
const branch = value => text(value, 120) && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
  !value.includes('..') && !value.includes('//') && !value.endsWith('/');
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

export function validateProjectConfig(config) {
  if (!exact(config, ['schemaVersion', 'project', 'execution', 'limits', 'adapters', 'lanes']) ||
      config.schemaVersion !== 1) return false;
  if (!exact(config.project, ['key', 'repository', 'defaultBranch']) || !id(config.project.key) ||
      !repository(config.project.repository) || !branch(config.project.defaultBranch)) return false;
  if (!exact(config.execution, ['enabled', 'mode', 'stop']) || typeof config.execution.enabled !== 'boolean' ||
      config.execution.mode !== 'shadow' || typeof config.execution.stop !== 'boolean') return false;
  if (!exact(config.limits, ['maxConcurrentLanes', 'leaseMs', 'maxAttempts', 'baseDelayMs', 'maxDelayMs']) ||
      !integer(config.limits.maxConcurrentLanes, 1, config.project.repository.toLowerCase() === 'jamula/softwarefactory' ? 12 : 8) || !integer(config.limits.leaseMs, 1000, 3600000) ||
      !integer(config.limits.maxAttempts, 1, 5) || !integer(config.limits.baseDelayMs, 1, 60000) ||
      !integer(config.limits.maxDelayMs, config.limits.baseDelayMs, 300000)) return false;
  if (!exact(config.adapters, ['workTracker', 'engineeringAgent', 'state']) ||
      !['injected-read-only', 'mock'].includes(config.adapters.workTracker) ||
      !['injected-read-only', 'mock'].includes(config.adapters.engineeringAgent) ||
      config.adapters.state !== 'sqlite') return false;
  if (!dense(config.lanes) || config.lanes.length === 0 || config.lanes.length > 32 ||
      !config.lanes.every(lane => exact(lane, ['id', 'owners', 'prompt']) && id(lane.id) &&
        dense(lane.owners) && lane.owners.length > 0 && lane.owners.every(path) &&
        unique(lane.owners) && text(lane.prompt, 200) && path(lane.prompt)) ||
      !unique(config.lanes.map(lane => lane.id))) return false;
  const owners = config.lanes.flatMap(lane => lane.owners);
  return owners.every((owner, index) => owners.slice(index + 1).every(other =>
    !(owner === other || owner.startsWith(`${other}/`) || other.startsWith(`${owner}/`))));
}

export function parseProjectConfig(source) {
  if (typeof source !== 'string' || source.length > 65536) return {valid: false, config: null};
  try {
    const config = JSON.parse(source);
    return validateProjectConfig(config) ? {valid: true, config} : {valid: false, config: null};
  } catch {
    return {valid: false, config: null};
  }
}
