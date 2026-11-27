import {types} from 'node:util';
import {verifyHardStopReceipt} from './budget.mjs';

const ladder = [1, 2, 4, 8, 10, 12];
const maxExecutionTtlMs = 3600000;
const pos = x => Number.isSafeInteger(x) && x > 0;
const sha = x => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);
const envSlug = x => typeof x === 'string' && /^[a-z0-9][a-z0-9_-]{1,63}$/.test(x);
const hasVal = (x, k) => Object.hasOwn(Object.getOwnPropertyDescriptor(x, k) ?? {}, 'value');
const own = (x, k) => x !== null && typeof x === 'object' && !types.isProxy(x) &&
  !Array.isArray(x) && k.every(p => hasVal(x, p));
const deny = reason => ({shadow: true, liveDispatch: false, reason});
const baseFields = ['repositoryId', 'approvedRepositoryId', 'issue', 'head', 'generation',
  'approved', 'stop', 'includedOnly', 'overageDisabled', 'capacity', 'leaseVerified', 'alreadyDispatched'];

export function dispatchIntent(e) {
  if (!own(e, baseFields)) return deny('EVIDENCE_UNKNOWN');
  for (const opt of ['environmentVerified', 'hardStopReceipt', 'nowMs', 'executionTtlMs']) {
    if (Object.hasOwn(e, opt) && !hasVal(e, opt)) return deny('EVIDENCE_UNKNOWN');
  }
  if (e.stop !== false) return deny('STOPPED');
  if (!pos(e.repositoryId) || e.repositoryId !== e.approvedRepositoryId || !pos(e.issue) ||
      !sha(e.head) || !pos(e.generation) || e.approved !== true || e.leaseVerified !== true)
    return deny('SCOPE_OR_LEASE_UNKNOWN');
  if (Object.hasOwn(e, 'environmentVerified') && e.environmentVerified !== true)
    return deny('ENVIRONMENT_UNVERIFIED');
  if (e.includedOnly !== true || e.overageDisabled !== true || !pos(e.capacity))
    return deny('BUDGET_OR_CAPACITY_UNKNOWN');
  if (Object.hasOwn(e, 'hardStopReceipt')) {
    const receipt = verifyHardStopReceipt(e.hardStopReceipt, e.nowMs);
    if (!receipt.valid) return deny(receipt.reason);
  }
  if (Object.hasOwn(e, 'executionTtlMs') && (!pos(e.executionTtlMs) || e.executionTtlMs > maxExecutionTtlMs))
    return deny('EXECUTION_TTL_INVALID');
  if (e.alreadyDispatched !== false) return deny('DUPLICATE_OR_UNKNOWN');
  return {...deny('DRY_RUN_ONLY'), key: [e.repositoryId, e.issue, e.head, e.generation].join(':'),
    repositoryId: e.repositoryId, issue: e.issue};
}

// GitHub-hosted worker dry-run intent requiring verified environment, isolation,
// bounded execution TTL, worker ladder compliance, and a zero-overage hard-stop receipt.
export function hostedWorkerDispatchIntent(e) {
  if (!own(e, [...baseFields, 'environmentVerified', 'protectedEnvironment', 'isolatedWorktree',
    'hardStopReceipt', 'nowMs', 'executionTtlMs', 'requestedWorkers'])) return deny('EVIDENCE_UNKNOWN');
  if (e.stop !== false) return deny('STOPPED');
  if (!pos(e.repositoryId) || e.repositoryId !== e.approvedRepositoryId || !pos(e.issue) ||
      !sha(e.head) || !pos(e.generation) || e.approved !== true || e.leaseVerified !== true)
    return deny('SCOPE_OR_LEASE_UNKNOWN');
  if (e.environmentVerified !== true || !envSlug(e.protectedEnvironment) || e.isolatedWorktree !== true)
    return deny('ENVIRONMENT_UNVERIFIED');
  if (e.overageDisabled === false) return deny('OVERAGE_ENABLED');
  if (e.includedOnly !== true || e.overageDisabled !== true || !pos(e.capacity))
    return deny('BUDGET_OR_CAPACITY_UNKNOWN');
  const receipt = verifyHardStopReceipt(e.hardStopReceipt, e.nowMs);
  if (!receipt.valid) return deny(receipt.reason);
  if (!ladder.includes(e.requestedWorkers) || e.requestedWorkers > e.capacity)
    return deny('WORKER_LADDER_VIOLATION');
  if (!pos(e.executionTtlMs) || e.executionTtlMs > maxExecutionTtlMs)
    return deny('EXECUTION_TTL_INVALID');
  if (e.alreadyDispatched !== false) return deny('DUPLICATE_OR_UNKNOWN');
  return {...deny('DRY_RUN_ONLY'), key: [e.repositoryId, e.issue, e.head, e.generation].join(':'),
    repositoryId: e.repositoryId, issue: e.issue, protectedEnvironment: e.protectedEnvironment,
    requestedWorkers: e.requestedWorkers, executionTtlMs: e.executionTtlMs, receiptId: receipt.receiptId};
}
