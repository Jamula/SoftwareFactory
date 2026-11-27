import {types} from 'node:util';

export const SPECIALIST_ROLES = Object.freeze([
  'api',
  'data',
  'security',
  'test',
  'infra',
  'ui',
  'docs',
  'coordinator'
]);

const ownData = (value, key) => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return Boolean(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.value !== undefined);
};
const shape = (value, required, optional = []) => {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  return required.every(key => ownData(value, key)) &&
    keys.every(key => typeof key === 'string' && allowed.has(key) && ownData(value, key));
};
const text = (value, max = 120) => typeof value === 'string' && value.length > 0 &&
  value.length <= max && value.trim() === value && !/[\u0000-\u001f]/.test(value);
const id = value => text(value, 64) && /^[a-z0-9][a-z0-9-]*$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const dense = (value, max = 64) => !types.isProxy(value) && Array.isArray(value) &&
  Object.getPrototypeOf(value) === Array.prototype && value.length <= max &&
  Reflect.ownKeys(value).length === value.length + 1 &&
  Array.from({length: value.length}, (_, index) => ownData(value, String(index))).every(Boolean);
const copyList = values => Object.freeze(Array.from({length: values.length}, (_, index) => values[index]));
const unique = values => new Set(values).size === values.length;
const overlaps = (left, right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
const disjointPaths = paths => paths.every((entry, index) =>
  paths.slice(index + 1).every(other => !overlaps(entry, other)));
const path = value => text(value, 200) && /^[A-Za-z0-9._/-]+$/.test(value) &&
  !value.startsWith('/') && !value.split('/').some(part => !part || part === '.' || part === '..');
const pathList = (value, min = 1, max = 32) =>
  dense(value, max) && value.length >= min && value.every(path) && unique(value);
const repository = value => text(value, 200) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
const branch = value => text(value, 120) && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
  !value.includes('..') && !value.includes('//') && !value.endsWith('/');
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const specialist = value => SPECIALIST_ROLES.includes(value);

function topologicalOrder(items) {
  const byId = new Map(items.map(item => [item.id, item]));
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];
  function visit(itemId) {
    if (visiting.has(itemId) || !byId.has(itemId)) return false;
    if (visited.has(itemId)) return true;
    visiting.add(itemId);
    if (!byId.get(itemId).dependsOn.every(visit)) return false;
    visiting.delete(itemId);
    visited.add(itemId);
    ordered.push(byId.get(itemId));
    return true;
  }
  return items.every(item => visit(item.id)) ? ordered : null;
}

function validLanes(lanes) {
  if (!dense(lanes, 32) || lanes.length === 0 ||
      !lanes.every(lane => shape(lane, ['id', 'owners', 'prompt'], ['specialist']) &&
        id(lane.id) && pathList(lane.owners, 1, Infinity) && path(lane.prompt) &&
        (!Object.hasOwn(lane, 'specialist') || specialist(lane.specialist))) ||
      !unique(lanes.map(lane => lane.id))) return false;
  return disjointPaths(lanes.flatMap(lane => lane.owners));
}

function inspectKnowledgeMap(knowledgeMap, lanes) {
  if (!shape(knowledgeMap, ['repository', 'revision', 'source', 'generatedAtMs', 'maxAgeMs', 'components']) ||
      !repository(knowledgeMap.repository) || !sha(knowledgeMap.revision) ||
      !text(knowledgeMap.source, 64) || !nonnegative(knowledgeMap.generatedAtMs) ||
      !integer(knowledgeMap.maxAgeMs, 1000, 604800000) ||
      !dense(knowledgeMap.components, 64) || knowledgeMap.components.length === 0)
    return 'INVALID_KNOWLEDGE_MAP';
  if (knowledgeMap.source !== 'trusted-default-branch') return 'UNTRUSTED_KNOWLEDGE_SOURCE';
  const componentKeys = ['id', 'lane', 'specialist', 'owners', 'interfaces', 'decisions', 'tests', 'dependsOn'];
  for (const entry of knowledgeMap.components) {
    if (!shape(entry, componentKeys) || !id(entry.id) || !id(entry.lane) || !text(entry.specialist, 64) ||
        !pathList(entry.owners, 1, 32) || !pathList(entry.interfaces, 1, 32) ||
        !pathList(entry.decisions, 1, 32) || !pathList(entry.tests, 1, 32) ||
        !dense(entry.dependsOn, 32) || !entry.dependsOn.every(id) || !unique(entry.dependsOn))
      return 'INVALID_KNOWLEDGE_MAP';
    if (!specialist(entry.specialist)) return 'UNKNOWN_SPECIALIST';
  }
  if (!unique(knowledgeMap.components.map(entry => entry.id)) ||
      !disjointPaths(knowledgeMap.components.flatMap(entry => entry.owners)))
    return 'DUPLICATE_OR_OVERLAPPING_OWNERSHIP';
  if (!topologicalOrder(knowledgeMap.components)) return 'INVALID_COMPONENT_DEPENDENCIES';
  if (lanes) {
    const laneById = new Map(lanes.map(lane => [lane.id, lane]));
    for (const entry of knowledgeMap.components) {
      const lane = laneById.get(entry.lane);
      if (!lane || (Object.hasOwn(lane, 'specialist') && lane.specialist !== entry.specialist) ||
          !entry.owners.every(owner => lane.owners.some(prefix =>
            owner === prefix || owner.startsWith(`${prefix}/`))))
        return 'LANE_OWNERSHIP_MISMATCH';
    }
  }
  return null;
}

export function validateKnowledgeMap(knowledgeMap, context) {
  if (!shape(context, ['repository', 'revision', 'nowMs'], ['lanes']) ||
      !repository(context.repository) || !sha(context.revision) || !nonnegative(context.nowMs) ||
      (Object.hasOwn(context, 'lanes') && !validLanes(context.lanes)))
    return Object.freeze({shadow: true, valid: false, reason: 'INVALID_TRUST_CONTEXT'});
  const structuralError = inspectKnowledgeMap(knowledgeMap, context.lanes);
  if (structuralError !== null)
    return Object.freeze({shadow: true, valid: false, reason: structuralError});
  if (knowledgeMap.repository !== context.repository)
    return Object.freeze({shadow: true, valid: false, reason: 'CROSS_REPO_DATA_REJECTED'});
  if (knowledgeMap.revision !== context.revision || context.nowMs < knowledgeMap.generatedAtMs ||
      context.nowMs - knowledgeMap.generatedAtMs > knowledgeMap.maxAgeMs)
    return Object.freeze({shadow: true, valid: false, reason: 'STALE_KNOWLEDGE_MAP'});
  return Object.freeze({shadow: true, valid: true, reason: 'TRUSTED_KNOWLEDGE_MAP'});
}

export function validateProjectConfig(config) {
  if (!shape(config, ['schemaVersion', 'project', 'execution', 'limits', 'adapters', 'lanes'], ['knowledgeMap']) ||
      config.schemaVersion !== 1) return false;
  if (!shape(config.project, ['key', 'repository', 'defaultBranch']) || !id(config.project.key) ||
      !repository(config.project.repository) || !branch(config.project.defaultBranch)) return false;
  if (!shape(config.execution, ['enabled', 'mode', 'stop']) || typeof config.execution.enabled !== 'boolean' ||
      config.execution.mode !== 'shadow' || typeof config.execution.stop !== 'boolean') return false;
  if (!shape(config.limits, ['maxConcurrentLanes', 'leaseMs', 'maxAttempts', 'baseDelayMs', 'maxDelayMs']) ||
      !integer(config.limits.maxConcurrentLanes, 1, config.project.repository.toLowerCase() === 'jamula/softwarefactory' ? 12 : 8) ||
      !integer(config.limits.leaseMs, 1000, 3600000) ||
      !integer(config.limits.maxAttempts, 1, 5) || !integer(config.limits.baseDelayMs, 1, 60000) ||
      !integer(config.limits.maxDelayMs, config.limits.baseDelayMs, 300000)) return false;
  if (!shape(config.adapters, ['workTracker', 'engineeringAgent', 'state']) ||
      !['injected-read-only', 'mock'].includes(config.adapters.workTracker) ||
      !['injected-read-only', 'mock'].includes(config.adapters.engineeringAgent) ||
      config.adapters.state !== 'sqlite') return false;
  if (!validLanes(config.lanes)) return false;
  if (Object.hasOwn(config, 'knowledgeMap') &&
      (inspectKnowledgeMap(config.knowledgeMap, config.lanes) !== null ||
       config.knowledgeMap.repository !== config.project.repository)) return false;
  return true;
}

const blockedRoute = reason => Object.freeze({
  shadow: true,
  state: 'blocked',
  reason,
  units: Object.freeze([])
});

export function routeContractUnits(config, request) {
  if (!validateProjectConfig(config)) return blockedRoute('INVALID_PROJECT_CONFIG');
  if (!Object.hasOwn(config, 'knowledgeMap')) return blockedRoute('KNOWLEDGE_MAP_REQUIRED');
  if (!shape(request, ['repository', 'revision', 'nowMs', 'availableSpecialists', 'includedQuotaAvailable', 'units']) ||
      !repository(request.repository) || !sha(request.revision) || !nonnegative(request.nowMs) ||
      typeof request.includedQuotaAvailable !== 'boolean' ||
      !dense(request.availableSpecialists, SPECIALIST_ROLES.length) || request.availableSpecialists.length === 0 ||
      !request.availableSpecialists.every(item => text(item, 64)) || !unique(request.availableSpecialists) ||
      !dense(request.units, 64) || request.units.length === 0)
    return blockedRoute('INVALID_CONTRACT_REQUEST');
  if (request.repository !== config.project.repository) return blockedRoute('CROSS_REPO_DATA_REJECTED');
  const mapCheck = validateKnowledgeMap(config.knowledgeMap, {
    repository: request.repository,
    revision: request.revision,
    nowMs: request.nowMs,
    lanes: config.lanes
  });
  if (!mapCheck.valid) return blockedRoute(mapCheck.reason);
  if (!request.availableSpecialists.every(specialist)) return blockedRoute('UNKNOWN_SPECIALIST');
  if (!request.includedQuotaAvailable) return blockedRoute('QUOTA_UNVERIFIED');
  const components = new Map(config.knowledgeMap.components.map(entry => [entry.id, entry]));
  for (const unit of request.units) {
    if (!shape(unit, ['id', 'component', 'specialist', 'paths', 'acceptance', 'dependsOn'], ['repository']) ||
        !id(unit.id) || !id(unit.component) || !text(unit.specialist, 64) ||
        !pathList(unit.paths, 1, 32) || !pathList(unit.acceptance, 1, 16) ||
        !dense(unit.dependsOn, 32) || !unit.dependsOn.every(id) || !unique(unit.dependsOn) ||
        (Object.hasOwn(unit, 'repository') && !repository(unit.repository)))
      return blockedRoute('INVALID_CONTRACT_REQUEST');
    if (Object.hasOwn(unit, 'repository') && unit.repository !== config.project.repository)
      return blockedRoute('CROSS_REPO_DATA_REJECTED');
    if (!specialist(unit.specialist)) return blockedRoute('UNKNOWN_SPECIALIST');
    const target = components.get(unit.component);
    if (!target) return blockedRoute('UNKNOWN_COMPONENT');
    if (unit.specialist !== target.specialist || !request.availableSpecialists.includes(unit.specialist))
      return blockedRoute('SPECIALIST_CAPABILITY_UNAVAILABLE');
    if (!unit.paths.every(unitPath => target.owners.some(owner =>
        unitPath === owner || unitPath.startsWith(`${owner}/`))))
      return blockedRoute('UNIT_PATH_OUTSIDE_COMPONENT');
  }
  if (!unique(request.units.map(unit => unit.id))) return blockedRoute('DUPLICATE_CONTRACT_UNIT');
  if (!disjointPaths(request.units.flatMap(unit => unit.paths)))
    return blockedRoute('DUPLICATE_PATH_ASSIGNMENT');
  const orderedUnits = topologicalOrder(request.units);
  if (!orderedUnits) return blockedRoute('INVALID_UNIT_DEPENDENCIES');
  const units = orderedUnits.map(unit => {
    const target = components.get(unit.component);
    return Object.freeze({
      id: unit.id,
      component: target.id,
      lane: target.lane,
      specialist: target.specialist,
      paths: copyList(unit.paths),
      interfaces: copyList(target.interfaces),
      decisions: copyList(target.decisions),
      tests: copyList(target.tests),
      acceptance: copyList(unit.acceptance),
      dependsOn: copyList(unit.dependsOn)
    });
  });
  return Object.freeze({
    shadow: true,
    state: 'shadow-routed',
    reason: 'CONTRACT_UNITS_ROUTED',
    repository: config.project.repository,
    revision: config.knowledgeMap.revision,
    units: Object.freeze(units)
  });
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
