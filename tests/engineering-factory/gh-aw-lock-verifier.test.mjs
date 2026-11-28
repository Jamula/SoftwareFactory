import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {delimiter, dirname, join, resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {
  PINNED_FACTORY_POLICY_SCAN_RUN_SHA256,
  PINNED_GHAW_DETECTION_CONCLUSION_SCRIPT_SHA256,
  PINNED_GHAW_RELEASE,
  computeBodySha256,
  computeFrontmatterSha256,
  computeNormalizedScriptSha256,
  verifyEventTriggerMatrix,
  verifyGhAwWorkflowLock
} from '../../tools/engineering-factory/gh-aw-lock-verifier.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const checkoutSha = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const setupNodeSha = '949feb2413d6458794dcd2491c4babbbce0c15c1';
const canonicalPolicyScanSteps = [
  '      - name: Scan',
  '        id: policy_scan',
  '        run: |',
  '          set -euo pipefail',
  "          node --input-type=module -e '",
  '            import {readFileSync} from "node:fs";',
  '            import {verifyEventTriggerMatrix, verifyGhAwWorkflowLock} from "./tools/engineering-factory/gh-aw-lock-verifier.mjs";',
  '            const markdownSource = readFileSync(".github/workflows/factory-orchestrator.md", "utf8");',
  '            const lockYamlSource = readFileSync(".github/workflows/factory-orchestrator.lock.yml", "utf8");',
  '            const verdict = verifyGhAwWorkflowLock({markdownSource, lockYamlSource});',
  '            const matrixVerdict = verifyEventTriggerMatrix(lockYamlSource);',
  '            if (!verdict.valid || !matrixVerdict.valid || verdict.liveDispatch !== false || verdict.liveMerge !== false) {',
  '              process.exit(1);',
  '            }',
  "          '",
  '          echo "scan_verified=true" >> "$GITHUB_OUTPUT"'
].join('\n');

function makeMetadataLine({frontmatterHash, bodyHash, version = PINNED_GHAW_RELEASE.version, schemaVersion = 'v4'}) {
  const payload = {
    schema_version: schemaVersion,
    frontmatter_hash: frontmatterHash
  };
  if (bodyHash !== undefined) payload.body_hash = bodyHash;
  if (version !== null) payload.compiler_version = version;
  payload.strict = true;
  payload.agent_id = 'copilot';
  return `# gh-aw-metadata: ${JSON.stringify(payload)}`;
}

function buildFixture({
  frontmatterIf = "\"vars.FACTORY_GHAW_ENABLED == 'true' && !endsWith(github.actor, '[bot]')\"",
  frontmatterExtra = '',
  markdownBody = '# Synthetic orchestrator body',
  protocol = 'v3',
  version = PINNED_GHAW_RELEASE.version,
  commit = PINNED_GHAW_RELEASE.commit,
  topPermissions = '  contents: read',
  evaluateIf = "${{ vars.FACTORY_GHAW_ENABLED == 'true' && !endsWith(github.actor, '[bot]') }}",
  evaluatePerms = '      contents: read',
  checkoutUses = `actions/checkout@${checkoutSha} # v7.0.1`,
  persistCredentials = 'false',
  runBody = '          echo "shadow ok"',
  threatNeeds = '[evaluate]',
  threatIf = "${{ vars.FACTORY_GHAW_ENABLED == 'true' && needs.evaluate.result == 'success' && !endsWith(github.actor, '[bot]') }}",
  threatOutputs = '    outputs:\n      scan_verified: ${{ steps.policy_scan.outputs.scan_verified }}',
  threatSteps = canonicalPolicyScanSteps,
  safeNeeds = '[evaluate, threat-and-policy-scan]',
  safeIf = '${{ false }}',
  safePerms = '      issues: write',
  extraHeader = ''
} = {}) {
  const markdownSource = [
    '---',
    'name: Synthetic orchestrator',
    'engine: copilot',
    frontmatterIf === null ? '' : `if: ${frontmatterIf}`,
    'on:',
    '  workflow_dispatch:',
    'permissions:',
    '  contents: read',
    'tools:',
    '  work-queue: true',
    frontmatterExtra,
    '---',
    '',
    markdownBody
  ].filter(Boolean).join('\n');

  const sha = computeFrontmatterSha256(markdownSource);
  const bodySha = computeBodySha256(markdownSource);
  const lockYamlSource = [
    makeMetadataLine({frontmatterHash: sha, bodyHash: bodySha, version}),
    `# gh-aw-commit: ${commit}`,
    `# gh-aw-work-queue-protocol: ${protocol}`,
    extraHeader,
    'name: Synthetic orchestrator',
    'on:',
    '  workflow_dispatch:',
    'permissions:',
    topPermissions,
    'jobs:',
    '  evaluate:',
    `    if: ${evaluateIf}`,
    '    runs-on: ubuntu-latest',
    '    permissions:',
    evaluatePerms,
    '    steps:',
    '      - name: Checkout',
    `        uses: ${checkoutUses}`,
    '        with:',
    `          persist-credentials: ${persistCredentials}`,
    `      - uses: actions/setup-node@${setupNodeSha}`,
    '        with:',
    "          node-version: '26.13.1'",
    '      - name: Run check',
    '        run: |',
    runBody,
    '',
    '  threat-and-policy-scan:',
    `    needs: ${threatNeeds}`,
    `    if: ${threatIf}`,
    '    runs-on: ubuntu-latest',
    '    permissions:',
    '      contents: read',
    threatOutputs,
    '    steps:',
    threatSteps,
    '  safe-outputs-comment:',
    `    needs: ${safeNeeds}`,
    `    if: ${safeIf}`,
    '    runs-on: ubuntu-latest',
    '    permissions:',
    safePerms,
    '    steps:',
    '      - name: Dry-run output',
    '        run: echo "noop"'
  ].filter(line => line !== null && line !== '').join('\n');

  return {markdownSource, lockYamlSource, sha, bodySha};
}

test('verifies tracked .github/workflows/factory-orchestrator.md and .lock.yml pair and matches github/gh-aw v1.2.2 compiler hash', () => {
  const mdPath = resolve(repoRoot, '.github/workflows/factory-orchestrator.md');
  const lockPath = resolve(repoRoot, '.github/workflows/factory-orchestrator.lock.yml');
  const markdownSource = readFileSync(mdPath, 'utf8');
  const lockYamlSource = readFileSync(lockPath, 'utf8');

  const expectedHash = computeFrontmatterSha256(markdownSource);
  const expectedBodyHash = computeBodySha256(markdownSource);
  assert.match(expectedHash, /^[a-f0-9]{64}$/);
  assert.match(expectedBodyHash, /^[a-f0-9]{64}$/);
  assert.ok(lockYamlSource.includes(`"frontmatter_hash":"${expectedHash}"`));
  assert.ok(lockYamlSource.includes(`"body_hash":"${expectedBodyHash}"`));

  const verdict = verifyGhAwWorkflowLock({markdownSource, lockYamlSource});
  assert.equal(verdict.valid, true);
  assert.equal(verdict.shadow, true);
  assert.equal(verdict.liveDispatch, false);
  assert.equal(verdict.liveMerge, false);
  assert.equal(verdict.reason, 'GHAW_LOCK_VERIFIED');
  assert.equal(verdict.frontmatterSha256, expectedHash);
  assert.equal(verdict.bodySha256, expectedBodyHash);
  assert.equal(verdict.workQueueProtocol, 'v3');
  assert.deepEqual(verdict.pinnedRelease, PINNED_GHAW_RELEASE);
  assert.equal(Object.isFrozen(verdict), true);

  // Exact byte-for-byte parity with github/gh-aw@399a445fe2d8926c616b54b1b82a16b5b2be4445
  // pkg/cli/workflows/example-blocked-domains.md -> example-blocked-domains.lock.yml
  const upstreamExampleMd = [
    '---',
    'engine: copilot',
    'on:',
    '  workflow_dispatch:',
    '    ',
    'network:',
    '  firewall: true',
    '  allowed:',
    '    - defaults',
    '    - github',
    '    - node',
    '  blocked:',
    '    - tracker.example.com',
    '    - analytics.example.com',
    '---',
    '',
    '# Example: Blocked Domains'
  ].join('\n');
  assert.equal(
    computeFrontmatterSha256(upstreamExampleMd),
    '80100e1eccadf076c6f02412860f8dfb229e60d1753790630cb4589468eee780'
  );
});

test('normalizes CRLF frontmatter to identical SHA-256 and rejects malformed frontmatter', () => {
  const lf = '---\nname: "demo"\nlist: [a, \'it\'\'s\', 42, true, false]\nempty_arr: []\nempty_obj: {}\n---\n# Title\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  assert.equal(computeFrontmatterSha256(lf), computeFrontmatterSha256(crlf));

  for (const invalid of [
    null,
    123,
    '',
    'x'.repeat(262145),
    '---\nname:\tbad\n---\n',
    '---\nname: bad\u0000\n---\n',
    '---\rname: bad\r---\r',
    'no frontmatter',
    '---\n   \n---\n',
    '---\nname: unclosed',
    '---\nimports:\n  - shared.md\n---\n# body',
    '---\nimports:\n  - shared.md\nbad: [unclosed\n---\n# body',
    '---\nname: ok\n---\n{{#runtime-import other.md}}'
  ]) {
    assert.equal(computeFrontmatterSha256(invalid), null);
    assert.equal(computeBodySha256(invalid), null);
  }

  // Template expressions (env./vars.) and inlined-imports: true affect frontmatter_hash per gh-aw spec
  const withVarsA = '---\nengine: copilot\n---\nUse ${{ vars.ALPHA }} and ${{ github.actor }} and ${{ \'}\' && env.BETA }} and ${{ unclosed';
  const withVarsB = '---\nengine: copilot\n---\nChanged prose only ${{ vars.ALPHA }} and ${{ \'}\' && env.BETA }}';
  assert.equal(computeFrontmatterSha256(withVarsA), computeFrontmatterSha256(withVarsB));
  assert.notEqual(computeFrontmatterSha256(withVarsA), computeFrontmatterSha256('---\nengine: copilot\n---\nNo vars'));

  const inlinedA = '---\nengine: copilot\ninlined-imports: true\n---\nPrompt version A';
  const inlinedB = '---\nengine: copilot\ninlined-imports: true\n---\nPrompt version B';
  assert.notEqual(computeFrontmatterSha256(inlinedA), computeFrontmatterSha256(inlinedB));

  // Regression: YAML inline comment and quoted key spellings of inlined-imports: true must include body-text!
  const inlinedCommentA = '---\nengine: copilot\ninlined-imports: true # include prompt\n---\nPrompt version A';
  const inlinedCommentB = '---\nengine: copilot\ninlined-imports: true # include prompt\n---\nPrompt version B';
  assert.notEqual(computeFrontmatterSha256(inlinedCommentA), computeFrontmatterSha256(inlinedCommentB));

  const inlinedQuotedA = '---\nengine: copilot\n"inlined-imports": true\n---\nPrompt version A';
  const inlinedQuotedB = '---\nengine: copilot\n"inlined-imports": true\n---\nPrompt version B';
  assert.notEqual(computeFrontmatterSha256(inlinedQuotedA), computeFrontmatterSha256(inlinedQuotedB));

  const base = buildFixture();
  const crlfVerdict = verifyGhAwWorkflowLock({
    markdownSource: base.markdownSource.replace(/\n/g, '\r\n'),
    lockYamlSource: base.lockYamlSource.replace(/\n/g, '\r\n')
  });
  assert.equal(crlfVerdict.valid, true);
});

test('rejects revoked proxies, active proxy traps, getters, symbols, and non-plain inputs without throwing', () => {
  let trapCalls = 0;
  const trap = () => {
    trapCalls++;
    throw new Error('proxy trap must not execute');
  };
  const handler = {get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap};
  const base = buildFixture();

  const revokedInput = Proxy.revocable({markdownSource: base.markdownSource, lockYamlSource: base.lockYamlSource}, handler);
  revokedInput.revoke();
  assert.equal(verifyGhAwWorkflowLock(revokedInput.proxy).reason, 'INVALID_LOCK_INPUT');
  assert.equal(verifyGhAwWorkflowLock(new Proxy(base, handler)).reason, 'INVALID_LOCK_INPUT');

  const revokedRelease = Proxy.revocable({...PINNED_GHAW_RELEASE}, handler);
  revokedRelease.revoke();
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: base.markdownSource,
    lockYamlSource: base.lockYamlSource,
    pinnedRelease: revokedRelease.proxy
  }).reason, 'PINNED_RELEASE_INVALID');

  const getterObj = {lockYamlSource: base.lockYamlSource};
  Object.defineProperty(getterObj, 'markdownSource', {enumerable: true, get: trap});
  assert.equal(verifyGhAwWorkflowLock(getterObj).reason, 'INVALID_LOCK_INPUT');

  const nonEnumObj = {markdownSource: base.markdownSource, lockYamlSource: base.lockYamlSource};
  Object.defineProperty(nonEnumObj, 'extra', {enumerable: false, value: 1});
  assert.equal(verifyGhAwWorkflowLock(nonEnumObj).reason, 'INVALID_LOCK_INPUT');

  const symbolObj = {
    markdownSource: base.markdownSource,
    lockYamlSource: base.lockYamlSource,
    [Symbol('s')]: 1
  };
  assert.equal(verifyGhAwWorkflowLock(symbolObj).reason, 'INVALID_LOCK_INPUT');

  for (const bad of [
    null,
    undefined,
    [],
    Object.create({markdownSource: base.markdownSource, lockYamlSource: base.lockYamlSource}),
    {markdownSource: base.markdownSource},
    {markdownSource: '', lockYamlSource: base.lockYamlSource},
    {markdownSource: base.markdownSource, lockYamlSource: ''}
  ]) {
    assert.equal(verifyGhAwWorkflowLock(bad).reason, 'INVALID_LOCK_INPUT');
  }
  assert.equal(trapCalls, 0);
});

test('enforces pinned github/gh-aw release metadata and protocol v3 vs verified v4 rules', () => {
  const v3 = buildFixture({protocol: 'v3'});
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: v3.markdownSource,
    lockYamlSource: v3.lockYamlSource,
    pinnedRelease: {version: 'v1.2.2', commit: PINNED_GHAW_RELEASE.commit}
  }).valid, true);

  const v4OnV122 = buildFixture({protocol: 'v4'});
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: v4OnV122.markdownSource,
    lockYamlSource: v4OnV122.lockYamlSource
  }).reason, 'WORK_QUEUE_PROTOCOL_UNSUPPORTED');

  const newerCommit = 'b'.repeat(40);
  const v4OnVerifiedNewer = buildFixture({protocol: 'v4', version: 'v1.3.0', commit: newerCommit});
  const v4Unverified = verifyGhAwWorkflowLock({
    markdownSource: v4OnVerifiedNewer.markdownSource,
    lockYamlSource: v4OnVerifiedNewer.lockYamlSource,
    pinnedRelease: {version: 'v1.3.0', commit: newerCommit}
  });
  assert.equal(v4Unverified.reason, 'PINNED_RELEASE_INVALID');

  const v4Verified = verifyGhAwWorkflowLock({
    markdownSource: v4OnVerifiedNewer.markdownSource,
    lockYamlSource: v4OnVerifiedNewer.lockYamlSource,
    pinnedRelease: {repository: 'github/gh-aw', version: 'v1.3.0', commit: newerCommit, verified: true}
  });
  assert.equal(v4Verified.valid, true);
  assert.equal(v4Verified.workQueueProtocol, 'v4');

  let commitCoercions = 0;
  for (const badPin of [
    null,
    [],
    {version: '1.2.2', commit: PINNED_GHAW_RELEASE.commit},
    {repository: 'other/gh-aw', version: 'v1.2.2', commit: PINNED_GHAW_RELEASE.commit},
    {version: 'v1.2.1', commit: newerCommit, verified: true},
    {version: 'v0.9.0', commit: newerCommit, verified: true},
    {version: 'v1.1.9', commit: newerCommit, verified: true},
    {version: 'v1.2.2', commit: 'not-a-sha'},
    {version: 'v1.2.2', commit: Symbol('sha')},
    {version: 'v1.2.2', commit: {toString() { commitCoercions++; throw new Error('boom'); }}},
    {version: 'v1.2.2', commit: PINNED_GHAW_RELEASE.commit, verified: false}
  ]) {
    assert.equal(verifyGhAwWorkflowLock({
      markdownSource: v3.markdownSource,
      lockYamlSource: v3.lockYamlSource,
      pinnedRelease: badPin
    }).reason, 'PINNED_RELEASE_INVALID');
  }
  assert.equal(commitCoercions, 0);

  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: v3.markdownSource,
    lockYamlSource: v3.lockYamlSource,
    pinnedRelease: {version: 'v1.2.2', commit: newerCommit}
  }).reason, 'PINNED_RELEASE_MISMATCH');

  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: v3.markdownSource,
    lockYamlSource: v3.lockYamlSource,
    pinnedRelease: {version: 'v1.3.0', commit: PINNED_GHAW_RELEASE.commit, verified: true}
  }).reason, 'PINNED_RELEASE_MISMATCH');

  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: v3.markdownSource,
    lockYamlSource: v3.lockYamlSource.replace(PINNED_GHAW_RELEASE.commit, newerCommit)
  }).reason, 'PINNED_RELEASE_MISMATCH');

  // Reject protocol/branch keys inside tools.work-queue or top-level frontmatter per gh-aw v1.2.2 schema
  for (const invalidSchemaMd of [
    '---\nname: Bad wq\ntools:\n  work-queue:\n    protocol: v3\n---\n# Body',
    '---\nname: Bad wq2\ntools:\n  work-queue:\n    branch: work-queue\n---\n# Body',
    '---\nname: Bad wq3\ntools:\n  work-queue: false\n---\n# Body',
    '---\nname: Bad wq4\ntools:\n  work-queue:\n    worker: "yes"\n---\n# Body',
    '---\nname: Bad wq5\ntools:\n  work-queue:\n    issues:\n      bad: 1\n---\n# Body',
    '---\nname: Bad wq6\ntools:\n  work-queue:\n    memory: true\n---\n# Body',
    '---\nname: Direct protocol\nprotocol: v5\n---\n# Body',
    '---\nname: Direct work-queue\nwork-queue:\n  branch: main\n---\n# Body'
  ]) {
    const h = computeFrontmatterSha256(invalidSchemaMd);
    const b = computeBodySha256(invalidSchemaMd);
    assert.equal(verifyGhAwWorkflowLock({
      markdownSource: invalidSchemaMd,
      lockYamlSource: v3.lockYamlSource.replace(v3.sha, h).replace(v3.bodySha, b)
    }).reason, 'INVALID_FRONTMATTER');
  }

  // SoftwareFactory protocol and ref options outside compiler-owned frontmatter schema
  const headerlessProtocolLock = v3.lockYamlSource.replace('# gh-aw-work-queue-protocol: v3\n', '');
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: v3.markdownSource,
    lockYamlSource: headerlessProtocolLock,
    workQueueProtocol: 'v5'
  }).reason, 'WORK_QUEUE_PROTOCOL_UNSUPPORTED');

  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: v3.markdownSource,
    lockYamlSource: v3.lockYamlSource,
    workQueueProtocol: 'v4'
  }).reason, 'WORK_QUEUE_PROTOCOL_UNSUPPORTED');

  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: v3.markdownSource,
    lockYamlSource: v3.lockYamlSource,
    workQueueRef: 'refs/heads/main'
  }).reason, 'INVALID_WORK_QUEUE_BRANCH');

  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: v3.markdownSource,
    lockYamlSource: `# gh-aw-work-queue-ref: refs/heads/work-queue\n${v3.lockYamlSource}`,
    workQueueRef: 'work-queue'
  }).reason, 'INVALID_WORK_QUEUE_BRANCH');

  const headerMismatch = buildFixture({protocol: 'v3'});
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: headerMismatch.markdownSource,
    lockYamlSource: headerMismatch.lockYamlSource.replace('# gh-aw-work-queue-protocol: v3', '# gh-aw-work-queue-protocol: v4'),
    workQueueProtocol: 'v3'
  }).reason, 'WORK_QUEUE_PROTOCOL_UNSUPPORTED');

  // Verify github/gh-aw step action SHA and repository checkout ref match pinnedRelease.commit
  const wrongGhAwAction = buildFixture({
    checkoutUses: `github/gh-aw/actions/setup@${newerCommit}`
  });
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: wrongGhAwAction.markdownSource,
    lockYamlSource: wrongGhAwAction.lockYamlSource
  }).reason, 'PINNED_RELEASE_MISMATCH');

  const wrongGhAwRepoCheckout = v3.lockYamlSource.replace(
    'persist-credentials: false',
    `persist-credentials: false\n          repository: GitHub/gh-aw\n          ref: ${newerCommit}`
  );
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: v3.markdownSource,
    lockYamlSource: wrongGhAwRepoCheckout
  }).reason, 'PINNED_RELEASE_MISMATCH');
});

test('enforces # gh-aw-metadata:, legacy # frontmatter-hash:, body_hash, and strict YAML failure modes', () => {
  const base = buildFixture();
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: 'no frontmatter at all',
    lockYamlSource: base.lockYamlSource
  }).reason, 'INVALID_FRONTMATTER');

  const badYamlMd = '---\nname: [unclosed\n---\n# body';
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: badYamlMd,
    lockYamlSource: base.lockYamlSource
  }).reason, 'INVALID_FRONTMATTER');

  // Legacy # frontmatter-hash: header accepted only when exact-matched to canonical hash
  const legacyLock = base.lockYamlSource.replace(
    /^# gh-aw-metadata:.*$/m,
    `# frontmatter-hash: ${base.sha}`
  );
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: base.markdownSource,
    lockYamlSource: legacyLock
  }).valid, true);

  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: base.markdownSource,
    lockYamlSource: legacyLock.replace(base.sha, 'f'.repeat(64))
  }).reason, 'FRONTMATTER_HASH_MISMATCH');

  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: base.markdownSource,
    lockYamlSource: base.lockYamlSource.replace(/^# gh-aw-metadata:.*\n/m, '')
  }).reason, 'FRONTMATTER_HASH_MISSING');

  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: base.markdownSource,
    lockYamlSource: base.lockYamlSource.replace(base.sha, 'f'.repeat(64))
  }).reason, 'FRONTMATTER_HASH_MISMATCH');

  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: base.markdownSource,
    lockYamlSource: base.lockYamlSource.replace(base.bodySha, 'e'.repeat(64))
  }).reason, 'BODY_HASH_MISMATCH');

  for (const badMeta of [
    '# gh-aw-metadata: {bad json}',
    '# gh-aw-metadata: []',
    `# gh-aw-metadata: {"schema_version":"v99","frontmatter_hash":"${base.sha}"}`,
    `# gh-aw-metadata: {"schema_version":"v4","frontmatter_hash":"${base.sha}","strict":"yes"}`,
    `# gh-aw-metadata: {"schema_version":"v4","frontmatter_hash":"${base.sha}","dry_run":"yes"}`,
    `# gh-aw-metadata: {"schema_version":"v4","frontmatter_hash":"${base.sha}","body_hash":"short"}`,
    `# gh-aw-metadata: {"schema_version":"v4","frontmatter_hash":"${base.sha}","body_hash":{"toString":null,"valueOf":null}}`
  ]) {
    assert.equal(verifyGhAwWorkflowLock({
      markdownSource: base.markdownSource,
      lockYamlSource: base.lockYamlSource.replace(/^# gh-aw-metadata:.*$/m, badMeta)
    }).reason, 'INVALID_LOCK_METADATA');
  }

  for (const missingOrNonStringFrontmatterHash of [
    '# gh-aw-metadata: {"schema_version":"v3"}',
    '# gh-aw-metadata: {"schema_version":"v4","frontmatter_hash":{"toString":null,"valueOf":null}}',
    '# gh-aw-metadata: {"schema_version":"v4","frontmatter_hash":12345}'
  ]) {
    assert.equal(verifyGhAwWorkflowLock({
      markdownSource: base.markdownSource,
      lockYamlSource: base.lockYamlSource.replace(/^# gh-aw-metadata:.*$/m, missingOrNonStringFrontmatterHash)
    }).reason, 'FRONTMATTER_HASH_MISSING');
  }

  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: base.markdownSource,
    lockYamlSource: base.lockYamlSource.replace('"compiler_version":"v1.2.2"', '"compiler_version":"v1.2.1"')
  }).reason, 'PINNED_RELEASE_MISMATCH');

  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: base.markdownSource,
    lockYamlSource: `${makeMetadataLine({frontmatterHash: base.sha})}\n${ base.lockYamlSource}`
  }).reason, 'INVALID_LOCK_METADATA');

  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: base.markdownSource,
    lockYamlSource: `# frontmatter-hash: ${base.sha}\n${legacyLock}`
  }).reason, 'INVALID_LOCK_METADATA');

  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: base.markdownSource,
    lockYamlSource: legacyLock.replace(base.sha, 'short')
  }).reason, 'FRONTMATTER_HASH_MISSING');

  const dupHeader = buildFixture({extraHeader: `# gh-aw-commit: ${PINNED_GHAW_RELEASE.commit}`});
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: dupHeader.markdownSource,
    lockYamlSource: dupHeader.lockYamlSource
  }).reason, 'INVALID_LOCK_METADATA');

  const metaLine = makeMetadataLine({frontmatterHash: base.sha, bodyHash: base.bodySha});
  for (const invalidLock of [
    `${metaLine}\n---\nname: doc`,
    `${metaLine}\n- list_root`,
    `${metaLine}\nname: dup\nname: dup2`,
    `${metaLine}\nname: &anchor val`,
    `${metaLine}\nname: "unterminated`,
    `${metaLine}\n"__proto__": bad`,
    `${metaLine}\nname: valid_only`
  ]) {
    assert.equal(verifyGhAwWorkflowLock({
      markdownSource: base.markdownSource,
      lockYamlSource: invalidLock
    }).reason, 'INVALID_LOCK_YAML');
  }
});

test('enforces SHA-pinned uses, persist-credentials:false, no ${{}} in run, permissions, threat gate, bot guard, default-off, and no main merge', () => {
  const emptyTop = buildFixture({topPermissions: '{}'});
  // Replace multiline permissions:\n  {} with inline permissions: {}
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: emptyTop.markdownSource,
    lockYamlSource: emptyTop.lockYamlSource.replace('permissions:\n{}', 'permissions: {}')
  }).valid, true);

  for (const writePerm of ['permissions: write-all', 'permissions:\n  contents: write', 'permissions:\n  issues: write']) {
    const f = buildFixture();
    assert.equal(verifyGhAwWorkflowLock({
      markdownSource: f.markdownSource,
      lockYamlSource: f.lockYamlSource.replace('permissions:\n  contents: read', writePerm)
    }).reason, 'TOP_LEVEL_WRITE_PERMISSION');
  }

  const extraReadPerm = buildFixture({topPermissions: '  issues: read'});
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: extraReadPerm.markdownSource,
    lockYamlSource: extraReadPerm.lockYamlSource
  }).reason, 'INVALID_TOP_LEVEL_PERMISSIONS');

  for (const badUses of [
    'actions/checkout@v4',
    'actions/checkout@main',
    'docker://alpine:3.20',
    './.github/actions/local',
    `actions/../evil@${checkoutSha}`
  ]) {
    const f = buildFixture({checkoutUses: badUses});
    assert.equal(verifyGhAwWorkflowLock({
      markdownSource: f.markdownSource,
      lockYamlSource: f.lockYamlSource
    }).reason, 'UNPINNED_ACTION_REFERENCE');
  }

  for (const mixedCheckout of [
    `actions/checkout@${checkoutSha}`,
    `Actions/checkout@${checkoutSha}`,
    `ACTIONS/CHECKOUT@${checkoutSha}`
  ]) {
    const persistedCreds = buildFixture({checkoutUses: mixedCheckout, persistCredentials: 'true'});
    assert.equal(verifyGhAwWorkflowLock({
      markdownSource: persistedCreds.markdownSource,
      lockYamlSource: persistedCreds.lockYamlSource
    }).reason, 'CHECKOUT_CREDENTIALS_PERSISTED');
  }

  const unsafeRun = buildFixture({runBody: '          echo "${{ inputs.issue_number }}"'});
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: unsafeRun.markdownSource,
    lockYamlSource: unsafeRun.lockYamlSource
  }).reason, 'UNSAFE_RUN_INTERPOLATION');

  const agentWrite = buildFixture({evaluatePerms: '      issues: write'});
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: agentWrite.markdownSource,
    lockYamlSource: agentWrite.lockYamlSource
  }).reason, 'AGENT_JOB_WRITE_PERMISSION');

  const excessiveSafe = buildFixture({safePerms: '      contents: write'});
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: excessiveSafe.markdownSource,
    lockYamlSource: excessiveSafe.lockYamlSource
  }).reason, 'EXCESSIVE_SAFE_OUTPUT_PERMISSION');

  const missingThreatGate = buildFixture({safeNeeds: '[evaluate]'});
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: missingThreatGate.markdownSource,
    lockYamlSource: missingThreatGate.lockYamlSource
  }).reason, 'MISSING_THREAT_SCAN_GATE');

  const threatWithoutEval = buildFixture({threatNeeds: '[other]'});
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: threatWithoutEval.markdownSource,
    lockYamlSource: threatWithoutEval.lockYamlSource
  }).reason, 'MISSING_THREAT_SCAN_GATE');

  // Regression tests: safe-outputs with always(), failure(), cancelled(), disjunction, missing scan_verified output check, or skippable scan step MUST fail closed!
  for (const badSafeIf of [
    '${{ always() }}',
    "${{ always() && needs.threat-and-policy-scan.result == 'success' }}",
    '${{ failure() }}',
    '${{ cancelled() }}',
    '${{ true }}',
    "${{ needs.evaluate.result == 'success' || needs.threat-and-policy-scan.result == 'success' }}",
    "${{ needs.threat-and-policy-scan.result == 'success' }}",
    "${{ needs.evaluate.result == 'success' && needs.threat-and-policy-scan.result == 'success' }}"
  ]) {
    const f = buildFixture({safeIf: badSafeIf});
    assert.equal(verifyGhAwWorkflowLock({
      markdownSource: f.markdownSource,
      lockYamlSource: f.lockYamlSource
    }).reason, 'MISSING_THREAT_SCAN_GATE');
  }

  const validEnabledSafe = buildFixture({
    safeIf: "${{ needs.evaluate.result == 'success' && needs.threat-and-policy-scan.result == 'success' && needs.threat-and-policy-scan.outputs.scan_verified == 'true' }}"
  });
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: validEnabledSafe.markdownSource,
    lockYamlSource: validEnabledSafe.lockYamlSource
  }).valid, true);

  // Enabled write-capable safe-outputs without scan_verified output declared on scan job MUST fail closed!
  const missingScanOutputDecl = buildFixture({
    threatOutputs: null,
    safeIf: "${{ needs.evaluate.result == 'success' && needs.threat-and-policy-scan.result == 'success' && needs.threat-and-policy-scan.outputs.scan_verified == 'true' }}"
  });
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: missingScanOutputDecl.markdownSource,
    lockYamlSource: missingScanOutputDecl.lockYamlSource
  }).reason, 'MISSING_THREAT_SCAN_GATE');

  // Step-level if: on threat-and-policy-scan step (e.g. if: ${{ false }} or if: ${{ always() && false }}) MUST fail closed!
  for (const skippableStepIf of ['${{ false }}', '${{ always() && false }}']) {
    const skippableScanStep = buildFixture();
    assert.equal(verifyGhAwWorkflowLock({
      markdownSource: skippableScanStep.markdownSource,
      lockYamlSource: skippableScanStep.lockYamlSource.replace(
        '      - name: Scan\n',
        `      - name: Scan\n        if: ${skippableStepIf}\n`
      )
    }).reason, 'MISSING_THREAT_SCAN_GATE');
  }

  // Hardcoded literal scan_verified: 'true', boolean true, scalar outputs, or binding to a conditional/missing step MUST fail closed!
  for (const invalidOutputs of [
    "    outputs:\n      scan_verified: 'true'",
    "    outputs:\n      scan_verified: '${{ true }}'",
    '    outputs:\n      scan_verified: true',
    '    outputs:\n      scan_verified: ${{ steps.missing_step.outputs.scan_verified }}',
    '    outputs: invalid_scalar'
  ]) {
    const badOut = buildFixture({
      threatOutputs: invalidOutputs,
      safeIf: "${{ needs.evaluate.result == 'success' && needs.threat-and-policy-scan.result == 'success' && needs.threat-and-policy-scan.outputs.scan_verified == 'true' }}"
    });
    assert.equal(verifyGhAwWorkflowLock({
      markdownSource: badOut.markdownSource,
      lockYamlSource: badOut.lockYamlSource
    }).reason, 'MISSING_THREAT_SCAN_GATE');
  }

  // Frontmatter missing or weakening mandatory guards MUST fail closed!
  const missingFmIf = buildFixture({frontmatterIf: null});
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: missingFmIf.markdownSource,
    lockYamlSource: missingFmIf.lockYamlSource
  }).reason, 'MISSING_DEFAULT_OFF_GUARD');

  const missingFmBot = buildFixture({
    frontmatterIf: "\"vars.FACTORY_GHAW_ENABLED == 'true'\""
  });
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: missingFmBot.markdownSource,
    lockYamlSource: missingFmBot.lockYamlSource
  }).reason, 'MISSING_BOT_LOOP_GUARD');

  // Threat scan job without any run: step MUST fail closed!
  const noRunStepScan = buildFixture({
    threatSteps: `      - uses: actions/setup-node@${setupNodeSha}`
  });
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: noRunStepScan.markdownSource,
    lockYamlSource: noRunStepScan.lockYamlSource
  }).reason, 'MISSING_THREAT_SCAN_GATE');

  // Write-capable safe-outputs with omitted if: MUST fail closed!
  const omittedIfWriteSafe = buildFixture();
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: omittedIfWriteSafe.markdownSource,
    lockYamlSource: omittedIfWriteSafe.lockYamlSource.replace('    if: ${{ false }}\n', '')
  }).reason, 'MISSING_THREAT_SCAN_GATE');

  // continue-on-error: true on evaluate or threat-and-policy-scan job or step MUST fail closed!
  const evalJobContinue = buildFixture();
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: evalJobContinue.markdownSource,
    lockYamlSource: evalJobContinue.lockYamlSource.replace('  evaluate:\n', '  evaluate:\n    continue-on-error: true\n')
  }).reason, 'MISSING_THREAT_SCAN_GATE');

  const scanStepContinue = buildFixture();
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: scanStepContinue.markdownSource,
    lockYamlSource: scanStepContinue.lockYamlSource.replace('      - name: Scan\n', '      - name: Scan\n        continue-on-error: true\n')
  }).reason, 'MISSING_THREAT_SCAN_GATE');

  const scanBypassIf = buildFixture({threatIf: '${{ !always() }}'});
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: scanBypassIf.markdownSource,
    lockYamlSource: scanBypassIf.lockYamlSource
  }).reason, 'MISSING_THREAT_SCAN_GATE');

  const scanMissingEvalSuccess = buildFixture({threatIf: '${{ true }}'});
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: scanMissingEvalSuccess.markdownSource,
    lockYamlSource: scanMissingEvalSuccess.lockYamlSource
  }).reason, 'MISSING_THREAT_SCAN_GATE');

  const safeBooleanFalse = buildFixture({safeIf: 'false'});
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: safeBooleanFalse.markdownSource,
    lockYamlSource: safeBooleanFalse.lockYamlSource
  }).valid, true);

  const safeMalformedIf = buildFixture({safeIf: "'${{ == }}'"});
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: safeMalformedIf.markdownSource,
    lockYamlSource: safeMalformedIf.lockYamlSource
  }).reason, 'MISSING_THREAT_SCAN_GATE');

  // Regression tests: disjunctions (true || ..., ... || true), negations, !=, string literals, and bypass calls on evaluate MUST fail closed!
  for (const bypassedDefaultOff of [
    "${{ !endsWith(github.actor, '[bot]') }}",
    "${{ true || vars.FACTORY_GHAW_ENABLED == 'true' && !endsWith(github.actor, '[bot]') }}",
    "${{ vars.FACTORY_GHAW_ENABLED == 'true' && !endsWith(github.actor, '[bot]') || true }}",
    "${{ !(vars.FACTORY_GHAW_ENABLED == 'true') && !endsWith(github.actor, '[bot]') }}",
    "${{ vars.FACTORY_GHAW_ENABLED != 'true' && !endsWith(github.actor, '[bot]') }}",
    "${{ inputs.note == 'vars.FACTORY_GHAW_ENABLED == ''true''' && !endsWith(github.actor, '[bot]') }}",
    "${{ always() && vars.FACTORY_GHAW_ENABLED == 'true' && !endsWith(github.actor, '[bot]') }}"
  ]) {
    const f = buildFixture({evaluateIf: bypassedDefaultOff});
    assert.equal(verifyGhAwWorkflowLock({
      markdownSource: f.markdownSource,
      lockYamlSource: f.lockYamlSource
    }).reason, 'MISSING_DEFAULT_OFF_GUARD');
  }

  for (const bypassedBotGuard of [
    "${{ vars.FACTORY_GHAW_ENABLED == 'true' }}",
    "${{ vars.FACTORY_GHAW_ENABLED == 'true' && ( !endsWith(github.actor, '[bot]') || true ) }}",
    "${{ vars.FACTORY_GHAW_ENABLED == 'true' && endsWith(github.actor, '[bot]') }}",
    "${{ vars.FACTORY_GHAW_ENABLED == 'true' && github.actor != 'copilot-swe-agent[bot]' }}"
  ]) {
    const f = buildFixture({evaluateIf: bypassedBotGuard});
    assert.equal(verifyGhAwWorkflowLock({
      markdownSource: f.markdownSource,
      lockYamlSource: f.lockYamlSource
    }).reason, 'MISSING_BOT_LOOP_GUARD');
  }

  const explicitBotGuard = buildFixture({
    evaluateIf: "${{ 'true' == vars.FACTORY_GHAW_ENABLED && 'copilot-swe-agent[bot]' != github.actor && github.actor != 'github-actions[bot]' && (github.ref_protected == true) }}",
    threatNeeds: 'evaluate'
  });
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: explicitBotGuard.markdownSource,
    lockYamlSource: explicitBotGuard.lockYamlSource
  }).valid, true);

  for (const mergeFm of [
    'safe-outputs:\n  merge-pull-request:\n    branch: main',
    'safe-outputs:\n  merge-pull-request: true',
    'safe-outputs:\n  merge-pull-request:\n    branches: [main]',
    'safe-outputs:\n  - merge-pull-request'
  ]) {
    const f = buildFixture({frontmatterExtra: mergeFm});
    assert.equal(verifyGhAwWorkflowLock({
      markdownSource: f.markdownSource,
      lockYamlSource: f.lockYamlSource
    }).reason, 'MAIN_MERGE_FORBIDDEN_IN_GHAW');
  }

  const cliMergeStep = buildFixture({runBody: '          gh pr merge 12 --squash'});
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: cliMergeStep.markdownSource,
    lockYamlSource: cliMergeStep.lockYamlSource
  }).reason, 'MAIN_MERGE_FORBIDDEN_IN_GHAW');

  const mergeJobLock = buildFixture();
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: mergeJobLock.markdownSource,
    lockYamlSource: mergeJobLock.lockYamlSource.replace('safe-outputs-comment:', 'safe-outputs-merge-pull-request:')
  }).reason, 'MAIN_MERGE_FORBIDDEN_IN_GHAW');
});

test('covers YAML edge cases: quoted keys, block scalars in sequences, empty mappings, and missing jobs', () => {
  const md = [
    '---',
    '"name": "Quoted\\"Name"',
    "'description': 'Single''Quote'",
    'if: "vars.FACTORY_GHAW_ENABLED == \'true\' && !endsWith(github.actor, \'[bot]\')"',
    'tools:',
    '  work-queue:',
    '    require-assignment: true',
    '    worker: true',
    '    issues:',
    '      label: sf',
    '    memory:',
    '      name: persist_work_queue_memory',
    '      path: state/queue.json',
    '      target-repo: Jamula/SoftwareFactory',
    `      base-revision: ${checkoutSha}`,
    '      branch-prefix: gh-aw/memory',
    '      max-bytes: 4096',
    '      schema:',
    '        type: object',
    'safe-outputs:',
    '  merge-pull-request: false',
    'empty-section:',
    '---',
    '# Body'
  ].join('\n');
  const sha = computeFrontmatterSha256(md);
  const bodySha = computeBodySha256(md);
  const lock = [
    makeMetadataLine({frontmatterHash: sha, bodyHash: bodySha}),
    `# gh-aw-commit: ${PINNED_GHAW_RELEASE.commit}`,
    'name: Edge Lock',
    'on:',
    '  workflow_dispatch:',
    'permissions: {}',
    'jobs:',
    '  evaluate:',
    "    if: 1 == 1 && vars.FACTORY_GHAW_ENABLED == 'true' && !endsWith(github.actor, '[bot]')",
    '    runs-on: ubuntu-latest',
    '    permissions: {}',
    '    steps:',
    '      - run: |',
    '          echo "step block"',
    '',
    '          echo "after blank"',
    '        env:',
    '          MODE: shadow',
    '  threat-scan:',
    '    needs:',
    '      - evaluate',
    '    runs-on: ubuntu-latest',
    '    permissions: {}',
    '    steps:',
    '      - name: Threat check',
    '        run: echo "ok"',
    '  safe-outputs-implicit:',
    '    needs:',
    '      - evaluate',
    '      - threat-scan',
    '    runs-on: ubuntu-latest',
    '    permissions: {}',
    '    steps:',
    '      - run: echo "implicit success"'
  ].join('\n');
  const verdict = verifyGhAwWorkflowLock({markdownSource: md, lockYamlSource: lock});
  assert.equal(verdict.valid, true);

  const noEvalLock = lock.replace('  evaluate:', '  threat-and-policy-scan:')
    .replace('      - evaluate\n', '      - threat-and-policy-scan\n')
    .replace('      - evaluate\n      - threat-scan', '      - threat-and-policy-scan\n      - threat-scan');
  assert.equal(verifyGhAwWorkflowLock({markdownSource: md, lockYamlSource: noEvalLock}).reason, 'MISSING_EVALUATION_JOB');

  const noThreatLock = lock
    .replace('  threat-scan:\n    needs:\n      - evaluate\n    runs-on: ubuntu-latest\n    permissions: {}\n    steps:\n      - name: Threat check\n        run: echo "ok"\n', '')
    .replace('  safe-outputs-implicit:\n    needs:\n      - evaluate\n      - threat-scan\n    runs-on: ubuntu-latest\n    permissions: {}\n    steps:\n      - run: echo "implicit success"', '');
  assert.equal(verifyGhAwWorkflowLock({markdownSource: md, lockYamlSource: noThreatLock}).reason, 'MISSING_THREAT_SCAN_GATE');

  const reusableUnpinned = lock.replace('    runs-on: ubuntu-latest\n    permissions: {}\n    steps:', '    uses: org/repo/.github/workflows/ci.yml@main\n    permissions: {}\n    steps:');
  assert.equal(verifyGhAwWorkflowLock({markdownSource: md, lockYamlSource: reusableUnpinned}).reason, 'UNPINNED_ACTION_REFERENCE');

  const reusablePinned = [
    makeMetadataLine({frontmatterHash: sha, bodyHash: bodySha}),
    `# gh-aw-commit: ${PINNED_GHAW_RELEASE.commit}`,
    'name: Reusable Lock',
    'on:',
    '  workflow_dispatch:',
    'permissions: {}',
    'jobs:',
    '  evaluate:',
    "    if: vars.FACTORY_GHAW_ENABLED == 'true' && !endsWith(github.actor, '[bot]')",
    `    uses: Jamula/SoftwareFactory/.github/workflows/reusable-replay-smoke.yml@${checkoutSha}`,
    '    permissions: {}',
    '  threat-scan:',
    '    needs: evaluate',
    '    runs-on: ubuntu-latest',
    '    permissions: {}',
    '    steps:',
    '      - run: echo "ok"'
  ].join('\n');
  assert.equal(verifyGhAwWorkflowLock({markdownSource: md, lockYamlSource: reusablePinned}).valid, true);

  const reusableWrongGhAw = reusablePinned.replace(
    `Jamula/SoftwareFactory/.github/workflows/reusable-replay-smoke.yml@${checkoutSha}`,
    `github/gh-aw/.github/workflows/reusable.yml@${checkoutSha}`
  );
  assert.equal(verifyGhAwWorkflowLock({markdownSource: md, lockYamlSource: reusableWrongGhAw}).reason, 'PINNED_RELEASE_MISMATCH');

  const envMergeLock = lock.replace('MODE: shadow', 'SAFE_OUTPUT: merge-pull-request');
  assert.equal(verifyGhAwWorkflowLock({markdownSource: md, lockYamlSource: envMergeLock}).reason, 'MAIN_MERGE_FORBIDDEN_IN_GHAW');

  const nameMergeLock = lock.replace('Threat check', 'Execute merge-pull-request');
  assert.equal(verifyGhAwWorkflowLock({markdownSource: md, lockYamlSource: nameMergeLock}).reason, 'MAIN_MERGE_FORBIDDEN_IN_GHAW');

  // Standalone '-' sequence item, nested sequence mapping key without inline value, and empty needs
  const nestedSeqMd = [
    '---',
    'name: Nested Sequence',
    'if: "vars.FACTORY_GHAW_ENABLED == \'true\' && !endsWith(github.actor, \'[bot]\')"',
    'items:',
    '  -',
    '    sub: val',
    '  - nested_map:',
    '      a: 1',
    '  - empty_nested:',
    '---',
    '# Body'
  ].join('\n');
  const nestedSha = computeFrontmatterSha256(nestedSeqMd);
  const nestedLock = lock.replace(sha, nestedSha);
  assert.equal(verifyGhAwWorkflowLock({markdownSource: nestedSeqMd, lockYamlSource: nestedLock}).valid, true);

  const missingNeedsLock = nestedLock.replace('    needs:\n      - evaluate\n', '');
  assert.equal(verifyGhAwWorkflowLock({markdownSource: nestedSeqMd, lockYamlSource: missingNeedsLock}).reason, 'MISSING_THREAT_SCAN_GATE');

  // Invalid safe-outputs scalar, invalid work-queue scalar, and invalid double-quote escape
  for (const badFm of [
    '---\nsafe-outputs: invalid_scalar\n---\n# Body',
    '---\ntools:\n  work-queue: invalid_scalar\n---\n# Body',
    '---\nif: "vars.FACTORY_GHAW_ENABLED == \'true\' && !endsWith(github.actor, \'[bot]\')"\ntools:\n  work-queue:\n    issues:\n      label: ""\n---\n# Body',
    '---\nif: "vars.FACTORY_GHAW_ENABLED == \'true\' && !endsWith(github.actor, \'[bot]\')"\ntools:\n  work-queue:\n    issues:\n      label: "   "\n---\n# Body',
    `---\nif: "vars.FACTORY_GHAW_ENABLED == 'true' && !endsWith(github.actor, '[bot]')"\ntools:\n  work-queue:\n    issues:\n      label: ${'a'.repeat(34)}\n---\n# Body`,
    `---\narr: ${'['.repeat(20000)}${']'.repeat(20000)}\n---\n# Body`,
    '---\nif: "vars.FACTORY_GHAW_ENABLED == \'true\' && !endsWith(github.actor, \'[bot]\')"\ntools:\n  work-queue:\n    memory:\n      path: state.json\n---\n# Body',
    `---\nif: "vars.FACTORY_GHAW_ENABLED == 'true' && !endsWith(github.actor, '[bot]')"\ntools:\n  work-queue:\n    memory:\n      path: ../escape.json\n      target-repo: Jamula/SoftwareFactory\n      base-revision: ${checkoutSha}\n      branch-prefix: p\n      schema:\n        type: object\n---\n# Body`,
    `---\nif: "vars.FACTORY_GHAW_ENABLED == 'true' && !endsWith(github.actor, '[bot]')"\ntools:\n  work-queue:\n    memory:\n      path: state.json\n      target-repo: bad_repo\n      base-revision: ${checkoutSha}\n      branch-prefix: p\n      schema:\n        type: object\n---\n# Body`,
    '---\nif: "vars.FACTORY_GHAW_ENABLED == \'true\' && !endsWith(github.actor, \'[bot]\')"\ntools:\n  work-queue:\n    memory:\n      path: state.json\n      target-repo: Jamula/SoftwareFactory\n      base-revision: not-a-sha\n      branch-prefix: p\n      schema:\n        type: object\n---\n# Body',
    `---\nif: "vars.FACTORY_GHAW_ENABLED == 'true' && !endsWith(github.actor, '[bot]')"\ntools:\n  work-queue:\n    memory:\n      path: state.json\n      target-repo: Jamula/SoftwareFactory\n      base-revision: ${checkoutSha}\n      branch-prefix: ""\n      schema:\n        type: object\n---\n# Body`,
    `---\nif: "vars.FACTORY_GHAW_ENABLED == 'true' && !endsWith(github.actor, '[bot]')"\ntools:\n  work-queue:\n    memory:\n      path: state.json\n      target-repo: Jamula/SoftwareFactory\n      base-revision: ${checkoutSha}\n      branch-prefix: p\n      name: 9bad\n      schema:\n        type: object\n---\n# Body`,
    `---\nif: "vars.FACTORY_GHAW_ENABLED == 'true' && !endsWith(github.actor, '[bot]')"\ntools:\n  work-queue:\n    memory:\n      path: state.json\n      target-repo: Jamula/SoftwareFactory\n      base-revision: ${checkoutSha}\n      branch-prefix: p\n      max-bytes: 999999\n      schema:\n        type: object\n---\n# Body`,
    `---\nif: "vars.FACTORY_GHAW_ENABLED == 'true' && !endsWith(github.actor, '[bot]')"\ntools:\n  work-queue:\n    memory:\n      path: state.json\n      target-repo: Jamula/SoftwareFactory\n      base-revision: ${checkoutSha}\n      branch-prefix: p\n      extra-key: true\n      schema:\n        type: object\n---\n# Body`,
    '---\nname: "bad\\xescape"\n---\n# Body',
    '---\njust_a_word_without_colon\n---\n# Body',
    '---\nempty_list_item: [a, ]\n---\n# Body',
    '---\nnested_inline: [{}]\n---\n# Body',
    "---\nbad_single: 'un''escaped'mid'\n---\n# Body",
    '---\nhuge_int: 999999999999999999999999\n---\n# Body',
    '---\n"bad\\xkey": 1\n---\n# Body',
    '---\n<<: merge\n---\n# Body',
    '---\nbad key: 1\n---\n# Body',
    '---\nblock: |\n    line1\n  bad_dedent\n---\n# Body',
    '---\nseq:\n  - "unterminated\n---\n# Body',
    '---\nseq:\n  -\n---\n# Body',
    '---\nseq:\n  - key: |\n        a\n      b\n---\n# Body',
    '---\nseq:\n  - &anchor\n---\n# Body',
    '---\nseq:\n  - k: &anchor\n---\n# Body'
  ]) {
    const s = computeFrontmatterSha256(badFm);
    assert.equal(verifyGhAwWorkflowLock({
      markdownSource: badFm,
      lockYamlSource: lock.replace(sha, s)
    }).reason, 'INVALID_FRONTMATTER');
  }

  // Any configured merge-pull-request (unless explicitly false or absent) MUST be rejected!
  const nonMainMergeMd = [
    '---',
    'name: Feature Merge Only',
    'if: "vars.FACTORY_GHAW_ENABLED == \'true\' && !endsWith(github.actor, \'[bot]\')"',
    'tools:',
    '  work-queue:',
    '    worker: true',
    'empty_inline: [   ]',
    'safe-outputs:',
    '  merge-pull-request:',
    '    branch: [feature-branch]',
    '---',
    '# Body'
  ].join('\n');
  const nonMainSha = computeFrontmatterSha256(nonMainMergeMd);
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: nonMainMergeMd,
    lockYamlSource: lock.replace(sha, nonMainSha)
  }).reason, 'MAIN_MERGE_FORBIDDEN_IN_GHAW');

  const disabledMergeMd = nonMainMergeMd.replace('  merge-pull-request:\n    branch: [feature-branch]', '  merge-pull-request: false');
  const disabledMergeSha = computeFrontmatterSha256(disabledMergeMd);
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: disabledMergeMd,
    lockYamlSource: lock.replace(sha, disabledMergeSha)
  }).valid, true);

  for (const mainBranchArr of ['branch: [main]', 'branch: []']) {
    const badMergeMd = nonMainMergeMd.replace('branch: [feature-branch]', mainBranchArr);
    const badMergeSha = computeFrontmatterSha256(badMergeMd);
    assert.equal(verifyGhAwWorkflowLock({
      markdownSource: badMergeMd,
      lockYamlSource: lock.replace(sha, badMergeSha)
    }).reason, 'MAIN_MERGE_FORBIDDEN_IN_GHAW');
  }

  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: md,
    lockYamlSource: lock,
    pinnedRelease: {version: 123, commit: PINNED_GHAW_RELEASE.commit}
  }).reason, 'PINNED_RELEASE_INVALID');

  // Lock structural denials: scalar job, scalar step, non-string run, safe-outputs write-all, malformed if expressions
  const scalarJobLock = [
    makeMetadataLine({frontmatterHash: sha, bodyHash: bodySha}),
    'on:',
    '  workflow_dispatch:',
    'permissions: {}',
    'jobs:',
    '  evaluate: invalid_job'
  ].join('\n');
  assert.equal(verifyGhAwWorkflowLock({markdownSource: md, lockYamlSource: scalarJobLock}).reason, 'INVALID_LOCK_YAML');

  const implicitSafeMissingEvalNeed = lock.replace(
    '  safe-outputs-implicit:\n    needs:\n      - evaluate\n      - threat-scan',
    '  safe-outputs-implicit:\n    needs:\n      - threat-scan'
  );
  assert.equal(verifyGhAwWorkflowLock({markdownSource: md, lockYamlSource: implicitSafeMissingEvalNeed}).reason, 'MISSING_THREAT_SCAN_GATE');

  for (const malformedEvalIf of [
    '123',
    "''",
    "'${{ }}'",
    "'prefix ${{ true }}'",
    "'vars.X == ''unclosed'",
    "'vars.X == 999999999999999999999999'",
    "'vars.X > 1'",
    "'a.b()'",
    "'a == b == c'",
    "'=='",
    "'('",
    "'endsWith(github.actor, )'",
    `'${'!'.repeat(5000)}true'`,
    `'${'('.repeat(20)}true${')'.repeat(20)}'`,
    `'${Array(40).fill('1 == 1').join(' && ')}'`
  ]) {
    assert.equal(verifyGhAwWorkflowLock({
      markdownSource: md,
      lockYamlSource: lock.replace("1 == 1 && vars.FACTORY_GHAW_ENABLED == 'true' && !endsWith(github.actor, '[bot]')", malformedEvalIf)
    }).reason, 'MISSING_DEFAULT_OFF_GUARD');
  }

  const scalarStepLock = lock.replace('      - name: Threat check\n        run: echo "ok"', '      - scalar_step');
  assert.equal(verifyGhAwWorkflowLock({markdownSource: md, lockYamlSource: scalarStepLock}).reason, 'INVALID_LOCK_YAML');

  const numericRunLock = lock.replace('run: echo "ok"', 'run: 12345');
  assert.equal(verifyGhAwWorkflowLock({markdownSource: md, lockYamlSource: numericRunLock}).reason, 'UNSAFE_RUN_INTERPOLATION');

  const safeWriteAllLock = `${lock}\n  safe-outputs-bad:\n    needs: [threat-scan]\n    permissions: write-all\n    steps:\n      - run: echo "x"`;
  assert.equal(verifyGhAwWorkflowLock({markdownSource: md, lockYamlSource: safeWriteAllLock}).reason, 'EXCESSIVE_SAFE_OUTPUT_PERMISSION');
});

test('verifies compiler-shaped multi-job lock (activation -> agent -> detection -> safe_outputs) and enforces trusted safe-outputs checkout provenance', () => {
  const md = [
    '---',
    'name: Compiler Shaped Workflow',
    'engine: copilot',
    'if: "vars.FACTORY_GHAW_ENABLED == \'true\' && !endsWith(github.actor, \'[bot]\')"',
    'on:',
    '  pull_request_target:',
    'permissions: {}',
    'tools:',
    '  work-queue: true',
    '---',
    '# Body'
  ].join('\n');
  const fmHash = computeFrontmatterSha256(md);
  const bHash = computeBodySha256(md);

  const githubScriptSha = '3a2844b7e9c422d3c10d287c895573f7108da1b3';
  const defaultDetectionSteps = [
    '      - name: Setup gh-aw actions',
    `        uses: github/gh-aw/actions/setup@${PINNED_GHAW_RELEASE.commit}`,
    '      - name: Check if detection needed',
    '        id: detection_guard',
    '        if: always()',
    '        run: echo "run_detection=true" >> "$GITHUB_OUTPUT"',
    '      - name: Execute threat detection with AWF',
    '        id: detection_agentic_execution',
    '        run: threat-detect --engine copilot',
    '      - name: Redact secrets in detection logs',
    '        id: redact_detection_logs',
    "        if: always() && steps.detection_guard.outputs.run_detection == 'true'",
    `        uses: actions/github-script@${githubScriptSha}`,
    '        with:',
    "          script: const { main } = require('/tmp/gh-aw/actions/redact_secrets.cjs'); await main();",
    '      - name: Redact secrets in detection artifacts',
    '        id: redact_detection_artifacts',
    "        if: always() && steps.detection_guard.outputs.run_detection == 'true'",
    `        uses: actions/github-script@${githubScriptSha}`,
    '        with:',
    "          script: const { main } = require('/tmp/gh-aw/actions/redact_secrets.cjs'); await main();",
    '      - name: Parse and conclude threat detection',
    '        id: detection_conclusion',
    "        if: always() && steps.detection_guard.outputs.run_detection == 'false' || (always() && steps.detection_guard.outputs.run_detection == 'true' && steps.redact_detection_logs.outcome == 'success' && steps.redact_detection_artifacts.outcome == 'success')",
    `        uses: actions/github-script@${githubScriptSha}`,
    '        env:',
    '          RUN_DETECTION: ${{ steps.detection_guard.outputs.run_detection }}',
    '          DETECTION_AGENTIC_EXECUTION_OUTCOME: ${{ steps.detection_agentic_execution.outcome }}',
    '          GH_AW_DETECTION_CONTINUE_ON_ERROR: "false"',
    '        with:',
    '          script: |',
    '            try {',
    "              const path = require('path');",
    "              const actionsDir = path.join(process.env.RUNNER_TEMP, 'gh-aw', 'actions');",
    "              const { setupGlobals } = require(path.join(actionsDir, 'setup_globals.cjs'));",
    '              setupGlobals(core, github, context, exec, io, getOctokit);',
    "              const { main } = require(path.join(actionsDir, 'parse_threat_detection_results.cjs'));",
    '              await main();',
    '            } catch (loadErr) {',
    "              const continueOnError = process.env.GH_AW_DETECTION_CONTINUE_ON_ERROR !== 'false';",
    "              const msg = 'ERR_SYSTEM: \\u274C Unexpected error loading threat detection module: ' + (loadErr && loadErr.message ? loadErr.message : String(loadErr));",
    '              core.error(msg);',
    "              core.setOutput('reason', 'parse_error');",
    '              if (continueOnError) {',
    "                core.warning('\\u26A0\\uFE0F ' + msg);",
    "                core.setOutput('conclusion', 'warning');",
    "                core.setOutput('success', 'false');",
    '              } else {',
    "                core.setOutput('conclusion', 'failure');",
    "                core.setOutput('success', 'false');",
    '                core.setFailed(msg);',
    '              }',
    '            }'
  ].join('\n');

  const buildCompilerLock = ({
    onTrigger = '  pull_request_target:',
    activationPerms = '      actions: read\n      contents: read',
    activationIf = "${{ vars.FACTORY_GHAW_ENABLED == 'true' && !endsWith(github.actor, '[bot]') }}",
    agentIf = "${{ needs.activation.result == 'success' }}",
    detectionIf = "always() && needs.agent.result != 'skipped'",
    detectionOutputs = [
      '    outputs:',
      '      detection_success: ${{ steps.detection_conclusion.outputs.success }}',
      '      detection_conclusion: ${{ steps.detection_conclusion.outputs.conclusion }}'
    ].join('\n'),
    detectionHousekeeping = [
      '      - name: Clear agent token usage',
      '        if: always()',
      '        run: rm -f /tmp/gh-aw/agent_usage.json'
    ].join('\n'),
    detectionSteps = defaultDetectionSteps,
    safeIf = "(!cancelled()) && needs.agent.result == 'success' && needs.detection.result == 'success' && needs.detection.outputs.detection_success == 'true'",
    safeCheckoutWith = [
      '          persist-credentials: false',
      '          repository: ${{ github.repository }}',
      '          ref: refs/heads/main'
    ].join('\n')
  } = {}) => [
    makeMetadataLine({frontmatterHash: fmHash, bodyHash: bHash, schemaVersion: 'v4'}),
    'name: "Compiler Shaped Workflow"',
    '"on":',
    onTrigger,
    'permissions: {}',
    'jobs:',
    '  activation:',
    `    if: ${activationIf}`,
    '    runs-on: ubuntu-slim',
    '    permissions:',
    activationPerms,
    '    steps:',
    '      - name: Checkout gh-aw setup',
    `        uses: actions/checkout@${checkoutSha}`,
    '        with:',
    '          repository: github/gh-aw',
    `          ref: ${PINNED_GHAW_RELEASE.commit}`,
    '          persist-credentials: false',
    '  agent:',
    '    needs: [activation]',
    `    if: ${agentIf}`,
    '    runs-on: ubuntu-latest',
    '    permissions:',
    '      contents: read',
    '    steps:',
    '      - name: Agent step',
    '        run: echo "agent"',
    '  detection:',
    '    needs: [agent, activation]',
    `    if: ${detectionIf}`,
    '    runs-on: ubuntu-latest',
    '    permissions:',
    '      contents: read',
    detectionOutputs,
    '    steps:',
    detectionHousekeeping,
    detectionSteps,
    '  safe_outputs:',
    '    needs: [activation, agent, detection]',
    `    if: ${safeIf}`,
    '    runs-on: ubuntu-latest',
    '    permissions:',
    '      issues: write',
    '    steps:',
    '      - name: Checkout control plane',
    `        uses: actions/checkout@${checkoutSha}`,
    '        with:',
    safeCheckoutWith,
    '      - name: Apply safe output',
    '        run: echo "safe"'
  ].join('\n');

  const validCompilerVerdict = verifyGhAwWorkflowLock({
    markdownSource: md,
    lockYamlSource: buildCompilerLock()
  });
  assert.equal(validCompilerVerdict.valid, true);
  assert.equal(validCompilerVerdict.reason, 'GHAW_LOCK_VERIFIED');

  // Pinned github/gh-aw checkout inside safe_outputs is also trusted
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: md,
    lockYamlSource: buildCompilerLock({
      safeCheckoutWith: `          persist-credentials: false\n          repository: github/gh-aw\n          ref: ${PINNED_GHAW_RELEASE.commit}`
    })
  }).valid, true);

  // Helper job requesting write permission is rejected
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: md,
    lockYamlSource: buildCompilerLock({activationPerms: '      actions: write\n      contents: read'})
  }).reason, 'AGENT_JOB_WRITE_PERMISSION');

  // Agent job not inheriting guarded activation when agent lacks direct guards is rejected
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: md,
    lockYamlSource: buildCompilerLock({activationIf: '${{ true }}'})
  }).reason, 'MISSING_DEFAULT_OFF_GUARD');

  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: md,
    lockYamlSource: buildCompilerLock({agentIf: '${{ always() }}'})
  }).reason, 'MISSING_DEFAULT_OFF_GUARD');

  // Untrusted checkout refs/repos (including omitted ref, github.workflow_sha, and unallowlisted 40-hex SHAs) inside write-capable safe_outputs MUST fail closed!
  const unallowlistedSha = 'd'.repeat(40);
  for (const untrustedWith of [
    '          persist-credentials: false',
    '          persist-credentials: false\n          ref: ${{ github.workflow_sha }}',
    `          persist-credentials: false\n          ref: ${unallowlistedSha}`,
    '          persist-credentials: false\n          ref: ${{ github.event.pull_request.head.sha }}',
    '          persist-credentials: false\n          repository: ${{ github.event.pull_request.head.repo.full_name }}\n          ref: refs/heads/main',
    '          persist-credentials: false\n          repository: attacker/fork\n          ref: refs/heads/main',
    '          persist-credentials: false\n          repository: 12345\n          ref: refs/heads/main',
    '          persist-credentials: false\n          ref: feature/untrusted-branch'
  ]) {
    assert.equal(verifyGhAwWorkflowLock({
      markdownSource: md,
      lockYamlSource: buildCompilerLock({safeCheckoutWith: untrustedWith})
    }).reason, 'UNTRUSTED_SAFE_OUTPUT_CHECKOUT');
  }

  // Explicitly allowlisted trustedControlPlaneShas passes; malformed trustedControlPlaneShas fails closed!
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: md,
    lockYamlSource: buildCompilerLock({
      safeCheckoutWith: `          persist-credentials: false\n          repository: Jamula/SoftwareFactory\n          ref: ${unallowlistedSha}`
    }),
    trustedControlPlaneShas: [unallowlistedSha]
  }).valid, true);

  // Also accept detection_conclusion == 'success' gating on safe_outputs, while rejecting skippable housekeeping or missing agent success!
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: md,
    lockYamlSource: buildCompilerLock({
      safeIf: "always() && needs.agent.result == 'success' && needs.detection.result == 'success' && needs.detection.outputs.detection_conclusion == 'success'"
    })
  }).valid, true);

  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: md,
    lockYamlSource: buildCompilerLock({
      safeIf: "(!cancelled()) && needs.agent.result != 'skipped' && needs.detection.result == 'success' && needs.detection.outputs.detection_success == 'true'"
    })
  }).reason, 'MISSING_THREAT_SCAN_GATE');

  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: md,
    lockYamlSource: buildCompilerLock({
      detectionHousekeeping: '      - name: Bad conditional step\n        if: vars.SKIP == \'true\'\n        run: echo "skip"'
    })
  }).reason, 'MISSING_THREAT_SCAN_GATE');

  // always() && false on a detection step OR binding detection_success to an if: always() step MUST fail closed!
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: md,
    lockYamlSource: buildCompilerLock({
      detectionHousekeeping: '      - name: Skipped via always() && false\n        if: always() && false\n        run: echo "skip"'
    })
  }).reason, 'MISSING_THREAT_SCAN_GATE');

  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: md,
    lockYamlSource: buildCompilerLock({
      detectionHousekeeping: '      - name: Conditional step with id\n        id: cond_step\n        if: always()\n        run: echo "cond"',
      detectionOutputs: '    outputs:\n      detection_success: ${{ steps.cond_step.outputs.success }}'
    })
  }).reason, 'MISSING_THREAT_SCAN_GATE');

  // Action-based detection_conclusion MUST fail closed when preceding core scan step is missing or conditional,
  // or when its condition, env bindings, or script violate threat_detection_steps.go's fail-closed contract!
  for (const mutatedDetectionSteps of [
    // Preceding core scan step missing (only housekeeping run step exists)
    defaultDetectionSteps.replace(
      '      - name: Execute threat detection with AWF\n        id: detection_agentic_execution\n        run: threat-detect --engine copilot\n',
      ''
    ),
    // Preceding core scan step is conditional (if: always()) instead of unconditional
    defaultDetectionSteps.replace(
      '        id: detection_agentic_execution\n        run: threat-detect --engine copilot',
      '        id: detection_agentic_execution\n        if: always()\n        run: threat-detect --engine copilot\n      - name: Dummy unconditional\n        run: echo "noop"'
    ),
    // Permissive GH_AW_DETECTION_CONTINUE_ON_ERROR: "true" on detection_conclusion
    defaultDetectionSteps.replace('GH_AW_DETECTION_CONTINUE_ON_ERROR: "false"', 'GH_AW_DETECTION_CONTINUE_ON_ERROR: "true"'),
    // Hardcoded RUN_DETECTION: "false" bypass on detection_conclusion
    defaultDetectionSteps.replace('RUN_DETECTION: ${{ steps.detection_guard.outputs.run_detection }}', 'RUN_DETECTION: "false"'),
    // Script omits parse_threat_detection_results.cjs or hardcodes success
    defaultDetectionSteps.replace('parse_threat_detection_results.cjs', 'noop.cjs'),
    defaultDetectionSteps.replace("                core.setOutput('success', 'false');", "                core.setOutput('success', 'true');"),
    // High-severity spoof vector (discussion_r4717788242): comment naming parse_threat_detection_results.cjs + boolean setOutput('success', true)
    defaultDetectionSteps.replace(
      / {10}script: \|[\s\S]*$/,
      [
        '          script: |',
        '            // parse_threat_detection_results.cjs',
        "            core.setOutput('success', true);"
      ].join('\n')
    ),
    // Extra with: parameter or whitespace-only script on detection_conclusion
    defaultDetectionSteps.replace(
      '          GH_AW_DETECTION_CONTINUE_ON_ERROR: "false"\n        with:\n',
      '          GH_AW_DETECTION_CONTINUE_ON_ERROR: "false"\n        with:\n          result-encoding: string\n'
    ),
    defaultDetectionSteps.replace(/ {10}script: \|[\s\S]*$/, "          script: '   '"),
    // Omitted if: or bare if: always() on detection_conclusion, extra env var, comment-spoofed detection_guard, or spoofed redaction steps
    defaultDetectionSteps.replace(
      "        id: detection_conclusion\n        if: always() && steps.detection_guard.outputs.run_detection == 'false' || (always() && steps.detection_guard.outputs.run_detection == 'true' && steps.redact_detection_logs.outcome == 'success' && steps.redact_detection_artifacts.outcome == 'success')\n",
      '        id: detection_conclusion\n'
    ),
    defaultDetectionSteps.replace(
      "        id: detection_conclusion\n        if: always() && steps.detection_guard.outputs.run_detection == 'false' || (always() && steps.detection_guard.outputs.run_detection == 'true' && steps.redact_detection_logs.outcome == 'success' && steps.redact_detection_artifacts.outcome == 'success')\n",
      '        id: detection_conclusion\n        if: always()\n'
    ),
    defaultDetectionSteps.replace(
      '          GH_AW_DETECTION_CONTINUE_ON_ERROR: "false"',
      '          GH_AW_DETECTION_CONTINUE_ON_ERROR: "false"\n          RUNNER_TEMP: /tmp/attacker'
    ),
    defaultDetectionSteps.replace('run_detection=true', 'run_detection=false'),
    defaultDetectionSteps.replace(
      '        run: echo "run_detection=true" >> "$GITHUB_OUTPUT"',
      '        run: |\n          # run_detection=true\n          echo "run_detection=false" >> "$GITHUB_OUTPUT"'
    ),
    defaultDetectionSteps.replace(
      "          script: const { main } = require('/tmp/gh-aw/actions/redact_secrets.cjs'); await main();",
      "          script: core.info('spoofed redaction');"
    ),
    defaultDetectionSteps.replace(
      "        id: redact_detection_logs\n        if: always() && steps.detection_guard.outputs.run_detection == 'true'\n",
      '        id: redact_detection_logs\n'
    ),
    // Missing github/gh-aw/actions/setup, custom destination, unverified preceding uses:, or module-replacing run: step MUST fail closed!
    defaultDetectionSteps.replace(
      `      - name: Setup gh-aw actions\n        uses: github/gh-aw/actions/setup@${PINNED_GHAW_RELEASE.commit}\n`,
      ''
    ),
    defaultDetectionSteps.replace(
      `        uses: github/gh-aw/actions/setup@${PINNED_GHAW_RELEASE.commit}`,
      `        uses: github/gh-aw/actions/setup@${PINNED_GHAW_RELEASE.commit}\n        with:\n          destination: /tmp/untrusted`
    ),
    defaultDetectionSteps.replace(
      '      - name: Execute threat detection with AWF\n',
      '      - name: Overwrite actions module\n        run: cp /tmp/evil.cjs "$RUNNER_TEMP/gh-aw/actions/parse_threat_detection_results.cjs"\n      - name: Execute threat detection with AWF\n'
    ),
    defaultDetectionSteps.replace(
      '      - name: Execute threat detection with AWF\n',
      `      - uses: actions/github-script@${githubScriptSha}\n        with:\n          script: core.info('tamper');\n      - name: Execute threat detection with AWF\n`
    ),
    // Linear-time O(N) rejection of malformed threat-detect ' ---' repetitions (CodeQL ReDoS regression)
    defaultDetectionSteps.replace(
      '        run: threat-detect --engine copilot',
      `        run: threat-detect${' ---'.repeat(60)}`
    ),
    defaultDetectionSteps.replace(
      / {6}- name: Redact secrets in detection logs[\s\S]*?- name: Redact secrets in detection artifacts/,
      '      - name: Redact secrets in detection artifacts'
    ),
    defaultDetectionSteps.replace(
      / {6}- name: Redact secrets in detection artifacts[\s\S]*?- name: Parse and conclude threat detection/,
      '      - name: Parse and conclude threat detection'
    ),
    // Tampered step conditions on redact_detection_logs or detection_conclusion
    defaultDetectionSteps.replace(
      "        id: redact_detection_logs\n        if: always() && steps.detection_guard.outputs.run_detection == 'true'",
      '        id: redact_detection_logs\n        if: always() && false'
    ),
    defaultDetectionSteps.replace(
      "        if: always() && steps.detection_guard.outputs.run_detection == 'false' || (always() && steps.detection_guard.outputs.run_detection == 'true' && steps.redact_detection_logs.outcome == 'success' && steps.redact_detection_artifacts.outcome == 'success')",
      '        if: always() && false'
    ),
    defaultDetectionSteps.replace(
      "        if: always() && steps.detection_guard.outputs.run_detection == 'false' || (always() && steps.detection_guard.outputs.run_detection == 'true' && steps.redact_detection_logs.outcome == 'success' && steps.redact_detection_artifacts.outcome == 'success')",
      "        if: always() && steps.detection_guard.outputs.run_detection == 'false' || false"
    )
  ]) {
    assert.equal(verifyGhAwWorkflowLock({
      markdownSource: md,
      lockYamlSource: buildCompilerLock({detectionSteps: mutatedDetectionSteps})
    }).reason, 'MISSING_THREAT_SCAN_GATE');
  }

  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: md,
    lockYamlSource: buildCompilerLock({
      detectionIf: "failure() && needs.agent.result != 'skipped'"
    })
  }).reason, 'MISSING_THREAT_SCAN_GATE');

  for (const badShas of [null, ['not-a-sha'], new Array(1)]) {
    assert.equal(verifyGhAwWorkflowLock({
      markdownSource: md,
      lockYamlSource: buildCompilerLock(),
      trustedControlPlaneShas: badShas
    }).reason, 'INVALID_LOCK_INPUT');
    assert.equal(verifyGhAwWorkflowLock({
      markdownSource: md,
      lockYamlSource: buildCompilerLock(),
      trustedDetectionScriptSha256s: badShas
    }).reason, 'INVALID_LOCK_INPUT');
    assert.equal(verifyGhAwWorkflowLock({
      markdownSource: md,
      lockYamlSource: buildCompilerLock(),
      trustedPolicyScanRunSha256s: badShas
    }).reason, 'INVALID_LOCK_INPUT');
  }

  // Also accept upstream buildDetectionGuardStep script when OUTPUT_TYPES and HAS_PATCH env bindings are verified
  const upstreamGuardScriptSteps = defaultDetectionSteps.replace(
    '        id: detection_guard\n        if: always()\n        run: echo "run_detection=true" >> "$GITHUB_OUTPUT"',
    [
      '        id: detection_guard',
      '        if: always()',
      '        env:',
      '          OUTPUT_TYPES: ${{ needs.agent.outputs.output_types }}',
      '          HAS_PATCH: ${{ needs.agent.outputs.has_patch }}',
      '        run: |',
      '          if [[ -n "$OUTPUT_TYPES" || "$HAS_PATCH" == "true" ]]; then',
      '            echo "run_detection=true" >> "$GITHUB_OUTPUT"',
      '            echo "Detection will run: output_types=$OUTPUT_TYPES, has_patch=$HAS_PATCH"',
      '          else',
      '            echo "run_detection=false" >> "$GITHUB_OUTPUT"',
      '            echo "Detection skipped: no agent outputs or patches to analyze"',
      '          fi'
    ].join('\n')
  );
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: md,
    lockYamlSource: buildCompilerLock({
      detectionHousekeeping: '',
      detectionSteps: upstreamGuardScriptSteps
    })
  }).valid, true);
  // Upstream guard script WITHOUT OUTPUT_TYPES/HAS_PATCH bindings, mismatched deps, or bound to helper job (needs.activation) MUST fail closed!
  for (const invalidGuardSteps of [
    upstreamGuardScriptSteps.replace('          OUTPUT_TYPES: ${{ needs.agent.outputs.output_types }}\n', ''),
    upstreamGuardScriptSteps.replace('needs.agent.outputs.has_patch', 'needs.other.outputs.has_patch'),
    upstreamGuardScriptSteps
      .replace('needs.agent.outputs.output_types', 'needs.activation.outputs.output_types')
      .replace('needs.agent.outputs.has_patch', 'needs.activation.outputs.has_patch')
  ]) {
    assert.equal(verifyGhAwWorkflowLock({
      markdownSource: md,
      lockYamlSource: buildCompilerLock({
        detectionHousekeeping: '',
        detectionSteps: invalidGuardSteps
      })
    }).reason, 'MISSING_THREAT_SCAN_GATE');
  }

  // Case-folded checkout keys (Repository / Ref) and INPUT_* env overrides inside write-capable safe_outputs MUST fail closed!
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: md,
    lockYamlSource: buildCompilerLock({
      safeCheckoutWith: '          persist-credentials: false\n          Repository: attacker/evil-fork\n          ref: refs/heads/main'
    })
  }).reason, 'UNTRUSTED_SAFE_OUTPUT_CHECKOUT');
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: md,
    lockYamlSource: buildCompilerLock({
      safeCheckoutWith: '          persist-credentials: false\n          ref: refs/heads/main\n          Ref: refs/pull/1/head'
    })
  }).reason, 'CHECKOUT_CREDENTIALS_PERSISTED');
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: md,
    lockYamlSource: buildCompilerLock().replace('      - name: Checkout control plane\n', '      - name: Checkout control plane\n        env:\n          INPUT_REF: refs/pull/1/head\n')
  }).reason, 'UNTRUSTED_SAFE_OUTPUT_CHECKOUT');
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: md,
    lockYamlSource: buildCompilerLock({
      detectionOutputs: '    outputs:\n      detection_success: ${{ steps.detection_agentic_execution.outputs.success }}'
    })
  }).reason, 'MISSING_THREAT_SCAN_GATE');

  // Explicit caller-provided 64-hex SHA-256 allowlist for custom reviewed detection_conclusion script
  const customReviewedDetectionScript = [
    "const { main } = require('/opt/gh-aw-reviewed/parse_threat_detection_results.cjs');",
    'await main();'
  ].join('\n');
  const customDetectionDigest = computeNormalizedScriptSha256(customReviewedDetectionScript);
  assert.match(customDetectionDigest, /^[a-f0-9]{64}$/);
  assert.notEqual(customDetectionDigest, PINNED_GHAW_DETECTION_CONCLUSION_SCRIPT_SHA256);
  const customDetectionLock = buildCompilerLock({
    detectionSteps: defaultDetectionSteps.replace(
      / {10}script: \|[\s\S]*$/,
      [
        '          script: |',
        ...customReviewedDetectionScript.split('\n').map(line => `            ${line}`)
      ].join('\n')
    )
  });
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: md,
    lockYamlSource: customDetectionLock
  }).reason, 'MISSING_THREAT_SCAN_GATE');
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: md,
    lockYamlSource: customDetectionLock,
    trustedDetectionScriptSha256s: [customDetectionDigest]
  }).valid, true);
});

test('enforces exact SHA-256 normalized script digest on run: scan-output producers and rejects comment/setter spoofs', () => {
  assert.match(PINNED_GHAW_DETECTION_CONCLUSION_SCRIPT_SHA256, /^[a-f0-9]{64}$/);
  assert.match(PINNED_FACTORY_POLICY_SCAN_RUN_SHA256, /^[a-f0-9]{64}$/);

  const sampleScript = 'set -euo pipefail\necho "ok"';
  assert.equal(
    computeNormalizedScriptSha256(`\n  ${sampleScript}  \r\n`),
    computeNormalizedScriptSha256(sampleScript)
  );
  for (const invalidScript of [null, 42, '', '   \n  ', 'echo\ttab', 'echo \u0000', 'a\rb']) {
    assert.equal(computeNormalizedScriptSha256(invalidScript), null);
  }

  // Spoofed run: producers (raw echo, comment-prefixed echo, working-directory hijack, NODE_OPTIONS hijack) MUST fail closed!
  const canonicalRunOnly = canonicalPolicyScanSteps.replace('      - name: Scan\n        id: policy_scan\n', '');
  for (const spoofedThreatSteps of [
    '      - name: Spoofed echo scan\n        id: policy_scan\n        run: echo "scan_verified=true" >> "$GITHUB_OUTPUT"',
    [
      '      - name: Comment-spoofed scan',
      '        id: policy_scan',
      '        run: |',
      '          # verifyGhAwWorkflowLock({markdownSource, lockYamlSource})',
      '          echo "scan_verified=true" >> "$GITHUB_OUTPUT"'
    ].join('\n'),
    `      - name: Working-dir hijacked scan\n        id: policy_scan\n        working-directory: /tmp/untrusted\n${canonicalRunOnly}`,
    `      - name: Custom-shell hijacked scan\n        id: policy_scan\n        shell: "bash -c 'echo scan_verified=true >> \\"$GITHUB_OUTPUT\\"' {0}"\n${canonicalRunOnly}`,
    `      - name: NODE_OPTIONS hijacked scan\n        id: policy_scan\n        env:\n          NODE_OPTIONS: --require=/tmp/evil.cjs\n${canonicalRunOnly}`,
    `      - name: BASH_ENV hijacked scan\n        id: policy_scan\n        env:\n          BASH_ENV: /tmp/evil.sh\n${canonicalRunOnly}`,
    `      - name: Exported Bash function hijacked scan\n        id: policy_scan\n        env:\n          "BASH_FUNC_node%%": "() { return 0; }"\n${canonicalRunOnly}`,
    `      - name: GITHUB_REF env hijacked scan\n        id: policy_scan\n        env:\n          GITHUB_REF: refs/heads/main\n${canonicalRunOnly}`,
    `      - name: Scalar env scan\n        id: policy_scan\n        env: invalid_scalar\n${canonicalRunOnly}`
  ]) {
    const spoofed = buildFixture({
      threatSteps: spoofedThreatSteps,
      safeIf: "${{ needs.evaluate.result == 'success' && needs.threat-and-policy-scan.result == 'success' && needs.threat-and-policy-scan.outputs.scan_verified == 'true' }}"
    });
    assert.equal(verifyGhAwWorkflowLock({
      markdownSource: spoofed.markdownSource,
      lockYamlSource: spoofed.lockYamlSource
    }).reason, 'MISSING_THREAT_SCAN_GATE');
  }

  // Workflow-level and scan-job-level defaults/container/env hijacks MUST fail closed!
  const validSafeBase = buildFixture({
    safeIf: "${{ needs.evaluate.result == 'success' && needs.threat-and-policy-scan.result == 'success' && needs.threat-and-policy-scan.outputs.scan_verified == 'true' }}"
  });
  for (const hijackedLock of [
    validSafeBase.lockYamlSource.replace('jobs:\n', 'defaults:\n  run:\n    working-directory: /tmp/untrusted\njobs:\n'),
    validSafeBase.lockYamlSource.replace('jobs:\n', 'env:\n  PATH: /tmp/fake-bin:/usr/bin\njobs:\n'),
    validSafeBase.lockYamlSource.replace('  threat-and-policy-scan:\n', '  threat-and-policy-scan:\n    defaults:\n      run:\n        working-directory: /tmp/untrusted\n'),
    validSafeBase.lockYamlSource.replace('  threat-and-policy-scan:\n', '  threat-and-policy-scan:\n    container: alpine:3.20\n'),
    validSafeBase.lockYamlSource.replace('  threat-and-policy-scan:\n', '  threat-and-policy-scan:\n    env:\n      NODE_OPTIONS: --require=/tmp/evil.cjs\n'),
    // Untrusted checkout or workspace-mutating run step before policy_scan in threat-and-policy-scan MUST fail closed!
    validSafeBase.lockYamlSource.replace(
      '      - name: Scan\n',
      `      - uses: actions/checkout@${checkoutSha}\n        with:\n          persist-credentials: false\n          repository: attacker/evil-fork\n          ref: refs/heads/main\n      - name: Scan\n`
    ),
    validSafeBase.lockYamlSource.replace(
      '      - name: Scan\n',
      `      - uses: actions/checkout@${checkoutSha}\n        with:\n          persist-credentials: false\n          path: sub\n      - name: Scan\n`
    ),
    validSafeBase.lockYamlSource.replace(
      '      - name: Scan\n',
      '      - name: Tamper workspace\n        run: echo "evil"\n      - name: Scan\n'
    ),
    // Preceding actions/github-script (or setup-node with cache/unknown inputs) before policy_scan MUST fail closed!
    validSafeBase.lockYamlSource.replace(
      '      - name: Scan\n',
      '      - uses: actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3\n        with:\n          script: require("fs").writeFileSync("tools/engineering-factory/gh-aw-lock-verifier.mjs", "export const verifyGhAwWorkflowLock = () => ({valid:true,liveDispatch:false,liveMerge:false});");\n      - name: Scan\n'
    ),
    validSafeBase.lockYamlSource.replace(
      '      - name: Scan\n',
      `      - uses: actions/setup-node@${setupNodeSha}\n        with:\n          node-version: '26.13.1'\n          package-manager-cache: true\n      - name: Scan\n`
    ),
    // Omitted ref in scan-job actions/checkout on workflow_dispatch WITHOUT case-sensitive protected default-branch provenance (with or without job.if) MUST fail closed!
    validSafeBase.lockYamlSource.replace(
      '      - name: Scan\n',
      `      - uses: actions/checkout@${checkoutSha}\n        with:\n          persist-credentials: false\n      - name: Scan\n`
    ),
    validSafeBase.lockYamlSource
      .replace("    if: ${{ vars.FACTORY_GHAW_ENABLED == 'true' && needs.evaluate.result == 'success' && !endsWith(github.actor, '[bot]') }}\n", '')
      .replace(
        '      - name: Scan\n',
        `      - uses: actions/checkout@${checkoutSha}\n        with:\n          persist-credentials: false\n      - name: Scan\n`
      )
  ]) {
    assert.equal(verifyGhAwWorkflowLock({
      markdownSource: validSafeBase.markdownSource,
      lockYamlSource: hijackedLock
    }).reason, 'MISSING_THREAT_SCAN_GATE');
  }

  // Omitted ref or github.workflow_sha in scan-job checkout succeeds when evaluate establishes protected default-branch provenance, and fails otherwise
  const evalRefProvFixture = buildFixture({
    evaluateIf: "${{ vars.FACTORY_GHAW_ENABLED == 'true' && github.ref == 'refs/heads/main' && github.ref_protected == true && !endsWith(github.actor, '[bot]') }}",
    runBody: '          set -euo pipefail\n          test "$GITHUB_REF" = refs/heads/main\n          test "$GITHUB_REF_PROTECTED" = true',
    threatSteps: `      - uses: actions/checkout@${checkoutSha}\n        with:\n          persist-credentials: false\n${canonicalPolicyScanSteps}`
  });
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: evalRefProvFixture.markdownSource,
    lockYamlSource: evalRefProvFixture.lockYamlSource
  }).valid, true);

  for (const invalidScanWorkflowShaFixture of [
    buildFixture({
      threatSteps: `      - uses: actions/checkout@${checkoutSha}\n        with:\n          repository: Jamula/SoftwareFactory\n          ref: \${{ github.workflow_sha }}\n          persist-credentials: false\n${canonicalPolicyScanSteps}`
    }),
    buildFixture({
      threatSteps: `      - uses: actions/checkout@${checkoutSha}\n        with:\n          repository: 12345\n          ref: \${{ github.workflow_sha }}\n          persist-credentials: false\n${canonicalPolicyScanSteps}`
    }),
    buildFixture({
      threatSteps: `      - uses: actions/checkout@${checkoutSha}\n        with:\n          repository: attacker/evil-fork\n          ref: \${{ github.workflow_sha }}\n          persist-credentials: false\n${canonicalPolicyScanSteps}`
    })
  ]) {
    assert.equal(verifyGhAwWorkflowLock({
      markdownSource: invalidScanWorkflowShaFixture.markdownSource,
      lockYamlSource: invalidScanWorkflowShaFixture.lockYamlSource
    }).reason, 'MISSING_THREAT_SCAN_GATE');
  }

  // Explicit caller-provided 64-hex SHA-256 allowlist for custom reviewed policy_scan run script
  const customPolicyRun = 'set -euo pipefail\nnode ./tools/custom-reviewed-policy-scan.mjs\necho "scan_verified=true" >> "$GITHUB_OUTPUT"';
  const customPolicyDigest = computeNormalizedScriptSha256(customPolicyRun);
  assert.notEqual(customPolicyDigest, PINNED_FACTORY_POLICY_SCAN_RUN_SHA256);
  const customPolicyFixture = buildFixture({
    threatSteps: [
      '      - name: Custom reviewed policy scan',
      '        id: policy_scan',
      '        run: |',
      ...customPolicyRun.split('\n').map(line => `          ${line}`)
    ].join('\n'),
    safeIf: "${{ needs.evaluate.result == 'success' && needs.threat-and-policy-scan.result == 'success' && needs.threat-and-policy-scan.outputs.scan_verified == 'true' }}"
  });
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: customPolicyFixture.markdownSource,
    lockYamlSource: customPolicyFixture.lockYamlSource
  }).reason, 'MISSING_THREAT_SCAN_GATE');
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: customPolicyFixture.markdownSource,
    lockYamlSource: customPolicyFixture.lockYamlSource,
    trustedPolicyScanRunSha256s: [customPolicyDigest]
  }).valid, true);
});

test('verifies Issue #5 event trigger matrix, 10-minute default-off recovery schedule, and zero untrusted PR-text interpolation', () => {
  const shadowReconcileYaml = readFileSync(resolve(repoRoot, '.github/workflows/shadow-reconcile.yml'), 'utf8');
  const shadowVerdict = verifyEventTriggerMatrix(shadowReconcileYaml);
  assert.equal(shadowVerdict.valid, true);
  assert.equal(shadowVerdict.shadow, true);
  assert.equal(shadowVerdict.liveDispatch, false);
  assert.equal(shadowVerdict.liveMerge, false);
  assert.equal(shadowVerdict.reason, 'EVENT_TRIGGER_MATRIX_VERIFIED');
  assert.deepEqual(shadowVerdict.triggers, [
    'issues',
    'pull_request_target',
    'push',
    'schedule',
    'workflow_dispatch',
    'workflow_run'
  ]);
  assert.deepEqual(shadowVerdict.recoverySchedule, {
    cron: '3,13,23,33,43,53 * * * *',
    intervalMinutes: 10,
    offMinute: true,
    minuteOffsets: [3, 13, 23, 33, 43, 53]
  });
  assert.deepEqual(shadowVerdict.defaultOffVars, ['FACTORY_SHADOW_ENABLED']);
  assert.equal(shadowVerdict.targetBranch, 'main');
  assert.equal(Object.isFrozen(shadowVerdict), true);
  assert.equal(Object.isFrozen(shadowVerdict.recoverySchedule), true);

  // Tracked factory-orchestrator.lock.yml wires the full #5 event matrix + default-off 10-minute recovery schedule
  const orchestratorLock = readFileSync(resolve(repoRoot, '.github/workflows/factory-orchestrator.lock.yml'), 'utf8');
  const orchestratorVerdict = verifyEventTriggerMatrix(orchestratorLock);
  assert.equal(orchestratorVerdict.valid, true);
  assert.equal(orchestratorVerdict.reason, 'EVENT_TRIGGER_MATRIX_VERIFIED');
  assert.deepEqual(orchestratorVerdict.triggers, [
    'issues',
    'pull_request_target',
    'push',
    'schedule',
    'workflow_dispatch',
    'workflow_run'
  ]);
  assert.deepEqual(orchestratorVerdict.recoverySchedule, {
    cron: '3,13,23,33,43,53 * * * *',
    intervalMinutes: 10,
    offMinute: true,
    minuteOffsets: [3, 13, 23, 33, 43, 53]
  });
  assert.deepEqual(orchestratorVerdict.defaultOffVars, ['FACTORY_GHAW_ENABLED']);
  assert.equal(orchestratorVerdict.targetBranch, 'main');

  // Partial workflow_dispatch-only fixture fails strict schedule requirement unless partial options are explicitly passed
  const dispatchOnlyLock = [
    'name: Dispatch only orchestrator',
    'on:',
    '  workflow_dispatch:',
    'permissions:',
    '  contents: read',
    'concurrency:',
    '  group: factory-dispatch-only-${{ github.ref }}',
    '  cancel-in-progress: false',
    'jobs:',
    '  evaluate:',
    "    if: ${{ vars.FACTORY_GHAW_ENABLED == 'true' && !endsWith(github.actor, '[bot]') }}",
    '    runs-on: ubuntu-latest',
    '    permissions:',
    '      contents: read',
    '    steps:',
    '      - run: echo "dispatch only"'
  ].join('\n');
  assert.equal(verifyEventTriggerMatrix(dispatchOnlyLock).reason, 'MISSING_RECOVERY_SCHEDULE');
  const partialOrchestrator = verifyEventTriggerMatrix(dispatchOnlyLock, {
    requireRecoverySchedule: false,
    allowPartialTriggers: true
  });
  assert.equal(partialOrchestrator.valid, true);
  assert.equal(partialOrchestrator.recoverySchedule, null);
  assert.deepEqual(partialOrchestrator.defaultOffVars, ['FACTORY_GHAW_ENABLED']);

  const wrGuardClause = " && (github.event_name != 'workflow_run' || github.event.workflow_run.head_repository.id == 1471342715)";
  const guardedMainEvalIf = `\${{ vars.FACTORY_GHAW_ENABLED == 'true' && github.ref == 'refs/heads/main' && github.ref_protected == true && !endsWith(github.actor, '[bot]')${wrGuardClause} }}`;
  const buildMatrixYaml = ({
    cron = "'3,13,23,33,43,53 * * * *'",
    includeReview = true,
    extraTrigger = '',
    topPerms = '  contents: read',
    topConcurrency = 'concurrency:\n  group: factory-event-matrix-${{ github.ref }}\n  cancel-in-progress: false',
    evalIf = `\${{ vars.FACTORY_GHAW_ENABLED == 'true' && !endsWith(github.actor, '[bot]')${wrGuardClause} }}`,
    evalPerms = '      contents: read',
    evalConcurrency = '',
    checkoutUses = `actions/checkout@${checkoutSha}`,
    checkoutWith = '          persist-credentials: false\n          repository: ${{ github.repository }}\n          ref: refs/heads/main',
    stepEnv = '          FACTORY_PULL_NUMBER: ${{ github.event.pull_request.number }}\n          FACTORY_PULL_HEAD: ${{ github.event.pull_request.head.sha }}',
    stepIf = '',
    stepRun = '          echo "reconcile metadata only"',
    extraJobs = [
      '  threat-and-policy-scan:',
      '    needs: [evaluate]',
      "    if: always() && needs.evaluate.result != 'skipped'",
      '    runs-on: ubuntu-latest',
      '    permissions:',
      '      contents: read',
      '    steps:',
      '      - run: echo "scan"',
      '  safe-outputs-noop:',
      '    needs: [evaluate, threat-and-policy-scan]',
      '    if: ${{ false }}',
      '    runs-on: ubuntu-latest',
      '    permissions:',
      '      issues: write',
      '    steps:',
      '      - run: echo "disabled"'
    ].join('\n')
  } = {}) => [
    'name: Event Matrix Orchestrator',
    'on:',
    '  workflow_dispatch:',
    '    inputs:',
    '      issue_number:',
    '        type: string',
    cron === null ? '' : `  schedule:\n    - cron: ${cron}`,
    '  issues:',
    '    types: [opened, edited, labeled, unlabeled, closed, reopened]',
    '  pull_request_target:',
    '    branches: [main]',
    '    types: [opened, reopened, synchronize, ready_for_review, closed]',
    includeReview ? '  pull_request_review:\n    types: [submitted, edited, dismissed]' : '',
    '  push:',
    '    branches: [main]',
    '  workflow_run:',
    '    workflows: ["Factory validation"]',
    '    types: [completed]',
    '    branches: [main]',
    extraTrigger,
    'permissions:',
    topPerms,
    topConcurrency,
    'jobs:',
    '  evaluate:',
    evalIf === null ? '' : `    if: ${evalIf}`,
    evalConcurrency,
    '    runs-on: ubuntu-latest',
    evalPerms === null ? '' : `    permissions:\n${evalPerms}`,
    '    steps:',
    `      - uses: ${checkoutUses}`,
    '        with:',
    checkoutWith,
    '      - name: Metadata reconcile',
    stepIf ? `        if: ${stepIf}` : '',
    '        env:',
    stepEnv,
    '        run: |',
    stepRun,
    extraJobs
  ].filter(Boolean).join('\n');

  const fullMatrix = verifyEventTriggerMatrix(buildMatrixYaml());
  assert.equal(fullMatrix.valid, true);
  assert.equal(fullMatrix.triggers.includes('pull_request_review'), true);

  // Alternate valid 10-minute cron forms (*/10 and off-minute range/step 7-59/10)
  const stepTen = verifyEventTriggerMatrix(buildMatrixYaml({cron: "'*/10 * * * *'"}));
  assert.equal(stepTen.valid, true);
  assert.equal(stepTen.recoverySchedule.offMinute, false);
  assert.deepEqual(stepTen.recoverySchedule.minuteOffsets, [0, 10, 20, 30, 40, 50]);

  const rangeTen = verifyEventTriggerMatrix(buildMatrixYaml({cron: "'7-59/10 * * * *'"}));
  assert.equal(rangeTen.valid, true);
  assert.equal(rangeTen.recoverySchedule.offMinute, true);
  assert.deepEqual(rangeTen.recoverySchedule.minuteOffsets, [7, 17, 27, 37, 47, 57]);

  // Custom targetBranch option
  const customBranchYaml = buildMatrixYaml({includeReview: false})
    .replaceAll('branches: [main]', 'branches: [release/v1]')
    .replace('ref: refs/heads/main', 'ref: refs/heads/release/v1');
  assert.equal(verifyEventTriggerMatrix(customBranchYaml, {targetBranch: 'release/v1'}).valid, true);

  // Invalid inputs & options (including proxies) fail closed
  const revokedOpt = Proxy.revocable({}, {});
  revokedOpt.revoke();
  for (const [badSrc, badOpt] of [
    [null, undefined],
    ['', undefined],
    ['name:\tbad', undefined],
    [shadowReconcileYaml, revokedOpt.proxy],
    [shadowReconcileYaml, null],
    [shadowReconcileYaml, {unknownOpt: true}],
    [shadowReconcileYaml, {requireRecoverySchedule: 'yes'}],
    [shadowReconcileYaml, {allowPartialTriggers: 1}],
    [shadowReconcileYaml, {targetBranch: '../bad'}],
    [shadowReconcileYaml, {targetBranch: 'bad//ref'}],
    [shadowReconcileYaml, {targetBranch: 'bad/'}],
    [shadowReconcileYaml, {targetBranch: 'bad.lock'}],
    [shadowReconcileYaml, {trustedControlPlaneShas: ['bad-sha']}]
  ]) {
    assert.equal(verifyEventTriggerMatrix(badSrc, badOpt).reason, 'INVALID_LOCK_INPUT');
  }

  for (const badYaml of [
    'name: missing_sections',
    'on:\n  workflow_dispatch:\npermissions: {}\njobs:\n  evaluate: scalar',
    'on:\n  workflow_dispatch:\npermissions: {}\njobs:\n  evaluate:\n    steps: []',
    'on:\n  workflow_dispatch:\npermissions: {}\njobs:\n  evaluate:\n    steps:\n      - scalar_step'
  ]) {
    assert.equal(verifyEventTriggerMatrix(badYaml, {
      requireRecoverySchedule: false,
      allowPartialTriggers: true
    }).reason, 'INVALID_LOCK_YAML');
  }

  // Unsupported triggers MUST fail closed
  for (const unsupported of [
    '  pull_request:\n    branches: [main]',
    '  issue_comment:\n    types: [created]',
    '  pull_request_review_comment:\n    types: [created]',
    '  repository_dispatch:',
    '  merge_group:'
  ]) {
    assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({extraTrigger: unsupported})).reason, 'UNSUPPORTED_EVENT_TRIGGER');
  }

  // Invalid recovery schedules MUST fail closed
  for (const badCron of [
    "'*/5 * * * *'",
    "'* * * * *'",
    "'0 * * * *'",
    "'3,13,23,33,43,54 * * * *'",
    "'9-53/10 * * * *'",
    "'10,20,30,40,50,59 * * * *'",
    "'3,13,23 * * * *'",
    "'3,13,23,33,43,53 0 * * *'",
    '12345'
  ]) {
    assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({cron: badCron})).reason, 'INVALID_RECOVERY_SCHEDULE');
  }
  const duplicateScheduleYaml = buildMatrixYaml().replace(
    "  schedule:\n    - cron: '3,13,23,33,43,53 * * * *'",
    "  schedule:\n    - cron: '3,13,23,33,43,53 * * * *'\n    - cron: '7,17,27,37,47,57 * * * *'"
  );
  assert.equal(verifyEventTriggerMatrix(duplicateScheduleYaml).reason, 'INVALID_RECOVERY_SCHEDULE');

  // Schedule-only workflow or missing core #5 triggers MUST fail closed
  assert.equal(
    verifyEventTriggerMatrix("name: PollOnly\non:\n  schedule:\n    - cron: '3,13,23,33,43,53 * * * *'\npermissions: {}\njobs:\n  evaluate:\n    steps:\n      - run: echo x", {allowPartialTriggers: true}).reason,
    'MISSING_REQUIRED_EVENT_TRIGGER'
  );
  assert.equal(
    verifyEventTriggerMatrix(buildMatrixYaml().replace('  push:\n    branches: [main]\n', '')).reason,
    'MISSING_REQUIRED_EVENT_TRIGGER'
  );

  // Per-trigger configuration violations MUST fail closed
  for (const mutatedConfig of [
    buildMatrixYaml().replace('  workflow_dispatch:\n    inputs:\n      issue_number:\n        type: string', '  workflow_dispatch: invalid_scalar'),
    buildMatrixYaml().replace('    inputs:\n      issue_number:\n        type: string', '    inputs: invalid_scalar'),
    buildMatrixYaml().replace('    types: [opened, edited, labeled, unlabeled, closed, reopened]', '    types: [unknown_type]'),
    buildMatrixYaml().replace('    types: [opened, edited, labeled, unlabeled, closed, reopened]', '    types: [opened, opened]'),
    buildMatrixYaml().replace('  pull_request_target:\n    branches: [main]', '  pull_request_target:\n    branches: ["*"]'),
    buildMatrixYaml().replace('  pull_request_review:\n    types: [submitted, edited, dismissed]', '  pull_request_review:\n    types: [pending]'),
    buildMatrixYaml().replace('    workflows: ["Factory validation"]', '    workflows: []'),
    buildMatrixYaml().replace('    types: [completed]', '    types: [requested]'),
    buildMatrixYaml().replace('  push:\n    branches: [main]', '  push:\n    branches: [develop]')
  ]) {
    assert.equal(verifyEventTriggerMatrix(mutatedConfig).reason, 'INVALID_EVENT_TRIGGER_CONFIG');
  }

  // Untrusted PR-text / event-payload interpolations MUST fail closed across env, with, if, name, and case/bracket variants!
  for (const untrustedEnv of [
    '          PR_TITLE: ${{ github.event.pull_request.title }}',
    '          PR_BODY: ${{ github.event.pull_request.body }}',
    '          PR_HEAD_REF: ${{ github.event.pull_request.head.ref }}',
    '          ISSUE_BODY: ${{ github.event.issue.body }}',
    '          REVIEW_BODY: ${{ github.event.review.body }}',
    '          COMMENT_BODY: ${{ github.event.comment.body }}',
    '          COMMIT_MSG: ${{ github.event.head_commit.message }}',
    '          RUN_TITLE: ${{ github.event.workflow_run.display_title }}',
    '          HEAD_REF: ${{ github.head_ref }}',
    '          UPPER_CASE: ${{ GITHUB.EVENT.PULL_REQUEST.TITLE }}',
    "          BRACKET: ${{ github.event['pull_request']['body'] }}",
    '          RAW_EVENT: ${{ toJSON(github.event) }}',
    '          UNCLOSED_EXPR: "${{ github.event.number"',
    '          STRAY_CLOSE: "value }} ${{ github.event.number }}"',
    "          UNCLOSED_QUOTE: \"${{ 'unclosed }}\""
  ]) {
    assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({stepEnv: untrustedEnv})).reason, 'UNTRUSTED_PR_TEXT_INTERPOLATION');
  }
  for (const untrustedStepIf of [
    "contains(github.event.pull_request.body, '/ship')",
    "${{ github.event.issue.title == 'urgent' }}",
    "${{ true }} && github.event.pull_request.title != ''",
    "github.event.pull_request.title != '' && ${{ true }}"
  ]) {
    assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({stepIf: untrustedStepIf})).reason, 'UNTRUSTED_PR_TEXT_INTERPOLATION');
  }
  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({
    stepIf: "${{ github.event_name != 'it''s_github.event.pull_request.body' }}"
  })).valid, true);
  // Sequence string elements (e.g. strategy.matrix.payload array) AND matrix axis named `steps` with `run:` MUST fail closed!
  const matrixSequenceSpoof = buildMatrixYaml().replace(
    '    runs-on: ubuntu-latest',
    '    strategy:\n      matrix:\n        payload: ["${{ github.event.pull_request.title }}"]\n    runs-on: ubuntu-latest'
  );
  assert.equal(verifyEventTriggerMatrix(matrixSequenceSpoof).reason, 'UNTRUSTED_PR_TEXT_INTERPOLATION');

  const matrixStepsAxisRunSpoof = buildMatrixYaml().replace(
    '    runs-on: ubuntu-latest',
    '    strategy:\n      matrix:\n        steps:\n          - run: "${{ github.event.pull_request.title }}"\n    runs-on: ubuntu-latest'
  );
  assert.equal(verifyEventTriggerMatrix(matrixStepsAxisRunSpoof).reason, 'UNTRUSTED_PR_TEXT_INTERPOLATION');

  // Run interpolation, unpinned uses, credentials, untrusted PR checkout, permissions, merge ban, default-off, and concurrency
  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({
    stepRun: '          echo "${{ github.event.number }}"'
  })).reason, 'UNSAFE_RUN_INTERPOLATION');

  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({
    checkoutUses: 'actions/checkout@v4'
  })).reason, 'UNPINNED_ACTION_REFERENCE');

  const unpinnedJobUses = buildMatrixYaml({
    extraJobs: '  reusable:\n    needs: [evaluate]\n    uses: org/repo/.github/workflows/a.yml@main'
  });
  assert.equal(verifyEventTriggerMatrix(unpinnedJobUses).reason, 'UNPINNED_ACTION_REFERENCE');

  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({
    checkoutWith: '          persist-credentials: true'
  })).reason, 'CHECKOUT_CREDENTIALS_PERSISTED');

  for (const untrustedCheckout of [
    '          persist-credentials: false',
    '          persist-credentials: false\n          ref: ${{ github.event.pull_request.head.sha }}',
    '          persist-credentials: false\n          ref: ${{ env.PR_HEAD }}',
    '          persist-credentials: false\n          ref: ${{ steps.prep.outputs.sha }}',
    '          persist-credentials: false\n          ref: ${{ github.sha }}',
    '          persist-credentials: false\n          ref: ${{ always() }}',
    '          persist-credentials: false\n          ref: refs/pull/42/head',
    '          persist-credentials: false\n          ref: refs/remotes/pull/42/head',
    '          persist-credentials: false\n          repository: github/gh-aw\n          ref: main',
    '          persist-credentials: false\n          repository: attacker/fork\n          ref: refs/heads/main',
    '          persist-credentials: false\n          repository: 12345',
    '          persist-credentials: false\n          ref: 12345'
  ]) {
    assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({
      checkoutWith: untrustedCheckout
    })).reason, 'UNTRUSTED_PR_CHECKOUT');
  }
  // Omitted ref without pull_request_review still fails closed unless ALL active upstream needs enforce github.ref == 'refs/heads/<targetBranch>'!
  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({
    includeReview: false,
    checkoutWith: '          persist-credentials: false'
  })).reason, 'UNTRUSTED_PR_CHECKOUT');
  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({
    includeReview: false,
    evalIf: `\${{ vars.FACTORY_GHAW_ENABLED == 'true' && github.ref == 'refs/heads/main' && !endsWith(github.actor, '[bot]')${wrGuardClause} }}`,
    extraJobs: [
      '  noref_peer:',
      `    if: vars.FACTORY_GHAW_ENABLED == 'true'${wrGuardClause}`,
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: echo "peer"',
      '  mixed_needs_checkout:',
      '    needs: [evaluate, noref_peer]',
      '    runs-on: ubuntu-latest',
      '    steps:',
      `      - uses: actions/checkout@${checkoutSha}`,
      '        with:',
      '          persist-credentials: false'
    ].join('\n')
  }).replace(/  pull_request_target:\n    branches: \[main\]\n    types: \[[^\]]+\]\n/, ''), {allowPartialTriggers: true}).reason, 'UNTRUSTED_PR_CHECKOUT');
  // Case-folded checkout keys (Repository / Ref) and INPUT_* env overrides in verifyEventTriggerMatrix MUST fail closed!
  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({
    checkoutWith: '          persist-credentials: false\n          Repository: attacker/evil-fork\n          ref: refs/heads/main'
  })).reason, 'UNTRUSTED_PR_CHECKOUT');
  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml().replace(
    `      - uses: actions/checkout@${checkoutSha}\n`,
    `      - uses: actions/checkout@${checkoutSha}\n        env:\n          INPUT_REF: refs/pull/42/head\n`
  )).reason, 'UNTRUSTED_PR_CHECKOUT');
  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml().replace(
    `      - uses: actions/checkout@${checkoutSha}\n`,
    `      - uses: actions/checkout@${checkoutSha}\n        env:\n          GIT_CONFIG_COUNT: "1"\n`
  )).reason, 'UNTRUSTED_PR_CHECKOUT');
  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml().replace(
    `      - uses: actions/checkout@${checkoutSha}\n`,
    `      - uses: actions/checkout@${checkoutSha}\n        env: \${{ fromJSON('{"GIT_CONFIG_COUNT":"1"}') }}\n`
  )).reason, 'UNTRUSTED_PR_CHECKOUT');
  // Pinned github/gh-aw and allowlisted trustedControlPlaneShas checkouts pass; github.workflow_sha without protected provenance fails closed!
  const allowlistedMatrixSha = 'e'.repeat(40);
  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({
    checkoutWith: `          persist-credentials: false\n          repository: github/gh-aw\n          ref: ${PINNED_GHAW_RELEASE.commit}`
  })).valid, true);
  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({
    checkoutWith: `          persist-credentials: false\n          ref: ${allowlistedMatrixSha}`
  }), {trustedControlPlaneShas: [allowlistedMatrixSha]}).valid, true);
  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({
    checkoutWith: '          persist-credentials: false\n          ref: ${{ github.workflow_sha }}'
  })).reason, 'UNTRUSTED_PR_CHECKOUT');
  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({
    includeReview: false,
    checkoutWith: '          persist-credentials: false\n          ref: ${{ github.workflow_sha }}'
  })).reason, 'UNTRUSTED_PR_CHECKOUT');
  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({
    includeReview: false,
    evalIf: guardedMainEvalIf,
    checkoutWith: '          persist-credentials: false\n          ref: ${{ github.workflow_sha }}',
    stepRun: '          set -euo pipefail\n          test "$GITHUB_REF" = refs/heads/main\n          test "$GITHUB_REF_PROTECTED" = true\n          echo "ok"'
  })).valid, true);
  // Also accept checkout occurring AFTER an earlier fail-closed preamble step (when checkout preserves success() semantics)!
  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({
    includeReview: false,
    evalIf: guardedMainEvalIf,
    checkoutWith: '          persist-credentials: false\n          ref: ${{ github.workflow_sha }}'
  }).replace(
    `      - uses: actions/checkout@${checkoutSha}\n`,
    `      - name: Guard ref first\n        run: |\n          set -euo pipefail\n          test "$GITHUB_REF" = refs/heads/main\n          test "$GITHUB_REF_PROTECTED" = true\n      - uses: actions/checkout@${checkoutSha}\n        if: success()\n`
  )).valid, true);
  for (const bypassStepIf of ['always()', '${{ !success() }}', '${{ success() == false }}', '${{ success() || true }}']) {
    assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({
      includeReview: false,
      evalIf: guardedMainEvalIf,
      checkoutWith: '          persist-credentials: false\n          ref: ${{ github.workflow_sha }}'
    }).replace(
      `      - uses: actions/checkout@${checkoutSha}\n`,
      `      - name: Guard ref first\n        run: |\n          set -euo pipefail\n          test "$GITHUB_REF" = refs/heads/main\n          test "$GITHUB_REF_PROTECTED" = true\n      - uses: actions/checkout@${checkoutSha}\n        if: ${bypassStepIf}\n`
    )).reason, 'UNTRUSTED_PR_CHECKOUT');
  }
  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({
    includeReview: false,
    evalIf: guardedMainEvalIf,
    checkoutWith: '          persist-credentials: false\n          ref: ${{ github.workflow_sha }}',
    stepRun: '          set -euo pipefail\n          test "$GITHUB_REF" = refs/heads/main\n          test "$GITHUB_REF_PROTECTED" = true'
  }).replace(
    '          test "$GITHUB_REF_PROTECTED" = true\n',
    '          test "$GITHUB_REF_PROTECTED" = true\n      - name: Bypass failed preamble\n        if: always()\n        run: node tools/engineering-factory/run.mjs --inventory\n'
  )).reason, 'UNTRUSTED_PR_CHECKOUT');
  // Error-tolerant preamble (continue-on-error: true) OR repository code running BEFORE preamble MUST fail closed!
  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({
    includeReview: false,
    evalIf: guardedMainEvalIf,
    checkoutWith: '          persist-credentials: false\n          ref: ${{ github.workflow_sha }}',
    stepRun: '          set -euo pipefail\n          test "$GITHUB_REF" = refs/heads/main\n          test "$GITHUB_REF_PROTECTED" = true'
  }).replace('      - name: Metadata reconcile\n', '      - name: Metadata reconcile\n        continue-on-error: true\n')).reason, 'UNTRUSTED_PR_CHECKOUT');
  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({
    includeReview: false,
    evalIf: guardedMainEvalIf,
    checkoutWith: '          persist-credentials: false\n          ref: ${{ github.workflow_sha }}',
    stepRun: '          set -euo pipefail\n          test "$GITHUB_REF" = refs/heads/main\n          test "$GITHUB_REF_PROTECTED" = true'
  }).replace(
    '      - name: Metadata reconcile\n',
    '      - name: Run untrusted repo code before preamble\n        run: node tools/engineering-factory/run.mjs --inventory\n      - name: Metadata reconcile\n'
  )).reason, 'UNTRUSTED_PR_CHECKOUT');
  // Weakened || true preamble, mutated shadow-reconcile optin emitting unconditional enabled=true, or != 'skipped' provenance inheritance MUST fail closed!
  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({
    includeReview: false,
    evalIf: guardedMainEvalIf,
    checkoutWith: '          persist-credentials: false\n          ref: ${{ github.workflow_sha }}',
    stepRun: '          set -euo pipefail\n          test "$GITHUB_REF" = refs/heads/main || true\n          test "$GITHUB_REF_PROTECTED" = true'
  })).reason, 'UNTRUSTED_PR_CHECKOUT');
  assert.equal(verifyEventTriggerMatrix(
    shadowReconcileYaml.replace(
      '            echo "enabled=false" >> "$GITHUB_OUTPUT"\n          fi',
      '            echo "enabled=false" >> "$GITHUB_OUTPUT"\n          fi\n          echo "enabled=true" >> "$GITHUB_OUTPUT"'
    )
  ).reason, 'UNTRUSTED_PR_CHECKOUT');
  // Preceding run: step poisoning $GITHUB_ENV (e.g. BASH_ENV) before preamble or optin MUST fail closed!
  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({
    includeReview: false,
    evalIf: guardedMainEvalIf,
    checkoutWith: '          persist-credentials: false\n          ref: ${{ github.workflow_sha }}'
  }).replace(
    `      - uses: actions/checkout@${checkoutSha}\n`,
    `      - name: Poison GITHUB_ENV\n        run: |\n          echo 'test() { return 0; }' > /tmp/fake_test.sh\n          echo "BASH_ENV=/tmp/fake_test.sh" >> "$GITHUB_ENV"\n      - name: Guard ref after poisoned env\n        run: |\n          set -euo pipefail\n          test "$GITHUB_REF" = refs/heads/main\n          test "$GITHUB_REF_PROTECTED" = true\n      - uses: actions/checkout@${checkoutSha}\n`
  )).reason, 'UNTRUSTED_PR_CHECKOUT');
  assert.equal(verifyEventTriggerMatrix(
    shadowReconcileYaml.replace(
      '      - name: Check case-sensitive opt-in before checkout\n',
      '      - name: Poison GITHUB_ENV before optin\n        run: echo "GITHUB_REF=refs/heads/main" >> "$GITHUB_ENV"\n      - name: Check case-sensitive opt-in before checkout\n'
    )
  ).reason, 'UNTRUSTED_PR_CHECKOUT');
  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({
    includeReview: false,
    evalIf: guardedMainEvalIf,
    stepRun: '          set -euo pipefail\n          test "$GITHUB_REF" = refs/heads/main\n          test "$GITHUB_REF_PROTECTED" = true',
    extraJobs: [
      '  detection:',
      '    needs: [evaluate]',
      "    if: always() && needs.evaluate.result != 'skipped'",
      '    runs-on: ubuntu-latest',
      '    permissions:',
      '      contents: read',
      '    steps:',
      `      - uses: actions/checkout@${checkoutSha}`,
      '        with:',
      '          persist-credentials: false\n          ref: ${{ github.workflow_sha }}'
    ].join('\n')
  })).reason, 'UNTRUSTED_PR_CHECKOUT');

  // Linear-time O(N) guard against long .github identifier chains (no polynomial ReDoS)
  const redosStart = performance.now();
  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({
    stepEnv: `          SAFE_VAR: \${{ vars${'.github'.repeat(6000)} == 'x' }}`
  })).valid, true);
  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({
    stepEnv: `          UNTRUSTED_VAR: \${{ github${'.github'.repeat(6000)} == 'x' }}`
  })).reason, 'UNTRUSTED_PR_TEXT_INTERPOLATION');
  assert.ok(performance.now() - redosStart < 250);

  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({topPerms: '  contents: write'})).reason, 'TOP_LEVEL_WRITE_PERMISSION');
  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({topPerms: '  issues: read'})).reason, 'INVALID_TOP_LEVEL_PERMISSIONS');
  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({evalPerms: '      issues: write'})).reason, 'AGENT_JOB_WRITE_PERMISSION');
  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({
    extraJobs: '  activation:\n    needs: [evaluate]\n    runs-on: ubuntu-slim\n    permissions:\n      issues: write\n    steps:\n      - run: echo x'
  })).reason, 'AGENT_JOB_WRITE_PERMISSION');
  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({
    extraJobs: '  safe-outputs-bad:\n    needs: [evaluate]\n    if: ${{ false }}\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write\n    steps:\n      - run: echo x'
  })).reason, 'EXCESSIVE_SAFE_OUTPUT_PERMISSION');
  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({
    extraJobs: '  safe-outputs-missing-perms:\n    needs: [evaluate]\n    if: ${{ false }}\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo x'
  })).reason, 'EXCESSIVE_SAFE_OUTPUT_PERMISSION');

  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({
    stepRun: '          gh pr merge 1 --squash'
  })).reason, 'MAIN_MERGE_FORBIDDEN_IN_GHAW');
  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({
    extraJobs: '  merge-pull-request:\n    needs: [evaluate]\n    if: ${{ false }}\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo x'
  })).reason, 'MAIN_MERGE_FORBIDDEN_IN_GHAW');

  // Concurrency non-overlap enforcement (including downstream jobs and rejecting per-run identifiers in concurrency.group)
  for (const badTopConcurrency of [
    '',
    'concurrency:\n  group: g\n  cancel-in-progress: true',
    'concurrency:\n  group: "   "\n  cancel-in-progress: false',
    'concurrency:\n  group: reconcile-${{ github.run_id }}\n  cancel-in-progress: false',
    'concurrency:\n  group: reconcile-${{ github.run_number }}\n  cancel-in-progress: false',
    'concurrency:\n  group: reconcile-${{ github.run_attempt }}\n  cancel-in-progress: false',
    'concurrency:\n  group: reconcile-${{ github.sha }}\n  cancel-in-progress: false',
    'concurrency:\n  group: reconcile-${{ inputs.issue_number }}\n  cancel-in-progress: false',
    'concurrency:\n  group: reconcile-${{ 1 == 1 }}\n  cancel-in-progress: false'
  ]) {
    assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({topConcurrency: badTopConcurrency})).reason, 'MISSING_CONCURRENCY_GUARD');
  }
  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({
    topConcurrency: '',
    evalConcurrency: '    concurrency:\n      group: g\n      cancel-in-progress: false'
  })).reason, 'MISSING_CONCURRENCY_GUARD');
  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({
    evalConcurrency: '    concurrency:\n      group: g\n      cancel-in-progress: true'
  })).reason, 'MISSING_CONCURRENCY_GUARD');

  // Case-insensitive github.ref == 'refs/heads/main' ALONE does NOT make omitted checkout ref trusted (requires github.ref_protected + case-sensitive shell guard)
  const caseInsensitiveOnlyDispatch = buildMatrixYaml({
    includeReview: false,
    evalIf: `\${{ vars.FACTORY_GHAW_ENABLED == 'true' && github.ref == 'refs/heads/main' && !endsWith(github.actor, '[bot]')${wrGuardClause} }}`
  }).replace(/  pull_request_target:\n    branches: \[main\]\n    types: \[[^\]]+\]\n/, '');
  assert.equal(verifyEventTriggerMatrix(
    caseInsensitiveOnlyDispatch.replace('          ref: refs/heads/main', '').replace(/\n\n+/g, '\n'),
    {allowPartialTriggers: true}
  ).reason, 'UNTRUSTED_PR_CHECKOUT');

  // Default-off & case-sensitive protected-ref provenance downstream inheritance (including implicit needs success & reverse topological order)
  const implicitAndReverseDownstream = buildMatrixYaml({
    includeReview: false,
    evalIf: guardedMainEvalIf,
    stepRun: '          set -euo pipefail\n          test "$GITHUB_REF" = refs/heads/main\n          test "$GITHUB_REF_PROTECTED" = true\n          echo "eval"',
    extraJobs: [
      '  downstream_implicit:',
      '    needs: [mid_step]',
      '    runs-on: ubuntu-latest',
      '    steps:',
      `      - uses: actions/checkout@${checkoutSha}`,
      '        with:',
      '          persist-credentials: false',
      '  mid_step:',
      '    needs: [evaluate]',
      "    if: (!cancelled()) && needs.evaluate.result == 'success'",
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: echo "mid"'
    ].join('\n')
  }).replace(/  pull_request_target:\n    branches: \[main\]\n    types: \[[^\]]+\]\n/, '');
  assert.equal(verifyEventTriggerMatrix(implicitAndReverseDownstream, {allowPartialTriggers: true}).valid, true);

  for (const unguardedMatrix of [
    buildMatrixYaml({evalIf: null}),
    buildMatrixYaml({evalIf: '${{ false }}', extraJobs: ''}),
    buildMatrixYaml({
      extraJobs: '  unguarded_child:\n    needs: [evaluate]\n    if: always()\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo x'
    }),
    buildMatrixYaml({
      extraJobs: '  failure_child:\n    needs: [evaluate]\n    if: failure()\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo x'
    }),
    buildMatrixYaml({
      extraJobs: '  empty_needs_child:\n    needs: []\n    if: ${{ true }}\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo x'
    })
  ]) {
    assert.equal(verifyEventTriggerMatrix(unguardedMatrix).reason, 'MISSING_DEFAULT_OFF_GUARD');
  }

  // workflow_run (BOTH with branches: [main] and branchless) requires same-repository head_repository.id guard bound to trusted repo
  const stripWrBranch = yamlText => yamlText.replace('    types: [completed]\n    branches: [main]', '    types: [completed]');
  const unguardedEvalIf = "${{ vars.FACTORY_GHAW_ENABLED == 'true' && !endsWith(github.actor, '[bot]') }}";
  assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({evalIf: unguardedEvalIf})).reason, 'MISSING_WORKFLOW_RUN_REPO_GUARD');
  assert.equal(verifyEventTriggerMatrix(stripWrBranch(buildMatrixYaml({evalIf: unguardedEvalIf}))).reason, 'MISSING_WORKFLOW_RUN_REPO_GUARD');

  // Positive foreign repository IDs or mismatched repository/repository_id bindings MUST fail closed!
  for (const foreignWrEvalIf of [
    "${{ vars.FACTORY_GHAW_ENABLED == 'true' && !endsWith(github.actor, '[bot]') && (github.event_name != 'workflow_run' || github.event.workflow_run.head_repository.id == 999999) }}",
    "${{ vars.FACTORY_GHAW_ENABLED == 'true' && github.repository_id == '1471342715' && !endsWith(github.actor, '[bot]') && (github.event_name != 'workflow_run' || github.event.workflow_run.head_repository.id == 999999) }}",
    "${{ vars.FACTORY_GHAW_ENABLED == 'true' && github.repository == 'Jamula/SoftwareFactory' && github.repository_id == '999999' && !endsWith(github.actor, '[bot]') && (github.event_name != 'workflow_run' || github.event.workflow_run.head_repository.id == 999999) }}",
    "${{ vars.FACTORY_GHAW_ENABLED == 'true' && github.repository == 'jamula/softwarefactory' && github.repository_id == '1471342715' && !endsWith(github.actor, '[bot]') && (github.event_name != 'workflow_run' || github.event.workflow_run.head_repository.id == 1471342715) }}",
    "${{ vars.FACTORY_GHAW_ENABLED == 'true' && github.repository == 'Synthetic/Consumer' && !endsWith(github.actor, '[bot]') && (github.event_name != 'workflow_run' || github.event.workflow_run.head_repository.id == 1471342715) }}",
    "${{ vars.FACTORY_GHAW_ENABLED == 'true' && github.repository == 'Synthetic/Consumer' && github.repository_id == '1471342715' && !endsWith(github.actor, '[bot]') && (github.event_name != 'workflow_run' || github.event.workflow_run.head_repository.id == 1471342715) }}",
    "${{ vars.FACTORY_GHAW_ENABLED == 'true' && github.repository == '' && !endsWith(github.actor, '[bot]') && (github.event_name != 'workflow_run' || github.event.workflow_run.head_repository.id == 1471342715) }}",
    "${{ vars.FACTORY_GHAW_ENABLED == 'true' && github.repository_id == 0 && !endsWith(github.actor, '[bot]') && (github.event_name != 'workflow_run' || github.event.workflow_run.head_repository.id == 1471342715) }}",
    "${{ vars.FACTORY_GHAW_ENABLED == 'true' && github.repository_id == '9999999999999999' && !endsWith(github.actor, '[bot]') && (github.event_name != 'workflow_run' || github.event.workflow_run.head_repository.id == '9999999999999999') }}",
    "${{ vars.FACTORY_GHAW_ENABLED == 'true' && github.repository_id == '1471342715' && github.repository_id == '200036' && !endsWith(github.actor, '[bot]') && (github.event_name != 'workflow_run' || github.event.workflow_run.head_repository.id == 1471342715) }}"
  ]) {
    assert.equal(verifyEventTriggerMatrix(buildMatrixYaml({evalIf: foreignWrEvalIf})).reason, 'MISSING_WORKFLOW_RUN_REPO_GUARD');
  }

  for (const validWrEvalIf of [
    "${{ vars.FACTORY_GHAW_ENABLED == 'true' && !endsWith(github.actor, '[bot]') && (github.event_name != 'workflow_run' || github.event.workflow_run.head_repository.id == 1471342715) }}",
    "${{ vars.FACTORY_GHAW_ENABLED == 'true' && !endsWith(github.actor, '[bot]') && ('1471342715' == github.event.workflow_run.head_repository.id || github.event_name != 'workflow_run') }}",
    "${{ vars.FACTORY_GHAW_ENABLED == 'true' && github.repository == 'Synthetic/Consumer' && '200036' == github.repository_id && !endsWith(github.actor, '[bot]') && (github.event_name != 'workflow_run' || github.event.workflow_run.head_repository.id == 200036) }}",
    "${{ vars.FACTORY_GHAW_ENABLED == 'true' && !endsWith(github.actor, '[bot]') && (github.event_name != 'workflow_run' || github.event.workflow_run.head_repository.id == github.repository_id) }}",
    "${{ vars.FACTORY_GHAW_ENABLED == 'true' && !endsWith(github.actor, '[bot]') && (github.event_name != 'workflow_run' || github.event.workflow_run.repository.id == github.event.workflow_run.head_repository.id) }}",
    "${{ vars.FACTORY_GHAW_ENABLED == 'true' && !endsWith(github.actor, '[bot]') && github.event_name != 'workflow_run' }}",
    "${{ vars.FACTORY_GHAW_ENABLED == 'true' && !endsWith(github.actor, '[bot]') && github.event.workflow_run.head_repository.id == 1471342715 }}"
  ]) {
    const guardedWrYaml = stripWrBranch(buildMatrixYaml({
      evalIf: validWrEvalIf,
      extraJobs: [
        '  implicit_child:',
        '    needs: [evaluate]',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: echo "implicit"',
        '  explicit_child:',
        '    needs: [implicit_child]',
        "    if: needs.implicit_child.result == 'success'",
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: echo "explicit"'
      ].join('\n')
    }));
    assert.equal(verifyEventTriggerMatrix(guardedWrYaml).valid, true);
  }

  // Downstream job depending ONLY on an unguarded/unknown job when branchless workflow_run is active fails closed
  const mixedWrPeerYaml = stripWrBranch(buildMatrixYaml({
    evalIf: "${{ vars.FACTORY_GHAW_ENABLED == 'true' && !endsWith(github.actor, '[bot]') && (github.event_name != 'workflow_run' || github.event.workflow_run.head_repository.id == 1471342715) }}",
    extraJobs: [
      '  dangling_wr_child:',
      '    needs: [missing_upstream]',
      "    if: vars.FACTORY_GHAW_ENABLED == 'true'",
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: echo "dangling"'
    ].join('\n')
  }));
  assert.equal(verifyEventTriggerMatrix(mixedWrPeerYaml).reason, 'MISSING_WORKFLOW_RUN_REPO_GUARD');

  const partialWrChildYaml = stripWrBranch(buildMatrixYaml({
    evalIf: "${{ vars.FACTORY_GHAW_ENABLED == 'true' && !endsWith(github.actor, '[bot]') && (github.event_name != 'workflow_run' || github.event.workflow_run.head_repository.id == 1471342715) }}",
    extraJobs: [
      '  unguarded_wr_child:',
      '    needs: [evaluate]',
      "    if: vars.FACTORY_GHAW_ENABLED == 'true'",
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: echo "missing needs.evaluate.result == success"'
    ].join('\n')
  }));
  assert.equal(verifyEventTriggerMatrix(partialWrChildYaml).reason, 'MISSING_WORKFLOW_RUN_REPO_GUARD');
});

test('enforces verifyGhAwWorkflowLock trigger parity, workflow_run repo guard, evaluate PR-checkout protection, and runtime shell behavior', () => {
  const mdPath = resolve(repoRoot, '.github/workflows/factory-orchestrator.md');
  const lockPath = resolve(repoRoot, '.github/workflows/factory-orchestrator.lock.yml');
  const trackedMd = readFileSync(mdPath, 'utf8');
  const trackedLock = readFileSync(lockPath, 'utf8');

  const rehashPair = (nextMd, nextLock) => {
    const fmHash = computeFrontmatterSha256(nextMd);
    const bHash = computeBodySha256(nextMd);
    const updatedLock = nextLock
      .replace(/"frontmatter_hash":"[a-f0-9]{64}"/, `"frontmatter_hash":"${fmHash}"`)
      .replace(/"body_hash":"[a-f0-9]{64}"/, `"body_hash":"${bHash}"`);
    return verifyGhAwWorkflowLock({markdownSource: nextMd, lockYamlSource: updatedLock});
  };

  // Malformed or empty frontmatter.on fails closed
  for (const badFmOn of ['on: workflow_dispatch', 'on: {}']) {
    const mutatedMd = trackedMd.replace(/on:\n[\s\S]*?\npermissions:/, `${badFmOn}\npermissions:`);
    assert.equal(rehashPair(mutatedMd, trackedLock).reason, 'INVALID_FRONTMATTER');
  }

  // Unsupported trigger (including PR-controlled pull_request_review) in frontmatter or lock fails closed
  for (const unsupportedOrchestratorTrigger of [
    '  pull_request:\n    branches: [main]',
    '  pull_request_review:\n    types: [submitted, edited, dismissed]',
    '  issue_comment:\n    types: [created]'
  ]) {
    assert.equal(
      rehashPair(trackedMd.replace('  push:\n    branches: [main]', unsupportedOrchestratorTrigger), trackedLock).reason,
      'UNSUPPORTED_EVENT_TRIGGER'
    );
    assert.equal(
      rehashPair(trackedMd, trackedLock.replace('  push:\n    branches: [main]', unsupportedOrchestratorTrigger)).reason,
      'UNSUPPORTED_EVENT_TRIGGER'
    );
  }

  // Invalid schedule or event trigger config in frontmatter or lock fails closed
  assert.equal(
    rehashPair(trackedMd.replace("cron: '3,13,23,33,43,53 * * * *'", "cron: '*/5 * * * *'"), trackedLock).reason,
    'INVALID_RECOVERY_SCHEDULE'
  );
  assert.equal(
    rehashPair(trackedMd, trackedLock.replace("cron: '3,13,23,33,43,53 * * * *'", "cron: '*/5 * * * *'")).reason,
    'INVALID_RECOVERY_SCHEDULE'
  );
  assert.equal(
    rehashPair(trackedMd.replace('  pull_request_target:\n    branches: [main]\n    types: [opened, reopened, synchronize, ready_for_review, closed]', '  pull_request_target: {}'), trackedLock).reason,
    'INVALID_EVENT_TRIGGER_CONFIG'
  );
  assert.equal(
    rehashPair(trackedMd, trackedLock.replace('  push:\n    branches: [main]', '  push:\n    branches: [develop]')).reason,
    'INVALID_EVENT_TRIGGER_CONFIG'
  );

  // Trigger parity mismatch between .md and .lock.yml fails closed (both missing keys AND same-key config drift!)
  assert.equal(
    rehashPair(trackedMd.replace('  push:\n    branches: [main]\n', ''), trackedLock).reason,
    'TRIGGER_PARITY_MISMATCH'
  );
  for (const mutatedLockConfig of [
    trackedLock.replace('types: [opened, edited, labeled, unlabeled, closed, reopened]', 'types: [closed]'),
    trackedLock.replace('types: [opened, reopened, synchronize, ready_for_review, closed]', 'types: [opened]'),
    trackedLock.replace('workflows: ["Factory validation", "Windows Aspire runtime", ".NET MAF specialist agents"]', 'workflows: ["Factory validation"]'),
    trackedLock.replace("cron: '3,13,23,33,43,53 * * * *'", "cron: '7,17,27,37,47,57 * * * *'")
  ]) {
    assert.equal(rehashPair(trackedMd, mutatedLockConfig).reason, 'TRIGGER_PARITY_MISMATCH');
  }

  // Missing or foreign workflow_run head_repository.id guard in frontmatter.if or evaluate.if fails closed
  const stripWrGuard = text => text.replace(
    " && (github.event_name != 'workflow_run' || github.event.workflow_run.head_repository.id == 1471342715)",
    ''
  );
  assert.equal(rehashPair(stripWrGuard(trackedMd), trackedLock).reason, 'MISSING_WORKFLOW_RUN_REPO_GUARD');
  assert.equal(rehashPair(trackedMd, stripWrGuard(trackedLock)).reason, 'MISSING_WORKFLOW_RUN_REPO_GUARD');
  for (const badHeadRepoId of ['0', '999999']) {
    assert.equal(
      rehashPair(
        trackedMd,
        trackedLock.replace(
          'github.event.workflow_run.head_repository.id == 1471342715',
          `github.event.workflow_run.head_repository.id == ${badHeadRepoId}`
        )
      ).reason,
      'MISSING_WORKFLOW_RUN_REPO_GUARD'
    );
  }

  // Compiler-shaped activation -> agent helper inheritance for workflow_run repo guard
  const helperWrMd = [
    '---',
    'name: Compiler Workflow Run',
    'engine: copilot',
    "if: \"vars.FACTORY_GHAW_ENABLED == 'true' && !endsWith(github.actor, '[bot]') && (github.event_name != 'workflow_run' || github.event.workflow_run.head_repository.id == 1471342715)\"",
    'on:',
    '  workflow_run:',
    '    workflows: ["Factory validation"]',
    '    types: [completed]',
    'permissions: {}',
    '---',
    '# Body'
  ].join('\n');
  const buildHelperWrLock = ({
    activationWrGuard = " && (github.event_name != 'workflow_run' || github.event.workflow_run.head_repository.id == 1471342715)",
    agentExtraIf = ''
  } = {}) => [
    makeMetadataLine({
      frontmatterHash: computeFrontmatterSha256(helperWrMd),
      bodyHash: computeBodySha256(helperWrMd)
    }),
    `# gh-aw-commit: ${PINNED_GHAW_RELEASE.commit}`,
    'name: Compiler Workflow Run',
    'on:',
    '  workflow_run:',
    '    workflows: ["Factory validation"]',
    '    types: [completed]',
    'permissions: {}',
    'jobs:',
    '  activation:',
    `    if: vars.FACTORY_GHAW_ENABLED == 'true' && !endsWith(github.actor, '[bot]')${activationWrGuard}`,
    '    runs-on: ubuntu-slim',
    '    permissions:',
    '      contents: read',
    '    steps:',
    '      - run: echo "activate"',
    '  agent:',
    '    needs: [activation]',
    agentExtraIf ? `    if: ${agentExtraIf}` : "    if: needs.activation.result == 'success'",
    '    runs-on: ubuntu-latest',
    '    permissions:',
    '      contents: read',
    '    steps:',
    '      - run: echo "agent"',
    '  threat-scan:',
    '    needs: [agent]',
    "    if: needs.agent.result == 'success'",
    '    runs-on: ubuntu-latest',
    '    permissions:',
    '      contents: read',
    '    steps:',
    '      - run: echo "scan"'
  ].join('\n');
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: helperWrMd,
    lockYamlSource: buildHelperWrLock()
  }).valid, true);
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: helperWrMd,
    lockYamlSource: buildHelperWrLock({activationWrGuard: ''})
  }).reason, 'MISSING_WORKFLOW_RUN_REPO_GUARD');

  // Evaluate job checkout omitting ref/repository, unallowlisted repo, or github.workflow_sha without protected ref provenance fails closed
  for (const untrustedEvalCheckout of [
    '      - name: Checkout immutable protected-branch workflow revision\n        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false',
    '      - name: Checkout immutable protected-branch workflow revision\n        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          repository: attacker/evil-fork\n          ref: ${{ github.workflow_sha }}\n          persist-credentials: false',
    '      - name: Checkout immutable protected-branch workflow revision\n        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          repository: 12345\n          ref: ${{ github.workflow_sha }}\n          persist-credentials: false'
  ]) {
    assert.equal(
      rehashPair(
        trackedMd,
        trackedLock.replace(
          '      - name: Checkout immutable protected-branch workflow revision\n        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          repository: Jamula/SoftwareFactory\n          ref: ${{ github.workflow_sha }}\n          persist-credentials: false',
          untrustedEvalCheckout
        )
      ).reason,
      'UNTRUSTED_PR_CHECKOUT'
    );
  }
  assert.equal(
    rehashPair(
      trackedMd,
      trackedLock.replace('          test "$GITHUB_REF_PROTECTED" = true\n', '')
    ).reason,
    'UNTRUSTED_PR_CHECKOUT'
  );

  // Untrusted PR text interpolation in verifyGhAwWorkflowLock fails closed
  assert.equal(
    rehashPair(
      trackedMd,
      trackedLock.replace(
        '          FACTORY_MAIN_HEAD: ${{ github.sha }}',
        '          FACTORY_MAIN_HEAD: ${{ github.sha }}\n          FACTORY_PR_TITLE: ${{ github.event.pull_request.title }}'
      )
    ).reason,
    'UNTRUSTED_PR_TEXT_INTERPOLATION'
  );

  // Execute the tracked evaluate & policy_scan shell scripts offline across all modes & triggers
  const evalScriptMatch = /name: Verify gh-aw workflow lock and execute shadow evaluation[\s\S]*?run: \|\n((?: {10}.*\n)+)/.exec(trackedLock);
  const scanScriptMatch = /id: policy_scan\n {8}run: \|\n((?: {10}.*\n)+)/.exec(trackedLock);
  assert.ok(evalScriptMatch !== null);
  assert.ok(scanScriptMatch !== null);
  const evalScript = evalScriptMatch[1].split('\n').map(line => line.slice(10)).join('\n');
  const scanScript = scanScriptMatch[1].split('\n').map(line => line.slice(10)).join('\n');
  assert.equal(computeNormalizedScriptSha256(scanScript), PINNED_FACTORY_POLICY_SCAN_RUN_SHA256);

  const validSha = 'a'.repeat(40);
  const prHeadSha = 'b'.repeat(40);
  const tmpDir = mkdtempSync(join(tmpdir(), 'sf-policy-scan-'));
  try {
    const binDir = join(tmpDir, 'bin');
    const runnerTempA = join(tmpDir, 'runner-a');
    const runnerTempB = join(tmpDir, 'runner-b');
    mkdirSync(binDir);
    mkdirSync(runnerTempA);
    mkdirSync(runnerTempB);
    const remoteWorkQueueSnap = join(tmpDir, 'remote-work-queue-snapshot.json');
    const fakeGitPath = join(binDir, 'git');
    writeFileSync(fakeGitPath, [
      '#!/usr/bin/env bash',
      'if [ "$1" = rev-parse ]; then',
      '  echo "${MOCK_GIT_HEAD}"',
      '  exit 0',
      'fi',
      'if [ "$1" = fetch ]; then',
      '  test -s "${MOCK_REMOTE_WQ_SNAP:-}"',
      '  exit $?',
      'fi',
      'if [ "$1" = show ]; then',
      '  cat "${MOCK_REMOTE_WQ_SNAP}"',
      '  exit $?',
      'fi',
      'exit 1'
    ].join('\n') + '\n', 'utf8');
    chmodSync(fakeGitPath, 0o755);

    const mockFetchFile = join(tmpDir, 'mock-fetch.mjs');
    writeFileSync(mockFetchFile, [
      `const mainSha = ${JSON.stringify(validSha)};`,
      `const prSha = ${JSON.stringify(prHeadSha)};`,
      'const apiBase = "https://api.github.com/repos/Jamula/SoftwareFactory";',
      'const json = body => new Response(JSON.stringify(body), {status: 200, headers: {"content-type": "application/json"}});',
      'globalThis.fetch = async rawUrl => {',
      '  const url = String(rawUrl);',
      '  if (url === apiBase) return json({id: 1471342715, full_name: "Jamula/SoftwareFactory", fork: false});',
      '  if (url === apiBase + "/branches/main") return json({name: "main", protected: true, commit: {sha: mainSha}});',
      '  if (url.startsWith(apiBase + "/issues?")) return json([{number: 5, repository_url: apiBase}]);',
      '  if (url.startsWith(apiBase + "/pulls?")) return json([{number: 42, base: {repo: {id: 1471342715, full_name: "Jamula/SoftwareFactory"}}}]);',
      '  if (url === apiBase + "/issues/5") return json({number: 5, state: "open", repository_url: apiBase});',
      '  if (url === apiBase + "/pulls/42") {',
      '    return json({',
      '      number: 42, state: "open", draft: false,',
      '      head: {sha: prSha, repo: {id: 1471342715, full_name: "Jamula/SoftwareFactory"}},',
      '      base: {ref: "main", sha: mainSha, repo: {id: 1471342715, full_name: "Jamula/SoftwareFactory"}}',
      '    });',
      '  }',
      '  if (url === apiBase + "/actions/runs/998877") {',
      '    return json({',
      '      id: 998877, status: "completed", conclusion: "success", event: "pull_request", head_sha: prSha,',
      '      repository: {id: 1471342715, full_name: "Jamula/SoftwareFactory"},',
      '      head_repository: {id: 1471342715, full_name: "Jamula/SoftwareFactory"}',
      '    });',
      '  }',
      '  return new Response("unexpected url: " + url, {status: 404});',
      '};'
    ].join('\n'), 'utf8');

    const baseEvalEnv = {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      NODE_OPTIONS: `--import=${pathToFileURL(mockFetchFile).href}`,
      RUNNER_TEMP: runnerTempA,
      MOCK_GIT_HEAD: validSha,
      MOCK_REMOTE_WQ_SNAP: remoteWorkQueueSnap,
      FACTORY_GHAW_ENABLED: 'true',
      FACTORY_EXPECTED_WORKFLOW_PATH: '.github/workflows/factory-orchestrator.lock.yml',
      GITHUB_REPOSITORY: 'Jamula/SoftwareFactory',
      GITHUB_REPOSITORY_ID: '1471342715',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REF_PROTECTED: 'true',
      GITHUB_WORKFLOW_REF: 'Jamula/SoftwareFactory/.github/workflows/factory-orchestrator.lock.yml@refs/heads/main',
      GITHUB_WORKFLOW_SHA: validSha,
      GITHUB_SHA: validSha,
      GITHUB_RUN_ID: '46100001',
      GITHUB_EVENT_NAME: 'schedule',
      FACTORY_GHAW_MODE: '',
      FACTORY_ISSUE_NUMBER: '',
      FACTORY_PULL_NUMBER: '',
      FACTORY_PULL_HEAD: '',
      FACTORY_WORKFLOW_RUN_ID: '',
      FACTORY_CHECK_HEAD: '',
      FACTORY_WORKFLOW_HEAD_REPO_ID: '',
      FACTORY_MAIN_HEAD: validSha
    };

    // Missed-event -> scheduled wake replay: first schedule wake discovers & reconciles open issue #5 + PR #42 and persists snapshot
    const scheduleRun = spawnSync('bash', ['-c', evalScript], {cwd: repoRoot, env: baseEvalEnv, encoding: 'utf8'});
    assert.equal(scheduleRun.status, 0, scheduleRun.stderr);
    assert.match(scheduleRun.stdout, /"SHADOW_PLAN"/);
    assert.match(scheduleRun.stdout, /"recoveredCount":2/);
    assert.match(scheduleRun.stdout, /"reason":"SHADOW_RECONCILED"/);

    // Promote persisted snapshot to simulated refs/heads/work-queue and verify fresh runner restores & deduplicates!
    const snapAPath = join(runnerTempA, 'factory-event-journal-snapshot.json');
    writeFileSync(remoteWorkQueueSnap, readFileSync(snapAPath, 'utf8'), 'utf8');
    const secondScheduleOnFreshRunner = spawnSync('bash', ['-c', evalScript], {
      cwd: repoRoot,
      env: {...baseEvalEnv, RUNNER_TEMP: runnerTempB, GITHUB_EVENT_NAME: 'workflow_dispatch', FACTORY_GHAW_MODE: 'shadow'},
      encoding: 'utf8'
    });
    assert.equal(secondScheduleOnFreshRunner.status, 0, secondScheduleOnFreshRunner.stderr);
    assert.match(secondScheduleOnFreshRunner.stdout, /"recoveredCount":0/);
    assert.match(secondScheduleOnFreshRunner.stdout, /"reason":"NO_CLAIM"/);

    // smoke mode runs only the synthetic smoke check without live GitHub reads
    const smokeOnlyRun = spawnSync('bash', ['-c', evalScript], {
      cwd: repoRoot,
      env: {...baseEvalEnv, GITHUB_EVENT_NAME: 'workflow_dispatch', FACTORY_GHAW_MODE: 'smoke'},
      encoding: 'utf8'
    });
    assert.equal(smokeOnlyRun.status, 0, smokeOnlyRun.stderr);
    assert.match(smokeOnlyRun.stdout, /"SHADOW_PLAN"/);
    assert.doesNotMatch(smokeOnlyRun.stdout, /"recoveredCount"/);

    // verify-lock mode skips both smoke and live GitHub reads
    const verifyOnlyRun = spawnSync('bash', ['-c', evalScript], {
      cwd: repoRoot,
      env: {...baseEvalEnv, GITHUB_EVENT_NAME: 'workflow_dispatch', FACTORY_GHAW_MODE: 'verify-lock', FACTORY_ISSUE_NUMBER: '5'},
      encoding: 'utf8'
    });
    assert.equal(verifyOnlyRun.status, 0, verifyOnlyRun.stderr);
    assert.doesNotMatch(verifyOnlyRun.stdout, /"SHADOW_PLAN"/);

    // Scoped journal reconciliation runs across workflow_dispatch(issue), issues, pull_request_target, workflow_run, and push
    let runCounter = 100;
    for (const [eventEnv, expectedKind] of [
      [{...baseEvalEnv, GITHUB_EVENT_NAME: 'workflow_dispatch', FACTORY_GHAW_MODE: 'shadow', FACTORY_ISSUE_NUMBER: '5'}, 'manual'],
      [{...baseEvalEnv, GITHUB_EVENT_NAME: 'issues', FACTORY_ISSUE_NUMBER: '5'}, 'issue'],
      [{...baseEvalEnv, GITHUB_EVENT_NAME: 'pull_request_target', FACTORY_PULL_NUMBER: '42', FACTORY_PULL_HEAD: prHeadSha}, 'pull'],
      [
        {
          ...baseEvalEnv,
          GITHUB_EVENT_NAME: 'workflow_run',
          FACTORY_WORKFLOW_RUN_ID: '998877',
          FACTORY_CHECK_HEAD: prHeadSha,
          FACTORY_WORKFLOW_HEAD_REPO_ID: '1471342715'
        },
        'check'
      ],
      [{...baseEvalEnv, GITHUB_EVENT_NAME: 'push'}, 'main']
    ]) {
      const freshRunnerDir = join(tmpDir, `runner-ev-${++runCounter}`);
      mkdirSync(freshRunnerDir);
      const runEnv = {...eventEnv, RUNNER_TEMP: freshRunnerDir, GITHUB_RUN_ID: `4610${runCounter}`};
      const reconciledRun = spawnSync('bash', ['-c', evalScript], {cwd: repoRoot, env: runEnv, encoding: 'utf8'});
      assert.equal(reconciledRun.status, 0, reconciledRun.stderr);
      assert.match(reconciledRun.stdout, /"reconciled":true/);
      assert.match(reconciledRun.stdout, /"reason":"SHADOW_RECONCILED"/);
      assert.match(reconciledRun.stdout, new RegExp(`"kind":"${expectedKind}"`));

      // Replaying the exact same deliveryId against persisted snapshot deduplicates across runs!
      const replayRun = spawnSync('bash', ['-c', evalScript], {cwd: repoRoot, env: runEnv, encoding: 'utf8'});
      assert.equal(replayRun.status, 0, replayRun.stderr);
      assert.match(replayRun.stdout, /"reconciled":false/);
      assert.match(replayRun.stdout, /"reason":"DUPLICATE_DELIVERY"/);
    }

    // Fork workflow_run, checkout SHA mismatch, PR merge-ref revisions, unknown events, and malformed inputs fail closed
    for (const rejectedEnv of [
      {...baseEvalEnv, GITHUB_EVENT_NAME: 'workflow_run', FACTORY_WORKFLOW_HEAD_REPO_ID: '999999'},
      {...baseEvalEnv, MOCK_GIT_HEAD: prHeadSha},
      {...baseEvalEnv, GITHUB_WORKFLOW_SHA: ''},
      {...baseEvalEnv, GITHUB_EVENT_NAME: 'repository_dispatch'},
      {
        ...baseEvalEnv,
        GITHUB_EVENT_NAME: 'pull_request_review',
        GITHUB_REF: 'refs/pull/42/merge',
        GITHUB_REF_PROTECTED: 'false',
        GITHUB_WORKFLOW_REF: 'Jamula/SoftwareFactory/.github/workflows/factory-orchestrator.lock.yml@refs/pull/42/merge',
        FACTORY_PULL_NUMBER: '42',
        FACTORY_PULL_HEAD: prHeadSha
      },
      {
        ...baseEvalEnv,
        GITHUB_WORKFLOW_REF: 'Jamula/SoftwareFactory/.github/workflows/factory-orchestrator.lock.yml@refs/pull/42/merge'
      },
      {...baseEvalEnv, GITHUB_REF: 'refs/heads/feature'},
      {...baseEvalEnv, GITHUB_REF_PROTECTED: 'false'},
      {...baseEvalEnv, FACTORY_GHAW_MODE: 'live-dispatch'},
      {...baseEvalEnv, FACTORY_ISSUE_NUMBER: '0'},
      {...baseEvalEnv, FACTORY_PULL_NUMBER: 'abc'},
      {...baseEvalEnv, FACTORY_PULL_HEAD: 'not-a-sha'}
    ]) {
      const failedRun = spawnSync('bash', ['-c', evalScript], {cwd: repoRoot, env: rejectedEnv, encoding: 'utf8'});
      assert.notEqual(failedRun.status, 0);
    }

    // Execute policy_scan script and verify scan_verified=true output
    const ghOutFile = join(tmpDir, 'github_output.txt');
    writeFileSync(ghOutFile, '', 'utf8');
    const scanRun = spawnSync('bash', ['-c', scanScript], {
      cwd: repoRoot,
      env: {...process.env, GITHUB_OUTPUT: ghOutFile},
      encoding: 'utf8'
    });
    assert.equal(scanRun.status, 0, scanRun.stderr);
    assert.equal(readFileSync(ghOutFile, 'utf8').trim(), 'scan_verified=true');
  } finally {
    rmSync(tmpDir, {recursive: true, force: true});
  }
});
