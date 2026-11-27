import {types} from 'node:util';

const plain = x => x !== null && typeof x === 'object' && !types.isProxy(x) && !Array.isArray(x);
const prop = (x, k) => Object.getOwnPropertyDescriptor(x, k)?.value;
const own = (x, keys) => plain(x) &&
  keys.every(k => Object.hasOwn(Object.getOwnPropertyDescriptor(x, k) ?? {}, 'value'));
const nonneg = n => Number.isSafeInteger(n) && n >= 0;
const positive = n => nonneg(n) && n > 0;

// Enforceable zero-overage hard-stop receipt validation. Metadata only; no billing credentials.
export function verifyHardStopReceipt(receipt, nowMs) {
  const out = (valid, reason, receiptId) => Object.freeze(receiptId ?
    {shadow: true, liveDispatch: false, valid, reason, receiptId} :
    {shadow: true, liveDispatch: false, valid, reason});
  if (!own(receipt, ['receiptId', 'provider', 'includedOnly', 'overageDisabled',
    'hardStopEnforced', 'paidUsageMicros', 'observedMs']) ||
    typeof receipt.receiptId !== 'string' || !/^[a-zA-Z0-9._:-]{1,120}$/.test(receipt.receiptId) ||
    typeof receipt.provider !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(receipt.provider))
    return out(false, 'HARD_STOP_UNVERIFIED');
  if (receipt.overageDisabled !== true) return out(false, 'OVERAGE_ENABLED');
  if (receipt.includedOnly !== true || receipt.hardStopEnforced !== true)
    return out(false, 'HARD_STOP_UNVERIFIED');
  if (receipt.paidUsageMicros !== 0) return out(false, 'PAID_USAGE_NONZERO');
  if (!nonneg(nowMs) || !nonneg(receipt.observedMs) ||
      nowMs < receipt.observedMs || nowMs - receipt.observedMs > 60000)
    return out(false, 'STALE_HARD_STOP_RECEIPT');
  return out(true, 'HARD_STOP_VERIFIED', receipt.receiptId);
}

// Pure advisory evaluation; never an authorization or provider reservation.
export function budgetDecision(e) {
  const result = (reason, available = 0) => ({shadow: true, liveDispatch: false, reason, available});
  if (!plain(e) || prop(e, 'stop') !== false) return result('STOPPED');
  if (Object.hasOwn(e, 'environmentVerified') && prop(e, 'environmentVerified') !== true)
    return result('ENVIRONMENT_UNVERIFIED');
  if (prop(e, 'includedOnly') !== true || prop(e, 'overageDisabled') !== true || prop(e, 'authorityVerified') !== true)
    return result('BUDGET_UNKNOWN');
  const nowMs = prop(e, 'nowMs'), observedMs = prop(e, 'observedMs');
  if (!nonneg(nowMs) || !nonneg(observedMs) || nowMs < observedMs || nowMs - observedMs > 60000)
    return result('STALE_QUOTA');
  if (Object.hasOwn(e, 'hardStopReceipt')) {
    const check = verifyHardStopReceipt(prop(e, 'hardStopReceipt'), nowMs);
    if (!check.valid) return result(check.reason);
  }
  const remaining = prop(e, 'remaining'), reserved = prop(e, 'reserved'),
    active = prop(e, 'active'), maxActive = prop(e, 'maxActive'), unitsPerRun = prop(e, 'unitsPerRun');
  if (![remaining, reserved, active, maxActive, unitsPerRun].every(nonneg) ||
      unitsPerRun === 0 || maxActive === 0 || active > maxActive || reserved > remaining)
    return result('INVALID_QUOTA');
  const available = Math.min(maxActive - active, Math.floor((remaining - reserved) / unitsPerRun));
  return result(available ? 'SHADOW_CAPACITY' : 'CAPACITY_EXHAUSTED', available);
}

// Synthetic allocation only. Inputs are normalized fixtures, not billing credentials.
// Candidate order is supplied by the dependency-aware planner.
export function allocateShadowCapacity(e, scopes, candidates) {
  const denied = reason => ({shadow: true, liveDispatch: false, reason, selected: []});
  const decision = budgetDecision(e);
  if (decision.reason !== 'SHADOW_CAPACITY') return denied(decision.reason);
  const dense = a => !types.isProxy(a) && Array.isArray(a) && a.length <= 250 &&
    Array.from({length: a.length}, (_, i) => Object.hasOwn(Object.getOwnPropertyDescriptor(a, i) ?? {}, 'value')).every(Boolean);
  if (!dense(scopes) || !dense(candidates) || !scopes.length) return denied('SCOPE_UNKNOWN');
  const caps = new Map();
  // Subtract rather than sum: each count is safe, but an aggregate could overflow.
  let unaccountedActive = prop(e, 'active');
  for (const scope of scopes) {
    if (!own(scope, ['repositoryId', 'maxActive', 'active']) ||
        !positive(scope.repositoryId) || !positive(scope.maxActive) ||
        !nonneg(scope.active) || scope.active > scope.maxActive ||
        caps.has(scope.repositoryId)) return denied('SCOPE_UNKNOWN');
    if (scope.active > unaccountedActive) return denied('SCOPE_UNKNOWN');
    unaccountedActive -= scope.active;
    caps.set(scope.repositoryId, scope.maxActive - scope.active);
  }
  const seen = new Set();
  for (const c of candidates) {
    if (!own(c, ['repositoryId', 'issue', 'head']) || !caps.has(c.repositoryId) || !positive(c.issue) ||
        typeof c.head !== 'string' || !/^[a-f0-9]{40}$/.test(c.head)) return denied('CANDIDATE_UNKNOWN');
    const key = [c.repositoryId, c.issue].join(':');
    if (seen.has(key)) return denied('DUPLICATE_CANDIDATE');
    seen.add(key);
  }
  const selected = [];
  for (const c of candidates) {
    if (selected.length === decision.available) break;
    const left = caps.get(c.repositoryId);
    if (left === 0) continue;
    selected.push({repositoryId: c.repositoryId, issue: c.issue, head: c.head});
    caps.set(c.repositoryId, left - 1);
  }
  return {shadow: true, liveDispatch: false, reason: selected.length ? 'SHADOW_ALLOCATION' : 'NO_SCOPED_CAPACITY', selected};
}
