import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnose as classify} from '../../tools/engineering-factory/validation-diagnosis.mjs';
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
