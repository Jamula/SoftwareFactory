import {test} from 'node:test';
import assert from 'node:assert/strict';
import {budgetDecision,allocateShadowCapacity,verifyHardStopReceipt} from '../../tools/engineering-factory/budget.mjs';
const e={stop:false,includedOnly:true,overageDisabled:true,authorityVerified:true,nowMs:100000,observedMs:99999,remaining:10,reserved:2,active:1,maxActive:5,unitsPerRun:2};
const receipt={receiptId:'hsr-2026-11-26-001',provider:'github-hosted-copilot',includedOnly:true,overageDisabled:true,hardStopEnforced:true,paidUsageMicros:0,observedMs:99999};
test('budget advisory cannot dispatch',()=>{
 assert.deepEqual(budgetDecision(e),{shadow:true,liveDispatch:false,reason:'SHADOW_CAPACITY',available:4});
 assert.equal(budgetDecision({...e,remaining:2}).reason,'CAPACITY_EXHAUSTED');
 assert.equal(budgetDecision({...e,active:5}).available,0);
 assert.equal(budgetDecision({...e,environmentVerified:true,hardStopReceipt:receipt}).available,4);
});
test('fail closed on absent and invalid evidence',()=>{
 for(const [change,reason] of [[{stop:true},'STOPPED'],[{environmentVerified:false},'ENVIRONMENT_UNVERIFIED'],[{includedOnly:false},'BUDGET_UNKNOWN'],[{overageDisabled:false},'BUDGET_UNKNOWN'],[{authorityVerified:false},'BUDGET_UNKNOWN'],[{nowMs:null},'STALE_QUOTA'],[{observedMs:null},'STALE_QUOTA'],[{observedMs:-1},'STALE_QUOTA'],[{observedMs:100001},'STALE_QUOTA'],[{observedMs:1},'STALE_QUOTA'],[{hardStopReceipt:null},'HARD_STOP_UNVERIFIED'],[{hardStopReceipt:{...receipt,overageDisabled:false}},'OVERAGE_ENABLED'],[{hardStopReceipt:{...receipt,paidUsageMicros:1}},'PAID_USAGE_NONZERO'],[{hardStopReceipt:{...receipt,observedMs:1}},'STALE_HARD_STOP_RECEIPT'],[{remaining:-1},'INVALID_QUOTA'],[{unitsPerRun:0},'INVALID_QUOTA'],[{maxActive:0},'INVALID_QUOTA'],[{active:6},'INVALID_QUOTA'],[{reserved:11},'INVALID_QUOTA']]) {
  const r=budgetDecision({...e,...change});assert.equal(r.reason,reason);assert.equal(r.available,0);assert.equal(r.liveDispatch,false);
 }
 assert.equal(budgetDecision(null).reason,'STOPPED');
 assert.equal(budgetDecision([]).reason,'STOPPED');
 assert.equal(budgetDecision(new Proxy(e,{})).reason,'STOPPED');
 let getterCalls=0;
 const withGetter={...e};
 Object.defineProperty(withGetter,'stop',{get(){getterCalls++;return false;}});
 assert.equal(budgetDecision(withGetter).reason,'STOPPED');
 assert.equal(getterCalls,0);
});

test('verifies enforceable zero-overage hard-stop receipts',()=>{
 const ok=verifyHardStopReceipt(receipt,100000);
 assert.deepEqual(ok,{shadow:true,liveDispatch:false,valid:true,reason:'HARD_STOP_VERIFIED',receiptId:receipt.receiptId});
 assert.equal(Object.isFrozen(ok),true);
 assert.equal(verifyHardStopReceipt({...receipt,observedMs:40000},100000).valid,true);
 for(const [bad,nowMs,reason] of [
  [null,100000,'HARD_STOP_UNVERIFIED'],
  [{},100000,'HARD_STOP_UNVERIFIED'],
  [[],100000,'HARD_STOP_UNVERIFIED'],
  [new Proxy(receipt,{}),100000,'HARD_STOP_UNVERIFIED'],
  [{...receipt,receiptId:''},100000,'HARD_STOP_UNVERIFIED'],
  [{...receipt,receiptId:'bad space'},100000,'HARD_STOP_UNVERIFIED'],
  [{...receipt,provider:'UPPER'},100000,'HARD_STOP_UNVERIFIED'],
  [{...receipt,provider:123},100000,'HARD_STOP_UNVERIFIED'],
  [{...receipt,overageDisabled:false},100000,'OVERAGE_ENABLED'],
  [{...receipt,overageDisabled:null},100000,'OVERAGE_ENABLED'],
  [{...receipt,includedOnly:false},100000,'HARD_STOP_UNVERIFIED'],
  [{...receipt,hardStopEnforced:false},100000,'HARD_STOP_UNVERIFIED'],
  [{...receipt,paidUsageMicros:5},100000,'PAID_USAGE_NONZERO'],
  [{...receipt,paidUsageMicros:null},100000,'PAID_USAGE_NONZERO'],
  [{...receipt,observedMs:-1},100000,'STALE_HARD_STOP_RECEIPT'],
  [{...receipt,observedMs:100001},100000,'STALE_HARD_STOP_RECEIPT'],
  [{...receipt,observedMs:39999},100000,'STALE_HARD_STOP_RECEIPT'],
  [receipt,null,'STALE_HARD_STOP_RECEIPT']
 ]){
  const res=verifyHardStopReceipt(bad,nowMs);
  assert.equal(res.valid,false);
  assert.equal(res.liveDispatch,false);
  assert.equal(res.reason,reason);
 }
 let calls=0;
 const getterReceipt={...receipt};
 Object.defineProperty(getterReceipt,'paidUsageMicros',{get(){calls++;return 0;}});
 assert.equal(verifyHardStopReceipt(getterReceipt,100000).reason,'HARD_STOP_UNVERIFIED');
 assert.equal(calls,0);
});

const head='a'.repeat(40),candidate=(repositoryId,issue)=>({repositoryId,issue,head});
const scopes=[{repositoryId:1,maxActive:2,active:1},{repositoryId:2,maxActive:4,active:0}];
test('shadow allocation respects both global and repository caps',()=>{
 const candidates=[candidate(1,1),candidate(1,2),candidate(2,1),candidate(2,2),candidate(2,3),candidate(2,4)];
 const a=allocateShadowCapacity(e,scopes,candidates);
 assert.equal(a.reason,'SHADOW_ALLOCATION');assert.equal(a.liveDispatch,false);
 assert.deepEqual(a.selected,[candidates[0],...candidates.slice(2,5)]);
 assert.equal(allocateShadowCapacity({...e,active:2},[{...scopes[0],active:2}],[candidate(1,1)]).reason,'NO_SCOPED_CAPACITY');
 assert.equal(allocateShadowCapacity(e,scopes,[]).reason,'NO_SCOPED_CAPACITY');
});
test('unknown or contradictory evidence never allocates',()=>{
 for(const budget of [null,{...e,stop:true},{...e,remaining:2},{...e,overageDisabled:false}])
  assert.equal(allocateShadowCapacity(budget,scopes,[candidate(1,1)]).selected.length,0);
 for(const bad of [null,[],new Array(1),new Proxy(scopes,{}),[null],[new Proxy(scopes[0],{})],[{...scopes[0],repositoryId:0}],[{...scopes[0],maxActive:0}],[{...scopes[0],active:1.1}],[{...scopes[0],active:-1}],[{...scopes[0],active:3}],[scopes[0],scopes[0]]])
  assert.equal(allocateShadowCapacity(e,bad,[]).reason,'SCOPE_UNKNOWN');
 assert.equal(allocateShadowCapacity(e,scopes,null).reason,'SCOPE_UNKNOWN');
 for(const bad of [null,new Proxy(candidate(1,1),{}),candidate(3,1),candidate(1,0),{...candidate(1,1),head:0},{...candidate(1,1),head:'bad'}])
  assert.equal(allocateShadowCapacity(e,scopes,[bad]).reason,'CANDIDATE_UNKNOWN');
 assert.equal(allocateShadowCapacity(e,scopes,[candidate(1,1),{...candidate(1,1),head:'b'.repeat(40)}]).reason,'DUPLICATE_CANDIDATE');
});


test('reject scoped active counts exceeding global activity; allow partial scopes',()=>{
 const candidates=[candidate(1,1),candidate(2,1)];
 const inconsistent=[scopes[0],{...scopes[1],active:1}];
 assert.deepEqual(allocateShadowCapacity(e,inconsistent,candidates),{shadow:true,liveDispatch:false,reason:'SCOPE_UNKNOWN',selected:[]});
 assert.equal(allocateShadowCapacity(e,[{...scopes[0],active:2}],[candidate(1,1)]).reason,'SCOPE_UNKNOWN');
 assert.deepEqual(allocateShadowCapacity({...e,active:2},scopes,candidates).selected,candidates);
 assert.deepEqual(allocateShadowCapacity({...e,active:2},inconsistent,candidates).selected,candidates);
 const max=Number.MAX_SAFE_INTEGER;
 assert.equal(allocateShadowCapacity({...e,maxActive:max,active:max-1},[{repositoryId:1,maxActive:max,active:max-1},{repositoryId:2,maxActive:max,active:1}],candidates).reason,'SCOPE_UNKNOWN');
});
