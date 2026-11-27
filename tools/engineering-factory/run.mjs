import {pathToFileURL} from 'node:url';
import {types} from 'node:util';
import {smoke,readInventory} from './shadow-runtime.mjs';
import {reconcileEventTrigger,reconcilePullTrigger,resolveTrustedScope} from './event-envelope.mjs';
import {reconcileIssueTrigger} from './issue-event.mjs';
import {planLanes} from '../engineering-coordinator/planner.mjs';
import {validateProjectConfig} from '../engineering-coordinator/project-config.mjs';
import {DEFAULT_FACTORY_SCOPE,guardedSquashEvidence} from './protected-squash.mjs';
import {evaluateCloudAgentAdmission} from './cloud-agent-admission.mjs';
import {verifyM01AutonomousExit} from './pilot-readiness.mjs';
import {telemetrySummary,createExecutionReceipt} from './telemetry.mjs';

export {telemetrySummary};
export const DEFAULT_REPOSITORY='Jamula/SoftwareFactory';
export const DEFAULT_REPOSITORY_ID=1471342715;
export const DEFAULT_BRANCH='main';
export const DEFAULT_WORKFLOW_PATH='.github/workflows/shadow-reconcile.yml';
export const MAX_INPUT_UTF8_BYTES=262_144;

let localReceiptSequence=0;
const nextLocalSequence=()=>{
  localReceiptSequence=(localReceiptSequence%1000000000)+1;
  return localReceiptSequence;
};
const commandSpecs=new Map([
  ['--smoke',{stage:'evaluate',tag:'smoke',syntheticOnly:true}],
  ['--inventory',{stage:'reconcile',tag:'inventory',syntheticOnly:false}],
  ['--reconcile-pull',{stage:'reconcile',tag:'reconcile-pull',syntheticOnly:false}],
  ['--reconcile-issue',{stage:'reconcile',tag:'reconcile-issue',syntheticOnly:false}],
  ['--reconcile-event',{stage:'reconcile',tag:'reconcile-event',syntheticOnly:false}],
  ['--plan-lanes',{stage:'evaluate',tag:'plan-lanes',syntheticOnly:false}],
  ['--evaluate-squash',{stage:'merge-shadow',tag:'evaluate-squash',syntheticOnly:false}],
  ['--verify-admission',{stage:'dispatch',tag:'verify-admission',syntheticOnly:false}],
  ['--verify-m01-readiness',{stage:'acceptance',tag:'verify-m01-readiness',syntheticOnly:false}]
]);

const USAGE_TEXT='Usage: node tools/engineering-factory/run.mjs [--smoke|--inventory|--reconcile-pull|--reconcile-issue|--reconcile-event|--plan-lanes|--evaluate-squash|--verify-admission|--verify-m01-readiness] [--receipt]';

const SCOPE_KEYS=new Set(['repository','repositoryId','branch','workflowPath']);
const RECONCILE_EVENT_INPUT_KEYS=new Set([
  'scope','repository','repositoryId','branch','workflowPath','snapshot','owner','leaseMs'
]);
const PLAN_INPUT_KEYS=new Set(['config','tasks','active','policy']);
const SQUASH_INPUT_KEYS=new Set(['intent','evidence','scope']);
const OPTION_GUARDED_KEYS=['repositoryId','repository','branch','workflowPath','scope','input','request'];

const EVENT_TELEMETRY_REASON_MAP=new Map([
  ['CLAIM_PENDING','LEASE_HELD'],
  ['INVALID_REVIEW','INVALID_EVENT'],
  ['INVALID_CHECK','INVALID_EVENT'],
  ['PULL_STATE_CHANGED','STALE_EVENT']
]);
const M01_TELEMETRY_REASON_MAP=new Map([
  ['M01_PREREQUISITES_UNVERIFIED','GATES_UNKNOWN'],
  ['POLICY_BELOW_M01_TARGET','INVALID_POLICY'],
  ['WORKER_CAPACITY_UNKNOWN','CAPACITY_UNKNOWN'],
  ['IDENTITY_OR_PIN','PROVENANCE_MISMATCH'],
  ['UPSTREAM_BLOCKED','DEPENDENCIES_BLOCKED'],
  ['OPTIONS_UNKNOWN','EVIDENCE_UNKNOWN'],
  ['CYCLE_INVENTORY_UNKNOWN','INVALID_INVENTORY'],
  ['IDENTITY_OR_REVIEW_UNKNOWN','REVIEW_UNVERIFIED'],
  ['DUPLICATE_CYCLE','DELIVERY_CONFLICT'],
  ['SAFETY_OR_COST_UNKNOWN','BUDGET_UNKNOWN'],
  ['TIMING_OR_SCENARIO_UNKNOWN','EVIDENCE_UNKNOWN'],
  ['SCENARIO_MISSING','ACCEPTANCE_INCOMPLETE']
]);

const positiveInt=n=>Number.isSafeInteger(n)&&n>0;
const parsePositiveRepoId=raw=>typeof raw==='string'&&/^[1-9][0-9]{0,15}$/.test(raw)&&
  positiveInt(Number(raw))?Number(raw):null;

function ownEnumerableData(obj,key) {
  const d=Object.getOwnPropertyDescriptor(obj,key);
  return d!==undefined&&d.enumerable===true&&Object.hasOwn(d,'value');
}

function plainJsonValue(value,budget={remaining:50000},depth=0) {
  if(--budget.remaining<0||depth>12||types.isProxy(value)) return false;
  if(value===null||typeof value==='string'||typeof value==='boolean') return true;
  if(typeof value==='number') return Number.isFinite(value);
  if(typeof value!=='object') return false;
  if(Array.isArray(value)) {
    if(Object.getPrototypeOf(value)!==Array.prototype||value.length>10000||
       Reflect.ownKeys(value).length!==value.length+1) return false;
    for(let i=0;i<value.length;i++) {
      if(!ownEnumerableData(value,i)||!plainJsonValue(value[i],budget,depth+1)) return false;
    }
    return true;
  }
  if(Object.getPrototypeOf(value)!==Object.prototype) return false;
  const keys=Reflect.ownKeys(value);
  if(keys.length>128) return false;
  return keys.every(key=>typeof key==='string'&&key!=='__proto__'&&
    ownEnumerableData(value,key)&&plainJsonValue(value[key],budget,depth+1));
}

function plainJsonObject(value) {
  return value!==null&&typeof value==='object'&&!types.isProxy(value)&&!Array.isArray(value)&&
    plainJsonValue(value);
}

function readEnvValue(env,key) {
  if(env===null||env===undefined) return {ok:true,value:undefined};
  if(typeof env!=='object'||types.isProxy(env)||Array.isArray(env)) return {ok:false,value:undefined};
  const d=Object.getOwnPropertyDescriptor(env,key);
  if(d===undefined) return {ok:true,value:undefined};
  return Object.hasOwn(d,'value')?{ok:true,value:d.value}:{ok:false,value:undefined};
}

function mergeConsistentString(values) {
  let chosen=null;
  for(const v of values) {
    if(v===undefined) continue;
    if(typeof v!=='string'||v.length===0||v.length>200) return {ok:false,value:null};
    if(chosen!==null&&chosen!==v) return {ok:false,value:null};
    chosen=v;
  }
  return {ok:true,value:chosen};
}

function resolveRepositoryBinding(options,env,spec) {
  let scopeOpt=null;
  if(options.scope!==undefined) {
    if(!plainJsonObject(options.scope)||!Object.keys(options.scope).every(k=>SCOPE_KEYS.has(k))) {
      return {ok:false,repositoryId:null};
    }
    scopeOpt=options.scope;
  }
  const repoIdCandidates=[];
  for(const rawId of [options.repositoryId,scopeOpt?.repositoryId]) {
    if(rawId!==undefined) {
      if(!positiveInt(rawId)) return {ok:false,repositoryId:null};
      repoIdCandidates.push(rawId);
    }
  }
  const envExpected=readEnvValue(env,'FACTORY_EXPECTED_REPO_ID');
  if(!envExpected.ok) return {ok:false,repositoryId:null};
  if(envExpected.value!==undefined) {
    const parsedId=parsePositiveRepoId(envExpected.value);
    if(parsedId===null) return {ok:false,repositoryId:null};
    repoIdCandidates.push(parsedId);
  }
  if(new Set(repoIdCandidates).size>1) return {ok:false,repositoryId:null};
  const repositoryId=repoIdCandidates[0]??DEFAULT_REPOSITORY_ID;

  const envRepo=readEnvValue(env,'FACTORY_EXPECTED_REPOSITORY');
  const envBranch=readEnvValue(env,'FACTORY_EXPECTED_BRANCH');
  const envWorkflow=readEnvValue(env,'FACTORY_EXPECTED_WORKFLOW_PATH');
  const ghRepoId=readEnvValue(env,'GITHUB_REPOSITORY_ID');
  const ghRepo=readEnvValue(env,'GITHUB_REPOSITORY');
  if(!envRepo.ok||!envBranch.ok||!envWorkflow.ok||!ghRepoId.ok||!ghRepo.ok) {
    return {ok:false,repositoryId:null};
  }
  const mergedRepo=mergeConsistentString([options.repository,scopeOpt?.repository,envRepo.value]);
  const mergedBranch=mergeConsistentString([options.branch,scopeOpt?.branch,envBranch.value]);
  const mergedWorkflow=mergeConsistentString([options.workflowPath,scopeOpt?.workflowPath,envWorkflow.value]);
  if(!mergedRepo.ok||!mergedBranch.ok||!mergedWorkflow.ok) {
    return {ok:false,repositoryId:null};
  }
  if(repositoryId===DEFAULT_REPOSITORY_ID) {
    if(mergedRepo.value!==null&&mergedRepo.value!==DEFAULT_REPOSITORY) {
      return {ok:false,repositoryId:null};
    }
  } else if(mergedRepo.value!==null&&mergedRepo.value.toLowerCase()===DEFAULT_REPOSITORY.toLowerCase()) {
    return {ok:false,repositoryId:null};
  }
  const repository=repositoryId===DEFAULT_REPOSITORY_ID?DEFAULT_REPOSITORY:mergedRepo.value;
  const explicit=repoIdCandidates.length>0||mergedRepo.value!==null||
    mergedBranch.value!==null||mergedWorkflow.value!==null;
  const inActions=env?.GITHUB_ACTIONS==='true';
  if(!spec.syntheticOnly||explicit) {
    if(ghRepoId.value!==undefined&&ghRepoId.value!==String(repositoryId)) {
      return {ok:false,repositoryId:null};
    }
    const hasEffectiveGhRepo=ghRepo.value!==undefined&&(inActions||ghRepo.value!=='');
    if(hasEffectiveGhRepo&&repository!==null&&ghRepo.value!==repository) {
      return {ok:false,repositoryId:null};
    }
  }
  return {
    ok:true,
    repositoryId,
    repository,
    branch:mergedBranch.value,
    workflowPath:mergedWorkflow.value,
    explicitScope:mergedRepo.value!==null||mergedBranch.value!==null||mergedWorkflow.value!==null
  };
}

function resolveReconcileScope(repoBinding,inputObj) {
  let trustedCandidate;
  if(repoBinding.repositoryId===DEFAULT_REPOSITORY_ID) {
    trustedCandidate={
      repository:DEFAULT_REPOSITORY,
      repositoryId:DEFAULT_REPOSITORY_ID,
      branch:repoBinding.branch??DEFAULT_BRANCH,
      workflowPath:repoBinding.workflowPath??DEFAULT_WORKFLOW_PATH
    };
  } else {
    if(repoBinding.repository===null||repoBinding.branch===null||repoBinding.workflowPath===null) {
      return {ok:false,reason:'TRUST_UNKNOWN'};
    }
    trustedCandidate={
      repository:repoBinding.repository,
      repositoryId:repoBinding.repositoryId,
      branch:repoBinding.branch,
      workflowPath:repoBinding.workflowPath
    };
  }
  if(!resolveTrustedScope(trustedCandidate)) return {ok:false,reason:'TRUST_UNKNOWN'};
  if(inputObj!==undefined) {
    let inputScope=null;
    if(Object.hasOwn(inputObj,'scope')) {
      if(!plainJsonObject(inputObj.scope)||!Object.keys(inputObj.scope).every(k=>SCOPE_KEYS.has(k))) {
        return {ok:false,reason:'TRUST_UNKNOWN'};
      }
      inputScope=inputObj.scope;
    }
    if(hasMismatchedStringField(inputObj,'repository',trustedCandidate.repository)||
       hasMismatchedStringField(inputScope,'repository',trustedCandidate.repository)||
       hasMismatchedStringField(inputObj,'branch',trustedCandidate.branch)||
       hasMismatchedStringField(inputScope,'branch',trustedCandidate.branch)||
       hasMismatchedStringField(inputObj,'workflowPath',trustedCandidate.workflowPath)||
       hasMismatchedStringField(inputScope,'workflowPath',trustedCandidate.workflowPath)) {
      return {ok:false,reason:'PROVENANCE_MISMATCH'};
    }
  }
  return {
    ok:true,
    isDefaultUnscoped:repoBinding.repositoryId===DEFAULT_REPOSITORY_ID&&!repoBinding.explicitScope&&inputObj===undefined,
    scope:trustedCandidate
  };
}

function parseBoundedInput(injectedInput,env) {
  const envJson=readEnvValue(env,'FACTORY_INPUT_JSON');
  if(!envJson.ok) return {present:true,ok:false,reason:'EVIDENCE_UNKNOWN',value:undefined};
  const rawSource=injectedInput!==undefined?injectedInput:envJson.value;
  if(rawSource===undefined) return {present:false,ok:true,reason:null,value:undefined};
  if(typeof rawSource==='string') {
    if(Buffer.byteLength(rawSource,'utf8')>MAX_INPUT_UTF8_BYTES) {
      return {present:true,ok:false,reason:'RESPONSE_LIMIT',value:undefined};
    }
    try {
      const parsed=JSON.parse(rawSource);
      return plainJsonObject(parsed)
        ?{present:true,ok:true,reason:null,value:parsed}
        :{present:true,ok:false,reason:'EVIDENCE_UNKNOWN',value:undefined};
    } catch {
      return {present:true,ok:false,reason:'EVIDENCE_UNKNOWN',value:undefined};
    }
  }
  if(!plainJsonObject(rawSource)) {
    return {present:true,ok:false,reason:'EVIDENCE_UNKNOWN',value:undefined};
  }
  if(Buffer.byteLength(JSON.stringify(rawSource),'utf8')>MAX_INPUT_UTF8_BYTES) {
    return {present:true,ok:false,reason:'RESPONSE_LIMIT',value:undefined};
  }
  return {present:true,ok:true,reason:null,value:rawSource};
}

function parseArgs(args) {
  if(types.isProxy(args)||!Array.isArray(args)) return null;
  let command=null,emitReceipt=false;
  for(const arg of args) {
    if(arg==='--receipt') {
      if(emitReceipt) return null;
      emitReceipt=true;
    } else if(commandSpecs.has(arg)) {
      if(command!==null) return null;
      command=arg;
    } else {
      return null;
    }
  }
  return {command:command??'--smoke',emitReceipt};
}

function safeClock(clock) {
  try {
    const value=clock();
    return Number.isSafeInteger(value)&&value>=0?value:null;
  } catch {
    return null;
  }
}

function resolveReceiptSource(env,spec,finishedAt,injectedReceiptId,repositoryId) {
  if(!positiveInt(repositoryId)) return {source:'invalid',receiptId:'invalid'};
  const hostedRunner=env?.RUNNER_ENVIRONMENT==='github-hosted';
  const runId=typeof env?.GITHUB_RUN_ID==='string'&&/^[1-9][0-9]{0,19}$/.test(env.GITHUB_RUN_ID)?env.GITHUB_RUN_ID:null;
  const rawAttempt=env?.GITHUB_RUN_ATTEMPT??'1';
  const attempt=typeof rawAttempt==='string'&&/^[1-9][0-9]{0,3}$/.test(rawAttempt)?rawAttempt:null;
  const discriminator=()=>finishedAt!==null?`${finishedAt}-${nextLocalSequence()}`:`${nextLocalSequence()}`;
  if(spec.syntheticOnly) {
    const defaultId=hostedRunner&&runId&&attempt
      ?`gh-${runId}-${attempt}-${spec.tag}`
      :`synthetic-${spec.tag}-${discriminator()}`;
    return {source:'synthetic',receiptId:injectedReceiptId??defaultId};
  }
  if(env?.GITHUB_ACTIONS==='true') {
    if(!hostedRunner||env.GITHUB_REPOSITORY_ID!==String(repositoryId)||!runId||!attempt)
      return {source:'invalid',receiptId:'invalid'};
    return {source:'github-hosted',receiptId:injectedReceiptId??`gh-${runId}-${attempt}-${spec.tag}`};
  }
  return {source:'synthetic',receiptId:injectedReceiptId??`local-${spec.tag}-${discriminator()}`};
}

function sanitizeEventResult(raw) {
  if(raw===null||typeof raw!=='object'||types.isProxy(raw)||Array.isArray(raw)||
     Object.getPrototypeOf(raw)!==Object.prototype) {
    return {shadow:true,evidenceComplete:false,reconciled:false,liveDispatch:false,liveMerge:false,reason:'READ_FAILED'};
  }
  const clean={};
  for(const key of Reflect.ownKeys(raw)) {
    if(key==='snapshot') continue;
    if(typeof key!=='string'||!ownEnumerableData(raw,key)||!plainJsonValue(raw[key])) {
      return {shadow:true,evidenceComplete:false,reconciled:false,liveDispatch:false,liveMerge:false,reason:'READ_FAILED'};
    }
    clean[key]=raw[key];
  }
  return clean;
}

function normalizePlanResult(raw) {
  if(!plainJsonObject(raw)) {
    return {shadow:true,liveDispatch:false,scheduled:[],reason:'INVALID_TASKS'};
  }
  const scheduled=Array.isArray(raw.scheduled)?raw.scheduled:[];
  const reason=typeof raw.reason==='string'&&raw.reason.length>0
    ?raw.reason
    :(scheduled.length>0?'SHADOW_PLAN':'NO_READY_WORK');
  return {shadow:true,liveDispatch:false,...raw,scheduled,reason};
}

function hasMismatchedRepoId(value,repositoryId) {
  return plainJsonObject(value)&&Object.hasOwn(value,'repositoryId')&&value.repositoryId!==repositoryId;
}

function hasMismatchedStringField(value,key,expected) {
  return expected!==null&&plainJsonObject(value)&&Object.hasOwn(value,key)&&value[key]!==expected;
}

export function evaluateProtectedSquash(input,bindingOrRepoId=DEFAULT_REPOSITORY_ID,evaluator=guardedSquashEvidence) {
  const blockedSquash=reason=>({shadow:true,liveMerge:false,dependentWorkAllowed:false,reason});
  const binding=typeof bindingOrRepoId==='number'
    ?{
      repositoryId:bindingOrRepoId,
      repository:bindingOrRepoId===DEFAULT_REPOSITORY_ID?DEFAULT_REPOSITORY:null,
      branch:bindingOrRepoId===DEFAULT_REPOSITORY_ID?DEFAULT_BRANCH:null
    }
    :(plainJsonObject(bindingOrRepoId)
      ?{
        repositoryId:bindingOrRepoId.repositoryId,
        repository:bindingOrRepoId.repository??null,
        branch:bindingOrRepoId.branch??(bindingOrRepoId.repositoryId===DEFAULT_REPOSITORY_ID?DEFAULT_BRANCH:null)
      }
      :{repositoryId:0,repository:null,branch:null});
  const {repositoryId,repository:expectedRepository,branch:expectedBranch}=binding;
  if(!positiveInt(repositoryId)||expectedRepository===null||expectedBranch===null||
     (repositoryId!==DEFAULT_REPOSITORY_ID&&expectedRepository.toLowerCase()===DEFAULT_REPOSITORY.toLowerCase())) {
    return blockedSquash('PROVENANCE_MISMATCH');
  }
  if(!plainJsonObject(input)||!Object.keys(input).every(k=>SQUASH_INPUT_KEYS.has(k))||
     !Object.hasOwn(input,'intent')||!Object.hasOwn(input,'evidence')) {
    return blockedSquash('INTENT_UNKNOWN');
  }
  const hasScope=Object.hasOwn(input,'scope');
  const scope=hasScope
    ?input.scope
    :(repositoryId===DEFAULT_FACTORY_SCOPE.repositoryId&&expectedBranch===DEFAULT_BRANCH
      ?DEFAULT_FACTORY_SCOPE
      :{
        repository:expectedRepository,
        repositoryId,
        branch:expectedBranch,
        ...(repositoryId===DEFAULT_FACTORY_SCOPE.repositoryId?{requiredChecks:DEFAULT_FACTORY_SCOPE.requiredChecks}:{})
      });
  const ev=plainJsonObject(input.evidence)?input.evidence:null;
  const mismatchedRepoName=
    hasMismatchedStringField(scope,'repository',expectedRepository)||
    hasMismatchedStringField(input.intent,'repository',expectedRepository)||
    hasMismatchedStringField(ev,'repository',expectedRepository)||
    (ev!==null&&(
      hasMismatchedStringField(ev.protection,'repository',expectedRepository)||
      hasMismatchedStringField(ev.policy,'repository',expectedRepository)||
      hasMismatchedStringField(ev.snapshot,'repository',expectedRepository)
    ));
  const mismatchedBranch=
    hasMismatchedStringField(scope,'branch',expectedBranch)||
    hasMismatchedStringField(input.intent,'branch',expectedBranch)||
    hasMismatchedStringField(input.intent,'targetBranch',expectedBranch)||
    hasMismatchedStringField(input.intent,'baseRef',expectedBranch)||
    hasMismatchedStringField(ev,'branch',expectedBranch)||
    (ev!==null&&(
      hasMismatchedStringField(ev.protection,'branch',expectedBranch)||
      hasMismatchedStringField(ev.policy,'defaultBranch',expectedBranch)||
      hasMismatchedStringField(ev.snapshot,'baseBranch',expectedBranch)
    ));
  const mismatchedEvidenceNested=ev!==null&&(
    hasMismatchedRepoId(ev.protection,repositoryId)||
    hasMismatchedRepoId(ev.policy,repositoryId)
  );
  if((hasScope&&(!plainJsonObject(scope)||scope.repositoryId!==repositoryId))||
     hasMismatchedRepoId(scope,repositoryId)||
     hasMismatchedRepoId(input.intent,repositoryId)||
     hasMismatchedRepoId(ev,repositoryId)||
     mismatchedEvidenceNested||
     mismatchedRepoName||
     mismatchedBranch) {
    return blockedSquash('PROVENANCE_MISMATCH');
  }
  return evaluator(input.intent,input.evidence,scope);
}

function projectPlanTelemetry(result) {
  const scheduledCount=result.scheduled.length;
  const rawBlocked=Array.isArray(result.blockedTasks)?result.blockedTasks:[];
  const seenReasons=new Set();
  const blockedTasks=[];
  for(let i=0;i<rawBlocked.length&&blockedTasks.length<32;i++) {
    const item=rawBlocked[i];
    const itemReason=plainJsonObject(item)&&typeof item.reason==='string'?item.reason:'OTHER';
    if(!seenReasons.has(itemReason)) {
      seenReasons.add(itemReason);
      blockedTasks.push({reason:itemReason});
    }
  }
  return {
    shadow:true,
    liveDispatch:false,
    reason:result.reason,
    scheduledCount,
    blockedCount:rawBlocked.length,
    scheduled:scheduledCount>0?[1]:[],
    ...(blockedTasks.length>0?{blockedTasks}:{})
  };
}

function telemetryResultFor(command,result) {
  if(command==='--plan-lanes') {
    return projectPlanTelemetry(result);
  }
  if(command==='--reconcile-event'&&plainJsonObject(result)&&typeof result.reason==='string') {
    const mapped=EVENT_TELEMETRY_REASON_MAP.get(result.reason);
    return mapped?{...result,reason:mapped}:result;
  }
  if(command==='--verify-m01-readiness'&&plainJsonObject(result)) {
    if(result.shadow===true&&result.ready===true&&result.liveActivation===false&&
       result.accepted===false&&result.reason==='M01_EXIT_EVIDENCE_READY_ONLY') {
      return {shadow:true,liveDispatch:false,liveMerge:false,reason:'SHADOW_ELIGIBLE'};
    }
    if(result.ready===false&&typeof result.reason==='string') {
      return {
        shadow:true,
        state:'blocked',
        reason:M01_TELEMETRY_REASON_MAP.get(result.reason)??result.reason
      };
    }
  }
  return result;
}

async function observedResult(observe,stage,command,work) {
  let result;
  await observe(stage,async()=>{
    result=await work();
    return telemetrySummary(telemetryResultFor(command,result));
  });
  return result;
}

function buildStageReceipt({env,spec,repositoryId,startedAt,finishedAt,command,result,receiptId:injectedId,quota,cost,humanTouches,correlation}) {
  const {source,receiptId}=resolveReceiptSource(env,spec,finishedAt,injectedId,repositoryId);
  const durationMs=startedAt!==null&&finishedAt!==null&&finishedAt>=startedAt?finishedAt-startedAt:null;
  return createExecutionReceipt({
    source,
    repositoryId,
    receiptId,
    observedMs:finishedAt,
    stage:spec.stage,
    durationMs,
    result:telemetryResultFor(command,result),
    quota,
    cost,
    humanTouches,
    correlation
  });
}

function emitCompletedRun({parsed,wantsReceipt,env,spec,repositoryId,startedAt,clock,result,payload,exitCode,write,writeReceipt,receiptId,quota,cost,humanTouches,correlation}) {
  if(!wantsReceipt) {
    write(JSON.stringify(payload));
    return exitCode;
  }
  const finishedAt=safeClock(clock);
  const receipt=buildStageReceipt({
    env,spec,repositoryId,startedAt,finishedAt,command:parsed.command,
    result,receiptId,quota,cost,humanTouches,correlation
  });
  if(parsed.emitReceipt) {
    write(JSON.stringify(receipt));
    if(typeof writeReceipt==='function') {
      try {writeReceipt(receipt);} catch {}
    }
    return receipt.valid?exitCode:1;
  }
  write(JSON.stringify(payload));
  try {writeReceipt(receipt);} catch {}
  return exitCode;
}

// The injected I/O and inventory functions permit deterministic offline CLI tests.
export async function run(args,options={}) {
  if(options===null||typeof options!=='object'||types.isProxy(options)||Array.isArray(options)) {
    console.error('FACTORY_RUN_FAILED');
    return 1;
  }
  const hasBadOptionGetter=OPTION_GUARDED_KEYS.some(k=>{
    const d=Object.getOwnPropertyDescriptor(options,k);
    return d!==undefined&&!Object.hasOwn(d,'value');
  });
  const {
    write=console.log,
    fail=console.error,
    inventory=readInventory,
    replay=smoke,
    reconcile=reconcilePullTrigger,
    reconcileIssue=reconcileIssueTrigger,
    reconcileEvent=reconcileEventTrigger,
    plan=planLanes,
    evaluateSquash=guardedSquashEvidence,
    verifyAdmission=evaluateCloudAgentAdmission,
    verifyM01Readiness=verifyM01AutonomousExit,
    env=process.env,
    observe=(_stage,work)=>work(),
    clock=Date.now,
    writeReceipt,
    receiptId,
    quota=null,
    cost=null,
    humanTouches=null,
    correlation=null
  }=options;
  const parsed=parseArgs(args);
  if(!parsed) {
    fail(USAGE_TEXT);
    return 2;
  }
  const spec=commandSpecs.get(parsed.command);
  const wantsReceipt=parsed.emitReceipt||typeof writeReceipt==='function';
  const startedAt=wantsReceipt?safeClock(clock):null;
  let effectiveRepositoryId=DEFAULT_REPOSITORY_ID;
  try {
    if(hasBadOptionGetter||(options.request!==undefined&&typeof options.request!=='function')) {
      const blocked={shadow:true,liveDispatch:false,liveMerge:false,state:'blocked',reason:'EVIDENCE_UNKNOWN'};
      await observedResult(observe,spec.stage,parsed.command,async()=>blocked);
      return emitCompletedRun({
        parsed,wantsReceipt,env,spec,repositoryId:null,startedAt,clock,
        result:blocked,payload:blocked,exitCode:1,write,writeReceipt,receiptId,quota,cost,humanTouches,correlation
      });
    }
    const repoBinding=resolveRepositoryBinding(options,env,spec);
    if(!repoBinding.ok) {
      const blocked={shadow:true,liveDispatch:false,liveMerge:false,state:'blocked',reason:'PROVENANCE_MISMATCH'};
      await observedResult(observe,spec.stage,parsed.command,async()=>blocked);
      return emitCompletedRun({
        parsed,wantsReceipt,env,spec,repositoryId:null,startedAt,clock,
        result:blocked,payload:blocked,exitCode:1,write,writeReceipt,receiptId,quota,cost,humanTouches,correlation
      });
    }
    effectiveRepositoryId=repoBinding.repositoryId;
    const inputCheck=parseBoundedInput(options.input,env);
    if(!inputCheck.ok) {
      const blocked={shadow:true,liveDispatch:false,liveMerge:false,state:'blocked',reason:inputCheck.reason};
      await observedResult(observe,spec.stage,parsed.command,async()=>blocked);
      return emitCompletedRun({
        parsed,wantsReceipt,env,spec,repositoryId:effectiveRepositoryId,startedAt,clock,
        result:blocked,payload:blocked,exitCode:1,write,writeReceipt,receiptId,quota,cost,humanTouches,correlation
      });
    }
    const parsedInput=inputCheck.value;
    const reconcileRuntimeOpts=scope=>({
      scope,
      ...(options.request!==undefined?{request:options.request}:{}),
      ...(Object.hasOwn(options,'clock')?{clock}:{})
    });
    const blockedReconcile=reason=>({
      shadow:true,evidenceComplete:false,reconciled:false,liveDispatch:false,liveMerge:false,reason
    });
    const handlers={
      '--smoke':async()=>replay(),
      '--inventory':async()=>{
        const blockedInv={shadow:true,liveDispatch:false,liveMerge:false,state:'blocked',reason:'PROVENANCE_MISMATCH'};
        if(effectiveRepositoryId!==DEFAULT_REPOSITORY_ID) {
          if(inventory===readInventory) return blockedInv;
          const inv=await inventory({
            repositoryId:effectiveRepositoryId,
            ...(repoBinding.repository!==null?{repository:repoBinding.repository}:{})
          });
          if(!plainJsonObject(inv)||inv.repositoryId!==effectiveRepositoryId||
             (Object.hasOwn(inv,'repository')&&(typeof inv.repository!=='string'||
              inv.repository.toLowerCase()===DEFAULT_REPOSITORY.toLowerCase()||
              (repoBinding.repository!==null&&inv.repository!==repoBinding.repository)))) {
            return blockedInv;
          }
          return inv;
        }
        const inv=await inventory();
        if(plainJsonObject(inv)&&((Object.hasOwn(inv,'repositoryId')&&inv.repositoryId!==DEFAULT_REPOSITORY_ID)||
           (Object.hasOwn(inv,'repository')&&inv.repository!==DEFAULT_REPOSITORY))) {
          return blockedInv;
        }
        return inv;
      },
      '--reconcile-pull':async()=>{
        const scopeCheck=resolveReconcileScope(repoBinding,undefined);
        if(!scopeCheck.ok) return blockedReconcile(scopeCheck.reason);
        return scopeCheck.isDefaultUnscoped&&options.request===undefined
          ?reconcile(env)
          :reconcile(env,reconcileRuntimeOpts(scopeCheck.scope));
      },
      '--reconcile-issue':async()=>{
        const scopeCheck=resolveReconcileScope(repoBinding,undefined);
        if(!scopeCheck.ok) return blockedReconcile(scopeCheck.reason);
        return scopeCheck.isDefaultUnscoped&&options.request===undefined
          ?reconcileIssue(env)
          :reconcileIssue(env,reconcileRuntimeOpts(scopeCheck.scope));
      },
      '--reconcile-event':async()=>{
        if(parsedInput!==undefined) {
          if(!Object.keys(parsedInput).every(k=>RECONCILE_EVENT_INPUT_KEYS.has(k))) {
            return blockedReconcile('EVIDENCE_UNKNOWN');
          }
          if(hasMismatchedRepoId(parsedInput,effectiveRepositoryId)||
             hasMismatchedRepoId(parsedInput.scope,effectiveRepositoryId)) {
            return blockedReconcile('PROVENANCE_MISMATCH');
          }
        }
        const scopeCheck=resolveReconcileScope(repoBinding,parsedInput);
        if(!scopeCheck.ok) return blockedReconcile(scopeCheck.reason);
        if(scopeCheck.isDefaultUnscoped&&options.request===undefined) {
          return sanitizeEventResult(await reconcileEvent(env));
        }
        const extraOpts={};
        for(const k of ['snapshot','owner','leaseMs']) {
          if(parsedInput!==undefined&&Object.hasOwn(parsedInput,k)) extraOpts[k]=parsedInput[k];
        }
        return sanitizeEventResult(await reconcileEvent(env,{...reconcileRuntimeOpts(scopeCheck.scope),...extraOpts}));
      },
      '--plan-lanes':async()=>{
        const blockedPlan=reason=>({shadow:true,liveDispatch:false,ready:[],scheduled:[],reason});
        if(parsedInput===undefined||!Object.keys(parsedInput).every(k=>PLAN_INPUT_KEYS.has(k))||
           !Object.hasOwn(parsedInput,'config')||!Object.hasOwn(parsedInput,'tasks')) {
          return blockedPlan('INVALID_TASKS');
        }
        if(!validateProjectConfig(parsedInput.config)) {
          return blockedPlan('INVALID_PROJECT_CONFIG');
        }
        if(repoBinding.repository===null||
           (effectiveRepositoryId!==DEFAULT_REPOSITORY_ID&&env?.GITHUB_ACTIONS==='true'&&env?.GITHUB_REPOSITORY!==repoBinding.repository)||
           parsedInput.config.project.repository!==repoBinding.repository) {
          return blockedPlan('PROVENANCE_MISMATCH');
        }
        if(parsedInput.config.execution.enabled!==true||parsedInput.config.execution.stop!==false) {
          return blockedPlan('STOPPED');
        }
        return normalizePlanResult(await plan(parsedInput.config,parsedInput.tasks,parsedInput.active,parsedInput.policy));
      },
      '--evaluate-squash':async()=>evaluateProtectedSquash(parsedInput,{
        repositoryId:effectiveRepositoryId,
        repository:repoBinding.repository,
        branch:repoBinding.branch
      },evaluateSquash),
      '--verify-admission':async()=>{
        if(plainJsonObject(parsedInput)&&(hasMismatchedRepoId(parsedInput,effectiveRepositoryId)||
           (Object.hasOwn(parsedInput,'approvedRepositoryId')&&parsedInput.approvedRepositoryId!==effectiveRepositoryId))) {
          return {
            shadow:true,liveDispatch:false,admitted:false,state:'blocked',
            reason:'PROVENANCE_MISMATCH',admissionCode:'REPOSITORY_SCOPE_MISMATCH',
            detail:'REPOSITORY_SCOPE_MISMATCH',actualWorkerMax:0,workerShortfallFrom12:12
          };
        }
        return verifyAdmission(parsedInput);
      },
      '--verify-m01-readiness':async()=>{
        if(plainJsonObject(parsedInput)&&(
           hasMismatchedRepoId(parsedInput,effectiveRepositoryId)||
           hasMismatchedRepoId(parsedInput.policy,effectiveRepositoryId)||
           hasMismatchedRepoId(parsedInput.readiness,effectiveRepositoryId)||
           (Array.isArray(parsedInput.cycles)&&parsedInput.cycles.some(c=>hasMismatchedRepoId(c,effectiveRepositoryId))))) {
          return {shadow:true,ready:false,liveActivation:false,accepted:false,reason:'IDENTITY_OR_PIN'};
        }
        return verifyM01Readiness(parsedInput);
      }
    };
    const result=await observedResult(observe,spec.stage,parsed.command,handlers[parsed.command]);
    const exitCode=parsed.command==='--smoke'
      ?(result.reason==='SHADOW_PLAN'&&Array.isArray(result.ready)&&result.ready.join(',')==='1,2'?0:1)
      :(parsed.command==='--inventory'&&plainJsonObject(result)&&result.reason==='PROVENANCE_MISMATCH'?1:0);
    const payload=parsed.command==='--smoke'
      ?{mode:'synthetic',...result,liveDispatch:false,liveMerge:false}
      :result;
    return emitCompletedRun({
      parsed,wantsReceipt,env,spec,repositoryId:effectiveRepositoryId,startedAt,clock,
      result,payload,exitCode,write,writeReceipt,receiptId,quota,cost,humanTouches,correlation
    });
  } catch {
    if(wantsReceipt) {
      const finishedAt=safeClock(clock);
      const receipt=buildStageReceipt({
        env,spec,repositoryId:effectiveRepositoryId,startedAt,finishedAt,command:parsed.command,
        result:{reason:'READ_FAILED'},receiptId,quota,cost,humanTouches,correlation
      });
      if(parsed.emitReceipt) {
        try {write(JSON.stringify(receipt));} catch {}
      }
      if(typeof writeReceipt==='function') {
        try {writeReceipt(receipt);} catch {}
      }
    }
    fail('FACTORY_RUN_FAILED');
    return 1;
  }
}
export async function runCliIfDirect(entrypoint,moduleUrl,args,setExitCode=value=>{process.exitCode=value;}) {
  if(entrypoint && pathToFileURL(entrypoint).href===moduleUrl) {
    setExitCode(await run(args));
    return true;
  }
  return false;
}
await runCliIfDirect(process.argv[1],import.meta.url,process.argv.slice(2));
