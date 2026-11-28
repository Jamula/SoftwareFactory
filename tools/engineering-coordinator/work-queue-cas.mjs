import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {pathsOverlap, planLanes} from './planner.mjs';
import {validateProjectConfig} from './project-config.mjs';

export const PROTECTED_WORK_QUEUE_REF = 'refs/heads/work-queue';
export const ZERO_GIT_OID = '0000000000000000000000000000000000000000';
export const MAX_LEASE_TTL_MS = 3600000;

const MAX_ENTRIES = 250;
const MAX_RECEIPTS = 250;
const MAX_ARCHIVED_TERMINAL = 2000;
const HEX40_RE = /^[a-f0-9]{40}$/;
const HEX64_RE = /^[a-f0-9]{64}$/;
const TRACEPARENT_RE = /^00-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{2}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const LANE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VALID_ENTRY_STATUSES = new Set(['leased', 'requeued', 'completed', 'cancelled', 'exhausted']);
const TERMINAL_ENTRY_STATUSES = new Set(['completed', 'cancelled', 'exhausted']);
const VALID_RUN_STATES = new Set(['launch_failed', 'worker_terminated', 'run_terminal', 'run_missing']);
const VALID_CONCLUSIONS = new Set([
  'success', 'failure', 'neutral', 'cancelled', 'skipped',
  'timed_out', 'action_required', 'stale', 'startup_failure'
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
  if (entry.priorRuns !== undefined) {
    copy.priorRuns = Object.freeze(entry.priorRuns.map(item => Object.freeze({
      runId: item.runId,
      runAttempt: item.runAttempt
    })));
  }
  return Object.freeze(copy);
}

function copyEntryWith(entry, overrides) {
  const next = {...entry, ownedPaths: [...entry.ownedPaths], ...overrides};
  if (entry.priorRuns !== undefined) {
    next.priorRuns = entry.priorRuns.map(item => ({runId: item.runId, runAttempt: item.runAttempt}));
  }
  return next;
}

function isValidPriorRuns(priorRuns, entry) {
  if (!isDenseArray(priorRuns, 4) || priorRuns.length === 0 || priorRuns.length >= entry.attempts) {
    return false;
  }
  const seen = new Set([`${entry.runId}:${entry.runAttempt}`]);
  for (const item of priorRuns) {
    if (!isPlainRecord(item, ['runId', 'runAttempt']) || !positive(item.runId) || !positive(item.runAttempt)) {
      return false;
    }
    const key = `${item.runId}:${item.runAttempt}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
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
  if (!isPlainRecord(entry, required, ['traceparent', 'lockSha256', 'priorRuns'])) return false;
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
  if (entry.priorRuns !== undefined && !isValidPriorRuns(entry.priorRuns, entry)) return false;
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

function isValidArchivedEntry(item) {
  return isPlainRecord(item, ['workId', 'status']) &&
    typeof item.workId === 'string' && item.workId.length > 0 && item.workId.length <= 160 &&
    TERMINAL_ENTRY_STATUSES.has(item.status);
}

function freezeValidatedState(state) {
  if (!isPlainRecord(state, ['schemaVersion', 'protocol', 'sequence', 'nextGeneration', 'entries', 'recoveryReceipts'], ['archivedTerminal']) ||
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
  const archived = [];
  if (state.archivedTerminal !== undefined) {
    if (!isDenseArray(state.archivedTerminal, MAX_ARCHIVED_TERMINAL)) return null;
    for (const item of state.archivedTerminal) {
      if (!isValidArchivedEntry(item) || seenWorkIds.has(item.workId)) return null;
      seenWorkIds.add(item.workId);
      archived.push(Object.freeze({workId: item.workId, status: item.status}));
    }
  }
  const receipts = [];
  for (const receipt of state.recoveryReceipts) {
    if (!isValidReceipt(receipt) || receipt.reclaimedGeneration >= state.nextGeneration) return null;
    receipts.push(cloneReceipt(receipt));
  }
  const frozen = {
    schemaVersion: 1,
    protocol: state.protocol,
    sequence: state.sequence,
    nextGeneration: state.nextGeneration,
    entries: Object.freeze(entries),
    recoveryReceipts: Object.freeze(receipts)
  };
  if (archived.length > 0) frozen.archivedTerminal = Object.freeze(archived);
  return Object.freeze(frozen);
}

function computeStateOid(previousOid, state) {
  return createHash('sha256')
    .update(`${previousOid}:${JSON.stringify(state)}`, 'utf8')
    .digest('hex')
    .slice(0, 40);
}

function createSeededWorkQueueRefStore(initialState, initialOid) {
  let currentOid = ZERO_GIT_OID;
  let currentState = null;
  if (initialState !== null) {
    const validated = freezeValidatedState(initialState);
    if (validated === null) throw new TypeError('INVALID_INITIAL_WORK_QUEUE_STATE');
    currentState = validated;
    currentOid = initialOid === null ? computeStateOid(ZERO_GIT_OID, validated) : initialOid;
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

export function createInMemoryWorkQueueRefStore(initialState = null) {
  return createSeededWorkQueueRefStore(initialState, null);
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

function sanitizeSchedulingPolicy(policy) {
  if (policy === undefined) return {ok: true, policy: undefined};
  if (!isPlainRecord(policy, ['now', 'agingMs', 'riskCeiling', 'ready']) ||
      !isDenseArray(policy.ready, MAX_ENTRIES)) {
    return {ok: false};
  }
  const ready = [];
  for (let i = 0; i < policy.ready.length; i++) {
    const entry = policy.ready[i];
    if (!isPlainRecord(entry, ['id', 'readySince', 'risk'])) return {ok: false};
    ready.push({id: entry.id, readySince: entry.readySince, risk: entry.risk});
  }
  return {
    ok: true,
    policy: {
      now: policy.now,
      agingMs: policy.agingMs,
      riskCeiling: policy.riskCeiling,
      ready
    }
  };
}

export function planUnifiedWorkQueue(input) {
  if (!isPlainRecord(input, ['config', 'shadowInput', 'nowMs'], ['activeLeases', 'policy'])) {
    return denyPlan('INVALID_UNIFIED_PLAN_INPUT');
  }
  if (!nonnegative(input.nowMs)) return denyPlan('INVALID_UNIFIED_PLAN_INPUT');
  if (!validateProjectConfig(input.config)) return denyPlan('INVALID_PROJECT_CONFIG');
  const checkedPolicy = sanitizeSchedulingPolicy(input.policy);
  if (!checkedPolicy.ok) return denyPlan('SCHEDULING_POLICY_UNKNOWN');

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
  if (!isDenseArray(rawLeases, MAX_ENTRIES)) return denyPlan('INVALID_ACTIVE_LEASES');

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
    if (activeReservations.length > 32) return denyPlan('INVALID_ACTIVE_LEASES');
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

  const planned = planLanes(cappedConfig, normalizedTasks, activeReservations, checkedPolicy.policy);
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

async function resolveStoreResponse(raw) {
  if (raw === null || typeof raw !== 'object' || types.isProxy(raw)) return null;
  let resolved = raw;
  if (types.isPromise(raw)) {
    if (Object.getPrototypeOf(raw) !== Promise.prototype || Object.hasOwn(raw, 'then')) {
      return null;
    }
    resolved = await raw;
  }
  if (resolved === null || typeof resolved !== 'object' || types.isProxy(resolved) ||
      Array.isArray(resolved) || Object.getPrototypeOf(resolved) !== Object.prototype ||
      Object.hasOwn(resolved, 'then')) {
    return null;
  }
  return resolved;
}

async function readValidatedSnapshot(refStore) {
  let snapshot;
  try {
    snapshot = await resolveStoreResponse(refStore.readRef(PROTECTED_WORK_QUEUE_REF));
  } catch {
    return {ok: false, reason: 'REF_STORE_UNAVAILABLE'};
  }
  if (snapshot === null || !isOwnEnumerableData(snapshot, 'ok')) {
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

function buildNextState(state, sequence, nextGeneration, entries, recoveryReceipts, archivedTerminal) {
  const next = {
    schemaVersion: 1,
    protocol: state.protocol,
    sequence,
    nextGeneration,
    entries,
    recoveryReceipts
  };
  if (archivedTerminal.length > 0) next.archivedTerminal = archivedTerminal;
  return next;
}

async function executeCasTransition(refStore, maxCasAttempts, transformState) {
  for (let casAttempt = 1; casAttempt <= maxCasAttempts; casAttempt++) {
    const current = await readValidatedSnapshot(refStore);
    if (!current.ok) return denyMutation(current.reason);
    const step = transformState(current.state, current.oid);
    if (step.abort) return step.result;

    let casResult;
    try {
      casResult = await resolveStoreResponse(refStore.compareAndSwapRef({
        ref: PROTECTED_WORK_QUEUE_REF,
        expectedOid: current.oid,
        nextState: step.nextState,
        force: false
      }));
    } catch {
      return denyMutation('REF_STORE_UNAVAILABLE');
    }
    if (casResult === null || !isOwnEnumerableData(casResult, 'ok')) {
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

  // Snapshot all validated candidate fields and config limits BEFORE any async refStore read.
  const refStore = options.refStore;
  const claimNowMs = options.nowMs;
  const maxConcurrentLanes = options.config.limits.maxConcurrentLanes;
  const configMaxAttempts = options.config.limits.maxAttempts;
  const snapCandidate = Object.freeze({
    workId: checked.workId,
    targetType: options.candidate.targetType,
    repository: options.candidate.repository,
    repositoryId: options.candidate.repositoryId,
    issueNumber: checked.issueNumber,
    pullNumber: checked.pullNumber,
    headSha: checked.headSha,
    lane: options.candidate.lane,
    ownedPaths: Object.freeze([...options.candidate.ownedPaths]),
    workerId: options.candidate.workerId,
    runId: options.candidate.runId,
    runAttempt: checked.runAttempt,
    leaseTtlMs: options.candidate.leaseTtlMs,
    maxExecutionMs: checked.maxExecutionMs,
    maxAttempts: checked.maxAttempts,
    traceparent: options.candidate.traceparent,
    lockSha256: options.candidate.lockSha256
  });

  return executeCasTransition(refStore, maxCasAttempts, state => {
    if (state.entries.some(item => claimNowMs < item.claimedAtMs)) {
      return {abort: true, result: denyMutation('CLOCK_SKEW_REJECTED')};
    }
    const archivedList = state.archivedTerminal ?? [];
    const existingIndex = state.entries.findIndex(item => item.workId === snapCandidate.workId);
    const existing = existingIndex >= 0 ? state.entries[existingIndex] : null;
    const effectiveMaxAttempts = existing === null
      ? snapCandidate.maxAttempts
      : Math.min(existing.maxAttempts, snapCandidate.maxAttempts, configMaxAttempts);
    if (existing !== null) {
      if (isLeaseActive(existing, claimNowMs)) return {abort: true, result: denyMutation('DUPLICATE_ACTIVE_CLAIM')};
      if (existing.status === 'completed') return {abort: true, result: denyMutation('WORK_ALREADY_COMPLETED')};
      if (existing.status === 'cancelled') return {abort: true, result: denyMutation('WORK_CANCELLED')};
      const matchesUsedRun = (existing.runId === snapCandidate.runId && existing.runAttempt === snapCandidate.runAttempt) ||
        (existing.priorRuns !== undefined && existing.priorRuns.some(
          prior => prior.runId === snapCandidate.runId && prior.runAttempt === snapCandidate.runAttempt
        ));
      if (matchesUsedRun) {
        return {abort: true, result: denyMutation('DUPLICATE_RUN_ATTEMPT')};
      }
      if (existing.status === 'exhausted' || existing.attempts >= effectiveMaxAttempts) {
        return {abort: true, result: denyMutation('RETRY_CEILING_EXHAUSTED')};
      }
    } else {
      const archived = archivedList.find(item => item.workId === snapCandidate.workId);
      if (archived !== undefined) {
        if (archived.status === 'completed') return {abort: true, result: denyMutation('WORK_ALREADY_COMPLETED')};
        if (archived.status === 'cancelled') return {abort: true, result: denyMutation('WORK_CANCELLED')};
        return {abort: true, result: denyMutation('RETRY_CEILING_EXHAUSTED')};
      }
    }

    let workingEntries = [...state.entries];
    let nextArchived = [...archivedList];

    // Atomically fence any expired leased entries before evaluating capacity and assigning new ownership,
    // preventing in-flight renewals with earlier timestamps from reactivating reassigned lanes/paths,
    // and marking entries whose attempts meet a lowered configMaxAttempts ceiling as 'exhausted' so
    // terminal compaction can archive them rather than stranding a queue slot.
    let nextGenCursor = state.nextGeneration;
    const expiryReceipts = [];
    workingEntries = workingEntries.map(item => {
      if (item.workId !== snapCandidate.workId && item.status === 'leased' && !isLeaseActive(item, claimNowMs)) {
        const fencedGeneration = nextGenCursor++;
        const effectiveLimit = Math.min(item.maxAttempts, configMaxAttempts);
        const boundedMaxAttempts = Math.max(item.attempts, effectiveLimit);
        const fencedOutcome = item.attempts >= effectiveLimit ? 'exhausted' : 'requeued';
        expiryReceipts.push({
          workId: item.workId,
          repositoryId: item.repositoryId,
          targetType: item.targetType,
          runState: 'lease_expired',
          conclusion: null,
          previousRunId: item.runId,
          previousRunAttempt: item.runAttempt,
          previousGeneration: item.generation,
          reclaimedGeneration: fencedGeneration,
          attempts: item.attempts,
          maxAttempts: effectiveLimit,
          outcome: fencedOutcome,
          reclaimedAtMs: claimNowMs
        });
        return copyEntryWith(item, {
          status: fencedOutcome,
          generation: fencedGeneration,
          maxAttempts: boundedMaxAttempts,
          leaseExpiresAtMs: Math.min(item.leaseExpiresAtMs, claimNowMs)
        });
      }
      return item;
    });

    if (existing === null && workingEntries.length >= MAX_ENTRIES) {
      const evictIdx = workingEntries.findIndex(item => TERMINAL_ENTRY_STATUSES.has(item.status));
      if (evictIdx < 0) {
        return {abort: true, result: denyMutation('QUEUE_CAPACITY_EXCEEDED')};
      }
      if (nextArchived.length >= MAX_ARCHIVED_TERMINAL) {
        return {abort: true, result: denyMutation('ARCHIVE_CAPACITY_EXHAUSTED')};
      }
      const [evicted] = workingEntries.splice(evictIdx, 1);
      nextArchived.push({workId: evicted.workId, status: evicted.status});
    }

    const activeEntries = workingEntries.filter(item =>
      item.workId !== snapCandidate.workId && isLeaseActive(item, claimNowMs));
    for (const active of activeEntries) {
      if (snapCandidate.ownedPaths.some(candidatePath =>
          active.ownedPaths.some(activePath => pathsOverlap(candidatePath, activePath)))) {
        return {abort: true, result: denyMutation('OWNED_PATHS_OVERLAP')};
      }
    }
    if (activeEntries.some(active => active.lane === snapCandidate.lane)) {
      return {abort: true, result: denyMutation('LANE_RESERVED')};
    }
    if (activeEntries.length >= maxConcurrentLanes) {
      return {abort: true, result: denyMutation('CAPACITY_FULL')};
    }

    const executionDeadlineMs = claimNowMs + snapCandidate.maxExecutionMs;
    const leaseExpiresAtMs = Math.min(executionDeadlineMs, claimNowMs + snapCandidate.leaseTtlMs);
    const generation = nextGenCursor;
    const attempts = existing === null ? 1 : existing.attempts + 1;

    const nextEntry = {
      workId: snapCandidate.workId,
      targetType: snapCandidate.targetType,
      repository: snapCandidate.repository,
      repositoryId: snapCandidate.repositoryId,
      issueNumber: snapCandidate.issueNumber,
      pullNumber: snapCandidate.pullNumber,
      headSha: snapCandidate.headSha,
      lane: snapCandidate.lane,
      ownedPaths: [...snapCandidate.ownedPaths],
      status: 'leased',
      generation,
      attempts,
      maxAttempts: effectiveMaxAttempts,
      workerId: snapCandidate.workerId,
      runId: snapCandidate.runId,
      runAttempt: snapCandidate.runAttempt,
      claimedAtMs: claimNowMs,
      leaseTtlMs: snapCandidate.leaseTtlMs,
      leaseExpiresAtMs,
      maxExecutionMs: snapCandidate.maxExecutionMs,
      executionDeadlineMs
    };
    if (snapCandidate.traceparent !== undefined) nextEntry.traceparent = snapCandidate.traceparent;
    if (snapCandidate.lockSha256 !== undefined) nextEntry.lockSha256 = snapCandidate.lockSha256;
    if (existing !== null) {
      nextEntry.priorRuns = [
        ...(existing.priorRuns === undefined
          ? []
          : existing.priorRuns.map(prior => ({runId: prior.runId, runAttempt: prior.runAttempt}))),
        {runId: existing.runId, runAttempt: existing.runAttempt}
      ];
    }

    if (existingIndex >= 0) {
      const targetIdx = workingEntries.findIndex(item => item.workId === snapCandidate.workId);
      workingEntries[targetIdx] = nextEntry;
    } else {
      workingEntries.push(nextEntry);
    }

    const mergedReceipts = expiryReceipts.length > 0
      ? [...state.recoveryReceipts, ...expiryReceipts].slice(-MAX_RECEIPTS)
      : [...state.recoveryReceipts];

    return {
      abort: false,
      nextState: buildNextState(
        state,
        state.sequence + 1,
        generation + 1,
        workingEntries,
        mergedReceipts,
        nextArchived
      ),
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
  if (!isPlainRecord(options, required, ['stop', 'force', 'maxCasAttempts', 'config'])) {
    return denyMutation('INVALID_RENEW_OPTIONS');
  }
  if (options.force === true) return denyMutation('FORCE_UPDATE_FORBIDDEN');
  if (options.force !== undefined && options.force !== false) return denyMutation('INVALID_RENEW_OPTIONS');
  if (options.config !== undefined && !validateProjectConfig(options.config)) {
    return denyMutation('INVALID_PROJECT_CONFIG');
  }
  const stopConfigured = options.config !== undefined &&
    (options.config.execution.stop !== false || options.config.execution.enabled !== true);
  if ((options.stop !== undefined && options.stop !== false) || stopConfigured) return denyMutation('STOPPED');
  const maxCasAttempts = resolveCasAttempts(options.maxCasAttempts);
  if (!isValidRefStore(options.refStore) || typeof options.workId !== 'string' || options.workId.length === 0 ||
      !isWorkerId(options.workerId) || !positive(options.generation) ||
      !nonnegative(options.nowMs) || maxCasAttempts === null) {
    return denyMutation('INVALID_RENEW_OPTIONS');
  }
  if (!boundedTtl(options.leaseTtlMs)) return denyMutation('INVALID_LEASE_TTL');

  const refStore = options.refStore;
  const workId = options.workId;
  const workerId = options.workerId;
  const generation = options.generation;
  const leaseTtlMs = options.leaseTtlMs;
  const renewNowMs = options.nowMs;
  const maxConcurrentLanes = options.config !== undefined ? options.config.limits.maxConcurrentLanes : null;

  return executeCasTransition(refStore, maxCasAttempts, state => {
    const index = state.entries.findIndex(item => item.workId === workId);
    if (index < 0) return {abort: true, result: denyMutation('WORK_NOT_FOUND')};
    const entry = state.entries[index];
    if (entry.generation !== generation) return {abort: true, result: denyMutation('STALE_GENERATION')};
    if (entry.status !== 'leased' || entry.workerId !== workerId) {
      return {abort: true, result: denyMutation('LEASE_NOT_HELD')};
    }
    if (renewNowMs < entry.claimedAtMs || state.entries.some(other => renewNowMs < other.claimedAtMs)) {
      return {abort: true, result: denyMutation('CLOCK_SKEW_REJECTED')};
    }
    if (renewNowMs >= entry.executionDeadlineMs) return {abort: true, result: denyMutation('EXECUTION_TTL_EXCEEDED')};
    if (renewNowMs >= entry.leaseExpiresAtMs) return {abort: true, result: denyMutation('LEASE_EXPIRED')};

    const otherActive = state.entries.filter(other => other.workId !== workId && isLeaseActive(other, renewNowMs));
    if (otherActive.some(other => other.lane === entry.lane)) {
      return {abort: true, result: denyMutation('LANE_RESERVED')};
    }
    if (otherActive.some(other => entry.ownedPaths.some(p => other.ownedPaths.some(op => pathsOverlap(p, op))))) {
      return {abort: true, result: denyMutation('OWNED_PATHS_OVERLAP')};
    }
    if (maxConcurrentLanes !== null && otherActive.length + 1 > maxConcurrentLanes) {
      return {abort: true, result: denyMutation('CAPACITY_FULL')};
    }

    const clampedExpiry = Math.min(entry.executionDeadlineMs, renewNowMs + leaseTtlMs);
    const updated = copyEntryWith(entry, {
      leaseTtlMs: Math.min(leaseTtlMs, entry.maxExecutionMs),
      leaseExpiresAtMs: Math.max(entry.leaseExpiresAtMs, clampedExpiry)
    });
    const nextEntries = [...state.entries];
    nextEntries[index] = updated;
    return {
      abort: false,
      nextState: buildNextState(
        state,
        state.sequence + 1,
        state.nextGeneration,
        nextEntries,
        [...state.recoveryReceipts],
        [...(state.archivedTerminal ?? [])]
      ),
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

  const refStore = options.refStore;
  const workId = options.workId;
  const workerId = options.workerId;
  const generation = options.generation;
  const outcome = options.outcome;
  const settleNowMs = options.nowMs;

  return executeCasTransition(refStore, maxCasAttempts, state => {
    const index = state.entries.findIndex(item => item.workId === workId);
    if (index < 0) return {abort: true, result: denyMutation('WORK_NOT_FOUND')};
    const entry = state.entries[index];
    if (entry.generation !== generation) return {abort: true, result: denyMutation('STALE_GENERATION')};
    if (entry.status !== 'leased' || entry.workerId !== workerId) {
      return {abort: true, result: denyMutation('LEASE_NOT_HELD')};
    }
    if (settleNowMs < entry.claimedAtMs) return {abort: true, result: denyMutation('CLOCK_SKEW_REJECTED')};
    if (outcome === 'completed') {
      if (settleNowMs >= entry.executionDeadlineMs) return {abort: true, result: denyMutation('EXECUTION_TTL_EXCEEDED')};
      if (settleNowMs >= entry.leaseExpiresAtMs) return {abort: true, result: denyMutation('LEASE_EXPIRED')};
    }

    const finalStatus = outcome === 'requeued' && entry.attempts >= entry.maxAttempts
      ? 'exhausted'
      : outcome;
    const updated = copyEntryWith(entry, {
      status: finalStatus,
      leaseExpiresAtMs: Math.min(entry.leaseExpiresAtMs, settleNowMs)
    });
    const nextEntries = [...state.entries];
    nextEntries[index] = updated;
    return {
      abort: false,
      nextState: buildNextState(
        state,
        state.sequence + 1,
        state.nextGeneration,
        nextEntries,
        [...state.recoveryReceipts],
        [...(state.archivedTerminal ?? [])]
      ),
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

  const refStore = options.refStore;
  const reconcileNowMs = options.nowMs;
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
    if (obs.runState === 'run_terminal') {
      if (typeof obs.conclusion !== 'string' || !VALID_CONCLUSIONS.has(obs.conclusion)) {
        return denyMutation('INVALID_RECONCILE_INPUT');
      }
    } else if (obs.conclusion !== undefined) {
      return denyMutation('INVALID_RECONCILE_INPUT');
    }
    observationsByWorkId.set(obs.workId, Object.freeze({
      workId: obs.workId,
      runId: obs.runId,
      runAttempt: obs.runAttempt,
      leaseGeneration: obs.leaseGeneration,
      runState: obs.runState,
      conclusion: obs.conclusion ?? null
    }));
  }

  return executeCasTransition(refStore, maxCasAttempts, (state, oid) => {
    let nextGeneration = state.nextGeneration;
    const nextEntries = [];
    const newReceipts = [];
    const skipped = [];

    for (const entry of state.entries) {
      if (reconcileNowMs < entry.claimedAtMs) {
        return {abort: true, result: denyMutation('CLOCK_SKEW_REJECTED')};
      }
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
          const leaseStillActive = isLeaseActive(entry, reconcileNowMs);
          const conclusion = obs.conclusion;
          const terminalSuccess = obs.runState === 'run_terminal' && conclusion === 'success';
          if (leaseStillActive || !terminalSuccess) {
            const reclaimedGeneration = nextGeneration++;
            const outcome = (leaseStillActive && terminalSuccess)
              ? 'completed'
              : (entry.attempts >= retryLimit ? 'exhausted' : 'requeued');
            nextEntries.push(copyEntryWith(entry, {
              maxAttempts: persistedMaxAttempts,
              status: outcome,
              generation: reclaimedGeneration,
              leaseExpiresAtMs: Math.min(entry.leaseExpiresAtMs, reconcileNowMs)
            }));
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
              reclaimedAtMs: reconcileNowMs
            });
            continue;
          }
        }
      }

      if (entry.status === 'leased' &&
          (reconcileNowMs >= entry.leaseExpiresAtMs || reconcileNowMs >= entry.executionDeadlineMs)) {
        const reclaimedGeneration = nextGeneration++;
        const outcome = entry.attempts >= retryLimit ? 'exhausted' : 'requeued';
        nextEntries.push(copyEntryWith(entry, {
          maxAttempts: persistedMaxAttempts,
          status: outcome,
          generation: reclaimedGeneration,
          leaseExpiresAtMs: Math.min(entry.leaseExpiresAtMs, reconcileNowMs)
        }));
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
          reclaimedAtMs: reconcileNowMs
        });
        continue;
      }

      nextEntries.push(copyEntryWith(entry, {}));
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
      nextState: buildNextState(
        state,
        state.sequence + 1,
        nextGeneration,
        nextEntries,
        mergedReceipts,
        [...(state.archivedTerminal ?? [])]
      ),
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

const DUPLICATE_REJECTION_REASONS = new Set([
  'DUPLICATE_ACTIVE_CLAIM',
  'DUPLICATE_RUN_ATTEMPT',
  'WORK_ALREADY_COMPLETED',
  'WORK_CANCELLED',
  'RETRY_CEILING_EXHAUSTED'
]);

const isOptionalBoolean = value => value === undefined || typeof value === 'boolean';

function clonePlainJson(value, depth) {
  if (depth > 12 || types.isProxy(value)) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    if (!isDenseArray(value, MAX_ARCHIVED_TERMINAL)) return undefined;
    const out = [];
    for (let i = 0; i < value.length; i++) {
      const item = clonePlainJson(value[i], depth + 1);
      if (item === undefined) return undefined;
      out.push(item);
    }
    return out;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const keys = Reflect.ownKeys(value);
  const out = {};
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (typeof key !== 'string' || key === '__proto__' || !isOwnEnumerableData(value, key)) {
      return undefined;
    }
    const item = clonePlainJson(value[key], depth + 1);
    if (item === undefined) return undefined;
    out[key] = item;
  }
  return out;
}

function validateSimulationStep(step, prevNowMs) {
  if (step === null || typeof step !== 'object' || Array.isArray(step) ||
      typeof step.kind !== 'string' || !nonnegative(step.nowMs)) {
    return {ok: false, reason: 'INVALID_SIMULATION_SCENARIO'};
  }
  if (step.nowMs < prevNowMs) {
    return {ok: false, reason: 'NON_MONOTONIC_SCENARIO_CLOCK'};
  }
  if (step.kind === 'plan') {
    return isPlainRecord(step, ['kind', 'nowMs', 'shadowInput'], ['policy'])
      ? {ok: true}
      : {ok: false, reason: 'INVALID_SIMULATION_SCENARIO'};
  }
  if (step.kind === 'concurrent_claims') {
    if (!isPlainRecord(step, ['kind', 'nowMs', 'claims'], ['stop', 'force', 'targetRef', 'mainHealthy', 'maxCasAttempts']) ||
        !Array.isArray(step.claims) || step.claims.length < 1 || step.claims.length > 16 ||
        !isOptionalBoolean(step.stop) || !isOptionalBoolean(step.force) || !isOptionalBoolean(step.mainHealthy) ||
        (step.targetRef !== undefined && (typeof step.targetRef !== 'string' || step.targetRef.length === 0)) ||
        resolveCasAttempts(step.maxCasAttempts) === null) {
      return {ok: false, reason: 'INVALID_SIMULATION_SCENARIO'};
    }
    for (let i = 0; i < step.claims.length; i++) {
      const item = step.claims[i];
      if (!isPlainRecord(item, ['candidate'], ['readyAtMs']) ||
          (item.readyAtMs !== undefined && (!nonnegative(item.readyAtMs) || item.readyAtMs > step.nowMs))) {
        return {ok: false, reason: 'INVALID_SIMULATION_SCENARIO'};
      }
    }
    return {ok: true};
  }
  if (step.kind === 'replay_events') {
    if (!isPlainRecord(step, ['kind', 'nowMs', 'events'], ['stop', 'mainHealthy', 'maxCasAttempts']) ||
        !Array.isArray(step.events) || step.events.length < 1 || step.events.length > 32 ||
        !isOptionalBoolean(step.stop) || !isOptionalBoolean(step.mainHealthy) ||
        resolveCasAttempts(step.maxCasAttempts) === null) {
      return {ok: false, reason: 'INVALID_SIMULATION_SCENARIO'};
    }
    for (let i = 0; i < step.events.length; i++) {
      const ev = step.events[i];
      if (!isPlainRecord(ev, ['deliveryId', 'eventSequence', 'candidate'], ['authoritativeHeadSha', 'readyAtMs']) ||
          !isWorkerId(ev.deliveryId) || !positive(ev.eventSequence) ||
          (ev.readyAtMs !== undefined && (!nonnegative(ev.readyAtMs) || ev.readyAtMs > step.nowMs)) ||
          (ev.authoritativeHeadSha !== undefined &&
            (!isHex40(ev.authoritativeHeadSha) || ev.candidate === null ||
             typeof ev.candidate !== 'object' || ev.candidate.targetType !== 'pull_request'))) {
        return {ok: false, reason: 'INVALID_SIMULATION_SCENARIO'};
      }
    }
    return {ok: true};
  }
  if (step.kind === 'worker_action') {
    const validRenew = step.action === 'renew' &&
      isPlainRecord(step, ['kind', 'action', 'workId', 'workerId', 'generation', 'leaseTtlMs', 'nowMs'], ['stop', 'force', 'maxCasAttempts']);
    const validSettle = step.action === 'settle' &&
      isPlainRecord(step, ['kind', 'action', 'workId', 'workerId', 'generation', 'outcome', 'nowMs'], ['stop', 'force', 'maxCasAttempts']);
    if ((!validRenew && !validSettle) || !isOptionalBoolean(step.stop) ||
        !isOptionalBoolean(step.force) || resolveCasAttempts(step.maxCasAttempts) === null) {
      return {ok: false, reason: 'INVALID_SIMULATION_SCENARIO'};
    }
    return {ok: true};
  }
  if (step.kind === 'reconcile_runs') {
    return (isPlainRecord(step, ['kind', 'nowMs', 'observedRuns'], ['stop', 'force', 'maxCasAttempts']) &&
      isOptionalBoolean(step.stop) && isOptionalBoolean(step.force) &&
      resolveCasAttempts(step.maxCasAttempts) !== null)
      ? {ok: true}
      : {ok: false, reason: 'INVALID_SIMULATION_SCENARIO'};
  }
  if (step.kind === 'runner_restart') {
    return (isPlainRecord(step, ['kind', 'nowMs'], ['stop']) && isOptionalBoolean(step.stop))
      ? {ok: true}
      : {ok: false, reason: 'INVALID_SIMULATION_SCENARIO'};
  }
  if (step.kind === 'emergency_stop') {
    return (isPlainRecord(step, ['kind', 'nowMs', 'stop']) && typeof step.stop === 'boolean')
      ? {ok: true}
      : {ok: false, reason: 'INVALID_SIMULATION_SCENARIO'};
  }
  return {ok: false, reason: 'INVALID_SIMULATION_SCENARIO'};
}

export async function simulateDurableCasLifecycle(scenario) {
  const cloned = clonePlainJson(scenario, 0);
  if (cloned === undefined || !isPlainRecord(cloned, ['config', 'steps'], ['initialState'])) {
    return denyMutation('INVALID_SIMULATION_SCENARIO');
  }
  if (!validateProjectConfig(cloned.config)) {
    return denyMutation('INVALID_PROJECT_CONFIG');
  }
  let seededState = null;
  if (cloned.initialState !== undefined && cloned.initialState !== null) {
    seededState = freezeValidatedState(cloned.initialState);
    if (seededState === null) return denyMutation('INVALID_QUEUE_STATE');
  }
  if (!Array.isArray(cloned.steps) || cloned.steps.length === 0 || cloned.steps.length > 128) {
    return denyMutation('INVALID_SIMULATION_SCENARIO');
  }
  let prevNowMs = 0;
  if (seededState !== null) {
    for (const entry of seededState.entries) {
      if (entry.claimedAtMs > prevNowMs) prevNowMs = entry.claimedAtMs;
    }
    for (const receipt of seededState.recoveryReceipts) {
      if (receipt.reclaimedAtMs > prevNowMs) prevNowMs = receipt.reclaimedAtMs;
    }
  }
  for (let i = 0; i < cloned.steps.length; i++) {
    const stepCheck = validateSimulationStep(cloned.steps[i], prevNowMs);
    if (!stepCheck.ok) return denyMutation(stepCheck.reason);
    prevNowMs = cloned.steps[i].nowMs;
  }

  const baseConfig = cloned.config;
  const configStopped = baseConfig.execution.stop !== false || baseConfig.execution.enabled !== true;
  let runtimeStop = false;
  const isStopped = stepStop => configStopped || runtimeStop || stepStop === true;
  let backingStore = createSeededWorkQueueRefStore(seededState, null);
  let runnerEpoch = 1;
  const seenDeliveries = new Map();
  const latestSequenceByTarget = new Map();

  let casReads = 0;
  let forceRejected = 0;
  let claimsGranted = 0;
  let duplicateClaimsRejected = 0;
  let staleHeadRejected = 0;
  let outOfOrderRejected = 0;
  let deliveryConflictsRejected = 0;
  let staleWorkerRejections = 0;
  let staleRunObservationsSkipped = 0;
  let stopBlocks = 0;
  let mainUnhealthyBlocks = 0;
  let occupiedDurationMs = 0;
  const readyLatenciesMs = [];
  const casCounters = {
    CAS_APPLIED: 0,
    CAS_CONFLICT: 0,
    FORCE_UPDATE_FORBIDDEN: 0,
    UNPROTECTED_WORK_QUEUE_REF: 0
  };
  const reclaimedCounts = {
    launch_failed: 0,
    worker_terminated: 0,
    run_terminal: 0,
    run_missing: 0,
    lease_expired: 0
  };
  let lastCountedReceiptGen = 0;
  if (seededState !== null) {
    for (const receipt of seededState.recoveryReceipts) {
      if (receipt.reclaimedGeneration > lastCountedReceiptGen) {
        lastCountedReceiptGen = receipt.reclaimedGeneration;
      }
    }
  }

  const instrumentedStore = Object.freeze({
    readRef(ref) {
      casReads += 1;
      return backingStore.readRef(ref);
    },
    compareAndSwapRef(req) {
      const res = backingStore.compareAndSwapRef(req);
      casCounters[res.reason] += 1;
      return res;
    }
  });

  function buildStepConfig(stepStop) {
    return {
      ...baseConfig,
      execution: {
        ...baseConfig.execution,
        stop: stepStop
      }
    };
  }

  function currentRawEntries() {
    const snap = backingStore.readRef(PROTECTED_WORK_QUEUE_REF);
    return snap.state === null ? [] : snap.state.entries;
  }

  function recordStateAdvance(beforeEntries, nowMs) {
    const afterSnap = backingStore.readRef(PROTECTED_WORK_QUEUE_REF);
    const afterState = afterSnap.state;
    const afterEntries = afterState === null ? [] : afterState.entries;
    const afterByWorkId = new Map(afterEntries.map(entry => [entry.workId, entry]));
    for (const prev of beforeEntries) {
      if (prev.status !== 'leased') continue;
      const curr = afterByWorkId.get(prev.workId);
      if (curr === undefined || curr.status !== 'leased' || curr.generation !== prev.generation) {
        const effectiveEndMs = Math.min(nowMs, prev.leaseExpiresAtMs, prev.executionDeadlineMs);
        occupiedDurationMs += Math.max(0, effectiveEndMs - prev.claimedAtMs);
      }
    }
    if (afterState !== null) {
      for (const receipt of afterState.recoveryReceipts) {
        if (receipt.reclaimedGeneration > lastCountedReceiptGen) {
          reclaimedCounts[receipt.runState] += 1;
          lastCountedReceiptGen = receipt.reclaimedGeneration;
        }
      }
    }
    return afterSnap;
  }

  const stepResults = [];
  for (let index = 0; index < cloned.steps.length; index++) {
    const step = cloned.steps[index];
    if (step.kind === 'emergency_stop') {
      runtimeStop = step.stop;
      const effectiveStop = isStopped(false);
      const snap = backingStore.readRef(PROTECTED_WORK_QUEUE_REF);
      stepResults.push(Object.freeze({
        index,
        kind: 'emergency_stop',
        runnerEpoch,
        nowMs: step.nowMs,
        stop: effectiveStop,
        reason: effectiveStop ? 'EMERGENCY_STOP_ENGAGED' : 'EMERGENCY_STOP_CLEARED',
        oid: snap.oid
      }));
      continue;
    }

    if (step.kind === 'runner_restart') {
      if (step.stop !== undefined) runtimeStop = step.stop;
      const persisted = backingStore.readRef(PROTECTED_WORK_QUEUE_REF);
      seenDeliveries.clear();
      latestSequenceByTarget.clear();
      const rehydrated = persisted.state === null
        ? null
        : JSON.parse(JSON.stringify(persisted.state));
      backingStore = createSeededWorkQueueRefStore(
        rehydrated,
        persisted.state === null ? null : persisted.oid
      );
      runnerEpoch += 1;
      const afterRestart = backingStore.readRef(PROTECTED_WORK_QUEUE_REF);
      stepResults.push(Object.freeze({
        index,
        kind: 'runner_restart',
        runnerEpoch,
        nowMs: step.nowMs,
        reason: 'RUNNER_RESTARTED',
        oid: afterRestart.oid,
        preservedEntries: afterRestart.state === null ? 0 : afterRestart.state.entries.length
      }));
      continue;
    }

    if (step.kind === 'plan') {
      const snap = instrumentedStore.readRef(PROTECTED_WORK_QUEUE_REF);
      const activeLeases = snap.state === null ? [] : snap.state.entries;
      const planOptions = {
        config: buildStepConfig(isStopped(false)),
        shadowInput: step.shadowInput,
        activeLeases,
        nowMs: step.nowMs
      };
      if (step.policy !== undefined) planOptions.policy = step.policy;
      const planned = planUnifiedWorkQueue(planOptions);
      if (planned.reason === 'STOPPED') stopBlocks += 1;
      let maxBlockedWaitMs = 0;
      if (step.policy !== undefined && planned.blockedTasks !== undefined && Array.isArray(step.policy.ready)) {
        const readySinceMap = new Map(step.policy.ready.map(item => [item.id, item.readySince]));
        for (const blocked of planned.blockedTasks) {
          const readySince = readySinceMap.get(blocked.id);
          if (typeof readySince === 'number' && readySince <= step.nowMs) {
            maxBlockedWaitMs = Math.max(maxBlockedWaitMs, step.nowMs - readySince);
          }
        }
      }
      stepResults.push(Object.freeze({
        index,
        kind: 'plan',
        runnerEpoch,
        nowMs: step.nowMs,
        reason: planned.reason,
        readyIds: planned.readyIds ?? Object.freeze([]),
        blockedCount: planned.blockedTasks === undefined ? 0 : planned.blockedTasks.length,
        maxBlockedWaitMs,
        oid: snap.oid
      }));
      continue;
    }

    if (step.kind === 'concurrent_claims') {
      const beforeSnap = backingStore.readRef(PROTECTED_WORK_QUEUE_REF);
      const beforeEntries = beforeSnap.state === null ? [] : beforeSnap.state.entries;
      const stepStop = isStopped(step.stop);
      const stepConfig = buildStepConfig(stepStop);
      const maxCasAttempts = step.maxCasAttempts ?? 5;
      let outcomes;

      if (step.targetRef !== undefined && step.targetRef !== PROTECTED_WORK_QUEUE_REF) {
        const refRes = instrumentedStore.compareAndSwapRef({
          ref: step.targetRef,
          expectedOid: beforeSnap.oid,
          nextState: beforeSnap.state === null ? createEmptyQueueState() : beforeSnap.state,
          force: step.force === true
        });
        outcomes = step.claims.map(item => Object.freeze({
          ok: false,
          reason: refRes.reason,
          workerId: typeof item.candidate?.workerId === 'string' ? item.candidate.workerId : null
        }));
      } else if (step.mainHealthy === false && step.force !== true && !stepStop) {
        mainUnhealthyBlocks += step.claims.length;
        outcomes = step.claims.map(item => Object.freeze({
          ok: false,
          reason: 'MAIN_UNHEALTHY',
          workerId: typeof item.candidate?.workerId === 'string' ? item.candidate.workerId : null
        }));
      } else {
        const readersCount = (stepStop || step.force === true)
          ? 0
          : step.claims.filter(item => validateCandidate(item.candidate, stepConfig, step.nowMs).ok).length;
        let pendingInitialReads = readersCount;
        let releaseBarrier;
        const barrierPromise = new Promise(resolve => {
          releaseBarrier = resolve;
        });

        outcomes = await Promise.all(step.claims.map(async item => {
          let firstRead = readersCount >= 2;
          const workerStore = Object.freeze({
            async readRef(ref) {
              const snap = instrumentedStore.readRef(ref);
              if (firstRead) {
                firstRead = false;
                pendingInitialReads -= 1;
                if (pendingInitialReads === 0) releaseBarrier();
                await barrierPromise;
              }
              return snap;
            },
            compareAndSwapRef(req) {
              return instrumentedStore.compareAndSwapRef(req);
            }
          });

          const claimOpts = {
            refStore: workerStore,
            config: stepConfig,
            candidate: item.candidate,
            nowMs: step.nowMs,
            maxCasAttempts
          };
          if (step.stop !== undefined) claimOpts.stop = step.stop;
          if (step.force !== undefined) claimOpts.force = step.force;
          const res = await claimWorkQueueLease(claimOpts);
          if (res.ok) {
            claimsGranted += 1;
            if (item.readyAtMs !== undefined) readyLatenciesMs.push(step.nowMs - item.readyAtMs);
            return Object.freeze({
              ok: true,
              reason: res.reason,
              workId: res.lease.workId,
              workerId: res.lease.workerId,
              generation: res.lease.generation,
              casAttempts: res.casAttempts
            });
          }
          if (res.reason === 'STOPPED') stopBlocks += 1;
          else if (res.reason === 'FORCE_UPDATE_FORBIDDEN') forceRejected += 1;
          else if (DUPLICATE_REJECTION_REASONS.has(res.reason)) duplicateClaimsRejected += 1;
          return Object.freeze({
            ok: false,
            reason: res.reason,
            workerId: typeof item.candidate?.workerId === 'string' ? item.candidate.workerId : null
          });
        }));
      }

      const afterSnap = recordStateAdvance(beforeEntries, step.nowMs);
      stepResults.push(Object.freeze({
        index,
        kind: 'concurrent_claims',
        runnerEpoch,
        nowMs: step.nowMs,
        outcomes: Object.freeze(outcomes),
        oid: afterSnap.oid
      }));
      continue;
    }

    if (step.kind === 'replay_events') {
      const beforeEntries = currentRawEntries();
      const stepStop = isStopped(step.stop);
      const stepConfig = buildStepConfig(stepStop);
      const maxCasAttempts = step.maxCasAttempts ?? 3;
      const outcomes = [];

      for (const ev of step.events) {
        if (stepStop) {
          stopBlocks += 1;
          outcomes.push(Object.freeze({deliveryId: ev.deliveryId, ok: false, reason: 'STOPPED'}));
          continue;
        }
        if (step.mainHealthy === false) {
          mainUnhealthyBlocks += 1;
          outcomes.push(Object.freeze({deliveryId: ev.deliveryId, ok: false, reason: 'MAIN_UNHEALTHY'}));
          continue;
        }
        const checked = validateCandidate(ev.candidate, stepConfig, step.nowMs);
        if (!checked.ok) {
          outcomes.push(Object.freeze({deliveryId: ev.deliveryId, ok: false, reason: checked.reason}));
          continue;
        }
        const deliveryKey = `${ev.candidate.repositoryId}:${ev.deliveryId}`;
        const deliveryFingerprint = JSON.stringify([
          checked.workId,
          ev.eventSequence,
          ev.candidate.lane,
          ev.candidate.ownedPaths,
          ev.candidate.workerId,
          ev.candidate.runId,
          checked.runAttempt,
          ev.candidate.leaseTtlMs,
          checked.maxExecutionMs,
          checked.maxAttempts,
          ev.candidate.traceparent ?? null,
          ev.candidate.lockSha256 ?? null,
          ev.authoritativeHeadSha ?? null,
          ev.readyAtMs ?? null
        ]);
        const previousDelivery = seenDeliveries.get(deliveryKey);
        if (previousDelivery !== undefined && previousDelivery.fingerprint !== deliveryFingerprint) {
          deliveryConflictsRejected += 1;
          outcomes.push(Object.freeze({
            deliveryId: ev.deliveryId,
            workId: checked.workId,
            ok: false,
            reason: 'DELIVERY_CONFLICT'
          }));
          continue;
        }
        if (previousDelivery !== undefined && previousDelivery.consumed) {
          duplicateClaimsRejected += 1;
          outcomes.push(Object.freeze({
            deliveryId: ev.deliveryId,
            workId: checked.workId,
            ok: false,
            reason: 'DUPLICATE_DELIVERY'
          }));
          continue;
        }
        seenDeliveries.set(deliveryKey, {fingerprint: deliveryFingerprint, consumed: false});
        if (ev.authoritativeHeadSha !== undefined && ev.candidate.headSha !== ev.authoritativeHeadSha) {
          seenDeliveries.set(deliveryKey, {fingerprint: deliveryFingerprint, consumed: true});
          staleHeadRejected += 1;
          outcomes.push(Object.freeze({
            deliveryId: ev.deliveryId,
            workId: checked.workId,
            ok: false,
            reason: 'STALE_HEAD_SUPERSEDED'
          }));
          continue;
        }
        const targetKey = ev.candidate.targetType === 'issue'
          ? `${ev.candidate.repositoryId}:issue:${ev.candidate.issueNumber}`
          : `${ev.candidate.repositoryId}:pr:${ev.candidate.pullNumber}`;
        const prevSeq = latestSequenceByTarget.get(targetKey);
        if (prevSeq !== undefined && ev.eventSequence < prevSeq) {
          seenDeliveries.set(deliveryKey, {fingerprint: deliveryFingerprint, consumed: true});
          outOfOrderRejected += 1;
          outcomes.push(Object.freeze({
            deliveryId: ev.deliveryId,
            workId: checked.workId,
            ok: false,
            reason: 'OUT_OF_ORDER_EVENT'
          }));
          continue;
        }
        latestSequenceByTarget.set(targetKey, ev.eventSequence);

        const claimRes = await claimWorkQueueLease({
          refStore: instrumentedStore,
          config: stepConfig,
          candidate: ev.candidate,
          nowMs: step.nowMs,
          maxCasAttempts
        });
        if (claimRes.ok) {
          seenDeliveries.set(deliveryKey, {fingerprint: deliveryFingerprint, consumed: true});
          claimsGranted += 1;
          if (ev.readyAtMs !== undefined) readyLatenciesMs.push(step.nowMs - ev.readyAtMs);
          outcomes.push(Object.freeze({
            deliveryId: ev.deliveryId,
            workId: claimRes.lease.workId,
            ok: true,
            reason: claimRes.reason,
            generation: claimRes.lease.generation
          }));
        } else {
          if (DUPLICATE_REJECTION_REASONS.has(claimRes.reason)) {
            seenDeliveries.set(deliveryKey, {fingerprint: deliveryFingerprint, consumed: true});
            duplicateClaimsRejected += 1;
          }
          outcomes.push(Object.freeze({
            deliveryId: ev.deliveryId,
            workId: checked.workId,
            ok: false,
            reason: claimRes.reason
          }));
        }
      }

      const afterSnap = recordStateAdvance(beforeEntries, step.nowMs);
      stepResults.push(Object.freeze({
        index,
        kind: 'replay_events',
        runnerEpoch,
        nowMs: step.nowMs,
        outcomes: Object.freeze(outcomes),
        oid: afterSnap.oid
      }));
      continue;
    }

    if (step.kind === 'worker_action') {
      const beforeEntries = currentRawEntries();
      const stepStop = isStopped(step.stop);
      let res;
      if (step.action === 'renew') {
        const renewOpts = {
          refStore: instrumentedStore,
          config: buildStepConfig(stepStop),
          workId: step.workId,
          workerId: step.workerId,
          generation: step.generation,
          leaseTtlMs: step.leaseTtlMs,
          nowMs: step.nowMs
        };
        if (step.stop !== undefined) renewOpts.stop = step.stop;
        if (step.force !== undefined) renewOpts.force = step.force;
        if (step.maxCasAttempts !== undefined) renewOpts.maxCasAttempts = step.maxCasAttempts;
        res = await renewWorkQueueLease(renewOpts);
      } else {
        const settleOpts = {
          refStore: instrumentedStore,
          workId: step.workId,
          workerId: step.workerId,
          generation: step.generation,
          outcome: step.outcome,
          nowMs: step.nowMs,
          stop: stepStop
        };
        if (step.force !== undefined) settleOpts.force = step.force;
        if (step.maxCasAttempts !== undefined) settleOpts.maxCasAttempts = step.maxCasAttempts;
        res = await settleWorkQueueLease(settleOpts);
      }
      if (res.reason === 'STOPPED') stopBlocks += 1;
      else if (res.reason === 'FORCE_UPDATE_FORBIDDEN') forceRejected += 1;
      else if (res.reason === 'STALE_GENERATION' || res.reason === 'LEASE_NOT_HELD') staleWorkerRejections += 1;

      const afterSnap = recordStateAdvance(beforeEntries, step.nowMs);
      stepResults.push(Object.freeze({
        index,
        kind: 'worker_action',
        action: step.action,
        runnerEpoch,
        nowMs: step.nowMs,
        ok: res.ok,
        reason: res.reason,
        lease: res.lease ?? null,
        oid: afterSnap.oid
      }));
      continue;
    }

    // step.kind === 'reconcile_runs'
    const beforeEntries = currentRawEntries();
    const stepStop = isStopped(step.stop);
    const reconcileOpts = {
      refStore: instrumentedStore,
      config: buildStepConfig(stepStop),
      observedRuns: step.observedRuns,
      nowMs: step.nowMs
    };
    if (step.stop !== undefined) reconcileOpts.stop = step.stop;
    if (step.force !== undefined) reconcileOpts.force = step.force;
    if (step.maxCasAttempts !== undefined) reconcileOpts.maxCasAttempts = step.maxCasAttempts;
    const recRes = await reconcileWorkQueueRunStates(reconcileOpts);
    if (recRes.reason === 'STOPPED') stopBlocks += 1;
    else if (recRes.reason === 'FORCE_UPDATE_FORBIDDEN') forceRejected += 1;
    if (recRes.skipped !== undefined) {
      for (const skippedItem of recRes.skipped) {
        if (skippedItem.reason === 'STALE_OR_INACTIVE_RUN') staleRunObservationsSkipped += 1;
      }
    }

    const afterSnap = recordStateAdvance(beforeEntries, step.nowMs);
    stepResults.push(Object.freeze({
      index,
      kind: 'reconcile_runs',
      runnerEpoch,
      nowMs: step.nowMs,
      ok: recRes.ok,
      reason: recRes.reason,
      reclaimed: recRes.reclaimed ?? Object.freeze([]),
      receiptCount: recRes.receipts === undefined ? 0 : recRes.receipts.length,
      oid: afterSnap.oid
    }));
  }

  const finalSnap = backingStore.readRef(PROTECTED_WORK_QUEUE_REF);
  const finalState = finalSnap.state === null ? createEmptyQueueState() : finalSnap.state;
  for (const entry of finalState.entries) {
    if (entry.status === 'leased') {
      const effectiveEndMs = Math.min(prevNowMs, entry.leaseExpiresAtMs, entry.executionDeadlineMs);
      occupiedDurationMs += Math.max(0, effectiveEndMs - entry.claimedAtMs);
    }
  }

  readyLatenciesMs.sort((a, b) => a - b);
  const sampleCount = readyLatenciesMs.length;
  const p50ReadyLatencyMs = sampleCount === 0 ? null : readyLatenciesMs[Math.ceil(sampleCount * 0.5) - 1];
  const p95ReadyLatencyMs = sampleCount === 0 ? null : readyLatenciesMs[Math.ceil(sampleCount * 0.95) - 1];

  return Object.freeze({
    shadow: true,
    ok: true,
    liveDispatch: false,
    liveMerge: false,
    reason: 'LIFECYCLE_VERIFIED',
    ref: PROTECTED_WORK_QUEUE_REF,
    finalOid: finalSnap.oid,
    finalState,
    runnerEpochs: runnerEpoch,
    steps: Object.freeze(stepResults),
    metrics: Object.freeze({
      casReads,
      casApplied: casCounters.CAS_APPLIED,
      casConflicts: casCounters.CAS_CONFLICT,
      forceRejected: forceRejected + casCounters.FORCE_UPDATE_FORBIDDEN,
      unprotectedRefRejected: casCounters.UNPROTECTED_WORK_QUEUE_REF,
      claimsGranted,
      duplicateClaimsRejected,
      staleHeadRejected,
      outOfOrderRejected,
      deliveryConflictsRejected,
      staleWorkerRejections,
      staleRunObservationsSkipped,
      stopBlocks,
      mainUnhealthyBlocks,
      reclaimedByRunState: Object.freeze({...reclaimedCounts}),
      occupiedDurationMs,
      readySampleCount: sampleCount,
      p50ReadyLatencyMs,
      p95ReadyLatencyMs
    })
  });
}
