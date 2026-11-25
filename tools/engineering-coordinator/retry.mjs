const transient = new Set(['NETWORK_TIMEOUT', 'SERVER_ERROR', 'RATE_LIMITED', 'TEMPORARY_UNAVAILABLE']);
export function retryDelay(attempt, policy, random = () => 0.5, retryAfterMs = 0) {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || !policy ||
      !Number.isSafeInteger(policy.baseDelayMs) || !Number.isSafeInteger(policy.maxDelayMs) ||
      policy.baseDelayMs < 1 || policy.maxDelayMs < policy.baseDelayMs ||
      !Number.isFinite(retryAfterMs) || retryAfterMs < 0 || retryAfterMs > policy.maxDelayMs) return null;
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) return null;
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** Math.min(attempt - 1, 20)));
  return Math.min(policy.maxDelayMs, Math.max(retryAfterMs, Math.floor(ceiling * (0.75 + sample * 0.5))));
}

export async function withBoundedRetry(operation, options) {
  if (typeof operation !== 'function' || !options ||
      !Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1 || options.maxAttempts > 5 ||
      typeof options.sleep !== 'function' || typeof options.classify !== 'function')
    return {ok: false, reason: 'INVALID_RETRY_OPTIONS', attempts: 0};
  const random = options.random ?? (() => 0.5);
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return {ok: true, value: await operation(attempt), attempts: attempt};
    } catch (error) {
      let classification;
      try { classification = options.classify(error); }
      catch { return {ok: false, reason: 'CLASSIFICATION_FAILED', attempts: attempt}; }
      if (!classification || !transient.has(classification.kind) || attempt === options.maxAttempts)
        return {ok: false, reason: classification?.kind ?? 'UNKNOWN_FAILURE', attempts: attempt};
      const delay = retryDelay(attempt, options, random, classification.retryAfterMs ?? 0);
      if (delay === null) return {ok: false, reason: 'INVALID_RETRY_POLICY', attempts: attempt};
      try { await options.sleep(delay); }
      catch { return {ok: false, reason: 'BACKOFF_FAILED', attempts: attempt}; }
    }
  }
}

export async function readAfterUncertainWrite({write, read, matches, idempotencyKey, retry}) {
  if (typeof write !== 'function' || typeof read !== 'function' || typeof matches !== 'function' ||
      typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || !retry)
    return {ok: false, reason: 'INVALID_RECONCILIATION'};
  try {
    const receipt = await write(idempotencyKey);
    return {ok: true, reconciled: false, receipt};
  } catch {
    const observed = await withBoundedRetry(read, retry);
    if (!observed.ok) return {ok: false, reason: 'READ_AFTER_WRITE_FAILED', attempts: observed.attempts};
    let matched;
    try { matched = await matches(observed.value, idempotencyKey); }
    catch { return {ok: false, reason: 'RECONCILIATION_FAILED', attempts: observed.attempts}; }
    if (matched === true)
      return {ok: true, reconciled: true, receipt: observed.value, attempts: observed.attempts};
    return {ok: false, reason: 'WRITE_OUTCOME_UNKNOWN', attempts: observed.attempts};
  }
}
