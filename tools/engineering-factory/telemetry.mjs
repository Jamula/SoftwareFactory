// OpenTelemetry API boundary and laptop-free sanitized execution receipts.
import {types} from 'node:util';
import {normalizeStageDurations} from './stage-latency.mjs';

export const EXECUTION_RECEIPT_SCHEMA_VERSION=1;
const stages=new Set(['reconcile','normalize','evaluate','queue','review','merge-shadow','verify-main']);
const outcomes=new Set(['eligible','blocked','failed','unknown']);
const reasons=new Set([
  'NONE','INVALID_EVIDENCE','STALE','DEPENDENCY','QUOTA','POLICY',
  'SECURITY','LEASE','REVIEW','COVERAGE','CHECKS','RUNTIME','OTHER'
]);
const reasonLabels=new Map([
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
  ['CAPACITY_UNKNOWN','QUOTA'],['CAPACITY_UNVERIFIED','QUOTA'],['CAPACITY_EXHAUSTED','QUOTA'],
  ['CAPACITY_FULL','QUOTA'],['NO_SCOPED_CAPACITY','QUOTA'],['BUDGET_UNKNOWN','QUOTA'],
  ['BUDGET_OR_CONCURRENCY','QUOTA'],['INVALID_QUOTA','QUOTA'],['RATE_OR_PERMISSION_UNKNOWN','QUOTA'],
  ['RATE_LIMIT_OR_UNKNOWN','QUOTA'],['PROVIDER_INELIGIBLE_OR_QUOTA','QUOTA'],['JOURNAL_FULL','QUOTA'],
  ['TRUST_UNKNOWN','SECURITY'],['PROVENANCE_MISMATCH','SECURITY'],['UNTRUSTED_POLICY','SECURITY'],
  ['STOPPED_OR_UNAUTHORIZED','SECURITY'],['PROTECTIONS_UNVERIFIED','SECURITY'],
  ['THREADS_OR_SECURITY_UNKNOWN','SECURITY'],['PROVIDER_FORBIDDEN','SECURITY'],
  ['STALE_EVENT','STALE'],['HEAD_CHANGED','STALE'],['BASE_CHANGED','STALE'],
  ['STALE_HEAD_OR_BASE','STALE'],['SCOPE_OR_HEAD_CHANGED','STALE'],['HEAD_OR_BASE_MISMATCH','STALE'],
  ['BASE_MOVED_SINCE_VERIFICATION','STALE'],['TASK_STATE_CHANGED','STALE'],
  ['SHADOW_HEAD_SUPERSEDED','STALE'],['DUPLICATE_DELIVERY','STALE'],['STALE_QUOTA','STALE'],
  ['STALE_EVIDENCE','STALE'],['STALE_CONTRACT','STALE'],['STALE_OR_UNKNOWN_EVIDENCE','STALE'],
  ['UNKNOWN_DEPENDENCY','DEPENDENCY'],['DEPENDENCY_UNKNOWN','DEPENDENCY'],
  ['DEPENDENCY_CYCLE','DEPENDENCY'],['DEPENDENCIES_BLOCKED','DEPENDENCY'],
  ['DEPENDENCY_UNACCEPTED','DEPENDENCY'],['DEPENDENCIES_UNKNOWN','DEPENDENCY'],['TASK_BLOCKED','DEPENDENCY'],
  ['LEASE_HELD','LEASE'],['LEASE_LOST','LEASE'],['LEASE_UNAVAILABLE','LEASE'],['CLAIM_LOST','LEASE'],
  ['LEASE_OR_CLOCK_UNKNOWN','LEASE'],['WORK_RESERVATION_UNKNOWN','LEASE'],
  ['ACTIVE_RESERVATIONS_UNAVAILABLE','LEASE'],['STALE_CHECKPOINT','LEASE'],
  ['SERIALIZED_OR_RECOVERY_REQUIRED','LEASE'],['INTENT_UNAVAILABLE_OR_CLAIMED','LEASE'],
  ['LANE_OR_PATH_RESERVED','LEASE'],
  ['REVIEW_UNVERIFIED','REVIEW'],['REVIEW_MISSING','REVIEW'],['REVIEW_INCOMPLETE','REVIEW'],
  ['AGENT_REVIEW_FAILED','REVIEW'],['REVIEW_READ_FAILED','REVIEW'],
  ['AMBIGUOUS_REVIEW_HISTORY','REVIEW'],['FORMAL_REVIEW_MISSING','REVIEW'],
  ['COVERAGE_UNVERIFIED','COVERAGE'],['COVERAGE_INCOMPLETE','COVERAGE'],['COVERAGE','COVERAGE'],
  ['CHECKS_INCOMPLETE','CHECKS'],['MAIN_VERIFICATION_REQUIRED','CHECKS'],
  ['BASE_OR_MAIN_UNHEALTHY','CHECKS'],['ACCEPTANCE_INCOMPLETE','CHECKS'],['GITHUB_NOT_CLEAN','CHECKS'],
  ['INVALID_ISSUE','INVALID_EVIDENCE'],['INVALID_PULL','INVALID_EVIDENCE'],
  ['INVALID_EVENT','INVALID_EVIDENCE'],['IDENTITY_UNKNOWN','INVALID_EVIDENCE'],
  ['RESPONSE_LIMIT','INVALID_EVIDENCE'],['INVALID_TASKS','INVALID_EVIDENCE'],
  ['INVALID_TASK','INVALID_EVIDENCE'],['INVALID_INVENTORY','INVALID_EVIDENCE'],
  ['INVALID_ACTIVE_LANE','INVALID_EVIDENCE'],['EVIDENCE_UNKNOWN','INVALID_EVIDENCE'],
  ['INTENT_UNKNOWN','INVALID_EVIDENCE'],['MERGE_RECEIPT_UNKNOWN','INVALID_EVIDENCE'],
  ['GATES_UNKNOWN','INVALID_EVIDENCE'],['INVALID_IDENTITY','INVALID_EVIDENCE'],
  ['DELIVERY_CONFLICT','INVALID_EVIDENCE'],['INVALID_CANDIDATE','INVALID_EVIDENCE'],
  ['READ_FAILED','RUNTIME'],['TASK_READ_FAILED','RUNTIME'],['CLOCK_UNAVAILABLE','RUNTIME'],
  ['CLOCK_UNKNOWN','RUNTIME'],['RUNTIME_UNKNOWN','RUNTIME'],['INVALID_RUNTIME','RUNTIME'],
  ['LANE_FAILED','RUNTIME'],['JOURNAL_UNAVAILABLE','RUNTIME'],['RECONCILIATION_UNAVAILABLE','RUNTIME'],
  ['FRESH_EVIDENCE_UNAVAILABLE','RUNTIME'],['RECOVERY_REQUIRED','RUNTIME'],
  ['PROVIDER_UNKNOWN','RUNTIME'],['PROVIDER_RESPONSE_UNKNOWN','RUNTIME'],
  ['REQUEST_OUTCOME_UNKNOWN','RUNTIME'],['DEFERRED_TRANSIENT','RUNTIME']
]);
const failedCodes=new Set([
  'READ_FAILED','TASK_READ_FAILED','LEASE_UNAVAILABLE','CLOCK_UNAVAILABLE','AGENT_REVIEW_FAILED',
  'LANE_FAILED','INVALID_RUNTIME','RUNTIME_UNKNOWN','CLOCK_UNKNOWN','JOURNAL_UNAVAILABLE',
  'RECONCILIATION_UNAVAILABLE','FRESH_EVIDENCE_UNAVAILABLE','RECOVERY_REQUIRED',
  'ACTIVE_RESERVATIONS_UNAVAILABLE','REVIEW_READ_FAILED','PROVIDER_UNKNOWN',
  'PROVIDER_RESPONSE_UNKNOWN','REQUEST_OUTCOME_UNKNOWN'
]);
const eligibleCodes=new Set([
  'SHADOW_ELIGIBLE','SHADOW_SQUASH_ELIGIBLE','SHADOW_MAIN_VERIFIED','SHADOW_RECONCILED',
  'SHADOW_PLATFORM_GATES_ONLY','QUEUED','SHADOW_CAPACITY','SHADOW_ALLOCATION',
  'REQUEST_SIMULATED','REQUEST_RECONCILED'
]);
const unknownCodes=new Set([
  'PULL_IDENTITY_MATCHED','ISSUE_IDENTITY_MATCHED','IDENTITY_ONLY','NORMALIZED_ONLY',
  'NO_READY_WORK','NO_CLAIM','NO_RECOVERABLE_INTENT'
]);

export function telemetrySummary(result) {
  if(!result||typeof result!=='object'||types.isProxy(result)) return {outcome:'unknown',reason:'NONE'};
  const code=typeof result.reason==='string'?result.reason:'';
  if(code==='SHADOW_TICK_COMPLETE') {
    if(!Array.isArray(result.completed)||result.completed.length===0) return {outcome:'unknown',reason:'NONE'};
    const summaries=result.completed.map(item=>telemetrySummary(item));
    const failure=summaries.find(item=>item.outcome==='failed');
    if(failure) return failure;
    const blocked=summaries.find(item=>item.outcome!=='eligible');
    return blocked??{outcome:'eligible',reason:'NONE'};
  }
  if(!code) {
    if(result.state==='shadow-reviewed') return {outcome:'eligible',reason:'NONE'};
    if(result.reconciled===false||result.state==='blocked') return {outcome:'blocked',reason:'NONE'};
    return {outcome:'unknown',reason:'NONE'};
  }
  const reason=reasonLabels.get(code)??'OTHER';
  if(failedCodes.has(code)) return {outcome:'failed',reason};
  if(result.reconciled===false||result.state==='blocked'||result.accepted===false||result.eligible===false)
    return {outcome:'blocked',reason};
  if(result.reconciled===true||unknownCodes.has(code)) return {outcome:'unknown',reason};
  if(code==='SHADOW_PLAN') {
    const planned=(Array.isArray(result.ready)&&result.ready.length>0)||
      (Array.isArray(result.scheduled)&&result.scheduled.length>0);
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
  if(!stageCheck.valid) return invalidReceipt();
  if(durationMs!==null&&Object.hasOwn(stageCheck.stages,input.stage)&&
     stageCheck.stages[input.stage]!==null&&stageCheck.stages[input.stage]!==durationMs)
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

// Convert one validated execution receipt into stage-aggregate rows for #18 reporting.
export function receiptStageRows(receipt) {
  if(!exactData(receipt,receiptKeys)||receipt.schemaVersion!==EXECUTION_RECEIPT_SCHEMA_VERSION||
     receipt.valid!==true||receipt.shadow!==true||receipt.liveDispatch!==false||receipt.liveMerge!==false||
     !['synthetic','github-hosted'].includes(receipt.source)||!positive(receipt.repositoryId)||
     !receiptToken(receipt.receiptId)||!nonnegative(receipt.observedMs)||!stages.has(receipt.stage)||
     !outcomes.has(receipt.outcome)||!reasons.has(receipt.reason)||
     (receipt.durationMs!==null&&!nonnegative(receipt.durationMs)))
    return {valid:false,reason:'INVALID_RECEIPT',rows:[]};
  const stageCheck=normalizeStageDurations(receipt.stages);
  if(!stageCheck.valid||!validStoredQuota(receipt.quota)||!validStoredCost(receipt.cost)||
     !validStoredTouches(receipt.humanTouches)||!normalizeCorrelation(receipt.correlation))
    return {valid:false,reason:'INVALID_RECEIPT',rows:[]};
  const rows=[];
  for(const [stageName,duration] of Object.entries(stageCheck.stages)) {
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
