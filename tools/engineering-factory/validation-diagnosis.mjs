const sha=s=>typeof s==='string'&&/^[a-f0-9]{40}$/.test(s);
const categories=new Set(['test','infra','dependency','permission','coverage','security']);
const own=(v,k)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&k.every(x=>Object.hasOwn(v,x));
const result=(category,action)=>({shadow:true,category,action,skipRequiredChecks:false,liveRetry:false});
export function diagnose(e,head) {
 if(!sha(head)||!own(e,['head','complete','category','attempt','retryLimit','transient'])||e.head!==head||e.complete!==true||typeof e.transient!=='boolean'||!categories.has(e.category)||!Number.isSafeInteger(e.attempt)||e.attempt<0||!Number.isSafeInteger(e.retryLimit)||e.retryLimit<0||e.retryLimit>2) return result('unknown','investigate');
 if(e.category==='infra'&&e.transient===true&&e.attempt<e.retryLimit) return result('infra','consider-retry');
 return result(e.category,'repair-or-investigate');
}
import {types} from 'node:util';
import {planKnowledgeRoutes} from './contract-routing.mjs';


const ownData = (value, keys) => value !== null && typeof value === 'object' &&
  !types.isProxy(value) && !Array.isArray(value) &&
  keys.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
const feedback = (reason, tests = []) => ({shadow: true, reason, tests, requiredValidation: 'full'});

export function planFastFeedback(catalog, evidence, expected) {
  if (!ownData(expected, ['repository', 'head', 'revision']) || !sha(expected.head) ||
      !ownData(evidence, ['repository', 'producer', 'verified', 'head', 'base', 'paths', 'complete']) ||
      evidence.repository !== expected.repository || evidence.producer !== 'trusted-ci' ||
      evidence.verified !== true || evidence.complete !== true ||
      evidence.head !== expected.head || evidence.base !== expected.revision)
    return feedback('CHANGE_EVIDENCE_UNKNOWN');
  const mapped = planKnowledgeRoutes(catalog, expected, evidence.paths);
  if (mapped.state !== 'shadow-mapped') return feedback(mapped.reason);
  return feedback('ADDITIONAL_FAST_FEEDBACK', [...new Set(mapped.routes.flatMap(route => route.tests))].sort());
}

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const buildFields = ['head', 'workflow', 'dependencies', 'toolchain', 'inputs'];
const fingerprint = value => ownData(value, buildFields) && sha(value.head) &&
  buildFields.slice(1).every(field => digest(value[field]));
const reuse = (candidate, reason) => ({shadow: true, candidate, reason, requiredValidation: 'full'});

export function planBuildReuse(build, receipt) {
  if (!fingerprint(build) || !fingerprint(receipt) ||
      !ownData(build, ['repository']) || !ownData(receipt, ['repository', 'producer', 'verified']) ||
      typeof build.repository !== 'string' || !/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(build.repository) ||
      receipt.repository !== build.repository || receipt.producer !== 'trusted-ci' || receipt.verified !== true)
    return reuse(false, 'BUILD_PROVENANCE_UNKNOWN');
  if (!buildFields.every(field => build[field] === receipt[field])) return reuse(false, 'BUILD_INPUTS_CHANGED');
  return reuse(true, 'EXACT_INPUTS_MATCH');
}

const boundedInt = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const FAILURE_FIELDS = [
  'head', 'complete', 'producer', 'verified', 'signal',
  'transient', 'attempt', 'retryLimit', 'repairAttempt', 'maxRepairAttempts'
];
const SIGNAL_RULES = new Map([
  ['test-failure', {category: 'test', repairAction: 'repair-code-or-test'}],
  ['assertion-failed', {category: 'test', repairAction: 'repair-code-or-test'}],
  ['runtime-smoke-failed', {category: 'test', repairAction: 'repair-code-or-test'}],
  ['coverage-below-target', {category: 'coverage', repairAction: 'add-targeted-coverage-tests'}],
  ['coverage-missing', {category: 'coverage', repairAction: 'diagnose-coverage-evidence'}],
  ['coverage-head-mismatch', {category: 'coverage', repairAction: 'diagnose-coverage-evidence'}],
  ['codeql-alert', {category: 'security', terminalAction: 'block-and-security-remediate', reason: 'SECURITY_GATE_BLOCKED'}],
  ['secret-detected', {category: 'security', terminalAction: 'block-and-security-remediate', reason: 'SECURITY_GATE_BLOCKED'}],
  ['untrusted-provenance', {category: 'security', terminalAction: 'block-and-security-remediate', reason: 'SECURITY_GATE_BLOCKED'}],
  ['cache-poisoning', {category: 'security', terminalAction: 'block-and-security-remediate', reason: 'SECURITY_GATE_BLOCKED'}],
  ['tls-or-certificate', {category: 'security', terminalAction: 'block-and-security-remediate', reason: 'SECURITY_GATE_BLOCKED'}],
  ['runner-timeout', {category: 'infra', subkind: 'runner-timeout', transientAllowed: true}],
  ['runner-lost', {category: 'infra', subkind: 'runner-infra', transientAllowed: true}],
  ['github-api-5xx', {category: 'infra', subkind: 'runner-infra', transientAllowed: true}],
  ['network-reset', {category: 'infra', subkind: 'runner-infra', transientAllowed: true}],
  ['job-step-timeout', {category: 'infra', subkind: 'stage-timeout', transientAllowed: false}],
  ['npm-lock-mismatch', {category: 'dependency-lock', repairAction: 'reconcile-locked-dependencies'}],
  ['nuget-restore-mismatch', {category: 'dependency-lock', repairAction: 'reconcile-locked-dependencies'}],
  ['toolchain-version-drift', {category: 'dependency-lock', repairAction: 'reconcile-locked-dependencies'}],
  ['http-401-unauthorized', {category: 'permission', terminalAction: 'escalate-permission-review', reason: 'PERMISSION_BOUNDARY_BLOCKED'}],
  ['http-403-forbidden', {category: 'permission', terminalAction: 'escalate-permission-review', reason: 'PERMISSION_BOUNDARY_BLOCKED'}],
  ['missing-workflow-permission', {category: 'permission', terminalAction: 'escalate-permission-review', reason: 'PERMISSION_BOUNDARY_BLOCKED'}],
  ['fork-restriction', {category: 'permission', terminalAction: 'escalate-permission-review', reason: 'PERMISSION_BOUNDARY_BLOCKED'}]
]);

const repairDecision = (category, signal, deterministic, allowRetry, action, reason) => ({
  shadow: true,
  category,
  signal,
  deterministic,
  allowRetry,
  blindRetryRejected: !allowRetry,
  action,
  reason,
  fullValidationRequired: true,
  skipRequiredChecks: false,
  liveRetry: false
});

export function classifyValidationFailure(failure, expectedHead) {
  if (!sha(expectedHead) || !ownData(failure, FAILURE_FIELDS) ||
      failure.head !== expectedHead || failure.complete !== true ||
      failure.producer !== 'trusted-ci' || failure.verified !== true ||
      typeof failure.transient !== 'boolean' ||
      !boundedInt(failure.attempt, 10) || !boundedInt(failure.retryLimit, 2) ||
      !boundedInt(failure.repairAttempt, 10) || !boundedInt(failure.maxRepairAttempts, 2) ||
      !SIGNAL_RULES.has(failure.signal))
    return repairDecision('unknown', 'unknown', true, false, 'investigate-unknown-failure', 'EVIDENCE_INVALID_OR_STALE');
  const rule = SIGNAL_RULES.get(failure.signal);
  if (rule.category === 'infra') {
    if (rule.transientAllowed && failure.transient) {
      if (failure.attempt < failure.retryLimit)
        return repairDecision('infra', failure.signal, false, true, 'bounded-infra-retry', 'TRANSIENT_INFRA_RETRY_ELIGIBLE');
      return repairDecision('infra', failure.signal, false, false, 'escalate-infra-exhausted', 'INFRA_RETRY_BUDGET_EXHAUSTED');
    }
    if (failure.repairAttempt < failure.maxRepairAttempts)
      return repairDecision('infra', failure.signal, true, false, 'diagnose-stage-timeout', 'DETERMINISTIC_TIMEOUT_NO_BLIND_RETRY');
    return repairDecision('infra', failure.signal, true, false, 'escalate-repair-budget-exhausted', 'REPAIR_BUDGET_EXHAUSTED');
  }
  if (rule.terminalAction)
    return repairDecision(rule.category, failure.signal, true, false, rule.terminalAction, rule.reason);
  if (failure.repairAttempt < failure.maxRepairAttempts)
    return repairDecision(rule.category, failure.signal, true, false, rule.repairAction, 'BOUNDED_REPAIR_ELIGIBLE');
  return repairDecision(rule.category, failure.signal, true, false, 'escalate-repair-budget-exhausted', 'REPAIR_BUDGET_EXHAUSTED');
}

