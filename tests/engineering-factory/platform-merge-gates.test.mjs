import test from 'node:test';
import assert from 'node:assert/strict';
import {platformMergeGates} from '../../tools/engineering-factory/platform-merge-gates.mjs';
const head='a'.repeat(40);
const policy=()=>({repositoryId:1471342715,trusted:true,required:['build-test','upload-coverage-javascript','windows-aspire-runtime','CodeQL'].map((name,i)=>({name,appId:i+1}))});
const evidence=()=>({head,complete:true,checks:policy().required.map(c=>({...c,head,status:'completed',conclusion:'success'})),review:{head,complete:true,independent:true,summaryDisposition:'clear',findings:[]},coverageVerified:true,securityClear:true,threadsResolved:true,baseHealthy:true,independentFavorable:true});
test('all exact platform and material review gates must be satisfied; no live merge',()=>{
 assert.deepEqual(platformMergeGates(head,policy(),evidence()),{shadow:true,eligible:true,liveMerge:false,reason:'SHADOW_PLATFORM_GATES_ONLY'});
 for(const v of [null,{...policy(),repositoryId:1},{...policy(),trusted:false},{...policy(),required:null},{...policy(),required:[{},...policy().required]},{...policy(),required:[...policy().required,policy().required[0]]}])assert.equal(platformMergeGates(head,v,evidence()).reason,'POLICY_UNKNOWN');
 assert.equal(platformMergeGates('bad',policy(),evidence()).reason,'POLICY_UNKNOWN');
 assert.equal(platformMergeGates(head,{...policy(),required:policy().required.slice(0,3)},evidence()).reason,'PLATFORM_POLICY_INCOMPLETE');
 for(const v of [null,{...evidence(),head:'b'.repeat(40)},{...evidence(),complete:false},{...evidence(),checks:[null]}])assert.equal(platformMergeGates(head,policy(),v).reason,'EVIDENCE_UNKNOWN');
 for(const change of [{head:'b'.repeat(40)},{appId:99},{status:'in_progress'},{conclusion:'cancelled'}]){
  const e=evidence();Object.assign(e.checks[2],change);assert.equal(platformMergeGates(head,policy(),e).reason,'CHECKS_INCOMPLETE');
 }
 for(const checks of [evidence().checks.slice(0,3),[...evidence().checks,evidence().checks[0]]])assert.equal(platformMergeGates(head,policy(),{...evidence(),checks}).reason,'CHECKS_INCOMPLETE');
 const e=evidence();e.checks.push({name:'extra',head,appId:1,status:'completed',conclusion:'success'});assert.equal(platformMergeGates(head,policy(),e).eligible,true);
 for(const k of ['coverageVerified','securityClear','threadsResolved','baseHealthy','independentFavorable'])assert.equal(platformMergeGates(head,policy(),{...evidence(),[k]:false}).reason,'GATES_UNKNOWN');
 for(const summaryDisposition of ['uncertain','actionable'])assert.equal(platformMergeGates(head,policy(),{...evidence(),review:{...evidence().review,summaryDisposition}}).reason,'REVIEW_INCOMPLETE');
 assert.equal(platformMergeGates(head,policy(),{...evidence(),review:{...evidence().review,findings:[{id:'x',state:'actionable',source:'summary'}]}}).reason,'REVIEW_INCOMPLETE');
});

test('nested review accessors and proxies cannot execute or modify validated gates',()=>{
 const poison=()=>{throw Error('unexpected getter');};
 const a=evidence();let reads=0;
 Object.defineProperty(a.review,'head',{get(){reads++;a.baseHealthy=false;return head;}});
 assert.equal(platformMergeGates(head,policy(),a).reason,'REVIEW_INCOMPLETE');assert.equal(reads,0);assert.equal(a.baseHealthy,true);
 const b=evidence();b.review=new Proxy(b.review,{get:poison});assert.equal(platformMergeGates(head,policy(),b).reason,'REVIEW_INCOMPLETE');
 const c=evidence();c.review.findings=[{id:'x',state:'resolved',source:'summary'}];Object.defineProperty(c.review.findings[0],'state',{get:poison});assert.equal(platformMergeGates(head,policy(),c).reason,'REVIEW_INCOMPLETE');
 const d=evidence();d.review.findings=[{id:'x',state:'resolved',source:'summary'}];Object.defineProperty(d.review.findings,0,{get:poison});assert.equal(platformMergeGates(head,policy(),d).reason,'REVIEW_INCOMPLETE');
});
