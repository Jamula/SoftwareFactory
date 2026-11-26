// Pure advisory evaluation; never an authorization or provider reservation.
export function budgetDecision(e) {
  const result=(reason,available=0)=>({shadow:true,liveDispatch:false,reason,available});
  if (!e || e.stop!==false) return result('STOPPED');
  if (e.includedOnly!==true || e.overageDisabled!==true || e.authorityVerified!==true)
    return result('BUDGET_UNKNOWN');
  if (!Number.isSafeInteger(e.nowMs) || !Number.isSafeInteger(e.observedMs) ||
      e.observedMs<0 || e.nowMs<e.observedMs || e.nowMs-e.observedMs>60000)
    return result('STALE_QUOTA');
  if (![e.remaining,e.reserved,e.active,e.maxActive,e.unitsPerRun].every(n=>Number.isSafeInteger(n)&&n>=0) ||
      e.unitsPerRun===0 || e.maxActive===0 || e.active>e.maxActive || e.reserved>e.remaining)
    return result('INVALID_QUOTA');
  const available=Math.min(e.maxActive-e.active,Math.floor((e.remaining-e.reserved)/e.unitsPerRun));
  return result(available?'SHADOW_CAPACITY':'CAPACITY_EXHAUSTED',available);
}

// Synthetic allocation only. Inputs are normalized fixtures, not billing credentials.
// Candidate order is supplied by the dependency-aware planner.
export function allocateShadowCapacity(e, scopes, candidates) {
 const denied=reason=>({shadow:true,liveDispatch:false,reason,selected:[]});
 const decision=budgetDecision(e);
 if(decision.reason!=='SHADOW_CAPACITY')return denied(decision.reason);
 const positive=n=>Number.isSafeInteger(n)&&n>0;
 const dense=a=>Array.isArray(a)&&a.length<=250&&Array.from({length:a.length},(_,i)=>Object.hasOwn(a,i)).every(Boolean);
 if(!dense(scopes)||!dense(candidates)||!scopes.length)return denied('SCOPE_UNKNOWN');
 const caps=new Map();
 // Subtract rather than sum: each count is safe, but an aggregate could overflow.
 let unaccountedActive=e.active;
 for(const scope of scopes){
  if(!scope||!positive(scope.repositoryId)||!positive(scope.maxActive)||
     !Number.isSafeInteger(scope.active)||scope.active<0||scope.active>scope.maxActive||
     caps.has(scope.repositoryId))return denied('SCOPE_UNKNOWN');
  if(scope.active>unaccountedActive)return denied('SCOPE_UNKNOWN');
  unaccountedActive-=scope.active;
  caps.set(scope.repositoryId,scope.maxActive-scope.active);
 }
 const seen=new Set();
 for(const c of candidates){
  if(!c||!caps.has(c.repositoryId)||!positive(c.issue)||
     typeof c.head!=='string'||! /^[a-f0-9]{40}$/.test(c.head))return denied('CANDIDATE_UNKNOWN');
  const key=[c.repositoryId,c.issue].join(':');
  if(seen.has(key))return denied('DUPLICATE_CANDIDATE');
  seen.add(key);
 }
 const selected=[];
 for(const c of candidates){
  if(selected.length===decision.available)break;
  const left=caps.get(c.repositoryId);
  if(left===0)continue;
  selected.push({repositoryId:c.repositoryId,issue:c.issue,head:c.head});
  caps.set(c.repositoryId,left-1);
 }
 return {shadow:true,liveDispatch:false,reason:selected.length?'SHADOW_ALLOCATION':'NO_SCOPED_CAPACITY',selected};
}
