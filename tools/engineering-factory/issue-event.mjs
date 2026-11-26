import {types} from 'node:util';
import {eventEnvelope} from './event-envelope.mjs';

const repositoryId = 1471342715;
const workflowRef = 'Jamula/SoftwareFactory/.github/workflows/shadow-reconcile.yml@refs/heads/main';
const workflowBranch = 'refs/heads/main';
const positive = value => Number.isSafeInteger(value) && value > 0;
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const own = (value, keys) => value !== null && typeof value === 'object' &&
  !types.isProxy(value) && !Array.isArray(value) &&
  keys.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
const blocked = reason => ({shadow: true, evidenceComplete: false, reason});
const blockedTrigger = reason => ({shadow: true, evidenceComplete: false, reconciled: false, reason});

export async function readIssueIdentity(number, request = fetch) {
  if (!positive(number)) return blocked('INVALID_ISSUE');
  try {
    const response = await request('https://api.github.com/repos/Jamula/SoftwareFactory/issues/' + number, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: {accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'}
    });
    if (response.status === 403 || response.status === 429) return blocked('RATE_OR_PERMISSION_UNKNOWN');
    if (!response.ok || !response.body) return blocked('READ_FAILED');

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', {fatal: true});
    let raw = '';
    let bytes = 0;
    try {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 524288) return blocked('RESPONSE_LIMIT');
        raw += decoder.decode(value, {stream: true});
      }
      raw += decoder.decode();
    } finally {
      await reader.cancel();
    }

    const issue = JSON.parse(raw);
    if (issue?.number !== number || issue.repository_url !== 'https://api.github.com/repos/Jamula/SoftwareFactory' ||
        Object.hasOwn(issue, 'pull_request') || !['open', 'closed'].includes(issue.state))
      return blocked('IDENTITY_UNKNOWN');
    return {...blocked('IDENTITY_ONLY'), number, state: issue.state};
  } catch {
    return blocked('READ_FAILED');
  }
}

export async function reconcileIssueTrigger(env, {clock = Date.now, readIdentity = readIssueIdentity} = {}) {
  const workflowSha = env.GITHUB_WORKFLOW_SHA;
  const manual = env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  if (!['issues', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) ||
      env.GITHUB_REPOSITORY_ID !== String(repositoryId) || env.GITHUB_REF !== workflowBranch ||
      env.GITHUB_WORKFLOW_REF !== workflowRef || env.GITHUB_REF_PROTECTED !== 'true' ||
      !sha(workflowSha) || env.GITHUB_SHA !== workflowSha || env.FACTORY_CHECKOUT_SHA !== workflowSha)
    return blockedTrigger('TRUST_UNKNOWN');

  const numberText = env.FACTORY_ISSUE_NUMBER;
  if (typeof numberText !== 'string' || !/^[1-9][0-9]{0,15}$/.test(numberText) ||
      !positive(Number(numberText))) return blockedTrigger('INVALID_ISSUE');
  const number = Number(numberText);
  const startedAt = clock();
  const event = {
    repositoryId, workflowSha, kind: manual ? 'manual' : 'issue', head: workflowSha,
    deliveryId: env.GITHUB_RUN_ID, receivedMs: startedAt
  };
  const trust = {repositoryId, workflowSha};
  const observed = eventEnvelope(event, trust, startedAt);
  if (!observed.accepted) return blockedTrigger(observed.reason);

  let current;
  try {
    current = await readIdentity(number);
  } catch {
    return blockedTrigger('READ_FAILED');
  }
  const finishedAt = clock();
  if (!eventEnvelope(event, trust, finishedAt).accepted) return blockedTrigger('STALE_EVENT');
  if (!own(current, ['reason']) || current.reason !== 'IDENTITY_ONLY') {
    return blockedTrigger(own(current, ['reason']) && current.reason === 'RATE_OR_PERMISSION_UNKNOWN'
      ? 'RATE_OR_PERMISSION_UNKNOWN' : 'READ_FAILED');
  }
  if (!own(current, ['number', 'state']) || current.number !== number ||
      !['open', 'closed'].includes(current.state)) return blockedTrigger('IDENTITY_UNKNOWN');

  return {
    shadow: true, evidenceComplete: false, reconciled: true, reason: 'ISSUE_IDENTITY_MATCHED',
    repositoryId, number, state: current.state, workflowSha, runId: observed.deliveryId,
    observedMs: finishedAt - startedAt
  };
}
