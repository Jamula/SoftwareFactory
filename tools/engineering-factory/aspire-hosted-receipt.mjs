// Deterministic, metadata-only, fail-closed cross-OS GitHub-hosted Aspire 17 and
// OpenTelemetry runtime receipt verifier. Zero network, filesystem, or live side effects.
import {createHash} from 'node:crypto';
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
    workflowName: 'Factory validation',
    jobName: 'linux-aspire-runtime',
    workflowPath: '.github/workflows/validate.yml',
    allowedTraceReadbackMethods: Object.freeze(['cli-export-zip', 'authenticated-https-api'])
  }),
  windows: Object.freeze({
    os: 'windows',
    runnerLabel: 'windows-latest',
    workflowName: 'Windows Aspire runtime',
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
export const MINIMUM_OTEL_PACKAGE_VERSION = Object.freeze([1, 21, 0]);
export const REQUIRED_MAF_AGENT_PACKAGES = Object.freeze([
  'Microsoft.Agents.AI',
  'Microsoft.Agents.AI.GitHub.Copilot',
  'Microsoft.Agents.AI.Workflows'
]);
export const REQUIRED_OTEL_AGENT_PACKAGES = Object.freeze([
  'OpenTelemetry',
  'OpenTelemetry.Exporter.OpenTelemetryProtocol'
]);

export const PINNED_LOCAL_OTLP_BOOTSTRAP_AST_SHA256 =
  'e809b709b7fc40fc1ea4c95ba95ff561197be6f8ca03490b9954015c44df75ec';
export const PINNED_TELEMETRY_AST_SHA256 =
  '994bc75fa9c78e56942caf6278e7640ecedf8e4eeac9dc9916c2b0063957a250';

const TRACE_READBACK_TOOLS = new Map([
  ['cli-export-zip', 'tools/engineering-factory/verify-dashboard-export.mjs'],
  ['authenticated-https-api', 'tools/engineering-factory/verify-dashboard-api.mjs']
]);
const ALLOWED_EVENTS = new Set(['push', 'pull_request', 'merge_group']);
const ALLOWED_ACTIVITY_SOURCE_SET = new Set(ALLOWED_MAF_ACTIVITY_SOURCES);
const ALLOWED_CSPROJ_PROPERTIES = new Map([
  ['outputtype', 'Exe'],
  ['targetframework', 'net10.0'],
  ['nullable', 'enable'],
  ['implicitusings', 'enable'],
  ['treatwarningsaserrors', 'true'],
  ['copilotskipclidownload', 'true'],
  ['rootnamespace', 'SoftwareFactory.Agents']
]);
const REQUIRED_CSPROJ_PROPERTIES = [...ALLOWED_CSPROJ_PROPERTIES.keys()];
const CSHARP_ESCAPES = new Map([
  ['\\', '\\'],
  ['"', '"'],
  ["'", "'"],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
  ['0', '\0']
]);
const APPHOST_BUILDER_TOKENS_JSON = JSON.stringify([
  {k: 'id', v: 'var'}, {k: 'id', v: 'builder'}, {k: 'p', v: '='},
  {k: 'id', v: 'DistributedApplication'}, {k: 'p', v: '.'}, {k: 'id', v: 'CreateBuilder'},
  {k: 'p', v: '('}, {k: 'id', v: 'args'}, {k: 'p', v: ')'}
]);
const APPHOST_NODE_TOKENS_JSON = JSON.stringify([
  {k: 'id', v: 'builder'}, {k: 'p', v: '.'}, {k: 'id', v: 'AddNodeApp'},
  {k: 'p', v: '('}, {k: 'str', v: 'synthetic-shadow'}, {k: 'p', v: ','},
  {k: 'str', v: './tools/engineering-factory'}, {k: 'p', v: ','},
  {k: 'str', v: 'aspire-telemetry-smoke.mjs'}, {k: 'p', v: ')'},
  {k: 'p', v: '.'}, {k: 'id', v: 'WithExplicitStart'}, {k: 'p', v: '('}, {k: 'p', v: ')'}
]);
const APPHOST_MAF_TOKENS_JSON = JSON.stringify([
  {k: 'id', v: 'builder'}, {k: 'p', v: '.'}, {k: 'id', v: 'AddDotnetProject'},
  {k: 'p', v: '('}, {k: 'str', v: 'maf-specialist-shadow'}, {k: 'p', v: ','},
  {k: 'str', v: './src/SoftwareFactory.Agents/SoftwareFactory.Agents.csproj'}, {k: 'p', v: ')'},
  {k: 'p', v: '.'}, {k: 'id', v: 'WithArgs'}, {k: 'p', v: '('}, {k: 'str', v: '--smoke'}, {k: 'p', v: ')'},
  {k: 'p', v: '.'}, {k: 'id', v: 'WithExplicitStart'}, {k: 'p', v: '('}, {k: 'p', v: ')'}
]);
const APPHOST_RUN_TOKENS_JSON = JSON.stringify([
  {k: 'id', v: 'builder'}, {k: 'p', v: '.'}, {k: 'id', v: 'Build'}, {k: 'p', v: '('}, {k: 'p', v: ')'},
  {k: 'p', v: '.'}, {k: 'id', v: 'Run'}, {k: 'p', v: '('}, {k: 'p', v: ')'}
]);
const MAX_DURATION_MS = 3_600_000;
const MAX_SOURCE_CHARS = 262_144;
const SHA40_NONZERO_RE = /^(?!0{40})[0-9a-f]{40}$/;
const SAFE_BRANCH_CHARS_RE = /^[^\u0000-\u0020\u007f~^:?*[\\]{1,200}$/;
const ISO_UTC_SECONDS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const LOOPBACK_HTTPS_ORIGIN_RE = /^https:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/;
const PACKAGE_NAME_RE = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const XML_PROP_NAME_RE = /^[A-Za-z][A-Za-z0-9]*$/;
const XML_DECLARATION_RE =
  /^<\?xml[ \t]+version="1\.0"(?:[ \t]+encoding="[A-Za-z][A-Za-z0-9._-]*")?(?:[ \t]+standalone="(?:yes|no)")?[ \t]*\?>/;
const CSHARP_ID_CHAR_RE = /[A-Za-z0-9_]/;
const XML_ATTR_PAIR_RE = /^([A-Za-z]+)="([^"]+)"$/;
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

function isSafeBranchName(value) {
  if (typeof value !== 'string' || !SAFE_BRANCH_CHARS_RE.test(value)) return false;
  if (value.startsWith('/') || value.startsWith('-') || value.endsWith('/') || value.endsWith('.') ||
      value.includes('//') || value.includes('..') || value.includes('@{') ||
      value === '@' || value === 'HEAD') {
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
  if (typeof rawVersion !== 'string' || rawVersion.length > 64) return null;
  const match = SEMVER_RE.exec(rawVersion);
  if (match === null) return null;
  const tuple = [Number(match[1]), Number(match[2]), Number(match[3])];
  return tuple.every(part => Number.isSafeInteger(part) && part <= 2_147_483_647) ? tuple : null;
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
        typeof item.name !== 'string' || item.name.length === 0 || item.name.length > 128) {
      return {ok: false, reason: 'MAF_ACTIVITY_SOURCE_UNREADY'};
    }
    if (isRetiredGitHubModelsPackage(item.name)) {
      return {ok: false, reason: 'RETIRED_GITHUB_MODELS_PACKAGE_FORBIDDEN'};
    }
    if (EXCLUDED_AGENT_FRAMEWORK_RE.test(item.name)) {
      return {ok: false, reason: 'EXCLUDED_AGENT_FRAMEWORK_FORBIDDEN'};
    }
    if (!PACKAGE_NAME_RE.test(item.name)) {
      return {ok: false, reason: 'MAF_ACTIVITY_SOURCE_UNREADY'};
    }
    const tuple = parseSemverTuple(item.version);
    if (tuple === null || map.has(item.name)) {
      return {ok: false, reason: 'MAF_ACTIVITY_SOURCE_UNREADY'};
    }
    map.set(item.name, {version: item.version, tuple});
  }
  return {ok: true, map};
}

function validateAllowlistedPackages(appHostMap, agentMap) {
  const requiredAppHostEntries = Object.entries(REQUIRED_APPHOST_PACKAGES);
  if (appHostMap.size !== requiredAppHostEntries.length) return false;
  for (const [pkgName, pinnedVersion] of requiredAppHostEntries) {
    const entry = appHostMap.get(pkgName);
    if (!entry || entry.version !== pinnedVersion) return false;
  }
  if (agentMap.size !== REQUIRED_MAF_AGENT_PACKAGES.length + REQUIRED_OTEL_AGENT_PACKAGES.length) {
    return false;
  }
  for (const pkgName of REQUIRED_MAF_AGENT_PACKAGES) {
    const entry = agentMap.get(pkgName);
    if (!entry || !semverAtLeast(entry.tuple, MINIMUM_MAF_PACKAGE_VERSION)) return false;
  }
  for (const pkgName of REQUIRED_OTEL_AGENT_PACKAGES) {
    const entry = agentMap.get(pkgName);
    if (!entry || !semverAtLeast(entry.tuple, MINIMUM_OTEL_PACKAGE_VERSION)) return false;
  }
  return true;
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
  if (receipt.jobName !== platformSpec.jobName ||
      receipt.workflowPath !== platformSpec.workflowPath ||
      receipt.workflowName !== platformSpec.workflowName) {
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
  const agentPkg = validatePackageInventory(maf.agentPackages);
  if (!agentPkg.ok) return agentPkg;
  if (!validateAllowlistedPackages(appHostPkg.map, agentPkg.map)) {
    return {ok: false, reason: 'MAF_ACTIVITY_SOURCE_UNREADY'};
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

function readEscapedLiteral(source, startIdx, quote) {
  let i = startIdx;
  let value = '';
  while (i < source.length && source[i] !== '\n') {
    if (source[i] === '\\') {
      const decoded = CSHARP_ESCAPES.get(source[i + 1]);
      if (decoded === undefined) return null;
      value += decoded;
      i += 2;
    } else if (source[i] === quote) {
      return {value, nextIdx: i + 1};
    } else {
      value += source[i++];
    }
  }
  return null;
}

function canonicalTokensSha256(tokens) {
  return createHash('sha256').update(JSON.stringify(tokens)).digest('hex');
}

function lexCodeSegment(source, startIdx, stopAtClosingBrace) {
  const tokens = [];
  let braceDepth = 0;
  let i = startIdx;

  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i + 2);
      if (nl === -1) {
        i = source.length;
        break;
      }
      i = nl + 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) return null;
      i = end + 2;
      continue;
    }
    if (ch === '#' || (ch === '@' && source[i + 1] === '$')) return null;
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
      tokens.push({k: 'str', v: value});
      continue;
    }
    if (ch === '$' && source[i + 1] === '"') {
      i += 2;
      tokens.push({k: 'istr-start', v: ''});
      let seg = '';
      let closed = false;
      while (i < source.length && source[i] !== '\n') {
        if (source[i] === '\\') {
          const decoded = CSHARP_ESCAPES.get(source[i + 1]);
          if (decoded === undefined) return null;
          seg += decoded;
          i += 2;
        } else if (source[i] === '{' && source[i + 1] === '{') {
          seg += '{';
          i += 2;
        } else if (source[i] === '}' && source[i + 1] === '}') {
          seg += '}';
          i += 2;
        } else if (source[i] === '}') {
          return null;
        } else if (source[i] === '{') {
          tokens.push({k: 'str', v: seg});
          seg = '';
          tokens.push({k: 'hole-start', v: ''});
          const hole = lexCodeSegment(source, i + 1, true);
          if (hole === null || hole.tokens.length === 0) return null;
          tokens.push(...hole.tokens);
          tokens.push({k: 'hole-end', v: ''});
          i = hole.nextIdx;
        } else if (source[i] === '"') {
          tokens.push({k: 'str', v: seg});
          tokens.push({k: 'istr-end', v: ''});
          i++;
          closed = true;
          break;
        } else {
          seg += source[i++];
        }
      }
      if (!closed) return null;
      continue;
    }
    if (ch === '$') return null;
    if (ch === '"' || ch === "'") {
      if (ch === '"' && source[i + 1] === '"' && source[i + 2] === '"') return null;
      const parsed = readEscapedLiteral(source, i + 1, ch);
      if (parsed === null || (ch === "'" && parsed.value.length !== 1)) return null;
      tokens.push({k: ch === '"' ? 'str' : 'chr', v: parsed.value});
      i = parsed.nextIdx;
      continue;
    }
    if (CSHARP_ID_CHAR_RE.test(ch)) {
      let end = i + 1;
      while (end < source.length && CSHARP_ID_CHAR_RE.test(source[end])) end++;
      tokens.push({k: 'id', v: source.slice(i, end)});
      i = end;
      continue;
    }
    if (ch === '{') {
      braceDepth++;
      tokens.push({k: 'p', v: ch});
      i++;
      continue;
    }
    if (ch === '}') {
      if (stopAtClosingBrace && braceDepth === 0) {
        return {tokens, nextIdx: i + 1};
      }
      braceDepth--;
      if (braceDepth < 0) return null;
      tokens.push({k: 'p', v: ch});
      i++;
      continue;
    }
    tokens.push({k: 'p', v: ch});
    i++;
  }

  if (stopAtClosingBrace || braceDepth !== 0) return null;
  return {tokens, nextIdx: i};
}

function scanCSharpSource(rawSource, allowPackageDirectives) {
  const source = rawSource.replaceAll('\r\n', '\n');
  if (source.includes('\r')) return null;
  const directives = [];
  let i = 0;

  if (allowPackageDirectives) {
    let atLineStart = true;
    while (i < source.length) {
      const ch = source[i];
      if (ch === ' ' || ch === '\t') {
        i++;
        continue;
      }
      if (ch === '\n') {
        atLineStart = true;
        i++;
        continue;
      }
      if (ch === '/' && source[i + 1] === '/') {
        const nl = source.indexOf('\n', i + 2);
        if (nl === -1) return {directives, tokens: []};
        atLineStart = true;
        i = nl + 1;
        continue;
      }
      if (ch === '/' && source[i + 1] === '*') {
        const end = source.indexOf('*/', i + 2);
        if (end === -1) return null;
        atLineStart = false;
        i = end + 2;
        continue;
      }
      if (atLineStart && ch === '#') {
        const nl = source.indexOf('\n', i);
        const rawLine = nl === -1 ? source.slice(i) : source.slice(i, nl);
        if (!rawLine.startsWith('#:package') ||
            (rawLine[9] !== ' ' && rawLine[9] !== '\t')) {
          return null;
        }
        const cleaned = rawLine.slice(9).trim();
        if (cleaned.length === 0) return null;
        directives.push(cleaned);
        if (nl === -1) return {directives, tokens: []};
        atLineStart = true;
        i = nl + 1;
        continue;
      }
      break;
    }
  }

  const lexed = lexCodeSegment(source, i, false);
  return lexed === null ? null : {directives, tokens: lexed.tokens};
}

function parseAgentsCsprojManifest(rawXml) {
  const xml = rawXml.replaceAll('\r\n', '\n');
  if (xml.includes('\r')) return null;
  let pos = 0;
  if (xml.startsWith('<?xml')) {
    const declMatch = XML_DECLARATION_RE.exec(xml);
    if (declMatch === null) return null;
    pos = declMatch[0].length;
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
    if (xml.startsWith('<!--', lt)) {
      const bodyStart = lt + 4;
      const commentEnd = xml.indexOf('-->', bodyStart);
      if (commentEnd === -1 || xml[commentEnd - 1] === '-' || xml.slice(bodyStart, commentEnd).includes('--')) {
        return null;
      }
      pos = commentEnd + 3;
      continue;
    }
    if (xml.startsWith('<!', lt) || xml.startsWith('<?', lt)) return null;
    const gt = xml.indexOf('>', lt + 1);
    if (gt === -1) return null;
    const rawTag = xml.slice(lt + 1, gt).trimEnd();
    pos = gt + 1;

    if (stack.length === 0) {
      if (seenRoot || rawTag !== 'Project Sdk="Microsoft.NET.Sdk"') return null;
      seenRoot = true;
      stack.push('Project');
      continue;
    }
    const parent = stack[stack.length - 1];
    if (rawTag.startsWith('/')) {
      const closingName = rawTag.slice(1);
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
      if (!XML_PROP_NAME_RE.test(rawTag) || !ALLOWED_CSPROJ_PROPERTIES.has(propKeyLower) || properties.has(propKeyLower)) {
        return null;
      }
      const closeStart = xml.indexOf('<', pos);
      if (closeStart === -1) return null;
      const valueText = xml.slice(pos, closeStart);
      const closeEnd = xml.indexOf('>', closeStart + 1);
      if (closeEnd === -1 || xml.slice(closeStart + 1, closeEnd).trimEnd() !== `/${rawTag}` ||
          valueText !== ALLOWED_CSPROJ_PROPERTIES.get(propKeyLower)) {
        return null;
      }
      properties.set(propKeyLower, valueText);
      pos = closeEnd + 1;
      continue;
    }
    // parent === 'ItemGroup'
    if (!rawTag.endsWith('/')) return null;
    const itemSpec = rawTag.slice(0, -1).trim();
    if (!itemSpec.startsWith('PackageReference ')) return null;
    const attrMap = new Map();
    for (const part of itemSpec.slice('PackageReference '.length).trim().split(/\s+/)) {
      const attrMatch = XML_ATTR_PAIR_RE.exec(part);
      if (attrMatch === null || attrMap.has(attrMatch[1])) return null;
      attrMap.set(attrMatch[1], attrMatch[2]);
    }
    if (attrMap.size !== 2 || !attrMap.has('Include') || !attrMap.has('Version')) return null;
    packages.push(Object.freeze({name: attrMap.get('Include'), version: attrMap.get('Version')}));
  }

  if (!seenRoot || stack.length !== 0) return null;
  return {properties, packages};
}

function validateAppHostTokens(tokens) {
  if (tokens.length === 0 || tokens[tokens.length - 1].k !== 'p' || tokens[tokens.length - 1].v !== ';') {
    return false;
  }
  const statements = [];
  let current = [];
  for (const tok of tokens) {
    if (tok.k === 'p' && tok.v === ';') {
      if (current.length === 0) return false;
      statements.push(JSON.stringify(current));
      current = [];
    } else {
      current.push(tok);
    }
  }
  if (statements.length !== 4 ||
      statements[0] !== APPHOST_BUILDER_TOKENS_JSON ||
      statements[3] !== APPHOST_RUN_TOKENS_JSON) {
    return false;
  }
  const middle = [statements[1], statements[2]];
  return middle.includes(APPHOST_NODE_TOKENS_JSON) && middle.includes(APPHOST_MAF_TOKENS_JSON);
}

function hasForbiddenFrameworkInActiveCode(scanResult) {
  for (const directive of scanResult.directives) {
    if (RETIRED_GITHUB_MODELS_RE.test(directive)) return 'RETIRED_GITHUB_MODELS_PACKAGE_FORBIDDEN';
    if (EXCLUDED_AGENT_FRAMEWORK_RE.test(directive)) return 'EXCLUDED_AGENT_FRAMEWORK_FORBIDDEN';
  }
  const tokens = scanResult.tokens;
  let dottedChain = '';
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.k === 'id') {
      dottedChain = dottedChain.length === 0 ? tok.v : `${dottedChain}.${tok.v}`;
    } else if (!(tok.k === 'p' && tok.v === '.' && dottedChain.length > 0 && tokens[i + 1]?.k === 'id')) {
      dottedChain = '';
    }
    for (const candidate of [tok.v, dottedChain]) {
      if (candidate.length === 0) continue;
      if (RETIRED_GITHUB_MODELS_RE.test(candidate)) return 'RETIRED_GITHUB_MODELS_PACKAGE_FORBIDDEN';
      if (EXCLUDED_AGENT_FRAMEWORK_RE.test(candidate)) return 'EXCLUDED_AGENT_FRAMEWORK_FORBIDDEN';
    }
  }
  return null;
}

function normalizeTelemetryVersionToken(tokens, expectedMafVersion) {
  const versionIdx = tokens.findIndex((tok, idx) =>
    tok.k === 'id' && tok.v === 'TelemetryVersion' &&
    tokens[idx + 1]?.k === 'p' && tokens[idx + 1]?.v === '=' &&
    tokens[idx + 2]?.k === 'str' &&
    tokens[idx + 3]?.k === 'p' && tokens[idx + 3]?.v === ';'
  );
  if (versionIdx === -1 || tokens[versionIdx + 2].v !== expectedMafVersion) return null;
  return tokens.map((tok, idx) =>
    idx === versionIdx + 2 ? {k: 'str', v: '$VERIFIED_MAF_VERSION$'} : tok
  );
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
  for (const spec of appHostScan.directives) {
    const atIndex = spec.indexOf('@');
    if (atIndex <= 0 || atIndex !== spec.lastIndexOf('@') || spec.includes(' ')) {
      return deny('MAF_ACTIVITY_SOURCE_UNREADY');
    }
    appHostPackages.push(Object.freeze({name: spec.slice(0, atIndex), version: spec.slice(atIndex + 1)}));
  }
  const appHostInv = validatePackageInventory(appHostPackages);
  if (!appHostInv.ok) return deny(appHostInv.reason);
  const agentPackages = csprojParsed.packages;
  const agentInv = validatePackageInventory(agentPackages);
  if (!agentInv.ok) return deny(agentInv.reason);
  if (!validateAppHostTokens(appHostScan.tokens) ||
      !REQUIRED_CSPROJ_PROPERTIES.every(key => csprojParsed.properties.has(key)) ||
      !validateAllowlistedPackages(appHostInv.map, agentInv.map)) {
    return deny('MAF_ACTIVITY_SOURCE_UNREADY');
  }
  const expectedMafVersion = agentInv.map.get(REQUIRED_MAF_ACTIVITY_SOURCE).version;
  const normalizedTelemetryTokens = normalizeTelemetryVersionToken(telemetryScan.tokens, expectedMafVersion);
  if (normalizedTelemetryTokens === null ||
      canonicalTokensSha256(bootstrapScan.tokens) !== PINNED_LOCAL_OTLP_BOOTSTRAP_AST_SHA256 ||
      canonicalTokensSha256(normalizedTelemetryTokens) !== PINNED_TELEMETRY_AST_SHA256) {
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
