import {types} from 'node:util';
import {coverageEvidence} from './coverage-evidence.mjs';
const SOFTWARE_FACTORY_REPO_ID=1471342715;
const policyKeys=['repositoryId','pin','lineMin','branchMin','firstPilot'];
const readinessKeys=['repositoryId','pin','enrolled','stop','upstreamAccepted','review','coverageLine','coverageBranch','requiredChecks','quotaVerified','rollbackVerified','securityClear'];
export const M01_STRUCTURAL_PREREQUISITES=Object.freeze([
 'noPythonVerified',
 'boundedLeaseTtlVerified',
 'crossRunStateVerified',
 'protectedEnvironmentVerified',
 'hardStopBillingVerified',
 'laptopOfflineRecoveryVerified',
 'stopSwitchVerified'
]);
const sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
const id=x=>Number.isSafeInteger(x)&&x>0;
const own=(x,k)=>x!==null&&typeof x==='object'&&!types.isProxy(x)&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype&&k.every(p=>Object.hasOwn(Object.getOwnPropertyDescriptor(x,p)??{},'value'));
const deny=reason=>({shadow:true,ready:false,liveActivation:false,reason});
export function pilotReadiness(policy,e){
 if(!own(policy,policyKeys)||!id(policy.repositoryId)||!sha(policy.pin)||!Number.isFinite(policy.lineMin)||policy.lineMin<95||policy.lineMin>100||!Number.isFinite(policy.branchMin)||policy.branchMin<90||policy.branchMin>100||typeof policy.firstPilot!=='boolean')return deny('POLICY_UNKNOWN');
 const m01Req=Object.getOwnPropertyDescriptor(policy,'requireM01Prerequisites');
 if(m01Req!==undefined&&(!Object.hasOwn(m01Req,'value')||typeof m01Req.value!=='boolean'))return deny('POLICY_UNKNOWN');
 const requireM01=m01Req!==undefined&&m01Req.value;
 if(!own(e,readinessKeys)||(requireM01&&!own(e,M01_STRUCTURAL_PREREQUISITES)))return deny('EVIDENCE_UNKNOWN');
 if(e.stop!==false||e.enrolled!==true)return deny('STOPPED');
 if(e.repositoryId!==policy.repositoryId||e.pin!==policy.pin)return deny('IDENTITY_OR_PIN');
 if(!policy.firstPilot&&e.upstreamAccepted!==true)return deny('UPSTREAM_BLOCKED');
 if(e.review!==true||e.requiredChecks!==true||e.quotaVerified!==true||e.rollbackVerified!==true||e.securityClear!==true)return deny('GATES_UNKNOWN');
 if(requireM01&&M01_STRUCTURAL_PREREQUISITES.some(k=>e[k]!==true))return deny('M01_PREREQUISITES_UNVERIFIED');
 if(!Number.isFinite(e.coverageLine)||e.coverageLine<policy.lineMin||e.coverageLine>100||!Number.isFinite(e.coverageBranch)||e.coverageBranch<policy.branchMin||e.coverageBranch>100)return deny('COVERAGE');
 return {shadow:true,ready:true,liveActivation:false,reason:'SYNTHETIC_READY_ONLY'};
}


// Synthetic repeatability evidence; never grants activation or actual acceptance.
export function evaluateSelfPilotCycles(cycles,expectedComponents,options={repositoryId:SOFTWARE_FACTORY_REPO_ID}) {
 const blocked=reason=>({shadow:true,liveActivation:false,accepted:false,reason});
 if(!own(options,[]))return blocked('OPTIONS_UNKNOWN');
 const repoDesc=Object.getOwnPropertyDescriptor(options,'repositoryId');
 const repositoryId=repoDesc===undefined?SOFTWARE_FACTORY_REPO_ID:(Object.hasOwn(repoDesc,'value')?repoDesc.value:null);
 if(!id(repositoryId))return blocked('OPTIONS_UNKNOWN');
 if(types.isProxy(cycles)||!Array.isArray(cycles)||Object.getPrototypeOf(cycles)!==Array.prototype||
    cycles.length<3||cycles.length>50||Reflect.ownKeys(cycles).length!==cycles.length+1||
    !Array.from({length:cycles.length},(_,i)=>Object.hasOwn(Object.getOwnPropertyDescriptor(cycles,i)??{},'value')).every(Boolean))
  return blocked('CYCLE_INVENTORY_UNKNOWN');
 const issues=new Set(),prs=new Set(),heads=new Set(),latencies=[];
 let reviewFix=false,parallel=false;
 for(let i=0;i<cycles.length;i++){
  const c=Object.getOwnPropertyDescriptor(cycles,i).value;
  if(!own(c,['repositoryId','issue','pr','head','reviewedHead','reviewIndependent','checksPassed','securityClear','threadsResolved','coverageReports','mainVerified','costVerified','extraCost','humanInterventions','unauthorizedWrites','duplicateDispatches','startedAt','eligibleAt','mergedAt','reviewFix','parallelCandidate'])||
     c.repositoryId!==repositoryId||!id(c.issue)||!id(c.pr)||!sha(c.head)||c.reviewedHead!==c.head)
   return blocked('IDENTITY_OR_REVIEW_UNKNOWN');
  if(issues.has(c.issue)||prs.has(c.pr)||heads.has(c.head))return blocked('DUPLICATE_CYCLE');
  issues.add(c.issue);prs.add(c.pr);heads.add(c.head);
  if([c.reviewIndependent,c.checksPassed,c.securityClear,c.threadsResolved,c.mainVerified,c.costVerified].some(x=>x!==true)||
     c.extraCost!==0||c.humanInterventions!==0||c.unauthorizedWrites!==0||c.duplicateDispatches!==0)
   return blocked('SAFETY_OR_COST_UNKNOWN');
  if(!coverageEvidence(c.head,expectedComponents,c.coverageReports).valid)return blocked('COVERAGE');
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


// Offline M01 exit-readiness evaluator; never grants live dispatch or self-acceptance.
export function verifyM01AutonomousExit(e){
 const exitDeny=reason=>({shadow:true,ready:false,liveActivation:false,accepted:false,reason});
 if(!own(e,['policy','readiness',...M01_STRUCTURAL_PREREQUISITES,'cycles','expectedComponents','actualWorkerMax','workerShortfallFrom12']))
  return exitDeny('EVIDENCE_UNKNOWN');
 if(!own(e.policy,policyKeys))return exitDeny('POLICY_UNKNOWN');
 const policyReq=Object.getOwnPropertyDescriptor(e.policy,'requireM01Prerequisites');
 if(policyReq!==undefined&&(!Object.hasOwn(policyReq,'value')||policyReq.value!==true))return exitDeny('POLICY_UNKNOWN');
 if(!own(e.readiness,readinessKeys))return exitDeny('EVIDENCE_UNKNOWN');
 const m01Policy={repositoryId:e.policy.repositoryId,pin:e.policy.pin,lineMin:e.policy.lineMin,branchMin:e.policy.branchMin,firstPilot:e.policy.firstPilot,requireM01Prerequisites:true};
 const m01Readiness=Object.fromEntries([...readinessKeys.map(k=>[k,e.readiness[k]]),...M01_STRUCTURAL_PREREQUISITES.map(k=>[k,e[k]])]);
 const preflight=pilotReadiness(m01Policy,m01Readiness);
 if(!preflight.ready)return exitDeny(preflight.reason);
 if(e.policy.repositoryId!==SOFTWARE_FACTORY_REPO_ID||e.policy.lineMin<98||e.policy.branchMin<95)
  return exitDeny('POLICY_BELOW_M01_TARGET');
 if(!id(e.actualWorkerMax)||e.actualWorkerMax>1000||!Number.isSafeInteger(e.workerShortfallFrom12)||e.workerShortfallFrom12!==Math.max(0,12-e.actualWorkerMax))
  return exitDeny('WORKER_CAPACITY_UNKNOWN');
 const repeatability=evaluateSelfPilotCycles(e.cycles,e.expectedComponents,{repositoryId:SOFTWARE_FACTORY_REPO_ID});
 if(repeatability.reason!=='SYNTHETIC_REPEATABILITY_ONLY')return exitDeny(repeatability.reason);
 for(let i=0;i<e.cycles.length;i++){
  const c=e.cycles[i];
  if(!own(c,['acceptanceVerified','gateBypasses'])||c.acceptanceVerified!==true||c.gateBypasses!==0)
   return exitDeny('SAFETY_OR_COST_UNKNOWN');
  for(let j=0;j<c.coverageReports.length;j++){
   const r=c.coverageReports[j];
   if(r.lines*100<e.policy.lineMin*r.lineTotal||r.branches*100<e.policy.branchMin*r.branchTotal)
    return exitDeny('COVERAGE');
  }
 }
 return {shadow:true,ready:true,liveActivation:false,accepted:false,reason:'M01_EXIT_EVIDENCE_READY_ONLY',
  sampleCount:repeatability.sampleCount,p50Ms:repeatability.p50Ms,p95Ms:repeatability.p95Ms,
  actualWorkerMax:e.actualWorkerMax,workerShortfallFrom12:e.workerShortfallFrom12};
}
