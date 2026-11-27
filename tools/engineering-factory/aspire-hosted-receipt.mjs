// Deterministic, metadata-only, fail-closed cross-OS GitHub-hosted Aspire 17 and
// OpenTelemetry runtime receipt verifier. Zero network, filesystem, or live side effects.
import {types} from 'node:util';

export const SOFTWARE_FACTORY_REPOSITORY = 'Jamula/SoftwareFactory';
export const SOFTWARE_FACTORY_REPOSITORY_ID = 1471342715;
export const HOSTED_RECEIPT_SCHEMA_VERSION = 1;
export const HOSTED_RECEIPT_MILESTONE = 'M01.02';

export const PINNED_HOSTED_RUNTIME_TOOLCHAIN = Object.freeze({
  runnerEnvironment: 'github-hosted',
  runnerGroupName: 'GitHub Actions',
  nodeVersion: 'v26.13.1',
  dotnetVersion: '10.0.404',
  aspireVersion: '17.0.0'
});

export const REQUIRED_HOSTED_PLATFORMS = Object.freeze({
  linux: Object.freeze({
    os: 'linux',
    runnerLabel: 'ubuntu-latest',
    jobName: 'linux-aspire-runtime',
    workflowPath: '.github/workflows/validate.yml',
    allowedTraceReadbackMethods: Object.freeze(['cli-export-zip', 'authenticated-https-api'])
  }),
  windows: Object.freeze({
    os: 'windows',
    runnerLabel: 'windows-latest',
    jobName: 'windows-aspire-runtime',
    workflowPath: '.github/workflows/windows-aspire.yml',
    allowedTraceReadbackMethods: Object.freeze(['authenticated-https-api'])
  })
});

export const REQUIRED_SYNTHETIC_SIGNAL_CONTRACT = Object.freeze({
  serviceName: 'softwarefactory-shadow',
  scopeName: 'softwarefactory',
  syntheticScenario: 'local-synthetic-stop',
  syntheticResultState: 'blocked',
  syntheticResultReason: 'STOPPED',
  spanName: 'factory.evaluate',
  correlatedLogBody: 'factory.stage.completed',
  sqlitePersistenceMode: 'Run',
  metricReceiptTool: 'tools/engineering-factory/verify-dashboard-metric-receipt.mjs',
  counterInstrument: 'factory.stage.count',
  counterTemporality: 'cumulative',
  counterValue: 1,
  histogramInstrument: 'factory.stage.duration',
  histogramUnit: 'ms',
  histogramTemporality: 'cumulative',
  histogramCount: 1,
  recordedLabels: Object.freeze({
    stage: 'evaluate',
    outcome: 'blocked',
    reason: 'POLICY'
  })
});

export const REQUIRED_MAF_ACTIVITY_SOURCE = 'Microsoft.Agents.AI.Workflows';
export const REQUIRED_AGENTS_ACTIVITY_SOURCE = 'SoftwareFactory.Agents';
export const ALLOWED_MAF_ACTIVITY_SOURCES = Object.freeze([
  REQUIRED_MAF_ACTIVITY_SOURCE,
  REQUIRED_AGENTS_ACTIVITY_SOURCE,
  'Experimental.Microsoft.Agents.AI'
]);

export const REQUIRED_APPHOST_PACKAGES = Object.freeze({
  'Aspire.Hosting.AppHost': '17.0.0',
  'Aspire.Hosting.Dotnet': '17.0.0',
  'Aspire.Hosting.JavaScript': '17.0.0'
});

export const MINIMUM_MAF_PACKAGE_VERSION = Object.freeze([1, 28, 0]);
export const REQUIRED_MAF_AGENT_PACKAGES = Object.freeze([
  'Microsoft.Agents.AI',
  'Microsoft.Agents.AI.GitHub.Copilot',
  'Microsoft.Agents.AI.Workflows'
]);
export const REQUIRED_OTEL_AGENT_PACKAGES = Object.freeze([
  'OpenTelemetry',
  'OpenTelemetry.Exporter.OpenTelemetryProtocol'
]);

const TRACE_READBACK_TOOLS = new Map([
  ['cli-export-zip', 'tools/engineering-factory/verify-dashboard-export.mjs'],
  ['authenticated-https-api', 'tools/engineering-factory/verify-dashboard-api.mjs']
]);
const ALLOWED_EVENTS = new Set(['push', 'pull_request', 'merge_group']);
const ALLOWED_ACTIVITY_SOURCE_SET = new Set(ALLOWED_MAF_ACTIVITY_SOURCES);
const MAX_DURATION_MS = 3_600_000;
const MAX_SOURCE_CHARS = 262_144;
const SHA40_NONZERO_RE = /^(?!0{40})[0-9a-f]{40}$/;
const SAFE_BRANCH_CHARS_RE = /^[^\u0000-\u0020\u007f~^:?*[\\]{1,200}$/;
const ISO_UTC_SECONDS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const LOOPBACK_HTTPS_ORIGIN_RE = /^https:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/;
const PACKAGE_NAME_RE = /^[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const XML_PROP_NAME_RE = /^[A-Za-z][A-Za-z0-9]*$/;
const CSPROJ_PKG_ATTRS_RE = /^PackageReference\s+Include="([^"]+)"\s+Version="([^"]+)"$/;
const RETIRED_GITHUB_MODELS_RE = /github\.?models/i;
const EXCLUDED_AGENT_FRAMEWORK_RE = /(?:^|[^A-Za-z0-9])(?:semantickernel|semantic[_-]kernel|autogen)(?:$|[^A-Za-z0-9])/i;
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const EVIDENCE_KEYS = [
  'schemaVersion',
  'milestone',
  'issueNumber',
  'repository',
  'repositoryId',
  'branch',
  'headSha',
  'laptopDependency',
  'incrementalUnapprovedSpendUsdCents',
  'platforms',
  'mafReadiness'
];
const PLATFORMS_KEYS = ['linux', 'windows'];
const PLATFORM_RECEIPT_KEYS = [
  'os',
  'runnerLabel',
  'runnerEnvironment',
  'runnerGroupName',
  'workflowName',
  'workflowPath',
  'jobName',
  'runId',
  'jobId',
  'runUrl',
  'jobUrl',
  'event',
  'headBranch',
  'headSha',
  'status',
  'conclusion',
  'startedAt',
  'completedAt',
  'durationMs',
  'nodeVersion',
  'dotnetVersion',
  'aspireVersion',
  'pythonInvocations',
  'sdkShutdownVerified',
  'appHostCleanStop',
  'loopbackAuth',
  'telemetry'
];
const LOOPBACK_AUTH_KEYS = [
  'otlpEndpoint',
  'otlpProtocol',
  'dashboardHttpsLoopbackVerified',
  'loginChallengeVerified',
  'api401VerifierTestPassed',
  'liveApi401ChallengeVerified',
  'anonymousAllowed',
  'unsecuredTransportAllowed',
  'tlsVerificationBypassed',
  'rootStoreMutated'
];
const TELEMETRY_KEYS = [
  'serviceName',
  'scopeName',
  'syntheticScenario',
  'syntheticResultState',
  'syntheticResultReason',
  'traceReadbackMethod',
  'traceReadbackTool',
  'spanName',
  'traceVerified',
  'correlatedLogBody',
  'correlatedLogVerified',
  'traceSpanCorrelationVerified',
  'sqlitePersistenceMode',
  'sqliteReadOnlyVerified',
  'metricReceiptTool',
  'counterInstrument',
  'counterMonotonic',
  'counterTemporality',
  'counterValue',
  'counterVerified',
  'histogramInstrument',
  'histogramUnit',
  'histogramTemporality',
  'histogramCount',
  'histogramVerified',
  'recordedLabels',
  'rawTelemetryPublished',
  'tempArtifactsCleaned'
];
const RECORDED_LABEL_KEYS = ['stage', 'outcome', 'reason'];
const MAF_READINESS_KEYS = [
  'headSha',
  'workflowRunId',
  'workflowRunUrl',
  'linuxAgentJobId',
  'windowsAgentJobId',
  'appHostResourceName',
  'appHostProjectPath',
  'explicitStartOnly',
  'copilotSkipCliDownload',
  'loopbackOtlpOnly',
  'authenticatedHeadersRequired',
  'retiredGitHubModelsReferenced',
  'activitySources',
  'appHostPackages',
  'agentPackages'
];
const PACKAGE_ITEM_KEYS = ['name', 'version'];
const MANIFEST_INPUT_KEYS = [
  'appHostSource',
  'agentsCsprojSource',
  'localOtlpBootstrapSource',
  'telemetrySource'
];

const deny = reason => Object.freeze({
  shadow: true,
  valid: false,
  liveDispatch: false,
  liveMerge: false,
  reason
});

const positiveId = value => Number.isSafeInteger(value) && value > 0 && value <= 1_000_000_000_000_000;
const isSha40 = value => typeof value === 'string' && SHA40_NONZERO_RE.test(value);
const isSafeText = value =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 160 && !CONTROL_CHAR_RE.test(value);
const isSafeBranchName = value =>
  typeof value === 'string' && SAFE_BRANCH_CHARS_RE.test(value) &&
  !value.startsWith('/') && !value.endsWith('/') && !value.includes('//') && !value.includes('..');

function hasOwnEnumerableData(target, key) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor !== undefined &&
    descriptor.enumerable === true &&
    Object.hasOwn(descriptor, 'value') &&
    descriptor.value !== undefined;
}

export function isPlainDataRecord(value, requiredKeys) {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  const allowed = new Set(requiredKeys);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== allowed.size) return false;
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !allowed.has(key) || !hasOwnEnumerableData(value, key)) {
      return false;
    }
  }
  return true;
}

export function isDenseDataArray(value, minLen = 1, maxLen = 64) {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype || value.length < minLen || value.length > maxLen ||
      Reflect.ownKeys(value).length !== value.length + 1) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    if (!hasOwnEnumerableData(value, String(i))) return false;
  }
  return true;
}

export function isRetiredGitHubModelsPackage(packageName) {
  return typeof packageName === 'string' && RETIRED_GITHUB_MODELS_RE.test(packageName);
}

export function isValidLoopbackHttpsOrigin(rawOrigin) {
  if (typeof rawOrigin !== 'string') return false;
  const match = LOOPBACK_HTTPS_ORIGIN_RE.exec(rawOrigin);
  return match !== null && Number(match[1]) <= 65535;
}

function parseIsoUtcSeconds(rawTimestamp) {
  if (typeof rawTimestamp !== 'string' || !ISO_UTC_SECONDS_RE.test(rawTimestamp)) return null;
  const parsedMs = Date.parse(rawTimestamp);
  if (!Number.isFinite(parsedMs)) return null;
  return new Date(parsedMs).toISOString().replace('.000Z', 'Z') === rawTimestamp ? parsedMs : null;
}

function parseSemverTuple(rawVersion) {
  if (typeof rawVersion !== 'string') return null;
  const match = SEMVER_RE.exec(rawVersion);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function semverAtLeast(tuple, minimum) {
  for (let i = 0; i < 3; i++) {
    if (tuple[i] !== minimum[i]) return tuple[i] > minimum[i];
  }
  return true;
}

function validatePackageInventory(items) {
  if (!isDenseDataArray(items, 1, 32)) return {ok: false, reason: 'MAF_ACTIVITY_SOURCE_UNREADY'};
  const map = new Map();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!isPlainDataRecord(item, PACKAGE_ITEM_KEYS) ||
        typeof item.name !== 'string' || item.name.length > 128 || !PACKAGE_NAME_RE.test(item.name)) {
      return {ok: false, reason: 'MAF_ACTIVITY_SOURCE_UNREADY'};
    }
    if (isRetiredGitHubModelsPackage(item.name)) {
      return {ok: false, reason: 'RETIRED_GITHUB_MODELS_PACKAGE_FORBIDDEN'};
    }
    if (EXCLUDED_AGENT_FRAMEWORK_RE.test(item.name)) {
      return {ok: false, reason: 'EXCLUDED_AGENT_FRAMEWORK_FORBIDDEN'};
    }
    const tuple = parseSemverTuple(item.version);
    if (tuple === null || map.has(item.name)) {
      return {ok: false, reason: 'MAF_ACTIVITY_SOURCE_UNREADY'};
    }
    map.set(item.name, {version: item.version, tuple});
  }
  return {ok: true, map};
}

function validateLoopbackAuth(auth, traceReadbackMethod) {
  if (!isPlainDataRecord(auth, LOOPBACK_AUTH_KEYS)) return false;
  if (typeof auth.liveApi401ChallengeVerified !== 'boolean') return false;
  if (traceReadbackMethod === 'authenticated-https-api' && auth.liveApi401ChallengeVerified !== true) {
    return false;
  }
  return isValidLoopbackHttpsOrigin(auth.otlpEndpoint) &&
    auth.otlpProtocol === 'http/protobuf' &&
    auth.dashboardHttpsLoopbackVerified === true &&
    auth.loginChallengeVerified === true &&
    auth.api401VerifierTestPassed === true &&
    auth.anonymousAllowed === false &&
    auth.unsecuredTransportAllowed === false &&
    auth.tlsVerificationBypassed === false &&
    auth.rootStoreMutated === false;
}

function validateTelemetryReceipt(telemetry, platformSpec) {
  if (!isPlainDataRecord(telemetry, TELEMETRY_KEYS) ||
      !isPlainDataRecord(telemetry.recordedLabels, RECORDED_LABEL_KEYS)) {
    return false;
  }
  const c = REQUIRED_SYNTHETIC_SIGNAL_CONTRACT;
  const expectedLabels = c.recordedLabels;
  if (!platformSpec.allowedTraceReadbackMethods.includes(telemetry.traceReadbackMethod) ||
      telemetry.traceReadbackTool !== TRACE_READBACK_TOOLS.get(telemetry.traceReadbackMethod)) {
    return false;
  }
  return telemetry.serviceName === c.serviceName &&
    telemetry.scopeName === c.scopeName &&
    telemetry.syntheticScenario === c.syntheticScenario &&
    telemetry.syntheticResultState === c.syntheticResultState &&
    telemetry.syntheticResultReason === c.syntheticResultReason &&
    telemetry.spanName === c.spanName &&
    telemetry.traceVerified === true &&
    telemetry.correlatedLogBody === c.correlatedLogBody &&
    telemetry.correlatedLogVerified === true &&
    telemetry.traceSpanCorrelationVerified === true &&
    telemetry.sqlitePersistenceMode === c.sqlitePersistenceMode &&
    telemetry.sqliteReadOnlyVerified === true &&
    telemetry.metricReceiptTool === c.metricReceiptTool &&
    telemetry.counterInstrument === c.counterInstrument &&
    telemetry.counterMonotonic === true &&
    telemetry.counterTemporality === c.counterTemporality &&
    telemetry.counterValue === c.counterValue &&
    telemetry.counterVerified === true &&
    telemetry.histogramInstrument === c.histogramInstrument &&
    telemetry.histogramUnit === c.histogramUnit &&
    telemetry.histogramTemporality === c.histogramTemporality &&
    telemetry.histogramCount === c.histogramCount &&
    telemetry.histogramVerified === true &&
    telemetry.recordedLabels.stage === expectedLabels.stage &&
    telemetry.recordedLabels.outcome === expectedLabels.outcome &&
    telemetry.recordedLabels.reason === expectedLabels.reason &&
    telemetry.rawTelemetryPublished === false &&
    telemetry.tempArtifactsCleaned === true;
}

function validatePlatformReceipt(receipt, platformSpec, envelope) {
  if (!isPlainDataRecord(receipt, PLATFORM_RECEIPT_KEYS)) return {ok: false, reason: 'INVALID_PLATFORM_RECEIPT'};
  if (receipt.os !== platformSpec.os || receipt.runnerLabel !== platformSpec.runnerLabel) {
    return {ok: false, reason: 'RUNNER_IMAGE_MISMATCH'};
  }
  if (receipt.runnerEnvironment !== PINNED_HOSTED_RUNTIME_TOOLCHAIN.runnerEnvironment ||
      receipt.runnerGroupName !== PINNED_HOSTED_RUNTIME_TOOLCHAIN.runnerGroupName) {
    return {ok: false, reason: 'NON_GITHUB_HOSTED_RUNNER'};
  }
  if (receipt.jobName !== platformSpec.jobName || receipt.workflowPath !== platformSpec.workflowPath ||
      !isSafeText(receipt.workflowName)) {
    return {ok: false, reason: 'JOB_IDENTITY_MISMATCH'};
  }
  if (!positiveId(receipt.runId) || !positiveId(receipt.jobId)) {
    return {ok: false, reason: 'INVALID_PLATFORM_RECEIPT'};
  }
  const expectedRunUrl = `https://github.com/${envelope.repository}/actions/runs/${receipt.runId}`;
  const expectedJobUrl = `${expectedRunUrl}/job/${receipt.jobId}`;
  if (receipt.runUrl !== expectedRunUrl || receipt.jobUrl !== expectedJobUrl) {
    return {ok: false, reason: 'RUN_URL_MISMATCH'};
  }
  if (!isSha40(receipt.headSha) || receipt.headSha !== envelope.headSha) {
    return {ok: false, reason: 'HEAD_SHA_MISMATCH'};
  }
  if (receipt.headBranch !== envelope.branch) {
    return {ok: false, reason: 'BRANCH_MISMATCH'};
  }
  if (!ALLOWED_EVENTS.has(receipt.event) || receipt.status !== 'completed' || receipt.conclusion !== 'success') {
    return {ok: false, reason: 'RUNTIME_JOB_NOT_SUCCESSFUL'};
  }
  const startedMs = parseIsoUtcSeconds(receipt.startedAt);
  const completedMs = parseIsoUtcSeconds(receipt.completedAt);
  if (startedMs === null || completedMs === null || completedMs <= startedMs ||
      !Number.isSafeInteger(receipt.durationMs) || receipt.durationMs !== completedMs - startedMs ||
      receipt.durationMs > MAX_DURATION_MS) {
    return {ok: false, reason: 'INVALID_TIMING'};
  }
  if (receipt.nodeVersion !== PINNED_HOSTED_RUNTIME_TOOLCHAIN.nodeVersion ||
      receipt.dotnetVersion !== PINNED_HOSTED_RUNTIME_TOOLCHAIN.dotnetVersion ||
      receipt.aspireVersion !== PINNED_HOSTED_RUNTIME_TOOLCHAIN.aspireVersion) {
    return {ok: false, reason: 'TOOLCHAIN_PIN_MISMATCH'};
  }
  if (!Number.isSafeInteger(receipt.pythonInvocations) || receipt.pythonInvocations < 0) {
    return {ok: false, reason: 'INVALID_PLATFORM_RECEIPT'};
  }
  if (receipt.pythonInvocations !== 0) {
    return {ok: false, reason: 'PYTHON_INVOCATION_FORBIDDEN'};
  }
  if (!validateTelemetryReceipt(receipt.telemetry, platformSpec)) {
    return {ok: false, reason: 'TELEMETRY_RECEIPT_UNVERIFIED'};
  }
  if (!validateLoopbackAuth(receipt.loopbackAuth, receipt.telemetry.traceReadbackMethod)) {
    return {ok: false, reason: 'LOOPBACK_AUTH_UNVERIFIED'};
  }
  if (receipt.sdkShutdownVerified !== true) {
    return {ok: false, reason: 'SDK_SHUTDOWN_UNVERIFIED'};
  }
  if (receipt.appHostCleanStop !== true) {
    return {ok: false, reason: 'APPHOST_STOP_UNVERIFIED'};
  }
  return {ok: true};
}

function validateMafReadiness(maf, envelope, seenRunIds, seenJobIds) {
  if (!isPlainDataRecord(maf, MAF_READINESS_KEYS)) {
    return {ok: false, reason: 'MAF_ACTIVITY_SOURCE_UNREADY'};
  }
  if (!isSha40(maf.headSha) || maf.headSha !== envelope.headSha) {
    return {ok: false, reason: 'HEAD_SHA_MISMATCH'};
  }
  if (maf.retiredGitHubModelsReferenced !== false) {
    return {ok: false, reason: 'RETIRED_GITHUB_MODELS_PACKAGE_FORBIDDEN'};
  }
  if (!positiveId(maf.workflowRunId) || !positiveId(maf.linuxAgentJobId) || !positiveId(maf.windowsAgentJobId) ||
      maf.linuxAgentJobId === maf.windowsAgentJobId || seenRunIds.has(maf.workflowRunId) ||
      seenJobIds.has(maf.linuxAgentJobId) || seenJobIds.has(maf.windowsAgentJobId)) {
    return {ok: false, reason: 'DUPLICATE_RUN_OR_JOB_ID'};
  }
  const expectedRunUrl = `https://github.com/${envelope.repository}/actions/runs/${maf.workflowRunId}`;
  if (maf.workflowRunUrl !== expectedRunUrl) {
    return {ok: false, reason: 'RUN_URL_MISMATCH'};
  }
  if (maf.appHostResourceName !== 'maf-specialist-shadow' ||
      maf.appHostProjectPath !== 'src/SoftwareFactory.Agents/SoftwareFactory.Agents.csproj' ||
      maf.explicitStartOnly !== true || maf.copilotSkipCliDownload !== true ||
      maf.loopbackOtlpOnly !== true || maf.authenticatedHeadersRequired !== true) {
    return {ok: false, reason: 'MAF_ACTIVITY_SOURCE_UNREADY'};
  }
  if (!isDenseDataArray(maf.activitySources, 1, 16)) {
    return {ok: false, reason: 'MAF_ACTIVITY_SOURCE_UNREADY'};
  }
  const sources = new Set();
  for (let i = 0; i < maf.activitySources.length; i++) {
    const source = maf.activitySources[i];
    if (typeof source !== 'string' || !ALLOWED_ACTIVITY_SOURCE_SET.has(source) || sources.has(source)) {
      return {ok: false, reason: 'MAF_ACTIVITY_SOURCE_UNREADY'};
    }
    sources.add(source);
  }
  if (!sources.has(REQUIRED_MAF_ACTIVITY_SOURCE) || !sources.has(REQUIRED_AGENTS_ACTIVITY_SOURCE)) {
    return {ok: false, reason: 'MAF_ACTIVITY_SOURCE_UNREADY'};
  }
  const appHostPkg = validatePackageInventory(maf.appHostPackages);
  if (!appHostPkg.ok) return appHostPkg;
  for (const [pkgName, pinnedVersion] of Object.entries(REQUIRED_APPHOST_PACKAGES)) {
    const entry = appHostPkg.map.get(pkgName);
    if (!entry || entry.version !== pinnedVersion) {
      return {ok: false, reason: 'MAF_ACTIVITY_SOURCE_UNREADY'};
    }
  }
  const agentPkg = validatePackageInventory(maf.agentPackages);
  if (!agentPkg.ok) return agentPkg;
  for (const pkgName of REQUIRED_MAF_AGENT_PACKAGES) {
    const entry = agentPkg.map.get(pkgName);
    if (!entry || !semverAtLeast(entry.tuple, MINIMUM_MAF_PACKAGE_VERSION)) {
      return {ok: false, reason: 'MAF_ACTIVITY_SOURCE_UNREADY'};
    }
  }
  for (const pkgName of REQUIRED_OTEL_AGENT_PACKAGES) {
    if (!agentPkg.map.has(pkgName)) {
      return {ok: false, reason: 'MAF_ACTIVITY_SOURCE_UNREADY'};
    }
  }
  return {ok: true};
}

export function verifyCrossOsAspireRuntimeEvidence(evidence) {
  if (!isPlainDataRecord(evidence, EVIDENCE_KEYS)) return deny('EVIDENCE_UNKNOWN');
  if (evidence.schemaVersion !== HOSTED_RECEIPT_SCHEMA_VERSION ||
      evidence.milestone !== HOSTED_RECEIPT_MILESTONE ||
      !positiveId(evidence.issueNumber) ||
      evidence.repository !== SOFTWARE_FACTORY_REPOSITORY ||
      evidence.repositoryId !== SOFTWARE_FACTORY_REPOSITORY_ID ||
      !isSafeBranchName(evidence.branch) ||
      !isSha40(evidence.headSha)) {
    return deny('ENVELOPE_IDENTITY_INVALID');
  }
  if (evidence.laptopDependency !== false) {
    return deny('LAPTOP_DEPENDENCY_FORBIDDEN');
  }
  if (!Number.isSafeInteger(evidence.incrementalUnapprovedSpendUsdCents) ||
      evidence.incrementalUnapprovedSpendUsdCents !== 0) {
    return deny('UNAPPROVED_SPEND_FORBIDDEN');
  }
  if (!isPlainDataRecord(evidence.platforms, PLATFORMS_KEYS)) {
    return deny('PLATFORMS_INCOMPLETE');
  }
  const linux = evidence.platforms.linux;
  const windows = evidence.platforms.windows;
  const linuxCheck = validatePlatformReceipt(linux, REQUIRED_HOSTED_PLATFORMS.linux, evidence);
  if (!linuxCheck.ok) return deny(linuxCheck.reason);
  const windowsCheck = validatePlatformReceipt(windows, REQUIRED_HOSTED_PLATFORMS.windows, evidence);
  if (!windowsCheck.ok) return deny(windowsCheck.reason);
  if (linux.runId === windows.runId || linux.jobId === windows.jobId) {
    return deny('DUPLICATE_RUN_OR_JOB_ID');
  }
  const mafCheck = validateMafReadiness(
    evidence.mafReadiness,
    evidence,
    new Set([linux.runId, windows.runId]),
    new Set([linux.jobId, windows.jobId])
  );
  if (!mafCheck.ok) return deny(mafCheck.reason);
  return Object.freeze({
    shadow: true,
    valid: true,
    liveDispatch: false,
    liveMerge: false,
    reason: 'CROSS_OS_HOSTED_ASPIRE_VERIFIED',
    repository: evidence.repository,
    repositoryId: evidence.repositoryId,
    headSha: evidence.headSha,
    linuxRunId: linux.runId,
    linuxJobId: linux.jobId,
    windowsRunId: windows.runId,
    windowsJobId: windows.jobId,
    mafWorkflowRunId: evidence.mafReadiness.workflowRunId,
    mafWorkflowsSourceReady: true
  });
}

function scanCSharpSource(rawSource, allowPackageDirectives) {
  const source = rawSource.replaceAll('\r\n', '\n');
  if (source.includes('\r')) return null;
  const directives = [];
  const statements = [];
  let current = '';
  let atLineStart = true;
  let seenCodeToken = false;
  let braceDepth = 0;
  const appendSpace = () => {
    if (current.length > 0 && !current.endsWith(' ')) current += ' ';
  };
  const flushStatement = () => {
    const trimmed = current.trim();
    if (trimmed.length > 0) statements.push({text: trimmed, braceDepth});
    current = '';
  };

  for (let i = 0; i < source.length;) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t') {
      appendSpace();
      i++;
      continue;
    }
    if (ch === '\n') {
      appendSpace();
      atLineStart = true;
      i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i + 2);
      appendSpace();
      if (nl === -1) break;
      atLineStart = true;
      i = nl + 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) return null;
      appendSpace();
      atLineStart = false;
      i = end + 2;
      continue;
    }
    if (atLineStart && ch === '#') {
      const nl = source.indexOf('\n', i);
      const line = nl === -1 ? source.slice(i) : source.slice(i, nl);
      if (!allowPackageDirectives || seenCodeToken || !line.startsWith('#:package')) {
        return null;
      }
      directives.push(line.trim());
      if (nl === -1) break;
      atLineStart = true;
      i = nl + 1;
      continue;
    }
    atLineStart = false;
    seenCodeToken = true;
    if (ch === '@' && source[i + 1] === '"') {
      current += '@"';
      i += 2;
      let closed = false;
      while (i < source.length) {
        if (source[i] === '"' && source[i + 1] === '"') {
          current += '""';
          i += 2;
        } else if (source[i] === '"') {
          current += '"';
          i++;
          closed = true;
          break;
        } else {
          current += source[i++];
        }
      }
      if (!closed) return null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (ch === '"' && source[i + 1] === '"' && source[i + 2] === '"') return null;
      const quote = ch;
      current += quote;
      i++;
      let closed = false;
      while (i < source.length && source[i] !== '\n') {
        if (source[i] === '\\') {
          if (i + 1 >= source.length || source[i + 1] === '\n') return null;
          current += source.slice(i, i + 2);
          i += 2;
        } else if (source[i] === quote) {
          current += quote;
          i++;
          closed = true;
          break;
        } else {
          current += source[i++];
        }
      }
      if (!closed) return null;
      continue;
    }
    if (ch === ';') {
      flushStatement();
      i++;
      continue;
    }
    if (ch === '{') {
      flushStatement();
      braceDepth++;
      i++;
      continue;
    }
    if (ch === '}') {
      flushStatement();
      braceDepth--;
      if (braceDepth < 0) return null;
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (braceDepth !== 0) return null;
  flushStatement();
  return {directives, statements};
}

function stripXmlComments(rawXml) {
  const xml = rawXml.replaceAll('\r\n', '\n');
  if (xml.includes('\r')) return null;
  let out = '';
  let pos = 0;
  while (pos < xml.length) {
    const start = xml.indexOf('<!--', pos);
    if (start === -1) {
      out += xml.slice(pos);
      break;
    }
    out += xml.slice(pos, start);
    const bodyStart = start + 4;
    const end = xml.indexOf('-->', bodyStart);
    if (end === -1 || xml.slice(bodyStart, end).includes('--')) return null;
    pos = end + 3;
  }
  return out;
}

function parseAgentsCsprojManifest(rawXml) {
  const xml = stripXmlComments(rawXml);
  if (xml === null) return null;
  let pos = 0;
  const trimmedStart = xml.trimStart();
  if (trimmedStart.startsWith('<?xml ')) {
    const prologStart = xml.indexOf('<?xml ');
    const prologEnd = xml.indexOf('?>', prologStart + 6);
    const firstClose = xml.indexOf('>', prologStart + 6);
    if (prologEnd === -1 || prologEnd + 1 !== firstClose) return null;
    pos = prologEnd + 2;
  }

  const stack = [];
  const properties = new Map();
  const packages = [];
  let seenRoot = false;

  while (pos < xml.length) {
    const lt = xml.indexOf('<', pos);
    if (lt === -1) {
      if (xml.slice(pos).trim().length > 0) return null;
      break;
    }
    if (xml.slice(pos, lt).trim().length > 0) return null;
    if (xml.startsWith('<!', lt) || xml.startsWith('<?', lt)) return null;
    const gt = xml.indexOf('>', lt + 1);
    if (gt === -1) return null;
    const rawTag = xml.slice(lt + 1, gt).trim();
    pos = gt + 1;

    if (stack.length === 0) {
      if (seenRoot || rawTag !== 'Project Sdk="Microsoft.NET.Sdk"') return null;
      seenRoot = true;
      stack.push('Project');
      continue;
    }
    const parent = stack[stack.length - 1];
    if (rawTag.startsWith('/')) {
      const closingName = rawTag.slice(1).trim();
      if (closingName !== parent) return null;
      stack.pop();
      continue;
    }
    if (parent === 'Project') {
      if (rawTag !== 'PropertyGroup' && rawTag !== 'ItemGroup') return null;
      stack.push(rawTag);
      continue;
    }
    if (parent === 'PropertyGroup') {
      if (!XML_PROP_NAME_RE.test(rawTag) || rawTag === 'TargetFrameworks' || properties.has(rawTag)) {
        return null;
      }
      const closeStart = xml.indexOf('<', pos);
      if (closeStart === -1) return null;
      const valueText = xml.slice(pos, closeStart).trim();
      const closeEnd = xml.indexOf('>', closeStart + 1);
      if (closeEnd === -1 || xml.slice(closeStart + 1, closeEnd).trim() !== `/${rawTag}`) {
        return null;
      }
      properties.set(rawTag, valueText);
      pos = closeEnd + 1;
      continue;
    }
    // parent === 'ItemGroup'
    if (!rawTag.endsWith('/')) return null;
    const itemSpec = rawTag.slice(0, -1).trim();
    const match = CSPROJ_PKG_ATTRS_RE.exec(itemSpec);
    if (match === null) return null;
    packages.push(Object.freeze({name: match[1], version: match[2]}));
  }

  if (!seenRoot || stack.length !== 0) return null;
  return {properties, packages};
}

// Pure manifest parser confirming apphost.cs, SoftwareFactory.Agents.csproj, and OTLP
// bootstrap sources match the Aspire 17 + MAF ActivitySource readiness contract.
export function verifyMafSourceManifests(manifests) {
  if (!isPlainDataRecord(manifests, MANIFEST_INPUT_KEYS)) return deny('MANIFEST_INPUT_INVALID');
  for (const key of MANIFEST_INPUT_KEYS) {
    const text = manifests[key];
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_SOURCE_CHARS || CONTROL_CHAR_RE.test(text)) {
      return deny('MANIFEST_INPUT_INVALID');
    }
    if (RETIRED_GITHUB_MODELS_RE.test(text)) {
      return deny('RETIRED_GITHUB_MODELS_PACKAGE_FORBIDDEN');
    }
    if (EXCLUDED_AGENT_FRAMEWORK_RE.test(text)) {
      return deny('EXCLUDED_AGENT_FRAMEWORK_FORBIDDEN');
    }
  }
  const appHostScan = scanCSharpSource(manifests.appHostSource, true);
  const bootstrapScan = scanCSharpSource(manifests.localOtlpBootstrapSource, false);
  const telemetryScan = scanCSharpSource(manifests.telemetrySource, false);
  const csprojParsed = parseAgentsCsprojManifest(manifests.agentsCsprojSource);
  if (appHostScan === null || bootstrapScan === null || telemetryScan === null || csprojParsed === null) {
    return deny('MAF_ACTIVITY_SOURCE_UNREADY');
  }
  const appHostPackages = [];
  for (const directive of appHostScan.directives) {
    const spec = directive.slice('#:package'.length).trim();
    const atIndex = spec.indexOf('@');
    if (atIndex <= 0 || atIndex !== spec.lastIndexOf('@') || spec.includes(' ')) {
      return deny('MAF_ACTIVITY_SOURCE_UNREADY');
    }
    appHostPackages.push(Object.freeze({name: spec.slice(0, atIndex), version: spec.slice(atIndex + 1)}));
  }
  const appHostInv = validatePackageInventory(appHostPackages);
  if (!appHostInv.ok) return deny(appHostInv.reason);
  for (const [pkgName, pinnedVersion] of Object.entries(REQUIRED_APPHOST_PACKAGES)) {
    const entry = appHostInv.map.get(pkgName);
    if (!entry || entry.version !== pinnedVersion) return deny('MAF_ACTIVITY_SOURCE_UNREADY');
  }
  if (appHostScan.statements.some(({text, braceDepth}) =>
    braceDepth !== 0 || text === 'return' || text.startsWith('return ') || text.startsWith('throw ')
  )) {
    return deny('MAF_ACTIVITY_SOURCE_UNREADY');
  }
  const hasExplicitNodeShadow = appHostScan.statements.some(({text}) =>
    text.startsWith('builder.AddNodeApp("synthetic-shadow", "./tools/engineering-factory", "aspire-telemetry-smoke.mjs")') &&
    text.endsWith('.WithExplicitStart()') &&
    !text.includes('?')
  );
  const hasExplicitMafShadow = appHostScan.statements.some(({text}) =>
    text.startsWith('builder.AddDotnetProject("maf-specialist-shadow", "./src/SoftwareFactory.Agents/SoftwareFactory.Agents.csproj")') &&
    text.endsWith('.WithExplicitStart()') &&
    !text.includes('?')
  );
  if (!hasExplicitNodeShadow || !hasExplicitMafShadow ||
      !appHostScan.statements.some(({text}) => text === 'builder.Build().Run()')) {
    return deny('MAF_ACTIVITY_SOURCE_UNREADY');
  }
  if (csprojParsed.properties.get('TargetFramework') !== 'net10.0' ||
      csprojParsed.properties.get('CopilotSkipCliDownload') !== 'true') {
    return deny('MAF_ACTIVITY_SOURCE_UNREADY');
  }
  const agentPackages = csprojParsed.packages;
  const agentInv = validatePackageInventory(agentPackages);
  if (!agentInv.ok) return deny(agentInv.reason);
  for (const pkgName of REQUIRED_MAF_AGENT_PACKAGES) {
    const entry = agentInv.map.get(pkgName);
    if (!entry || !semverAtLeast(entry.tuple, MINIMUM_MAF_PACKAGE_VERSION)) {
      return deny('MAF_ACTIVITY_SOURCE_UNREADY');
    }
  }
  for (const pkgName of REQUIRED_OTEL_AGENT_PACKAGES) {
    if (!agentInv.map.has(pkgName)) return deny('MAF_ACTIVITY_SOURCE_UNREADY');
  }
  const bootstrapStatements = bootstrapScan.statements.map(s => s.text);
  const telemetryStatements = telemetryScan.statements.map(s => s.text);
  const hasDualActivitySources = bootstrapStatements.some(stmt =>
    stmt.startsWith('TracerProvider tracerProvider = Sdk.CreateTracerProviderBuilder()') &&
    stmt.includes('.AddSource(SoftwareFactoryTelemetry.WorkflowsSourceName, SoftwareFactoryTelemetry.AgentsSourceName)') &&
    stmt.includes('.AddOtlpExporter(') &&
    stmt.endsWith('.Build()')
  );
  const hasEndpointLookup = bootstrapStatements.some(stmt =>
    stmt.includes('env.TryGetValue("OTEL_EXPORTER_OTLP_ENDPOINT"')
  );
  const hasHeadersLookup = bootstrapStatements.some(stmt =>
    stmt.includes('env.TryGetValue("OTEL_EXPORTER_OTLP_HEADERS"')
  );
  const hasWorkflowsConst = telemetryStatements.includes(
    `public const string WorkflowsSourceName = "${REQUIRED_MAF_ACTIVITY_SOURCE}"`
  );
  const hasAgentsConst = telemetryStatements.includes(
    `public const string AgentsSourceName = "${REQUIRED_AGENTS_ACTIVITY_SOURCE}"`
  );
  if (!hasWorkflowsConst || !hasAgentsConst || !hasDualActivitySources || !hasEndpointLookup || !hasHeadersLookup) {
    return deny('MAF_ACTIVITY_SOURCE_UNREADY');
  }
  return Object.freeze({
    shadow: true,
    valid: true,
    liveDispatch: false,
    liveMerge: false,
    reason: 'MAF_SOURCE_MANIFESTS_VERIFIED',
    appHostPackages: Object.freeze(appHostPackages),
    agentPackages: Object.freeze(agentPackages),
    activitySources: Object.freeze([REQUIRED_MAF_ACTIVITY_SOURCE, REQUIRED_AGENTS_ACTIVITY_SOURCE])
  });
}
