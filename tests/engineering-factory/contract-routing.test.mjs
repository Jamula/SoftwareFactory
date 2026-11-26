import test from 'node:test';
import assert from 'node:assert/strict';
import {planKnowledgeRoutes as plan, routeContract as route} from '../../tools/engineering-factory/contract-routing.mjs';
const revision='a'.repeat(40);
const c={component:'core',owner:'core-team',specialty:'security',revision};
const q={component:'core',revision,allowedSpecialties:['security']};
test('exact trusted contract routes in shadow',()=>assert.deepEqual(route([c],q),{state:'shadow-routed',owner:'core-team',specialty:'security',revision}));
test('missing or duplicate component',()=>{
  for(const catalog of [[],[c,c],[{...c,component:'other'}]]) assert.equal(route(catalog,q).reason,'OWNERSHIP_UNKNOWN');
});
test('stale and unavailable specialty',()=>{
  assert.equal(route([{...c,revision:'b'.repeat(40)}],q).reason,'STALE_CONTRACT');
  for(const s of [null,new Array(1),['bad name'],['ui']]) assert.equal(route([c],{...q,allowedSpecialties:s}).reason,'SPECIALTY_UNAVAILABLE');
});
test('reject malformed contracts',()=>{
  for(const [catalog,request] of [[null,q],[new Array(1),q],[[null],q],[[c],null],[[c],{...q,component:'!'}],[[c],{...q,revision:null}],[[{...c,component:null}],q],[[{...c,owner:null}],q],[[{...c,specialty:null}],q],[[{...c,revision:null}],q]]) assert.equal(route(catalog,request).reason,'INVALID_CONTRACT');
});

test('reject inherited and decorated array metadata',()=>{
 for(const invalid of [Object.create(c),Object.assign([],c),{...c,owner:undefined},'record']) assert.equal(route([invalid],q).reason,'INVALID_CONTRACT');
 for(const invalid of [Object.create(q),Object.assign([],q),{component:q.component,revision:q.revision},Object.assign(Object.create({allowedSpecialties:q.allowedSpecialties}),{component:q.component,revision:q.revision})]) assert.equal(route([c],invalid).reason,'INVALID_CONTRACT');
});

const expected = {repository: 'synthetic/project', revision};
const core = {
 component: 'core', owner: 'core-team', specialty: 'security', root: 'src/core',
 interface: 'contracts/core.json', decision: 'decisions/core.md', tests: ['tests/core.test.mjs'], dependsOn: []
};
const ui = {
 component: 'ui', owner: 'widget-team', specialty: 'ui', root: 'src/ui',
 interface: 'contracts/ui.json', decision: 'decisions/ui.md', tests: ['tests/ui.test.mjs'], dependsOn: ['core']
};
const catalog = {...expected, components: [ui, core]};
const change = ['src/core/module.mjs'];

test('routes changed ownership and dependent components with immutable references', () => {
 for (const file of [core.root, change[0], core.interface, core.decision, core.tests[0]]) {
  const result = plan(catalog, expected, [file]);
  assert.deepEqual(result, {
   state: 'shadow-mapped', ...expected, routes: [
    {component: core.component, owner: core.owner, specialty: core.specialty, interface: core.interface,
     decision: core.decision, tests: core.tests, dependsOn: []},
    {component: ui.component, owner: ui.owner, specialty: ui.specialty, interface: ui.interface,
     decision: ui.decision, tests: ui.tests, dependsOn: ['core']}
   ]
  });
  assert.notEqual(result.routes[0].tests, core.tests);
 }
 assert.deepEqual(plan(catalog, expected, [ui.root]).routes.map(route => route.dependsOn), [[]]);
 assert.equal(plan(catalog, expected, ['src/core-more/module.mjs']).reason, 'PATH_UNMAPPED');
});

test('blocks stale snapshots, ambiguous ownership and broken dependency graphs', () => {
 for (const trust of [null, [], {}, {repository: 1, revision}, {...expected, repository: 'x'.repeat(161)},
  {...expected, repository: 'bad'}, {...expected, revision: 'bad'}]) {
  assert.equal(plan(catalog, trust, change).reason, 'TRUST_UNKNOWN');
 }
 for (const map of [null, {...catalog, repository: 'synthetic/other'}, {...catalog, revision: 'b'.repeat(40)}]) {
  assert.equal(plan(map, expected, change).reason, 'MAP_STALE_OR_UNKNOWN');
 }
 assert.equal(plan({...catalog, components: [core, {...ui, root: core.root + '/nested'}]}, expected, change).reason,
  'OWNERSHIP_AMBIGUOUS');
 assert.equal(plan({...catalog, components: [ui, {...core, root: ui.root + '/nested'}]}, expected, change).reason,
  'OWNERSHIP_AMBIGUOUS');
 for (const dependsOn of [['missing'], ['core'], ['ui']]) {
  assert.equal(plan({...catalog, components: [ui, {...core, dependsOn}]}, expected, change).reason,
   'DEPENDENCIES_UNKNOWN');
 }
});

test('map and diff validation reject inputs outside the bounded metadata schema', () => {
 const accessor = [];
 Object.defineProperty(accessor, '0', {enumerable: true, get() {throw Error('must not run');}});
 const missingIndex = Object.assign(new Array(1), {notIndex: true});
 const mapEntries = [
  [], null, new Array(201), [core, core], new Array(1), missingIndex, accessor,
  [null], [{...core, component: 'bad id'}], [{...core, component: 'x'.repeat(65)}],
  [{...core, owner: ''}], [{...core, specialty: null}], [{...core, root: '!'}],
  [{...core, interface: null}], [{...core, decision: 'x'.repeat(241)}],
  [{...core, tests: []}], [{...core, tests: [core.tests[0], core.tests[0]]}], [{...core, tests: [null]}],
  [{...core, dependsOn: [null]}], [{...core, dependsOn: ['ui', 'ui']}],
  [new Proxy(core, {get() {throw Error('must not run');}})]
 ];
 for (const components of mapEntries) assert.equal(plan({...catalog, components}, expected, change).reason, 'MAP_INVALID');
 for (const paths of [null, [], ['.'], ['src/../core'], ['src//core'], [change[0], change[0]], accessor,
  new Proxy(change, {get() {throw Error('must not run');}})]) {
  assert.equal(plan(catalog, expected, paths).reason, 'CHANGES_UNKNOWN');
 }
});

test('rejects array prototypes and all extra own keys before invoking array behavior', () => {
 const throwingIterator = [...core.tests];
 Object.defineProperty(throwingIterator, Symbol.iterator, {get() {throw Error('must not run');}});
 const hiddenMethod = [...core.tests];
 Object.defineProperty(hiddenMethod, 'map', {get() {throw Error('must not run');}});
 const customPrototype = Object.setPrototypeOf([...core.tests], {});
 for (const tests of [throwingIterator, hiddenMethod, customPrototype]) {
  assert.equal(plan({...catalog, components: [{...core, tests}]}, expected, change).reason, 'MAP_INVALID');
 }
 const hiddenDependencyMethod = [...ui.dependsOn];
 Object.defineProperty(hiddenDependencyMethod, 'every', {get() {throw Error('must not run');}});
 assert.equal(plan({...catalog, components: [core, {...ui, dependsOn: hiddenDependencyMethod}]}, expected, change).reason,
  'MAP_INVALID');
 const decoratedComponents = [core];
 Object.defineProperty(decoratedComponents, 'map', {get() {throw Error('must not run');}});
 assert.equal(plan({...catalog, components: decoratedComponents}, expected, change).reason, 'MAP_INVALID');
 const symbolPath = [change[0]];
 Object.defineProperty(symbolPath, Symbol('extra'), {value: true});
 assert.equal(plan(catalog, expected, symbolPath).reason, 'CHANGES_UNKNOWN');
 const hiddenPath = [change[0]];
 Object.defineProperty(hiddenPath, 'extra', {value: true});
 assert.equal(plan(catalog, expected, hiddenPath).reason, 'CHANGES_UNKNOWN');
 const customPaths = Object.setPrototypeOf([change[0]], {});
 assert.equal(plan(catalog, expected, customPaths).reason, 'CHANGES_UNKNOWN');
});

