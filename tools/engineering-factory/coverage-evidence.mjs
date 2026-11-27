import {types} from 'node:util';

const FACTORY_REPO = 'Jamula/SoftwareFactory';
const FACTORY_REPO_ID = 1471342715;
const ACTIONS_APP_ID = 15368;
const REQUIRED_STATUS_CONTEXTS = ['build-test', 'upload-coverage-javascript', 'windows-aspire-runtime'];
const POLICY_KEYS = new Set([
  'repository', 'lineMin', 'branchMin', 'existingLineMin', 'existingBranchMin', 'branchless'
]);
const RECEIPT_KEYS = [
  'repository', 'repositoryId', 'branch', 'headRepository', 'isFork',
  'head', 'base', 'mergeGroupHead', 'mergeGroup', 'ruleset', 'pullChecks', 'mergeGroupChecks',
  'codeScanning', 'secretScanningClear', 'threadsResolved', 'trustedReviewers', 'review',
  'baseCoverage', 'expectedComponents', 'coverageReports'
];
const RECEIPT_ALLOWED_KEYS = new Set([...RECEIPT_KEYS, 'branchless']);
const RULESET_KEYS = [
  'strict_required_status_checks_policy', 'required_status_checks',
  'minimum_coverage', 'max_coverage_drop', 'required_approving_review_count',
  'required_review_thread_resolution', 'allowed_merge_methods',
  'merge_queue_merge_method', 'merge_queue_grouping', 'bypass_actors',
  'secret_scanning_required', 'code_scanning_tools'
];
const REVIEW_KEYS = [
  'head', 'reviewer', 'author', 'agent', 'state', 'independent',
  'summaryDisposition', 'unresolvedSummaryFindings', 'blockingReviewCount'
];

const sha = x => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);
const hasData = (x, p) => {
  const d = Object.getOwnPropertyDescriptor(x, p);
  return d !== undefined && Object.hasOwn(d, 'value');
};
const own = (x, k) => x !== null && typeof x === 'object' && !types.isProxy(x) && !Array.isArray(x) &&
  Object.getPrototypeOf(x) === Object.prototype && k.every(p => hasData(x, p));
const exact = (x, k) => own(x, k) && Reflect.ownKeys(x).length === k.length;
const ownValue = (x, p) => Object.hasOwn(x, p) ? Object.getOwnPropertyDescriptor(x, p).value : undefined;
const plainSubset = (x, allowed) => x !== null && typeof x === 'object' && !types.isProxy(x) &&
  !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype &&
  Reflect.ownKeys(x).every(k => typeof k === 'string' && allowed.has(k) && hasData(x, k)) &&
  [...allowed].every(k => Object.hasOwn(x, k) || !(k in x));
const name = x => typeof x === 'string' && /^[a-z0-9][a-z0-9._-]{0,79}$/.test(x);
const repoName = x => typeof x === 'string' && x.length <= 200 &&
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(x) && !x.includes('..');
const reviewerId = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,79}$/.test(x);
const pct = (x, min) => Number.isFinite(x) && x >= min && x <= 100;
// Accept ordinary, bounded data arrays only; reject accessors and custom behavior.
const dense = (x, max = 250) => !types.isProxy(x) && Array.isArray(x) &&
  Object.getPrototypeOf(x) === Array.prototype && x.length <= max &&
  Reflect.ownKeys(x).length === x.length + 1 &&
  Array.from({length: x.length}, (_, i) => hasData(x, i)).every(Boolean);
const count = (a, b) => Number.isSafeInteger(a) && Number.isSafeInteger(b) &&
  a >= 0 && b > 0 && a <= b && b <= 100000000;
const deny = reason => ({shadow: true, valid: false, reason});
const gateDeny = reason => Object.freeze({shadow: true, valid: false, liveMerge: false, reason});

function resolvePolicy(head, expectedSet, policy) {
  if (policy === undefined) return {ok: true, lineMin: 98, branchMin: 95, branchless: null};
  if (!plainSubset(policy, POLICY_KEYS)) return {ok: false, reason: 'INVALID_POLICY'};
  const repoOpt = ownValue(policy, 'repository');
  const repository = repoOpt === undefined ? FACTORY_REPO : repoOpt;
  if (!repoName(repository)) return {ok: false, reason: 'INVALID_POLICY'};
  const isFactory = repository.toLowerCase() === 'jamula/softwarefactory';
  let floorLine = isFactory ? 98 : 95;
  let floorBranch = isFactory ? 95 : 90;
  const existingLine = ownValue(policy, 'existingLineMin');
  if (existingLine !== undefined) {
    if (!pct(existingLine, floorLine)) return {ok: false, reason: 'INVALID_POLICY'};
    floorLine = existingLine;
  }
  const existingBranch = ownValue(policy, 'existingBranchMin');
  if (existingBranch !== undefined) {
    if (!pct(existingBranch, floorBranch)) return {ok: false, reason: 'INVALID_POLICY'};
    floorBranch = existingBranch;
  }
  const lineOpt = ownValue(policy, 'lineMin');
  const branchOpt = ownValue(policy, 'branchMin');
  const lineMin = lineOpt === undefined ? floorLine : lineOpt;
  const branchMin = branchOpt === undefined ? floorBranch : branchOpt;
  if (!pct(lineMin, floorLine) || !pct(branchMin, floorBranch)) return {ok: false, reason: 'INVALID_POLICY'};
  const branchless = new Set();
  const branchlessOpt = ownValue(policy, 'branchless');
  if (branchlessOpt !== undefined) {
    if (!dense(branchlessOpt)) return {ok: false, reason: 'INVALID_POLICY'};
    for (let i = 0; i < branchlessOpt.length; i++) {
      const entry = branchlessOpt[i];
      if (!exact(entry, ['component', 'head', 'reviewedBy', 'reason']) ||
          !name(entry.component) || !sha(entry.head) || !reviewerId(entry.reviewedBy) ||
          typeof entry.reason !== 'string' || entry.reason.trim().length < 8 ||
          entry.reason.length > 240 || /[\u0000-\u001f\u007f]/.test(entry.reason) ||
          branchless.has(entry.component)) return {ok: false, reason: 'INVALID_POLICY'};
      if (!expectedSet.has(entry.component) || entry.head !== head)
        return {ok: false, reason: 'BRANCHLESS_UNJUSTIFIED'};
      branchless.add(entry.component);
    }
  }
  return {ok: true, lineMin, branchMin, branchless};
}

// SoftwareFactory defaults to 98/95; consumer policies require >=95/90 or their stricter existing floor.
export function coverageEvidence(head, expected, reports, policy) {
  if (!sha(head) || !dense(expected) || !expected.length || !expected.every(name))
    return deny('INVENTORY_UNKNOWN');
  const expectedSet = new Set(expected);
  if (expectedSet.size !== expected.length || !dense(reports) || reports.length !== expected.length)
    return deny('INVENTORY_UNKNOWN');
  const resolved = resolvePolicy(head, expectedSet, policy);
  if (!resolved.ok) return deny(resolved.reason);
  const seen = new Set();
  let lines = 0, lineTotal = 0, branches = 0, branchTotal = 0;
  for (let i = 0; i < reports.length; i++) {
    const r = reports[i];
    if (!own(r, ['component', 'head', 'lines', 'lineTotal', 'branches', 'branchTotal']) ||
        !expectedSet.has(r.component) || seen.has(r.component) || r.head !== head ||
        !count(r.lines, r.lineTotal)) return deny('INVALID_REPORT');
    const zeroBranches = r.branches === 0 && r.branchTotal === 0;
    if (!zeroBranches && !count(r.branches, r.branchTotal)) return deny('INVALID_REPORT');
    if (zeroBranches && resolved.branchless === null) return deny('INVALID_REPORT');
    if (resolved.branchless !== null && zeroBranches !== resolved.branchless.has(r.component))
      return deny('BRANCHLESS_UNJUSTIFIED');
    if (r.lines * 100 < resolved.lineMin * r.lineTotal ||
        (!zeroBranches && r.branches * 100 < resolved.branchMin * r.branchTotal))
      return deny('COMPONENT_BELOW_TARGET');
    seen.add(r.component);
    lines += r.lines;
    lineTotal += r.lineTotal;
    branches += r.branches;
    branchTotal += r.branchTotal;
  }
  return {shadow: true, valid: true, reason: 'COUNTS_ONLY', lines, lineTotal, branches, branchTotal};
}

// Convert actual Node test:coverage file rows to component counts. The inventory
// is independently enumerated from the checked-out source tree by the CI reporter.
export function coverageFromNodeSummary(head, expected, files, policy) {
  if (!dense(files) || !files.length) return deny('INVENTORY_UNKNOWN');
  const rows = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (!own(f, ['component', 'coveredLineCount', 'totalLineCount', 'coveredBranchCount', 'totalBranchCount']))
      return deny('INVALID_REPORT');
    rows.push({
      component: f.component,
      head,
      lines: f.coveredLineCount,
      lineTotal: f.totalLineCount,
      branches: f.coveredBranchCount,
      branchTotal: f.totalBranchCount
    });
  }
  const evidence = coverageEvidence(head, expected, rows, policy);
  return evidence.valid ? {...evidence, head, components: rows} : evidence;
}

function verifyRuleset(ruleset) {
  if (!exact(ruleset, RULESET_KEYS) || !dense(ruleset.required_status_checks, 32) ||
      !dense(ruleset.allowed_merge_methods, 4) || !dense(ruleset.code_scanning_tools, 16))
    return {ok: false, reason: 'RULESET_UNKNOWN'};
  if (!pct(ruleset.minimum_coverage, 98) || ruleset.max_coverage_drop !== 0)
    return {ok: false, reason: 'COVERAGE_RULESET_BELOW_TARGET'};
  if (ruleset.strict_required_status_checks_policy !== true ||
      ruleset.required_review_thread_resolution !== true ||
      ruleset.required_approving_review_count !== 0 ||
      ruleset.allowed_merge_methods.length !== 1 || ruleset.allowed_merge_methods[0] !== 'squash' ||
      ruleset.merge_queue_merge_method !== 'SQUASH' ||
      ruleset.merge_queue_grouping !== 'ALLGREEN' ||
      ruleset.bypass_actors !== 0 || ruleset.secret_scanning_required !== true)
    return {ok: false, reason: 'RULESET_INCOMPLETE'};
  const requiredMap = new Map();
  for (let i = 0; i < ruleset.required_status_checks.length; i++) {
    const item = ruleset.required_status_checks[i];
    if (!exact(item, ['context', 'integration_id']) || typeof item.context !== 'string' ||
        !item.context || !Number.isSafeInteger(item.integration_id) || item.integration_id <= 0 ||
        requiredMap.has(item.context)) return {ok: false, reason: 'RULESET_UNKNOWN'};
    requiredMap.set(item.context, item.integration_id);
  }
  if (REQUIRED_STATUS_CONTEXTS.some(ctx => requiredMap.get(ctx) !== ACTIONS_APP_ID))
    return {ok: false, reason: 'RULESET_INCOMPLETE'};
  for (let i = 0; i < ruleset.code_scanning_tools.length; i++) {
    const tool = ruleset.code_scanning_tools[i];
    if (!exact(tool, ['tool', 'security_alerts_threshold', 'alerts_threshold']) ||
        typeof tool.tool !== 'string') return {ok: false, reason: 'RULESET_UNKNOWN'};
  }
  const scanner = ruleset.code_scanning_tools[0];
  if (ruleset.code_scanning_tools.length !== 1 || scanner.tool !== 'CodeQL' ||
      scanner.security_alerts_threshold !== 'medium_or_higher' ||
      scanner.alerts_threshold !== 'errors_and_warnings')
    return {ok: false, reason: 'RULESET_INCOMPLETE'};
  return {ok: true, requiredMap, minimumCoverage: ruleset.minimum_coverage};
}

function verifyChecks(checks, requiredMap, expectedHead, requiredEvent) {
  if (!dense(checks)) return false;
  const seen = new Set();
  const keys = requiredEvent === null
    ? ['name', 'head', 'appId', 'status', 'conclusion']
    : ['name', 'head', 'appId', 'event', 'status', 'conclusion'];
  for (let i = 0; i < checks.length; i++) {
    const c = checks[i];
    if (!exact(c, keys) || typeof c.name !== 'string') return false;
    if (!requiredMap.has(c.name)) continue;
    if (seen.has(c.name) || c.head !== expectedHead || c.appId !== requiredMap.get(c.name) ||
        (requiredEvent !== null && c.event !== requiredEvent) ||
        c.status !== 'completed' || c.conclusion !== 'success') return false;
    seen.add(c.name);
  }
  return seen.size === requiredMap.size;
}

// Reconcile effective main rulesets (required_approving_review_count: 0, separate CodeQL
// code_scanning rule, minimum_coverage >= 98) with exact-head PR/merge_group/fork gates.
export function verifyCandidateGateReceipt(receipt) {
  if (!plainSubset(receipt, RECEIPT_ALLOWED_KEYS) ||
      !RECEIPT_KEYS.every(k => Object.hasOwn(receipt, k)) ||
      receipt.repository !== FACTORY_REPO ||
      receipt.repositoryId !== FACTORY_REPO_ID || receipt.branch !== 'main' ||
      !repoName(receipt.headRepository) || typeof receipt.isFork !== 'boolean' ||
      !sha(receipt.head) || !sha(receipt.base) || receipt.head === receipt.base ||
      !sha(receipt.mergeGroupHead) || receipt.mergeGroupHead === receipt.head ||
      receipt.mergeGroupHead === receipt.base ||
      typeof receipt.secretScanningClear !== 'boolean' || typeof receipt.threadsResolved !== 'boolean' ||
      !dense(receipt.trustedReviewers, 64) || !receipt.trustedReviewers.length ||
      !receipt.trustedReviewers.every(reviewerId))
    return gateDeny('RECEIPT_UNKNOWN');
  const allowlist = new Set(receipt.trustedReviewers.map(r => r.toLowerCase()));
  if (allowlist.size !== receipt.trustedReviewers.length)
    return gateDeny('RECEIPT_UNKNOWN');
  if (receipt.isFork || receipt.headRepository !== FACTORY_REPO)
    return gateDeny('FORK_PR_PLATFORM_GATES_UNTRUSTED');
  const rules = verifyRuleset(receipt.ruleset);
  if (!rules.ok) return gateDeny(rules.reason);
  if (!verifyChecks(receipt.pullChecks, rules.requiredMap, receipt.head, null))
    return gateDeny('PULL_CHECKS_INCOMPLETE');
  const mg = receipt.mergeGroup;
  if (!exact(mg, ['head', 'base', 'memberHeads']) || mg.head !== receipt.mergeGroupHead ||
      mg.base !== receipt.base || !dense(mg.memberHeads, 5) || !mg.memberHeads.length ||
      !mg.memberHeads.every(m => sha(m) && m !== receipt.base && m !== receipt.mergeGroupHead) ||
      new Set(mg.memberHeads).size !== mg.memberHeads.length ||
      !mg.memberHeads.includes(receipt.head) ||
      !verifyChecks(receipt.mergeGroupChecks, rules.requiredMap, receipt.mergeGroupHead, 'merge_group'))
    return gateDeny('MERGE_GROUP_CHECKS_INCOMPLETE');
  const cs = receipt.codeScanning;
  if (!exact(cs, ['tool', 'head', 'status', 'conclusion', 'openAlerts']) || cs.tool !== 'CodeQL' ||
      cs.head !== receipt.head || cs.status !== 'completed' || cs.conclusion !== 'success' ||
      !Number.isSafeInteger(cs.openAlerts) || cs.openAlerts !== 0)
    return gateDeny('CODEQL_ALERTS_OR_INCOMPLETE');
  if (!receipt.secretScanningClear || !receipt.threadsResolved)
    return gateDeny('SECURITY_OR_THREADS_UNRESOLVED');
  const rv = receipt.review;
  if (!exact(rv, REVIEW_KEYS) || rv.head !== receipt.head || rv.independent !== true ||
      !reviewerId(rv.reviewer) || !reviewerId(rv.author) || !reviewerId(rv.agent))
    return gateDeny('INDEPENDENT_REVIEW_INCOMPLETE');
  const reviewerLower = rv.reviewer.toLowerCase();
  const authorLower = rv.author.toLowerCase();
  const agentLower = rv.agent.toLowerCase();
  if (!allowlist.has(reviewerLower) ||
      reviewerLower === authorLower ||
      reviewerLower === agentLower ||
      !(rv.state === 'APPROVED' || (rv.state === 'COMMENTED' &&
        ['copilot-pull-request-reviewer', 'copilot-pull-request-reviewer[bot]'].includes(reviewerLower))) ||
      rv.summaryDisposition !== 'clear' || rv.unresolvedSummaryFindings !== 0 || rv.blockingReviewCount !== 0)
    return gateDeny('INDEPENDENT_REVIEW_INCOMPLETE');
  const bc = receipt.baseCoverage;
  if (!exact(bc, ['head', 'lines', 'lineTotal']) || bc.head !== receipt.base ||
      !count(bc.lines, bc.lineTotal))
    return gateDeny('COVERAGE_UNVERIFIED');
  const branchless = ownValue(receipt, 'branchless');
  const covPolicy = branchless === undefined
    ? {repository: FACTORY_REPO, lineMin: rules.minimumCoverage, branchMin: 95}
    : {repository: FACTORY_REPO, lineMin: rules.minimumCoverage, branchMin: 95, branchless};
  const cov = coverageEvidence(receipt.head, receipt.expectedComponents, receipt.coverageReports, covPolicy);
  if (!cov.valid || BigInt(cov.lines) * BigInt(bc.lineTotal) < BigInt(bc.lines) * BigInt(cov.lineTotal))
    return gateDeny('COVERAGE_UNVERIFIED');
  if (branchless !== undefined && branchless.some(entry => {
    const by = entry.reviewedBy.toLowerCase();
    return !allowlist.has(by) || by === authorLower || by === agentLower;
  })) return gateDeny('COVERAGE_UNVERIFIED');
  return Object.freeze({
    shadow: true,
    valid: true,
    liveMerge: false,
    reason: 'CANDIDATE_GATES_VERIFIED',
    head: receipt.head,
    mergeGroupHead: receipt.mergeGroupHead
  });
}
