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
