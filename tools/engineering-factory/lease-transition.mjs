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
 if(request.kind!=='acquire'||!Object.hasOwn(request,'ttl')||!positive(request.ttl)||request.ttl>120000||!Number.isSafeInteger(now+request.ttl)||!Number.isSafeInteger(generation+1)) return deny('INVALID_REQUEST');
 if(lease!==null&&lease.expires>now) return deny('HELD');
 return {shadow:true,changed:true,reason:'ACQUIRED',lease:{worker:request.worker,generation:generation+1,expires:now+request.ttl}};
}

/** Local durable shadow lease store. Caller must supply a private local path.
 * BEGIN IMMEDIATE serializes competing processes; generation survives restart.
 * Never stores credentials, issue text or authorization to dispatch.
 */
import {DatabaseSync} from 'node:sqlite';
export function openLeaseStore(path) {
 const db=new DatabaseSync(path);
 db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS shadow_leases (scope TEXT PRIMARY KEY, worker TEXT NOT NULL, generation INTEGER NOT NULL, expires INTEGER NOT NULL)');
 const read=db.prepare('SELECT worker,generation,expires FROM shadow_leases WHERE scope=?');
 const write=db.prepare('INSERT INTO shadow_leases(scope,worker,generation,expires) VALUES(?,?,?,?) ON CONFLICT(scope) DO UPDATE SET worker=excluded.worker,generation=excluded.generation,expires=excluded.expires');
 return {
  apply(scope,request,now){
   if(typeof scope!=='string'||!/^[1-9][0-9]{0,15}:[1-9][0-9]{0,15}:[a-f0-9]{40}$/.test(scope))return deny('INVALID_SCOPE');
   try {
    db.exec('BEGIN IMMEDIATE');
   } catch { return deny('STORE_UNAVAILABLE'); }
   try {
    const row=read.get(scope);
    const result=leaseTransition(row??null,request,now);
    if(result.changed)write.run(scope,result.lease.worker,result.lease.generation,result.lease.expires);
    db.exec('COMMIT');
    return result;
   } catch {
    // SQLite may already have rolled back, or the connection may be unavailable.
    try { db.exec('ROLLBACK'); } catch {}
    return deny('STORE_UNAVAILABLE');
   }
  },
  close(){db.close();}
 };
}
