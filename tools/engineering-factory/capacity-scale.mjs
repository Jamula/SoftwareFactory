import {types} from 'node:util';
import {budgetDecision, verifyHardStopReceipt} from './budget.mjs';

// Advisory only: an independently verified provider ceiling is not authorization.
// No reservation, dispatch or configuration mutation is performed.
export const WORKER_LADDER = Object.freeze([1, 2, 4, 8, 10, 12]);
export const WORKER_GOAL = Object.freeze({min: 10, max: 12});

const plain = x => x !== null && typeof x === 'object' && !types.isProxy(x) && !Array.isArray(x);
const prop = (x, k) => Object.getOwnPropertyDescriptor(x, k)?.value;
const nonnegative = n => Number.isSafeInteger(n) && n >= 0;
const positive = n => nonnegative(n) && n > 0;
const envSlug = s => typeof s === 'string' && /^[a-z0-9][a-z0-9_-]{1,63}$/.test(s);
const result = (reason, nextLimit = null) => ({shadow: true, liveDispatch: false, reason, nextLimit});

function hasObservedPeak(e, currentLimit) {
  const observedPeak = prop(e, 'observedPeak');
  return nonnegative(observedPeak) && observedPeak === currentLimit;
}

function validateConcurrencyGates(e, budgetInput, activeCount) {
  const verifiedProviderLimit = prop(e, 'verifiedProviderLimit');
  const currentLimit = prop(e, 'currentLimit');
  if (!positive(verifiedProviderLimit) || prop(budgetInput, 'maxActive') !== verifiedProviderLimit ||
      currentLimit > verifiedProviderLimit)
    return 'PROVIDER_LIMIT_UNKNOWN';
  const repositoryLimit = prop(e, 'repositoryLimit'), repositoryActive = prop(e, 'repositoryActive');
  if (prop(e, 'repositoryLimitVerified') !== true || !positive(repositoryLimit) ||
      !nonnegative(repositoryActive) || repositoryActive > activeCount ||
      repositoryActive > currentLimit || currentLimit > repositoryLimit)
    return 'REPOSITORY_CAPACITY_UNKNOWN';
  return null;
}

function validateSafetyAndCostGates(e) {
  if (prop(e, 'qualityClear') !== true || prop(e, 'mainHealthy') !== true ||
      prop(e, 'costVerified') !== true || prop(e, 'extraCost') !== 0 ||
      prop(e, 'duplicateDispatches') !== 0 || prop(e, 'unauthorizedWrites') !== 0)
    return 'SAFETY_OR_COST_UNKNOWN';
  return null;
}

function validateHostedScaleGates(e, budgetInput, activeCount) {
  const concurrencyError = validateConcurrencyGates(e, budgetInput, activeCount);
  if (concurrencyError) return concurrencyError;
  if (!hasObservedPeak(e, prop(e, 'currentLimit'))) return 'OBSERVED_WORKERS_UNKNOWN';
  return validateSafetyAndCostGates(e);
}

function validateComparativeThroughputGates(e, currentLimit) {
  const beforeCohort = prop(e, 'beforeCohort');
  if (prop(e, 'comparabilityVerified') !== true || typeof beforeCohort !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(beforeCohort) || beforeCohort !== prop(e, 'afterCohort'))
    return 'COHORT_UNKNOWN';
  const beforeWindowMs = prop(e, 'beforeWindowMs'), beforeAccepted = prop(e, 'beforeAccepted'),
    afterAccepted = prop(e, 'afterAccepted');
  if (!hasObservedPeak(e, currentLimit) ||
      !positive(beforeWindowMs) || beforeWindowMs !== prop(e, 'afterWindowMs') ||
      !nonnegative(beforeAccepted) || !nonnegative(afterAccepted) ||
      beforeAccepted < 5 || afterAccepted < 5)
    return 'EXPERIMENT_EVIDENCE_UNKNOWN';
  const safetyError = validateSafetyAndCostGates(e);
  if (safetyError) return safetyError;
  if (afterAccepted <= beforeAccepted) return 'NO_MEASURED_GAIN';
  return null;
}

export function recommendShadowScale(e) {
  if (!plain(e) || prop(e, 'stop') !== false) return result('STOPPED');
  if (Object.hasOwn(e, 'environmentVerified') && prop(e, 'environmentVerified') !== true)
    return result('ENVIRONMENT_UNVERIFIED');
  const repositoryId = prop(e, 'repositoryId'), currentLimit = prop(e, 'currentLimit');
  if (!positive(repositoryId) || repositoryId !== prop(e, 'approvedRepositoryId') ||
      prop(e, 'independentEvidence') !== true || !WORKER_LADDER.includes(currentLimit))
    return result('SCOPE_UNKNOWN');
  const budgetInput = prop(e, 'budget');
  const budget = budgetDecision(budgetInput);
  if (budget.reason !== 'SHADOW_CAPACITY') return result(budget.reason);
  if (Object.hasOwn(e, 'hardStopReceipt')) {
    const check = verifyHardStopReceipt(prop(e, 'hardStopReceipt'), prop(budgetInput, 'nowMs'));
    if (!check.valid) return result(check.reason);
  }
  const concurrencyError = validateConcurrencyGates(e, budgetInput, prop(budgetInput, 'active'));
  if (concurrencyError) return result(concurrencyError);
  const throughputError = validateComparativeThroughputGates(e, currentLimit);
  if (throughputError) return result(throughputError);
  const next = WORKER_LADDER[WORKER_LADDER.indexOf(currentLimit) + 1];
  if (next === undefined) return result('LADDER_COMPLETE');
  if (next > prop(e, 'verifiedProviderLimit') || next > prop(e, 'repositoryLimit') ||
      next - prop(e, 'repositoryActive') > budget.available)
    return result('CAPACITY_INSUFFICIENT');
  return result('SHADOW_SCALE_RECOMMENDED', next);
}

// Enforce 1->2->4->8->10->12 hosted worker ladder strictly within verified included quota,
// verified environment/worktree isolation, and enforceable zero-overage hard-stop receipts,
// reporting actual maximum workers and shortfall against the 10-12 goal.
export function evaluateHostedWorkerLadder(e) {
  const report = (reason, nextLimit = null, actualMaxWorkers = 0, verifiedCapacityCeiling = 0) =>
    Object.freeze({
      shadow: true,
      liveDispatch: false,
      reason,
      nextLimit,
      actualMaxWorkers,
      verifiedCapacityCeiling,
      goalMinWorkers: WORKER_GOAL.min,
      goalMaxWorkers: WORKER_GOAL.max,
      shortfallMin: Math.max(0, WORKER_GOAL.min - actualMaxWorkers),
      shortfallMax: Math.max(0, WORKER_GOAL.max - actualMaxWorkers),
      goalMet: actualMaxWorkers >= WORKER_GOAL.min
    });
  if (!plain(e) || prop(e, 'stop') !== false) return report('STOPPED');
  if (prop(e, 'environmentVerified') !== true || !envSlug(prop(e, 'protectedEnvironment')) ||
      prop(e, 'isolatedWorktrees') !== true)
    return report('ENVIRONMENT_UNVERIFIED');
  const budgetInput = prop(e, 'budget'), receiptInput = prop(e, 'hardStopReceipt');
  if (prop(e, 'overageDisabled') === false ||
      (plain(budgetInput) && prop(budgetInput, 'overageDisabled') === false) ||
      (plain(receiptInput) && prop(receiptInput, 'overageDisabled') === false))
    return report('OVERAGE_ENABLED');
  const repositoryId = prop(e, 'repositoryId'), currentLimit = prop(e, 'currentLimit');
  if (!positive(repositoryId) || repositoryId !== prop(e, 'approvedRepositoryId') ||
      prop(e, 'independentEvidence') !== true || !WORKER_LADDER.includes(currentLimit))
    return report('SCOPE_UNKNOWN');
  if (!plain(budgetInput) || prop(budgetInput, 'includedOnly') !== true ||
      prop(budgetInput, 'overageDisabled') !== true || prop(budgetInput, 'authorityVerified') !== true)
    return report('QUOTA_UNKNOWN');
  const budget = budgetDecision(budgetInput);
  if (budget.reason !== 'SHADOW_CAPACITY' && budget.reason !== 'CAPACITY_EXHAUSTED')
    return report(budget.reason);
  const receipt = verifyHardStopReceipt(receiptInput, prop(budgetInput, 'nowMs'));
  if (!receipt.valid) return report(receipt.reason);
  const gateError = validateHostedScaleGates(e, budgetInput, prop(budgetInput, 'active'));
  if (gateError) return report(gateError);
  const ceiling = Math.min(prop(e, 'verifiedProviderLimit'), prop(e, 'repositoryLimit'),
    prop(e, 'repositoryActive') + budget.available);
  const actualMax = prop(e, 'observedPeak');
  const next = WORKER_LADDER[WORKER_LADDER.indexOf(currentLimit) + 1];
  if (next === undefined) return report('LADDER_COMPLETE', null, actualMax, ceiling);
  if (next > ceiling) return report('CAPACITY_INSUFFICIENT', null, actualMax, ceiling);
  return report('SHADOW_SCALE_RECOMMENDED', next, actualMax, ceiling);
}
