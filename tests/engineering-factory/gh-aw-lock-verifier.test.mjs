import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {
  PINNED_GHAW_RELEASE,
  computeBodySha256,
  computeFrontmatterSha256,
  verifyGhAwWorkflowLock
} from '../../tools/engineering-factory/gh-aw-lock-verifier.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const checkoutSha = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const setupNodeSha = '949feb2413d6458794dcd2491c4babbbce0c15c1';

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
    '      - name: Scan',
    '        id: policy_scan',
    '        run: echo "scan_verified=true" >> "$GITHUB_OUTPUT"',
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
  const noRunStepScan = buildFixture();
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: noRunStepScan.markdownSource,
    lockYamlSource: noRunStepScan.lockYamlSource.replace(
      '      - name: Scan\n        id: policy_scan\n        run: echo "scan_verified=true" >> "$GITHUB_OUTPUT"',
      `      - uses: actions/setup-node@${setupNodeSha}`
    )
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
    "              const { setupGlobals } = require('/tmp/gh-aw/actions/setup_globals.cjs');",
    '              setupGlobals(core, github, context, exec, io, getOctokit);',
    "              const { main } = require('/tmp/gh-aw/actions/parse_threat_detection_results.cjs');",
    '              await main();',
    '            } catch (loadErr) {',
    "              core.setOutput('conclusion', 'failure');",
    "              core.setOutput('success', 'false');",
    '              core.setFailed(String(loadErr));',
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
    defaultDetectionSteps.replace("core.setOutput('success', 'false');", "core.setOutput('success', 'true');"),
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
  }
});
