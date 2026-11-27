import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stageLatency as measure,
  normalizeStageDurations,
  decomposeCandidateLatency
} from '../../tools/engineering-factory/stage-latency.mjs';

const h='a'.repeat(40),e={head:h,observedHead:h,ready:1000,ciDone:2000,reviewDone:4000,eligible:5000,enrolled:5100,merged:6000,mainVerified:7000};

test('separate overlap from idle, queue and verified delivery',()=>{
  assert.deepEqual(measure(e),{state:'synthetic',ciMs:1000,reviewMs:3000,validationCriticalMs:3000,postValidationIdleMs:1000,enrollmentIdleMs:100,queueMs:900,eligibleToMergeMs:1000,readyToMergeMs:5000,mainVerificationMs:1000,readyToVerifiedMs:6000});
  assert.equal(measure({...e,ciDone:4500}).validationCriticalMs,3500);
});

test('missing stale unsafe and reversed timestamps remain unknown',()=>{
  for(const x of [null,[],Object.create(e),{...e,head:'bad'},{...e,observedHead:'b'.repeat(40)}])assert.equal(measure(x).reason,'HEAD_UNKNOWN');
  for(const x of [{...e,ready:-1},{...e,reviewDone:null},{...e,merged:1.5},{...e,mainVerified:Infinity}])assert.equal(measure(x).reason,'INCOMPLETE_TIMELINE');
  for(const x of [{...e,ciDone:999},{...e,reviewDone:999},{...e,eligible:3999},{...e,enrolled:4999},{...e,merged:5099},{...e,mainVerified:5999}])assert.equal(measure(x).reason,'INVALID_ORDER');
  let reads=0;const trap=()=>{reads++;throw Error('unexpected read');};
  const a={...e};Object.defineProperty(a,'ready',{get:trap});
  assert.equal(measure(a).reason,'HEAD_UNKNOWN');
  assert.equal(measure(new Proxy(e,{get:trap,getOwnPropertyDescriptor:trap})).reason,'HEAD_UNKNOWN');
  assert.equal(reads,0);
});

test('normalizeStageDurations preserves null unknowns and rejects invalid stage maps',()=>{
  const valid=normalizeStageDurations({
    reconcile:0,normalize:12,evaluate:4,dispatch:null,ci:48000,
    queue:15,review:90000,'merge-shadow':250,'verify-main':null,acceptance:null
  });
  assert.equal(valid.valid,true);
  assert.equal(valid.stages.reconcile,0);
  assert.equal(valid.stages.dispatch,null);
  assert.equal(valid.stages['verify-main'],null);

  const getterObj={};
  Object.defineProperty(getterObj,'reconcile',{enumerable:true,get:()=>1});
  for(const invalid of [
    null,42,[],Object.create({reconcile:1}),new Proxy({reconcile:1},{}),{},
    {[Symbol('reconcile')]:1},{unknownStage:1},getterObj,
    {reconcile:-1},{reconcile:1.25},{reconcile:NaN},{reconcile:'0'}
  ]){
    assert.deepEqual(normalizeStageDurations(invalid),{
      valid:false,reason:'INVALID_STAGE_DURATIONS',stages:null
    });
  }
});

test('decomposeCandidateLatency supports hosted runs, right-censoring, >25m outliers and zero SHA leakage',()=>{
  const hosted=decomposeCandidateLatency({source:'github-hosted',...e});
  assert.deepEqual(hosted,{
    state:'github-hosted',censored:false,ciMs:1000,reviewMs:3000,validationCriticalMs:3000,
    postValidationIdleMs:1000,enrollmentIdleMs:100,queueMs:900,eligibleToMergeMs:1000,
    readyToMergeMs:5000,mainVerificationMs:1000,readyToVerifiedMs:6000,outlierOver25m:false
  });
  assert.equal(JSON.stringify(hosted).includes(h),false);

  const boundary=decomposeCandidateLatency({
    source:'synthetic',...e,mainVerified:e.ready+1500000
  });
  assert.equal(boundary.outlierOver25m,false);
  const outlier=decomposeCandidateLatency({
    source:'github-hosted',...e,ciDone:5000,reviewDone:3000,eligible:6000,
    enrolled:7000,merged:8000,mainVerified:e.ready+1500001
  });
  assert.equal(outlier.validationCriticalMs,4000);
  assert.equal(outlier.outlierOver25m,true);

  const censoredValidation=decomposeCandidateLatency({
    source:'github-hosted',head:h,observedHead:h,ready:1000,ciDone:2200,
    reviewDone:null,eligible:null,enrolled:null,merged:null,mainVerified:null
  });
  assert.deepEqual(censoredValidation,{
    state:'github-hosted',censored:true,ciMs:1200,reviewMs:null,validationCriticalMs:null,
    postValidationIdleMs:null,enrollmentIdleMs:null,queueMs:null,eligibleToMergeMs:null,
    readyToMergeMs:null,mainVerificationMs:null,readyToVerifiedMs:null,outlierOver25m:null
  });

  const censoredVerify=decomposeCandidateLatency({
    source:'synthetic',...e,mainVerified:null
  });
  assert.equal(censoredVerify.censored,true);
  assert.equal(censoredVerify.readyToMergeMs,5000);
  assert.equal(censoredVerify.mainVerificationMs,null);
  assert.equal(censoredVerify.readyToVerifiedMs,null);
  assert.equal(censoredVerify.outlierOver25m,null);

  for(const badSource of [
    null,[],{source:'github-proxy',...e},{source:'historical-proxy',...e},
    {source:'github-hosted',...e,extra:1}
  ])assert.equal(decomposeCandidateLatency(badSource).reason,'SOURCE_UNKNOWN');

  for(const badHead of [
    {source:'synthetic',...e,head:'invalid'},
    {source:'synthetic',...e,observedHead:'b'.repeat(40)}
  ])assert.equal(decomposeCandidateLatency(badHead).reason,'HEAD_UNKNOWN');

  for(const badTime of [
    {source:'synthetic',...e,ready:null},
    {source:'synthetic',...e,ready:-1},
    {source:'synthetic',...e,ciDone:1.5},
    {source:'synthetic',...e,mainVerified:'7000'}
  ])assert.equal(decomposeCandidateLatency(badTime).reason,'INCOMPLETE_TIMELINE');

  for(const badOrder of [
    {source:'synthetic',...e,ciDone:999},
    {source:'synthetic',...e,reviewDone:999},
    {source:'synthetic',...e,reviewDone:null},
    {source:'synthetic',...e,eligible:3999},
    {source:'synthetic',...e,eligible:null},
    {source:'synthetic',...e,enrolled:4999},
    {source:'synthetic',...e,enrolled:null},
    {source:'synthetic',...e,merged:5099},
    {source:'synthetic',...e,merged:null},
    {source:'synthetic',...e,mainVerified:5999}
  ])assert.equal(decomposeCandidateLatency(badOrder).reason,'INVALID_ORDER');
});
