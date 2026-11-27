import test from 'node:test';
import assert from 'node:assert/strict';
import {
 classifyValidationFailure,
 diagnose as classify,
 planBuildReuse,
 planFastFeedback
} from '../../tools/engineering-factory/validation-diagnosis.mjs';
import {softwareFactoryCatalog} from '../../tools/engineering-factory/contract-routing.mjs';
const head='a'.repeat(40);
const e={head,complete:true,category:'infra',attempt:0,retryLimit:2,transient:true};
test('bounded retry recommendation only for verified transient infra',()=>{
 assert.deepEqual(classify(e,head),{shadow:true,category:'infra',action:'consider-retry',skipRequiredChecks:false,liveRetry:false});
 for(const x of [{attempt:2},{transient:false},{retryLimit:0}]) assert.equal(classify({...e,...x},head).action,'repair-or-investigate');
 for(const category of ['test','dependency','permission','coverage','security']) assert.equal(classify({...e,category},head).action,'repair-or-investigate');
});
test('invalid and stale evidence is unknown',()=>{
 for(const x of [null,[],Object.create(e),{...e,head:'b'.repeat(40)},{...e,complete:false},{...e,category:'bad'},{...e,attempt:0.1},{...e,attempt:-1},{...e,retryLimit:0.1},{...e,retryLimit:-1},{...e,retryLimit:3}]) assert.equal(classify(x,head).category,'unknown');
 assert.equal(classify(e,'bad').category,'unknown');
});

test('transient evidence must be boolean',()=>{
 for(const transient of [null,'true',0,undefined]) assert.deepEqual(classify({...e,transient},head),{shadow:true,category:'unknown',action:'investigate',skipRequiredChecks:false,liveRetry:false});
});

const trust = {repository: 'synthetic/project', revision: 'b'.repeat(40), head};
const first = {component: 'api', owner: 'api', specialty: 'api', root: 'src/api', interface: 'contracts/api.json',
 decision: 'decisions/api.md', tests: ['tests/shared.test.mjs', 'tests/api.test.mjs'], dependsOn: []};
const second = {...first, component: 'ui', owner: 'ui', specialty: 'ui', root: 'src/ui',
 interface: 'contracts/ui.json', tests: ['tests/ui.test.mjs', 'tests/shared.test.mjs'], dependsOn: ['api']};
const catalog = {repository: trust.repository, revision: trust.revision, components: [first, second]};
const changes = {repository: trust.repository, producer: 'trusted-ci', verified: true,
 head, base: trust.revision, paths: ['src/api/handler.mjs'], complete: true};

test('suggests only additional checks with a trusted diff and retains full validation', () => {
 assert.deepEqual(planFastFeedback(catalog, changes, trust), {shadow: true,
  reason: 'ADDITIONAL_FAST_FEEDBACK', tests: ['tests/api.test.mjs','tests/shared.test.mjs','tests/ui.test.mjs'],
  requiredValidation: 'full'});
 assert.deepEqual(planFastFeedback(catalog, {...changes, paths: ['.github/workflows/main.yml']}, trust), {
  shadow: true, reason: 'PATH_UNMAPPED', tests: [], requiredValidation: 'full'
 });
});

test('uses full validation only when exact candidate and base evidence is unavailable', () => {
 for (const proof of [null, new Proxy(changes, {get() {throw Error('must not run');}}), Object.create(changes),
  {...changes, producer: 'untrusted'}, {...changes, verified: false}, {...changes, repository: 'synthetic/other'},
  {...changes, head: trust.revision}, {...changes, base: head}, {...changes, complete: false}]) {
  assert.deepEqual(planFastFeedback(catalog, proof, trust), {
   shadow: true, reason: 'CHANGE_EVIDENCE_UNKNOWN', tests: [], requiredValidation: 'full'
  });
 }
 for (const expected of [null, {...trust, head: 'bad'}])
  assert.equal(planFastFeedback(catalog, changes, expected).reason, 'CHANGE_EVIDENCE_UNKNOWN');
 assert.equal(planFastFeedback(null, changes, trust).reason, 'MAP_STALE_OR_UNKNOWN');
});

const hash = digit => digit.repeat(64);
const build = {repository: trust.repository, head, workflow: hash('1'), dependencies: hash('2'),
 toolchain: hash('3'), inputs: hash('4')};
const receipt = {...build, producer: 'trusted-ci', verified: true};

test('only an exact verified build receipt is a reuse candidate, full validation still runs', () => {
 assert.deepEqual(planBuildReuse(build, receipt), {shadow: true, candidate: true, reason: 'EXACT_INPUTS_MATCH',
  requiredValidation: 'full'});
 for (const field of ['head', 'workflow', 'dependencies', 'toolchain', 'inputs']) {
  assert.deepEqual(planBuildReuse(build, {...receipt, [field]: 'c'.repeat(build[field].length)}), {
   shadow: true, candidate: false, reason: 'BUILD_INPUTS_CHANGED', requiredValidation: 'full'
  });
 }
});

test('blocks cache reuse on malformed, unverified, or wrong source receipts', () => {
 const blocked = {shadow: true, candidate: false, reason: 'BUILD_PROVENANCE_UNKNOWN', requiredValidation: 'full'};
 const {repository, ...withoutRepository} = build;
 for (const invalid of [null, [], new Proxy(build, {get() {throw Error('must not run');}}), withoutRepository,
  {...build, repository: false}, {...build, repository: 'wrong'}, {...build, head: 'bad'},
  {...build, workflow: 'bad'}, {...build, inputs: null}]) {
  assert.deepEqual(planBuildReuse(invalid, receipt), blocked);
 }
 for (const invalid of [null, build, withoutRepository, {...receipt, repository: 'synthetic/other'},
  {...receipt, producer: 'fork-workflow'}, {...receipt, verified: false}]) {
  assert.deepEqual(planBuildReuse(build, invalid), blocked);
 }
 assert.equal(repository, trust.repository);
});

const failureEvent = (overrides = {}) => ({
 head,
 complete: true,
 producer: 'trusted-ci',
 verified: true,
 signal: 'test-failure',
 transient: false,
 attempt: 0,
 retryLimit: 2,
 repairAttempt: 0,
 maxRepairAttempts: 2,
 ...overrides
});

test('classifyValidationFailure maps test, coverage, security, infra/runner-timeout, dependency-lock, and permission failures and rejects blind retries on deterministic failures', () => {
 for (const [signal, category, action] of [
  ['test-failure', 'test', 'repair-code-or-test'],
  ['assertion-failed', 'test', 'repair-code-or-test'],
  ['runtime-smoke-failed', 'test', 'repair-code-or-test'],
  ['coverage-below-target', 'coverage', 'add-targeted-coverage-tests'],
  ['coverage-missing', 'coverage', 'diagnose-coverage-evidence'],
  ['coverage-head-mismatch', 'coverage', 'diagnose-coverage-evidence'],
  ['npm-lock-mismatch', 'dependency-lock', 'reconcile-locked-dependencies'],
  ['nuget-restore-mismatch', 'dependency-lock', 'reconcile-locked-dependencies'],
  ['toolchain-version-drift', 'dependency-lock', 'reconcile-locked-dependencies']
 ]) {
  for (const transient of [false, true]) {
   const decision = classifyValidationFailure(failureEvent({signal, transient}), head);
   assert.deepEqual(decision, {
    shadow: true,
    category,
    signal,
    deterministic: true,
    allowRetry: false,
    blindRetryRejected: true,
    action,
    reason: 'BOUNDED_REPAIR_ELIGIBLE',
    fullValidationRequired: true,
    skipRequiredChecks: false,
    liveRetry: false
   });
  }
  const exhausted = classifyValidationFailure(
   failureEvent({signal, repairAttempt: 2, maxRepairAttempts: 2}),
   head
  );
  assert.equal(exhausted.category, category);
  assert.equal(exhausted.allowRetry, false);
  assert.equal(exhausted.blindRetryRejected, true);
  assert.equal(exhausted.action, 'escalate-repair-budget-exhausted');
  assert.equal(exhausted.reason, 'REPAIR_BUDGET_EXHAUSTED');
 }

 for (const signal of [
  'codeql-alert', 'secret-detected', 'untrusted-provenance', 'cache-poisoning', 'tls-or-certificate'
 ]) {
  const decision = classifyValidationFailure(failureEvent({signal, transient: true}), head);
  assert.equal(decision.category, 'security');
  assert.equal(decision.deterministic, true);
  assert.equal(decision.allowRetry, false);
  assert.equal(decision.blindRetryRejected, true);
  assert.equal(decision.action, 'block-and-security-remediate');
  assert.equal(decision.reason, 'SECURITY_GATE_BLOCKED');
 }

 for (const signal of [
  'http-401-unauthorized', 'http-403-forbidden', 'missing-workflow-permission', 'fork-restriction'
 ]) {
  const decision = classifyValidationFailure(failureEvent({signal, transient: true}), head);
  assert.equal(decision.category, 'permission');
  assert.equal(decision.deterministic, true);
  assert.equal(decision.allowRetry, false);
  assert.equal(decision.blindRetryRejected, true);
  assert.equal(decision.action, 'escalate-permission-review');
  assert.equal(decision.reason, 'PERMISSION_BOUNDARY_BLOCKED');
 }

 for (const signal of ['runner-timeout', 'runner-lost', 'github-api-5xx', 'network-reset']) {
  const retryable = classifyValidationFailure(
   failureEvent({signal, transient: true, attempt: 1, retryLimit: 2}),
   head
  );
  assert.deepEqual(retryable, {
   shadow: true,
   category: 'infra',
   signal,
   deterministic: false,
   allowRetry: true,
   blindRetryRejected: false,
   action: 'bounded-infra-retry',
   reason: 'TRANSIENT_INFRA_RETRY_ELIGIBLE',
   fullValidationRequired: true,
   skipRequiredChecks: false,
   liveRetry: false
  });

  const retryExhausted = classifyValidationFailure(
   failureEvent({signal, transient: true, attempt: 2, retryLimit: 2}),
   head
  );
  assert.equal(retryExhausted.category, 'infra');
  assert.equal(retryExhausted.allowRetry, false);
  assert.equal(retryExhausted.blindRetryRejected, true);
  assert.equal(retryExhausted.action, 'escalate-infra-exhausted');
  assert.equal(retryExhausted.reason, 'INFRA_RETRY_BUDGET_EXHAUSTED');

  const nonTransient = classifyValidationFailure(
   failureEvent({signal, transient: false, attempt: 0, retryLimit: 2}),
   head
  );
  assert.equal(nonTransient.category, 'infra');
  assert.equal(nonTransient.deterministic, true);
  assert.equal(nonTransient.allowRetry, false);
  assert.equal(nonTransient.blindRetryRejected, true);
  assert.equal(nonTransient.action, 'diagnose-stage-timeout');
  assert.equal(nonTransient.reason, 'DETERMINISTIC_TIMEOUT_NO_BLIND_RETRY');
 }

 const stageTimeout = classifyValidationFailure(
  failureEvent({signal: 'job-step-timeout', transient: true, repairAttempt: 0, maxRepairAttempts: 2}),
  head
 );
 assert.equal(stageTimeout.category, 'infra');
 assert.equal(stageTimeout.deterministic, true);
 assert.equal(stageTimeout.allowRetry, false);
 assert.equal(stageTimeout.blindRetryRejected, true);
 assert.equal(stageTimeout.action, 'diagnose-stage-timeout');

 const stageTimeoutExhausted = classifyValidationFailure(
  failureEvent({signal: 'job-step-timeout', transient: true, repairAttempt: 2, maxRepairAttempts: 2}),
  head
 );
 assert.equal(stageTimeoutExhausted.action, 'escalate-repair-budget-exhausted');
 assert.equal(stageTimeoutExhausted.reason, 'REPAIR_BUDGET_EXHAUSTED');
});

test('classifyValidationFailure fails closed on malformed, untrusted, or stale evidence and planFastFeedback integrates with softwareFactoryCatalog', () => {
 for (const [badFailure, badHead] of [
  [failureEvent(), 'bad-sha'],
  [null, head],
  [[], head],
  [new Proxy(failureEvent(), {}), head],
  [Object.create(failureEvent()), head],
  [failureEvent({head: 'b'.repeat(40)}), head],
  [failureEvent({complete: false}), head],
  [failureEvent({producer: 'untrusted'}), head],
  [failureEvent({verified: false}), head],
  [failureEvent({transient: 'false'}), head],
  [failureEvent({attempt: -1}), head],
  [failureEvent({attempt: 11}), head],
  [failureEvent({retryLimit: 3}), head],
  [failureEvent({repairAttempt: -1}), head],
  [failureEvent({maxRepairAttempts: 3}), head],
  [failureEvent({signal: 'unknown-signal'}), head]
 ]) {
  const denied = classifyValidationFailure(badFailure, badHead);
  assert.equal(denied.category, 'unknown');
  assert.equal(denied.allowRetry, false);
  assert.equal(denied.blindRetryRejected, true);
  assert.equal(denied.action, 'investigate-unknown-failure');
  assert.equal(denied.reason, 'EVIDENCE_INVALID_OR_STALE');
  assert.equal(denied.fullValidationRequired, true);
 }

 const sfCatalog = softwareFactoryCatalog(trust.revision);
 const sfExpected = {repository: 'Jamula/SoftwareFactory', revision: trust.revision, head};
 const sfChanges = {
  repository: 'Jamula/SoftwareFactory',
  producer: 'trusted-ci',
  verified: true,
  head,
  base: trust.revision,
  paths: ['.github/workflows/validate.yml'],
  complete: true
 };
 const fast = planFastFeedback(sfCatalog, sfChanges, sfExpected);
 assert.equal(fast.reason, 'ADDITIONAL_FAST_FEEDBACK');
 assert.equal(fast.requiredValidation, 'full');
 assert.ok(fast.tests.includes('tests/engineering-factory/locked-build-cache.test.mjs'));
});

