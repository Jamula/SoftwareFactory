import {createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {openEventJournal, reconcileJournalOnce} from '../engineering-coordinator/event-journal.mjs';
import {ownOptional, readOwn, readPublicGitHubJson, readPullIdentity, resolveTrustedScope} from './event-envelope.mjs';

// Optional local diagnostic harness only. Under Roadmap v2, GitHub is the
// orchestrator and local polling is never an operational host or lease authority.
export const LOCAL_DIAGNOSTIC_ONLY = true;

const intervalMs = 600000;
const retryDelayMs = 3600000;
const hostOptionKeys = [
  'scope', 'repository', 'repositoryId', 'branch', 'workflowPath',
  'journal', 'owner', 'clock', 'request', 'signal', 'cursor',
  'diagnosticOnly', 'hosted', 'enabled', 'path', 'write', 'wait', 'open'
];
const validOwner = owner => typeof owner === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(owner);
const receipt = (reason, extra = {}) => ({shadow: true, liveDispatch: false, liveMerge: false, reason, ...extra});
const isIdentity = (p, repositoryId, number) =>
  p?.reason === 'IDENTITY_ONLY' && p.repositoryId === repositoryId && p.number === number;

// Read at most one PR-only page each tick. Identity reads have their own
// reserved budget; unrelated issues cannot consume it. Cursor is advisory,
// never grants authority, and can restart at page one after host restart.
async function readPage(request, page, apiRoot) {
  const res = await readPublicGitHubJson(
    `${apiRoot}/pulls?state=open&sort=created&direction=asc&per_page=1&page=${page}`,
    request
  );
  if (!res.ok) throw Error('PULL_PAGE_UNAVAILABLE');
  const rows = res.value;
  if (!Array.isArray(rows) || rows.length > 1 || rows.some(r => !Number.isSafeInteger(r?.number) || r.number < 1)) {
    throw Error('PULL_PAGE_INVALID');
  }
  return rows;
}

// One bounded read-only local diagnostic pass. At most three GETs (page, identity,
// reconciliation), including at most one recovery claim. Inventory gets its own
// page/identity budget even when recovery has a pending or deferred result.
// No mutation after cancellation; refuses hosted/operational invocation.
export async function localReconcileTick(options = {}) {
  if (!ownOptional(options, hostOptionKeys)) return receipt('TRUST_UNKNOWN');
  const resolved = resolveTrustedScope(options);
  if (!resolved) return receipt('TRUST_UNKNOWN');
  const journal = readOwn(options, 'journal');
  const owner = readOwn(options, 'owner');
  const clock = readOwn(options, 'clock', Date.now);
  const request = readOwn(options, 'request', fetch);
  const signal = readOwn(options, 'signal', new AbortController().signal);
  const cursor = readOwn(options, 'cursor', {page: 1});
  const diagnosticOnly = readOwn(options, 'diagnosticOnly', true);
  const hosted = readOwn(options, 'hosted', false);
  if (diagnosticOnly !== true || hosted === true) return receipt('LOCAL_DIAGNOSTIC_ONLY');
  if (!validOwner(owner)) return receipt('INVALID_OWNER');
  const {repositoryId, apiRoot} = resolved;
  const pullScope = {
    repository: resolved.repository,
    repositoryId,
    branch: resolved.branch,
    workflowPath: resolved.workflowPath
  };
  const stopped = () => signal.aborted;
  // Preserve a completed recovery receipt even if the independent inventory pass fails.
  let finish = receipt;
  const budgeted = (url, reqOptions) => {
    signal.throwIfAborted();
    return request(url, {...reqOptions, signal: AbortSignal.any([reqOptions.signal, signal])});
  };
  const guarded = {
    claim(...args) { signal.throwIfAborted(); return journal.claim(...args, 'pull'); },
    complete(...args) { signal.throwIfAborted(); return journal.complete(...args); }
  };
  const deferUnknown = (ticket, finished) => {
    signal.throwIfAborted();
    return journal.defer(ticket, finished, retryDelayMs);
  };
  const read = async ticket => {
    if (ticket.kind !== 'pull') return null;
    const p = await readPullIdentity(ticket.subject, budgeted, pullScope);
    signal.throwIfAborted();
    if (!isIdentity(p, repositoryId, ticket.subject)) return null;
    return {shadow: true, fresh: true, repositoryId, kind: 'pull', subject: ticket.subject, head: p.head};
  };
  try {
    signal.throwIfAborted();
    const recovery = await reconcileJournalOnce({
      journal: guarded, repositoryId, owner, leaseMs: 30000, clock, read, stop: false, deferUnknown
    });
    signal.throwIfAborted();
    if (!['NO_CLAIM', 'SHADOW_RECONCILED', 'SHADOW_HEAD_SUPERSEDED', 'EVIDENCE_UNKNOWN'].includes(recovery.reason)) {
      return receipt(recovery.reason);
    }
    finish = reason => recovery.reason === 'NO_CLAIM'
      ? receipt(reason)
      : receipt(recovery.reason, {inventoryReason: reason});
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) return finish('CLOCK_UNKNOWN');
    const rows = await readPage(budgeted, cursor.page, apiRoot);
    signal.throwIfAborted();
    if (!rows.length) {
      const reason = cursor.page === 1 ? 'NO_OPEN_PULLS' : 'SWEEP_COMPLETE';
      cursor.page = 1;
      return finish(reason);
    }
    const number = rows[0].number;
    const p = await readPullIdentity(number, budgeted, pullScope);
    signal.throwIfAborted();
    cursor.page++;
    if (!isIdentity(p, repositoryId, number)) return finish('IDENTITY_UNKNOWN');
    const deliveryId = createHash('sha256')
      .update(JSON.stringify([repositoryId, number, p.head, p.base, p.state, p.draft]))
      .digest('hex');
    const queued = journal.enqueue({repositoryId, deliveryId, kind: 'pull', subject: number, head: p.head});
    if (!queued.queued) return finish(queued.reason);
    // A recovery claim already consumed this tick's reconciliation slot. The
    // fresh inventory hint remains queued for the next eligible recovery.
    if (recovery.reason !== 'NO_CLAIM') return finish('QUEUED');
    const reconciled = await reconcileJournalOnce({
      journal: guarded, repositoryId, owner, leaseMs: 30000, clock, read, stop: false, deferUnknown
    });
    signal.throwIfAborted();
    return receipt(reconciled.reason);
  } catch {
    return stopped() ? receipt('STOPPED') : finish('LOCAL_POLL_UNAVAILABLE');
  }
}

// Optional local diagnostic loop on a workstation with a local SQLite path.
// Refuses hosted/operational invocation and never launches workers, sets
// repository variables, authorizes writes, installs a service, or provisions resources.
export async function runLocalShadowHost(options = {}) {
  if (!ownOptional(options, hostOptionKeys)) return receipt('TRUST_UNKNOWN');
  const resolved = resolveTrustedScope(options);
  if (!resolved) return receipt('TRUST_UNKNOWN');
  const enabled = readOwn(options, 'enabled');
  const path = readOwn(options, 'path');
  const owner = readOwn(options, 'owner');
  const signal = readOwn(options, 'signal');
  const clock = readOwn(options, 'clock', Date.now);
  const request = readOwn(options, 'request', fetch);
  const write = readOwn(options, 'write', console.log);
  const wait = readOwn(options, 'wait', sleep);
  const open = readOwn(options, 'open', openEventJournal);
  const diagnosticOnly = readOwn(options, 'diagnosticOnly', true);
  const hosted = readOwn(options, 'hosted', false);
  if (diagnosticOnly !== true || hosted === true) return receipt('LOCAL_DIAGNOSTIC_ONLY');
  if (enabled !== true || signal.aborted) return receipt('STOPPED');
  if (!validOwner(owner)) return receipt('INVALID_OWNER');
  const scope = {
    repository: resolved.repository,
    repositoryId: resolved.repositoryId,
    branch: resolved.branch,
    workflowPath: resolved.workflowPath
  };
  let journal;
  try {
    journal = open(path);
    const cursor = {page: 1};
    while (!signal.aborted) {
      write(JSON.stringify(await localReconcileTick({journal, owner, clock, request, signal, cursor, scope})));
      if (signal.aborted) break;
      await wait(intervalMs, undefined, {signal});
    }
    return receipt('STOPPED');
  } catch {
    return receipt(signal.aborted ? 'STOPPED' : 'LOCAL_HOST_UNAVAILABLE');
  } finally {
    journal?.close();
  }
}
