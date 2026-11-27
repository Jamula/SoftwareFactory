import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {pathsOverlap, planLanes} from './planner.mjs';
import {validateProjectConfig} from './project-config.mjs';

export const PROTECTED_WORK_QUEUE_REF = 'refs/heads/work-queue';
export const ZERO_GIT_OID = '0000000000000000000000000000000000000000';
export const MAX_LEASE_TTL_MS = 3600000;

const MAX_ENTRIES = 250;
const MAX_RECEIPTS = 250;
const HEX40_RE = /^[a-f0-9]{40}$/;
const HEX64_RE = /^[a-f0-9]{64}$/;
const TRACEPARENT_RE = /^00-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{2}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const LANE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VALID_ENTRY_STATUSES = new Set(['leased', 'requeued', 'completed', 'cancelled', 'exhausted']);
const VALID_RUN_STATES = new Set(['launch_failed', 'worker_terminated', 'run_terminal', 'run_missing']);
const VALID_CONCLUSIONS = new Set([
  'success', 'failure', 'timed_out', 'cancelled', 'startup_failure', 'action_required', 'stale'
]);

const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const boundedTtl = value => Number.isSafeInteger(value) && value >= 1 && value <= MAX_LEASE_TTL_MS;
const isHex40 = value => typeof value === 'string' && HEX40_RE.test(value);
const isHex64 = value => typeof value === 'string' && HEX64_RE.test(value);
const isTraceparent = value => typeof value === 'string' && TRACEPARENT_RE.test(value);
const isRepoName = value => typeof value === 'string' && !value.includes('..') && REPO_RE.test(value);
const isWorkerId = value => typeof value === 'string' && WORKER_ID_RE.test(value);
const isLaneId = value => typeof value === 'string' && LANE_ID_RE.test(value);

function isOwnEnumerableData(target, key) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor !== undefined && descriptor.enumerable === true && Object.hasOwn(descriptor, 'value');
}

function isPlainRecord(value, requiredKeys, optionalKeys = []) {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const ownKeys = Reflect.ownKeys(value);
  if (!ownKeys.every(key => typeof key === 'string' && allowed.has(key) && isOwnEnumerableData(value, key))) {
    return false;
  }
  return requiredKeys.every(key => Object.hasOwn(value, key) && value[key] !== undefined);
}

function isDenseArray(value, maxLen = MAX_ENTRIES) {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > maxLen || Reflect.ownKeys(value).length !== value.length + 1) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    if (!isOwnEnumerableData(value, String(i))) return false;
  }
  return true;
}

function isValidRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 &&
    !value.startsWith('/') && !value.includes('\\') && !value.includes(':') &&
    /^[A-Za-z0-9._/-]+$/.test(value) &&
    !value.split('/').some(part => part.length === 0 || part === '.' || part === '..');
}

function isValidPathSet(paths) {
  if (!isDenseArray(paths, 64) || paths.length === 0 || !paths.every(isValidRelativePath)) return false;
  return new Set(paths).size === paths.length;
}

function createEmptyQueueState() {
  return Object.freeze({
    schemaVersion: 1,
    protocol: 'v3',
    sequence: 0,
    nextGeneration: 1,
    entries: Object.freeze([]),
    recoveryReceipts: Object.freeze([])
  });
}

function cloneEntry(entry) {
  const copy = {
    workId: entry.workId,
    targetType: entry.targetType,
    repository: entry.repository,
    repositoryId: entry.repositoryId,
    issueNumber: entry.issueNumber,
    pullNumber: entry.pullNumber,
    headSha: entry.headSha,
    lane: entry.lane,
    ownedPaths: Object.freeze([...entry.ownedPaths]),
    status: entry.status,
    generation: entry.generation,
    attempts: entry.attempts,
    maxAttempts: entry.maxAttempts,
    workerId: entry.workerId,
    runId: entry.runId,
    runAttempt: entry.runAttempt,
    claimedAtMs: entry.claimedAtMs,
    leaseTtlMs: entry.leaseTtlMs,
    leaseExpiresAtMs: entry.leaseExpiresAtMs,
    maxExecutionMs: entry.maxExecutionMs,
    executionDeadlineMs: entry.executionDeadlineMs
  };
  if (entry.traceparent !== undefined) copy.traceparent = entry.traceparent;
  if (entry.lockSha256 !== undefined) copy.lockSha256 = entry.lockSha256;
  return Object.freeze(copy);
}

function cloneReceipt(receipt) {
  return Object.freeze({
    workId: receipt.workId,
    repositoryId: receipt.repositoryId,
    targetType: receipt.targetType,
    runState: receipt.runState,
    conclusion: receipt.conclusion,
    previousRunId: receipt.previousRunId,
    previousRunAttempt: receipt.previousRunAttempt,
    previousGeneration: receipt.previousGeneration,
    reclaimedGeneration: receipt.reclaimedGeneration,
    attempts: receipt.attempts,
    maxAttempts: receipt.maxAttempts,
    outcome: receipt.outcome,
    reclaimedAtMs: receipt.reclaimedAtMs
  });
}

function expectedWorkId(entry) {
  return entry.targetType === 'issue'
    ? `${entry.repositoryId}:issue:${entry.issueNumber}`
    : `${entry.repositoryId}:pr:${entry.pullNumber}:${entry.headSha}`;
}

function isValidQueueEntry(entry) {
  const required = [
    'workId', 'targetType', 'repository', 'repositoryId', 'issueNumber', 'pullNumber', 'headSha',
    'lane', 'ownedPaths', 'status', 'generation', 'attempts', 'maxAttempts', 'workerId', 'runId', 'runAttempt',
    'claimedAtMs', 'leaseTtlMs', 'leaseExpiresAtMs', 'maxExecutionMs', 'executionDeadlineMs'
  ];
  if (!isPlainRecord(entry, required, ['traceparent', 'lockSha256'])) return false;
  if (!isRepoName(entry.repository) || !positive(entry.repositoryId) ||
      !isLaneId(entry.lane) || !isValidPathSet(entry.ownedPaths) ||
      !VALID_ENTRY_STATUSES.has(entry.status) || !positive(entry.generation) ||
      !positive(entry.attempts) || !Number.isSafeInteger(entry.maxAttempts) ||
      entry.maxAttempts < 1 || entry.maxAttempts > 5 || entry.attempts > entry.maxAttempts ||
      !isWorkerId(entry.workerId) || !positive(entry.runId) || !positive(entry.runAttempt) ||
      !nonnegative(entry.claimedAtMs) || !boundedTtl(entry.leaseTtlMs) ||
      !boundedTtl(entry.maxExecutionMs) || entry.maxExecutionMs < entry.leaseTtlMs ||
      !nonnegative(entry.leaseExpiresAtMs) || !nonnegative(entry.executionDeadlineMs) ||
      entry.executionDeadlineMs !== entry.claimedAtMs + entry.maxExecutionMs ||
      entry.leaseExpiresAtMs > entry.executionDeadlineMs) {
    return false;
  }
  if (entry.targetType === 'issue') {
    if (!positive(entry.issueNumber) || entry.pullNumber !== null || entry.headSha !== null) return false;
  } else if (entry.targetType === 'pull_request') {
    if (!positive(entry.pullNumber) || !isHex40(entry.headSha) || entry.issueNumber !== null) return false;
  } else {
    return false;
  }
  if (entry.workId !== expectedWorkId(entry)) return false;
  if (entry.traceparent !== undefined && !isTraceparent(entry.traceparent)) return false;
  if (entry.lockSha256 !== undefined && !isHex64(entry.lockSha256)) return false;
  return true;
}

function isValidReceipt(receipt) {
  const required = [
    'workId', 'repositoryId', 'targetType', 'runState', 'conclusion', 'previousRunId', 'previousRunAttempt',
    'previousGeneration', 'reclaimedGeneration', 'attempts', 'maxAttempts', 'outcome', 'reclaimedAtMs'
  ];
  if (!isPlainRecord(receipt, required)) return false;
  if (typeof receipt.workId !== 'string' || receipt.workId.length === 0 || !positive(receipt.repositoryId) ||
      (receipt.targetType !== 'issue' && receipt.targetType !== 'pull_request') ||
      (!VALID_RUN_STATES.has(receipt.runState) && receipt.runState !== 'lease_expired') ||
      (receipt.conclusion !== null && !VALID_CONCLUSIONS.has(receipt.conclusion)) ||
      !positive(receipt.previousRunId) || !positive(receipt.previousRunAttempt) ||
      !positive(receipt.previousGeneration) ||
      !positive(receipt.reclaimedGeneration) || receipt.reclaimedGeneration <= receipt.previousGeneration ||
      !positive(receipt.attempts) || !Number.isSafeInteger(receipt.maxAttempts) ||
      receipt.maxAttempts < 1 || receipt.maxAttempts > 5 ||
      !['requeued', 'exhausted', 'completed'].includes(receipt.outcome) ||
      !nonnegative(receipt.reclaimedAtMs)) {
    return false;
  }
  return true;
}

function freezeValidatedState(state) {
  if (!isPlainRecord(state, ['schemaVersion', 'protocol', 'sequence', 'nextGeneration', 'entries', 'recoveryReceipts']) ||
      state.schemaVersion !== 1 || (state.protocol !== 'v3' && state.protocol !== 'v4') ||
      !nonnegative(state.sequence) || !positive(state.nextGeneration) ||
      !isDenseArray(state.entries, MAX_ENTRIES) || !isDenseArray(state.recoveryReceipts, MAX_RECEIPTS)) {
    return null;
  }
  const seenWorkIds = new Set();
  const entries = [];
  for (const entry of state.entries) {
    if (!isValidQueueEntry(entry) || seenWorkIds.has(entry.workId) || entry.generation >= state.nextGeneration) {
      return null;
    }
    seenWorkIds.add(entry.workId);
    entries.push(cloneEntry(entry));
  }
  const receipts = [];
  for (const receipt of state.recoveryReceipts) {
    if (!isValidReceipt(receipt) || receipt.reclaimedGeneration >= state.nextGeneration) return null;
    receipts.push(cloneReceipt(receipt));
  }
  return Object.freeze({
    schemaVersion: 1,
    protocol: state.protocol,
    sequence: state.sequence,
    nextGeneration: state.nextGeneration,
    entries: Object.freeze(entries),
    recoveryReceipts: Object.freeze(receipts)
  });
}

function computeStateOid(previousOid, state) {
  return createHash('sha256')
    .update(`${previousOid}:${JSON.stringify(state)}`, 'utf8')
    .digest('hex')
    .slice(0, 40);
}

export function createInMemoryWorkQueueRefStore(initialState = null) {
  let currentOid = ZERO_GIT_OID;
  let currentState = null;
  if (initialState !== null) {
    const validated = freezeValidatedState(initialState);
    if (validated === null) throw new TypeError('INVALID_INITIAL_WORK_QUEUE_STATE');
    currentState = validated;
    currentOid = computeStateOid(ZERO_GIT_OID, validated);
  }

  return Object.freeze({
    readRef(ref = PROTECTED_WORK_QUEUE_REF) {
      if (ref !== PROTECTED_WORK_QUEUE_REF) {
        return Object.freeze({ok: false, reason: 'UNPROTECTED_WORK_QUEUE_REF'});
      }
      return Object.freeze({
        ok: true,
        ref: PROTECTED_WORK_QUEUE_REF,
        oid: currentOid,
        state: currentState === null ? null : freezeValidatedState(currentState)
      });
    },
    compareAndSwapRef(request) {
      if (!isPlainRecord(request, ['ref', 'expectedOid', 'nextState'], ['force'])) {
        return Object.freeze({ok: false, reason: 'INVALID_CAS_REQUEST'});
      }
      if (request.force === true) {
        return Object.freeze({ok: false, reason: 'FORCE_UPDATE_FORBIDDEN'});
      }
      if (request.force !== undefined && request.force !== false) {
        return Object.freeze({ok: false, reason: 'INVALID_CAS_REQUEST'});
      }
      if (request.ref !== PROTECTED_WORK_QUEUE_REF) {
        return Object.freeze({ok: false, reason: 'UNPROTECTED_WORK_QUEUE_REF'});
      }
      if (!isHex40(request.expectedOid)) {
        return Object.freeze({ok: false, reason: 'INVALID_CAS_REQUEST'});
      }
      const validated = freezeValidatedState(request.nextState);
      if (validated === null) {
        return Object.freeze({ok: false, reason: 'INVALID_NEXT_STATE'});
      }
      if (request.expectedOid !== currentOid) {
        return Object.freeze({ok: false, reason: 'CAS_CONFLICT', currentOid});
      }
      const previousOid = currentOid;
      currentOid = computeStateOid(previousOid, validated);
      currentState = validated;
      return Object.freeze({
        ok: true,
        reason: 'CAS_APPLIED',
        ref: PROTECTED_WORK_QUEUE_REF,
        previousOid,
        oid: currentOid,
        state: currentState
      });
    }
  });
}

function isLeaseActive(entry, nowMs) {
  return entry.status === 'leased' && entry.leaseExpiresAtMs > nowMs && entry.executionDeadlineMs > nowMs;
}

function resolveLaneForPaths(lanes, paths) {
  const matched = lanes.filter(lane => paths.every(path =>
    lane.owners.some(owner => path === owner || path.startsWith(`${owner}/`))));
  return matched.length === 1 ? matched[0].id : null;
}

const denyPlan = reason => Object.freeze({
  shadow: true,
  liveDispatch: false,
  scheduled: Object.freeze([]),
  reason
});

export function planUnifiedWorkQueue(input) {
  if (!isPlainRecord(input, ['config', 'shadowInput', 'nowMs'], ['activeLeases', 'policy'])) {
    return denyPlan('INVALID_UNIFIED_PLAN_INPUT');
  }
  if (!nonnegative(input.nowMs)) return denyPlan('INVALID_UNIFIED_PLAN_INPUT');
  if (!validateProjectConfig(input.config)) return denyPlan('INVALID_PROJECT_CONFIG');

  const shadow = input.shadowInput;
  if (!isPlainRecord(shadow, ['enabled', 'stop', 'capacity', 'quotaVerified', 'tasks'])) {
    return denyPlan('INVALID_SHADOW_INPUT');
  }
  if (shadow.enabled !== true || shadow.stop !== false ||
      input.config.execution.enabled !== true || input.config.execution.stop !== false) {
    return denyPlan('STOPPED');
  }
  if (!positive(shadow.capacity) || shadow.capacity > 50 || shadow.quotaVerified !== true) {
    return denyPlan('CAPACITY_UNKNOWN');
  }
  if (!isDenseArray(shadow.tasks, MAX_ENTRIES)) return denyPlan('INVALID_TASKS');

  const rawLeases = input.activeLeases === undefined ? [] : input.activeLeases;
  if (!isDenseArray(rawLeases, 32)) return denyPlan('INVALID_ACTIVE_LEASES');

  const activeReservations = [];
  for (let i = 0; i < rawLeases.length; i++) {
    const lease = rawLeases[i];
    if (!isValidQueueEntry(lease)) return denyPlan('INVALID_ACTIVE_LEASES');
    if (!isLeaseActive(lease, input.nowMs)) continue;
    const reservationId = lease.targetType === 'issue' ? lease.issueNumber : lease.pullNumber;
    activeReservations.push({
      id: reservationId,
      lane: lease.lane,
      paths: [...lease.ownedPaths]
    });
  }

  const normalizedTasks = [];
  for (let i = 0; i < shadow.tasks.length; i++) {
    const task = shadow.tasks[i];
    if (!isPlainRecord(task, ['id', 'priority', 'state', 'dependencies', 'paths'], ['lane']) ||
        !isDenseArray(task.dependencies, MAX_ENTRIES) ||
        !isValidPathSet(task.paths) ||
        !['approved', 'active', 'accepted', 'pending', 'blocked'].includes(task.state)) {
      return denyPlan('INVALID_TASKS');
    }
    const inferredLane = resolveLaneForPaths(input.config.lanes, task.paths);
    if (inferredLane === null || (task.lane !== undefined && task.lane !== inferredLane)) {
      return denyPlan('LANE_OWNERSHIP_VIOLATION');
    }
    normalizedTasks.push({
      id: task.id,
      lane: inferredLane,
      state: task.state === 'pending' ? 'blocked' : task.state,
      priority: task.priority,
      dependencies: [...task.dependencies],
      paths: [...task.paths]
    });
  }

  const cappedConfig = {
    ...input.config,
    limits: {
      ...input.config.limits,
      maxConcurrentLanes: Math.min(input.config.limits.maxConcurrentLanes, shadow.capacity)
    }
  };

  const planned = planLanes(cappedConfig, normalizedTasks, activeReservations, input.policy);
  const frozenScheduled = Object.freeze(planned.scheduled.map(item => Object.freeze({
    id: item.id,
    lane: item.lane,
    paths: Object.freeze([...item.paths])
  })));
  const response = {
    shadow: true,
    liveDispatch: false,
    scheduled: frozenScheduled,
    readyIds: Object.freeze(planned.scheduled.map(item => item.id)),
    reason: planned.reason
  };
  if (planned.blockedTasks !== undefined) {
    response.blockedTasks = Object.freeze(planned.blockedTasks.map(item => Object.freeze({...item})));
  }
  return Object.freeze(response);
}

const denyMutation = reason => Object.freeze({
  shadow: true,
  ok: false,
  liveDispatch: false,
  liveMerge: false,
  reason
});

function isValidRefStore(refStore) {
  return refStore !== null && typeof refStore === 'object' && !types.isProxy(refStore) &&
    typeof refStore.readRef === 'function' && typeof refStore.compareAndSwapRef === 'function';
}

async function readValidatedSnapshot(refStore) {
  let snapshot;
  try {
    const rawSnapshot = refStore.readRef(PROTECTED_WORK_QUEUE_REF);
    if (rawSnapshot !== null && typeof rawSnapshot === 'object' && types.isProxy(rawSnapshot)) {
      return {ok: false, reason: 'REF_STORE_UNAVAILABLE'};
    }
    snapshot = await rawSnapshot;
  } catch {
    return {ok: false, reason: 'REF_STORE_UNAVAILABLE'};
  }
  if (snapshot === null || typeof snapshot !== 'object' || types.isProxy(snapshot) ||
      Array.isArray(snapshot) || Object.getPrototypeOf(snapshot) !== Object.prototype ||
      !isOwnEnumerableData(snapshot, 'ok')) {
    return {ok: false, reason: 'REF_STORE_UNAVAILABLE'};
  }
  if (snapshot.ok === false) {
    const reason = isOwnEnumerableData(snapshot, 'reason') && typeof snapshot.reason === 'string' && snapshot.reason.length > 0
      ? snapshot.reason
      : 'REF_STORE_UNAVAILABLE';
    return {ok: false, reason};
  }
  if (snapshot.ok !== true || !isOwnEnumerableData(snapshot, 'oid') || !isHex40(snapshot.oid) ||
      !isOwnEnumerableData(snapshot, 'state')) {
    return {ok: false, reason: 'REF_STORE_UNAVAILABLE'};
  }
  if (snapshot.state === null) {
    if (snapshot.oid !== ZERO_GIT_OID) return {ok: false, reason: 'INVALID_QUEUE_STATE'};
    return {ok: true, oid: snapshot.oid, state: createEmptyQueueState()};
  }
  const validated = freezeValidatedState(snapshot.state);
  if (validated === null) return {ok: false, reason: 'INVALID_QUEUE_STATE'};
  return {ok: true, oid: snapshot.oid, state: validated};
}

function validateCandidate(candidate, config, nowMs) {
  const optional = ['issueNumber', 'pullNumber', 'headSha', 'runAttempt', 'maxExecutionMs', 'maxAttempts', 'traceparent', 'lockSha256'];
  const required = ['targetType', 'repository', 'repositoryId', 'lane', 'ownedPaths', 'workerId', 'runId', 'leaseTtlMs'];
  if (!isPlainRecord(candidate, required, optional)) return {ok: false, reason: 'INVALID_CANDIDATE'};
  const runAttempt = candidate.runAttempt === undefined ? 1 : candidate.runAttempt;
  if (!isRepoName(candidate.repository) ||
      !positive(candidate.repositoryId) || !isWorkerId(candidate.workerId) ||
      !positive(candidate.runId) || !positive(runAttempt) || !isValidPathSet(candidate.ownedPaths)) {
    return {ok: false, reason: 'INVALID_CANDIDATE'};
  }
  if (candidate.repository !== config.project.repository) {
    return {ok: false, reason: 'CROSS_REPO_CANDIDATE_REJECTED'};
  }
  const laneDef = config.lanes.find(lane => lane.id === candidate.lane);
  if (!laneDef || !candidate.ownedPaths.every(path =>
      laneDef.owners.some(owner => path === owner || path.startsWith(`${owner}/`)))) {
    return {ok: false, reason: 'LANE_OWNERSHIP_VIOLATION'};
  }
  if (!boundedTtl(candidate.leaseTtlMs)) return {ok: false, reason: 'INVALID_LEASE_TTL'};
  const maxExecutionMs = candidate.maxExecutionMs === undefined
    ? Math.min(MAX_LEASE_TTL_MS, Math.max(candidate.leaseTtlMs, config.limits.leaseMs))
    : candidate.maxExecutionMs;
  if (!boundedTtl(maxExecutionMs) || maxExecutionMs < candidate.leaseTtlMs ||
      !Number.isSafeInteger(nowMs + maxExecutionMs)) {
    return {ok: false, reason: 'INVALID_LEASE_TTL'};
  }
  const maxAttempts = candidate.maxAttempts === undefined ? config.limits.maxAttempts : candidate.maxAttempts;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    return {ok: false, reason: 'INVALID_CANDIDATE'};
  }
  if (maxAttempts > config.limits.maxAttempts) {
    return {ok: false, reason: 'RETRY_CEILING_EXCEEDED'};
  }
  if (candidate.traceparent !== undefined && !isTraceparent(candidate.traceparent)) {
    return {ok: false, reason: 'INVALID_CANDIDATE'};
  }
  if (candidate.lockSha256 !== undefined && !isHex64(candidate.lockSha256)) {
    return {ok: false, reason: 'INVALID_CANDIDATE'};
  }
  if (candidate.targetType === 'issue') {
    if (!positive(candidate.issueNumber) || candidate.pullNumber !== undefined || candidate.headSha !== undefined) {
      return {ok: false, reason: 'INVALID_CANDIDATE'};
    }
    return {
      ok: true,
      workId: `${candidate.repositoryId}:issue:${candidate.issueNumber}`,
      issueNumber: candidate.issueNumber,
      pullNumber: null,
      headSha: null,
      runAttempt,
      maxExecutionMs,
      maxAttempts
    };
  }
  if (candidate.targetType === 'pull_request') {
    if (!positive(candidate.pullNumber) || !isHex40(candidate.headSha) || candidate.issueNumber !== undefined) {
      return {ok: false, reason: 'INVALID_CANDIDATE'};
    }
    return {
      ok: true,
      workId: `${candidate.repositoryId}:pr:${candidate.pullNumber}:${candidate.headSha}`,
      issueNumber: null,
      pullNumber: candidate.pullNumber,
      headSha: candidate.headSha,
      runAttempt,
      maxExecutionMs,
      maxAttempts
    };
  }
  return {ok: false, reason: 'INVALID_CANDIDATE'};
}

function resolveCasAttempts(maxCasAttempts) {
  if (maxCasAttempts === undefined) return 3;
  return Number.isSafeInteger(maxCasAttempts) && maxCasAttempts >= 1 && maxCasAttempts <= 5 ? maxCasAttempts : null;
}

async function executeCasTransition(refStore, maxCasAttempts, transformState) {
  for (let casAttempt = 1; casAttempt <= maxCasAttempts; casAttempt++) {
    const current = await readValidatedSnapshot(refStore);
    if (!current.ok) return denyMutation(current.reason);
    const step = transformState(current.state, current.oid);
    if (step.abort) return step.result;

    let casResult;
    try {
      const rawCasResult = refStore.compareAndSwapRef({
        ref: PROTECTED_WORK_QUEUE_REF,
        expectedOid: current.oid,
        nextState: step.nextState,
        force: false
      });
      if (rawCasResult !== null && typeof rawCasResult === 'object' && types.isProxy(rawCasResult)) {
        return denyMutation('REF_STORE_UNAVAILABLE');
      }
      casResult = await rawCasResult;
    } catch {
      return denyMutation('REF_STORE_UNAVAILABLE');
    }
    if (casResult === null || typeof casResult !== 'object' || types.isProxy(casResult) ||
        Array.isArray(casResult) || Object.getPrototypeOf(casResult) !== Object.prototype ||
        !isOwnEnumerableData(casResult, 'ok')) {
      return denyMutation('REF_STORE_UNAVAILABLE');
    }
    if (casResult.ok === true) {
      if (!isOwnEnumerableData(casResult, 'oid') || !isHex40(casResult.oid)) {
        return denyMutation('REF_STORE_UNAVAILABLE');
      }
      return step.onApplied(casResult.oid, casAttempt);
    }
    const reason = isOwnEnumerableData(casResult, 'reason') && typeof casResult.reason === 'string' && casResult.reason.length > 0
      ? casResult.reason
      : 'REF_STORE_UNAVAILABLE';
    if (reason !== 'CAS_CONFLICT') {
      return denyMutation(reason);
    }
  }
  return denyMutation('CAS_CONFLICT_EXHAUSTED');
}

export async function claimWorkQueueLease(options) {
  if (!isPlainRecord(options, ['refStore', 'config', 'candidate', 'nowMs'], ['stop', 'force', 'maxCasAttempts'])) {
    return denyMutation('INVALID_CLAIM_OPTIONS');
  }
  if (options.force === true) return denyMutation('FORCE_UPDATE_FORBIDDEN');
  if (options.force !== undefined && options.force !== false) return denyMutation('INVALID_CLAIM_OPTIONS');
  const maxCasAttempts = resolveCasAttempts(options.maxCasAttempts);
  if (!isValidRefStore(options.refStore) || !nonnegative(options.nowMs) || maxCasAttempts === null) {
    return denyMutation('INVALID_CLAIM_OPTIONS');
  }
  if (!validateProjectConfig(options.config)) return denyMutation('INVALID_PROJECT_CONFIG');
  if ((options.stop !== undefined && options.stop !== false) ||
      options.config.execution.stop !== false || options.config.execution.enabled !== true) {
    return denyMutation('STOPPED');
  }

  const checked = validateCandidate(options.candidate, options.config, options.nowMs);
  if (!checked.ok) return denyMutation(checked.reason);

  return executeCasTransition(options.refStore, maxCasAttempts, state => {
    const existingIndex = state.entries.findIndex(item => item.workId === checked.workId);
    const existing = existingIndex >= 0 ? state.entries[existingIndex] : null;
    const effectiveMaxAttempts = existing === null
      ? checked.maxAttempts
      : Math.min(existing.maxAttempts, checked.maxAttempts, options.config.limits.maxAttempts);
    if (existing !== null) {
      if (isLeaseActive(existing, options.nowMs)) return {abort: true, result: denyMutation('DUPLICATE_ACTIVE_CLAIM')};
      if (existing.status === 'completed') return {abort: true, result: denyMutation('WORK_ALREADY_COMPLETED')};
      if (existing.status === 'cancelled') return {abort: true, result: denyMutation('WORK_CANCELLED')};
      if (existing.status === 'exhausted' || existing.attempts >= effectiveMaxAttempts) {
        return {abort: true, result: denyMutation('RETRY_CEILING_EXHAUSTED')};
      }
    } else if (state.entries.length >= MAX_ENTRIES) {
      return {abort: true, result: denyMutation('QUEUE_CAPACITY_EXCEEDED')};
    }

    const activeEntries = state.entries.filter(item =>
      item.workId !== checked.workId && isLeaseActive(item, options.nowMs));
    for (const active of activeEntries) {
      if (options.candidate.ownedPaths.some(candidatePath =>
          active.ownedPaths.some(activePath => pathsOverlap(candidatePath, activePath)))) {
        return {abort: true, result: denyMutation('OWNED_PATHS_OVERLAP')};
      }
    }
    if (activeEntries.some(active => active.lane === options.candidate.lane)) {
      return {abort: true, result: denyMutation('LANE_RESERVED')};
    }
    if (activeEntries.length >= options.config.limits.maxConcurrentLanes) {
      return {abort: true, result: denyMutation('CAPACITY_FULL')};
    }

    const executionDeadlineMs = options.nowMs + checked.maxExecutionMs;
    const leaseExpiresAtMs = Math.min(executionDeadlineMs, options.nowMs + options.candidate.leaseTtlMs);
    const generation = state.nextGeneration;
    const attempts = existing === null ? 1 : existing.attempts + 1;

    const nextEntry = {
      workId: checked.workId,
      targetType: options.candidate.targetType,
      repository: options.candidate.repository,
      repositoryId: options.candidate.repositoryId,
      issueNumber: checked.issueNumber,
      pullNumber: checked.pullNumber,
      headSha: checked.headSha,
      lane: options.candidate.lane,
      ownedPaths: [...options.candidate.ownedPaths],
      status: 'leased',
      generation,
      attempts,
      maxAttempts: effectiveMaxAttempts,
      workerId: options.candidate.workerId,
      runId: options.candidate.runId,
      runAttempt: checked.runAttempt,
      claimedAtMs: options.nowMs,
      leaseTtlMs: options.candidate.leaseTtlMs,
      leaseExpiresAtMs,
      maxExecutionMs: checked.maxExecutionMs,
      executionDeadlineMs
    };
    if (options.candidate.traceparent !== undefined) nextEntry.traceparent = options.candidate.traceparent;
    if (options.candidate.lockSha256 !== undefined) nextEntry.lockSha256 = options.candidate.lockSha256;

    const nextEntries = [...state.entries];
    if (existingIndex >= 0) nextEntries[existingIndex] = nextEntry;
    else nextEntries.push(nextEntry);

    return {
      abort: false,
      nextState: {
        schemaVersion: 1,
        protocol: state.protocol,
        sequence: state.sequence + 1,
        nextGeneration: generation + 1,
        entries: nextEntries,
        recoveryReceipts: [...state.recoveryReceipts]
      },
      onApplied: (appliedOid, casAttempts) => Object.freeze({
        shadow: true,
        ok: true,
        liveDispatch: false,
        liveMerge: false,
        reason: 'LEASE_CLAIMED',
        ref: PROTECTED_WORK_QUEUE_REF,
        oid: appliedOid,
        casAttempts,
        lease: cloneEntry(nextEntry)
      })
    };
  });
}

export async function renewWorkQueueLease(options) {
  const required = ['refStore', 'workId', 'workerId', 'generation', 'leaseTtlMs', 'nowMs'];
  if (!isPlainRecord(options, required, ['stop', 'force', 'maxCasAttempts'])) {
    return denyMutation('INVALID_RENEW_OPTIONS');
  }
  if (options.force === true) return denyMutation('FORCE_UPDATE_FORBIDDEN');
  if (options.force !== undefined && options.force !== false) return denyMutation('INVALID_RENEW_OPTIONS');
  if (options.stop !== undefined && options.stop !== false) return denyMutation('STOPPED');
  const maxCasAttempts = resolveCasAttempts(options.maxCasAttempts);
  if (!isValidRefStore(options.refStore) || typeof options.workId !== 'string' || options.workId.length === 0 ||
      !isWorkerId(options.workerId) || !positive(options.generation) ||
      !nonnegative(options.nowMs) || maxCasAttempts === null) {
    return denyMutation('INVALID_RENEW_OPTIONS');
  }
  if (!boundedTtl(options.leaseTtlMs)) return denyMutation('INVALID_LEASE_TTL');

  return executeCasTransition(options.refStore, maxCasAttempts, state => {
    const index = state.entries.findIndex(item => item.workId === options.workId);
    if (index < 0) return {abort: true, result: denyMutation('WORK_NOT_FOUND')};
    const entry = state.entries[index];
    if (entry.generation !== options.generation) return {abort: true, result: denyMutation('STALE_GENERATION')};
    if (entry.status !== 'leased' || entry.workerId !== options.workerId) {
      return {abort: true, result: denyMutation('LEASE_NOT_HELD')};
    }
    if (options.nowMs < entry.claimedAtMs) return {abort: true, result: denyMutation('CLOCK_SKEW_REJECTED')};
    if (options.nowMs >= entry.executionDeadlineMs) return {abort: true, result: denyMutation('EXECUTION_TTL_EXCEEDED')};
    if (options.nowMs >= entry.leaseExpiresAtMs) return {abort: true, result: denyMutation('LEASE_EXPIRED')};

    const updated = {
      ...entry,
      ownedPaths: [...entry.ownedPaths],
      leaseTtlMs: Math.min(options.leaseTtlMs, entry.maxExecutionMs),
      leaseExpiresAtMs: Math.min(entry.executionDeadlineMs, options.nowMs + options.leaseTtlMs)
    };
    const nextEntries = [...state.entries];
    nextEntries[index] = updated;
    return {
      abort: false,
      nextState: {
        schemaVersion: 1,
        protocol: state.protocol,
        sequence: state.sequence + 1,
        nextGeneration: state.nextGeneration,
        entries: nextEntries,
        recoveryReceipts: [...state.recoveryReceipts]
      },
      onApplied: appliedOid => Object.freeze({
        shadow: true,
        ok: true,
        liveDispatch: false,
        liveMerge: false,
        reason: 'LEASE_RENEWED',
        oid: appliedOid,
        lease: cloneEntry(updated)
      })
    };
  });
}

export async function settleWorkQueueLease(options) {
  const required = ['refStore', 'workId', 'workerId', 'generation', 'outcome', 'nowMs'];
  if (!isPlainRecord(options, required, ['stop', 'force', 'maxCasAttempts'])) {
    return denyMutation('INVALID_SETTLE_OPTIONS');
  }
  if (options.force === true) return denyMutation('FORCE_UPDATE_FORBIDDEN');
  if (options.force !== undefined && options.force !== false) return denyMutation('INVALID_SETTLE_OPTIONS');
  if (options.stop !== undefined && options.stop !== false) return denyMutation('STOPPED');
  const maxCasAttempts = resolveCasAttempts(options.maxCasAttempts);
  if (!isValidRefStore(options.refStore) || typeof options.workId !== 'string' || options.workId.length === 0 ||
      !isWorkerId(options.workerId) || !positive(options.generation) ||
      !['completed', 'cancelled', 'requeued'].includes(options.outcome) ||
      !nonnegative(options.nowMs) || maxCasAttempts === null) {
    return denyMutation('INVALID_SETTLE_OPTIONS');
  }

  return executeCasTransition(options.refStore, maxCasAttempts, state => {
    const index = state.entries.findIndex(item => item.workId === options.workId);
    if (index < 0) return {abort: true, result: denyMutation('WORK_NOT_FOUND')};
    const entry = state.entries[index];
    if (entry.generation !== options.generation) return {abort: true, result: denyMutation('STALE_GENERATION')};
    if (entry.status !== 'leased' || entry.workerId !== options.workerId) {
      return {abort: true, result: denyMutation('LEASE_NOT_HELD')};
    }
    if (options.nowMs < entry.claimedAtMs) return {abort: true, result: denyMutation('CLOCK_SKEW_REJECTED')};
    if (options.outcome === 'completed') {
      if (options.nowMs >= entry.executionDeadlineMs) return {abort: true, result: denyMutation('EXECUTION_TTL_EXCEEDED')};
      if (options.nowMs >= entry.leaseExpiresAtMs) return {abort: true, result: denyMutation('LEASE_EXPIRED')};
    }

    const finalStatus = options.outcome === 'requeued' && entry.attempts >= entry.maxAttempts
      ? 'exhausted'
      : options.outcome;
    const updated = {
      ...entry,
      ownedPaths: [...entry.ownedPaths],
      status: finalStatus,
      leaseExpiresAtMs: Math.min(entry.leaseExpiresAtMs, options.nowMs)
    };
    const nextEntries = [...state.entries];
    nextEntries[index] = updated;
    return {
      abort: false,
      nextState: {
        schemaVersion: 1,
        protocol: state.protocol,
        sequence: state.sequence + 1,
        nextGeneration: state.nextGeneration,
        entries: nextEntries,
        recoveryReceipts: [...state.recoveryReceipts]
      },
      onApplied: appliedOid => Object.freeze({
        shadow: true,
        ok: true,
        liveDispatch: false,
        liveMerge: false,
        reason: 'LEASE_SETTLED',
        oid: appliedOid,
        lease: cloneEntry(updated)
      })
    };
  });
}

export async function reconcileWorkQueueRunStates(options) {
  if (!isPlainRecord(options, ['refStore', 'observedRuns', 'nowMs'], ['stop', 'force', 'maxCasAttempts', 'config'])) {
    return denyMutation('INVALID_RECONCILE_INPUT');
  }
  if (options.force === true) return denyMutation('FORCE_UPDATE_FORBIDDEN');
  if (options.force !== undefined && options.force !== false) return denyMutation('INVALID_RECONCILE_INPUT');
  if (options.config !== undefined && !validateProjectConfig(options.config)) {
    return denyMutation('INVALID_PROJECT_CONFIG');
  }
  const stopConfigured = options.config !== undefined &&
    (options.config.execution.stop !== false || options.config.execution.enabled !== true);
  if ((options.stop !== undefined && options.stop !== false) || stopConfigured) {
    return Object.freeze({
      shadow: true,
      ok: false,
      liveDispatch: false,
      liveMerge: false,
      reclaimed: Object.freeze([]),
      receipts: Object.freeze([]),
      reason: 'STOPPED'
    });
  }
  const maxCasAttempts = resolveCasAttempts(options.maxCasAttempts);
  if (!isValidRefStore(options.refStore) || !isDenseArray(options.observedRuns, MAX_ENTRIES) ||
      !nonnegative(options.nowMs) || maxCasAttempts === null) {
    return denyMutation('INVALID_RECONCILE_INPUT');
  }

  const configuredCeiling = options.config !== undefined ? options.config.limits.maxAttempts : 5;
  const observationsByWorkId = new Map();
  for (let i = 0; i < options.observedRuns.length; i++) {
    const obs = options.observedRuns[i];
    if (!isPlainRecord(obs, ['workId', 'runId', 'runAttempt', 'leaseGeneration', 'runState'], ['conclusion']) ||
        typeof obs.workId !== 'string' || obs.workId.length === 0 ||
        !positive(obs.runId) || !positive(obs.runAttempt) || !positive(obs.leaseGeneration) ||
        !VALID_RUN_STATES.has(obs.runState) || observationsByWorkId.has(obs.workId)) {
      return denyMutation('INVALID_RECONCILE_INPUT');
    }
    if (obs.conclusion !== undefined) {
      if (obs.runState !== 'run_terminal' || !VALID_CONCLUSIONS.has(obs.conclusion)) {
        return denyMutation('INVALID_RECONCILE_INPUT');
      }
    }
    observationsByWorkId.set(obs.workId, obs);
  }

  return executeCasTransition(options.refStore, maxCasAttempts, (state, oid) => {
    let nextGeneration = state.nextGeneration;
    const nextEntries = [];
    const newReceipts = [];
    const skipped = [];

    for (const entry of state.entries) {
      const retryLimit = Math.min(entry.maxAttempts, configuredCeiling);
      const persistedMaxAttempts = Math.max(entry.attempts, retryLimit);
      const obs = observationsByWorkId.get(entry.workId);
      if (obs !== undefined) {
        const matchesLease = entry.status === 'leased' &&
          entry.runId === obs.runId &&
          entry.runAttempt === obs.runAttempt &&
          entry.generation === obs.leaseGeneration;
        if (!matchesLease) {
          skipped.push(Object.freeze({
            workId: entry.workId,
            runId: obs.runId,
            runAttempt: obs.runAttempt,
            leaseGeneration: obs.leaseGeneration,
            reason: 'STALE_OR_INACTIVE_RUN'
          }));
        } else {
          const leaseStillActive = isLeaseActive(entry, options.nowMs);
          const conclusion = obs.conclusion ?? null;
          const terminalSuccess = obs.runState === 'run_terminal' && conclusion === 'success';
          if (leaseStillActive || !terminalSuccess) {
            const reclaimedGeneration = nextGeneration++;
            const outcome = (leaseStillActive && terminalSuccess)
              ? 'completed'
              : (entry.attempts >= retryLimit ? 'exhausted' : 'requeued');
            nextEntries.push({
              ...entry,
              ownedPaths: [...entry.ownedPaths],
              maxAttempts: persistedMaxAttempts,
              status: outcome,
              generation: reclaimedGeneration,
              leaseExpiresAtMs: Math.min(entry.leaseExpiresAtMs, options.nowMs)
            });
            newReceipts.push({
              workId: entry.workId,
              repositoryId: entry.repositoryId,
              targetType: entry.targetType,
              runState: obs.runState,
              conclusion,
              previousRunId: entry.runId,
              previousRunAttempt: entry.runAttempt,
              previousGeneration: entry.generation,
              reclaimedGeneration,
              attempts: entry.attempts,
              maxAttempts: retryLimit,
              outcome,
              reclaimedAtMs: options.nowMs
            });
            continue;
          }
        }
      }

      if (entry.status === 'leased' &&
          (options.nowMs >= entry.leaseExpiresAtMs || options.nowMs >= entry.executionDeadlineMs)) {
        const reclaimedGeneration = nextGeneration++;
        const outcome = entry.attempts >= retryLimit ? 'exhausted' : 'requeued';
        nextEntries.push({
          ...entry,
          ownedPaths: [...entry.ownedPaths],
          maxAttempts: persistedMaxAttempts,
          status: outcome,
          generation: reclaimedGeneration,
          leaseExpiresAtMs: Math.min(entry.leaseExpiresAtMs, options.nowMs)
        });
        newReceipts.push({
          workId: entry.workId,
          repositoryId: entry.repositoryId,
          targetType: entry.targetType,
          runState: 'lease_expired',
          conclusion: null,
          previousRunId: entry.runId,
          previousRunAttempt: entry.runAttempt,
          previousGeneration: entry.generation,
          reclaimedGeneration,
          attempts: entry.attempts,
          maxAttempts: retryLimit,
          outcome,
          reclaimedAtMs: options.nowMs
        });
        continue;
      }

      nextEntries.push({...entry, ownedPaths: [...entry.ownedPaths]});
    }

    for (const [workId, obs] of observationsByWorkId.entries()) {
      if (!state.entries.some(item => item.workId === workId)) {
        skipped.push(Object.freeze({
          workId,
          runId: obs.runId,
          runAttempt: obs.runAttempt,
          leaseGeneration: obs.leaseGeneration,
          reason: 'UNKNOWN_WORK_ID'
        }));
      }
    }

    if (newReceipts.length === 0) {
      return {
        abort: true,
        result: Object.freeze({
          shadow: true,
          ok: true,
          liveDispatch: false,
          liveMerge: false,
          reason: 'NO_ORPHANS_DETECTED',
          oid,
          reclaimed: Object.freeze([]),
          receipts: Object.freeze([]),
          skipped: Object.freeze(skipped)
        })
      };
    }

    const mergedReceipts = [...state.recoveryReceipts, ...newReceipts].slice(-MAX_RECEIPTS);
    return {
      abort: false,
      nextState: {
        schemaVersion: 1,
        protocol: state.protocol,
        sequence: state.sequence + 1,
        nextGeneration,
        entries: nextEntries,
        recoveryReceipts: mergedReceipts
      },
      onApplied: appliedOid => Object.freeze({
        shadow: true,
        ok: true,
        liveDispatch: false,
        liveMerge: false,
        reason: 'ORPHANS_RECLAIMED',
        oid: appliedOid,
        reclaimed: Object.freeze(newReceipts.map(item => item.workId)),
        receipts: Object.freeze(newReceipts.map(cloneReceipt)),
        skipped: Object.freeze(skipped)
      })
    };
  });
}
