import test from 'node:test';
import assert from 'node:assert/strict';
import {prLifecycle as measure} from '../../tools/engineering-factory/pr-lifecycle.mjs';
const e=()=>({created:100,initialDraft:true,firstPublished:200,historyComplete:true,merged:500,mainVerified:600,observed:700});
test('first publication, merge and verified main use independent clocks',()=>{
 const a=measure(e());assert.deepEqual(a,{known:true,source:'timeline',censored:false,draftToPublishMs:100,openDraftAgeMs:null,publishToMergeMs:300,openPublishedAgeMs:null,createdToMergeMs:400,openAgeMs:null,mergeToVerifiedMs:100,verificationPendingAgeMs:null});
 assert.equal(measure({...e(),initialDraft:false,firstPublished:100}).draftToPublishMs,0);
 assert.equal(measure({...e(),mainVerified:null}).verificationPendingAgeMs,200);
});
test('open stages are censored and never reported as completed durations',()=>{
 const a=measure({...e(),merged:null,mainVerified:null});assert.equal(a.censored,true);assert.equal(a.openPublishedAgeMs,500);assert.equal(a.openAgeMs,600);assert.equal(a.publishToMergeMs,null);
 const b=measure({...e(),firstPublished:null,merged:null,mainVerified:null});assert.equal(b.openDraftAgeMs,600);assert.equal(b.draftToPublishMs,null);assert.equal(b.openPublishedAgeMs,null);
});
test('missing, malformed, contradictory or accessor-backed evidence stays unknown',()=>{
 for(const x of [null,new Proxy(e(),{}),{...e(),historyComplete:false},{...e(),initialDraft:null},{...e(),created:-1},{...e(),observed:99}])assert.equal(measure(x).reason,'HISTORY_UNKNOWN');
 for(const x of [{firstPublished:99},{firstPublished:701},{firstPublished:undefined},{initialDraft:false}])assert.equal(measure({...e(),...x}).reason,'PUBLICATION_UNKNOWN');
 for(const x of [{merged:199},{merged:701},{merged:1.5},{firstPublished:null}])assert.equal(measure({...e(),...x}).reason,'MERGE_UNKNOWN');
 for(const x of [{mainVerified:499},{mainVerified:701},{merged:null},{mainVerified:undefined}])assert.equal(measure({...e(),...x}).reason,'VERIFICATION_UNKNOWN');
 const a=e();let reads=0;Object.defineProperty(a,'created',{get(){reads++;throw Error('getter');}});assert.equal(measure(a).reason,'HISTORY_UNKNOWN');assert.equal(reads,0);
});
