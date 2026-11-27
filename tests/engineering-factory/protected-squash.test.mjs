import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FACTORY_SCOPE,
  createGitHubShadowTransport,
  createShadowSquashController,
  guardedSquashEvidence,
  readProtectedSquashCandidate
} from '../../tools/engineering-factory/protected-squash.mjs';

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
  const proxyEvidence = new Proxy(e, {get: poison});
  const getterPolicyEvidence = {...e};
  Object.defineProperty(getterPolicyEvidence, 'policy', {get: poison});
  assert.equal(evaluated({...e, policy}), 'PROTECTIONS_UNVERIFIED');
  assert.equal(guardedSquashEvidence(intent, proxyEvidence).reason, 'SCOPE_OR_HEAD_CHANGED');
  assert.equal(guardedSquashEvidence(intent, getterPolicyEvidence).reason, 'EVIDENCE_UNKNOWN');
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

test('parameterizes consumer scopes while preserving consumer formal-approval and >=95/90+ coverage gates', async () => {
  assert.equal(DEFAULT_FACTORY_SCOPE.repositoryId, 1471342715);
  assert.equal(guardedSquashEvidence(intent, evidence(),
    {repository: 'Jamula/SoftwareFactory', repositoryId: 1471342715}).reason, 'SHADOW_SQUASH_ELIGIBLE');
  const consumerScope = {
    repository: 'Jamula/Spellbook',
    repositoryId: 987654321,
    branch: 'main',
    requiredChecks: ['spellbook-ci', 'spellbook-security']
  };
  const consumerChecks = consumerScope.requiredChecks.map((name, i) => ({name, appId: i + 10}));
  const consumerIntent = {
    repository: consumerScope.repository,
    repositoryId: consumerScope.repositoryId,
    branch: 'main',
    number: 88,
    expectedHead: head,
    expectedBase: base
  };
  const consumerEvidence = () => ({
    repository: consumerScope.repository,
    repositoryId: consumerScope.repositoryId,
    branch: 'main',
    number: 88,
    head,
    base,
    open: true,
    draft: false,
    stop: false,
    scopeVerified: true,
    nativeQueue: false,
    protection: {
      repository: consumerScope.repository,
      repositoryId: consumerScope.repositoryId,
      branch: 'main',
      base,
      verified: true,
      protected: true,
      bypass: false,
      method: 'squash',
      upToDate: true,
      review: true,
      requiredApprovingReviewCount: 1,
      hostedReviewGate: false,
      threads: true,
      security: true,
      requiredChecks: consumerChecks
    },
    policy: {
      version: 1,
      repository: consumerScope.repository,
      defaultBranch: 'main',
      mergeMethod: 'squash',
      mode: 'shadow',
      killSwitch: false,
      checks: consumerChecks,
      reviewers: ['spellbook-maintainer'],
      coverage: {line: 97, branch: 92},
      owners: [{prefix: 'src', owner: 'spellbook-owner'}],
      maxActive: 1,
      creditLimit: 5,
      riskClasses: ['low']
    },
    snapshot: {
      repository: consumerScope.repository,
      policySource: 'trusted-default-branch',
      pr: 88,
      issue: 5,
      head,
      base,
      observedHead: head,
      observedBase: base,
      baseBranch: 'main',
      rateLimited: false,
      remainingCredits: 1,
      activeCount: 0,
      providerReady: true,
      risk: 'low',
      priority: 1,
      paths: ['src/spell.mjs'],
      dependencies: [],
      acceptanceComplete: true,
      baseCompatible: true,
      mainHealthy: true,
      author: 'spellbook-author',
      agent: 'spellbook-agent',
      checks: consumerChecks.map(c => ({...c, head, status: 'completed', conclusion: 'success'}))
    },
    reviewHistory: [{sequence: 1, reviewer: 'spellbook-maintainer', head, state: 'APPROVED'}],
    coverageReports: [{component: 'spell', head, lines: 97, lineTotal: 100, branches: 92, branchTotal: 100}],
    expectedComponents: ['spell'],
    threads: {head, resolved: true},
    security: {head, clear: true},
    platformReview: {head, complete: true, independent: true, summaryDisposition: 'clear', findings: []}
  });

  assert.deepEqual(guardedSquashEvidence(consumerIntent, consumerEvidence(), consumerScope),
    {shadow: true, liveMerge: false, dependentWorkAllowed: false, reason: 'SHADOW_SQUASH_ELIGIBLE'});

  const inferredChecksScope = {repository: consumerScope.repository, repositoryId: consumerScope.repositoryId};
  assert.equal(guardedSquashEvidence(consumerIntent, consumerEvidence(), inferredChecksScope).reason,
    'SHADOW_SQUASH_ELIGIBLE');

  const zeroNativeReview = consumerEvidence();
  zeroNativeReview.protection = {...zeroNativeReview.protection, review: false, requiredApprovingReviewCount: 0, hostedReviewGate: true};
  assert.equal(guardedSquashEvidence(consumerIntent, zeroNativeReview, consumerScope).reason,
    'PROTECTIONS_UNVERIFIED');

  const belowConsumerTarget = consumerEvidence();
  belowConsumerTarget.coverageReports = [{component: 'spell', head, lines: 96, lineTotal: 100, branches: 92, branchTotal: 100}];
  assert.equal(guardedSquashEvidence(consumerIntent, belowConsumerTarget, consumerScope).reason,
    'COVERAGE_UNVERIFIED');

  const invalidConsumerInventory = consumerEvidence();
  invalidConsumerInventory.expectedComponents = [];
  assert.equal(guardedSquashEvidence(consumerIntent, invalidConsumerInventory, consumerScope).reason,
    'COVERAGE_UNVERIFIED');

  const duplicateConsumerReport = consumerEvidence();
  duplicateConsumerReport.expectedComponents = ['spell', 'rune'];
  duplicateConsumerReport.coverageReports = [
    {component: 'spell', head, lines: 98, lineTotal: 100, branches: 95, branchTotal: 100},
    {component: 'spell', head, lines: 98, lineTotal: 100, branches: 95, branchTotal: 100}
  ];
  assert.equal(guardedSquashEvidence(consumerIntent, duplicateConsumerReport, consumerScope).reason,
    'COVERAGE_UNVERIFIED');

  for (const badScope of [
    null,
    {repository: '../bad', repositoryId: 1},
    {repository: 'Jamula/SoftwareFactory', repositoryId: 987654321},
    {repository: 'Jamula/Spellbook', repositoryId: 1471342715, requiredChecks: ['spellbook-ci']},
    {repository: 'Jamula/SoftwareFactory', repositoryId: 1471342715, requiredChecks: ['build-test']},
    {repository: 'Jamula/Spellbook', repositoryId: 987654321, branch: '/bad'},
    {repository: 'Jamula/Spellbook', repositoryId: 987654321, requiredChecks: []}
  ]) {
    assert.equal(guardedSquashEvidence(consumerIntent, consumerEvidence(), badScope).reason,
      'PROTECTIONS_UNVERIFIED');
  }
  assert.equal(guardedSquashEvidence(consumerIntent, {...consumerEvidence(), policy: null},
    {repository: 'Jamula/Spellbook', repositoryId: 987654321}).reason, 'PROTECTIONS_UNVERIFIED');
  assert.throws(() => createShadowSquashController(mock(), {repository: '../bad', repositoryId: 1}),
    /INVALID_SHADOW_SQUASH_SCOPE/);

  const consumerReceipt = {
    repository: consumerScope.repository,
    repositoryId: consumerScope.repositoryId,
    branch: 'main',
    number: 88,
    head,
    base,
    method: 'squash',
    mergeCommit,
    merged: true
  };
  const consumerMain = {
    repository: consumerScope.repository,
    repositoryId: consumerScope.repositoryId,
    branch: 'main',
    head: mergeCommit,
    healthy: true,
    stop: false
  };
  const scopedController = createShadowSquashController({
    mode: 'shadow',
    scope: consumerScope,
    readCandidate: async () => consumerEvidence(),
    simulateSquash: async () => consumerReceipt,
    readMergeReceipt: async () => consumerReceipt,
    readMain: async () => consumerMain
  });
  assert.deepEqual(await scopedController.run(consumerIntent), {
    shadow: true,
    liveMerge: false,
    dependentWorkAllowed: true,
    reason: 'SHADOW_MAIN_VERIFIED',
    mergeCommit
  });
});

test('aggregates read-only GitHub API metadata for required_approving_review_count: 0 and blocks stale, dismissed, summary-only, self/agent, race and unhealthy-main cases', async () => {
  const staleHead = 'd'.repeat(40);
  const movedBase = 'e'.repeat(40);
  const policyChecks = [
    {name: 'build-test', appId: 15368},
    {name: 'upload-coverage-javascript', appId: 15368},
    {name: 'windows-aspire-runtime', appId: 15368},
    {name: 'CodeQL', appId: 29110}
  ];
  const policy = {
    version: 1,
    repository: scope.repository,
    defaultBranch: 'main',
    mergeMethod: 'squash',
    mode: 'shadow',
    killSwitch: false,
    checks: policyChecks,
    reviewers: [reviewer, 'human-reviewer', 'second-reviewer', 'pr-author', 'coding-agent'],
    coverage: {line: 98, branch: 95},
    owners: [{prefix: 'src', owner: 'factory-owner'}],
    maxActive: 1,
    creditLimit: 5,
    riskClasses: ['low']
  };
  const response = value => new Response(JSON.stringify(value));
  const checkRow = (id, name, shaValue, conclusion = 'success') => ({
    id,
    name,
    head_sha: shaValue,
    status: 'completed',
    conclusion,
    completed_at: '2026-11-26T20:00:00Z',
    app: {
      id: name === 'CodeQL' ? 29110 : 15368,
      slug: name === 'CodeQL' ? 'github-code-scanning' : 'github-actions'
    }
  });
  const checkSuite = (shaValue, overrides = {}) => {
    const rows = policyChecks.map((c, idx) =>
      checkRow(idx + 1, c.name, shaValue, overrides[c.name] ?? 'success'));
    return {total_count: rows.length, check_runs: rows};
  };
  const clearOverview = '<!-- ccr-overview-v2 -->\n\n### 🟢 Approval recommended\n\n**No open issues** 🎉';
  const summaryFindingOverview = '<!-- ccr-overview-v2 -->\n\n### 🟡 Changes recommended\n\n<details open>\n<summary><strong>1 open issue</strong></summary>\n- summary-only defect\n</details>';

  function createGitHubApi(state = {}) {
    const repoObj = {id: scope.repositoryId, full_name: scope.repository};
    const currentPull = () => ({
      number: 12,
      state: 'open',
      draft: false,
      user: {login: state.author ?? 'pr-author', id: 55},
      base: {repo: repoObj, ref: 'main', sha: state.pullBase ?? base},
      head: {repo: repoObj, sha: state.pullHead ?? head},
      mergeable: true,
      mergeable_state: 'clean'
    });
    const rules = state.rules ?? [
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 0,
          required_review_thread_resolution: true,
          allowed_merge_methods: ['squash']
        }
      },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [
            {context: 'build-test', integration_id: 15368},
            {context: 'upload-coverage-javascript', integration_id: 15368},
            {context: 'windows-aspire-runtime', integration_id: 15368}
          ]
        }
      },
      {
        type: 'code_scanning',
        parameters: {
          code_scanning_tools: [{
            tool: 'CodeQL',
            security_alerts_threshold: 'medium_or_higher',
            alerts_threshold: 'errors_and_warnings'
          }]
        }
      }
    ];
    let pullReads = 0;
    return async (url, options) => {
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(options.signal instanceof AbortSignal, true);
      assert.equal(options.headers.authorization, undefined);
      if (url.endsWith('/pulls/12')) {
        pullReads++;
        if (state.mutateOnReread && pullReads === 2) {
          return response({...currentPull(), head: {repo: repoObj, sha: staleHead}});
        }
        return response(currentPull());
      }
      if (url.endsWith('/rules/branches/main')) return response(rules);
      if (url.endsWith('/branches/main/protection')) {
        return state.legacyProtection
          ? response(state.legacyProtection)
          : new Response(JSON.stringify({message: 'Branch not protected'}), {status: 404});
      }
      if (url.endsWith('/branches/main')) {
        return response({name: 'main', protected: true, commit: {sha: state.mainHead ?? base}});
      }
      if (url.includes('/files?')) return response(state.files ?? [{filename: 'src/component.mjs'}]);
      if (url.includes('/reviews?')) {
        return response(state.reviews ?? [{
          id: 500,
          user: {login: reviewer, id: 175728472},
          state: 'COMMENTED',
          commit_id: head,
          submitted_at: '2026-11-26T20:01:00Z',
          body: clearOverview
        }]);
      }
      if (url.includes(`/commits/${head}/check-runs`)) return response(checkSuite(head, state.headCheckOverrides));
      if (url.includes(`/commits/${base}/check-runs`)) return response(checkSuite(base, state.baseCheckOverrides));
      if (url.includes(`/commits/${mergeCommit}/check-runs`)) {
        return response(checkSuite(mergeCommit, state.mergedMainCheckOverrides));
      }
      throw Error('unexpected endpoint ' + url);
    };
  }

  const baseTransportOptions = apiState => ({
    request: createGitHubApi(apiState),
    policy,
    issue: 8,
    agent: 'coding-agent',
    coverageReports: [{component: 'component', head, lines: 99, lineTotal: 100, branches: 96, branchTotal: 100}],
    expectedComponents: ['component'],
    threads: {head, resolved: true},
    security: {head, clear: true},
    remainingCredits: 1,
    activeCount: 0,
    providerReady: true,
    risk: 'low',
    priority: 1,
    dependencies: [],
    acceptanceComplete: true,
    simulateSquash: async target => {
      apiState.mainHead = mergeCommit;
      return {...scope, number: target.number, head: target.expectedHead, base: target.expectedBase,
        method: 'squash', mergeCommit, merged: true};
    },
    readMergeReceipt: async target => ({
      ...scope, number: target.number, head: target.expectedHead, base: target.expectedBase,
      method: 'squash', mergeCommit, merged: true
    })
  });

  // 1. Happy path: required_approving_review_count: 0 + clean Copilot COMMENTED review -> shadow verified
  const happyState = {};
  const happyController = createShadowSquashController(createGitHubShadowTransport(baseTransportOptions(happyState)));
  assert.deepEqual(await happyController.run(intent), {
    shadow: true,
    liveMerge: false,
    dependentWorkAllowed: true,
    reason: 'SHADOW_MAIN_VERIFIED',
    mergeCommit
  });
  // Subsequent intent using old base is blocked as moved base
  assert.equal((await happyController.run(intent)).reason, 'BASE_MOVED_SINCE_VERIFICATION');

  // 2. Stale head blocks (both stale Copilot review SHA and moved PR head on GitHub)
  const staleReviewController = createShadowSquashController(createGitHubShadowTransport(baseTransportOptions({
    reviews: [{
      id: 501, user: {login: reviewer, id: 175728472}, state: 'COMMENTED',
      commit_id: staleHead, submitted_at: '2026-11-26T20:01:00Z', body: clearOverview
    }]
  })));
  assert.deepEqual(await staleReviewController.run(intent), {
    shadow: true, liveMerge: false, dependentWorkAllowed: false, reason: 'REVIEW_MISSING'
  });

  const movedHeadController = createShadowSquashController(createGitHubShadowTransport(baseTransportOptions({
    pullHead: staleHead
  })));
  assert.equal((await movedHeadController.run(intent)).reason, 'SCOPE_OR_HEAD_CHANGED');

  // 3. Dismissed review blocks
  const dismissedController = createShadowSquashController(createGitHubShadowTransport(baseTransportOptions({
    reviews: [
      {id: 510, user: {login: 'human-reviewer', id: 77}, state: 'APPROVED', commit_id: head, submitted_at: '2026-11-26T20:01:00Z'},
      {id: 511, user: {login: 'human-reviewer', id: 77}, state: 'DISMISSED', commit_id: head, submitted_at: '2026-11-26T20:02:00Z'}
    ]
  })));
  assert.equal((await dismissedController.run(intent)).reason, 'REVIEW_MISSING');

  // 4. Summary-only unresolved finding blocks even when required_approving_review_count: 0 and inline threads are resolved
  const summaryFindingState = {
    reviews: [{
      id: 520, user: {login: reviewer, id: 175728472}, state: 'COMMENTED',
      commit_id: head, submitted_at: '2026-11-26T20:01:00Z', body: summaryFindingOverview
    }]
  };
  const summaryBlockedCandidate = await readProtectedSquashCandidate(intent, baseTransportOptions(summaryFindingState));
  assert.deepEqual(summaryBlockedCandidate.platformReview.findings, [
    {id: 'summary-520-1', state: 'actionable', source: 'summary'}
  ]);
  const summaryFindingController = createShadowSquashController(
    createGitHubShadowTransport(baseTransportOptions(summaryFindingState)));
  assert.equal((await summaryFindingController.run(intent)).reason, 'REVIEW_MISSING');

  // Also blocks when human APPROVED exists alongside an unresolved summary/inline finding in platformReview
  const inlineWithApproval = createShadowSquashController(createGitHubShadowTransport({
    ...baseTransportOptions({
      reviews: [{id: 521, user: {login: 'human-reviewer', id: 77}, state: 'APPROVED',
        commit_id: head, submitted_at: '2026-11-26T20:01:00Z'}]
    }),
    inlineFindings: [{id: 'inline-thread-1', state: 'actionable', source: 'inline'}]
  }));
  assert.equal((await inlineWithApproval.run(intent)).reason, 'REVIEW_INCOMPLETE');

  // 5. Self-authored and agent-authored reviews block even when listed in policy.reviewers
  for (const selfActor of ['pr-author', 'coding-agent']) {
    const selfController = createShadowSquashController(createGitHubShadowTransport(baseTransportOptions({
      reviews: [{
        id: 530, user: {login: selfActor, id: 55}, state: 'APPROVED',
        commit_id: head, submitted_at: '2026-11-26T20:01:00Z'
      }]
    })));
    assert.equal((await selfController.run(intent)).reason, 'REVIEW_MISSING');
  }
  const botAgentController = createShadowSquashController(createGitHubShadowTransport(baseTransportOptions({
    reviews: [{
      id: 531, user: {login: 'copilot-swe-agent[bot]', id: 99}, state: 'APPROVED',
      commit_id: head, submitted_at: '2026-11-26T20:01:00Z'
    }]
  })));
  assert.equal((await botAgentController.run(intent)).reason, 'REVIEW_UNVERIFIED');

  // 6. Race / moved-base blocks (moved main before merge & TOCTOU PR mutation mid-read)
  const movedMainController = createShadowSquashController(createGitHubShadowTransport(baseTransportOptions({
    mainHead: movedBase
  })));
  assert.equal((await movedMainController.run(intent)).reason, 'SCOPE_OR_HEAD_CHANGED');

  const toctouController = createShadowSquashController(createGitHubShadowTransport(baseTransportOptions({
    mutateOnReread: true
  })));
  assert.equal((await toctouController.run(intent)).reason, 'SCOPE_OR_HEAD_CHANGED');

  // 7. Unhealthy main blocks both pre-merge and post-merge (holding dependents until main recovers)
  const unhealthyBaseController = createShadowSquashController(createGitHubShadowTransport(baseTransportOptions({
    baseCheckOverrides: {'windows-aspire-runtime': 'failure'}
  })));
  assert.equal((await unhealthyBaseController.run(intent)).reason, 'BASE_OR_MAIN_UNHEALTHY');

  const postMergeState = {mergedMainCheckOverrides: {CodeQL: 'failure'}};
  let stopFlag = false;
  const postMergeController = createShadowSquashController(createGitHubShadowTransport({
    ...baseTransportOptions(postMergeState),
    readStop: () => stopFlag
  }));
  const held = await postMergeController.run(intent);
  assert.deepEqual(held, {
    shadow: true,
    liveMerge: false,
    dependentWorkAllowed: false,
    reason: 'MAIN_VERIFICATION_REQUIRED',
    mergeCommit
  });
  assert.equal((await postMergeController.run({...intent, expectedBase: mergeCommit})).reason,
    'SERIALIZED_OR_RECOVERY_REQUIRED');
  postMergeState.mergedMainCheckOverrides = {};
  stopFlag = true;
  assert.equal((await postMergeController.reconcile()).reason, 'MAIN_VERIFICATION_REQUIRED');
  stopFlag = false;
  assert.deepEqual(await postMergeController.reconcile(), {
    shadow: true,
    liveMerge: false,
    dependentWorkAllowed: true,
    reason: 'SHADOW_MAIN_VERIFIED',
    mergeCommit
  });

  // 8. Enforces distinct formal approval count >= 2 when required by ruleset or legacy protection
  const twoApprovalState = () => ({
    legacyProtection: {
      enforce_admins: {enabled: true},
      required_pull_request_reviews: {required_approving_review_count: 2}
    },
    reviews: [
      {id: 540, user: {login: 'human-reviewer', id: 77}, state: 'APPROVED',
        commit_id: head, submitted_at: '2026-11-26T20:01:00Z'}
    ]
  });
  const oneOfTwoController = createShadowSquashController(
    createGitHubShadowTransport(baseTransportOptions(twoApprovalState())));
  assert.equal((await oneOfTwoController.run(intent)).reason, 'REVIEW_MISSING');

  const bothApprovedState = twoApprovalState();
  bothApprovedState.reviews.push({
    id: 541, user: {login: 'second-reviewer', id: 78}, state: 'APPROVED',
    commit_id: head, submitted_at: '2026-11-26T20:02:00Z'
  });
  const twoOfTwoController = createShadowSquashController(
    createGitHubShadowTransport(baseTransportOptions(bothApprovedState)));
  assert.equal((await twoOfTwoController.run(intent)).reason, 'SHADOW_MAIN_VERIFIED');

  // 9. Extra policy-required check beyond scope baseline must pass on both base and post-merge main
  const extendedChecks = [...policyChecks, {name: 'extra-policy-gate', appId: 15368}];
  const extendedPolicy = {...policy, checks: extendedChecks};
  const extendedApi = (baseOverrides = {}, mergedOverrides = {}) => {
    let mainAt = base;
    return {
      request: async url => {
        if (url.endsWith('/pulls/12')) {
          const repoObj = {id: scope.repositoryId, full_name: scope.repository};
          return response({
            number: 12, state: 'open', draft: false, user: {login: 'pr-author', id: 55},
            base: {repo: repoObj, ref: 'main', sha: base}, head: {repo: repoObj, sha: head},
            mergeable: true, mergeable_state: 'clean'
          });
        }
        if (url.endsWith('/rules/branches/main')) {
          return response([
            {type: 'pull_request', parameters: {required_approving_review_count: 0,
              required_review_thread_resolution: true, allowed_merge_methods: ['squash']}},
            {type: 'required_status_checks', parameters: {strict_required_status_checks_policy: true,
              required_status_checks: extendedChecks.filter(c => c.name !== 'CodeQL')
                .map(c => ({context: c.name, integration_id: c.appId}))}},
            {type: 'code_scanning', parameters: {code_scanning_tools: [{tool: 'CodeQL',
              security_alerts_threshold: 'medium_or_higher', alerts_threshold: 'errors_and_warnings'}]}}
          ]);
        }
        if (url.endsWith('/branches/main/protection')) {
          return new Response(JSON.stringify({message: 'Branch not protected'}), {status: 404});
        }
        if (url.endsWith('/branches/main')) return response({name: 'main', protected: true, commit: {sha: mainAt}});
        if (url.includes('/files?')) return response([{filename: 'src/component.mjs'}]);
        if (url.includes('/reviews?')) {
          return response([{id: 550, user: {login: reviewer, id: 175728472}, state: 'COMMENTED',
            commit_id: head, submitted_at: '2026-11-26T20:01:00Z', body: clearOverview}]);
        }
        const shaForChecks = url.includes(head) ? head : url.includes(mergeCommit) ? mergeCommit : base;
        const mapOverrides = shaForChecks === base ? baseOverrides : shaForChecks === mergeCommit ? mergedOverrides : {};
        const rows = extendedChecks.map((c, idx) =>
          checkRow(idx + 1, c.name, shaForChecks, mapOverrides[c.name] ?? 'success'));
        return response({total_count: rows.length, check_runs: rows});
      },
      advanceMain() { mainAt = mergeCommit; }
    };
  };
  const preSimExtra = extendedApi({'extra-policy-gate': 'failure'}, {});
  const preSimController = createShadowSquashController(createGitHubShadowTransport({
    ...baseTransportOptions({}),
    policy: extendedPolicy,
    request: preSimExtra.request
  }));
  assert.equal((await preSimController.run(intent)).reason, 'BASE_OR_MAIN_UNHEALTHY');

  const postSimExtra = extendedApi({}, {'extra-policy-gate': 'failure'});
  const postSimController = createShadowSquashController(createGitHubShadowTransport({
    ...baseTransportOptions({}),
    policy: extendedPolicy,
    request: postSimExtra.request,
    simulateSquash: async target => {
      postSimExtra.advanceMain();
      return {...scope, number: target.number, head: target.expectedHead, base: target.expectedBase,
        method: 'squash', mergeCommit, merged: true};
    }
  }));
  assert.equal((await postSimController.run(intent)).reason, 'MAIN_VERIFICATION_REQUIRED');

  // 10. Dynamic readStop blocks before simulateSquash and never clears a static stop
  let simulatedWhileStopped = 0;
  const dynamicStoppedController = createShadowSquashController(createGitHubShadowTransport({
    ...baseTransportOptions({}),
    readStop: () => true,
    simulateSquash: async () => { simulatedWhileStopped++; return receipt; }
  }));
  assert.equal((await dynamicStoppedController.run(intent)).reason, 'STOPPED_OR_UNAUTHORIZED');
  assert.equal(simulatedWhileStopped, 0);

  const staticStoppedController = createShadowSquashController(createGitHubShadowTransport({
    ...baseTransportOptions({}),
    stop: true,
    readStop: () => false,
    simulateSquash: async () => { simulatedWhileStopped++; return receipt; }
  }));
  assert.equal((await staticStoppedController.run(intent)).reason, 'STOPPED_OR_UNAUTHORIZED');
  assert.equal(simulatedWhileStopped, 0);

  // 11. Renaming an unowned source file into an owned destination blocks ownership validation
  const renameController = createShadowSquashController(createGitHubShadowTransport(baseTransportOptions({
    files: [{filename: 'src/component.mjs', status: 'renamed', previous_filename: 'unowned/secret.mjs'}]
  })));
  assert.equal((await renameController.run(intent)).reason, 'PATH_OWNERSHIP_UNKNOWN');

  // 12. Missing explicit gate evidence fails closed instead of synthesizing favorable defaults
  const baseOpts = baseTransportOptions({});
  const fullCandidate = await readProtectedSquashCandidate(intent, baseOpts);
  assert.equal(fullCandidate.shadow, true);
  assert.equal(fullCandidate.liveMerge, false);
  for (const [missingField, expectedReason] of [
    ['remainingCredits', 'BUDGET_OR_CONCURRENCY'],
    ['providerReady', 'PROVIDER_UNKNOWN'],
    ['risk', 'RISK_OR_PRIORITY_UNKNOWN'],
    ['dependencies', 'DEPENDENCIES_BLOCKED'],
    ['acceptanceComplete', 'ACCEPTANCE_INCOMPLETE']
  ]) {
    const partialOpts = {...baseOpts};
    delete partialOpts[missingField];
    const candidate = await readProtectedSquashCandidate(intent, partialOpts);
    assert.equal(guardedSquashEvidence(intent, candidate).reason, expectedReason);
  }
  const withoutSecurity = {...baseOpts};
  delete withoutSecurity.security;
  assert.equal((await readProtectedSquashCandidate(intent, withoutSecurity)).reason, 'POLICY_UNKNOWN');
  assert.equal((await readProtectedSquashCandidate(intent, {...baseOpts, readStop: 'invalid'})).reason, 'STOP_UNKNOWN');
  assert.equal((await readProtectedSquashCandidate(intent, {...baseOpts, request: 'invalid'})).reason, 'READ_FAILED');

  // Explicit security alert failure and transport/candidate option validation fail closed
  const explicitSecurityAlert = await readProtectedSquashCandidate(intent, {
    ...baseTransportOptions({}),
    security: {head, clear: false}
  });
  assert.equal(guardedSquashEvidence(intent, explicitSecurityAlert).reason, 'THREADS_OR_SECURITY_UNKNOWN');
  assert.equal((await readProtectedSquashCandidate(intent, null)).reason, 'POLICY_UNKNOWN');
  assert.equal((await readProtectedSquashCandidate(intent, {
    ...baseTransportOptions({}),
    scope: {repository: '../bad', repositoryId: 1}
  })).reason, 'PROTECTIONS_UNVERIFIED');
  for (const invalidOpts of [
    null,
    {...baseTransportOptions({}), policy: null},
    {...baseTransportOptions({}), simulateSquash: null},
    {...baseTransportOptions({}), request: 'not-fn'}
  ]) {
    assert.throws(() => createGitHubShadowTransport(invalidOpts), /INVALID_SHADOW_SQUASH_TRANSPORT/);
  }
  for (const invalidScope of [
    {repository: '../bad', repositoryId: 1},
    {repository: scope.repository, repositoryId: scope.repositoryId, requiredChecks: ['missing-in-policy']}
  ]) {
    assert.throws(() => createGitHubShadowTransport({...baseTransportOptions({}), scope: invalidScope}),
      /INVALID_SHADOW_SQUASH_SCOPE/);
  }
});
