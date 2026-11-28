// Deterministic exact-head protected main and candidate integration health auditor.
// Metadata-only, read-only, shadow-only, and fail-closed across all active workflows,
// fork runtime skips, summary-only review findings, merge_group SHA binding, and JS/C# 98/95 coverage.
import {types} from 'node:util';
import {coverageEvidence} from './coverage-evidence.mjs';
import {classifyReviewSummary} from './review-batch.mjs';

export const SOFTWARE_FACTORY_REPO = 'Jamula/SoftwareFactory';
export const SOFTWARE_FACTORY_REPO_ID = 1471342715;
export const GITHUB_ACTIONS_APP_ID = 15368;
export const GITHUB_ADVANCED_SECURITY_APP_ID = 57789;

export const ACTIVE_MAIN_WORKFLOWS = Object.freeze([
  'Factory validation',
  'Windows Aspire runtime',
  '.NET MAF specialist agents',
  'Reusable replay smoke',
  'CodeQL'
]);

const AUTOMODE_GATEKEEPER_WORKFLOW = 'Factory automode Merge Queue gatekeeper';
const AUTOMODE_GATEKEEPER_JOBS = new Set(['evaluate', 'apply-queue-actions']);
const AUTOMODE_GATEKEEPER_EVENTS = new Set([
  'push',
  'dynamic',
  'workflow_run',
  'schedule',
  'workflow_dispatch',
  'pull_request_target'
]);

// Duplicate CodeQL - Code Quality is disabled in repository settings while security
// CodeQL remains mandatory; historical receipts and optional main gatekeepers are still validated.
export const OPTIONAL_MAIN_WORKFLOWS = Object.freeze([
  'CodeQL - Code Quality',
  AUTOMODE_GATEKEEPER_WORKFLOW
]);

export const DEFAULT_OFF_MAIN_WORKFLOWS = Object.freeze([
  'Factory shadow reconciliation',
  'Factory gh-aw outer orchestrator'
]);

export const REQUIRED_STATUS_CHECK_CONTEXTS = Object.freeze([
  'build-test',
  'upload-coverage-javascript',
  'windows-aspire-runtime'
]);

// .NET MAF specialist agents is path-filtered on pull_request when C#/Aspire files
// are unchanged, while remaining unconditional on merge_group and protected main.
export const PATH_FILTERED_DOTNET_PULL_CHECKS = Object.freeze([
  'linux-dotnet-agents',
  'windows-dotnet-agents'
]);

export const DOTNET_AGENTS_PULL_PATH_FILTERS = Object.freeze([
  'src/**',
  'tests/SoftwareFactory.Agents.Tests/**',
  'apphost.cs',
  'global.json',
  'Directory.Build.props',
  'Directory.Packages.props',
  '.github/workflows/dotnet-agents.yml'
]);

export const REQUIRED_CANDIDATE_RUNTIME_CHECKS = Object.freeze([
  'linux-aspire-runtime',
  'windows-aspire-runtime',
  'linux-dotnet-agents',
  'windows-dotnet-agents'
]);

export const REQUIRED_CANDIDATE_PULL_CHECKS = Object.freeze([
  'test-coverage',
  'linux-aspire-runtime',
  'build-test',
  'upload-coverage-javascript',
  'windows-aspire-runtime',
  'linux-dotnet-agents',
  'windows-dotnet-agents'
]);

export const REQUIRED_MERGE_GROUP_CHECKS = Object.freeze([
  'test-coverage',
  'linux-aspire-runtime',
  'build-test',
  'upload-coverage-javascript',
  'windows-aspire-runtime',
  'linux-dotnet-agents',
  'windows-dotnet-agents',
  'pinned-synthetic-replay / replay'
]);

const MAIN_WORKFLOW_REQUIRED_JOBS = new Map([
  ['Factory validation', ['test-coverage', 'linux-aspire-runtime', 'build-test', 'upload-coverage-javascript']],
  ['Windows Aspire runtime', ['windows-aspire-runtime']],
  ['.NET MAF specialist agents', ['linux-dotnet-agents', 'windows-dotnet-agents']],
  ['Reusable replay smoke', ['pinned-synthetic-replay / replay']],
  ['CodeQL', ['Analyze (actions)', 'Analyze (csharp)', 'Analyze (javascript-typescript)']],
  ['CodeQL - Code Quality', ['Analyze (csharp)', 'Analyze (javascript-typescript)']],
  [AUTOMODE_GATEKEEPER_WORKFLOW, ['evaluate']]
]);

const defaultOffSet = new Set(DEFAULT_OFF_MAIN_WORKFLOWS);
const activeWorkflowSet = new Set(ACTIVE_MAIN_WORKFLOWS);
const optionalMainWorkflowSet = new Set(OPTIONAL_MAIN_WORKFLOWS);
const pathFilteredDotnetPullSet = new Set(PATH_FILTERED_DOTNET_PULL_CHECKS);
const unconditionalCandidateRuntimeChecks = REQUIRED_CANDIDATE_RUNTIME_CHECKS.filter(
  name => !pathFilteredDotnetPullSet.has(name)
);
const unconditionalCandidatePullChecks = REQUIRED_CANDIDATE_PULL_CHECKS.filter(
  name => !pathFilteredDotnetPullSet.has(name)
);
const builtInActionsJobSet = new Set([
  ...REQUIRED_STATUS_CHECK_CONTEXTS,
  ...REQUIRED_CANDIDATE_PULL_CHECKS,
  ...REQUIRED_MERGE_GROUP_CHECKS,
  ...[...MAIN_WORKFLOW_REQUIRED_JOBS.values()].flat()
]);

const CHECK_STATUSES = new Set([
  'queued',
  'in_progress',
  'completed',
  'waiting',
  'requested',
  'pending'
]);

const CHECK_CONCLUSIONS = new Set([
  'success',
  'failure',
  'neutral',
  'cancelled',
  'skipped',
  'timed_out',
  'action_required',
  'stale',
  'startup_failure'
]);

const REVIEW_STATES = new Set([
  'APPROVED',
  'COMMENTED',
  'CHANGES_REQUESTED',
  'DISMISSED',
  'PENDING'
]);

const SUMMARY_DISPOSITIONS = new Set(['clear', 'actionable', 'uncertain']);

const requiredPullCheckSet = new Set(REQUIRED_CANDIDATE_PULL_CHECKS);

const isSha40 = v => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);
const isPositiveInt = v => Number.isSafeInteger(v) && v > 0;
const isNonNegInt = v => Number.isSafeInteger(v) && v >= 0;
const isSafeText = (v, max) =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const isRepoSlug = v =>
  isSafeText(v, 140) &&
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v) &&
  !v.includes('..') &&
  !v.split('/').includes('.');
const isReviewerLogin = v =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,79}$/.test(v);
const isDotnetComponent = v =>
  typeof v === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(v) &&
  !v.includes('..') &&
  !v.split('/').some(part => part.length === 0 || part === '.');
const isDotnet10Sdk = v => typeof v === 'string' && /^10\.\d+\.\d+$/.test(v);
const isValidCounts = (covered, total) =>
  isNonNegInt(covered) && isPositiveInt(total) && covered <= total && total <= 100000000;

function isPlainObject(value) {
  return value !== null &&
    typeof value === 'object' &&
    !types.isProxy(value) &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function hasOwnData(target, key) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor !== undefined && descriptor.enumerable === true && Object.hasOwn(descriptor, 'value');
}

function exactPlainObject(value, requiredKeys, optionalKeys) {
  if (!isPlainObject(value)) return false;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const ownKeys = Reflect.ownKeys(value);
  for (let i = 0; i < ownKeys.length; i++) {
    const key = ownKeys[i];
    if (typeof key !== 'string' || !allowed.has(key) || !hasOwnData(value, key)) return false;
  }
  for (let i = 0; i < requiredKeys.length; i++) {
    if (!hasOwnData(value, requiredKeys[i])) return false;
  }
  for (let i = 0; i < optionalKeys.length; i++) {
    const opt = optionalKeys[i];
    if (!Object.hasOwn(value, opt) && Object.getOwnPropertyDescriptor(Object.prototype, opt) !== undefined) {
      return false;
    }
  }
  return true;
}

function isDenseArray(value, maxLen) {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return false;
  }
  if (value.length > maxLen || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let i = 0; i < value.length; i++) {
    if (!hasOwnData(value, i)) return false;
  }
  return true;
}

function isValidStatusConclusion(status, conclusion) {
  if (!CHECK_STATUSES.has(status)) return false;
  return status === 'completed' ? CHECK_CONCLUSIONS.has(conclusion) : conclusion === null;
}

function addReason(list, reason) {
  if (!list.includes(reason)) list.push(reason);
}

function meetsExactPercentFloor(covered, total, minPercent) {
  const str = String(minPercent);
  const dot = str.indexOf('.');
  if (dot === -1) {
    return BigInt(covered) * 100n >= BigInt(str) * BigInt(total);
  }
  const decimals = str.length - dot - 1;
  const scale = 10n ** BigInt(decimals);
  const minScaled = BigInt(str.slice(0, dot) + str.slice(dot + 1));
  return BigInt(covered) * 100n * scale >= minScaled * BigInt(total);
}

function isExpectedCheckAppId(checkName, appId, requiredCheckMap, forceActionsOnly) {
  if (forceActionsOnly || builtInActionsJobSet.has(checkName)) {
    return appId === GITHUB_ACTIONS_APP_ID;
  }
  if (requiredCheckMap.has(checkName)) {
    return appId === requiredCheckMap.get(checkName);
  }
  if (checkName === 'CodeQL') {
    return appId === GITHUB_ADVANCED_SECURITY_APP_ID || appId === GITHUB_ACTIONS_APP_ID;
  }
  return appId === GITHUB_ACTIONS_APP_ID;
}

function formatCoverageSummary(componentCount, lines, lineTotal, branches, branchTotal, sdkVersion) {
  const linePct = Math.round((lines * 10000) / lineTotal) / 100;
  const branchPct = branchTotal === 0 ? null : Math.round((branches * 10000) / branchTotal) / 100;
  const base = {
    componentCount,
    lines,
    lineTotal,
    linePct,
    linePercent: `${linePct.toFixed(2)}%`,
    branches,
    branchTotal,
    branchPct,
    branchPercent: branchPct === null ? 'N/A' : `${branchPct.toFixed(2)}%`
  };
  if (sdkVersion !== null) base.sdkVersion = sdkVersion;
  return Object.freeze(base);
}

function invalidResult(reason) {
  return Object.freeze({
    shadow: true,
    liveMerge: false,
    liveDispatch: false,
    valid: false,
    eligible: false,
    mainHealthy: false,
    dependentWorkAllowed: false,
    candidateEvaluated: false,
    candidateHealthy: null,
    reason,
    failureReasons: Object.freeze([reason]),
    repository: null,
    repositoryId: null,
    branch: null,
    mainHead: null,
    candidateHead: null,
    mergeGroupHead: null,
    failedMainWorkflows: Object.freeze([]),
    failedMainJobs: Object.freeze([]),
    coverageSummary: null
  });
}

const RULESET_KEYS = [
  'strictRequiredStatusChecks',
  'requiredStatusChecks',
  'minimumCoverage',
  'maxCoverageDrop',
  'requiredApprovingReviewCount',
  'copilotCodeReviewOnPush',
  'requiredReviewThreadResolution',
  'allowedMergeMethods',
  'mergeQueueMergeMethod',
  'mergeQueueGrouping',
  'bypassActorsCount',
  'secretScanningRequired',
  'codeScanningTools'
];

const defaultRequiredCheckMap = new Map(
  REQUIRED_STATUS_CHECK_CONTEXTS.map(ctx => [ctx, GITHUB_ACTIONS_APP_ID])
);

function auditRuleset(ruleset) {
  if (!exactPlainObject(ruleset, RULESET_KEYS, []) ||
      typeof ruleset.strictRequiredStatusChecks !== 'boolean' ||
      !isDenseArray(ruleset.requiredStatusChecks, 32) ||
      typeof ruleset.minimumCoverage !== 'number' ||
      typeof ruleset.maxCoverageDrop !== 'number' ||
      !Number.isSafeInteger(ruleset.requiredApprovingReviewCount) ||
      typeof ruleset.copilotCodeReviewOnPush !== 'boolean' ||
      typeof ruleset.requiredReviewThreadResolution !== 'boolean' ||
      !isDenseArray(ruleset.allowedMergeMethods, 4) ||
      typeof ruleset.mergeQueueMergeMethod !== 'string' ||
      typeof ruleset.mergeQueueGrouping !== 'string' ||
      !Number.isSafeInteger(ruleset.bypassActorsCount) ||
      typeof ruleset.secretScanningRequired !== 'boolean' ||
      !isDenseArray(ruleset.codeScanningTools, 16)) {
    return {
      structuralError: true,
      ok: false,
      reason: 'INVALID_INPUT',
      lineMin: 98,
      requiredApprovals: 0,
      requiredCheckMap: defaultRequiredCheckMap
    };
  }

  const checkMap = new Map();
  for (let i = 0; i < ruleset.requiredStatusChecks.length; i++) {
    const entry = ruleset.requiredStatusChecks[i];
    if (!exactPlainObject(entry, ['context', 'integrationId'], []) ||
        !isSafeText(entry.context, 100) ||
        !isPositiveInt(entry.integrationId) ||
        checkMap.has(entry.context)) {
      return {
        structuralError: true,
        ok: false,
        reason: 'INVALID_INPUT',
        lineMin: 98,
        requiredApprovals: 0,
        requiredCheckMap: defaultRequiredCheckMap
      };
    }
    checkMap.set(entry.context, entry.integrationId);
  }
  for (let i = 0; i < ruleset.allowedMergeMethods.length; i++) {
    if (!isSafeText(ruleset.allowedMergeMethods[i], 32)) {
      return {
        structuralError: true,
        ok: false,
        reason: 'INVALID_INPUT',
        lineMin: 98,
        requiredApprovals: 0,
        requiredCheckMap: defaultRequiredCheckMap
      };
    }
  }
  const scannerMap = new Map();
  for (let i = 0; i < ruleset.codeScanningTools.length; i++) {
    const scanner = ruleset.codeScanningTools[i];
    if (!exactPlainObject(scanner, ['tool', 'securityAlertsThreshold', 'alertsThreshold'], []) ||
        !isSafeText(scanner.tool, 80) ||
        !isSafeText(scanner.securityAlertsThreshold, 40) ||
        !isSafeText(scanner.alertsThreshold, 40) ||
        scannerMap.has(scanner.tool)) {
      return {
        structuralError: true,
        ok: false,
        reason: 'INVALID_INPUT',
        lineMin: 98,
        requiredApprovals: 0,
        requiredCheckMap: defaultRequiredCheckMap
      };
    }
    scannerMap.set(scanner.tool, scanner);
  }

  const codeqlRule = scannerMap.get('CodeQL');
  const codeqlProtected =
    scannerMap.size === 1 &&
    codeqlRule !== undefined &&
    (codeqlRule.securityAlertsThreshold === 'medium_or_higher' ||
      codeqlRule.securityAlertsThreshold === 'all') &&
    (codeqlRule.alertsThreshold === 'errors_and_warnings' ||
      codeqlRule.alertsThreshold === 'all');

  let builtInProducerOverridden = false;
  const effectiveCheckMap = new Map(defaultRequiredCheckMap);
  for (const [ctx, appId] of checkMap) {
    if (builtInActionsJobSet.has(ctx) && appId !== GITHUB_ACTIONS_APP_ID) {
      builtInProducerOverridden = true;
    } else if (ctx === 'CodeQL' &&
               appId !== GITHUB_ADVANCED_SECURITY_APP_ID &&
               appId !== GITHUB_ACTIONS_APP_ID) {
      builtInProducerOverridden = true;
    } else {
      effectiveCheckMap.set(ctx, appId);
    }
  }

  const effectiveLineMin =
    Number.isFinite(ruleset.minimumCoverage) &&
    ruleset.minimumCoverage >= 98 &&
    ruleset.minimumCoverage <= 100
      ? ruleset.minimumCoverage
      : 98;
  const effectiveRequiredApprovals =
    ruleset.requiredApprovingReviewCount > 0 ? ruleset.requiredApprovingReviewCount : 0;

  if (!Number.isFinite(ruleset.minimumCoverage) ||
      ruleset.minimumCoverage < 98 ||
      ruleset.minimumCoverage > 100 ||
      ruleset.maxCoverageDrop !== 0 ||
      ruleset.strictRequiredStatusChecks !== true ||
      ruleset.requiredReviewThreadResolution !== true ||
      ruleset.secretScanningRequired !== true ||
      !codeqlProtected ||
      builtInProducerOverridden ||
      ruleset.bypassActorsCount !== 0 ||
      ruleset.requiredApprovingReviewCount < 0 ||
      (ruleset.requiredApprovingReviewCount === 0 && ruleset.copilotCodeReviewOnPush !== true) ||
      ruleset.allowedMergeMethods.length !== 1 ||
      ruleset.allowedMergeMethods[0] !== 'squash' ||
      ruleset.mergeQueueMergeMethod !== 'SQUASH' ||
      ruleset.mergeQueueGrouping !== 'ALLGREEN' ||
      REQUIRED_STATUS_CHECK_CONTEXTS.some(ctx => checkMap.get(ctx) !== GITHUB_ACTIONS_APP_ID)) {
    return {
      structuralError: false,
      ok: false,
      reason: 'RULESET_INCOMPLETE',
      lineMin: effectiveLineMin,
      requiredApprovals: effectiveRequiredApprovals,
      requiredCheckMap: effectiveCheckMap
    };
  }

  return {
    structuralError: false,
    ok: true,
    reason: null,
    lineMin: effectiveLineMin,
    requiredApprovals: effectiveRequiredApprovals,
    requiredCheckMap: checkMap
  };
}

function auditJsCoverage(jsCov, expectedHead, lineMin, invalidReason, trustedSet, excludedSet) {
  if (!exactPlainObject(jsCov, ['head', 'expectedComponents', 'components'], ['branchless']) ||
      !isSha40(jsCov.head) ||
      jsCov.head !== expectedHead ||
      !isDenseArray(jsCov.expectedComponents, 250) ||
      !isDenseArray(jsCov.components, 250)) {
    return {ok: false, reason: invalidReason, summary: null};
  }
  for (let i = 0; i < jsCov.components.length; i++) {
    if (!exactPlainObject(
      jsCov.components[i],
      ['component', 'head', 'lines', 'lineTotal', 'branches', 'branchTotal'],
      []
    )) {
      return {ok: false, reason: invalidReason, summary: null};
    }
  }
  const hasBranchless = Object.hasOwn(jsCov, 'branchless');
  if (hasBranchless) {
    if (!isDenseArray(jsCov.branchless, 250)) {
      return {ok: false, reason: invalidReason, summary: null};
    }
    for (let i = 0; i < jsCov.branchless.length; i++) {
      if (!exactPlainObject(jsCov.branchless[i], ['component', 'head', 'reviewedBy', 'reason'], [])) {
        return {ok: false, reason: invalidReason, summary: null};
      }
    }
  }
  const policy = hasBranchless
    ? {repository: SOFTWARE_FACTORY_REPO, lineMin: 98, branchMin: 95, branchless: jsCov.branchless}
    : {repository: SOFTWARE_FACTORY_REPO, lineMin: 98, branchMin: 95};
  const evidence = coverageEvidence(expectedHead, jsCov.expectedComponents, jsCov.components, policy);
  if (!evidence.valid) {
    return {
      ok: false,
      reason: evidence.reason === 'COMPONENT_BELOW_TARGET' ? 'JS_COVERAGE_BELOW_TARGET' : invalidReason,
      summary: null
    };
  }
  for (let i = 0; i < jsCov.components.length; i++) {
    const row = jsCov.components[i];
    if (!meetsExactPercentFloor(row.lines, row.lineTotal, lineMin)) {
      return {ok: false, reason: 'JS_COVERAGE_BELOW_TARGET', summary: null};
    }
  }
  if (hasBranchless && trustedSet !== null) {
    for (let i = 0; i < jsCov.branchless.length; i++) {
      const reviewer = jsCov.branchless[i].reviewedBy.toLowerCase();
      if (!trustedSet.has(reviewer) || excludedSet.has(reviewer)) {
        return {ok: false, reason: invalidReason, summary: null};
      }
    }
  }
  return {
    ok: true,
    reason: null,
    summary: formatCoverageSummary(
      jsCov.expectedComponents.length,
      evidence.lines,
      evidence.lineTotal,
      evidence.branches,
      evidence.branchTotal,
      null
    )
  };
}

function auditDotnetCoverage(dotnetCov, expectedHead, lineMin, invalidReason) {
  if (!exactPlainObject(dotnetCov, ['head', 'sdkVersion', 'expectedComponents', 'components'], []) ||
      !isSha40(dotnetCov.head) ||
      !isDotnet10Sdk(dotnetCov.sdkVersion) ||
      !isDenseArray(dotnetCov.expectedComponents, 256) ||
      dotnetCov.expectedComponents.length === 0 ||
      !isDenseArray(dotnetCov.components, 256) ||
      dotnetCov.components.length !== dotnetCov.expectedComponents.length ||
      dotnetCov.head !== expectedHead) {
    return {ok: false, reason: invalidReason, summary: null};
  }
  const expectedSet = new Set();
  for (let i = 0; i < dotnetCov.expectedComponents.length; i++) {
    const comp = dotnetCov.expectedComponents[i];
    if (!isDotnetComponent(comp) || expectedSet.has(comp)) {
      return {ok: false, reason: invalidReason, summary: null};
    }
    expectedSet.add(comp);
  }
  const seen = new Set();
  let lines = 0;
  let lineTotal = 0;
  let branches = 0;
  let branchTotal = 0;
  let belowTarget = false;
  for (let i = 0; i < dotnetCov.components.length; i++) {
    const row = dotnetCov.components[i];
    if (!exactPlainObject(row, ['component', 'head', 'lines', 'lineTotal', 'branches', 'branchTotal'], []) ||
        !expectedSet.has(row.component) ||
        seen.has(row.component) ||
        row.head !== expectedHead ||
        !isValidCounts(row.lines, row.lineTotal) ||
        !isValidCounts(row.branches, row.branchTotal)) {
      return {ok: false, reason: invalidReason, summary: null};
    }
    seen.add(row.component);
    if (!meetsExactPercentFloor(row.lines, row.lineTotal, lineMin) ||
        !meetsExactPercentFloor(row.branches, row.branchTotal, 95)) {
      belowTarget = true;
    }
    lines += row.lines;
    lineTotal += row.lineTotal;
    branches += row.branches;
    branchTotal += row.branchTotal;
  }
  if (belowTarget) {
    return {ok: false, reason: 'DOTNET_COVERAGE_BELOW_TARGET', summary: null};
  }
  return {
    ok: true,
    reason: null,
    summary: formatCoverageSummary(
      dotnetCov.expectedComponents.length,
      lines,
      lineTotal,
      branches,
      branchTotal,
      dotnetCov.sdkVersion
    )
  };
}

function validMainRunEvent(workflow, event) {
  if (workflow === AUTOMODE_GATEKEEPER_WORKFLOW) {
    return AUTOMODE_GATEKEEPER_EVENTS.has(event);
  }
  return event === 'push' || event === 'dynamic';
}

function validMainRunName(workflow, runName) {
  if (workflow === 'CodeQL') return runName === 'Push on main' || runName === 'CodeQL';
  if (workflow === 'CodeQL - Code Quality') {
    return runName === 'Code Quality: Push on main' || runName === 'CodeQL - Code Quality';
  }
  if (activeWorkflowSet.has(workflow) || workflow === AUTOMODE_GATEKEEPER_WORKFLOW) {
    return runName === workflow;
  }
  return runName === workflow || runName === 'Push on main';
}

function isAllowedMainJobConclusion(isDefaultOff, isAutomodeGatekeeper, job) {
  if (isDefaultOff) return job.conclusion === 'skipped' || job.conclusion === 'success';
  if (isAutomodeGatekeeper) {
    return job.conclusion === 'success' ||
      (job.conclusion === 'skipped' && AUTOMODE_GATEKEEPER_JOBS.has(job.name));
  }
  return job.conclusion === 'success';
}

function isAllowedMainRunConclusion(
  isDefaultOff,
  isAutomodeGatekeeper,
  runConclusion,
  allJobsSkipped,
  evaluateConclusion
) {
  if (isDefaultOff) return runConclusion === 'skipped' || runConclusion === 'success';
  if (isAutomodeGatekeeper) {
    return allJobsSkipped
      ? runConclusion === 'skipped'
      : (runConclusion === 'success' && evaluateConclusion === 'success');
  }
  return runConclusion === 'success';
}

function auditMainSection(main, lineMin, requiredCheckMap) {
  if (!exactPlainObject(
    main,
    ['head', 'protected', 'security', 'workflowRuns', 'jsCoverage', 'dotnetCoverage'],
    []
  ) ||
      !isSha40(main.head) ||
      typeof main.protected !== 'boolean' ||
      !exactPlainObject(main.security, ['secretScanningClear', 'openCodeScanningAlerts'], []) ||
      typeof main.security.secretScanningClear !== 'boolean' ||
      !isNonNegInt(main.security.openCodeScanningAlerts) ||
      !isDenseArray(main.workflowRuns, 64) ||
      main.workflowRuns.length === 0) {
    return {structuralError: true};
  }

  const seenRunIds = new Set();
  const seenJobIds = new Set();
  const seenActiveRuns = new Set();

  for (let i = 0; i < main.workflowRuns.length; i++) {
    const run = main.workflowRuns[i];
    if (!exactPlainObject(
      run,
      ['workflow', 'runName', 'runId', 'event', 'headSha', 'status', 'conclusion', 'jobs'],
      ['defaultOff']
    ) ||
        !isSafeText(run.workflow, 120) ||
        !isSafeText(run.runName, 120) ||
        !isPositiveInt(run.runId) ||
        seenRunIds.has(run.runId) ||
        !isSafeText(run.event, 40) ||
        !isSha40(run.headSha) ||
        !isValidStatusConclusion(run.status, run.conclusion) ||
        !isDenseArray(run.jobs, 64) ||
        run.jobs.length === 0) {
      return {structuralError: true};
    }
    if (Object.hasOwn(run, 'defaultOff')) {
      if (typeof run.defaultOff !== 'boolean' || (run.defaultOff === true && !defaultOffSet.has(run.workflow))) {
        return {structuralError: true};
      }
    }
    if (activeWorkflowSet.has(run.workflow) || optionalMainWorkflowSet.has(run.workflow)) {
      if (seenActiveRuns.has(run.workflow)) return {structuralError: true};
      seenActiveRuns.add(run.workflow);
    }
    seenRunIds.add(run.runId);
    const jobNames = new Set();
    for (let j = 0; j < run.jobs.length; j++) {
      const job = run.jobs[j];
      if (!exactPlainObject(job, ['name', 'jobId', 'appId', 'headSha', 'status', 'conclusion'], []) ||
          !isSafeText(job.name, 120) ||
          jobNames.has(job.name) ||
          !isPositiveInt(job.jobId) ||
          seenJobIds.has(job.jobId) ||
          !isPositiveInt(job.appId) ||
          !isSha40(job.headSha) ||
          !isValidStatusConclusion(job.status, job.conclusion)) {
        return {structuralError: true};
      }
      jobNames.add(job.name);
      seenJobIds.add(job.jobId);
    }
  }

  const reasons = [];
  const failedWorkflows = [];
  const failedJobs = [];
  const verifiedActiveWorkflows = new Set();
  const satisfiedMainChecks = new Set();

  if (main.protected !== true) addReason(reasons, 'MAIN_NOT_PROTECTED');
  if (!main.security.secretScanningClear || main.security.openCodeScanningAlerts !== 0) {
    addReason(reasons, 'MAIN_SECURITY_ALERTS_OPEN');
  }

  for (let i = 0; i < main.workflowRuns.length; i++) {
    const run = main.workflowRuns[i];
    const isDefaultOff = Object.hasOwn(run, 'defaultOff') && run.defaultOff === true;
    const isAutomodeGatekeeper = run.workflow === AUTOMODE_GATEKEEPER_WORKFLOW;
    if (run.headSha !== main.head) addReason(reasons, 'MAIN_HEAD_MISMATCH');

    const presentJobs = new Set();
    let runHasFailedJob = false;
    let runHasIncompleteJob = false;
    let allJobsSkipped = true;
    let gatekeeperEvaluateConclusion = null;

    for (let j = 0; j < run.jobs.length; j++) {
      const job = run.jobs[j];
      presentJobs.add(job.name);
      if (job.conclusion !== 'skipped') allJobsSkipped = false;
      if (isAutomodeGatekeeper && job.name === 'evaluate') {
        gatekeeperEvaluateConclusion = job.conclusion;
      }
      if (job.headSha !== main.head) addReason(reasons, 'MAIN_HEAD_MISMATCH');
      const forceActionsOnly =
        activeWorkflowSet.has(run.workflow) || optionalMainWorkflowSet.has(run.workflow) || isDefaultOff;
      const trustedApp = isExpectedCheckAppId(job.name, job.appId, requiredCheckMap, forceActionsOnly);
      if (!trustedApp) addReason(reasons, 'UNTRUSTED_CHECK_APP');
      if (!isDefaultOff &&
          job.headSha === main.head &&
          trustedApp &&
          job.status === 'completed' &&
          job.conclusion === 'success') {
        satisfiedMainChecks.add(`${job.name}\u0000${job.appId}`);
      }
      if (job.status !== 'completed') {
        runHasIncompleteJob = true;
        failedJobs.push(Object.freeze({
          workflow: run.workflow,
          runName: run.runName,
          runId: run.runId,
          jobName: job.name,
          jobId: job.jobId,
          status: job.status,
          conclusion: job.conclusion
        }));
      } else if (!isAllowedMainJobConclusion(isDefaultOff, isAutomodeGatekeeper, job)) {
        runHasFailedJob = true;
        failedJobs.push(Object.freeze({
          workflow: run.workflow,
          runName: run.runName,
          runId: run.runId,
          jobName: job.name,
          jobId: job.jobId,
          status: job.status,
          conclusion: job.conclusion
        }));
      }
    }

    if (!isDefaultOff) {
      if (!validMainRunEvent(run.workflow, run.event) || !validMainRunName(run.workflow, run.runName)) {
        addReason(reasons, 'MAIN_WORKFLOW_METADATA_MISMATCH');
      }
    }

    if (run.status !== 'completed' || runHasIncompleteJob) {
      if (!failedWorkflows.includes(run.workflow)) failedWorkflows.push(run.workflow);
      addReason(reasons, 'MAIN_WORKFLOW_INCOMPLETE');
    } else {
      const runAllowed = isAllowedMainRunConclusion(
        isDefaultOff,
        isAutomodeGatekeeper,
        run.conclusion,
        allJobsSkipped,
        gatekeeperEvaluateConclusion
      );
      if (!runAllowed || runHasFailedJob) {
        if (!failedWorkflows.includes(run.workflow)) failedWorkflows.push(run.workflow);
        addReason(reasons, 'MAIN_WORKFLOW_FAILED');
      }
    }

    const requiredJobs = MAIN_WORKFLOW_REQUIRED_JOBS.get(run.workflow);
    if (requiredJobs !== undefined) {
      verifiedActiveWorkflows.add(run.workflow);
      if (requiredJobs.some(req => !presentJobs.has(req))) {
        addReason(reasons, 'MAIN_REQUIRED_JOB_MISSING');
      }
    }
  }

  if (ACTIVE_MAIN_WORKFLOWS.some(wf => !verifiedActiveWorkflows.has(wf))) {
    addReason(reasons, 'MAIN_ACTIVE_WORKFLOW_MISSING');
  }

  for (const [requiredContext, requiredIntegrationId] of requiredCheckMap) {
    if (!satisfiedMainChecks.has(`${requiredContext}\u0000${requiredIntegrationId}`)) {
      addReason(reasons, 'MAIN_REQUIRED_JOB_MISSING');
    }
  }

  const jsResult = auditJsCoverage(main.jsCoverage, main.head, lineMin, 'MAIN_JS_COVERAGE_INVALID', null, null);
  if (!jsResult.ok) addReason(reasons, jsResult.reason);

  const dotnetResult = auditDotnetCoverage(
    main.dotnetCoverage,
    main.head,
    lineMin,
    'MAIN_DOTNET_COVERAGE_INVALID'
  );
  if (!dotnetResult.ok) addReason(reasons, dotnetResult.reason);

  return {
    structuralError: false,
    reasons,
    failedWorkflows: Object.freeze(failedWorkflows),
    failedJobs: Object.freeze(failedJobs),
    jsSummary: jsResult.summary,
    dotnetSummary: dotnetResult.summary
  };
}

function validateCheckRecordArray(checks, seenJobIds) {
  if (!isDenseArray(checks, 64)) return null;
  const byName = new Map();
  for (let i = 0; i < checks.length; i++) {
    const c = checks[i];
    if (!exactPlainObject(c, ['name', 'jobId', 'appId', 'headSha', 'event', 'status', 'conclusion'], []) ||
        !isSafeText(c.name, 120) ||
        !isPositiveInt(c.jobId) ||
        seenJobIds.has(c.jobId) ||
        !isPositiveInt(c.appId) ||
        !isSha40(c.headSha) ||
        !isSafeText(c.event, 40) ||
        !isValidStatusConclusion(c.status, c.conclusion)) {
      return null;
    }
    seenJobIds.add(c.jobId);
    const existing = byName.get(c.name);
    if (existing === undefined) byName.set(c.name, [c]);
    else existing.push(c);
  }
  return byName;
}

const CANDIDATE_KEYS = [
  'prNumber',
  'head',
  'base',
  'headRepository',
  'headRepositoryId',
  'isFork',
  'pullChecks',
  'codeScanning',
  'secretScanningClear',
  'unresolvedInlineThreads',
  'trustedReviewers',
  'review',
  'mergeGroup',
  'jsCoverage'
];

const REVIEW_REQUIRED_KEYS = [
  'reviewId',
  'head',
  'reviewer',
  'author',
  'agent',
  'state',
  'independent',
  'summaryDisposition',
  'unresolvedSummaryFindings',
  'blockingReviewCount'
];

const ADDITIONAL_REVIEW_KEYS = ['reviewId', 'head', 'reviewer', 'state', 'independent'];

function hasCoverageDrop(candidateSummary, mainSummary) {
  if (BigInt(candidateSummary.lines) * BigInt(mainSummary.lineTotal) <
      BigInt(mainSummary.lines) * BigInt(candidateSummary.lineTotal)) {
    return true;
  }
  if (mainSummary.branchTotal > 0 && candidateSummary.branchTotal > 0) {
    return BigInt(candidateSummary.branches) * BigInt(mainSummary.branchTotal) <
      BigInt(mainSummary.branches) * BigInt(candidateSummary.branchTotal);
  }
  return false;
}

function auditCandidateSection(candidate, mainHead, mainAudit, lineMin, requiredApprovals, requiredCheckMap) {
  if (!exactPlainObject(
    candidate,
    CANDIDATE_KEYS,
    ['additionalReviews', 'dotnetCoverage', 'dotnetPathsChanged']
  ) ||
      !isPositiveInt(candidate.prNumber) ||
      !isSha40(candidate.head) ||
      !isSha40(candidate.base) ||
      !isRepoSlug(candidate.headRepository) ||
      !isPositiveInt(candidate.headRepositoryId) ||
      typeof candidate.isFork !== 'boolean' ||
      typeof candidate.secretScanningClear !== 'boolean' ||
      !isNonNegInt(candidate.unresolvedInlineThreads) ||
      !isDenseArray(candidate.trustedReviewers, 64) ||
      candidate.trustedReviewers.length === 0) {
    return {structuralError: true};
  }

  const hasDotnetPathsChanged = Object.hasOwn(candidate, 'dotnetPathsChanged');
  if (hasDotnetPathsChanged && typeof candidate.dotnetPathsChanged !== 'boolean') {
    return {structuralError: true};
  }
  const dotnetPathsChanged = hasDotnetPathsChanged ? candidate.dotnetPathsChanged : true;
  const hasCandidateDotnetCoverage = Object.hasOwn(candidate, 'dotnetCoverage');
  if (!hasCandidateDotnetCoverage && dotnetPathsChanged) {
    return {structuralError: true};
  }

  const trustedSet = new Set();
  for (let i = 0; i < candidate.trustedReviewers.length; i++) {
    const login = candidate.trustedReviewers[i];
    if (!isReviewerLogin(login)) return {structuralError: true};
    const lower = login.toLowerCase();
    if (trustedSet.has(lower)) return {structuralError: true};
    trustedSet.add(lower);
  }

  const seenCheckJobIds = new Set();
  const pullByName = validateCheckRecordArray(candidate.pullChecks, seenCheckJobIds);
  if (pullByName === null) return {structuralError: true};

  const cs = candidate.codeScanning;
  if (!exactPlainObject(
    cs,
    ['head', 'codeqlStatus', 'codeqlConclusion', 'openAlerts'],
    ['codeQualityStatus', 'codeQualityConclusion']
  ) ||
      !isSha40(cs.head) ||
      !isValidStatusConclusion(cs.codeqlStatus, cs.codeqlConclusion) ||
      !isNonNegInt(cs.openAlerts)) {
    return {structuralError: true};
  }
  const hasCodeQualityStatus = Object.hasOwn(cs, 'codeQualityStatus');
  const hasCodeQualityConclusion = Object.hasOwn(cs, 'codeQualityConclusion');
  if (hasCodeQualityStatus !== hasCodeQualityConclusion ||
      (hasCodeQualityStatus && !isValidStatusConclusion(cs.codeQualityStatus, cs.codeQualityConclusion))) {
    return {structuralError: true};
  }

  const rv = candidate.review;
  if (!exactPlainObject(rv, REVIEW_REQUIRED_KEYS, ['summaryBody']) ||
      !isPositiveInt(rv.reviewId) ||
      !isSha40(rv.head) ||
      !isReviewerLogin(rv.reviewer) ||
      !isReviewerLogin(rv.author) ||
      !isReviewerLogin(rv.agent) ||
      !REVIEW_STATES.has(rv.state) ||
      typeof rv.independent !== 'boolean' ||
      !SUMMARY_DISPOSITIONS.has(rv.summaryDisposition) ||
      !isNonNegInt(rv.unresolvedSummaryFindings) ||
      !isNonNegInt(rv.blockingReviewCount)) {
    return {structuralError: true};
  }
  const hasSummaryBody = Object.hasOwn(rv, 'summaryBody');
  if (hasSummaryBody &&
      (typeof rv.summaryBody !== 'string' || rv.summaryBody.length > 65536 || rv.summaryBody.includes('\u0000'))) {
    return {structuralError: true};
  }

  const hasAdditionalReviews = Object.hasOwn(candidate, 'additionalReviews');
  const seenReviewIds = new Set([rv.reviewId]);
  if (hasAdditionalReviews) {
    if (!isDenseArray(candidate.additionalReviews, 32)) return {structuralError: true};
    for (let i = 0; i < candidate.additionalReviews.length; i++) {
      const extra = candidate.additionalReviews[i];
      if (!exactPlainObject(extra, ADDITIONAL_REVIEW_KEYS, []) ||
          !isPositiveInt(extra.reviewId) ||
          seenReviewIds.has(extra.reviewId) ||
          !isSha40(extra.head) ||
          !isReviewerLogin(extra.reviewer) ||
          !REVIEW_STATES.has(extra.state) ||
          typeof extra.independent !== 'boolean') {
        return {structuralError: true};
      }
      seenReviewIds.add(extra.reviewId);
    }
  }

  const mg = candidate.mergeGroup;
  if (!exactPlainObject(mg, ['head', 'base', 'headRef', 'memberHeads', 'checks'], []) ||
      !isSha40(mg.head) ||
      !isSha40(mg.base) ||
      !isSafeText(mg.headRef, 200) ||
      !isDenseArray(mg.memberHeads, 5) ||
      mg.memberHeads.length === 0) {
    return {structuralError: true};
  }
  const memberSet = new Set();
  for (let i = 0; i < mg.memberHeads.length; i++) {
    const m = mg.memberHeads[i];
    if (!isSha40(m) || memberSet.has(m)) return {structuralError: true};
    memberSet.add(m);
  }
  const mgByName = validateCheckRecordArray(mg.checks, seenCheckJobIds);
  if (mgByName === null) return {structuralError: true};

  const reasons = [];

  if (candidate.base !== mainHead || candidate.head === mainHead) {
    addReason(reasons, 'CANDIDATE_BASE_MISMATCH');
  }

  const isForkOrigin =
    candidate.isFork ||
    candidate.headRepository !== SOFTWARE_FACTORY_REPO ||
    candidate.headRepositoryId !== SOFTWARE_FACTORY_REPO_ID;

  const effectiveRuntimeChecks = dotnetPathsChanged
    ? REQUIRED_CANDIDATE_RUNTIME_CHECKS
    : unconditionalCandidateRuntimeChecks;
  const effectivePullChecks = dotnetPathsChanged
    ? REQUIRED_CANDIDATE_PULL_CHECKS
    : unconditionalCandidatePullChecks;

  let anyRuntimeSkipped = false;
  let anyRuntimeMissing = false;
  for (let i = 0; i < effectiveRuntimeChecks.length; i++) {
    const entries = pullByName.get(effectiveRuntimeChecks[i]);
    if (entries === undefined) anyRuntimeMissing = true;
    else if (entries.some(e => e.conclusion === 'skipped')) anyRuntimeSkipped = true;
  }

  if (isForkOrigin) {
    addReason(reasons, anyRuntimeSkipped || anyRuntimeMissing ? 'FORK_PR_RUNTIME_CHECKS_SKIPPED' : 'FORK_PR_UNTRUSTED');
  } else if (anyRuntimeSkipped) {
    addReason(reasons, 'RUNTIME_CHECKS_SKIPPED');
  }

  let pullAllGreen = effectivePullChecks.every(name => pullByName.has(name));
  const satisfiedPullChecks = new Set();
  for (let i = 0; i < candidate.pullChecks.length; i++) {
    const c = candidate.pullChecks[i];
    if (c.headSha !== candidate.head) addReason(reasons, 'CANDIDATE_PULL_HEAD_MISMATCH');
    const trustedApp = isExpectedCheckAppId(c.name, c.appId, requiredCheckMap, false);
    if (!trustedApp) {
      addReason(reasons, 'UNTRUSTED_CHECK_APP');
    }
    const eventOk = requiredPullCheckSet.has(c.name)
      ? c.event === 'pull_request'
      : (c.event === 'pull_request' || c.event === 'dynamic');
    if (!eventOk || c.status !== 'completed' || c.conclusion !== 'success') {
      pullAllGreen = false;
    } else if (c.headSha === candidate.head && trustedApp) {
      satisfiedPullChecks.add(`${c.name}\u0000${c.appId}`);
    }
  }
  for (const [requiredContext, requiredIntegrationId] of requiredCheckMap) {
    if (!satisfiedPullChecks.has(`${requiredContext}\u0000${requiredIntegrationId}`)) {
      pullAllGreen = false;
    }
  }
  if (!pullAllGreen) addReason(reasons, 'CANDIDATE_PULL_CHECKS_FAILED');

  const codeQualityFailed =
    hasCodeQualityStatus &&
    (cs.codeQualityStatus !== 'completed' || cs.codeQualityConclusion !== 'success');
  if (cs.head !== candidate.head) {
    addReason(reasons, 'CANDIDATE_SECURITY_HEAD_MISMATCH');
  } else if (
    cs.codeqlStatus !== 'completed' ||
    cs.codeqlConclusion !== 'success' ||
    codeQualityFailed ||
    cs.openAlerts !== 0 ||
    !candidate.secretScanningClear
  ) {
    addReason(reasons, 'CANDIDATE_SECURITY_FAILED');
  }

  if (candidate.unresolvedInlineThreads > 0) {
    addReason(reasons, 'INLINE_REVIEW_THREADS_UNRESOLVED');
  }

  const reviewerLower = rv.reviewer.toLowerCase();
  const excludedSet = new Set([rv.author.toLowerCase(), rv.agent.toLowerCase()]);
  const qualifyingApprovers = new Set();
  const objectingReviewers = new Set();

  const primaryExactHead = rv.head === candidate.head;
  const primaryIndependent = rv.independent && trustedSet.has(reviewerLower) && !excludedSet.has(reviewerLower);
  const primaryBlocked =
    rv.blockingReviewCount > 0 ||
    rv.state === 'CHANGES_REQUESTED' ||
    rv.state === 'DISMISSED' ||
    rv.state === 'PENDING';

  if (!primaryExactHead) addReason(reasons, 'STALE_REVIEW_HEAD');
  if (!primaryIndependent) addReason(reasons, 'INDEPENDENT_REVIEW_REQUIRED');
  if (primaryBlocked) {
    objectingReviewers.add(reviewerLower);
    addReason(reasons, 'BLOCKING_OR_INCOMPLETE_REVIEW');
  }
  const isCopilotBot =
    reviewerLower === 'copilot-pull-request-reviewer' ||
    reviewerLower === 'copilot-pull-request-reviewer[bot]';
  if (!(rv.state === 'APPROVED' || (rv.state === 'COMMENTED' && isCopilotBot))) {
    addReason(reasons, 'REVIEW_NOT_APPROVED');
  }
  if (primaryExactHead && primaryIndependent && !primaryBlocked && rv.state === 'APPROVED') {
    qualifyingApprovers.add(reviewerLower);
  }

  if (hasAdditionalReviews) {
    for (let i = 0; i < candidate.additionalReviews.length; i++) {
      const extra = candidate.additionalReviews[i];
      const extraLower = extra.reviewer.toLowerCase();
      const extraBlocked =
        extra.state === 'CHANGES_REQUESTED' ||
        extra.state === 'DISMISSED' ||
        extra.state === 'PENDING';
      const extraExactHead = extra.head === candidate.head;
      const extraIndependent =
        extra.independent && trustedSet.has(extraLower) && !excludedSet.has(extraLower);

      if (extraBlocked) {
        objectingReviewers.add(extraLower);
        addReason(reasons, 'BLOCKING_OR_INCOMPLETE_REVIEW');
      }
      if (!extraExactHead) addReason(reasons, 'STALE_REVIEW_HEAD');
      if (!extraIndependent) addReason(reasons, 'INDEPENDENT_REVIEW_REQUIRED');
      if (!extraBlocked && extra.state !== 'APPROVED') addReason(reasons, 'REVIEW_NOT_APPROVED');
      if (extraExactHead && extraIndependent && !extraBlocked && extra.state === 'APPROVED') {
        qualifyingApprovers.add(extraLower);
      }
    }
  }

  for (const objecting of objectingReviewers) {
    qualifyingApprovers.delete(objecting);
  }
  if (qualifyingApprovers.size < requiredApprovals) {
    addReason(reasons, 'REVIEW_APPROVAL_COUNT_UNMET');
  }

  let bodyDispositionClear = !(isCopilotBot && rv.state === 'COMMENTED');
  if (hasSummaryBody && isCopilotBot) {
    const classified = classifyReviewSummary(rv.reviewId, rv.summaryBody);
    bodyDispositionClear = classified.summaryDisposition === 'clear' && classified.findings.length === 0;
  }
  if (!bodyDispositionClear || rv.summaryDisposition !== 'clear' || rv.unresolvedSummaryFindings > 0) {
    addReason(reasons, 'SUMMARY_REVIEW_FINDINGS_OPEN');
  }

  const expectedQueueRef = `gh-readonly-queue/main/pr-${candidate.prNumber}-${mainHead}`;
  if (mg.base !== mainHead ||
      mg.head === mainHead ||
      mg.head === candidate.head ||
      mg.headRef !== expectedQueueRef ||
      !memberSet.has(candidate.head) ||
      mg.memberHeads.some(m => m === mainHead || m === mg.head)) {
    addReason(reasons, 'MERGE_GROUP_SHA_MISMATCH');
  }

  let mgAllGreen = REQUIRED_MERGE_GROUP_CHECKS.every(name => mgByName.has(name));
  const satisfiedMgChecks = new Set();
  for (let i = 0; i < mg.checks.length; i++) {
    const c = mg.checks[i];
    if (c.headSha !== mg.head) addReason(reasons, 'MERGE_GROUP_SHA_MISMATCH');
    const trustedApp = isExpectedCheckAppId(c.name, c.appId, requiredCheckMap, false);
    if (!trustedApp) {
      addReason(reasons, 'UNTRUSTED_CHECK_APP');
    }
    if (c.event !== 'merge_group') addReason(reasons, 'MERGE_GROUP_EVENT_MISMATCH');
    if (c.status !== 'completed' || c.conclusion !== 'success') {
      mgAllGreen = false;
    } else if (c.headSha === mg.head && trustedApp && c.event === 'merge_group') {
      satisfiedMgChecks.add(`${c.name}\u0000${c.appId}`);
    }
  }
  for (const [requiredContext, requiredIntegrationId] of requiredCheckMap) {
    if (!satisfiedMgChecks.has(`${requiredContext}\u0000${requiredIntegrationId}`)) {
      mgAllGreen = false;
    }
  }
  if (!mgAllGreen) addReason(reasons, 'MERGE_GROUP_CHECKS_FAILED');

  const jsResult = auditJsCoverage(
    candidate.jsCoverage,
    candidate.head,
    lineMin,
    'CANDIDATE_JS_COVERAGE_INVALID',
    trustedSet,
    excludedSet
  );
  if (!jsResult.ok) {
    addReason(reasons, jsResult.reason);
  } else if (mainAudit.jsSummary === null) {
    addReason(reasons, 'MAIN_BASE_COVERAGE_UNVERIFIED');
  } else if (hasCoverageDrop(jsResult.summary, mainAudit.jsSummary)) {
    addReason(reasons, 'JS_COVERAGE_REGRESSION');
  }

  let candDotnetSummary = null;
  if (hasCandidateDotnetCoverage) {
    const dotnetResult = auditDotnetCoverage(
      candidate.dotnetCoverage,
      candidate.head,
      lineMin,
      'CANDIDATE_DOTNET_COVERAGE_INVALID'
    );
    candDotnetSummary = dotnetResult.summary;
    if (!dotnetResult.ok) {
      addReason(reasons, dotnetResult.reason);
    } else if (mainAudit.dotnetSummary === null) {
      addReason(reasons, 'MAIN_BASE_COVERAGE_UNVERIFIED');
    } else if (hasCoverageDrop(dotnetResult.summary, mainAudit.dotnetSummary)) {
      addReason(reasons, 'DOTNET_COVERAGE_REGRESSION');
    }
  }

  return {
    structuralError: false,
    candidateHead: candidate.head,
    mergeGroupHead: mg.head,
    reasons,
    jsSummary: jsResult.summary,
    dotnetSummary: candDotnetSummary
  };
}

export function auditProtectedMainAndCandidateGates(input) {
  if (!exactPlainObject(input, ['repository', 'repositoryId', 'branch', 'ruleset', 'main'], ['candidate']) ||
      !isRepoSlug(input.repository) ||
      !isPositiveInt(input.repositoryId) ||
      !isSafeText(input.branch, 120)) {
    return invalidResult('INVALID_INPUT');
  }
  if (input.repository !== SOFTWARE_FACTORY_REPO ||
      input.repositoryId !== SOFTWARE_FACTORY_REPO_ID ||
      input.branch !== 'main') {
    return invalidResult('SCOPE_MISMATCH');
  }

  const rules = auditRuleset(input.ruleset);
  if (rules.structuralError) return invalidResult('INVALID_INPUT');

  const mainAudit = auditMainSection(input.main, rules.lineMin, rules.requiredCheckMap);
  if (mainAudit.structuralError) return invalidResult('INVALID_INPUT');

  let candAudit = null;
  if (Object.hasOwn(input, 'candidate')) {
    candAudit = auditCandidateSection(
      input.candidate,
      input.main.head,
      mainAudit,
      rules.lineMin,
      rules.requiredApprovals,
      rules.requiredCheckMap
    );
    if (candAudit.structuralError) return invalidResult('INVALID_INPUT');
  }

  const failureReasons = [];
  for (let i = 0; i < mainAudit.reasons.length; i++) {
    addReason(failureReasons, mainAudit.reasons[i]);
  }
  if (!rules.ok) addReason(failureReasons, rules.reason);
  if (candAudit !== null) {
    for (let i = 0; i < candAudit.reasons.length; i++) {
      addReason(failureReasons, candAudit.reasons[i]);
    }
  }

  const mainHealthy = rules.ok && mainAudit.reasons.length === 0;
  const candidateEvaluated = candAudit !== null;
  const candidateHealthy = candAudit === null ? null : (rules.ok && candAudit.reasons.length === 0);
  const valid = mainHealthy && (candAudit === null || candidateHealthy === true);
  const eligible = candidateEvaluated && valid;
  const reason = valid
    ? (candidateEvaluated ? 'MAIN_AND_CANDIDATE_HEALTHY' : 'MAIN_HEALTHY')
    : failureReasons[0];

  return Object.freeze({
    shadow: true,
    liveMerge: false,
    liveDispatch: false,
    valid,
    eligible,
    mainHealthy,
    dependentWorkAllowed: mainHealthy,
    candidateEvaluated,
    candidateHealthy,
    reason,
    failureReasons: Object.freeze(failureReasons),
    repository: input.repository,
    repositoryId: input.repositoryId,
    branch: input.branch,
    mainHead: input.main.head,
    candidateHead: candAudit === null ? null : candAudit.candidateHead,
    mergeGroupHead: candAudit === null ? null : candAudit.mergeGroupHead,
    failedMainWorkflows: mainAudit.failedWorkflows,
    failedMainJobs: mainAudit.failedJobs,
    coverageSummary: Object.freeze({
      mainJs: mainAudit.jsSummary,
      mainDotnet: mainAudit.dotnetSummary,
      candidateJs: candAudit === null ? null : candAudit.jsSummary,
      candidateDotnet: candAudit === null ? null : candAudit.dotnetSummary
    })
  });
}
