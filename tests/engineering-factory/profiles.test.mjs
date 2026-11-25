import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluate } from '../../tools/engineering-factory/core.mjs';

const examples = JSON.parse(await readFile(new URL('../../tools/engineering-factory/example-policies.json', import.meta.url)));
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);

function profileInput(policy) {
  const owner = policy.owners[0].prefix;
  const check = policy.checks[0];
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
    checks: [{
      name: check.name,
      head,
      appId: check.appId,
      status: 'completed',
      conclusion: 'success'
    }],
    author: 'synthetic-author',
    agent: 'synthetic-agent',
    reviews: [{ reviewer: 'synthetic-reviewer', head, state: 'APPROVED' }]
  };
}

test('all synthetic repository profiles evaluate independently', () => {
  const policies = examples.map(example => ({ ...example, mode: 'shadow', killSwitch: false }));
  for (const policy of policies) {
    assert.equal(evaluate(policy, profileInput(policy)).reason, 'SHADOW_ELIGIBLE');
  }
  assert.equal(evaluate(policies[1], profileInput(policies[2])).reason, 'UNTRUSTED_POLICY');
  assert.equal(evaluate(policies[2], profileInput(policies[1])).reason, 'UNTRUSTED_POLICY');
});
