import test from 'node:test';
import assert from 'node:assert/strict';
import {createShadowSquashController, guardedSquashEvidence} from '../../tools/engineering-factory/protected-squash.mjs';

const scope = {repository: 'Jamula/SoftwareFactory', repositoryId: 1471342715, branch: 'main'};
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const mergeCommit = 'c'.repeat(40);
const intent = {...scope, number: 12, expectedHead: head, expectedBase: base};
const reviewer = 'copilot-pull-request-reviewer[bot]';
const checks = ['build-test', 'upload-coverage-javascript', 'windows-aspire-runtime', 'CodeQL']
  .map((name, index) => ({name, appId: index + 1}));
const evaluated = e => guardedSquashEvidence(intent, e).reason;
const receipt = {...scope, number: 12, head, base, method: 'squash', mergeCommit, merged: true};
const healthy = {...scope, head: mergeCommit, healthy: true, stop: false};

function evidence() {
  return {
    ...scope, number: 12, head, base,
    open: true, draft: false, stop: false, scopeVerified: true, nativeQueue: false,
    protection: {...scope, base, verified: true, protected: true, bypass: false, method: 'squash',
      upToDate: true, review: true, threads: true, security: true, requiredChecks: checks},
    policy: {version: 1, repository: scope.repository, defaultBranch: 'main', mergeMethod: 'squash',
      mode: 'shadow', killSwitch: false, checks, reviewers: [reviewer], coverage: {line: 98, branch: 95},
      owners: [{prefix: 'src', owner: 'synthetic-owner'}], maxActive: 1, creditLimit: 5,
      riskClasses: ['low']},
    snapshot: {repository: scope.repository, policySource: 'trusted-default-branch', pr: 12, issue: 1,
      head, base, observedHead: head, observedBase: base, baseBranch: 'main', rateLimited: false,
      remainingCredits: 1, activeCount: 0, providerReady: true, risk: 'low', priority: 1,
      paths: ['src/component.mjs'], dependencies: [], acceptanceComplete: true, baseCompatible: true,
      mainHealthy: true, author: 'author', agent: 'agent',
      checks: checks.map(check => ({...check, head, status: 'completed', conclusion: 'success'}))},
    reviewHistory: [{sequence: 1, reviewer, head, state: 'COMMENTED', summaryDisposition: 'clear'}],
    coverageReports: [{component: 'component', head, lines: 98, lineTotal: 100, branches: 95, branchTotal: 100}],
    expectedComponents: ['component'], threads: {head, resolved: true}, security: {head, clear: true},
    platformReview: {head, complete: true, independent: true, summaryDisposition: 'clear', findings: []}
  };
}

test('a protected candidate stays shadow-only and fails closed on identity, queue and protection changes', () => {
  assert.deepEqual(guardedSquashEvidence(intent, evidence()),
    {shadow: true, liveMerge: false, dependentWorkAllowed: false, reason: 'SHADOW_SQUASH_ELIGIBLE'});
  for (const invalid of [
    null, {...intent, repository: 'example/other'}, {...intent, repositoryId: 1},
    {...intent, branch: 'feature'}, {...intent, number: 0}, {...intent, number: 1.1},
    {...intent, expectedHead: 'bad'}, {...intent, expectedBase: 'bad'},
    {...intent, expectedBase: head}, {...scope}
  ]) assert.equal(guardedSquashEvidence(invalid, evidence()).reason, 'INTENT_UNKNOWN');
  for (const change of [
    {repository: 'example/other'}, {branch: 'feature'}, {number: 13}, {head: base}, {base: head}, {repositoryId: 1}
  ]) assert.equal(evaluated({...evidence(), ...change}), 'SCOPE_OR_HEAD_CHANGED');
  assert.equal(evaluated({...scope, number: 12, head, base}), 'EVIDENCE_UNKNOWN');
  for (const change of [{open: false}, {draft: true}, {stop: true}, {scopeVerified: false}]) {
    assert.equal(evaluated({...evidence(), ...change}), 'STOPPED_OR_UNAUTHORIZED');
  }
  for (const nativeQueue of [true, null]) assert.equal(evaluated({...evidence(), nativeQueue}), 'QUEUE_PATH_REQUIRED');
  for (const change of [{repositoryId: 2}, {base: head}, {verified: false}, {protected: false},
    {bypass: true}, {method: 'merge'}, {upToDate: false}, {review: false}, {threads: false}, {security: false},
    {requiredChecks: []}, {requiredChecks: null}, {requiredChecks: [{name: 'build-test', appId: 700}]}
  ]) {
    const e = evidence();
    assert.equal(evaluated({...e, protection: {...e.protection, ...change}}), 'PROTECTIONS_UNVERIFIED');
  }
  const e = evidence();
  assert.equal(evaluated({...e, protection: scope}), 'PROTECTIONS_UNVERIFIED');
  for (const policy of [null, {...e.policy, repository: 'example/candidate'},
    {...e.policy, defaultBranch: 'feature'}, {...e.policy, mergeMethod: 'rebase'}])
    assert.equal(evaluated({...e, policy}), 'PROTECTIONS_UNVERIFIED');
});

test('checks fresh coverage, threads, security, review history, required producers and candidate policy', () => {
  const e = evidence();
  for (const snapshot of [null, {...e.snapshot, head: base}, {...e.snapshot, base: head}, {...e.snapshot, pr: 13}])
    assert.equal(evaluated({...e, snapshot}), 'SCOPE_OR_HEAD_CHANGED');
  for (const patch of [{threads: null}, {threads: {head: base, resolved: true}},
    {threads: {head, resolved: false}}, {security: {head, clear: false}}])
    assert.equal(evaluated({...e, ...patch}), 'THREADS_OR_SECURITY_UNKNOWN');
  for (const reviewHistory of [null, new Array(1), [null], [{...e.reviewHistory[0], sequence: 0}]])
    assert.equal(evaluated({...e, reviewHistory}), 'REVIEW_UNVERIFIED');
  for (const change of [{head: base}, {state: 'DISMISSED'}, {summaryDisposition: 'uncertain'},
    {summaryDisposition: 'actionable'}]) {
    assert.equal(evaluated({...e, reviewHistory: [{...e.reviewHistory[0], ...change}]}), 'REVIEW_MISSING');
  }
  const objection = {reviewer, head, sequence: 2, state: 'CHANGES_REQUESTED'};
  assert.equal(evaluated({...e, reviewHistory: [...e.reviewHistory, objection]}), 'REVIEW_MISSING');
  assert.equal(evaluated({...e, coverageReports: [{...e.coverageReports[0], head: base}]}), 'COVERAGE_UNVERIFIED');
  for (const coverage of [{line: 99, branch: 95}, {line: 98, branch: 96}])
    assert.equal(evaluated({...e, policy: {...e.policy, coverage}}), 'COVERAGE_UNVERIFIED');
  assert.equal(evaluated({...e, snapshot: {...e.snapshot, checks:
    e.snapshot.checks.map(check => ({...check, appId: check.appId + 1}))}}), 'CHECKS_INCOMPLETE');
  for (const [key, reason] of [['acceptanceComplete', 'ACCEPTANCE_INCOMPLETE'], ['mainHealthy', 'BASE_OR_MAIN_UNHEALTHY']])
    assert.equal(evaluated({...e, snapshot: {...e.snapshot, [key]: false}}), reason);
  assert.equal(evaluated({...e, platformReview: {...e.platformReview, summaryDisposition: 'uncertain'}}),
    'REVIEW_INCOMPLETE');
  assert.equal(evaluated({...e, protection: {...e.protection, requiredChecks: checks.slice(0, 3)}}),
    'PLATFORM_POLICY_INCOMPLETE');
});

test('rejects complex metadata without executing accessors, proxies or custom iteration', () => {
  const e = evidence();
  let calls = 0;
  const poison = () => { calls++; throw Error('unexpected user code'); };
  const item = {...e.reviewHistory[0]};
  Object.defineProperty(item, 'summaryDisposition', {get: poison});
  const policy = new Proxy(e.policy, {get: poison});
  assert.equal(evaluated({...e, policy}), 'PROTECTIONS_UNVERIFIED');
  assert.equal(evaluated({...e, reviewHistory: [item]}), 'REVIEW_UNVERIFIED');
  const snapshots = [
    {...e.snapshot, extra: undefined}, {...e.snapshot, [Symbol('hidden')]: 1},
    {...e.snapshot, extra: new Date(0)}, {...e.snapshot, extra: Array(257).fill(0)},
    {...e.snapshot, extra: Array.from({length: 250}, () => Array(100).fill(0))}
  ];
  const cyclic = {...e.snapshot};
  cyclic.extra = cyclic;
  for (const snapshot of [...snapshots, cyclic]) assert.equal(evaluated({...e, snapshot}), 'SCOPE_OR_HEAD_CHANGED');
  const protection = {...e.protection, requiredChecks: new Proxy(checks, {get: poison})};
  assert.equal(evaluated({...e, protection}), 'PROTECTIONS_UNVERIFIED');
  const custom = Object.setPrototypeOf([...checks], Object.create(Array.prototype));
  const accessor = [...checks];
  Object.defineProperty(accessor, 0, {get: poison});
  for (const requiredChecks of [custom, accessor, Array(251).fill(checks[0])])
    assert.equal(evaluated({...e, protection: {...e.protection, requiredChecks}}), 'PROTECTIONS_UNVERIFIED');
  assert.equal(calls, 0);
});

const mock = change => ({
  mode: 'shadow', readCandidate: async () => evidence(), simulateSquash: async () => receipt,
  readMain: async () => healthy, readMergeReceipt: async () => receipt, ...change
});

test('serializes concurrent mock operations, re-reads evidence and verifies resulting main', async () => {
  for (const transport of [null, {...mock(), mode: 'live'}, {...mock(), readMain: false}]) {
    assert.throws(() => createShadowSquashController(transport), /INVALID_SHADOW_SQUASH_TRANSPORT/);
  }
  let resolveFresh;
  const fresh = new Promise(resolve => { resolveFresh = resolve; });
  const calls = [];
  const controller = createShadowSquashController(mock({
    readCandidate: async target => { calls.push(['read', target]); return fresh; },
    simulateSquash: async target => { calls.push(['simulate', target]); return receipt; }
  }));
  assert.equal((await controller.run(null)).reason, 'INTENT_UNKNOWN');
  assert.equal((await controller.reconcile()).reason, 'NO_RECOVERABLE_INTENT');
  const running = controller.run({...intent, extraneous: 'discard me'});
  assert.equal((await controller.run(intent)).reason, 'SERIALIZED_OR_RECOVERY_REQUIRED');
  assert.equal((await controller.reconcile()).reason, 'NO_RECOVERABLE_INTENT');
  resolveFresh(evidence());
  assert.deepEqual(await running, {shadow: true, liveMerge: false, dependentWorkAllowed: true,
    reason: 'SHADOW_MAIN_VERIFIED', mergeCommit});
  assert.deepEqual(calls.map(([name]) => name), ['read', 'simulate']);
  assert.deepEqual(calls[0][1], {...intent, method: 'squash'});
  assert.equal(Object.isFrozen(calls[0][1]), true);
  assert.equal(calls[0][1], calls[1][1]);
  assert.equal((await controller.run(intent)).reason, 'BASE_MOVED_SINCE_VERIFICATION');
  assert.equal((await controller.run({...intent, expectedBase: mergeCommit})).reason, 'SCOPE_OR_HEAD_CHANGED');
  const stale = createShadowSquashController(mock({readCandidate: async () => ({...evidence(), head: base}),
    simulateSquash: async () => assert.fail('stale read must never simulate')}));
  assert.equal((await stale.run(intent)).reason, 'SCOPE_OR_HEAD_CHANGED');
});

test('never retries simulation after an uncertain receipt or unhealthy main', async () => {
  let simulated = 0;
  let main = healthy;
  let existing;
  const controller = createShadowSquashController(mock({
    simulateSquash: async () => { simulated++; throw Error('lost result'); },
    readMergeReceipt: async () => { if (!existing) throw Error('read unavailable'); return existing; },
    readMain: async () => main
  }));
  assert.equal((await controller.run(intent)).reason, 'RECOVERY_REQUIRED');
  assert.equal((await controller.run(intent)).reason, 'SERIALIZED_OR_RECOVERY_REQUIRED');
  assert.equal((await controller.reconcile()).reason, 'RECOVERY_REQUIRED');
  for (const variant of [null, scope, {...receipt, merged: false}, {...receipt, method: 'merge'},
    {...receipt, mergeCommit: 'bad'}, {...receipt, mergeCommit: head}
  ]) {
    existing = variant ?? {};
    assert.equal((await controller.reconcile()).reason, 'MERGE_RECEIPT_UNKNOWN');
  }
  existing = receipt;
  for (const candidate of [null, scope, {...healthy, head: base}, {...healthy, healthy: false}, {...healthy, stop: true}]) {
    main = candidate;
    assert.equal((await controller.reconcile()).reason, 'MAIN_VERIFICATION_REQUIRED');
  }
  main = healthy;
  const result = await controller.reconcile();
  assert.equal(result.reason, 'SHADOW_MAIN_VERIFIED');
  assert.equal(result.dependentWorkAllowed, true);
  assert.equal(simulated, 1);
  const unavailable = createShadowSquashController(mock({readCandidate: async () => { throw Error('read'); }}));
  assert.equal((await unavailable.run(intent)).reason, 'FRESH_EVIDENCE_UNAVAILABLE');
  const ambiguous = createShadowSquashController(mock({simulateSquash: async () => ({...receipt, head: base})}));
  assert.equal((await ambiguous.run(intent)).reason, 'MERGE_RECEIPT_UNKNOWN');
  assert.equal((await ambiguous.run(intent)).reason, 'SERIALIZED_OR_RECOVERY_REQUIRED');
});
