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

export const M01_CUSTOMER_ONE_PREREQUISITES=Object.freeze([
 'noPythonVerified',
 'mainCodeqlHealthy',
 'ghAwLockVerified',
 'workQueueCasVerified',
 'unifiedCliVerified',
 'antiRogueCircuitBreakersVerified',
 'crossOsAspireRuntimeVerified',
 'hardStopBillingVerified',
 'nativeCloudSmokeVerified',
 'repoScopedLiveAuthVerified'
]);

export const M01_CUSTOMER_ONE_SLOS=Object.freeze({
 issueReadyToPrInitialMaxMs:600_000,
 issueReadyToPrStretchMaxMs:120_000,
 prToCompleteInitialMaxMs:900_000,
 prToCompleteStretchMaxMs:300_000,
 issueReadyToOutcomeInitialMaxMs:1_500_000,
 issueReadyToOutcomeStretchMaxMs:420_000,
 outlierOutcomeThresholdMs:1_500_000,
 eligibleToMergeInitialMaxMs:120_000,
 eligibleToMergeStretchMaxMs:30_000,
 automatedCiP50InitialExclusiveMaxMs:75_000,
 automatedCiP50StretchMaxMs:30_000,
 batchDrainMaxMs:120_000,
 batchDrainStretchMaxMs:30_000,
 maxHumanInterventions:0,
 minAcceptedCycles:3,
 workerGoalMax:12
});

const dossierInputKeys=[
 'repositoryId',
 'pin',
 'enrolled',
 'stop',
 'lineMin',
 'branchMin',
 'actualWorkerMax',
 'workerShortfallFrom12',
 'prerequisites',
 'expectedComponents',
 'cycles'
];

const dossierCycleKeys=[
 'source',
 'repositoryId',
 'issue',
 'pr',
 'head',
 'reviewedHead',
 'batchId',
 'batchStartedAt',
 'reviewIndependent',
 'checksPassed',
 'securityClear',
 'threadsResolved',
 'coverageReports',
 'mainVerified',
 'costVerified',
 'acceptanceVerified',
 'laptopOfflineVerified',
 'extraCost',
 'humanInterventions',
 'unauthorizedWrites',
 'duplicateDispatches',
 'gateBypasses',
 'issueReadyAt',
 'prCreatedAt',
 'eligibleAt',
 'prMergedAt',
 'mainVerifiedAt',
 'acceptanceVerifiedAt',
 'automatedCiMs',
 'reviewFix',
 'parallelCandidate'
];

const ms=x=>Number.isSafeInteger(x)&&x>=0&&!Object.is(x,-0);
const componentName=x=>typeof x==='string'&&/^[a-z0-9][a-z0-9._-]{0,79}$/.test(x);
const batchToken=x=>typeof x==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/.test(x);
const ownEnumerableData=(x,p)=>{
 const d=Object.getOwnPropertyDescriptor(x,p);
 return d!==undefined&&d.enumerable===true&&Object.hasOwn(d,'value');
};
const exactPlain=(x,keys)=>
 x!==null&&
 typeof x==='object'&&
 !types.isProxy(x)&&
 !Array.isArray(x)&&
 Object.getPrototypeOf(x)===Object.prototype&&
 Reflect.ownKeys(x).length===keys.length&&
 keys.every(k=>ownEnumerableData(x,k));
const denseDataArray=(x,maxLen)=>
 !types.isProxy(x)&&
 Array.isArray(x)&&
 Object.getPrototypeOf(x)===Array.prototype&&
 x.length<=maxLen&&
 Reflect.ownKeys(x).length===x.length+1&&
 Array.from({length:x.length},(_,i)=>ownEnumerableData(x,i)).every(Boolean);

const EMPTY_SLO_CHECKS=Object.freeze({
 evaluable:false,
 issueReadyToPrP50Met:null,
 issueReadyToPrP95Met:null,
 prToCompleteP50Met:null,
 prToCompleteP95Met:null,
 issueReadyToOutcomeP50Met:null,
 issueReadyToOutcomeP95Met:null,
 eligibleToMergeP50Met:null,
 eligibleToMergeP95Met:null,
 automatedCiP50Met:null,
 automatedCiStretchMet:null,
 batchDrainMet:null,
 batchDrainStretchMet:null,
 humanInterventionsMet:null,
 allInitialSlosMet:false
});

const percentile=(sorted,p)=>sorted[Math.ceil(sorted.length*p)-1];

const summarizeLatencySlo=(values,initialMaxMs,stretchMaxMs)=>{
 const sorted=[...values].sort((a,b)=>a-b);
 const p50Ms=percentile(sorted,0.5);
 const p95Ms=percentile(sorted,0.95);
 return Object.freeze({
  p50Ms,
  p95Ms,
  initialMaxMs,
  stretchMaxMs,
  p50MeetsInitial:p50Ms<=initialMaxMs,
  p95MeetsInitial:p95Ms<=initialMaxMs,
  p50MeetsStretch:p50Ms<=stretchMaxMs,
  p95MeetsStretch:p95Ms<=stretchMaxMs
 });
};

const dossierDeny=(reason,verifiedPrerequisites,blockingPrerequisites)=>Object.freeze({
 shadow:true,
 liveActivation:false,
 accepted:false,
 pilotEntryReady:false,
 m01ExitEvidenceReady:false,
 reason,
 verifiedPrerequisites:Object.freeze(verifiedPrerequisites),
 blockingPrerequisites:Object.freeze(blockingPrerequisites),
 actualWorkerMax:null,
 workerShortfallFrom12:null,
 cycleSource:null,
 sampleCount:0,
 deliveredCycleCount:0,
 syntheticCycleCount:0,
 deliveredCyclesShortfallFrom3:M01_CUSTOMER_ONE_SLOS.minAcceptedCycles,
 issueReadyToPrMs:null,
 prToCompleteMs:null,
 issueReadyToOutcomeMs:null,
 eligibleToMergeMs:null,
 automatedCiP50Ms:null,
 automatedCiP95Ms:null,
 batchDrainMs:null,
 batchDrains:Object.freeze([]),
 humanInterventions:null,
 sloChecks:EMPTY_SLO_CHECKS,
 cycleMetrics:Object.freeze([])
});

// Post-retarget M01 Customer One readiness and canonical #10 3-cycle SLO dossier evaluator.
// Read-only, deterministic, fail-closed; synthetic cycles are never counted as delivered work.
export function evaluateCustomerOnePilotReadinessDossier(input){
 const allPrereqs=[...M01_CUSTOMER_ONE_PREREQUISITES];
 if(!exactPlain(input,dossierInputKeys))return dossierDeny('EVIDENCE_UNKNOWN',[],allPrereqs);
 if(!id(input.repositoryId)||!sha(input.pin)||typeof input.enrolled!=='boolean'||typeof input.stop!=='boolean'||
    !Number.isFinite(input.lineMin)||input.lineMin<98||input.lineMin>100||
    !Number.isFinite(input.branchMin)||input.branchMin<95||input.branchMin>100)
  return dossierDeny('POLICY_UNKNOWN',[],allPrereqs);
 if(input.repositoryId!==SOFTWARE_FACTORY_REPO_ID)return dossierDeny('IDENTITY_OR_PIN',[],allPrereqs);
 if(!Number.isSafeInteger(input.actualWorkerMax)||input.actualWorkerMax<0||input.actualWorkerMax>1000||
    !Number.isSafeInteger(input.workerShortfallFrom12)||
    input.workerShortfallFrom12!==Math.max(0,M01_CUSTOMER_ONE_SLOS.workerGoalMax-input.actualWorkerMax))
  return dossierDeny('WORKER_CAPACITY_UNKNOWN',[],allPrereqs);
 if(!exactPlain(input.prerequisites,M01_CUSTOMER_ONE_PREREQUISITES)||
    M01_CUSTOMER_ONE_PREREQUISITES.some(k=>typeof input.prerequisites[k]!=='boolean'))
  return dossierDeny('PREREQUISITES_UNKNOWN',[],allPrereqs);

 const verifiedPrerequisites=M01_CUSTOMER_ONE_PREREQUISITES.filter(k=>input.prerequisites[k]);
 const blockingPrerequisites=M01_CUSTOMER_ONE_PREREQUISITES.filter(k=>!input.prerequisites[k]);

 if(!denseDataArray(input.expectedComponents,250)||input.expectedComponents.length===0||
    !input.expectedComponents.every(componentName)||
    new Set(input.expectedComponents).size!==input.expectedComponents.length)
  return dossierDeny('INVENTORY_UNKNOWN',verifiedPrerequisites,blockingPrerequisites);
 if(!denseDataArray(input.cycles,50))
  return dossierDeny('CYCLE_INVENTORY_UNKNOWN',verifiedPrerequisites,blockingPrerequisites);

 const coveragePolicy={repository:'Jamula/SoftwareFactory',lineMin:input.lineMin,branchMin:input.branchMin};
 const issues=new Set(),prs=new Set(),heads=new Set(),batches=new Map();
 const readyToPrList=[],prToCompleteList=[],readyToOutcomeList=[],ciList=[],eligibleToMergeList=[],cycleMetrics=[];
 let cycleSource=null,reviewFix=false,parallelCandidate=false;
 let totalHumanInterventions=0,deliveredCycleCount=0,syntheticCycleCount=0;

 for(let i=0;i<input.cycles.length;i++){
  const c=input.cycles[i];
  if(!exactPlain(c,dossierCycleKeys))
   return dossierDeny('CYCLE_INVENTORY_UNKNOWN',verifiedPrerequisites,blockingPrerequisites);
  if(c.source!=='synthetic'&&c.source!=='github-hosted')
   return dossierDeny('SOURCE_UNKNOWN',verifiedPrerequisites,blockingPrerequisites);
  if(cycleSource===null)cycleSource=c.source;
  else if(c.source!==cycleSource)
   return dossierDeny('PROVENANCE_ISOLATION_VIOLATION',verifiedPrerequisites,blockingPrerequisites);
  if(c.repositoryId!==SOFTWARE_FACTORY_REPO_ID||!id(c.issue)||!id(c.pr)||!sha(c.head)||c.reviewedHead!==c.head)
   return dossierDeny('IDENTITY_OR_REVIEW_UNKNOWN',verifiedPrerequisites,blockingPrerequisites);
  if(issues.has(c.issue)||prs.has(c.pr)||heads.has(c.head))
   return dossierDeny('DUPLICATE_CYCLE',verifiedPrerequisites,blockingPrerequisites);
  issues.add(c.issue);prs.add(c.pr);heads.add(c.head);
  if([c.reviewIndependent,c.checksPassed,c.securityClear,c.threadsResolved,c.mainVerified,c.costVerified,c.acceptanceVerified,c.laptopOfflineVerified].some(v=>v!==true)||
     c.extraCost!==0||c.unauthorizedWrites!==0||c.duplicateDispatches!==0||c.gateBypasses!==0||
     !ms(c.humanInterventions))
   return dossierDeny('SAFETY_OR_COST_UNKNOWN',verifiedPrerequisites,blockingPrerequisites);
  if(!coverageEvidence(c.head,input.expectedComponents,c.coverageReports,coveragePolicy).valid)
   return dossierDeny('COVERAGE',verifiedPrerequisites,blockingPrerequisites);
  if(!batchToken(c.batchId)||
     ![c.batchStartedAt,c.issueReadyAt,c.prCreatedAt,c.eligibleAt,c.prMergedAt,c.mainVerifiedAt,c.acceptanceVerifiedAt,c.automatedCiMs].every(ms)||
     c.issueReadyAt>c.prCreatedAt||c.prCreatedAt>c.eligibleAt||c.eligibleAt>c.prMergedAt||
     c.prMergedAt>c.mainVerifiedAt||c.mainVerifiedAt>c.acceptanceVerifiedAt||
     typeof c.reviewFix!=='boolean'||typeof c.parallelCandidate!=='boolean')
   return dossierDeny('TIMING_OR_SCENARIO_UNKNOWN',verifiedPrerequisites,blockingPrerequisites);

  const existingBatch=batches.get(c.batchId);
  if(existingBatch===undefined){
   batches.set(c.batchId,{
    batchId:c.batchId,
    batchStartedAt:c.batchStartedAt,
    members:[{eligibleAt:c.eligibleAt,prMergedAt:c.prMergedAt}]
   });
  }else{
   if(existingBatch.batchStartedAt!==c.batchStartedAt)
    return dossierDeny('BATCH_BOUNDARY_UNKNOWN',verifiedPrerequisites,blockingPrerequisites);
   existingBatch.members.push({eligibleAt:c.eligibleAt,prMergedAt:c.prMergedAt});
  }

  reviewFix ||= c.reviewFix;
  parallelCandidate ||= c.parallelCandidate;
  totalHumanInterventions+=c.humanInterventions;
  const countedAsDeliveredWork=c.source==='github-hosted'&&c.humanInterventions===0;
  if(c.source==='synthetic')syntheticCycleCount++;
  else if(countedAsDeliveredWork)deliveredCycleCount++;

  const cycleReadyToPrMs=c.prCreatedAt-c.issueReadyAt;
  const cyclePrCreatedToMergeMs=c.prMergedAt-c.prCreatedAt;
  const cycleEligibleToMergeMs=c.prMergedAt-c.eligibleAt;
  const cycleMergeToMainVerifiedMs=c.mainVerifiedAt-c.prMergedAt;
  const cyclePrToCompleteMs=c.mainVerifiedAt-c.prCreatedAt;
  const cycleReadyToOutcomeMs=c.acceptanceVerifiedAt-c.issueReadyAt;
  readyToPrList.push(cycleReadyToPrMs);
  prToCompleteList.push(cyclePrToCompleteMs);
  readyToOutcomeList.push(cycleReadyToOutcomeMs);
  ciList.push(c.automatedCiMs);
  eligibleToMergeList.push(cycleEligibleToMergeMs);
  cycleMetrics.push(Object.freeze({
   issue:c.issue,
   pr:c.pr,
   head:c.head,
   batchId:c.batchId,
   batchStartedAt:c.batchStartedAt,
   source:c.source,
   countedAsDeliveredWork,
   issueReadyToPrMs:cycleReadyToPrMs,
   prCreatedToMergeMs:cyclePrCreatedToMergeMs,
   eligibleToMergeMs:cycleEligibleToMergeMs,
   mergeToMainVerifiedMs:cycleMergeToMainVerifiedMs,
   prToCompleteMs:cyclePrToCompleteMs,
   issueReadyToOutcomeMs:cycleReadyToOutcomeMs,
   automatedCiMs:c.automatedCiMs,
   humanInterventions:c.humanInterventions
  }));
 }

 const batchDrains=[];
 for(const batch of batches.values()){
  const ordered=[...batch.members].sort((a,b)=>a.eligibleAt-b.eligibleAt||a.prMergedAt-b.prMergedAt);
  const minEligibleAt=ordered[0].eligibleAt;
  let minMergedAt=ordered[0].prMergedAt;
  let finalMergedAt=ordered[0].prMergedAt;
  for(let i=1;i<ordered.length;i++){
   if(ordered[i].eligibleAt>finalMergedAt)
    return dossierDeny('BATCH_BOUNDARY_UNKNOWN',verifiedPrerequisites,blockingPrerequisites);
   minMergedAt=Math.min(minMergedAt,ordered[i].prMergedAt);
   finalMergedAt=Math.max(finalMergedAt,ordered[i].prMergedAt);
  }
  if(batch.batchStartedAt<minEligibleAt||batch.batchStartedAt>minMergedAt)
   return dossierDeny('BATCH_BOUNDARY_UNKNOWN',verifiedPrerequisites,blockingPrerequisites);
  batchDrains.push(Object.freeze({
   batchId:batch.batchId,
   cycleCount:ordered.length,
   batchStartedAt:batch.batchStartedAt,
   finalMergedAt,
   drainMs:finalMergedAt-batch.batchStartedAt
  }));
 }

 const stoppedOrUnenrolled=input.stop!==false||input.enrolled!==true;
 const pilotEntryReady=!stoppedOrUnenrolled&&blockingPrerequisites.length===0;
 const hasMinCycles=input.cycles.length>=M01_CUSTOMER_ONE_SLOS.minAcceptedCycles;

 let issueReadyToPrMs=null,prToCompleteMs=null,issueReadyToOutcomeMs=null,eligibleToMergeMs=null;
 let automatedCiP50Ms=null,automatedCiP95Ms=null,batchDrainMs=null;
 let sloChecks=EMPTY_SLO_CHECKS;
 const humanInterventions=input.cycles.length===0?null:totalHumanInterventions;

 if(hasMinCycles){
  issueReadyToPrMs=summarizeLatencySlo(
   readyToPrList,
   M01_CUSTOMER_ONE_SLOS.issueReadyToPrInitialMaxMs,
   M01_CUSTOMER_ONE_SLOS.issueReadyToPrStretchMaxMs
  );
  prToCompleteMs=summarizeLatencySlo(
   prToCompleteList,
   M01_CUSTOMER_ONE_SLOS.prToCompleteInitialMaxMs,
   M01_CUSTOMER_ONE_SLOS.prToCompleteStretchMaxMs
  );
  const outcomeSummary=summarizeLatencySlo(
   readyToOutcomeList,
   M01_CUSTOMER_ONE_SLOS.issueReadyToOutcomeInitialMaxMs,
   M01_CUSTOMER_ONE_SLOS.issueReadyToOutcomeStretchMaxMs
  );
  issueReadyToOutcomeMs=Object.freeze({
   ...outcomeSummary,
   outlierOver25mCount:readyToOutcomeList.filter(v=>v>M01_CUSTOMER_ONE_SLOS.outlierOutcomeThresholdMs).length
  });
  eligibleToMergeMs=summarizeLatencySlo(
   eligibleToMergeList,
   M01_CUSTOMER_ONE_SLOS.eligibleToMergeInitialMaxMs,
   M01_CUSTOMER_ONE_SLOS.eligibleToMergeStretchMaxMs
  );
  const sortedCi=[...ciList].sort((a,b)=>a-b);
  automatedCiP50Ms=percentile(sortedCi,0.5);
  automatedCiP95Ms=percentile(sortedCi,0.95);
  batchDrainMs=Math.max(...batchDrains.map(b=>b.drainMs));

  const automatedCiP50Met=automatedCiP50Ms<M01_CUSTOMER_ONE_SLOS.automatedCiP50InitialExclusiveMaxMs;
  const automatedCiStretchMet=automatedCiP50Ms<=M01_CUSTOMER_ONE_SLOS.automatedCiP50StretchMaxMs;
  const batchDrainMet=batchDrainMs<=M01_CUSTOMER_ONE_SLOS.batchDrainMaxMs;
  const batchDrainStretchMet=batchDrainMs<=M01_CUSTOMER_ONE_SLOS.batchDrainStretchMaxMs;
  const humanInterventionsMet=humanInterventions===M01_CUSTOMER_ONE_SLOS.maxHumanInterventions;
  sloChecks=Object.freeze({
   evaluable:true,
   issueReadyToPrP50Met:issueReadyToPrMs.p50MeetsInitial,
   issueReadyToPrP95Met:issueReadyToPrMs.p95MeetsInitial,
   prToCompleteP50Met:prToCompleteMs.p50MeetsInitial,
   prToCompleteP95Met:prToCompleteMs.p95MeetsInitial,
   issueReadyToOutcomeP50Met:issueReadyToOutcomeMs.p50MeetsInitial,
   issueReadyToOutcomeP95Met:issueReadyToOutcomeMs.p95MeetsInitial,
   eligibleToMergeP50Met:eligibleToMergeMs.p50MeetsInitial,
   eligibleToMergeP95Met:eligibleToMergeMs.p95MeetsInitial,
   automatedCiP50Met,
   automatedCiStretchMet,
   batchDrainMet,
   batchDrainStretchMet,
   humanInterventionsMet,
   allInitialSlosMet:
    issueReadyToPrMs.p50MeetsInitial&&
    prToCompleteMs.p50MeetsInitial&&
    issueReadyToOutcomeMs.p50MeetsInitial&&
    eligibleToMergeMs.p95MeetsInitial&&
    automatedCiP50Met&&
    batchDrainMet&&
    humanInterventionsMet
  });
 }

 let reason;
 let m01ExitEvidenceReady=false;
 if(stoppedOrUnenrolled){
  reason='STOPPED';
 }else if(!pilotEntryReady){
  reason='PILOT_ENTRY_BLOCKED';
 }else if(input.actualWorkerMax===0){
  reason='WORKER_CAPACITY_UNVERIFIED';
 }else if(cycleSource==='synthetic'){
  reason='SYNTHETIC_CYCLES_NOT_DELIVERED_WORK';
 }else if(!hasMinCycles){
  reason='LIVE_CYCLES_PENDING';
 }else if(totalHumanInterventions!==M01_CUSTOMER_ONE_SLOS.maxHumanInterventions){
  reason='HUMAN_INTERVENTION_NONZERO';
 }else if(!reviewFix||!parallelCandidate){
  reason='SCENARIO_MISSING';
 }else{
  reason='CUSTOMER_ONE_EXIT_EVIDENCE_READY_ONLY';
  m01ExitEvidenceReady=true;
 }

 return Object.freeze({
  shadow:true,
  liveActivation:false,
  accepted:false,
  pilotEntryReady,
  m01ExitEvidenceReady,
  reason,
  verifiedPrerequisites:Object.freeze(verifiedPrerequisites),
  blockingPrerequisites:Object.freeze(blockingPrerequisites),
  actualWorkerMax:input.actualWorkerMax,
  workerShortfallFrom12:input.workerShortfallFrom12,
  cycleSource,
  sampleCount:input.cycles.length,
  deliveredCycleCount,
  syntheticCycleCount,
  deliveredCyclesShortfallFrom3:Math.max(0,M01_CUSTOMER_ONE_SLOS.minAcceptedCycles-deliveredCycleCount),
  issueReadyToPrMs,
  prToCompleteMs,
  issueReadyToOutcomeMs,
  eligibleToMergeMs,
  automatedCiP50Ms,
  automatedCiP95Ms,
  batchDrainMs,
  batchDrains:Object.freeze(batchDrains),
  humanInterventions,
  sloChecks,
  cycleMetrics:Object.freeze(cycleMetrics)
 });
}

export const M01_CONSOLIDATED_EXIT_CONTRACT=Object.freeze({
 minAcceptedIssues:3,
 minParallelNonOverlappingCandidates:2,
 minReviewRepairCycles:1,
 maxHumanInterventions:0,
 maxIncrementalBilledUsdCents:0,
 lineMin:98,
 branchMin:95,
 requiredAgentLogin:'copilot-swe-agent[bot]'
});

const consolidatedExitInputKeys=[
 'repositoryId',
 'pin',
 'enrolled',
 'stop',
 'lineMin',
 'branchMin',
 'prerequisites',
 'expectedComponents',
 'cycles'
];

const consolidatedExitCycleKeys=[
 'source',
 'agentLogin',
 'repositoryId',
 'issue',
 'pr',
 'head',
 'reviewedHead',
 'changedFiles',
 'reviewIndependent',
 'checksPassed',
 'securityClear',
 'threadsResolved',
 'squashQueueMerged',
 'mainVerified',
 'costVerified',
 'acceptanceVerified',
 'coverageReports',
 'humanInterventions',
 'incrementalBilledUsdCents',
 'unauthorizedWrites',
 'duplicateDispatches',
 'gateBypasses',
 'startedAt',
 'mergedAt',
 'reviewFix',
 'parallelCandidate'
];

const repoFilePath=x=>
 typeof x==='string'&&
 x.length>0&&
 x.length<=240&&
 !/^\/|\/$|\\|\/\/|[\x00-\x1f\x7f]/.test(x)&&
 x.split('/').every(s=>s!=='.'&&s!=='..'&&s.trim()===s);

const consolidatedExitDeny=(reason,verifiedPrerequisites,blockingPrerequisites)=>Object.freeze({
 shadow:true,
 liveActivation:false,
 accepted:false,
 pilotEntryReady:false,
 exitGateReady:false,
 m01ExitEvidenceReady:false,
 reason,
 verifiedPrerequisites:Object.freeze(verifiedPrerequisites),
 blockingPrerequisites:Object.freeze(blockingPrerequisites),
 cycleSource:null,
 sampleCount:0,
 deliveredCycleCount:0,
 syntheticCycleCount:0,
 deliveredCyclesShortfallFrom3:M01_CONSOLIDATED_EXIT_CONTRACT.minAcceptedIssues,
 parallelNonOverlappingCount:0,
 reviewRepairCount:0,
 humanInterventions:null,
 incrementalBilledUsdCents:null
});

// Streamlined M01.08 (#10) consolidated exit-gate evaluator.
// Read-only, deterministic, fail-closed; never grants live activation or self-acceptance,
// and never counts synthetic cycles as delivered work.
export function evaluateConsolidatedM01ExitGate(input){
 const allPrereqs=[...M01_CUSTOMER_ONE_PREREQUISITES];
 if(!exactPlain(input,consolidatedExitInputKeys))return consolidatedExitDeny('EVIDENCE_UNKNOWN',[],allPrereqs);
 if(!id(input.repositoryId)||!sha(input.pin)||typeof input.enrolled!=='boolean'||typeof input.stop!=='boolean'||
    !Number.isFinite(input.lineMin)||input.lineMin<M01_CONSOLIDATED_EXIT_CONTRACT.lineMin||input.lineMin>100||
    !Number.isFinite(input.branchMin)||input.branchMin<M01_CONSOLIDATED_EXIT_CONTRACT.branchMin||input.branchMin>100)
  return consolidatedExitDeny('POLICY_UNKNOWN',[],allPrereqs);
 if(input.repositoryId!==SOFTWARE_FACTORY_REPO_ID)return consolidatedExitDeny('IDENTITY_OR_PIN',[],allPrereqs);
 if(!exactPlain(input.prerequisites,M01_CUSTOMER_ONE_PREREQUISITES)||
    M01_CUSTOMER_ONE_PREREQUISITES.some(k=>typeof input.prerequisites[k]!=='boolean'))
  return consolidatedExitDeny('PREREQUISITES_UNKNOWN',[],allPrereqs);

 const verifiedPrerequisites=M01_CUSTOMER_ONE_PREREQUISITES.filter(k=>input.prerequisites[k]);
 const blockingPrerequisites=M01_CUSTOMER_ONE_PREREQUISITES.filter(k=>!input.prerequisites[k]);

 if(!denseDataArray(input.expectedComponents,250)||input.expectedComponents.length===0||
    !input.expectedComponents.every(componentName)||
    new Set(input.expectedComponents).size!==input.expectedComponents.length)
  return consolidatedExitDeny('INVENTORY_UNKNOWN',verifiedPrerequisites,blockingPrerequisites);
 if(!denseDataArray(input.cycles,50))
  return consolidatedExitDeny('CYCLE_INVENTORY_UNKNOWN',verifiedPrerequisites,blockingPrerequisites);

 const coveragePolicy={repository:'Jamula/SoftwareFactory',lineMin:input.lineMin,branchMin:input.branchMin};
 const issues=new Set(),prs=new Set(),heads=new Set(),parsedCycles=[];
 let cycleSource=null,deliveredCycleCount=0,syntheticCycleCount=0;
 let totalHumanInterventions=0,totalIncrementalBilledUsdCents=0,reviewRepairCount=0;

 for(let i=0;i<input.cycles.length;i++){
  const c=input.cycles[i];
  if(!exactPlain(c,consolidatedExitCycleKeys))
   return consolidatedExitDeny('CYCLE_INVENTORY_UNKNOWN',verifiedPrerequisites,blockingPrerequisites);
  if(c.source!=='synthetic'&&c.source!=='github-hosted')
   return consolidatedExitDeny('SOURCE_UNKNOWN',verifiedPrerequisites,blockingPrerequisites);
  if(cycleSource===null)cycleSource=c.source;
  else if(c.source!==cycleSource)
   return consolidatedExitDeny('PROVENANCE_ISOLATION_VIOLATION',verifiedPrerequisites,blockingPrerequisites);
  if(c.agentLogin!==M01_CONSOLIDATED_EXIT_CONTRACT.requiredAgentLogin)
   return consolidatedExitDeny('AGENT_IDENTITY_UNKNOWN',verifiedPrerequisites,blockingPrerequisites);
  if(c.repositoryId!==SOFTWARE_FACTORY_REPO_ID||!id(c.issue)||!id(c.pr)||!sha(c.head)||c.reviewedHead!==c.head)
   return consolidatedExitDeny('IDENTITY_OR_REVIEW_UNKNOWN',verifiedPrerequisites,blockingPrerequisites);
  if(issues.has(c.issue)||prs.has(c.pr)||heads.has(c.head))
   return consolidatedExitDeny('DUPLICATE_CYCLE',verifiedPrerequisites,blockingPrerequisites);
  issues.add(c.issue);prs.add(c.pr);heads.add(c.head);
  if(!denseDataArray(c.changedFiles,200)||c.changedFiles.length===0||!c.changedFiles.every(repoFilePath))
   return consolidatedExitDeny('CHANGED_FILES_UNKNOWN',verifiedPrerequisites,blockingPrerequisites);
  const fileSet=new Set(c.changedFiles.map(f=>f.toLowerCase()));
  if(fileSet.size!==c.changedFiles.length)
   return consolidatedExitDeny('CHANGED_FILES_UNKNOWN',verifiedPrerequisites,blockingPrerequisites);
  if([c.reviewIndependent,c.checksPassed,c.securityClear,c.threadsResolved,c.squashQueueMerged,c.mainVerified,c.costVerified,c.acceptanceVerified].some(v=>v!==true)||
     c.unauthorizedWrites!==0||c.duplicateDispatches!==0||c.gateBypasses!==0||
     !ms(c.humanInterventions)||!ms(c.incrementalBilledUsdCents))
   return consolidatedExitDeny('SAFETY_OR_COST_UNKNOWN',verifiedPrerequisites,blockingPrerequisites);
  if(!coverageEvidence(c.head,input.expectedComponents,c.coverageReports,coveragePolicy).valid)
   return consolidatedExitDeny('COVERAGE',verifiedPrerequisites,blockingPrerequisites);
  if(!ms(c.startedAt)||!ms(c.mergedAt)||c.startedAt>=c.mergedAt||
     typeof c.reviewFix!=='boolean'||typeof c.parallelCandidate!=='boolean')
   return consolidatedExitDeny('TIMING_OR_SCENARIO_UNKNOWN',verifiedPrerequisites,blockingPrerequisites);

  totalHumanInterventions+=c.humanInterventions;
  totalIncrementalBilledUsdCents+=c.incrementalBilledUsdCents;
  const countedAsDeliveredWork=
   c.source==='github-hosted'&&
   c.humanInterventions===0&&
   c.incrementalBilledUsdCents===0;
  if(c.source==='synthetic'){
   syntheticCycleCount++;
  }else if(countedAsDeliveredWork){
   deliveredCycleCount++;
   if(c.reviewFix)reviewRepairCount++;
  }
  parsedCycles.push({
   startedAt:c.startedAt,
   mergedAt:c.mergedAt,
   fileSet,
   parallelCandidate:c.parallelCandidate,
   countedAsDeliveredWork
  });
 }

 const concurrentParallelIndices=new Set();
 for(let i=0;i<parsedCycles.length;i++){
  const a=parsedCycles[i];
  for(let j=i+1;j<parsedCycles.length;j++){
   const b=parsedCycles[j];
   if(a.startedAt<b.mergedAt&&b.startedAt<a.mergedAt){
    for(const file of a.fileSet){
     if(b.fileSet.has(file))
      return consolidatedExitDeny('PARALLEL_FILE_OVERLAP',verifiedPrerequisites,blockingPrerequisites);
    }
    if(a.countedAsDeliveredWork&&b.countedAsDeliveredWork&&a.parallelCandidate&&b.parallelCandidate){
     concurrentParallelIndices.add(i);
     concurrentParallelIndices.add(j);
    }
   }
  }
 }
 const parallelNonOverlappingCount=concurrentParallelIndices.size;
 const stoppedOrUnenrolled=input.stop!==false||input.enrolled!==true;
 const pilotEntryReady=!stoppedOrUnenrolled&&blockingPrerequisites.length===0;
 const humanInterventions=input.cycles.length===0?null:totalHumanInterventions;
 const incrementalBilledUsdCents=input.cycles.length===0?null:totalIncrementalBilledUsdCents;

 let reason;
 let exitGateReady=false;
 if(stoppedOrUnenrolled){
  reason='STOPPED';
 }else if(!pilotEntryReady){
  reason='PILOT_ENTRY_BLOCKED';
 }else if(cycleSource==='synthetic'){
  reason='SYNTHETIC_CYCLES_NOT_DELIVERED_WORK';
 }else if(totalIncrementalBilledUsdCents!==M01_CONSOLIDATED_EXIT_CONTRACT.maxIncrementalBilledUsdCents){
  reason='INCREMENTAL_BILLED_SPEND_NONZERO';
 }else if(totalHumanInterventions!==M01_CONSOLIDATED_EXIT_CONTRACT.maxHumanInterventions){
  reason='HUMAN_INTERVENTION_NONZERO';
 }else if(deliveredCycleCount<M01_CONSOLIDATED_EXIT_CONTRACT.minAcceptedIssues){
  reason='LIVE_CYCLES_PENDING';
 }else if(
  parallelNonOverlappingCount<M01_CONSOLIDATED_EXIT_CONTRACT.minParallelNonOverlappingCandidates||
  reviewRepairCount<M01_CONSOLIDATED_EXIT_CONTRACT.minReviewRepairCycles
 ){
  reason='SCENARIO_MISSING';
 }else{
  reason='CONSOLIDATED_M01_EXIT_EVIDENCE_READY_ONLY';
  exitGateReady=true;
 }

 return Object.freeze({
  shadow:true,
  liveActivation:false,
  accepted:false,
  pilotEntryReady,
  exitGateReady,
  m01ExitEvidenceReady:exitGateReady,
  reason,
  verifiedPrerequisites:Object.freeze(verifiedPrerequisites),
  blockingPrerequisites:Object.freeze(blockingPrerequisites),
  cycleSource,
  sampleCount:input.cycles.length,
  deliveredCycleCount,
  syntheticCycleCount,
  deliveredCyclesShortfallFrom3:Math.max(0,M01_CONSOLIDATED_EXIT_CONTRACT.minAcceptedIssues-deliveredCycleCount),
  parallelNonOverlappingCount,
  reviewRepairCount,
  humanInterventions,
  incrementalBilledUsdCents
 });
}
