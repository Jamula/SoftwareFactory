import {types} from 'node:util';

const repositoryId=1471342715;
const repository='Jamula/SoftwareFactory';
const queueStates=new Set(['AWAITING_CHECKS','LOCKED','MERGEABLE','QUEUED','UNMERGEABLE']);
const intentFields=['repositoryId','repository','branch','number','expectedHead','expectedBase'];
const rereadFields=['repositoryId','repository','branch','stop','pull','entry'];
const pullFields=['repositoryId','repository','number','baseBranch','base','head','state','draft','mergeQueueEntryId'];
const entryFields=['repositoryId','repository','branch','id','pullRequestNumber','head','base','state','position','jump'];
const positive=n=>Number.isSafeInteger(n)&&n>0;
const sha=s=>typeof s==='string'&&/^[a-f0-9]{40}$/.test(s);
const text=(s,max=120)=>typeof s==='string'&&s.length>0&&s.length<=max&&!/[\u0000-\u001f\u007f]/.test(s);
const record=(value,fields)=>value!==null&&typeof value==='object'&&!types.isProxy(value)&&
 !Array.isArray(value)&&Reflect.ownKeys(value).length===fields.length&&
 fields.every(field=>Object.hasOwn(Object.getOwnPropertyDescriptor(value,field)??{},'value'));
const blocked=reason=>({shadow:true,evidenceComplete:false,queueObserved:false,mergeEligible:false,
 liveQueueWrite:false,liveMerge:false,dependentWorkAllowed:false,reason});

/**
 * Normalize a second, read-only pull/merge-queue snapshot after a queue request.
 * This accepts already normalized API metadata and performs no network or mutation.
 */
export function reconcileQueueSnapshot(intent,reread) {
 if(!record(intent,intentFields)||!positive(intent.repositoryId)||intent.repositoryId!==repositoryId||
    intent.repository!==repository||intent.branch!=='main'||!positive(intent.number)||
    !sha(intent.expectedHead)||!sha(intent.expectedBase)||intent.expectedHead===intent.expectedBase)
  return blocked('QUEUE_INTENT_UNKNOWN');
 if(!record(reread,rereadFields))return blocked('QUEUE_REREAD_UNKNOWN');
 if(reread.stop!==false)return blocked('STOPPED');
 if(reread.repositoryId!==repositoryId||reread.repository!==repository||reread.branch!=='main')
  return blocked('QUEUE_SCOPE_MISMATCH');
 const {pull,entry}=reread;
 if(!record(pull,pullFields)||!record(entry,entryFields))return blocked('QUEUE_REREAD_UNKNOWN');
 if(pull.repositoryId!==repositoryId||pull.number!==intent.number||pull.baseBranch!=='main'||
    pull.state!=='OPEN'||pull.draft!==false)return blocked('PULL_NOT_READY');
 if(pull.head!==intent.expectedHead)return blocked('HEAD_CHANGED');
 if(pull.base!==intent.expectedBase)return blocked('BASE_CHANGED');
 if(!text(pull.mergeQueueEntryId)||!text(entry.id)||pull.mergeQueueEntryId!==entry.id||
    entry.repositoryId!==repositoryId||entry.repository!==repository||entry.branch!=='main'||
    entry.pullRequestNumber!==intent.number)return blocked('QUEUE_ENTRY_IDENTITY_MISMATCH');
 if(entry.head!==intent.expectedHead)return blocked('QUEUE_HEAD_MISMATCH');
 if(entry.base!==intent.expectedBase)return blocked('QUEUE_BASE_MISMATCH');
 if(!queueStates.has(entry.state)||!positive(entry.position)||entry.jump!==false)
  return blocked('QUEUE_STATE_UNKNOWN');
 if(entry.state==='UNMERGEABLE')return blocked('QUEUE_ENTRY_UNMERGEABLE');
 return {shadow:true,evidenceComplete:false,queueObserved:true,mergeEligible:false,
  liveQueueWrite:false,liveMerge:false,dependentWorkAllowed:false,reason:'QUEUE_ENTRY_OBSERVED',
  repository,repositoryId,branch:'main',number:intent.number,head:intent.expectedHead,
  base:intent.expectedBase,queueEntryId:entry.id,queueState:entry.state,position:entry.position};
}
