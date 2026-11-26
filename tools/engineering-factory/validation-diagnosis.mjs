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

