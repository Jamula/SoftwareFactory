import {types} from 'node:util';
import {evaluate, validPolicy} from './core.mjs';
import {coverageEvidence} from './coverage-evidence.mjs';
import {buildCandidateReviewEvidence, normalizeReviewHistory} from './review-history.mjs';
import {platformMergeGates} from './platform-merge-gates.mjs';
import {readBranchHealth, readCandidatePullMetadata} from './pull-signals.mjs';

const defaultChecks = Object.freeze([
  'build-test',
  'upload-coverage-javascript',
  'windows-aspire-runtime',
  'CodeQL'
]);
export const DEFAULT_FACTORY_SCOPE = Object.freeze({
  repository: 'Jamula/SoftwareFactory',
  repositoryId: 1471342715,
  branch: 'main',
  requiredChecks: defaultChecks
});

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const validRepo = value => typeof value === 'string' &&
  /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(value) &&
  !value.split('/').some(part => part === '.' || part === '..');
const validBranch = value => typeof value === 'string' &&
  /^[A-Za-z0-9_./-]{1,120}$/.test(value) &&
  !value.startsWith('/') && !value.endsWith('/') && !value.includes('//') &&
  !value.split('/').some(part => part === '.' || part === '..');
const componentName = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,79}$/.test(value);
const countPair = (covered, total) => Number.isSafeInteger(covered) && Number.isSafeInteger(total) &&
  covered >= 0 && total > 0 && covered <= total && total <= 100000000;
const object = (value, keys) => value !== null && typeof value === 'object' &&
  !types.isProxy(value) && !Array.isArray(value) &&
  keys.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
const denseList = (value, limit = 250) => !types.isProxy(value) && Array.isArray(value) &&
  Object.getPrototypeOf(value) === Array.prototype && value.length <= limit &&
  Reflect.ownKeys(value).length === value.length + 1 &&
  Array.from({length: value.length}, (_, index) =>
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, index) ?? {}, 'value')).every(Boolean);
const array = (value, fields, limit = 250) => denseList(value, limit) &&
  value.every(item => object(item, fields));

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

function normalizeScope(rawScope, policy) {
  if (!object(rawScope, ['repository', 'repositoryId']) ||
      !validRepo(rawScope.repository) || !positive(rawScope.repositoryId)) return null;
  const hasBranch = Object.hasOwn(Object.getOwnPropertyDescriptor(rawScope, 'branch') ?? {}, 'value');
  const branch = hasBranch ? rawScope.branch : 'main';
  if (!validBranch(branch)) return null;
  const isFactory = rawScope.repository.toLowerCase() === 'jamula/softwarefactory';
  const hasRequired = Object.hasOwn(Object.getOwnPropertyDescriptor(rawScope, 'requiredChecks') ?? {}, 'value');
  let requiredChecks;
  if (hasRequired) {
    if (!denseList(rawScope.requiredChecks, 32) || rawScope.requiredChecks.length === 0 ||
        rawScope.requiredChecks.some(name => typeof name !== 'string' || name.length === 0) ||
        new Set(rawScope.requiredChecks).size !== rawScope.requiredChecks.length) return null;
    requiredChecks = [...rawScope.requiredChecks];
  } else if (isFactory) {
    requiredChecks = [...defaultChecks];
  } else if (Array.isArray(policy?.checks) && policy.checks.length > 0 &&
      policy.checks.every(c => object(c, ['name']) && typeof c.name === 'string' && c.name.length > 0)) {
    requiredChecks = policy.checks.map(c => c.name);
  } else {
    return null;
  }
  return Object.freeze({
    repository: rawScope.repository,
    repositoryId: rawScope.repositoryId,
    branch,
    requiredChecks: Object.freeze(requiredChecks)
  });
}

const blocked = reason => ({shadow: true, liveMerge: false, dependentWorkAllowed: false, reason});
const scopeFields = ['repository', 'repositoryId', 'branch'];
const inScope = (data, activeScope) => object(data, scopeFields) &&
  data.repository === activeScope.repository &&
  data.repositoryId === activeScope.repositoryId &&
  data.branch === activeScope.branch;
const validIntent = (intent, activeScope) => inScope(intent, activeScope) &&
  object(intent, ['number', 'expectedHead', 'expectedBase']) &&
  positive(intent.number) &&
  sha(intent.expectedHead) && sha(intent.expectedBase) && intent.expectedHead !== intent.expectedBase;
const binds = (data, intent, activeScope) => inScope(data, activeScope) &&
  object(data, ['number', 'head', 'base']) &&
  data.number === intent.number && data.head === intent.expectedHead && data.base === intent.expectedBase;
const sameHead = (evidence, head, field) =>
  object(evidence, ['head', field]) && evidence.head === head && evidence[field] === true;

function passesProtection(protection, policy, base, activeScope) {
  if (!plain(protection) || !inScope(protection, activeScope) ||
      !object(protection, ['base', 'verified', 'protected', 'bypass', 'method', 'upToDate',
        'review', 'threads', 'security', 'requiredChecks'])) return false;
  const isFactory = activeScope.repository.toLowerCase() === 'jamula/softwarefactory';
  const hasApprovalCount = Object.hasOwn(protection, 'requiredApprovingReviewCount');
  const reviewProtected = hasApprovalCount
    ? (Number.isSafeInteger(protection.requiredApprovingReviewCount) &&
       protection.requiredApprovingReviewCount >= 0 &&
       ((protection.requiredApprovingReviewCount >= 1 && protection.review === true) ||
        (isFactory && protection.requiredApprovingReviewCount === 0 &&
         protection.review === false && protection.hostedReviewGate === true)))
    : protection.review === true;
  return protection.base === base && protection.verified === true && protection.protected === true &&
    protection.bypass === false && protection.method === 'squash' &&
    reviewProtected &&
    [protection.upToDate, protection.threads, protection.security].every(x => x === true) &&
    array(protection.requiredChecks, ['name', 'appId']) && protection.requiredChecks.length > 0 &&
    protection.requiredChecks.every(required => policy.checks.some(check =>
      check.name === required.name && check.appId === required.appId));
}

function verifiedCoverage(head, expected, reports, policy, isFactory) {
  if (isFactory) {
    const factoryCoverage = coverageEvidence(head, expected, reports);
    if (!factoryCoverage.valid || reports.some(row =>
        row.lines * 100 < policy.coverage.line * row.lineTotal ||
        row.branches * 100 < policy.coverage.branch * row.branchTotal)) return null;
    return factoryCoverage;
  }
  if (!denseList(expected) || expected.length === 0 || !expected.every(componentName) ||
      new Set(expected).size !== expected.length ||
      !array(reports, ['component', 'head', 'lines', 'lineTotal', 'branches', 'branchTotal']) ||
      reports.length !== expected.length) return null;
  const minLine = Math.max(95, policy.coverage.line);
  const minBranch = Math.max(90, policy.coverage.branch);
  const seen = new Set();
  let lines = 0, lineTotal = 0, branches = 0, branchTotal = 0;
  for (const row of reports) {
    if (!expected.includes(row.component) || seen.has(row.component) || row.head !== head ||
        !countPair(row.lines, row.lineTotal) || !countPair(row.branches, row.branchTotal) ||
        row.lines * 100 < minLine * row.lineTotal ||
        row.branches * 100 < minBranch * row.branchTotal) return null;
    seen.add(row.component);
    lines += row.lines;
    lineTotal += row.lineTotal;
    branches += row.branches;
    branchTotal += row.branchTotal;
  }
  return {valid: true, lines, lineTotal, branches, branchTotal};
}

/** Normalize independently obtained receipts for a current, protected candidate. */
export function guardedSquashEvidence(intent, evidence, scope = DEFAULT_FACTORY_SCOPE) {
  const activeScope = normalizeScope(scope, evidence?.policy);
  if (!activeScope) return blocked('PROTECTIONS_UNVERIFIED');
  if (!validIntent(intent, activeScope)) return blocked('INTENT_UNKNOWN');
  if (!binds(evidence, intent, activeScope)) return blocked('SCOPE_OR_HEAD_CHANGED');
  if (!object(evidence, ['open', 'draft', 'stop', 'scopeVerified', 'nativeQueue',
    'protection', 'policy', 'snapshot', 'reviewHistory', 'coverageReports',
    'expectedComponents', 'threads', 'security', 'platformReview'])) return blocked('EVIDENCE_UNKNOWN');
  if (evidence.open !== true || evidence.draft !== false || evidence.stop !== false ||
      evidence.scopeVerified !== true) return blocked('STOPPED_OR_UNAUTHORIZED');
  if (evidence.nativeQueue !== false) return blocked('QUEUE_PATH_REQUIRED');
  const {policy, snapshot, threads, security, reviewHistory} = evidence;
  if (!plain(policy) || !validPolicy(policy) || policy.repository !== activeScope.repository ||
      policy.defaultBranch !== activeScope.branch || policy.mergeMethod !== 'squash' ||
      !passesProtection(evidence.protection, policy, intent.expectedBase, activeScope))
    return blocked('PROTECTIONS_UNVERIFIED');
  if (!plain(snapshot) || !object(snapshot, ['head', 'base', 'pr']) || snapshot.head !== intent.expectedHead ||
      snapshot.base !== intent.expectedBase || snapshot.pr !== intent.number)
    return blocked('SCOPE_OR_HEAD_CHANGED');
  if (!sameHead(threads, intent.expectedHead, 'resolved') ||
      !sameHead(security, intent.expectedHead, 'clear')) return blocked('THREADS_OR_SECURITY_UNKNOWN');
  if (!plain(reviewHistory) || !array(reviewHistory, ['sequence', 'reviewer', 'head', 'state']))
    return blocked('REVIEW_UNVERIFIED');
  const normalized = normalizeReviewHistory(intent.expectedHead, reviewHistory, activeScope.repository);
  if (!normalized.ok) return blocked('REVIEW_UNVERIFIED');
  const isFactory = activeScope.repository.toLowerCase() === 'jamula/softwarefactory';
  const coverage = verifiedCoverage(intent.expectedHead, evidence.expectedComponents,
    evidence.coverageReports, policy, isFactory);
  if (!coverage) return blocked('COVERAGE_UNVERIFIED');
  const decision = evaluate(policy, {...snapshot, reviews: normalized.reviews, threadsResolved: true,
    securityClear: true, coverage: {head: intent.expectedHead, complete: true,
      line: coverage.lines * 100 / coverage.lineTotal, branch: coverage.branches * 100 / coverage.branchTotal}});
  if (decision.state !== 'eligible') return blocked(decision.reason);
  const platform = platformMergeGates(intent.expectedHead,
    {repositoryId: activeScope.repositoryId, trusted: true, required: evidence.protection.requiredChecks},
    {head: intent.expectedHead, complete: true, checks: snapshot.checks, review: evidence.platformReview,
      coverageVerified: true, securityClear: true, threadsResolved: true,
      baseHealthy: true, independentFavorable: true},
    activeScope);
  return blocked(platform.eligible ? 'SHADOW_SQUASH_ELIGIBLE' : platform.reason);
}

/** Read-only GitHub API candidate-evidence aggregator feeding guardedSquashEvidence in shadow mode. */
export async function readProtectedSquashCandidate(intent, options) {
  if (!object(options, ['policy', 'issue', 'agent', 'coverageReports', 'expectedComponents', 'threads']) ||
      !plain(options.policy) || !validPolicy(options.policy)) {
    return {shadow: true, liveMerge: false, evidenceComplete: false, reason: 'POLICY_UNKNOWN'};
  }
  const activeScope = normalizeScope(options.scope ?? DEFAULT_FACTORY_SCOPE, options.policy);
  if (!activeScope) {
    return {shadow: true, liveMerge: false, evidenceComplete: false, reason: 'PROTECTIONS_UNVERIFIED'};
  }
  const isFactory = activeScope.repository.toLowerCase() === 'jamula/softwarefactory';
  const hostedReviewGate = isFactory && options.policy.reviewers.length > 0;
  const meta = await readCandidatePullMetadata(intent, {
    request: options.request ?? fetch,
    scope: activeScope,
    policyChecks: options.policy.checks,
    hostedReviewGate
  });
  if (!meta.evidenceComplete) return meta;

  const mainHealthy = activeScope.requiredChecks.every(name => {
    const pinned = options.policy.checks.find(c => c.name === name);
    const matches = meta.baseChecks.filter(c => c.name === name);
    return Boolean(pinned) && matches.length === 1 && matches[0].appId === pinned.appId &&
      matches[0].status === 'completed' && matches[0].conclusion === 'success';
  });
  const codeqlPolicy = options.policy.checks.find(c => c.name === 'CodeQL');
  const codeqlPassed = !codeqlPolicy || meta.checks.some(c =>
    c.name === 'CodeQL' && c.appId === codeqlPolicy.appId &&
    c.status === 'completed' && c.conclusion === 'success');
  const hasExplicitSecurity = Object.hasOwn(Object.getOwnPropertyDescriptor(options, 'security') ?? {}, 'value');
  const securityClear = meta.protection.security === true && codeqlPassed &&
    (hasExplicitSecurity ? sameHead(options.security, intent.expectedHead, 'clear') : true);

  const reviewEvidence = buildCandidateReviewEvidence(intent.expectedHead, meta.reviewRecords, {
    repository: activeScope.repository,
    reviewers: options.policy.reviewers,
    author: meta.author,
    agent: options.agent,
    inlineFindings: options.inlineFindings ?? []
  });

  return {
    repository: activeScope.repository,
    repositoryId: activeScope.repositoryId,
    branch: activeScope.branch,
    number: meta.number,
    head: meta.head,
    base: meta.base,
    open: meta.open,
    draft: meta.draft,
    stop: (options.stop ?? false) !== false,
    scopeVerified: meta.scopeVerified,
    nativeQueue: meta.nativeQueue,
    protection: meta.protection,
    policy: options.policy,
    snapshot: {
      repository: activeScope.repository,
      policySource: 'trusted-default-branch',
      pr: meta.number,
      issue: options.issue,
      head: meta.head,
      base: meta.base,
      observedHead: meta.head,
      observedBase: meta.base,
      baseBranch: activeScope.branch,
      rateLimited: false,
      remainingCredits: options.remainingCredits ?? 1,
      activeCount: options.activeCount ?? 0,
      providerReady: options.providerReady ?? true,
      risk: options.risk ?? 'low',
      priority: options.priority ?? 1,
      paths: meta.paths,
      dependencies: options.dependencies ?? [],
      acceptanceComplete: options.acceptanceComplete ?? true,
      baseCompatible: meta.baseCompatible,
      mainHealthy,
      author: meta.author,
      agent: options.agent,
      checks: meta.checks
    },
    reviewHistory: reviewEvidence.ok ? reviewEvidence.reviewHistory : null,
    coverageReports: options.coverageReports,
    expectedComponents: options.expectedComponents,
    threads: options.threads,
    security: {head: intent.expectedHead, clear: securityClear},
    platformReview: reviewEvidence.ok ? reviewEvidence.platformReview : null
  };
}

/** Build a read-only GitHub shadow transport for createShadowSquashController (liveMerge remains false). */
export function createGitHubShadowTransport(options) {
  if (!object(options, ['policy', 'simulateSquash', 'readMergeReceipt']) ||
      !plain(options.policy) || !validPolicy(options.policy) ||
      typeof options.simulateSquash !== 'function' || typeof options.readMergeReceipt !== 'function') {
    throw new TypeError('INVALID_SHADOW_SQUASH_TRANSPORT');
  }
  const request = options.request ?? fetch;
  if (typeof request !== 'function') throw new TypeError('INVALID_SHADOW_SQUASH_TRANSPORT');
  const activeScope = normalizeScope(options.scope ?? DEFAULT_FACTORY_SCOPE, options.policy);
  if (!activeScope) throw new TypeError('INVALID_SHADOW_SQUASH_SCOPE');
  const requiredMainChecks = activeScope.requiredChecks
    .map(name => options.policy.checks.find(c => c.name === name))
    .filter(Boolean);
  if (requiredMainChecks.length !== activeScope.requiredChecks.length) {
    throw new TypeError('INVALID_SHADOW_SQUASH_SCOPE');
  }
  return Object.freeze({
    mode: 'shadow',
    scope: activeScope,
    readCandidate: target => readProtectedSquashCandidate(target, {...options, scope: activeScope, request}),
    simulateSquash: target => options.simulateSquash(target),
    readMergeReceipt: target => options.readMergeReceipt(target),
    readMain: () => readBranchHealth(activeScope, requiredMainChecks, {
      request,
      stop: typeof options.readStop === 'function' ? options.readStop() !== false : (options.stop ?? false) !== false
    })
  });
}

/** A single shadow controller serializes mock squashes and holds uncertain outcomes. */
export function createShadowSquashController(transport, scope) {
  if (!object(transport, ['mode', 'readCandidate', 'simulateSquash', 'readMergeReceipt', 'readMain']) ||
      transport.mode !== 'shadow' ||
      ![transport.readCandidate, transport.simulateSquash, transport.readMergeReceipt, transport.readMain]
        .every(fn => typeof fn === 'function')) throw new TypeError('INVALID_SHADOW_SQUASH_TRANSPORT');
  const hasTransportScope = Object.hasOwn(Object.getOwnPropertyDescriptor(transport, 'scope') ?? {}, 'value');
  const activeScope = normalizeScope(scope ?? (hasTransportScope ? transport.scope : DEFAULT_FACTORY_SCOPE));
  if (!activeScope) throw new TypeError('INVALID_SHADOW_SQUASH_SCOPE');
  let busy = false;
  let pending;
  let verifiedMain;

  function verifyReceipt(intent, receipt) {
    if (!binds(receipt, intent, activeScope) || !object(receipt, ['method', 'mergeCommit', 'merged']) ||
        receipt.merged !== true || receipt.method !== 'squash' || !sha(receipt.mergeCommit) ||
        [intent.expectedHead, intent.expectedBase].includes(receipt.mergeCommit))
      return blocked('MERGE_RECEIPT_UNKNOWN');
    return {...blocked('MAIN_VERIFICATION_REQUIRED'), mergeCommit: receipt.mergeCommit};
  }

  async function verify(intent, receipt) {
    const result = verifyReceipt(intent, receipt);
    if (!result.mergeCommit) return result;
    const main = await transport.readMain();
    if (!inScope(main, activeScope) || !object(main, ['head', 'healthy', 'stop']) ||
        main.head !== result.mergeCommit || main.healthy !== true || main.stop !== false) return result;
    verifiedMain = result.mergeCommit;
    pending = undefined;
    return {...blocked('SHADOW_MAIN_VERIFIED'), dependentWorkAllowed: true, mergeCommit: result.mergeCommit};
  }

  return Object.freeze({
    async run(intent) {
      if (!validIntent(intent, activeScope)) return blocked('INTENT_UNKNOWN');
      if (busy || pending) return blocked('SERIALIZED_OR_RECOVERY_REQUIRED');
      if (verifiedMain && intent.expectedBase !== verifiedMain) return blocked('BASE_MOVED_SINCE_VERIFICATION');
      busy = true;
      const target = Object.freeze({
        repository: activeScope.repository,
        repositoryId: activeScope.repositoryId,
        branch: activeScope.branch,
        number: intent.number,
        expectedHead: intent.expectedHead,
        expectedBase: intent.expectedBase,
        method: 'squash'
      });
      try {
        const decision = guardedSquashEvidence(target, await transport.readCandidate(target), activeScope);
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
