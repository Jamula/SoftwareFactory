import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {
  ALLOWED_MAF_ACTIVITY_SOURCES,
  HOSTED_RECEIPT_MILESTONE,
  HOSTED_RECEIPT_SCHEMA_VERSION,
  MINIMUM_MAF_PACKAGE_VERSION,
  PINNED_HOSTED_RUNTIME_TOOLCHAIN,
  REQUIRED_AGENTS_ACTIVITY_SOURCE,
  REQUIRED_APPHOST_PACKAGES,
  REQUIRED_HOSTED_PLATFORMS,
  REQUIRED_MAF_ACTIVITY_SOURCE,
  REQUIRED_MAF_AGENT_PACKAGES,
  REQUIRED_OTEL_AGENT_PACKAGES,
  REQUIRED_SYNTHETIC_SIGNAL_CONTRACT,
  SOFTWARE_FACTORY_REPOSITORY,
  SOFTWARE_FACTORY_REPOSITORY_ID,
  isDenseDataArray,
  isPlainDataRecord,
  isRetiredGitHubModelsPackage,
  isValidLoopbackHttpsOrigin,
  verifyCrossOsAspireRuntimeEvidence,
  verifyMafSourceManifests
} from '../../tools/engineering-factory/aspire-hosted-receipt.mjs';
import {parseOrigin} from '../../tools/engineering-factory/verify-dashboard-api.mjs';
import {LABELS as SQLITE_METRIC_LABELS, NAMES as SQLITE_METRIC_NAMES} from '../../tools/engineering-factory/verify-dashboard-metric-receipt.mjs';

const RECEIPT_PATH = resolve('docs/evidence/m01-02-hosted-aspire-receipts.json');
const COMMITTED_RECEIPT_RAW = readFileSync(RECEIPT_PATH, 'utf8');
const COMMITTED_RECEIPT = JSON.parse(COMMITTED_RECEIPT_RAW);

function cloneReceipt() {
  return structuredClone(COMMITTED_RECEIPT);
}

function loadRepoManifests() {
  return {
    appHostSource: readFileSync(resolve('apphost.cs'), 'utf8'),
    agentsCsprojSource: readFileSync(resolve('src/SoftwareFactory.Agents/SoftwareFactory.Agents.csproj'), 'utf8'),
    localOtlpBootstrapSource: readFileSync(resolve('src/SoftwareFactory.Agents/Telemetry/LocalOtlpBootstrap.cs'), 'utf8'),
    telemetrySource: readFileSync(resolve('src/SoftwareFactory.Agents/Telemetry/SoftwareFactoryTelemetry.cs'), 'utf8')
  };
}

test('validates committed cec2745 cross-OS hosted Linux + Windows Aspire receipt and live repo parity', () => {
  const verdict = verifyCrossOsAspireRuntimeEvidence(COMMITTED_RECEIPT);
  assert.equal(Object.isFrozen(verdict), true);
  assert.deepEqual(verdict, {
    shadow: true,
    valid: true,
    liveDispatch: false,
    liveMerge: false,
    reason: 'CROSS_OS_HOSTED_ASPIRE_VERIFIED',
    repository: 'Jamula/SoftwareFactory',
    repositoryId: 1471342715,
    headSha: 'cec2745b7b8a21e77ad9f2839d4255d42305d419',
    linuxRunId: 45975774012,
    linuxJobId: 140426990428,
    windowsRunId: 45975774125,
    windowsJobId: 140426992317,
    mafWorkflowRunId: 45975773949,
    mafWorkflowsSourceReady: true
  });

  // Verify sanitized receipt contains no tokens, PEM material, or runner temp paths.
  assert.equal(/login\?t=|-----BEGIN|X-API-Key|RUNNER_TEMP|\/home\/runner|D:\\a\\/i.test(COMMITTED_RECEIPT_RAW), false);

  // Verify single-source-of-truth parity with dashboard API and SQLite metric verifiers.
  assert.deepEqual(
    [REQUIRED_SYNTHETIC_SIGNAL_CONTRACT.counterInstrument, REQUIRED_SYNTHETIC_SIGNAL_CONTRACT.histogramInstrument],
    [...SQLITE_METRIC_NAMES]
  );
  assert.deepEqual(REQUIRED_SYNTHETIC_SIGNAL_CONTRACT.recordedLabels, SQLITE_METRIC_LABELS);
  assert.deepEqual(parseOrigin(COMMITTED_RECEIPT.platforms.linux.loopbackAuth.otlpEndpoint), {
    hostname: '127.0.0.1',
    port: 18890
  });

  // Verify MAF readiness metadata matches checked-out C# manifests and ActivitySources.
  const manifestResult = verifyMafSourceManifests(loadRepoManifests());
  assert.equal(Object.isFrozen(manifestResult), true);
  assert.equal(manifestResult.valid, true);
  assert.equal(manifestResult.reason, 'MAF_SOURCE_MANIFESTS_VERIFIED');
  assert.deepEqual(manifestResult.appHostPackages, COMMITTED_RECEIPT.mafReadiness.appHostPackages);
  assert.deepEqual(manifestResult.agentPackages, COMMITTED_RECEIPT.mafReadiness.agentPackages);
  assert.deepEqual(manifestResult.activitySources, COMMITTED_RECEIPT.mafReadiness.activitySources);

  // Verify exported constants remain frozen.
  for (const frozenValue of [
    PINNED_HOSTED_RUNTIME_TOOLCHAIN,
    REQUIRED_HOSTED_PLATFORMS,
    REQUIRED_HOSTED_PLATFORMS.linux,
    REQUIRED_HOSTED_PLATFORMS.windows,
    REQUIRED_SYNTHETIC_SIGNAL_CONTRACT,
    REQUIRED_SYNTHETIC_SIGNAL_CONTRACT.recordedLabels,
    ALLOWED_MAF_ACTIVITY_SOURCES,
    REQUIRED_APPHOST_PACKAGES,
    MINIMUM_MAF_PACKAGE_VERSION,
    REQUIRED_MAF_AGENT_PACKAGES,
    REQUIRED_OTEL_AGENT_PACKAGES
  ]) {
    assert.equal(Object.isFrozen(frozenValue), true);
  }
  assert.equal(HOSTED_RECEIPT_SCHEMA_VERSION, 1);
  assert.equal(HOSTED_RECEIPT_MILESTONE, 'M01.02');
  assert.equal(SOFTWARE_FACTORY_REPOSITORY, 'Jamula/SoftwareFactory');
  assert.equal(SOFTWARE_FACTORY_REPOSITORY_ID, 1471342715);
  assert.equal(REQUIRED_MAF_ACTIVITY_SOURCE, 'Microsoft.Agents.AI.Workflows');
  assert.equal(REQUIRED_AGENTS_ACTIVITY_SOURCE, 'SoftwareFactory.Agents');
});

test('accepts valid candidate variants for loopback hosts, Linux API readback, Experimental MAF source, and newer MAF semver', () => {
  const candidate = cloneReceipt();
  candidate.branch = 'u/cyrusjamula/supreme-disco';
  candidate.platforms.linux.headBranch = 'u/cyrusjamula/supreme-disco';
  candidate.platforms.windows.headBranch = 'u/cyrusjamula/supreme-disco';
  candidate.platforms.linux.event = 'pull_request';
  candidate.platforms.windows.event = 'merge_group';
  candidate.platforms.linux.loopbackAuth.otlpEndpoint = 'https://localhost:18890';
  candidate.platforms.linux.loopbackAuth.liveApi401ChallengeVerified = true;
  candidate.platforms.windows.loopbackAuth.otlpEndpoint = 'https://[::1]:65535';
  candidate.platforms.linux.telemetry.traceReadbackMethod = 'authenticated-https-api';
  candidate.platforms.linux.telemetry.traceReadbackTool = 'tools/engineering-factory/verify-dashboard-api.mjs';
  candidate.mafReadiness.activitySources.push('Experimental.Microsoft.Agents.AI');
  candidate.mafReadiness.agentPackages = [
    {name: 'Microsoft.Agents.AI', version: '2.0.0'},
    {name: 'Microsoft.Agents.AI.GitHub.Copilot', version: '1.29.0'},
    {name: 'Microsoft.Agents.AI.Workflows', version: '1.28.1'},
    {name: 'OpenTelemetry', version: '1.21.0'},
    {name: 'OpenTelemetry.Exporter.OpenTelemetryProtocol', version: '1.21.0'}
  ];
  const verdict = verifyCrossOsAspireRuntimeEvidence(candidate);
  assert.equal(verdict.valid, true);
  assert.equal(verdict.reason, 'CROSS_OS_HOSTED_ASPIRE_VERIFIED');
});

test('rejects proxies, revoked proxies, getters, non-plain prototypes, symbols, and malformed arrays without executing traps', () => {
  let trapReads = 0;
  const poison = () => {
    trapReads++;
    throw new Error('unexpected accessor execution');
  };

  const {proxy: revokedObject, revoke: revokeObject} = Proxy.revocable(cloneReceipt(), {});
  revokeObject();
  const {proxy: revokedArray, revoke: revokeArray} = Proxy.revocable(['Microsoft.Agents.AI.Workflows'], {});
  revokeArray();

  for (const badRoot of [
    null,
    undefined,
    'receipt',
    42,
    [],
    new Date(),
    Object.create(null),
    new Proxy(cloneReceipt(), {}),
    revokedObject
  ]) {
    const res = verifyCrossOsAspireRuntimeEvidence(badRoot);
    assert.equal(res.valid, false);
    assert.equal(res.reason, 'EVIDENCE_UNKNOWN');
  }

  // Missing key, extra key, symbol key, non-enumerable key, undefined value, and getter key.
  const missingKey = cloneReceipt();
  delete missingKey.headSha;
  assert.equal(verifyCrossOsAspireRuntimeEvidence(missingKey).reason, 'EVIDENCE_UNKNOWN');

  const extraKey = cloneReceipt();
  extraKey.extra = true;
  assert.equal(verifyCrossOsAspireRuntimeEvidence(extraKey).reason, 'EVIDENCE_UNKNOWN');

  const symbolKey = cloneReceipt();
  symbolKey[Symbol('hidden')] = 1;
  assert.equal(verifyCrossOsAspireRuntimeEvidence(symbolKey).reason, 'EVIDENCE_UNKNOWN');

  const nonEnum = cloneReceipt();
  Object.defineProperty(nonEnum, 'headSha', {value: nonEnum.headSha, enumerable: false});
  assert.equal(verifyCrossOsAspireRuntimeEvidence(nonEnum).reason, 'EVIDENCE_UNKNOWN');

  const undefVal = cloneReceipt();
  undefVal.headSha = undefined;
  assert.equal(verifyCrossOsAspireRuntimeEvidence(undefVal).reason, 'EVIDENCE_UNKNOWN');

  const getterRoot = cloneReceipt();
  Object.defineProperty(getterRoot, 'headSha', {get: poison, enumerable: true});
  assert.equal(verifyCrossOsAspireRuntimeEvidence(getterRoot).reason, 'EVIDENCE_UNKNOWN');

  // Nested proxy and getter traps across platforms, loopbackAuth, telemetry, recordedLabels, and mafReadiness.
  const nestedProxyPlatforms = cloneReceipt();
  nestedProxyPlatforms.platforms = new Proxy(nestedProxyPlatforms.platforms, {});
  assert.equal(verifyCrossOsAspireRuntimeEvidence(nestedProxyPlatforms).reason, 'PLATFORMS_INCOMPLETE');

  const nestedGetterLinux = cloneReceipt();
  Object.defineProperty(nestedGetterLinux.platforms.linux, 'nodeVersion', {get: poison, enumerable: true});
  assert.equal(verifyCrossOsAspireRuntimeEvidence(nestedGetterLinux).reason, 'INVALID_PLATFORM_RECEIPT');

  const nestedProxyAuth = cloneReceipt();
  nestedProxyAuth.platforms.linux.loopbackAuth = new Proxy(nestedProxyAuth.platforms.linux.loopbackAuth, {});
  assert.equal(verifyCrossOsAspireRuntimeEvidence(nestedProxyAuth).reason, 'LOOPBACK_AUTH_UNVERIFIED');

  const nestedGetterLabels = cloneReceipt();
  Object.defineProperty(nestedGetterLabels.platforms.windows.telemetry.recordedLabels, 'stage', {
    get: poison,
    enumerable: true
  });
  assert.equal(verifyCrossOsAspireRuntimeEvidence(nestedGetterLabels).reason, 'TELEMETRY_RECEIPT_UNVERIFIED');

  const nestedProxyTelemetry = cloneReceipt();
  nestedProxyTelemetry.platforms.windows.telemetry = new Proxy(nestedProxyTelemetry.platforms.windows.telemetry, {});
  assert.equal(verifyCrossOsAspireRuntimeEvidence(nestedProxyTelemetry).reason, 'TELEMETRY_RECEIPT_UNVERIFIED');

  // Dense data array validation including sparse arrays with matching ownKeys count, getters, and custom prototypes.
  assert.equal(isPlainDataRecord({a: 1}, ['a', 'b']), false);
  assert.equal(isDenseDataArray(null), false);
  assert.equal(isDenseDataArray('abc'), false);
  assert.equal(isDenseDataArray({0: 'a', length: 1}), false);
  assert.equal(isDenseDataArray(revokedArray), false);
  assert.equal(isDenseDataArray([]), false);
  assert.equal(isDenseDataArray(['a', 'b'], 1, 1), false);

  const subProtoArr = Object.setPrototypeOf(['a'], Object.create(Array.prototype));
  assert.equal(isDenseDataArray(subProtoArr), false);

  const sparseWithNamedKey = Array(1);
  sparseWithNamedKey.named = 'x';
  assert.equal(isDenseDataArray(sparseWithNamedKey), false);

  const getterElementArr = ['Microsoft.Agents.AI.Workflows', 'SoftwareFactory.Agents'];
  Object.defineProperty(getterElementArr, '0', {get: poison, enumerable: true});
  const badMafArray = cloneReceipt();
  badMafArray.mafReadiness.activitySources = getterElementArr;
  assert.equal(verifyCrossOsAspireRuntimeEvidence(badMafArray).reason, 'MAF_ACTIVITY_SOURCE_UNREADY');

  assert.equal(trapReads, 0);
});

test('enforces envelope identity, zero laptop dependency, zero unapproved spend, and paired platform structure', () => {
  for (const mutate of [
    r => { r.schemaVersion = 2; },
    r => { r.milestone = 'M02.01'; },
    r => { r.issueNumber = 0; },
    r => { r.issueNumber = 1.5; },
    r => { r.repository = 'Other/Repo'; },
    r => { r.repositoryId = 999; },
    r => { r.branch = 123; },
    r => { r.branch = ''; },
    r => { r.branch = '/leading'; },
    r => { r.branch = 'trailing/'; },
    r => { r.branch = 'double//slash'; },
    r => { r.branch = 'parent..ref'; },
    r => { r.branch = 'trailing.'; },
    r => { r.branch = 'ref@{0}'; },
    r => { r.branch = '@'; },
    r => { r.branch = 'u/.hidden/branch'; },
    r => { r.branch = 'u/branch.lock'; },
    r => { r.branch = 'bad space'; },
    r => { r.headSha = '0'.repeat(40); },
    r => { r.headSha = 'CEC2745B7B8A21E77AD9F2839D4255D42305D419'; },
    r => { r.headSha = 'short'; },
    r => { r.headSha = 12345; }
  ]) {
    const candidate = cloneReceipt();
    mutate(candidate);
    assert.equal(verifyCrossOsAspireRuntimeEvidence(candidate).reason, 'ENVELOPE_IDENTITY_INVALID');
  }

  for (const badLaptop of [true, 'false', 0]) {
    const candidate = cloneReceipt();
    candidate.laptopDependency = badLaptop;
    assert.equal(verifyCrossOsAspireRuntimeEvidence(candidate).reason, 'LAPTOP_DEPENDENCY_FORBIDDEN');
  }

  for (const badSpend of [1, -1, 0.5, '0']) {
    const candidate = cloneReceipt();
    candidate.incrementalUnapprovedSpendUsdCents = badSpend;
    assert.equal(verifyCrossOsAspireRuntimeEvidence(candidate).reason, 'UNAPPROVED_SPEND_FORBIDDEN');
  }

  const missingWindows = cloneReceipt();
  delete missingWindows.platforms.windows;
  assert.equal(verifyCrossOsAspireRuntimeEvidence(missingWindows).reason, 'PLATFORMS_INCOMPLETE');
});

test('enforces cross-OS runner provenance, SHA/branch alignment, pinned toolchain, zero Python, and timing bounds', () => {
  const otherSha = 'a'.repeat(40);

  const cases = [
    [r => { r.platforms.linux.os = 'windows'; }, 'RUNNER_IMAGE_MISMATCH'],
    [r => { r.platforms.linux.runnerLabel = 'ubuntu-22.04'; }, 'RUNNER_IMAGE_MISMATCH'],
    [r => { r.platforms.windows.runnerLabel = 'windows-2022'; }, 'RUNNER_IMAGE_MISMATCH'],
    [r => { r.platforms.linux.runnerEnvironment = 'self-hosted'; }, 'NON_GITHUB_HOSTED_RUNNER'],
    [r => { r.platforms.windows.runnerGroupName = 'Self-Hosted'; }, 'NON_GITHUB_HOSTED_RUNNER'],
    [r => { r.platforms.linux.jobName = 'test-coverage'; }, 'JOB_IDENTITY_MISMATCH'],
    [r => { r.platforms.windows.workflowPath = '.github/workflows/other.yml'; }, 'JOB_IDENTITY_MISMATCH'],
    [r => { r.platforms.linux.workflowName = '   '; }, 'JOB_IDENTITY_MISMATCH'],
    [r => { r.platforms.linux.workflowName = 'bad\u0007name'; }, 'JOB_IDENTITY_MISMATCH'],
    [r => { r.platforms.linux. workflowName = 123; }, 'JOB_IDENTITY_MISMATCH'],
    [r => { r.platforms.linux.runId = 0; }, 'INVALID_PLATFORM_RECEIPT'],
    [r => { r.platforms.windows.jobId = -5; }, 'INVALID_PLATFORM_RECEIPT'],
    [r => { r.platforms.linux.runUrl = 'https://evil.example/Jamula/SoftwareFactory/actions/runs/45975774012'; }, 'RUN_URL_MISMATCH'],
    [r => { r.platforms.windows.jobUrl = 'https://github.com/Jamula/SoftwareFactory/actions/runs/45975774125/job/999'; }, 'RUN_URL_MISMATCH'],
    [r => { r.platforms.linux.headSha = otherSha; }, 'HEAD_SHA_MISMATCH'],
    [r => { r.platforms.windows.headSha = 'invalid-sha'; }, 'HEAD_SHA_MISMATCH'],
    [r => { r.platforms.linux.headBranch = 'develop'; }, 'BRANCH_MISMATCH'],
    [r => { r.platforms.windows.headBranch = 'develop'; }, 'BRANCH_MISMATCH'],
    [r => { r.platforms.linux.event = 'workflow_dispatch'; }, 'RUNTIME_JOB_NOT_SUCCESSFUL'],
    [r => { r.platforms.linux.status = 'in_progress'; }, 'RUNTIME_JOB_NOT_SUCCESSFUL'],
    [r => { r.platforms.windows.conclusion = 'failure'; }, 'RUNTIME_JOB_NOT_SUCCESSFUL'],
    [r => { r.platforms.linux.startedAt = 12345; }, 'INVALID_TIMING'],
    [r => { r.platforms.linux.startedAt = '2026-11-27 09:41:18Z'; }, 'INVALID_TIMING'],
    [r => { r.platforms.linux.startedAt = '2026-13-01T00:00:00Z'; }, 'INVALID_TIMING'],
    [r => { r.platforms.linux.startedAt = '2026-02-30T00:00:00Z'; }, 'INVALID_TIMING'],
    [r => { r.platforms.windows.completedAt = '2026-11-27T09:41:20Z'; }, 'INVALID_TIMING'],
    [r => { r.platforms.windows.durationMs = 128000; }, 'INVALID_TIMING'],
    [r => { r.platforms.windows.durationMs = '129000'; }, 'INVALID_TIMING'],
    [r => {
      r.platforms.linux.startedAt = '2026-11-27T08:00:00Z';
      r.platforms.linux.completedAt = '2026-11-27T09:00:01Z';
      r.platforms.linux.durationMs = 3_601_000;
    }, 'INVALID_TIMING'],
    [r => { r.platforms.linux.nodeVersion = 'v22.12.0'; }, 'TOOLCHAIN_PIN_MISMATCH'],
    [r => { r.platforms.windows.dotnetVersion = '9.0.200'; }, 'TOOLCHAIN_PIN_MISMATCH'],
    [r => { r.platforms.linux.aspireVersion = '16.2.0'; }, 'TOOLCHAIN_PIN_MISMATCH'],
    [r => { r.platforms.linux.pythonInvocations = -1; }, 'INVALID_PLATFORM_RECEIPT'],
    [r => { r.platforms.windows.pythonInvocations = 1.5; }, 'INVALID_PLATFORM_RECEIPT'],
    [r => { r.platforms.linux.pythonInvocations = 1; }, 'PYTHON_INVOCATION_FORBIDDEN'],
    [r => { r.platforms.windows.pythonInvocations = 2; }, 'PYTHON_INVOCATION_FORBIDDEN'],
    [r => {
      r.platforms.windows.runId = r.platforms.linux.runId;
      r.platforms.windows.runUrl = `https://github.com/Jamula/SoftwareFactory/actions/runs/${r.platforms.windows.runId}`;
      r.platforms.windows.jobUrl = `${r.platforms.windows.runUrl}/job/${r.platforms.windows.jobId}`;
    }, 'DUPLICATE_RUN_OR_JOB_ID'],
    [r => {
      r.platforms.windows.jobId = r.platforms.linux.jobId;
      r.platforms.windows.jobUrl = `${r.platforms.windows.runUrl}/job/${r.platforms.windows.jobId}`;
    }, 'DUPLICATE_RUN_OR_JOB_ID']
  ];

  for (const [mutate, expectedReason] of cases) {
    const candidate = cloneReceipt();
    mutate(candidate);
    const verdict = verifyCrossOsAspireRuntimeEvidence(candidate);
    assert.equal(verdict.valid, false);
    assert.equal(verdict.reason, expectedReason);
  }
});

test('enforces loopback HTTPS login/401 challenge, OTLP trace/log/SQLite metrics, SDK shutdown, and AppHost stop', () => {
  assert.equal(isValidLoopbackHttpsOrigin(null), false);
  assert.equal(isValidLoopbackHttpsOrigin('http://127.0.0.1:18890'), false);
  assert.equal(isValidLoopbackHttpsOrigin('https://127.0.0.1:70000'), false);
  assert.equal(isValidLoopbackHttpsOrigin('https://127.0.0.1:18890/v1/traces'), false);
  assert.equal(isValidLoopbackHttpsOrigin('https://127.0.0.1:18890'), true);

  for (const mutateAuth of [
    a => { a.otlpEndpoint = 'http://127.0.0.1:18890'; },
    a => { a.otlpEndpoint = 'https://remote.example:18890'; },
    a => { a.otlpProtocol = 'grpc'; },
    a => { a.dashboardHttpsLoopbackVerified = false; },
    a => { a.loginChallengeVerified = false; },
    a => { a.api401VerifierTestPassed = false; },
    a => { a.liveApi401ChallengeVerified = 'false'; },
    a => { a.anonymousAllowed = true; },
    a => { a.unsecuredTransportAllowed = true; },
    a => { a.tlsVerificationBypassed = true; },
    a => { a.rootStoreMutated = true; }
  ]) {
    const candidate = cloneReceipt();
    mutateAuth(candidate.platforms.linux.loopbackAuth);
    assert.equal(verifyCrossOsAspireRuntimeEvidence(candidate).reason, 'LOOPBACK_AUTH_UNVERIFIED');
  }

  const missingLive401OnApiReadback = cloneReceipt();
  missingLive401OnApiReadback.platforms.windows.loopbackAuth.liveApi401ChallengeVerified = false;
  assert.equal(verifyCrossOsAspireRuntimeEvidence(missingLive401OnApiReadback).reason, 'LOOPBACK_AUTH_UNVERIFIED');

  for (const mutateTelemetry of [
    t => { t.serviceName = 'other-service'; },
    t => { t.scopeName = 'other-scope'; },
    t => { t.syntheticScenario = 'wrong'; },
    t => { t.syntheticResultState = 'eligible'; },
    t => { t.syntheticResultReason = 'OK'; },
    t => { t.traceReadbackMethod = 'unverified'; },
    t => { t.traceReadbackTool = 'tools/engineering-factory/verify-dashboard-api.mjs'; },
    t => { t.spanName = 'wrong.span'; },
    t => { t.traceVerified = false; },
    t => { t.correlatedLogBody = 'wrong.log'; },
    t => { t.correlatedLogVerified = false; },
    t => { t.traceSpanCorrelationVerified = false; },
    t => { t.sqlitePersistenceMode = 'InMemory'; },
    t => { t.sqliteReadOnlyVerified = false; },
    t => { t.metricReceiptTool = 'wrong.mjs'; },
    t => { t.counterInstrument = 'wrong.counter'; },
    t => { t.counterMonotonic = false; },
    t => { t.counterTemporality = 'delta'; },
    t => { t.counterValue = 2; },
    t => { t.counterVerified = false; },
    t => { t.histogramInstrument = 'wrong.hist'; },
    t => { t.histogramUnit = 's'; },
    t => { t.histogramTemporality = 'delta'; },
    t => { t.histogramCount = 0; },
    t => { t.histogramVerified = false; },
    t => { t.recordedLabels.stage = 'reconcile'; },
    t => { t.recordedLabels.outcome = 'eligible'; },
    t => { t.recordedLabels.reason = 'STOPPED'; },
    t => { t.rawTelemetryPublished = true; },
    t => { t.tempArtifactsCleaned = false; }
  ]) {
    const candidate = cloneReceipt();
    mutateTelemetry(candidate.platforms.linux.telemetry);
    assert.equal(verifyCrossOsAspireRuntimeEvidence(candidate).reason, 'TELEMETRY_RECEIPT_UNVERIFIED');
  }

  // Windows must use authenticated-https-api readback, never cli-export-zip.
  const winZip = cloneReceipt();
  winZip.platforms.windows.telemetry.traceReadbackMethod = 'cli-export-zip';
  winZip.platforms.windows.telemetry.traceReadbackTool = 'tools/engineering-factory/verify-dashboard-export.mjs';
  assert.equal(verifyCrossOsAspireRuntimeEvidence(winZip).reason, 'TELEMETRY_RECEIPT_UNVERIFIED');

  const noSdkShutdown = cloneReceipt();
  noSdkShutdown.platforms.windows.sdkShutdownVerified = false;
  assert.equal(verifyCrossOsAspireRuntimeEvidence(noSdkShutdown).reason, 'SDK_SHUTDOWN_UNVERIFIED');

  const noCleanStop = cloneReceipt();
  noCleanStop.platforms.linux.appHostCleanStop = false;
  assert.equal(verifyCrossOsAspireRuntimeEvidence(noCleanStop).reason, 'APPHOST_STOP_UNVERIFIED');
});

test('enforces MAF Microsoft.Agents.AI.Workflows ActivitySource readiness and rejects retired GitHub Models packages', () => {
  assert.equal(isRetiredGitHubModelsPackage(null), false);
  assert.equal(isRetiredGitHubModelsPackage('Aspire.Hosting.AppHost'), false);
  assert.equal(isRetiredGitHubModelsPackage('Aspire.Hosting.GitHub.Models'), true);
  assert.equal(isRetiredGitHubModelsPackage('CommunityToolkit.Aspire.Hosting.GitHub.Models'), true);
  assert.equal(isRetiredGitHubModelsPackage('Microsoft.Extensions.AI.GitHubModels'), true);

  const mafCases = [
    [m => { delete m.activitySources; }, 'MAF_ACTIVITY_SOURCE_UNREADY'],
    [m => { m.headSha = 'b'.repeat(40); }, 'HEAD_SHA_MISMATCH'],
    [m => { m.retiredGitHubModelsReferenced = true; }, 'RETIRED_GITHUB_MODELS_PACKAGE_FORBIDDEN'],
    [m => { m.workflowRunId = 45975774012; }, 'DUPLICATE_RUN_OR_JOB_ID'],
    [m => { m.linuxAgentJobId = m.windowsAgentJobId; }, 'DUPLICATE_RUN_OR_JOB_ID'],
    [m => { m.linuxAgentJobId = 140426990428; }, 'DUPLICATE_RUN_OR_JOB_ID'],
    [m => { m.windowsAgentJobId = 140426992317; }, 'DUPLICATE_RUN_OR_JOB_ID'],
    [m => { m.workflowRunId = 0; }, 'DUPLICATE_RUN_OR_JOB_ID'],
    [m => { m.workflowRunUrl = 'https://github.com/Jamula/SoftwareFactory/actions/runs/999'; }, 'RUN_URL_MISMATCH'],
    [m => { m.appHostResourceName = 'wrong-resource'; }, 'MAF_ACTIVITY_SOURCE_UNREADY'],
    [m => { m.appHostProjectPath = 'wrong.csproj'; }, 'MAF_ACTIVITY_SOURCE_UNREADY'],
    [m => { m.explicitStartOnly = false; }, 'MAF_ACTIVITY_SOURCE_UNREADY'],
    [m => { m.copilotSkipCliDownload = false; }, 'MAF_ACTIVITY_SOURCE_UNREADY'],
    [m => { m.loopbackOtlpOnly = false; }, 'MAF_ACTIVITY_SOURCE_UNREADY'],
    [m => { m.authenticatedHeadersRequired = false; }, 'MAF_ACTIVITY_SOURCE_UNREADY'],
    [m => { m.activitySources = ['SoftwareFactory.Agents']; }, 'MAF_ACTIVITY_SOURCE_UNREADY'],
    [m => { m.activitySources = ['Microsoft.Agents.AI.Workflows']; }, 'MAF_ACTIVITY_SOURCE_UNREADY'],
    [m => { m.activitySources = ['Microsoft.Agents.AI.Workflows', 'Microsoft.Agents.AI.Workflows']; }, 'MAF_ACTIVITY_SOURCE_UNREADY'],
    [m => { m.activitySources = ['Microsoft.Agents.AI.Workflows', 'Unknown.Source']; }, 'MAF_ACTIVITY_SOURCE_UNREADY'],
    [m => { m.activitySources = [123]; }, 'MAF_ACTIVITY_SOURCE_UNREADY'],
    [m => { m.appHostPackages = []; }, 'MAF_ACTIVITY_SOURCE_UNREADY'],
    [m => { m.appHostPackages.push({name: 'bad/name', version: '17.0.0'}); }, 'MAF_ACTIVITY_SOURCE_UNREADY'],
    [m => { m.appHostPackages.push({name: 123, version: '17.0.0'}); }, 'MAF_ACTIVITY_SOURCE_UNREADY'],
    [m => { m.appHostPackages.push({name: 'Aspire.Hosting.AppHost', version: '17.0.0'}); }, 'MAF_ACTIVITY_SOURCE_UNREADY'],
    [m => { m.appHostPackages[0].version = '16.2.0'; }, 'MAF_ACTIVITY_SOURCE_UNREADY'],
    [m => { m.appHostPackages[0].version = '17.0.0-preview.1'; }, 'MAF_ACTIVITY_SOURCE_UNREADY'],
    [m => { m.appHostPackages[0].version = 17; }, 'MAF_ACTIVITY_SOURCE_UNREADY'],
    [m => { m.appHostPackages.pop(); }, 'MAF_ACTIVITY_SOURCE_UNREADY'],
    [m => { m.appHostPackages.push({name: 'Aspire.Hosting.GitHub.Models', version: '9.2.0'}); }, 'RETIRED_GITHUB_MODELS_PACKAGE_FORBIDDEN'],
    [m => { m.agentPackages.push({name: 'Microsoft.Extensions.AI.GitHubModels', version: '1.0.0'}); }, 'RETIRED_GITHUB_MODELS_PACKAGE_FORBIDDEN'],
    [m => { m.agentPackages.push({name: 'Microsoft.SemanticKernel', version: '1.40.0'}); }, 'EXCLUDED_AGENT_FRAMEWORK_FORBIDDEN'],
    [m => { m.agentPackages.push({name: 'AutoGen.Core', version: '0.2.0'}); }, 'EXCLUDED_AGENT_FRAMEWORK_FORBIDDEN'],
    [m => { m.agentPackages = []; }, 'MAF_ACTIVITY_SOURCE_UNREADY'],
    [m => { m.agentPackages[0].version = '0.9.0'; }, 'MAF_ACTIVITY_SOURCE_UNREADY'],
    [m => { m.agentPackages[2].version = '1.27.9'; }, 'MAF_ACTIVITY_SOURCE_UNREADY'],
    [m => { m.agentPackages.pop(); }, 'MAF_ACTIVITY_SOURCE_UNREADY']
  ];

  for (const [mutate, expectedReason] of mafCases) {
    const candidate = cloneReceipt();
    mutate(candidate.mafReadiness);
    const verdict = verifyCrossOsAspireRuntimeEvidence(candidate);
    assert.equal(verdict.valid, false);
    assert.equal(verdict.reason, expectedReason);
  }
});

test('verifyMafSourceManifests fails closed on malformed inputs, retired GitHub Models, and incomplete C# wiring', () => {
  assert.equal(verifyMafSourceManifests(null).reason, 'MANIFEST_INPUT_INVALID');
  assert.equal(verifyMafSourceManifests({...loadRepoManifests(), appHostSource: ''}).reason, 'MANIFEST_INPUT_INVALID');
  assert.equal(verifyMafSourceManifests({...loadRepoManifests(), appHostSource: 123}).reason, 'MANIFEST_INPUT_INVALID');
  assert.equal(
    verifyMafSourceManifests({...loadRepoManifests(), appHostSource: 'a\u0000b'}).reason,
    'MANIFEST_INPUT_INVALID'
  );
  assert.equal(
    verifyMafSourceManifests({...loadRepoManifests(), appHostSource: 'x'.repeat(262_145)}).reason,
    'MANIFEST_INPUT_INVALID'
  );

  assert.equal(
    verifyMafSourceManifests({
      ...loadRepoManifests(),
      appHostSource: `#:package Aspire.Hosting.GitHub.Models@9.2.0\n${loadRepoManifests().appHostSource}`
    }).reason,
    'RETIRED_GITHUB_MODELS_PACKAGE_FORBIDDEN'
  );

  assert.equal(
    verifyMafSourceManifests({
      ...loadRepoManifests(),
      telemetrySource: `${loadRepoManifests().telemetrySource}\n// Active code check\ninternal static class Bad { internal const string X = "GitHub.Models"; }\n`
    }).reason,
    'RETIRED_GITHUB_MODELS_PACKAGE_FORBIDDEN'
  );

  assert.equal(
    verifyMafSourceManifests({
      ...loadRepoManifests(),
      appHostSource: `#:package Microsoft.SemanticKernel@1.40.0\n${loadRepoManifests().appHostSource}`
    }).reason,
    'EXCLUDED_AGENT_FRAMEWORK_FORBIDDEN'
  );

  assert.equal(
    verifyMafSourceManifests({
      ...loadRepoManifests(),
      telemetrySource: `${loadRepoManifests().telemetrySource}\ninternal static class BadSk { internal const string X = "AutoGen"; }\n`
    }).reason,
    'EXCLUDED_AGENT_FRAMEWORK_FORBIDDEN'
  );

  assert.equal(
    verifyMafSourceManifests({
      ...loadRepoManifests(),
      agentsCsprojSource: loadRepoManifests().agentsCsprojSource.replace(
        '</ItemGroup>',
        '  <PackageReference Include="Microsoft.SemanticKernel" Version="1.40.0" />\n  </ItemGroup>'
      )
    }).reason,
    'EXCLUDED_AGENT_FRAMEWORK_FORBIDDEN'
  );

  // Valid XML prolog, benign comments (including documenting retired packages), verbatim C# strings, and escaped quotes/chars remain accepted.
  const benignDecorated = loadRepoManifests();
  benignDecorated.appHostSource =
    `// Aspire.Hosting.GitHub.Models is retired and unused\n/* Microsoft.SemanticKernel is excluded */\n${benignDecorated.appHostSource} // trailing comment without newline`;
  benignDecorated.telemetrySource =
    `${benignDecorated.telemetrySource}\ninternal static class BenignLiterals { internal static readonly string Verbatim = @"verbatim ""quote"" /* not comment */"; internal static readonly string Escaped = "escaped \\" // not comment"; internal const char Quote = '\\''; }`;
  benignDecorated.agentsCsprojSource =
    `<?xml version="1.0" encoding="utf-8"?>\n<!-- Aspire.Hosting.GitHub.Models is retired -->\n${benignDecorated.agentsCsprojSource}\n<!-- trailing comment -->\n`;
  assert.equal(verifyMafSourceManifests(benignDecorated).valid, true);

  const eofDirectiveOnly = loadRepoManifests();
  eofDirectiveOnly.appHostSource = '#:package Aspire.Hosting.AppHost@17.0.0';
  assert.equal(verifyMafSourceManifests(eofDirectiveOnly).reason, 'MAF_ACTIVITY_SOURCE_UNREADY');

  for (const mutate of [
    m => { m.appHostSource = 'var b = 1;'; },
    m => { m.appHostSource = 'bad\rcarriage'; },
    m => { m.appHostSource = `${m.appHostSource}\n/* unclosed block comment`; },
    m => { m.appHostSource = `${m.appHostSource}\nvar bad = @"unclosed verbatim;`; },
    m => { m.appHostSource = `${m.appHostSource}\nvar bad = """raw""";`; },
    m => { m.appHostSource = `${m.appHostSource}\n}`; },
    m => { m.appHostSource = `${m.appHostSource}\n{`; },
    m => { m.appHostSource = `${m.appHostSource}\nif (false) { var x = 1; }`; },
    m => { m.appHostSource = m.appHostSource.replace('var builder =', 'return;\nvar builder ='); },
    m => { m.appHostSource = m.appHostSource.replace('builder.Build().Run();', ''); },
    m => { m.appHostSource = `${m.appHostSource}\nvar bad = "unclosed string\n";`; },
    m => { m.appHostSource = `${m.appHostSource}\nvar bad = "dangling escape\\\n";`; },
    m => { m.appHostSource = `${m.appHostSource}\nvar bad = "eof escape\\`; },
    m => { m.appHostSource = `${m.appHostSource}\n#:package AfterCode@1.0.0\n`; },
    m => { m.appHostSource = `#if false\n${m.appHostSource}\n#endif\n`; },
    m => { m.appHostSource = `#:package MalformedNoVersion\n${m.appHostSource}`; },
    m => { m.appHostSource = `#:package Bad@1.0.0@extra\r\n${m.appHostSource.replaceAll('\n', '\r\n')}`; },
    m => { m.appHostSource = m.appHostSource.replace('17.0.0', '16.0.0'); },
    m => {
      // Missing WithExplicitStart() on synthetic-shadow must not match maf-specialist-shadow's WithExplicitStart().
      m.appHostSource = m.appHostSource.replace(
        'builder.AddNodeApp("synthetic-shadow", "./tools/engineering-factory", "aspire-telemetry-smoke.mjs")\n    .WithExplicitStart();',
        'builder.AddNodeApp("synthetic-shadow", "./tools/engineering-factory", "aspire-telemetry-smoke.mjs");'
      );
    },
    m => {
      // Premature builder.Build().Run(); before resource registrations must fail closed.
      m.appHostSource = m.appHostSource
        .replace('builder.Build().Run();', '')
        .replace(
          'var builder = DistributedApplication.CreateBuilder(args);',
          'var builder = DistributedApplication.CreateBuilder(args);\nbuilder.Build().Run();'
        );
    },
    m => {
      // Duplicate builder.Build().Run(); must fail closed.
      m.appHostSource = `${m.appHostSource}\nbuilder.Build().Run();`;
    },
    m => {
      // Removing .WithArgs("--smoke") from MAF registration must fail closed.
      m.appHostSource = m.appHostSource.replace('    .WithArgs("--smoke")\n', '');
    },
    m => {
      // Unsupported CLI argument on MAF registration must fail closed.
      m.appHostSource = m.appHostSource.replace('"--smoke"', '"--unknown"');
    },
    m => {
      // Overriding .WithArgs("--smoke") with a second .WithArgs(...) call must fail closed.
      m.appHostSource = m.appHostSource.replace('.WithArgs("--smoke")', '.WithArgs("--smoke").WithArgs("--other")');
    },
    m => {
      // C# block-commented .WithExplicitStart() must fail closed.
      m.appHostSource = m.appHostSource.replaceAll('.WithExplicitStart()', '/* .WithExplicitStart() */');
    },
    m => {
      // Inline // comment before .WithExplicitStart() must fail closed.
      m.appHostSource = m.appHostSource.replace('.WithExplicitStart()', '// .WithExplicitStart()');
    },
    m => {
      m.appHostSource = m.appHostSource.replace(
        'builder.AddDotnetProject',
        '// builder.AddDotnetProject'
      );
    },
    m => { m.appHostSource = m.appHostSource.replaceAll('.WithExplicitStart()', ''); },
    m => { m.agentsCsprojSource = 'bad\rxml'; },
    m => { m.agentsCsprojSource = '<?xml bad'; },
    m => { m.agentsCsprojSource = `<?xml bad ><Project Sdk="Microsoft.NET.Sdk">?>`; },
    m => { m.agentsCsprojSource = `${m.agentsCsprojSource}<!-- unclosed`; },
    m => { m.agentsCsprojSource = `${m.agentsCsprojSource}<!-- illegal -- double dash -->`; },
    m => { m.agentsCsprojSource = `<!DOCTYPE Project>\n${m.agentsCsprojSource}`; },
    m => { m.agentsCsprojSource = `${m.agentsCsprojSource}\nstray-trailing-text`; },
    m => { m.agentsCsprojSource = '<Project Sdk="Microsoft.NET.Sdk">stray</Project>'; },
    m => { m.agentsCsprojSource = '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>'; },
    m => { m.agentsCsprojSource = `${m.agentsCsprojSource}\n<Project Sdk="Microsoft.NET.Sdk"></Project>`; },
    m => { m.agentsCsprojSource = '<Project Sdk="Microsoft.NET.Sdk"><Unclosed'; },
    m => { m.agentsCsprojSource = '<Project Sdk="Microsoft.NET.Sdk"></WrongClose>'; },
    m => { m.agentsCsprojSource = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup></Project>'; },
    m => { m.agentsCsprojSource = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>'; },
    m => { m.agentsCsprojSource = m.agentsCsprojSource.replace('<PropertyGroup>', '<PropertyGroup Condition="false">'); },
    m => { m.agentsCsprojSource = m.agentsCsprojSource.replace('<ItemGroup>', '<Target Name="Override">'); },
    m => { m.agentsCsprojSource = m.agentsCsprojSource.replace('<TargetFramework>net10.0</TargetFramework>', '<TargetFrameworks>net10.0</TargetFrameworks>'); },
    m => { m.agentsCsprojSource = m.agentsCsprojSource.replace('<TargetFramework>net10.0</TargetFramework>', '<TargetFramework Condition="false">net10.0</TargetFramework>'); },
    m => { m.agentsCsprojSource = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0'; },
    m => { m.agentsCsprojSource = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework'; },
    m => { m.agentsCsprojSource = m.agentsCsprojSource.replace('</TargetFramework>', '</Mismatch>'); },
    m => {
      // Lowercase MSBuild property override must fail closed (MSBuild is case-insensitive).
      m.agentsCsprojSource = m.agentsCsprojSource.replace(
        '</Project>',
        '  <PropertyGroup><copilotskipclidownload>false</copilotskipclidownload></PropertyGroup>\n</Project>'
      );
    },
    m => {
      m.agentsCsprojSource = m.agentsCsprojSource.replace(
        '<CopilotSkipCliDownload>true</CopilotSkipCliDownload>',
        '<CopilotSkipCliDownload>&#x66;alse</CopilotSkipCliDownload>'
      );
    },
    m => {
      // Later PropertyGroup overriding CopilotSkipCliDownload to false must fail closed.
      m.agentsCsprojSource = m.agentsCsprojSource.replace(
        '</Project>',
        '  <PropertyGroup><CopilotSkipCliDownload>false</CopilotSkipCliDownload></PropertyGroup>\n</Project>'
      );
    },
    m => {
      // XML-commented CopilotSkipCliDownload property must fail closed.
      m.agentsCsprojSource = m.agentsCsprojSource.replace(
        '<CopilotSkipCliDownload>true</CopilotSkipCliDownload>',
        '<!-- <CopilotSkipCliDownload>true</CopilotSkipCliDownload> -->'
      );
    },
    m => {
      // XML-commented ItemGroup / PackageReference declarations must fail closed.
      m.agentsCsprojSource = m.agentsCsprojSource
        .replace('<ItemGroup>', '<!-- <ItemGroup>')
        .replace('</ItemGroup>', '</ItemGroup> -->');
    },
    m => { m.agentsCsprojSource = m.agentsCsprojSource.replace('net10.0', 'net8.0'); },
    m => { m.agentsCsprojSource = m.agentsCsprojSource.replace('<CopilotSkipCliDownload>true</CopilotSkipCliDownload>', '<CopilotSkipCliDownload>false</CopilotSkipCliDownload>'); },
    m => { m.agentsCsprojSource = m.agentsCsprojSource.replace('<CopilotSkipCliDownload>true</CopilotSkipCliDownload>', ''); },
    m => { m.agentsCsprojSource = m.agentsCsprojSource.replace('/>', '></PackageReference>'); },
    m => { m.agentsCsprojSource = m.agentsCsprojSource.replace('Version="1.28.0" />', 'Broken="true" />'); },
    m => { m.agentsCsprojSource = m.agentsCsprojSource.replace('Version="1.28.0" />', 'Version="1.28.0" Condition="false" />'); },
    m => { m.agentsCsprojSource = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><CopilotSkipCliDownload>true</CopilotSkipCliDownload></PropertyGroup></Project>'; },
    m => { m.agentsCsprojSource = m.agentsCsprojSource.replace('Version="1.28.0"', 'Version="1.27.0"'); },
    m => {
      m.agentsCsprojSource = m.agentsCsprojSource.replaceAll(
        '<PackageReference Include="OpenTelemetry.Exporter.OpenTelemetryProtocol" Version="1.21.0" />',
        ''
      );
    },
    m => {
      // C# \t escape inside WorkflowsSourceName must decode to a tab and fail exact comparison.
      m.telemetrySource = m.telemetrySource.replace(
        '"Microsoft.Agents.AI.Workflows"',
        '"Microsoft.Agen\\ts.AI.Workflows"'
      );
    },
    m => {
      m.telemetrySource = m.telemetrySource.replace(
        '"Microsoft.Agents.AI.Workflows"',
        '"Microsoft.Agen\\xs.AI.Workflows"'
      );
    },
    m => { m.telemetrySource = m.telemetrySource.replaceAll('"Microsoft.Agents.AI.Workflows"', '"Other.Workflows"'); },
    m => { m.telemetrySource = m.telemetrySource.replaceAll('"SoftwareFactory.Agents"', '"Other.Agents"'); },
    m => {
      // Disposing tracerProvider immediately inside StartFromEnvironment must fail closed.
      m.localOtlpBootstrapSource = m.localOtlpBootstrapSource.replace(
        'ILogger stageLogger = loggerFactory.CreateLogger(SoftwareFactoryTelemetry.AgentsSourceName);',
        'tracerProvider.Dispose();\n        ILogger stageLogger = loggerFactory.CreateLogger(SoftwareFactoryTelemetry.AgentsSourceName);'
      );
    },
    m => {
      // Weakening ContainsForbiddenOverrides helper body must fail closed.
      m.localOtlpBootstrapSource = m.localOtlpBootstrapSource.replace(
        'ForbiddenExactEnvKeys.Contains(key)',
        'false'
      );
    },
    m => {
      // Making ValidateHeaders conditional in ValidateEnvironment must fail closed.
      m.localOtlpBootstrapSource = m.localOtlpBootstrapSource.replace(
        'ValidateHeaders(rawHeaders);',
        'if (false) ValidateHeaders(rawHeaders);'
      );
    },
    m => {
      // Clearing options.Headers after assignment in ConfigureExporterOptions must fail closed.
      m.localOtlpBootstrapSource = m.localOtlpBootstrapSource.replace(
        'options.Headers = config.Headers;',
        'options.Headers = config.Headers;\n        options.Headers = "";'
      );
    },
    m => {
      // Appending extra unreachable condition to ParseLoopbackEndpoint guard must fail closed.
      m.localOtlpBootstrapSource = m.localOtlpBootstrapSource.replace(
        '!LoopbackHosts.Contains(uri.Host)',
        '!LoopbackHosts.Contains(uri.Host) && uri.Host.Length < 0'
      );
    },
    m => {
      // Block-commented .AddSource(...) in LocalOtlpBootstrap.cs must fail closed.
      m.localOtlpBootstrapSource = m.localOtlpBootstrapSource.replace(
        '.AddSource(SoftwareFactoryTelemetry.WorkflowsSourceName, SoftwareFactoryTelemetry.AgentsSourceName)',
        '/* .AddSource(SoftwareFactoryTelemetry.WorkflowsSourceName, SoftwareFactoryTelemetry.AgentsSourceName) */'
      );
    },
    m => {
      // String-literal spoofing of .AddSource(...) must fail closed.
      m.localOtlpBootstrapSource = m.localOtlpBootstrapSource.replace(
        '.AddSource(SoftwareFactoryTelemetry.WorkflowsSourceName, SoftwareFactoryTelemetry.AgentsSourceName)',
        '.AddSource(".AddSource(SoftwareFactoryTelemetry.WorkflowsSourceName, SoftwareFactoryTelemetry.AgentsSourceName)")'
      );
    },
    m => {
      // Bypassing ValidateEnvironment in StartFromEnvironment must fail closed.
      m.localOtlpBootstrapSource = m.localOtlpBootstrapSource.replace(
        'ValidatedLocalOtlpConfig? validated = ValidateEnvironment(env);',
        'ValidatedLocalOtlpConfig? validated = null;'
      );
    },
    m => {
      // Missing MeterProvider OTLP exporter wiring must fail closed.
      m.localOtlpBootstrapSource = m.localOtlpBootstrapSource.replace('"/v1/metrics"', '"/v1/wrong"');
    },
    m => {
      // Missing log OTLP exporter wiring must fail closed.
      m.localOtlpBootstrapSource = m.localOtlpBootstrapSource.replace('"/v1/logs"', '"/v1/wrong"');
    },
    m => {
      // Adding a non-loopback host to LoopbackHosts allowlist must fail closed.
      m.localOtlpBootstrapSource = m.localOtlpBootstrapSource.replace('"[::1]"', '"[::1]", "0.0.0.0"');
    },
    m => {
      // Removing LoopbackHosts declaration must fail closed.
      m.localOtlpBootstrapSource = m.localOtlpBootstrapSource.replace('LoopbackHosts = new(', 'OtherHosts = new(');
    },
    m => {
      // Removing forbidden environment override guard must fail closed.
      m.localOtlpBootstrapSource = m.localOtlpBootstrapSource.replaceAll('if (hasAnyForbiddenOverride)', 'if (false)');
    },
    m => {
      // Replacing ParseLoopbackEndpoint(rawEndpoint!) with new Uri(rawEndpoint!) must fail closed.
      m.localOtlpBootstrapSource = m.localOtlpBootstrapSource.replace(
        'ParseLoopbackEndpoint(rawEndpoint!)',
        'new Uri(rawEndpoint!)'
      );
    },
    m => {
      // Removing ValidateHeaders(rawHeaders); call must fail closed.
      m.localOtlpBootstrapSource = m.localOtlpBootstrapSource.replace('ValidateHeaders(rawHeaders);', '');
    },
    m => {
      // Removing ValidatedLocalOtlpConfig BaseEndpoint/Headers binding must fail closed.
      m.localOtlpBootstrapSource = m.localOtlpBootstrapSource.replace('Headers = rawHeaders!,', 'Headers = "",');
    },
    m => {
      // Removing exporter header binding or proxy/redirect disablement must fail closed.
      m.localOtlpBootstrapSource = m.localOtlpBootstrapSource.replace('options.Headers = config.Headers;', '');
    },
    m => {
      m.localOtlpBootstrapSource = m.localOtlpBootstrapSource.replace('config.BaseEndpoint', 'new Uri("https://example.com")');
    },
    m => {
      m.localOtlpBootstrapSource = m.localOtlpBootstrapSource.replace('UseProxy = false', 'UseProxy = true');
    },
    m => {
      // Weakening ParseLoopbackEndpoint host/port check must fail closed.
      m.localOtlpBootstrapSource = m.localOtlpBootstrapSource.replace('!LoopbackHosts.Contains(uri.Host)', 'false');
    },
    m => {
      // Weakening ValidateHeaders whitespace or key=value check must fail closed.
      m.localOtlpBootstrapSource = m.localOtlpBootstrapSource.replace('string.IsNullOrWhiteSpace(rawHeaders)', 'false');
    },
    m => {
      m.localOtlpBootstrapSource = m.localOtlpBootstrapSource.replace('pair.IndexOf(\'=\')', '1');
    },
    m => {
      m.localOtlpBootstrapSource = m.localOtlpBootstrapSource.replace('eq <= 0 || eq == pair.Length - 1', 'false');
    },
    m => {
      // Missing method header or empty method body in LocalOtlpBootstrap.cs must fail closed.
      m.localOtlpBootstrapSource = m.localOtlpBootstrapSource.replace(
        'private static void ValidateHeaders(string? rawHeaders)',
        'private static void OtherValidate(string? rawHeaders)'
      );
    },
    m => {
      const start = m.localOtlpBootstrapSource.indexOf('private static void ValidateHeaders(string? rawHeaders)');
      const end = m.localOtlpBootstrapSource.indexOf('private static bool ContainsForbiddenOverrides', start);
      m.localOtlpBootstrapSource =
        `${m.localOtlpBootstrapSource.slice(0, start)}private static void ValidateHeaders(string? rawHeaders) {}\n\n    ${m.localOtlpBootstrapSource.slice(end)}`;
    },
    m => {
      // Early return bypassing ParseLoopbackEndpoint or ValidateHeaders must fail closed.
      m.localOtlpBootstrapSource = m.localOtlpBootstrapSource.replace(
        'ArgumentNullException.ThrowIfNull(env);',
        'return new ValidatedLocalOtlpConfig { BaseEndpoint = new Uri("https://example.com"), Protocol = OtlpExportProtocol.HttpProtobuf, Headers = "a=b", ServiceName = "s" };'
      );
    },
    m => {
      m.localOtlpBootstrapSource = m.localOtlpBootstrapSource.replace(
        'if (!Uri.TryCreate(',
        'return new Uri(rawEndpoint); if (!Uri.TryCreate('
      );
    },
    m => {
      m.localOtlpBootstrapSource = m.localOtlpBootstrapSource.replace(
        'if (string.IsNullOrWhiteSpace(rawHeaders)',
        'return; if (string.IsNullOrWhiteSpace(rawHeaders)'
      );
    },
    m => {
      m.localOtlpBootstrapSource = m.localOtlpBootstrapSource.replace(
        'options.Protocol = config.Protocol;',
        'return; options.Protocol = config.Protocol;'
      );
    },
    m => { m.localOtlpBootstrapSource = m.localOtlpBootstrapSource.replaceAll('AgentsSourceName', 'OtherSource'); },
    m => { m.localOtlpBootstrapSource = m.localOtlpBootstrapSource.replace('TryGetValue("OTEL_EXPORTER_OTLP_ENDPOINT"', 'TryGetValue("NONE"'); },
    m => { m.localOtlpBootstrapSource = m.localOtlpBootstrapSource.replace('TryGetValue("OTEL_EXPORTER_OTLP_HEADERS"', 'TryGetValue("NONE"'); }
  ]) {
    const manifests = loadRepoManifests();
    mutate(manifests);
    const res = verifyMafSourceManifests(manifests);
    assert.equal(res.valid, false);
    assert.equal(res.reason, 'MAF_ACTIVITY_SOURCE_UNREADY');
  }
});
