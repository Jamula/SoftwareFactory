import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileQueueSnapshot} from '../../tools/engineering-factory/queue-reread.mjs';

const repository='Jamula/SoftwareFactory',repositoryId=1471342715;
const head='a'.repeat(40),base='b'.repeat(40),number=42;
const intent={repositoryId,repository,branch:'main',number,expectedHead:head,expectedBase:base};
const pull={repositoryId,repository,number,baseBranch:'main',base,head,state:'OPEN',draft:false,
 mergeQueueEntryId:'PRME_entry_42'};
const entry={repositoryId,repository,branch:'main',id:'PRME_entry_42',pullRequestNumber:number,
 head,base,state:'QUEUED',position:2,jump:false};
const snapshot=(p=pull,e=entry,extra={})=>({repositoryId,repository,branch:'main',stop:false,pull:p,entry:e,...extra});

test('records a queue reread only when the exact PR, head, base, and entry are bound',()=>{
 const result=reconcileQueueSnapshot(intent,snapshot());
 assert.deepEqual(result,{shadow:true,evidenceComplete:false,queueObserved:true,mergeEligible:false,
  liveQueueWrite:false,liveMerge:false,dependentWorkAllowed:false,reason:'QUEUE_ENTRY_OBSERVED',
  repository,repositoryId,branch:'main',number,head,base,queueEntryId:entry.id,queueState:'QUEUED',position:2});
});

test('does not turn queue observation into merge eligibility or dependent-work permission',()=>{
 for(const state of ['AWAITING_CHECKS','LOCKED','MERGEABLE','QUEUED']){
  const result=reconcileQueueSnapshot(intent,snapshot(pull,{...entry,state}));
  assert.equal(result.queueState,state);
  assert.equal(result.mergeEligible,false);
  assert.equal(result.liveMerge,false);
  assert.equal(result.dependentWorkAllowed,false);
 }
 assert.equal(reconcileQueueSnapshot(intent,snapshot(pull,{...entry,state:'UNMERGEABLE'})).reason,
  'QUEUE_ENTRY_UNMERGEABLE');
});

test('fails closed for invalid intents, prototypes, accessors, and proxies',()=>{
 for(const bad of [null,{}, {...intent,repositoryId:0},{...intent,repositoryId:1},
  {...intent,repository:'other/repo'},{...intent,branch:'feature'},{...intent,number:0},
  {...intent,expectedHead:'bad'},{...intent,expectedBase:'bad'},
  {...intent,expectedBase:head}])
  assert.equal(reconcileQueueSnapshot(bad,snapshot()).reason,'QUEUE_INTENT_UNKNOWN');
 const accessor={...intent};
 Object.defineProperty(accessor,'number',{get(){throw Error('must not evaluate accessor');},enumerable:true});
 assert.equal(reconcileQueueSnapshot(accessor,snapshot()).reason,'QUEUE_INTENT_UNKNOWN');
 assert.equal(reconcileQueueSnapshot(new Proxy(intent,{}),snapshot()).reason,'QUEUE_INTENT_UNKNOWN');
});

test('rejects malformed, missing, or stopped rereads',()=>{
 assert.equal(reconcileQueueSnapshot(intent,null).reason,'QUEUE_REREAD_UNKNOWN');
 assert.equal(reconcileQueueSnapshot(intent,snapshot(null,entry)).reason,'QUEUE_REREAD_UNKNOWN');
 assert.equal(reconcileQueueSnapshot(intent,snapshot(pull,null)).reason,'QUEUE_REREAD_UNKNOWN');
 assert.equal(reconcileQueueSnapshot(intent,snapshot(pull,entry,{other:true})).reason,'QUEUE_REREAD_UNKNOWN');
 assert.equal(reconcileQueueSnapshot(intent,{...snapshot(),stop:true}).reason,'STOPPED');
 assert.equal(reconcileQueueSnapshot(intent,{...snapshot(),repository:'fork/repo'}).reason,'QUEUE_SCOPE_MISMATCH');
 assert.equal(reconcileQueueSnapshot(intent,{...snapshot(),repositoryId:0}).reason,'QUEUE_SCOPE_MISMATCH');
 assert.equal(reconcileQueueSnapshot(intent,{...snapshot(),branch:'feature'}).reason,'QUEUE_SCOPE_MISMATCH');
});

test('rejects closed, draft, non-main, or wrong-number PR rereads',()=>{
 for(const p of [{...pull,state:'CLOSED'},{...pull,draft:true},{...pull,baseBranch:'release'},
  {...pull,number:number+1}])
  assert.equal(reconcileQueueSnapshot(intent,snapshot(p)).reason,'PULL_NOT_READY');
});

test('rejects contradictory or malformed pull repository names',()=>{
 for(const repositoryName of ['other/repo',null,undefined])
  assert.equal(reconcileQueueSnapshot(intent,snapshot({...pull,repository:repositoryName})).reason,
   'PULL_NOT_READY');
 const missingRepository={...pull};
 delete missingRepository.repository;
 assert.equal(reconcileQueueSnapshot(intent,snapshot(missingRepository)).reason,'QUEUE_REREAD_UNKNOWN');
});

test('invalidates snapshots when either the PR head or base moves',()=>{
 assert.equal(reconcileQueueSnapshot(intent,snapshot({...pull,head:'c'.repeat(40)})).reason,'HEAD_CHANGED');
 assert.equal(reconcileQueueSnapshot(intent,snapshot({...pull,base:'d'.repeat(40)})).reason,'BASE_CHANGED');
});

test('rejects wrong queue identity, PR binding, and entry head/base',()=>{
 assert.equal(reconcileQueueSnapshot(intent,snapshot({...pull,mergeQueueEntryId:'PRME_other'})).reason,
  'QUEUE_ENTRY_IDENTITY_MISMATCH');
 assert.equal(reconcileQueueSnapshot(intent,snapshot(pull,{...entry,id:'PRME_other'})).reason,
  'QUEUE_ENTRY_IDENTITY_MISMATCH');
 assert.equal(reconcileQueueSnapshot(intent,snapshot(pull,{...entry,repository:'fork/repo'})).reason,
  'QUEUE_ENTRY_IDENTITY_MISMATCH');
 assert.equal(reconcileQueueSnapshot(intent,snapshot(pull,{...entry,pullRequestNumber:99})).reason,
  'QUEUE_ENTRY_IDENTITY_MISMATCH');
 assert.equal(reconcileQueueSnapshot(intent,snapshot(pull,{...entry,head:'c'.repeat(40)})).reason,
  'QUEUE_HEAD_MISMATCH');
 assert.equal(reconcileQueueSnapshot(intent,snapshot(pull,{...entry,base:'d'.repeat(40)})).reason,
  'QUEUE_BASE_MISMATCH');
});

test('rejects unknown queue states, invalid positions, jumps, and malformed IDs',()=>{
 for(const e of [{...entry,state:'UNKNOWN'},{...entry,position:0},{...entry,position:1.5},
  {...entry,jump:true}])
  assert.equal(reconcileQueueSnapshot(intent,snapshot(pull,e)).reason,'QUEUE_STATE_UNKNOWN');
 for(const e of [{...entry,id:''},{...entry,id:'x'.repeat(121)},{...entry,id:'bad\nentry'}])
  assert.equal(reconcileQueueSnapshot(intent,snapshot({...pull,mergeQueueEntryId:e.id},e)).reason,
   'QUEUE_ENTRY_IDENTITY_MISMATCH');
});
