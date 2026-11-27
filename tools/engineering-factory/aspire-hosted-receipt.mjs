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
const ALLOWED_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const REQUIRED_FORBIDDEN_ENV_PREFIXES = [
  'OTEL_EXPORTER_OTLP_TRACES_',
  'OTEL_EXPORTER_OTLP_METRICS_',
  'OTEL_EXPORTER_OTLP_LOGS_'
];
const REQUIRED_FORBIDDEN_EXACT_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'OTEL_EXPORTER_OTLP_CERTIFICATE',
  'OTEL_EXPORTER_OTLP_INSECURE'
];
const CSHARP_ESCAPES = new Map([
  ['\\', '\\'],
  ['"', '"'],
  ["'", "'"],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
  ['0', '\0']
]);
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
function isSafeBranchName(value) {
  if (typeof value !== 'string' || !SAFE_BRANCH_CHARS_RE.test(value)) return false;
  if (value.startsWith('/') || value.endsWith('/') || value.endsWith('.') ||
      value.includes('//') || value.includes('..') || value.includes('@{') || value === '@') {
    return false;
  }
  return value.split('/').every(part => !part.startsWith('.') && !part.endsWith('.lock'));
}

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

function normalizeCanonicalCode(rawCode) {
  return rawCode
    .trim()
    .replaceAll(' .', '.')
    .replaceAll('. ', '.');
}

function scanCSharpSource(rawSource, allowPackageDirectives) {
  const source = rawSource.replaceAll('\r\n', '\n');
  if (source.includes('\r')) return null;
  const directives = [];
  const statements = [];
  let current = '';
  let literals = [];
  let atLineStart = true;
  let seenCodeToken = false;
  let braceDepth = 0;
  const appendSpace = () => {
    if (current.length > 0 && !current.endsWith(' ')) current += ' ';
  };
  const flushStatement = () => {
    const code = normalizeCanonicalCode(current);
    if (code.length > 0) {
      statements.push({code, literals, braceDepth});
    }
    current = '';
    literals = [];
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
      i += 2;
      let value = '';
      let closed = false;
      while (i < source.length) {
        if (source[i] === '"' && source[i + 1] === '"') {
          value += '"';
          i += 2;
        } else if (source[i] === '"') {
          i++;
          closed = true;
          break;
        } else {
          value += source[i++];
        }
      }
      if (!closed) return null;
      const idx = literals.length;
      literals.push(value);
      current += `$STR_${idx}$`;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (ch === '"' && source[i + 1] === '"' && source[i + 2] === '"') return null;
      const quote = ch;
      i++;
      let value = '';
      let closed = false;
      while (i < source.length && source[i] !== '\n') {
        if (source[i] === '\\') {
          const decoded = CSHARP_ESCAPES.get(source[i + 1]);
          if (decoded === undefined) return null;
          value += decoded;
          i += 2;
        } else if (source[i] === quote) {
          i++;
          closed = true;
          break;
        } else {
          value += source[i++];
        }
      }
      if (!closed) return null;
      const idx = literals.length;
      literals.push(value);
      current += quote === '"' ? `$STR_${idx}$` : `$CHR_${idx}$`;
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
      const propKeyLower = rawTag.toLowerCase();
      if (!XML_PROP_NAME_RE.test(rawTag) || propKeyLower === 'targetframeworks' || properties.has(propKeyLower)) {
        return null;
      }
      const closeStart = xml.indexOf('<', pos);
      if (closeStart === -1) return null;
      const valueText = xml.slice(pos, closeStart).trim();
      const closeEnd = xml.indexOf('>', closeStart + 1);
      if (closeEnd === -1 || xml.slice(closeStart + 1, closeEnd).trim() !== `/${rawTag}` || valueText.includes('&')) {
        return null;
      }
      properties.set(propKeyLower, valueText);
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

function hasForbiddenFrameworkInActiveCode(scanResult) {
  for (const directive of scanResult.directives) {
    if (RETIRED_GITHUB_MODELS_RE.test(directive)) return 'RETIRED_GITHUB_MODELS_PACKAGE_FORBIDDEN';
    if (EXCLUDED_AGENT_FRAMEWORK_RE.test(directive)) return 'EXCLUDED_AGENT_FRAMEWORK_FORBIDDEN';
  }
  for (const stmt of scanResult.statements) {
    if (RETIRED_GITHUB_MODELS_RE.test(stmt.code) || stmt.literals.some(lit => RETIRED_GITHUB_MODELS_RE.test(lit))) {
      return 'RETIRED_GITHUB_MODELS_PACKAGE_FORBIDDEN';
    }
    if (EXCLUDED_AGENT_FRAMEWORK_RE.test(stmt.code) || stmt.literals.some(lit => EXCLUDED_AGENT_FRAMEWORK_RE.test(lit))) {
      return 'EXCLUDED_AGENT_FRAMEWORK_FORBIDDEN';
    }
  }
  return null;
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
  }
  const appHostScan = scanCSharpSource(manifests.appHostSource, true);
  const bootstrapScan = scanCSharpSource(manifests.localOtlpBootstrapSource, false);
  const telemetryScan = scanCSharpSource(manifests.telemetrySource, false);
  const csprojParsed = parseAgentsCsprojManifest(manifests.agentsCsprojSource);
  if (appHostScan === null || bootstrapScan === null || telemetryScan === null || csprojParsed === null) {
    return deny('MAF_ACTIVITY_SOURCE_UNREADY');
  }
  for (const scan of [appHostScan, bootstrapScan, telemetryScan]) {
    const forbiddenReason = hasForbiddenFrameworkInActiveCode(scan);
    if (forbiddenReason !== null) return deny(forbiddenReason);
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
function validateAppHostStatements(statements) {
  if (statements.length !== 4 || statements.some(({braceDepth}) => braceDepth !== 0)) {
    return false;
  }
  const builderOk = statements[0].code === 'var builder = DistributedApplication.CreateBuilder(args)' &&
    statements[0].literals.length === 0;
  const runOk = statements[3].code === 'builder.Build().Run()' &&
    statements[3].literals.length === 0;
  const middle = [statements[1], statements[2]];
  const hasNode = middle.some(({code, literals}) =>
    code === 'builder.AddNodeApp($STR_0$, $STR_1$, $STR_2$).WithExplicitStart()' &&
    literals.length === 3 &&
    literals[0] === 'synthetic-shadow' &&
    literals[1] === './tools/engineering-factory' &&
    literals[2] === 'aspire-telemetry-smoke.mjs'
  );
  const hasMaf = middle.some(({code, literals}) =>
    code === 'builder.AddDotnetProject($STR_0$, $STR_1$).WithArgs($STR_2$).WithExplicitStart()' &&
    literals.length === 3 &&
    literals[0] === 'maf-specialist-shadow' &&
    literals[1] === './src/SoftwareFactory.Agents/SoftwareFactory.Agents.csproj' &&
    literals[2] === '--smoke'
  );
  return builderOk && runOk && hasNode && hasMaf;
}

function extractClassMethodBody(statements, headerPrefix) {
  const headerIdx = statements.findIndex(s => s.braceDepth === 1 && s.code.startsWith(headerPrefix));
  if (headerIdx === -1) return null;
  const body = [];
  for (let i = headerIdx + 1; i < statements.length && statements[i].braceDepth >= 2; i++) {
    body.push(statements[i]);
  }
  return body.length > 0 ? body : null;
}

function validateOtlpBootstrapStatements(statements) {
  const startBody = extractClassMethodBody(statements, 'public static LocalOtlpRuntime StartFromEnvironment(');
  const validateBody = extractClassMethodBody(statements, 'public static ValidatedLocalOtlpConfig? ValidateEnvironment(');
  const exporterBody = extractClassMethodBody(statements, 'private static void ConfigureExporterOptions(');
  const loopbackBody = extractClassMethodBody(statements, 'private static Uri ParseLoopbackEndpoint(');
  const headersBody = extractClassMethodBody(statements, 'private static void ValidateHeaders(');
  if (!startBody || !validateBody || !exporterBody || !loopbackBody || !headersBody) {
    return false;
  }

  const loopbackHeaderIdx = statements.findIndex(s =>
    s.braceDepth === 1 && s.code.includes('LoopbackHosts = new(')
  );
  const loopbackHostsStmt = loopbackHeaderIdx !== -1 ? statements[loopbackHeaderIdx + 1] : undefined;
  if (loopbackHostsStmt === undefined ||
      loopbackHostsStmt.braceDepth !== 2 ||
      loopbackHostsStmt.literals.length === 0 ||
      loopbackHostsStmt.code !== loopbackHostsStmt.literals.map((_, idx) => `$STR_${idx}$`).join(', ') ||
      !loopbackHostsStmt.literals.every(host => ALLOWED_LOOPBACK_HOSTS.has(host))) {
    return false;
  }

  const forbiddenPrefixesStmt = statements.find(s =>
    s.braceDepth === 1 && s.code.startsWith('private static readonly string[] ForbiddenEnvPrefixes =')
  );
  const forbiddenExactIdx = statements.findIndex(s =>
    s.braceDepth === 1 && s.code.includes('ForbiddenExactEnvKeys = new(')
  );
  const forbiddenExactStmt = forbiddenExactIdx !== -1 ? statements[forbiddenExactIdx + 1] : undefined;
  const forbiddenMethodStmt = statements.find(s =>
    s.braceDepth === 1 && s.code.startsWith('private static bool ContainsForbiddenOverrides(')
  );
  if (!forbiddenPrefixesStmt ||
      !REQUIRED_FORBIDDEN_ENV_PREFIXES.every(p => forbiddenPrefixesStmt.literals.includes(p)) ||
      !forbiddenExactStmt || forbiddenExactStmt.braceDepth !== 2 ||
      !REQUIRED_FORBIDDEN_EXACT_ENV_KEYS.every(k => forbiddenExactStmt.literals.includes(k)) ||
      !forbiddenMethodStmt ||
      !forbiddenMethodStmt.code.includes('ForbiddenExactEnvKeys.Contains(key) || ForbiddenEnvPrefixes.Any(')) {
    return false;
  }

  const startOk = startBody.length === 18 &&
    !startBody.some(({code}) => code.includes('.Dispose(')) &&
    startBody[0].code === 'IReadOnlyDictionary<string, string?> env = environment ?? SnapshotProcessEnvironment()' &&
    startBody[1].code === 'ValidatedLocalOtlpConfig? validated = ValidateEnvironment(env)' &&
    startBody[2].code === 'if (validated is null)' &&
    startBody[3].braceDepth === 3 &&
    startBody[3].code === 'return LocalOtlpRuntime.Disabled()' &&
    startBody[4].code === 'ResourceBuilder resource = ResourceBuilder.CreateDefault().AddService(validated.ServiceName)' &&
    startBody[5].braceDepth === 2 &&
    startBody[5].code === 'TracerProvider tracerProvider = Sdk.CreateTracerProviderBuilder().SetResourceBuilder(resource).AddSource(SoftwareFactoryTelemetry.WorkflowsSourceName, SoftwareFactoryTelemetry.AgentsSourceName).AddOtlpExporter(options => ConfigureExporterOptions(options, validated, $STR_0$)).Build()' &&
    startBody[5].literals[0] === '/v1/traces' &&
    startBody[6].braceDepth === 2 &&
    startBody[6].code === 'MeterProvider meterProvider = Sdk.CreateMeterProviderBuilder().SetResourceBuilder(resource).AddMeter(SoftwareFactoryTelemetry.AgentsSourceName).AddOtlpExporter(options => ConfigureExporterOptions(options, validated, $STR_0$)).Build()' &&
    startBody[6].literals[0] === '/v1/metrics' &&
    startBody[13].code === 'otel.AddOtlpExporter(options => ConfigureExporterOptions(options, validated, $STR_0$))' &&
    startBody[13].literals[0] === '/v1/logs' &&
    startBody[16].code === 'ILogger stageLogger = loggerFactory.CreateLogger(SoftwareFactoryTelemetry.AgentsSourceName)' &&
    startBody[17].braceDepth === 2 &&
    startBody[17].code === 'return new LocalOtlpRuntime( isEnabled: true, tracerProvider: tracerProvider, meterProvider: meterProvider, loggerFactory: loggerFactory, stageLogger: stageLogger)';
  if (!startOk) return false;

  const endpointLookupIdx = validateBody.findIndex(({code, literals, braceDepth}) =>
    braceDepth === 2 &&
    code === 'bool hasEndpoint = env.TryGetValue($STR_0$, out string? rawEndpoint) && !string.IsNullOrWhiteSpace(rawEndpoint)' &&
    literals[0] === 'OTEL_EXPORTER_OTLP_ENDPOINT'
  );
  const forbiddenCheckIdx = validateBody.findIndex(({code, braceDepth}) =>
    braceDepth === 2 && code === 'bool hasAnyForbiddenOverride = ContainsForbiddenOverrides(env)'
  );
  const noEndpointForbiddenOk = validateBody.some(({code, braceDepth}, idx) =>
    braceDepth === 2 && code === 'if (!hasEndpoint)' &&
    validateBody[idx + 1]?.braceDepth === 3 && validateBody[idx + 1]?.code === 'if (hasAnyForbiddenOverride)' &&
    validateBody[idx + 2]?.braceDepth === 4 &&
    validateBody[idx + 2]?.code.startsWith('throw new LocalOtlpConfigurationException(') === true
  );
  const activeForbiddenOk = validateBody.some(({code, braceDepth}, idx) =>
    braceDepth === 2 && code === 'if (hasAnyForbiddenOverride)' &&
    validateBody[idx + 1]?.braceDepth === 3 &&
    validateBody[idx + 1]?.code.startsWith('throw new LocalOtlpConfigurationException(') === true
  );
  const parseLoopbackCallIdx = validateBody.findIndex(({code, braceDepth}, idx) =>
    braceDepth === 2 &&
    code === 'Uri baseUri = ParseLoopbackEndpoint(rawEndpoint!)' &&
    !validateBody[idx - 1]?.code.startsWith('if ')
  );
  const headersLookupIdx = validateBody.findIndex(({code, literals, braceDepth}) =>
    braceDepth === 2 &&
    code === 'string? rawHeaders = env.TryGetValue($STR_0$, out string? headerVal) ? headerVal : null' &&
    literals[0] === 'OTEL_EXPORTER_OTLP_HEADERS'
  );
  const validateHeadersCallIdx = validateBody.findIndex(({code, braceDepth}, idx) =>
    braceDepth === 2 &&
    code === 'ValidateHeaders(rawHeaders)' &&
    !validateBody[idx - 1]?.code.startsWith('if ')
  );
  const returnConfigIdx = validateBody.findIndex(({code, braceDepth}, idx) =>
    braceDepth === 2 &&
    code === 'return new ValidatedLocalOtlpConfig' &&
    validateBody[idx + 1]?.braceDepth === 3 &&
    validateBody[idx + 1]?.code === 'BaseEndpoint = baseUri, Protocol = protocol, Headers = rawHeaders!, ServiceName = serviceName'
  );
  const prematureValidateReturn = validateBody.some(({code}, idx) =>
    idx < returnConfigIdx && code.startsWith('return ') && code !== 'return null'
  );
  if (endpointLookupIdx === -1 || forbiddenCheckIdx === -1 || !noEndpointForbiddenOk || !activeForbiddenOk ||
      parseLoopbackCallIdx <= endpointLookupIdx || headersLookupIdx === -1 ||
      validateHeadersCallIdx <= headersLookupIdx || returnConfigIdx <= parseLoopbackCallIdx ||
      returnConfigIdx <= validateHeadersCallIdx || prematureValidateReturn) {
    return false;
  }

  const hasExporterBinding = exporterBody.length === 8 &&
    exporterBody[0].code === 'options.Protocol = config.Protocol' &&
    exporterBody[1].code === 'options.Headers = config.Headers' &&
    exporterBody[2].code === 'options.TimeoutMilliseconds = 3000' &&
    exporterBody[3].code === 'options.Endpoint = config.Protocol == OtlpExportProtocol.HttpProtobuf ? new Uri(config.BaseEndpoint, httpSignalPath) : config.BaseEndpoint' &&
    exporterBody[4].code === 'if (config.Protocol == OtlpExportProtocol.HttpProtobuf)' &&
    exporterBody[6].code === 'AllowAutoRedirect = false, UseProxy = false';

  const hasLoopbackEnforcement = loopbackBody.length === 3 &&
    loopbackBody[0].braceDepth === 2 &&
    loopbackBody[0].code === 'if (!Uri.TryCreate(rawEndpoint.Trim(), UriKind.Absolute, out Uri? uri) || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) || !LoopbackHosts.Contains(uri.Host) || uri.IsDefaultPort || !string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment) || uri.AbsolutePath != $STR_0$)' &&
    loopbackBody[0].literals.length === 1 &&
    loopbackBody[0].literals[0] === '/' &&
    loopbackBody[1].braceDepth === 3 &&
    loopbackBody[1].code.startsWith('throw new LocalOtlpConfigurationException(') &&
    loopbackBody[2].braceDepth === 2 &&
    loopbackBody[2].code.startsWith('return new Uri(');

  const hasHeadersEnforcement = headersBody.length === 10 &&
    headersBody[0].braceDepth === 2 &&
    headersBody[0].code === 'if (string.IsNullOrWhiteSpace(rawHeaders) || rawHeaders.Length > 2048)' &&
    headersBody[1].braceDepth === 3 &&
    headersBody[1].code.startsWith('throw new LocalOtlpConfigurationException(') &&
    headersBody[2].code === 'foreach (char c in rawHeaders)' &&
    headersBody[3].code === 'if (char.IsControl(c))' &&
    headersBody[4].code.startsWith('throw new LocalOtlpConfigurationException(') &&
    headersBody[5].code === 'string[] pairs = rawHeaders.Split($CHR_0$)' &&
    headersBody[5].literals[0] === ',' &&
    headersBody[6].code === 'foreach (string pair in pairs)' &&
    headersBody[7].code === 'int eq = pair.IndexOf($CHR_0$)' &&
    headersBody[7].literals[0] === '=' &&
    headersBody[8].code === 'if (eq <= 0 || eq == pair.Length - 1)' &&
    headersBody[9].code.startsWith('throw new LocalOtlpConfigurationException(');

  return hasExporterBinding && hasLoopbackEnforcement && hasHeadersEnforcement;
}
  if (!validateAppHostStatements(appHostScan.statements)) {
    return deny('MAF_ACTIVITY_SOURCE_UNREADY');
  }
  if (csprojParsed.properties.get('targetframework') !== 'net10.0' ||
      csprojParsed.properties.get('copilotskipclidownload') !== 'true') {
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
  const hasWorkflowsConst = telemetryScan.statements.some(({code, literals}) =>
    code === 'public const string WorkflowsSourceName = $STR_0$' &&
    literals.length === 1 &&
    literals[0] === REQUIRED_MAF_ACTIVITY_SOURCE
  );
  const hasAgentsConst = telemetryScan.statements.some(({code, literals}) =>
    code === 'public const string AgentsSourceName = $STR_0$' &&
    literals.length === 1 &&
    literals[0] === REQUIRED_AGENTS_ACTIVITY_SOURCE
  );
  if (!hasWorkflowsConst || !hasAgentsConst || !validateOtlpBootstrapStatements(bootstrapScan.statements)) {
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
