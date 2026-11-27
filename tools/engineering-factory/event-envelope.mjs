import {types} from 'node:util';
import {
  exportJournalSnapshot,
  importJournalSnapshot,
  openEventJournal,
  reconcileJournalOnce
} from '../engineering-coordinator/event-journal.mjs';

const DEFAULT_REPOSITORY = 'Jamula/SoftwareFactory';
const DEFAULT_REPOSITORY_ID = 1471342715;
const DEFAULT_BRANCH = 'main';
const DEFAULT_WORKFLOW_PATH = '.github/workflows/shadow-reconcile.yml';
const scopeKeys = ['repository', 'repositoryId', 'branch', 'workflowPath'];
const kinds = new Set(['issue', 'pull', 'review', 'check', 'main', 'manual']);
const reviewStates = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED']);
const checkConclusions = new Set([
  'success', 'failure', 'neutral', 'cancelled', 'skipped',
  'timed_out', 'action_required', 'stale', 'startup_failure'
]);

export const positive = n => Number.isSafeInteger(n) && n > 0;
export const sha = s => typeof s === 'string' && /^[a-f0-9]{40}$/.test(s);
const validLogin = s => typeof s === 'string' && s.length <= 44 &&
  /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?:\[bot\])?$/.test(s);
const validRepository = s => typeof s === 'string' && s.length <= 200 &&
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s) &&
  !s.split('/').some(part => part === '.' || part === '..');
const validBranch = s => typeof s === 'string' && s.length <= 120 &&
  /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(s) &&
  !s.includes('..') && !s.includes('//') && !s.endsWith('/') && !s.endsWith('.lock');
const validWorkflowPath = s => typeof s === 'string' && s.length <= 200 &&
  /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(s) && !s.includes('..');
const isPlainObject = v => v !== null && typeof v === 'object' && !types.isProxy(v) &&
  !Array.isArray(v) &&
  (v === process.env || Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const ownValue = (v, key) => Object.hasOwn(Object.getOwnPropertyDescriptor(v, key) ?? {}, 'value');
export const own = (v, keys) => isPlainObject(v) && keys.every(k => ownValue(v, k));
export const ownOptional = (v, keys) => isPlainObject(v) && keys.every(k => {
  const desc = Object.getOwnPropertyDescriptor(v, k);
  return desc === undefined || Object.hasOwn(desc, 'value');
});
export const readOwn = (v, key, fallback = undefined) => {
  const desc = Object.getOwnPropertyDescriptor(v, key);
  return desc !== undefined && Object.hasOwn(desc, 'value') && desc.value !== undefined
    ? desc.value : fallback;
};
const parsePositiveId = text => typeof text === 'string' && /^[1-9][0-9]{0,15}$/.test(text) &&
  positive(Number(text)) ? Number(text) : 0;
const deny = reason => ({shadow: true, accepted: false, reason});
const blockedRead = reason => ({shadow: true, evidenceComplete: false, reason});
const blockedTrigger = reason => ({shadow: true, evidenceComplete: false, reconciled: false, reason});

const provenanceEnvKeys = [
  'GITHUB_EVENT_NAME', 'GITHUB_REPOSITORY_ID', 'GITHUB_REF', 'GITHUB_WORKFLOW_REF',
  'GITHUB_REF_PROTECTED', 'GITHUB_WORKFLOW_SHA', 'GITHUB_SHA', 'FACTORY_CHECKOUT_SHA',
  'GITHUB_RUN_ID', 'FACTORY_PULL_NUMBER', 'FACTORY_PULL_HEAD', 'FACTORY_REVIEW_ID',
  'FACTORY_WORKFLOW_RUN_ID', 'FACTORY_CHECK_HEAD', 'FACTORY_MAIN_HEAD', 'FACTORY_ISSUE_NUMBER'
];
const reconcileOptionKeys = [
  'scope', ...scopeKeys, 'clock', 'request', 'readIdentity',
  'journal', 'snapshot', 'owner', 'leaseMs', 'deferUnknown'
];

export function resolveTrustedScope(options = {}) {
  if (!ownOptional(options, ['scope'])) return null;
  const scopedProp = readOwn(options, 'scope');
  const raw = scopedProp === undefined ? options : scopedProp;
  if (!ownOptional(raw, scopeKeys)) return null;
  const rawRepository = readOwn(raw, 'repository');
  const rawRepositoryId = readOwn(raw, 'repositoryId');
  if (rawRepository !== undefined && rawRepositoryId === undefined) return null;
  const repository = readOwn(raw, 'repository', DEFAULT_REPOSITORY);
  const repositoryId = readOwn(raw, 'repositoryId', DEFAULT_REPOSITORY_ID);
  const branch = readOwn(raw, 'branch', DEFAULT_BRANCH);
  const workflowPath = readOwn(raw, 'workflowPath', DEFAULT_WORKFLOW_PATH);
  if (!validRepository(repository) || !positive(repositoryId) ||
      !validBranch(branch) || !validWorkflowPath(workflowPath)) return null;
  return Object.freeze({
    repository,
    repositoryId,
    branch,
    workflowPath,
    workflowBranch: `refs/heads/${branch}`,
    workflowRef: `${repository}/${workflowPath}@refs/heads/${branch}`,
    apiRoot: `https://api.github.com/repos/${repository}`,
    explicitRepositoryId: rawRepositoryId !== undefined
  });
}

export function verifyWorkflowProvenance(env, resolved, expectedEvent, requireBranchRef) {
  if (!ownOptional(env, provenanceEnvKeys)) return null;
  const workflowSha = readOwn(env, 'GITHUB_WORKFLOW_SHA');
  if (readOwn(env, 'GITHUB_EVENT_NAME') !== expectedEvent ||
      readOwn(env, 'GITHUB_REPOSITORY_ID') !== String(resolved.repositoryId) ||
      (requireBranchRef && readOwn(env, 'GITHUB_REF') !== resolved.workflowBranch) ||
      readOwn(env, 'GITHUB_WORKFLOW_REF') !== resolved.workflowRef ||
      readOwn(env, 'GITHUB_REF_PROTECTED') !== 'true' || !sha(workflowSha) ||
      readOwn(env, 'GITHUB_SHA') !== workflowSha ||
      readOwn(env, 'FACTORY_CHECKOUT_SHA') !== workflowSha) {
    return null;
  }
  return workflowSha;
}

export async function readPublicGitHubJson(url, request = fetch) {
  try {
    const response = await request(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: {accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'}
    });
    if (response.status === 401 || response.status === 403 || response.status === 429) {
      return {ok: false, reason: 'RATE_OR_PERMISSION_UNKNOWN'};
    }
    if (!response.ok || !response.body) return {ok: false, reason: 'READ_FAILED'};
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', {fatal: true});
    let raw = '';
    let bytes = 0;
    try {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 524288) return {ok: false, reason: 'RESPONSE_LIMIT'};
        raw += decoder.decode(value, {stream: true});
      }
      raw += decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
    }
    const hasNext = response.headers.get('link')?.includes('rel="next"') === true;
    return {ok: true, value: JSON.parse(raw), hasNext};
  } catch {
    return {ok: false, reason: 'READ_FAILED'};
  }
}

export function eventEnvelope(event, trust, now) {
  if (!own(trust, ['repositoryId', 'workflowSha']) || !positive(trust.repositoryId) || !sha(trust.workflowSha)) {
    return deny('TRUST_UNKNOWN');
  }
  if (!own(event, ['repositoryId', 'workflowSha', 'deliveryId', 'kind', 'head', 'receivedMs']) ||
      !positive(event.repositoryId) || !sha(event.workflowSha) || !sha(event.head) ||
      typeof event.deliveryId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(event.deliveryId) ||
      !kinds.has(event.kind) || !Number.isSafeInteger(event.receivedMs) || event.receivedMs < 0) {
    return deny('INVALID_EVENT');
  }
  if (event.repositoryId !== trust.repositoryId || event.workflowSha !== trust.workflowSha) {
    return deny('PROVENANCE_MISMATCH');
  }
  if (!Number.isSafeInteger(now) || now < event.receivedMs || now - event.receivedMs > 120000) {
    return deny('STALE_EVENT');
  }
  return {
    shadow: true, accepted: true, reason: 'NORMALIZED_ONLY',
    repositoryId: event.repositoryId, kind: event.kind, head: event.head,
    deliveryId: event.deliveryId, receivedMs: event.receivedMs
  };
}

/** Public, read-only metadata adapter; does not imply authoritative approval or complete evidence. */
export async function readPullIdentity(number, request = fetch, scope = {}) {
  const resolved = resolveTrustedScope(scope);
  if (!resolved) return blockedRead('TRUST_UNKNOWN');
  if (!positive(number)) return blockedRead('INVALID_PULL');
  const res = await readPublicGitHubJson(`${resolved.apiRoot}/pulls/${number}`, request);
  if (!res.ok) return blockedRead(res.reason);
  const p = res.value;
  if (p?.number !== number || p?.base?.repo?.full_name !== resolved.repository ||
      p?.head?.repo?.full_name !== resolved.repository || p.base.ref !== resolved.branch ||
      !sha(p.base.sha) || !sha(p.head.sha) || !positive(p.base.repo.id) ||
      p.head.repo.id !== p.base.repo.id ||
      (resolved.explicitRepositoryId && p.base.repo.id !== resolved.repositoryId) ||
      !['open', 'closed'].includes(p.state) || typeof p.draft !== 'boolean') {
    return blockedRead('IDENTITY_UNKNOWN');
  }
  return {
    ...blockedRead('IDENTITY_ONLY'),
    repositoryId: p.base.repo.id, number, head: p.head.sha, base: p.base.sha,
    state: p.state, draft: p.draft
  };
}

/** Public, read-only review metadata adapter bound to a fresh same-repository pull read. */
export async function readReviewIdentity(number, reviewId, request = fetch, scope = {}) {
  const resolved = resolveTrustedScope(scope);
  if (!resolved) return blockedRead('TRUST_UNKNOWN');
  if (!positive(number)) return blockedRead('INVALID_PULL');
  if (!positive(reviewId)) return blockedRead('INVALID_REVIEW');
  const pull = await readPullIdentity(number, request, scope);
  if (pull.reason !== 'IDENTITY_ONLY') return blockedRead(pull.reason);
  const res = await readPublicGitHubJson(`${resolved.apiRoot}/pulls/${number}/reviews/${reviewId}`, request);
  if (!res.ok) return blockedRead(res.reason);
  const r = res.value;
  if (r?.id !== reviewId || !validLogin(r?.user?.login) || !positive(r?.user?.id) ||
      !reviewStates.has(r.state) || !sha(r.commit_id)) {
    return blockedRead('IDENTITY_UNKNOWN');
  }
  const finalPull = await readPullIdentity(number, request, scope);
  if (finalPull.reason !== 'IDENTITY_ONLY') return blockedRead(finalPull.reason);
  if (finalPull.repositoryId !== pull.repositoryId) return blockedRead('IDENTITY_UNKNOWN');
  if (finalPull.head !== pull.head) return blockedRead('HEAD_CHANGED');
  if (finalPull.base !== pull.base || finalPull.state !== pull.state || finalPull.draft !== pull.draft) {
    return blockedRead('PULL_STATE_CHANGED');
  }
  return {
    ...blockedRead('IDENTITY_ONLY'),
    repositoryId: finalPull.repositoryId, number, reviewId,
    reviewer: r.user.login, reviewerId: r.user.id, reviewState: r.state,
    commitId: r.commit_id, head: finalPull.head, base: finalPull.base,
    state: finalPull.state, draft: finalPull.draft
  };
}

/** Public, read-only Actions workflow_run metadata adapter for same-repository completed checks. */
export async function readCheckRunIdentity(runId, request = fetch, scope = {}) {
  const resolved = resolveTrustedScope(scope);
  if (!resolved) return blockedRead('TRUST_UNKNOWN');
  if (!positive(runId)) return blockedRead('INVALID_CHECK');
  const res = await readPublicGitHubJson(`${resolved.apiRoot}/actions/runs/${runId}`, request);
  if (!res.ok) return blockedRead(res.reason);
  const r = res.value;
  if (r?.id !== runId || r?.repository?.full_name !== resolved.repository ||
      r.repository.id !== resolved.repositoryId ||
      r?.head_repository?.full_name !== resolved.repository ||
      r.head_repository.id !== resolved.repositoryId ||
      !sha(r.head_sha) || r.status !== 'completed' || !checkConclusions.has(r.conclusion) ||
      typeof r.event !== 'string' || !/^[a-z_]{1,40}$/.test(r.event)) {
    return blockedRead('IDENTITY_UNKNOWN');
  }
  return {
    ...blockedRead('IDENTITY_ONLY'),
    repositoryId: r.repository.id, runId, head: r.head_sha,
    status: r.status, conclusion: r.conclusion, triggerEvent: r.event
  };
}

/** Public, read-only repository and protected branch head adapter for main push verification. */
export async function readMainIdentity(request = fetch, scope = {}) {
  const resolved = resolveTrustedScope(scope);
  if (!resolved) return blockedRead('TRUST_UNKNOWN');
  const branchPath = resolved.branch.split('/').map(encodeURIComponent).join('/');
  const [repoRes, branchRes] = await Promise.all([
    readPublicGitHubJson(resolved.apiRoot, request),
    readPublicGitHubJson(`${resolved.apiRoot}/branches/${branchPath}`, request)
  ]);
  if (!repoRes.ok) return blockedRead(repoRes.reason);
  if (!branchRes.ok) return blockedRead(branchRes.reason);
  const repo = repoRes.value;
  const branch = branchRes.value;
  if (repo?.full_name !== resolved.repository || repo.id !== resolved.repositoryId ||
      repo.fork !== false || branch?.name !== resolved.branch ||
      branch.protected !== true || !sha(branch.commit?.sha)) {
    return blockedRead('IDENTITY_UNKNOWN');
  }
  return {
    ...blockedRead('IDENTITY_ONLY'),
    repositoryId: repo.id, branch: branch.name, head: branch.commit.sha, branchProtected: true
  };
}

function explicitScopeFrom(resolved) {
  return {
    repository: resolved.repository,
    repositoryId: resolved.repositoryId,
    branch: resolved.branch,
    workflowPath: resolved.workflowPath
  };
}

const preservedReadReasons = new Set(['RATE_OR_PERMISSION_UNKNOWN', 'HEAD_CHANGED', 'PULL_STATE_CHANGED']);

async function observeFresh(event, trust, clock, loader) {
  const startedAt = clock();
  const observed = eventEnvelope({...event, receivedMs: startedAt}, trust, startedAt);
  if (!observed.accepted) return {ok: false, reason: observed.reason};
  let current;
  try {
    current = await loader();
  } catch {
    return {ok: false, reason: 'READ_FAILED'};
  }
  const finishedAt = clock();
  if (!eventEnvelope({...event, receivedMs: startedAt}, trust, finishedAt).accepted) {
    return {ok: false, reason: 'STALE_EVENT'};
  }
  if (!own(current, ['reason']) || current.reason !== 'IDENTITY_ONLY') {
    const reason = own(current, ['reason']) && preservedReadReasons.has(current.reason)
      ? current.reason : 'READ_FAILED';
    return {ok: false, reason};
  }
  return {ok: true, observed, current, observedMs: finishedAt - startedAt};
}

/** Bind one protected-base Actions trigger to a fresh, same-repository public PR read. */
export async function reconcilePullTrigger(env, options = {}) {
  if (!ownOptional(options, reconcileOptionKeys)) return blockedTrigger('TRUST_UNKNOWN');
  const resolved = resolveTrustedScope(options);
  if (!resolved) return blockedTrigger('TRUST_UNKNOWN');
  const workflowSha = verifyWorkflowProvenance(env, resolved, 'pull_request_target', false);
  if (!workflowSha) return blockedTrigger('TRUST_UNKNOWN');
  const number = parsePositiveId(readOwn(env, 'FACTORY_PULL_NUMBER'));
  if (!number) return blockedTrigger('INVALID_PULL');
  const clock = readOwn(options, 'clock', Date.now);
  const request = readOwn(options, 'request', fetch);
  const readIdentity = readOwn(options, 'readIdentity');
  const {repositoryId} = resolved;
  const loader = readIdentity
    ? () => readIdentity(number)
    : () => readPullIdentity(number, request, explicitScopeFrom(resolved));
  const fresh = await observeFresh(
    {repositoryId, workflowSha, kind: 'pull', head: readOwn(env, 'FACTORY_PULL_HEAD'), deliveryId: readOwn(env, 'GITHUB_RUN_ID')},
    {repositoryId, workflowSha}, clock, loader
  );
  if (!fresh.ok) return blockedTrigger(fresh.reason);
  const {current, observed, observedMs} = fresh;
  if (!own(current, ['repositoryId', 'number', 'head', 'base', 'state', 'draft']) ||
      current.repositoryId !== repositoryId || current.number !== number ||
      !sha(current.head) || !sha(current.base) || !['open', 'closed'].includes(current.state) ||
      typeof current.draft !== 'boolean') return blockedTrigger('IDENTITY_UNKNOWN');
  if (current.head !== observed.head) return blockedTrigger('HEAD_CHANGED');
  return {
    shadow: true, evidenceComplete: false, reconciled: true, reason: 'PULL_IDENTITY_MATCHED',
    repositoryId, number, head: current.head, base: current.base, state: current.state, draft: current.draft,
    workflowSha, runId: observed.deliveryId, observedMs
  };
}

/** Bind one protected review trigger to a fresh same-repository PR and review read. */
export async function reconcileReviewTrigger(env, options = {}) {
  if (!ownOptional(options, reconcileOptionKeys)) return blockedTrigger('TRUST_UNKNOWN');
  const resolved = resolveTrustedScope(options);
  if (!resolved) return blockedTrigger('TRUST_UNKNOWN');
  const workflowSha = verifyWorkflowProvenance(env, resolved, 'pull_request_review', false);
  if (!workflowSha) return blockedTrigger('TRUST_UNKNOWN');
  const number = parsePositiveId(readOwn(env, 'FACTORY_PULL_NUMBER'));
  if (!number) return blockedTrigger('INVALID_PULL');
  const reviewId = parsePositiveId(readOwn(env, 'FACTORY_REVIEW_ID'));
  if (!reviewId) return blockedTrigger('INVALID_REVIEW');
  const clock = readOwn(options, 'clock', Date.now);
  const request = readOwn(options, 'request', fetch);
  const readIdentity = readOwn(options, 'readIdentity');
  const {repositoryId} = resolved;
  const loader = readIdentity
    ? () => readIdentity(number, reviewId)
    : () => readReviewIdentity(number, reviewId, request, explicitScopeFrom(resolved));
  const fresh = await observeFresh(
    {repositoryId, workflowSha, kind: 'review', head: readOwn(env, 'FACTORY_PULL_HEAD'), deliveryId: readOwn(env, 'GITHUB_RUN_ID')},
    {repositoryId, workflowSha}, clock, loader
  );
  if (!fresh.ok) return blockedTrigger(fresh.reason);
  const {current, observed, observedMs} = fresh;
  if (!own(current, [
        'repositoryId', 'number', 'reviewId', 'reviewer', 'reviewerId',
        'reviewState', 'commitId', 'head', 'base', 'state', 'draft'
      ]) ||
      current.repositoryId !== repositoryId || current.number !== number ||
      current.reviewId !== reviewId || !validLogin(current.reviewer) ||
      !positive(current.reviewerId) || !reviewStates.has(current.reviewState) ||
      !sha(current.commitId) || !sha(current.head) || !sha(current.base) ||
      !['open', 'closed'].includes(current.state) || typeof current.draft !== 'boolean') {
    return blockedTrigger('IDENTITY_UNKNOWN');
  }
  if (current.head !== observed.head || current.commitId !== observed.head) {
    return blockedTrigger('HEAD_CHANGED');
  }
  return {
    shadow: true, evidenceComplete: false, reconciled: true, reason: 'REVIEW_IDENTITY_MATCHED',
    repositoryId, number, reviewId, reviewer: current.reviewer, reviewerId: current.reviewerId,
    reviewState: current.reviewState, head: current.head, base: current.base,
    state: current.state, draft: current.draft, workflowSha, runId: observed.deliveryId, observedMs
  };
}

/** Bind one protected workflow_run trigger to a fresh same-repository completed check read. */
export async function reconcileCheckTrigger(env, options = {}) {
  if (!ownOptional(options, reconcileOptionKeys)) return blockedTrigger('TRUST_UNKNOWN');
  const resolved = resolveTrustedScope(options);
  if (!resolved) return blockedTrigger('TRUST_UNKNOWN');
  const workflowSha = verifyWorkflowProvenance(env, resolved, 'workflow_run', true);
  if (!workflowSha) return blockedTrigger('TRUST_UNKNOWN');
  const workflowRunId = parsePositiveId(readOwn(env, 'FACTORY_WORKFLOW_RUN_ID'));
  if (!workflowRunId) return blockedTrigger('INVALID_CHECK');
  const clock = readOwn(options, 'clock', Date.now);
  const request = readOwn(options, 'request', fetch);
  const readIdentity = readOwn(options, 'readIdentity');
  const {repositoryId} = resolved;
  const loader = readIdentity
    ? () => readIdentity(workflowRunId)
    : () => readCheckRunIdentity(workflowRunId, request, explicitScopeFrom(resolved));
  const fresh = await observeFresh(
    {repositoryId, workflowSha, kind: 'check', head: readOwn(env, 'FACTORY_CHECK_HEAD'), deliveryId: readOwn(env, 'GITHUB_RUN_ID')},
    {repositoryId, workflowSha}, clock, loader
  );
  if (!fresh.ok) return blockedTrigger(fresh.reason);
  const {current, observed, observedMs} = fresh;
  if (!own(current, ['repositoryId', 'runId', 'head', 'status', 'conclusion', 'triggerEvent']) ||
      current.repositoryId !== repositoryId || current.runId !== workflowRunId ||
      !sha(current.head) || current.status !== 'completed' ||
      !checkConclusions.has(current.conclusion) || typeof current.triggerEvent !== 'string' ||
      !/^[a-z_]{1,40}$/.test(current.triggerEvent)) {
    return blockedTrigger('IDENTITY_UNKNOWN');
  }
  if (current.head !== observed.head) return blockedTrigger('HEAD_CHANGED');
  return {
    shadow: true, evidenceComplete: false, reconciled: true, reason: 'CHECK_IDENTITY_MATCHED',
    repositoryId, workflowRunId, head: current.head, status: current.status,
    conclusion: current.conclusion, triggerEvent: current.triggerEvent,
    workflowSha, runId: observed.deliveryId, observedMs
  };
}

/** Bind one protected push trigger to a fresh repository and protected branch head read. */
export async function reconcileMainTrigger(env, options = {}) {
  if (!ownOptional(options, reconcileOptionKeys)) return blockedTrigger('TRUST_UNKNOWN');
  const resolved = resolveTrustedScope(options);
  if (!resolved) return blockedTrigger('TRUST_UNKNOWN');
  const workflowSha = verifyWorkflowProvenance(env, resolved, 'push', true);
  if (!workflowSha) return blockedTrigger('TRUST_UNKNOWN');
  const mainHead = readOwn(env, 'FACTORY_MAIN_HEAD', workflowSha);
  if (mainHead !== workflowSha) return blockedTrigger('TRUST_UNKNOWN');
  const clock = readOwn(options, 'clock', Date.now);
  const request = readOwn(options, 'request', fetch);
  const readIdentity = readOwn(options, 'readIdentity');
  const {repositoryId} = resolved;
  const loader = readIdentity
    ? () => readIdentity()
    : () => readMainIdentity(request, explicitScopeFrom(resolved));
  const fresh = await observeFresh(
    {repositoryId, workflowSha, kind: 'main', head: mainHead, deliveryId: readOwn(env, 'GITHUB_RUN_ID')},
    {repositoryId, workflowSha}, clock, loader
  );
  if (!fresh.ok) return blockedTrigger(fresh.reason);
  const {current, observed, observedMs} = fresh;
  if (!own(current, ['repositoryId', 'branch', 'head', 'branchProtected']) ||
      current.repositoryId !== repositoryId || current.branch !== resolved.branch ||
      current.branchProtected !== true || !sha(current.head)) {
    return blockedTrigger('IDENTITY_UNKNOWN');
  }
  if (current.head !== observed.head) return blockedTrigger('HEAD_CHANGED');
  return {
    shadow: true, evidenceComplete: false, reconciled: true, reason: 'MAIN_IDENTITY_MATCHED',
    repositoryId, branch: current.branch, head: current.head, branchProtected: true,
    workflowSha, runId: observed.deliveryId, observedMs
  };
}

/** Build a fresh scoped metadata reader for event-journal claims across all event kinds. */
export function createScopedJournalReader(scope = {}, readerOptions = {}) {
  const resolved = resolveTrustedScope(scope);
  if (!resolved || !ownOptional(readerOptions, ['request', 'reviewHint', 'getActiveDeliveryId'])) {
    return async () => null;
  }
  const request = readOwn(readerOptions, 'request', fetch);
  const reviewHint = readOwn(readerOptions, 'reviewHint', null);
  const getActiveDeliveryId = readOwn(readerOptions, 'getActiveDeliveryId', null);
  if (reviewHint !== null && !own(reviewHint, ['deliveryId', 'subject', 'reviewId'])) {
    return async () => null;
  }
  return async ticket => {
    if (!own(ticket, ['repositoryId', 'kind', 'subject', 'head']) ||
        !ownOptional(ticket, ['deliveryId']) ||
        ticket.repositoryId !== resolved.repositoryId) return null;
    const explicitScope = explicitScopeFrom(resolved);
    if (ticket.kind === 'pull') {
      const p = await readPullIdentity(ticket.subject, request, explicitScope);
      return p.reason === 'IDENTITY_ONLY'
        ? {shadow: true, fresh: true, repositoryId: resolved.repositoryId, kind: 'pull', subject: ticket.subject, head: p.head}
        : null;
    }
    if (ticket.kind === 'review') {
      const activeDeliveryId = readOwn(ticket, 'deliveryId') ??
        (typeof getActiveDeliveryId === 'function' ? getActiveDeliveryId() : null);
      if (reviewHint && activeDeliveryId === reviewHint.deliveryId &&
          reviewHint.subject === ticket.subject && positive(reviewHint.reviewId)) {
        const r = await readReviewIdentity(ticket.subject, reviewHint.reviewId, request, explicitScope);
        if (r.reason !== 'IDENTITY_ONLY') return null;
        const freshHead = r.head === r.commitId ? r.head : (r.head !== ticket.head ? r.head : null);
        return freshHead
          ? {shadow: true, fresh: true, repositoryId: resolved.repositoryId, kind: 'review', subject: ticket.subject, head: freshHead}
          : null;
      }
      // Without the exact triggering review ID, supersede only moved PR heads;
      // leave unchanged-head review claims unacknowledged rather than matching unrelated reviews.
      const p = await readPullIdentity(ticket.subject, request, explicitScope);
      if (p.reason !== 'IDENTITY_ONLY' || p.head === ticket.head) return null;
      return {shadow: true, fresh: true, repositoryId: resolved.repositoryId, kind: 'review', subject: ticket.subject, head: p.head};
    }
    if (ticket.kind === 'check') {
      const c = await readCheckRunIdentity(ticket.subject, request, explicitScope);
      return c.reason === 'IDENTITY_ONLY'
        ? {shadow: true, fresh: true, repositoryId: resolved.repositoryId, kind: 'check', subject: ticket.subject, head: c.head}
        : null;
    }
    if (ticket.kind === 'main') {
      if (ticket.subject !== 0) return null;
      const m = await readMainIdentity(request, explicitScope);
      return m.reason === 'IDENTITY_ONLY'
        ? {shadow: true, fresh: true, repositoryId: resolved.repositoryId, kind: 'main', subject: 0, head: m.head}
        : null;
    }
    if ((ticket.kind !== 'issue' && ticket.kind !== 'manual') || !positive(ticket.subject)) return null;
    const [issueRes, m] = await Promise.all([
      readPublicGitHubJson(`${resolved.apiRoot}/issues/${ticket.subject}`, request),
      readMainIdentity(request, explicitScope)
    ]);
    if (!issueRes.ok || m.reason !== 'IDENTITY_ONLY') return null;
    const issue = issueRes.value;
    if (issue?.number !== ticket.subject || issue.repository_url !== resolved.apiRoot ||
        Object.hasOwn(issue, 'pull_request') || !['open', 'closed'].includes(issue.state)) {
      return null;
    }
    return {
      shadow: true, fresh: true, repositoryId: resolved.repositoryId,
      kind: ticket.kind, subject: ticket.subject, head: m.head
    };
  };
}

const supportedTriggerEvents = new Set([
  'pull_request_target', 'pull_request_review', 'workflow_run', 'push', 'issues', 'workflow_dispatch'
]);

/** Enqueue and reconcile a trusted GitHub trigger through event-journal with optional snapshot state. */
export async function reconcileEventTrigger(env, options = {}) {
  const blocked = (reason, extra = {}) => ({
    shadow: true, evidenceComplete: false, reconciled: false,
    liveDispatch: false, liveMerge: false, reason, ...extra
  });
  if (!ownOptional(options, reconcileOptionKeys) || !ownOptional(env, provenanceEnvKeys)) {
    return blocked('TRUST_UNKNOWN');
  }
  const resolved = resolveTrustedScope(options);
  if (!resolved) return blocked('TRUST_UNKNOWN');
  const eventName = readOwn(env, 'GITHUB_EVENT_NAME');
  if (!supportedTriggerEvents.has(eventName)) return blocked('TRUST_UNKNOWN');
  const requireRef = eventName !== 'pull_request_target' && eventName !== 'pull_request_review';
  const workflowSha = verifyWorkflowProvenance(env, resolved, eventName, requireRef);
  if (!workflowSha) return blocked('TRUST_UNKNOWN');

  let kind;
  let subject = 0;
  let head = workflowSha;
  let reviewId = 0;
  if (eventName === 'pull_request_target') {
    subject = parsePositiveId(readOwn(env, 'FACTORY_PULL_NUMBER'));
    if (!subject) return blocked('INVALID_PULL');
    kind = 'pull';
    head = readOwn(env, 'FACTORY_PULL_HEAD');
  } else if (eventName === 'pull_request_review') {
    subject = parsePositiveId(readOwn(env, 'FACTORY_PULL_NUMBER'));
    if (!subject) return blocked('INVALID_PULL');
    reviewId = parsePositiveId(readOwn(env, 'FACTORY_REVIEW_ID'));
    if (!reviewId) return blocked('INVALID_REVIEW');
    kind = 'review';
    head = readOwn(env, 'FACTORY_PULL_HEAD');
  } else if (eventName === 'workflow_run') {
    subject = parsePositiveId(readOwn(env, 'FACTORY_WORKFLOW_RUN_ID'));
    if (!subject) return blocked('INVALID_CHECK');
    kind = 'check';
    head = readOwn(env, 'FACTORY_CHECK_HEAD');
  } else if (eventName === 'push') {
    const mainHead = readOwn(env, 'FACTORY_MAIN_HEAD', workflowSha);
    if (mainHead !== workflowSha) return blocked('TRUST_UNKNOWN');
    kind = 'main';
    head = mainHead;
  } else {
    subject = parsePositiveId(readOwn(env, 'FACTORY_ISSUE_NUMBER'));
    if (!subject) return blocked('INVALID_ISSUE');
    kind = eventName === 'workflow_dispatch' ? 'manual' : 'issue';
  }

  const clock = readOwn(options, 'clock', Date.now);
  const request = readOwn(options, 'request', fetch);
  const journal = readOwn(options, 'journal');
  const snapshot = readOwn(options, 'snapshot');
  const owner = readOwn(options, 'owner', 'github-actions');
  const leaseMs = readOwn(options, 'leaseMs', 30000);
  const deferUnknown = readOwn(options, 'deferUnknown');
  const now = clock();
  const trust = {repositoryId: resolved.repositoryId, workflowSha};
  const observed = eventEnvelope({
    repositoryId: resolved.repositoryId, workflowSha, kind, head,
    deliveryId: readOwn(env, 'GITHUB_RUN_ID'), receivedMs: now
  }, trust, now);
  if (!observed.accepted) return blocked(observed.reason);

  const explicitScope = explicitScopeFrom(resolved);
  const ownedJournal = journal === undefined ? openEventJournal(':memory:') : null;
  const store = journal ?? ownedJournal;
  try {
    if (snapshot !== undefined) {
      const imported = importJournalSnapshot(store, snapshot);
      if (!imported.imported) return blocked(imported.reason);
    }
    if (!store || typeof store.enqueue !== 'function' ||
        typeof store.claim !== 'function' || typeof store.complete !== 'function') {
      return blocked('JOURNAL_UNAVAILABLE');
    }
    const beforeExport = exportJournalSnapshot(store, {repositoryId: resolved.repositoryId});
    const alreadyCompleted = beforeExport.exported &&
      beforeExport.entries.some(row => row.deliveryId === observed.deliveryId && row.completed);
    const queued = store.enqueue({
      repositoryId: resolved.repositoryId, deliveryId: observed.deliveryId,
      kind, subject, head: observed.head
    });
    if (!queued.queued && queued.reason !== 'DUPLICATE_DELIVERY') return blocked(queued.reason);
    if (queued.reason === 'DUPLICATE_DELIVERY' && alreadyCompleted) {
      return blocked('DUPLICATE_DELIVERY', {
        repositoryId: resolved.repositoryId, kind, subject, runId: observed.deliveryId,
        snapshot: beforeExport
      });
    }

    let claimedDeliveryId = null;
    const trackedStore = {
      claim(...args) {
        const ticket = store.claim(...args);
        claimedDeliveryId = ticket?.deliveryId ?? null;
        return ticket;
      },
      complete(...args) {
        return store.complete(...args);
      }
    };
    const read = createScopedJournalReader(explicitScope, {
      request,
      reviewHint: kind === 'review' ? {deliveryId: observed.deliveryId, subject, reviewId} : null,
      getActiveDeliveryId: () => claimedDeliveryId
    });
    const outcome = await reconcileJournalOnce({
      journal: trackedStore, repositoryId: resolved.repositoryId, owner, leaseMs,
      clock, read, stop: false, deferUnknown
    });
    const exported = exportJournalSnapshot(store, {repositoryId: resolved.repositoryId});
    const extra = exported.exported ? {snapshot: exported} : {};
    if (claimedDeliveryId !== observed.deliveryId) {
      const pendingReason = claimedDeliveryId === null
        ? (outcome.reason === 'NO_CLAIM' ? 'CLAIM_PENDING' : outcome.reason)
        : 'QUEUED';
      return blocked(pendingReason, {
        repositoryId: resolved.repositoryId, kind, subject, head: observed.head,
        workflowSha, runId: observed.deliveryId,
        ...(claimedDeliveryId !== null ? {recoveredDeliveryId: claimedDeliveryId, recoveryReason: outcome.reason} : {}),
        ...extra
      });
    }
    return {
      shadow: true, evidenceComplete: false, reconciled: outcome.reason === 'SHADOW_RECONCILED',
      liveDispatch: false, liveMerge: false, reason: outcome.reason,
      repositoryId: resolved.repositoryId, kind, subject, head: observed.head,
      workflowSha, runId: observed.deliveryId, ...extra
    };
  } finally {
    ownedJournal?.close();
  }
}
