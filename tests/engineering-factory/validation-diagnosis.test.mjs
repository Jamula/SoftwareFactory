import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnose as classify, planBuildReuse, planFastFeedback} from '../../tools/engineering-factory/validation-diagnosis.mjs';
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

