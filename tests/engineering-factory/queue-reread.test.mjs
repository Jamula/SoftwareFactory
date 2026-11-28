import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_QUEUE_SCOPE,reconcileQueueSnapshot} from '../../tools/engineering-factory/queue-reread.mjs';
import {evaluatePullMergeLatencySample,evaluatePullMergeLatencySlo} from '../../tools/engineering-factory/merge-queue-slo.mjs';
import {buildCandidateReviewEvidence} from '../../tools/engineering-factory/review-history.mjs';

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
 assert.deepEqual(reconcileQueueSnapshot(intent,snapshot(),DEFAULT_QUEUE_SCOPE),result);
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
 for(const bad of [null,'intent',{},{...intent,repositoryId:0},{...intent,repositoryId:1},
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
 for(const p of [{...pull,repositoryId:99},{...pull,state:'CLOSED'},{...pull,draft:true},
  {...pull,baseBranch:'release'},{...pull,number:number+1}])
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
 assert.equal(reconcileQueueSnapshot(intent,snapshot(pull,{...entry,id:''})).reason,
  'QUEUE_ENTRY_IDENTITY_MISMATCH');
 assert.equal(reconcileQueueSnapshot(intent,snapshot(pull,{...entry,repositoryId:99})).reason,
  'QUEUE_ENTRY_IDENTITY_MISMATCH');
 assert.equal(reconcileQueueSnapshot(intent,snapshot(pull,{...entry,repository:'fork/repo'})).reason,
  'QUEUE_ENTRY_IDENTITY_MISMATCH');
 assert.equal(reconcileQueueSnapshot(intent,snapshot(pull,{...entry,branch:'release'})).reason,
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
 for(const e of [{...entry,id:''},{...entry,id:'   '},{...entry,id:'x'.repeat(121)},{...entry,id:'bad\nentry'}])
  assert.equal(reconcileQueueSnapshot(intent,snapshot({...pull,mergeQueueEntryId:e.id},e)).reason,
   'QUEUE_ENTRY_IDENTITY_MISMATCH');
});

test('supports consumer repository scopes and custom default branches with strict isolation',()=>{
 const consumerScopes=[
  {repositoryId:1467877692,repository:'Jamula/FamilyTree',defaultBranch:'main'},
  {repositoryId:1448979947,repository:'Jamula/Spellbook',defaultBranch:'release/v2.0'}
 ];
 for(const scope of consumerScopes){
  const scopedIntent={repositoryId:scope.repositoryId,repository:scope.repository,
   branch:scope.defaultBranch,number:19,expectedHead:head,expectedBase:base};
  const scopedPull={repositoryId:scope.repositoryId,repository:scope.repository,number:19,
   baseBranch:scope.defaultBranch,base,head,state:'OPEN',draft:false,mergeQueueEntryId:'PRME_consumer_19'};
  const scopedEntry={repositoryId:scope.repositoryId,repository:scope.repository,
   branch:scope.defaultBranch,id:'PRME_consumer_19',pullRequestNumber:19,head,base,
   state:'QUEUED',position:1,jump:false};
  const scopedReread={repositoryId:scope.repositoryId,repository:scope.repository,
   branch:scope.defaultBranch,stop:false,pull:scopedPull,entry:scopedEntry};
  const observed=reconcileQueueSnapshot(scopedIntent,scopedReread,scope);
  assert.equal(observed.reason,'QUEUE_ENTRY_OBSERVED');
  assert.equal(observed.repository,scope.repository);
  assert.equal(observed.repositoryId,scope.repositoryId);
  assert.equal(observed.branch,scope.defaultBranch);
  assert.equal(observed.mergeEligible,false);
  assert.equal(reconcileQueueSnapshot(scopedIntent,scopedReread).reason,'QUEUE_INTENT_UNKNOWN');
  assert.equal(reconcileQueueSnapshot(intent,snapshot(),scope).reason,'QUEUE_INTENT_UNKNOWN');
  assert.equal(reconcileQueueSnapshot(scopedIntent,{...scopedReread,branch:'other'},scope).reason,
   'QUEUE_SCOPE_MISMATCH');
 }
});

test('fails closed with QUEUE_SCOPE_UNKNOWN on malformed, unsafe, or spoofed scopes',()=>{
 const validConsumer={repositoryId:1467877692,repository:'Jamula/FamilyTree',defaultBranch:'main'};
 const nonEnumScope={...validConsumer};
 Object.defineProperty(nonEnumScope,'defaultBranch',{value:'main',enumerable:false});
 const nullProtoScope=Object.assign(Object.create(null),validConsumer);
 const customProtoScope=Object.assign(Object.create({}),validConsumer);
 const accessorScope={...validConsumer};
 Object.defineProperty(accessorScope,'repository',{get(){throw Error('must not invoke');},enumerable:true});
 const renamedKeyScope={repositoryId:1467877692,repository:'Jamula/FamilyTree',branch:'main'};

 const revoked=Proxy.revocable(validConsumer,{});
 revoked.revoke();
 const trapBomb=new Proxy(validConsumer,new Proxy({},{get(){throw Error('proxy trap must not run');}}));

 const invalidScopes=[
  null,
  'Jamula/FamilyTree',
  [],
  {},
  nonEnumScope,
  nullProtoScope,
  customProtoScope,
  accessorScope,
  renamedKeyScope,
  new Proxy(validConsumer,{}),
  revoked.proxy,
  trapBomb,
  {...validConsumer,extra:true},
  {...validConsumer,repositoryId:0},
  {...validConsumer,repositoryId:-1},
  {...validConsumer,repositoryId:1.5},
  {...validConsumer,repositoryId:'1467877692'},
  {...validConsumer,repository:123},
  {...validConsumer,repository:''},
  {...validConsumer,repository:'noslash'},
  {...validConsumer,repository:'a/b/c'},
  {...validConsumer,repository:'./FamilyTree'},
  {...validConsumer,repository:'Jamula/..'},
  {...validConsumer,repository:'Jamula/.git'},
  {...validConsumer,repository:'Jamula/FamilyTree.git'},
  {...validConsumer,repository:'Jamula/FamilyTree.GIT'},
  {...validConsumer,repository:'Jamula.git/FamilyTree'},
  {repositoryId:1471342715,repository:'Jamula/FamilyTree',defaultBranch:'main'},
  {repositoryId:1467877692,repository:'Jamula/SoftwareFactory',defaultBranch:'main'},
  {repositoryId:1467877692,repository:'jamula/softwarefactory',defaultBranch:'main'},
  {repositoryId:1471342715,repository:'jamula/softwarefactory',defaultBranch:'main'},
  {...validConsumer,defaultBranch:null},
  {...validConsumer,defaultBranch:''},
  {...validConsumer,defaultBranch:'HEAD'},
  {...validConsumer,defaultBranch:'-main'},
  {...validConsumer,defaultBranch:'a..b'},
  {...validConsumer,defaultBranch:'release/../main'},
  {...validConsumer,defaultBranch:'/main'},
  {...validConsumer,defaultBranch:'main/'},
  {...validConsumer,defaultBranch:'release//v1'},
  {...validConsumer,defaultBranch:'.main'},
  {...validConsumer,defaultBranch:'main.'},
  {...validConsumer,defaultBranch:'release/.v1'},
  {...validConsumer,defaultBranch:'release./v1'},
  {...validConsumer,defaultBranch:'main.lock'},
  {...validConsumer,defaultBranch:'main.LOCK'},
  {...validConsumer,defaultBranch:'main space'},
  {...validConsumer,defaultBranch:'x'.repeat(121)}
 ];
 for(const badScope of invalidScopes)
  assert.equal(reconcileQueueSnapshot(intent,snapshot(),badScope).reason,'QUEUE_SCOPE_UNKNOWN');
});

test('hardens record checks against custom prototypes, non-enumerable fields, and renamed keys',()=>{
 const hide=(obj,key)=>{
  const copy={...obj};
  Object.defineProperty(copy,key,{value:obj[key],enumerable:false});
  return copy;
 };
 const nullProto=obj=>Object.assign(Object.create(null),obj);
 const customProto=obj=>Object.assign(Object.create({inherited:true}),obj);

 assert.equal(reconcileQueueSnapshot(hide(intent,'number'),snapshot()).reason,'QUEUE_INTENT_UNKNOWN');
 assert.equal(reconcileQueueSnapshot(nullProto(intent),snapshot()).reason,'QUEUE_INTENT_UNKNOWN');
 assert.equal(reconcileQueueSnapshot(customProto(intent),snapshot()).reason,'QUEUE_INTENT_UNKNOWN');
 const renamedIntent={...intent,wrongKey:1};
 delete renamedIntent.number;
 assert.equal(reconcileQueueSnapshot(renamedIntent,snapshot()).reason,'QUEUE_INTENT_UNKNOWN');

 assert.equal(reconcileQueueSnapshot(intent,hide(snapshot(),'stop')).reason,'QUEUE_REREAD_UNKNOWN');
 assert.equal(reconcileQueueSnapshot(intent,nullProto(snapshot())).reason,'QUEUE_REREAD_UNKNOWN');
 assert.equal(reconcileQueueSnapshot(intent,snapshot(hide(pull,'state'),entry)).reason,'QUEUE_REREAD_UNKNOWN');
 assert.equal(reconcileQueueSnapshot(intent,snapshot(customProto(pull),entry)).reason,'QUEUE_REREAD_UNKNOWN');
 assert.equal(reconcileQueueSnapshot(intent,snapshot(pull,hide(entry,'position'))).reason,'QUEUE_REREAD_UNKNOWN');
 assert.equal(reconcileQueueSnapshot(intent,snapshot(pull,nullProto(entry))).reason,'QUEUE_REREAD_UNKNOWN');
});

test('verifies deterministic replay invariants on m01-05-merge-queue-receipt.json without asserting live hosted provenance',()=>{
 const receiptUrl=new URL('../../docs/evidence/m01-05-merge-queue-receipt.json',import.meta.url);
 const receipt=JSON.parse(readFileSync(receiptUrl,'utf8'));

 assert.equal(receipt.issue,8);
 assert.equal(receipt.milestone,'M01.05');
 assert.deepEqual(receipt.scope,DEFAULT_QUEUE_SCOPE);
 assert.equal(receipt.mainIntegrationRange.tipMainOid,'b0924c3807f797e6090e1dc3e1e65fc9caa07550');
 assert.equal(receipt.cohortProvenance.captureKind,'readonly-github-api-snapshot');
 assert.equal(receipt.cohortProvenance.independentHostedProvenanceEstablished,false);
 assert.equal(receipt.cohortProvenance.offlineReplayEstablishesLiveProvenance,false);
 assert.equal(receipt.cohortProvenance.publicActionsMetadataEstablishesCompleteRefHistory,false);
 assert.equal(receipt.cohortProvenance.sourceComplete,false);
 assert.equal(receipt.cohortProvenance.humanTouchesComplete,false);
 assert.equal(receipt.cohortProvenance.unattendedIssue10Claimed,false);
 assert.equal(receipt.cohortProvenance.closesIssue8,false);
 assert.equal(receipt.sloSamples.length,21);
 assert.deepEqual(receipt.sloSamples.map(s=>s.prNumber),Array.from({length:21},(_,i)=>145+i));

 for(const sample of receipt.sloSamples){
  const single=evaluatePullMergeLatencySample(sample);
  assert.equal(single.valid,true);
  assert.equal(single.humanTouchesComplete,false);
  assert.equal(single.unattendedMerge,false);
 }

 const cohort=evaluatePullMergeLatencySlo(receipt.sloSamples,receipt.sloOptions);
 assert.equal(cohort.valid,true);
 assert.equal(cohort.known,false);
 assert.equal(cohort.status,'partial');
 assert.equal(cohort.reason,'PARTIAL_COHORT_EVIDENCE');
 assert.equal(cohort.sampleCount,21);
 assert.equal(cohort.sloMet,null);
 assert.equal(cohort.humanTouchesComplete,false);
 assert.equal(cohort.zeroRoutineHumanTouchesMet,false);
 assert.equal(cohort.counts.unattendedMergedCount,0);
 assert.equal(cohort.humanTouches.observedRoutineCount,21);
 assert.deepEqual(JSON.parse(JSON.stringify(cohort.rework)),receipt.sloEvaluationSummary.rework);
 assert.deepEqual(JSON.parse(JSON.stringify(cohort.metrics)),receipt.sloEvaluationSummary.metrics);
 assert.deepEqual(JSON.parse(JSON.stringify(cohort.stageAttribution)),receipt.sloEvaluationSummary.stageAttribution);

 const ifWindowComplete=evaluatePullMergeLatencySlo(receipt.sloSamples,{...receipt.sloOptions,sourceComplete:true});
 assert.equal(ifWindowComplete.sloMet,false);
 assert.equal(ifWindowComplete.reason,'SLO_MISSED');

 const pr145Sample=receipt.sloSamples.find(s=>s.prNumber===145);
 assert.ok(pr145Sample.headCommits.some(h=>h.sha.startsWith('695827465b')));
 assert.ok(pr145Sample.headCommits.some(h=>h.sha.startsWith('889e3fc759')));

 const requiredMg=['Factory validation','Windows Aspire runtime','.NET MAF specialist agents','Reusable replay smoke'];
 assert.deepEqual(receipt.requiredMergeGroupWorkflows,requiredMg);
 assert.equal(receipt.mergeGroupCheckReceipts.length,21);
 for(let i=0;i<receipt.mergeGroupCheckReceipts.length;i++){
  const mg=receipt.mergeGroupCheckReceipts[i];
  const sample=receipt.sloSamples[i];
  assert.equal(mg.prNumber,sample.prNumber);
  assert.equal(mg.headRefOid,sample.headCommits.at(-1).sha);
  assert.equal(Date.parse(mg.mergedAtIso),sample.mergedAt);
  assert.equal(mg.mainVerification.completedAtMs,sample.mainVerifiedAt);
  assert.deepEqual(mg.workflows.map(w=>w.name),requiredMg);
  assert.ok(mg.workflows.every(w=>w.status==='completed'&&w.conclusion==='success'));
 }
 const mg161=receipt.mergeGroupCheckReceipts.find(m=>m.prNumber===161);
 const mg157=receipt.mergeGroupCheckReceipts.find(m=>m.prNumber===157);
 assert.equal(mg161.workflows.find(w=>w.name==='Factory validation').runId,46101393942);
 assert.equal(mg157.workflows.find(w=>w.name==='Factory validation').runId,46101395492);
 assert.equal(mg157.mergeCommitOid,'b0924c3807f797e6090e1dc3e1e65fc9caa07550');

 for(const snap of receipt.queueRereadSnapshots){
  const actual=reconcileQueueSnapshot(snap.intent,snap.reread,snap.scope);
  assert.deepEqual(actual,snap.expected);
  if(snap.scope.repositoryId===DEFAULT_QUEUE_SCOPE.repositoryId){
   assert.deepEqual(reconcileQueueSnapshot(snap.intent,snap.reread),snap.expected);
   if(snap.syntheticFixture===false){
    const recordedMg=receipt.mergeGroupCheckReceipts.find(m=>m.prNumber===snap.intent.number);
    assert.equal(snap.reread.pull.base,recordedMg.pullBaseOid);
    assert.equal(snap.reread.entry.base,recordedMg.queueBaseOid);
    assert.equal(snap.reread.pull.head,recordedMg.headRefOid);
   }
  }
 }

 assert.equal(receipt.negativeCaseVerification.allPassedFailClosed,true);
 for(const neg of receipt.negativeCaseVerification.cases){
  if(neg.evaluator==='reconcileQueueSnapshot'){
   const res=reconcileQueueSnapshot(neg.intent,neg.reread,neg.scope);
   assert.equal(res.reason,neg.expectedReason);
   assert.equal(res.queueObserved,neg.expectedQueueObserved);
   assert.equal(res.mergeEligible,neg.expectedMergeEligible);
  }else{
   assert.equal(neg.evaluator,'buildCandidateReviewEvidence');
   const rev=buildCandidateReviewEvidence(neg.head,neg.history,neg.options);
   assert.equal(rev.ok,true);
   assert.equal(rev.independentFavorable,neg.expectedIndependentFavorable);
   if(Object.hasOwn(neg,'expectedBatchState'))
    assert.equal(rev.batch.state,neg.expectedBatchState);
  }
 }
});
