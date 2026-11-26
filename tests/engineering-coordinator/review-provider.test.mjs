import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewDecision, createReviewProvider as createProvider} from '../../tools/engineering-coordinator/review-provider.mjs';
const target={repository:'example/synthetic',number:1,head:'a'.repeat(40)};
const observed=(state='needed')=>({...target,reviewState:state});
const reservation={...target,included:true,overageDisabled:true,reserved:true};
const retry={maxAttempts:2,baseDelayMs:5,maxDelayMs:20,sleep:async()=>{},classify:()=>({kind:'NETWORK_TIMEOUT'})};
const reason=(value,expected)=>assert.equal(value.reason,expected);
test('invalid candidates and scoped evidence fail closed',()=>{
 for(const c of [null,{...target,repository:undefined},{...target,repository:'x/..'},{...target,repository:'x/y/z'},{...target,number:0},{...target,number:1.5},{...target,head:1},{...target,head:'short'}])
  reason(reviewDecision(c,observed(),reservation),'INVALID_CANDIDATE');
 for(const o of [null,{...observed(),repository:'other/repo'},{...observed(),number:2},{...observed(),head:'b'.repeat(40)},observed('unknown')])
  reason(reviewDecision(target,o,reservation),'STALE_OR_UNKNOWN_EVIDENCE');
 for(const r of [null,{...reservation,head:'b'.repeat(40)},{...reservation,included:false},{...reservation,overageDisabled:false},{...reservation,reserved:false}])
  reason(reviewDecision(target,observed(),r),'CAPACITY_UNVERIFIED');
 reason(reviewDecision(target,observed('pending'),null),'REVIEW_PENDING');
 reason(reviewDecision(target,observed('reviewed'),null),'HEAD_REVIEWED');
 reason(reviewDecision(target,observed(),reservation),'SIMULATE_REQUEST');
});
const createReviewProvider=(transport,retry,intents={claim:()=>true})=>createProvider(transport,retry,intents);
const mock=(readReview,simulateRequest)=>({mode:'shadow',readReview,simulateRequest});
test('only shadow transport, no live request when invalid or no capacity',async()=>{
 const transport=mock(async()=>observed(),async()=>{assert.fail('unexpected request')});
 for(const t of [null,{...transport,mode:'live'},{...transport,readReview:null},{...transport,simulateRequest:null}])
  assert.throws(()=>createReviewProvider(t,retry),/INVALID_REVIEW_PROVIDER/);
 assert.throws(()=>createReviewProvider(transport,null),/INVALID_REVIEW_PROVIDER/);
 const p=createReviewProvider(transport,retry);
 reason(await p.request(null,reservation),'INVALID_CANDIDATE');
 reason(await p.request(target,null),'CAPACITY_UNVERIFIED');
 reason(await createReviewProvider(mock(async()=>{throw Error('offline')},transport.simulateRequest),retry).request(target,reservation),'REVIEW_READ_FAILED');
 reason(await createReviewProvider(mock(async()=>observed('pending'),transport.simulateRequest),retry).request(target,reservation),'REVIEW_PENDING');
});
test('synthetic provider responses, exact-head request and one write',async()=>{
 for(const [status,expected] of [[201,'REQUEST_SIMULATED'],[422,'PROVIDER_INELIGIBLE_OR_QUOTA'],[403,'PROVIDER_FORBIDDEN'],[429,'DEFERRED_TRANSIENT'],[503,'DEFERRED_TRANSIENT'],[500,'PROVIDER_RESPONSE_UNKNOWN'],[undefined,'PROVIDER_RESPONSE_UNKNOWN']]){
  let writes=0;
  const p=createReviewProvider(mock(async()=>observed(),async(t,k)=>{writes++;assert.deepEqual(t,target);assert.equal(k,'example/synthetic:1:'+target.head);return status===undefined?null:{status}}),retry);
  reason(await p.request(target,reservation),expected);assert.equal(writes,1);
 }
});
test('conflict re-read, timeout reconciliation, unknown write never repeated',async()=>{
 for(const [status,second,expected] of [[409,observed('pending'),'REQUEST_RECONCILED'],[409,observed('reviewed'),'REQUEST_RECONCILED'],[409,observed(),'REQUEST_OUTCOME_UNKNOWN'],[409,{...observed('pending'),head:'b'.repeat(40)},'REQUEST_OUTCOME_UNKNOWN'],[409,null,'REQUEST_OUTCOME_UNKNOWN'],[0,observed('reviewed'),'REQUEST_RECONCILED'],[0,observed(),'REQUEST_OUTCOME_UNKNOWN'],[0,null,'REQUEST_OUTCOME_UNKNOWN']]){
  let reads=0,writes=0;
  const p=createReviewProvider(mock(async()=>{if(++reads===1)return observed();if(second===null)throw Error('offline');return second;},async()=>{writes++;if(status===0)throw Error('timeout');return {status}}),retry);
  reason(await p.request(target,reservation),expected);assert.equal(writes,1);
 }
});

test('durable intent guard fails closed and prevents a repeated write',async()=>{
 const seen=new Set(); let writes=0;
 const transport=mock(async()=>observed(),async()=>{writes++;throw Error('timeout')});
 for(const guard of [null,{}, {claim:null}])assert.throws(()=>createProvider(transport,retry,guard),/INVALID_REVIEW_PROVIDER/);
 for(const guard of [{claim:()=>false},{claim:()=>{throw Error('offline')}},{claim:()=>1}])
  reason(await createProvider(transport,retry,guard).request(target,reservation),'INTENT_UNAVAILABLE_OR_CLAIMED');
 const intents={claim:key=>{if(seen.has(key))return false;seen.add(key);return true;}};
 reason(await createProvider(transport,retry,intents).request(target,reservation),'REQUEST_OUTCOME_UNKNOWN');
 reason(await createProvider(transport,retry,intents).request({...target,repository:'Example/Synthetic'},{...reservation,repository:'Example/Synthetic'}),'STALE_OR_UNKNOWN_EVIDENCE');
 reason(await createProvider(transport,retry,intents).request(target,reservation),'INTENT_UNAVAILABLE_OR_CLAIMED');
 assert.equal(writes,1);
});
