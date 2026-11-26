import {budgetDecision} from './budget.mjs';

// Advisory only: an independently verified provider ceiling is not authorization.
// No reservation, dispatch or configuration mutation is performed.
const tiers=[1,2,4];
const nonnegative=n=>Number.isSafeInteger(n)&&n>=0;
const positive=n=>nonnegative(n)&&n>0;
const result=(reason,nextLimit=null)=>({shadow:true,liveDispatch:false,reason,nextLimit});
export function recommendShadowScale(e){
  if(!e||e.stop!==false)return result('STOPPED');
  if(!positive(e.repositoryId)||e.repositoryId!==e.approvedRepositoryId||
      e.independentEvidence!==true||!tiers.includes(e.currentLimit))
    return result('SCOPE_UNKNOWN');
  const budget=budgetDecision(e.budget);
  if(budget.reason!=='SHADOW_CAPACITY')return result(budget.reason);
  if(!positive(e.verifiedProviderLimit)||e.budget.maxActive!==e.verifiedProviderLimit||
      e.budget.active>e.currentLimit||e.currentLimit>e.verifiedProviderLimit)
    return result('PROVIDER_LIMIT_UNKNOWN');
  if(!nonnegative(e.observedPeak)||e.observedPeak!==e.currentLimit||
      !positive(e.beforeWindowMs)||e.beforeWindowMs!==e.afterWindowMs||
      !nonnegative(e.beforeAccepted)||!nonnegative(e.afterAccepted)||
      e.beforeAccepted<5||e.afterAccepted<5)
    return result('EXPERIMENT_EVIDENCE_UNKNOWN');
  if(e.qualityClear!==true||e.mainHealthy!==true||e.costVerified!==true||
      e.extraCost!==0||e.duplicateDispatches!==0||e.unauthorizedWrites!==0)
    return result('SAFETY_OR_COST_UNKNOWN');
  if(e.afterAccepted<=e.beforeAccepted)return result('NO_MEASURED_GAIN');
  const next=tiers[tiers.indexOf(e.currentLimit)+1];
  if(next===undefined)return result('LADDER_COMPLETE');
  if(next>e.verifiedProviderLimit||next-e.budget.active>budget.available)
    return result('CAPACITY_INSUFFICIENT');
  return result('SHADOW_SCALE_RECOMMENDED',next);
}
