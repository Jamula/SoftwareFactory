import test from 'node:test';
import assert from 'node:assert/strict';
import {routeContract as route} from '../../tools/engineering-factory/contract-routing.mjs';
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
