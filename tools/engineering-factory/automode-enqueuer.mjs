// Deterministic, metadata-only, fail-closed Automode Merge Queue gatekeeper evaluator.
import {types} from 'node:util';
import {EXACT_PROTECTED_CONTROL_PLANE_PATHS, isProtectedControlPlanePath} from './anti-rogue-audit.mjs';
import {classifyReviewSummary} from './review-batch.mjs';

export const SOFTWARE_FACTORY_REPO = 'Jamula/SoftwareFactory';
export const SOFTWARE_FACTORY_REPO_ID = 1471342715;
export const GITHUB_ACTIONS_APP_ID = 15368;
export const GITHUB_CODE_SCANNING_APP_ID = 57789;
export const MAX_ENQUEUE_PER_TICK = 5;

export const PROTECTED_CONTROL_PLANE_PREFIXES = Object.freeze([
  ...new Set([
    '.github/workflows/',
    'config/',
    ...EXACT_PROTECTED_CONTROL_PLANE_PATHS,
    'tools/engineering-factory/review-batch.mjs',
    'tools/engineering-factory/automode-enqueuer.mjs',
    'tools/engineering-factory/main-health-audit.mjs',
    'tools/engineering-factory/gh-aw-lock-verifier.mjs',
    'tools/engineering-factory/protected-squash.mjs'
  ])
]);
const PROTECTED_ENTRIES = PROTECTED_CONTROL_PLANE_PREFIXES.map(p => ({
  lower: p.toLowerCase(),
  isPrefix: p.endsWith('/')
}));

const REQUIRED_ACTIONS_CHECKS = Object.freeze(['build-test', 'upload-coverage-javascript', 'windows-aspire-runtime']);
const CODEQL_ANALYZE_CHECKS = new Set(['Analyze (javascript-typescript)', 'Analyze (actions)', 'Analyze (csharp)']);
const CHECK_STATUSES = new Set(['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending']);
const CHECK_CONCLUSIONS = new Set([
  'success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure'
]);
const REVIEW_STATES = new Set(['APPROVED', 'COMMENTED', 'CHANGES_REQUESTED', 'DISMISSED', 'PENDING']);
const DECISION_REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);
const MERGEABLE_STATES = new Set(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']);
const MERGE_STATE_STATUSES = new Set(['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNKNOWN', 'UNSTABLE']);
const PR_ID_RE = /^PR_[A-Za-z0-9_-]{10,64}$/;
const SHA40_RE = /^[0-9a-f]{40}$/;
const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,79}$/;
const BOT_LOGIN_RE =
  /\[bot\]$|^(?:copilot-swe-agent|copilot-pull-request-reviewer|anthropic-code-agent|openai-code-agent|github-actions)$/i;
const PR_KEYS = [
  'id', 'number', 'state', 'isDraft', 'baseRefName', 'headRepositoryId', 'headRefOid', 'mergeQueueEntry',
  'mergeable', 'mergeStateStatus', 'authorLogin', 'authorIsBot', 'changedFilesComplete', 'files',
  'reviewThreadsComplete', 'unresolvedThreadCount', 'reviewsComplete', 'reviews', 'checkRunsComplete',
  'statusCheckRollupState', 'checkRuns'
];

const isPositiveInt = v => Number.isSafeInteger(v) && v > 0;
const isNonNegInt = v => Number.isSafeInteger(v) && v >= 0;
const isSha40 = v => typeof v === 'string' && SHA40_RE.test(v);
const isLogin = v => typeof v === 'string' && LOGIN_RE.test(v);
const isSafePath = v =>
  typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\u0000-\u001f\u007f\\]/.test(v) &&
  !v.split('/').some(seg => seg === '' || seg === '.' || seg === '..');
const COPILOT_REVIEW_CHECKS = new Set(['copilot-pull-request-reviewer', 'running copilot code review', 'copilot code review']);
const isCopilotReviewCheck = name => COPILOT_REVIEW_CHECKS.has(name.toLowerCase());
const isCopilotReviewer = (login, isBot) =>
  isBot === true && /^copilot-pull-request-reviewer(?:\[bot\])?$/i.test(login);
const isSummaryClear = rev => classifyReviewSummary(rev.id, rev.body).summaryDisposition === 'clear';
const isProtectedPath = f => {
  const lower = f.toLowerCase();
  return isProtectedControlPlanePath(f) || isProtectedControlPlanePath(lower) ||
    PROTECTED_ENTRIES.some(e => (e.isPrefix ? lower.startsWith(e.lower) : lower === e.lower));
};
const isPlainObject = v =>
  v !== null && typeof v === 'object' && !types.isProxy(v) && Object.getPrototypeOf(v) === Object.prototype;

function hasOwnData(target, key) {
  const d = Object.getOwnPropertyDescriptor(target, key);
  return d !== undefined && d.enumerable === true && Object.hasOwn(d, 'value');
}

function exactPlainObject(v, reqKeys, optKeys) {
  if (!isPlainObject(v)) return false;
  const allowed = new Set([...reqKeys, ...optKeys]);
  for (const k of Reflect.ownKeys(v)) {
    if (typeof k !== 'string' || !allowed.has(k) || !hasOwnData(v, k)) return false;
  }
  for (const r of reqKeys) if (!Object.hasOwn(v, r)) return false;
  for (const o of optKeys) {
    if (!Object.hasOwn(v, o) && Object.getOwnPropertyDescriptor(Object.prototype, o) !== undefined) return false;
  }
  return true;
}

function isDenseArray(v, maxLen) {
  if (types.isProxy(v) || !Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype) return false;
  if (v.length > maxLen || Reflect.ownKeys(v).length !== v.length + 1) return false;
  for (let i = 0; i < v.length; i++) if (!hasOwnData(v, i)) return false;
  return true;
}

function isValidCheckStatus(status, conclusion) {
  if (typeof status !== 'string' || !CHECK_STATUSES.has(status.toLowerCase())) return false;
  return status.toLowerCase() === 'completed'
    ? (typeof conclusion === 'string' && CHECK_CONCLUSIONS.has(conclusion.toLowerCase()))
    : conclusion === null;
}

function validatePrStructure(pr) {
  if (!exactPlainObject(pr, PR_KEYS, []) || !isPositiveInt(pr.number) || typeof pr.id !== 'string' ||
      typeof pr.state !== 'string' || typeof pr.isDraft !== 'boolean' || typeof pr.baseRefName !== 'string' ||
      (pr.headRepositoryId !== null && !isPositiveInt(pr.headRepositoryId)) ||
      typeof pr.headRefOid !== 'string' ||
      (pr.mergeQueueEntry !== null && !exactPlainObject(pr.mergeQueueEntry, ['id'], [])) ||
      !MERGEABLE_STATES.has(pr.mergeable) || !MERGE_STATE_STATUSES.has(pr.mergeStateStatus) ||
      !isLogin(pr.authorLogin) || typeof pr.authorIsBot !== 'boolean' ||
      typeof pr.changedFilesComplete !== 'boolean' || !isDenseArray(pr.files, 500) ||
      typeof pr.reviewThreadsComplete !== 'boolean' || !isNonNegInt(pr.unresolvedThreadCount) ||
      typeof pr.reviewsComplete !== 'boolean' || !isDenseArray(pr.reviews, 200) ||
      typeof pr.checkRunsComplete !== 'boolean' ||
      (pr.statusCheckRollupState !== null && typeof pr.statusCheckRollupState !== 'string') ||
      !isDenseArray(pr.checkRuns, 200)) {
    return false;
  }
  for (const rev of pr.reviews) {
    if (!exactPlainObject(rev, ['id', 'reviewerLogin', 'reviewerIsBot', 'state', 'commitOid', 'body'], []) ||
        !isPositiveInt(rev.id) || !isLogin(rev.reviewerLogin) || typeof rev.reviewerIsBot !== 'boolean' ||
        !REVIEW_STATES.has(rev.state) || (rev.commitOid !== null && !isSha40(rev.commitOid)) ||
        typeof rev.body !== 'string' || rev.body.length > 65536 || rev.body.includes('\u0000')) {
      return false;
    }
  }
  for (const cr of pr.checkRuns) {
    if (!exactPlainObject(cr, ['name', 'status', 'conclusion', 'appId', 'headSha'], []) ||
        typeof cr.name !== 'string' || cr.name.length === 0 || cr.name.length > 160 ||
        !isValidCheckStatus(cr.status, cr.conclusion) || !isNonNegInt(cr.appId) || !isSha40(cr.headSha)) {
      return false;
    }
  }
  return true;
}

function evaluateSinglePr(pr, branchUpdateSupported) {
  if (!PR_ID_RE.test(pr.id) || !isSha40(pr.headRefOid)) return {kind: 'SKIP', reason: 'INVALID_PR_IDENTITY'};
  if (pr.state !== 'OPEN') return {kind: 'SKIP', reason: 'NOT_OPEN'};
  if (pr.isDraft || pr.mergeStateStatus === 'DRAFT') return {kind: 'SKIP', reason: 'DRAFT_PR'};
  if (pr.baseRefName !== 'main') return {kind: 'SKIP', reason: 'NON_MAIN_BASE'};
  if (pr.headRepositoryId !== SOFTWARE_FACTORY_REPO_ID) return {kind: 'SKIP', reason: 'UNTRUSTED_HEAD_REPOSITORY'};
  if (pr.mergeQueueEntry !== null) return {kind: 'SKIP', reason: 'ALREADY_IN_MERGE_QUEUE'};
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') return {kind: 'SKIP', reason: 'CONFLICTING'};
  if (pr.mergeable !== 'MERGEABLE' || pr.mergeStateStatus === 'UNKNOWN') return {kind: 'SKIP', reason: 'MERGE_STATE_UNKNOWN'};
  if (!pr.changedFilesComplete || pr.files.length === 0 || !pr.files.every(isSafePath)) {
    return {kind: 'SKIP', reason: 'CHANGED_FILES_INCOMPLETE'};
  }

  const authorLower = pr.authorLogin.toLowerCase();
  const authorIsBot = pr.authorIsBot || BOT_LOGIN_RE.test(pr.authorLogin);
  const touchesProtected = pr.files.some(isProtectedPath);
  const latestStateByReviewer = new Map();
  let hasPendingReview = false;
  let latestCopilotReview = null;
  let latestCopilotExact = null;

  if (pr.reviewsComplete) {
    for (const rev of pr.reviews) {
      if (rev.state === 'PENDING') hasPendingReview = true;
      const revLower = rev.reviewerLogin.toLowerCase();
      const independent = revLower !== authorLower;
      const revIsBot = rev.reviewerIsBot || BOT_LOGIN_RE.test(rev.reviewerLogin);
      if (DECISION_REVIEW_STATES.has(rev.state)) {
        latestStateByReviewer.set(revLower, {state: rev.state, commitOid: rev.commitOid, independent, revIsBot});
      }
      if (independent && (rev.state === 'APPROVED' || rev.state === 'COMMENTED') &&
          isCopilotReviewer(rev.reviewerLogin, rev.reviewerIsBot)) {
        latestCopilotReview = rev;
        if (rev.commitOid === pr.headRefOid) latestCopilotExact = rev;
      }
    }
  }

  let humanApprovedExactHead = false;
  let hasChangesRequested = false;
  for (const entry of latestStateByReviewer.values()) {
    if (entry.state === 'CHANGES_REQUESTED') hasChangesRequested = true;
    if (entry.state === 'APPROVED' && entry.commitOid === pr.headRefOid && entry.independent && !entry.revIsBot) {
      humanApprovedExactHead = true;
    }
  }

  if (touchesProtected && authorIsBot && !humanApprovedExactHead) {
    return {kind: 'SKIP', reason: 'PROTECTED_CONTROL_PLANE_REQUIRES_HUMAN_APPROVAL'};
  }
  if (!pr.reviewThreadsComplete) return {kind: 'SKIP', reason: 'REVIEW_THREADS_INCOMPLETE'};
  if (pr.unresolvedThreadCount > 0) return {kind: 'SKIP', reason: 'UNRESOLVED_REVIEW_THREADS'};
  if (!pr.reviewsComplete) return {kind: 'SKIP', reason: 'REVIEWS_INCOMPLETE'};
  if (hasPendingReview || hasChangesRequested) return {kind: 'SKIP', reason: 'CHANGES_REQUESTED'};
  if (pr.checkRuns.some(c => isCopilotReviewCheck(c.name) && c.status.toLowerCase() !== 'completed')) {
    return {kind: 'SKIP', reason: 'COPILOT_REVIEW_IN_PROGRESS'};
  }
  if (latestCopilotExact !== null && !isSummaryClear(latestCopilotExact)) {
    return {kind: 'SKIP', reason: 'COPILOT_SUMMARY_NOT_CLEAR'};
  }
  const copilotCarryForwardClear =
    latestCopilotExact !== null || (latestCopilotReview !== null && isSummaryClear(latestCopilotReview));
  if (!humanApprovedExactHead && !copilotCarryForwardClear) {
    return {
      kind: 'SKIP',
      reason: latestCopilotReview !== null ? 'COPILOT_SUMMARY_NOT_CLEAR' : 'INDEPENDENT_REVIEW_REQUIRED'
    };
  }
  if (pr.mergeStateStatus === 'BEHIND') {
    return branchUpdateSupported
      ? {kind: 'BEHIND', number: pr.number, expectedHeadOid: pr.headRefOid}
      : {kind: 'SKIP', reason: 'BRANCH_UPDATE_UNSUPPORTED'};
  }
  if (!pr.checkRunsComplete) return {kind: 'SKIP', reason: 'CHECK_RUNS_INCOMPLETE'};
  if (pr.statusCheckRollupState !== 'SUCCESS') return {kind: 'SKIP', reason: 'STATUS_ROLLUP_NOT_SUCCESS'};

  const passedChecks = new Set();
  for (const cr of pr.checkRuns) {
    if (cr.headSha !== pr.headRefOid) continue;
    const isReqActions = REQUIRED_ACTIONS_CHECKS.includes(cr.name);
    const isCodeql = cr.name === 'CodeQL' || CODEQL_ANALYZE_CHECKS.has(cr.name);
    if (!isReqActions && !isCodeql) continue;
    const trusted = isReqActions
      ? cr.appId === GITHUB_ACTIONS_APP_ID
      : (cr.appId === GITHUB_ACTIONS_APP_ID || cr.appId === GITHUB_CODE_SCANNING_APP_ID);
    if (!trusted) return {kind: 'SKIP', reason: 'UNTRUSTED_CHECK_APP'};
    if (cr.status.toLowerCase() !== 'completed' || cr.conclusion.toLowerCase() !== 'success') {
      return {kind: 'SKIP', reason: isReqActions ? 'REQUIRED_CHECKS_INCOMPLETE' : 'CODEQL_CHECKS_INCOMPLETE'};
    }
    passedChecks.add(cr.name);
  }
  if (REQUIRED_ACTIONS_CHECKS.some(req => !passedChecks.has(req))) return {kind: 'SKIP', reason: 'REQUIRED_CHECKS_INCOMPLETE'};
  const codeqlOk = passedChecks.has('CodeQL') ||
    (passedChecks.has('Analyze (javascript-typescript)') && passedChecks.has('Analyze (actions)'));
  if (!codeqlOk) return {kind: 'SKIP', reason: 'CODEQL_CHECKS_INCOMPLETE'};
  return {kind: 'ENQUEUE', number: pr.number, pullRequestId: pr.id, expectedHeadOid: pr.headRefOid};
}

const closedResult = reason =>
  Object.freeze({active: false, reason, enqueue: Object.freeze([]), updateBranch: Object.freeze([]), decisions: Object.freeze([])});

const INPUT_OPT_KEYS = [
  'killSwitchActive', 'automodeEnabled', 'maxEnqueuePerTick', 'mainHealthy', 'branchUpdateSupported'
];

export function evaluateAutomodePullRequests(input) {
  if (!exactPlainObject(input, ['repository', 'repositoryId', 'pullRequests'], INPUT_OPT_KEYS)) {
    return closedResult('INVALID_INPUT');
  }
  const hasKill = Object.hasOwn(input, 'killSwitchActive');
  const hasEnabled = Object.hasOwn(input, 'automodeEnabled');
  const hasMax = Object.hasOwn(input, 'maxEnqueuePerTick');
  const hasMainHealthy = Object.hasOwn(input, 'mainHealthy');
  const hasBranchUpdate = Object.hasOwn(input, 'branchUpdateSupported');
  if (typeof input.repository !== 'string' || !Number.isSafeInteger(input.repositoryId) || !isDenseArray(input.pullRequests, 100) ||
      (hasKill && typeof input.killSwitchActive !== 'boolean') || (hasEnabled && typeof input.automodeEnabled !== 'boolean') ||
      (hasMax && (!isPositiveInt(input.maxEnqueuePerTick) || input.maxEnqueuePerTick > MAX_ENQUEUE_PER_TICK)) ||
      (hasMainHealthy && typeof input.mainHealthy !== 'boolean') ||
      (hasBranchUpdate && typeof input.branchUpdateSupported !== 'boolean')) {
    return closedResult('INVALID_INPUT');
  }
  if ((hasKill && input.killSwitchActive === true) || (hasEnabled && input.automodeEnabled === false)) return closedResult('AUTOMODE_DISABLED');
  if (input.repository !== SOFTWARE_FACTORY_REPO || input.repositoryId !== SOFTWARE_FACTORY_REPO_ID) return closedResult('UNTRUSTED_REPOSITORY');
  if (hasMainHealthy && input.mainHealthy === false) return closedResult('MAIN_UNHEALTHY');

  const seenNumbers = new Set();
  for (const pr of input.pullRequests) {
    if (!validatePrStructure(pr) || seenNumbers.has(pr.number)) return closedResult('INVALID_INPUT');
    seenNumbers.add(pr.number);
  }

  const maxEnqueue = hasMax ? input.maxEnqueuePerTick : MAX_ENQUEUE_PER_TICK;
  const branchUpdateSupported = hasBranchUpdate ? input.branchUpdateSupported : true;
  const outcomes = [...input.pullRequests]
    .sort((a, b) => a.number - b.number)
    .map(pr => ({number: pr.number, res: evaluateSinglePr(pr, branchUpdateSupported)}));
  const enqueue = [];
  let behindCandidate = null;
  for (const {res} of outcomes) {
    if (res.kind === 'ENQUEUE' && enqueue.length < maxEnqueue) {
      enqueue.push(Object.freeze({number: res.number, pullRequestId: res.pullRequestId, expectedHeadOid: res.expectedHeadOid}));
    } else if (res.kind === 'BEHIND' && behindCandidate === null) {
      behindCandidate = res;
    }
  }

  const updateBranch = enqueue.length === 0 && behindCandidate !== null
    ? [Object.freeze({number: behindCandidate.number, expectedHeadOid: behindCandidate.expectedHeadOid})]
    : [];
  const enqueuedSet = new Set(enqueue.map(e => e.number));
  const updatedNumber = updateBranch.length === 1 ? updateBranch[0].number : null;
  const decisions = outcomes.map(({number, res}) => {
    if (enqueuedSet.has(number)) return Object.freeze({number, action: 'ENQUEUE', reason: 'ELIGIBLE'});
    if (res.kind === 'ENQUEUE') return Object.freeze({number, action: 'SKIP', reason: 'MAX_ENQUEUE_LIMIT_REACHED'});
    if (updatedNumber === number) return Object.freeze({number, action: 'UPDATE_BRANCH', reason: 'BEHIND_UPDATE_BRANCH'});
    if (res.kind === 'BEHIND') return Object.freeze({number, action: 'SKIP', reason: 'BEHIND_DEFERRED'});
    return Object.freeze({number, action: 'SKIP', reason: res.reason});
  });

  return Object.freeze({
    active: true, reason: 'EVALUATED',
    enqueue: Object.freeze(enqueue), updateBranch: Object.freeze(updateBranch), decisions: Object.freeze(decisions)
  });
}
