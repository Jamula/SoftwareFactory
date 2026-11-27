import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  defaultSoftwareFactoryTestInventory
} from '../../tools/engineering-factory/contract-routing.mjs';
import {
  CONNECTOR_PROTOCOL_VERSION,
  CONNECTOR_ROLES,
  FORBIDDEN_CONTROL_PLANE_PATHS,
  MAX_MCP_REQUEST_BYTES,
  MCP_CONNECTOR_TOOLS,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  PROVIDER_ADAPTERS,
  SUPPORTED_PROVIDER_FAMILIES,
  createCopilotOnlyRollbackState,
  handleMcpConnectorRequest,
  isValidTraceparent,
  validateMultiAgentConnectorConfig
} from '../../tools/engineering-factory/mcp-agent-connector.mjs';

const HEAD_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const OTHER_SHA = 'c'.repeat(40);
const VALID_TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const FACTORY_REPO_ID = 1471342715;
const CONSUMER_REPO_ID = 22001100;
const NOW_MS = 1_795_740_000_000;

const copilotConfig = (overrides = {}) => ({
  providerFamily: 'github-copilot',
  adapter: 'copilot-cloud-agent',
  includedQuotaVerified: true,
  overageHardStopUsdCents: 0,
  unapprovedSpendUsdCents: 0,
  externalMergeAuthorityOnly: true,
  allowDirectMergeOrPolicyWrite: false,
  ...overrides
});

const codexConfig = (overrides = {}) => ({
  providerFamily: 'openai-codex',
  adapter: 'openai-codex-action',
  role: 'specialist',
  ownerAuthorized: true,
  includedQuotaVerified: true,
  unapprovedSpendUsdCents: 0,
  env: { OPENAI_AGENTS_DISABLE_TRACING: '1' },
  externalTelemetryDisabled: true,
  trustedBaseConfigRestored: true,
  externalMergeAuthorityOnly: true,
  allowDirectMergeOrPolicyWrite: false,
  ...overrides
});

const claudeConfig = (overrides = {}) => ({
  providerFamily: 'anthropic-claude',
  adapter: 'claude-code-action',
  role: 'independent-reviewer',
  ownerAuthorized: true,
  includedQuotaVerified: true,
  unapprovedSpendUsdCents: 0,
  preToolUseOnFailure: 'block',
  externalTelemetryDisabled: true,
  trustedBaseConfigRestored: true,
  externalMergeAuthorityOnly: true,
  allowDirectMergeOrPolicyWrite: false,
  ...overrides
});

const consumerProjectConfig = () => ({
  schemaVersion: 1,
  project: { key: 'spellbook', repository: 'Synthetic/Spellbook', defaultBranch: 'main' },
  execution: { enabled: false, mode: 'shadow', stop: true },
  limits: { maxConcurrentLanes: 2, leaseMs: 5000, maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 1000 },
  adapters: { workTracker: 'mock', engineeringAgent: 'mock', state: 'sqlite' },
  lanes: [
    { id: 'api', specialist: 'api', owners: ['src/api'], prompt: 'agents/engineering-coordinator.md' },
    { id: 'docs', owners: ['docs'], prompt: 'agents/engineering-coordinator.md' }
  ],
  knowledgeMap: {
    repository: 'Synthetic/Spellbook',
    revision: HEAD_SHA,
    source: 'trusted-default-branch',
    generatedAtMs: NOW_MS - 1000,
    maxAgeMs: 60_000,
    components: [
      {
        id: 'api-service',
        lane: 'api',
        specialist: 'api',
        owners: ['src/api'],
        interfaces: ['src/api/contracts.mjs'],
        decisions: ['docs/architecture.md'],
        tests: ['tests/api.test.mjs'],
        dependsOn: []
      }
    ]
  }
});

const authorizedContext = () => ({
  authorizedRepositories: [
    {
      repositoryId: FACTORY_REPO_ID,
      repository: 'Jamula/SoftwareFactory',
      defaultBranch: 'main',
      revision: HEAD_SHA
    },
    {
      repositoryId: CONSUMER_REPO_ID,
      repository: 'Synthetic/Spellbook',
      defaultBranch: 'main',
      coverage: { line: 97, branch: 92 },
      revision: HEAD_SHA,
      projectConfig: consumerProjectConfig()
    }
  ]
});

function buildProtectedSquashFixtures() {
  const scope = { repository: 'Jamula/SoftwareFactory', repositoryId: FACTORY_REPO_ID, branch: 'main' };
  const reviewer = 'copilot-pull-request-reviewer[bot]';
  const checks = ['build-test', 'upload-coverage-javascript', 'windows-aspire-runtime', 'CodeQL']
    .map((name, index) => ({ name, appId: index + 1 }));
  const policy = {
    version: 1,
    repository: scope.repository,
    defaultBranch: 'main',
    mergeMethod: 'squash',
    mode: 'shadow',
    killSwitch: false,
    checks,
    reviewers: [reviewer],
    coverage: { line: 98, branch: 95 },
    owners: [{ prefix: 'src', owner: 'synthetic-owner' }],
    maxActive: 1,
    creditLimit: 5,
    riskClasses: ['low']
  };
  const snapshot = {
    repository: scope.repository,
    policySource: 'trusted-default-branch',
    pr: 12,
    issue: 1,
    head: HEAD_SHA,
    base: BASE_SHA,
    observedHead: HEAD_SHA,
    observedBase: BASE_SHA,
    baseBranch: 'main',
    rateLimited: false,
    remainingCredits: 1,
    activeCount: 0,
    providerReady: true,
    risk: 'low',
    priority: 1,
    paths: ['src/component.mjs'],
    dependencies: [],
    acceptanceComplete: true,
    baseCompatible: true,
    mainHealthy: true,
    threadsResolved: true,
    securityClear: true,
    coverage: { head: HEAD_SHA, line: 98, branch: 95, complete: true },
    author: 'author',
    agent: 'agent',
    checks: checks.map(check => ({ ...check, head: HEAD_SHA, status: 'completed', conclusion: 'success' })),
    reviews: [{ reviewer, head: HEAD_SHA, state: 'COMMENTED', summaryDisposition: 'clear' }]
  };
  const intent = { ...scope, number: 12, expectedHead: HEAD_SHA, expectedBase: BASE_SHA };
  const squashSnapshot = { ...snapshot };
  delete squashSnapshot.reviews;
  delete squashSnapshot.threadsResolved;
  delete squashSnapshot.securityClear;
  delete squashSnapshot.coverage;
  const evidence = {
    ...scope,
    number: 12,
    head: HEAD_SHA,
    base: BASE_SHA,
    open: true,
    draft: false,
    stop: false,
    scopeVerified: true,
    nativeQueue: false,
    protection: {
      ...scope,
      base: BASE_SHA,
      verified: true,
      protected: true,
      bypass: false,
      method: 'squash',
      upToDate: true,
      review: true,
      threads: true,
      security: true,
      requiredChecks: checks
    },
    policy,
    snapshot: squashSnapshot,
    reviewHistory: [{ sequence: 1, reviewer, head: HEAD_SHA, state: 'COMMENTED', summaryDisposition: 'clear' }],
    coverageReports: [{ component: 'component', head: HEAD_SHA, lines: 98, lineTotal: 100, branches: 95, branchTotal: 100 }],
    expectedComponents: ['component'],
    threads: { head: HEAD_SHA, resolved: true },
    security: { head: HEAD_SHA, clear: true },
    platformReview: { head: HEAD_SHA, complete: true, independent: true, summaryDisposition: 'clear', findings: [] }
  };
  return { scope, policy, snapshot, intent, evidence };
}

test('constants freeze supported protocol versions, providers, roles, and read-only tools', () => {
  assert.equal(CONNECTOR_PROTOCOL_VERSION, '1.0.0');
  assert.equal(MCP_PROTOCOL_VERSION, '2025-06-18');
  assert.equal(MCP_SERVER_NAME, 'softwarefactory-mcp-connector');
  assert.equal(MAX_MCP_REQUEST_BYTES, 65_536);
  assert.deepEqual(SUPPORTED_PROVIDER_FAMILIES, ['github-copilot', 'openai-codex', 'anthropic-claude']);
  assert.deepEqual(CONNECTOR_ROLES, ['worker', 'independent-reviewer', 'specialist']);
  assert.equal(Object.isFrozen(PROVIDER_ADAPTERS), true);
  assert.equal(Object.isFrozen(FORBIDDEN_CONTROL_PLANE_PATHS), true);
  assert.equal(MCP_CONNECTOR_TOOLS.length, 4);
  for (const tool of MCP_CONNECTOR_TOOLS) {
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false
    });
  }
});

test('validateMultiAgentConnectorConfig verifies Copilot, Codex, and Claude isolation contracts', () => {
  for (const adapter of PROVIDER_ADAPTERS['github-copilot']) {
    const res = validateMultiAgentConnectorConfig(copilotConfig({ adapter, externalTelemetryDisabled: true }));
    assert.equal(res.valid, true);
    assert.equal(res.reason, 'PROVIDER_ISOLATION_VERIFIED');
    assert.equal(res.providerFamily, 'github-copilot');
    assert.equal(res.adapter, adapter);
    assert.equal(res.role, 'worker');
    assert.equal(res.externalMergeAuthorityOnly, true);
    assert.equal(res.allowDirectMergeOrPolicyWrite, false);
    assert.equal(res.unapprovedSpendUsdCents, 0);
    assert.equal(res.telemetryExportAllowed, false);
    assert.equal(res.sessionCheckpointVerified, false);
  }

  for (const adapter of PROVIDER_ADAPTERS['openai-codex']) {
    const res = validateMultiAgentConnectorConfig(codexConfig({ adapter }));
    assert.equal(res.valid, true);
    assert.equal(res.providerFamily, 'openai-codex');
    assert.equal(res.adapter, adapter);
    assert.equal(res.role, 'specialist');
  }

  const cappedCodex = codexConfig({
    authorizedSpendCapUsdCents: 500,
    observedSpendUsdCents: 120
  });
  delete cappedCodex.includedQuotaVerified;
  assert.equal(validateMultiAgentConnectorConfig(cappedCodex).valid, true);

  const serializedState = JSON.stringify({ turn: 2, summary: 'bounded checkpoint state' });
  const digest = createHash('sha256').update(serializedState, 'utf8').digest('hex');
  for (const adapter of PROVIDER_ADAPTERS['anthropic-claude']) {
    const res = validateMultiAgentConnectorConfig(claudeConfig({
      adapter,
      headSha: HEAD_SHA,
      sessionCheckpoint: {
        sessionId: 'claude-session:01',
        sha256: digest,
        headSha: HEAD_SHA,
        serializedState
      }
    }));
    assert.equal(res.valid, true);
    assert.equal(res.providerFamily, 'anthropic-claude');
    assert.equal(res.sessionCheckpointVerified, true);
  }

  const cappedClaude = claudeConfig({
    includedQuotaVerified: false,
    authorizedSpendCapUsdCents: 400,
    observedSpendUsdCents: 0
  });
  assert.equal(validateMultiAgentConnectorConfig(cappedClaude).valid, true);
  assert.equal(validateMultiAgentConnectorConfig(cappedClaude).sessionCheckpointVerified, false);
});

test('validateMultiAgentConnectorConfig fails closed on proxy, prototype, budget, tracing, and hook violations', () => {
  const proxyTrap = {
    get() { throw new Error('proxy get trap must never run'); },
    ownKeys() { throw new Error('proxy ownKeys trap must never run'); },
    getPrototypeOf() { throw new Error('proxy getPrototypeOf trap must never run'); }
  };
  const getterObj = copilotConfig();
  Object.defineProperty(getterObj, 'includedQuotaVerified', {
    enumerable: true,
    get() { throw new Error('accessor must not run'); }
  });
  const symbolObj = copilotConfig();
  Object.defineProperty(symbolObj, Symbol('extra'), { value: 1 });

  for (const invalid of [
    null,
    undefined,
    'config',
    [],
    new Proxy({}, proxyTrap),
    new Proxy([], proxyTrap),
    Object.create(null),
    getterObj,
    symbolObj,
    copilotConfig({ unknownField: true }),
    copilotConfig({ headSha: 'not-a-sha' }),
    copilotConfig({ sessionCheckpoint: {} }),
    copilotConfig({ authorizedSpendCapUsdCents: 100, observedSpendUsdCents: 0 }),
    codexConfig({ sessionCheckpoint: {} })
  ]) {
    assert.equal(validateMultiAgentConnectorConfig(invalid).reason, 'INVALID_CONNECTOR_CONFIG');
  }

  assert.equal(validateMultiAgentConnectorConfig(copilotConfig({ providerFamily: 'other-vendor' })).reason,
    'UNSUPPORTED_PROVIDER_FAMILY');
  assert.equal(validateMultiAgentConnectorConfig(copilotConfig({ adapter: 'claude-agent-sdk' })).reason,
    'UNSUPPORTED_PROVIDER_ADAPTER');
  assert.equal(validateMultiAgentConnectorConfig(copilotConfig({ externalMergeAuthorityOnly: false })).reason,
    'EXTERNAL_MERGE_AUTHORITY_REQUIRED');
  assert.equal(validateMultiAgentConnectorConfig(copilotConfig({ allowDirectMergeOrPolicyWrite: true })).reason,
    'DIRECT_MERGE_OR_POLICY_WRITE_FORBIDDEN');
  for (const spend of [1, -1, '0', null]) {
    assert.equal(validateMultiAgentConnectorConfig(copilotConfig({ unapprovedSpendUsdCents: spend })).reason,
      'UNAPPROVED_SPEND_FORBIDDEN');
  }
  assert.equal(validateMultiAgentConnectorConfig(copilotConfig({ role: 'admin' })).reason,
    'INVALID_CONNECTOR_ROLE');

  assert.equal(validateMultiAgentConnectorConfig(copilotConfig({ includedQuotaVerified: false })).reason,
    'INCLUDED_QUOTA_UNVERIFIED');
  assert.equal(validateMultiAgentConnectorConfig(copilotConfig({ overageHardStopUsdCents: 100 })).reason,
    'OVERAGE_HARD_STOP_REQUIRED');
  assert.equal(validateMultiAgentConnectorConfig(copilotConfig({ externalTelemetryDisabled: false })).reason,
    'EXTERNAL_TELEMETRY_NOT_DISABLED');

  assert.equal(validateMultiAgentConnectorConfig(codexConfig({ ownerAuthorized: false })).reason,
    'OWNER_AUTHORIZATION_REQUIRED');
  for (const badEnv of [undefined, null, [], {}, { OPENAI_AGENTS_DISABLE_TRACING: '0' }, { OPENAI_AGENTS_DISABLE_TRACING: 1 }]) {
    assert.equal(validateMultiAgentConnectorConfig(codexConfig({ env: badEnv })).reason,
      'EXTERNAL_TRACING_NOT_DISABLED');
  }
  assert.equal(validateMultiAgentConnectorConfig(codexConfig({ externalTelemetryDisabled: false })).reason,
    'EXTERNAL_TELEMETRY_NOT_DISABLED');
  assert.equal(validateMultiAgentConnectorConfig(codexConfig({ trustedBaseConfigRestored: false })).reason,
    'UNTRUSTED_PROVIDER_CONFIG');
  assert.equal(validateMultiAgentConnectorConfig(codexConfig({ includedQuotaVerified: false })).reason,
    'INCLUDED_QUOTA_UNVERIFIED');
  const codexMissingQuota = codexConfig();
  delete codexMissingQuota.includedQuotaVerified;
  assert.equal(validateMultiAgentConnectorConfig(codexMissingQuota).reason, 'INCLUDED_QUOTA_UNVERIFIED');
  for (const invalidCap of [
    { authorizedSpendCapUsdCents: 500 },
    { observedSpendUsdCents: 10 },
    { authorizedSpendCapUsdCents: 0, observedSpendUsdCents: 0 },
    { authorizedSpendCapUsdCents: 500, observedSpendUsdCents: -1 },
    { authorizedSpendCapUsdCents: 500, observedSpendUsdCents: 10, includedQuotaVerified: 'yes' }
  ]) {
    assert.equal(validateMultiAgentConnectorConfig(codexConfig(invalidCap)).reason,
      'INVALID_AUTHORIZED_SPEND_CAP');
  }
  for (const exhaustedCap of [
    { authorizedSpendCapUsdCents: 500, observedSpendUsdCents: 500 },
    { authorizedSpendCapUsdCents: 500, observedSpendUsdCents: 600 }
  ]) {
    assert.equal(validateMultiAgentConnectorConfig(codexConfig(exhaustedCap)).reason,
      'AUTHORIZED_SPEND_CAP_EXHAUSTED');
  }
  assert.equal(validateMultiAgentConnectorConfig(copilotConfig({ env: [] })).reason,
    'INVALID_CONNECTOR_ENV');
  assert.equal(validateMultiAgentConnectorConfig(codexConfig({
    env: { OPENAI_AGENTS_DISABLE_TRACING: '1', lowercase_bad: 'x' }
  })).reason, 'INVALID_CONNECTOR_ENV');
  assert.equal(validateMultiAgentConnectorConfig(codexConfig({
    env: { OPENAI_AGENTS_DISABLE_TRACING: '1', BAD_CTRL: 'line\nbreak' }
  })).reason, 'INVALID_CONNECTOR_ENV');
  assert.equal(validateMultiAgentConnectorConfig(codexConfig({
    env: { OPENAI_AGENTS_DISABLE_TRACING: '1', LEAKED_KEY: 'sk-live-secret12345' }
  })).reason, 'SECRET_MATERIAL_REJECTED');

  assert.equal(validateMultiAgentConnectorConfig(claudeConfig({ ownerAuthorized: false })).reason,
    'OWNER_AUTHORIZATION_REQUIRED');
  for (const hookMode of [undefined, 'ignore', 'warn', true]) {
    assert.equal(validateMultiAgentConnectorConfig(claudeConfig({ preToolUseOnFailure: hookMode })).reason,
      'PRE_TOOL_HOOK_NOT_FAIL_CLOSED');
  }
  assert.equal(validateMultiAgentConnectorConfig(claudeConfig({ externalTelemetryDisabled: false })).reason,
    'EXTERNAL_TELEMETRY_NOT_DISABLED');
  assert.equal(validateMultiAgentConnectorConfig(claudeConfig({ trustedBaseConfigRestored: false })).reason,
    'UNTRUSTED_PROVIDER_CONFIG');
  assert.equal(validateMultiAgentConnectorConfig(claudeConfig({ includedQuotaVerified: false })).reason,
    'INCLUDED_QUOTA_UNVERIFIED');
  const claudeMissingQuota = claudeConfig();
  delete claudeMissingQuota.includedQuotaVerified;
  assert.equal(validateMultiAgentConnectorConfig(claudeMissingQuota).reason, 'INCLUDED_QUOTA_UNVERIFIED');
  assert.equal(validateMultiAgentConnectorConfig(claudeConfig({
    authorizedSpendCapUsdCents: 200,
    observedSpendUsdCents: 200
  })).reason, 'AUTHORIZED_SPEND_CAP_EXHAUSTED');

  const validHash = 'd'.repeat(64);
  for (const badCheckpoint of [
    null,
    { sessionId: '', sha256: validHash, headSha: HEAD_SHA, serializedState: '{}' },
    { sessionId: 'sess-1', sha256: 'short', headSha: HEAD_SHA, serializedState: '{}' },
    { sessionId: 'sess-1', sha256: validHash, headSha: 'bad', serializedState: '{}' },
    { sessionId: 'sess-1', sha256: validHash, headSha: HEAD_SHA, serializedState: 123 },
    { sessionId: 'sess-1', sha256: validHash, headSha: HEAD_SHA, serializedState: 'x'.repeat(MAX_MCP_REQUEST_BYTES + 1) }
  ]) {
    assert.equal(validateMultiAgentConnectorConfig(claudeConfig({
      headSha: HEAD_SHA,
      sessionCheckpoint: badCheckpoint
    })).reason, 'INVALID_SESSION_CHECKPOINT');
  }
  assert.equal(validateMultiAgentConnectorConfig(claudeConfig({
    headSha: HEAD_SHA,
    sessionCheckpoint: { sessionId: 'sess-1', sha256: validHash, headSha: HEAD_SHA }
  })).reason, 'CHECKPOINT_STATE_MISSING');
  assert.equal(validateMultiAgentConnectorConfig(claudeConfig({
    sessionCheckpoint: { sessionId: 'sess-1', sha256: validHash, headSha: HEAD_SHA, serializedState: '{}' }
  })).reason, 'SESSION_CHECKPOINT_HEAD_MISMATCH');
  assert.equal(validateMultiAgentConnectorConfig(claudeConfig({
    headSha: BASE_SHA,
    sessionCheckpoint: { sessionId: 'sess-1', sha256: validHash, headSha: HEAD_SHA, serializedState: '{}' }
  })).reason, 'SESSION_CHECKPOINT_HEAD_MISMATCH');
  assert.equal(validateMultiAgentConnectorConfig(claudeConfig({
    headSha: HEAD_SHA,
    sessionCheckpoint: {
      sessionId: 'sess-1',
      sha256: validHash,
      headSha: HEAD_SHA,
      serializedState: 'token sk-ant-api03-secret'
    }
  })).reason, 'SECRET_MATERIAL_REJECTED');
  assert.equal(validateMultiAgentConnectorConfig(claudeConfig({
    headSha: HEAD_SHA,
    sessionCheckpoint: {
      sessionId: 'sess-1',
      sha256: validHash,
      headSha: HEAD_SHA,
      serializedState: '{"clean":true}'
    }
  })).reason, 'SESSION_CHECKPOINT_DIGEST_MISMATCH');
});

test('createCopilotOnlyRollbackState preserves verified Copilot budget evidence and fails closed when unverified', () => {
  const unverifiedRollback = createCopilotOnlyRollbackState('  EXTERNAL_PROVIDER_QUOTA_EXHAUSTED  ');
  assert.equal(Object.isFrozen(unverifiedRollback), true);
  assert.equal(Object.isFrozen(unverifiedRollback.fallbackConfig), true);
  assert.equal(unverifiedRollback.rollbackActive, true);
  assert.equal(unverifiedRollback.reason, 'EXTERNAL_PROVIDER_QUOTA_EXHAUSTED');
  assert.equal(unverifiedRollback.activeProviderFamily, 'github-copilot');
  assert.equal(unverifiedRollback.budgetVerified, false);
  assert.equal(unverifiedRollback.budgetRevalidationRequired, true);
  assert.equal(unverifiedRollback.preserveCopilotExecution, false);
  assert.equal(unverifiedRollback.externalConnectorsEnabled, false);
  assert.equal(unverifiedRollback.fallbackConfig.includedQuotaVerified, false);
  assert.equal(unverifiedRollback.fallbackConfig.overageHardStopUsdCents, null);
  assert.deepEqual(unverifiedRollback.disabledProviders, ['openai-codex', 'anthropic-claude']);
  assert.equal(validateMultiAgentConnectorConfig(unverifiedRollback.fallbackConfig).valid, false);
  assert.equal(validateMultiAgentConnectorConfig(unverifiedRollback.fallbackConfig).reason, 'INCLUDED_QUOTA_UNVERIFIED');

  for (const unverifiedBudget of [
    null,
    { providerFamily: 'openai-codex', includedQuotaVerified: true, overageHardStopUsdCents: 0, unapprovedSpendUsdCents: 0 },
    { includedQuotaVerified: true, overageHardStopUsdCents: 100, unapprovedSpendUsdCents: 0 },
    { includedQuotaVerified: true, overageHardStopUsdCents: 0, unapprovedSpendUsdCents: 1 },
    { includedQuotaVerified: true, overageHardStopUsdCents: 0, unapprovedSpendUsdCents: 0, extra: 1 }
  ]) {
    const rb = createCopilotOnlyRollbackState('QUOTA_STOP', unverifiedBudget);
    assert.equal(rb.budgetRevalidationRequired, true);
    assert.equal(validateMultiAgentConnectorConfig(rb.fallbackConfig).valid, false);
  }

  const verifiedRollback = createCopilotOnlyRollbackState('CODEX_DISABLED', copilotConfig());
  assert.equal(verifiedRollback.budgetVerified, true);
  assert.equal(verifiedRollback.budgetRevalidationRequired, false);
  assert.equal(verifiedRollback.preserveCopilotExecution, true);
  assert.equal(verifiedRollback.fallbackConfig.includedQuotaVerified, true);
  assert.equal(verifiedRollback.fallbackConfig.overageHardStopUsdCents, 0);
  assert.equal(validateMultiAgentConnectorConfig(verifiedRollback.fallbackConfig).valid, true);

  for (const fallbackInput of [undefined, '', '   ', 'bad\nreason', 'x'.repeat(161)]) {
    assert.equal(createCopilotOnlyRollbackState(fallbackInput).reason, 'ROLLBACK_TO_COPILOT_ONLY');
  }
  const redacted = createCopilotOnlyRollbackState('provider failed with ghp_secretToken999');
  assert.equal(redacted.reason, 'REDACTED_ROLLBACK_REASON');
  assert.equal(JSON.stringify(redacted).includes('ghp_secretToken999'), false);
});

test('handleMcpConnectorRequest enforces byte bounds, JSON-RPC 2.0 envelopes, notifications, and lifecycle methods', () => {
  assert.equal(handleMcpConnectorRequest('').error.code, -32700);
  assert.equal(handleMcpConnectorRequest('{bad json').error.code, -32700);
  assert.equal(handleMcpConnectorRequest('[]').error.code, -32600);
  assert.equal(handleMcpConnectorRequest('{"__proto__":{"x":1}}').error.code, -32600);

  const multiByteOversize = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'ping',
    params: { pad: '€'.repeat(25_000) }
  });
  assert.ok(multiByteOversize.length < MAX_MCP_REQUEST_BYTES);
  assert.ok(Buffer.byteLength(multiByteOversize, 'utf8') > MAX_MCP_REQUEST_BYTES);
  assert.equal(handleMcpConnectorRequest(multiByteOversize).error.code, -32600);
  assert.equal(handleMcpConnectorRequest(multiByteOversize).error.data.reason, 'PAYLOAD_TOO_LARGE');

  const oversizeObj = {
    jsonrpc: '2.0',
    id: 1,
    method: 'ping',
    params: { pad: 'a'.repeat(MAX_MCP_REQUEST_BYTES) }
  };
  assert.equal(handleMcpConnectorRequest(oversizeObj).error.data.reason, 'PAYLOAD_TOO_LARGE');

  let deep = { leaf: true };
  for (let i = 0; i < 14; i++) deep = { nested: deep };
  assert.equal(handleMcpConnectorRequest(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: deep })).error.code, -32600);

  const wide = Array.from({ length: 255 }, (_, idx) => ({ a: idx, b: idx, c: idx }));
  const hugeBudget = {
    jsonrpc: '2.0',
    id: 1,
    method: 'ping',
    params: Object.fromEntries(Array.from({ length: 10 }, (_, idx) => [`k${idx}`, wide]))
  };
  assert.equal(handleMcpConnectorRequest(hugeBudget).error.code, -32600);
  assert.equal(handleMcpConnectorRequest({ jsonrpc: '2.0', id: 1, method: 'ping', params: { badNum: Number.NaN } }).error.code, -32600);
  assert.equal(handleMcpConnectorRequest({ jsonrpc: '2.0', id: 1, method: 'ping', params: { fn: () => {} } }).error.code, -32600);
  const sparse = new Array(2);
  sparse[0] = 'only-first';
  assert.equal(handleMcpConnectorRequest({ jsonrpc: '2.0', id: 1, method: 'ping', params: { sparse } }).error.code, -32600);
  const holeWithExtra = Object.assign(new Array(1), { extra: 1 });
  assert.equal(handleMcpConnectorRequest({ jsonrpc: '2.0', id: 1, method: 'ping', params: { holeWithExtra } }).error.code, -32600);
  assert.equal(handleMcpConnectorRequest(null).error.code, -32600);

  for (const badId of [1.5, true, '', 'id\n1', {}]) {
    const err = handleMcpConnectorRequest({ jsonrpc: '2.0', id: badId, method: 'ping' });
    assert.equal(err.error.code, -32600);
    assert.equal(err.id, null);
  }

  for (const badEnvelope of [
    { jsonrpc: '1.0', id: 'req-1', method: 'ping' },
    { jsonrpc: '2.0', id: 'req-1', method: '' },
    { jsonrpc: '2.0', id: 'req-1', method: 'ping', extra: 1 }
  ]) {
    const err = handleMcpConnectorRequest(badEnvelope);
    assert.equal(err.error.code, -32600);
    assert.equal(err.id, 'req-1');
  }

  assert.equal(handleMcpConnectorRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: undefined,
    method: 'notifications/cancelled',
    params: { _meta: { progressToken: 'tok-notify', count: 1 } }
  }), null);
  assert.equal(handleMcpConnectorRequest({ jsonrpc: '2.0', method: 'notifications/initialized', params: [] }).error.code, -32600);
  assert.equal(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: { _meta: 'invalid' }
  }).error.code, -32600);

  assert.equal(handleMcpConnectorRequest({ jsonrpc: '2.0', id: 2, method: 'ping', params: [] }).error.code, -32602);
  for (const invalidCtx of [
    null,
    { unexpected: true },
    { stop: 'true' },
    { stop: 1 },
    { stop: {} },
    { killSwitch: 'true' },
    { killSwitch: 1 },
    { killSwitch: {} },
    { nowMs: -1 },
    { nowMs: '1000' }
  ]) {
    const ctxErr = handleMcpConnectorRequest({ jsonrpc: '2.0', id: 2, method: 'ping' }, invalidCtx);
    assert.equal(ctxErr.error.code, -32602);
    assert.equal(ctxErr.error.data.reason, 'INVALID_CONNECTOR_CONTEXT');
  }

  const initRaw = JSON.stringify({
    jsonrpc: '2.0',
    id: 'init-1',
    method: 'initialize',
    params: {
      _meta: { progressToken: 'tok-1', traceFlag: true },
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'dotnet-maf', version: '1.28.0' }
    }
  });
  const initRes = handleMcpConnectorRequest(initRaw);
  assert.deepEqual(initRes, {
    jsonrpc: '2.0',
    id: 'init-1',
    result: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: MCP_SERVER_NAME, version: CONNECTOR_PROTOCOL_VERSION }
    }
  });
  assert.equal(handleMcpConnectorRequest({ jsonrpc: '2.0', id: null, method: 'initialize' }).id, null);
  assert.equal(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 3,
    method: 'initialize',
    params: { protocolVersion: '' }
  }).error.code, -32602);

  assert.deepEqual(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 4,
    method: 'ping',
    params: { _meta: { progressToken: 'tok-1' } }
  }), {
    jsonrpc: '2.0',
    id: 4,
    result: {}
  });
  assert.deepEqual(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 40,
    method: 'ping',
    params: { _meta: { progressToken: 42 } }
  }), {
    jsonrpc: '2.0',
    id: 40,
    result: {}
  });
  assert.equal(handleMcpConnectorRequest({ jsonrpc: '2.0', id: 4, method: 'ping', params: { a: 1 } }).error.code, -32602);

  const listRes = handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/list',
    params: { _meta: { progressToken: 'tok-1' }, cursor: 'page-1' }
  });
  assert.equal(listRes.result.tools.length, 4);
  assert.equal(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/list',
    params: { bad: 1 }
  }).error.code, -32602);
  assert.equal(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/list',
    params: { cursor: 123 }
  }).error.code, -32602);

  for (const badMeta of [
    [],
    { progressToken: '' },
    { progressToken: 1.5 },
    { nestedArr: ['gho_secretInMetaArray'] },
    { nestedObj: { token: 'ghu_secretInMetaObj' } }
  ]) {
    const metaErr = handleMcpConnectorRequest({
      jsonrpc: '2.0',
      id: 'meta-bad',
      method: 'ping',
      params: { _meta: badMeta }
    });
    assert.equal(metaErr.error.code, -32602);
    assert.equal(metaErr.error.data.reason, 'INVALID_MCP_META');
  }

  assert.equal(handleMcpConnectorRequest({ jsonrpc: '2.0', id: 6, method: 'resources/write' }).error.code, -32601);
  assert.equal(handleMcpConnectorRequest({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 123 } }).error.code, -32602);
  assert.equal(handleMcpConnectorRequest({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'ping', arguments: [] } }).error.code, -32602);
  assert.equal(handleMcpConnectorRequest({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'delete_branch' } }).error.data.reason, 'UNKNOWN_TOOL');

  const stopped = handleMcpConnectorRequest(
    { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'get_repo_knowledge_map' } },
    { killSwitch: true }
  );
  assert.equal(stopped.result.isError, true);
  assert.equal(stopped.result.structuredContent.reason, 'CONNECTOR_STOPPED');

  const stoppedByStopFlag = handleMcpConnectorRequest(
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get_repo_knowledge_map' } },
    { stop: true, killSwitch: false }
  );
  assert.equal(stoppedByStopFlag.result.isError, true);
  assert.equal(stoppedByStopFlag.result.structuredContent.reason, 'CONNECTOR_STOPPED');
});

test('tools/call get_repo_knowledge_map enforces authorizedRepositories, explicit freshness timestamps, and consumer thresholds', () => {
  const ctx = { ...authorizedContext(), nowMs: NOW_MS };

  const sfRes = handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'km-sf',
    method: 'tools/call',
    params: {
      name: 'get_repo_knowledge_map',
      arguments: { repositoryId: FACTORY_REPO_ID, repository: 'Jamula/SoftwareFactory', nowMs: NOW_MS }
    }
  }, authorizedContext());
  assert.equal(sfRes.result.isError, false);
  const sfMap = sfRes.result.structuredContent;
  assert.deepEqual(JSON.parse(sfRes.result.content[0].text), sfMap);
  assert.equal(sfMap.authorized, true);
  assert.equal(sfMap.verifiedAtMs, NOW_MS);
  assert.deepEqual(sfMap.coverageThresholds, { line: 98, branch: 95 });
  assert.equal(sfMap.architectureInvariants.externalMergeAuthorityOnly, true);
  assert.equal(sfMap.architectureInvariants.allowDirectMergeOrPolicyWrite, false);
  assert.ok(sfMap.lanes.some(lane => lane.id === 'factory-lane'));
  const sfFactoryComp = sfMap.components.find(comp => comp.id === 'engineering-factory');
  assert.ok(sfFactoryComp);
  assert.ok(sfFactoryComp.tests.includes('tests/engineering-factory/mcp-agent-connector.test.mjs'));

  const explicitInventory = [
    ...new Set([
      ...defaultSoftwareFactoryTestInventory(),
      'tests/engineering-factory/mcp-agent-connector.test.mjs'
    ])
  ];
  const sfExplicitInvRes = handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'km-sf-inv-ok',
    method: 'tools/call',
    params: {
      name: 'get_repo_knowledge_map',
      arguments: {
        repositoryId: FACTORY_REPO_ID,
        nowMs: NOW_MS,
        testInventory: explicitInventory
      }
    }
  }, authorizedContext());
  assert.equal(sfExplicitInvRes.result.isError, false);

  assert.equal(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'km-sf-inv-missing-connector',
    method: 'tools/call',
    params: {
      name: 'get_repo_knowledge_map',
      arguments: {
        repositoryId: FACTORY_REPO_ID,
        nowMs: NOW_MS,
        testInventory: defaultSoftwareFactoryTestInventory()
      }
    }
  }, authorizedContext()).result.structuredContent.reason, 'TEST_INVENTORY_UNALIGNED');

  assert.equal(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'km-sf-inv-missing-baseline',
    method: 'tools/call',
    params: {
      name: 'get_repo_knowledge_map',
      arguments: {
        repositoryId: FACTORY_REPO_ID,
        nowMs: NOW_MS,
        testInventory: ['tests/engineering-factory/mcp-agent-connector.test.mjs']
      }
    }
  }, authorizedContext()).result.structuredContent.reason, 'TEST_INVENTORY_UNALIGNED');

  assert.equal(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'km-sf-inv-bad-type',
    method: 'tools/call',
    params: {
      name: 'get_repo_knowledge_map',
      arguments: {
        repositoryId: FACTORY_REPO_ID,
        nowMs: NOW_MS,
        testInventory: [123]
      }
    }
  }, authorizedContext()).result.structuredContent.reason, 'INVALID_KNOWLEDGE_MAP_ARGUMENTS');

  const consumerRes = handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'km-consumer',
    method: 'tools/call',
    params: {
      name: 'get_repo_knowledge_map',
      arguments: { repositoryId: CONSUMER_REPO_ID, revision: HEAD_SHA, nowMs: NOW_MS }
    }
  }, ctx);
  assert.equal(consumerRes.result.isError, false);
  assert.deepEqual(consumerRes.result.structuredContent.coverageThresholds, { line: 97, branch: 92 });
  assert.equal(consumerRes.result.structuredContent.lanes.length, 2);
  assert.equal(consumerRes.result.structuredContent.lanes[1].specialist, null);

  assert.equal(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'km-missing-now',
    method: 'tools/call',
    params: {
      name: 'get_repo_knowledge_map',
      arguments: { repositoryId: CONSUMER_REPO_ID, revision: HEAD_SHA }
    }
  }, authorizedContext()).result.structuredContent.reason, 'FRESHNESS_TIMESTAMP_REQUIRED');

  assert.equal(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'km-mismatch-now',
    method: 'tools/call',
    params: {
      name: 'get_repo_knowledge_map',
      arguments: { repositoryId: CONSUMER_REPO_ID, revision: HEAD_SHA, nowMs: NOW_MS + 5 }
    }
  }, ctx).result.structuredContent.reason, 'CLOCK_MISMATCH');

  const laneOnlyCtx = {
    nowMs: NOW_MS,
    authorizedRepositories: [
      {
        repositoryId: 33001100,
        repository: 'Synthetic/FamilyTree',
        revision: HEAD_SHA,
        lanes: [{ id: 'backend', specialist: 'api', owners: ['src/backend'] }]
      }
    ]
  };
  const laneOnlyRes = handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'km-lanes',
    method: 'tools/call',
    params: { name: 'get_repo_knowledge_map', arguments: { repositoryId: 33001100 } }
  }, laneOnlyCtx);
  assert.equal(laneOnlyRes.result.isError, false);
  assert.deepEqual(laneOnlyRes.result.structuredContent.coverageThresholds, { line: 95, branch: 90 });

  assert.equal(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'km-unauth',
    method: 'tools/call',
    params: { name: 'get_repo_knowledge_map', arguments: { repositoryId: 999999 } }
  }, ctx).result.structuredContent.reason, 'UNAUTHORIZED_REPOSITORY');

  assert.equal(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'km-cross',
    method: 'tools/call',
    params: {
      name: 'get_repo_knowledge_map',
      arguments: { repositoryId: FACTORY_REPO_ID, repository: 'Synthetic/Spellbook' }
    }
  }, ctx).result.structuredContent.reason, 'CROSS_REPO_ACCESS_DENIED');

  assert.equal(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'km-stale-rev',
    method: 'tools/call',
    params: {
      name: 'get_repo_knowledge_map',
      arguments: { repositoryId: FACTORY_REPO_ID, revision: OTHER_SHA }
    }
  }, ctx).result.structuredContent.reason, 'STALE_KNOWLEDGE_REVISION');

  assert.equal(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'km-no-rev',
    method: 'tools/call',
    params: { name: 'get_repo_knowledge_map', arguments: { repositoryId: FACTORY_REPO_ID, nowMs: NOW_MS } }
  }, {
    authorizedRepositories: [{ repositoryId: FACTORY_REPO_ID, repository: 'Jamula/SoftwareFactory' }]
  }).result.structuredContent.reason, 'REVISION_REQUIRED');

  assert.equal(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'km-bad-args',
    method: 'tools/call',
    params: { name: 'get_repo_knowledge_map', arguments: { repositoryId: -1 } }
  }, ctx).result.structuredContent.reason, 'INVALID_KNOWLEDGE_MAP_ARGUMENTS');

  assert.equal(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'km-no-ctx',
    method: 'tools/call',
    params: { name: 'get_repo_knowledge_map', arguments: { repositoryId: FACTORY_REPO_ID, nowMs: NOW_MS } }
  }, {}).result.structuredContent.reason, 'AUTHORIZATION_CONTEXT_INVALID');

  assert.equal(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'km-spoof-id',
    method: 'tools/call',
    params: { name: 'get_repo_knowledge_map', arguments: { repositoryId: FACTORY_REPO_ID, nowMs: NOW_MS } }
  }, {
    authorizedRepositories: [{ repositoryId: FACTORY_REPO_ID, repository: 'Spoof/Repo', revision: HEAD_SHA }]
  }).result.structuredContent.reason, 'REPOSITORY_IDENTITY_MISMATCH');

  assert.equal(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'km-floor',
    method: 'tools/call',
    params: { name: 'get_repo_knowledge_map', arguments: { repositoryId: FACTORY_REPO_ID, nowMs: NOW_MS } }
  }, {
    authorizedRepositories: [{
      repositoryId: FACTORY_REPO_ID,
      repository: 'Jamula/SoftwareFactory',
      coverage: { line: 95, branch: 95 },
      revision: HEAD_SHA
    }]
  }).result.structuredContent.reason, 'COVERAGE_FLOOR_VIOLATION');

  for (const badAuthList of [
    [{ repositoryId: 0, repository: 'Synthetic/Bad' }],
    [
      { repositoryId: 10, repository: 'Synthetic/One', revision: HEAD_SHA },
      { repositoryId: 10, repository: 'Synthetic/Two', revision: HEAD_SHA }
    ],
    [{ repositoryId: 10, repository: 'Synthetic/One', defaultBranch: 'bad..branch' }],
    [{ repositoryId: 10, repository: 'Synthetic/One', coverage: { line: 101, branch: 90 } }]
  ]) {
    assert.equal(handleMcpConnectorRequest({
      jsonrpc: '2.0',
      id: 'km-auth-bad',
      method: 'tools/call',
      params: { name: 'get_repo_knowledge_map', arguments: { repositoryId: 10, nowMs: NOW_MS } }
    }, { authorizedRepositories: badAuthList }).result.structuredContent.reason, 'AUTHORIZATION_CONTEXT_INVALID');
  }

  assert.equal(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'km-bad-pc',
    method: 'tools/call',
    params: { name: 'get_repo_knowledge_map', arguments: { repositoryId: 10, revision: HEAD_SHA, nowMs: NOW_MS } }
  }, {
    authorizedRepositories: [{ repositoryId: 10, repository: 'Synthetic/One', projectConfig: {} }]
  }).result.structuredContent.reason, 'INVALID_PROJECT_CONFIG');

  const trunkConfig = consumerProjectConfig();
  trunkConfig.project.defaultBranch = 'trunk';
  for (const conflictingEnrollment of [
    { repositoryId: CONSUMER_REPO_ID, repository: 'Synthetic/Spellbook', revision: HEAD_SHA, projectConfig: trunkConfig },
    {
      repositoryId: CONSUMER_REPO_ID,
      repository: 'Synthetic/Spellbook',
      defaultBranch: 'main',
      revision: HEAD_SHA,
      projectConfig: trunkConfig
    }
  ]) {
    assert.equal(handleMcpConnectorRequest({
      jsonrpc: '2.0',
      id: 'km-branch-conflict',
      method: 'tools/call',
      params: { name: 'get_repo_knowledge_map', arguments: { repositoryId: CONSUMER_REPO_ID, nowMs: NOW_MS } }
    }, { authorizedRepositories: [conflictingEnrollment] }).result.structuredContent.reason, 'BRANCH_METADATA_CONFLICT');
  }

  const alignedTrunkRes = handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'km-branch-trunk-ok',
    method: 'tools/call',
    params: { name: 'get_repo_knowledge_map', arguments: { repositoryId: CONSUMER_REPO_ID, nowMs: NOW_MS } }
  }, {
    authorizedRepositories: [{
      repositoryId: CONSUMER_REPO_ID,
      repository: 'Synthetic/Spellbook',
      defaultBranch: 'trunk',
      revision: HEAD_SHA,
      projectConfig: trunkConfig
    }]
  });
  assert.equal(alignedTrunkRes.result.isError, false);
  assert.equal(alignedTrunkRes.result.structuredContent.defaultBranch, 'trunk');

  assert.equal(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'km-expired-pc',
    method: 'tools/call',
    params: {
      name: 'get_repo_knowledge_map',
      arguments: { repositoryId: CONSUMER_REPO_ID, revision: HEAD_SHA, nowMs: NOW_MS + 900_000 }
    }
  }, authorizedContext()).result.structuredContent.reason, 'STALE_KNOWLEDGE_MAP');

  assert.equal(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'km-unavail',
    method: 'tools/call',
    params: { name: 'get_repo_knowledge_map', arguments: { repositoryId: 10, revision: HEAD_SHA, nowMs: NOW_MS } }
  }, {
    authorizedRepositories: [{ repositoryId: 10, repository: 'Synthetic/One' }]
  }).result.structuredContent.reason, 'KNOWLEDGE_MAP_UNAVAILABLE');

  assert.equal(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'km-bad-lanes',
    method: 'tools/call',
    params: { name: 'get_repo_knowledge_map', arguments: { repositoryId: 10, revision: HEAD_SHA, nowMs: NOW_MS } }
  }, {
    authorizedRepositories: [{
      repositoryId: 10,
      repository: 'Synthetic/One',
      lanes: [
        { id: 'lane-a', specialist: 'api', owners: ['src'] },
        { id: 'lane-b', specialist: 'ui', owners: ['src/nested'] }
      ]
    }]
  }).result.structuredContent.reason, 'INVALID_LANE_OWNERSHIP');
});

test('tools/call evaluate_gate_status delegates read-only to core.mjs and protected-squash.mjs', () => {
  const { scope, policy, snapshot, intent, evidence } = buildProtectedSquashFixtures();
  const ctx = authorizedContext();

  const candidateOk = handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'gate-cand-ok',
    method: 'tools/call',
    params: {
      name: 'evaluate_gate_status',
      arguments: { mode: 'candidate', policy, snapshot }
    }
  }, ctx);
  assert.equal(candidateOk.result.isError, false);
  assert.deepEqual(candidateOk.result.structuredContent, {
    shadow: true,
    readOnly: true,
    evaluator: 'core.evaluate',
    mode: 'candidate',
    state: 'eligible',
    eligible: true,
    reason: 'SHADOW_ELIGIBLE',
    externalMergeAuthorityOnly: true,
    liveMerge: false,
    allowDirectMergeOrPolicyWrite: false
  });

  const candidateBlocked = handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'gate-cand-block',
    method: 'tools/call',
    params: {
      name: 'evaluate_gate_status',
      arguments: { mode: 'candidate', policy, snapshot: { ...snapshot, threadsResolved: false } }
    }
  });
  assert.equal(candidateBlocked.result.isError, false);
  assert.equal(candidateBlocked.result.structuredContent.eligible, false);
  assert.equal(candidateBlocked.result.structuredContent.reason, 'THREADS_OR_SECURITY_UNKNOWN');
  assert.equal(candidateBlocked.result.structuredContent.externalMergeAuthorityOnly, true);
  assert.equal(candidateBlocked.result.structuredContent.liveMerge, false);

  const squashOk = handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'gate-squash-ok',
    method: 'tools/call',
    params: {
      name: 'evaluate_gate_status',
      arguments: { mode: 'protected-squash', intent, evidence }
    }
  }, ctx);
  assert.equal(squashOk.result.isError, false);
  assert.equal(squashOk.result.structuredContent.eligible, true);
  assert.equal(squashOk.result.structuredContent.reason, 'SHADOW_SQUASH_ELIGIBLE');
  assert.equal(squashOk.result.structuredContent.externalMergeAuthorityOnly, true);
  assert.equal(squashOk.result.structuredContent.liveMerge, false);

  const squashBlocked = handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'gate-squash-block',
    method: 'tools/call',
    params: {
      name: 'evaluate_gate_status',
      arguments: { mode: 'protected-squash', intent, evidence: { ...evidence, draft: true }, scope }
    }
  }, ctx);
  assert.equal(squashBlocked.result.isError, false);
  assert.equal(squashBlocked.result.structuredContent.eligible, false);
  assert.equal(squashBlocked.result.structuredContent.reason, 'STOPPED_OR_UNAUTHORIZED');

  assert.equal(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'gate-unauth-cand',
    method: 'tools/call',
    params: {
      name: 'evaluate_gate_status',
      arguments: { mode: 'candidate', policy: { ...policy, repository: 'Unauthorized/Repo' }, snapshot }
    }
  }, ctx).result.structuredContent.reason, 'UNAUTHORIZED_REPOSITORY');

  assert.equal(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'gate-unauth-cand-type',
    method: 'tools/call',
    params: {
      name: 'evaluate_gate_status',
      arguments: { mode: 'candidate', policy: { ...policy, repository: 123 }, snapshot }
    }
  }, ctx).result.structuredContent.reason, 'UNAUTHORIZED_REPOSITORY');

  const spellbookReviewer = 'independent-human-reviewer';
  const spellbookPolicy97 = {
    ...policy,
    repository: 'Synthetic/Spellbook',
    reviewers: [spellbookReviewer],
    coverage: { line: 97, branch: 92 }
  };
  const spellbookSnapshot97 = {
    ...snapshot,
    repository: 'Synthetic/Spellbook',
    coverage: { head: HEAD_SHA, line: 97, branch: 92, complete: true },
    reviews: [{ reviewer: spellbookReviewer, head: HEAD_SHA, state: 'APPROVED' }]
  };
  const spellbookCandidateOk = handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'gate-spellbook-cand-ok',
    method: 'tools/call',
    params: {
      name: 'evaluate_gate_status',
      arguments: { mode: 'candidate', policy: spellbookPolicy97, snapshot: spellbookSnapshot97 }
    }
  }, ctx);
  assert.equal(spellbookCandidateOk.result.isError, false);
  assert.equal(spellbookCandidateOk.result.structuredContent.eligible, true);

  const spellbookWeakCand = handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'gate-spellbook-cand-weak',
    method: 'tools/call',
    params: {
      name: 'evaluate_gate_status',
      arguments: {
        mode: 'candidate',
        policy: { ...spellbookPolicy97, coverage: { line: 95, branch: 90 } },
        snapshot: {
          ...spellbookSnapshot97,
          coverage: { head: HEAD_SHA, line: 95, branch: 90, complete: true }
        }
      }
    }
  }, ctx);
  assert.equal(spellbookWeakCand.result.isError, true);
  assert.equal(spellbookWeakCand.result.structuredContent.eligible, false);
  assert.equal(spellbookWeakCand.result.structuredContent.reason, 'COVERAGE_FLOOR_VIOLATION');

  const spellbookScope = {
    repository: 'Synthetic/Spellbook',
    repositoryId: CONSUMER_REPO_ID,
    branch: 'main',
    requiredChecks: policy.checks.map(c => c.name)
  };
  const spellbookIntent = {
    repository: 'Synthetic/Spellbook',
    repositoryId: CONSUMER_REPO_ID,
    branch: 'main',
    number: 12,
    expectedHead: HEAD_SHA,
    expectedBase: BASE_SHA
  };
  const spellbookSquashSnapshot = { ...spellbookSnapshot97 };
  delete spellbookSquashSnapshot.reviews;
  delete spellbookSquashSnapshot.threadsResolved;
  delete spellbookSquashSnapshot.securityClear;
  delete spellbookSquashSnapshot.coverage;
  const spellbookEvidence97 = {
    ...evidence,
    repository: 'Synthetic/Spellbook',
    repositoryId: CONSUMER_REPO_ID,
    protection: {
      ...evidence.protection,
      repository: 'Synthetic/Spellbook',
      repositoryId: CONSUMER_REPO_ID
    },
    policy: spellbookPolicy97,
    snapshot: spellbookSquashSnapshot,
    reviewHistory: [{ sequence: 1, reviewer: spellbookReviewer, head: HEAD_SHA, state: 'APPROVED' }],
    coverageReports: [{ component: 'component', head: HEAD_SHA, lines: 97, lineTotal: 100, branches: 92, branchTotal: 100 }]
  };
  const spellbookSquashOk = handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'gate-spellbook-squash-ok',
    method: 'tools/call',
    params: {
      name: 'evaluate_gate_status',
      arguments: {
        mode: 'protected-squash',
        intent: spellbookIntent,
        evidence: spellbookEvidence97,
        scope: spellbookScope
      }
    }
  }, ctx);
  assert.equal(spellbookSquashOk.result.isError, false);
  assert.equal(spellbookSquashOk.result.structuredContent.eligible, true);

  const spellbookWeakSquash = handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'gate-spellbook-squash-weak',
    method: 'tools/call',
    params: {
      name: 'evaluate_gate_status',
      arguments: {
        mode: 'protected-squash',
        intent: spellbookIntent,
        evidence: {
          ...spellbookEvidence97,
          policy: { ...spellbookPolicy97, coverage: { line: 95, branch: 90 } },
          coverageReports: [{ component: 'component', head: HEAD_SHA, lines: 95, lineTotal: 100, branches: 90, branchTotal: 100 }]
        },
        scope: spellbookScope
      }
    }
  }, ctx);
  assert.equal(spellbookWeakSquash.result.isError, true);
  assert.equal(spellbookWeakSquash.result.structuredContent.eligible, false);
  assert.equal(spellbookWeakSquash.result.structuredContent.reason, 'COVERAGE_FLOOR_VIOLATION');

  assert.equal(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'gate-default-floor-violation',
    method: 'tools/call',
    params: {
      name: 'evaluate_gate_status',
      arguments: {
        mode: 'candidate',
        policy: { ...spellbookPolicy97, coverage: { line: 94, branch: 90 } },
        snapshot: spellbookSnapshot97
      }
    }
  }).result.structuredContent.reason, 'COVERAGE_FLOOR_VIOLATION');

  assert.equal(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'gate-squash-missing-policy',
    method: 'tools/call',
    params: {
      name: 'evaluate_gate_status',
      arguments: {
        mode: 'protected-squash',
        intent,
        evidence: { ...evidence, policy: null }
      }
    }
  }).result.structuredContent.reason, 'COVERAGE_FLOOR_VIOLATION');

  assert.equal(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'gate-unauth-squash',
    method: 'tools/call',
    params: {
      name: 'evaluate_gate_status',
      arguments: {
        mode: 'protected-squash',
        intent,
        evidence,
        scope: { repository: 'Unauthorized/Repo', repositoryId: 999, branch: 'main' }
      }
    }
  }, ctx).result.structuredContent.reason, 'UNAUTHORIZED_REPOSITORY');

  assert.equal(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'gate-bad-ctx',
    method: 'tools/call',
    params: { name: 'evaluate_gate_status', arguments: { mode: 'candidate', policy, snapshot } }
  }, { authorizedRepositories: [] }).result.structuredContent.reason, 'AUTHORIZATION_CONTEXT_INVALID');

  for (const badGateArgs of [
    { mode: 'live-merge' },
    { mode: 'candidate', policy: {} },
    { mode: 'protected-squash', intent: {} }
  ]) {
    const denied = handleMcpConnectorRequest({
      jsonrpc: '2.0',
      id: 'gate-bad',
      method: 'tools/call',
      params: { name: 'evaluate_gate_status', arguments: badGateArgs }
    });
    assert.equal(denied.result.isError, true);
    assert.equal(denied.result.structuredContent.reason, 'INVALID_GATE_EVALUATION_ARGUMENTS');
    assert.equal(denied.result.structuredContent.externalMergeAuthorityOnly, true);
    assert.equal(denied.result.structuredContent.liveMerge, false);
  }
});

test('tools/call get_bounded_work_item_context validates W3C traceparent, secrets, and control-plane paths', () => {
  assert.equal(isValidTraceparent(VALID_TRACEPARENT), true);
  for (const badTrace of [
    null,
    '01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`,
    `00-4bf92f3577b34da6a3ce929d0e0e4736-${'0'.repeat(16)}-01`,
    '00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01'
  ]) {
    assert.equal(isValidTraceparent(badTrace), false);
  }

  const ctx = authorizedContext();
  const validRes = handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'wi-1',
    method: 'tools/call',
    params: {
      name: 'get_bounded_work_item_context',
      arguments: {
        repositoryId: FACTORY_REPO_ID,
        issueNumber: 136,
        pullRequestNumber: 200,
        traceparent: VALID_TRACEPARENT,
        summary: 'Implement task-1 and risk-class MCP multi-agent connector',
        notes: ['Preserve deterministic disk-cache and external merge gates'],
        ownedPaths: [
          'src/features/connector-client.mjs',
          'tests/engineering-factory/mcp-agent-connector.test.mjs',
          'docs/MCP-MULTI-AGENT-CONNECTOR.md'
        ],
        additionalForbiddenPaths: ['apphost.cs']
      }
    }
  }, ctx);
  assert.equal(validRes.result.isError, false);
  const workItem = validRes.result.structuredContent;
  assert.equal(workItem.maxRepairIterations, 2);
  assert.equal(workItem.secretsStripped, false);
  assert.ok(workItem.forbiddenControlPlanePaths.includes('tools/engineering-factory/core.mjs'));
  assert.ok(workItem.forbiddenControlPlanePaths.includes('.github/softwarefactory-policy.json'));
  assert.ok(workItem.forbiddenControlPlanePaths.includes('tools/engineering-factory/review-history.mjs'));
  assert.ok(workItem.forbiddenControlPlanePaths.includes('tools/engineering-factory/review-batch.mjs'));
  assert.ok(workItem.forbiddenControlPlanePaths.includes('apphost.cs'));

  for (const secretSample of [
    'token ghp_abc123XYZ',
    'oauth gho_abc123XYZ',
    'user token ghu_abc123XYZ',
    'server token ghs_abc123XYZ',
    'refresh token ghr_abc123XYZ',
    'fine grained github_pat_11AABBCC',
    'openai key sk-proj-998877',
    'anthropic key sk-ant-api03-998877',
    'header Bearer eyJhbGciOiJIUzI1NiJ9',
    'header BEARER upperCaseBearerSecret',
    'header bEaReR mixedCaseBearerSecret'
  ]) {
    const rejected = handleMcpConnectorRequest({
      jsonrpc: '2.0',
      id: 'wi-sec-reject',
      method: 'tools/call',
      params: {
        name: 'get_bounded_work_item_context',
        arguments: {
          repositoryId: FACTORY_REPO_ID,
          issueNumber: 136,
          traceparent: VALID_TRACEPARENT,
          summary: `Context with ${secretSample}`,
          ownedPaths: ['docs/MCP-MULTI-AGENT-CONNECTOR.md']
        }
      }
    });
    assert.equal(rejected.result.isError, true);
    assert.equal(rejected.result.structuredContent.reason, 'SECRET_TOKEN_REJECTED');
    assert.equal(JSON.stringify(rejected).includes(secretSample.split(' ').at(-1)), false);
  }

  const strippedRes = handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'wi-sec-strip',
    method: 'tools/call',
    params: {
      name: 'get_bounded_work_item_context',
      arguments: {
        repositoryId: FACTORY_REPO_ID,
        issueNumber: 136,
        traceparent: VALID_TRACEPARENT,
        summary: 'Summary with BEARER topSecretHeader and gho_oauthSecret1 and GHP_NON_PREFIX',
        notes: [
          'Auth header bEaReR secretJwtValue and ghu_userSecret2 and ghr_refreshSecret3 and key sk-ant-999',
          'No secret in second note'
        ],
        ownedPaths: ['docs/MCP-MULTI-AGENT-CONNECTOR.md'],
        maxRepairIterations: 3,
        secretHandling: 'strip'
      }
    }
  });
  assert.equal(strippedRes.result.isError, false);
  assert.equal(strippedRes.result.structuredContent.secretsStripped, true);
  assert.equal(strippedRes.result.structuredContent.summary, 'Summary with [REDACTED] and [REDACTED] and GHP_NON_PREFIX');
  assert.equal(
    strippedRes.result.structuredContent.notes[0],
    'Auth header [REDACTED] and [REDACTED] and [REDACTED] and key [REDACTED]'
  );
  for (const leaked of ['secretJwtValue', 'topSecretHeader', 'oauthSecret1', 'userSecret2', 'refreshSecret3']) {
    assert.equal(JSON.stringify(strippedRes).includes(leaked), false);
  }

  for (const forbiddenOwned of [
    ['.github/workflows/ci.yml'],
    ['.github/agentic.lock.yml'],
    ['.github/softwarefactory-policy.json'],
    ['tools/engineering-factory/core.mjs'],
    ['tools/engineering-factory/review-history.mjs'],
    ['tools/engineering-factory/review-batch.mjs'],
    ['tools/engineering-factory/budget.mjs'],
    ['tools/engineering-factory/mcp-agent-connector.mjs'],
    ['tools/engineering-factory']
  ]) {
    assert.equal(handleMcpConnectorRequest({
      jsonrpc: '2.0',
      id: 'wi-forbid',
      method: 'tools/call',
      params: {
        name: 'get_bounded_work_item_context',
        arguments: {
          repositoryId: FACTORY_REPO_ID,
          issueNumber: 136,
          traceparent: VALID_TRACEPARENT,
          summary: 'Attempt protected edit',
          ownedPaths: forbiddenOwned
        }
      }
    }).result.structuredContent.reason, 'FORBIDDEN_CONTROL_PLANE_PATH');
  }

  assert.equal(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'wi-bad-trace',
    method: 'tools/call',
    params: {
      name: 'get_bounded_work_item_context',
      arguments: {
        repositoryId: FACTORY_REPO_ID,
        issueNumber: 136,
        traceparent: 'bad',
        summary: 'Valid summary',
        ownedPaths: ['docs/MCP-MULTI-AGENT-CONNECTOR.md']
      }
    }
  }).result.structuredContent.reason, 'INVALID_TRACEPARENT');

  assert.equal(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'wi-bad-iter',
    method: 'tools/call',
    params: {
      name: 'get_bounded_work_item_context',
      arguments: {
        repositoryId: FACTORY_REPO_ID,
        issueNumber: 136,
        traceparent: VALID_TRACEPARENT,
        summary: 'Valid summary',
        ownedPaths: ['docs/MCP-MULTI-AGENT-CONNECTOR.md'],
        maxRepairIterations: 6
      }
    }
  }).result.structuredContent.reason, 'INVALID_MAX_REPAIR_ITERATIONS');

  for (const invalidArgs of [
    {
      repositoryId: FACTORY_REPO_ID,
      issueNumber: 136,
      traceparent: VALID_TRACEPARENT,
      summary: 'Valid summary',
      ownedPaths: ['../escape.mjs']
    },
    {
      repositoryId: FACTORY_REPO_ID,
      issueNumber: 136,
      traceparent: VALID_TRACEPARENT,
      summary: 'Valid summary',
      ownedPaths: ['docs/MCP-MULTI-AGENT-CONNECTOR.md'],
      secretHandling: 'allow'
    },
    {
      repositoryId: FACTORY_REPO_ID,
      issueNumber: 136,
      traceparent: VALID_TRACEPARENT,
      summary: 'Valid summary',
      ownedPaths: ['docs/MCP-MULTI-AGENT-CONNECTOR.md'],
      notes: ['']
    },
    {
      repositoryId: FACTORY_REPO_ID,
      issueNumber: 136,
      traceparent: VALID_TRACEPARENT,
      summary: 'Valid summary',
      ownedPaths: ['docs/MCP-MULTI-AGENT-CONNECTOR.md'],
      additionalForbiddenPaths: ['/abs/path']
    }
  ]) {
    assert.equal(handleMcpConnectorRequest({
      jsonrpc: '2.0',
      id: 'wi-invalid',
      method: 'tools/call',
      params: { name: 'get_bounded_work_item_context', arguments: invalidArgs }
    }).result.structuredContent.reason, 'INVALID_WORK_ITEM_ARGUMENTS');
  }

  assert.equal(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'wi-unauth',
    method: 'tools/call',
    params: {
      name: 'get_bounded_work_item_context',
      arguments: {
        repositoryId: 999999,
        issueNumber: 136,
        traceparent: VALID_TRACEPARENT,
        summary: 'Valid summary',
        ownedPaths: ['docs/MCP-MULTI-AGENT-CONNECTOR.md']
      }
    }
  }, ctx).result.structuredContent.reason, 'UNAUTHORIZED_REPOSITORY');

  assert.equal(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'wi-bad-auth-ctx',
    method: 'tools/call',
    params: {
      name: 'get_bounded_work_item_context',
      arguments: {
        repositoryId: FACTORY_REPO_ID,
        issueNumber: 136,
        traceparent: VALID_TRACEPARENT,
        summary: 'Valid summary',
        ownedPaths: ['docs/MCP-MULTI-AGENT-CONNECTOR.md']
      }
    }
  }, { authorizedRepositories: [] }).result.structuredContent.reason, 'AUTHORIZATION_CONTEXT_INVALID');
});

test('tools/call validate_provider_isolation validates IChatClient, Codex, and Claude adapters via MCP', () => {
  const ichatOk = handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'iso-ichat',
    method: 'tools/call',
    params: {
      name: 'validate_provider_isolation',
      arguments: copilotConfig({ adapter: 'microsoft-extensions-ai-ichatclient' })
    }
  });
  assert.equal(ichatOk.result.isError, false);
  assert.equal(ichatOk.result.structuredContent.valid, true);

  const codexFail = handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'iso-codex-fail',
    method: 'tools/call',
    params: {
      name: 'validate_provider_isolation',
      arguments: codexConfig({ adapter: 'openai-agents-sdk', env: { OPENAI_AGENTS_DISABLE_TRACING: '0' } })
    }
  });
  assert.equal(codexFail.result.isError, true);
  assert.equal(codexFail.result.structuredContent.reason, 'EXTERNAL_TRACING_NOT_DISABLED');

  const claudeFail = handleMcpConnectorRequest({
    jsonrpc: '2.0',
    id: 'iso-claude-fail',
    method: 'tools/call',
    params: {
      name: 'validate_provider_isolation',
      arguments: claudeConfig({ adapter: 'claude-agent-sdk', preToolUseOnFailure: 'ignore' })
    }
  });
  assert.equal(claudeFail.result.isError, true);
  assert.equal(claudeFail.result.structuredContent.reason, 'PRE_TOOL_HOOK_NOT_FAIL_CLOSED');
});
