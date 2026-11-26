import {withBoundedRetry, readAfterUncertainWrite} from './retry.mjs';

// This adapter only exercises a synthetic transport. It cannot authorize a real review.
const denied = reason => ({shadow: true, accepted: false, reason});
const accepted = reason => ({shadow: true, accepted: true, reason});
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const repository = value => typeof value === 'string' &&
  /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(value) && !value.includes('..');
const valid = candidate => candidate && repository(candidate.repository) &&
  Number.isSafeInteger(candidate.number) && candidate.number > 0 && sha(candidate.head);
const matches = (observed, candidate) => observed && observed.repository === candidate.repository &&
  observed.number === candidate.number && observed.head === candidate.head;
const states = new Set(['needed', 'pending', 'reviewed']);

// The caller must obtain a scoped, atomic, zero-cost reservation from its trusted
// runtime. Configuration, review text and provider errors cannot create authority.
export function reviewDecision(candidate, observed, reservation) {
  if (!valid(candidate)) return denied('INVALID_CANDIDATE');
  if (!matches(observed, candidate) || !states.has(observed.reviewState))
    return denied('STALE_OR_UNKNOWN_EVIDENCE');
  if (observed.reviewState !== 'needed') return accepted(observed.reviewState === 'pending' ?
    'REVIEW_PENDING' : 'HEAD_REVIEWED');
  if (!matches(reservation, candidate) || reservation.included !== true ||
      reservation.overageDisabled !== true || reservation.reserved !== true)
    return denied('CAPACITY_UNVERIFIED');
  return accepted('SIMULATE_REQUEST');
}

export function createReviewProvider(transport, retry, intents) {
  if (!transport || transport.mode !== 'shadow' || typeof transport.readReview !== 'function' ||
      typeof transport.simulateRequest !== 'function' || !retry || typeof intents?.claim !== 'function')
    throw new TypeError('INVALID_REVIEW_PROVIDER');
  return Object.freeze({
    async request(candidate, reservation) {
      if (!valid(candidate)) return denied('INVALID_CANDIDATE');
      const target = Object.freeze({repository: candidate.repository, number: candidate.number, head: candidate.head});
      const read = () => transport.readReview(target);
      const observed = await withBoundedRetry(read, retry);
      if (!observed.ok) return denied('REVIEW_READ_FAILED');
      const decision = reviewDecision(target, observed.value, reservation);
      if (decision.reason !== 'SIMULATE_REQUEST') return decision;
      const key = [target.repository.toLowerCase(), target.number, target.head].join(':');
      // The atomic durable claim is consumed before a possible write, including on crash.
      try { if (intents.claim(key) !== true) return denied('INTENT_UNAVAILABLE_OR_CLAIMED'); }
      catch { return denied('INTENT_UNAVAILABLE_OR_CLAIMED'); }
      const result = await readAfterUncertainWrite({
        write: idempotencyKey => transport.simulateRequest(target, idempotencyKey),
        read, retry, idempotencyKey: key,
        matches: value => matches(value, target) && ['pending', 'reviewed'].includes(value.reviewState)
      });
      if (!result.ok) return denied('REQUEST_OUTCOME_UNKNOWN');
      if (result.reconciled) return accepted('REQUEST_RECONCILED');
      const status = result.receipt?.status;
      if (status === 201) return accepted('REQUEST_SIMULATED');
      if (status === 409) {
        const pending = await withBoundedRetry(read, retry);
        if (pending.ok && matches(pending.value, target) &&
            ['pending', 'reviewed'].includes(pending.value.reviewState)) return accepted('REQUEST_RECONCILED');
        return denied('REQUEST_OUTCOME_UNKNOWN');
      }
      if (status === 422) return denied('PROVIDER_INELIGIBLE_OR_QUOTA');
      if (status === 403) return denied('PROVIDER_FORBIDDEN');
      if (status === 429 || status === 503) return denied('DEFERRED_TRANSIENT');
      return denied('PROVIDER_RESPONSE_UNKNOWN');
    }
  });
}
