const positive=n=>Number.isSafeInteger(n)&&n>0;
const token=s=>typeof s==='string'&&/^[a-zA-Z0-9-]{1,80}$/.test(s);
const own=(v,k)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&k.every(x=>Object.hasOwn(v,x));
const deny=reason=>({shadow:true,changed:false,reason});
export function leaseTransition(lease,request,now) {
 if(!own(request,['kind','worker','generation','stop'])||!token(request.worker)||!Number.isSafeInteger(request.generation)||request.generation<0||!Number.isSafeInteger(now)||now<0) return deny('INVALID_REQUEST');
 if(request.stop!==false) return deny('STOPPED');
 if(lease!==null&&(!own(lease,['worker','generation','expires'])||!token(lease.worker)||!positive(lease.generation)||!Number.isSafeInteger(lease.expires)||lease.expires<0)) return deny('INVALID_LEASE');
 const generation=lease===null?0:lease.generation;
 if(request.generation!==generation) return deny('STALE_GENERATION');
 if(request.kind==='release'){
   if(lease===null||lease.worker!==request.worker||lease.expires<=now) return deny('NOT_HELD');
   return {shadow:true,changed:true,reason:'RELEASED',lease:{...lease,expires:now}};
 }
 if(request.kind!=='acquire'||!positive(request.ttl)||request.ttl>120000||!Number.isSafeInteger(now+request.ttl)||!Number.isSafeInteger(generation+1)) return deny('INVALID_REQUEST');
 if(lease!==null&&lease.expires>now) return deny('HELD');
 return {shadow:true,changed:true,reason:'ACQUIRED',lease:{worker:request.worker,generation:generation+1,expires:now+request.ttl}};
}
