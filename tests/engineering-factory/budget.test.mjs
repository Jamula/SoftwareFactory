import {test} from 'node:test';
import assert from 'node:assert/strict';
import {budgetDecision,allocateShadowCapacity} from '../../tools/engineering-factory/budget.mjs';
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

const head='a'.repeat(40),candidate=(repositoryId,issue)=>({repositoryId,issue,head});
const scopes=[{repositoryId:1,maxActive:2,active:1},{repositoryId:2,maxActive:4,active:0}];
test('shadow allocation respects both global and repository caps',()=>{
 const candidates=[candidate(1,1),candidate(1,2),candidate(2,1),candidate(2,2),candidate(2,3),candidate(2,4)];
 const a=allocateShadowCapacity(e,scopes,candidates);
 assert.equal(a.reason,'SHADOW_ALLOCATION');assert.equal(a.liveDispatch,false);
 assert.deepEqual(a.selected,[candidates[0],...candidates.slice(2,5)]);
 assert.equal(allocateShadowCapacity(e,[{...scopes[0],active:2}],[candidate(1,1)]).reason,'NO_SCOPED_CAPACITY');
 assert.equal(allocateShadowCapacity(e,scopes,[]).reason,'NO_SCOPED_CAPACITY');
});
test('unknown or contradictory evidence never allocates',()=>{
 for(const budget of [null,{...e,stop:true},{...e,remaining:2},{...e,overageDisabled:false}])
  assert.equal(allocateShadowCapacity(budget,scopes,[candidate(1,1)]).selected.length,0);
 for(const bad of [null,[],new Array(1),[null],[{...scopes[0],repositoryId:0}],[{...scopes[0],maxActive:0}],[{...scopes[0],active:1.1}],[{...scopes[0],active:-1}],[{...scopes[0],active:3}],[scopes[0],scopes[0]]])
  assert.equal(allocateShadowCapacity(e,bad,[]).reason,'SCOPE_UNKNOWN');
 assert.equal(allocateShadowCapacity(e,scopes,null).reason,'SCOPE_UNKNOWN');
 for(const bad of [null,candidate(3,1),candidate(1,0),{...candidate(1,1),head:0},{...candidate(1,1),head:'bad'}])
  assert.equal(allocateShadowCapacity(e,scopes,[bad]).reason,'CANDIDATE_UNKNOWN');
 assert.equal(allocateShadowCapacity(e,scopes,[candidate(1,1),{...candidate(1,1),head:'b'.repeat(40)}]).reason,'DUPLICATE_CANDIDATE');
});
