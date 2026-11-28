import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import {
  defaultSoftwareFactoryTestInventory
} from '../../tools/engineering-factory/contract-routing.mjs';
import { buildReadOnlyOnboardingPlan, evaluateConsumerOnboardingSuccess } from '../../tools/engineering-factory/consumer-onboarding.mjs';
import {
  CONNECTOR_PROTOCOL_VERSION,
  CONNECTOR_ROLES,
  CROSS_MODEL_MODES,
  FORBIDDEN_CONTROL_PLANE_PATHS,
  MAX_MCP_FRAMED_LINES,
  MAX_MCP_REQUEST_BYTES,
  MCP_CONNECTOR_TOOLS,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  PROVIDER_ADAPTERS,
  SUPPORTED_PROVIDER_FAMILIES,
  createCopilotOnlyRollbackState,
  evaluateCrossModelReviewEligibility,
  handleMcpConnectorRequest,
  isValidTraceparent,
  processMcpFramedMessages,
  startMcpStdioServer,
  validateMcpConnectorEnrollment,
  validateMultiAgentConnectorConfig
} from '../../tools/engineering-factory/mcp-agent-connector.mjs';

const HEAD_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const OTHER_SHA = 'c'.repeat(40);
const VALID_TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const FACTORY_REPO_ID = 1471342715;
const CONSUMER_REPO_ID = 22001100;
const NOW_MS = 1_795_740_000_000;

const mcpCall = (name, args, context = authorizedContext()) => handleMcpConnectorRequest({
  jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args }
}, context).result;

test('new read-only tools enforce enrollment, trusted lanes, identities and stricter coverage', () => {
  const task = { id: 1, lane: 'api', state: 'approved', priority: 1, dependencies: [], paths: ['src/api/x.mjs'] };
  const plan = mcpCall('plan_disjoint_lanes', { repositoryId: CONSUMER_REPO_ID, tasks: [task] });
  assert.equal(plan.isError, false);
  assert.equal(plan.structuredContent.reason, 'SHADOW_PLAN');
  assert.equal(plan.structuredContent.scheduled.length, 1);
  assert.equal(mcpCall('plan_disjoint_lanes', { repositoryId: CONSUMER_REPO_ID, tasks: [{ ...task, dependencies: [1] }] }).structuredContent.reason, 'DEPENDENCY_CYCLE');
  assert.equal(mcpCall('plan_disjoint_lanes', { repositoryId: CONSUMER_REPO_ID, tasks: [{ ...task, paths: ['.github/workflows/x.yml'] }] }).structuredContent.reason, 'INVALID_OR_PROTECTED_PATH');
  assert.equal(mcpCall('plan_disjoint_lanes', { repositoryId: CONSUMER_REPO_ID, tasks: [{ ...task, paths: ['src/api/build.lock.yml'] }] }).structuredContent.reason, 'INVALID_OR_PROTECTED_PATH');
  for (const path of ['src/api', 'src/api/build.v1']) {
    assert.equal(mcpCall('plan_disjoint_lanes', { repositoryId: CONSUMER_REPO_ID, tasks: [{ ...task, paths: [path] }] }).structuredContent.reason, 'TRUSTED_FILE_INVENTORY_REQUIRED');
  }
  const noInventory = authorizedContext();
  delete noInventory.authorizedRepositories[1].trustedFiles;
  assert.equal(mcpCall('plan_disjoint_lanes', { repositoryId: CONSUMER_REPO_ID, tasks: [task] }, noInventory).structuredContent.reason, 'TRUSTED_FILE_INVENTORY_REQUIRED');
  assert.equal(mcpCall('plan_disjoint_lanes', {
    repositoryId: CONSUMER_REPO_ID, tasks: [task], trustedFiles: ['src/api/x.mjs']
  }, noInventory).structuredContent.reason, 'INVALID_PLAN_ARGUMENTS');
  assert.equal(mcpCall('plan_disjoint_lanes', { repositoryId: CONSUMER_REPO_ID, tasks: [],
    active: [{ id: 2, lane: 'api', paths: ['src/api/build.v1'] }]
  }).structuredContent.reason, 'TRUSTED_FILE_INVENTORY_REQUIRED');
  assert.equal(mcpCall('plan_disjoint_lanes', { repositoryId: CONSUMER_REPO_ID, tasks: [], active: [{ id: 2, lane: 'api', paths: ['src/api/build.lock.yml'] }] }).structuredContent.reason, 'INVALID_OR_PROTECTED_PATH');
  assert.equal(mcpCall('plan_disjoint_lanes', { repositoryId: FACTORY_REPO_ID, tasks: [] }).structuredContent.reason, 'NO_READY_WORK');
  assert.equal(mcpCall('plan_disjoint_lanes', { repositoryId: 1, tasks: [] }).structuredContent.reason, 'UNAUTHORIZED_REPOSITORY');
  assert.equal(mcpCall('plan_disjoint_lanes', { repositoryId: CONSUMER_REPO_ID, tasks: [] }, {}).structuredContent.reason, 'AUTHORIZATION_CONTEXT_INVALID');
  assert.equal(mcpCall('plan_disjoint_lanes', { repositoryId: CONSUMER_REPO_ID }, authorizedContext()).structuredContent.reason, 'INVALID_PLAN_ARGUMENTS');
  const discovery = {
    repository: 'Synthetic/Spellbook', repositoryId: CONSUMER_REPO_ID,
    pinnedFactorySha: 'afc3d223f287b029db32672908097efc67a259c9',
    stackProfile: 'baseline-95-90'
  };
  const onboarding = mcpCall('build_consumer_onboarding_plan', { repositoryId: CONSUMER_REPO_ID, discovery });
  assert.equal(onboarding.isError, true);
  assert.equal(onboarding.structuredContent.reason, 'LOCAL_GATE_BELOW_ENROLLMENT');
  const factoryOnly = { authorizedRepositories: [{ repositoryId: FACTORY_REPO_ID, repository: 'Jamula/SoftwareFactory' }] };
  assert.equal(mcpCall('build_consumer_onboarding_plan', { repositoryId: CONSUMER_REPO_ID, discovery }, factoryOnly).structuredContent.reason, 'UNAUTHORIZED_REPOSITORY');
  assert.equal(mcpCall('build_consumer_onboarding_plan', {
    repositoryId: CONSUMER_REPO_ID, discovery, authorizedRepositories: authorizedContext().authorizedRepositories
  }, factoryOnly).structuredContent.reason, 'UNAUTHORIZED_REPOSITORY');
  const strictProfile = mcpCall('build_consumer_onboarding_plan', {
    repositoryId: CONSUMER_REPO_ID, discovery: { ...discovery, stackProfile: 'strict-up-to-date-migration-gated' }
  });
  assert.equal(strictProfile.structuredContent.reason, 'DEFAULT_BRANCH_MISMATCH');
  const existing = mcpCall('build_consumer_onboarding_plan', {
    repositoryId: CONSUMER_REPO_ID,
    discovery: { ...discovery, discoveredRepository: {
      defaultBranch: 'main', mergeMethod: 'squash', checks: [{ name: 'build-test', appId: 12345 }],
      reviewers: ['synthetic-reviewer'], owners: [{ prefix: 'src/', owner: 'synthetic-owner' }],
      coverage: { line: 99, branch: 93 }, maxConcurrency: 1, existingFiles: []
    } }
  });
  assert.equal(existing.isError, false);
  assert.deepEqual(existing.structuredContent.plan.policy.coverage, { line: 99, branch: 93 });
  assert.equal(existing.structuredContent.plan.localGates.minBranchCoverage, 93);
  const missingEvidence = structuredClone(discovery);
  missingEvidence.stricterCoverageThresholds = { line: 98, branch: 95 };
  assert.equal(mcpCall('build_consumer_onboarding_plan', { repositoryId: CONSUMER_REPO_ID, discovery: missingEvidence }).structuredContent.reason, 'LOCAL_GATE_BELOW_ENROLLMENT');
  assert.equal(mcpCall('build_consumer_onboarding_plan', { repositoryId: CONSUMER_REPO_ID, discovery: { ...discovery, repository: 'Other/Repo' } }).structuredContent.reason, 'INVALID_ONBOARDING_ARGUMENTS');
  assert.equal(mcpCall('build_consumer_onboarding_plan', { repositoryId: CONSUMER_REPO_ID, discovery: { ...discovery, stricterCoverageThresholds: { line: 95, branch: 90 } } }).structuredContent.reason, 'COVERAGE_FLOOR_VIOLATION');
  assert.equal(mcpCall('build_consumer_onboarding_plan', { repositoryId: CONSUMER_REPO_ID, discovery, success: {} }).isError, true);
  const selection = {
    repositoryId: CONSUMER_REPO_ID, repositorySlug: 'Synthetic/Spellbook', expectedHeadSha: HEAD_SHA,
    nowMs: NOW_MS, targetComponent: 'api', specialistRole: 'api',
    changedPaths: ['src/api/x.mjs'], guidanceEntries: [], curatedLessons: []
  };
  const selected = mcpCall('select_scoped_guidance_and_lessons', selection);
  assert.equal(selected.isError, false);
  assert.deepEqual(selected.structuredContent.effectiveGates, { minLineCoveragePct: 97, minBranchCoveragePct: 92 });
  assert.equal(mcpCall('select_scoped_guidance_and_lessons', { ...selection, repositorySlug: 'Other/Repo' }).structuredContent.reason, 'CROSS_REPO_ACCESS_DENIED');
  assert.equal(mcpCall('select_scoped_guidance_and_lessons', { ...selection, expectedHeadSha: OTHER_SHA }).structuredContent.reason, 'STALE_CONTEXT');
  assert.equal(mcpCall('select_scoped_guidance_and_lessons', { ...selection, policy: { minLineCoveragePct: 95 } }).structuredContent.reason, 'COVERAGE_FLOOR_VIOLATION');
  assert.equal(mcpCall('select_scoped_guidance_and_lessons', { ...selection, policy: [] }).structuredContent.reason, 'INVALID_SELECTION_INPUT');
  assert.equal(mcpCall('select_scoped_guidance_and_lessons', { ...selection, guidanceEntries: [{ text: 'gh' + 'p_fake' }] }).structuredContent.reason, 'INVALID_OR_SECRET_ARGUMENTS');
  assert.equal(mcpCall('get_factory_board_snapshot', { repositoryId: FACTORY_REPO_ID }).structuredContent.reason, 'BOARD_TRANSPORT_REQUIRED');
  assert.equal(mcpCall('get_factory_board_snapshot', { repositoryId: FACTORY_REPO_ID, repository: 'Other/Repo' }).structuredContent.reason, 'INVALID_BOARD_ARGUMENTS');
});

test('all advertised array schemas declare item types', () => {
  const visit = schema => {
    if (schema.type === 'array') {
      assert.ok(schema.items, 'array items are required by MCP clients');
      visit(schema.items);
    }
    if (schema.properties) Object.values(schema.properties).forEach(visit);
  };
  for (const tool of MCP_CONNECTOR_TOOLS) visit(tool.inputSchema);
});

function syntheticOnboardingPackage(repository, repositoryId, localLine = 98, localBranch = 95, stackProfile = 'baseline-95-90', policyOverrides = {}) {
  const plan = buildReadOnlyOnboardingPlan({
    repository, repositoryId, pinnedFactorySha: 'afc3d223f287b029db32672908097efc67a259c9',
    stackProfile, stricterCoverageThresholds: stackProfile === 'baseline-95-90'
      ? { line: 98, branch: 95 } : { line: 100, branch: 100 }
  });
  assert.equal(plan.valid, true);
  const policy = { ...structuredClone(plan.policy), ...policyOverrides };
  const candidate = {
    policySource: 'trusted-default-branch', repository, issue: 10, pr: 20,
    head: HEAD_SHA, observedHead: HEAD_SHA, base: BASE_SHA, observedBase: BASE_SHA,
    baseBranch: policy.defaultBranch, rateLimited: false, remainingCredits: 25, activeCount: 0,
    providerReady: true, risk: 'low', priority: 1, paths: [`${policy.owners[0].prefix}index.ts`],
    dependencies: [], acceptanceComplete: true, baseCompatible: true, mainHealthy: true,
    threadsResolved: true, securityClear: true,
    coverage: { head: HEAD_SHA, ...policy.coverage, complete: true },
    checks: policy.checks.map(check => ({ ...check, head: HEAD_SHA, status: 'completed', conclusion: 'success' })),
    author: 'synthetic-author', agent: 'synthetic-agent',
    reviews: [{ reviewer: policy.reviewers[0], head: HEAD_SHA, state: 'APPROVED' }]
  };
  const credentialId = plan.rollbackPlan.revokeCredentialId;
  return {
    contractVersion: plan.contractVersion, repositoryId, stackProfile: plan.stackProfile,
    ownerAuthorized: true, migrationFreezeClear: true, autoActivate: false, productionDeployEnabled: false,
    workflowPin: structuredClone(plan.workflowPin), policy,
    localGates: { ...structuredClone(plan.localGates), minLineCoverage: localLine, minBranchCoverage: localBranch },
    credentials: {
      credentialId, scope: 'repo-read-only-shadow', allowedRepositories: [repository],
      sharedAdminToken: false, persistedInCheckout: false
    },
    replaySuite: {
      eligibleCandidate: candidate,
      staleReview: { ...candidate, reviews: [{ reviewer: policy.reviewers[0], head: BASE_SHA, state: 'APPROVED' }] },
      dismissedReview: { ...candidate, reviews: [{ reviewer: policy.reviewers[0], head: HEAD_SHA, state: 'DISMISSED' }] },
      commentedBotReview: { ...candidate, reviews: [{ reviewer: 'copilot-pull-request-reviewer[bot]', head: HEAD_SHA, state: 'COMMENTED', summaryDisposition: 'clear' }] },
      wrongRepository: { ...candidate, repository: 'Synthetic/Foreign' },
      missingQuota: { ...candidate, remainingCredits: 0 },
      killSwitchPolicy: { ...policy, mode: 'shadow', killSwitch: true }
    },
    rollback: {
      disableMode: 'disabled', killSwitch: true, revokeCredentialId: credentialId,
      revertWorkflowPinPrRequired: true, queuedLiveMutations: 0
    }
  };
}

function syntheticSuccess(pkg, peer) {
  return {
    synthetic: true, onboardingPrMerged: true,
    usability: {
      mandatorySettingsCount: 4, generatedFileCount: 2, discoveryAndPlanDurationMs: 15,
      basicIntegrationDurationMs: 300000, overwrittenExistingFiles: 0, competingBacklogsCreated: 0,
      mandatoryExternalServices: 0, incrementalBilledUsdCents: 0
    },
    governance: {
      authoritativeBacklog: 'github-issues', allowCommentedBotApproval: false,
      independentApprovedReviewRequired: true, perRepoAiCreditHardStop: true, paidOverageAllowed: false
    },
    existingGates: {
      lineCoverage: 95, branchCoverage: 90, requiredChecks: pkg.localGates.requiredChecks, maxConcurrency: 1
    },
    onboardingPackage: pkg,
    peerRegistry: [{ repository: peer.policy.repository, repositoryId: peer.repositoryId, credentialId: peer.credentials.credentialId }],
    rollbackProof: {
      commitsToRevert: 1, factoryRepositoryUntouched: true,
      rollbackReceipt: {
        repository: pkg.policy.repository, postPolicy: structuredClone(pkg.policy),
        revokedCredentialId: pkg.credentials.credentialId, pinRevertedViaReviewedPr: true, queuedLiveMutations: 0
      },
      cohortPackages: [structuredClone(pkg), structuredClone(peer)]
    }
  };
}

test('onboarding success preserves enrolled local gates and accepts only safe credential metadata', () => {
  const peer = syntheticOnboardingPackage('Synthetic/Peer', CONSUMER_REPO_ID + 1);
  const weak = syntheticOnboardingPackage('Synthetic/Spellbook', CONSUMER_REPO_ID, 96, 91);
  const success = syntheticSuccess(weak, peer);
  assert.equal(evaluateConsumerOnboardingSuccess(success).valid, true);
  const discovery = {
    repository: weak.policy.repository, repositoryId: CONSUMER_REPO_ID,
    pinnedFactorySha: 'afc3d223f287b029db32672908097efc67a259c9', stackProfile: 'baseline-95-90',
    discoveredRepository: {
      defaultBranch: 'main', mergeMethod: 'squash', checks: [{ name: 'build-test', appId: 12345 }],
      reviewers: ['synthetic-reviewer'], owners: [{ prefix: 'src/', owner: 'synthetic-owner' }],
      coverage: { line: 97, branch: 92 }, maxConcurrency: 1, existingFiles: []
    }
  };
  const args = { repositoryId: CONSUMER_REPO_ID, discovery, success };
  assert.equal(mcpCall('build_consumer_onboarding_plan', args).structuredContent.reason, 'ONBOARDING_IDENTITY_OR_GATE_MISMATCH');
  for (const [line, branch] of [[96, 92], [97, 91]]) {
    const weakGate = syntheticOnboardingPackage('Synthetic/Spellbook', CONSUMER_REPO_ID, line, branch);
    assert.equal(mcpCall('build_consumer_onboarding_plan', { ...args, success: syntheticSuccess(weakGate, peer) }).structuredContent.reason, 'ONBOARDING_IDENTITY_OR_GATE_MISMATCH');
    const partial = { ...syntheticSuccess(weakGate, peer), requireAutonomousAcceptance: true };
    assert.equal(evaluateConsumerOnboardingSuccess(partial).shadowOnboarded, true);
    assert.equal(mcpCall('build_consumer_onboarding_plan', { ...args, success: partial }).structuredContent.reason, 'ONBOARDING_IDENTITY_OR_GATE_MISMATCH');
  }
  const good = syntheticOnboardingPackage('Synthetic/Spellbook', CONSUMER_REPO_ID, 97, 92);
  const accepted = mcpCall('build_consumer_onboarding_plan', { ...args, success: syntheticSuccess(good, peer) });
  assert.equal(accepted.isError, false);
  assert.equal(accepted.structuredContent.success.valid, true);
  assert.equal(accepted.structuredContent.success.accepted, false);
  const validPartial = mcpCall('build_consumer_onboarding_plan', { ...args, success: {
    ...syntheticSuccess(good, peer), requireAutonomousAcceptance: true
  } });
  assert.equal(validPartial.isError, true);
  assert.equal(validPartial.structuredContent.success.shadowOnboarded, true);
  assert.equal(validPartial.structuredContent.success.reason, 'AUTONOMOUS_PROOF_REQUIRED');
  for (const changed of [
    { coverage: { line: 99, branch: 92 } },
    { coverage: { line: 97, branch: 93 } },
    { checks: [{ name: 'build-test', appId: 12345 }, { name: 'additional-gate', appId: 555 }] }
  ]) {
    const stricter = { ...discovery, discoveredRepository: { ...discovery.discoveredRepository, ...changed } };
    for (const proof of [syntheticSuccess(good, peer), { ...syntheticSuccess(good, peer), requireAutonomousAcceptance: true }]) {
      assert.equal(mcpCall('build_consumer_onboarding_plan', { ...args, discovery: stricter, success: proof }).structuredContent.reason, 'ONBOARDING_IDENTITY_OR_GATE_MISMATCH');
    }
  }
  const loose = syntheticOnboardingPackage('Synthetic/Spellbook', CONSUMER_REPO_ID, 97, 92);
  loose.localGates.maxConcurrency = 2;
  const looseSuccess = syntheticSuccess(loose, peer);
  looseSuccess.existingGates.maxConcurrency = 2;
  assert.equal(evaluateConsumerOnboardingSuccess(looseSuccess).valid, true);
  assert.equal(mcpCall('build_consumer_onboarding_plan', { ...args, success: looseSuccess }).structuredContent.reason, 'ONBOARDING_IDENTITY_OR_GATE_MISMATCH');
  const invalidPlan = { ...discovery, pinnedFactorySha: HEAD_SHA };
  assert.equal(mcpCall('build_consumer_onboarding_plan', { ...args, discovery: invalidPlan, success: syntheticSuccess(good, peer) }).structuredContent.reason, 'ONBOARDING_IDENTITY_OR_GATE_MISMATCH');
  const wrongBranch = syntheticOnboardingPackage('Synthetic/Spellbook', CONSUMER_REPO_ID, 100, 100, 'strict-up-to-date-migration-gated');
  const branchSuccess = syntheticSuccess(wrongBranch, peer);
  assert.equal(evaluateConsumerOnboardingSuccess(branchSuccess).valid, true);
  assert.equal(mcpCall('build_consumer_onboarding_plan', { ...args, success: branchSuccess }).structuredContent.reason, 'ONBOARDING_IDENTITY_OR_GATE_MISMATCH');
  const other = syntheticOnboardingPackage('Synthetic/Other', CONSUMER_REPO_ID + 2, 97, 92);
  assert.equal(mcpCall('build_consumer_onboarding_plan', { ...args, success: {
    ...syntheticSuccess(other, peer), requireAutonomousAcceptance: true
  } }).structuredContent.reason, 'ONBOARDING_IDENTITY_OR_GATE_MISMATCH');
  for (const policyOverrides of [
    { reviewers: ['synthetic-unapproved-reviewer'] },
    { reviewers: ['synthetic-reviewer', 'synthetic-unapproved-reviewer'] },
    { owners: [{ prefix: 'src/', owner: 'synthetic-unapproved-owner' }] },
    { owners: [{ prefix: 'src/', owner: 'synthetic-owner' }, { prefix: 'other/', owner: 'synthetic-other-owner' }] },
    { mergeMethod: 'merge' },
    { creditLimit: 101 },
    { riskClasses: ['low', 'high', 'extra-risk'] }
  ]) {
    const changed = syntheticOnboardingPackage('Synthetic/Spellbook', CONSUMER_REPO_ID, 97, 92, 'baseline-95-90', policyOverrides);
    for (const proof of [syntheticSuccess(changed, peer), { ...syntheticSuccess(changed, peer), requireAutonomousAcceptance: true }]) {
      const evaluated = evaluateConsumerOnboardingSuccess(proof);
      assert.equal(evaluated.valid || evaluated.shadowOnboarded, true);
      assert.equal(mcpCall('build_consumer_onboarding_plan', { ...args, success: proof }).structuredContent.reason, 'ONBOARDING_IDENTITY_OR_GATE_MISMATCH');
    }
  }
  const caseOnly = syntheticOnboardingPackage('Synthetic/Spellbook', CONSUMER_REPO_ID, 97, 92, 'baseline-95-90', { reviewers: ['SYNTHETIC-REVIEWER'] });
  assert.equal(mcpCall('build_consumer_onboarding_plan', { ...args, success: syntheticSuccess(caseOnly, peer) }).isError, false);
  const alternateProfile = syntheticOnboardingPackage('Synthetic/Spellbook', CONSUMER_REPO_ID, 97, 92, 'web-genealogy-95-90');
  assert.equal(evaluateConsumerOnboardingSuccess(syntheticSuccess(alternateProfile, peer)).valid, true);
  assert.equal(mcpCall('build_consumer_onboarding_plan', { ...args, success: syntheticSuccess(alternateProfile, peer) }).structuredContent.reason, 'ONBOARDING_IDENTITY_OR_GATE_MISMATCH');
  const alternatePin = { ...discovery, pinnedFactorySha: HEAD_SHA, pinnedCheckoutSha: BASE_SHA, observedCheckoutRef: BASE_SHA };
  assert.equal(buildReadOnlyOnboardingPlan(alternatePin).valid, true);
  assert.equal(mcpCall('build_consumer_onboarding_plan', { ...args, discovery: alternatePin, success: syntheticSuccess(good, peer) }).structuredContent.reason, 'ONBOARDING_IDENTITY_OR_GATE_MISMATCH');
  const bad = syntheticSuccess(good, peer);
  bad.onboardingPackage.credentials.sharedAdminToken = true;
  assert.equal(mcpCall('build_consumer_onboarding_plan', { ...args, success: bad }).structuredContent.reason, 'INVALID_OR_SECRET_ARGUMENTS');
  const secret = syntheticSuccess(good, peer);
  secret.onboardingPackage.credentials.credentialId = 'gh' + 'p_fake';
  assert.equal(mcpCall('build_consumer_onboarding_plan', { ...args, success: secret }).structuredContent.reason, 'INVALID_OR_SECRET_ARGUMENTS');
  const collision = syntheticSuccess(good, peer);
  collision.onboardingPackage.credentialMetadata = { value: 'gh' + 'p_fake' };
  assert.equal(mcpCall('build_consumer_onboarding_plan', { ...args, success: collision }).structuredContent.reason, 'INVALID_OR_SECRET_ARGUMENTS');
});

test('operator enrollment is structurally validated without weakening repository boundaries', () => {
  const entries = authorizedContext().authorizedRepositories;
  assert.equal(validateMcpConnectorEnrollment(entries), true);
  assert.equal(validateMcpConnectorEnrollment(null), false);
  assert.equal(validateMcpConnectorEnrollment([]), false);
  assert.equal(validateMcpConnectorEnrollment([{ repositoryId: FACTORY_REPO_ID, repository: 'Synthetic/Other' }]), false);
  assert.equal(validateMcpConnectorEnrollment([{ ...entries[1], coverage: { line: 94, branch: 90 } }]), false);
  assert.equal(validateMcpConnectorEnrollment([{ ...entries[1], projectConfig: {} }]), false);
  assert.equal(validateMcpConnectorEnrollment([{ ...entries[1], lanes: [{ id: 'api', specialist: 'api', owners: ['src/api'] }] }]), true);
  assert.equal(validateMcpConnectorEnrollment([{ ...entries[1], lanes: [] }]), false);
  for (const trustedFiles of [['src/api/work.lock.yml'], ['src/api', 'src/api/nested.mjs'], ['src/api/x.mjs', 'src/api/x.mjs'], [null], ['.github/workflows/test.yml']]) {
    assert.equal(validateMcpConnectorEnrollment([{ ...entries[1], trustedFiles }]), false);
  }
  assert.equal(validateMcpConnectorEnrollment([{ ...entries[1], projectConfig: { ...entries[1].projectConfig, project: { ...entries[1].projectConfig.project, repository: 'Synthetic/Other' } } }]), false);
  assert.equal(validateMcpConnectorEnrollment([{ ...entries[1], revision: 'gh' + 'p_fake' }]), false);
});

test('CLI accepts only trusted bounded enrollment and rejects malformed configuration without leaking input', () => {
  const variable = 'SOFTWAREFACTORY_MCP_AUTHORIZED_REPOSITORIES';
  const invoke = (value, requests) => {
    const env = { ...process.env };
    delete env[variable];
    if (value !== undefined) env[variable] = value;
    return spawnSync(process.execPath, ['bin/softwarefactory-mcp.mjs'], {
      env, encoding: 'utf8', input: requests.map(request => JSON.stringify(request)).join('\n') + '\n'
    });
  };
  const discovery = {
    repository: 'Synthetic/Spellbook', repositoryId: CONSUMER_REPO_ID,
    pinnedFactorySha: 'afc3d223f287b029db32672908097efc67a259c9', stackProfile: 'strict-up-to-date-migration-gated'
  };
  const call = {
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'build_consumer_onboarding_plan', arguments: { repositoryId: CONSUMER_REPO_ID, discovery } }
  };
  const defaults = invoke(undefined, [call]);
  assert.equal(defaults.status, 0);
  assert.equal(defaults.stderr, '');
  assert.equal(JSON.parse(defaults.stdout).result.structuredContent.reason, 'UNAUTHORIZED_REPOSITORY');
  const entries = [{ repositoryId: CONSUMER_REPO_ID, repository: 'Synthetic/Spellbook', defaultBranch: 'trunk', coverage: { line: 97, branch: 92 } }];
  const enrolled = invoke(JSON.stringify(entries), [call]);
  assert.equal(enrolled.status, 0);
  assert.equal(enrolled.stderr, '');
  assert.deepEqual(JSON.parse(enrolled.stdout).result.structuredContent.plan.policy.coverage, { line: 100, branch: 100 });
  const injected = structuredClone(call);
  injected.params.arguments.authorizedRepositories = entries;
  assert.equal(JSON.parse(invoke(undefined, [injected]).stdout).result.structuredContent.reason, 'UNAUTHORIZED_REPOSITORY');
  const confidential = 'gh' + 'p_fake';
  for (const raw of [
    '', '{' + confidential, 'null', '[]',
    JSON.stringify([{ repositoryId: FACTORY_REPO_ID, repository: 'Synthetic/Other' }]),
    JSON.stringify([entries[0], entries[0]]),
    JSON.stringify([{ ...entries[0], projectConfig: {} }]),
    JSON.stringify([{ ...entries[0], lanes: [] }]),
    JSON.stringify([{ ...entries[0], credential: confidential }]),
    'x'.repeat(MAX_MCP_REQUEST_BYTES + 1)
  ]) {
    const rejected = invoke(raw, [call]);
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, '');
    assert.equal(rejected.stderr, 'Invalid MCP repository enrollment.\n');
    assert.equal(rejected.stderr.includes(confidential), false);
  }
});

test('stdio frames are ordered, bounded, UTF-8 checked, and use only an injected board transport', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', chunk => { text += chunk.toString(); });
  let calls = 0;
  const request = async (url, options) => {
    calls++;
    assert.match(url, /^https:\/\/api\.github\.com\/repos\/Jamula\/SoftwareFactory\//);
    assert.equal(options.headers.authorization, undefined);
    return new Response('[]');
  };
  const server = startMcpStdioServer({ input, output, context: { ...authorizedContext(), boardTransport: { request } } });
  const frame = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const board = id => frame(id, 'tools/call', { name: 'get_factory_board_snapshot', arguments: { repositoryId: FACTORY_REPO_ID } });
  input.write(`${frame(1, 'initialize')}\n${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  input.write(`${frame('gh' + 'p_fake', 'ping')}\n`);
  input.write(Buffer.from([0xff, 10]));
  input.write(`${'x'.repeat(MAX_MCP_REQUEST_BYTES + 5)}\n`);
  input.write(`${board(2)}\n${frame(3, 'ping')}\r\n`);
  input.end('{bad');
  await server;
  const frames = text.trimEnd().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(frames.map(x => x.id), [1, null, null, null, 2, 3, null]);
  assert.equal(frames[1].error.data.reason, 'INVALID_ID');
  assert.equal(frames[2].error.code, -32700);
  assert.equal(frames[3].error.data.reason, 'PAYLOAD_TOO_LARGE');
  assert.equal(frames[4].result.structuredContent.source, 'github-rest');
  assert.equal(frames[6].error.code, -32700);
  assert.ok(calls > 0);
  assert.equal(text.includes('DISABLED'), false);
  assert.equal(text.includes('gh' + 'p_fake'), false);
});

test('stdio tools/call exercises all eight read-only tools over PassThrough', async () => {
  const { policy, snapshot } = buildProtectedSquashFixtures();
  const discovery = {
    repository: 'Synthetic/Spellbook', repositoryId: CONSUMER_REPO_ID,
    pinnedFactorySha: 'afc3d223f287b029db32672908097efc67a259c9', stackProfile: 'baseline-95-90',
    discoveredRepository: {
      defaultBranch: 'main', mergeMethod: 'squash', checks: [{ name: 'build-test', appId: 12345 }],
      reviewers: ['synthetic-reviewer'], owners: [{ prefix: 'src/', owner: 'synthetic-owner' }],
      coverage: { line: 97, branch: 92 }, maxConcurrency: 1, existingFiles: []
    }
  };
  const calls = [
    ['get_repo_knowledge_map', { repositoryId: CONSUMER_REPO_ID, revision: HEAD_SHA, nowMs: NOW_MS }, 'KNOWLEDGE_MAP_VERIFIED'],
    ['evaluate_gate_status', { mode: 'candidate', policy, snapshot }, 'SHADOW_ELIGIBLE'],
    ['get_bounded_work_item_context', {
      repositoryId: CONSUMER_REPO_ID, issueNumber: 1, traceparent: VALID_TRACEPARENT,
      summary: 'Synthetic work item', ownedPaths: ['src/api/x.mjs']
    }, 'WORK_ITEM_CONTEXT_BOUNDED'],
    ['validate_provider_isolation', copilotConfig(), 'PROVIDER_ISOLATION_VERIFIED'],
    ['plan_disjoint_lanes', { repositoryId: CONSUMER_REPO_ID, tasks: [
      { id: 1, lane: 'api', state: 'approved', priority: 1, dependencies: [], paths: ['src/api/x.mjs'] }
    ] }, 'SHADOW_PLAN'],
    ['build_consumer_onboarding_plan', { repositoryId: CONSUMER_REPO_ID, discovery }, 'READ_ONLY_ONBOARDING_PLAN_READY'],
    ['select_scoped_guidance_and_lessons', {
      repositoryId: CONSUMER_REPO_ID, repositorySlug: 'Synthetic/Spellbook', expectedHeadSha: HEAD_SHA,
      nowMs: NOW_MS, targetComponent: 'api', specialistRole: 'api',
      changedPaths: ['src/api/x.mjs'], guidanceEntries: [], curatedLessons: []
    }, 'SCOPED_KNOWLEDGE_SELECTED'],
    ['get_factory_board_snapshot', { repositoryId: FACTORY_REPO_ID }, 'github-rest']
  ];
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', chunk => { text += chunk; });
  const server = startMcpStdioServer({ input, output, context: {
    ...authorizedContext(), boardTransport: { request: async () => new Response('[]') }
  } });
  input.end(calls.map(([name, args], id) => JSON.stringify({
    jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args }
  })).join('\n') + '\n');
  await server;
  const frames = text.trim().split('\n').map(JSON.parse);
  assert.equal(frames.length, calls.length);
  for (let id = 0; id < calls.length; id++) {
    const payload = frames[id].result.structuredContent;
    assert.equal(frames[id].id, id);
    assert.equal(frames[id].result.isError, false, calls[id][0]);
    assert.equal(payload.plan?.reason ?? payload.reason ?? payload.source, calls[id][2], calls[id][0]);
  }
});

test('stdio denies unauthorized boards before calling injected transport and hides transport errors', async () => {
  let calls = 0;
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', chunk => { text += chunk; });
  const server = startMcpStdioServer({ input, output, context: {
    ...authorizedContext(),
    boardTransport: { request: async () => { calls++; throw new Error('gh' + 'p_private'); } }
  } });
  const board = repositoryId => JSON.stringify({ jsonrpc: '2.0', id: repositoryId, method: 'tools/call', params: { name: 'get_factory_board_snapshot', arguments: { repositoryId } } });
  input.end(`${board(999)}\n${board(FACTORY_REPO_ID)}\n`);
  await server;
  const frames = text.trim().split('\n').map(JSON.parse);
  assert.equal(frames[0].result.structuredContent.reason, 'UNAUTHORIZED_REPOSITORY');
  assert.equal(frames[1].result.structuredContent.reason, 'BOARD_READ_FAILED');
  assert.ok(calls > 0);
  assert.equal(text.includes('private'), false);
});

test('stdio times out noncooperative board reads and resumes ordered requests without further provider calls', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  let resolveRequest;
  let calls = 0;
  output.on('data', chunk => { text += chunk; });
  const server = startMcpStdioServer({ input, output, context: {
    ...authorizedContext(),
    boardTransport: { request: () => { calls++; return new Promise(resolve => { resolveRequest = resolve; }); } }
  } });
  input.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'get_factory_board_snapshot', arguments: { repositoryId: FACTORY_REPO_ID }
  } })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`);
  await server;
  const frames = text.trim().split('\n').map(JSON.parse);
  assert.deepEqual(frames.map(frame => frame.id), [1, 2]);
  assert.equal(frames[0].result.structuredContent.reason, 'BOARD_READ_FAILED');
  resolveRequest(new Response('[]'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
});

test('stdio honors output backpressure and rejects closed output', async () => {
  const input = new PassThrough();
  const chunks = [];
  const output = new Writable({
    highWaterMark: 1,
    write(chunk, encoding, callback) { chunks.push(chunk.toString()); setImmediate(callback); }
  });
  const server = startMcpStdioServer({ input, output });
  input.end('{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
  await server;
  assert.deepEqual(chunks.map(chunk => JSON.parse(chunk).id), [1, 2]);
  const closed = new PassThrough();
  closed.destroy();
  const next = new PassThrough();
  const failing = startMcpStdioServer({ input: next, output: closed });
  next.end('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  await assert.rejects(failing, /OUTPUT_CLOSED/);
});

test('stdio subprocess emits only JSON responses and handles notifications', async () => {
  const moduleUrl = new URL('../../tools/engineering-factory/mcp-agent-connector.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { startMcpStdioServer } from ${JSON.stringify(moduleUrl)}; await startMcpStdioServer();`],
  { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  child.stdin.end('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
  assert.equal(await exited, 0);
  assert.equal(stderr, '');
  const frames = stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(frames.map(frame => frame.id), [1, 2]);
  assert.equal(frames[1].result.tools.length, 8);
});

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
      projectConfig: consumerProjectConfig(),
      trustedFiles: ['src/api/x.mjs']
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
  assert.equal(MCP_CONNECTOR_TOOLS.length, 8);
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
  assert.equal(handleMcpConnectorRequest({ jsonrpc: '2.0', method: 'notifications/initialized', params: [] }), null);
  assert.equal(handleMcpConnectorRequest('{"jsonrpc":"2.0","method":"notifications/initialized","params":[]}'), null);
  assert.equal(handleMcpConnectorRequest({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: { _meta: 'invalid' }
  }), null);

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
  assert.equal(listRes.result.tools.length, 8);
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
    { nestedObj: { token: 'ghu_secretInMetaObj' } },
    { claudeCodeOauthToken: 'opaque-meta-val' },
    { CLAUDE_CODE_OAUTH_TOKEN: 'opaque-meta-env-val' },
    { GH_TOKEN: 'opaque-meta-gh-val' },
    { GH_ENTERPRISE_TOKEN: 'opaque-meta-ghe-val' },
    { GITHUB_ENTERPRISE_TOKEN: 'opaque-meta-ghent-val' },
    { APIKey: 'opaque-meta-acronym-key' },
    { APIKEY: 'opaque-meta-compact-key' },
    { authorization: 'opaque-auth-header-placeholder' },
    { access_token: 'opaque-snake-access' },
    { api_key: 'opaque-snake-key' }
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

  for (const secretHandling of ['reject', 'strip']) {
    for (const secretPathArgs of [
      {
        ownedPaths: ['docs/ghp_SyntheticConnectorCanary1234567890'],
        secretHandling
      },
      {
        ownedPaths: ['docs/MCP-MULTI-AGENT-CONNECTOR.md'],
        additionalForbiddenPaths: ['config/sk-ant-SyntheticCanary987654321'],
        secretHandling
      }
    ]) {
      const secretPathRes = handleMcpConnectorRequest({
        jsonrpc: '2.0',
        id: `wi-sec-path-${secretHandling}`,
        method: 'tools/call',
        params: {
          name: 'get_bounded_work_item_context',
          arguments: {
            repositoryId: FACTORY_REPO_ID,
            issueNumber: 136,
            traceparent: VALID_TRACEPARENT,
            summary: 'Clean summary',
            ...secretPathArgs
          }
        }
      });
      assert.equal(secretPathRes.result.isError, true);
      assert.equal(secretPathRes.result.structuredContent.reason, 'SECRET_TOKEN_REJECTED');
      assert.equal(JSON.stringify(secretPathRes).includes('SyntheticConnectorCanary1234567890'), false);
      assert.equal(JSON.stringify(secretPathRes).includes('SyntheticCanary987654321'), false);
    }
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

test('subscription entitlement metadata and credential-bearing env/config keys fail closed without raw tokens', () => {
  assert.equal(MAX_MCP_FRAMED_LINES, 100);
  assert.deepEqual(CROSS_MODEL_MODES, ['independent-review', 'specialist-fallback']);

  const { includedQuotaVerified: _dropClaudeQuota, ...claudePlanCfg } =
    claudeConfig({ oauthEntitlementVerified: true });
  const claudePlanRes = validateMultiAgentConnectorConfig(claudePlanCfg);
  assert.equal(claudePlanRes.valid, true);
  assert.equal(claudePlanRes.oauthEntitlementVerified, true);

  const { includedQuotaVerified: _dropCodexQuota, ...codexPlanCfg } =
    codexConfig({ oauthEntitlementVerified: true });
  const codexPlanRes = validateMultiAgentConnectorConfig(codexPlanCfg);
  assert.equal(codexPlanRes.valid, true);
  assert.equal(codexPlanRes.oauthEntitlementVerified, true);

  const copilotPlanAligned = validateMultiAgentConnectorConfig(
    copilotConfig({ oauthEntitlementVerified: true, env: { COPILOT_TRACE_MODE: 'local' } })
  );
  assert.equal(copilotPlanAligned.valid, true);
  assert.equal(copilotPlanAligned.oauthEntitlementVerified, true);
  assert.equal(
    validateMultiAgentConnectorConfig(copilotConfig({ oauthEntitlementVerified: false })).reason,
    'OAUTH_ENTITLEMENT_UNVERIFIED'
  );

  const { includedQuotaVerified: _dropClaudeUnverified, ...claudeUnverifiedPlan } =
    claudeConfig({ oauthEntitlementVerified: false });
  const { includedQuotaVerified: _dropCodexUnverified, ...codexUnverifiedPlan } =
    codexConfig({ oauthEntitlementVerified: false });
  for (const unverifiedPlanCfg of [
    claudeUnverifiedPlan,
    claudeConfig({ includedQuotaVerified: true, oauthEntitlementVerified: false }),
    codexUnverifiedPlan
  ]) {
    assert.equal(validateMultiAgentConnectorConfig(unverifiedPlanCfg).reason, 'OAUTH_ENTITLEMENT_UNVERIFIED');
  }

  assert.equal(
    validateMultiAgentConnectorConfig(claudeConfig({
      includedQuotaVerified: false,
      oauthEntitlementVerified: true
    })).reason,
    'INCLUDED_QUOTA_UNVERIFIED'
  );
  assert.equal(
    validateMultiAgentConnectorConfig(claudeConfig({
      includedQuotaVerified: 'yes',
      oauthEntitlementVerified: true
    })).reason,
    'INCLUDED_QUOTA_UNVERIFIED'
  );

  for (const invalidEntitlementFlag of ['true', 1, {}, 'opaque-non-prefix-string']) {
    assert.equal(
      validateMultiAgentConnectorConfig(claudeConfig({ oauthEntitlementVerified: invalidEntitlementFlag })).reason,
      'INVALID_OAUTH_ENTITLEMENT'
    );
  }

  const proxyTrap = {
    get() { throw new Error('proxy trap must never run'); },
    ownKeys() { throw new Error('proxy trap must never run'); }
  };
  const arrWithGetter = [];
  Object.defineProperty(arrWithGetter, '0', {
    enumerable: true,
    get() { throw new Error('array getter must never execute'); }
  });
  const cyclicConfig = copilotConfig();
  cyclicConfig.env = cyclicConfig;
  let sharedDag = { leaf: 1 };
  for (let i = 0; i < 20; i++) {
    sharedDag = { left: sharedDag, right: sharedDag };
  }
  for (const structuralTrap of [
    claudeConfig({ overageHardStopUsdCents: new Proxy({}, proxyTrap) }),
    claudeConfig({ overageHardStopUsdCents: arrWithGetter }),
    claudeConfig({ overageHardStopUsdCents: [Object.create(null)] }),
    claudeConfig({ overageHardStopUsdCents: Object.create(null) }),
    claudeConfig({ overageHardStopUsdCents: Number.NaN }),
    claudeConfig({ overageHardStopUsdCents: () => {} }),
    cyclicConfig,
    claudeConfig({ overageHardStopUsdCents: sharedDag })
  ]) {
    assert.equal(validateMultiAgentConnectorConfig(structuralTrap).reason, 'INVALID_CONNECTOR_CONFIG');
  }
  assert.equal(
    validateMultiAgentConnectorConfig(copilotConfig({ preToolUseOnFailure: 'block' })).reason,
    'INVALID_CONNECTOR_CONFIG'
  );
  assert.equal(
    validateMultiAgentConnectorConfig(codexConfig({ preToolUseOnFailure: 'block' })).reason,
    'INVALID_CONNECTOR_CONFIG'
  );
  assert.equal(
    validateMultiAgentConnectorConfig(copilotConfig({ ownerAuthorized: false })).reason,
    'OWNER_AUTHORIZATION_REQUIRED'
  );
  assert.equal(
    validateMultiAgentConnectorConfig(copilotConfig({ trustedBaseConfigRestored: false })).reason,
    'UNTRUSTED_PROVIDER_CONFIG'
  );
  assert.equal(
    validateMultiAgentConnectorConfig(codexConfig({ overageHardStopUsdCents: 500 })).reason,
    'OVERAGE_HARD_STOP_REQUIRED'
  );
  assert.equal(
    validateMultiAgentConnectorConfig(claudeConfig({ overageHardStopUsdCents: 500 })).reason,
    'OVERAGE_HARD_STOP_REQUIRED'
  );
  assert.equal(
    validateMultiAgentConnectorConfig(claudeConfig({ env: { lowercase_bad: '1' } })).reason,
    'INVALID_CONNECTOR_ENV'
  );

  for (const rejectedCfg of [
    claudeConfig({ oauthEntitlementVerified: 'sk-ant-canary-1' }),
    claudeConfig({ overageHardStopUsdCents: 'sk-ant-canary-2' }),
    claudeConfig({ overageHardStopUsdCents: ['ghp_ArrayCanary'] }),
    claudeConfig({ overageHardStopUsdCents: { nested: 'ghp_ObjCanary' } }),
    codexConfig({ preToolUseOnFailure: 'sk-CrossFieldCodexCanary' }),
    copilotConfig({ preToolUseOnFailure: 'ghp_CrossFieldCopilotCanary' }),
    claudeConfig({ claudeCodeOauthToken: 'opaque-val-1' }),
    claudeConfig({ access_token: 'opaque-val-2' }),
    claudeConfig({ api_key: 'opaque-val-3' }),
    claudeConfig({ authorization: 'opaque-auth-header-placeholder' }),
    codexConfig({ openaiApiKey: 'opaque-val-4' }),
    copilotConfig({ githubToken: 'opaque-val-5' }),
    claudeConfig({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'opaque-val-6' } }),
    claudeConfig({ env: { AUTHORIZATION: 'opaque-auth-header-placeholder' } }),
    claudeConfig({ preToolUseOnFailure: 'warn', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-canary-3' } }),
    claudeConfig({ env: { ANTHROPIC_API_KEY: 'opaque-val-7' } }),
    codexConfig({ env: { OPENAI_AGENTS_DISABLE_TRACING: '1', OPENAI_API_KEY: 'opaque-val-8' } }),
    copilotConfig({ env: { GITHUB_TOKEN: 'opaque-val-9' } }),
    copilotConfig({ env: { GH_TOKEN: 'opaque-val-10' } }),
    copilotConfig({ env: { GH_ENTERPRISE_TOKEN: 'opaque-val-11' } }),
    copilotConfig({ env: { GITHUB_ENTERPRISE_TOKEN: 'opaque-val-12' } }),
    copilotConfig({ env: { APIKEY: 'opaque-val-13' } }),
    claudeConfig({ APIKey: 'opaque-val-14' }),
    claudeConfig({ CLIENTSECRET: 'opaque-val-15' })
  ]) {
    const res = validateMultiAgentConnectorConfig(rejectedCfg);
    assert.equal(res.valid, false);
    assert.equal(res.reason, 'SECRET_MATERIAL_REJECTED');
    assert.equal(JSON.stringify(res).includes('canary'), false);
    assert.equal(JSON.stringify(res).includes('Canary'), false);
    assert.equal(JSON.stringify(res).includes('opaque-'), false);
  }

  for (const badRollbackBudget of [
    copilotConfig({ oauthEntitlementVerified: false }),
    copilotConfig({ externalTelemetryDisabled: false }),
    copilotConfig({ externalMergeAuthorityOnly: false }),
    copilotConfig({ allowDirectMergeOrPolicyWrite: true }),
    copilotConfig({ adapter: 'claude-code-action' }),
    copilotConfig({ authorizedSpendCapUsdCents: 100, observedSpendUsdCents: 999 }),
    copilotConfig({ sessionCheckpoint: new Proxy({}, proxyTrap) }),
    copilotConfig({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'opaque-token' } })
  ]) {
    const rb = createCopilotOnlyRollbackState('ENTITLEMENT_CHECK', badRollbackBudget);
    assert.equal(rb.budgetVerified, false);
    assert.equal(rb.budgetRevalidationRequired, true);
  }
  const cleanEnvBudget = createCopilotOnlyRollbackState(
    'CLEAN_BUDGET',
    copilotConfig({ oauthEntitlementVerified: true, externalTelemetryDisabled: true, env: { SAFE_FLAG: '1' } })
  );
  assert.equal(cleanEnvBudget.budgetVerified, true);
});

test('processMcpFramedMessages processes bounded stdio JSON-RPC batches, omits notifications, and guarantees newline-free frames', () => {
  const ctx = { ...authorizedContext(), nowMs: NOW_MS };
  const batchLines = [
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'f-init',
      method: 'initialize',
      params: { protocolVersion: MCP_PROTOCOL_VERSION }
    }),
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    }),
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'f-wi',
      method: 'tools/call',
      params: {
        name: 'get_bounded_work_item_context',
        arguments: {
          repositoryId: FACTORY_REPO_ID,
          issueNumber: 136,
          traceparent: VALID_TRACEPARENT,
          summary: 'Line separator \u2028 and paragraph separator \u2029 must stay single-line',
          ownedPaths: ['docs/MCP-MULTI-AGENT-CONNECTOR.md']
        }
      }
    }),
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { _meta: { progressToken: 'tok-cancel' } }
    }),
    '{malformed-json-frame'
  ];

  const arrayRes = processMcpFramedMessages(batchLines, ctx);
  assert.equal(Object.isFrozen(arrayRes), true);
  assert.equal(Object.isFrozen(arrayRes.responses), true);
  assert.equal(arrayRes.valid, true);
  assert.equal(arrayRes.readOnly, true);
  assert.equal(arrayRes.reason, 'MCP_FRAMED_BATCH_PROCESSED');
  assert.equal(arrayRes.lineCount, 5);
  assert.equal(arrayRes.notificationCount, 2);
  assert.equal(arrayRes.errorCount, 1);
  assert.equal(arrayRes.responses.length, 3);
  for (const frame of arrayRes.responses) {
    assert.equal(/[\r\n\u2028\u2029]/.test(frame), false);
    assert.equal(typeof JSON.parse(frame), 'object');
  }
  assert.equal(arrayRes.responses[1].includes('\\u2028'), true);
  assert.equal(arrayRes.responses[1].includes('\\u2029'), true);
  const parsedWorkItem = JSON.parse(arrayRes.responses[1]);
  assert.equal(
    parsedWorkItem.result.structuredContent.summary,
    'Line separator \u2028 and paragraph separator \u2029 must stay single-line'
  );
  assert.equal(JSON.parse(arrayRes.responses[2]).error.code, -32700);
  assert.equal(arrayRes.framedOutput, `${arrayRes.responses.join('\n')}\n`);

  const crlfStream = `${batchLines.join('\r\n')}\r\n`;
  const streamRes = processMcpFramedMessages(crlfStream, ctx);
  assert.deepEqual(streamRes, arrayRes);

  const noTrailingNewlineRes = processMcpFramedMessages(batchLines.slice(0, 2).join('\n'));
  assert.equal(noTrailingNewlineRes.valid, true);
  assert.equal(noTrailingNewlineRes.lineCount, 2);
  assert.equal(noTrailingNewlineRes.notificationCount, 1);
  assert.equal(noTrailingNewlineRes.responses.length, 1);

  const notificationsOnly = processMcpFramedMessages([
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled' })
  ]);
  assert.equal(notificationsOnly.valid, true);
  assert.equal(notificationsOnly.lineCount, 2);
  assert.equal(notificationsOnly.notificationCount, 2);
  assert.deepEqual(notificationsOnly.responses, []);
  assert.equal(notificationsOnly.framedOutput, '');

  const pingLine = idx => JSON.stringify({ jsonrpc: '2.0', id: idx, method: 'ping' });
  const exactMaxLines = Array.from({ length: MAX_MCP_FRAMED_LINES }, (_, idx) => pingLine(idx + 1));
  const maxArrayRes = processMcpFramedMessages(exactMaxLines);
  assert.equal(maxArrayRes.valid, true);
  assert.equal(maxArrayRes.lineCount, 100);
  assert.equal(maxArrayRes.responses.length, 100);

  const maxStringRes = processMcpFramedMessages(`${exactMaxLines.join('\n')}\n`);
  assert.equal(maxStringRes.valid, true);
  assert.equal(maxStringRes.lineCount, 100);

  const overMaxLines = Array.from({ length: MAX_MCP_FRAMED_LINES + 1 }, (_, idx) => pingLine(idx + 1));
  assert.equal(processMcpFramedMessages(overMaxLines).valid, false);
  assert.equal(processMcpFramedMessages(overMaxLines).reason, 'FRAMED_BATCH_LIMIT_EXCEEDED');
  assert.equal(processMcpFramedMessages(overMaxLines.join('\n')).reason, 'FRAMED_BATCH_LIMIT_EXCEEDED');
  assert.equal(processMcpFramedMessages(`${exactMaxLines.join('\n')}\n\n`).reason, 'FRAMED_BATCH_LIMIT_EXCEEDED');

  const asciiOversizeLine = JSON.stringify({
    jsonrpc: '2.0',
    id: 'big-ascii',
    method: 'ping',
    params: { pad: 'x'.repeat(MAX_MCP_REQUEST_BYTES) }
  });
  const multiByteOversizeLine = JSON.stringify({
    jsonrpc: '2.0',
    id: 'big-utf8',
    method: 'ping',
    params: { pad: '€'.repeat(25_000) }
  });
  assert.ok(multiByteOversizeLine.length < MAX_MCP_REQUEST_BYTES);
  assert.ok(Buffer.byteLength(multiByteOversizeLine, 'utf8') > MAX_MCP_REQUEST_BYTES);

  const mixedOversize = processMcpFramedMessages([
    pingLine(1),
    asciiOversizeLine,
    multiByteOversizeLine,
    pingLine(2)
  ]);
  assert.equal(mixedOversize.valid, true);
  assert.equal(mixedOversize.errorCount, 2);
  assert.equal(mixedOversize.responses.length, 4);
  assert.equal(JSON.parse(mixedOversize.responses[0]).id, 1);
  assert.equal(JSON.parse(mixedOversize.responses[1]).error.data.reason, 'PAYLOAD_TOO_LARGE');
  assert.equal(JSON.parse(mixedOversize.responses[2]).error.data.reason, 'PAYLOAD_TOO_LARGE');
  assert.equal(JSON.parse(mixedOversize.responses[3]).id, 2);

  const rawOversizeStream = processMcpFramedMessages(`${pingLine(1)}\n${asciiOversizeLine}\n`);
  assert.equal(rawOversizeStream.valid, true);
  assert.equal(rawOversizeStream.errorCount, 1);
  assert.equal(JSON.parse(rawOversizeStream.responses[1]).error.data.reason, 'PAYLOAD_TOO_LARGE');

  const proxyTrap = {
    get() { throw new Error('proxy trap must not execute'); },
    ownKeys() { throw new Error('proxy trap must not execute'); }
  };
  const getterArr = [pingLine(1)];
  Object.defineProperty(getterArr, '0', {
    enumerable: true,
    get() { throw new Error('array getter must not execute'); }
  });
  const sparseArr = new Array(2);
  sparseArr[0] = pingLine(1);
  const protoArr = Object.setPrototypeOf([pingLine(1)], Object.prototype);

  for (const invalidBatch of [
    null,
    undefined,
    123,
    {},
    new Proxy([], proxyTrap),
    getterArr,
    sparseArr,
    protoArr,
    [123]
  ]) {
    const bad = processMcpFramedMessages(invalidBatch);
    assert.equal(bad.valid, false);
    assert.equal(bad.reason, 'INVALID_FRAMED_BATCH');
    assert.deepEqual(bad.responses, []);
    assert.equal(bad.framedOutput, '');
  }

  assert.equal(processMcpFramedMessages([]).reason, 'EMPTY_FRAMED_BATCH');
  assert.equal(processMcpFramedMessages('').reason, 'EMPTY_FRAMED_BATCH');

  for (const embeddedNewlineInput of [
    [`${pingLine(1)}\n${pingLine(2)}`],
    [`${pingLine(1)}\r`],
    `${pingLine(1)}\r${pingLine(2)}`,
    `${pingLine(1)}\r`
  ]) {
    const embeddedErr = processMcpFramedMessages(embeddedNewlineInput);
    assert.equal(embeddedErr.valid, false);
    assert.equal(embeddedErr.reason, 'EMBEDDED_NEWLINE_IN_FRAME');
  }

  const badCtxRes = processMcpFramedMessages([pingLine(1)], { stop: 'yes' });
  assert.equal(badCtxRes.valid, false);
  assert.equal(badCtxRes.reason, 'INVALID_CONNECTOR_CONTEXT');
});

test('evaluateCrossModelReviewEligibility enforces cross-model independence, provider isolation, OAuth metadata, merge authority, and rollback', () => {
  const checkpointState = JSON.stringify({ reviewerTurn: 1, verdict: 'commented-clear' });
  const checkpointSha256 = createHash('sha256').update(checkpointState, 'utf8').digest('hex');

  const claudeSessionReviewer = claudeConfig({
    adapter: 'claude-agent-sdk',
    role: 'independent-reviewer',
    includedQuotaVerified: undefined,
    oauthEntitlementVerified: true,
    headSha: HEAD_SHA,
    sessionCheckpoint: {
      sessionId: 'claude-review-session-01',
      sha256: checkpointSha256,
      headSha: HEAD_SHA,
      serializedState: checkpointState
    }
  });
  delete claudeSessionReviewer.includedQuotaVerified;

  const crossProviderReview = evaluateCrossModelReviewEligibility({
    authorProvider: 'github-copilot',
    authorModelFamily: 'GPT-5.4',
    authorIdentity: 'copilot-swe-agent[bot]',
    authorConfig: copilotConfig({ headSha: HEAD_SHA }),
    reviewerProvider: 'anthropic-claude',
    reviewerModelFamily: 'Claude-Opus-4.6',
    reviewerIdentity: 'claude-reviewer[bot]',
    reviewerConfig: claudeSessionReviewer,
    headSha: HEAD_SHA,
    externalMergeGateAuthoritative: true
  });
  assert.equal(Object.isFrozen(crossProviderReview), true);
  assert.equal(crossProviderReview.valid, true);
  assert.equal(crossProviderReview.eligible, true);
  assert.equal(crossProviderReview.mode, 'independent-review');
  assert.equal(crossProviderReview.reason, 'CROSS_MODEL_REVIEW_ELIGIBLE');
  assert.equal(crossProviderReview.crossProvider, true);
  assert.equal(crossProviderReview.crossModelFamily, true);
  assert.equal(crossProviderReview.authorModelFamily, 'gpt-5.4');
  assert.equal(crossProviderReview.reviewerModelFamily, 'claude-opus-4.6');
  assert.equal(crossProviderReview.headSha, HEAD_SHA);
  assert.equal(crossProviderReview.rollbackActive, false);
  assert.equal(crossProviderReview.externalMergeGateAuthoritative, true);
  assert.equal(crossProviderReview.externalMergeAuthorityOnly, true);
  assert.deepEqual(crossProviderReview.soleMergeEvaluators, [
    'tools/engineering-factory/core.mjs',
    'tools/engineering-factory/protected-squash.mjs'
  ]);
  assert.equal(crossProviderReview.allowDirectMergeOrPolicyWrite, false);
  assert.equal(crossProviderReview.syntheticApprovalAllowed, false);
  assert.equal(crossProviderReview.liveDispatch, false);
  assert.equal(crossProviderReview.liveMerge, false);
  assert.equal(crossProviderReview.unapprovedSpendUsdCents, 0);
  assert.equal(crossProviderReview.reviewerValidation.oauthEntitlementVerified, true);
  assert.equal(crossProviderReview.reviewerValidation.sessionCheckpointVerified, true);
  assert.equal(crossProviderReview.rollbackState.budgetVerified, true);
  assert.equal(crossProviderReview.rollbackState.preserveCopilotExecution, true);

  const sameProviderCrossModel = evaluateCrossModelReviewEligibility({
    authorProvider: 'github-copilot',
    authorModelFamily: 'gpt-5.4',
    authorConfig: copilotConfig({ headSha: HEAD_SHA }),
    reviewerProvider: 'github-copilot',
    reviewerModelFamily: 'claude-sonnet-4.5',
    reviewerConfig: copilotConfig({ role: 'independent-reviewer', headSha: HEAD_SHA }),
    headSha: HEAD_SHA,
    externalMergeGateAuthoritative: true
  });
  assert.equal(sameProviderCrossModel.eligible, true);
  assert.equal(sameProviderCrossModel.crossProvider, false);
  assert.equal(sameProviderCrossModel.crossModelFamily, true);
  assert.equal(sameProviderCrossModel.headSha, HEAD_SHA);

  const crossProviderSameModel = evaluateCrossModelReviewEligibility({
    authorProvider: 'openai-codex',
    authorModelFamily: 'gpt-5.4',
    authorConfig: codexConfig({ role: 'worker', headSha: HEAD_SHA }),
    reviewerProvider: 'github-copilot',
    reviewerModelFamily: 'gpt-5.4',
    reviewerConfig: copilotConfig({ role: 'independent-reviewer', headSha: HEAD_SHA }),
    headSha: HEAD_SHA,
    externalMergeGateAuthoritative: true
  });
  assert.equal(crossProviderSameModel.eligible, true);
  assert.equal(crossProviderSameModel.crossProvider, true);
  assert.equal(crossProviderSameModel.crossModelFamily, false);
  assert.equal(crossProviderSameModel.rollbackState.budgetVerified, true);

  for (const missingHeadCase of [
    {
      authorConfig: copilotConfig(),
      reviewerConfig: copilotConfig({ role: 'independent-reviewer' })
    },
    {
      headSha: HEAD_SHA,
      authorConfig: copilotConfig(),
      reviewerConfig: copilotConfig({ role: 'independent-reviewer' })
    },
    {
      headSha: HEAD_SHA,
      authorConfig: copilotConfig({ headSha: HEAD_SHA }),
      reviewerConfig: copilotConfig({ role: 'independent-reviewer' })
    }
  ]) {
    const missingHeadRes = evaluateCrossModelReviewEligibility({
      authorProvider: 'github-copilot',
      authorModelFamily: 'gpt-5.4',
      reviewerProvider: 'github-copilot',
      reviewerModelFamily: 'claude-sonnet-4.5',
      externalMergeGateAuthoritative: true,
      ...missingHeadCase
    });
    assert.equal(missingHeadRes.eligible, false);
    assert.equal(missingHeadRes.reason, 'CANDIDATE_HEAD_SHA_REQUIRED');
  }

  const specialistFallback = evaluateCrossModelReviewEligibility({
    mode: 'specialist-fallback',
    authorProvider: 'openai-codex',
    authorModelFamily: 'codex-1',
    authorConfig: codexConfig({ role: 'worker', oauthEntitlementVerified: true, headSha: HEAD_SHA }),
    reviewerProvider: 'anthropic-claude',
    reviewerModelFamily: 'claude-sonnet-4.5',
    reviewerConfig: claudeConfig({
      role: 'specialist',
      includedQuotaVerified: false,
      authorizedSpendCapUsdCents: 300,
      observedSpendUsdCents: 50,
      headSha: HEAD_SHA
    }),
    headSha: HEAD_SHA,
    verifiedCopilotBudget: copilotConfig(),
    externalMergeGateAuthoritative: true
  });
  assert.equal(specialistFallback.eligible, true);
  assert.equal(specialistFallback.mode, 'specialist-fallback');
  assert.equal(specialistFallback.reason, 'SPECIALIST_FALLBACK_ELIGIBLE');
  assert.equal(specialistFallback.headSha, HEAD_SHA);
  assert.equal(specialistFallback.rollbackState.budgetVerified, true);

  const externalOnlyNoCopilotBudget = evaluateCrossModelReviewEligibility({
    mode: 'specialist-fallback',
    authorProvider: 'openai-codex',
    authorModelFamily: 'codex-1',
    authorConfig: codexConfig({ role: 'worker' }),
    reviewerProvider: 'anthropic-claude',
    reviewerModelFamily: 'claude-sonnet-4.5',
    reviewerConfig: claudeConfig({ role: 'specialist' }),
    externalMergeGateAuthoritative: true
  });
  assert.equal(externalOnlyNoCopilotBudget.eligible, true);
  assert.equal(externalOnlyNoCopilotBudget.rollbackState.budgetVerified, false);
  assert.equal(externalOnlyNoCopilotBudget.rollbackState.budgetRevalidationRequired, true);

  const selfModelRejected = evaluateCrossModelReviewEligibility({
    authorProvider: 'openai-codex',
    authorModelFamily: 'gpt-5.4',
    authorConfig: codexConfig({ role: 'worker' }),
    reviewerProvider: 'openai-codex',
    reviewerModelFamily: 'GPT-5.4',
    reviewerConfig: codexConfig({ role: 'independent-reviewer' }),
    externalMergeGateAuthoritative: true
  });
  assert.equal(selfModelRejected.eligible, false);
  assert.equal(selfModelRejected.rollbackActive, true);
  assert.equal(selfModelRejected.reason, 'SELF_MODEL_REVIEW_FORBIDDEN');

  const selfIdentityRejected = evaluateCrossModelReviewEligibility({
    authorProvider: 'github-copilot',
    authorModelFamily: 'gpt-5.4',
    authorIdentity: 'Copilot-Bot[bot]',
    authorConfig: copilotConfig(),
    reviewerProvider: 'anthropic-claude',
    reviewerModelFamily: 'claude-opus-4.6',
    reviewerIdentity: 'copilot-bot[bot]',
    reviewerConfig: claudeConfig(),
    externalMergeGateAuthoritative: true
  });
  assert.equal(selfIdentityRejected.eligible, false);
  assert.equal(selfIdentityRejected.reason, 'SELF_IDENTITY_REVIEW_FORBIDDEN');

  const codexTracingFailed = evaluateCrossModelReviewEligibility({
    authorProvider: 'openai-codex',
    authorModelFamily: 'codex-1',
    authorConfig: codexConfig({ role: 'worker', env: { OPENAI_AGENTS_DISABLE_TRACING: '0' } }),
    reviewerProvider: 'anthropic-claude',
    reviewerModelFamily: 'claude-opus-4.6',
    reviewerConfig: claudeConfig(),
    externalMergeGateAuthoritative: true
  });
  assert.equal(codexTracingFailed.eligible, false);
  assert.equal(codexTracingFailed.failedSide, 'author');
  assert.equal(codexTracingFailed.reason, 'EXTERNAL_TRACING_NOT_DISABLED');

  const claudeHookFailed = evaluateCrossModelReviewEligibility({
    authorProvider: 'github-copilot',
    authorModelFamily: 'gpt-5.4',
    authorConfig: copilotConfig(),
    reviewerProvider: 'anthropic-claude',
    reviewerModelFamily: 'claude-opus-4.6',
    reviewerConfig: claudeConfig({ preToolUseOnFailure: 'warn' }),
    externalMergeGateAuthoritative: true
  });
  assert.equal(claudeHookFailed.eligible, false);
  assert.equal(claudeHookFailed.failedSide, 'reviewer');
  assert.equal(claudeHookFailed.reason, 'PRE_TOOL_HOOK_NOT_FAIL_CLOSED');
  assert.equal(claudeHookFailed.rollbackState.preserveCopilotExecution, true);

  const copilotAuthorFailedIgnoreSuppliedBudget = evaluateCrossModelReviewEligibility({
    authorProvider: 'github-copilot',
    authorModelFamily: 'gpt-5.4',
    authorConfig: copilotConfig({ includedQuotaVerified: false }),
    reviewerProvider: 'anthropic-claude',
    reviewerModelFamily: 'claude-opus-4.6',
    reviewerConfig: claudeConfig(),
    verifiedCopilotBudget: copilotConfig(),
    externalMergeGateAuthoritative: true
  });
  assert.equal(copilotAuthorFailedIgnoreSuppliedBudget.reason, 'INCLUDED_QUOTA_UNVERIFIED');
  assert.equal(copilotAuthorFailedIgnoreSuppliedBudget.rollbackState.budgetVerified, false);

  const copilotAuthorMissingFamilyIgnoreBudget = evaluateCrossModelReviewEligibility({
    authorProvider: 'github-copilot',
    authorModelFamily: 'gpt-5.4',
    authorConfig: { includedQuotaVerified: false },
    reviewerProvider: 'anthropic-claude',
    reviewerModelFamily: 'claude-opus-4.6',
    reviewerConfig: claudeConfig(),
    verifiedCopilotBudget: copilotConfig(),
    externalMergeGateAuthoritative: true
  });
  assert.equal(copilotAuthorMissingFamilyIgnoreBudget.rollbackState.budgetVerified, false);

  const copilotReviewerFailedIgnoreSuppliedBudget = evaluateCrossModelReviewEligibility({
    authorProvider: 'openai-codex',
    authorModelFamily: 'codex-1',
    authorConfig: codexConfig({ role: 'worker' }),
    reviewerProvider: 'github-copilot',
    reviewerModelFamily: 'claude-sonnet-4.5',
    reviewerConfig: copilotConfig({ role: 'independent-reviewer', overageHardStopUsdCents: 100 }),
    verifiedCopilotBudget: copilotConfig(),
    externalMergeGateAuthoritative: true
  });
  assert.equal(copilotReviewerFailedIgnoreSuppliedBudget.reason, 'OVERAGE_HARD_STOP_REQUIRED');
  assert.equal(copilotReviewerFailedIgnoreSuppliedBudget.rollbackState.budgetVerified, false);

  const invalidSuppliedBudget = evaluateCrossModelReviewEligibility({
    authorProvider: 'openai-codex',
    authorModelFamily: 'codex-1',
    authorConfig: codexConfig({ role: 'worker' }),
    reviewerProvider: 'anthropic-claude',
    reviewerModelFamily: 'claude-opus-4.6',
    reviewerConfig: claudeConfig(),
    verifiedCopilotBudget: { includedQuotaVerified: false, overageHardStopUsdCents: 0, unapprovedSpendUsdCents: 0 },
    externalMergeGateAuthoritative: true
  });
  assert.equal(invalidSuppliedBudget.eligible, false);
  assert.equal(invalidSuppliedBudget.reason, 'INVALID_VERIFIED_COPILOT_BUDGET');

  const rejectedInactiveReason = evaluateCrossModelReviewEligibility({
    authorProvider: 'github-copilot',
    authorModelFamily: 'gpt-5.4',
    authorConfig: copilotConfig(),
    reviewerProvider: 'anthropic-claude',
    reviewerModelFamily: 'claude-opus-4.6',
    reviewerConfig: claudeConfig(),
    rollbackReason: 'ghp_InactiveReasonCanary999',
    externalMergeGateAuthoritative: true
  });
  assert.equal(rejectedInactiveReason.eligible, false);
  assert.equal(rejectedInactiveReason.reason, 'SECRET_MATERIAL_REJECTED');
  assert.equal(JSON.stringify(rejectedInactiveReason).includes('InactiveReasonCanary999'), false);

  const controlCharInactiveRollbackReason = evaluateCrossModelReviewEligibility({
    authorProvider: 'github-copilot',
    authorModelFamily: 'gpt-5.4',
    authorConfig: copilotConfig(),
    reviewerProvider: 'anthropic-claude',
    reviewerModelFamily: 'claude-opus-4.6',
    reviewerConfig: claudeConfig(),
    rollbackReason: 'bad\u0000char',
    externalMergeGateAuthoritative: true
  });
  assert.equal(controlCharInactiveRollbackReason.eligible, false);
  assert.equal(controlCharInactiveRollbackReason.reason, 'INVALID_CROSS_MODEL_INPUT');

  for (const [rejectedInput, expectedSide] of [
    [{
      authorProvider: 'github-copilot',
      authorModelFamily: 'gpt-5.4',
      authorConfig: copilotConfig(),
      reviewerProvider: 'anthropic-claude',
      reviewerModelFamily: 'claude-opus-4.6',
      reviewerConfig: claudeConfig(),
      authorization: 'opaque-auth-header-placeholder',
      externalMergeGateAuthoritative: true
    }, null],
    [{
      authorProvider: 'github-copilot',
      authorModelFamily: 'sk-ant-canary-model',
      authorConfig: copilotConfig(),
      reviewerProvider: 'anthropic-claude',
      reviewerModelFamily: 'claude-opus-4.6',
      reviewerConfig: claudeConfig(),
      externalMergeGateAuthoritative: true
    }, null],
    [{
      authorProvider: 'github-copilot',
      authorModelFamily: 'gpt-5.4',
      authorConfig: copilotConfig(),
      reviewerProvider: 'anthropic-claude',
      reviewerModelFamily: 'claude-opus-4.6',
      reviewerConfig: claudeConfig(),
      verifiedCopilotBudget: { ...copilotConfig(), env: { GITHUB_TOKEN: 'opaque-gh-budget-token' } },
      externalMergeGateAuthoritative: true
    }, null],
    [{
      authorProvider: 'github-copilot',
      authorModelFamily: 'gpt-5.4',
      authorConfig: copilotConfig(),
      reviewerProvider: 'anthropic-claude',
      reviewerModelFamily: 'claude-opus-4.6',
      reviewerConfig: claudeConfig(),
      verifiedCopilotBudget: { ...copilotConfig(), nestedList: [{ apiKey: 'opaque-budget-secret' }] },
      externalMergeGateAuthoritative: true
    }, null],
    [{
      authorProvider: 'openai-codex',
      authorModelFamily: 'codex-1',
      authorConfig: codexConfig({
        role: 'worker',
        env: { OPENAI_AGENTS_DISABLE_TRACING: '1', OPENAI_API_KEY: 'opaque-author-key' }
      }),
      reviewerProvider: 'anthropic-claude',
      reviewerModelFamily: 'claude-opus-4.6',
      reviewerConfig: claudeConfig(),
      externalMergeGateAuthoritative: true
    }, 'author'],
    [{
      authorProvider: 'github-copilot',
      authorModelFamily: 'gpt-5.4',
      authorConfig: copilotConfig(),
      reviewerProvider: 'anthropic-claude',
      reviewerModelFamily: 'claude-opus-4.6',
      reviewerConfig: claudeConfig({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'opaque-reviewer-oauth' } }),
      externalMergeGateAuthoritative: true
    }, 'reviewer']
  ]) {
    const secDenied = evaluateCrossModelReviewEligibility(rejectedInput);
    assert.equal(secDenied.eligible, false);
    assert.equal(secDenied.reason, 'SECRET_MATERIAL_REJECTED');
    assert.equal(secDenied.failedSide, expectedSide);
    assert.equal(JSON.stringify(secDenied).includes('canary'), false);
    assert.equal(JSON.stringify(secDenied).includes('opaque-'), false);
  }

  for (const badMergeAuth of [undefined, false, 'true', 1]) {
    const mergeDenied = evaluateCrossModelReviewEligibility({
      authorProvider: 'github-copilot',
      authorModelFamily: 'gpt-5.4',
      authorConfig: copilotConfig(),
      reviewerProvider: 'anthropic-claude',
      reviewerModelFamily: 'claude-opus-4.6',
      reviewerConfig: claudeConfig(),
      externalMergeGateAuthoritative: badMergeAuth
    });
    assert.equal(mergeDenied.eligible, false);
    assert.equal(mergeDenied.reason, 'EXTERNAL_MERGE_AUTHORITY_REQUIRED');
    assert.equal(mergeDenied.externalMergeGateAuthoritative, true);
  }

  const manualRollback = evaluateCrossModelReviewEligibility({
    authorProvider: 'github-copilot',
    authorModelFamily: 'gpt-5.4',
    authorConfig: copilotConfig(),
    reviewerProvider: 'anthropic-claude',
    reviewerModelFamily: 'claude-opus-4.6',
    reviewerConfig: claudeConfig(),
    externalMergeGateAuthoritative: true,
    rollbackToCopilotOnly: true,
    rollbackReason: 'VENDOR_QUOTA_REVOKED'
  });
  assert.equal(manualRollback.eligible, false);
  assert.equal(manualRollback.rollbackActive, true);
  assert.equal(manualRollback.reason, 'VENDOR_QUOTA_REVOKED');
  assert.equal(manualRollback.rollbackState.preserveCopilotExecution, true);

  const redactedRollback = evaluateCrossModelReviewEligibility({
    externalMergeGateAuthoritative: true,
    rollbackToCopilotOnly: true,
    rollbackReason: 'revoked token ghp_SecretRollbackCanary777'
  });
  assert.equal(redactedRollback.reason, 'REDACTED_ROLLBACK_REASON');
  assert.equal(JSON.stringify(redactedRollback).includes('SecretRollbackCanary777'), false);

  for (const stopSignal of [
    { killSwitch: true },
    { stop: true, rollbackReason: 'OPERATOR_EMERGENCY_STOP' }
  ]) {
    const stopped = evaluateCrossModelReviewEligibility({
      externalMergeGateAuthoritative: true,
      verifiedCopilotBudget: copilotConfig(),
      ...stopSignal
    });
    assert.equal(stopped.eligible, false);
    assert.equal(stopped.reason, 'CONNECTOR_STOPPED');
    assert.equal(stopped.rollbackActive, true);
  }

  assert.equal(evaluateCrossModelReviewEligibility({
    authorProvider: 'github-copilot',
    authorModelFamily: 'gpt-5.4',
    authorConfig: copilotConfig(),
    reviewerProvider: 'openai-codex',
    reviewerModelFamily: 'claude-opus-4.6',
    reviewerConfig: claudeConfig(),
    externalMergeGateAuthoritative: true
  }).reason, 'PROVIDER_CONFIG_MISMATCH');

  assert.equal(evaluateCrossModelReviewEligibility({
    authorProvider: 'github-copilot',
    authorModelFamily: 'gpt-5.4',
    authorConfig: copilotConfig({ role: 'independent-reviewer' }),
    reviewerProvider: 'anthropic-claude',
    reviewerModelFamily: 'claude-opus-4.6',
    reviewerConfig: claudeConfig(),
    externalMergeGateAuthoritative: true
  }).reason, 'INVALID_AUTHOR_ROLE');

  assert.equal(evaluateCrossModelReviewEligibility({
    authorProvider: 'github-copilot',
    authorModelFamily: 'gpt-5.4',
    authorConfig: copilotConfig(),
    reviewerProvider: 'anthropic-claude',
    reviewerModelFamily: 'claude-opus-4.6',
    reviewerConfig: claudeConfig({ role: 'worker' }),
    externalMergeGateAuthoritative: true
  }).reason, 'INVALID_REVIEWER_ROLE');

  assert.equal(evaluateCrossModelReviewEligibility({
    mode: 'specialist-fallback',
    authorProvider: 'github-copilot',
    authorModelFamily: 'gpt-5.4',
    authorConfig: copilotConfig(),
    reviewerProvider: 'anthropic-claude',
    reviewerModelFamily: 'claude-opus-4.6',
    reviewerConfig: claudeConfig({ role: 'independent-reviewer' }),
    externalMergeGateAuthoritative: true
  }).reason, 'INVALID_REVIEWER_ROLE');

  assert.equal(evaluateCrossModelReviewEligibility({
    authorProvider: 'github-copilot',
    authorModelFamily: 'gpt-5.4',
    authorConfig: copilotConfig({ headSha: HEAD_SHA }),
    reviewerProvider: 'anthropic-claude',
    reviewerModelFamily: 'claude-opus-4.6',
    reviewerConfig: claudeConfig({ headSha: BASE_SHA }),
    externalMergeGateAuthoritative: true
  }).reason, 'CROSS_MODEL_HEAD_MISMATCH');

  assert.equal(evaluateCrossModelReviewEligibility({
    mode: 'auto-merge',
    externalMergeGateAuthoritative: true
  }).reason, 'INVALID_CROSS_MODEL_MODE');

  assert.equal(evaluateCrossModelReviewEligibility({
    authorProvider: 'unknown-vendor',
    authorModelFamily: 'gpt-5.4',
    authorConfig: copilotConfig(),
    reviewerProvider: 'anthropic-claude',
    reviewerModelFamily: 'claude-opus-4.6',
    reviewerConfig: claudeConfig(),
    externalMergeGateAuthoritative: true
  }).reason, 'UNSUPPORTED_PROVIDER_FAMILY');

  for (const badModel of ['', '  gpt-5  ', 'gpt/5']) {
    assert.equal(evaluateCrossModelReviewEligibility({
      authorProvider: 'github-copilot',
      authorModelFamily: badModel,
      authorConfig: copilotConfig(),
      reviewerProvider: 'anthropic-claude',
      reviewerModelFamily: 'claude-opus-4.6',
      reviewerConfig: claudeConfig(),
      externalMergeGateAuthoritative: true
    }).reason, 'INVALID_MODEL_FAMILY');
  }

  for (const badActor of ['', 'bad actor', 'actor/slash']) {
    assert.equal(evaluateCrossModelReviewEligibility({
      authorProvider: 'github-copilot',
      authorModelFamily: 'gpt-5.4',
      authorIdentity: badActor,
      authorConfig: copilotConfig(),
      reviewerProvider: 'anthropic-claude',
      reviewerModelFamily: 'claude-opus-4.6',
      reviewerConfig: claudeConfig(),
      externalMergeGateAuthoritative: true
    }).reason, 'INVALID_ACTOR_IDENTITY');
  }

  const proxyTrap = {
    get() { throw new Error('proxy trap must not execute'); },
    ownKeys() { throw new Error('proxy trap must not execute'); }
  };
  for (const malformedInput of [
    null,
    undefined,
    [],
    new Proxy({}, proxyTrap),
    { badNum: Number.NaN },
    { unknownTopKey: true },
    { killSwitch: 'true' },
    { stop: 1 },
    { rollbackToCopilotOnly: 'yes' },
    { rollbackReason: 123 },
    { verifiedCopilotBudget: 'not-object' },
    { headSha: 'not-40-hex' }
  ]) {
    const res = evaluateCrossModelReviewEligibility(malformedInput);
    assert.equal(res.eligible, false);
    assert.equal(res.reason, 'INVALID_CROSS_MODEL_INPUT');
  }
});
