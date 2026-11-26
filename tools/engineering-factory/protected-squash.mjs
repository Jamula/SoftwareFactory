import {types} from 'node:util';
import {evaluate, validPolicy} from './core.mjs';
import {coverageEvidence} from './coverage-evidence.mjs';
import {normalizeReviewHistory} from './review-history.mjs';
import {platformMergeGates} from './platform-merge-gates.mjs';

const repository = 'Jamula/SoftwareFactory';
const repositoryId = 1471342715;
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const object = (value, keys) => value !== null && typeof value === 'object' &&
  !types.isProxy(value) && !Array.isArray(value) &&
  keys.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
const array = (value, fields, limit = 250) => !types.isProxy(value) && Array.isArray(value) &&
  Object.getPrototypeOf(value) === Array.prototype && value.length <= limit &&
  Reflect.ownKeys(value).length === value.length + 1 &&
  Array.from({length: value.length}, (_, index) => Object.getOwnPropertyDescriptor(value, index))
    .every(descriptor => Object.hasOwn(descriptor ?? {}, 'value') && object(descriptor.value, fields));
// The composed evaluators operate on normalized JSON data. Reject accessor
// properties, proxies, custom prototypes and oversized/cyclic inputs first.
function plain(value, budget = {remaining: 10000}, depth = 0) {
  if (--budget.remaining < 0 || depth > 8 || types.isProxy(value)) return false;
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== (Array.isArray(value) ? Array.prototype : Object.prototype)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length <= 256 && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && Object.hasOwn(descriptor, 'value') &&
      plain(descriptor.value, budget, depth + 1);
  });
}
const blocked = reason => ({shadow: true, liveMerge: false, dependentWorkAllowed: false, reason});
const scope = ['repository', 'repositoryId', 'branch'];
const inScope = data => object(data, scope) && data.repository === repository &&
  data.repositoryId === repositoryId && data.branch === 'main';
const validIntent = intent => inScope(intent) &&
  object(intent, ['number', 'expectedHead', 'expectedBase']) &&
  Number.isSafeInteger(intent.number) && intent.number > 0 &&
  sha(intent.expectedHead) && sha(intent.expectedBase) && intent.expectedHead !== intent.expectedBase;
const binds = (data, intent) => inScope(data) && object(data, ['number', 'head', 'base']) &&
  data.number === intent.number && data.head === intent.expectedHead && data.base === intent.expectedBase;
const sameHead = (evidence, head, field) =>
  object(evidence, ['head', field]) && evidence.head === head && evidence[field] === true;

function passesProtection(protection, policy, base) {
  return inScope(protection) && object(protection, ['base', 'verified', 'protected', 'bypass', 'method', 'upToDate',
    'review', 'threads', 'security', 'requiredChecks']) &&
    protection.base === base && protection.verified === true && protection.protected === true &&
    protection.bypass === false && protection.method === 'squash' &&
    [protection.upToDate, protection.review, protection.threads, protection.security].every(x => x === true) &&
    array(protection.requiredChecks, ['name', 'appId']) && protection.requiredChecks.length > 0 &&
    protection.requiredChecks.every(required => policy.checks.some(check =>
      check.name === required.name && check.appId === required.appId));
}

/** Normalize independently obtained receipts for a current, protected candidate. */
export function guardedSquashEvidence(intent, evidence) {
  if (!validIntent(intent)) return blocked('INTENT_UNKNOWN');
  if (!binds(evidence, intent)) return blocked('SCOPE_OR_HEAD_CHANGED');
  if (!object(evidence, ['open', 'draft', 'stop', 'scopeVerified', 'nativeQueue',
    'protection', 'policy', 'snapshot', 'reviewHistory', 'coverageReports',
    'expectedComponents', 'threads', 'security', 'platformReview'])) return blocked('EVIDENCE_UNKNOWN');
  if (evidence.open !== true || evidence.draft !== false || evidence.stop !== false ||
      evidence.scopeVerified !== true) return blocked('STOPPED_OR_UNAUTHORIZED');
  if (evidence.nativeQueue !== false) return blocked('QUEUE_PATH_REQUIRED');
  const {policy, snapshot, threads, security, reviewHistory} = evidence;
  if (!plain(policy) || !validPolicy(policy) || policy.repository !== repository || policy.defaultBranch !== 'main' ||
      policy.mergeMethod !== 'squash' || !passesProtection(evidence.protection, policy, intent.expectedBase))
    return blocked('PROTECTIONS_UNVERIFIED');
  if (!plain(snapshot) || !object(snapshot, ['head', 'base', 'pr']) || snapshot.head !== intent.expectedHead ||
      snapshot.base !== intent.expectedBase || snapshot.pr !== intent.number)
    return blocked('SCOPE_OR_HEAD_CHANGED');
  if (!sameHead(threads, intent.expectedHead, 'resolved') ||
      !sameHead(security, intent.expectedHead, 'clear')) return blocked('THREADS_OR_SECURITY_UNKNOWN');
  if (!plain(reviewHistory) || !array(reviewHistory, ['sequence', 'reviewer', 'head', 'state']))
    return blocked('REVIEW_UNVERIFIED');
  const normalized = normalizeReviewHistory(intent.expectedHead, reviewHistory, repository);
  if (!normalized.ok) return blocked('REVIEW_UNVERIFIED');
  const coverage = coverageEvidence(intent.expectedHead, evidence.expectedComponents, evidence.coverageReports);
  if (!coverage.valid || evidence.coverageReports.some(row =>
      row.lines * 100 < policy.coverage.line * row.lineTotal ||
      row.branches * 100 < policy.coverage.branch * row.branchTotal)) return blocked('COVERAGE_UNVERIFIED');
  const decision = evaluate(policy, {...snapshot, reviews: normalized.reviews, threadsResolved: true,
    securityClear: true, coverage: {head: intent.expectedHead, complete: true,
      line: coverage.lines * 100 / coverage.lineTotal, branch: coverage.branches * 100 / coverage.branchTotal}});
  if (decision.state !== 'eligible') return blocked(decision.reason);
  const platform = platformMergeGates(intent.expectedHead,
    {repositoryId, trusted: true, required: evidence.protection.requiredChecks},
    {head: intent.expectedHead, complete: true, checks: snapshot.checks, review: evidence.platformReview,
      coverageVerified: true, securityClear: true, threadsResolved: true,
      baseHealthy: true, independentFavorable: true});
  return blocked(platform.eligible ? 'SHADOW_SQUASH_ELIGIBLE' : platform.reason);
}

/** A single shadow controller serializes mock squashes and holds uncertain outcomes. */
export function createShadowSquashController(transport) {
  if (!object(transport, ['mode', 'readCandidate', 'simulateSquash', 'readMergeReceipt', 'readMain']) ||
      transport.mode !== 'shadow' ||
      ![transport.readCandidate, transport.simulateSquash, transport.readMergeReceipt, transport.readMain]
        .every(fn => typeof fn === 'function')) throw new TypeError('INVALID_SHADOW_SQUASH_TRANSPORT');
  let busy = false;
  let pending;
  let verifiedMain;

  function verifyReceipt(intent, receipt) {
    if (!binds(receipt, intent) || !object(receipt, ['method', 'mergeCommit', 'merged']) ||
        receipt.merged !== true || receipt.method !== 'squash' || !sha(receipt.mergeCommit) ||
        [intent.expectedHead, intent.expectedBase].includes(receipt.mergeCommit))
      return blocked('MERGE_RECEIPT_UNKNOWN');
    return {...blocked('MAIN_VERIFICATION_REQUIRED'), mergeCommit: receipt.mergeCommit};
  }

  async function verify(intent, receipt) {
    const result = verifyReceipt(intent, receipt);
    if (!result.mergeCommit) return result;
    const main = await transport.readMain();
    if (!inScope(main) || !object(main, ['head', 'healthy', 'stop']) ||
        main.head !== result.mergeCommit || main.healthy !== true || main.stop !== false) return result;
    verifiedMain = result.mergeCommit;
    pending = undefined;
    return {...blocked('SHADOW_MAIN_VERIFIED'), dependentWorkAllowed: true, mergeCommit: result.mergeCommit};
  }

  return Object.freeze({
    async run(intent) {
      if (!validIntent(intent)) return blocked('INTENT_UNKNOWN');
      if (busy || pending) return blocked('SERIALIZED_OR_RECOVERY_REQUIRED');
      if (verifiedMain && intent.expectedBase !== verifiedMain) return blocked('BASE_MOVED_SINCE_VERIFICATION');
      busy = true;
      const target = Object.freeze({repository, repositoryId, branch: 'main', number: intent.number,
        expectedHead: intent.expectedHead, expectedBase: intent.expectedBase, method: 'squash'});
      try {
        const decision = guardedSquashEvidence(target, await transport.readCandidate(target));
        if (decision.reason !== 'SHADOW_SQUASH_ELIGIBLE') return decision;
        pending = target;
        return await verify(target, await transport.simulateSquash(target));
      } catch { return blocked(pending ? 'RECOVERY_REQUIRED' : 'FRESH_EVIDENCE_UNAVAILABLE'); }
      finally { busy = false; }
    },
    async reconcile() {
      if (busy || !pending) return blocked('NO_RECOVERABLE_INTENT');
      busy = true;
      try { return await verify(pending, await transport.readMergeReceipt(pending)); }
      catch { return blocked('RECOVERY_REQUIRED'); }
      finally { busy = false; }
    }
  });
}
