import {types} from 'node:util';

const sha=s=>typeof s==='string'&&/^[a-f0-9]{40}$/.test(s);
const positive=n=>Number.isSafeInteger(n)&&n>0;
const own=(v,keys)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&keys.every(k=>Object.hasOwn(v,k));
const exactArray = (value, max = 500) => {
 if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
  return false;
 const length = value.length;
 if (length > max) return false;
 const keys = Reflect.ownKeys(value);
 if (keys.length !== length + 1) return false;
 const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
 if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') || lengthDescriptor.value !== length)
  return false;
 for (let i = 0; i < length; i++) {
  const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false;
 }
 return true;
};
const dense=a=>exactArray(a);
const blocked=reason=>({shadow:true,liveMerge:false,reason});
export function nextIntegration(state) {
 if(!own(state,['stop','main','mainHealthy','active','candidates'])||state.stop!==false) return blocked('STOPPED');
 if(!sha(state.main)||state.mainHealthy!==true||state.active!==false) return blocked('MAIN_OR_TRAIN_UNREADY');
 if(!dense(state.candidates)||state.candidates.some(c=>!own(c,['pr','head','observedHead','base','checks','approval','threads','authority'])||!positive(c.pr)||!sha(c.head)||!sha(c.observedHead)||!sha(c.base))||new Set(state.candidates.map(c=>c.pr)).size!==state.candidates.length) return blocked('INVALID_CANDIDATES');
 const c=state.candidates.find(c=>c.head===c.observedHead&&c.base===state.main&&c.checks===true&&c.approval===true&&c.threads===true&&c.authority===true);
 if(!c) return blocked('NO_ELIGIBLE_CANDIDATE');
 return {...blocked('SHADOW_NEXT'),pr:c.pr,expectedHead:c.head,expectedBase:c.base,method:'squash'};
}

const data=(o,keys)=>o!==null&&typeof o==='object'&&!types.isProxy(o)&&!Array.isArray(o)&&keys.every(k=>Object.hasOwn(Object.getOwnPropertyDescriptor(o,k)??{},'value'));
const queueBlocked=reason=>({shadow:true,liveMerge:false,reason});
// An explicit GraphQL enqueue operation, never a direct merge or queue jump.
// Returns inert request data only; no transport or live mutation is possible.
export function queueAdapter(intent,fresh){
 if(!data(intent,['pr','expectedHead','expectedBase'])||!positive(intent.pr)||!sha(intent.expectedHead)||!sha(intent.expectedBase))return queueBlocked('INTENT_UNKNOWN');
 if(!data(fresh,['pr','id','repository','head','base','branch','open','draft','queueRequired','authority','checks','review','threads','security','coverage','mainHealthy','stop','queued']))return queueBlocked('EVIDENCE_UNKNOWN');
 if(fresh.stop!==false||fresh.repository!=='Jamula/SoftwareFactory'||fresh.branch!=='main'||fresh.pr!==intent.pr||fresh.head!==intent.expectedHead||fresh.base!==intent.expectedBase)return queueBlocked('SCOPE_OR_HEAD_CHANGED');
 if(fresh.open!==true||fresh.draft!==false)return queueBlocked('CANDIDATE_NOT_READY');
 if(fresh.queued===true)return queueBlocked('ALREADY_QUEUED');
 if(fresh.queued!==false||[fresh.queueRequired,fresh.authority,fresh.checks,fresh.review,fresh.threads,fresh.security,fresh.coverage,fresh.mainHealthy].some(x=>x!==true)||typeof fresh.id!=='string'||!/^PR_[A-Za-z0-9_-]{1,100}$/.test(fresh.id))return queueBlocked('GATES_UNKNOWN');
 return {...queueBlocked('SHADOW_QUEUE_INTENT'),request:{
  query:'mutation Enqueue($id: ID!, $head: GitObjectID!) { enqueuePullRequest(input: {pullRequestId: $id, expectedHeadOid: $head, jump: false}) { mergeQueueEntry { id } } }',
  variables:{id:fresh.id,head:intent.expectedHead}
 }};
}

const nonnegative = (value, limit) => Number.isSafeInteger(value) && value >= 0 && value <= limit;
const outcomeFields = ['workload', 'gateSet', 'gatesPassed', 'accepted', 'durationMs', 'rework', 'costMicros'];

function validOutcome(outcome) {
 return data(outcome, outcomeFields) && sha(outcome.workload) && sha(outcome.gateSet) &&
  outcome.gatesPassed === true && positive(outcome.accepted) && nonnegative(outcome.accepted, 100000) &&
  positive(outcome.durationMs) && nonnegative(outcome.durationMs, 86400000) &&
  nonnegative(outcome.rework, 100000) && nonnegative(outcome.costMicros, 1000000000);
}

const experiment = reason => ({shadow: true, synthetic: true, comparable: false, reason});

export function compareTrainExperiment(pairs) {
 if (!exactArray(pairs, 100) || pairs.length < 2) return experiment('SAMPLE_UNKNOWN');
 const ids = new Set();
 const baselineMs = [];
 const candidateMs = [];
 let acceptedPerArm = 0;
 for (let i = 0; i < pairs.length; i++) {
  const item = Object.getOwnPropertyDescriptor(pairs, String(i));
  if (!item || !Object.hasOwn(item, 'value')) return experiment('SAMPLE_UNKNOWN');
  const pair = item.value;
  if (!data(pair, ['id', 'baseline', 'candidate']) || !positive(pair.id) || ids.has(pair.id) ||
      !validOutcome(pair.baseline) || !validOutcome(pair.candidate))
   return experiment('SAMPLE_UNKNOWN');
  ids.add(pair.id);
  const {baseline, candidate} = pair;
  if (baseline.workload !== candidate.workload || baseline.gateSet !== candidate.gateSet ||
      baseline.accepted !== candidate.accepted) return experiment('UNMATCHED_WORK');
  if (candidate.rework > baseline.rework || candidate.costMicros > baseline.costMicros)
   return experiment('REWORK_OR_COST_REGRESSION');
  acceptedPerArm += baseline.accepted;
  baselineMs.push(baseline.durationMs);
  candidateMs.push(candidate.durationMs);
 }
 function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
   totalMs: sorted.reduce((sum, elapsed) => sum + elapsed, 0),
   p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
   p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]
  };
 }
 const baseline = summarize(baselineMs);
 const candidate = summarize(candidateMs);
 return {shadow: true, synthetic: true, comparable: true, reason: 'MATCHED_SYNTHETIC_TRIALS',
  pairs: pairs.length, acceptedPerArm, baseline, candidate, throughputRatio: baseline.totalMs / candidate.totalMs};
}

