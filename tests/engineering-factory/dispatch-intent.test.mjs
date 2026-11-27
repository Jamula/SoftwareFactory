import test from 'node:test';
import assert from 'node:assert/strict';
import {dispatchIntent as plan, hostedWorkerDispatchIntent} from '../../tools/engineering-factory/dispatch-intent.mjs';

const e={repositoryId:1,approvedRepositoryId:1,issue:2,head:'a'.repeat(40),generation:3,approved:true,stop:false,includedOnly:true,overageDisabled:true,capacity:4,leaseVerified:true,alreadyDispatched:false};
const receipt={receiptId:'hsr-7-001',provider:'github-hosted-copilot',includedOnly:true,overageDisabled:true,hardStopEnforced:true,paidUsageMicros:0,observedMs:5000};
const hosted={...e,environmentVerified:true,protectedEnvironment:'factory-copilot-pilot',isolatedWorktree:true,hardStopReceipt:receipt,nowMs:5500,executionTtlMs:300000,requestedWorkers:4};

test('dry run only, deterministic idempotency',()=>{
 assert.deepEqual(plan(e),{shadow:true,liveDispatch:false,reason:'DRY_RUN_ONLY',key:'1:2:'+e.head+':3',repositoryId:1,issue:2});
 assert.deepEqual(plan({...e,environmentVerified:true,hardStopReceipt:receipt,nowMs:5500,executionTtlMs:3600000}),{shadow:true,liveDispatch:false,reason:'DRY_RUN_ONLY',key:'1:2:'+e.head+':3',repositoryId:1,issue:2});
 assert.deepEqual(plan({...e,hardStopReceipt:receipt},5500),{shadow:true,liveDispatch:false,reason:'DRY_RUN_ONLY',key:'1:2:'+e.head+':3',repositoryId:1,issue:2});
 assert.equal(plan({...e,hardStopReceipt:receipt,nowMs:5500},5500).reason,'DRY_RUN_ONLY');
});

test('deny unknown permission quota, clock mismatch, and duplicate',()=>{
 for(const x of [null,[],new Proxy(e,{}),Object.create(e)])assert.equal(plan(x).reason,'EVIDENCE_UNKNOWN');
 assert.equal(plan(e,-1).reason,'EVIDENCE_UNKNOWN');
 assert.equal(plan({...e,hardStopReceipt:receipt,nowMs:5000},70000).reason,'STALE_HARD_STOP_RECEIPT');
 assert.equal(plan({...e,hardStopReceipt:receipt},70000).reason,'STALE_HARD_STOP_RECEIPT');
 for(const x of [{stop:true},{repositoryId:0},{approvedRepositoryId:2},{issue:0},{head:'bad'},{generation:0},{approved:false},{leaseVerified:false},{environmentVerified:false},{includedOnly:false},{overageDisabled:false},{capacity:0},{hardStopReceipt:null,nowMs:5500},{hardStopReceipt:{...receipt,overageDisabled:false},nowMs:5500},{executionTtlMs:0},{executionTtlMs:3600001},{alreadyDispatched:true},{alreadyDispatched:null}])assert.notEqual(plan({...e,...x}).reason,'DRY_RUN_ONLY');
});

test('own and inherited accessors for required and optional fields are denied without a read',()=>{
 let calls=0;
 for(const field of [...Object.keys(e),'environmentVerified','hardStopReceipt','nowMs','executionTtlMs']){
  const x={...e};
  Object.defineProperty(x,field,{get(){calls++;throw Error('unexpected getter');}});
  assert.equal(plan(x).reason,'EVIDENCE_UNKNOWN',field);
 }
 // Inherited nowMs accessor on prototype must never execute when hardStopReceipt is an own property.
 const proto={};
 Object.defineProperty(proto,'nowMs',{get(){calls++;throw Error('unexpected inherited nowMs getter');}});
 const inheritedClock=Object.assign(Object.create(proto),{...e,hardStopReceipt:receipt});
 assert.equal(plan(inheritedClock).reason,'STALE_HARD_STOP_RECEIPT');
 assert.equal(calls,0);
});

test('hosted worker dispatch intent enforces environment, hard-stop receipt, authoritative clock, worker ladder, and bounded TTL',()=>{
 for(const tier of [1,2,4,8,10,12]){
  const res=hostedWorkerDispatchIntent({...hosted,capacity:12,requestedWorkers:tier});
  assert.deepEqual(res,{shadow:true,liveDispatch:false,reason:'DRY_RUN_ONLY',key:'1:2:'+e.head+':3',repositoryId:1,issue:2,protectedEnvironment:'factory-copilot-pilot',requestedWorkers:tier,executionTtlMs:300000,receiptId:'hsr-7-001'});
 }
 assert.equal(hostedWorkerDispatchIntent(hosted,5500).reason,'DRY_RUN_ONLY');
 assert.equal(hostedWorkerDispatchIntent(hosted,-1).reason,'EVIDENCE_UNKNOWN');
 assert.equal(hostedWorkerDispatchIntent(hosted,70000).reason,'STALE_HARD_STOP_RECEIPT');
 const proxyHosted = new Proxy(hosted, {});
 for(const [change,reason] of [
  [null,'EVIDENCE_UNKNOWN'],
  [proxyHosted,'EVIDENCE_UNKNOWN'],
  [{stop:true},'STOPPED'],
  [{repositoryId:0},'SCOPE_OR_LEASE_UNKNOWN'],
  [{approvedRepositoryId:9},'SCOPE_OR_LEASE_UNKNOWN'],
  [{issue:0},'SCOPE_OR_LEASE_UNKNOWN'],
  [{head:'invalid'},'SCOPE_OR_LEASE_UNKNOWN'],
  [{generation:0},'SCOPE_OR_LEASE_UNKNOWN'],
  [{approved:false},'SCOPE_OR_LEASE_UNKNOWN'],
  [{leaseVerified:false},'SCOPE_OR_LEASE_UNKNOWN'],
  [{environmentVerified:false},'ENVIRONMENT_UNVERIFIED'],
  [{protectedEnvironment:'BAD ENV'},'ENVIRONMENT_UNVERIFIED'],
  [{protectedEnvironment:'a'},'ENVIRONMENT_UNVERIFIED'],
  [{isolatedWorktree:false},'ENVIRONMENT_UNVERIFIED'],
  [{overageDisabled:false},'OVERAGE_ENABLED'],
  [{includedOnly:false},'BUDGET_OR_CAPACITY_UNKNOWN'],
  [{overageDisabled:null},'BUDGET_OR_CAPACITY_UNKNOWN'],
  [{capacity:0},'BUDGET_OR_CAPACITY_UNKNOWN'],
  [{hardStopReceipt:{...receipt,overageDisabled:false}},'OVERAGE_ENABLED'],
  [{hardStopReceipt:{...receipt,hardStopEnforced:false}},'HARD_STOP_UNVERIFIED'],
  [{hardStopReceipt:{...receipt,paidUsageMicros:10}},'PAID_USAGE_NONZERO'],
  [{nowMs:70000},'STALE_HARD_STOP_RECEIPT'],
  [{requestedWorkers:3},'WORKER_LADDER_VIOLATION'],
  [{requestedWorkers:6},'WORKER_LADDER_VIOLATION'],
  [{requestedWorkers:16,capacity:16},'WORKER_LADDER_VIOLATION'],
  [{requestedWorkers:8,capacity:4},'WORKER_LADDER_VIOLATION'],
  [{executionTtlMs:0},'EXECUTION_TTL_INVALID'],
  [{executionTtlMs:3600001},'EXECUTION_TTL_INVALID'],
  [{alreadyDispatched:true},'DUPLICATE_OR_UNKNOWN']
 ]){
  const input = (change === null || change === proxyHosted) ? change : {...hosted, ...change};
  const out = hostedWorkerDispatchIntent(input);
  assert.equal(out.liveDispatch,false);
  assert.equal(out.reason,reason);
 }
});
