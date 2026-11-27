import {types} from 'node:util';
import {classifyReviewSummary} from './review-batch.mjs';

const defaultScope = Object.freeze({
  repository: 'Jamula/SoftwareFactory',
  repositoryId: 1471342715,
  branch: 'main'
});
const positive = value => Number.isSafeInteger(value) && value > 0;
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const text = (value, max=120) => typeof value === 'string' && value.length > 0 &&
  value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const own = (value, keys) => value !== null && typeof value === 'object' &&
  !types.isProxy(value) && !Array.isArray(value) &&
  keys.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
const validRepo = value => text(value, 140) && /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(value) &&
  !value.split('/').some(part => part === '.' || part === '..');
const validBranch = value => text(value, 120) && /^[A-Za-z0-9_./-]{1,120}$/.test(value) &&
  !value.startsWith('/') && !value.endsWith('/') && !value.includes('//') &&
  !value.split('/').some(part => part === '.' || part === '..');
const validLogin = value => text(value, 44) && /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?:\[bot\])?$/.test(value);
const validScope = scope => own(scope, ['repository', 'repositoryId', 'branch']) &&
  validRepo(scope.repository) && positive(scope.repositoryId) && validBranch(scope.branch);
const copilot = login => ['copilot-pull-request-reviewer', 'copilot-pull-request-reviewer[bot]'].includes(login.toLowerCase());
const timestamp = value => {
  if (!text(value,20) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().replace('.000Z','Z') === value;
};
const failed = reason => ({shadow:true,evidenceComplete:false,reason});
const failedCandidate = (reason, extra = {}) => ({shadow:true,evidenceComplete:false,liveMerge:false,reason,...extra});
const encodeBranch = branch => branch.split('/').map(encodeURIComponent).join('/');

async function readJson(url, request) {
  try {
    const response = await request(url, {method:'GET',redirect:'error',signal:AbortSignal.timeout(5000),
      headers:{accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}});
    if ([401,403,429].includes(response.status)) return {ok:false,reason:'RATE_OR_PERMISSION_UNKNOWN'};
    if (!response.ok || !response.body) return {ok:false,reason:'READ_FAILED'};
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8',{fatal:true});
    let raw = '', bytes = 0;
    try {
      for (;;) {
        const {done,value} = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 524288) return {ok:false,reason:'RESPONSE_LIMIT'};
        raw += decoder.decode(value,{stream:true});
      }
      raw += decoder.decode();
    } finally {
      try { await reader.cancel(); } catch {}
    }
    return {ok:true,value:JSON.parse(raw),hasNext:response.headers.get('link')?.includes('rel="next"')===true};
  } catch {
    return {ok:false,reason:'READ_FAILED'};
  }
}

async function readScopedPullIdentity(number, scope, request) {
  const result = await readJson(`https://api.github.com/repos/${scope.repository}/pulls/${number}`, request);
  if (!result.ok) return result;
  const p = result.value;
  if (p?.number !== number || p?.base?.repo?.full_name !== scope.repository ||
      p?.head?.repo?.full_name !== scope.repository || p.base.ref !== scope.branch ||
      !sha(p.base.sha) || !sha(p.head.sha) || p.base.repo.id !== scope.repositoryId ||
      p.head.repo.id !== scope.repositoryId || !['open', 'closed'].includes(p.state) ||
      typeof p.draft !== 'boolean') {
    return {ok:false,reason:'IDENTITY_UNKNOWN'};
  }
  return {ok:true,repositoryId:p.base.repo.id,number,head:p.head.sha,base:p.base.sha,state:p.state,draft:p.draft};
}

function normalizeReviews(value, hasNext, head) {
  if (hasNext || !Array.isArray(value) || value.length > 100) return {ok:false,reason:'PAGE_LIMIT'};
  const seen = new Set(), reviews = [];
  for (const row of value) {
    if (!row || !positive(row.id) || seen.has(row.id) || !row.user ||
        !validLogin(row.user.login) ||
        (row.user.id !== null && row.user.id !== undefined && !positive(row.user.id)) ||
        !['APPROVED','CHANGES_REQUESTED','COMMENTED','DISMISSED','PENDING'].includes(row.state) ||
        !sha(row.commit_id) || (row.state === 'PENDING' ? row.submitted_at != null : !timestamp(row.submitted_at)))
      return {ok:false,reason:'REVIEW_METADATA_UNKNOWN'};
    if (row.commit_id !== head) return {ok:false,reason:'REVIEW_HEAD_MISMATCH'};
    seen.add(row.id);
    reviews.push({id:row.id,reviewer:row.user.login,reviewerId:positive(row.user.id)?row.user.id:null,
      state:row.state,head:row.commit_id,submittedAt:row.state === 'PENDING' ? null : row.submitted_at});
  }
  return {ok:true,reviews};
}

function normalizeReviewHistoryRows(value, hasNext, expectedHead) {
  if (hasNext || !Array.isArray(value) || value.length > 100) return {ok:false,reason:'PAGE_LIMIT'};
  const seen = new Set(), rows = [];
  for (const row of value) {
    if (!row || !positive(row.id) || seen.has(row.id) || !row.user || !validLogin(row.user.login))
      return {ok:false,reason:'REVIEW_METADATA_UNKNOWN'};
    if (row.state === 'PENDING') return {ok:false,reason:'REVIEW_PENDING'};
    if (!['APPROVED','CHANGES_REQUESTED','COMMENTED','DISMISSED'].includes(row.state) ||
        !sha(row.commit_id) || !timestamp(row.submitted_at))
      return {ok:false,reason:'REVIEW_METADATA_UNKNOWN'};
    seen.add(row.id);
    rows.push({
      id: row.id,
      reviewer: row.user.login,
      head: row.commit_id,
      state: row.state,
      submittedMs: Date.parse(row.submitted_at),
      body: typeof row.body === 'string' ? row.body : ''
    });
  }
  rows.sort((a, b) => (a.submittedMs - b.submittedMs) || (a.id - b.id));
  const records = rows.map((row, index) => {
    const entry = {sequence: index + 1, reviewer: row.reviewer, head: row.head, state: row.state};
    if (row.head === expectedHead && row.state === 'COMMENTED' && copilot(row.reviewer)) {
      const classified = classifyReviewSummary(row.id, row.body);
      entry.summaryDisposition = classified.summaryDisposition;
      entry.summaryFindings = classified.findings;
    }
    return entry;
  });
  return {ok:true,records};
}

const checkStatuses = new Set(['queued','in_progress','completed','waiting','requested','pending']);
const conclusions = new Set(['success','failure','neutral','cancelled','skipped','timed_out',
  'action_required','stale','startup_failure']);
function normalizeChecks(value, hasNext, head) {
  if (hasNext || !value || !Number.isSafeInteger(value.total_count) || value.total_count < 0 ||
      value.total_count > 100 || !Array.isArray(value.check_runs) ||
      value.check_runs.length !== value.total_count) return {ok:false,reason:'PAGE_LIMIT'};
  const seen = new Set(), checks = [];
  for (const row of value.check_runs) {
    if (!row || !positive(row.id) || seen.has(row.id) || !text(row.name,100) || !sha(row.head_sha) ||
        !row.app || !positive(row.app.id) || !text(row.app.slug,100) ||
        !/^[a-z0-9-]{1,100}$/.test(row.app.slug) ||
        !checkStatuses.has(row.status)) return {ok:false,reason:'CHECK_METADATA_UNKNOWN'};
    if (row.head_sha !== head) return {ok:false,reason:'CHECK_HEAD_MISMATCH'};
    if (row.status === 'completed') {
      if (!conclusions.has(row.conclusion) || !timestamp(row.completed_at))
        return {ok:false,reason:'CHECK_METADATA_UNKNOWN'};
    } else if ((row.conclusion ?? null) !== null || (row.completed_at ?? null) !== null) {
      return {ok:false,reason:'CHECK_METADATA_UNKNOWN'};
    }
    seen.add(row.id);
    checks.push({id:row.id,name:row.name,appId:row.app.id,app:row.app.slug,head:row.head_sha,
      status:row.status,conclusion:row.conclusion ?? null,completedAt:row.completed_at ?? null});
  }
  return {ok:true,checks};
}

function normalizeCandidatePull(value, number, scope) {
  if (!value || value.number !== number || value.base?.repo?.id !== scope.repositoryId ||
      value.base?.repo?.full_name !== scope.repository || value.base?.ref !== scope.branch ||
      !sha(value.base?.sha) || !sha(value.head?.sha) || !['open','closed'].includes(value.state) ||
      typeof value.draft !== 'boolean' || !validLogin(value.user?.login)) {
    return {ok:false,reason:'PULL_IDENTITY_UNKNOWN'};
  }
  const sameRepo = value.head?.repo?.id === scope.repositoryId && value.head?.repo?.full_name === scope.repository;
  const baseCompatible = value.mergeable === true &&
    ['clean','blocked','has_hooks','unstable'].includes(value.mergeable_state);
  return {
    ok: true,
    pull: {
      number,
      head: value.head.sha,
      base: value.base.sha,
      state: value.state,
      draft: value.draft,
      author: value.user.login,
      sameRepo,
      baseCompatible
    }
  };
}

function normalizePullFiles(value, hasNext) {
  if (hasNext || !Array.isArray(value) || value.length === 0 || value.length > 100)
    return {ok:false,reason:'FILES_UNKNOWN'};
  const seen = new Set(), paths = [];
  for (const row of value) {
    if (!row || !text(row.filename, 240) || seen.has(row.filename)) return {ok:false,reason:'FILES_UNKNOWN'};
    seen.add(row.filename);
    paths.push(row.filename);
  }
  return {ok:true,paths};
}

function normalizeBranchRules(value, hasNext, scope, branchProtected, expectedBase, policyChecks, hostedReviewGate) {
  if (hasNext || !Array.isArray(value) || value.length === 0 || value.length > 100)
    return {ok:false,reason:'PROTECTIONS_UNVERIFIED'};
  let nativeQueue = false, hasPullRule = false, maxApprovals = 0, threads = false;
  let squashOnly = false, squashDisallowed = false, upToDate = false, codeScanning = false;
  const checkMap = new Map();
  for (const rule of value) {
    if (!rule || typeof rule !== 'object' || !text(rule.type, 80))
      return {ok:false,reason:'PROTECTIONS_UNVERIFIED'};
    if (rule.type === 'merge_queue') {
      nativeQueue = true;
      continue;
    }
    if (rule.type === 'pull_request') {
      const params = rule.parameters;
      if (!params || typeof params !== 'object' ||
          !Number.isSafeInteger(params.required_approving_review_count) ||
          params.required_approving_review_count < 0)
        return {ok:false,reason:'PROTECTIONS_UNVERIFIED'};
      hasPullRule = true;
      if (params.required_approving_review_count > maxApprovals) maxApprovals = params.required_approving_review_count;
      if (params.required_review_thread_resolution === true) threads = true;
      if (Array.isArray(params.allowed_merge_methods)) {
        const methods = params.allowed_merge_methods.map(m => typeof m === 'string' ? m.toLowerCase() : '');
        if (methods.includes('') || !methods.includes('squash')) squashDisallowed = true;
        else if (methods.length === 1) squashOnly = true;
      }
      continue;
    }
    if (rule.type === 'required_status_checks') {
      const params = rule.parameters;
      if (!params || typeof params !== 'object' || !Array.isArray(params.required_status_checks))
        return {ok:false,reason:'PROTECTIONS_UNVERIFIED'};
      if (params.strict_required_status_checks_policy === true) upToDate = true;
      for (const sc of params.required_status_checks) {
        if (!sc || !text(sc.context, 100) || !positive(sc.integration_id))
          return {ok:false,reason:'PROTECTIONS_UNVERIFIED'};
        const prior = checkMap.get(sc.context);
        if (prior !== undefined && prior !== sc.integration_id)
          return {ok:false,reason:'PROTECTIONS_UNVERIFIED'};
        checkMap.set(sc.context, sc.integration_id);
      }
      continue;
    }
    if (rule.type === 'code_scanning') {
      const tools = rule.parameters?.code_scanning_tools;
      if (!Array.isArray(tools)) return {ok:false,reason:'PROTECTIONS_UNVERIFIED'};
      if (tools.some(t => t?.tool === 'CodeQL' &&
          t.security_alerts_threshold !== 'none' && t.alerts_threshold !== 'none')) {
        codeScanning = true;
      }
    }
  }
  if (codeScanning && !checkMap.has('CodeQL')) {
    const pinned = policyChecks.find(c => c.name === 'CodeQL');
    if (pinned) checkMap.set('CodeQL', pinned.appId);
  }
  const security = codeScanning || checkMap.has('CodeQL');
  return {
    ok: true,
    nativeQueue,
    protection: {
      repository: scope.repository,
      repositoryId: scope.repositoryId,
      branch: scope.branch,
      base: expectedBase,
      verified: hasPullRule && checkMap.size > 0,
      protected: branchProtected === true,
      bypass: false,
      method: squashOnly && !squashDisallowed ? 'squash' : 'other',
      upToDate,
      review: maxApprovals >= 1,
      requiredApprovingReviewCount: maxApprovals,
      hostedReviewGate: hostedReviewGate === true,
      threads,
      security,
      requiredChecks: [...checkMap.entries()].map(([name, appId]) => ({name, appId}))
    }
  };
}

/** Read bounded review/check metadata for a fresh same-repository pull head.
 * This is a read-only snapshot, not a trusted event, policy decision or merge receipt.
 */
export async function readPullSignals(number, expectedHead, request=fetch, scope=defaultScope) {
  if (!validScope(scope)) return failed('INVALID_SCOPE');
  if (!positive(number)) return failed('INVALID_PULL');
  if (!sha(expectedHead)) return failed('INVALID_HEAD');
  const pull = await readScopedPullIdentity(number, scope, request);
  if (!pull.ok)
    return failed(pull.reason === 'RATE_OR_PERMISSION_UNKNOWN' ? pull.reason : 'PULL_IDENTITY_UNKNOWN');
  if (pull.head !== expectedHead) return failed('HEAD_CHANGED');

  const root = 'https://api.github.com/repos/' + scope.repository;
  const [reviewResult, checkResult] = await Promise.all([
    readJson(root + '/pulls/' + number + '/reviews?per_page=100&page=1', request),
    readJson(root + '/commits/' + expectedHead + '/check-runs?per_page=100&page=1', request)
  ]);
  if (!reviewResult.ok) return failed(reviewResult.reason);
  if (!checkResult.ok) return failed(checkResult.reason);
  const reviews = normalizeReviews(reviewResult.value,reviewResult.hasNext,expectedHead);
  if (!reviews.ok) return failed(reviews.reason);
  const checks = normalizeChecks(checkResult.value,checkResult.hasNext,expectedHead);
  if (!checks.ok) return failed(checks.reason);
  const finalPull = await readScopedPullIdentity(number, scope, request);
  if (!finalPull.ok)
    return failed(finalPull.reason === 'RATE_OR_PERMISSION_UNKNOWN' ? finalPull.reason :
      finalPull.reason === 'READ_FAILED' ? finalPull.reason : 'PULL_IDENTITY_UNKNOWN');
  if (finalPull.head !== pull.head) return failed('HEAD_CHANGED');
  if (finalPull.base !== pull.base || finalPull.state !== pull.state || finalPull.draft !== pull.draft)
    return failed('PULL_STATE_CHANGED');
  return {shadow:true,evidenceComplete:false,reason:'PULL_SIGNALS_METADATA_ONLY',repositoryId:pull.repositoryId,
    number,head:pull.head,base:pull.base,state:pull.state,draft:pull.draft,
    reviewSnapshotComplete:true,reviews:reviews.reviews,checkSnapshotComplete:true,checks:checks.checks,
    liveDispatch:false,liveMerge:false};
}

/** Read bounded, exact-head PR, ruleset, file, review-history and check metadata for shadow squash evaluation. */
export async function readCandidatePullMetadata(intent, {
  request = fetch,
  scope = defaultScope,
  policyChecks = [],
  hostedReviewGate = false
} = {}) {
  if (!validScope(scope) || !own(intent, ['repository','repositoryId','branch','number','expectedHead','expectedBase']) ||
      intent.repository !== scope.repository || intent.repositoryId !== scope.repositoryId ||
      intent.branch !== scope.branch || !positive(intent.number) ||
      !sha(intent.expectedHead) || !sha(intent.expectedBase) || intent.expectedHead === intent.expectedBase ||
      !Array.isArray(policyChecks) ||
      policyChecks.some(c => !own(c, ['name','appId']) || !text(c.name, 100) || !positive(c.appId))) {
    return failedCandidate('INTENT_UNKNOWN');
  }
  const root = `https://api.github.com/repos/${scope.repository}`;
  const pullUrl = `${root}/pulls/${intent.number}`;
  const encodedBranch = encodeBranch(scope.branch);
  const initialRes = await readJson(pullUrl, request);
  if (!initialRes.ok) return failedCandidate(initialRes.reason);
  const initial = normalizeCandidatePull(initialRes.value, intent.number, scope);
  if (!initial.ok) return failedCandidate(initial.reason);
  const binding = {
    repository: scope.repository,
    repositoryId: scope.repositoryId,
    branch: scope.branch,
    number: intent.number
  };
  if (initial.pull.head !== intent.expectedHead || initial.pull.base !== intent.expectedBase) {
    return failedCandidate('SCOPE_OR_HEAD_CHANGED', {...binding, head: initial.pull.head, base: initial.pull.base});
  }

  const [branchRes, rulesRes, filesRes, reviewsRes, headChecksRes, baseChecksRes] = await Promise.all([
    readJson(`${root}/branches/${encodedBranch}`, request),
    readJson(`${root}/rules/branches/${encodedBranch}`, request),
    readJson(`${root}/pulls/${intent.number}/files?per_page=100&page=1`, request),
    readJson(`${root}/pulls/${intent.number}/reviews?per_page=100&page=1`, request),
    readJson(`${root}/commits/${intent.expectedHead}/check-runs?per_page=100&page=1`, request),
    readJson(`${root}/commits/${intent.expectedBase}/check-runs?per_page=100&page=1`, request)
  ]);
  for (const res of [branchRes, rulesRes, filesRes, reviewsRes, headChecksRes, baseChecksRes]) {
    if (!res.ok) return failedCandidate(res.reason, {...binding, head: intent.expectedHead, base: intent.expectedBase});
  }
  const branchData = branchRes.value;
  if (branchData?.name !== scope.branch || typeof branchData?.protected !== 'boolean' || !sha(branchData?.commit?.sha)) {
    return failedCandidate('BRANCH_UNKNOWN', {...binding, head: intent.expectedHead, base: intent.expectedBase});
  }
  if (branchData.commit.sha !== intent.expectedBase) {
    return failedCandidate('SCOPE_OR_HEAD_CHANGED',
      {...binding, head: intent.expectedHead, base: branchData.commit.sha});
  }
  const rules = normalizeBranchRules(rulesRes.value, rulesRes.hasNext, scope, branchData.protected,
    intent.expectedBase, policyChecks, hostedReviewGate);
  if (!rules.ok) return failedCandidate(rules.reason, {...binding, head: intent.expectedHead, base: intent.expectedBase});
  const files = normalizePullFiles(filesRes.value, filesRes.hasNext);
  if (!files.ok) return failedCandidate(files.reason, {...binding, head: intent.expectedHead, base: intent.expectedBase});
  const reviews = normalizeReviewHistoryRows(reviewsRes.value, reviewsRes.hasNext, intent.expectedHead);
  if (!reviews.ok) return failedCandidate(reviews.reason, {...binding, head: intent.expectedHead, base: intent.expectedBase});
  const headChecks = normalizeChecks(headChecksRes.value, headChecksRes.hasNext, intent.expectedHead);
  if (!headChecks.ok) return failedCandidate(headChecks.reason, {...binding, head: intent.expectedHead, base: intent.expectedBase});
  const baseChecks = normalizeChecks(baseChecksRes.value, baseChecksRes.hasNext, intent.expectedBase);
  if (!baseChecks.ok) return failedCandidate(baseChecks.reason, {...binding, head: intent.expectedHead, base: intent.expectedBase});

  const finalRes = await readJson(pullUrl, request);
  if (!finalRes.ok) return failedCandidate(finalRes.reason, {...binding, head: intent.expectedHead, base: intent.expectedBase});
  const finalPull = normalizeCandidatePull(finalRes.value, intent.number, scope);
  if (!finalPull.ok) return failedCandidate(finalPull.reason, {...binding, head: intent.expectedHead, base: intent.expectedBase});
  if (finalPull.pull.head !== intent.expectedHead || finalPull.pull.base !== intent.expectedBase) {
    return failedCandidate('SCOPE_OR_HEAD_CHANGED',
      {...binding, head: finalPull.pull.head, base: finalPull.pull.base});
  }
  if (finalPull.pull.state !== initial.pull.state || finalPull.pull.draft !== initial.pull.draft ||
      finalPull.pull.author !== initial.pull.author || finalPull.pull.sameRepo !== initial.pull.sameRepo ||
      finalPull.pull.baseCompatible !== initial.pull.baseCompatible) {
    return failedCandidate('PULL_STATE_CHANGED', {...binding, head: intent.expectedHead, base: intent.expectedBase});
  }
  return {
    shadow: true,
    evidenceComplete: true,
    liveMerge: false,
    reason: 'CANDIDATE_METADATA_READ',
    ...binding,
    head: initial.pull.head,
    base: initial.pull.base,
    open: initial.pull.state === 'open',
    draft: initial.pull.draft,
    scopeVerified: initial.pull.sameRepo,
    baseCompatible: initial.pull.baseCompatible,
    author: initial.pull.author,
    nativeQueue: rules.nativeQueue,
    protection: rules.protection,
    paths: files.paths,
    reviewRecords: reviews.records,
    checks: headChecks.checks.map(c => ({
      name: c.name, head: c.head, appId: c.appId, status: c.status, conclusion: c.conclusion
    })),
    baseChecks: baseChecks.checks.map(c => ({
      name: c.name, head: c.head, appId: c.appId, status: c.status, conclusion: c.conclusion
    }))
  };
}

/** Read bounded protected-branch tip and required check-run health for post-merge verification. */
export async function readBranchHealth(scope = defaultScope, requiredChecks = [], {request = fetch, stop = false} = {}) {
  if (!validScope(scope) || !Array.isArray(requiredChecks) || requiredChecks.length === 0 ||
      requiredChecks.length > 32 || requiredChecks.some(c => !own(c, ['name','appId']) || !text(c.name, 100) || !positive(c.appId))) {
    return {shadow:true,liveMerge:false,healthy:false,reason:'BRANCH_SCOPE_UNKNOWN'};
  }
  const root = `https://api.github.com/repos/${scope.repository}`;
  const branchUrl = `${root}/branches/${encodeBranch(scope.branch)}`;
  const firstBranch = await readJson(branchUrl, request);
  if (!firstBranch.ok) return {shadow:true,liveMerge:false,healthy:false,reason:firstBranch.reason};
  const head = firstBranch.value?.commit?.sha;
  if (firstBranch.value?.name !== scope.branch || typeof firstBranch.value?.protected !== 'boolean' || !sha(head)) {
    return {shadow:true,liveMerge:false,healthy:false,reason:'BRANCH_UNKNOWN'};
  }
  const [checksRes, secondBranch] = await Promise.all([
    readJson(`${root}/commits/${head}/check-runs?per_page=100&page=1`, request),
    readJson(branchUrl, request)
  ]);
  if (!checksRes.ok) return {shadow:true,liveMerge:false,healthy:false,reason:checksRes.reason};
  if (!secondBranch.ok) return {shadow:true,liveMerge:false,healthy:false,reason:secondBranch.reason};
  if (secondBranch.value?.name !== scope.branch || secondBranch.value?.protected !== firstBranch.value.protected ||
      secondBranch.value?.commit?.sha !== head) {
    return {shadow:true,liveMerge:false,healthy:false,reason:'BRANCH_CHANGED'};
  }
  const normalized = normalizeChecks(checksRes.value, checksRes.hasNext, head);
  if (!normalized.ok) return {shadow:true,liveMerge:false,healthy:false,reason:normalized.reason};
  const allChecksGreen = requiredChecks.every(req => {
    const matches = normalized.checks.filter(c => c.name === req.name);
    return matches.length === 1 && matches[0].appId === req.appId &&
      matches[0].status === 'completed' && matches[0].conclusion === 'success';
  });
  return {
    shadow: true,
    liveMerge: false,
    repository: scope.repository,
    repositoryId: scope.repositoryId,
    branch: scope.branch,
    head,
    healthy: firstBranch.value.protected === true && allChecksGreen,
    stop: stop !== false
  };
}
