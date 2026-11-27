import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluate, validPolicy } from '../../tools/engineering-factory/core.mjs';

const examples = JSON.parse(await readFile(new URL('../../tools/engineering-factory/example-policies.json', import.meta.url)));
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);

const byRepo = name => examples.find(entry => entry.repository === name);

function profileInput(policy) {
  const owner = policy.owners[0].prefix;
  return {
    policySource: 'trusted-default-branch',
    repository: policy.repository,
    issue: 1,
    pr: 2,
    head,
    observedHead: head,
    base,
    observedBase: base,
    baseBranch: policy.defaultBranch,
    rateLimited: false,
    remainingCredits: 10,
    activeCount: 0,
    providerReady: true,
    risk: 'low',
    priority: 1,
    paths: [`${owner}demo.ts`],
    dependencies: [],
    acceptanceComplete: true,
    baseCompatible: true,
    mainHealthy: true,
    threadsResolved: true,
    securityClear: true,
    coverage: {
      head,
      line: policy.coverage.line,
      branch: policy.coverage.branch,
      complete: true
    },
    checks: policy.checks.map(check => ({
      name: check.name,
      head,
      appId: check.appId,
      status: 'completed',
      conclusion: 'success'
    })),
    author: 'synthetic-author',
    agent: 'synthetic-agent',
    reviews: [{ reviewer: policy.reviewers[0], head, state: 'APPROVED' }]
  };
}

test('all synthetic repository profiles remain disabled at rest and evaluate independently in shadow', () => {
  assert.equal(examples.length, 3);
  for (const example of examples) {
    assert.equal(validPolicy(example), true);
    assert.equal(example.mode, 'disabled');
    assert.equal(example.killSwitch, true);
    assert.equal(evaluate(example, profileInput(example)).reason, 'STOPPED');
  }

  const shadowPolicies = examples.map(example => ({ ...example, mode: 'shadow', killSwitch: false }));
  for (let i = 0; i < shadowPolicies.length; i += 1) {
    const policy = shadowPolicies[i];
    assert.equal(evaluate(policy, profileInput(policy)).reason, 'SHADOW_ELIGIBLE');
    for (let j = 0; j < shadowPolicies.length; j += 1) {
      if (i === j) continue;
      assert.equal(evaluate(policy, profileInput(shadowPolicies[j])).reason, 'UNTRUSTED_POLICY');
    }
  }
});

test('web/genealogy baseline synthetic profile enforces 95/90, single-lane cap and APPROVED-only reviews', () => {
  const policy = { ...byRepo('example/family-tree'), mode: 'shadow', killSwitch: false };
  const input = profileInput(policy);

  assert.deepEqual(policy.coverage, { line: 95, branch: 90 });
  assert.equal(policy.maxActive, 1);
  assert.equal(evaluate(policy, input).reason, 'SHADOW_ELIGIBLE');
  assert.equal(evaluate(policy, { ...input, coverage: { ...input.coverage, line: 94.9 } }).reason, 'COVERAGE_INCOMPLETE');
  assert.equal(evaluate(policy, { ...input, coverage: { ...input.coverage, branch: 89.9 } }).reason, 'COVERAGE_INCOMPLETE');
  assert.equal(evaluate(policy, { ...input, activeCount: 1 }).reason, 'BUDGET_OR_CONCURRENCY');

  const bot = 'copilot-pull-request-reviewer[bot]';
  const withBot = { ...policy, reviewers: [...policy.reviewers, bot] };
  assert.equal(
    evaluate(withBot, {
      ...input,
      reviews: [{ reviewer: bot, head, state: 'COMMENTED', summaryDisposition: 'clear' }]
    }).reason,
    'REVIEW_MISSING'
  );
});

test('iOS/WebKit stricter synthetic profile preserves 97/90 app coverage, WebKit/iOS gates and maxActive: 2', () => {
  const policy = { ...byRepo('example/spellbook'), mode: 'shadow', killSwitch: false };
  const input = profileInput(policy);

  assert.deepEqual(policy.coverage, { line: 97, branch: 90 });
  assert.equal(policy.maxActive, 2);
  assert.equal(evaluate(policy, { ...input, paths: ['ios/ViewController.swift', 'src/bridge.ts'], activeCount: 1 }).reason, 'SHADOW_ELIGIBLE');
  assert.equal(evaluate(policy, { ...input, activeCount: 2 }).reason, 'BUDGET_OR_CONCURRENCY');
  assert.equal(evaluate(policy, { ...input, coverage: { ...input.coverage, line: 96.9 } }).reason, 'COVERAGE_INCOMPLETE');
  assert.equal(evaluate(policy, { ...input, coverage: { ...input.coverage, branch: 89.9 } }).reason, 'COVERAGE_INCOMPLETE');
  assert.equal(evaluate(policy, { ...input, checks: [input.checks[0]] }).reason, 'CHECKS_INCOMPLETE');
  assert.equal(evaluate(policy, { ...input, paths: ['android/Main.kt'] }).reason, 'PATH_OWNERSHIP_UNKNOWN');
});

test('strict-up-to-date migration-gated synthetic profile enforces trunk base, exact head and APPROVED reviews', () => {
  const policy = { ...byRepo('example/family-hub'), mode: 'shadow', killSwitch: false };
  const input = profileInput(policy);

  assert.equal(policy.defaultBranch, 'trunk');
  assert.equal(policy.mergeMethod, 'merge');
  assert.equal(evaluate(policy, input).reason, 'SHADOW_ELIGIBLE');
  assert.equal(evaluate(policy, { ...input, baseCompatible: false }).reason, 'BASE_OR_MAIN_UNHEALTHY');
  assert.equal(evaluate(policy, { ...input, baseBranch: 'main' }).reason, 'STALE_HEAD_OR_BASE');
  assert.equal(evaluate(policy, { ...input, observedBase: head }).reason, 'STALE_HEAD_OR_BASE');
  assert.equal(evaluate(policy, { ...input, reviews: [{ reviewer: policy.reviewers[0], head: base, state: 'APPROVED' }] }).reason, 'REVIEW_MISSING');
  assert.equal(evaluate(policy, { ...input, reviews: [{ reviewer: policy.reviewers[0], head, state: 'DISMISSED' }] }).reason, 'REVIEW_MISSING');

  const bot = 'copilot-pull-request-reviewer[bot]';
  const withBot = { ...policy, reviewers: [...policy.reviewers, bot] };
  assert.equal(
    evaluate(withBot, {
      ...input,
      reviews: [{ reviewer: bot, head, state: 'COMMENTED', summaryDisposition: 'clear' }]
    }).reason,
    'REVIEW_MISSING'
  );
});
