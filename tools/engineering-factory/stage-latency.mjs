import {types} from 'node:util';
const plainObject=x=>x!==null&&typeof x==='object'&&!types.isProxy(x)&&Object.getPrototypeOf(x)===Object.prototype;
const own=(x,k)=>x!==null&&typeof x==='object'&&!types.isProxy(x)&&!Array.isArray(x)&&k.every(p=>Object.hasOwn(Object.getOwnPropertyDescriptor(x,p)??{},'value'));
const exactPlain=(x,k)=>plainObject(x)&&Reflect.ownKeys(x).length===k.length&&own(x,k);
const ms=x=>Number.isSafeInteger(x)&&x>=0;
const sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
const fields=['head','observedHead','ready','ciDone','reviewDone','eligible','enrolled','merged','mainVerified'];
const candidateFields=['source',...fields];
const allowedStages=new Set(['reconcile','normalize','evaluate','dispatch','ci','queue','review','merge-shadow','verify-main','acceptance']);
const outlierThresholdMs=1500000;
const unknown=reason=>({state:'unknown',reason});

// Synthetic timeline only; parallel CI and review must not be summed.
export function stageLatency(e){
 if(!own(e,fields)||!sha(e.head)||e.head!==e.observedHead)return unknown('HEAD_UNKNOWN');
 if(!fields.slice(2).every(k=>ms(e[k])))return unknown('INCOMPLETE_TIMELINE');
 const validated=Math.max(e.ciDone,e.reviewDone);
 if(e.ciDone<e.ready||e.reviewDone<e.ready||e.eligible<validated||e.enrolled<e.eligible||e.merged<e.enrolled||e.mainVerified<e.merged)return unknown('INVALID_ORDER');
 return {state:'synthetic',ciMs:e.ciDone-e.ready,reviewMs:e.reviewDone-e.ready,validationCriticalMs:validated-e.ready,postValidationIdleMs:e.eligible-validated,enrollmentIdleMs:e.enrolled-e.eligible,queueMs:e.merged-e.enrolled,eligibleToMergeMs:e.merged-e.eligible,readyToMergeMs:e.merged-e.ready,mainVerificationMs:e.mainVerified-e.merged,readyToVerifiedMs:e.mainVerified-e.ready};
}

// Validate per-stage receipt durations; unmeasured stages stay null, never zero.
export function normalizeStageDurations(value){
 if(!plainObject(value))return {valid:false,reason:'INVALID_STAGE_DURATIONS',stages:null};
 const keys=Reflect.ownKeys(value);
 if(!keys.length)return {valid:false,reason:'INVALID_STAGE_DURATIONS',stages:null};
 const stages={};
 for(const key of keys){
  if(typeof key!=='string'||!allowedStages.has(key))return {valid:false,reason:'INVALID_STAGE_DURATIONS',stages:null};
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if(!Object.hasOwn(descriptor,'value'))return {valid:false,reason:'INVALID_STAGE_DURATIONS',stages:null};
  const duration=descriptor.value;
  if(duration!==null&&!ms(duration))return {valid:false,reason:'INVALID_STAGE_DURATIONS',stages:null};
  stages[key]=duration;
 }
 return {valid:true,stages};
}

// Sanitized candidate decomposition for synthetic or GitHub-hosted evidence, including right-censored runs.
export function decomposeCandidateLatency(e){
 if(!exactPlain(e,candidateFields)||!['synthetic','github-hosted'].includes(e.source))return unknown('SOURCE_UNKNOWN');
 if(!sha(e.head)||e.head!==e.observedHead)return unknown('HEAD_UNKNOWN');
 if(!ms(e.ready)||!fields.slice(3).every(k=>e[k]===null||ms(e[k])))return unknown('INCOMPLETE_TIMELINE');
 const validated=e.ciDone!==null&&e.reviewDone!==null?Math.max(e.ciDone,e.reviewDone):null;
 if((e.ciDone!==null&&e.ciDone<e.ready)||(e.reviewDone!==null&&e.reviewDone<e.ready)||
    (e.eligible!==null&&(validated===null||e.eligible<validated))||
    (e.enrolled!==null&&(e.eligible===null||e.enrolled<e.eligible))||
    (e.merged!==null&&(e.enrolled===null||e.merged<e.enrolled))||
    (e.mainVerified!==null&&(e.merged===null||e.mainVerified<e.merged)))return unknown('INVALID_ORDER');
 const readyToVerifiedMs=e.mainVerified===null?null:e.mainVerified-e.ready;
 return {
  state:e.source,
  censored:e.mainVerified===null,
  ciMs:e.ciDone===null?null:e.ciDone-e.ready,
  reviewMs:e.reviewDone===null?null:e.reviewDone-e.ready,
  validationCriticalMs:validated===null?null:validated-e.ready,
  postValidationIdleMs:e.eligible===null?null:e.eligible-validated,
  enrollmentIdleMs:e.enrolled===null?null:e.enrolled-e.eligible,
  queueMs:e.merged===null?null:e.merged-e.enrolled,
  eligibleToMergeMs:e.merged===null?null:e.merged-e.eligible,
  readyToMergeMs:e.merged===null?null:e.merged-e.ready,
  mainVerificationMs:e.mainVerified===null?null:e.mainVerified-e.merged,
  readyToVerifiedMs,
  outlierOver25m:readyToVerifiedMs===null?null:readyToVerifiedMs>outlierThresholdMs
 };
}
