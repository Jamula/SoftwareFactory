import {types} from 'node:util';

const kinds=new Set(['issue','pull','review','check','main','manual']);
const positive=n=>Number.isSafeInteger(n)&&n>0;
const sha=s=>typeof s==='string'&&/^[a-f0-9]{40}$/.test(s);
const own=(v,keys)=>v!==null&&typeof v==='object'&&!types.isProxy(v)&&!Array.isArray(v)&&keys.every(k=>Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)??{},'value'));
const deny=reason=>({shadow:true,accepted:false,reason});
export function eventEnvelope(event,trust,now) {
 if(!own(trust,['repositoryId','workflowSha'])||!positive(trust.repositoryId)||!sha(trust.workflowSha)) return deny('TRUST_UNKNOWN');
 if(!own(event,['repositoryId','workflowSha','deliveryId','kind','head','receivedMs'])||
    !positive(event.repositoryId)||!sha(event.workflowSha)||!sha(event.head)||
    typeof event.deliveryId!=='string'||! /^[a-zA-Z0-9-]{1,80}$/.test(event.deliveryId)||
    !kinds.has(event.kind)||!Number.isSafeInteger(event.receivedMs)||event.receivedMs<0) return deny('INVALID_EVENT');
 if(event.repositoryId!==trust.repositoryId||event.workflowSha!==trust.workflowSha) return deny('PROVENANCE_MISMATCH');
 if(!Number.isSafeInteger(now)||now<event.receivedMs||now-event.receivedMs>120000) return deny('STALE_EVENT');
 return {shadow:true,accepted:true,reason:'NORMALIZED_ONLY',repositoryId:event.repositoryId,kind:event.kind,head:event.head,deliveryId:event.deliveryId,receivedMs:event.receivedMs};
}

/** Public, read-only metadata adapter; does not imply authoritative approval or complete evidence. */
export async function readPullIdentity(number,request=fetch){
 const blocked=reason=>({shadow:true,evidenceComplete:false,reason});
 if(!positive(number))return blocked('INVALID_PULL');
 try{
  const response=await request('https://api.github.com/repos/Jamula/SoftwareFactory/pulls/'+number,{method:'GET',redirect:'error',signal:AbortSignal.timeout(5000),headers:{accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}});
  if(response.status===429||response.status===403)return blocked('RATE_OR_PERMISSION_UNKNOWN');
  if(!response.ok||!response.body)return blocked('READ_FAILED');
  const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let raw='',bytes=0;
  try{
   for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>524288)return blocked('RESPONSE_LIMIT');raw+=decoder.decode(value,{stream:true});}
   raw+=decoder.decode();
  }finally{await reader.cancel();}
  const p=JSON.parse(raw);
  if(p?.number!==number||p?.base?.repo?.full_name!=='Jamula/SoftwareFactory'||p?.head?.repo?.full_name!=='Jamula/SoftwareFactory'||p.base.ref!=='main'||!sha(p.base.sha)||!sha(p.head.sha)||!positive(p.base.repo.id)||p.head.repo.id!==p.base.repo.id||!['open','closed'].includes(p.state)||typeof p.draft!=='boolean')return blocked('IDENTITY_UNKNOWN');
  return {...blocked('IDENTITY_ONLY'),repositoryId:p.base.repo.id,number,head:p.head.sha,base:p.base.sha,state:p.state,draft:p.draft};
 }catch{return blocked('READ_FAILED');}
}

const repositoryId = 1471342715;
const workflowRef = 'Jamula/SoftwareFactory/.github/workflows/shadow-reconcile.yml@refs/heads/main';
const blockedPull = reason => ({shadow: true, evidenceComplete: false, reconciled: false, reason});

/** Bind one protected-base Actions trigger to a fresh, same-repository public PR read. */
export async function reconcilePullTrigger(env, {clock = Date.now, readIdentity = readPullIdentity} = {}) {
  const workflowSha = env.GITHUB_WORKFLOW_SHA;
  if (env.GITHUB_EVENT_NAME !== 'pull_request_target' || env.GITHUB_REPOSITORY_ID !== String(repositoryId) ||
      env.GITHUB_WORKFLOW_REF !== workflowRef || env.GITHUB_REF_PROTECTED !== 'true' ||
      !sha(workflowSha) || env.GITHUB_SHA !== workflowSha || env.FACTORY_CHECKOUT_SHA !== workflowSha) {
    return blockedPull('TRUST_UNKNOWN');
  }
  const numberText = env.FACTORY_PULL_NUMBER;
  if (typeof numberText !== 'string' || !/^[1-9][0-9]{0,15}$/.test(numberText) || !positive(Number(numberText))) {
    return blockedPull('INVALID_PULL');
  }
  const number = Number(numberText);
  const startedAt = clock();
  const event = {
    repositoryId, workflowSha, kind: 'pull', head: env.FACTORY_PULL_HEAD,
    deliveryId: env.GITHUB_RUN_ID, receivedMs: startedAt
  };
  const trust = {repositoryId, workflowSha};
  const observed = eventEnvelope(event, trust, startedAt);
  if (!observed.accepted) return blockedPull(observed.reason);
  let current;
  try { current = await readIdentity(number); }
  catch { return blockedPull('READ_FAILED'); }
  const finishedAt = clock();
  if (!eventEnvelope(event, trust, finishedAt).accepted) return blockedPull('STALE_EVENT');
  if (!own(current, ['reason']) || current.reason !== 'IDENTITY_ONLY') {
    const reason = own(current, ['reason']) && current.reason === 'RATE_OR_PERMISSION_UNKNOWN' ?
      'RATE_OR_PERMISSION_UNKNOWN' : 'READ_FAILED';
    return blockedPull(reason);
  }
  if (!own(current, ['repositoryId', 'number', 'head', 'base', 'state', 'draft']) ||
      current.repositoryId !== repositoryId || current.number !== number ||
      !sha(current.head) || !sha(current.base) || !['open', 'closed'].includes(current.state) ||
      typeof current.draft !== 'boolean') return blockedPull('IDENTITY_UNKNOWN');
  if (current.head !== observed.head) return blockedPull('HEAD_CHANGED');
  return {
    shadow: true, evidenceComplete: false, reconciled: true, reason: 'PULL_IDENTITY_MATCHED',
    repositoryId, number, head: current.head, base: current.base, state: current.state, draft: current.draft,
    workflowSha, runId: observed.deliveryId, observedMs: finishedAt - startedAt
  };
}
