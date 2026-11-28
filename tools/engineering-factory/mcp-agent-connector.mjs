// Read-only, deterministic MCP server and multi-agent isolation connector (#136).
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { planLanes } from '../engineering-coordinator/planner.mjs';
import { buildReadOnlyOnboardingPlan, evaluateConsumerOnboardingSuccess } from './consumer-onboarding.mjs';
import { selectScopedGuidanceAndLessons } from './curated-lessons.mjs';
import { fetchFactoryBoardSnapshot } from './factory-board.mjs';
import {
  SPECIALIST_ROLES,
  validateKnowledgeMap,
  validateProjectConfig
} from '../engineering-coordinator/project-config.mjs';
import {
  defaultSoftwareFactoryTestInventory,
  softwareFactoryCatalog
} from './contract-routing.mjs';
import { evaluate as evaluateCandidate } from './core.mjs';
import {
  DEFAULT_FACTORY_SCOPE,
  guardedSquashEvidence as evaluateProtectedSquash
} from './protected-squash.mjs';

export const CONNECTOR_PROTOCOL_VERSION = '1.0.0';
export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_SERVER_NAME = 'softwarefactory-mcp-connector';
export const MAX_MCP_REQUEST_BYTES = 65_536;
export const MAX_MCP_FRAMED_LINES = 100;

export const CROSS_MODEL_MODES = Object.freeze([
  'independent-review',
  'specialist-fallback'
]);

export const SUPPORTED_PROVIDER_FAMILIES = Object.freeze([
  'github-copilot',
  'openai-codex',
  'anthropic-claude'
]);

export const PROVIDER_ADAPTERS = Object.freeze({
  'github-copilot': Object.freeze([
    'copilot-cloud-agent',
    'microsoft-agents-ai-ichatclient',
    'microsoft-extensions-ai-ichatclient'
  ]),
  'openai-codex': Object.freeze([
    'openai-codex-action',
    'openai-agents-sdk',
    'microsoft-extensions-ai-ichatclient'
  ]),
  'anthropic-claude': Object.freeze([
    'claude-code-action',
    'claude-agent-sdk',
    'microsoft-extensions-ai-ichatclient'
  ])
});

export const CONNECTOR_ROLES = Object.freeze([
  'worker',
  'independent-reviewer',
  'specialist'
]);

export const FORBIDDEN_CONTROL_PLANE_PATHS = Object.freeze([
  '.github/workflows',
  '.github/rulesets',
  '.github/softwarefactory-policy.json',
  'config/policy',
  'tools/engineering-factory/core.mjs',
  'tools/engineering-factory/protected-squash.mjs',
  'tools/engineering-factory/coverage-evidence.mjs',
  'tools/engineering-factory/platform-merge-gates.mjs',
  'tools/engineering-factory/review-history.mjs',
  'tools/engineering-factory/review-batch.mjs',
  'tools/engineering-factory/budget.mjs',
  'tools/engineering-factory/mcp-agent-connector.mjs'
]);

const MCP_CONNECTOR_TEST_SUITE = 'tests/engineering-factory/mcp-agent-connector.test.mjs';

const READ_ONLY_TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false
});

const freezeDeep = value => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
};

export const MCP_CONNECTOR_TOOLS = Object.freeze([
  Object.freeze({
    name: 'get_repo_knowledge_map',
    description: 'Return authorized read-only repository lane ownership, coverage floors, and gate invariants.',
    inputSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze(['repositoryId']),
      properties: Object.freeze({
        repositoryId: Object.freeze({ type: 'integer', minimum: 1 }),
        repository: Object.freeze({ type: 'string', minLength: 3, maxLength: 160 }),
        revision: Object.freeze({ type: 'string', pattern: '^[0-9a-f]{40}$' }),
        nowMs: Object.freeze({ type: 'integer', minimum: 0 }),
        testInventory: Object.freeze({
          type: 'array',
          maxItems: 120,
          items: Object.freeze({ type: 'string', minLength: 1, maxLength: 240 })
        })
      })
    }),
    annotations: READ_ONLY_TOOL_ANNOTATIONS
  }),
  Object.freeze({
    name: 'evaluate_gate_status',
    description: 'Evaluate candidate or protected-squash eligibility in pure read-only external-gate mode.',
    inputSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze(['mode']),
      properties: Object.freeze({
        mode: Object.freeze({ type: 'string', enum: Object.freeze(['candidate', 'protected-squash']) }),
        policy: Object.freeze({ type: 'object' }),
        snapshot: Object.freeze({ type: 'object' }),
        intent: Object.freeze({ type: 'object' }),
        evidence: Object.freeze({ type: 'object' }),
        scope: Object.freeze({ type: 'object' })
      })
    }),
    annotations: READ_ONLY_TOOL_ANNOTATIONS
  }),
  Object.freeze({
    name: 'get_bounded_work_item_context',
    description: 'Validate W3C traceparent, enforce secret redaction/rejection, and return bounded lane scope.',
    inputSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze(['repositoryId', 'issueNumber', 'traceparent', 'summary', 'ownedPaths']),
      properties: Object.freeze({
        repositoryId: Object.freeze({ type: 'integer', minimum: 1 }),
        issueNumber: Object.freeze({ type: 'integer', minimum: 1 }),
        pullRequestNumber: Object.freeze({ type: 'integer', minimum: 1 }),
        traceparent: Object.freeze({
          type: 'string',
          pattern: '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$'
        }),
        summary: Object.freeze({ type: 'string', minLength: 1, maxLength: 2000 }),
        notes: Object.freeze({
          type: 'array',
          maxItems: 20,
          items: Object.freeze({ type: 'string', minLength: 1, maxLength: 500 })
        }),
        ownedPaths: Object.freeze({
          type: 'array',
          minItems: 1,
          maxItems: 32,
          items: Object.freeze({ type: 'string', minLength: 1, maxLength: 240 })
        }),
        additionalForbiddenPaths: Object.freeze({
          type: 'array',
          maxItems: 32,
          items: Object.freeze({ type: 'string', minLength: 1, maxLength: 240 })
        }),
        maxRepairIterations: Object.freeze({ type: 'integer', minimum: 1, maximum: 5 }),
        secretHandling: Object.freeze({ type: 'string', enum: Object.freeze(['reject', 'strip']) })
      })
    }),
    annotations: READ_ONLY_TOOL_ANNOTATIONS
  }),
  Object.freeze({
    name: 'validate_provider_isolation',
    description: 'Validate multi-agent provider isolation, zero external tracing, and zero unapproved spend.',
    inputSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze([
        'providerFamily',
        'adapter',
        'externalMergeAuthorityOnly',
        'allowDirectMergeOrPolicyWrite',
        'unapprovedSpendUsdCents'
      ]),
      properties: Object.freeze({
        providerFamily: Object.freeze({ type: 'string', enum: SUPPORTED_PROVIDER_FAMILIES }),
        adapter: Object.freeze({ type: 'string', minLength: 1, maxLength: 80 }),
        role: Object.freeze({ type: 'string', enum: CONNECTOR_ROLES }),
        externalMergeAuthorityOnly: Object.freeze({ type: 'boolean', const: true }),
        allowDirectMergeOrPolicyWrite: Object.freeze({ type: 'boolean', const: false }),
        unapprovedSpendUsdCents: Object.freeze({ type: 'integer', const: 0 }),
        includedQuotaVerified: Object.freeze({ type: 'boolean' }),
        oauthEntitlementVerified: Object.freeze({ type: 'boolean' }),
        overageHardStopUsdCents: Object.freeze({ type: 'integer' }),
        ownerAuthorized: Object.freeze({ type: 'boolean' }),
        authorizedSpendCapUsdCents: Object.freeze({ type: 'integer', minimum: 1 }),
        observedSpendUsdCents: Object.freeze({ type: 'integer', minimum: 0 }),
        externalTelemetryDisabled: Object.freeze({ type: 'boolean' }),
        trustedBaseConfigRestored: Object.freeze({ type: 'boolean' }),
        preToolUseOnFailure: Object.freeze({ type: 'string' }),
        env: Object.freeze({ type: 'object' }),
        headSha: Object.freeze({ type: 'string', pattern: '^[0-9a-f]{40}$' }),
        sessionCheckpoint: Object.freeze({
          type: 'object',
          required: Object.freeze(['sessionId', 'sha256', 'headSha', 'serializedState'])
        })
      })
    }),
    annotations: READ_ONLY_TOOL_ANNOTATIONS
  }),
  ...[
    ['plan_disjoint_lanes', 'Plan disjoint authorized lanes without dispatching.', ['repositoryId', 'tasks'], {
      repositoryId: { type: 'integer', minimum: 1 }, tasks: { type: 'array', maxItems: 250, items: { type: 'object' } },
      active: { type: 'array', maxItems: 32, items: { type: 'object' } }, policy: { type: 'object' }
    }],
    ['build_consumer_onboarding_plan', 'Build a read-only consumer onboarding plan and optional success evaluation.', ['repositoryId', 'discovery'], {
      repositoryId: { type: 'integer', minimum: 1 }, discovery: { type: 'object' }, success: { type: 'object' }
    }],
    ['select_scoped_guidance_and_lessons', 'Select authorized, scoped guidance and lessons.', [
      'repositoryId', 'repositorySlug', 'expectedHeadSha', 'nowMs', 'targetComponent',
      'specialistRole', 'changedPaths', 'guidanceEntries', 'curatedLessons'
    ], {
      repositoryId: { type: 'integer', minimum: 1 }, repositorySlug: { type: 'string' },
      expectedHeadSha: { type: 'string' }, nowMs: { type: 'integer', minimum: 0 },
      targetComponent: { type: 'string' }, specialistRole: { type: 'string' },
      changedPaths: { type: 'array', maxItems: 200, items: { type: 'string' } },
      guidanceEntries: { type: 'array', maxItems: 100, items: { type: 'object' } },
      curatedLessons: { type: 'array', maxItems: 200, items: { type: 'object' } }, issueNumber: { type: 'integer', minimum: 1 },
      policy: { type: 'object' }, checkpointEvidence: { type: 'object' }, externalKnowledgeStoreRequired: { type: 'boolean' }
    }],
    ['get_factory_board_snapshot', 'Read an authorized board using an injected read-only transport.', ['repositoryId'], {
      repositoryId: { type: 'integer', minimum: 1 }, repository: { type: 'string', maxLength: 160 }
    }]
  ].map(([name, description, required, properties]) => freezeDeep({
    name, description,
    inputSchema: { type: 'object', additionalProperties: false, required, properties },
    annotations: READ_ONLY_TOOL_ANNOTATIONS
  }))
]);

const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const COMPACT_SECRET_KEY_PATTERN = new RegExp(
  '(?:authorization|authheader|password|passwd|passphrase|secret|credentials?|' +
  '(?:api|private|access|secret|signing|encryption|client|service)key|' +
  'token)$'
);
const ALLOWED_CONFIG_KEYS = new Set([
  'providerFamily',
  'adapter',
  'role',
  'externalMergeAuthorityOnly',
  'allowDirectMergeOrPolicyWrite',
  'unapprovedSpendUsdCents',
  'includedQuotaVerified',
  'oauthEntitlementVerified',
  'overageHardStopUsdCents',
  'ownerAuthorized',
  'authorizedSpendCapUsdCents',
  'observedSpendUsdCents',
  'externalTelemetryDisabled',
  'trustedBaseConfigRestored',
  'preToolUseOnFailure',
  'env',
  'headSha',
  'sessionCheckpoint'
]);
const ALLOWED_CROSS_MODEL_KEYS = new Set([
  'mode',
  'authorProvider',
  'authorModelFamily',
  'authorIdentity',
  'authorConfig',
  'reviewerProvider',
  'reviewerModelFamily',
  'reviewerIdentity',
  'reviewerConfig',
  'headSha',
  'externalMergeGateAuthoritative',
  'rollbackToCopilotOnly',
  'rollbackReason',
  'verifiedCopilotBudget',
  'killSwitch',
  'stop'
]);
const SOLE_MERGE_EVALUATORS = Object.freeze([
  'tools/engineering-factory/core.mjs',
  'tools/engineering-factory/protected-squash.mjs'
]);
const ENVELOPE_KEYS = new Set(['jsonrpc', 'method', 'id', 'params']);
const ALLOWED_CONTEXT_KEYS = new Set(['authorizedRepositories', 'killSwitch', 'stop', 'nowMs']);
const ZERO_TRACE_ID = '0'.repeat(32);
const ZERO_PARENT_ID = '0'.repeat(16);
const SECRET_TOKEN_PATTERN =
  /(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9_]*|github_pat_[A-Za-z0-9_]*|sk-ant-[A-Za-z0-9_-]*|sk-[A-Za-z0-9_-]*|[Bb][Ee][Aa][Rr][Ee][Rr][ \t]+\S*)/g;

const ownData = (obj, key) => {
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  return Boolean(desc && desc.enumerable && Object.hasOwn(desc, 'value'));
};

const isPlainObject = value => {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) {
    return false;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  return keys.length <= 128 && keys.every(key =>
    typeof key === 'string' && !FORBIDDEN_OBJECT_KEYS.has(key) && ownData(value, key));
};

const isDenseArray = (value, max = 128) => {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return false;
  }
  const len = value.length;
  if (len > max || Reflect.ownKeys(value).length !== len + 1) {
    return false;
  }
  for (let i = 0; i < len; i++) {
    if (!ownData(value, String(i))) {
      return false;
    }
  }
  return true;
};

const isDeepPlainValue = (value, budget = { remaining: 5000 }, depth = 0) => {
  if (--budget.remaining < 0 || depth > 12) {
    return false;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value !== 'object' || types.isProxy(value)) {
    return false;
  }
  if (Array.isArray(value)) {
    return isDenseArray(value, 256) && value.every(item => isDeepPlainValue(item, budget, depth + 1));
  }
  return isPlainObject(value) && Object.keys(value).every(key => isDeepPlainValue(value[key], budget, depth + 1));
};

const hasAllowedKeys = (value, required, optional = []) => {
  if (!isPlainObject(value)) {
    return false;
  }
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every(key => Object.hasOwn(value, key) && value[key] !== undefined) &&
    keys.every(key => allowed.has(key));
};

const isPositiveInt = value => Number.isSafeInteger(value) && value > 0;
const isNonNegativeInt = value => Number.isSafeInteger(value) && value >= 0;
const isSha40 = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const isSha256 = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const isSlug = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const isModelFamily = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value);
const isActorIdentity = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,127}$/.test(value);
const isSessionId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const isSafeText = (value, max) => typeof value === 'string' && value.trim().length > 0 &&
  value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const isRepoName = value => typeof value === 'string' && value.length <= 160 &&
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) &&
  !value.split('/').some(part => part === '.' || part === '..');
const isBranchName = value => typeof value === 'string' && value.length > 0 && value.length <= 120 &&
  /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
  !value.includes('..') && !value.includes('//') && !value.endsWith('/');
const isRepoPath = value => typeof value === 'string' && value.length > 0 && value.length <= 240 &&
  !value.startsWith('/') && !value.endsWith('/') && !value.includes('\\') && !value.includes(':') &&
  /^[A-Za-z0-9._/-]+$/.test(value) &&
  !value.split('/').some(part => !part || part === '.' || part === '..');
const pathsOverlap = (left, right) =>
  left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
const arePathsDisjoint = paths => paths.every((entry, idx) =>
  paths.slice(idx + 1).every(other => !pathsOverlap(entry, other)));
const isUnique = values => new Set(values).size === values.length;

export function isValidTraceparent(value) {
  if (typeof value !== 'string' || !/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(value)) {
    return false;
  }
  const [, traceId, parentId] = value.split('-');
  return traceId !== ZERO_TRACE_ID && parentId !== ZERO_PARENT_ID;
}

const containsSecretToken = text => {
  SECRET_TOKEN_PATTERN.lastIndex = 0;
  return SECRET_TOKEN_PATTERN.test(text);
};

const stripSecretTokens = text => {
  SECRET_TOKEN_PATTERN.lastIndex = 0;
  let stripped = false;
  const sanitized = text.replace(SECRET_TOKEN_PATTERN, () => {
    stripped = true;
    return '[REDACTED]';
  });
  return { sanitized, stripped };
};

const isForbiddenSecretKeyName = key => {
  if (key === 'progressToken') {
    return false;
  }
  const compact = key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  return COMPACT_SECRET_KEY_PATTERN.test(compact);
};

function inspectBoundedPlainTree(value, budget = { remaining: 5000 }, depth = 0) {
  if (--budget.remaining < 0 || depth > 12) {
    return { valid: false, hasSecret: false };
  }
  if (value === undefined || value === null || typeof value === 'boolean') {
    return { valid: true, hasSecret: false };
  }
  if (typeof value === 'string') {
    return {
      valid: true,
      hasSecret: value.length <= MAX_MCP_REQUEST_BYTES && containsSecretToken(value)
    };
  }
  if (typeof value === 'number') {
    return { valid: Number.isFinite(value), hasSecret: false };
  }
  if (typeof value !== 'object' || types.isProxy(value)) {
    return { valid: false, hasSecret: false };
  }
  let hasSecret = false;
  if (Array.isArray(value)) {
    if (!isDenseArray(value, 256)) {
      return { valid: false, hasSecret: false };
    }
    for (let i = 0; i < value.length; i++) {
      const child = inspectBoundedPlainTree(value[i], budget, depth + 1);
      if (!child.valid) {
        return { valid: false, hasSecret: false };
      }
      if (child.hasSecret) {
        hasSecret = true;
      }
    }
    return { valid: true, hasSecret };
  }
  if (!isPlainObject(value)) {
    return { valid: false, hasSecret: false };
  }
  for (const key of Object.keys(value)) {
    if (isForbiddenSecretKeyName(key)) {
      hasSecret = true;
    }
    const child = inspectBoundedPlainTree(value[key], budget, depth + 1);
    if (!child.valid) {
      return { valid: false, hasSecret: false };
    }
    if (child.hasSecret) {
      hasSecret = true;
    }
  }
  return { valid: true, hasSecret };
}

const isValidConnectorContext = context =>
  isPlainObject(context) &&
  Object.keys(context).every(key => ALLOWED_CONTEXT_KEYS.has(key)) &&
  (context.killSwitch === undefined || typeof context.killSwitch === 'boolean') &&
  (context.stop === undefined || typeof context.stop === 'boolean') &&
  (context.nowMs === undefined || isNonNegativeInt(context.nowMs)) &&
  isDeepPlainValue(context);

const isValidMcpMeta = meta => {
  if (meta === undefined) {
    return true;
  }
  if (!isPlainObject(meta) || Object.keys(meta).length > 32) {
    return false;
  }
  const tree = inspectBoundedPlainTree(meta);
  if (!tree.valid || tree.hasSecret) {
    return false;
  }
  if (meta.progressToken !== undefined &&
      !Number.isSafeInteger(meta.progressToken) &&
      !(typeof meta.progressToken === 'string' &&
        meta.progressToken.length > 0 &&
        meta.progressToken.length <= 128 &&
        !/[\u0000-\u001f\u007f]/.test(meta.progressToken))) {
    return false;
  }
  return true;
};

const configDenied = reason => Object.freeze({
  shadow: true,
  valid: false,
  liveDispatch: false,
  liveMerge: false,
  externalMergeAuthorityOnly: true,
  allowDirectMergeOrPolicyWrite: false,
  reason
});

function validateConnectorEnv(env) {
  if (!isPlainObject(env)) {
    return 'INVALID_CONNECTOR_ENV';
  }
  for (const key of Object.keys(env)) {
    const val = env[key];
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || typeof val !== 'string' ||
        val.length > 256 || /[\u0000-\u001f\u007f]/.test(val)) {
      return 'INVALID_CONNECTOR_ENV';
    }
  }
  return null;
}

function validateSessionCheckpoint(checkpoint, expectedHeadSha) {
  if (!hasAllowedKeys(checkpoint, ['sessionId', 'sha256', 'headSha'], ['serializedState']) ||
      !isSessionId(checkpoint.sessionId) || !isSha256(checkpoint.sha256) || !isSha40(checkpoint.headSha)) {
    return 'INVALID_SESSION_CHECKPOINT';
  }
  if (expectedHeadSha === undefined || checkpoint.headSha !== expectedHeadSha) {
    return 'SESSION_CHECKPOINT_HEAD_MISMATCH';
  }
  if (checkpoint.serializedState === undefined) {
    return 'CHECKPOINT_STATE_MISSING';
  }
  if (typeof checkpoint.serializedState !== 'string' ||
      Buffer.byteLength(checkpoint.serializedState, 'utf8') > MAX_MCP_REQUEST_BYTES) {
    return 'INVALID_SESSION_CHECKPOINT';
  }
  const computedDigest = createHash('sha256').update(checkpoint.serializedState, 'utf8').digest('hex');
  if (computedDigest !== checkpoint.sha256) {
    return 'SESSION_CHECKPOINT_DIGEST_MISMATCH';
  }
  return null;
}

function validateExternalProviderBudget(config) {
  const hasCapFields = config.authorizedSpendCapUsdCents !== undefined ||
    config.observedSpendUsdCents !== undefined;
  if (hasCapFields) {
    if (!isPositiveInt(config.authorizedSpendCapUsdCents) ||
        !isNonNegativeInt(config.observedSpendUsdCents) ||
        (config.includedQuotaVerified !== undefined && typeof config.includedQuotaVerified !== 'boolean')) {
      return 'INVALID_AUTHORIZED_SPEND_CAP';
    }
    if (config.observedSpendUsdCents >= config.authorizedSpendCapUsdCents) {
      return 'AUTHORIZED_SPEND_CAP_EXHAUSTED';
    }
    return null;
  }
  if (config.includedQuotaVerified !== undefined && config.includedQuotaVerified !== true) {
    return 'INCLUDED_QUOTA_UNVERIFIED';
  }
  if (config.oauthEntitlementVerified === false) {
    return 'OAUTH_ENTITLEMENT_UNVERIFIED';
  }
  if (config.includedQuotaVerified !== true && config.oauthEntitlementVerified !== true) {
    return 'INCLUDED_QUOTA_UNVERIFIED';
  }
  return null;
}

export function validateMultiAgentConnectorConfig(config) {
  if (!isPlainObject(config)) {
    return configDenied('INVALID_CONNECTOR_CONFIG');
  }
  const tree = inspectBoundedPlainTree(config);
  if (!tree.valid) {
    return configDenied('INVALID_CONNECTOR_CONFIG');
  }
  if (tree.hasSecret) {
    return configDenied('SECRET_MATERIAL_REJECTED');
  }
  if (Object.keys(config).some(key => !ALLOWED_CONFIG_KEYS.has(key))) {
    return configDenied('INVALID_CONNECTOR_CONFIG');
  }
  if (!SUPPORTED_PROVIDER_FAMILIES.includes(config.providerFamily)) {
    return configDenied('UNSUPPORTED_PROVIDER_FAMILY');
  }
  if (!PROVIDER_ADAPTERS[config.providerFamily].includes(config.adapter)) {
    return configDenied('UNSUPPORTED_PROVIDER_ADAPTER');
  }
  if (config.externalMergeAuthorityOnly !== true) {
    return configDenied('EXTERNAL_MERGE_AUTHORITY_REQUIRED');
  }
  if (config.allowDirectMergeOrPolicyWrite !== false) {
    return configDenied('DIRECT_MERGE_OR_POLICY_WRITE_FORBIDDEN');
  }
  if (config.unapprovedSpendUsdCents !== 0) {
    return configDenied('UNAPPROVED_SPEND_FORBIDDEN');
  }
  if (config.oauthEntitlementVerified !== undefined && typeof config.oauthEntitlementVerified !== 'boolean') {
    return configDenied('INVALID_OAUTH_ENTITLEMENT');
  }
  const role = config.role === undefined ? 'worker' : config.role;
  if (!CONNECTOR_ROLES.includes(role)) {
    return configDenied('INVALID_CONNECTOR_ROLE');
  }
  if (config.headSha !== undefined && !isSha40(config.headSha)) {
    return configDenied('INVALID_CONNECTOR_CONFIG');
  }

  let sessionCheckpointVerified = false;
  if (config.providerFamily === 'github-copilot') {
    if (config.env !== undefined) {
      const envError = validateConnectorEnv(config.env);
      if (envError !== null) {
        return configDenied(envError);
      }
    }
    if (config.ownerAuthorized !== undefined && config.ownerAuthorized !== true) {
      return configDenied('OWNER_AUTHORIZATION_REQUIRED');
    }
    if (config.trustedBaseConfigRestored !== undefined && config.trustedBaseConfigRestored !== true) {
      return configDenied('UNTRUSTED_PROVIDER_CONFIG');
    }
    if (config.includedQuotaVerified !== true) {
      return configDenied('INCLUDED_QUOTA_UNVERIFIED');
    }
    if (config.oauthEntitlementVerified === false) {
      return configDenied('OAUTH_ENTITLEMENT_UNVERIFIED');
    }
    if (config.overageHardStopUsdCents !== 0) {
      return configDenied('OVERAGE_HARD_STOP_REQUIRED');
    }
    if (config.externalTelemetryDisabled !== undefined && config.externalTelemetryDisabled !== true) {
      return configDenied('EXTERNAL_TELEMETRY_NOT_DISABLED');
    }
    if (config.sessionCheckpoint !== undefined ||
        config.authorizedSpendCapUsdCents !== undefined ||
        config.observedSpendUsdCents !== undefined ||
        config.preToolUseOnFailure !== undefined) {
      return configDenied('INVALID_CONNECTOR_CONFIG');
    }
  } else if (config.providerFamily === 'openai-codex') {
    if (config.ownerAuthorized !== true) {
      return configDenied('OWNER_AUTHORIZATION_REQUIRED');
    }
    if (!isPlainObject(config.env) || config.env.OPENAI_AGENTS_DISABLE_TRACING !== '1') {
      return configDenied('EXTERNAL_TRACING_NOT_DISABLED');
    }
    const envError = validateConnectorEnv(config.env);
    if (envError !== null) {
      return configDenied(envError);
    }
    if (config.externalTelemetryDisabled !== true) {
      return configDenied('EXTERNAL_TELEMETRY_NOT_DISABLED');
    }
    if (config.trustedBaseConfigRestored !== true) {
      return configDenied('UNTRUSTED_PROVIDER_CONFIG');
    }
    if (config.overageHardStopUsdCents !== undefined && config.overageHardStopUsdCents !== 0) {
      return configDenied('OVERAGE_HARD_STOP_REQUIRED');
    }
    const budgetError = validateExternalProviderBudget(config);
    if (budgetError !== null) {
      return configDenied(budgetError);
    }
    if (config.sessionCheckpoint !== undefined || config.preToolUseOnFailure !== undefined) {
      return configDenied('INVALID_CONNECTOR_CONFIG');
    }
  } else {
    if (config.ownerAuthorized !== true) {
      return configDenied('OWNER_AUTHORIZATION_REQUIRED');
    }
    if (config.preToolUseOnFailure !== 'block') {
      return configDenied('PRE_TOOL_HOOK_NOT_FAIL_CLOSED');
    }
    if (config.env !== undefined) {
      const envError = validateConnectorEnv(config.env);
      if (envError !== null) {
        return configDenied(envError);
      }
    }
    if (config.externalTelemetryDisabled !== true) {
      return configDenied('EXTERNAL_TELEMETRY_NOT_DISABLED');
    }
    if (config.trustedBaseConfigRestored !== true) {
      return configDenied('UNTRUSTED_PROVIDER_CONFIG');
    }
    if (config.overageHardStopUsdCents !== undefined && config.overageHardStopUsdCents !== 0) {
      return configDenied('OVERAGE_HARD_STOP_REQUIRED');
    }
    const budgetError = validateExternalProviderBudget(config);
    if (budgetError !== null) {
      return configDenied(budgetError);
    }
    if (config.sessionCheckpoint !== undefined) {
      const checkpointError = validateSessionCheckpoint(config.sessionCheckpoint, config.headSha);
      if (checkpointError !== null) {
        return configDenied(checkpointError);
      }
      sessionCheckpointVerified = true;
    }
  }

  return Object.freeze({
    shadow: true,
    valid: true,
    liveDispatch: false,
    liveMerge: false,
    reason: 'PROVIDER_ISOLATION_VERIFIED',
    protocolVersion: CONNECTOR_PROTOCOL_VERSION,
    providerFamily: config.providerFamily,
    adapter: config.adapter,
    role,
    oauthEntitlementVerified: config.oauthEntitlementVerified === true,
    externalMergeAuthorityOnly: true,
    allowDirectMergeOrPolicyWrite: false,
    unapprovedSpendUsdCents: 0,
    telemetryExportAllowed: false,
    sessionCheckpointVerified
  });
}

function isVerifiedCopilotBudgetConfig(verifiedCopilotBudget) {
  if (!isPlainObject(verifiedCopilotBudget) ||
      (verifiedCopilotBudget.providerFamily !== undefined &&
       verifiedCopilotBudget.providerFamily !== 'github-copilot')) {
    return false;
  }
  const candidate = {
    ...verifiedCopilotBudget,
    providerFamily: 'github-copilot',
    adapter: verifiedCopilotBudget.adapter === undefined
      ? 'copilot-cloud-agent'
      : verifiedCopilotBudget.adapter,
    externalMergeAuthorityOnly: verifiedCopilotBudget.externalMergeAuthorityOnly === undefined
      ? true
      : verifiedCopilotBudget.externalMergeAuthorityOnly,
    allowDirectMergeOrPolicyWrite: verifiedCopilotBudget.allowDirectMergeOrPolicyWrite === undefined
      ? false
      : verifiedCopilotBudget.allowDirectMergeOrPolicyWrite
  };
  return validateMultiAgentConnectorConfig(candidate).valid;
}

export function createCopilotOnlyRollbackState(reason, verifiedCopilotBudget) {
  let normalizedReason = 'ROLLBACK_TO_COPILOT_ONLY';
  if (typeof reason === 'string' && reason.trim().length > 0 &&
      reason.trim().length <= 160 && !/[\u0000-\u001f\u007f]/.test(reason)) {
    normalizedReason = containsSecretToken(reason) ? 'REDACTED_ROLLBACK_REASON' : reason.trim();
  }
  const budgetVerified = isVerifiedCopilotBudgetConfig(verifiedCopilotBudget);

  const fallbackConfig = Object.freeze({
    providerFamily: 'github-copilot',
    adapter: 'copilot-cloud-agent',
    role: 'worker',
    includedQuotaVerified: budgetVerified,
    overageHardStopUsdCents: budgetVerified ? 0 : null,
    unapprovedSpendUsdCents: 0,
    externalMergeAuthorityOnly: true,
    allowDirectMergeOrPolicyWrite: false,
    externalTelemetryDisabled: true
  });
  return Object.freeze({
    shadow: true,
    rollbackActive: true,
    protocolVersion: CONNECTOR_PROTOCOL_VERSION,
    reason: normalizedReason,
    activeProviderFamily: 'github-copilot',
    preserveCopilotExecution: budgetVerified,
    budgetVerified,
    budgetRevalidationRequired: !budgetVerified,
    externalConnectorsEnabled: false,
    disabledProviders: Object.freeze(['openai-codex', 'anthropic-claude']),
    externalMergeAuthorityOnly: true,
    allowDirectMergeOrPolicyWrite: false,
    unapprovedSpendUsdCents: 0,
    fallbackConfig
  });
}

const isValidRpcId = id =>
  id === null ||
  Number.isSafeInteger(id) ||
  (typeof id === 'string' && id.length > 0 && id.length <= 128 &&
    !/[\u0000-\u001f\u007f]/.test(id) && !containsSecretToken(id));

const jsonRpcError = (id, code, message, reason) => Object.freeze({
  jsonrpc: '2.0',
  id,
  error: Object.freeze({
    code,
    message,
    data: Object.freeze({ reason })
  })
});

const jsonRpcResult = (id, result) => Object.freeze({
  jsonrpc: '2.0',
  id,
  result
});

const toolCallOutcome = (payload, isError) => {
  const frozenPayload = Object.freeze(payload);
  return Object.freeze({
    isError,
    content: Object.freeze([
      Object.freeze({
        type: 'text',
        text: JSON.stringify(frozenPayload)
      })
    ]),
    structuredContent: frozenPayload
  });
};

function parseAuthorizedRepositories(authorizedRepositories) {
  if (!isDenseArray(authorizedRepositories, 64) || authorizedRepositories.length === 0) {
    return { ok: false, reason: 'AUTHORIZATION_CONTEXT_INVALID' };
  }
  const byId = new Map();
  const byName = new Set();
  for (const item of authorizedRepositories) {
    if (!hasAllowedKeys(item, ['repositoryId', 'repository'], [
      'defaultBranch',
      'coverage',
      'revision',
      'projectConfig',
      'lanes',
      'trustedFiles'
    ]) || !isPositiveInt(item.repositoryId) || !isRepoName(item.repository)) {
      return { ok: false, reason: 'AUTHORIZATION_CONTEXT_INVALID' };
    }
    const lowerName = item.repository.toLowerCase();
    const isFactoryName = lowerName === 'jamula/softwarefactory';
    const isFactoryId = item.repositoryId === DEFAULT_FACTORY_SCOPE.repositoryId;
    if (isFactoryName !== isFactoryId) {
      return { ok: false, reason: 'REPOSITORY_IDENTITY_MISMATCH' };
    }
    if (byId.has(item.repositoryId) || byName.has(lowerName)) {
      return { ok: false, reason: 'AUTHORIZATION_CONTEXT_INVALID' };
    }
    const defaultBranch = item.defaultBranch === undefined ? 'main' : item.defaultBranch;
    if (!isBranchName(defaultBranch) || (item.revision !== undefined && !isSha40(item.revision))) {
      return { ok: false, reason: 'AUTHORIZATION_CONTEXT_INVALID' };
    }
    if (item.trustedFiles !== undefined &&
        (!isDenseArray(item.trustedFiles, 256) ||
         !item.trustedFiles.every(path => isRepoPath(path) && !path.endsWith('.lock.yml') &&
           !FORBIDDEN_CONTROL_PLANE_PATHS.some(blocked => pathsOverlap(path, blocked))) ||
         !isUnique(item.trustedFiles) || !arePathsDisjoint(item.trustedFiles))) {
      return { ok: false, reason: 'AUTHORIZATION_CONTEXT_INVALID' };
    }
    const minLine = isFactoryId ? 98 : 95;
    const minBranch = isFactoryId ? 95 : 90;
    let coverageThresholds = Object.freeze({ line: minLine, branch: minBranch });
    if (item.coverage !== undefined) {
      if (!hasAllowedKeys(item.coverage, ['line', 'branch']) ||
          typeof item.coverage.line !== 'number' || typeof item.coverage.branch !== 'number' ||
          item.coverage.line > 100 || item.coverage.branch > 100) {
        return { ok: false, reason: 'AUTHORIZATION_CONTEXT_INVALID' };
      }
      if (item.coverage.line < minLine || item.coverage.branch < minBranch) {
        return { ok: false, reason: 'COVERAGE_FLOOR_VIOLATION' };
      }
      coverageThresholds = Object.freeze({
        line: item.coverage.line,
        branch: item.coverage.branch
      });
    }
    byId.set(item.repositoryId, {
      repositoryId: item.repositoryId,
      repository: item.repository,
      defaultBranch,
      coverageThresholds,
      revision: item.revision,
      projectConfig: item.projectConfig,
      lanes: item.lanes,
      trustedFiles: item.trustedFiles
    });
    byName.add(lowerName);
  }
  return { ok: true, byId };
}

const validEnrolledLanes = lanes =>
  isDenseArray(lanes, 32) && lanes.length > 0 &&
  lanes.every(lane => hasAllowedKeys(lane, ['id', 'specialist', 'owners']) &&
    isSlug(lane.id) && SPECIALIST_ROLES.includes(lane.specialist) &&
    isDenseArray(lane.owners, 32) && lane.owners.length > 0 && lane.owners.every(isRepoPath)) &&
  isUnique(lanes.map(lane => lane.id)) && arePathsDisjoint(lanes.flatMap(lane => lane.owners));

export function validateMcpConnectorEnrollment(authorizedRepositories) {
  const context = { authorizedRepositories };
  if (!isValidConnectorContext(context)) return false;
  const tree = inspectBoundedPlainTree(authorizedRepositories);
  if (!tree.valid || tree.hasSecret) return false;
  const auth = parseAuthorizedRepositories(authorizedRepositories);
  if (!auth.ok) return false;
  return [...auth.byId.values()].every(entry =>
    (entry.lanes === undefined || validEnrolledLanes(entry.lanes)) &&
    (entry.projectConfig === undefined ||
      (validateProjectConfig(entry.projectConfig) &&
       entry.projectConfig.project.repository === entry.repository &&
       entry.projectConfig.project.defaultBranch === entry.defaultBranch)));
}

function buildSanitizedKnowledgeMap(entry, revision, nowMs, requestedTestInventory) {
  if (entry.projectConfig !== undefined) {
    if (!validateProjectConfig(entry.projectConfig) ||
        entry.projectConfig.project.repository !== entry.repository ||
        entry.projectConfig.knowledgeMap === undefined) {
      return { ok: false, reason: 'INVALID_PROJECT_CONFIG' };
    }
    if (entry.projectConfig.project.defaultBranch !== entry.defaultBranch) {
      return { ok: false, reason: 'BRANCH_METADATA_CONFLICT' };
    }
    const check = validateKnowledgeMap(entry.projectConfig.knowledgeMap, {
      repository: entry.repository,
      revision,
      nowMs,
      lanes: entry.projectConfig.lanes
    });
    if (!check.valid) {
      return { ok: false, reason: check.reason };
    }
    const lanes = Object.freeze(entry.projectConfig.lanes.map(lane => Object.freeze({
      id: lane.id,
      specialist: lane.specialist === undefined ? null : lane.specialist,
      owners: Object.freeze([...lane.owners])
    })));
    const components = Object.freeze(entry.projectConfig.knowledgeMap.components.map(comp => Object.freeze({
      id: comp.id,
      lane: comp.lane,
      specialist: comp.specialist,
      owners: Object.freeze([...comp.owners]),
      interfaces: Object.freeze([...comp.interfaces]),
      decisions: Object.freeze([...comp.decisions]),
      tests: Object.freeze([...comp.tests]),
      dependsOn: Object.freeze([...comp.dependsOn])
    })));
    return { ok: true, lanes, components };
  }

  if (entry.repositoryId === DEFAULT_FACTORY_SCOPE.repositoryId) {
    let effectiveInventory;
    if (requestedTestInventory !== undefined) {
      if (!requestedTestInventory.includes(MCP_CONNECTOR_TEST_SUITE)) {
        return { ok: false, reason: 'TEST_INVENTORY_UNALIGNED' };
      }
      effectiveInventory = requestedTestInventory;
    } else {
      effectiveInventory = [...new Set([
        ...defaultSoftwareFactoryTestInventory(),
        MCP_CONNECTOR_TEST_SUITE
      ])];
    }
    const catalog = softwareFactoryCatalog(revision, effectiveInventory);
    if (catalog.state === 'blocked') {
      return { ok: false, reason: catalog.reason };
    }
    const laneMap = new Map();
    for (const comp of catalog.components) {
      if (!laneMap.has(comp.owner)) {
        laneMap.set(comp.owner, { id: comp.owner, specialist: comp.specialty, owners: [] });
      }
      laneMap.get(comp.owner).owners.push(comp.root);
    }
    const lanes = Object.freeze([...laneMap.values()].map(lane => Object.freeze({
      id: lane.id,
      specialist: lane.specialist,
      owners: Object.freeze(lane.owners)
    })));
    const components = Object.freeze(catalog.components.map(comp => Object.freeze({
      id: comp.component,
      lane: comp.owner,
      specialist: comp.specialty,
      owners: Object.freeze([comp.root]),
      interfaces: Object.freeze([comp.interface]),
      decisions: Object.freeze([comp.decision]),
      tests: Object.freeze([...comp.tests]),
      dependsOn: Object.freeze([...comp.dependsOn])
    })));
    return { ok: true, lanes, components };
  }

  if (entry.lanes === undefined) {
    return { ok: false, reason: 'KNOWLEDGE_MAP_UNAVAILABLE' };
  }
  if (!validEnrolledLanes(entry.lanes)) {
    return { ok: false, reason: 'INVALID_LANE_OWNERSHIP' };
  }
  const lanes = Object.freeze(entry.lanes.map(lane => Object.freeze({
    id: lane.id,
    specialist: lane.specialist,
    owners: Object.freeze([...lane.owners])
  })));
  return { ok: true, lanes, components: Object.freeze([]) };
}

function handleGetRepoKnowledgeMap(args, context) {
  if (!hasAllowedKeys(args, ['repositoryId'], ['repository', 'revision', 'nowMs', 'testInventory']) ||
      !isPositiveInt(args.repositoryId) ||
      (args.repository !== undefined && !isRepoName(args.repository)) ||
      (args.revision !== undefined && !isSha40(args.revision)) ||
      (args.nowMs !== undefined && !isNonNegativeInt(args.nowMs)) ||
      (args.testInventory !== undefined &&
        (!isDenseArray(args.testInventory, 120) ||
         !args.testInventory.every(item => typeof item === 'string')))) {
    return toolCallOutcome({
      shadow: true,
      readOnly: true,
      authorized: false,
      reason: 'INVALID_KNOWLEDGE_MAP_ARGUMENTS'
    }, true);
  }
  if (args.nowMs !== undefined && context.nowMs !== undefined && args.nowMs !== context.nowMs) {
    return toolCallOutcome({
      shadow: true,
      readOnly: true,
      authorized: false,
      reason: 'CLOCK_MISMATCH'
    }, true);
  }
  const effectiveNowMs = context.nowMs !== undefined ? context.nowMs : args.nowMs;
  if (effectiveNowMs === undefined) {
    return toolCallOutcome({
      shadow: true,
      readOnly: true,
      authorized: false,
      reason: 'FRESHNESS_TIMESTAMP_REQUIRED'
    }, true);
  }
  const auth = parseAuthorizedRepositories(context.authorizedRepositories);
  if (!auth.ok) {
    return toolCallOutcome({
      shadow: true,
      readOnly: true,
      authorized: false,
      reason: auth.reason
    }, true);
  }
  const entry = auth.byId.get(args.repositoryId);
  if (!entry) {
    return toolCallOutcome({
      shadow: true,
      readOnly: true,
      authorized: false,
      reason: 'UNAUTHORIZED_REPOSITORY'
    }, true);
  }
  if (args.repository !== undefined && args.repository !== entry.repository) {
    return toolCallOutcome({
      shadow: true,
      readOnly: true,
      authorized: false,
      reason: 'CROSS_REPO_ACCESS_DENIED'
    }, true);
  }
  if (args.revision !== undefined && entry.revision !== undefined && args.revision !== entry.revision) {
    return toolCallOutcome({
      shadow: true,
      readOnly: true,
      authorized: false,
      reason: 'STALE_KNOWLEDGE_REVISION'
    }, true);
  }
  const revision = args.revision === undefined ? entry.revision : args.revision;
  if (revision === undefined) {
    return toolCallOutcome({
      shadow: true,
      readOnly: true,
      authorized: false,
      reason: 'REVISION_REQUIRED'
    }, true);
  }
  const mapped = buildSanitizedKnowledgeMap(entry, revision, effectiveNowMs, args.testInventory);
  if (!mapped.ok) {
    return toolCallOutcome({
      shadow: true,
      readOnly: true,
      authorized: false,
      reason: mapped.reason
    }, true);
  }
  return toolCallOutcome({
    shadow: true,
    readOnly: true,
    authorized: true,
    reason: 'KNOWLEDGE_MAP_VERIFIED',
    repositoryId: entry.repositoryId,
    repository: entry.repository,
    defaultBranch: entry.defaultBranch,
    revision,
    verifiedAtMs: effectiveNowMs,
    coverageThresholds: entry.coverageThresholds,
    lanes: mapped.lanes,
    components: mapped.components,
    architectureInvariants: Object.freeze({
      externalMergeAuthorityOnly: true,
      allowDirectMergeOrPolicyWrite: false,
      mergeEvaluators: SOLE_MERGE_EVALUATORS,
      mergeQueueRequired: true,
      unapprovedSpendUsdCents: 0,
      protectedControlPlanePaths: FORBIDDEN_CONTROL_PLANE_PATHS
    })
  }, false);
}

function policyMeetsCoverageFloor(policy, minLine, minBranch) {
  return isPlainObject(policy) &&
    hasAllowedKeys(policy.coverage, ['line', 'branch']) &&
    typeof policy.coverage.line === 'number' &&
    typeof policy.coverage.branch === 'number' &&
    policy.coverage.line >= minLine &&
    policy.coverage.branch >= minBranch;
}

function defaultCoverageFloor(repository) {
  const isFactory = typeof repository === 'string' &&
    repository.toLowerCase() === 'jamula/softwarefactory';
  return isFactory
    ? { line: 98, branch: 95 }
    : { line: 95, branch: 90 };
}

function handleEvaluateGateStatus(args, context) {
  const deniedGate = reason => toolCallOutcome({
    shadow: true,
    readOnly: true,
    state: 'blocked',
    eligible: false,
    reason,
    externalMergeAuthorityOnly: true,
    liveMerge: false,
    allowDirectMergeOrPolicyWrite: false
  }, true);

  let authById = null;
  if (context.authorizedRepositories !== undefined) {
    const auth = parseAuthorizedRepositories(context.authorizedRepositories);
    if (!auth.ok) {
      return deniedGate(auth.reason);
    }
    authById = auth.byId;
  }

  if (args.mode === 'candidate') {
    if (!hasAllowedKeys(args, ['mode', 'policy', 'snapshot']) ||
        !isPlainObject(args.policy) || !isPlainObject(args.snapshot)) {
      return deniedGate('INVALID_GATE_EVALUATION_ARGUMENTS');
    }
    let requiredFloor = defaultCoverageFloor(args.policy.repository);
    if (authById !== null) {
      const matched = typeof args.policy.repository === 'string'
        ? [...authById.values()].find(entry => entry.repository === args.policy.repository)
        : undefined;
      if (!matched) {
        return deniedGate('UNAUTHORIZED_REPOSITORY');
      }
      requiredFloor = matched.coverageThresholds;
    }
    if (!policyMeetsCoverageFloor(args.policy, requiredFloor.line, requiredFloor.branch)) {
      return deniedGate('COVERAGE_FLOOR_VIOLATION');
    }
    const decision = evaluateCandidate(args.policy, args.snapshot);
    return toolCallOutcome({
      shadow: true,
      readOnly: true,
      evaluator: 'core.evaluate',
      mode: 'candidate',
      state: decision.state,
      eligible: decision.state === 'eligible',
      reason: decision.reason,
      externalMergeAuthorityOnly: true,
      liveMerge: false,
      allowDirectMergeOrPolicyWrite: false
    }, false);
  }

  if (args.mode === 'protected-squash') {
    if (!hasAllowedKeys(args, ['mode', 'intent', 'evidence'], ['scope']) ||
        !isPlainObject(args.intent) || !isPlainObject(args.evidence) ||
        (args.scope !== undefined && !isPlainObject(args.scope))) {
      return deniedGate('INVALID_GATE_EVALUATION_ARGUMENTS');
    }
    const targetScope = args.scope === undefined ? DEFAULT_FACTORY_SCOPE : args.scope;
    let requiredFloor = defaultCoverageFloor(targetScope.repository);
    if (authById !== null) {
      const entry = authById.get(targetScope.repositoryId);
      if (!entry || entry.repository !== targetScope.repository) {
        return deniedGate('UNAUTHORIZED_REPOSITORY');
      }
      requiredFloor = entry.coverageThresholds;
    }
    if (!policyMeetsCoverageFloor(args.evidence.policy, requiredFloor.line, requiredFloor.branch)) {
      return deniedGate('COVERAGE_FLOOR_VIOLATION');
    }
    const decision = evaluateProtectedSquash(args.intent, args.evidence, targetScope);
    const eligible = decision.reason === 'SHADOW_SQUASH_ELIGIBLE';
    return toolCallOutcome({
      shadow: true,
      readOnly: true,
      evaluator: 'protected-squash.guardedSquashEvidence',
      mode: 'protected-squash',
      state: eligible ? 'eligible' : 'blocked',
      eligible,
      reason: decision.reason,
      dependentWorkAllowed: Boolean(decision.dependentWorkAllowed),
      externalMergeAuthorityOnly: true,
      liveMerge: false,
      allowDirectMergeOrPolicyWrite: false
    }, false);
  }

  return deniedGate('INVALID_GATE_EVALUATION_ARGUMENTS');
}

function handleGetBoundedWorkItemContext(args, context) {
  const deniedWorkItem = reason => toolCallOutcome({
    shadow: true,
    readOnly: true,
    reason,
    externalMergeAuthorityOnly: true,
    allowDirectMergeOrPolicyWrite: false
  }, true);

  if (!hasAllowedKeys(
    args,
    ['repositoryId', 'issueNumber', 'traceparent', 'summary', 'ownedPaths'],
    ['pullRequestNumber', 'notes', 'additionalForbiddenPaths', 'maxRepairIterations', 'secretHandling']
  ) ||
      !isPositiveInt(args.repositoryId) ||
      !isPositiveInt(args.issueNumber) ||
      (args.pullRequestNumber !== undefined && !isPositiveInt(args.pullRequestNumber)) ||
      !isSafeText(args.summary, 2000) ||
      !isDenseArray(args.ownedPaths, 32) || args.ownedPaths.length === 0 ||
      !args.ownedPaths.every(isRepoPath) || !arePathsDisjoint(args.ownedPaths)) {
    return deniedWorkItem('INVALID_WORK_ITEM_ARGUMENTS');
  }
  if (!isValidTraceparent(args.traceparent)) {
    return deniedWorkItem('INVALID_TRACEPARENT');
  }
  const maxRepairIterations = args.maxRepairIterations === undefined ? 2 : args.maxRepairIterations;
  if (!Number.isSafeInteger(maxRepairIterations) || maxRepairIterations < 1 || maxRepairIterations > 5) {
    return deniedWorkItem('INVALID_MAX_REPAIR_ITERATIONS');
  }
  const secretHandling = args.secretHandling === undefined ? 'reject' : args.secretHandling;
  if (secretHandling !== 'reject' && secretHandling !== 'strip') {
    return deniedWorkItem('INVALID_WORK_ITEM_ARGUMENTS');
  }
  const rawNotes = args.notes === undefined ? [] : args.notes;
  if (!isDenseArray(rawNotes, 20) || !rawNotes.every(note => isSafeText(note, 500))) {
    return deniedWorkItem('INVALID_WORK_ITEM_ARGUMENTS');
  }
  const extraForbidden = args.additionalForbiddenPaths === undefined ? [] : args.additionalForbiddenPaths;
  if (!isDenseArray(extraForbidden, 32) || !extraForbidden.every(isRepoPath)) {
    return deniedWorkItem('INVALID_WORK_ITEM_ARGUMENTS');
  }
  if (args.ownedPaths.some(containsSecretToken) || extraForbidden.some(containsSecretToken)) {
    return deniedWorkItem('SECRET_TOKEN_REJECTED');
  }

  if (context.authorizedRepositories !== undefined) {
    const auth = parseAuthorizedRepositories(context.authorizedRepositories);
    if (!auth.ok) {
      return deniedWorkItem(auth.reason);
    }
    if (!auth.byId.has(args.repositoryId)) {
      return deniedWorkItem('UNAUTHORIZED_REPOSITORY');
    }
  }

  const forbiddenSet = new Set([...FORBIDDEN_CONTROL_PLANE_PATHS, ...extraForbidden]);
  const forbiddenControlPlanePaths = Object.freeze([...forbiddenSet]);
  if (args.ownedPaths.some(owned =>
    owned.endsWith('.lock.yml') ||
    forbiddenControlPlanePaths.some(forbidden => pathsOverlap(owned, forbidden)))) {
    return deniedWorkItem('FORBIDDEN_CONTROL_PLANE_PATH');
  }

  if (secretHandling === 'reject') {
    if (containsSecretToken(args.summary) || rawNotes.some(containsSecretToken)) {
      return deniedWorkItem('SECRET_TOKEN_REJECTED');
    }
    return toolCallOutcome({
      shadow: true,
      readOnly: true,
      reason: 'WORK_ITEM_CONTEXT_BOUNDED',
      repositoryId: args.repositoryId,
      issueNumber: args.issueNumber,
      pullRequestNumber: args.pullRequestNumber === undefined ? null : args.pullRequestNumber,
      traceparent: args.traceparent,
      summary: args.summary.trim(),
      notes: Object.freeze(rawNotes.map(note => note.trim())),
      secretsStripped: false,
      ownedPaths: Object.freeze([...args.ownedPaths]),
      forbiddenControlPlanePaths,
      maxRepairIterations,
      externalMergeAuthorityOnly: true,
      allowDirectMergeOrPolicyWrite: false
    }, false);
  }

  const summaryRedacted = stripSecretTokens(args.summary.trim());
  let secretsStripped = summaryRedacted.stripped;
  const sanitizedNotes = rawNotes.map(note => {
    const redacted = stripSecretTokens(note.trim());
    if (redacted.stripped) {
      secretsStripped = true;
    }
    return redacted.sanitized;
  });

  return toolCallOutcome({
    shadow: true,
    readOnly: true,
    reason: 'WORK_ITEM_CONTEXT_BOUNDED',
    repositoryId: args.repositoryId,
    issueNumber: args.issueNumber,
    pullRequestNumber: args.pullRequestNumber === undefined ? null : args.pullRequestNumber,
    traceparent: args.traceparent,
    summary: summaryRedacted.sanitized,
    notes: Object.freeze(sanitizedNotes),
    secretsStripped,
    ownedPaths: Object.freeze([...args.ownedPaths]),
    forbiddenControlPlanePaths,
    maxRepairIterations,
    externalMergeAuthorityOnly: true,
    allowDirectMergeOrPolicyWrite: false
  }, false);
}

const wrapperDenied = reason => toolCallOutcome({ shadow: true, readOnly: true, reason }, true);

function inspectAdditionalArguments(name, args) {
  const tree = inspectBoundedPlainTree(args);
  if (!tree.valid || !tree.hasSecret || name !== 'build_consumer_onboarding_plan' ||
      !isPlainObject(args.success)) return tree;
  const copy = structuredClone(args);
  const packages = [copy.success.onboardingPackage];
  if (isDenseArray(copy.success.rollbackProof?.cohortPackages, 256)) {
    packages.push(...copy.success.rollbackProof.cohortPackages);
  }
  for (const pkg of packages) {
    if (!isPlainObject(pkg) || !Object.hasOwn(pkg, 'credentials')) continue;
    if (Object.hasOwn(pkg, 'credentialMetadata')) return tree;
    const metadata = pkg.credentials;
    if (!hasAllowedKeys(metadata, [
      'credentialId', 'scope', 'allowedRepositories', 'sharedAdminToken', 'persistedInCheckout'
    ]) || metadata.sharedAdminToken !== false || metadata.persistedInCheckout !== false) return tree;
    if (!isPlainObject(pkg.workflowPin) || pkg.workflowPin.persistCredentials !== false) return tree;
    delete pkg.credentials;
    delete pkg.workflowPin.persistCredentials;
    pkg.credentialMetadata = {
      credentialId: metadata.credentialId, scope: metadata.scope,
      allowedRepositories: metadata.allowedRepositories
    };
  }
  return inspectBoundedPlainTree(copy);
}

function handleAdditionalTool(name, args, context) {
  const tree = inspectAdditionalArguments(name, args);
  if (!tree.valid || tree.hasSecret) return wrapperDenied('INVALID_OR_SECRET_ARGUMENTS');
  const auth = parseAuthorizedRepositories(context.authorizedRepositories);
  if (!auth.ok) return wrapperDenied(auth.reason);
  const entry = auth.byId.get(args.repositoryId);
  if (!entry) return wrapperDenied('UNAUTHORIZED_REPOSITORY');
  let result;
  if (name === 'plan_disjoint_lanes') {
    if (!hasAllowedKeys(args, ['repositoryId', 'tasks'], ['active', 'policy'])) return wrapperDenied('INVALID_PLAN_ARGUMENTS');
    let config = entry.projectConfig;
    if (config === undefined && entry.repositoryId === DEFAULT_FACTORY_SCOPE.repositoryId) {
      const map = buildSanitizedKnowledgeMap(entry, '0'.repeat(40), 0);
      if (!map.ok) return wrapperDenied(map.reason);
      config = {
        schemaVersion: 1,
        project: { key: 'softwarefactory', repository: entry.repository, defaultBranch: entry.defaultBranch },
        execution: { enabled: false, mode: 'shadow', stop: false },
        limits: { maxConcurrentLanes: 1, leaseMs: 1000, maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
        adapters: { workTracker: 'mock', engineeringAgent: 'mock', state: 'sqlite' },
        lanes: map.lanes.map(lane => ({ id: lane.id, owners: [...lane.owners], prompt: 'docs/ENGINEERING-STANDARDS.md' }))
      };
    }
    if (!validateProjectConfig(config) || config.project.repository !== entry.repository ||
        config.project.defaultBranch !== entry.defaultBranch) return wrapperDenied('INVALID_PROJECT_CONFIG');
    const inventories = [args.tasks, args.active ?? []];
    if (inventories.some(items => !isDenseArray(items, 250) || items.some(item =>
      !isPlainObject(item) || !isDenseArray(item.paths, 256) ||
      item.paths.some(path => typeof path !== 'string' || path.endsWith('.lock.yml') ||
        FORBIDDEN_CONTROL_PLANE_PATHS.some(blocked => pathsOverlap(path, blocked)))))) {
      return wrapperDenied('INVALID_OR_PROTECTED_PATH');
    }
    if (inventories.some(items => items.some(item => item.paths.some(path =>
      entry.trustedFiles === undefined || !entry.trustedFiles.includes(path))))) {
      return wrapperDenied('TRUSTED_FILE_INVENTORY_REQUIRED');
    }
    result = planLanes(config, args.tasks, args.active, args.policy);
    return toolCallOutcome(result, !['SHADOW_PLAN', 'NO_READY_WORK'].includes(result.reason));
  }
  if (name === 'build_consumer_onboarding_plan') {
    if (!hasAllowedKeys(args, ['repositoryId', 'discovery'], ['success']) ||
        !isPlainObject(args.discovery) || args.discovery.repositoryId !== entry.repositoryId ||
        args.discovery.repository !== entry.repository) return wrapperDenied('INVALID_ONBOARDING_ARGUMENTS');
    const coverage = args.discovery.stricterCoverageThresholds;
    if (coverage !== undefined && (!hasAllowedKeys(coverage, ['line', 'branch']) ||
        coverage.line < entry.coverageThresholds.line || coverage.branch < entry.coverageThresholds.branch)) {
      return wrapperDenied('COVERAGE_FLOOR_VIOLATION');
    }
    const plan = buildReadOnlyOnboardingPlan(args.discovery);
    if (plan.valid && plan.policy.defaultBranch !== entry.defaultBranch) {
      return wrapperDenied('DEFAULT_BRANCH_MISMATCH');
    }
    if (plan.valid && (plan.localGates.minLineCoverage < entry.coverageThresholds.line ||
        plan.localGates.minBranchCoverage < entry.coverageThresholds.branch)) {
      return wrapperDenied('LOCAL_GATE_BELOW_ENROLLMENT');
    }
    const success = args.success === undefined ? undefined : evaluateConsumerOnboardingSuccess(args.success);
    if (success?.valid || success?.shadowOnboarded === true) {
      const pkg = args.success.onboardingPackage;
      if (!plan.valid || pkg.repositoryId !== entry.repositoryId ||
          pkg.policy.repository !== entry.repository || pkg.policy.defaultBranch !== entry.defaultBranch ||
          pkg.stackProfile !== plan.stackProfile || pkg.policy.mergeMethod !== plan.policy.mergeMethod ||
          pkg.workflowPin.reviewedWorkflowSha !== plan.workflowPin.reviewedWorkflowSha ||
          pkg.workflowPin.reviewedCheckoutSha !== plan.workflowPin.reviewedCheckoutSha ||
          pkg.policy.creditLimit > plan.policy.creditLimit ||
          pkg.policy.riskClasses.some(risk => !plan.policy.riskClasses.includes(risk)) ||
          pkg.policy.reviewers.some(reviewer => !plan.policy.reviewers.some(
            authorized => authorized.toLowerCase() === reviewer.toLowerCase())) ||
          pkg.policy.owners.length !== plan.policy.owners.length ||
          pkg.policy.owners.some(owner => !plan.policy.owners.some(
            expected => expected.prefix === owner.prefix && expected.owner === owner.owner)) ||
          pkg.policy.coverage.line < Math.max(entry.coverageThresholds.line, plan.policy.coverage.line) ||
          pkg.policy.coverage.branch < Math.max(entry.coverageThresholds.branch, plan.policy.coverage.branch) ||
          pkg.localGates.minLineCoverage < Math.max(entry.coverageThresholds.line, plan.localGates.minLineCoverage) ||
          pkg.localGates.minBranchCoverage < Math.max(entry.coverageThresholds.branch, plan.localGates.minBranchCoverage) ||
          pkg.policy.maxActive > plan.policy.maxActive ||
          pkg.localGates.maxConcurrency > plan.localGates.maxConcurrency ||
          plan.localGates.requiredChecks.some(check => !pkg.localGates.requiredChecks.some(
            candidate => candidate.name === check.name && candidate.appId === check.appId))) {
        return wrapperDenied('ONBOARDING_IDENTITY_OR_GATE_MISMATCH');
      }
    }
    result = success === undefined ? { plan } : { plan, success };
    return toolCallOutcome(result, !plan.valid || (success !== undefined && !success.valid));
  }
  if (name === 'select_scoped_guidance_and_lessons') {
    if (args.repositorySlug !== entry.repository) return wrapperDenied('CROSS_REPO_ACCESS_DENIED');
    if ((entry.revision !== undefined && args.expectedHeadSha !== entry.revision) ||
        (context.nowMs !== undefined && args.nowMs !== context.nowMs)) return wrapperDenied('STALE_CONTEXT');
    if (args.policy !== undefined && !isPlainObject(args.policy)) return wrapperDenied('INVALID_SELECTION_INPUT');
    const policy = { ...args.policy };
    if ((policy.minLineCoveragePct !== undefined && policy.minLineCoveragePct < entry.coverageThresholds.line) ||
        (policy.minBranchCoveragePct !== undefined && policy.minBranchCoveragePct < entry.coverageThresholds.branch)) {
      return wrapperDenied('COVERAGE_FLOOR_VIOLATION');
    }
    policy.minLineCoveragePct ??= entry.coverageThresholds.line;
    policy.minBranchCoveragePct ??= entry.coverageThresholds.branch;
    result = selectScopedGuidanceAndLessons({ ...args, policy });
    return toolCallOutcome(result, !result.valid);
  }
  if (!hasAllowedKeys(args, ['repositoryId'], ['repository']) ||
      (args.repository !== undefined && args.repository !== entry.repository)) {
    return wrapperDenied('INVALID_BOARD_ARGUMENTS');
  }
  return wrapperDenied('BOARD_TRANSPORT_REQUIRED');
}

export function handleMcpConnectorRequest(rawOrObject, context = {}) {
  let envelope;
  if (typeof rawOrObject === 'string') {
    const byteLength = Buffer.byteLength(rawOrObject, 'utf8');
    if (byteLength === 0) {
      return jsonRpcError(null, -32700, 'PARSE_ERROR', 'EMPTY_PAYLOAD');
    }
    if (byteLength > MAX_MCP_REQUEST_BYTES) {
      return jsonRpcError(null, -32600, 'INVALID_REQUEST', 'PAYLOAD_TOO_LARGE');
    }
    try {
      envelope = JSON.parse(rawOrObject);
    } catch {
      return jsonRpcError(null, -32700, 'PARSE_ERROR', 'MALFORMED_JSON');
    }
    if (!isPlainObject(envelope) || !isDeepPlainValue(envelope)) {
      return jsonRpcError(null, -32600, 'INVALID_REQUEST', 'INVALID_ENVELOPE');
    }
  } else {
    if (!isPlainObject(rawOrObject)) {
      return jsonRpcError(null, -32600, 'INVALID_REQUEST', 'INVALID_ENVELOPE');
    }
    const normalizedEnvelope = Object.hasOwn(rawOrObject, 'id') && rawOrObject.id === undefined
      ? Object.fromEntries(Object.entries(rawOrObject).filter(([key]) => key !== 'id'))
      : rawOrObject;
    if (!isDeepPlainValue(normalizedEnvelope)) {
      return jsonRpcError(null, -32600, 'INVALID_REQUEST', 'INVALID_ENVELOPE');
    }
    if (Buffer.byteLength(JSON.stringify(normalizedEnvelope), 'utf8') > MAX_MCP_REQUEST_BYTES) {
      return jsonRpcError(null, -32600, 'INVALID_REQUEST', 'PAYLOAD_TOO_LARGE');
    }
    envelope = normalizedEnvelope;
  }

  const hasId = Object.hasOwn(envelope, 'id');
  if (hasId && !isValidRpcId(envelope.id)) {
    return jsonRpcError(null, -32600, 'INVALID_REQUEST', 'INVALID_ID');
  }
  const responseId = hasId ? envelope.id : null;

  if (Object.keys(envelope).some(key => !ENVELOPE_KEYS.has(key)) ||
      envelope.jsonrpc !== '2.0' ||
      typeof envelope.method !== 'string' ||
      envelope.method.length === 0 ||
      envelope.method.length > 128 ||
      /[\u0000-\u001f\u007f]/.test(envelope.method)) {
    return jsonRpcError(responseId, -32600, 'INVALID_REQUEST', 'INVALID_JSONRPC_ENVELOPE');
  }

  if (!hasId) {
    return null;
  }

  if (envelope.params !== undefined && !isPlainObject(envelope.params)) {
    return jsonRpcError(responseId, -32602, 'INVALID_PARAMS', 'PARAMS_MUST_BE_OBJECT');
  }
  if (envelope.params !== undefined && !isValidMcpMeta(envelope.params._meta)) {
    return jsonRpcError(responseId, -32602, 'INVALID_PARAMS', 'INVALID_MCP_META');
  }

  if (!isValidConnectorContext(context)) {
    return jsonRpcError(responseId, -32602, 'INVALID_PARAMS', 'INVALID_CONNECTOR_CONTEXT');
  }

  if (envelope.method === 'initialize') {
    if (envelope.params !== undefined &&
        (!hasAllowedKeys(envelope.params, [], ['_meta', 'protocolVersion', 'capabilities', 'clientInfo']) ||
         (envelope.params.protocolVersion !== undefined &&
          (typeof envelope.params.protocolVersion !== 'string' ||
           envelope.params.protocolVersion.length === 0 ||
           envelope.params.protocolVersion.length > 32)))) {
      return jsonRpcError(responseId, -32602, 'INVALID_PARAMS', 'INVALID_INITIALIZE_PARAMS');
    }
    return jsonRpcResult(responseId, Object.freeze({
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: Object.freeze({
        tools: Object.freeze({ listChanged: false })
      }),
      serverInfo: Object.freeze({
        name: MCP_SERVER_NAME,
        version: CONNECTOR_PROTOCOL_VERSION
      })
    }));
  }

  if (envelope.method === 'ping') {
    if (envelope.params !== undefined && !hasAllowedKeys(envelope.params, [], ['_meta'])) {
      return jsonRpcError(responseId, -32602, 'INVALID_PARAMS', 'INVALID_PING_PARAMS');
    }
    return jsonRpcResult(responseId, Object.freeze({}));
  }

  if (envelope.method === 'tools/list') {
    if (envelope.params !== undefined &&
        (!hasAllowedKeys(envelope.params, [], ['_meta', 'cursor']) ||
         (envelope.params.cursor !== undefined &&
          (typeof envelope.params.cursor !== 'string' || envelope.params.cursor.length > 256)))) {
      return jsonRpcError(responseId, -32602, 'INVALID_PARAMS', 'INVALID_TOOLS_LIST_PARAMS');
    }
    return jsonRpcResult(responseId, Object.freeze({
      tools: MCP_CONNECTOR_TOOLS
    }));
  }

  if (envelope.method === 'tools/call') {
    if (context.killSwitch === true || context.stop === true) {
      return jsonRpcResult(responseId, toolCallOutcome({
        shadow: true,
        readOnly: true,
        reason: 'CONNECTOR_STOPPED',
        externalMergeAuthorityOnly: true,
        liveMerge: false,
        allowDirectMergeOrPolicyWrite: false
      }, true));
    }
    if (!hasAllowedKeys(envelope.params, ['name'], ['arguments', '_meta']) ||
        typeof envelope.params.name !== 'string' ||
        (envelope.params.arguments !== undefined && !isPlainObject(envelope.params.arguments))) {
      return jsonRpcError(responseId, -32602, 'INVALID_PARAMS', 'INVALID_TOOL_CALL_PARAMS');
    }
    const toolArgs = envelope.params.arguments === undefined ? {} : envelope.params.arguments;
    if (envelope.params.name === 'get_repo_knowledge_map') {
      return jsonRpcResult(responseId, handleGetRepoKnowledgeMap(toolArgs, context));
    }
    if (envelope.params.name === 'evaluate_gate_status') {
      return jsonRpcResult(responseId, handleEvaluateGateStatus(toolArgs, context));
    }
    if (envelope.params.name === 'get_bounded_work_item_context') {
      return jsonRpcResult(responseId, handleGetBoundedWorkItemContext(toolArgs, context));
    }
    if (envelope.params.name === 'validate_provider_isolation') {
      const outcome = validateMultiAgentConnectorConfig(toolArgs);
      return jsonRpcResult(responseId, toolCallOutcome(outcome, !outcome.valid));
    }
    if (['plan_disjoint_lanes', 'build_consumer_onboarding_plan',
      'select_scoped_guidance_and_lessons', 'get_factory_board_snapshot'].includes(envelope.params.name)) {
      return jsonRpcResult(responseId, handleAdditionalTool(envelope.params.name, toolArgs, context));
    }
    return jsonRpcError(responseId, -32602, 'INVALID_PARAMS', 'UNKNOWN_TOOL');
  }

  return jsonRpcError(responseId, -32601, 'METHOD_NOT_FOUND', 'UNSUPPORTED_READ_ONLY_METHOD');
}

const serializeMcpStdioFrame = response =>
  JSON.stringify(response)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

const framedBatchDenied = reason => Object.freeze({
  shadow: true,
  valid: false,
  readOnly: true,
  protocolVersion: CONNECTOR_PROTOCOL_VERSION,
  mcpProtocolVersion: MCP_PROTOCOL_VERSION,
  reason,
  lineCount: 0,
  notificationCount: 0,
  errorCount: 0,
  responses: Object.freeze([]),
  framedOutput: ''
});

function extractFramedLines(lines) {
  if (typeof lines === 'string') {
    if (lines.length === 0) {
      return { ok: false, reason: 'EMPTY_FRAMED_BATCH' };
    }
    const extracted = [];
    let cursor = 0;
    while (cursor < lines.length) {
      if (extracted.length >= MAX_MCP_FRAMED_LINES) {
        return { ok: false, reason: 'FRAMED_BATCH_LIMIT_EXCEEDED' };
      }
      const nl = lines.indexOf('\n', cursor);
      const rawEnd = nl === -1 ? lines.length : nl;
      const lineEnd = nl !== -1 && nl > cursor && lines.charCodeAt(nl - 1) === 13
        ? nl - 1
        : rawEnd;
      const currentFrame = lines.slice(cursor, lineEnd);
      if (currentFrame.includes('\r')) {
        return { ok: false, reason: 'EMBEDDED_NEWLINE_IN_FRAME' };
      }
      extracted.push(currentFrame.length > MAX_MCP_REQUEST_BYTES
        ? 'x'.repeat(MAX_MCP_REQUEST_BYTES + 1)
        : currentFrame);
      if (nl === -1) {
        break;
      }
      cursor = nl + 1;
    }
    return { ok: true, frameLines: extracted };
  }
  if (types.isProxy(lines) || !Array.isArray(lines) ||
      Object.getPrototypeOf(lines) !== Array.prototype ||
      Reflect.ownKeys(lines).length !== lines.length + 1) {
    return { ok: false, reason: 'INVALID_FRAMED_BATCH' };
  }
  if (lines.length === 0) {
    return { ok: false, reason: 'EMPTY_FRAMED_BATCH' };
  }
  if (lines.length > MAX_MCP_FRAMED_LINES) {
    return { ok: false, reason: 'FRAMED_BATCH_LIMIT_EXCEEDED' };
  }
  for (let i = 0; i < lines.length; i++) {
    if (!ownData(lines, String(i)) || typeof lines[i] !== 'string') {
      return { ok: false, reason: 'INVALID_FRAMED_BATCH' };
    }
    if (lines[i].includes('\n') || lines[i].includes('\r')) {
      return { ok: false, reason: 'EMBEDDED_NEWLINE_IN_FRAME' };
    }
  }
  return { ok: true, frameLines: lines };
}

export function processMcpFramedMessages(lines, context = {}) {
  if (!isValidConnectorContext(context)) {
    return framedBatchDenied('INVALID_CONNECTOR_CONTEXT');
  }
  const extracted = extractFramedLines(lines);
  if (!extracted.ok) {
    return framedBatchDenied(extracted.reason);
  }
  const responses = [];
  let notificationCount = 0;
  let errorCount = 0;
  for (const line of extracted.frameLines) {
    const response = line.length > MAX_MCP_REQUEST_BYTES ||
      Buffer.byteLength(line, 'utf8') > MAX_MCP_REQUEST_BYTES
      ? jsonRpcError(null, -32600, 'INVALID_REQUEST', 'PAYLOAD_TOO_LARGE')
      : handleMcpConnectorRequest(line, context);
    if (response === null) {
      notificationCount += 1;
      continue;
    }
    if (response.error !== undefined) {
      errorCount += 1;
    }
    responses.push(serializeMcpStdioFrame(response));
  }
  return Object.freeze({
    shadow: true,
    valid: true,
    readOnly: true,
    protocolVersion: CONNECTOR_PROTOCOL_VERSION,
    mcpProtocolVersion: MCP_PROTOCOL_VERSION,
    reason: 'MCP_FRAMED_BATCH_PROCESSED',
    lineCount: extracted.frameLines.length,
    notificationCount,
    errorCount,
    responses: Object.freeze(responses),
    framedOutput: responses.length === 0 ? '' : `${responses.join('\n')}\n`
  });
}

// Transport is injected separately from JSON-only authorization context; defaults never reach gh or fetch.
export async function startMcpStdioServer({ input = process.stdin, output = process.stdout, env = process.env, context = {} } = {}) {
  void env;
  let transport;
  let requestContext = context;
  if (isPlainObject(context) && Object.hasOwn(context, 'boardTransport')) {
    transport = context.boardTransport;
    requestContext = Object.fromEntries(Object.entries(context).filter(([key]) => key !== 'boardTransport'));
  }
  const validTransport = isPlainObject(transport) &&
    hasAllowedKeys(transport, ['request']) && typeof transport.request === 'function';
  let streamFailure = input.errored ?? output.errored ??
    (output.destroyed || !output.writable ? new Error('OUTPUT_CLOSED') : null);
  let rejectLifetime;
  const lifetimeFailure = new Promise((_, reject) => { rejectLifetime = reject; });
  lifetimeFailure.catch(() => {});
  const failStream = error => {
    streamFailure ??= error;
    rejectLifetime(streamFailure);
  };
  const onError = error => failStream(error);
  const onClose = () => failStream(new Error('OUTPUT_CLOSED'));
  output.on('error', onError);
  output.on('close', onClose);
  if (streamFailure !== null) failStream(streamFailure);
  let pending = Buffer.alloc(0);
  let oversized = false;
  const writeFrame = async response => {
    if (response === null) return;
    let onDrain;
    try {
      let drainDone = Promise.resolve();
      const writeDone = new Promise((resolve, reject) => {
        if (!output.write(`${serializeMcpStdioFrame(response)}\n`, 'utf8', error => {
          if (error) reject(error);
          else resolve();
        })) {
          drainDone = new Promise(resolveDrain => {
            onDrain = resolveDrain;
            output.once('drain', onDrain);
          });
        }
      });
      writeDone.catch(() => {});
      await Promise.race([lifetimeFailure, Promise.all([writeDone, drainDone])]);
    } finally {
      if (onDrain !== undefined) output.off('drain', onDrain);
    }
  };
  const handleFrame = async () => {
    let response;
    if (oversized) {
      response = jsonRpcError(null, -32600, 'INVALID_REQUEST', 'PAYLOAD_TOO_LARGE');
    } else {
      let text;
      try {
        const bytes = pending.length && pending[pending.length - 1] === 13 ? pending.subarray(0, -1) : pending;
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        response = jsonRpcError(null, -32700, 'PARSE_ERROR', 'MALFORMED_JSON');
      }
      if (text !== undefined) response = handleMcpConnectorRequest(text, requestContext);
      if (validTransport && response?.result?.structuredContent?.reason === 'BOARD_TRANSPORT_REQUIRED') {
        const envelope = JSON.parse(text);
        const entry = parseAuthorizedRepositories(requestContext.authorizedRepositories).byId.get(envelope.params.arguments.repositoryId);
        const controller = new AbortController();
        let timer;
        let active = true;
        try {
          const snapshot = await Promise.race([
            fetchFactoryBoardSnapshot({
              repo: entry.repository,
              execGh: async () => { throw new Error('DISABLED'); },
              request: (url, options) => {
                if (!active) throw new Error('BOARD_READ_EXPIRED');
                return transport.request(url, { ...options, signal: controller.signal });
              }
            }),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('BOARD_READ_TIMEOUT')), 5000);
            })
          ]);
          const inspected = inspectBoundedPlainTree(snapshot);
          response = snapshot.ok !== true
            ? jsonRpcResult(envelope.id, wrapperDenied('BOARD_READ_FAILED'))
            : inspected.valid && !inspected.hasSecret &&
            Buffer.byteLength(JSON.stringify(snapshot)) <= MAX_MCP_REQUEST_BYTES
            ? jsonRpcResult(envelope.id, toolCallOutcome(snapshot, false))
            : jsonRpcResult(envelope.id, wrapperDenied('BOARD_RESULT_UNSAFE'));
        } catch {
          response = jsonRpcResult(envelope.id, wrapperDenied('BOARD_READ_FAILED'));
        } finally {
          active = false;
          controller.abort();
          clearTimeout(timer);
        }
      }
    }
    pending = Buffer.alloc(0);
    oversized = false;
    await writeFrame(response);
  };
  const chunks = [];
  let inputEnded = input.readableEnded === true || input.destroyed === true;
  let notifyPump;
  const wakePump = () => {
    const fn = notifyPump;
    notifyPump = undefined;
    fn?.();
  };
  const onData = chunk => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    input.pause();
    wakePump();
  };
  const onInputEnd = () => {
    inputEnded = true;
    wakePump();
  };
  const onInputError = error => failStream(error);
  const onInputClose = () => {
    inputEnded = true;
    wakePump();
  };
  input.on('data', onData);
  input.on('end', onInputEnd);
  input.on('error', onInputError);
  input.on('close', onInputClose);
  try {
    while (true) {
      if (chunks.length === 0 && !inputEnded) {
        input.resume();
        await Promise.race([
          lifetimeFailure,
          new Promise(resolve => { notifyPump = resolve; })
        ]);
        continue;
      }
      await Promise.race([lifetimeFailure, Promise.resolve()]);
      if (chunks.length === 0) break;
      const bytes = chunks.shift();
      let start = 0;
      while (start < bytes.length) {
        const newline = bytes.indexOf(10, start);
        const end = newline < 0 ? bytes.length : newline;
        const part = bytes.subarray(start, end);
        if (!oversized) {
          if (pending.length + part.length > MAX_MCP_REQUEST_BYTES + 1) {
            oversized = true;
            pending = Buffer.alloc(0);
          } else {
            pending = Buffer.concat([pending, part]);
          }
        }
        if (newline < 0) break;
        if (pending.length > MAX_MCP_REQUEST_BYTES &&
            pending[pending.length - 1] !== 13) oversized = true;
        await handleFrame();
        start = newline + 1;
      }
    }
    if (pending.length || oversized) {
      if (pending.length > MAX_MCP_REQUEST_BYTES) oversized = true;
      await handleFrame();
    }
  } finally {
    input.off('data', onData);
    input.off('end', onInputEnd);
    input.off('error', onInputError);
    input.off('close', onInputClose);
    input.pause();
    if (output.errored && streamFailure === null) {
      await new Promise(resolve => process.nextTick(resolve));
    }
    output.off('error', onError);
    output.off('close', onClose);
  }
}

export async function runMcpStdioCli({
  input = process.stdin,
  output = process.stdout,
  stderr = process.stderr,
  env = process.env
} = {}) {
  if (env === null || typeof env !== 'object') {
    stderr.write('Invalid MCP repository enrollment.\n');
    return 1;
  }
  const rawEnrollment = env.SOFTWAREFACTORY_MCP_AUTHORIZED_REPOSITORIES;
  let authorizedRepositories = [{
    repositoryId: DEFAULT_FACTORY_SCOPE.repositoryId,
    repository: DEFAULT_FACTORY_SCOPE.repository
  }];
  let valid = true;
  if (rawEnrollment !== undefined) {
    if (typeof rawEnrollment !== 'string' ||
        Buffer.byteLength(rawEnrollment, 'utf8') > MAX_MCP_REQUEST_BYTES) {
      valid = false;
    } else {
      try {
        authorizedRepositories = JSON.parse(rawEnrollment);
        valid = validateMcpConnectorEnrollment(authorizedRepositories);
      } catch {
        valid = false;
      }
    }
  }
  if (!valid) {
    stderr.write('Invalid MCP repository enrollment.\n');
    return 1;
  }
  try {
    await startMcpStdioServer({ input, output, env, context: { authorizedRepositories } });
    return 0;
  } catch {
    stderr.write('MCP server stopped.\n');
    return 1;
  }
}

function resolveVerifiedCopilotBudget(input, authorValidation, reviewerValidation) {
  const copilotSideFailed =
    ((input.authorProvider === 'github-copilot' ||
      (isPlainObject(input.authorConfig) &&
       input.authorConfig.providerFamily === 'github-copilot')) &&
     !authorValidation.valid) ||
    ((input.reviewerProvider === 'github-copilot' ||
      (isPlainObject(input.reviewerConfig) &&
       input.reviewerConfig.providerFamily === 'github-copilot')) &&
     !reviewerValidation.valid);
  if (copilotSideFailed) {
    return undefined;
  }
  if (input.verifiedCopilotBudget !== undefined) {
    return input.verifiedCopilotBudget;
  }
  if (authorValidation.valid && authorValidation.providerFamily === 'github-copilot') {
    return input.authorConfig;
  }
  if (reviewerValidation.valid && reviewerValidation.providerFamily === 'github-copilot') {
    return input.reviewerConfig;
  }
  return undefined;
}

const crossModelDenied = (reason, rollbackState, details = {}) => Object.freeze({
  shadow: true,
  valid: false,
  eligible: false,
  liveDispatch: false,
  liveMerge: false,
  protocolVersion: CONNECTOR_PROTOCOL_VERSION,
  mode: details.mode === undefined ? 'independent-review' : details.mode,
  reason,
  failedSide: details.failedSide === undefined ? null : details.failedSide,
  rollbackActive: true,
  externalMergeGateAuthoritative: true,
  externalMergeAuthorityOnly: true,
  soleMergeEvaluators: SOLE_MERGE_EVALUATORS,
  allowDirectMergeOrPolicyWrite: false,
  syntheticApprovalAllowed: false,
  unapprovedSpendUsdCents: 0,
  authorValidation: details.authorValidation === undefined ? null : details.authorValidation,
  reviewerValidation: details.reviewerValidation === undefined ? null : details.reviewerValidation,
  rollbackState
});

export function evaluateCrossModelReviewEligibility(input) {
  if (!isPlainObject(input)) {
    return crossModelDenied(
      'INVALID_CROSS_MODEL_INPUT',
      createCopilotOnlyRollbackState('INVALID_CROSS_MODEL_INPUT')
    );
  }
  const inspectableObj = Object.fromEntries(
    Object.entries(input).filter(([key]) =>
      key !== 'rollbackReason' && key !== 'authorConfig' && key !== 'reviewerConfig')
  );
  const topTree = inspectBoundedPlainTree(inspectableObj);
  if (!topTree.valid) {
    return crossModelDenied(
      'INVALID_CROSS_MODEL_INPUT',
      createCopilotOnlyRollbackState('INVALID_CROSS_MODEL_INPUT')
    );
  }
  const rollbackRequested =
    input.killSwitch === true || input.stop === true || input.rollbackToCopilotOnly === true;
  const hasTopLevelSecret = topTree.hasSecret ||
    (!rollbackRequested &&
     typeof input.rollbackReason === 'string' &&
     input.rollbackReason.length <= MAX_MCP_REQUEST_BYTES &&
     containsSecretToken(input.rollbackReason));
  if (hasTopLevelSecret) {
    return crossModelDenied(
      'SECRET_MATERIAL_REJECTED',
      createCopilotOnlyRollbackState('SECRET_MATERIAL_REJECTED')
    );
  }
  if (Object.keys(input).some(key => !ALLOWED_CROSS_MODEL_KEYS.has(key)) ||
      (input.killSwitch !== undefined && typeof input.killSwitch !== 'boolean') ||
      (input.stop !== undefined && typeof input.stop !== 'boolean') ||
      (input.rollbackToCopilotOnly !== undefined && typeof input.rollbackToCopilotOnly !== 'boolean') ||
      (input.rollbackReason !== undefined && typeof input.rollbackReason !== 'string') ||
      (!rollbackRequested &&
       input.rollbackReason !== undefined &&
       !isSafeText(input.rollbackReason, 160)) ||
      (input.verifiedCopilotBudget !== undefined && !isPlainObject(input.verifiedCopilotBudget)) ||
      (input.headSha !== undefined && !isSha40(input.headSha))) {
    return crossModelDenied(
      'INVALID_CROSS_MODEL_INPUT',
      createCopilotOnlyRollbackState('INVALID_CROSS_MODEL_INPUT')
    );
  }
  const mode = input.mode === undefined ? 'independent-review' : input.mode;
  if (!CROSS_MODEL_MODES.includes(mode)) {
    return crossModelDenied(
      'INVALID_CROSS_MODEL_MODE',
      createCopilotOnlyRollbackState('INVALID_CROSS_MODEL_MODE')
    );
  }

  const authorValidation = validateMultiAgentConnectorConfig(input.authorConfig);
  const reviewerValidation = validateMultiAgentConnectorConfig(input.reviewerConfig);
  const verifiedCopilotSource = resolveVerifiedCopilotBudget(
    input,
    authorValidation,
    reviewerValidation
  );
  if (authorValidation.reason === 'SECRET_MATERIAL_REJECTED') {
    return crossModelDenied(
      'SECRET_MATERIAL_REJECTED',
      createCopilotOnlyRollbackState('SECRET_MATERIAL_REJECTED', verifiedCopilotSource),
      { mode, failedSide: 'author', authorValidation, reviewerValidation }
    );
  }
  if (reviewerValidation.reason === 'SECRET_MATERIAL_REJECTED') {
    return crossModelDenied(
      'SECRET_MATERIAL_REJECTED',
      createCopilotOnlyRollbackState('SECRET_MATERIAL_REJECTED', verifiedCopilotSource),
      { mode, failedSide: 'reviewer', authorValidation, reviewerValidation }
    );
  }

  if (input.externalMergeGateAuthoritative !== true) {
    return crossModelDenied(
      'EXTERNAL_MERGE_AUTHORITY_REQUIRED',
      createCopilotOnlyRollbackState('EXTERNAL_MERGE_AUTHORITY_REQUIRED', verifiedCopilotSource),
      { mode, authorValidation, reviewerValidation }
    );
  }
  if (input.killSwitch === true || input.stop === true) {
    const rb = createCopilotOnlyRollbackState(
      input.rollbackReason === undefined ? 'CONNECTOR_STOPPED' : input.rollbackReason,
      verifiedCopilotSource
    );
    return crossModelDenied('CONNECTOR_STOPPED', rb, { mode, authorValidation, reviewerValidation });
  }
  if (input.rollbackToCopilotOnly === true) {
    const rb = createCopilotOnlyRollbackState(input.rollbackReason, verifiedCopilotSource);
    return crossModelDenied(rb.reason, rb, { mode, authorValidation, reviewerValidation });
  }
  if (input.verifiedCopilotBudget !== undefined &&
      !isVerifiedCopilotBudgetConfig(input.verifiedCopilotBudget)) {
    return crossModelDenied(
      'INVALID_VERIFIED_COPILOT_BUDGET',
      createCopilotOnlyRollbackState('INVALID_VERIFIED_COPILOT_BUDGET'),
      { mode, authorValidation, reviewerValidation }
    );
  }
  if (!SUPPORTED_PROVIDER_FAMILIES.includes(input.authorProvider) ||
      !SUPPORTED_PROVIDER_FAMILIES.includes(input.reviewerProvider)) {
    return crossModelDenied(
      'UNSUPPORTED_PROVIDER_FAMILY',
      createCopilotOnlyRollbackState('UNSUPPORTED_PROVIDER_FAMILY', verifiedCopilotSource),
      { mode, authorValidation, reviewerValidation }
    );
  }
  if (!isModelFamily(input.authorModelFamily) || !isModelFamily(input.reviewerModelFamily)) {
    return crossModelDenied(
      'INVALID_MODEL_FAMILY',
      createCopilotOnlyRollbackState('INVALID_MODEL_FAMILY', verifiedCopilotSource),
      { mode, authorValidation, reviewerValidation }
    );
  }
  if ((input.authorIdentity !== undefined && !isActorIdentity(input.authorIdentity)) ||
      (input.reviewerIdentity !== undefined && !isActorIdentity(input.reviewerIdentity))) {
    return crossModelDenied(
      'INVALID_ACTOR_IDENTITY',
      createCopilotOnlyRollbackState('INVALID_ACTOR_IDENTITY', verifiedCopilotSource),
      { mode, authorValidation, reviewerValidation }
    );
  }
  if (input.authorIdentity !== undefined &&
      input.reviewerIdentity !== undefined &&
      input.authorIdentity.toLowerCase() === input.reviewerIdentity.toLowerCase()) {
    return crossModelDenied(
      'SELF_IDENTITY_REVIEW_FORBIDDEN',
      createCopilotOnlyRollbackState('SELF_IDENTITY_REVIEW_FORBIDDEN', verifiedCopilotSource),
      { mode, authorValidation, reviewerValidation }
    );
  }
  if (!authorValidation.valid) {
    return crossModelDenied(
      authorValidation.reason,
      createCopilotOnlyRollbackState(authorValidation.reason, verifiedCopilotSource),
      { mode, failedSide: 'author', authorValidation, reviewerValidation }
    );
  }
  if (!reviewerValidation.valid) {
    return crossModelDenied(
      reviewerValidation.reason,
      createCopilotOnlyRollbackState(reviewerValidation.reason, verifiedCopilotSource),
      { mode, failedSide: 'reviewer', authorValidation, reviewerValidation }
    );
  }
  if (authorValidation.providerFamily !== input.authorProvider ||
      reviewerValidation.providerFamily !== input.reviewerProvider) {
    return crossModelDenied(
      'PROVIDER_CONFIG_MISMATCH',
      createCopilotOnlyRollbackState('PROVIDER_CONFIG_MISMATCH', verifiedCopilotSource),
      { mode, authorValidation, reviewerValidation }
    );
  }

  const normalizedAuthorModel = input.authorModelFamily.toLowerCase();
  const normalizedReviewerModel = input.reviewerModelFamily.toLowerCase();
  const crossProvider = input.reviewerProvider !== input.authorProvider;
  const crossModelFamily = normalizedReviewerModel !== normalizedAuthorModel;
  if (!crossProvider && !crossModelFamily) {
    return crossModelDenied(
      'SELF_MODEL_REVIEW_FORBIDDEN',
      createCopilotOnlyRollbackState('SELF_MODEL_REVIEW_FORBIDDEN', verifiedCopilotSource),
      { mode, authorValidation, reviewerValidation }
    );
  }
  if (authorValidation.role === 'independent-reviewer') {
    return crossModelDenied(
      'INVALID_AUTHOR_ROLE',
      createCopilotOnlyRollbackState('INVALID_AUTHOR_ROLE', verifiedCopilotSource),
      { mode, failedSide: 'author', authorValidation, reviewerValidation }
    );
  }
  const expectedTargetRole = mode === 'independent-review' ? 'independent-reviewer' : 'specialist';
  if (reviewerValidation.role !== expectedTargetRole) {
    return crossModelDenied(
      'INVALID_REVIEWER_ROLE',
      createCopilotOnlyRollbackState('INVALID_REVIEWER_ROLE', verifiedCopilotSource),
      { mode, failedSide: 'reviewer', authorValidation, reviewerValidation }
    );
  }

  const allHeads = [input.headSha, input.authorConfig.headSha, input.reviewerConfig.headSha];
  const suppliedHeads = allHeads.filter(sha => sha !== undefined);
  if (new Set(suppliedHeads).size > 1) {
    return crossModelDenied(
      'CROSS_MODEL_HEAD_MISMATCH',
      createCopilotOnlyRollbackState('CROSS_MODEL_HEAD_MISMATCH', verifiedCopilotSource),
      { mode, authorValidation, reviewerValidation }
    );
  }
  if (mode === 'independent-review' && allHeads.some(sha => sha === undefined)) {
    return crossModelDenied(
      'CANDIDATE_HEAD_SHA_REQUIRED',
      createCopilotOnlyRollbackState('CANDIDATE_HEAD_SHA_REQUIRED', verifiedCopilotSource),
      { mode, authorValidation, reviewerValidation }
    );
  }
  const effectiveHeadSha = suppliedHeads.length > 0 ? suppliedHeads[0] : null;

  return Object.freeze({
    shadow: true,
    valid: true,
    eligible: true,
    liveDispatch: false,
    liveMerge: false,
    protocolVersion: CONNECTOR_PROTOCOL_VERSION,
    mode,
    reason: mode === 'independent-review'
      ? 'CROSS_MODEL_REVIEW_ELIGIBLE'
      : 'SPECIALIST_FALLBACK_ELIGIBLE',
    failedSide: null,
    rollbackActive: false,
    crossProvider,
    crossModelFamily,
    authorProvider: input.authorProvider,
    authorModelFamily: normalizedAuthorModel,
    reviewerProvider: input.reviewerProvider,
    reviewerModelFamily: normalizedReviewerModel,
    headSha: effectiveHeadSha,
    externalMergeGateAuthoritative: true,
    externalMergeAuthorityOnly: true,
    soleMergeEvaluators: SOLE_MERGE_EVALUATORS,
    allowDirectMergeOrPolicyWrite: false,
    syntheticApprovalAllowed: false,
    unapprovedSpendUsdCents: 0,
    telemetryExportAllowed: false,
    authorValidation,
    reviewerValidation,
    rollbackState: createCopilotOnlyRollbackState('ROLLBACK_READY', verifiedCopilotSource)
  });
}
