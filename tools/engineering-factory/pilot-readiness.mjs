const sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
const id=x=>Number.isSafeInteger(x)&&x>0;
const own=(x,k)=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&k.every(p=>Object.hasOwn(Object.getOwnPropertyDescriptor(x,p)??{},'value'));
const deny=reason=>({shadow:true,ready:false,liveActivation:false,reason});
export function pilotReadiness(policy,e){
 if(!own(policy,['repositoryId','pin','lineMin','branchMin','firstPilot'])||!id(policy.repositoryId)||!sha(policy.pin)||!Number.isFinite(policy.lineMin)||policy.lineMin<95||policy.lineMin>100||!Number.isFinite(policy.branchMin)||policy.branchMin<90||policy.branchMin>100||typeof policy.firstPilot!=='boolean')return deny('POLICY_UNKNOWN');
 if(!own(e,['repositoryId','pin','enrolled','stop','upstreamAccepted','review','coverageLine','coverageBranch','requiredChecks','quotaVerified','rollbackVerified','securityClear']))return deny('EVIDENCE_UNKNOWN');
 if(e.stop!==false||e.enrolled!==true)return deny('STOPPED');
 if(e.repositoryId!==policy.repositoryId||e.pin!==policy.pin)return deny('IDENTITY_OR_PIN');
 if(!policy.firstPilot&&e.upstreamAccepted!==true)return deny('UPSTREAM_BLOCKED');
 if(e.review!==true||e.requiredChecks!==true||e.quotaVerified!==true||e.rollbackVerified!==true||e.securityClear!==true)return deny('GATES_UNKNOWN');
 if(!Number.isFinite(e.coverageLine)||e.coverageLine<policy.lineMin||e.coverageLine>100||!Number.isFinite(e.coverageBranch)||e.coverageBranch<policy.branchMin||e.coverageBranch>100)return deny('COVERAGE');
 return {shadow:true,ready:true,liveActivation:false,reason:'SYNTHETIC_READY_ONLY'};
}


// Synthetic M04 repeatability evidence; never grants activation or actual acceptance.
export function evaluateSelfPilotCycles(cycles) {
 const blocked=reason=>({shadow:true,liveActivation:false,accepted:false,reason});
 if(!Array.isArray(cycles)||cycles.length<3||cycles.length>50||
    !Array.from({length:cycles.length},(_,i)=>Object.hasOwn(cycles,i)).every(Boolean))
  return blocked('CYCLE_INVENTORY_UNKNOWN');
 const issues=new Set(),prs=new Set(),heads=new Set(),latencies=[];
 let reviewFix=false,parallel=false;
 for(const c of cycles){
  if(!own(c,['repositoryId','issue','pr','head','reviewedHead','reviewIndependent','checksPassed','securityClear','threadsResolved','lines','branches','mainVerified','costVerified','extraCost','humanInterventions','unauthorizedWrites','duplicateDispatches','startedAt','eligibleAt','mergedAt','reviewFix','parallelCandidate'])||
     c.repositoryId!==1471342715||!id(c.issue)||!id(c.pr)||!sha(c.head)||c.reviewedHead!==c.head)
   return blocked('IDENTITY_OR_REVIEW_UNKNOWN');
  if(issues.has(c.issue)||prs.has(c.pr)||heads.has(c.head))return blocked('DUPLICATE_CYCLE');
  issues.add(c.issue);prs.add(c.pr);heads.add(c.head);
  if([c.reviewIndependent,c.checksPassed,c.securityClear,c.threadsResolved,c.mainVerified,c.costVerified].some(x=>x!==true)||
     c.extraCost!==0||c.humanInterventions!==0||c.unauthorizedWrites!==0||c.duplicateDispatches!==0)
   return blocked('SAFETY_OR_COST_UNKNOWN');
  if(!Number.isFinite(c.lines)||c.lines<98||c.lines>100||
     !Number.isFinite(c.branches)||c.branches<95||c.branches>100)return blocked('COVERAGE');
  if(![c.startedAt,c.eligibleAt,c.mergedAt].every(n=>Number.isSafeInteger(n)&&n>=0)||
     c.startedAt>c.eligibleAt||c.eligibleAt>c.mergedAt||
     typeof c.reviewFix!=='boolean'||typeof c.parallelCandidate!=='boolean')return blocked('TIMING_OR_SCENARIO_UNKNOWN');
  reviewFix ||= c.reviewFix;
  parallel ||= c.parallelCandidate;
  latencies.push(c.mergedAt-c.eligibleAt);
 }
 if(!reviewFix||!parallel)return blocked('SCENARIO_MISSING');
 latencies.sort((a,b)=>a-b);
 return {shadow:true,liveActivation:false,accepted:false,reason:'SYNTHETIC_REPEATABILITY_ONLY',sampleCount:latencies.length,
  p50Ms:latencies[Math.ceil(latencies.length*.5)-1],p95Ms:latencies[Math.ceil(latencies.length*.95)-1]};
}
