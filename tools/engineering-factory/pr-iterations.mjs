import {types} from 'node:util';
const sha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
const token=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(v);
const time=v=>Number.isSafeInteger(v)&&v>=0;
const own=(v,k)=>v!==null&&typeof v==='object'&&!types.isProxy(v)&&!Array.isArray(v)&&k.every(p=>Object.hasOwn(Object.getOwnPropertyDescriptor(v,p)??{},'value'));
const dense=v=>!types.isProxy(v)&&Array.isArray(v)&&Object.getPrototypeOf(v)===Array.prototype&&v.length<=1000&&Reflect.ownKeys(v).length===v.length+1&&Array.from({length:v.length},(_,i)=>Object.hasOwn(Object.getOwnPropertyDescriptor(v,i)??{},'value')).every(Boolean);
const unknown=reason=>({known:false,reason});
// Read-only normalized validation-attempt history; callers establish completeness,
// chronology, exact-head gate outcomes and cause independently. Never a merge gate.
export function prIterations(e){
 if(!own(e,['complete','observed','merged','finalHead','attempts'])||e.complete!==true||!time(e.observed)||typeof e.merged!=='boolean'||!sha(e.finalHead)||!dense(e.attempts)||!e.attempts.length)return unknown('HISTORY_UNKNOWN');
 const seen=new Set(),heads=new Set();let retries=0,queue=0,last=0,finalPassed=false,finalQueuePassed=true;
 const causes={initial:0,reviewRepair:0,ciRepair:0,baseRefresh:0,unknown:0};
 for(const a of e.attempts){
  if(!own(a,['id','head','at','kind','cause','passed'])||!token(a.id)||seen.has(a.id)||!sha(a.head)||!time(a.at)||a.at<last||a.at>e.observed||!['candidate','retry','queue'].includes(a.kind)||typeof a.passed!=='boolean')return unknown('ATTEMPT_UNKNOWN');
  seen.add(a.id);last=a.at;
  if(a.kind==='candidate'){
   if(heads.has(a.head)||typeof a.cause!=='string'||!Object.hasOwn(causes,a.cause)||(heads.size===0)!==(a.cause==='initial'))return unknown('CANDIDATE_UNKNOWN');
   heads.add(a.head);causes[a.cause]++;
  }else if(a.kind==='retry'){
   if(!heads.has(a.head)||a.cause!=='infrastructure')return unknown('RETRY_UNKNOWN');
   retries++;
  }else{
   if(!heads.has(a.head)||a.cause!=='queueRevalidation')return unknown('QUEUE_UNKNOWN');
   queue++;
  }
  if(a.head===e.finalHead){
   if(a.kind==='queue')finalQueuePassed=a.passed;
   else finalPassed=a.passed;
  }
 }
 if(!heads.has(e.finalHead)||(e.merged&&(!finalPassed||!finalQueuePassed)))return unknown('FINAL_EVIDENCE_UNKNOWN');
 return {known:true,censored:!e.merged,candidateRounds:heads.size,reworkRounds:heads.size-1,infrastructureRetries:retries,queueRevalidations:queue,causes,firstPass:e.merged?heads.size===1:null};
}
