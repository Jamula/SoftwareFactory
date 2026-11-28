// OpenTelemetry API boundary and laptop-free sanitized execution receipts.
import {types} from 'node:util';
import {normalizeStageDurations} from './stage-latency.mjs';

export const EXECUTION_RECEIPT_SCHEMA_VERSION=1;
const stages=new Set([
  'reconcile','normalize','evaluate','dispatch','ci','queue','review','merge-shadow','verify-main','acceptance'
]);
const outcomes=new Set(['eligible','blocked','failed','unknown']);
const reasons=new Set([
  'NONE','INVALID_EVIDENCE','STALE','DEPENDENCY','QUOTA','POLICY',
  'SECURITY','LEASE','REVIEW','COVERAGE','CHECKS','RUNTIME','OTHER'
]);
const reasonLabels=new Map([
  ['NONE','NONE'],['INVALID_EVIDENCE','INVALID_EVIDENCE'],['STALE','STALE'],
  ['DEPENDENCY','DEPENDENCY'],['QUOTA','QUOTA'],['POLICY','POLICY'],
  ['SECURITY','SECURITY'],['LEASE','LEASE'],['REVIEW','REVIEW'],
  ['CHECKS','CHECKS'],['RUNTIME','RUNTIME'],
  ['SHADOW_PLAN','NONE'],['SHADOW_ELIGIBLE','NONE'],['SHADOW_SQUASH_ELIGIBLE','NONE'],
  ['SHADOW_MAIN_VERIFIED','NONE'],['SHADOW_RECONCILED','NONE'],['SHADOW_TICK_COMPLETE','NONE'],
  ['SHADOW_PLATFORM_GATES_ONLY','NONE'],['PULL_IDENTITY_MATCHED','NONE'],
  ['ISSUE_IDENTITY_MATCHED','NONE'],['IDENTITY_ONLY','NONE'],['NORMALIZED_ONLY','NONE'],
  ['NO_READY_WORK','NONE'],['NO_CLAIM','NONE'],['NO_RECOVERABLE_INTENT','NONE'],
  ['QUEUED','NONE'],['SHADOW_CAPACITY','NONE'],['SHADOW_ALLOCATION','NONE'],
  ['REQUEST_SIMULATED','NONE'],['REQUEST_RECONCILED','NONE'],
  ['STOPPED','POLICY'],['ACTIVE_OWNERSHIP_CONFLICT','POLICY'],['ACTIVE_PATH_CONFLICT','POLICY'],
  ['INVALID_PROJECT_CONFIG','POLICY'],['INVALID_POLICY','POLICY'],['POLICY_UNKNOWN','POLICY'],
  ['PLATFORM_POLICY_INCOMPLETE','POLICY'],['QUEUE_PATH_REQUIRED','POLICY'],
  ['SCHEDULING_POLICY_UNKNOWN','POLICY'],['RISK_OR_PRIORITY_UNKNOWN','POLICY'],
  ['RISK_ABOVE_CEILING','POLICY'],['PATH_OWNERSHIP_UNKNOWN','POLICY'],
  ['PILOT_ENTRY_BLOCKED','POLICY'],['M01_PREREQUISITES_UNVERIFIED','POLICY'],
  ['POLICY_BELOW_M01_TARGET','POLICY'],['POLICY_BELOW_MINIMUM','POLICY'],
  ['POLICY_WEAKENING_REJECTED','POLICY'],['CONSUMER_FROZEN','POLICY'],
  ['REPO_KILL_SWITCH_ACTIVE','POLICY'],['STOPPED_BY_KILL_SWITCH','POLICY'],
  ['CONNECTOR_STOPPED','POLICY'],['LIVE_DISPATCH_DISABLED','POLICY'],
  ['LAPTOP_DEPENDENCY_FORBIDDEN','POLICY'],['PYTHON_INVOCATION_FORBIDDEN','POLICY'],
  ['OUT_OF_LANE_EDIT','POLICY'],['OUT_OF_LANE_TOUCHED_PATHS','POLICY'],
  ['LANE_OWNERSHIP_VIOLATION','POLICY'],['RETRY_CAP_EXCEEDED','POLICY'],
  ['RETRY_CEILING_EXCEEDED','POLICY'],['MERGED_WHILE_DRAFT','POLICY'],
  ['INDEPENDENT_ROLLBACK_UNVERIFIED','POLICY'],['HUMAN_INTERVENTION_NONZERO','POLICY'],
  ['SYNTHETIC_CYCLES_NOT_DELIVERED_WORK','POLICY'],
  ['INVALID_EVENT_TRIGGER_CONFIG','POLICY'],['INVALID_RECOVERY_SCHEDULE','POLICY'],
  ['INVALID_WORK_QUEUE_BRANCH','POLICY'],['MISSING_BOT_LOOP_GUARD','POLICY'],
  ['MISSING_DEFAULT_OFF_GUARD','POLICY'],['MISSING_RECOVERY_SCHEDULE','POLICY'],
  ['MISSING_REQUIRED_EVENT_TRIGGER','POLICY'],['UNSUPPORTED_EVENT_TRIGGER','POLICY'],
  ['CAPACITY_UNKNOWN','QUOTA'],['CAPACITY_UNVERIFIED','QUOTA'],['CAPACITY_EXHAUSTED','QUOTA'],
  ['CAPACITY_FULL','QUOTA'],['NO_SCOPED_CAPACITY','QUOTA'],['BUDGET_UNKNOWN','QUOTA'],
  ['BUDGET_OR_CONCURRENCY','QUOTA'],['INVALID_QUOTA','QUOTA'],['RATE_OR_PERMISSION_UNKNOWN','QUOTA'],
  ['RATE_LIMIT_OR_UNKNOWN','QUOTA'],['PROVIDER_INELIGIBLE_OR_QUOTA','QUOTA'],['JOURNAL_FULL','QUOTA'],
  ['AI_CREDIT_ACCOUNTING_UNVERIFIED','QUOTA'],['AI_CREDIT_CAP_EXCEEDED','QUOTA'],
  ['AI_CREDIT_ANOMALY','QUOTA'],['ACCOUNTING_ESTIMATED_OR_MISSING','QUOTA'],
  ['INCLUDED_QUOTA_NOT_ATTRIBUTED','QUOTA'],['INCREMENTAL_SPEND_NONZERO','QUOTA'],
  ['PAID_OVERAGE_ALLOWED','QUOTA'],['OVERAGE_LIMIT_NONZERO','QUOTA'],
  ['OVERAGE_ENABLED','QUOTA'],['BUDGET_OR_CAPACITY_UNKNOWN','QUOTA'],
  ['WORKER_CAPACITY_UNVERIFIED','QUOTA'],['WORKER_CAPACITY_UNKNOWN','QUOTA'],
  ['WORKER_LADDER_VIOLATION','QUOTA'],['QUOTA_UNVERIFIED','QUOTA'],
  ['QUOTA_REMAINING_REQUIRED','QUOTA'],['PORTFOLIO_CAPACITY_EXHAUSTED','QUOTA'],
  ['REPO_CONCURRENCY_CAP_REACHED','QUOTA'],['SPEND_UNKNOWN_OR_EXCEEDED','QUOTA'],
  ['UNAPPROVED_SPEND_FORBIDDEN','QUOTA'],['BASELINE_UNAPPROVED_SPEND','QUOTA'],
  ['COST_REGRESSION','QUOTA'],['SAFETY_OR_COST_UNKNOWN','QUOTA'],
  ['TRUST_UNKNOWN','SECURITY'],['PROVENANCE_MISMATCH','SECURITY'],['UNTRUSTED_POLICY','SECURITY'],
  ['STOPPED_OR_UNAUTHORIZED','SECURITY'],['PROTECTIONS_UNVERIFIED','SECURITY'],
  ['THREADS_OR_SECURITY_UNKNOWN','SECURITY'],['PROVIDER_FORBIDDEN','SECURITY'],
  ['UNSAFE_TELEMETRY_PAYLOAD','SECURITY'],['INVALID_TRACEPARENT','SECURITY'],
  ['TRACE_ID_MISMATCH','SECURITY'],['SPAN_LINKAGE_BROKEN','SECURITY'],
  ['DUPLICATE_SPAN_ID','SECURITY'],['ROOT_PARENT_SPAN_MUST_BE_NULL','SECURITY'],
  ['INVALID_GH_AW_LOCK_HASH','SECURITY'],['UNSIGNED_CANDIDATE_COMMIT','SECURITY'],
  ['SAFE_OUTPUTS_THREAT_FLAGGED','SECURITY'],['PROTECTED_CONTROL_PLANE_TOUCH','SECURITY'],
  ['UNSAFE_PATH_TRAVERSAL','SECURITY'],['FORCE_UPDATE_FORBIDDEN','SECURITY'],
  ['UNPROTECTED_WORK_QUEUE_REF','SECURITY'],['CROSS_REPO_CANDIDATE_REJECTED','SECURITY'],
  ['CROSS_REPO_ACCESS_DENIED','SECURITY'],['CROSS_REPO_DATA_REJECTED','SECURITY'],
  ['CROSS_REPO_ISOLATION_VIOLATION','SECURITY'],['CROSS_REPO_PRIVATE_DATA_REJECTED','SECURITY'],
  ['PROVENANCE_ISOLATION_VIOLATION','SECURITY'],['EVIDENCE_CLASS_MIXING_FORBIDDEN','SECURITY'],
  ['SEPARATE_AUTHORIZATION_REQUIRED','SECURITY'],['AUTHORIZATION_REPO_MISMATCH','SECURITY'],
  ['UNAUTHORIZED_REPOSITORY','SECURITY'],['REPOSITORY_NOT_AUTHORIZED','SECURITY'],
  ['IDENTITY_OR_PIN','SECURITY'],['ENVIRONMENT_UNVERIFIED','SECURITY'],
  ['LIVE_REPO_OR_PRIVATE_DATA_FORBIDDEN','SECURITY'],['PRODUCTION_ISOLATION_VIOLATION','SECURITY'],
  ['SECRET_OR_CREDENTIAL_DETECTED','SECURITY'],['PROMPT_INJECTION_DETECTED','SECURITY'],
  ['UNTRUSTED_INSTRUCTION_SOURCE','SECURITY'],['UNTRUSTED_PROVENANCE','SECURITY'],
  ['UNTRUSTED_CODEQL_PRODUCER','SECURITY'],['OS_ROOT_TRUST_MODIFIED','SECURITY'],
  ['LOOPBACK_AUTH_UNVERIFIED','SECURITY'],['NON_GITHUB_HOSTED_RUNNER','SECURITY'],
  ['RULESET_INCOMPLETE','SECURITY'],['RULESET_UNKNOWN','SECURITY'],
  ['SECURITY_GATE_BLOCKED','SECURITY'],['PERMISSION_BOUNDARY_BLOCKED','SECURITY'],
  ['AGENT_JOB_WRITE_PERMISSION','SECURITY'],['BODY_HASH_MISMATCH','SECURITY'],
  ['CHECKOUT_CREDENTIALS_PERSISTED','SECURITY'],['EXCESSIVE_SAFE_OUTPUT_PERMISSION','SECURITY'],
  ['FRONTMATTER_HASH_MISMATCH','SECURITY'],['FRONTMATTER_HASH_MISSING','SECURITY'],
  ['MAIN_MERGE_FORBIDDEN_IN_GHAW','SECURITY'],['MISSING_THREAT_SCAN_GATE','SECURITY'],
  ['PINNED_RELEASE_INVALID','SECURITY'],['PINNED_RELEASE_MISMATCH','SECURITY'],
  ['UNPINNED_ACTION_REFERENCE','SECURITY'],['UNSAFE_RUN_INTERPOLATION','SECURITY'],
  ['UNTRUSTED_PR_CHECKOUT','SECURITY'],['UNTRUSTED_PR_TEXT_INTERPOLATION','SECURITY'],
  ['UNTRUSTED_SAFE_OUTPUT_CHECKOUT','SECURITY'],
  ['STALE_EVENT','STALE'],['HEAD_CHANGED','STALE'],['BASE_CHANGED','STALE'],
  ['STALE_HEAD_OR_BASE','STALE'],['SCOPE_OR_HEAD_CHANGED','STALE'],['HEAD_OR_BASE_MISMATCH','STALE'],
  ['BASE_MOVED_SINCE_VERIFICATION','STALE'],['TASK_STATE_CHANGED','STALE'],
  ['SHADOW_HEAD_SUPERSEDED','STALE'],['DUPLICATE_DELIVERY','STALE'],['STALE_QUOTA','STALE'],
  ['STALE_EVIDENCE','STALE'],['STALE_CONTRACT','STALE'],['STALE_OR_UNKNOWN_EVIDENCE','STALE'],
  ['STALE_HARD_STOP_RECEIPT','STALE'],['STALE_BILLING_HARD_STOP_RECEIPT','STALE'],
  ['STALE_SMOKE_RECEIPT','STALE'],['STALE_HEAD_SUPERSEDED','STALE'],
  ['STALE_OR_INACTIVE_RUN','STALE'],['OUT_OF_ORDER_EVENT','STALE'],
  ['DUPLICATE_OR_UNKNOWN','STALE'],['DUPLICATE_CYCLE','STALE'],
  ['REVIEW_HEAD_MISMATCH','STALE'],['CANDIDATE_HEAD_MISMATCH','STALE'],
  ['BASE_NOT_STRICT_UP_TO_DATE','STALE'],['PATH_CONFLICT_REBASE_REQUIRED','STALE'],
  ['UNKNOWN_DEPENDENCY','DEPENDENCY'],['DEPENDENCY_UNKNOWN','DEPENDENCY'],
  ['DEPENDENCY_CYCLE','DEPENDENCY'],['DEPENDENCIES_BLOCKED','DEPENDENCY'],
  ['DEPENDENCY_UNACCEPTED','DEPENDENCY'],['DEPENDENCIES_UNKNOWN','DEPENDENCY'],['TASK_BLOCKED','DEPENDENCY'],
  ['UPSTREAM_BLOCKED','DEPENDENCY'],['M01_UPSTREAM_NOT_ACCEPTED','DEPENDENCY'],
  ['FAMILYTREE_PILOT_NOT_ACCEPTED','DEPENDENCY'],
  ['LEASE_HELD','LEASE'],['LEASE_LOST','LEASE'],['LEASE_UNAVAILABLE','LEASE'],['CLAIM_LOST','LEASE'],
  ['LEASE_OR_CLOCK_UNKNOWN','LEASE'],['WORK_RESERVATION_UNKNOWN','LEASE'],
  ['ACTIVE_RESERVATIONS_UNAVAILABLE','LEASE'],['STALE_CHECKPOINT','LEASE'],
  ['SERIALIZED_OR_RECOVERY_REQUIRED','LEASE'],['INTENT_UNAVAILABLE_OR_CLAIMED','LEASE'],
  ['LANE_OR_PATH_RESERVED','LEASE'],['CAS_CONFLICT','LEASE'],['LEASE_CONFLICT','LEASE'],
  ['LEASE_NOT_HELD','LEASE'],['NOT_HELD','LEASE'],['HELD','LEASE'],
  ['STALE_GENERATION','LEASE'],['INVALID_LEASE','LEASE'],['INVALID_LEASE_TTL','LEASE'],
  ['INVALID_CAS_LEASE','LEASE'],['EXECUTION_TTL_INVALID','LEASE'],
  ['SCOPE_OR_LEASE_UNKNOWN','LEASE'],['MISSING_CONCURRENCY_GUARD','LEASE'],
  ['WORK_QUEUE_PROTOCOL_UNSUPPORTED','LEASE'],['UNAUTHORIZED_CONCURRENT_AGENT_CLAIM','LEASE'],
  ['PATH_OVERLAP_DEFERRED','LEASE'],
  ['REVIEW_UNVERIFIED','REVIEW'],['REVIEW_MISSING','REVIEW'],['REVIEW_INCOMPLETE','REVIEW'],
  ['AGENT_REVIEW_FAILED','REVIEW'],['REVIEW_READ_FAILED','REVIEW'],
  ['AMBIGUOUS_REVIEW_HISTORY','REVIEW'],['FORMAL_REVIEW_MISSING','REVIEW'],
  ['FORMAL_APPROVAL_REQUIRED','REVIEW'],['INDEPENDENT_REVIEW_REQUIRED','REVIEW'],
  ['INDEPENDENT_REVIEW_INCOMPLETE','REVIEW'],['REVIEW_PENDING','REVIEW'],
  ['SELF_APPROVAL_FORBIDDEN','REVIEW'],['SELF_REVIEW_FORBIDDEN','REVIEW'],
  ['UNAUTHORIZED_REVIEWER','REVIEW'],['REVIEW_HISTORY_INCOMPLETE','REVIEW'],
  ['OUTSTANDING_CHANGES_REQUESTED','REVIEW'],['OUTSTANDING_DISMISSED_REVIEW','REVIEW'],
  ['REVIEW_FINDINGS_UNRESOLVED','REVIEW'],['REVIEW_NOT_ACCEPTABLE','REVIEW'],
  ['REVIEW_HISTORY_INCONSISTENT','REVIEW'],['IDENTITY_OR_REVIEW_UNKNOWN','REVIEW'],
  ['COVERAGE_UNVERIFIED','COVERAGE'],['COVERAGE_INCOMPLETE','COVERAGE'],['COVERAGE','COVERAGE'],
  ['COVERAGE_BELOW_THRESHOLD','COVERAGE'],['COMPONENT_BELOW_TARGET','COVERAGE'],
  ['BRANCHLESS_UNJUSTIFIED','COVERAGE'],['BRANCHLESS_REVIEWER_UNAUTHORIZED','COVERAGE'],
  ['COVERAGE_COUNTS_MISMATCH','COVERAGE'],['COVERAGE_RULESET_BELOW_TARGET','COVERAGE'],
  ['COVERAGE_BELOW_CONSUMER_GATE','COVERAGE'],['COVERAGE_BELOW_POLICY','COVERAGE'],
  ['COVERAGE_BELOW_FLOOR','COVERAGE'],['COVERAGE_FLOOR_VIOLATION','COVERAGE'],
  ['COVERAGE_REGRESSION','COVERAGE'],['COVERAGE_REGRESSED','COVERAGE'],
  ['BASELINE_COVERAGE_BELOW_FLOOR','COVERAGE'],['DOTNET_COVERAGE_BELOW_TARGET','COVERAGE'],
  ['JS_COVERAGE_BELOW_TARGET','COVERAGE'],
  ['CHECKS_INCOMPLETE','CHECKS'],['MAIN_VERIFICATION_REQUIRED','CHECKS'],
  ['BASE_OR_MAIN_UNHEALTHY','CHECKS'],['ACCEPTANCE_INCOMPLETE','CHECKS'],['GITHUB_NOT_CLEAN','CHECKS'],
  ['MAIN_UNHEALTHY','CHECKS'],['MAIN_OR_TRAIN_UNREADY','CHECKS'],['REPO_MAIN_UNHEALTHY','CHECKS'],
  ['POST_MERGE_MAIN_FAILED','CHECKS'],['CODEQL_PYTHON_RESIDUAL','CHECKS'],
  ['CODEQL_CHECKS_INCOMPLETE','CHECKS'],['MISSING_CODEQL_CHECKS','CHECKS'],
  ['REQUIRED_CHECKS_INCOMPLETE','CHECKS'],['REQUIRED_CHECKS_MISSING','CHECKS'],
  ['CHECKS_OR_SECURITY_INCOMPLETE','CHECKS'],['RUNTIME_JOB_NOT_SUCCESSFUL','CHECKS'],
  ['MISSING_EVALUATION_JOB','CHECKS'],['LIVE_CYCLES_PENDING','CHECKS'],['SCENARIO_MISSING','CHECKS'],
  ['INVALID_ISSUE','INVALID_EVIDENCE'],['INVALID_PULL','INVALID_EVIDENCE'],
  ['INVALID_EVENT','INVALID_EVIDENCE'],['IDENTITY_UNKNOWN','INVALID_EVIDENCE'],
  ['RESPONSE_LIMIT','INVALID_EVIDENCE'],['INVALID_TASKS','INVALID_EVIDENCE'],
  ['INVALID_TASK','INVALID_EVIDENCE'],['INVALID_INVENTORY','INVALID_EVIDENCE'],
  ['INVALID_ACTIVE_LANE','INVALID_EVIDENCE'],['EVIDENCE_UNKNOWN','INVALID_EVIDENCE'],
  ['INTENT_UNKNOWN','INVALID_EVIDENCE'],['MERGE_RECEIPT_UNKNOWN','INVALID_EVIDENCE'],
  ['GATES_UNKNOWN','INVALID_EVIDENCE'],['INVALID_IDENTITY','INVALID_EVIDENCE'],
  ['DELIVERY_CONFLICT','INVALID_EVIDENCE'],['INVALID_CANDIDATE','INVALID_EVIDENCE'],
  ['INVALID_RECEIPT','INVALID_EVIDENCE'],['INVALID_MISSION_CONTROL_TASK','INVALID_EVIDENCE'],
  ['INVALID_CAS_REQUEST','INVALID_EVIDENCE'],['INVALID_NEXT_STATE','INVALID_EVIDENCE'],
  ['INVALID_QUEUE_STATE','INVALID_EVIDENCE'],['UNKNOWN_WORK_ID','INVALID_EVIDENCE'],
  ['INVALID_FRONTMATTER','INVALID_EVIDENCE'],['INVALID_LOCK_INPUT','INVALID_EVIDENCE'],
  ['INVALID_LOCK_METADATA','INVALID_EVIDENCE'],['INVALID_LOCK_YAML','INVALID_EVIDENCE'],
  ['PREREQUISITES_UNKNOWN','INVALID_EVIDENCE'],['INVENTORY_UNKNOWN','INVALID_EVIDENCE'],
  ['CYCLE_INVENTORY_UNKNOWN','INVALID_EVIDENCE'],['BATCH_BOUNDARY_UNKNOWN','INVALID_EVIDENCE'],
  ['SOURCE_UNKNOWN','INVALID_EVIDENCE'],['TIMING_OR_SCENARIO_UNKNOWN','INVALID_EVIDENCE'],
  ['READ_FAILED','RUNTIME'],['TASK_READ_FAILED','RUNTIME'],['CLOCK_UNAVAILABLE','RUNTIME'],
  ['CLOCK_UNKNOWN','RUNTIME'],['RUNTIME_UNKNOWN','RUNTIME'],['INVALID_RUNTIME','RUNTIME'],
  ['LANE_FAILED','RUNTIME'],['JOURNAL_UNAVAILABLE','RUNTIME'],['RECONCILIATION_UNAVAILABLE','RUNTIME'],
  ['FRESH_EVIDENCE_UNAVAILABLE','RUNTIME'],['RECOVERY_REQUIRED','RUNTIME'],
  ['PROVIDER_UNKNOWN','RUNTIME'],['PROVIDER_RESPONSE_UNKNOWN','RUNTIME'],
  ['REQUEST_OUTCOME_UNKNOWN','RUNTIME'],['DEFERRED_TRANSIENT','RUNTIME'],
  ['REF_STORE_UNAVAILABLE','RUNTIME'],['STORE_UNAVAILABLE','RUNTIME'],['EXECUTION_TIMEOUT','RUNTIME']
]);
const failedCodes=new Set([
  'READ_FAILED','TASK_READ_FAILED','LEASE_UNAVAILABLE','CLOCK_UNAVAILABLE','AGENT_REVIEW_FAILED',
  'LANE_FAILED','INVALID_RUNTIME','RUNTIME_UNKNOWN','CLOCK_UNKNOWN','JOURNAL_UNAVAILABLE',
  'RECONCILIATION_UNAVAILABLE','FRESH_EVIDENCE_UNAVAILABLE','RECOVERY_REQUIRED',
  'ACTIVE_RESERVATIONS_UNAVAILABLE','REVIEW_READ_FAILED','PROVIDER_UNKNOWN',
  'PROVIDER_RESPONSE_UNKNOWN','REQUEST_OUTCOME_UNKNOWN','REF_STORE_UNAVAILABLE',
  'STORE_UNAVAILABLE','EXECUTION_TIMEOUT','RUNTIME'
]);
const eligibleCodes=new Set([
  'SHADOW_ELIGIBLE','SHADOW_SQUASH_ELIGIBLE','SHADOW_MAIN_VERIFIED','SHADOW_RECONCILED',
  'SHADOW_PLATFORM_GATES_ONLY','QUEUED','SHADOW_CAPACITY','SHADOW_ALLOCATION',
  'REQUEST_SIMULATED','REQUEST_RECONCILED'
]);
const unknownCodes=new Set([
  'PULL_IDENTITY_MATCHED','ISSUE_IDENTITY_MATCHED','IDENTITY_ONLY','NORMALIZED_ONLY',
  'NO_CLAIM','NO_RECOVERABLE_INTENT'
]);

function ownValue(value,key) {
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  return descriptor!==undefined&&Object.hasOwn(descriptor,'value')?descriptor.value:undefined;
}

function plainResultValue(value,budget={remaining:2048},depth=0) {
  if(--budget.remaining<0||depth>6||types.isProxy(value)) return false;
  if(value===null||['string','number','boolean'].includes(typeof value)) return true;
  if(typeof value!=='object') return false;
  if(Array.isArray(value)) {
    if(Object.getPrototypeOf(value)!==Array.prototype||value.length>500||
       Reflect.ownKeys(value).length!==value.length+1) return false;
    for(let i=0;i<value.length;i++) {
      const descriptor=Object.getOwnPropertyDescriptor(value,i);
      if(!descriptor||!Object.hasOwn(descriptor,'value')||!plainResultValue(descriptor.value,budget,depth+1))
        return false;
    }
    return true;
  }
  if(Object.getPrototypeOf(value)!==Object.prototype) return false;
  const keys=Reflect.ownKeys(value);
  if(keys.length>64) return false;
  for(const key of keys) {
    if(typeof key!=='string') return false;
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(!Object.hasOwn(descriptor,'value')||!plainResultValue(descriptor.value,budget,depth+1)) return false;
  }
  return true;
}

export function telemetrySummary(result) {
  if(result===null||result===undefined||typeof result!=='object') return {outcome:'unknown',reason:'NONE'};
  if(!plainResultValue(result)) return {outcome:'unknown',reason:'OTHER'};
  const rawReason=ownValue(result,'reason');
  const code=typeof rawReason==='string'?rawReason:'';
  if(code==='SHADOW_TICK_COMPLETE') {
    const completed=ownValue(result,'completed');
    if(!Array.isArray(completed)||completed.length===0) return {outcome:'unknown',reason:'NONE'};
    const summaries=completed.map(item=>telemetrySummary(item));
    const failure=summaries.find(item=>item.outcome==='failed');
    if(failure) return failure;
    const blocked=summaries.find(item=>item.outcome!=='eligible');
    return blocked??{outcome:'eligible',reason:'NONE'};
  }
  const state=ownValue(result,'state');
  const reconciled=ownValue(result,'reconciled');
  if(!code) {
    if(state==='shadow-reviewed') return {outcome:'eligible',reason:'NONE'};
    if(reconciled===false||state==='blocked') return {outcome:'blocked',reason:'NONE'};
    return {outcome:'unknown',reason:'NONE'};
  }
  const reason=reasonLabels.get(code)??'OTHER';
  if(failedCodes.has(code)) return {outcome:'failed',reason};
  if(reconciled===false||state==='blocked'||ownValue(result,'accepted')===false||ownValue(result,'eligible')===false)
    return {outcome:'blocked',reason};
  const explicitOutcome=ownValue(result,'outcome');
  if(reasons.has(code)&&outcomes.has(explicitOutcome)) return {outcome:explicitOutcome,reason:code};
  if(code==='NO_READY_WORK') {
    const blockedTasks=ownValue(result,'blockedTasks');
    if(Array.isArray(blockedTasks)&&blockedTasks.length>0) {
      const summaries=blockedTasks.map(item=>{
        const summary=telemetrySummary(item);
        return summary.outcome==='failed'?summary:{outcome:'blocked',reason:summary.reason};
      });
      return summaries.find(item=>item.outcome==='failed')??summaries[0];
    }
    return {outcome:'unknown',reason:'NONE'};
  }
  if(reconciled===true||unknownCodes.has(code)) return {outcome:'unknown',reason};
  if(code==='SHADOW_PLAN') {
    const ready=ownValue(result,'ready');
    const scheduled=ownValue(result,'scheduled');
    const planned=(Array.isArray(ready)&&ready.length>0)||(Array.isArray(scheduled)&&scheduled.length>0);
    return {outcome:planned?'eligible':'unknown',reason};
  }
  if(eligibleCodes.has(code)) return {outcome:'eligible',reason};
  if(reason!=='OTHER') return {outcome:'blocked',reason};
  return {outcome:'unknown',reason:'OTHER'};
}

const plainObject=v=>v!==null&&typeof v==='object'&&!types.isProxy(v)&&Object.getPrototypeOf(v)===Object.prototype;
const ownData=(v,keys)=>plainObject(v)&&Reflect.ownKeys(v).every(k=>typeof k==='string'&&keys.has(k)&&
  Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'));
const exactData=(v,keys)=>plainObject(v)&&Reflect.ownKeys(v).length===keys.length&&
  keys.every(k=>Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)??{},'value'));
const positive=n=>Number.isSafeInteger(n)&&n>0;
const nonnegative=n=>Number.isSafeInteger(n)&&n>=0;
const receiptToken=s=>typeof s==='string'&&/^[a-zA-Z0-9-]{1,64}$/.test(s);
const traceHex=s=>typeof s==='string'&&/^(?!0{32}$)[a-f0-9]{32}$/.test(s);
const spanHex=s=>typeof s==='string'&&/^(?!0{16}$)[a-f0-9]{16}$/.test(s);
const receiptInputKeys=new Set([
  'source','repositoryId','receiptId','observedMs','stage','result','outcome','reason',
  'durationMs','stages','quota','cost','humanTouches','correlation','shadow','liveDispatch','liveMerge'
]);
const receiptKeys=[
  'schemaVersion','valid','shadow','liveDispatch','liveMerge','source','repositoryId','receiptId',
  'observedMs','stage','outcome','reason','durationMs','stages','quota','cost','humanTouches','correlation'
];
const scorecardStageMap=new Map([
  ['reconcile','reconcile'],['dispatch','dispatch'],['ci','ci'],['review','review'],
  ['merge-shadow','merge'],['verify-main','verify-main'],['acceptance','acceptance']
]);

function normalizeQuota(quota) {
  if(quota===undefined||quota===null) return {state:'unknown',verified:false,includedOnly:null};
  if(exactData(quota,['verified'])&&quota.verified===false)
    return {state:'unknown',verified:false,includedOnly:null};
  if(exactData(quota,['verified','includedOnly','available'])&&quota.verified===true&&
     quota.includedOnly===true&&typeof quota.available==='boolean')
    return {state:quota.available?'verified-included':'exhausted',verified:true,includedOnly:true};
  return null;
}

function normalizeCost(cost) {
  if(cost===undefined||cost===null) return {state:'unknown',verified:false,currency:null,amountMicros:null};
  if(exactData(cost,['verified'])&&cost.verified===false)
    return {state:'unknown',verified:false,currency:null,amountMicros:null};
  if(exactData(cost,['verified','currency','amountMicros'])&&cost.verified===true&&
     cost.currency==='USD'&&cost.amountMicros===0)
    return {state:'verified-zero',verified:true,currency:'USD',amountMicros:0};
  return null;
}

function normalizeHumanTouches(touches) {
  if(touches===undefined||touches===null) return {state:'unknown',verified:false,count:null};
  if(exactData(touches,['verified'])&&touches.verified===false)
    return {state:'unknown',verified:false,count:null};
  if(exactData(touches,['verified','count'])&&touches.verified===true&&
     nonnegative(touches.count)&&touches.count<=1000)
    return {state:'verified',verified:true,count:touches.count};
  return null;
}

function normalizeCorrelation(correlation) {
  if(correlation===undefined||correlation===null) return {traceId:null,spanId:null};
  if(!exactData(correlation,['traceId','spanId'])) return null;
  if(correlation.traceId===null&&correlation.spanId===null) return {traceId:null,spanId:null};
  if(traceHex(correlation.traceId)&&(correlation.spanId===null||spanHex(correlation.spanId)))
    return {traceId:correlation.traceId,spanId:correlation.spanId};
  return null;
}

function invalidReceipt() {
  return {
    schemaVersion:EXECUTION_RECEIPT_SCHEMA_VERSION,valid:false,shadow:true,liveDispatch:false,liveMerge:false,
    source:'unknown',repositoryId:null,receiptId:null,observedMs:null,stage:null,
    outcome:'unknown',reason:'INVALID_EVIDENCE',durationMs:null,stages:null,
    quota:{state:'unknown',verified:false,includedOnly:null},
    cost:{state:'unknown',verified:false,currency:null,amountMicros:null},
    humanTouches:{state:'unknown',verified:false,count:null},
    correlation:{traceId:null,spanId:null}
  };
}

function consistentPrimaryStageDuration(stage,durationMs,stagesMap) {
  return durationMs===null||!Object.hasOwn(stagesMap,stage)||
    stagesMap[stage]===null||stagesMap[stage]===durationMs;
}

export function createExecutionReceipt(input) {
  if(!ownData(input,receiptInputKeys)) return invalidReceipt();
  if((input.shadow!==undefined&&input.shadow!==true)||
     (input.liveDispatch!==undefined&&input.liveDispatch!==false)||
     (input.liveMerge!==undefined&&input.liveMerge!==false)) return invalidReceipt();
  if(!['synthetic','github-hosted'].includes(input.source)||!positive(input.repositoryId)||
     !receiptToken(input.receiptId)||!nonnegative(input.observedMs)||!stages.has(input.stage))
    return invalidReceipt();
  const hasResult=Object.hasOwn(input,'result');
  const hasExplicit=Object.hasOwn(input,'outcome')||Object.hasOwn(input,'reason');
  if(hasResult===hasExplicit) return invalidReceipt();
  let outcome,reason;
  if(hasResult) {
    if(!plainResultValue(input.result)) return invalidReceipt();
    ({outcome,reason}=telemetrySummary(input.result));
  } else {
    if(!outcomes.has(input.outcome)||!reasons.has(input.reason)) return invalidReceipt();
    outcome=input.outcome;
    reason=input.reason;
  }
  const durationMs=input.durationMs===undefined?null:input.durationMs;
  if(durationMs!==null&&!nonnegative(durationMs)) return invalidReceipt();
  const stageCheck=input.stages===undefined||input.stages===null
    ?{valid:true,stages:{[input.stage]:durationMs}}
    :normalizeStageDurations(input.stages);
  if(!stageCheck.valid||!consistentPrimaryStageDuration(input.stage,durationMs,stageCheck.stages))
    return invalidReceipt();
  const quota=normalizeQuota(input.quota);
  const cost=normalizeCost(input.cost);
  const humanTouches=normalizeHumanTouches(input.humanTouches);
  const correlation=normalizeCorrelation(input.correlation);
  if(!quota||!cost||!humanTouches||!correlation) return invalidReceipt();
  return {
    schemaVersion:EXECUTION_RECEIPT_SCHEMA_VERSION,valid:true,shadow:true,liveDispatch:false,liveMerge:false,
    source:input.source,repositoryId:input.repositoryId,receiptId:input.receiptId,
    observedMs:input.observedMs,stage:input.stage,outcome,reason,durationMs,
    stages:stageCheck.stages,quota,cost,humanTouches,correlation
  };
}

function validStoredQuota(q) {
  return exactData(q,['state','verified','includedOnly'])&&(
    (q.state==='unknown'&&q.verified===false&&q.includedOnly===null)||
    (['verified-included','exhausted'].includes(q.state)&&q.verified===true&&q.includedOnly===true)
  );
}

function validStoredCost(c) {
  return exactData(c,['state','verified','currency','amountMicros'])&&(
    (c.state==='unknown'&&c.verified===false&&c.currency===null&&c.amountMicros===null)||
    (c.state==='verified-zero'&&c.verified===true&&c.currency==='USD'&&c.amountMicros===0)
  );
}

function validStoredTouches(t) {
  return exactData(t,['state','verified','count'])&&(
    (t.state==='unknown'&&t.verified===false&&t.count===null)||
    (t.state==='verified'&&t.verified===true&&nonnegative(t.count)&&t.count<=1000)
  );
}

// Project one validated receipt into stage rows preserving source provenance.
// Synthetic rows feed stage-aggregate.mjs directly; hosted provenance aggregation belongs to #18.
export function receiptStageRows(receipt) {
  if(!exactData(receipt,receiptKeys)||receipt.schemaVersion!==EXECUTION_RECEIPT_SCHEMA_VERSION||
     receipt.valid!==true||receipt.shadow!==true||receipt.liveDispatch!==false||receipt.liveMerge!==false||
     !['synthetic','github-hosted'].includes(receipt.source)||!positive(receipt.repositoryId)||
     !receiptToken(receipt.receiptId)||!nonnegative(receipt.observedMs)||!stages.has(receipt.stage)||
     !outcomes.has(receipt.outcome)||!reasons.has(receipt.reason)||
     (receipt.durationMs!==null&&!nonnegative(receipt.durationMs)))
    return {valid:false,reason:'INVALID_RECEIPT',rows:[]};
  const stageCheck=normalizeStageDurations(receipt.stages);
  if(!stageCheck.valid||!consistentPrimaryStageDuration(receipt.stage,receipt.durationMs,stageCheck.stages)||
     !validStoredQuota(receipt.quota)||!validStoredCost(receipt.cost)||
     !validStoredTouches(receipt.humanTouches)||!normalizeCorrelation(receipt.correlation))
    return {valid:false,reason:'INVALID_RECEIPT',rows:[]};
  const effectiveStages=receipt.durationMs===null
    ?stageCheck.stages
    :{...stageCheck.stages,[receipt.stage]:receipt.durationMs};
  const rows=[];
  for(const [stageName,duration] of Object.entries(effectiveStages)) {
    const mapped=scorecardStageMap.get(stageName);
    if(mapped&&duration!==null) {
      rows.push({
        id:`${receipt.receiptId}-${mapped}`,
        repositoryId:receipt.repositoryId,
        stage:mapped,
        at:receipt.observedMs,
        duration,
        source:receipt.source
      });
    }
  }
  return {valid:true,source:receipt.source,rows};
}

export const AUTONOMOUS_RECEIPT_SCHEMA_VERSION=1;
export const AI_CREDIT_USD_CENTS=1;
export const MAX_AI_CREDITS=1_000_000;
export const ALLOWED_MISSION_CONTROL_TASK_STATES=Object.freeze([
  'queued','in_progress','completed','failed','cancelled','timed_out'
]);
const AI_CREDIT_USD_MICROS=10_000;
const MAX_LEASE_GENERATION=1_000_000_000;
const NATIVE_CLOUD_AGENT_ACTOR='copilot-swe-agent[bot]';
const TRACEPARENT_V00=/^00-(?!0{32})([a-f0-9]{32})-(?!0{16})([a-f0-9]{16})-([a-f0-9]{2})$/;
const HYPHENATED_UUID=
  /^(?!0{8}-0{4}-0{4}-0{4}-0{12}$)[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_ID_SAFE=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_HEX=/^(?!0{64})[0-9a-f]{64}$/;
const SECRET_LIKE_VALUE=new RegExp(
  'gh[pousr]_[A-Za-z0-9_]{16,}|'+
  'github_pat_[A-Za-z0-9_]{16,}|'+
  'glpat-[A-Za-z0-9_-]{12,}|'+
  'sk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9]{16,}|'+
  'xox[baprs]-[A-Za-z0-9-]{10,}|'+
  'AKIA[0-9A-Z]{16}|'+
  'AIza[0-9A-Za-z_-]{20,}|'+
  'eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}|'+
  'bearer\\s+[A-Za-z0-9._~+/=-]{8,}',
  'i'
);
const hasSecretOrOversizedText=value=>
  typeof value==='string'&&(value.length>512||SECRET_LIKE_VALUE.test(value));
const FORBIDDEN_TELEMETRY_KEYS=new Set([
  'prompt','rawPrompt','systemPrompt','messages','issueBody','pullBody',
  'token','accessToken','apiKey','secret','password','authorization','pat','cookie',
  'otelLabels','otelAttributes','metricLabels','dimensions'
]);
const MISSION_CONTROL_TASK_STATE_SET=new Set(ALLOWED_MISSION_CONTROL_TASK_STATES);
const AUTONOMOUS_TOP_REQUIRED_KEYS=['traceparent','receipt','aiCreditAccounting','missionControl'];
const AUTONOMOUS_TOP_ALLOWED_KEYS=new Set([
  ...AUTONOMOUS_TOP_REQUIRED_KEYS,'parentSpanId','laptopCollectorRequired','shadow','liveDispatch','liveMerge'
]);
const ACCOUNTING_REQUIRED_KEYS=[
  'accountingSource','aiCreditsUsed','maxAiCredits','incrementalBilledUsdCents'
];
const ACCOUNTING_ALLOWED_KEYS=new Set([
  ...ACCOUNTING_REQUIRED_KEYS,'aiCreditUnitUsdCents','isEstimated','includedQuotaAttributed'
]);
const MISSION_CONTROL_REQUIRED_KEYS=['taskId','sessionId','taskState','lockSha256','casLeaseGeneration'];
const MISSION_CONTROL_ALLOWED_KEYS=new Set([...MISSION_CONTROL_REQUIRED_KEYS,'actor']);

function inspectRecordKeys(value,requiredKeys,allowedKeys) {
  if(!plainObject(value)) return 'INVALID_EVIDENCE';
  const keys=Reflect.ownKeys(value);
  for(const key of keys) {
    if(typeof key!=='string') return 'INVALID_EVIDENCE';
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(descriptor.enumerable!==true||!Object.hasOwn(descriptor,'value')) return 'INVALID_EVIDENCE';
    if(FORBIDDEN_TELEMETRY_KEYS.has(key)) return 'UNSAFE_TELEMETRY_PAYLOAD';
    if(!allowedKeys.has(key)) return 'INVALID_EVIDENCE';
  }
  return requiredKeys.every(key=>Object.hasOwn(value,key))?'OK':'INVALID_EVIDENCE';
}

const safeBoundedCredits=n=>Number.isSafeInteger(n)&&n>=0&&!Object.is(n,-0)&&n<=MAX_AI_CREDITS;

function autonomousDeny(reason,otelReason) {
  return Object.freeze({
    schemaVersion:AUTONOMOUS_RECEIPT_SCHEMA_VERSION,
    valid:false,
    shadow:true,
    liveDispatch:false,
    liveMerge:false,
    laptopCollectorRequired:false,
    state:'blocked',
    outcome:'blocked',
    reason,
    otelReason,
    receipt:null,
    telemetry:null,
    aiCreditAccounting:null,
    missionControl:null,
    otelAttributes:null
  });
}

function inspectReceiptContainer(receipt) {
  if(!plainObject(receipt)) return 'INVALID_RECEIPT';
  for(const key of Reflect.ownKeys(receipt)) {
    if(typeof key!=='string') return 'INVALID_RECEIPT';
    const descriptor=Object.getOwnPropertyDescriptor(receipt,key);
    if(descriptor.enumerable!==true||!Object.hasOwn(descriptor,'value')) return 'INVALID_RECEIPT';
    if(FORBIDDEN_TELEMETRY_KEYS.has(key)) return 'UNSAFE_TELEMETRY_PAYLOAD';
  }
  if(hasSecretOrOversizedText(receipt.receiptId))
    return 'UNSAFE_TELEMETRY_PAYLOAD';
  return 'OK';
}

export function correlateAutonomousExecutionReceipt(input) {
  const topCheck=inspectRecordKeys(input,AUTONOMOUS_TOP_REQUIRED_KEYS,AUTONOMOUS_TOP_ALLOWED_KEYS);
  if(topCheck!=='OK')
    return autonomousDeny(topCheck,topCheck==='UNSAFE_TELEMETRY_PAYLOAD'?'SECURITY':'INVALID_EVIDENCE');
  if(input.laptopCollectorRequired!==undefined&&input.laptopCollectorRequired!==false)
    return autonomousDeny('LAPTOP_DEPENDENCY_FORBIDDEN','POLICY');
  if((input.shadow!==undefined&&input.shadow!==true)||
     (input.liveDispatch!==undefined&&input.liveDispatch!==false)||
     (input.liveMerge!==undefined&&input.liveMerge!==false))
    return autonomousDeny('LIVE_DISPATCH_DISABLED','POLICY');

  if(typeof input.traceparent!=='string')
    return autonomousDeny('INVALID_TRACEPARENT','SECURITY');
  if(hasSecretOrOversizedText(input.traceparent))
    return autonomousDeny('UNSAFE_TELEMETRY_PAYLOAD','SECURITY');
  const tpMatch=TRACEPARENT_V00.exec(input.traceparent);
  if(!tpMatch) return autonomousDeny('INVALID_TRACEPARENT','SECURITY');
  const [,traceId,spanId,traceFlags]=tpMatch;
  const parentSpanId=input.parentSpanId===undefined?null:input.parentSpanId;
  if(hasSecretOrOversizedText(parentSpanId))
    return autonomousDeny('UNSAFE_TELEMETRY_PAYLOAD','SECURITY');
  if(parentSpanId!==null&&(!spanHex(parentSpanId)||parentSpanId===spanId))
    return autonomousDeny('INVALID_TRACEPARENT','SECURITY');

  const accountingCheck=inspectRecordKeys(input.aiCreditAccounting,ACCOUNTING_REQUIRED_KEYS,ACCOUNTING_ALLOWED_KEYS);
  if(accountingCheck!=='OK')
    return autonomousDeny(accountingCheck,accountingCheck==='UNSAFE_TELEMETRY_PAYLOAD'?'SECURITY':'INVALID_EVIDENCE');
  const {
    accountingSource,
    isEstimated,
    includedQuotaAttributed,
    aiCreditsUsed,
    maxAiCredits,
    incrementalBilledUsdCents
  }=input.aiCreditAccounting;
  if(!Object.hasOwn(input.aiCreditAccounting,'isEstimated')||
     !Object.hasOwn(input.aiCreditAccounting,'includedQuotaAttributed')||
     typeof isEstimated!=='boolean'||
     typeof includedQuotaAttributed!=='boolean'||
     accountingSource!=='authoritative'||
     isEstimated!==false)
    return autonomousDeny('AI_CREDIT_ACCOUNTING_UNVERIFIED','QUOTA');
  const unitCents=input.aiCreditAccounting.aiCreditUnitUsdCents===undefined
    ?AI_CREDIT_USD_CENTS
    :input.aiCreditAccounting.aiCreditUnitUsdCents;
  if(unitCents!==AI_CREDIT_USD_CENTS)
    return autonomousDeny('INVALID_POLICY','POLICY');
  if(includedQuotaAttributed!==true)
    return autonomousDeny('INCLUDED_QUOTA_NOT_ATTRIBUTED','QUOTA');
  if(!safeBoundedCredits(aiCreditsUsed)||!safeBoundedCredits(maxAiCredits)||
     !Number.isSafeInteger(incrementalBilledUsdCents)||Object.is(incrementalBilledUsdCents,-0))
    return autonomousDeny('AI_CREDIT_ACCOUNTING_UNVERIFIED','QUOTA');
  if(incrementalBilledUsdCents!==0)
    return autonomousDeny('INCREMENTAL_SPEND_NONZERO','QUOTA');
  if(aiCreditsUsed>maxAiCredits)
    return autonomousDeny('AI_CREDIT_CAP_EXCEEDED','QUOTA');

  const mcCheck=inspectRecordKeys(input.missionControl,MISSION_CONTROL_REQUIRED_KEYS,MISSION_CONTROL_ALLOWED_KEYS);
  if(mcCheck!=='OK')
    return autonomousDeny(mcCheck,mcCheck==='UNSAFE_TELEMETRY_PAYLOAD'?'SECURITY':'INVALID_EVIDENCE');
  const {taskId,sessionId,taskState,lockSha256,casLeaseGeneration}=input.missionControl;
  const actor=input.missionControl.actor===undefined?null:input.missionControl.actor;
  if([taskId,sessionId,taskState,lockSha256,actor].some(hasSecretOrOversizedText))
    return autonomousDeny('UNSAFE_TELEMETRY_PAYLOAD','SECURITY');
  if(typeof taskId!=='string'||!HYPHENATED_UUID.test(taskId)||
     typeof sessionId!=='string'||!SESSION_ID_SAFE.test(sessionId)||
     !MISSION_CONTROL_TASK_STATE_SET.has(taskState))
    return autonomousDeny('INVALID_MISSION_CONTROL_TASK','INVALID_EVIDENCE');
  if(typeof lockSha256!=='string'||!SHA256_HEX.test(lockSha256))
    return autonomousDeny('INVALID_GH_AW_LOCK_HASH','SECURITY');
  if(!positive(casLeaseGeneration)||casLeaseGeneration>MAX_LEASE_GENERATION)
    return autonomousDeny('INVALID_CAS_LEASE','LEASE');
  if(actor!==null&&actor!==NATIVE_CLOUD_AGENT_ACTOR)
    return autonomousDeny('PROVENANCE_MISMATCH','SECURITY');

  const receiptContainerCheck=inspectReceiptContainer(input.receipt);
  if(receiptContainerCheck!=='OK')
    return autonomousDeny(
      receiptContainerCheck,
      receiptContainerCheck==='UNSAFE_TELEMETRY_PAYLOAD'?'SECURITY':'INVALID_EVIDENCE'
    );
  let baseReceipt;
  if(Object.hasOwn(input.receipt,'schemaVersion')) {
    if(!receiptStageRows(input.receipt).valid)
      return autonomousDeny('INVALID_RECEIPT','INVALID_EVIDENCE');
    baseReceipt=input.receipt;
  } else {
    const built=createExecutionReceipt(input.receipt);
    if(!built.valid)
      return autonomousDeny('INVALID_RECEIPT','INVALID_EVIDENCE');
    baseReceipt=built;
  }
  if(baseReceipt.correlation.traceId!==null&&baseReceipt.correlation.traceId!==traceId)
    return autonomousDeny('TRACE_ID_MISMATCH','SECURITY');
  if(baseReceipt.correlation.spanId!==null&&baseReceipt.correlation.spanId!==spanId)
    return autonomousDeny('SPAN_LINKAGE_BROKEN','SECURITY');
  const expectedQuotaState=aiCreditsUsed<maxAiCredits?'verified-included':'exhausted';
  if(baseReceipt.quota.verified===true&&baseReceipt.quota.state!==expectedQuotaState)
    return autonomousDeny('INVALID_RECEIPT','INVALID_EVIDENCE');
  const normalizedStages=normalizeStageDurations(baseReceipt.stages).stages;

  const correlatedReceipt=Object.freeze({
    schemaVersion:EXECUTION_RECEIPT_SCHEMA_VERSION,
    valid:true,
    shadow:true,
    liveDispatch:false,
    liveMerge:false,
    source:baseReceipt.source,
    repositoryId:baseReceipt.repositoryId,
    receiptId:baseReceipt.receiptId,
    observedMs:baseReceipt.observedMs,
    stage:baseReceipt.stage,
    outcome:baseReceipt.outcome,
    reason:baseReceipt.reason,
    durationMs:baseReceipt.durationMs,
    stages:Object.freeze({...normalizedStages}),
    quota:Object.freeze({
      state:baseReceipt.quota.state,
      verified:baseReceipt.quota.verified,
      includedOnly:baseReceipt.quota.includedOnly
    }),
    cost:Object.freeze({
      state:baseReceipt.cost.state,
      verified:baseReceipt.cost.verified,
      currency:baseReceipt.cost.currency,
      amountMicros:baseReceipt.cost.amountMicros
    }),
    humanTouches:Object.freeze({
      state:baseReceipt.humanTouches.state,
      verified:baseReceipt.humanTouches.verified,
      count:baseReceipt.humanTouches.count
    }),
    correlation:Object.freeze({traceId,spanId})
  });
  const otelAttributes=Object.freeze({
    stage:correlatedReceipt.stage,
    outcome:correlatedReceipt.outcome,
    reason:correlatedReceipt.reason,
    taskState,
    accountingState:'authoritative-zero-incremental'
  });
  return Object.freeze({
    schemaVersion:AUTONOMOUS_RECEIPT_SCHEMA_VERSION,
    valid:true,
    shadow:true,
    liveDispatch:false,
    liveMerge:false,
    laptopCollectorRequired:false,
    state:correlatedReceipt.outcome==='eligible'?'correlated':correlatedReceipt.outcome,
    outcome:correlatedReceipt.outcome,
    reason:correlatedReceipt.reason,
    otelReason:correlatedReceipt.reason,
    receipt:correlatedReceipt,
    telemetry:Object.freeze({
      traceparent:input.traceparent,
      version:'00',
      traceId,
      spanId,
      parentSpanId,
      traceFlags,
      sampled:(Number.parseInt(traceFlags,16)&1)===1,
      aspireOtlpCompatible:true,
      laptopCollectorRequired:false
    }),
    aiCreditAccounting:Object.freeze({
      accountingSource:'authoritative',
      isEstimated:false,
      aiCreditUnitUsdCents:AI_CREDIT_USD_CENTS,
      aiCreditsUsed,
      maxAiCredits,
      remainingAiCredits:maxAiCredits-aiCreditsUsed,
      includedAiCreditsUsdCents:aiCreditsUsed*AI_CREDIT_USD_CENTS,
      includedAiCreditsUsdMicros:aiCreditsUsed*AI_CREDIT_USD_MICROS,
      incrementalBilledUsdCents:0,
      includedQuotaAttributed:true
    }),
    missionControl:Object.freeze({
      taskId:taskId.toLowerCase(),
      sessionId,
      taskState,
      lockSha256,
      casLeaseGeneration,
      actor
    }),
    otelAttributes
  });
}

export function localEndpoint(value) {
  try {
    const u=new URL(value);
    return ['http:','https:'].includes(u.protocol) && ['127.0.0.1','[::1]'].includes(u.hostname) &&
      u.port!=='' && !u.username && !u.password && !u.search && !u.hash && u.pathname==='/' ? u.origin : null;
  } catch { return null; }
}
// Only explicit local configuration reaches SDK construction. No default
// collector, environment-derived per-signal URL, or arbitrary headers.
export function localOtlpConfiguration(endpoint,protocol,header) {
  const origin=localEndpoint(endpoint);
  if(!origin||!['grpc','http/protobuf'].includes(protocol)||typeof header!=='string'||header.length>2048)
    return null;
  const match=/^x-otlp-api-key=([^,]+)$/.exec(header);
  if(!match)return null;
  let key;
  try {key=decodeURIComponent(match[1]);} catch {return null;}
  if(!/^[A-Za-z0-9._~+/=-]{1,1024}$/.test(key))return null;
  return {endpoint:origin,protocol,headers:{'x-otlp-api-key':key}};
}
export function createSignals({tracer,meter,logger,clock=()=>performance.now()}) {
  let count={add:()=>{}};
  let duration={record:()=>{}};
  try {count=meter.createCounter('factory.stage.count');} catch {}
  try {duration=meter.createHistogram('factory.stage.duration',{unit:'ms'});} catch {}
  const now=()=>{try {return clock();} catch {return NaN;}};
  return async function observe(stage,work) {
    if(!stages.has(stage)) throw new Error('UNKNOWN_STAGE');
    const start=now();
    let pending;
    const execute=async (span,active)=>{
      let outcome='failed',reason='OTHER';
      try {
        const result=await work();
        outcome=outcomes.has(result?.outcome)?result.outcome:'unknown';
        reason=reasons.has(result?.reason)?result.reason:'OTHER';
        return result;
      } finally {
        const attributes={stage,outcome,reason};
        const elapsed=now()-start;
        try {count.add(1,attributes);} catch {}
        try {if(Number.isFinite(elapsed)&&elapsed>=0) duration.record(elapsed,attributes);} catch {}
        try {span?.setAttributes(attributes);} catch {}
        try {if(outcome==='failed') span?.setStatus({code:2});} catch {}
        // Emit while the active SDK span is still in context; the SDK log
        // processor supplies trace/span correlation. Never emit work payloads.
        try {if(active) logger?.emit({body:'factory.stage.completed',attributes});} catch {}
        try {span?.end();} catch {}
      }
    };
    // The SDK invokes its callback synchronously in the active context.
    // Retain the original work promise even if the provider throws afterwards.
    const once=(span,active=false)=>pending??=execute(span,active);
    try {
      if(typeof tracer.startActiveSpan==='function') {
        await tracer.startActiveSpan('factory.'+stage,span=>once(span,true));
      } else {
        once(tracer.startSpan('factory.'+stage));
      }
    } catch {}
    return pending??once(undefined);
  };
}
