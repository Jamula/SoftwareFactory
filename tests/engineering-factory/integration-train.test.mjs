import test from 'node:test';
import assert from 'node:assert/strict';
import {nextIntegration as next} from '../../tools/engineering-factory/integration-train.mjs';
const main='a'.repeat(40),head='b'.repeat(40);
const c={pr:1,head,observedHead:head,base:main,checks:true,approval:true,threads:true,authority:true};
const s={stop:false,main,mainHealthy:true,active:false,candidates:[c]};
test('only next eligible exact candidate, never live merge',()=>{
 assert.deepEqual(next(s),{shadow:true,liveMerge:false,reason:'SHADOW_NEXT',pr:1,expectedHead:head,expectedBase:main,method:'squash'});
 assert.equal(next({...s,candidates:[{...c,checks:false},{...c,pr:2}]}).pr,2);
 for(const change of [{observedHead:main},{base:head},{checks:false},{approval:false},{threads:false},{authority:false}]) assert.equal(next({...s,candidates:[{...c,...change}]}).reason,'NO_ELIGIBLE_CANDIDATE');
 assert.equal(next({...s,candidates:[]}).reason,'NO_ELIGIBLE_CANDIDATE');
});
test('stop, unhealthy main, active train and malformed candidates',()=>{
 for(const x of [null,Object.create(s),{...s,stop:true}]) assert.equal(next(x).reason,'STOPPED');
 for(const x of [{main:'bad'},{mainHealthy:false},{active:true}]) assert.equal(next({...s,...x}).reason,'MAIN_OR_TRAIN_UNREADY');
 for(const candidates of [null,new Array(1),[null],[Object.create(c)],[{...c,pr:0}],[{...c,head:'bad'}],[{...c,observedHead:'bad'}],[{...c,base:'bad'}],[c,c]]) assert.equal(next({...s,candidates}).reason,'INVALID_CANDIDATES');
});
