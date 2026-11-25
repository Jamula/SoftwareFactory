import {types} from 'node:util';
const sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
const own=(x,k)=>x!==null&&typeof x==='object'&&!types.isProxy(x)&&!Array.isArray(x)&&k.every(p=>Object.hasOwn(Object.getOwnPropertyDescriptor(x,p)??{},'value'));
const integer=x=>Number.isSafeInteger(x)&&x>0;
const blocked=(reason)=>({shadow:true,eligible:false,reason});
// Diagnostic only. GitHub's aggregate review decision is NOT exact-head evidence.
export function queueInspection(p,head){
 if(!sha(head)||!own(p,['number','headRefOid','baseRefName','state','isDraft','reviewDecision','mergeStateStatus','autoMergeRequest','statusCheckRollup'])||!integer(p.number))return blocked('UNKNOWN');
 if(p.headRefOid!==head||p.baseRefName!=='main')return blocked('HEAD_OR_BASE_MISMATCH');
 if(p.state!=='OPEN'||p.isDraft!==false)return blocked('NOT_READY');
 if(p.reviewDecision!=='APPROVED')return blocked('FORMAL_REVIEW_MISSING');
 if(p.mergeStateStatus!=='CLEAN')return blocked('GITHUB_NOT_CLEAN');
 // Aggregate approval/checks are useful diagnostics but not independently verified.
 return {...blocked('EXACT_HEAD_EVIDENCE_REQUIRED'),pr:p.number,autoMergeRequested:p.autoMergeRequest!==null};
}
