import {createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {openEventJournal,reconcileJournalOnce} from '../engineering-coordinator/event-journal.mjs';
import {readPullIdentity} from './event-envelope.mjs';

const repositoryId=1471342715;
const intervalMs=600000;
const receipt=(reason,extra={})=>({shadow:true,liveDispatch:false,liveMerge:false,reason,...extra});
const isIdentity=(p,number)=>p?.reason==='IDENTITY_ONLY'&&p.repositoryId===repositoryId&&p.number===number;

// Read at most one PR-only page each tick. Identity reads have their own
// reserved budget; unrelated issues cannot consume it. Cursor is advisory,
// never grants authority, and can restart at page one after host restart.
async function readPage(request,page){
 const response=await request('https://api.github.com/repos/Jamula/SoftwareFactory/pulls?state=open&sort=created&direction=asc&per_page=1&page='+page,{method:'GET',redirect:'error',signal:AbortSignal.timeout(5000),headers:{accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}});
 if(!response.ok||!response.body)throw Error('PULL_PAGE_UNAVAILABLE');
 const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});
 let raw='',bytes=0;
 try{
  for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>524288)throw Error('PULL_PAGE_LIMIT');raw+=decoder.decode(value,{stream:true});}
  raw+=decoder.decode();
 }finally{await reader.cancel().catch(()=>{});}
 const rows=JSON.parse(raw);
 if(!Array.isArray(rows)||rows.length>1||rows.some(r=>!Number.isSafeInteger(r?.number)||r.number<1))throw Error('PULL_PAGE_INVALID');
 return rows;
}

// One bounded read-only recovery pass. At most three GETs (page, identity,
// reconciliation) or one recovery GET. No mutation after cancellation.
export async function localReconcileTick({journal,owner,clock=Date.now,request=fetch,signal=new AbortController().signal,cursor={page:1}}){
 const stopped=()=>signal.aborted;
 const budgeted=(url,options)=>{
  signal.throwIfAborted();
  return request(url,{...options,signal:AbortSignal.any([options.signal,signal])});
 };
 const guarded={
  claim(...args){signal.throwIfAborted();return journal.claim(...args,'pull');},
  complete(...args){signal.throwIfAborted();return journal.complete(...args);}
 };
 const read=async ticket=>{
  if(ticket.kind!=='pull')return null;
  const p=await readPullIdentity(ticket.subject,budgeted);
  return isIdentity(p,ticket.subject)?{shadow:true,fresh:true,repositoryId,kind:'pull',subject:ticket.subject,head:p.head}:null;
 };
 try{
  signal.throwIfAborted();
  const recovery=await reconcileJournalOnce({journal:guarded,repositoryId,owner,leaseMs:30000,clock,read,stop:false});
  signal.throwIfAborted();
  if(recovery.reason!=='NO_CLAIM')return receipt(recovery.reason);
  const now=clock();
  if(!Number.isSafeInteger(now)||now<0)return receipt('CLOCK_UNKNOWN');
  const rows=await readPage(budgeted,cursor.page);
  signal.throwIfAborted();
  if(!rows.length){
   const reason=cursor.page===1?'NO_OPEN_PULLS':'SWEEP_COMPLETE';
   cursor.page=1;return receipt(reason);
  }
  const number=rows[0].number;
  const p=await readPullIdentity(number,budgeted);
  signal.throwIfAborted();
  cursor.page++;
  if(!isIdentity(p,number))return receipt('IDENTITY_UNKNOWN');
  const deliveryId=createHash('sha256').update(JSON.stringify([repositoryId,number,p.head,p.base,p.state,p.draft])).digest('hex');
  const queued=journal.enqueue({repositoryId,deliveryId,kind:'pull',subject:number,head:p.head});
  if(!queued.queued)return receipt(queued.reason);
  const reconciled=await reconcileJournalOnce({journal:guarded,repositoryId,owner,leaseMs:30000,clock,read,stop:false});
  signal.throwIfAborted();
  return receipt(reconciled.reason);
 }catch{return receipt(stopped()?'STOPPED':'LOCAL_POLL_UNAVAILABLE');}
}

// Explicit opt-in on an owner-managed host, with an owner-controlled durable
// database path. The loop does not launch workers, set repository variables,
// authorize writes, install a service, or provision resources.
export async function runLocalShadowHost({enabled,path,owner,signal,clock=Date.now,request=fetch,write=console.log,wait=sleep,open=openEventJournal}){
 if(enabled!==true||signal.aborted)return receipt('STOPPED');
 let journal;
 try{
  journal=open(path);
  const cursor={page:1};
  while(!signal.aborted){
   write(JSON.stringify(await localReconcileTick({journal,owner,clock,request,signal,cursor})));
   if(signal.aborted)break;
   await wait(intervalMs,undefined,{signal});
  }
  return receipt('STOPPED');
 }catch{return receipt(signal.aborted?'STOPPED':'LOCAL_HOST_UNAVAILABLE');}
 finally{journal?.close();}
}
