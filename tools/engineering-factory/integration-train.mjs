const sha=s=>typeof s==='string'&&/^[a-f0-9]{40}$/.test(s);
const positive=n=>Number.isSafeInteger(n)&&n>0;
const own=(v,keys)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&keys.every(k=>Object.hasOwn(v,k));
const dense=a=>Array.isArray(a)&&Object.keys(a).length===a.length&&Array.from({length:a.length},(_,i)=>Object.hasOwn(a,i)).every(Boolean);
const blocked=reason=>({shadow:true,liveMerge:false,reason});
export function nextIntegration(state) {
 if(!own(state,['stop','main','mainHealthy','active','candidates'])||state.stop!==false) return blocked('STOPPED');
 if(!sha(state.main)||state.mainHealthy!==true||state.active!==false) return blocked('MAIN_OR_TRAIN_UNREADY');
 if(!dense(state.candidates)||state.candidates.some(c=>!own(c,['pr','head','observedHead','base','checks','approval','threads','authority'])||!positive(c.pr)||!sha(c.head)||!sha(c.observedHead)||!sha(c.base))||new Set(state.candidates.map(c=>c.pr)).size!==state.candidates.length) return blocked('INVALID_CANDIDATES');
 const c=state.candidates.find(c=>c.head===c.observedHead&&c.base===state.main&&c.checks===true&&c.approval===true&&c.threads===true&&c.authority===true);
 if(!c) return blocked('NO_ELIGIBLE_CANDIDATE');
 return {...blocked('SHADOW_NEXT'),pr:c.pr,expectedHead:c.head,expectedBase:c.base,method:'squash'};
}

import {types} from 'node:util';
const data=(o,keys)=>o!==null&&typeof o==='object'&&!types.isProxy(o)&&!Array.isArray(o)&&keys.every(k=>Object.hasOwn(Object.getOwnPropertyDescriptor(o,k)??{},'value'));
const queueBlocked=reason=>({shadow:true,liveMerge:false,reason});
// An explicit GraphQL enqueue operation, never a direct merge or queue jump.
// Returns inert request data only; no transport or live mutation is possible.
export function queueAdapter(intent,fresh){
 if(!data(intent,['pr','expectedHead','expectedBase'])||!positive(intent.pr)||!sha(intent.expectedHead)||!sha(intent.expectedBase))return queueBlocked('INTENT_UNKNOWN');
 if(!data(fresh,['pr','id','repository','head','base','branch','open','draft','queueRequired','authority','checks','review','threads','security','coverage','mainHealthy','stop','queued']))return queueBlocked('EVIDENCE_UNKNOWN');
 if(fresh.stop!==false||fresh.repository!=='Jamula/SoftwareFactory'||fresh.branch!=='main'||fresh.pr!==intent.pr||fresh.head!==intent.expectedHead||fresh.base!==intent.expectedBase)return queueBlocked('SCOPE_OR_HEAD_CHANGED');
 if(fresh.open!==true||fresh.draft!==false)return queueBlocked('CANDIDATE_NOT_READY');
 if(fresh.queued===true)return queueBlocked('ALREADY_QUEUED');
 if(fresh.queued!==false||[fresh.queueRequired,fresh.authority,fresh.checks,fresh.review,fresh.threads,fresh.security,fresh.coverage,fresh.mainHealthy].some(x=>x!==true)||typeof fresh.id!=='string'||!/^PR_[A-Za-z0-9_-]{1,100}$/.test(fresh.id))return queueBlocked('GATES_UNKNOWN');
 return {...queueBlocked('SHADOW_QUEUE_INTENT'),request:{
  query:'mutation Enqueue($id: ID!, $head: GitObjectID!) { enqueuePullRequest(input: {pullRequestId: $id, expectedHeadOid: $head, jump: false}) { mergeQueueEntry { id } } }',
  variables:{id:fresh.id,head:intent.expectedHead}
 }};
}
