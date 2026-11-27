import {
  eventEnvelope,
  own,
  ownOptional,
  positive,
  readOwn,
  readPublicGitHubJson,
  resolveTrustedScope,
  verifyWorkflowProvenance
} from './event-envelope.mjs';

const blocked = reason => ({shadow: true, evidenceComplete: false, reason});
const blockedTrigger = reason => ({shadow: true, evidenceComplete: false, reconciled: false, reason});
const issueOptionKeys = ['scope', 'repository', 'repositoryId', 'branch', 'workflowPath', 'clock', 'request', 'readIdentity'];

export async function readIssueIdentity(number, request = fetch, scope = {}) {
  const resolved = resolveTrustedScope(scope);
  if (!resolved) return blocked('TRUST_UNKNOWN');
  if (!positive(number)) return blocked('INVALID_ISSUE');
  const res = await readPublicGitHubJson(`${resolved.apiRoot}/issues/${number}`, request);
  if (!res.ok) return blocked(res.reason);
  const issue = res.value;
  if (issue?.number !== number || issue.repository_url !== resolved.apiRoot ||
      Object.hasOwn(issue, 'pull_request') || !['open', 'closed'].includes(issue.state)) {
    return blocked('IDENTITY_UNKNOWN');
  }
  return {...blocked('IDENTITY_ONLY'), number, state: issue.state};
}

export async function reconcileIssueTrigger(env, options = {}) {
  if (!ownOptional(options, issueOptionKeys) || !ownOptional(env, ['GITHUB_EVENT_NAME'])) {
    return blockedTrigger('TRUST_UNKNOWN');
  }
  const resolved = resolveTrustedScope(options);
  if (!resolved) return blockedTrigger('TRUST_UNKNOWN');
  const manual = readOwn(env, 'GITHUB_EVENT_NAME') === 'workflow_dispatch';
  const expectedEvent = manual ? 'workflow_dispatch' : 'issues';
  const workflowSha = verifyWorkflowProvenance(env, resolved, expectedEvent, true);
  if (!workflowSha) return blockedTrigger('TRUST_UNKNOWN');

  const numberText = readOwn(env, 'FACTORY_ISSUE_NUMBER');
  if (typeof numberText !== 'string' || !/^[1-9][0-9]{0,15}$/.test(numberText) ||
      !positive(Number(numberText))) return blockedTrigger('INVALID_ISSUE');
  const number = Number(numberText);
  const clock = readOwn(options, 'clock', Date.now);
  const request = readOwn(options, 'request', fetch);
  const readIdentity = readOwn(options, 'readIdentity');
  const {repositoryId} = resolved;
  const startedAt = clock();
  const event = {
    repositoryId, workflowSha, kind: manual ? 'manual' : 'issue', head: workflowSha,
    deliveryId: readOwn(env, 'GITHUB_RUN_ID'), receivedMs: startedAt
  };
  const trust = {repositoryId, workflowSha};
  const observed = eventEnvelope(event, trust, startedAt);
  if (!observed.accepted) return blockedTrigger(observed.reason);

  let current;
  try {
    current = await (readIdentity
      ? readIdentity(number)
      : readIssueIdentity(number, request, {
        repository: resolved.repository, repositoryId,
        branch: resolved.branch, workflowPath: resolved.workflowPath
      }));
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
