const stages=new Set(['reconcile','dispatch','ci','review','merge','verify-main','acceptance']);
const positive=n=>Number.isSafeInteger(n)&&n>0;
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const own=(v,k)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&k.every(x=>Object.hasOwn(v,x));
const dense=a=>Array.isArray(a)&&Object.keys(a).length===a.length&&Array.from({length:a.length},(_,i)=>Object.hasOwn(a,i)).every(Boolean);
const unknown=reason=>({state:'unknown',reason,sampleCount:0,p50:null,p95:null});
export function aggregateStage(rows,q) {
 if(!own(q,['repositoryId','stage','from','to','complete','source','observedMs','nowMs','maxAgeMs'])||!positive(q.repositoryId)||!stages.has(q.stage)||!integer(q.from)||!integer(q.to)||q.from>=q.to||q.complete!==true||q.source!=='synthetic') return unknown('SCOPE_UNKNOWN');
 if(!integer(q.observedMs)||!integer(q.nowMs)||!positive(q.maxAgeMs)||q.observedMs<q.to||q.observedMs>q.nowMs) return unknown('FRESHNESS_UNKNOWN');
 if(q.nowMs-q.observedMs>q.maxAgeMs) return unknown('STALE_EVIDENCE');
 if(!Array.isArray(rows)||rows.length>10000||!dense(rows)) return unknown('INVALID_ROWS');
 const seen=new Set(),durations=[];
 for(const r of rows){
   if(!own(r,['id','repositoryId','stage','at','duration','source'])||typeof r.id!=='string'||! /^[a-zA-Z0-9-]{1,80}$/.test(r.id)||r.repositoryId!==q.repositoryId||!stages.has(r.stage)||!integer(r.at)||!integer(r.duration)||r.source!==q.source) return unknown('INVALID_ROW');
   if(seen.has(r.id)) return unknown('DUPLICATE_EVIDENCE');
   seen.add(r.id);
   if(r.stage===q.stage&&r.at>=q.from&&r.at<q.to) durations.push(r.duration);
 }
 if(!durations.length) return unknown('NO_SAMPLES');
 durations.sort((a,b)=>a-b);
 const percentile=p=>durations[Math.ceil(p*durations.length)-1];
 return {state:'synthetic',reason:'MEASURED_FIXTURE',sampleCount:durations.length,p50:percentile(.5),p95:percentile(.95)};
}
