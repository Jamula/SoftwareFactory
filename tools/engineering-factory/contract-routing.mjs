const sha = s => typeof s === 'string' && /^[a-f0-9]{40}$/.test(s);
const token = s => typeof s === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(s);
const dense = a => Array.isArray(a) && Object.keys(a).length === a.length &&
  Array.from({length:a.length},(_,i)=>Object.hasOwn(a,i)).every(Boolean);
const record = (v, keys) => v !== null && typeof v === 'object' && !Array.isArray(v) && keys.every(k=>Object.hasOwn(v,k));
const blocked = reason => ({state:'blocked',reason});
export function routeContract(catalog, request) {
  if (!record(request,['component','revision','allowedSpecialties']) || !token(request.component) || !sha(request.revision) ||
      !dense(catalog) || !catalog.every(c=>record(c,['component','owner','specialty','revision']) && token(c.component) && token(c.owner) &&
        token(c.specialty) && sha(c.revision))) return blocked('INVALID_CONTRACT');
  const matches=catalog.filter(c=>c.component===request.component);
  if (matches.length!==1) return blocked('OWNERSHIP_UNKNOWN');
  const c=matches[0];
  if(c.revision!==request.revision) return blocked('STALE_CONTRACT');
  if(!dense(request.allowedSpecialties) || !request.allowedSpecialties.every(token) ||
     !request.allowedSpecialties.includes(c.specialty)) return blocked('SPECIALTY_UNAVAILABLE');
  return {state:'shadow-routed',owner:c.owner,specialty:c.specialty,revision:c.revision};
}
import {types} from 'node:util';


const ownData = (value, keys) => value !== null && typeof value === 'object' &&
  !types.isProxy(value) && !Array.isArray(value) &&
  keys.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
const boundedToken = value => token(value) && value.length <= 64;
const repository = value => typeof value === 'string' && value.length <= 160 &&
  /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(value);
const path = value => typeof value === 'string' && value.length <= 240 &&
  /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(value) &&
  value.split('/').every(part => part !== '.' && part !== '..');
const list = (value, max, valid) => !types.isProxy(value) && Array.isArray(value) &&
  value.length <= max && Object.keys(value).length === value.length &&
  Array.from({length: value.length}, (_, i) => Object.getOwnPropertyDescriptor(value, String(i)))
    .every(item => item && Object.hasOwn(item, 'value') && valid(item.value));
const containsPath = (prefix, changed) => changed === prefix || changed.startsWith(prefix + '/');
const unique = values => new Set(values).size === values.length;

export function planKnowledgeRoutes(catalog, expected, changedPaths) {
  if (!ownData(expected, ['repository', 'revision']) || !repository(expected.repository) ||
      !sha(expected.revision)) return blocked('TRUST_UNKNOWN');
  if (!ownData(catalog, ['repository', 'revision', 'components']) ||
      catalog.repository !== expected.repository || catalog.revision !== expected.revision)
    return blocked('MAP_STALE_OR_UNKNOWN');
  const componentFields = ['component', 'owner', 'specialty', 'root', 'interface', 'decision', 'tests', 'dependsOn'];
  if (!list(catalog.components, 200, entry => ownData(entry, componentFields) &&
      boundedToken(entry.component) && boundedToken(entry.owner) && boundedToken(entry.specialty) &&
      path(entry.root) && path(entry.interface) && path(entry.decision) && list(entry.tests, 30, path) &&
      entry.tests.length > 0 && unique(entry.tests) && list(entry.dependsOn, 60, boundedToken) &&
      unique(entry.dependsOn)) || catalog.components.length === 0 ||
      !unique(catalog.components.map(entry => entry.component))) return blocked('MAP_INVALID');
  if (!list(changedPaths, 500, path) || changedPaths.length === 0 || !unique(changedPaths))
    return blocked('CHANGES_UNKNOWN');
  if (catalog.components.some((entry, i) => catalog.components.slice(0, i).some(previous =>
      containsPath(previous.root, entry.root) || containsPath(entry.root, previous.root))))
    return blocked('OWNERSHIP_AMBIGUOUS');
  const byName = new Map(catalog.components.map(entry => [entry.component, entry]));
  const visiting = new Set();
  const visited = new Set();
  const dependencyOrder = [];
  function visit(name) {
    if (visiting.has(name) || !byName.has(name)) return false;
    if (visited.has(name)) return true;
    visiting.add(name);
    if (!byName.get(name).dependsOn.every(visit)) return false;
    visiting.delete(name);
    visited.add(name);
    dependencyOrder.push(byName.get(name));
    return true;
  }
  if (!Array.from(byName.keys()).every(visit)) return blocked('DEPENDENCIES_UNKNOWN');
  const affected = new Set();
  for (const changed of changedPaths) {
    const covered = catalog.components.filter(entry => containsPath(entry.root, changed) ||
      entry.interface === changed || entry.decision === changed || entry.tests.includes(changed));
    if (covered.length === 0) return blocked('PATH_UNMAPPED');
    for (const entry of covered) affected.add(entry.component);
  }
  for (const entry of dependencyOrder) {
    if (entry.dependsOn.some(dependency => affected.has(dependency))) affected.add(entry.component);
  }
  const routes = dependencyOrder.filter(entry => affected.has(entry.component)).map(entry => ({
    component: entry.component, owner: entry.owner, specialty: entry.specialty,
    interface: entry.interface, decision: entry.decision, tests: [...entry.tests],
    dependsOn: entry.dependsOn.filter(dependency => affected.has(dependency))
  }));
  return {state: 'shadow-mapped', repository: expected.repository, revision: expected.revision, routes};
}

