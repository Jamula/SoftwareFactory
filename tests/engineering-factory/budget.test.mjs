import {test} from 'node:test';
import assert from 'node:assert/strict';
import {budgetDecision} from '../../tools/engineering-factory/budget.mjs';
const e={stop:false,includedOnly:true,overageDisabled:true,authorityVerified:true,nowMs:100000,observedMs:99999,remaining:10,reserved:2,active:1,maxActive:5,unitsPerRun:2};
test('budget advisory cannot dispatch',()=>{
 assert.deepEqual(budgetDecision(e),{shadow:true,liveDispatch:false,reason:'SHADOW_CAPACITY',available:4});
 assert.equal(budgetDecision({...e,remaining:2}).reason,'CAPACITY_EXHAUSTED');
 assert.equal(budgetDecision({...e,active:5}).available,0);
});
test('fail closed on absent and invalid evidence',()=>{
 for(const [change,reason] of [[{stop:true},'STOPPED'],[{includedOnly:false},'BUDGET_UNKNOWN'],[{overageDisabled:false},'BUDGET_UNKNOWN'],[{authorityVerified:false},'BUDGET_UNKNOWN'],[{nowMs:null},'STALE_QUOTA'],[{observedMs:null},'STALE_QUOTA'],[{observedMs:-1},'STALE_QUOTA'],[{observedMs:100001},'STALE_QUOTA'],[{observedMs:1},'STALE_QUOTA'],[{remaining:-1},'INVALID_QUOTA'],[{unitsPerRun:0},'INVALID_QUOTA'],[{maxActive:0},'INVALID_QUOTA'],[{active:6},'INVALID_QUOTA'],[{reserved:11},'INVALID_QUOTA']]) {
  const r=budgetDecision({...e,...change});assert.equal(r.reason,reason);assert.equal(r.available,0);assert.equal(r.liveDispatch,false);
 }
 assert.equal(budgetDecision(null).reason,'STOPPED');
});
