import {types} from 'node:util';
const own=(x,k)=>x!==null&&typeof x==='object'&&!types.isProxy(x)&&!Array.isArray(x)&&k.every(p=>Object.hasOwn(Object.getOwnPropertyDescriptor(x,p)??{},'value'));
const ms=x=>Number.isSafeInteger(x)&&x>=0;
const sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
const fields=['head','observedHead','ready','ciDone','reviewDone','eligible','enrolled','merged','mainVerified'];
const unknown=reason=>({state:'unknown',reason});
// Synthetic timeline only; parallel CI and review must not be summed.
export function stageLatency(e){
 if(!own(e,fields)||!sha(e.head)||e.head!==e.observedHead)return unknown('HEAD_UNKNOWN');
 if(!fields.slice(2).every(k=>ms(e[k])))return unknown('INCOMPLETE_TIMELINE');
 const validated=Math.max(e.ciDone,e.reviewDone);
 if(e.ciDone<e.ready||e.reviewDone<e.ready||e.eligible<validated||e.enrolled<e.eligible||e.merged<e.enrolled||e.mainVerified<e.merged)return unknown('INVALID_ORDER');
 return {state:'synthetic',ciMs:e.ciDone-e.ready,reviewMs:e.reviewDone-e.ready,validationCriticalMs:validated-e.ready,postValidationIdleMs:e.eligible-validated,enrollmentIdleMs:e.enrolled-e.eligible,queueMs:e.merged-e.enrolled,eligibleToMergeMs:e.merged-e.eligible,readyToMergeMs:e.merged-e.ready,mainVerificationMs:e.mainVerified-e.merged,readyToVerifiedMs:e.mainVerified-e.ready};
}
