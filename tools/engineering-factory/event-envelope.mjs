const kinds=new Set(['issue','pull','review','check','main','manual']);
const positive=n=>Number.isSafeInteger(n)&&n>0;
const sha=s=>typeof s==='string'&&/^[a-f0-9]{40}$/.test(s);
const own=(v,keys)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&keys.every(k=>Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)??{},'value'));
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
