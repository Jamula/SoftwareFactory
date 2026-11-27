import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {
  PINNED_GHAW_RELEASE,
  computeFrontmatterSha256,
  verifyGhAwWorkflowLock
} from '../../tools/engineering-factory/gh-aw-lock-verifier.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const checkoutSha = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const setupNodeSha = '949feb2413d6458794dcd2491c4babbbce0c15c1';

function buildFixture({
  frontmatterExtra = '',
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
  safeNeeds = '[evaluate, threat-and-policy-scan]',
  safePerms = '      issues: write',
  extraHeader = ''
} = {}) {
  const markdownSource = [
    '---',
    'name: Synthetic orchestrator',
    'engine: copilot',
    'on:',
    '  workflow_dispatch:',
    'permissions:',
    '  contents: read',
    'tools:',
    '  work-queue:',
    `    protocol: ${protocol}`,
    '    branch: work-queue',
    frontmatterExtra,
    '---',
    '',
    '# Synthetic orchestrator body'
  ].filter(Boolean).join('\n');

  const sha = computeFrontmatterSha256(markdownSource);
  const lockYamlSource = [
    `# gh-aw-version: ${version}`,
    `# gh-aw-commit: ${commit}`,
    `# gh-aw-frontmatter-sha256: ${sha}`,
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
    "    if: ${{ vars.FACTORY_GHAW_ENABLED == 'true' && !endsWith(github.actor, '[bot]') }}",
    '    runs-on: ubuntu-latest',
    '    permissions:',
    '      contents: read',
    '    steps:',
    '      - name: Scan',
    '        run: echo "scan"',
    '  safe-outputs-comment:',
    `    needs: ${safeNeeds}`,
    '    if: ${{ false }}',
    '    runs-on: ubuntu-latest',
    '    permissions:',
    safePerms,
    '    steps:',
    '      - name: Dry-run output',
    '        run: echo "noop"'
  ].filter(line => line !== null).join('\n');

  return {markdownSource, lockYamlSource, sha};
}

test('verifies tracked .github/workflows/factory-orchestrator.md and .lock.yml pair', () => {
  const mdPath = resolve(repoRoot, '.github/workflows/factory-orchestrator.md');
  const lockPath = resolve(repoRoot, '.github/workflows/factory-orchestrator.lock.yml');
  const markdownSource = readFileSync(mdPath, 'utf8');
  const lockYamlSource = readFileSync(lockPath, 'utf8');

  const expectedHash = computeFrontmatterSha256(markdownSource);
  assert.match(expectedHash, /^[a-f0-9]{64}$/);
  assert.ok(lockYamlSource.includes(`# gh-aw-frontmatter-sha256: ${expectedHash}`));

  const verdict = verifyGhAwWorkflowLock({markdownSource, lockYamlSource});
  assert.equal(verdict.valid, true);
  assert.equal(verdict.shadow, true);
  assert.equal(verdict.liveDispatch, false);
  assert.equal(verdict.liveMerge, false);
  assert.equal(verdict.reason, 'GHAW_LOCK_VERIFIED');
  assert.equal(verdict.frontmatterSha256, expectedHash);
  assert.equal(verdict.workQueueProtocol, 'v3');
  assert.deepEqual(verdict.pinnedRelease, PINNED_GHAW_RELEASE);
  assert.equal(Object.isFrozen(verdict), true);
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
    '---\nname: unclosed'
  ]) {
    assert.equal(computeFrontmatterSha256(invalid), null);
  }

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

  for (const badPin of [
    null,
    [],
    {version: '1.2.2', commit: PINNED_GHAW_RELEASE.commit},
    {repository: 'other/gh-aw', version: 'v1.2.2', commit: PINNED_GHAW_RELEASE.commit},
    {version: 'v1.2.1', commit: newerCommit, verified: true},
    {version: 'v0.9.0', commit: newerCommit, verified: true},
    {version: 'v1.1.9', commit: newerCommit, verified: true},
    {version: 'v1.2.2', commit: 'not-a-sha'},
    {version: 'v1.2.2', commit: PINNED_GHAW_RELEASE.commit, verified: false}
  ]) {
    assert.equal(verifyGhAwWorkflowLock({
      markdownSource: v3.markdownSource,
      lockYamlSource: v3.lockYamlSource,
      pinnedRelease: badPin
    }).reason, 'PINNED_RELEASE_INVALID');
  }

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

  const topProtocol = [
    '---',
    'name: Direct protocol',
    'protocol: v5',
    '---',
    '# Body'
  ].join('\n');
  const topHash = computeFrontmatterSha256(topProtocol);
  const topLock = v3.lockYamlSource.replace(v3.sha, topHash);
  assert.equal(verifyGhAwWorkflowLock({markdownSource: topProtocol, lockYamlSource: topLock}).reason,
    'WORK_QUEUE_PROTOCOL_UNSUPPORTED');

  const directWorkQueue = [
    '---',
    'name: Direct work-queue',
    'work-queue:',
    '  branch: main',
    '---',
    '# Body'
  ].join('\n');
  const dqHash = computeFrontmatterSha256(directWorkQueue);
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: directWorkQueue,
    lockYamlSource: v3.lockYamlSource.replace(v3.sha, dqHash)
  }).reason, 'INVALID_WORK_QUEUE_BRANCH');

  const headerMismatch = buildFixture({protocol: 'v3'});
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: headerMismatch.markdownSource,
    lockYamlSource: headerMismatch.lockYamlSource.replace('# gh-aw-work-queue-protocol: v3', '# gh-aw-work-queue-protocol: v4')
  }).reason, 'WORK_QUEUE_PROTOCOL_UNSUPPORTED');
});

test('enforces frontmatter hash integrity and strict YAML failure modes', () => {
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

  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: base.markdownSource,
    lockYamlSource: base.lockYamlSource.replace(`# gh-aw-frontmatter-sha256: ${base.sha}\n`, '')
  }).reason, 'FRONTMATTER_HASH_MISSING');

  const dupHeader = buildFixture({extraHeader: `# gh-aw-version: ${PINNED_GHAW_RELEASE.version}`});
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: dupHeader.markdownSource,
    lockYamlSource: dupHeader.lockYamlSource
  }).reason, 'FRONTMATTER_HASH_MISSING');

  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: base.markdownSource,
    lockYamlSource: base.lockYamlSource.replace(base.sha, 'f'.repeat(64))
  }).reason, 'FRONTMATTER_HASH_MISMATCH');

  for (const invalidLock of [
    `# gh-aw-version: v1.2.2\n# gh-aw-commit: ${PINNED_GHAW_RELEASE.commit}\n# gh-aw-frontmatter-sha256: ${base.sha}\n---\nname: doc`,
    `# gh-aw-version: v1.2.2\n# gh-aw-commit: ${PINNED_GHAW_RELEASE.commit}\n# gh-aw-frontmatter-sha256: ${base.sha}\n- list_root`,
    `# gh-aw-version: v1.2.2\n# gh-aw-commit: ${PINNED_GHAW_RELEASE.commit}\n# gh-aw-frontmatter-sha256: ${base.sha}\nname: dup\nname: dup2`,
    `# gh-aw-version: v1.2.2\n# gh-aw-commit: ${PINNED_GHAW_RELEASE.commit}\n# gh-aw-frontmatter-sha256: ${base.sha}\nname: &anchor val`,
    `# gh-aw-version: v1.2.2\n# gh-aw-commit: ${PINNED_GHAW_RELEASE.commit}\n# gh-aw-frontmatter-sha256: ${base.sha}\nname: "unterminated`,
    `# gh-aw-version: v1.2.2\n# gh-aw-commit: ${PINNED_GHAW_RELEASE.commit}\n# gh-aw-frontmatter-sha256: ${base.sha}\n"__proto__": bad`,
    `# gh-aw-version: v1.2.2\n# gh-aw-commit: ${PINNED_GHAW_RELEASE.commit}\n# gh-aw-frontmatter-sha256: ${base.sha}\nname: valid_only`
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

  const persistedCreds = buildFixture({persistCredentials: 'true'});
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: persistedCreds.markdownSource,
    lockYamlSource: persistedCreds.lockYamlSource
  }).reason, 'CHECKOUT_CREDENTIALS_PERSISTED');

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

  const missingDefaultOff = buildFixture({evaluateIf: "${{ !endsWith(github.actor, '[bot]') }}"});
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: missingDefaultOff.markdownSource,
    lockYamlSource: missingDefaultOff.lockYamlSource
  }).reason, 'MISSING_DEFAULT_OFF_GUARD');

  const missingBotGuard = buildFixture({evaluateIf: "${{ vars.FACTORY_GHAW_ENABLED == 'true' }}"});
  assert.equal(verifyGhAwWorkflowLock({
    markdownSource: missingBotGuard.markdownSource,
    lockYamlSource: missingBotGuard.lockYamlSource
  }).reason, 'MISSING_BOT_LOOP_GUARD');

  const explicitBotGuard = buildFixture({
    evaluateIf: "${{ vars.FACTORY_GHAW_ENABLED == 'true' && github.actor != 'copilot-swe-agent[bot]' && github.actor != 'github-actions[bot]' }}",
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
    'tools:',
    '  work-queue:',
    '    protocol: v3',
    '    branch: work-queue',
    'safe-outputs:',
    '  merge-pull-request: false',
    'empty-section:',
    '---',
    '# Body'
  ].join('\n');
  const sha = computeFrontmatterSha256(md);
  const lock = [
    `# gh-aw-version: ${PINNED_GHAW_RELEASE.version}`,
    `# gh-aw-commit: ${PINNED_GHAW_RELEASE.commit}`,
    `# gh-aw-frontmatter-sha256: ${sha}`,
    'name: Edge Lock',
    'on:',
    '  workflow_dispatch:',
    'permissions: {}',
    'jobs:',
    '  evaluate:',
    '    if: vars.FACTORY_GHAW_ENABLED == "true" && !endsWith(github.actor, "[bot]")',
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
    '        run: echo "ok"'
  ].join('\n');
  const verdict = verifyGhAwWorkflowLock({markdownSource: md, lockYamlSource: lock});
  assert.equal(verdict.valid, true);

  const noEvalLock = lock.replace('  evaluate:', '  threat-and-policy-scan:').replace('- evaluate', '- threat-and-policy-scan');
  assert.equal(verifyGhAwWorkflowLock({markdownSource: md, lockYamlSource: noEvalLock}).reason, 'MISSING_EVALUATION_JOB');

  const noThreatLock = lock.replace('  threat-scan:\n    needs:\n      - evaluate\n    runs-on: ubuntu-latest\n    permissions: {}\n    steps:\n      - name: Threat check\n        run: echo "ok"', '');
  assert.equal(verifyGhAwWorkflowLock({markdownSource: md, lockYamlSource: noThreatLock}).reason, 'MISSING_THREAT_SCAN_GATE');

  const reusableUnpinned = lock.replace('    runs-on: ubuntu-latest\n    permissions: {}\n    steps:', '    uses: org/repo/.github/workflows/ci.yml@main\n    permissions: {}\n    steps:');
  assert.equal(verifyGhAwWorkflowLock({markdownSource: md, lockYamlSource: reusableUnpinned}).reason, 'UNPINNED_ACTION_REFERENCE');

  const reusablePinned = [
    `# gh-aw-version: ${PINNED_GHAW_RELEASE.version}`,
    `# gh-aw-commit: ${PINNED_GHAW_RELEASE.commit}`,
    `# gh-aw-frontmatter-sha256: ${sha}`,
    'name: Reusable Lock',
    'on:',
    '  workflow_dispatch:',
    'permissions: {}',
    'jobs:',
    '  evaluate:',
    '    if: vars.FACTORY_GHAW_ENABLED == "true" && !endsWith(github.actor, "[bot]")',
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

  const envMergeLock = lock.replace('MODE: shadow', 'SAFE_OUTPUT: merge-pull-request');
  assert.equal(verifyGhAwWorkflowLock({markdownSource: md, lockYamlSource: envMergeLock}).reason, 'MAIN_MERGE_FORBIDDEN_IN_GHAW');

  const nameMergeLock = lock.replace('Threat check', 'Execute merge-pull-request');
  assert.equal(verifyGhAwWorkflowLock({markdownSource: md, lockYamlSource: nameMergeLock}).reason, 'MAIN_MERGE_FORBIDDEN_IN_GHAW');

  // Standalone '-' sequence item, nested sequence mapping key without inline value, and empty needs
  const nestedSeqMd = [
    '---',
    'name: Nested Sequence',
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

  // Branch array merge-pull-request variants and default protocol under work-queue
  const nonMainMergeMd = [
    '---',
    'name: Feature Merge Only',
    'tools:',
    '  work-queue:',
    '    branch: work-queue',
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

  // Lock structural denials: scalar job, scalar step, non-string run, safe-outputs write-all
  const scalarJobLock = [
    `# gh-aw-version: ${PINNED_GHAW_RELEASE.version}`,
    `# gh-aw-commit: ${PINNED_GHAW_RELEASE.commit}`,
    `# gh-aw-frontmatter-sha256: ${sha}`,
    'on:',
    '  workflow_dispatch:',
    'permissions: {}',
    'jobs:',
    '  evaluate: invalid_job'
  ].join('\n');
  assert.equal(verifyGhAwWorkflowLock({markdownSource: md, lockYamlSource: scalarJobLock}).reason, 'INVALID_LOCK_YAML');

  const scalarStepLock = lock.replace('      - name: Threat check\n        run: echo "ok"', '      - scalar_step');
  assert.equal(verifyGhAwWorkflowLock({markdownSource: md, lockYamlSource: scalarStepLock}).reason, 'INVALID_LOCK_YAML');

  const numericRunLock = lock.replace('run: echo "ok"', 'run: 12345');
  assert.equal(verifyGhAwWorkflowLock({markdownSource: md, lockYamlSource: numericRunLock}).reason, 'UNSAFE_RUN_INTERPOLATION');

  const safeWriteAllLock = `${lock}\n  safe-outputs-bad:\n    needs: [threat-scan]\n    permissions: write-all\n    steps:\n      - run: echo "x"`;
  assert.equal(verifyGhAwWorkflowLock({markdownSource: md, lockYamlSource: safeWriteAllLock}).reason, 'EXCESSIVE_SAFE_OUTPUT_PERMISSION');
});
