import test from 'node:test';
import assert from 'node:assert/strict';
import {parseProjectConfig, validateProjectConfig} from '../../tools/engineering-coordinator/project-config.mjs';

const config = () => ({schemaVersion: 1,
  project: {key: 'alpha', repository: 'example/alpha', defaultBranch: 'main'},
  execution: {enabled: false, mode: 'shadow', stop: true},
  limits: {maxConcurrentLanes: 2, leaseMs: 5000, maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 1000},
  adapters: {workTracker: 'mock', engineeringAgent: 'mock', state: 'sqlite'},
  lanes: [{id: 'api', owners: ['src/api'], prompt: 'agents/engineering-coordinator.md'},
    {id: 'web', owners: ['src/web'], prompt: 'agents/engineering-coordinator.md'}]});

test('accepts a disabled, project-specific configuration', () => {
  assert.equal(validateProjectConfig(config()), true);
});

test('parses bounded JSON config and rejects malformed or invalid content', () => {
  const parsed = parseProjectConfig(JSON.stringify(config()));
  assert.equal(parsed.valid, true);
  assert.equal(parsed.config.project.key, 'alpha');
  assert.deepEqual(parseProjectConfig('{'), {valid: false, config: null});
  assert.deepEqual(parseProjectConfig('[]'), {valid: false, config: null});
  assert.deepEqual(parseProjectConfig('x'.repeat(65537)), {valid: false, config: null});
  assert.deepEqual(parseProjectConfig(null), {valid: false, config: null});
});

test('rejects unknown keys and invalid version', () => {
  assert.equal(validateProjectConfig({...config(), extra: true}), false);
  assert.equal(validateProjectConfig({...config(), schemaVersion: 2}), false);
});

test('rejects malformed project identity and unsafe branch names', () => {
  assert.equal(validateProjectConfig({...config(), project: {...config().project, key: 'Bad Key'}}), false);
  assert.equal(validateProjectConfig({...config(), project: {...config().project, repository: 'alpha'}}), false);
  assert.equal(validateProjectConfig({...config(), project: {...config().project, repository: 'bad repo/name'}}), false);
  assert.equal(validateProjectConfig({...config(), project: {...config().project, defaultBranch: ''}}), false);
  assert.equal(validateProjectConfig({...config(), project: {...config().project, defaultBranch: 'branch..name'}}), false);
});

test('keeps execution shadow-only and requires explicit boolean controls', () => {
  assert.equal(validateProjectConfig({...config(), execution: {enabled: true, mode: 'live', stop: false}}), false);
  assert.equal(validateProjectConfig({...config(), execution: {enabled: 'yes', mode: 'shadow', stop: false}}), false);
  assert.equal(validateProjectConfig({...config(), execution: {enabled: true, mode: 'shadow', stop: false}}), true);
});

test('bounds concurrency, lease and retry values', () => {
  assert.equal(validateProjectConfig({...config(), limits: {...config().limits, maxConcurrentLanes: 0}}), false);
  assert.equal(validateProjectConfig({...config(), limits: {...config().limits, leaseMs: 999}}), false);
  assert.equal(validateProjectConfig({...config(), limits: {...config().limits, maxAttempts: 6}}), false);
  assert.equal(validateProjectConfig({...config(), limits: {...config().limits, maxDelayMs: 10}}), false);
});

test('allows only injected read-only or mock adapters and SQLite persistence', () => {
  assert.equal(validateProjectConfig({...config(), adapters: {...config().adapters, workTracker: 'github-write'}}), false);
  assert.equal(validateProjectConfig({...config(), adapters: {...config().adapters, state: 'memory'}}), false);
  assert.equal(validateProjectConfig({...config(), adapters: {...config().adapters, engineeringAgent: 'mock'}}), true);
});

test('rejects invalid, duplicate, overlapping or missing lanes and owners', () => {
  assert.equal(validateProjectConfig({...config(), lanes: []}), false);
  assert.equal(validateProjectConfig({...config(), lanes: [config().lanes[0], config().lanes[0]]}), false);
  assert.equal(validateProjectConfig({...config(), lanes: [config().lanes[0],
    {id: 'web', owners: ['src/api/private'], prompt: 'agent.md'}]}), false);
  assert.equal(validateProjectConfig({...config(), lanes: [{id: 'api', owners: ['../src'], prompt: 'agent.md'}]}), false);
  assert.equal(validateProjectConfig({...config(), lanes: [{id: 'api', owners: ['src/api'], prompt: 'agent.md', extra: 1}]}), false);
  assert.equal(validateProjectConfig({...config(), lanes: [{id: 'api', owners: ['src/api'], prompt: ''}]}), false);
});

test('rejects null, arrays, sparse lanes, malformed paths and duplicate owners', () => {
  assert.equal(validateProjectConfig(null), false);
  assert.equal(validateProjectConfig([]), false);
  const sparse = config(); sparse.lanes = new Array(1);
  assert.equal(validateProjectConfig(sparse), false);
  assert.equal(validateProjectConfig({...config(), lanes: [{id: 'api', owners: ['src/api', 'src/api'], prompt: 'agent.md'}]}), false);
  assert.equal(validateProjectConfig({...config(), lanes: [{id: 'api', owners: ['src\\api'], prompt: 'agent.md'}]}), false);
  assert.equal(validateProjectConfig({...config(), lanes: [{id: 'api', owners: ['C:/private'], prompt: 'agent.md'}]}), false);
});

test('allows twelve logical shadow lanes only for SoftwareFactory, not more or consumer cap changes', () => {
  const c=config();
  c.project.repository='Jamula/SoftwareFactory';
  c.limits.maxConcurrentLanes=12;
  assert.equal(validateProjectConfig(c),true);
  c.limits.maxConcurrentLanes=13;
  assert.equal(validateProjectConfig(c),false);
  c.project.repository='example/alpha';
  c.limits.maxConcurrentLanes=9;
  assert.equal(validateProjectConfig(c),false);
});
