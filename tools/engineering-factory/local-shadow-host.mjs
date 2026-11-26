import {createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {openEventJournal,reconcileJournalOnce} from '../engineering-coordinator/event-journal.mjs';
import {readInventory} from './shadow-runtime.mjs';
import {readPullIdentity} from './event-envelope.mjs';

const repositoryId=1471342715;
const intervalMs=600000;
const receipt=(reason,extra={})=>({shadow:true,liveDispatch:false,liveMerge:false,reason,...extra});
const isIdentity=(p,number)=>p?.reason==='IDENTITY_ONLY'&&p.repositoryId===repositoryId&&p.number===number;

// One bounded read-only recovery pass. The production adapters can only GET
// public SoftwareFactory metadata. The journal is durable, not authority.
export async function localReconcileTick({journal,owner,clock=Date.now,request=fetch}){
 let requests=0;
 const budgeted=(url,options)=>{
  if(++requests>8)throw Error('LOCAL_READ_BUDGET');
  return request(url,options);
 };
 const read=async ticket=>{
  if(ticket.kind!=='pull')return null;
  const p=await readPullIdentity(ticket.subject,budgeted);
  return isIdentity(p,ticket.subject)?{shadow:true,fresh:true,repositoryId,kind:'pull',subject:ticket.subject,head:p.head}:null;
 };
 try{
  // Recover an outstanding claim before ingesting a new hint. Never advance
  // past a failed claim; its lease remains available for later recovery.
  const recovery=await reconcileJournalOnce({journal,repositoryId,owner,leaseMs:30000,clock,read,stop:false});
  if(recovery.reason!=='NO_CLAIM')return receipt(recovery.reason);
  const inventory=await readInventory(budgeted);
  if(!inventory.pulls.length)return receipt('NO_OPEN_PULLS');
  // Rotate the bounded one-PR poll, rather than exhaust the public API on
  // large inventories. This is not a complete approval/check inventory.
  const now=clock();
  if(!Number.isSafeInteger(now)||now<0)return receipt('CLOCK_UNKNOWN');
  const number=inventory.pulls[Math.floor(now/intervalMs)%inventory.pulls.length];
  const p=await readPullIdentity(number,budgeted);
  if(!isIdentity(p,number))return receipt('IDENTITY_UNKNOWN');
  const deliveryId=createHash('sha256').update(JSON.stringify([repositoryId,number,p.head,p.base,p.state,p.draft])).digest('hex');
  const queued=journal.enqueue({repositoryId,deliveryId,kind:'pull',subject:number,head:p.head});
  if(!queued.queued)return receipt(queued.reason);
  const reconciled=await reconcileJournalOnce({journal,repositoryId,owner,leaseMs:30000,clock,read,stop:false});
  return receipt(reconciled.reason);
 }catch{return receipt('LOCAL_POLL_UNAVAILABLE');}
}

// Explicit opt-in on an owner-managed host, with an owner-controlled durable
// database path. The loop does not launch workers, set repository variables,
// authorize writes, install a service, or provision resources.
export async function runLocalShadowHost({enabled,path,owner,signal,clock=Date.now,request=fetch,write=console.log,wait=sleep,open=openEventJournal}){
 if(enabled!==true)return receipt('STOPPED');
 let journal;
 try{
  journal=open(path);
  while(!signal.aborted){
   write(JSON.stringify(await localReconcileTick({journal,owner,clock,request})));
   if(signal.aborted)break;
   await wait(intervalMs,undefined,{signal});
  }
  return receipt('STOPPED');
 }catch{return receipt(signal.aborted?'STOPPED':'LOCAL_HOST_UNAVAILABLE');}
 finally{journal?.close();}
}
