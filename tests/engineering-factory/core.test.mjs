import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluate, validPolicy } from '../../tools/engineering-factory/core.mjs';

const examples = JSON.parse(await readFile(new URL('../../tools/engineering-factory/example-policies.json', import.meta.url)));
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const policy = { ...examples[0], mode: 'shadow', killSwitch: false };
const snapshot = {
  policySource: 'trusted-default-branch', repository: policy.repository, issue: 1, pr: 2,
  head, observedHead: head, base, observedBase: base, baseBranch: 'main',
  rateLimited: false, remainingCredits: 10, activeCount: 0, providerReady: true,
  risk: 'low', priority: 1, paths: ['src/demo.cs'], dependencies: [],
  acceptanceComplete: true, baseCompatible: true, mainHealthy: true,
  threadsResolved: true, securityClear: true,
  coverage: { head, line: 95, branch: 90, complete: true },
  checks: [{ name: 'build-test', head, appId: 12345, status: 'completed', conclusion: 'success' }],
  author: 'synthetic-author', agent: 'synthetic-agent',
  reviews: [{ reviewer: 'synthetic-reviewer', head, state: 'APPROVED' }]
};

test('example policies are strict and disabled', () => {
  for (const p of examples) {
    assert.equal(validPolicy(p), true);
    assert.equal(p.mode, 'disabled');
    assert.equal(p.killSwitch, true);
    assert.equal(validPolicy({ ...p, extra: true }), false);
  }
  assert.equal(evaluate(policy, snapshot).reason, 'SHADOW_ELIGIBLE');
});

for (const [name, change, reason] of [
  ['untrusted policy', { policySource: 'pr-head' }, 'UNTRUSTED_POLICY'],
  ['changed head', { observedHead: base }, 'STALE_HEAD_OR_BASE'],
  ['changed base', { observedBase: head }, 'STALE_HEAD_OR_BASE'],
  ['rate limit', { rateLimited: true }, 'RATE_LIMIT_OR_UNKNOWN'],
  ['unknown budget', { remainingCredits: null }, 'BUDGET_OR_CONCURRENCY'],
  ['concurrency', { activeCount: 1 }, 'BUDGET_OR_CONCURRENCY'],
  ['blocked dependency', { dependencies: [{ issue: 3, accepted: false }] }, 'DEPENDENCIES_BLOCKED'],
  ['partial acceptance', { acceptanceComplete: false }, 'ACCEPTANCE_INCOMPLETE'],
  ['main failure', { mainHealthy: false }, 'BASE_OR_MAIN_UNHEALTHY'],
  ['open thread', { threadsResolved: false }, 'THREADS_OR_SECURITY_UNKNOWN'],
  ['ambiguous coverage', { coverage: null }, 'COVERAGE_INCOMPLETE'],
  ['missing checks', { checks: [] }, 'CHECKS_INCOMPLETE'],
  ['wrong producer', { checks: [{ ...snapshot.checks[0], appId: 999 }] }, 'CHECKS_INCOMPLETE'],
  ['incomplete checks', { checks: [{ ...snapshot.checks[0], status: 'in_progress' }] }, 'CHECKS_INCOMPLETE'],
  ['null check', { checks: [null] }, 'CHECKS_INCOMPLETE'],
  ['stale review', { reviews: [{ ...snapshot.reviews[0], head: base }] }, 'REVIEW_MISSING'],
  ['dismissed review', { reviews: [{ ...snapshot.reviews[0], state: 'DISMISSED' }] }, 'REVIEW_MISSING'],
  ['outstanding changes requested', { reviews: [...snapshot.reviews,
    { reviewer: 'another-reviewer', head, state: 'CHANGES_REQUESTED' }] }, 'REVIEW_MISSING'],
  ['comment cannot clear previous request', { reviews: [...snapshot.reviews,
    { reviewer: 'another-reviewer', head, state: 'COMMENTED' }] }, 'REVIEW_MISSING'],
  ['self review', { author: 'synthetic-reviewer' }, 'REVIEW_MISSING'],
  ['case-insensitive self review', { agent: 'Synthetic-Reviewer' }, 'REVIEW_MISSING'],
  ['unknown review state', { reviews: [...snapshot.reviews,
    { reviewer: 'another-reviewer', head: null, state: null }] }, 'REVIEW_MISSING'],
  ['duplicate reviewer casing', { reviews: [...snapshot.reviews,
    { reviewer: 'Synthetic-Reviewer', head, state: 'APPROVED' }] }, 'REVIEW_MISSING'],
  ['path traversal', { paths: ['src/../other'] }, 'PATH_OWNERSHIP_UNKNOWN'],
  ['different path prefix', { paths: ['src-other/demo.cs'] }, 'PATH_OWNERSHIP_UNKNOWN'],
  ['backslash path', { paths: ['src/..\\other'] }, 'PATH_OWNERSHIP_UNKNOWN'],
]) {
  test(name, () => assert.equal(evaluate(policy, { ...snapshot, ...change }).reason, reason));
}

test('emergency stop and foreign repository fail closed', () => {
  assert.equal(evaluate({ ...policy, killSwitch: true }, snapshot).reason, 'STOPPED');
  assert.equal(evaluate(policy, { ...snapshot, repository: 'other/repository' }).reason, 'UNTRUSTED_POLICY');
});

test('a different repository and check can be evaluated independently', () => {
  const second = { ...examples[1], mode: 'shadow', killSwitch: false };
  const input = {
    ...snapshot, repository: second.repository, baseBranch: second.defaultBranch,
    paths: ['app/example.ts'], coverage: { head, line: 100, branch: 100, complete: true },
    checks: [{ ...snapshot.checks[0], name: second.checks[0].name, appId: second.checks[0].appId }]
  };
  assert.equal(evaluate(second, input).reason, 'SHADOW_ELIGIBLE');
});


test('sparse policy arrays cannot skip required validation', () => {
  for (const field of ['checks','reviewers','owners','riskClasses']) {
    const sparse = new Array(1);
    assert.equal(validPolicy({...policy,[field]:sparse}),false);
    assert.equal(evaluate({...policy,[field]:sparse},snapshot).reason,'INVALID_POLICY');
    const hidden = new Array(1); hidden.extra = policy[field][0];
    assert.equal(validPolicy({...policy,[field]:hidden}),false);
  }
});
test('sparse snapshot evidence fails closed, including mixed valid and missing entries', () => {
  for (const [field,reason] of [['paths','PATH_OWNERSHIP_UNKNOWN'],['dependencies','DEPENDENCIES_BLOCKED'],['checks','CHECKS_INCOMPLETE'],['reviews','REVIEW_MISSING']]) {
    const sparse = new Array(2);
    if(snapshot[field].length) sparse[1] = snapshot[field][0];
    assert.equal(evaluate(policy,{...snapshot,[field]:sparse}).reason,reason);
  }
  const inherited = new Array(1); Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype),{0:snapshot.checks[0]}));
  assert.equal(evaluate(policy,{...snapshot,checks:inherited}).reason,'CHECKS_INCOMPLETE');
});
