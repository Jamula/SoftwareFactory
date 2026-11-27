const sha = s => typeof s === 'string' && /^[a-f0-9]{40}$/.test(s);
const token = s => typeof s === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(s);
const exactArray = (value, max = 500) => {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    return false;
  const length = value.length;
  if (length > max) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1) return false;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') || lengthDescriptor.value !== length)
    return false;
  for (let i = 0; i < length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false;
  }
  return true;
};
const dense = a => exactArray(a);
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
const list = (value, max, valid) => {
  if (!exactArray(value, max)) return false;
  for (let i = 0; i < value.length; i++) {
    const item = Object.getOwnPropertyDescriptor(value, String(i));
    if (!item || !Object.hasOwn(item, 'value') || !valid(item.value)) return false;
  }
  return true;
};
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
      path(entry.root) && path(entry.interface) && path(entry.decision) && list(entry.tests, 60, path) &&
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

const SF_REPOSITORY = 'Jamula/SoftwareFactory';
const FACTORY_TESTS = [
  'aspire-telemetry-smoke', 'budget', 'capacity-scale', 'contract-routing', 'copilot-hosted-pilot',
  'core', 'coverage-evidence', 'dispatch-intent', 'event-envelope', 'integration-train', 'issue-event',
  'lease-transition', 'local-otel-sdk', 'local-shadow-host', 'locked-build-cache', 'outcome-measurement',
  'pilot-readiness', 'platform-merge-gates', 'pr-iterations', 'pr-lifecycle', 'profiles',
  'protected-squash', 'pull-signals', 'queue-inspection', 'queue-reread', 'review-batch',
  'review-history', 'run', 'shadow-dispatch-ledger', 'shadow-runtime', 'stage-aggregate',
  'stage-latency', 'telemetry', 'validation-diagnosis', 'verify-dashboard-metrics'
].map(stem => `tests/engineering-factory/${stem}.test.mjs`);
const COORDINATOR_TESTS = [
  'coordinator', 'event-journal', 'planner', 'project-config', 'provider-adapters',
  'retry', 'review-intent-store', 'review-provider', 'sqlite-state-store'
].map(stem => `tests/engineering-coordinator/${stem}.test.mjs`);
const BASELINE_TEST_INVENTORY = [...COORDINATOR_TESTS, ...FACTORY_TESTS];
const PINNED_CONTRACT_TESTS = [
  'tests/engineering-coordinator/coordinator.test.mjs',
  'tests/engineering-coordinator/planner.test.mjs',
  'tests/engineering-coordinator/project-config.test.mjs',
  'tests/engineering-factory/aspire-telemetry-smoke.test.mjs',
  'tests/engineering-factory/contract-routing.test.mjs',
  'tests/engineering-factory/copilot-hosted-pilot.test.mjs',
  'tests/engineering-factory/coverage-evidence.test.mjs',
  'tests/engineering-factory/local-otel-sdk.test.mjs',
  'tests/engineering-factory/local-shadow-host.test.mjs',
  'tests/engineering-factory/locked-build-cache.test.mjs',
  'tests/engineering-factory/platform-merge-gates.test.mjs',
  'tests/engineering-factory/run.test.mjs',
  'tests/engineering-factory/validation-diagnosis.test.mjs',
  'tests/engineering-factory/verify-dashboard-metrics.test.mjs'
];
const runnableTestPath = value => path(value) &&
  /^tests\/engineering-(?:factory|coordinator)\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.test\.mjs$/.test(value);
const ROOT_DOC_FILES = new Set(['AGENTS.md', 'CONTRIBUTING.md', 'LICENSE', 'NOTICE', 'VERSION', '.gitignore']);
const LOCK_FILES = new Set(['package.json', 'package-lock.json']);

export const defaultSoftwareFactoryTestInventory = () => [...BASELINE_TEST_INVENTORY];

const requiredGateContract = () => ({
  lineCoveragePct: 98,
  branchCoveragePct: 95,
  security: true,
  linuxRuntime: true,
  windowsRuntime: true
});

export function softwareFactoryCatalog(revision, ...rest) {
  if (!sha(revision)) return blocked('REVISION_UNKNOWN');
  const testInventory = rest.length === 0 ? defaultSoftwareFactoryTestInventory() : rest[0];
  const deletedPaths = rest.length < 2 ? [] : rest[1];
  if (!list(testInventory, 120, runnableTestPath) || testInventory.length === 0 || !unique(testInventory))
    return blocked('TEST_INVENTORY_UNKNOWN');
  if (!list(deletedPaths, 500, path) || !unique(deletedPaths))
    return blocked('CHANGES_UNKNOWN');
  const inventorySet = new Set(testInventory);
  const deletedSet = new Set(deletedPaths);
  if ([...deletedSet].some(deleted => inventorySet.has(deleted)) ||
      !PINNED_CONTRACT_TESTS.every(suite => inventorySet.has(suite)) ||
      BASELINE_TEST_INVENTORY.some(suite => !inventorySet.has(suite) && !deletedSet.has(suite)))
    return blocked('TEST_INVENTORY_UNALIGNED');
  const coordinatorTests = testInventory.filter(item => item.startsWith('tests/engineering-coordinator/')).sort();
  const factoryTests = testInventory.filter(item => item.startsWith('tests/engineering-factory/')).sort();
  if (coordinatorTests.length > 60 || factoryTests.length > 60)
    return blocked('TEST_INVENTORY_UNKNOWN');
  return {
    repository: SF_REPOSITORY,
    revision,
    components: [
      {
        component: 'coordinator-config',
        owner: 'coordinator-lane',
        specialty: 'configuration',
        root: 'config',
        interface: 'config/engineering-coordinator.schema.json',
        decision: 'docs/POLICY.md',
        tests: [
          'tests/engineering-coordinator/project-config.test.mjs',
          'tests/engineering-coordinator/planner.test.mjs',
          'tests/engineering-coordinator/coordinator.test.mjs'
        ],
        dependsOn: []
      },
      {
        component: 'coordinator-agents',
        owner: 'coordinator-lane',
        specialty: 'orchestration',
        root: 'agents',
        interface: 'agents/engineering-coordinator.md',
        decision: 'docs/ENGINEERING-COORDINATOR.md',
        tests: [
          'tests/engineering-coordinator/coordinator.test.mjs',
          'tests/engineering-coordinator/planner.test.mjs'
        ],
        dependsOn: ['coordinator-config']
      },
      {
        component: 'engineering-coordinator',
        owner: 'coordinator-lane',
        specialty: 'orchestration',
        root: 'tools/engineering-coordinator',
        interface: 'tools/engineering-coordinator/coordinator.mjs',
        decision: 'docs/COORDINATOR-EVENT-JOURNAL.md',
        tests: coordinatorTests,
        dependsOn: ['coordinator-config', 'coordinator-agents']
      },
      {
        component: 'engineering-coordinator-tests',
        owner: 'coordinator-lane',
        specialty: 'verification',
        root: 'tests/engineering-coordinator',
        interface: 'tests/engineering-coordinator/coordinator.test.mjs',
        decision: 'docs/COORDINATOR-REVIEW-PROVIDER.md',
        tests: [...coordinatorTests],
        dependsOn: ['engineering-coordinator']
      },
      {
        component: 'engineering-factory',
        owner: 'factory-lane',
        specialty: 'evaluator',
        root: 'tools/engineering-factory',
        interface: 'package.json',
        decision: 'docs/ENGINEERING-STANDARDS.md',
        tests: factoryTests,
        dependsOn: ['engineering-coordinator']
      },
      {
        component: 'engineering-factory-tests',
        owner: 'factory-lane',
        specialty: 'verification',
        root: 'tests/engineering-factory',
        interface: 'tests/engineering-factory/coverage-reporter.mjs',
        decision: 'docs/VERIFIED-OUTCOME-REPORTING.md',
        tests: [...factoryTests],
        dependsOn: ['engineering-factory']
      },
      {
        component: 'apphost-runtime',
        owner: 'platform-lane',
        specialty: 'aspire-runtime',
        root: 'apphost.cs',
        interface: 'global.json',
        decision: 'aspire.config.json',
        tests: [
          'tests/engineering-factory/aspire-telemetry-smoke.test.mjs',
          'tests/engineering-factory/local-otel-sdk.test.mjs',
          'tests/engineering-factory/local-shadow-host.test.mjs',
          'tests/engineering-factory/verify-dashboard-metrics.test.mjs'
        ],
        dependsOn: ['engineering-factory']
      },
      {
        component: 'ci-workflows',
        owner: 'ci-lane',
        specialty: 'ci-security',
        root: '.github/workflows',
        interface: 'package-lock.json',
        decision: 'apphost.run.json',
        tests: [
          'tests/engineering-factory/copilot-hosted-pilot.test.mjs',
          'tests/engineering-factory/coverage-evidence.test.mjs',
          'tests/engineering-factory/locked-build-cache.test.mjs',
          'tests/engineering-factory/platform-merge-gates.test.mjs',
          'tests/engineering-factory/validation-diagnosis.test.mjs'
        ],
        dependsOn: []
      },
      {
        component: 'repository-docs',
        owner: 'governance-lane',
        specialty: 'documentation',
        root: 'docs',
        interface: 'README.md',
        decision: 'SECURITY.md',
        tests: [
          'tests/engineering-factory/contract-routing.test.mjs',
          'tests/engineering-factory/run.test.mjs',
          'tests/engineering-factory/validation-diagnosis.test.mjs'
        ],
        dependsOn: []
      }
    ]
  };
}

const fastFeedbackDenied = reason => ({
  state: 'blocked',
  shadow: true,
  reason,
  components: [],
  routes: [],
  tests: [],
  fullValidationRequired: true,
  requiredValidation: 'full',
  requiredGates: requiredGateContract(),
  skipRequiredChecks: false
});

export function planChangeGraphFastFeedback(evidence, expected) {
  if (!ownData(expected, ['repository', 'revision', 'head']) ||
      expected.repository !== SF_REPOSITORY || !sha(expected.revision) || !sha(expected.head) ||
      !ownData(evidence, ['repository', 'producer', 'verified', 'complete', 'base', 'head', 'paths', 'testInventory']) ||
      evidence.repository !== SF_REPOSITORY || evidence.producer !== 'trusted-ci' ||
      evidence.verified !== true || evidence.complete !== true ||
      evidence.base !== expected.revision || evidence.head !== expected.head)
    return fastFeedbackDenied('CHANGE_EVIDENCE_UNKNOWN');
  if (!list(evidence.paths, 500, path) || evidence.paths.length === 0 || !unique(evidence.paths))
    return fastFeedbackDenied('CHANGES_UNKNOWN');
  let deletedPaths = [];
  if (Object.hasOwn(evidence, 'deletedPaths')) {
    if (!ownData(evidence, ['deletedPaths']) || !list(evidence.deletedPaths, 500, path) || !unique(evidence.deletedPaths))
      return fastFeedbackDenied('CHANGES_UNKNOWN');
    deletedPaths = evidence.deletedPaths;
  }
  const catalog = softwareFactoryCatalog(expected.revision, evidence.testInventory, deletedPaths);
  if (catalog.state === 'blocked') return fastFeedbackDenied(catalog.reason);
  const deletedSet = new Set(deletedPaths);
  const pathSet = new Set(evidence.paths);
  const inventorySet = new Set(evidence.testInventory);
  if ([...deletedSet].some(deleted => !pathSet.has(deleted)) ||
      evidence.paths.some(item => runnableTestPath(item) && !deletedSet.has(item) && !inventorySet.has(item)))
    return fastFeedbackDenied('TEST_INVENTORY_UNALIGNED');
  const normalizedPaths = new Set();
  let lockChanged = false;
  for (const item of evidence.paths) {
    if (ROOT_DOC_FILES.has(item)) normalizedPaths.add('README.md');
    else {
      if (LOCK_FILES.has(item)) lockChanged = true;
      normalizedPaths.add(item);
    }
  }
  const mapped = planKnowledgeRoutes(catalog, {repository: expected.repository, revision: expected.revision}, [...normalizedPaths]);
  if (mapped.state !== 'shadow-mapped') return fastFeedbackDenied(mapped.reason);
  const tests = new Set(mapped.routes.flatMap(route => route.tests));
  if (lockChanged) {
    for (const suite of evidence.testInventory) tests.add(suite);
  }
  return {
    state: 'shadow-mapped',
    shadow: true,
    reason: 'FAST_FEEDBACK_SELECTED',
    repository: expected.repository,
    revision: expected.revision,
    head: expected.head,
    components: mapped.routes.map(route => route.component),
    routes: mapped.routes,
    tests: [...tests].sort(),
    fullValidationRequired: true,
    requiredValidation: 'full',
    requiredGates: requiredGateContract(),
    skipRequiredChecks: false
  };
}

