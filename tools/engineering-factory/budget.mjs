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
