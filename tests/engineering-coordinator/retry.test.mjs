import test from 'node:test';
import assert from 'node:assert/strict';
import {retryDelay, withBoundedRetry, readAfterUncertainWrite} from '../../tools/engineering-coordinator/retry.mjs';

const policy = {baseDelayMs: 100, maxDelayMs: 1000, maxAttempts: 3,
  random: () => 0.5, sleep: async () => {}, classify: error => ({kind: error.kind, retryAfterMs: error.retryAfterMs})};

test('bounds exponential delays, jitter and provider retry-after', () => {
  assert.equal(retryDelay(1, policy, () => 0), 75);
  assert.equal(retryDelay(2, policy, () => 1), 250);
  assert.equal(retryDelay(2, policy, () => 0.5, 900), 900);
  assert.equal(retryDelay(8, policy, () => 0.5, 5000), 1000);
  assert.equal(retryDelay(30, policy, () => 0.5), 1000);
});

test('rejects invalid delay inputs and invalid jitter', () => {
  assert.equal(retryDelay(0, policy), null);
  assert.equal(retryDelay(1, {baseDelayMs: 0, maxDelayMs: 2}), null);
  assert.equal(retryDelay(1, null), null);
  assert.equal(retryDelay(1, {baseDelayMs: 1}), null);
  assert.equal(retryDelay(1, {baseDelayMs: 2, maxDelayMs: 1}), null);
  assert.equal(retryDelay(1, policy, () => Number.NaN), null);
  assert.equal(retryDelay(1, policy, () => 2), null);
  assert.equal(retryDelay(1, policy, () => 0.5, -1), null);
});

test('retries transient failures with bounded sleeps then succeeds', async () => {
  let calls = 0; const delays = [];
  const result = await withBoundedRetry(async () => {
    calls++;
    if (calls < 3) throw {kind: 'NETWORK_TIMEOUT'};
    return 'ok';
  }, {...policy, sleep: async delay => delays.push(delay)});
  assert.deepEqual(result, {ok: true, value: 'ok', attempts: 3});
  assert.deepEqual(delays, [100, 200]);
});

test('does not retry permanent errors and stops at the attempt limit', async () => {
  let calls = 0;
  const permanent = await withBoundedRetry(async () => { calls++; throw {kind: 'FORBIDDEN'}; }, policy);
  assert.deepEqual(permanent, {ok: false, reason: 'FORBIDDEN', attempts: 1});
  const exhausted = await withBoundedRetry(async () => { throw {kind: 'SERVER_ERROR'}; }, policy);
  assert.deepEqual(exhausted, {ok: false, reason: 'SERVER_ERROR', attempts: 3});
  assert.equal(calls, 1);
});

test('validates retry options and treats unclassified errors as unknown', async () => {
  assert.equal((await withBoundedRetry(async () => 1, {})).reason, 'INVALID_RETRY_OPTIONS');
  assert.equal((await withBoundedRetry(async () => { throw new Error('x'); }, policy)).reason, 'UNKNOWN_FAILURE');
});

test('uses default jitter and respects provider retry-after in the bounded retry helper', async () => {
  let calls = 0; const delays = [];
  const {random, ...withoutRandom} = policy;
  const result = await withBoundedRetry(async () => {
    if (++calls === 1) throw {kind: 'RATE_LIMITED', retryAfterMs: 500};
    return 'read';
  }, {...withoutRandom, sleep: async delay => delays.push(delay)});
  assert.deepEqual(result, {ok: true, value: 'read', attempts: 2});
  assert.deepEqual(delays, [500]);
  assert.equal(random(), 0.5);
});

test('rejects each invalid retry dependency and handles classifier, delay and sleep failures', async () => {
  assert.equal((await withBoundedRetry(null, policy)).reason, 'INVALID_RETRY_OPTIONS');
  assert.equal((await withBoundedRetry(async () => 1, {...policy, maxAttempts: 0})).reason, 'INVALID_RETRY_OPTIONS');
  assert.equal((await withBoundedRetry(async () => 1, {...policy, maxAttempts: 6})).reason, 'INVALID_RETRY_OPTIONS');
  assert.equal((await withBoundedRetry(async () => 1, {...policy, sleep: null})).reason, 'INVALID_RETRY_OPTIONS');
  assert.equal((await withBoundedRetry(async () => 1, {...policy, classify: null})).reason, 'INVALID_RETRY_OPTIONS');
  const classification = await withBoundedRetry(async () => { throw Error('x'); },
    {...policy, classify: () => { throw Error('bad classifier'); }});
  assert.equal(classification.reason, 'CLASSIFICATION_FAILED');
  const delay = await withBoundedRetry(async () => { throw {kind: 'NETWORK_TIMEOUT'}; },
    {...policy, random: () => Number.NaN});
  assert.equal(delay.reason, 'INVALID_RETRY_POLICY');
  const sleep = await withBoundedRetry(async () => { throw {kind: 'NETWORK_TIMEOUT'}; },
    {...policy, sleep: async () => { throw Error('timer unavailable'); }});
  assert.equal(sleep.reason, 'BACKOFF_FAILED');
});

test('reconciles uncertain writes from an authoritative read without repeating the write', async () => {
  let writes = 0;
  const reconciled = await readAfterUncertainWrite({write: async () => { writes++; throw Error('timeout'); },
    read: async () => ({key: 'same'}), matches: (value, key) => value.key === key,
    idempotencyKey: 'same', retry: policy});
  assert.equal(reconciled.reconciled, true);
  assert.equal(writes, 1);
});

test('keeps unknown write outcomes blocked and handles confirmed writes', async () => {
  const unknown = await readAfterUncertainWrite({write: async () => { throw Error('timeout'); },
    read: async () => ({key: 'different'}), matches: (value, key) => value.key === key,
    idempotencyKey: 'same', retry: policy});
  assert.equal(unknown.reason, 'WRITE_OUTCOME_UNKNOWN');
  const confirmed = await readAfterUncertainWrite({write: async key => `receipt:${key}`,
    read: async () => null, matches: () => false, idempotencyKey: 'same', retry: policy});
  assert.deepEqual(confirmed, {ok: true, reconciled: false, receipt: 'receipt:same'});
});

test('fails closed when read-after-write input, read or comparison is invalid', async () => {
  assert.equal((await readAfterUncertainWrite({write: null, read: async () => null, matches: () => false,
    idempotencyKey: 'same', retry: policy})).reason, 'INVALID_RECONCILIATION');
  const readFailure = await readAfterUncertainWrite({write: async () => { throw Error('timeout'); },
    read: async () => { throw {kind: 'FORBIDDEN'}; }, matches: () => false,
    idempotencyKey: 'same', retry: policy});
  assert.equal(readFailure.reason, 'READ_AFTER_WRITE_FAILED');
  const compareFailure = await readAfterUncertainWrite({write: async () => { throw Error('timeout'); },
    read: async () => null, matches: () => { throw Error('bad comparator'); },
    idempotencyKey: 'same', retry: policy});
  assert.equal(compareFailure.reason, 'RECONCILIATION_FAILED');
});
