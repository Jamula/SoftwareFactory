// Shadow scheduling and public metadata inventory. No mutation, agent dispatch or merge.
import {types} from 'node:util';
import {
  exportJournalSnapshot,
  importJournalSnapshot,
  openEventJournal,
  reconcileJournalOnce
} from '../engineering-coordinator/event-journal.mjs';
import {
  createScopedJournalReader,
  ownOptional,
  readMainIdentity,
  readOwn,
  readPullIdentity,
  reconcileEventTrigger,
  resolveTrustedScope,
  verifyWorkflowProvenance
} from './event-envelope.mjs';

const deny = reason => ({shadow:true, ready:[], reason});
const blockedInventory = reason => ({
  shadow:true, evidenceComplete:false, liveDispatch:false, liveMerge:false, reason
});
const blockedOrchestratorEval = reason => ({
  shadow:true, evidenceComplete:false, reconciled:false, liveDispatch:false, liveMerge:false, reason, snapshot:null
});
const DEFAULT_SCOPE = resolveTrustedScope({});
const SCOPE_KEYS = new Set(['repository','repositoryId','branch','workflowPath']);
const INVENTORY_OPTION_KEYS = new Set(['scope',...SCOPE_KEYS]);
const ORCHESTRATOR_EVAL_OPTION_KEYS = new Set([
  'scope',...SCOPE_KEYS,'request','clock','snapshot','maxRecoveryItems'
]);
const ORCHESTRATOR_EVENTS = new Set([
  'schedule','workflow_dispatch','issues','pull_request_target','workflow_run','push'
]);
const DEFAULT_RECOVERY_RETRY_MS = 3600000;

function isStrictPlainMap(value, allowedKeys) {
  if(value===null || typeof value!=='object' || types.isProxy(value) || Array.isArray(value) ||
     value===process.env ||
     (Object.getPrototypeOf(value)!==Object.prototype && Object.getPrototypeOf(value)!==null)) {
    return false;
  }
  for(const key of Reflect.ownKeys(value)) {
    if(typeof key!=='string' || !allowedKeys.has(key)) return false;
    const desc=Object.getOwnPropertyDescriptor(value,key);
    if(!desc || !desc.enumerable || !Object.hasOwn(desc,'value')) return false;
  }
  return true;
}

function resolveInventoryScope(options) {
  if(!isStrictPlainMap(options,INVENTORY_OPTION_KEYS)) return null;
  if(options.scope!==undefined) {
    if(!isStrictPlainMap(options.scope,SCOPE_KEYS)) return null;
    for(const key of SCOPE_KEYS) {
      if(options[key]!==undefined && options[key]!==options.scope[key]) return null;
    }
  }
  const resolved=resolveTrustedScope(options);
  if(!resolved) return null;
  const isDefaultName=resolved.repository.toLowerCase()===DEFAULT_SCOPE.repository.toLowerCase();
  const isDefaultId=resolved.repositoryId===DEFAULT_SCOPE.repositoryId;
  if(isDefaultName!==isDefaultId || (isDefaultId && resolved.repository!==DEFAULT_SCOPE.repository)) {
    return null;
  }
  return resolved;
}
const dense = a => Array.isArray(a) && Object.keys(a).length===a.length &&
  Array.from({length:a.length},(_,i)=>Object.hasOwn(a,i)).every(Boolean);
const positive = n => Number.isSafeInteger(n) && n > 0;
const pathOk = p => typeof p === 'string' && /^[a-zA-Z0-9_. /-]+$/.test(p) &&
  !p.split('/').some(s => !s || s === '.' || s === '..');
const overlap = (a,b) => a===b || a.startsWith(b+'/') || b.startsWith(a+'/');

export function plan(input) {
  if (!input || input.enabled!==true || input.stop!==false) return deny('STOPPED');
  if (!positive(input.capacity) || input.capacity>50 || input.quotaVerified!==true)
    return deny('CAPACITY_UNKNOWN');
  if (!dense(input.tasks) || input.tasks.length>250) return deny('INVALID_TASKS');
  const tasks=input.tasks;
  if (tasks.some(t=>!t || !positive(t.id) || !Number.isSafeInteger(t.priority) ||
      t.priority<0 || t.priority>100 || !['approved','active','accepted','pending'].includes(t.state) ||
      !dense(t.dependencies) || t.dependencies.some(d=>!positive(d)) ||
      new Set(t.dependencies).size!==t.dependencies.length ||
      !dense(t.paths) || !t.paths.length || !t.paths.every(pathOk))) return deny('INVALID_TASKS');
  const byId=new Map(tasks.map(t=>[t.id,t]));
  if (byId.size!==tasks.length || tasks.some(t=>t.dependencies.some(d=>!byId.has(d))))
    return deny('UNKNOWN_DEPENDENCY');
  const visited=new Set(), visiting=new Set();
  function visit(id) {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    if (!byId.get(id).dependencies.every(visit)) return false;
    visiting.delete(id);visited.add(id);return true;
  }
  if (!tasks.every(t=>visit(t.id))) return deny('DEPENDENCY_CYCLE');
  function descendants(id) {
    const seen=new Set();
    function walk(n) {
      for(const t of tasks) if(t.dependencies.includes(n)&&!seen.has(t.id)) {
        seen.add(t.id);walk(t.id);
      }
    }
    walk(id);return seen.size;
  }
  const active=tasks.filter(t=>t.state==='active');
  const owned=[];
  for(const t of active) {
    if(t.paths.some(p=>owned.some(o=>overlap(p,o)))) return deny('ACTIVE_OWNERSHIP_CONFLICT');
    owned.push(...t.paths);
  }
  const free=Math.max(0,input.capacity-active.length);
  const candidates=tasks.filter(t=>t.state==='approved' &&
    t.dependencies.every(d=>byId.get(d).state==='accepted'))
    .map(t=>({...t,weight:descendants(t.id)}))
    .sort((a,b)=>a.priority-b.priority||b.weight-a.weight||a.id-b.id);
  const ready=[];
  for(const t of candidates) {
    if(ready.length>=free) break;
    if(t.paths.some(p=>owned.some(o=>overlap(p,o)))) continue;
    ready.push(t.id);owned.push(...t.paths);
  }
  return {shadow:true,ready,reason:ready.length?'SHADOW_PLAN':'NO_READY_WORK'};
}

async function boundedJson(response) {
  if(!response.ok || !response.body) throw new Error('GITHUB_READ_FAILED');
  const reader=response.body.getReader();
  const decoder=new TextDecoder('utf-8',{fatal:true});
  let bytes=0,raw='';
  try {
    while(true) {
      const {done,value}=await reader.read();
      if(done) break;
      bytes+=value.byteLength;
      if(bytes>2*1024*1024) throw new Error('GITHUB_RESPONSE_LIMIT');
      raw+=decoder.decode(value,{stream:true});
    }
    raw+=decoder.decode();
    return JSON.parse(raw);
  } finally {
    await reader.cancel().catch(()=>{});
  }
}
export async function readInventory(request=fetch,options={}) {
  if(typeof request!=='function') return blockedInventory('TRUST_UNKNOWN');
  const resolved=resolveInventoryScope(options);
  if(!resolved) return blockedInventory('TRUST_UNKNOWN');
  async function read(kind) {
    const ids=[];
    for(let page=1;page<=5;page++) {
      const response=await request(resolved.apiRoot+'/'+kind+'?state=open&per_page=100&page='+page,{
        method:'GET',redirect:'error',signal:AbortSignal.timeout(5000),
        headers:{accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}
      });
      const rows=await boundedJson(response);
      if(!dense(rows)||rows.length>100||rows.some(r=>!r||!positive(r.number)))
        throw new Error('GITHUB_INVALID_METADATA');
      for(const row of rows) {
        if(kind==='issues') {
          if(Object.hasOwn(row,'pull_request')) continue;
          if(Object.hasOwn(row,'repository_url') && row.repository_url!==resolved.apiRoot)
            throw new Error('GITHUB_INVALID_METADATA');
        } else if(Object.hasOwn(row,'base') &&
                  (row.base?.repo?.full_name!==resolved.repository ||
                   row.base?.repo?.id!==resolved.repositoryId)) {
          throw new Error('GITHUB_INVALID_METADATA');
        }
        if(ids.includes(row.number)) throw new Error('GITHUB_DUPLICATE_METADATA');
        ids.push(row.number);
      }
      if(rows.length<100) return ids.sort((a,b)=>a-b);
    }
    throw new Error('GITHUB_INVENTORY_LIMIT');
  }
  const [issues,pulls]=await Promise.all([read('issues'),read('pulls')]);
  return {shadow:true,repository:resolved.repository,repositoryId:resolved.repositoryId,issues,pulls,
    evidenceComplete:false,liveDispatch:false,liveMerge:false};
}
export function smoke() {
  return plan({enabled:true,stop:false,capacity:2,quotaVerified:true,tasks:[
    {id:1,priority:0,state:'approved',dependencies:[],paths:['src/api']},
    {id:2,priority:1,state:'approved',dependencies:[],paths:['src/web']},
    {id:3,priority:0,state:'approved',dependencies:[1],paths:['src/integration']}
  ]});
}

export async function reconcileShadowOrchestratorRun(env,options={}) {
  if(!ownOptional(env,['GITHUB_EVENT_NAME','GITHUB_REPOSITORY','FACTORY_EXPECTED_WORKFLOW_PATH','FACTORY_ISSUE_NUMBER']) ||
     !isStrictPlainMap(options,ORCHESTRATOR_EVAL_OPTION_KEYS)) {
    return blockedOrchestratorEval('TRUST_UNKNOWN');
  }
  const request=options.request??fetch;
  const clock=options.clock??Date.now;
  const maxRecoveryItems=options.maxRecoveryItems??10;
  if(typeof request!=='function' || typeof clock!=='function' ||
     !positive(maxRecoveryItems) || maxRecoveryItems>50) {
    return blockedOrchestratorEval('TRUST_UNKNOWN');
  }
  const scopeInput={};
  for(const key of INVENTORY_OPTION_KEYS) {
    if(options[key]!==undefined) scopeInput[key]=options[key];
  }
  const envWorkflowPath=readOwn(env,'FACTORY_EXPECTED_WORKFLOW_PATH');
  if(envWorkflowPath!==undefined && scopeInput.workflowPath===undefined && scopeInput.scope===undefined) {
    scopeInput.workflowPath=envWorkflowPath;
  }
  const resolved=resolveInventoryScope(scopeInput);
  if(!resolved || readOwn(env,'GITHUB_REPOSITORY')!==resolved.repository) {
    return blockedOrchestratorEval('TRUST_UNKNOWN');
  }
  const eventName=readOwn(env,'GITHUB_EVENT_NAME');
  if(!ORCHESTRATOR_EVENTS.has(eventName)) return blockedOrchestratorEval('TRUST_UNKNOWN');
  const workflowSha=verifyWorkflowProvenance(env,resolved,eventName,eventName!=='pull_request_target');
  if(!workflowSha) return blockedOrchestratorEval('TRUST_UNKNOWN');

  const explicitScope={
    repository:resolved.repository,
    repositoryId:resolved.repositoryId,
    branch:resolved.branch,
    workflowPath:resolved.workflowPath
  };
  const issueNumber=readOwn(env,'FACTORY_ISSUE_NUMBER','');
  const isHeartbeat=eventName==='schedule' || (eventName==='workflow_dispatch' && issueNumber==='');
  if(!isHeartbeat) {
    const raw=await reconcileEventTrigger(env,{
      scope:explicitScope,
      request,
      clock,
      ...(options.snapshot!==undefined?{snapshot:options.snapshot}:{})
    });
    const {snapshot:exportedSnapshot=null,...publicResult}=raw;
    return {...publicResult,snapshot:exportedSnapshot};
  }

  let now;
  try { now=clock(); } catch { return blockedOrchestratorEval('CLOCK_UNKNOWN'); }
  if(!Number.isSafeInteger(now) || now<0) return blockedOrchestratorEval('CLOCK_UNKNOWN');

  const store=openEventJournal(':memory:');
  try {
    if(options.snapshot!==undefined) {
      const imported=importJournalSnapshot(store,options.snapshot,{now});
      if(!imported.imported) return blockedOrchestratorEval(imported.reason);
    }
    let inv;
    try {
      inv=await readInventory(request,explicitScope);
    } catch {
      return blockedOrchestratorEval('READ_FAILED');
    }
    const priorEntries=exportJournalSnapshot(store,{repositoryId:resolved.repositoryId}).entries;
    if(inv.issues.length>0) {
      const mainId=await readMainIdentity(request,explicitScope);
      if(mainId.reason==='IDENTITY_ONLY') {
        for(const issueNum of inv.issues.slice(0,maxRecoveryItems)) {
          const seen=priorEntries.some(e=>e.kind==='issue' && e.subject===issueNum &&
            (e.completed || e.head===mainId.head));
          if(!seen) {
            store.enqueue({
              repositoryId:resolved.repositoryId,
              deliveryId:`recovery-issue-${issueNum}-${mainId.head.slice(0,12)}`,
              kind:'issue',
              subject:issueNum,
              head:mainId.head
            });
          }
        }
      }
    }
    for(const pullNum of inv.pulls.slice(0,maxRecoveryItems)) {
      const pullId=await readPullIdentity(pullNum,request,explicitScope);
      if(pullId.reason==='IDENTITY_ONLY') {
        const seen=priorEntries.some(e=>e.kind==='pull' && e.subject===pullNum && e.head===pullId.head);
        if(!seen) {
          store.enqueue({
            repositoryId:resolved.repositoryId,
            deliveryId:`recovery-pull-${pullNum}-${pullId.head.slice(0,12)}`,
            kind:'pull',
            subject:pullNum,
            head:pullId.head
          });
        }
      }
    }
    const reader=createScopedJournalReader(explicitScope,{request});
    const maxDrain=maxRecoveryItems*2+4;
    let recoveredCount=0;
    let deferredCount=0;
    for(let pass=0;pass<maxDrain;pass++) {
      const outcome=await reconcileJournalOnce({
        journal:store,
        repositoryId:resolved.repositoryId,
        owner:'github-actions-recovery',
        leaseMs:30000,
        clock,
        read:reader,
        stop:false,
        deferUnknown:(ticket,finished)=>store.defer(ticket,finished,DEFAULT_RECOVERY_RETRY_MS)
      });
      if(outcome.reason==='NO_CLAIM') break;
      if(outcome.reason==='SHADOW_RECONCILED' || outcome.reason==='SHADOW_HEAD_SUPERSEDED') {
        recoveredCount++;
      } else if(outcome.reason==='EVIDENCE_UNKNOWN') {
        deferredCount++;
      } else {
        break;
      }
    }
    const exported=exportJournalSnapshot(store,{repositoryId:resolved.repositoryId});
    return {
      shadow:true,
      evidenceComplete:false,
      reconciled:true,
      liveDispatch:false,
      liveMerge:false,
      reason:recoveredCount>0?'SHADOW_RECONCILED':'NO_CLAIM',
      repository:resolved.repository,
      repositoryId:resolved.repositoryId,
      issues:inv.issues,
      pulls:inv.pulls,
      recoveredCount,
      deferredCount,
      workflowSha,
      snapshot:exported
    };
  } finally {
    store.close();
  }
}
