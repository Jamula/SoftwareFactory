import {types} from 'node:util';
import {planReviewBatch} from './review-batch.mjs';
const sha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
const pos=v=>Number.isSafeInteger(v)&&v>0;
const data=(v,keys)=>v!==null&&typeof v==='object'&&!types.isProxy(v)&&!Array.isArray(v)&&keys.every(k=>Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)??{},'value'));
const dense=(v,max)=>!types.isProxy(v)&&Array.isArray(v)&&Object.getPrototypeOf(v)===Array.prototype&&v.length<=max&&Reflect.ownKeys(v).length===v.length+1&&Array.from({length:v.length},(_,i)=>Object.hasOwn(Object.getOwnPropertyDescriptor(v,i)??{},'value')).every(Boolean);
const required=['build-test','upload-coverage-javascript','windows-aspire-runtime','CodeQL'];
const deny=reason=>({shadow:true,eligible:false,liveMerge:false,reason});
// Input is normalized by a separately trusted adapter. This diagnostic cannot
// establish protection enforcement or authorize any repository operation.
export function platformMergeGates(head,policy,e){
 if(!sha(head)||!data(policy,['repositoryId','trusted','required'])||policy.repositoryId!==1471342715||policy.trusted!==true||!dense(policy.required,32))return deny('POLICY_UNKNOWN');
 const expected=new Map();
 for(const c of policy.required){
  if(!data(c,['name','appId'])||typeof c.name!=='string'||!c.name||!pos(c.appId)||expected.has(c.name))return deny('POLICY_UNKNOWN');
  expected.set(c.name,c.appId);
 }
 if(required.some(n=>!expected.has(n)))return deny('PLATFORM_POLICY_INCOMPLETE');
 if(!data(e,['head','complete','checks','review','coverageVerified','securityClear','threadsResolved','baseHealthy','independentFavorable'])||e.head!==head||e.complete!==true||!dense(e.checks,256))return deny('EVIDENCE_UNKNOWN');
 const seen=new Set();
 for(const c of e.checks){
  if(!data(c,['name','head','appId','status','conclusion'])||typeof c.name!=='string')return deny('EVIDENCE_UNKNOWN');
  if(!expected.has(c.name))continue;
  if(seen.has(c.name)||c.head!==head||c.appId!==expected.get(c.name)||c.status!=='completed'||c.conclusion!=='success')return deny('CHECKS_INCOMPLETE');
  seen.add(c.name);
 }
 if(seen.size!==expected.size)return deny('CHECKS_INCOMPLETE');
 if([e.coverageVerified,e.securityClear,e.threadsResolved,e.baseHealthy,e.independentFavorable].some(v=>v!==true))return deny('GATES_UNKNOWN');
 if(planReviewBatch(head,e.review).state!=='no-repair')return deny('REVIEW_INCOMPLETE');
 return {shadow:true,eligible:true,liveMerge:false,reason:'SHADOW_PLATFORM_GATES_ONLY'};
}
